import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { oauthPkceAuthProvider } from "./oauth-pkce.ts";
import { InMemorySecretStore } from "../secret-store.ts";

interface MockIdp {
  tokenEndpoint: string;
  requests: URLSearchParams[];
  hits: () => number;
  close: () => Promise<void>;
}

/** A loopback OAuth token endpoint. `responder` shapes each token response. */
async function startMockIdp(
  responder: (params: URLSearchParams, hit: number) => { status: number; body: unknown },
): Promise<MockIdp> {
  const requests: URLSearchParams[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && (req.url ?? "").startsWith("/token")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const params = new URLSearchParams(raw);
        requests.push(params);
        const { status, body } = responder(params, requests.length);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  return {
    tokenEndpoint: `http://127.0.0.1:${port}/token`,
    requests,
    hits: () => requests.length,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let idp: MockIdp | undefined;
afterEach(async () => {
  await idp?.close();
  idp = undefined;
});

test("REFUSES a non-HTTPS OAuth endpoint (an http endpoint would send the code + refresh token in cleartext)", () => {
  const store = new InMemorySecretStore();
  // A non-loopback http token endpoint must be rejected at construction.
  expect(() =>
    oauthPkceAuthProvider(store, {
      id: "x",
      authorizeEndpoint: "https://idp.example/authorize",
      tokenEndpoint: "http://idp.example/token",
      clientId: "c",
    }),
  ).toThrow(/https|cleartext/i);
  // A non-loopback http authorize endpoint is likewise rejected.
  expect(() =>
    oauthPkceAuthProvider(store, {
      id: "x",
      authorizeEndpoint: "http://idp.example/authorize",
      tokenEndpoint: "https://idp.example/token",
      clientId: "c",
    }),
  ).toThrow(/https|cleartext/i);
  // Loopback http is allowed — local/dev IdPs run without TLS.
  expect(() =>
    oauthPkceAuthProvider(store, {
      id: "y",
      authorizeEndpoint: "http://127.0.0.1:9999/authorize",
      tokenEndpoint: "http://127.0.0.1:9999/token",
      clientId: "c",
    }),
  ).not.toThrow();
});

test("authorize -> callback round-trip yields a working oauth credential", async () => {
  idp = await startMockIdp(() => ({
    status: 200,
    body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 },
  }));
  const store = new InMemorySecretStore();
  const provider = oauthPkceAuthProvider(store, {
    id: "chatgpt-oauth",
    authorizeEndpoint: "https://idp.example/authorize",
    tokenEndpoint: idp.tokenEndpoint,
    clientId: "client-abc",
    scope: "openid profile",
    baseUrl: "https://api.example/v1",
    now: () => 1_000_000,
  });

  const auth = await provider.authorize();
  expect(auth.method).toBe("browser");
  const url = new URL(auth.url!);
  expect(url.searchParams.get("client_id")).toBe("client-abc");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("scope")).toBe("openid profile");
  expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const state = url.searchParams.get("state")!;

  const cred = await provider.callback({ accountId: "acct-1", code: "auth-code-xyz", state });
  expect(cred.kind).toBe("oauth");
  expect(cred.expiresAt).toBe(1_000_000 + 3600 * 1000);
  expect(cred.secretRef).toBe("chatgpt-oauth:acct-1");
  expect(cred.refreshRef).toBe("chatgpt-oauth-refresh:acct-1");
  // Tokens live in the store, never in the credential object.
  expect(await store.get(cred.secretRef)).toBe("at-1");
  expect(await store.get(cred.refreshRef!)).toBe("rt-1");
  expect(JSON.stringify(cred)).not.toContain("at-1");
  expect(JSON.stringify(cred)).not.toContain("rt-1");
  // The token endpoint got an authorization_code grant with our code.
  expect(idp.requests[0].get("grant_type")).toBe("authorization_code");
  expect(idp.requests[0].get("code")).toBe("auth-code-xyz");

  const req = await provider.applyToRequest(cred, { headers: {} });
  expect(req.headers.Authorization).toBe("Bearer at-1");
  expect(req.baseUrl).toBe("https://api.example/v1");
});

test("PKCE: the advertised challenge is S256(verifier), and the loopback listener captures the redirect", async () => {
  idp = await startMockIdp(() => ({
    status: 200,
    body: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
  }));
  const store = new InMemorySecretStore();
  const provider = oauthPkceAuthProvider(store, {
    authorizeEndpoint: "https://idp.example/authorize",
    tokenEndpoint: idp.tokenEndpoint,
    clientId: "c",
  });

  const auth = await provider.authorize();
  const url = new URL(auth.url!);
  const challenge = url.searchParams.get("code_challenge")!;
  const state = url.searchParams.get("state")!;
  const redirectUri = url.searchParams.get("redirect_uri")!;

  // Simulate the IdP redirecting the browser to the loopback listener.
  const res = await fetch(`${redirectUri}?code=the-code&state=${encodeURIComponent(state)}`);
  expect(res.status).toBe(200);

  // callback() with no explicit code awaits the redirect the listener captured.
  const cred = await provider.callback({ accountId: "acct-2" });
  expect(cred.secretRef).toBe("oauth-pkce:acct-2");
  expect(await store.get(cred.secretRef)).toBe("at");

  // The verifier the token endpoint received hashes (S256) to the challenge.
  const verifier = idp.requests[0].get("code_verifier")!;
  const expected = createHash("sha256").update(verifier).digest("base64url");
  expect(expected).toBe(challenge);
});

test("callback rejects a wrong or absent state and never exchanges the code", async () => {
  idp = await startMockIdp(() => ({ status: 200, body: { access_token: "at", expires_in: 3600 } }));
  const store = new InMemorySecretStore();
  const provider = oauthPkceAuthProvider(store, {
    authorizeEndpoint: "https://idp.example/authorize",
    tokenEndpoint: idp.tokenEndpoint,
    clientId: "c",
  });

  const a1 = await provider.authorize();
  const realState = new URL(a1.url!).searchParams.get("state")!;
  await expect(
    provider.callback({ accountId: "a", code: "x", state: `${realState}-tampered` }),
  ).rejects.toThrow(/state/i);

  // Fresh authorize; this time omit the state entirely.
  await provider.authorize();
  await expect(provider.callback({ accountId: "a", code: "x" })).rejects.toThrow(/state/i);

  expect(idp.hits()).toBe(0); // the token endpoint was never reached
});

// ── review fixes: loopback listener lifecycle (no leak / no hang / GET-only) ──

const okIdp = () => startMockIdp(() => ({ status: 200, body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } }));
function portOf(url: string): number {
  return Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port);
}
async function completeFlow(provider: ReturnType<typeof oauthPkceAuthProvider>, authUrl: string, accountId: string) {
  const state = new URL(authUrl).searchParams.get("state")!;
  const uri = new URL(authUrl).searchParams.get("redirect_uri")!;
  await fetch(`${uri}?code=c&state=${state}`); // browser GET redirect
  await provider.callback({ accountId }); // resolves + closes the loopback server
}

test("a second authorize() closes the first loopback listener (no orphaned socket)", async () => {
  idp = await okIdp();
  const provider = oauthPkceAuthProvider(new InMemorySecretStore(), {
    id: "x", authorizeEndpoint: "https://idp/a", tokenEndpoint: idp.tokenEndpoint, clientId: "c",
  });
  const auth1 = await provider.authorize();
  const port1 = portOf(auth1.url!);
  const auth2 = await provider.authorize(); // must tear down auth1's server

  await expect(fetch(`http://127.0.0.1:${port1}/callback`)).rejects.toThrow(); // port1 refused
  await completeFlow(provider, auth2.url!, "acct"); // clean up port2
});

test("the loopback flow times out instead of hanging forever (listener released)", async () => {
  idp = await okIdp();
  const provider = oauthPkceAuthProvider(new InMemorySecretStore(), {
    id: "x", authorizeEndpoint: "https://idp/a", tokenEndpoint: idp.tokenEndpoint, clientId: "c",
    callbackTimeoutMs: 40,
  });
  const auth = await provider.authorize();
  const port = portOf(auth.url!);
  // Browser flow: no code/state -> waits for a redirect that never comes -> times out.
  await expect(provider.callback({ accountId: "acct" })).rejects.toThrow(/timed out/);
  expect(idp.hits()).toBe(0); // never reached the token endpoint
  await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow(); // server closed on timeout
});

test("the loopback handler rejects a non-GET request (real redirect is always GET)", async () => {
  idp = await okIdp();
  const provider = oauthPkceAuthProvider(new InMemorySecretStore(), {
    id: "x", authorizeEndpoint: "https://idp/a", tokenEndpoint: idp.tokenEndpoint, clientId: "c",
  });
  const auth = await provider.authorize();
  const uri = new URL(auth.url!).searchParams.get("redirect_uri")!;
  const r = await fetch(uri, { method: "POST" });
  expect(r.status).toBe(405);
  await completeFlow(provider, auth.url!, "acct"); // clean up
});

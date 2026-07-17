import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAccounts, loginAccount } from "./accounts.ts";
import { createOpenHarnessAuthStorage } from "./pi-auth-storage.ts";

interface MockIdp {
  tokenEndpoint: string;
  requests: URLSearchParams[];
  hits: () => number;
  close: () => Promise<void>;
}

/** A loopback OAuth token endpoint; `responder` shapes each token response. */
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

let dir: string;
let idp: MockIdp | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oh-oauth-"));
});
afterEach(async () => {
  await idp?.close();
  idp = undefined;
  await rm(dir, { recursive: true, force: true });
});

test("loadAccounts registers an oauth provider and yields an oauth-kind account (unusable until login)", async () => {
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify({
      profiles: {
        work: {
          policy: "failover",
          accounts: [
            {
              id: "chatgpt",
              provider: "openai",
              oauth: {
                authorizeEndpoint: "https://idp.example/authorize",
                tokenEndpoint: "https://idp.example/token",
                clientId: "client-abc",
                scope: "openid profile",
                baseUrl: "https://api.example/v1",
              },
            },
          ],
        },
      },
    }),
  );

  const { manager, registry } = await loadAccounts({ dir, env: {} });

  // A dedicated PKCE provider instance is registered under the derived id.
  const provider = registry.get("oauth:chatgpt");
  expect(provider).toBeDefined();

  // The account resolves, scoped to its vendor, as an oauth-kind credential.
  const acct = manager.activeAccount("work", "openai");
  expect(acct?.id).toBe("chatgpt");
  expect(acct?.authProviderId).toBe("oauth:chatgpt");
  expect(acct?.credential.kind).toBe("oauth");
  expect(acct?.credential.secretRef).toBe("oauth:chatgpt:chatgpt");
  expect(acct?.credential.baseUrl).toBe("https://api.example/v1");

  // No token yet -> resolving through the provider fails (unusable until login),
  // proving the credential really points at the (empty) secret store.
  await expect(
    provider!.applyToRequest(acct!.credential, { headers: {} }),
  ).rejects.toThrow(/not found/i);
});

test("login round-trip persists a working credential; a reload resolves the Bearer token via pi-auth-storage", async () => {
  idp = await startMockIdp(() => ({
    status: 200,
    body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 },
  }));
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify({
      profiles: {
        work: {
          policy: "failover",
          accounts: [
            {
              id: "chatgpt",
              provider: "openai",
              authProviderId: "chatgpt-oauth",
              oauth: {
                authorizeEndpoint: "https://idp.example/authorize",
                tokenEndpoint: idp.tokenEndpoint,
                clientId: "client-abc",
                scope: "openid",
                baseUrl: "https://api.example/v1",
              },
            },
          ],
        },
      },
    }),
  );

  const cred = await loginAccount("chatgpt", {
    dir,
    onAuthorize: async (auth) => {
      // Simulate the browser being redirected to the loopback listener.
      const url = new URL(auth.url!);
      const state = url.searchParams.get("state")!;
      const redirectUri = url.searchParams.get("redirect_uri")!;
      await fetch(`${redirectUri}?code=auth-code-xyz&state=${encodeURIComponent(state)}`);
    },
  });

  // The returned credential carries refs only — never a token.
  expect(cred.kind).toBe("oauth");
  expect(cred.secretRef).toBe("chatgpt-oauth:chatgpt");
  expect(cred.refreshRef).toBe("chatgpt-oauth-refresh:chatgpt");
  expect(JSON.stringify(cred)).not.toContain("at-1");
  expect(JSON.stringify(cred)).not.toContain("rt-1");
  // The token endpoint saw an authorization_code grant carrying our code.
  expect(idp.requests[0].get("grant_type")).toBe("authorization_code");
  expect(idp.requests[0].get("code")).toBe("auth-code-xyz");

  // accounts.json now records the NON-SECRET oauthCredential, and holds no token.
  const rawFile = await readFile(join(dir, "accounts.json"), "utf8");
  expect(rawFile).not.toContain("at-1");
  expect(rawFile).not.toContain("rt-1");
  const parsed = JSON.parse(rawFile) as {
    profiles: Record<string, { accounts: { oauthCredential?: Record<string, unknown> }[] }>;
  };
  const persisted = parsed.profiles.work.accounts[0].oauthCredential!;
  expect(persisted.secretRef).toBe("chatgpt-oauth:chatgpt");
  expect(persisted.refreshRef).toBe("chatgpt-oauth-refresh:chatgpt");
  expect(typeof persisted.expiresAt).toBe("number");

  // Next launch: reload picks up the persisted credential; resolving through the
  // REAL Pi AuthStorage bridge yields the Bearer token from the encrypted store.
  const { manager, registry } = await loadAccounts({ dir, env: {} });
  const oh = createOpenHarnessAuthStorage({ manager, registry, profile: "work" });
  const active = await oh.syncActiveProvider("openai");
  expect(active?.id).toBe("chatgpt");
  expect(await oh.authStorage.getApiKey("openai")).toBe("at-1");
  // A still-valid token is NOT re-exchanged: only the login hit the endpoint.
  expect(idp.hits()).toBe(1);
});

test("an expired oauth token refreshes on resolve (through pi-auth-storage)", async () => {
  idp = await startMockIdp((params) => {
    if (params.get("grant_type") === "refresh_token") {
      return { status: 200, body: { access_token: "at-refreshed", refresh_token: "rt-2", expires_in: 3600 } };
    }
    return { status: 200, body: { access_token: "at-initial", refresh_token: "rt-1", expires_in: 3600 } };
  });
  const NOW = 5_000_000_000;
  // A logged-in oauth account whose persisted token is already expired at NOW.
  await writeFile(
    join(dir, "accounts.json"),
    JSON.stringify({
      profiles: {
        work: {
          policy: "failover",
          accounts: [
            {
              id: "chatgpt",
              provider: "openai",
              authProviderId: "chatgpt-oauth",
              oauth: {
                authorizeEndpoint: "https://idp.example/authorize",
                tokenEndpoint: idp.tokenEndpoint,
                clientId: "client-abc",
              },
              oauthCredential: {
                secretRef: "chatgpt-oauth:chatgpt",
                refreshRef: "chatgpt-oauth-refresh:chatgpt",
                expiresAt: NOW - 5_000,
              },
            },
          ],
        },
      },
    }),
  );

  const { manager, registry, secretStore } = await loadAccounts({ dir, env: {} });
  // Seed the encrypted store as a prior login would have.
  await secretStore.set("chatgpt-oauth:chatgpt", "at-stale");
  await secretStore.set("chatgpt-oauth-refresh:chatgpt", "rt-1");

  const oh = createOpenHarnessAuthStorage({ manager, registry, profile: "work", now: () => NOW });
  const active = await oh.syncActiveProvider("openai");
  expect(active?.id).toBe("chatgpt");

  // Exactly one refresh_token exchange, and Pi resolves the REFRESHED token.
  expect(idp.hits()).toBe(1);
  expect(idp.requests[0].get("grant_type")).toBe("refresh_token");
  expect(idp.requests[0].get("refresh_token")).toBe("rt-1");
  expect(await oh.authStorage.getApiKey("openai")).toBe("at-refreshed");
  // Store rotated in place: fresh access + rotated refresh token, never the stale one.
  expect(await secretStore.get("chatgpt-oauth:chatgpt")).toBe("at-refreshed");
  expect(await secretStore.get("chatgpt-oauth-refresh:chatgpt")).toBe("rt-2");
});

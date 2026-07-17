import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthProvider, ProviderRequest } from "../auth-provider.ts";
import type { SecretStore } from "../secret-store.ts";
import type { StoredCredential } from "../types.ts";

export interface OAuthPkceConfig {
  /** OAuth authorization endpoint (where the user's browser is sent). */
  authorizeEndpoint: string;
  /** OAuth token endpoint (code->token and refresh_token exchanges). */
  tokenEndpoint: string;
  clientId: string;
  /**
   * AuthProvider.id — the mechanism selector `Account.authProviderId` matches
   * against (e.g. "chatgpt-oauth"). Also namespaces the SecretStore refs.
   * Default "oauth-pkce".
   */
  id?: string;
  /** Loopback callback port. 0 / undefined => an ephemeral port is chosen. */
  port?: number;
  /** Loopback callback path. Default "/callback". */
  redirectPath?: string;
  /** Space-delimited scope(s), if the provider requires them. */
  scope?: string;
  /** Base URL applied to resolved requests (e.g. the vendor API root). */
  baseUrl?: string;
  /** Clock seam for expiry math (tests inject a fixed clock). */
  now?: () => number;
}

/** Fields the callback receives (the parsed redirect + which account it is for). */
interface OAuthCallbackInput {
  accountId?: string;
  code?: string;
  state?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface PendingAuth {
  verifier: string;
  state: string;
  redirectUri: string;
  server: Server;
  /** Resolves with the redirect query once the loopback listener catches it. */
  waitForRedirect: Promise<{ code?: string; state?: string }>;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}
function s256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Generic OAuth 2.1 + PKCE (S256) credential provider. Runs the loopback
 * authorization-code flow, exchanges the code for tokens, and supports
 * expiry-aware refresh. Tokens live ONLY in the SecretStore — the returned
 * StoredCredential carries refs + non-secret metadata (expiresAt), never a token.
 */
export function oauthPkceAuthProvider(store: SecretStore, config: OAuthPkceConfig): AuthProvider {
  const id = config.id ?? "oauth-pkce";
  const redirectPath = config.redirectPath ?? "/callback";
  const now = config.now ?? (() => Date.now());
  let pending: PendingAuth | undefined;

  async function postToken(body: URLSearchParams): Promise<TokenResponse> {
    const res = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`OAuth token endpoint returned HTTP ${res.status}`);
    const json = (await res.json()) as Partial<TokenResponse>;
    if (typeof json.access_token !== "string" || json.access_token === "") {
      throw new Error("OAuth token endpoint response missing access_token");
    }
    return {
      access_token: json.access_token,
      refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
      expires_in: typeof json.expires_in === "number" ? json.expires_in : 0,
    };
  }

  async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return {
    id,

    async authorize() {
      const verifier = base64url(randomBytes(32));
      const challenge = s256(verifier);
      const state = base64url(randomBytes(16));

      let resolveRedirect!: (r: { code?: string; state?: string }) => void;
      const waitForRedirect = new Promise<{ code?: string; state?: string }>((resolve) => {
        resolveRedirect = resolve;
      });

      const server = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (u.pathname !== redirectPath) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>Authorization received. You can close this window.</body></html>");
        resolveRedirect({
          code: u.searchParams.get("code") ?? undefined,
          state: u.searchParams.get("state") ?? undefined,
        });
      });

      const port = await new Promise<number>((resolve, reject) => {
        server.on("error", reject);
        server.listen(config.port ?? 0, "127.0.0.1", () => {
          resolve((server.address() as AddressInfo).port);
        });
      });
      const redirectUri = `http://127.0.0.1:${port}${redirectPath}`;

      const authUrl = new URL(config.authorizeEndpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", config.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      if (config.scope) authUrl.searchParams.set("scope", config.scope);

      pending = { verifier, state, redirectUri, server, waitForRedirect };
      return {
        method: "browser",
        url: authUrl.toString(),
        instructions:
          "Open the URL in your browser and sign in; the local loopback listener will capture the redirect.",
      };
    },

    async callback(input: unknown): Promise<StoredCredential> {
      const inp = (input ?? {}) as OAuthCallbackInput;
      const p = pending;
      if (!p) throw new Error("OAuth callback called before authorize()");
      try {
        let code = inp.code;
        let state = inp.state;
        // No explicit redirect params -> wait for the loopback listener (browser flow).
        if (code === undefined && state === undefined) {
          const r = await p.waitForRedirect;
          code = r.code;
          state = r.state;
        }
        if (!state || !constantTimeEquals(state, p.state)) {
          throw new Error("OAuth callback state mismatch");
        }
        if (!code) throw new Error("OAuth callback missing authorization code");
        const accountId = inp.accountId;
        if (!accountId) throw new Error("OAuth callback requires an accountId");

        const tok = await postToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: p.redirectUri,
            client_id: config.clientId,
            code_verifier: p.verifier,
          }),
        );

        const secretRef = `${id}:${accountId}`;
        const refreshRef = `${id}-refresh:${accountId}`;
        await store.set(secretRef, tok.access_token);
        let storedRefreshRef: string | undefined;
        if (tok.refresh_token) {
          await store.set(refreshRef, tok.refresh_token);
          storedRefreshRef = refreshRef;
        }
        return {
          kind: "oauth",
          secretRef,
          refreshRef: storedRefreshRef,
          expiresAt: now() + tok.expires_in * 1000,
          baseUrl: config.baseUrl,
        };
      } finally {
        await closeServer(p.server);
        pending = undefined;
      }
    },

    async refresh(cred: StoredCredential): Promise<StoredCredential> {
      if (cred.kind !== "oauth" || !cred.refreshRef) {
        throw new Error("credential has no refresh token to refresh with");
      }
      const refreshToken = await store.get(cred.refreshRef);
      if (!refreshToken) throw new Error("refresh token not found in secret store");
      const tok = await postToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: config.clientId,
        }),
      );
      await store.set(cred.secretRef, tok.access_token);
      // Some IdPs rotate the refresh token on use — persist the new one in place.
      if (tok.refresh_token) await store.set(cred.refreshRef, tok.refresh_token);
      return { ...cred, kind: "oauth", expiresAt: now() + tok.expires_in * 1000 };
    },

    async applyToRequest(cred: StoredCredential, req: ProviderRequest): Promise<ProviderRequest> {
      const token = await store.get(cred.secretRef);
      if (!token) throw new Error("oauth access token not found in secret store");
      // apiKey is what the Pi bridge (pi-auth-storage) pushes as the runtime key;
      // the Authorization header is the explicit bearer form. Both carry the token.
      return {
        ...req,
        apiKey: token,
        headers: { ...req.headers, Authorization: `Bearer ${token}` },
        baseUrl: cred.baseUrl ?? config.baseUrl ?? req.baseUrl,
      };
    },
  };
}

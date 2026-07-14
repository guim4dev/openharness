import {
  createDpopProof,
  validateRequest,
  verifyServerAuth,
  type Deny,
  type Principal,
  type ReplayGuard,
} from "./auth.ts";

/**
 * DPoP over HTTP — the glue between the harness (MCP client) and the gateway
 * (MCP server). The client attaches, per request, `Authorization: DPoP <token>`
 * plus a fresh proof signed by its key; the server validates the token, the
 * proof, and the key-binding. A stolen token is useless off the client's machine.
 *
 * (Our proof carries the client public key in a side header rather than a JWK in
 * the proof JWT header — a simplification of RFC 9449 sufficient for v2; the
 * binding check via `cnf.jkt` is unchanged.)
 */
const KEY_HEADER = "x-oh-dpop-key";
/** Response header carrying the gateway's signature over the client's proof. */
export const SERVER_AUTH_HEADER = "x-oh-gateway-auth";

/** A `fetch`-shaped function (the MCP client transport accepts one to inject). */
export type FetchLike = (input: unknown, init?: RequestInit) => Promise<Response>;

/**
 * Normalize a URL to the string both sides sign/verify as the proof `htu`. We
 * use pathname+search so the client (which sees the absolute URL) and the server
 * (whose `req.url` is only the path) agree without threading the host through.
 */
export function proofUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Build the DPoP headers a client attaches to a request. Pure/testable. */
export function dpopHeaders(token: string, proof: string, clientPublicKeyPem: string): Record<string, string> {
  return {
    authorization: `DPoP ${token}`,
    dpop: proof,
    [KEY_HEADER]: Buffer.from(clientPublicKeyPem).toString("base64url"),
  };
}

/**
 * Client: wrap `fetch` so every request carries the token + a fresh, request-
 * bound DPoP proof. Pass the returned function to the MCP client transport's
 * `fetch` option. The proof's `htm`/`htu` are bound to this request's method and
 * (normalized) URL, so it cannot be replayed against a different call.
 */
export function createDpopFetch(
  token: string,
  clientPrivateKeyPem: string,
  clientPublicKeyPem: string,
  baseFetch: FetchLike = fetch as unknown as FetchLike,
  now: () => number = Date.now,
  gatewayPublicKeyPem?: string,
): FetchLike {
  return async (input: unknown, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string })?.url ?? String(input));
    const method = (init?.method ?? "POST").toUpperCase();
    const proof = createDpopProof(clientPrivateKeyPem, { method, url: proofUrl(raw) }, now());
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(dpopHeaders(token, proof, clientPublicKeyPem))) headers.set(k, v);
    const res = await baseFetch(input, { ...init, headers });

    // Server authentication: on a successful response, the gateway must prove it
    // holds the private key for the PINNED pubkey by signing the proof we sent.
    // A fake gateway (no private key) cannot, so we refuse to trust it.
    if (gatewayPublicKeyPem && res.ok) {
      const sig = res.headers.get(SERVER_AUTH_HEADER);
      if (!sig || !verifyServerAuth(gatewayPublicKeyPem, proof, sig)) {
        throw new Error("gateway server authentication failed — the endpoint did not prove the pinned key");
      }
    }
    return res;
  };
}

/** Read a header from a plain object (case-insensitive) or a Headers instance. */
function header(headers: Record<string, string | undefined> | Headers, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

/**
 * Server: validate an incoming HTTP request's DPoP headers into a Principal (or
 * Deny). Extracts the token (`Authorization: DPoP <token>`), the proof (`DPoP`),
 * and the client key (side header), normalizes the URL the same way the client
 * did, then defers to `validateRequest`.
 */
export function dpopFromHttp(
  headers: Record<string, string | undefined> | Headers,
  req: { method: string; url: string },
  gatewayPublicKeyPem: string,
  now: number = Date.now(),
  replayGuard?: ReplayGuard,
): Principal | Deny {
  const auth = header(headers, "authorization");
  const token = auth?.startsWith("DPoP ") ? auth.slice("DPoP ".length) : undefined;
  const dpopProof = header(headers, "dpop");
  const keyB64 = header(headers, KEY_HEADER);
  const clientPublicKeyPem = keyB64 ? Buffer.from(keyB64, "base64url").toString() : undefined;
  return validateRequest(
    {
      ...(token ? { token } : {}),
      ...(dpopProof ? { dpopProof } : {}),
      ...(clientPublicKeyPem ? { clientPublicKeyPem } : {}),
      method: req.method.toUpperCase(),
      url: proofUrl(req.url),
    },
    gatewayPublicKeyPem,
    { now, ...(replayGuard ? { replayGuard } : {}) },
  );
}

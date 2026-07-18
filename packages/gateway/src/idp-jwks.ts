import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { Deny } from "./auth.ts";
import type { IdpVerifier } from "./token-exchange.ts";

/**
 * A JWKS-fetching `IdpVerifier` (deploy hardening §3) for a real OIDC IdP
 * (Okta / Entra / Auth0 / Google) that issues RS256/ES256 JWTs and publishes its
 * signing keys at a JWKS endpoint. It is a drop-in for the SAME `IdpVerifier`
 * seam as `createStaticKeyIdpVerifier` — the gateway is unchanged; a deployment
 * wires one verifier.
 *
 * The verify discipline mirrors the static verifier and hardens the JWKS-specific
 * attack surface:
 *  1. **Algorithm confusion.** Only an allowlisted alg (RS256/ES256) is accepted;
 *     `alg:"none"`, any HMAC (`HS*`), and off-list algs are refused. The alg is
 *     BOUND to the selected JWK's type (RS256 ⇒ `kty:"RSA"`; ES256 ⇒ `kty:"EC"`,
 *     `crv:"P-256"`) — the header `alg` alone never drives verification.
 *  2. **`kid`/`jku` injection.** `kid` is only an exact-match index into the JWKS
 *     fetched from the CONFIG `jwksUri`; any `jku`/`x5u`/`x5c` in the token header
 *     is ignored (no URL is ever fetched from the token). No `kid` with more than
 *     one candidate key of the right type → deny (no silent try-all).
 *  3. **aud/iss confusion.** Exact `iss`; `aud` exact-or-array-contains; a numeric
 *     `exp` is REQUIRED; `sub` must be a non-empty string.
 *  4. **JWKS fetch/cache lifecycle.** In-memory cache with a capped TTL (no
 *     infinite stale fallback). An unknown `kid` triggers AT MOST one refetch
 *     (short cooldown so repeated unknown-kids can't stampede the IdP). The fetch
 *     is hardened: HTTPS-only (loopback http allowed for dev), a response size cap,
 *     a timeout, and guarded JSON parsing. Any fetch/parse failure denies (fail
 *     closed) — it never throws through.
 *  5. **ES256 encoding + fail-closed edges.** JWT ECDSA signatures are raw `r||s`
 *     (IEEE P1363), so ES256 is verified with `{ dsaEncoding: "ieee-p1363" }`; a
 *     DER-encoded sig, a wrong-length/garbage sig, or a key-type mismatch denies.
 *     The subject token's byte length is capped BEFORE any parse.
 */
export interface JwksIdpOptions {
  /** The IdP's JWKS endpoint (must be https; loopback http allowed for dev). */
  jwksUri: string;
  /** Required `iss` claim. */
  issuer: string;
  /** Required `aud` claim (string, or one of an array `aud`). */
  audience: string;
  /** Accepted signature algorithms (allowlist). Default both RS256 and ES256. */
  algorithms?: ("RS256" | "ES256")[];
  /** The claim carrying the user's groups (default `groups`). */
  groupsClaim?: string;
  /** Clock (ms) for `exp`/`nbf`. Default `Date.now`. */
  now?: () => number;
  /** Leeway (seconds) for `exp`/`nbf`. Default 0. */
  clockToleranceSec?: number;
  /** How long a fetched JWKS is trusted before refetch (ms). Default 5 min. */
  cacheTtlMs?: number;
  /** `fetch` override (tests). Default the global `fetch`. */
  fetchImpl?: typeof fetch;
}

type Alg = "RS256" | "ES256";

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}
interface JwtPayload {
  sub?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  [k: string]: unknown;
}

/** A JWK as published in a JWKS (only the fields this verifier reads are typed). */
interface Jwk {
  kty?: unknown;
  crv?: unknown;
  kid?: unknown;
  [k: string]: unknown;
}

/** Byte caps: reject before parsing anything (DoS / algorithmic-blowup guard). */
const MAX_TOKEN_BYTES = 64 * 1024;
const MAX_JWKS_BYTES = 1024 * 1024; // ~1 MiB
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 300_000;
/** After an unknown-kid refetch, hold off further refetches this long (anti-stampede). */
const REFETCH_COOLDOWN_MS = 60_000;

/** The JWK type/curve a given alg must be verified against (alg ⇄ key binding). */
const ALG_KEY: Record<Alg, { kty: string; crv?: string }> = {
  RS256: { kty: "RSA" },
  ES256: { kty: "EC", crv: "P-256" },
};

function decodeSegment<T>(seg: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Reject a non-HTTPS JWKS endpoint at construction (fail closed). `http:` is
 * allowed ONLY for a loopback host (a local/dev IdP); anything else would let a
 * network attacker swap the JWKS in flight and forge tokens.
 */
function assertSecureJwksUri(value: string): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`jwksUri is not a valid URL: ${JSON.stringify(value)}`);
  }
  const host = u.hostname;
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback))
    throw new Error(
      `jwksUri must be https (got ${u.protocol}//${host}) — fetching the IdP signing keys over cleartext http lets a network attacker swap the JWKS and forge subject tokens`,
    );
}

function jwkMatchesAlg(jwk: Jwk, req: { kty: string; crv?: string }): boolean {
  if (jwk.kty !== req.kty) return false;
  if (req.crv !== undefined && jwk.crv !== req.crv) return false;
  return true;
}

/**
 * Pick the JWK to verify against. `kid` is an exact index; the chosen key MUST
 * match the alg's type. Distinguishes an UNKNOWN kid (no JWK carries it → the
 * caller may refetch once) from a kid that exists but is the wrong type / a
 * no-kid ambiguity (both → deny, never refetch, never try-all).
 */
function selectKey(
  keys: Jwk[],
  kid: string | undefined,
  req: { kty: string; crv?: string },
): { key: Jwk } | { deny: string } | { unknownKid: true } {
  if (kid !== undefined) {
    const byKid = keys.filter((k) => typeof k.kid === "string" && k.kid === kid);
    if (byKid.length === 0) return { unknownKid: true };
    const typed = byKid.filter((k) => jwkMatchesAlg(k, req));
    if (typed.length === 1) return { key: typed[0] };
    if (typed.length === 0) return { deny: "kid found but its key type does not match the token alg" };
    return { deny: "kid is ambiguous in the JWKS" };
  }
  // No kid: only unambiguous when exactly one key of the right type exists.
  const typed = keys.filter((k) => jwkMatchesAlg(k, req));
  if (typed.length === 1) return { key: typed[0] };
  return { deny: typed.length === 0 ? "no key of the token alg type in the JWKS" : "no kid and multiple candidate keys" };
}

export function createJwksIdpVerifier(opts: JwksIdpOptions): IdpVerifier {
  assertSecureJwksUri(opts.jwksUri);

  const allowed: Alg[] = opts.algorithms ?? ["RS256", "ES256"];
  const groupsClaim = opts.groupsClaim ?? "groups";
  const now = opts.now ?? Date.now;
  const tol = opts.clockToleranceSec ?? 0;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  let cache: { keys: Jwk[]; fetchedAt: number } | undefined;
  let lastForcedFetchAt = Number.NEGATIVE_INFINITY;

  /** Read a capped number of bytes from the response; undefined if it exceeds the cap. */
  async function readCapped(res: Response): Promise<string | undefined> {
    const declared = res.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_JWKS_BYTES) return undefined;
    const body = res.body;
    if (!body) {
      const text = await res.text();
      return Buffer.byteLength(text, "utf8") > MAX_JWKS_BYTES ? undefined : text;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_JWKS_BYTES) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Fetch + parse the JWKS. Returns the keys, or undefined on any failure (fail closed). */
  async function fetchJwks(): Promise<Jwk[] | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(opts.jwksUri, { signal: controller.signal, redirect: "error" });
      if (!res.ok) return undefined;
      const text = await readCapped(res);
      if (text === undefined) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return undefined;
      }
      const keys = (parsed as { keys?: unknown })?.keys;
      if (!Array.isArray(keys)) return undefined;
      return keys.filter((k): k is Jwk => k !== null && typeof k === "object");
    } catch {
      return undefined; // network error / timeout / abort → deny
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ensure a fresh-enough cache; refetch when stale. No stale fallback on failure. */
  async function ensureKeys(nowMs: number): Promise<Jwk[] | undefined> {
    if (cache && nowMs - cache.fetchedAt <= cacheTtlMs) return cache.keys;
    const fresh = await fetchJwks();
    if (fresh) cache = { keys: fresh, fetchedAt: nowMs };
    return fresh;
  }

  function verifySig(alg: Alg, data: Buffer, key: KeyObject, sig: Buffer): boolean {
    try {
      if (alg === "RS256") return verify("RSA-SHA256", data, key, sig);
      // ES256: JWT ECDSA sigs are raw r||s (IEEE P1363), not DER.
      return verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
    } catch {
      return false; // wrong-length/garbage sig or key-type mismatch → deny
    }
  }

  return {
    async verifySubjectToken(subjectToken: string): Promise<{ sub: string; groups: string[] } | Deny> {
      // Guard the exported seam against a non-string caller: the HTTP entry always
      // passes a string, but the contract is "any bad input → deny", never a throw
      // that propagates across the seam.
      if (typeof subjectToken !== "string") return { deny: "subject token is not a string" };
      // Cap byte length BEFORE any parse — a hostile token can't force expensive work.
      if (Buffer.byteLength(subjectToken, "utf8") > MAX_TOKEN_BYTES) return { deny: "subject token exceeds size cap" };

      const parts = subjectToken.split(".");
      if (parts.length !== 3) return { deny: "subject token is not a compact JWT" };
      const [h, p, s] = parts;

      const header = decodeSegment<JwtHeader>(h);
      if (!header || typeof header.alg !== "string") return { deny: "subject token header is invalid" };
      const alg = header.alg as Alg;
      // Allowlist check FIRST: rejects `none`, any `HS*`, and off-list algs before
      // any key work — the header alg never selects a verification path on its own.
      if (!allowed.includes(alg)) return { deny: `unsupported JWT alg '${header.alg}'` };
      const req = ALG_KEY[alg];
      const kid = typeof header.kid === "string" ? header.kid : undefined;

      const nowMs = now();
      let keys = await ensureKeys(nowMs);
      if (!keys) return { deny: "JWKS is unavailable" };

      let sel = selectKey(keys, kid, req);
      if ("unknownKid" in sel) {
        // Unknown kid: refetch AT MOST once (honoring the anti-stampede cooldown),
        // then re-select. A failed refetch, or still-absent kid, denies.
        if (nowMs - lastForcedFetchAt >= REFETCH_COOLDOWN_MS) {
          lastForcedFetchAt = nowMs;
          const refreshed = await fetchJwks();
          if (refreshed) {
            cache = { keys: refreshed, fetchedAt: nowMs };
            keys = refreshed;
            sel = selectKey(keys, kid, req);
          }
        }
      }
      if (!("key" in sel)) return { deny: "unknownKid" in sel ? "unknown kid" : sel.deny };

      // selectKey already bound the chosen JWK to the alg's type; build the key
      // (a malformed JWK throws → deny) and verify the signature over
      // `header.payload` BEFORE trusting any claim. verifySig also fails closed on
      // an alg/key mismatch (the verify call throws → false).
      let keyObj: KeyObject;
      try {
        keyObj = createPublicKey({ key: sel.key, format: "jwk" } as Parameters<typeof createPublicKey>[0]);
      } catch {
        return { deny: "selected JWK is not a usable public key" };
      }
      if (!verifySig(alg, Buffer.from(`${h}.${p}`), keyObj, Buffer.from(s, "base64url")))
        return { deny: "subject token signature is not valid under the IdP key" };

      const payload = decodeSegment<JwtPayload>(p);
      if (!payload) return { deny: "subject token payload is not valid JSON" };

      if (payload.iss !== opts.issuer) return { deny: `unexpected issuer '${String(payload.iss)}'` };
      const audience = payload.aud;
      const audOk = audience === opts.audience || (Array.isArray(audience) && audience.includes(opts.audience));
      if (!audOk) return { deny: `unexpected audience '${String(audience)}'` };

      const nowSec = nowMs / 1000;
      // `exp` is REQUIRED and numeric — a token without a numeric expiry is
      // rejected (never treated as "no expiry"), so a leaked subject token can't
      // become a permanent gateway-minting credential. Fail closed on a
      // non-numeric temporal claim.
      if (typeof payload.exp !== "number") return { deny: "subject token has no numeric exp" };
      if (nowSec > payload.exp + tol) return { deny: "subject token is expired" };
      if (payload.nbf !== undefined) {
        if (typeof payload.nbf !== "number") return { deny: "subject token has a non-numeric nbf" };
        if (nowSec + tol < payload.nbf) return { deny: "subject token is not yet valid" };
      }

      if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) return { deny: "subject token has no sub" };
      const rawGroups = payload[groupsClaim];
      const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === "string") : [];

      return { sub: payload.sub, groups };
    },
  };
}

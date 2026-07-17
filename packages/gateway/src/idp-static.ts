import { verify } from "node:crypto";
import type { Deny } from "./auth.ts";
import type { IdpVerifier } from "./token-exchange.ts";

/**
 * A concrete `IdpVerifier` (deploy hardening §3) for an IdP that issues EdDSA
 * (Ed25519) JWTs — the mature, offline-verifiable shape. The subject token is a
 * standard compact JWT `b64url(header).b64url(payload).b64url(sig)` signed by the
 * IdP's private key; this verifies it against the IdP's PUBLIC key (configured
 * out-of-band, e.g. from its JWKS) and checks issuer / audience / expiry before
 * mapping claims to the trustworthy identity.
 *
 * This is the "static key" verifier — the org configures ONE Ed25519 public key.
 * A full JWKS-fetching verifier (key rotation over the network) is a later impl
 * of the same `IdpVerifier` seam; the gateway is unchanged either way. Only
 * `alg: "EdDSA"` is accepted (no `alg:none`, no HMAC/RSA confusion).
 */
export interface StaticKeyIdpOptions {
  /** The IdP's Ed25519 PUBLIC key (PEM). */
  publicKeyPem: string;
  /** Required `iss` claim. */
  issuer: string;
  /** Required `aud` claim (string, or one of an array `aud`). */
  audience: string;
  /** The claim carrying the user's groups (default `groups`). */
  groupsClaim?: string;
  /** Clock (ms) for `exp`/`nbf`. Default `Date.now`. */
  now?: () => number;
  /** Leeway (seconds) for `exp`/`nbf`. Default 0. */
  clockToleranceSec?: number;
}

interface JwtHeader {
  alg?: string;
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

function decodeSegment<T>(seg: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

export function createStaticKeyIdpVerifier(opts: StaticKeyIdpOptions): IdpVerifier {
  const groupsClaim = opts.groupsClaim ?? "groups";
  const now = opts.now ?? Date.now;
  const tol = opts.clockToleranceSec ?? 0;

  return {
    async verifySubjectToken(subjectToken: string): Promise<{ sub: string; groups: string[] } | Deny> {
      const parts = subjectToken.split(".");
      if (parts.length !== 3) return { deny: "subject token is not a compact JWT" };
      const [h, p, s] = parts;

      const header = decodeSegment<JwtHeader>(h);
      if (!header || header.alg !== "EdDSA") return { deny: "unsupported JWT alg (only EdDSA)" };

      // Verify the signature over `header.payload` BEFORE trusting any claim.
      let sigOk = false;
      try {
        sigOk = verify(null, Buffer.from(`${h}.${p}`), opts.publicKeyPem, Buffer.from(s, "base64url"));
      } catch {
        sigOk = false;
      }
      if (!sigOk) return { deny: "subject token signature is not valid under the IdP key" };

      const payload = decodeSegment<JwtPayload>(p);
      if (!payload) return { deny: "subject token payload is not valid JSON" };

      if (payload.iss !== opts.issuer) return { deny: `unexpected issuer '${String(payload.iss)}'` };
      const aud = payload.aud;
      const audOk = aud === opts.audience || (Array.isArray(aud) && aud.includes(opts.audience));
      if (!audOk) return { deny: `unexpected audience '${String(aud)}'` };

      const nowSec = now() / 1000;
      if (typeof payload.exp === "number" && nowSec > payload.exp + tol) return { deny: "subject token is expired" };
      if (typeof payload.nbf === "number" && nowSec + tol < payload.nbf) return { deny: "subject token is not yet valid" };

      if (typeof payload.sub !== "string" || payload.sub.length === 0) return { deny: "subject token has no sub" };
      const rawGroups = payload[groupsClaim];
      const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === "string") : [];

      return { sub: payload.sub, groups };
    },
  };
}

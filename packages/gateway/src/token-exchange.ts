import { mintGatewayToken, type Deny, type GatewayClaims } from "./auth.ts";

/**
 * Deploy hardening §3 — IdP-gated token minting via OAuth 2.1 Token Exchange
 * (RFC 8693 shape). In dev the gateway signs a token directly; in production the
 * org's identity provider authenticates the employee and the gateway EXCHANGES
 * the IdP's subject token for the short-lived, DPoP-bound gateway token the
 * pipeline already validates. This makes `sub`/`groups` IdP-asserted (trustworthy
 * for per-principal policy) instead of client-asserted.
 *
 * `IdpVerifier` is the swappable seam: production validates the subject token
 * against the IdP's JWKS and maps claims; a stub asserts fixed identities in
 * tests. The gateway stays IdP-agnostic — a deployment wires one verifier.
 */
export interface IdpVerifier {
  /** Validate the org IdP's subject token → the trustworthy identity, or a Deny. */
  verifySubjectToken(subjectToken: string): Promise<{ sub: string; groups: string[] } | Deny>;
}

export interface TokenExchangeRequest {
  /** The IdP-issued subject token (e.g. an OIDC access/ID token). */
  subjectToken: string;
  /** The client's ed25519 public key (PEM) — the minted token is bound to it. */
  clientPublicKeyPem: string;
  /** Harness-asserted session context (audit/routing only, as documented). */
  harnessId: string;
  defVersion: string;
  sessionId: string;
}

export interface ExchangedToken {
  token: string;
  expiresInMs: number;
}

/**
 * Exchange an IdP subject token for a DPoP-bound gateway token. The IdP asserts
 * the trustworthy identity (`sub`/`groups`); the harness supplies the
 * audit/routing context; the gateway mints a token bound to the client key. A
 * failed IdP validation denies — no token is issued.
 */
export async function exchangeToken(
  req: TokenExchangeRequest,
  opts: { idp: IdpVerifier; gatewayPrivateKeyPem: string; ttlMs: number; now: number },
): Promise<ExchangedToken | Deny> {
  if (!req.subjectToken) return { deny: "no subject token" };
  if (!req.clientPublicKeyPem) return { deny: "no client key to bind" };

  const identity = await opts.idp.verifySubjectToken(req.subjectToken);
  if ("deny" in identity) return identity;

  const claims: GatewayClaims = {
    sub: identity.sub,
    groups: identity.groups,
    harnessId: req.harnessId,
    defVersion: req.defVersion,
    sessionId: req.sessionId,
  };
  const token = mintGatewayToken(claims, opts.gatewayPrivateKeyPem, req.clientPublicKeyPem, {
    ttlMs: opts.ttlMs,
    now: opts.now,
  });
  return { token, expiresInMs: opts.ttlMs };
}

import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

/**
 * Gateway authentication: short-lived, **DPoP-bound** access tokens.
 *
 * The gateway issues a token bound to the client's keypair via a `cnf.jkt`
 * thumbprint claim (RFC 9449 shape, ed25519). Every request must carry BOTH the
 * token AND a fresh DPoP proof signed by the client's private key. Validation
 * checks: the token's signature (gateway key), its expiry, the proof's signature
 * (client key presented on the request), and that the proof key's thumbprint
 * equals the token's `cnf.jkt`. A stolen token is therefore useless off the
 * client's machine — the attacker lacks the private key to sign a matching proof.
 *
 * Signing is ed25519 over a compact `base64url(payload).base64url(sig)` string
 * (self-contained; no external JOSE dep). Harness identity claims are
 * CLIENT-ASSERTED — used for audit/policy routing, never as a security boundary.
 */
export interface GatewayClaims {
  /** Employee subject (from the org IdP). */
  sub: string;
  /** IdP groups, for per-principal policy. */
  groups: string[];
  /** Harness id + definition version (client-asserted; audit/routing only). */
  harnessId: string;
  defVersion: string;
  /** Per-session id. */
  sessionId: string;
}

/** A validated caller. */
export interface Principal extends GatewayClaims {}

/** Validation failure with a reason (never leaks which check failed to the client). */
export interface Deny {
  deny: string;
}

export function isDeny(v: Principal | Deny): v is Deny {
  return (v as Deny).deny !== undefined;
}

interface Ed25519Pair {
  publicKey: string;
  privateKey: string;
}

/** Generate an ed25519 keypair (PEM) — for the gateway signer or a client. */
export function generateAuthKeypair(): Ed25519Pair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

const b64u = (b: Buffer): string => b.toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");

/** Stable thumbprint of a public key (over its PEM). */
export function thumbprint(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem.trim()).digest("base64url");
}

/** Sign a JSON payload with an ed25519 private key -> `b64u(json).b64u(sig)`. */
function signCompact(payload: unknown, privateKeyPem: string): string {
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = b64u(sign(null, Buffer.from(body), privateKeyPem));
  return `${body}.${sig}`;
}

/** Verify a compact token/proof; returns the parsed payload or undefined. */
function verifyCompact<T>(compact: string, publicKeyPem: string): T | undefined {
  const dot = compact.indexOf(".");
  if (dot <= 0) return undefined;
  const body = compact.slice(0, dot);
  const sig = compact.slice(dot + 1);
  try {
    if (!verify(null, Buffer.from(body), publicKeyPem, fromB64u(sig))) return undefined;
    return JSON.parse(fromB64u(body).toString()) as T;
  } catch {
    return undefined;
  }
}

interface TokenPayload extends GatewayClaims {
  exp: number; // epoch ms
  cnf: { jkt: string };
}
interface ProofPayload {
  htm: string;
  htu: string;
  iat: number;
}

/**
 * Mint a gateway access token bound to `clientPublicKeyPem`, valid for `ttlMs`.
 * Signed by the gateway's private key.
 */
export function mintGatewayToken(
  claims: GatewayClaims,
  gatewayPrivateKeyPem: string,
  clientPublicKeyPem: string,
  opts: { ttlMs: number; now: number },
): string {
  const payload: TokenPayload = {
    ...claims,
    exp: opts.now + opts.ttlMs,
    cnf: { jkt: thumbprint(clientPublicKeyPem) },
  };
  return signCompact(payload, gatewayPrivateKeyPem);
}

/** Build a DPoP proof for a request (the client holds the private key). */
export function createDpopProof(
  clientPrivateKeyPem: string,
  req: { method: string; url: string },
  now: number,
): string {
  const payload: ProofPayload = { htm: req.method, htu: req.url, iat: now };
  return signCompact(payload, clientPrivateKeyPem);
}

export interface IncomingRequest {
  token?: string;
  dpopProof?: string;
  /** The client's public key (PEM), presented alongside the proof. */
  clientPublicKeyPem?: string;
  method: string;
  url: string;
}

/**
 * Validate a request. Returns a `Principal` on success or a `Deny`. Fail-closed:
 * any missing/bad token, bad proof, key-binding mismatch, expiry, or method/url
 * mismatch denies. The `deny` reason is for server logs, not the client.
 */
export function validateRequest(
  req: IncomingRequest,
  gatewayPublicKeyPem: string,
  opts: { now: number; proofMaxAgeMs?: number } = { now: Date.now() },
): Principal | Deny {
  if (!req.token) return { deny: "no token" };
  if (!req.dpopProof || !req.clientPublicKeyPem) return { deny: "no DPoP proof" };

  const token = verifyCompact<TokenPayload>(req.token, gatewayPublicKeyPem);
  if (!token) return { deny: "bad token signature" };
  if (token.exp <= opts.now) return { deny: "token expired" };

  const proof = verifyCompact<ProofPayload>(req.dpopProof, req.clientPublicKeyPem);
  if (!proof) return { deny: "bad DPoP proof signature" };

  // Binding: the proof key must be the key the token was bound to.
  if (token.cnf.jkt !== thumbprint(req.clientPublicKeyPem)) return { deny: "proof key not bound to token" };

  // The proof must be for THIS request and recent (replay window).
  if (proof.htm !== req.method || proof.htu !== req.url) return { deny: "proof htm/htu mismatch" };
  const maxAge = opts.proofMaxAgeMs ?? 300_000;
  if (proof.iat > opts.now + 5_000 || proof.iat < opts.now - maxAge) return { deny: "proof stale" };

  return {
    sub: token.sub,
    groups: token.groups,
    harnessId: token.harnessId,
    defVersion: token.defVersion,
    sessionId: token.sessionId,
  };
}

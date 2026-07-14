import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

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
  /** Unique per-proof id — single-use, so a captured proof cannot be replayed. */
  jti: string;
}

/**
 * Single-use guard for DPoP proof ids. A validated proof's `jti` is recorded
 * until it expires; a second request presenting the same `jti` is rejected. This
 * is what makes an observed `(token, proof)` pair worthless for replay: the proof
 * authenticates exactly one request, not every request for the freshness window.
 */
export interface ReplayGuard {
  /** True if `jti` was already used (=> reject). Else record it until `notAfterMs` and return false. */
  seen(jti: string, now: number, notAfterMs: number): boolean;
}

/** In-memory `ReplayGuard`; prunes expired ids lazily on each check. */
export function createReplayGuard(): ReplayGuard {
  const store = new Map<string, number>();
  return {
    seen(jti, now, notAfterMs) {
      for (const [k, exp] of store) if (exp <= now) store.delete(k);
      if (store.has(jti)) return true;
      store.set(jti, notAfterMs);
      return false;
    },
  };
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

/**
 * Server-identity proof. The gateway signs a value bound to the client's DPoP
 * proof with its own private key; the client verifies against the `pubkey`
 * PINNED in the signed definition. This is what makes the pin real: a fake
 * gateway (rogue URL, DNS/ARP spoof) that lacks the private key cannot produce a
 * valid signature, so the client refuses to trust it. Binding to the (single-use)
 * client proof means a captured server signature can't be replayed to a
 * different exchange. (Channel confidentiality against a transparent forwarding
 * proxy is TLS's job — see the https requirement in the harness bridge.)
 */
export function signServerAuth(gatewayPrivateKeyPem: string, boundValue: string): string {
  return b64u(sign(null, Buffer.from(boundValue), gatewayPrivateKeyPem));
}

/** Verify a server-identity proof against the pinned gateway public key. */
export function verifyServerAuth(gatewayPublicKeyPem: string, boundValue: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(boundValue), gatewayPublicKeyPem, fromB64u(signature));
  } catch {
    return false;
  }
}

/** Build a DPoP proof for a request (the client holds the private key). */
export function createDpopProof(
  clientPrivateKeyPem: string,
  req: { method: string; url: string },
  now: number,
): string {
  const payload: ProofPayload = { htm: req.method, htu: req.url, iat: now, jti: randomBytes(16).toString("base64url") };
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
  opts: { now: number; proofMaxAgeMs?: number; replayGuard?: ReplayGuard } = { now: Date.now() },
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

  // The proof must be for THIS request and recent (short replay window).
  if (proof.htm !== req.method || proof.htu !== req.url) return { deny: "proof htm/htu mismatch" };
  const maxAge = opts.proofMaxAgeMs ?? 60_000;
  if (proof.iat > opts.now + 5_000 || proof.iat < opts.now - maxAge) return { deny: "proof stale" };

  // Single-use: a proof id may authenticate exactly one request. Rejects a
  // captured proof replayed inside the freshness window (any method/body).
  if (opts.replayGuard) {
    if (!proof.jti) return { deny: "proof missing jti" };
    if (opts.replayGuard.seen(proof.jti, opts.now, opts.now + maxAge)) return { deny: "proof replayed" };
  }

  return {
    sub: token.sub,
    groups: token.groups,
    harnessId: token.harnessId,
    defVersion: token.defVersion,
    sessionId: token.sessionId,
  };
}

import { createHmac, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import type { Deny } from "./auth.ts";
import { createJwksIdpVerifier } from "./idp-jwks.ts";

/** The verifier returns `{sub,groups}|Deny` (not a Principal), so check `deny` directly. */
const denied = (x: { sub: string; groups: string[] } | Deny): x is Deny => "deny" in x;

const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Export a public key as a JWK stamped with the metadata a real IdP JWKS carries. */
function jwkOf(pub: KeyObject, kid: string, alg: string): Record<string, unknown> {
  return { ...(pub.export({ format: "jwk" }) as Record<string, unknown>), kid, alg, use: "sig" };
}

/**
 * Mint a compact JWT with the requested alg/kid. Special cases exercise the
 * algorithm-confusion pitfalls: `none` → empty sig; `HS256` → HMAC (with the
 * attacker-chosen secret); `der:true` → ES256 signed in DER, NOT the JWT
 * ieee-p1363 shape (must be rejected).
 */
function mintJwt(
  privateKey: KeyObject,
  payload: Record<string, unknown>,
  opts: { alg: string; kid?: string; hmacSecret?: string; extraHeader?: Record<string, unknown>; der?: boolean },
): string {
  const header: Record<string, unknown> = { alg: opts.alg, typ: "JWT", ...(opts.extraHeader ?? {}) };
  if (opts.kid !== undefined) header.kid = opts.kid;
  const signingInput = `${b64u(header)}.${b64u(payload)}`;
  const data = Buffer.from(signingInput);
  let sig: Buffer;
  if (opts.alg === "none") sig = Buffer.alloc(0);
  else if (opts.alg === "HS256") sig = createHmac("sha256", opts.hmacSecret ?? "").update(data).digest();
  else if (opts.alg === "RS256" || opts.alg === "RS384") sig = nodeSign("RSA-SHA256", data, privateKey);
  else if (opts.alg === "ES256")
    sig = opts.der
      ? nodeSign("sha256", data, privateKey)
      : nodeSign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
  else throw new Error(`test cannot mint alg ${opts.alg}`);
  return `${signingInput}.${sig.toString("base64url")}`;
}

// --- Mock JWKS HTTP server (node:http on 127.0.0.1) ------------------------
interface MockJwks {
  uri: string;
  /** `raw` overrides the JSON body (to simulate a malformed response); `count` = requests served. */
  state: { keys: unknown[]; raw: string | null; count: number };
}
let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});
async function startJwks(initialKeys: unknown[]): Promise<MockJwks> {
  const state = { keys: initialKeys, raw: null as string | null, count: 0 };
  const server = createServer((_req, res) => {
    state.count++;
    res.setHeader("content-type", "application/json");
    res.end(state.raw !== null ? state.raw : JSON.stringify({ keys: state.keys }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { uri: `http://127.0.0.1:${port}/jwks`, state };
}

// --- Keys + payloads (module scope; RSA keygen is expensive) ---------------
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const attackerRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_JWK = jwkOf(rsa.publicKey, "rsa-1", "RS256");
const EC_JWK = jwkOf(ec.publicKey, "ec-1", "ES256");

const NOW = 1_000_000_000_000;
const iss = "https://idp.acme.com";
const aud = "openharness-gateway";
const basePayload = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: "alice@acme.com",
  iss,
  aud,
  exp: NOW / 1000 + 300,
  groups: ["eng", "admins"],
  ...extra,
});

function mkVerifier(jwksUri: string, algorithms?: ("RS256" | "ES256")[]) {
  return createJwksIdpVerifier({
    jwksUri,
    issuer: iss,
    audience: aud,
    now: () => NOW,
    ...(algorithms ? { algorithms } : {}),
  });
}

// --- Happy paths (nail the exact crypto.verify call shape) -----------------
test("valid RS256 token yields the IdP-asserted identity", async () => {
  const j = await startJwks([RSA_JWK]);
  const out = await mkVerifier(j.uri).verifySubjectToken(mintJwt(rsa.privateKey, basePayload(), { alg: "RS256", kid: "rsa-1" }));
  expect(denied(out)).toBe(false);
  if (!denied(out)) {
    expect(out.sub).toBe("alice@acme.com");
    expect(out.groups).toEqual(["eng", "admins"]);
  }
});

test("valid ES256 token yields the IdP-asserted identity", async () => {
  const j = await startJwks([EC_JWK]);
  const out = await mkVerifier(j.uri).verifySubjectToken(mintJwt(ec.privateKey, basePayload(), { alg: "ES256", kid: "ec-1" }));
  expect(denied(out)).toBe(false);
  if (!denied(out)) expect(out.sub).toBe("alice@acme.com");
});

// --- Seam guards (any bad input → deny, never a throw across the seam) ------
test("a non-string subject token is denied, not thrown", async () => {
  const j = await startJwks([RSA_JWK]);
  const v = mkVerifier(j.uri);
  for (const bad of [12345, null, undefined, {}] as unknown[]) {
    expect(denied(await v.verifySubjectToken(bad as string))).toBe(true);
  }
});

test("a whitespace-only sub is denied", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload({ sub: "   " }), { alg: "RS256", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

// --- Pitfall 1: algorithm confusion ----------------------------------------
test("alg:none is denied", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload(), { alg: "none", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("alg:HS256 HMAC'd with the public key as the secret is denied (no HMAC confusion)", async () => {
  const j = await startJwks([RSA_JWK]);
  const pubPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
  const tok = mintJwt(rsa.privateKey, basePayload(), { alg: "HS256", kid: "rsa-1", hmacSecret: pubPem });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("an alg not in the allowlist is denied (verifier restricted to ES256, RS256 token)", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload(), { alg: "RS256", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri, ["ES256"]).verifySubjectToken(tok))).toBe(true);
});

test("an off-list alg (RS384) is denied even with the default allowlist", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload(), { alg: "RS384", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("an RS256 header selecting an EC key (wrong-type kid) is denied (alg bound to JWK type)", async () => {
  const j = await startJwks([RSA_JWK, EC_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload(), { alg: "RS256", kid: "ec-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("an ES256 sig in DER encoding (not ieee-p1363) is denied", async () => {
  const j = await startJwks([EC_JWK]);
  const tok = mintJwt(ec.privateKey, basePayload(), { alg: "ES256", kid: "ec-1", der: true });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

// --- Pitfall 2: kid / jku injection ----------------------------------------
test("a jku/x5u/x5c in the token header is ignored — only the config JWKS is fetched", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload(), {
    alg: "RS256",
    kid: "rsa-1",
    extraHeader: { jku: "http://attacker.example/jwks", x5u: "http://attacker.example/x5", x5c: ["deadbeef"] },
  });
  const out = await mkVerifier(j.uri).verifySubjectToken(tok);
  expect(denied(out)).toBe(false);
  expect(j.state.count).toBe(1); // never fetched anything but the config JWKS
});

test("no kid falls back to the single key of the matching type", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload(), { alg: "RS256" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(false);
});

test("no kid with multiple candidate keys is denied (no silent try-all)", async () => {
  const rsa2 = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const j = await startJwks([RSA_JWK, jwkOf(rsa2.publicKey, "rsa-2", "RS256")]);
  const tok = mintJwt(rsa.privateKey, basePayload(), { alg: "RS256" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("a token signed by a different key (right kid, wrong signer) is denied", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(attackerRsa.privateKey, basePayload(), { alg: "RS256", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("an unknown kid denies and refetches AT MOST once (cooldown holds against a stampede)", async () => {
  const j = await startJwks([RSA_JWK]);
  const v = mkVerifier(j.uri);
  // Prime the cache with a valid verify (fetch #1).
  expect(denied(await v.verifySubjectToken(mintJwt(rsa.privateKey, basePayload(), { alg: "RS256", kid: "rsa-1" })))).toBe(false);
  expect(j.state.count).toBe(1);
  const unknown = mintJwt(rsa.privateKey, basePayload(), { alg: "RS256", kid: "does-not-exist" });
  // Unknown kid forces exactly one refetch (fetch #2), still absent → deny.
  expect(denied(await v.verifySubjectToken(unknown))).toBe(true);
  expect(j.state.count).toBe(2);
  // A second unknown-kid verify within the cooldown must NOT refetch again.
  expect(denied(await v.verifySubjectToken(unknown))).toBe(true);
  expect(j.state.count).toBe(2);
});

// --- Pitfall 3: aud/iss confusion + required temporal / sub claims ----------
test("a wrong issuer is denied", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload({ iss: "https://evil" }), { alg: "RS256", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("a wrong audience is denied", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload({ aud: "some-other-app" }), { alg: "RS256", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("an array aud containing the expected audience is accepted", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload({ aud: ["other-app", aud] }), { alg: "RS256", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(false);
});

test("a missing exp is denied (exp is required, never treated as no-expiry)", async () => {
  const j = await startJwks([RSA_JWK]);
  const p = basePayload();
  delete p.exp;
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(mintJwt(rsa.privateKey, p, { alg: "RS256", kid: "rsa-1" })))).toBe(true);
});

test("a non-numeric exp is denied", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload({ exp: "later" }), { alg: "RS256", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("an expired token is denied", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload({ exp: NOW / 1000 - 1 }), { alg: "RS256", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("a missing sub is denied", async () => {
  const j = await startJwks([RSA_JWK]);
  const p = basePayload();
  delete p.sub;
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(mintJwt(rsa.privateKey, p, { alg: "RS256", kid: "rsa-1" })))).toBe(true);
});

test("a tampered payload (extra group) breaks the signature and is denied", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload(), { alg: "RS256", kid: "rsa-1" });
  const [h, , s] = tok.split(".");
  const forged = b64u(basePayload({ groups: ["eng", "admins", "root"] }));
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(`${h}.${forged}.${s}`))).toBe(true);
});

test("a groups claim that is not an array maps to empty groups", async () => {
  const j = await startJwks([RSA_JWK]);
  const tok = mintJwt(rsa.privateKey, basePayload({ groups: "eng" }), { alg: "RS256", kid: "rsa-1" });
  const out = await mkVerifier(j.uri).verifySubjectToken(tok);
  expect(denied(out)).toBe(false);
  if (!denied(out)) expect(out.groups).toEqual([]);
});

// --- Pitfall 4 + 5: fetch/cache lifecycle, DoS caps, malformed responses ---
test("a second verify within the cache TTL does NOT refetch", async () => {
  const j = await startJwks([RSA_JWK]);
  const v = mkVerifier(j.uri);
  await v.verifySubjectToken(mintJwt(rsa.privateKey, basePayload(), { alg: "RS256", kid: "rsa-1" }));
  await v.verifySubjectToken(mintJwt(rsa.privateKey, basePayload(), { alg: "RS256", kid: "rsa-1" }));
  expect(j.state.count).toBe(1);
});

test("an oversized subject token (> 64 KiB) is denied before any parse", async () => {
  const j = await startJwks([RSA_JWK]);
  const huge = "A".repeat(70 * 1024);
  const tok = mintJwt(rsa.privateKey, basePayload({ filler: huge }), { alg: "RS256", kid: "rsa-1" });
  expect(tok.length).toBeGreaterThan(64 * 1024);
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("a non-compact token (wrong segment count) is denied", async () => {
  const j = await startJwks([RSA_JWK]);
  expect(denied(await mkVerifier(j.uri).verifySubjectToken("not.a.jwt.at.all"))).toBe(true);
  expect(denied(await mkVerifier(j.uri).verifySubjectToken("only-one-segment"))).toBe(true);
});

test("a malformed (non-JSON) JWKS response denies (fail closed)", async () => {
  const j = await startJwks([RSA_JWK]);
  j.state.raw = "<html>not json</html>";
  const tok = mintJwt(rsa.privateKey, basePayload(), { alg: "RS256", kid: "rsa-1" });
  expect(denied(await mkVerifier(j.uri).verifySubjectToken(tok))).toBe(true);
});

test("a JWKS fetch failure denies (fail closed, does not throw through)", async () => {
  // Nothing listening on port 1 → fetch rejects (loopback http is allowed at construction).
  const v = mkVerifier("http://127.0.0.1:1/jwks");
  const tok = mintJwt(rsa.privateKey, basePayload(), { alg: "RS256", kid: "rsa-1" });
  expect(denied(await v.verifySubjectToken(tok))).toBe(true);
});

test("a non-https jwksUri is rejected at construction", () => {
  expect(() => createJwksIdpVerifier({ jwksUri: "http://idp.example.com/jwks", issuer: iss, audience: aud })).toThrow();
});

test("an https jwksUri (and a loopback http one for dev) is accepted at construction", () => {
  expect(() => createJwksIdpVerifier({ jwksUri: "https://idp.acme.com/jwks", issuer: iss, audience: aud })).not.toThrow();
  expect(() => createJwksIdpVerifier({ jwksUri: "http://127.0.0.1:8080/jwks", issuer: iss, audience: aud })).not.toThrow();
});

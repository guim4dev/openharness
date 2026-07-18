import { generateKeyPairSync, sign } from "node:crypto";
import { expect, test } from "vitest";
import type { Deny } from "./auth.ts";
import { createStaticKeyIdpVerifier } from "./idp-static.ts";

/** The verifier returns `{sub,groups}|Deny` (not a full Principal), so check `deny` directly. */
const denied = (x: { sub: string; groups: string[] } | Deny): x is Deny => "deny" in x;

function idpKeypair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Mint a compact EdDSA JWT — what the IdP issues. `alg` overridable for the negative test. */
function mintJwt(privateKeyPem: string, payload: Record<string, unknown>, alg = "EdDSA"): string {
  const head = b64u({ alg, typ: "JWT" });
  const body = b64u(payload);
  const sig = sign(null, Buffer.from(`${head}.${body}`), privateKeyPem).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const NOW = 1_000_000_000_000;
const base = { sub: "alice@acme.com", iss: "https://idp.acme.com", aud: "openharness-gateway", exp: NOW / 1000 + 300, groups: ["eng", "admins"] };

function verifier(pub: string) {
  return createStaticKeyIdpVerifier({ publicKeyPem: pub, issuer: base.iss, audience: base.aud, now: () => NOW });
}

test("a valid EdDSA-JWT subject token yields the IdP-asserted identity", async () => {
  const idp = idpKeypair();
  const out = await verifier(idp.publicKey).verifySubjectToken(mintJwt(idp.privateKey, base));
  expect(denied(out)).toBe(false);
  if (!denied(out)) {
    expect(out.sub).toBe("alice@acme.com");
    expect(out.groups).toEqual(["eng", "admins"]);
  }
});

test("a token signed by a DIFFERENT key is denied", async () => {
  const idp = idpKeypair();
  const attacker = idpKeypair();
  const out = await verifier(idp.publicKey).verifySubjectToken(mintJwt(attacker.privateKey, base));
  expect(denied(out)).toBe(true);
});

test("alg other than EdDSA is denied (no alg confusion / none)", async () => {
  const idp = idpKeypair();
  const none = await verifier(idp.publicKey).verifySubjectToken(mintJwt(idp.privateKey, base, "none"));
  expect(denied(none)).toBe(true);
});

test("wrong issuer / audience are denied", async () => {
  const idp = idpKeypair();
  const v = verifier(idp.publicKey);
  expect(denied(await v.verifySubjectToken(mintJwt(idp.privateKey, { ...base, iss: "https://evil" })))).toBe(true);
  expect(denied(await v.verifySubjectToken(mintJwt(idp.privateKey, { ...base, aud: "some-other-app" })))).toBe(true);
});

test("an expired token is denied", async () => {
  const idp = idpKeypair();
  const expired = mintJwt(idp.privateKey, { ...base, exp: NOW / 1000 - 1 });
  expect(denied(await verifier(idp.publicKey).verifySubjectToken(expired))).toBe(true);
});

test("a token with NO exp is denied — exp is required, never treated as no-expiry", async () => {
  const idp = idpKeypair();
  const noExp = { sub: base.sub, iss: base.iss, aud: base.aud, groups: base.groups }; // no exp
  expect(denied(await verifier(idp.publicKey).verifySubjectToken(mintJwt(idp.privateKey, noExp)))).toBe(true);
});

test("a non-numeric exp (string) is denied, not skipped", async () => {
  const idp = idpKeypair();
  const strExp = mintJwt(idp.privateKey, { ...base, exp: "1" as unknown as number });
  expect(denied(await verifier(idp.publicKey).verifySubjectToken(strExp))).toBe(true);
});

test("a non-numeric nbf (string) is denied, not skipped", async () => {
  const idp = idpKeypair();
  const strNbf = mintJwt(idp.privateKey, { ...base, nbf: String(NOW / 1000 + 10000) as unknown as number });
  expect(denied(await verifier(idp.publicKey).verifySubjectToken(strNbf))).toBe(true);
});

test("a tampered payload (extra group) breaks the signature and is denied", async () => {
  const idp = idpKeypair();
  const tok = mintJwt(idp.privateKey, base);
  const [h, , s] = tok.split(".");
  const forgedBody = b64u({ ...base, groups: ["eng", "admins", "root"] });
  const out = await verifier(idp.publicKey).verifySubjectToken(`${h}.${forgedBody}.${s}`);
  expect(denied(out)).toBe(true);
});

test("an array `aud` containing the expected audience is accepted", async () => {
  const idp = idpKeypair();
  const tok = mintJwt(idp.privateKey, { ...base, aud: ["other-app", "openharness-gateway"] });
  expect(denied(await verifier(idp.publicKey).verifySubjectToken(tok))).toBe(false);
});

test("a non-string subject token is denied, not thrown (seam guard)", async () => {
  const idp = idpKeypair();
  const v = verifier(idp.publicKey);
  for (const bad of [12345, null, undefined, {}] as unknown[]) {
    expect(denied(await v.verifySubjectToken(bad as string))).toBe(true);
  }
});

test("a whitespace-only sub is denied", async () => {
  const idp = idpKeypair();
  expect(denied(await verifier(idp.publicKey).verifySubjectToken(mintJwt(idp.privateKey, { ...base, sub: "   " })))).toBe(true);
});

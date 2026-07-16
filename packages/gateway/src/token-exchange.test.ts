import { expect, test } from "vitest";
import { createDpopProof, generateAuthKeypair, isDeny, validateRequest } from "./auth.ts";
import { exchangeToken, type IdpVerifier } from "./token-exchange.ts";

const NOW = 1_000_000;
const REQ_URL = "https://gw.acme.internal/mcp";

/** A stub IdP: accepts one known subject token, denies everything else. */
const stubIdp: IdpVerifier = {
  async verifySubjectToken(t) {
    if (t === "valid-oidc-token") return { sub: "alice@acme.com", groups: ["eng"] };
    return { deny: "bad subject token" };
  },
};

test("exchanges a valid IdP subject token for a DPoP-bound gateway token that then validates", async () => {
  const gateway = generateAuthKeypair();
  const client = generateAuthKeypair();

  const exchanged = await exchangeToken(
    {
      subjectToken: "valid-oidc-token",
      clientPublicKeyPem: client.publicKey,
      harnessId: "acme-assistant",
      defVersion: "1.0.0",
      sessionId: "s1",
    },
    { idp: stubIdp, gatewayPrivateKeyPem: gateway.privateKey, ttlMs: 60_000, now: NOW },
  );
  expect("deny" in exchanged).toBe(false);
  if ("deny" in exchanged) return;

  // The minted token + a fresh client proof validates through the normal edge path,
  // and carries the IdP-asserted identity.
  const proof = createDpopProof(client.privateKey, { method: "POST", url: REQ_URL }, NOW);
  const principal = validateRequest(
    { token: exchanged.token, dpopProof: proof, clientPublicKeyPem: client.publicKey, method: "POST", url: REQ_URL },
    gateway.publicKey,
    { now: NOW },
  );
  expect(isDeny(principal)).toBe(false);
  if (!isDeny(principal)) {
    expect(principal.sub).toBe("alice@acme.com"); // IdP-asserted, not client-asserted
    expect(principal.groups).toEqual(["eng"]);
    expect(principal.harnessId).toBe("acme-assistant");
  }
});

test("a rejected subject token yields NO token (deny)", async () => {
  const gateway = generateAuthKeypair();
  const client = generateAuthKeypair();
  const out = await exchangeToken(
    { subjectToken: "forged", clientPublicKeyPem: client.publicKey, harnessId: "h", defVersion: "0", sessionId: "s" },
    { idp: stubIdp, gatewayPrivateKeyPem: gateway.privateKey, ttlMs: 60_000, now: NOW },
  );
  expect("deny" in out).toBe(true);
});

test("a token bound to the client key can't be used with a DIFFERENT key (still key-bound)", async () => {
  const gateway = generateAuthKeypair();
  const client = generateAuthKeypair();
  const attacker = generateAuthKeypair();
  const exchanged = await exchangeToken(
    { subjectToken: "valid-oidc-token", clientPublicKeyPem: client.publicKey, harnessId: "h", defVersion: "0", sessionId: "s" },
    { idp: stubIdp, gatewayPrivateKeyPem: gateway.privateKey, ttlMs: 60_000, now: NOW },
  );
  if ("deny" in exchanged) throw new Error("expected a token");
  // Attacker steals the token but signs the proof with their own key → denied.
  const proof = createDpopProof(attacker.privateKey, { method: "POST", url: REQ_URL }, NOW);
  const principal = validateRequest(
    { token: exchanged.token, dpopProof: proof, clientPublicKeyPem: attacker.publicKey, method: "POST", url: REQ_URL },
    gateway.publicKey,
    { now: NOW },
  );
  expect(isDeny(principal)).toBe(true);
});

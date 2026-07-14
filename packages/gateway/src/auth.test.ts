import { expect, test } from "vitest";
import {
  createDpopProof,
  createReplayGuard,
  generateAuthKeypair,
  isDeny,
  mintGatewayToken,
  validateRequest,
  type GatewayClaims,
} from "./auth.ts";

const NOW = 1_000_000;
const claims: GatewayClaims = {
  sub: "alice@acme.test",
  groups: ["eng"],
  harnessId: "acme-fintech",
  defVersion: "0.1.0",
  sessionId: "s1",
};
const req = { method: "POST", url: "https://gw.acme.internal/mcp" };

function setup() {
  const gw = generateAuthKeypair();
  const client = generateAuthKeypair();
  const token = mintGatewayToken(claims, gw.privateKey, client.publicKey, { ttlMs: 60_000, now: NOW });
  return { gw, client, token };
}

test("no token is denied", () => {
  const { gw } = setup();
  const r = validateRequest({ ...req }, gw.publicKey, { now: NOW });
  expect(isDeny(r)).toBe(true);
});

test("a valid token + matching-key DPoP proof yields the principal", () => {
  const { gw, client, token } = setup();
  const dpopProof = createDpopProof(client.privateKey, req, NOW);
  const r = validateRequest(
    { ...req, token, dpopProof, clientPublicKeyPem: client.publicKey },
    gw.publicKey,
    { now: NOW },
  );
  expect(isDeny(r)).toBe(false);
  if (!isDeny(r)) {
    expect(r.sub).toBe("alice@acme.test");
    expect(r.groups).toEqual(["eng"]);
  }
});

test("a proof is single-use under a ReplayGuard — the same proof cannot be replayed", () => {
  const { gw, client, token } = setup();
  const dpopProof = createDpopProof(client.privateKey, req, NOW);
  const replayGuard = createReplayGuard();
  const args = [{ ...req, token, dpopProof, clientPublicKeyPem: client.publicKey }, gw.publicKey, { now: NOW, replayGuard }] as const;

  const first = validateRequest(...args);
  expect(isDeny(first)).toBe(false); // legit request accepted

  const replay = validateRequest(...args); // identical proof, still inside the window
  expect(isDeny(replay)).toBe(true);
  if (isDeny(replay)) expect(replay.deny).toMatch(/replay/);
});

test("the proof freshness window is 60s (a 2-minute-old proof is stale)", () => {
  const { gw, client, token } = setup();
  const dpopProof = createDpopProof(client.privateKey, req, NOW - 120_000);
  const r = validateRequest(
    { ...req, token, dpopProof, clientPublicKeyPem: client.publicKey },
    gw.publicKey,
    { now: NOW },
  );
  expect(isDeny(r)).toBe(true);
  if (isDeny(r)) expect(r.deny).toMatch(/stale/);
});

test("a stolen token presented with a DIFFERENT proof key is denied (off-machine replay)", () => {
  const { gw, token } = setup();
  const attacker = generateAuthKeypair(); // attacker has the token but not the client's key
  const dpopProof = createDpopProof(attacker.privateKey, req, NOW);
  const r = validateRequest(
    { ...req, token, dpopProof, clientPublicKeyPem: attacker.publicKey },
    gw.publicKey,
    { now: NOW },
  );
  expect(isDeny(r)).toBe(true);
});

test("an expired token is denied", () => {
  const { gw, client, token } = setup();
  const dpopProof = createDpopProof(client.privateKey, req, NOW + 120_000);
  const r = validateRequest(
    { ...req, token, dpopProof, clientPublicKeyPem: client.publicKey },
    gw.publicKey,
    { now: NOW + 120_000 }, // past the 60s ttl
  );
  expect(isDeny(r)).toBe(true);
});

test("a token forged under the wrong gateway key is denied", () => {
  const { client, token } = setup();
  const otherGw = generateAuthKeypair();
  const dpopProof = createDpopProof(client.privateKey, req, NOW);
  const r = validateRequest(
    { ...req, token, dpopProof, clientPublicKeyPem: client.publicKey },
    otherGw.publicKey, // validate under a different gateway key
    { now: NOW },
  );
  expect(isDeny(r)).toBe(true);
});

test("a proof for a different request (htu) is denied", () => {
  const { gw, client, token } = setup();
  const dpopProof = createDpopProof(client.privateKey, { method: "POST", url: "https://evil/mcp" }, NOW);
  const r = validateRequest(
    { ...req, token, dpopProof, clientPublicKeyPem: client.publicKey },
    gw.publicKey,
    { now: NOW },
  );
  expect(isDeny(r)).toBe(true);
});

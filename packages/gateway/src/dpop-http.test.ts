import { describe, expect, test } from "vitest";
import { generateAuthKeypair, isDeny, mintGatewayToken, type GatewayClaims } from "./auth.ts";
import { createDpopFetch, dpopFromHttp, proofUrl } from "./dpop-http.ts";

const CLAIMS: GatewayClaims = {
  sub: "alice@acme.com",
  groups: ["eng"],
  harnessId: "acme-assistant",
  defVersion: "1.0.0",
  sessionId: "sess-1",
};

/** Mint a gateway + client keypair and a token binding the client key. */
function setup(now: number) {
  const gateway = generateAuthKeypair();
  const client = generateAuthKeypair();
  const token = mintGatewayToken(CLAIMS, gateway.privateKey, client.publicKey, { ttlMs: 60_000, now });
  return { gateway, client, token };
}

describe("dpop-http", () => {
  test("proofUrl normalizes absolute URLs to path+query and passes through paths", () => {
    expect(proofUrl("https://gw.acme.internal/mcp?x=1")).toBe("/mcp?x=1");
    expect(proofUrl("/mcp")).toBe("/mcp");
  });

  test("createDpopFetch attaches headers the server accepts (round-trip → Principal)", async () => {
    const now = 1_000_000;
    const { gateway, client, token } = setup(now);

    // Capture what the wrapped fetch would send, without hitting the network.
    let captured: { url: string; method: string; headers: Headers } | undefined;
    const baseFetch = async (input: unknown, init?: RequestInit) => {
      captured = { url: String(input), method: (init?.method ?? "POST").toUpperCase(), headers: new Headers(init?.headers) };
      return new Response("ok");
    };

    const fetchImpl = createDpopFetch(token, client.privateKey, client.publicKey, baseFetch, () => now);
    await fetchImpl("https://gw.acme.internal/mcp", { method: "POST" });

    expect(captured).toBeDefined();
    expect(captured!.headers.get("authorization")).toBe(`DPoP ${token}`);
    expect(captured!.headers.get("dpop")).toBeTruthy();

    // Server side: the captured headers validate against the gateway pubkey.
    const principal = dpopFromHttp(captured!.headers, { method: "POST", url: "/mcp" }, gateway.publicKey, now);
    expect(isDeny(principal)).toBe(false);
    if (!isDeny(principal)) {
      expect(principal.sub).toBe("alice@acme.com");
      expect(principal.groups).toEqual(["eng"]);
    }
  });

  test("preserves the caller's existing headers while adding DPoP", async () => {
    const now = 2_000_000;
    const { client, token } = setup(now);
    let captured: Headers | undefined;
    const baseFetch = async (_input: unknown, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response("ok");
    };
    const fetchImpl = createDpopFetch(token, client.privateKey, client.publicKey, baseFetch, () => now);
    await fetchImpl("https://gw.acme.internal/mcp", { method: "POST", headers: { "content-type": "application/json" } });
    expect(captured!.get("content-type")).toBe("application/json");
    expect(captured!.get("authorization")).toBe(`DPoP ${token}`);
  });

  test("denies when the DPoP proof header is missing", async () => {
    const now = 3_000_000;
    const { gateway, token } = setup(now);
    const principal = dpopFromHttp({ authorization: `DPoP ${token}` }, { method: "POST", url: "/mcp" }, gateway.publicKey, now);
    expect(isDeny(principal)).toBe(true);
  });

  test("denies a proof minted for a different method (replay to another verb)", async () => {
    const now = 4_000_000;
    const { gateway, client, token } = setup(now);
    let captured: Headers | undefined;
    const baseFetch = async (_input: unknown, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response("ok");
    };
    const fetchImpl = createDpopFetch(token, client.privateKey, client.publicKey, baseFetch, () => now);
    await fetchImpl("https://gw.acme.internal/mcp", { method: "POST" });
    // Same headers, but the server sees a GET — htm mismatch must deny.
    const principal = dpopFromHttp(captured!, { method: "GET", url: "/mcp" }, gateway.publicKey, now);
    expect(isDeny(principal)).toBe(true);
  });

  test("denies when the presented client key is not the bound key (stolen token)", async () => {
    const now = 5_000_000;
    const { gateway, token } = setup(now);
    const attacker = generateAuthKeypair();
    // Attacker has the token but signs the proof with their OWN key.
    let captured: Headers | undefined;
    const baseFetch = async (_input: unknown, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response("ok");
    };
    const fetchImpl = createDpopFetch(token, attacker.privateKey, attacker.publicKey, baseFetch, () => now);
    await fetchImpl("https://gw.acme.internal/mcp", { method: "POST" });
    const principal = dpopFromHttp(captured!, { method: "POST", url: "/mcp" }, gateway.publicKey, now);
    expect(isDeny(principal)).toBe(true);
    if (isDeny(principal)) expect(principal.deny).toMatch(/not bound/);
  });
});

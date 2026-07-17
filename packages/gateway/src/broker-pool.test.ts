import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parsePolicy } from "@openharness/policy";
import type { AuditSink } from "@openharness/audit";
import { CredentialPool, PooledKmsStore } from "./broker-pool.ts";
import { createGateway, type GatewayPipeline } from "./server.ts";
import { createApprovalQueue } from "./approval.ts";
import type { Connector } from "./connectors/index.ts";
import type { Principal } from "./auth.ts";

// ── CredentialPool ──────────────────────────────────────────────────────────

test("next() returns the first healthy ref; an auth failure invalidates it so the next call rotates", () => {
  const pool = new CredentialPool();
  expect(pool.next("gh", ["a", "b"])).toBe("a");
  pool.report("gh", "a", { ok: false, kind: "auth" });
  expect(pool.next("gh", ["a", "b"])).toBe("b"); // rotated past the invalid one
  expect(pool.next("other", ["a", "b"])).toBe("a"); // health is per-upstream
});

test("rate_limit backs off temporarily and auto-heals after `until`", () => {
  let now = 1_000_000;
  const pool = new CredentialPool({ now: () => now });
  pool.report("gh", "a", { ok: false, kind: "rate_limit", retryAfterMs: 5_000 });
  expect(pool.next("gh", ["a", "b"])).toBe("b"); // a is backed off
  now += 5_001;
  expect(pool.next("gh", ["a", "b"])).toBe("a"); // healed
});

test("`other` (transient) does NOT invalidate a credential", () => {
  const pool = new CredentialPool();
  pool.report("gh", "a", { ok: false, kind: "other" });
  expect(pool.next("gh", ["a", "b"])).toBe("a"); // still healthy
});

test("a later ok report heals an invalidated credential", () => {
  const pool = new CredentialPool();
  pool.report("gh", "a", { ok: false, kind: "auth" });
  expect(pool.next("gh", ["a"])).toBeUndefined(); // all unhealthy
  pool.report("gh", "a", { ok: true });
  expect(pool.next("gh", ["a"])).toBe("a");
});

// ── PooledKmsStore ────────────────────────────────────────────────────────────

test("resolve tags credentialId and rotates to the next ref after a reported auth failure", async () => {
  const secrets: Record<string, string> = { a: "tok-a", b: "tok-b" };
  const store = new PooledKmsStore({
    upstreams: { gh: ["a", "b"] },
    resolveRef: async (ref) => (secrets[ref] ? { secret: secrets[ref] } : undefined),
  });

  const first = await store.resolve("gh");
  expect(first).toEqual({ secret: "tok-a", credentialId: "a" });
  store.report("gh", first!.credentialId, { ok: false, kind: "auth" });

  const second = await store.resolve("gh");
  expect(second).toEqual({ secret: "tok-b", credentialId: "b" });
});

test("resolve returns undefined when every credential in the pool is unhealthy (fail closed)", async () => {
  const store = new PooledKmsStore({ upstreams: { gh: ["a"] }, resolveRef: async () => ({ secret: "x" }) });
  store.report("gh", "a", { ok: false, kind: "auth" });
  expect(await store.resolve("gh")).toBeUndefined();
});

// ── Rotation through the real governed pipeline ───────────────────────────────

const PRINCIPAL: Principal = { sub: "alice@acme.test", groups: ["eng"], harnessId: "h", defVersion: "0", sessionId: "s" };

/** A connector that FAILS (throws an auth error) on credential "a" and succeeds on "b". */
function credentialSensitiveConnector(): Connector {
  return {
    id: "gh",
    tools: [{ name: "gh__read" }],
    allowHosts: [],
    async call(_tool, _args, cred) {
      if (cred.credentialId === "a") throw new Error("github error 401 unauthorized");
      return { content: [{ type: "text", text: `ok via ${cred.credentialId}` }] };
    },
  };
}

async function pipelineHarness(broker: PooledKmsStore) {
  const audit: AuditSink = { record: () => {} };
  const pipeline: GatewayPipeline = {
    policy: parsePolicy({ default: "allow", rules: [] }),
    policyVersion: "0",
    resolvePrincipal: () => PRINCIPAL,
    broker,
    sessions: { for: () => credentialSensitiveConnector(), size: () => 1 },
    audit,
    approval: createApprovalQueue({ timeoutMs: 1_000 }),
  };
  const gw = createGateway({ catalog: [{ name: "gh__read", connectorId: "gh", upstreamId: "gh" }], pipeline });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gw.server.connect(st);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(ct);
  return { client, close: () => gw.close() };
}

test("end-to-end: a failing credential is reported by the pipeline and the NEXT call rotates to a healthy one", async () => {
  const broker = new PooledKmsStore({
    upstreams: { gh: ["a", "b"] },
    resolveRef: async (ref) => ({ secret: `tok-${ref}` }),
  });
  const h = await pipelineHarness(broker);
  try {
    // Call 1 draws credential "a" → the connector throws 401 → the pipeline reports
    // an auth failure → the pool invalidates "a".
    const r1 = await h.client.callTool({ name: "gh__read", arguments: {} });
    expect(r1.isError).toBe(true);

    // Call 2 now rotates to "b" and succeeds — rotation happened behind the gateway.
    const r2 = await h.client.callTool({ name: "gh__read", arguments: {} });
    expect(r2.isError).toBeFalsy();
    expect(JSON.stringify(r2.content)).toContain("ok via b");
  } finally {
    await h.close();
  }
});

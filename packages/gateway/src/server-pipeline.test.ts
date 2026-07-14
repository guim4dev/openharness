import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemorySecretStore } from "@openharness/credentials";
import { parsePolicy } from "@openharness/policy";
import type { AuditSink, AuditEntry } from "@openharness/audit";
import { createGateway, type GatewayPipeline } from "./server.ts";
import { createConnectorSessions } from "./sessions.ts";
import { createGithubReadConnector } from "./connectors/github-read.ts";
import { SecretStoreKms } from "./broker.ts";
import { createApprovalQueue } from "./approval.ts";
import type { Deny, Principal } from "./auth.ts";

const CATALOG = [{ name: "github__list_issues", connectorId: "github", upstreamId: "github" }];

function fakeResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as unknown as Response;
}
function stubFetch(): typeof fetch {
  return (async () => fakeResponse('[{"number":1,"title":"a bug"}]')) as unknown as typeof fetch;
}

interface Harness {
  client: Client;
  close: () => Promise<void>;
  audit: AuditEntry[];
  approval: ReturnType<typeof createApprovalQueue>;
}

async function harness(over: Partial<GatewayPipeline> & { policyRaw?: unknown } = {}): Promise<Harness> {
  const store = new InMemorySecretStore();
  await store.set("upstream:github", "ghp_orgtoken");
  const captured: AuditEntry[] = [];
  const audit: AuditSink = { record: (e) => void captured.push(e) };
  const approval = createApprovalQueue({ timeoutMs: 2_000 });
  const principal: Principal = {
    sub: "alice@acme.test",
    groups: ["eng"],
    harnessId: "h",
    defVersion: "0.1.0",
    sessionId: "s",
  };
  const pipeline: GatewayPipeline = {
    policy: parsePolicy(over.policyRaw ?? { default: "allow", rules: [] }),
    policyVersion: "0.1.0",
    resolvePrincipal: over.resolvePrincipal ?? (() => principal),
    broker: over.broker ?? new SecretStoreKms(store),
    sessions: createConnectorSessions({ github: () => createGithubReadConnector(stubFetch()) }),
    audit,
    approval,
  };
  const gw = createGateway({ catalog: CATALOG, pipeline });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gw.server.connect(st);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(ct);
  return { client, close: () => gw.close(), audit: captured, approval };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

test("end-to-end: an allowed call flows harness -> gateway -> upstream -> back, audited", async () => {
  const h = await harness();
  try {
    const res = await h.client.callTool({ name: "github__list_issues", arguments: { owner: "acme", repo: "app" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("a bug");
    // Audited: a tool_call(allow) attributed to the principal + a tool_result.
    const call = h.audit.find((e) => e.type === "tool_call") as { decision?: string; principal?: string } | undefined;
    expect(call?.decision).toBe("allow");
    expect(call?.principal).toBe("alice@acme.test");
    expect(h.audit.some((e) => e.type === "tool_result")).toBe(true);
  } finally {
    await h.close();
  }
});

test("a denied tool is blocked, audited deny, and the upstream is never reached", async () => {
  const h = await harness({ policyRaw: { default: "deny", rules: [] } });
  try {
    const res = await h.client.callTool({ name: "github__list_issues", arguments: { owner: "a", repo: "b" } });
    expect(res.isError).toBe(true);
    const call = h.audit.find((e) => e.type === "tool_call") as { decision?: string } | undefined;
    expect(call?.decision).toBe("deny");
    // No tool_result -> the connector/upstream was never reached (broker not called).
    expect(h.audit.some((e) => e.type === "tool_result")).toBe(false);
  } finally {
    await h.close();
  }
});

test("an ask tool suspends until approved, then proceeds (audited ask-approved)", async () => {
  const h = await harness({
    policyRaw: { default: "deny", rules: [{ match: "github__list_issues", action: "ask" }] },
  });
  try {
    const call = h.client.callTool({ name: "github__list_issues", arguments: { owner: "a", repo: "b" } });
    await waitFor(() => h.approval.pending().length > 0);
    h.approval.resolve(h.approval.pending()[0].id, true);
    const res = await call;
    expect(res.isError).toBeFalsy();
    const entry = h.audit.find((e) => e.type === "tool_call") as { decision?: string } | undefined;
    expect(entry?.decision).toBe("ask-approved");
  } finally {
    await h.close();
  }
});

test("an unauthorized caller is refused before policy/credential", async () => {
  const deny: Deny = { deny: "no token" };
  const h = await harness({ resolvePrincipal: () => deny });
  try {
    const res = await h.client.callTool({ name: "github__list_issues", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("unauthorized");
    expect(h.audit).toHaveLength(0); // nothing governed/audited
  } finally {
    await h.close();
  }
});

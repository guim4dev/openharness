import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemorySecretStore } from "@openharness/credentials";
import { parsePolicy } from "@openharness/policy";
import type { AuditEntry, AuditSink } from "@openharness/audit";
import { generateAuthKeypair, mintGatewayToken, type GatewayClaims } from "./auth.ts";
import { createDpopFetch } from "./dpop-http.ts";
import { startGatewayHttp, type GatewayHttpServer } from "./http.ts";
import { createConnectorSessions } from "./sessions.ts";
import { createGithubReadConnector } from "./connectors/github-read.ts";
import { SecretStoreKms } from "./broker.ts";
import { createApprovalQueue } from "./approval.ts";

const CATALOG = [{ name: "github__list_issues", connectorId: "github", upstreamId: "github" }];
const CLAIMS: GatewayClaims = {
  sub: "alice@acme.com",
  groups: ["eng"],
  harnessId: "acme-assistant",
  defVersion: "1.0.0",
  sessionId: "sess-1",
};

function fakeResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as unknown as Response;
}
function stubGithub(): typeof fetch {
  return (async () => fakeResponse('[{"number":1,"title":"a bug"}]')) as unknown as typeof fetch;
}

let running: GatewayHttpServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function boot(policyRaw: unknown = { default: "allow", rules: [] }) {
  const gateway = generateAuthKeypair();
  const store = new InMemorySecretStore();
  await store.set("upstream:github", "ghp_orgtoken");
  const captured: AuditEntry[] = [];
  const audit: AuditSink = { record: (e) => void captured.push(e) };
  running = await startGatewayHttp({
    catalog: CATALOG,
    gatewayPublicKeyPem: gateway.publicKey,
    pipeline: {
      policy: parsePolicy(policyRaw),
      policyVersion: "1.0.0",
      broker: new SecretStoreKms(store),
      sessions: createConnectorSessions({ github: () => createGithubReadConnector(stubGithub()) }),
      audit,
      approval: createApprovalQueue({ timeoutMs: 2_000 }),
    },
  });
  return { gateway, url: running.url, audit: captured };
}

/** A real MCP client that authenticates with a DPoP-bound token. */
async function connectClient(url: string, gatewayPrivateKey: string): Promise<Client> {
  const client = generateAuthKeypair();
  const token = mintGatewayToken(CLAIMS, gatewayPrivateKey, client.publicKey, {
    ttlMs: 60_000,
    now: Date.now(),
  });
  const dpopFetch = createDpopFetch(token, client.privateKey, client.publicKey);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: dpopFetch as unknown as typeof fetch,
  });
  const mcp = new Client({ name: "harness", version: "0" }, { capabilities: {} });
  await mcp.connect(transport);
  return mcp;
}

test("e2e over real HTTP: DPoP-authenticated client runs a governed call end-to-end", async () => {
  const { gateway, url, audit } = await boot();
  const mcp = await connectClient(url, gateway.privateKey);
  try {
    const tools = await mcp.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("github__list_issues");

    const res = await mcp.callTool({ name: "github__list_issues", arguments: { owner: "acme", repo: "app" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("a bug");

    const call = audit.find((e) => e.type === "tool_call") as { decision?: string; principal?: string } | undefined;
    expect(call?.decision).toBe("allow");
    expect(call?.principal).toBe("alice@acme.com");
    expect(audit.some((e) => e.type === "tool_result")).toBe(true);
  } finally {
    await mcp.close();
  }
});

test("e2e over real HTTP: a client WITHOUT DPoP is rejected at the edge (401)", async () => {
  const { url } = await boot();
  const transport = new StreamableHTTPClientTransport(new URL(url)); // plain fetch, no DPoP
  const mcp = new Client({ name: "attacker", version: "0" }, { capabilities: {} });
  await expect(mcp.connect(transport)).rejects.toThrow();
});

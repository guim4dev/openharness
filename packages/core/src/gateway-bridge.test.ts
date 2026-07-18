import { afterEach, expect, test } from "vitest";
import { InMemorySecretStore } from "@openharness/credentials";
import { parsePolicy } from "@openharness/policy";
import type { AuditEntry, AuditSink } from "@openharness/audit";
import type { HarnessGatewayConfig } from "@openharness/definition";
import {
  createApprovalQueue,
  createConnectorSessions,
  createGithubReadConnector,
  generateAuthKeypair,
  mintGatewayToken,
  SecretStoreKms,
  startGatewayHttp,
  type GatewayClaims,
  type GatewayHttpServer,
} from "@openharness/gateway";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpConnection, McpToolInfo } from "@openharness/mcp";
import { loadGatewayTools, type GatewayAuth } from "./gateway-bridge.ts";

/** Invoke a bridged tool — the bridge reads only (toolCallId, params). */
function run(tool: ToolDefinition, args: Record<string, unknown>): Promise<{ content: unknown }> {
  return (tool.execute as unknown as (id: string, p: unknown) => Promise<{ content: unknown }>)("call-1", args);
}

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
  const gatewayKeys = generateAuthKeypair();
  const store = new InMemorySecretStore();
  await store.set("upstream:github", "ghp_orgtoken");
  const captured: AuditEntry[] = [];
  const audit: AuditSink = { record: (e) => void captured.push(e) };
  running = await startGatewayHttp({
    catalog: CATALOG,
    gatewayPublicKeyPem: gatewayKeys.publicKey,
    gatewayPrivateKeyPem: gatewayKeys.privateKey,
    pipeline: {
      policy: parsePolicy(policyRaw),
      policyVersion: "1.0.0",
      broker: new SecretStoreKms(store),
      sessions: createConnectorSessions({ github: () => createGithubReadConnector(stubGithub()) }),
      audit,
      approval: createApprovalQueue({ timeoutMs: 2_000 }),
    },
  });

  // Mint the DPoP-bound token + client keypair the harness would obtain via IdP.
  const client = generateAuthKeypair();
  const token = mintGatewayToken(CLAIMS, gatewayKeys.privateKey, client.publicKey, {
    ttlMs: 60_000,
    now: Date.now(),
  });
  const auth: GatewayAuth = { token, clientPublicKey: client.publicKey, clientPrivateKey: client.privateKey };
  const config: HarnessGatewayConfig = { url: running.url, pubkey: gatewayKeys.publicKey, tools: ["github__list_issues"] };
  return { config, auth, audit: captured };
}

test("bridges a declared gateway's pinned tools as mcp__gateway__<tool>", async () => {
  const { config, auth } = await boot();
  const { tools, dispose } = await loadGatewayTools(config, auth);
  try {
    expect(tools.map((t) => t.name)).toEqual(["mcp__gateway__github__list_issues"]);
  } finally {
    await dispose();
  }
});

test("executing a bridged gateway tool flows through the governed pipeline (audited allow)", async () => {
  const { config, auth, audit } = await boot();
  const { tools, dispose } = await loadGatewayTools(config, auth);
  try {
    const tool = tools.find((t) => t.name === "mcp__gateway__github__list_issues")!;
    const result = await run(tool, { owner: "acme", repo: "app" });
    expect(JSON.stringify(result.content)).toContain("a bug");

    const call = audit.find((e) => e.type === "tool_call") as { decision?: string; principal?: string } | undefined;
    expect(call?.decision).toBe("allow");
    expect(call?.principal).toBe("alice@acme.com");
  } finally {
    await dispose();
  }
});

test("a denied gateway tool throws when executed, and the upstream is never reached", async () => {
  const { config, auth, audit } = await boot({ default: "deny", rules: [] });
  const { tools, dispose } = await loadGatewayTools(config, auth);
  try {
    const tool = tools.find((t) => t.name === "mcp__gateway__github__list_issues")!;
    // The gateway denies -> the bridged MCP tool surfaces an error -> Pi contract throws.
    await expect(run(tool, { owner: "a", repo: "b" })).rejects.toThrow();
    expect(audit.some((e) => e.type === "tool_result")).toBe(false);
  } finally {
    await dispose();
  }
});

test("requires https for a non-loopback gateway (refuses credentials over plaintext)", async () => {
  const gatewayKeys = generateAuthKeypair();
  const client = generateAuthKeypair();
  const token = mintGatewayToken(CLAIMS, gatewayKeys.privateKey, client.publicKey, { ttlMs: 60_000, now: Date.now() });
  const auth: GatewayAuth = { token, clientPublicKey: client.publicKey, clientPrivateKey: client.privateKey };
  const config: HarnessGatewayConfig = { url: "http://gw.acme.internal/mcp", pubkey: gatewayKeys.publicKey, tools: [] };
  await expect(loadGatewayTools(config, auth)).rejects.toThrow(/https/);
});

test("pin enforced: a gateway not proving the pinned pubkey is refused (fake gateway)", async () => {
  const { auth, config } = await boot();
  // Same URL + a valid token, but the harness pinned the WRONG pubkey: the real
  // gateway's response signature won't verify against it -> the client refuses.
  const impostorPin = generateAuthKeypair().publicKey;
  const badConfig: HarnessGatewayConfig = { ...config, pubkey: impostorPin };
  await expect(loadGatewayTools(badConfig, auth)).rejects.toThrow();
});

test("skips a gateway-served tool whose name is unsafe (an untrusted name can't poison the Pi tool list)", async () => {
  // Same guard the local MCP loader applies (isSafeMcpToolName): a gateway is an
  // untrusted upstream too. tools:[] takes the served catalog as-is, so an unsafe
  // name reaches the safety guard rather than being filtered by the allowlist.
  const gatewayKeys = generateAuthKeypair();
  const client = generateAuthKeypair();
  const token = mintGatewayToken(CLAIMS, gatewayKeys.privateKey, client.publicKey, { ttlMs: 60_000, now: Date.now() });
  const auth: GatewayAuth = { token, clientPublicKey: client.publicKey, clientPrivateKey: client.privateKey };
  const config: HarnessGatewayConfig = { url: "https://gw.acme.internal/mcp", pubkey: gatewayKeys.publicKey, tools: [] };

  const served: McpToolInfo[] = [
    { name: "safe_tool" },
    { name: "slash/name" }, // non-[A-Za-z0-9_.-] char -> unsafe
    { name: "has space" }, // whitespace -> unsafe
    { name: "x".repeat(101) }, // over the length cap -> unsafe
  ];
  const logs: string[] = [];
  const fakeConn: McpConnection = {
    listTools: async () => served,
    callTool: async () => ({ content: [] }),
    close: async () => {},
  };

  const { tools, dispose } = await loadGatewayTools(config, auth, {
    connect: async () => fakeConn,
    logger: (m) => logs.push(m),
  });
  try {
    // Only the safe tool is bridged; the three hostile names are dropped.
    expect(tools.map((t) => t.name)).toEqual(["mcp__gateway__safe_tool"]);
    expect(tools.some((t) => t.name.includes("slash/name"))).toBe(false);
    // The skip is logged (observability), not silent.
    expect(logs.some((m) => m.includes("unsafe"))).toBe(true);
  } finally {
    await dispose();
  }
});

test("fail-closed: a declared gateway that cannot be reached throws (offline hard-fail)", async () => {
  const gatewayKeys = generateAuthKeypair();
  const client = generateAuthKeypair();
  const token = mintGatewayToken(CLAIMS, gatewayKeys.privateKey, client.publicKey, { ttlMs: 60_000, now: Date.now() });
  const auth: GatewayAuth = { token, clientPublicKey: client.publicKey, clientPrivateKey: client.privateKey };
  // Nothing listening on this port.
  const config: HarnessGatewayConfig = { url: "http://127.0.0.1:1/mcp", pubkey: gatewayKeys.publicKey, tools: [] };
  await expect(loadGatewayTools(config, auth)).rejects.toThrow(/failed to connect/);
});

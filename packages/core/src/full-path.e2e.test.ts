import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import {
  AuthProviderRegistry,
  CredentialManager,
  InMemorySecretStore,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";
import { bundleDefinition, generateKeypair, writeBundle, BundleVerificationError } from "@openharness/bundle";
import { createFileAuditLog, hashCanonical, reconcileAuditLogs, verifyAuditLog } from "@openharness/audit";
import type { ConnectFn, McpConnection } from "@openharness/mcp";

import { resolvePinnedBundle } from "./update.ts";
import { createLiveSession } from "./live-session.ts";
import type { LiveSessionEvent } from "./live-session.ts";

/**
 * FULL-PATH composition proof: the SUPPLY-CHAIN half (sign → pin → anti-rollback
 * floor → verify) fused to the RUNTIME half (policy decision → audit → reconcile)
 * in a single run. Each half is unit-tested to death; `governance-integration`
 * proves the runtime half composes. NOTHING else proves the SEAM between them —
 * that the policy which actually governs a live tool call is the one carried by a
 * signed, pinned, floor-checked bundle, not an inline test convenience.
 *
 * That seam is where tonight's real bugs lived (the two-stage floor mismatch; an
 * earlier round-trip that silently dropped a security pin), so it gets an
 * end-to-end test with adversarial variants at each seam, not just a happy path:
 *   (1) happy path: bundleDefinition (reproducible) → resolvePinnedBundle at a
 *       floor → createLiveSession booting `verified` (NO inline policy) → a denied
 *       MCP call is blocked and an allowed call is redacted, both by the BUNDLE's
 *       policy → the audit chain verifies → it reconciles clean against a gateway
 *       chain of the same governed call (and drift is caught).
 *   (2) a tampered bundle is refused by BOTH resolve and the verified boot.
 *   (3) a bundle below the effective floor is refused by BOTH.
 */

const SECRET = "sk-LIVE-deadBEEF0123";
const PLACEHOLDER = "sk-REDACTED";
const VERSION = "0.2.0";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "oh-fullpath-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── credentials (real CredentialManager + api-key provider over an in-mem store) ──
function buildCredentials() {
  const store = new InMemorySecretStore();
  const accounts: Account[] = [
    {
      id: "a",
      provider: "anthropic",
      authProviderId: "api-key",
      label: "a",
      credential: { kind: "api_key", secretRef: "api-key:a" },
      health: { state: "ok" },
    },
  ];
  const profiles: Profile[] = [{ name: "work", policy: "failover", accountIds: ["a"] }];
  const manager = new CredentialManager({ accounts, profiles });
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));
  return { store, manager, registry };
}

/**
 * Author a REAL definition dir (harness.json + system-prompt.md + policy.json),
 * then sign it REPRODUCIBLY into a baked bundle and set an anti-rollback floor
 * below its version. The policy denies the `test` MCP server and redacts SECRET —
 * this is the policy the runtime must pick up FROM the signed bundle.
 */
function signHarness(): {
  bakedBundlePath: string;
  updatesDir: string;
  floorPath: string;
  pubkeyPath: string;
  pubkeyPem: string;
} {
  const defDir = join(tmp, "def");
  mkdirSync(defDir, { recursive: true });
  writeFileSync(
    join(defDir, "harness.json"),
    JSON.stringify({
      name: "fullpath",
      version: VERSION,
      branding: { displayName: "Full Path" },
      systemPrompt: "system-prompt.md",
      skills: [],
      providers: {
        default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" },
      },
      mcp: { servers: { test: { transport: "stdio", command: "irrelevant" } } },
    }),
  );
  writeFileSync(join(defDir, "system-prompt.md"), "You are a test harness.");
  writeFileSync(
    join(defDir, "policy.json"),
    JSON.stringify({
      default: "allow",
      rules: [{ match: "mcp__test__*", action: "deny", reason: "MCP server 'test' is denied by policy." }],
      redact: [{ pattern: "sk-LIVE-[A-Za-z0-9]+", replace: PLACEHOLDER }],
    }),
  );

  const { publicKey, privateKey } = generateKeypair();
  const pubkeyPath = join(tmp, "org.pub");
  writeFileSync(pubkeyPath, publicKey);

  const updatesDir = join(tmp, "updates");
  mkdirSync(updatesDir, { recursive: true });
  const bakedBundlePath = join(tmp, "baked.ohbundle");
  // Reproducible sign (fixed createdAt) — the supply-chain half.
  writeBundle(bundleDefinition(defDir, privateKey, { createdAt: "2020-01-01T00:00:00.000Z" }), bakedBundlePath);

  const floorPath = join(tmp, "version-floor.txt");
  writeFileSync(floorPath, "0.1.0\n"); // below VERSION — the baked bundle satisfies it

  return { bakedBundlePath, updatesDir, floorPath, pubkeyPath, pubkeyPem: publicKey };
}

// ── an in-memory MCP server whose `echo` body must NEVER run under the deny ──
async function inMemoryConnection(): Promise<McpConnection & { echoCalls: () => number }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let echoCalls = 0;
  const server = new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "echo back a message",
        inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    echoCalls++;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    return { content: [{ type: "text", text: `got:${String(args.msg)}` }] };
  });
  await server.connect(serverTransport);
  const client = new Client({ name: "harness-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools as never;
    },
    async callTool(name, args) {
      return (await client.callTool({ name, arguments: args })) as never;
    },
    async close() {
      await client.close();
      await server.close();
    },
    echoCalls: () => echoCalls,
  };
}

interface ToolRecord {
  calls: number;
  lastArgs: unknown;
}
function makeSecretEchoTool(record: ToolRecord): ToolDefinition {
  return {
    name: "secret_echo",
    label: "secret_echo",
    description: "Echoes a token.",
    parameters: {
      type: "object",
      properties: { token: { type: "string" } },
      required: [],
    } as unknown as ToolDefinition["parameters"],
    async execute(_id, params) {
      record.calls++;
      record.lastArgs = params;
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  } as ToolDefinition;
}

/** turn 1: try the denied MCP tool; turn 2: call the allowed tool with a secret. */
function twoTurnModel(): (authStorage: AuthStorage) => ModelRegistry {
  return (authStorage) => {
    const registry = ModelRegistry.inMemory(authStorage);
    const core = createFauxCore({ provider: "anthropic", api: "anthropic-messages" });
    core.setResponses([
      fauxAssistantMessage([fauxToolCall("mcp__test__echo", { msg: "hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("mcp attempt done", { stopReason: "stop" }),
      fauxAssistantMessage([fauxToolCall("secret_echo", { token: SECRET })], { stopReason: "toolUse" }),
      fauxAssistantMessage("allowed tool done", { stopReason: "stop" }),
    ]);
    registry.registerProvider("anthropic", {
      baseUrl: "http://stub.local",
      apiKey: "stub-key",
      api: "anthropic-messages",
      streamSimple: core.streamSimple,
      models: [
        {
          id: "claude-sonnet-5",
          name: "claude-sonnet-5 (stub)",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
    });
    return registry;
  };
}

test("(1) full path: a signed, pinned, floor-checked bundle governs a live session's tool calls end to end", async () => {
  const { bakedBundlePath, updatesDir, floorPath, pubkeyPath, pubkeyPem } = signHarness();

  // Supply-chain half: resolve the bundle at the effective floor.
  const resolved = resolvePinnedBundle({ bakedBundlePath, updatesDir, pubkeyPem, floorPath });
  expect(resolved.version).toBe(VERSION);
  expect(resolved.floor).toBe(VERSION); // max(persisted 0.1.0, baked 0.2.0)

  const { store, manager, registry } = buildCredentials();
  await store.set("api-key:a", "key-a");
  const conn = await inMemoryConnection();
  const mcpConnect: ConnectFn = async () => conn;
  const record: ToolRecord = { calls: 0, lastArgs: undefined };
  const auditPath = join(tmp, "audit", "session.jsonl");

  // Runtime half: boot `verified` from the RESOLVED bundle at the RESOLVED floor,
  // with NO inline policy — enforcement must come from the bundle's policy.json.
  const live = await createLiveSession({
    verified: { bundlePath: resolved.path, pubkeyPath, minVersion: resolved.floor },
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    auditPath,
    mcpConnect,
    customTools: [makeSecretEchoTool(record)],
    modelRegistryOverride: twoTurnModel(),
  });

  const names = live.session.getAllTools().map((t) => t.name);
  expect(names).toContain("mcp__test__echo");
  expect(names).toContain("secret_echo");

  const events: LiveSessionEvent[] = [];
  try {
    await live.prompt("call the mcp tool", (e) => events.push(e));
    await live.prompt("now call the allowed tool", (e) => events.push(e));
  } finally {
    await live.close();
  }

  // The BUNDLE's deny rule blocked the MCP tool — its body never ran.
  expect(conn.echoCalls()).toBe(0);
  expect(events.some((e) => e.type === "error")).toBe(false);
  // The BUNDLE's redact rule fired: the allowed tool saw the placeholder, not the secret.
  expect(record.calls).toBe(1);
  expect((record.lastArgs as { token?: string }).token).toBe(PLACEHOLDER);

  const content = await readFile(auditPath, "utf8");
  const lines = content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const deniedMcp = lines.find((l) => l.type === "tool_call" && l.tool === "mcp__test__echo");
  expect(deniedMcp?.decision).toBe("deny");
  const allowed = lines.find((l) => l.type === "tool_call" && l.tool === "secret_echo");
  expect(allowed?.decision).toBe("allow");
  expect(allowed?.argsHash).toMatch(/^[0-9a-f]{64}$/);
  // No secret anywhere in the audit file — only irreversible hashes.
  expect(content).not.toContain(SECRET);
  expect(content).not.toContain(PLACEHOLDER);
  expect(verifyAuditLog(auditPath)).toEqual({ ok: true });

  // Reconcile the composed local chain against a gateway chain that governed the
  // SAME allowed call (same tool + argsHash). Zero drift.
  const gwPath = join(tmp, "audit", "gateway.jsonl");
  const gw = createFileAuditLog(gwPath);
  gw.record({
    type: "tool_call",
    tool: "secret_echo",
    decision: "allow",
    argsHash: allowed!.argsHash as string,
    principal: "a",
    policyVersion: "1",
  });
  const clean = reconcileAuditLogs(auditPath, gwPath);
  expect(clean.ok).toBe(true);
  expect(clean.matched).toBe(1);
  expect(clean.onlyInGateway).toHaveLength(0);
  expect(clean.onlyInLocal).toHaveLength(0);

  // Drift IS caught: a gateway chain claiming an extra governed call the local
  // chain lacks flags divergence (the reconcile seam's adversarial variant).
  const gw2Path = join(tmp, "audit", "gateway2.jsonl");
  const gw2 = createFileAuditLog(gw2Path);
  gw2.record({ type: "tool_call", tool: "secret_echo", decision: "allow", argsHash: allowed!.argsHash as string });
  gw2.record({ type: "tool_call", tool: "secret_echo", decision: "allow", argsHash: hashCanonical({ token: "other" }) });
  const drift = reconcileAuditLogs(auditPath, gw2Path);
  expect(drift.ok).toBe(false);
  expect(drift.onlyInGateway).toHaveLength(1);
});

test("(2) a TAMPERED bundle is refused by both resolve and the verified boot", async () => {
  const { bakedBundlePath, updatesDir, floorPath, pubkeyPath, pubkeyPem } = signHarness();
  // Flip one byte of the signed bundle on disk.
  const buf = readFileSync(bakedBundlePath);
  buf[buf.length >> 1] ^= 1;
  writeFileSync(bakedBundlePath, buf);

  // Supply-chain resolve fails closed (a present-but-unverifiable baked bundle
  // must NOT collapse the floor to boot something older).
  expect(() => resolvePinnedBundle({ bakedBundlePath, updatesDir, pubkeyPem, floorPath })).toThrow(
    BundleVerificationError,
  );

  // The runtime boot ALSO refuses the tampered bundle — no session is created.
  const { manager, registry } = buildCredentials();
  await expect(
    createLiveSession({
      verified: { bundlePath: bakedBundlePath, pubkeyPath, minVersion: "0.1.0" },
      manager,
      registry,
      profile: "work",
      cwd: tmp,
      agentDir: join(tmp, "agent"),
      noExtensions: true,
    }),
  ).rejects.toThrow(BundleVerificationError);
});

test("(3) a bundle BELOW the effective floor is refused by both resolve and the verified boot", async () => {
  const { bakedBundlePath, updatesDir, floorPath, pubkeyPath, pubkeyPem } = signHarness();
  // Raise the persisted floor above the bundle's version.
  writeFileSync(floorPath, "9.9.9\n");

  // Nothing verifies at the 9.9.9 floor → resolve throws.
  expect(() => resolvePinnedBundle({ bakedBundlePath, updatesDir, pubkeyPem, floorPath })).toThrow(
    /no bundle verifies/i,
  );

  // The verified boot with the same floor as minVersion refuses the older bundle.
  const { manager, registry } = buildCredentials();
  await expect(
    createLiveSession({
      verified: { bundlePath: bakedBundlePath, pubkeyPath, minVersion: "9.9.9" },
      manager,
      registry,
      profile: "work",
      cwd: tmp,
      agentDir: join(tmp, "agent"),
      noExtensions: true,
    }),
  ).rejects.toThrow(BundleVerificationError);
});

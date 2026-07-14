import { afterEach, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemorySecretStore } from "@openharness/credentials";
import { generateAuthKeypair, mintGatewayToken, type GatewayClaims } from "./auth.ts";
import { createDpopFetch } from "./dpop-http.ts";
import { loadGatewayServerConfig } from "./config.ts";
import { startGatewayFromConfig } from "./serve.ts";
import type { Connector } from "./connectors/index.ts";
import type { GatewayHttpServer } from "./http.ts";

const CLAIMS: GatewayClaims = {
  sub: "alice@acme.com",
  groups: ["eng"],
  harnessId: "acme",
  defVersion: "1.0.0",
  sessionId: "s1",
};

let dir: string | undefined;
let running: GatewayHttpServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Write keys + policy + config to a temp dir; return the config path + keys. */
function writeConfig(policy: unknown): { configPath: string; keys: ReturnType<typeof generateAuthKeypair> } {
  dir = mkdtempSync(join(tmpdir(), "oh-gw-cfg-"));
  const keys = generateAuthKeypair();
  writeFileSync(join(dir, "gw.pub"), keys.publicKey);
  writeFileSync(join(dir, "gw.key"), keys.privateKey);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  const config = {
    host: "127.0.0.1",
    keys: { publicKey: "gw.pub", privateKey: "gw.key" },
    policy: "policy.json",
    policyVersion: "1.0.0",
    auditPath: "audit.log",
    catalog: [{ name: "github__list_issues", connectorId: "github", upstreamId: "github" }],
    connectors: [{ id: "github", type: "github-read" }],
  };
  const configPath = join(dir, "gateway.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { configPath, keys };
}

/** A stub connector standing in for the real github-read (no network). */
function stubGithub(): Connector {
  return {
    id: "github",
    tools: [{ name: "github__list_issues" }],
    allowHosts: ["api.github.com"],
    call: async () => ({ content: [{ type: "text", text: '[{"number":1,"title":"a bug"}]' }] }),
  };
}

async function bootFromConfig(policy: unknown) {
  const { configPath, keys } = writeConfig(policy);
  const resolved = loadGatewayServerConfig(configPath);
  const store = new InMemorySecretStore();
  await store.set("upstream:github", "ghp_orgtoken");
  running = await startGatewayFromConfig(resolved, {
    secretStore: store,
    connectorFactories: { "github-read": stubGithub },
  });
  return { keys, url: running.url, auditPath: resolved.auditPath };
}

async function connect(url: string, gatewayPrivateKey: string, pinnedPubkey: string): Promise<Client> {
  const client = generateAuthKeypair();
  const token = mintGatewayToken(CLAIMS, gatewayPrivateKey, client.publicKey, { ttlMs: 60_000, now: Date.now() });
  const fetchImpl = createDpopFetch(token, client.privateKey, client.publicKey, undefined, undefined, pinnedPubkey);
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: fetchImpl as unknown as typeof fetch });
  const mcp = new Client({ name: "harness", version: "0" }, { capabilities: {} });
  await mcp.connect(transport);
  return mcp;
}

test("loadGatewayServerConfig rejects a config missing keys", () => {
  dir = mkdtempSync(join(tmpdir(), "oh-gw-bad-"));
  const bad = { policy: {}, policyVersion: "1", auditPath: "a.log", catalog: [{ name: "x" }], connectors: [{ id: "x", type: "y" }] };
  const p = join(dir, "gateway.json");
  writeFileSync(p, JSON.stringify(bad));
  expect(() => loadGatewayServerConfig(p)).toThrow();
});

test("startGatewayFromConfig rejects an unknown connector type", async () => {
  dir = mkdtempSync(join(tmpdir(), "oh-gw-unk-"));
  const keys = generateAuthKeypair();
  writeFileSync(join(dir, "gw.pub"), keys.publicKey);
  writeFileSync(join(dir, "gw.key"), keys.privateKey);
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ default: "allow", rules: [] }));
  const config = {
    keys: { publicKey: "gw.pub", privateKey: "gw.key" },
    policy: "policy.json",
    policyVersion: "1.0.0",
    auditPath: "audit.log",
    catalog: [{ name: "t", connectorId: "c" }],
    connectors: [{ id: "c", type: "does-not-exist" }],
  };
  const p = join(dir, "gateway.json");
  writeFileSync(p, JSON.stringify(config));
  const resolved = loadGatewayServerConfig(p);
  await expect(startGatewayFromConfig(resolved, { secretStore: new InMemorySecretStore() })).rejects.toThrow(/unknown type/);
});

test("boots a governed gateway from a config file and serves a DPoP-authenticated call", async () => {
  const { keys, url, auditPath } = await bootFromConfig({ default: "allow", rules: [] });
  const mcp = await connect(url, keys.privateKey, keys.publicKey);
  try {
    const res = await mcp.callTool({ name: "github__list_issues", arguments: { owner: "acme", repo: "app" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("a bug");
    // The authoritative audit log was written to the configured path.
    expect(readFileSync(auditPath, "utf8")).toContain("tool_call");
  } finally {
    await mcp.close();
  }
});

test("the config's policy is authoritative — a denied tool is blocked end to end", async () => {
  const { keys, url } = await bootFromConfig({ default: "deny", rules: [] });
  const mcp = await connect(url, keys.privateKey, keys.publicKey);
  try {
    const res = await mcp.callTool({ name: "github__list_issues", arguments: { owner: "a", repo: "b" } });
    expect(res.isError).toBe(true);
  } finally {
    await mcp.close();
  }
});

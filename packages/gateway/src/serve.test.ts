import { afterEach, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemorySecretStore } from "@openharness/credentials";
import { generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
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

/** Write a config that turns on requireSecondPerson; return the resolved config. */
function writeSecondPersonConfig() {
  dir = mkdtempSync(join(tmpdir(), "oh-gw-2p-"));
  const keys = generateAuthKeypair();
  writeFileSync(join(dir, "gw.pub"), keys.publicKey);
  writeFileSync(join(dir, "gw.key"), keys.privateKey);
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ default: "allow", rules: [] }));
  const config = {
    host: "127.0.0.1",
    keys: { publicKey: "gw.pub", privateKey: "gw.key" },
    policy: "policy.json",
    policyVersion: "1.0.0",
    auditPath: "audit.log",
    approval: { timeoutMs: 30000, requireSecondPerson: true },
    catalog: [{ name: "github__list_issues", connectorId: "github", upstreamId: "github" }],
    connectors: [{ id: "github", type: "github-read" }],
  };
  const p = join(dir, "gateway.json");
  writeFileSync(p, JSON.stringify(config));
  return { resolved: loadGatewayServerConfig(p), keys };
}

test("startGatewayFromConfig fails closed when requireSecondPerson is set but no per-approver tokens are configured", async () => {
  const { resolved } = writeSecondPersonConfig();
  const store = new InMemorySecretStore();
  await store.set("upstream:github", "ghp_orgtoken");
  // The shared admin identity can't be a distinct second person — refuse to boot
  // rather than provide false dual control.
  await expect(
    startGatewayFromConfig(resolved, { secretStore: store, connectorFactories: { "github-read": stubGithub } }),
  ).rejects.toThrow(/requireSecondPerson|second person|approver/i);
});

test("startGatewayFromConfig boots with requireSecondPerson when per-approver tokens ARE configured", async () => {
  const { resolved, keys } = writeSecondPersonConfig();
  const store = new InMemorySecretStore();
  await store.set("upstream:github", "ghp_orgtoken");
  running = await startGatewayFromConfig(resolved, {
    secretStore: store,
    approvers: { "boss@acme.com": "boss-tok" },
    connectorFactories: { "github-read": stubGithub },
  });
  expect(running.url).toContain("http://127.0.0.1:");
  void keys;
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

test("a config with a child-process SANDBOX runs a governed call in a real worker process", async () => {
  dir = mkdtempSync(join(tmpdir(), "oh-gw-sbx-"));
  const gw = generateAuthKeypair();
  writeFileSync(join(dir, "gw.pub"), gw.publicKey);
  writeFileSync(join(dir, "gw.key"), gw.privateKey);
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ default: "allow", rules: [] }));
  // Point the sandbox at the no-network echo fixture registry so the test is hermetic.
  const registryModule = fileURLToPath(new URL("./__fixtures__/sandbox-connectors.ts", import.meta.url));
  writeFileSync(
    join(dir, "gateway.json"),
    JSON.stringify({
      host: "127.0.0.1",
      keys: { publicKey: "gw.pub", privateKey: "gw.key" },
      policy: "policy.json",
      policyVersion: "1.0.0",
      auditPath: "audit.log",
      sandbox: { kind: "child-process", registryModule, execArgv: ["--experimental-strip-types", "--no-warnings"] },
      catalog: [{ name: "echo__run", connectorId: "echo", upstreamId: "echo" }],
      connectors: [{ id: "echo", type: "echo" }],
    }),
  );
  const resolved = loadGatewayServerConfig(join(dir, "gateway.json"));
  const store = new InMemorySecretStore();
  await store.set("upstream:echo", "sekret");
  running = await startGatewayFromConfig(resolved, { secretStore: store });

  const mcp = await connect(running.url, gw.privateKey, gw.publicKey);
  try {
    const res = await mcp.callTool({ name: "echo__run", arguments: { a: 1 } });
    expect(res.isError).toBeFalsy();
    const echoed = JSON.parse((res.content as { text: string }[])[0].text) as { toolName: string; secret: string; pid: number };
    expect(echoed.toolName).toBe("echo__run");
    expect(echoed.secret).toBe("sekret"); // the credential was marshaled into the worker
    expect(echoed.pid).not.toBe(process.pid); // genuinely a separate OS process
  } finally {
    await mcp.close();
  }
});

test("a config with a POOL broker rotates the upstream credential behind the gateway", async () => {
  dir = mkdtempSync(join(tmpdir(), "oh-gw-pool-"));
  const gw = generateAuthKeypair();
  writeFileSync(join(dir, "gw.pub"), gw.publicKey);
  writeFileSync(join(dir, "gw.key"), gw.privateKey);
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ default: "allow", rules: [] }));
  writeFileSync(
    join(dir, "gateway.json"),
    JSON.stringify({
      host: "127.0.0.1",
      keys: { publicKey: "gw.pub", privateKey: "gw.key" },
      policy: "policy.json",
      policyVersion: "1.0.0",
      auditPath: "audit.log",
      broker: { kind: "pool", upstreams: { github: ["gh-a", "gh-b"] } },
      catalog: [{ name: "github__list_issues", connectorId: "github", upstreamId: "github" }],
      connectors: [{ id: "github", type: "github-read" }],
    }),
  );
  const resolved = loadGatewayServerConfig(join(dir, "gateway.json"));
  const store = new InMemorySecretStore();
  await store.set("upstream:gh-a", "tok-a");
  await store.set("upstream:gh-b", "tok-b");
  // A connector that rejects credential gh-a (401) and succeeds on gh-b.
  const rotating: () => Connector = () => ({
    id: "github",
    tools: [{ name: "github__list_issues" }],
    allowHosts: ["api.github.com"],
    call: async (_t, _a, cred) => {
      if (cred.credentialId === "gh-a") throw new Error("github error 401 unauthorized");
      return { content: [{ type: "text", text: `a bug via ${cred.credentialId}` }] };
    },
  });
  running = await startGatewayFromConfig(resolved, { secretStore: store, connectorFactories: { "github-read": rotating } });

  const mcp1 = await connect(running.url, gw.privateKey, gw.publicKey);
  try {
    const r1 = await mcp1.callTool({ name: "github__list_issues", arguments: { owner: "a", repo: "b" } });
    expect(r1.isError).toBe(true); // gh-a rejected → reported → invalidated
  } finally {
    await mcp1.close();
  }
  const mcp2 = await connect(running.url, gw.privateKey, gw.publicKey);
  try {
    const r2 = await mcp2.callTool({ name: "github__list_issues", arguments: { owner: "a", repo: "b" } });
    expect(r2.isError).toBeFalsy();
    expect(JSON.stringify(r2.content)).toContain("a bug via gh-b"); // rotated
  } finally {
    await mcp2.close();
  }
});

test("a config with tokenExchange exchanges an IdP JWT for a DPoP token that runs a governed call", async () => {
  dir = mkdtempSync(join(tmpdir(), "oh-gw-tx-"));
  const gw = generateAuthKeypair();
  const idp = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(join(dir, "gw.pub"), gw.publicKey);
  writeFileSync(join(dir, "gw.key"), gw.privateKey);
  writeFileSync(join(dir, "idp.pub"), idp.publicKey);
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ default: "allow", rules: [] }));
  writeFileSync(
    join(dir, "gateway.json"),
    JSON.stringify({
      host: "127.0.0.1",
      keys: { publicKey: "gw.pub", privateKey: "gw.key" },
      policy: "policy.json",
      policyVersion: "1.0.0",
      auditPath: "audit.log",
      tokenExchange: { idpPublicKey: "idp.pub", issuer: "https://idp.acme.com", audience: "openharness-gateway" },
      catalog: [{ name: "github__list_issues", connectorId: "github", upstreamId: "github" }],
      connectors: [{ id: "github", type: "github-read" }],
    }),
  );
  const resolved = loadGatewayServerConfig(join(dir, "gateway.json"));
  const store = new InMemorySecretStore();
  await store.set("upstream:github", "ghp_orgtoken");
  running = await startGatewayFromConfig(resolved, { secretStore: store, connectorFactories: { "github-read": stubGithub } });

  // Mint an IdP-signed EdDSA JWT subject token (what the org IdP would issue).
  const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64u({ alg: "EdDSA", typ: "JWT" });
  const body = b64u({
    sub: "alice@acme.com",
    iss: "https://idp.acme.com",
    aud: "openharness-gateway",
    exp: Math.floor(Date.now() / 1000) + 300,
    groups: ["eng"],
  });
  const jwt = `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), idp.privateKey).toString("base64url")}`;

  const client = generateAuthKeypair();
  const res = await fetch(running.url.replace("/mcp", "/token"), {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "x-oh-dpop-key": Buffer.from(client.publicKey).toString("base64url") },
  });
  expect(res.status).toBe(200);
  const { access_token } = (await res.json()) as { access_token: string };

  const fetchImpl = createDpopFetch(access_token, client.privateKey, client.publicKey, undefined, undefined, gw.publicKey);
  const mcp = new Client({ name: "harness", version: "0" }, { capabilities: {} });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(running.url), { fetch: fetchImpl as unknown as typeof fetch }));
  try {
    const call = await mcp.callTool({ name: "github__list_issues", arguments: { owner: "acme", repo: "app" } });
    expect(call.isError).toBeFalsy();
    expect(JSON.stringify(call.content)).toContain("a bug");
  } finally {
    await mcp.close();
  }

  // A forged subject token (bad issuer) gets no token.
  const badBody = b64u({ sub: "eve", iss: "https://evil", aud: "openharness-gateway", exp: Math.floor(Date.now() / 1000) + 300 });
  const badJwt = `${head}.${badBody}.${sign(null, Buffer.from(`${head}.${badBody}`), idp.privateKey).toString("base64url")}`;
  const bad = await fetch(running.url.replace("/mcp", "/token"), {
    method: "POST",
    headers: { authorization: `Bearer ${badJwt}`, "x-oh-dpop-key": Buffer.from(client.publicKey).toString("base64url") },
  });
  expect(bad.status).toBe(401);
});

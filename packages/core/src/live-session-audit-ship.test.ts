import { afterEach, beforeEach, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  InMemorySecretStore,
  CredentialManager,
  AuthProviderRegistry,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type { Account, Profile } from "@openharness/credentials";
import type { Policy } from "@openharness/policy";
import { createOpenHarnessServer, type StartedOpenHarnessServer } from "@openharness/server";
import { createLiveSession } from "./live-session.ts";
import { createToolCallingStubModelRegistry } from "./testing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleHarness = join(here, "..", "..", "..", "harnesses", "example");

let tmp: string;
let running: StartedOpenHarnessServer | undefined;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oh-ship-live-"));
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  await rm(tmp, { recursive: true, force: true });
});

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

function stubTool(): ToolDefinition {
  return {
    name: "do_thing",
    label: "do_thing",
    description: "does a thing",
    parameters: { type: "object", properties: {}, required: [] } as unknown as ToolDefinition["parameters"],
    async execute() {
      return { content: [{ type: "text", text: "done" }], details: undefined };
    },
  } as ToolDefinition;
}

test("a live session with auditServer ships its recorded entries to the authoritative anchor on close", async () => {
  const auditDir = join(tmp, "server-audit");
  running = await createOpenHarnessServer({ bundlesDir: join(tmp, "bundles"), auditDir }).start();

  const { store, manager, registry } = buildCredentials();
  await store.set("api-key:a", "key-a");
  const policy: Policy = { default: "allow", rules: [] };
  const auditPath = join(tmp, "audit", "session.jsonl");

  const live = await createLiveSession({
    harnessPath: exampleHarness,
    manager,
    registry,
    profile: "work",
    cwd: tmp,
    agentDir: join(tmp, "agent"),
    noExtensions: true,
    policy,
    auditPath,
    // intervalMs 0 → no periodic timer; the close() flush does the shipping.
    auditServer: { url: running.url, source: "live1", intervalMs: 0 },
    customTools: [stubTool()],
    modelRegistryOverride: createToolCallingStubModelRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      toolName: "do_thing",
      toolArgs: {},
      finalReply: "ok",
    }),
  });

  await live.prompt("go", () => {});
  await live.close(); // flush-on-close ships the tail

  // The server retained the session's records (tool_call + tool_result at least).
  const ingested = join(auditDir, "ingested-live1.jsonl");
  expect(existsSync(ingested)).toBe(true);
  const lines = (await readFile(ingested, "utf8")).split("\n").filter((l) => l.trim());
  expect(lines.length).toBeGreaterThanOrEqual(1);
  // And the local log has at least as many records as the server retained.
  const local = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.trim());
  expect(local.length).toBeGreaterThanOrEqual(lines.length);
});

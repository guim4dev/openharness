#!/usr/bin/env node
import { join } from "node:path";
import {
  AuthProviderRegistry,
  CredentialManager,
  EncryptedFileSecretStore,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import { configDir } from "@openharness/core";
import { loadHarnessDefinition } from "@openharness/definition";
import { launchTui } from "./launch.ts";

/**
 * Branded TUI entry: load a HarnessDefinition, resolve credentials from the
 * encrypted on-disk store, and launch Pi's InteractiveMode with the harness's
 * system prompt, mandatory skills, auth seam, and default model already wired.
 */
async function main(): Promise<void> {
  const [harnessPath] = process.argv.slice(2);
  if (!harnessPath) {
    console.error("usage: openharness-tui <harness-path>");
    process.exit(2);
  }

  const def = await loadHarnessDefinition(harnessPath);
  const p = def.manifest.providers.default;

  const store = await EncryptedFileSecretStore.open(join(configDir(), "secrets"));
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));
  const manager = new CredentialManager({
    accounts: [], // account configuration UI lands in a later phase
    profiles: [{ name: p.credentialProfile, policy: "failover", accountIds: [] }],
  });

  if (!manager.activeAccount(p.credentialProfile)) {
    console.log(`${def.manifest.branding.displayName} — no credential accounts configured for profile '${p.credentialProfile}'.`);
    console.log(`Add an account for provider '${p.provider}' to launch. (Account config UI lands in a later phase.)`);
    return;
  }

  console.log(`Launching ${def.manifest.branding.displayName}...`);
  await launchTui({ harnessPath, manager, registry, profile: p.credentialProfile });
}

main().catch((e: unknown) => {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
});

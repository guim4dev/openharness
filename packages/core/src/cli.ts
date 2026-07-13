#!/usr/bin/env node
import { loadHarnessDefinition } from "@openharness/definition";
import {
  AuthProviderRegistry,
  CredentialManager,
  InMemorySecretStore,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import { createOpenHarnessAuthStorage } from "./pi-auth-storage.ts";

/**
 * Phase-1 smoke: load a HarnessDefinition and wire it into Pi's real credential
 * seam, reporting readiness. Live model turns (driving a full Pi AgentSession)
 * arrive in Phase 2 together with the TUI/desktop frontends.
 */
async function main(): Promise<void> {
  const [harnessPath] = process.argv.slice(2);
  if (!harnessPath) {
    console.error("usage: openharness-core <harness-path>");
    process.exit(2);
  }

  const def = await loadHarnessDefinition(harnessPath);
  const p = def.manifest.providers.default;
  console.log(`Loaded harness: ${def.manifest.branding.displayName} (${def.manifest.name}@${def.manifest.version})`);
  console.log(`Provider: ${p.provider} / model ${p.model} / profile '${p.credentialProfile}'`);
  console.log(`System prompt: "${def.systemPromptText.trim().slice(0, 60)}"`);
  console.log(`Mandatory skills: ${def.skillDirs.filter((s) => s.mandatory).length}`);

  const store = new InMemorySecretStore();
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(store));
  const manager = new CredentialManager({
    accounts: [],
    profiles: [{ name: p.credentialProfile, policy: "failover", accountIds: [] }],
  });
  const oh = createOpenHarnessAuthStorage({ manager, registry, profile: p.credentialProfile });
  const active = await oh.syncActiveProvider(p.provider);

  if (!active) {
    console.log(`\nNo credential accounts configured for profile '${p.credentialProfile}'.`);
    console.log(`Add an account to run live. (Account config + live model turns land in Phase 2.)`);
  } else {
    console.log(`\nActive account: ${active.label} (${active.authProviderId}). Credential seam is ready.`);
  }
}

main().catch((e: unknown) => {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
});

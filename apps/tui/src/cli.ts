#!/usr/bin/env node
import { join } from "node:path";
import { configDir, loadAccounts } from "@openharness/core";
import { loadHarnessDefinition } from "@openharness/definition";
import { launchTui } from "./launch.ts";

/**
 * Branded TUI entry: load a HarnessDefinition, resolve bring-your-own-key
 * credentials (env keys + configDir()/accounts.json) via loadAccounts, and
 * launch Pi's InteractiveMode with the harness's system prompt, mandatory
 * skills, auth seam, and default model already wired.
 */
async function main(): Promise<void> {
  const [harnessPath] = process.argv.slice(2);
  if (!harnessPath) {
    console.error("usage: openharness-tui <harness-path>");
    process.exit(2);
  }

  const def = await loadHarnessDefinition(harnessPath);
  const p = def.manifest.providers.default;

  const { manager, registry } = await loadAccounts({ profileName: p.credentialProfile });

  if (!manager.activeAccount(p.credentialProfile, p.provider)) {
    console.log(`${def.manifest.branding.displayName} — no API key configured for provider '${p.provider}' (profile '${p.credentialProfile}').`);
    console.log(`Bring your own key: export ANTHROPIC_API_KEY=sk-... (or OPENAI_API_KEY, GEMINI_API_KEY, OPENCODE_GO_API_KEY), or add ${join(configDir(), "accounts.json")}.`);
    return;
  }

  console.log(`Launching ${def.manifest.branding.displayName}...`);
  await launchTui({ harnessPath, manager, registry, profile: p.credentialProfile });
}

main().catch((e: unknown) => {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
});

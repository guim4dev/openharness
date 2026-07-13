import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { loadHarnessDefinition } from "@openharness/definition";
import { buildTuiConfig } from "./build-options.ts";

const exampleHarness = join(dirname(fileURLToPath(import.meta.url)), "../../../harnesses/example");

test("buildTuiConfig maps the definition into Pi runtime options with the exact field names", async () => {
  const def = await loadHarnessDefinition(exampleHarness);
  const authStorage = AuthStorage.inMemory();

  const config = buildTuiConfig(def, { authStorage });

  // (c) the provided real Pi AuthStorage is forwarded by identity to the services factory.
  expect(config.servicesOptions.authStorage).toBe(authStorage);

  // (a) verbatim system-prompt REPLACE surface = resourceLoaderOptions.systemPrompt.
  expect(config.servicesOptions.resourceLoaderOptions?.systemPrompt).toBe(def.systemPromptText);

  // (b) mandatory skills = resourceLoaderOptions.additionalSkillPaths (absolute dirs).
  expect(config.servicesOptions.resourceLoaderOptions?.additionalSkillPaths).toEqual(
    def.skillDirs.map((s) => s.path),
  );

  // (d) default model id/provider fed verbatim to resolveCliModel(...).
  expect(config.modelSelection.cliModel).toBe(def.manifest.providers.default.model);
  expect(config.modelSelection.cliProvider).toBe(def.manifest.providers.default.provider);

  expect(config.providerId).toBe(def.manifest.providers.default.provider);
  expect(config.displayName).toBe(def.manifest.branding.displayName);
});

test("buildTuiConfig forwards per-turn extension factories into resourceLoaderOptions", async () => {
  const def = await loadHarnessDefinition(exampleHarness);
  const authStorage = AuthStorage.inMemory();
  const rotation = { name: "rotation", factory: () => {} };

  const config = buildTuiConfig(def, { authStorage, extensionFactories: [rotation] });

  expect(config.servicesOptions.resourceLoaderOptions?.extensionFactories).toEqual([rotation]);
});

test("buildTuiConfig omits extensionFactories when none are provided", async () => {
  const def = await loadHarnessDefinition(exampleHarness);
  const config = buildTuiConfig(def, { authStorage: AuthStorage.inMemory() });

  expect(config.servicesOptions.resourceLoaderOptions?.extensionFactories).toBeUndefined();
});

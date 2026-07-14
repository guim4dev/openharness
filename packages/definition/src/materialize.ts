import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { harnessManifestSchema } from "./schema.ts";

export class MaterializeError extends Error {}

export interface MaterializeDefinitionInput {
  /** The `harness.json` object (validated against the schema before any write). */
  manifest: unknown;
  /** Optional `policy.json` object. Omitted → no policy file (enforcement is a no-op). */
  policy?: unknown;
  /** Text written to `system-prompt.md` (the manifest must reference it). */
  systemPrompt: string;
}

export interface MaterializeDefinitionResult {
  rootDir: string;
  /** Filenames written, relative to `rootDir`. */
  files: string[];
}

/**
 * Materialize a COMPLETE harness definition to `dir` from in-memory objects —
 * the shape a visual builder or a generator produces: `harness.json` + optional
 * `policy.json` + `system-prompt.md`. Distinct from `scaffoldHarness`, which
 * generates a fresh starter; this writes exactly what it is given.
 *
 * Fail-closed: the manifest is validated against the schema BEFORE any file is
 * written, so a bad input never leaves a half-written, invalid directory. The
 * manifest must reference `system-prompt.md` as its `systemPrompt` (the file this
 * writes). The result loads via `loadHarnessDefinition` and — with no mandatory
 * skills declared — passes `openharness doctor`.
 */
export async function writeHarnessDefinition(
  dir: string,
  input: MaterializeDefinitionInput,
): Promise<MaterializeDefinitionResult> {
  const parsed = harnessManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    throw new MaterializeError(`manifest is invalid: ${parsed.error.toString()}`);
  }
  if (parsed.data.systemPrompt !== "system-prompt.md") {
    throw new MaterializeError(
      `manifest.systemPrompt must be "system-prompt.md" (got "${parsed.data.systemPrompt}") — that is the file writeHarnessDefinition writes`,
    );
  }

  const root = resolve(dir);
  await mkdir(root, { recursive: true });

  const files: string[] = [];
  await writeFile(join(root, "harness.json"), `${JSON.stringify(input.manifest, null, 2)}\n`);
  files.push("harness.json");
  const prompt = input.systemPrompt.endsWith("\n") ? input.systemPrompt : `${input.systemPrompt}\n`;
  await writeFile(join(root, "system-prompt.md"), prompt);
  files.push("system-prompt.md");
  if (input.policy !== undefined) {
    await writeFile(join(root, "policy.json"), `${JSON.stringify(input.policy, null, 2)}\n`);
    files.push("policy.json");
  }

  return { rootDir: root, files };
}

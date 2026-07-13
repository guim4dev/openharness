import { readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { harnessManifestSchema } from "./schema.ts";
import type { HarnessDefinition } from "./types.ts";

export class HarnessDefinitionError extends Error {}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadHarnessDefinition(rootDir: string): Promise<HarnessDefinition> {
  const root = resolve(rootDir);
  const manifestPath = join(root, "harness.json");
  if (!(await exists(manifestPath))) throw new HarnessDefinitionError(`No harness.json found in ${root}`);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (e) {
    throw new HarnessDefinitionError(`harness.json is not valid JSON: ${(e as Error).message}`);
  }

  const parsed = harnessManifestSchema.safeParse(raw);
  if (!parsed.success) throw new HarnessDefinitionError(`harness.json is invalid:\n${parsed.error.toString()}`);
  const manifest = parsed.data;

  const promptPath = join(root, manifest.systemPrompt);
  if (!(await exists(promptPath))) throw new HarnessDefinitionError(`systemPrompt file not found: ${promptPath}`);
  const systemPromptText = await readFile(promptPath, "utf8");

  const skillDirs: HarnessDefinition["skillDirs"] = [];
  for (const s of manifest.skills) {
    const abs = join(root, s.path);
    if (s.mandatory && !(await exists(join(abs, "SKILL.md"))))
      throw new HarnessDefinitionError(`Mandatory skill '${s.path}' is missing SKILL.md at ${abs}`);
    skillDirs.push({ path: abs, mandatory: s.mandatory });
  }

  const iconPath = manifest.branding.icon ? join(root, manifest.branding.icon) : undefined;
  return { manifest, rootDir: root, systemPromptText, skillDirs, iconPath };
}

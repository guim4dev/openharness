import { readFile, access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parsePolicy, PolicyError } from "@openharness/policy";
import { loadPromptLibrary, resolvePrompt, PromptLibraryError, type PromptLibrary } from "@openharness/prompts";
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

  // SECURITY: a file/dir path in the manifest must resolve INSIDE the definition
  // dir. Without this, an unverified definition (the dev `chat <dir>` path loads
  // one WITHOUT signature verification) could set `systemPrompt: "../../etc/passwd"`
  // and exfiltrate any readable file into the system prompt sent to the provider.
  // (The build path had a completeness check; this makes the loader itself safe
  // for every caller. `lib:` refs are map-key lookups and never touch the FS.)
  const insideRoot = (value: string, fieldName: string): string => {
    const abs = resolve(root, value);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new HarnessDefinitionError(
        `${fieldName} references '${value}', which resolves OUTSIDE the definition dir — refusing to read it.`,
      );
    }
    return abs;
  };

  // Optional shared PromptLibrary (a dir of curated .md prompts). Loaded before
  // resolving systemPrompt/appendSystemPrompt since either may reference it via
  // a `lib:<name>` ref. Must live inside the definition dir to be included when
  // this definition is bundled (bundleDefinition walks files under rootDir only).
  let promptLibrary: PromptLibrary | undefined;
  if (manifest.promptLibrary) {
    const libDir = insideRoot(manifest.promptLibrary, "promptLibrary");
    try {
      promptLibrary = await loadPromptLibrary(libDir);
    } catch (e) {
      throw new HarnessDefinitionError(`promptLibrary failed to load: ${(e as Error).message}`);
    }
  }

  // Resolve a systemPrompt/appendSystemPrompt field: either a `lib:<name>` ref
  // against `promptLibrary`, or (the original, backward-compatible behavior) a
  // file path relative to the definition root.
  async function resolvePromptField(value: string, fieldName: string): Promise<string> {
    if (value.startsWith("lib:")) {
      const name = value.slice("lib:".length);
      if (!promptLibrary) {
        throw new HarnessDefinitionError(
          `${fieldName} references '${value}' but no promptLibrary is configured in harness.json`,
        );
      }
      try {
        return resolvePrompt(promptLibrary, name);
      } catch (e) {
        if (e instanceof PromptLibraryError) throw new HarnessDefinitionError(`${fieldName}: ${e.message}`);
        throw e;
      }
    }
    const p = insideRoot(value, fieldName);
    if (!(await exists(p))) throw new HarnessDefinitionError(`${fieldName} file not found: ${p}`);
    return readFile(p, "utf8");
  }

  const baseSystemPrompt = await resolvePromptField(manifest.systemPrompt, "systemPrompt");
  let systemPromptText = baseSystemPrompt;
  if (manifest.appendSystemPrompt) {
    const appended = await resolvePromptField(manifest.appendSystemPrompt, "appendSystemPrompt");
    systemPromptText = `${baseSystemPrompt}\n\n${appended}`;
  }

  const skillDirs: HarnessDefinition["skillDirs"] = [];
  for (const s of manifest.skills) {
    const abs = insideRoot(s.path, `skill '${s.path}'`);
    if (s.mandatory && !(await exists(join(abs, "SKILL.md"))))
      throw new HarnessDefinitionError(`Mandatory skill '${s.path}' is missing SKILL.md at ${abs}`);
    skillDirs.push({ path: abs, mandatory: s.mandatory });
  }

  const iconPath = manifest.branding.icon ? insideRoot(manifest.branding.icon, "branding.icon") : undefined;

  // Optional policy.json. Absent => no policy (enforcement is a no-op). A present
  // but malformed file is a hard error: a broken security policy must fail loud,
  // never be silently ignored.
  const policyPath = join(root, "policy.json");
  let policy: HarnessDefinition["policy"];
  if (await exists(policyPath)) {
    let rawPolicy: unknown;
    try {
      rawPolicy = JSON.parse(await readFile(policyPath, "utf8"));
    } catch (e) {
      throw new HarnessDefinitionError(`policy.json is not valid JSON: ${(e as Error).message}`);
    }
    try {
      policy = parsePolicy(rawPolicy);
    } catch (e) {
      if (e instanceof PolicyError) throw new HarnessDefinitionError(e.message);
      throw e;
    }
  }

  return { manifest, rootDir: root, systemPromptText, skillDirs, iconPath, policy };
}

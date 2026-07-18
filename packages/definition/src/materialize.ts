import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { harnessManifestSchema } from "./schema.ts";

export class MaterializeError extends Error {}

/** Inline SKILL.md content for a skill the manifest declares. */
export interface MaterializeSkill {
  /** The skill DIRECTORY, relative to the definition root (e.g. `skills/triage`). */
  path: string;
  /** Full SKILL.md content (frontmatter + body) written to `<path>/SKILL.md`. */
  content: string;
}

export interface MaterializeDefinitionInput {
  /** The `harness.json` object (validated against the schema before any write). */
  manifest: unknown;
  /** Optional `policy.json` object. Omitted → no policy file (enforcement is a no-op). */
  policy?: unknown;
  /** Text written to `system-prompt.md` (the manifest must reference it). */
  systemPrompt: string;
  /**
   * Inline skill content to write as `<path>/SKILL.md`. A builder that declares a
   * (mandatory) skill in the manifest MUST supply its content here — otherwise the
   * materialized dir has a skill dir with no SKILL.md and fails `doctor`/load.
   */
  skills?: MaterializeSkill[];
}

export interface MaterializeDefinitionResult {
  rootDir: string;
  /** Filenames written, relative to `rootDir`. */
  files: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Materialize a COMPLETE harness definition to `dir` from in-memory objects —
 * the shape a visual builder or a generator produces: `harness.json` + optional
 * `policy.json` + `system-prompt.md` + inline skills. Distinct from
 * `scaffoldHarness`, which generates a fresh starter; this writes exactly what it
 * is given.
 *
 * Fail-closed: EVERYTHING is validated — the manifest against the schema, the
 * `systemPrompt` reference, any manifest field that points at a file this function
 * does NOT write, and every skill path (containment, symlink-aware) — BEFORE a
 * single byte is written, so a bad input never leaves a half-written, invalid
 * directory. The result loads via `loadHarnessDefinition` and — with no mandatory
 * skills declared — passes `openharness doctor`.
 */
export async function writeHarnessDefinition(
  dir: string,
  input: MaterializeDefinitionInput,
): Promise<MaterializeDefinitionResult> {
  // ---- Validate everything BEFORE any write (fail-closed atomicity) ----------
  const parsed = harnessManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    throw new MaterializeError(`manifest is invalid: ${parsed.error.toString()}`);
  }
  const manifest = parsed.data;
  if (manifest.systemPrompt !== "system-prompt.md") {
    throw new MaterializeError(
      `manifest.systemPrompt must be "system-prompt.md" (got "${manifest.systemPrompt}") — that is the file writeHarnessDefinition writes`,
    );
  }
  // Reject manifest fields that reference files this function does NOT materialize
  // — otherwise the dir loads (or doctors) broken with a dangling reference.
  if (manifest.appendSystemPrompt !== undefined) {
    throw new MaterializeError(
      `manifest.appendSystemPrompt is set ('${manifest.appendSystemPrompt}') but writeHarnessDefinition writes only system-prompt.md — inline the appended text into systemPrompt instead`,
    );
  }
  if (manifest.promptLibrary !== undefined) {
    throw new MaterializeError(
      `manifest.promptLibrary is set ('${manifest.promptLibrary}') but writeHarnessDefinition does not materialize a prompt library`,
    );
  }
  if (manifest.branding.icon !== undefined) {
    throw new MaterializeError(
      `manifest.branding.icon is set ('${manifest.branding.icon}') but writeHarnessDefinition does not materialize an icon file`,
    );
  }

  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  // The REAL (symlink-dereferenced) root — the containment target. `root` may sit
  // under a symlinked ancestor (e.g. /tmp -> /private/tmp on macOS).
  const realRoot = realpathSync(root);
  const withinReal = (p: string): boolean => p === realRoot || p.startsWith(realRoot + sep);

  // Validate every skill path (lexical + symlink-aware containment) up front, so a
  // bad or escaping skill path fails BEFORE harness.json / system-prompt.md exist.
  const skillTargets = (input.skills ?? []).map((s) => {
    const skillMd = resolve(root, s.path, "SKILL.md");
    if (skillMd !== root && !skillMd.startsWith(root + sep)) {
      throw new MaterializeError(`skill path '${s.path}' resolves OUTSIDE the definition dir — refusing to write it`);
    }
    // Symlink containment: follow symlinks on the deepest existing component. A
    // pre-existing symlink inside the dir must not let a write escape the root.
    let probe = dirname(skillMd);
    for (;;) {
      let real: string;
      try {
        real = realpathSync(probe);
      } catch {
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
        continue;
      }
      if (!withinReal(real)) {
        throw new MaterializeError(
          `skill path '${s.path}' (following symlinks) resolves OUTSIDE the definition dir — refusing to write it`,
        );
      }
      break;
    }
    const content = s.content.endsWith("\n") ? s.content : `${s.content}\n`;
    return { skillMd, relPath: join(s.path, "SKILL.md"), content };
  });

  // ---- All validation passed; write. ----------------------------------------
  const files: string[] = [];
  // Serialize the VALIDATED manifest (schema-stripped), not the raw input, so
  // extra/unknown keys never reach disk.
  await writeFile(join(root, "harness.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  files.push("harness.json");
  const prompt = input.systemPrompt.endsWith("\n") ? input.systemPrompt : `${input.systemPrompt}\n`;
  await writeFile(join(root, "system-prompt.md"), prompt);
  files.push("system-prompt.md");
  const policyPath = join(root, "policy.json");
  if (input.policy !== undefined) {
    await writeFile(policyPath, `${JSON.stringify(input.policy, null, 2)}\n`);
    files.push("policy.json");
  } else if (await exists(policyPath)) {
    // Re-materializing with no policy must not leave a STALE policy.json enforcing
    // rules the new definition dropped ("omitted policy → enforcement is a no-op").
    await rm(policyPath);
  }

  for (const t of skillTargets) {
    await mkdir(dirname(t.skillMd), { recursive: true });
    await writeFile(t.skillMd, t.content);
    files.push(t.relPath);
  }

  return { rootDir: root, files };
}

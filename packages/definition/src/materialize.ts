import { mkdir, writeFile } from "node:fs/promises";
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

  // Skills: write each SKILL.md, fail-closed on a path that escapes the root
  // (same containment rule the loader enforces on read). Validate ALL paths
  // before writing any, so a bad skill never leaves a half-written dir.
  for (const s of input.skills ?? []) {
    const skillMd = resolve(root, s.path, "SKILL.md");
    if (skillMd !== root && !skillMd.startsWith(root + sep)) {
      throw new MaterializeError(
        `skill path '${s.path}' resolves OUTSIDE the definition dir — refusing to write it`,
      );
    }
  }
  for (const s of input.skills ?? []) {
    const skillMd = resolve(root, s.path, "SKILL.md");
    await mkdir(dirname(skillMd), { recursive: true });
    const content = s.content.endsWith("\n") ? s.content : `${s.content}\n`;
    await writeFile(skillMd, content);
    files.push(join(s.path, "SKILL.md"));
  }

  return { rootDir: root, files };
}

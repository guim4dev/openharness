import { spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { bundleDefinition, writeBundle } from "@openharness/bundle";
import { loadHarnessDefinition } from "@openharness/definition";
import type { HarnessManifest } from "@openharness/definition";

export {
  verifyProvenance,
  signProvenance,
  sha256Hex,
} from "./attestation.ts";
export type {
  DsseEnvelope,
  InTotoStatement,
  TrustRoot,
  ArtifactRef,
  ProvenanceVerdict,
} from "./attestation.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/build/src -> repo root (three levels up). */
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..");

/**
 * esbuild emits `--format=esm` output, where `require` is stubbed and throws
 * "Dynamic require of X is not supported" for the CJS deps pulled transitively
 * through @openharness/core (cross-spawn under pi-coding-agent). This banner
 * re-establishes a real `require` (plus __dirname/__filename, absent in ESM) so
 * the single-file sidecar runs on bare `node`. Confirmed working in the M3
 * recon spike; the `createRequire` line is the load-bearing one.
 */
const CJS_INTEROP_BANNER =
  "import{createRequire as __cr}from'module';import{fileURLToPath as __ftp}from'url';" +
  "import{dirname as __dn}from'path';const require=__cr(import.meta.url);" +
  "const __filename=__ftp(import.meta.url);const __dirname=__dn(__filename);";

export interface BuildHarnessAppOptions {
  /** Directory of the source HarnessDefinition (contains harness.json). */
  defDir: string;
  /** Path to the org's ed25519 PRIVATE key (PEM). Used to sign; never copied. */
  privateKeyPath: string;
  /** Output directory for the branded, ready-to-package project. */
  outDir: string;
  /** Org segment of the reverse-DNS app identifier (default "org"). */
  org?: string;
  /** App name segment / bundle name (default: the definition's `name`). */
  name?: string;
  /** Repo root holding apps/desktop (default: inferred from this module). */
  repoRoot?: string;
}

export interface BuildHarnessAppResult {
  outDir: string;
  identifier: string;
  productName: string;
  bundle: { name: string; version: string };
  /** Resource filenames staged under `<outDir>/resources`. */
  resources: string[];
}

/**
 * Fail the build LOUD if the definition references any file/dir OUTSIDE its own
 * directory. `bundleDefinition` walks ONLY files under `defDir`, so an outside
 * reference (systemPrompt/appendSystemPrompt file, promptLibrary, a skill dir,
 * or a project-relative MCP command/arg that escapes via `..`) loads fine on the
 * author's disk but ships a bundle MISSING those files — the app then breaks at
 * runtime, silently. Catching it here turns a silent runtime break into a clear
 * build failure naming the offending path.
 *
 * Resolution mirrors `loadHarnessDefinition` (`join(root, value)`), so an
 * absolute-looking prompt/skill value is treated as root-relative exactly as at
 * load; only a `..` escape falls outside. MCP `command`/`args` are validated
 * ONLY when they are project-relative (`./`, `../`): a bare binary name or an
 * absolute system path is provided by the target machine, not bundled, so it is
 * intentionally left alone.
 */
function assertReferencedPathsInside(defDir: string, manifest: HarnessManifest): void {
  const root = resolve(defDir);
  const inside = (value: string): boolean => {
    const abs = resolve(join(root, value));
    return abs === root || abs.startsWith(root + sep);
  };
  const check = (value: string, field: string): void => {
    if (!inside(value)) {
      throw new Error(
        `buildHarnessApp: ${field} references '${value}', which resolves OUTSIDE the ` +
          `definition dir (${root}). Only files inside the definition dir are bundled; ` +
          `referencing a file outside it ships a broken app. Move it inside the definition ` +
          `dir (or, for a prompt, use a lib: ref into an in-dir promptLibrary).`,
      );
    }
  };

  if (!manifest.systemPrompt.startsWith("lib:")) check(manifest.systemPrompt, "systemPrompt");
  if (manifest.appendSystemPrompt && !manifest.appendSystemPrompt.startsWith("lib:"))
    check(manifest.appendSystemPrompt, "appendSystemPrompt");
  if (manifest.promptLibrary) check(manifest.promptLibrary, "promptLibrary");
  for (const s of manifest.skills) check(s.path, `skill '${s.path}'`);

  const isRelPathRef = (v: string): boolean =>
    v.startsWith("./") || v.startsWith("../") || v.startsWith(`.${sep}`) || v.startsWith(`..${sep}`);
  for (const [name, spec] of Object.entries(manifest.mcp?.servers ?? {})) {
    if (spec.command && isRelPathRef(spec.command)) check(spec.command, `mcp server '${name}' command`);
    for (const arg of spec.args ?? []) {
      if (isRelPathRef(arg)) check(arg, `mcp server '${name}' arg '${arg}'`);
    }
  }
}

/** Sanitize an arbitrary string into one reverse-DNS-safe identifier segment. */
function idSegment(s: string): string {
  const seg = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return seg.length > 0 ? seg : "app";
}

/**
 * Rewrite a copied tauri.conf.json in place for one brand:
 *  - productName / identifier from the definition (identifier also drives the
 *    macOS bundle id AND the sidecar's per-brand config-dir isolation);
 *  - bundle.resources staging the signed bundle, org pubkey, and sidecar so the
 *    release build seals them where `resource_dir()` finds them at runtime;
 *  - frontendDist points at the sibling pre-built UI; the before* commands are
 *    dropped (the branded project has no npm scripts to run them).
 * The window title is NOT set here: main.rs reads it from productName at
 * runtime, so templating productName brands the window too (adding a window to
 * app.windows[] would collide with the Rust-created "main" window).
 */
function templateTauriConf(
  confPath: string,
  t: { productName: string; identifier: string },
): void {
  const conf = JSON.parse(readFileSync(confPath, "utf8")) as Record<string, unknown>;
  delete conf.$schema; // the source path is repo-relative and dangles in the output
  conf.productName = t.productName;
  conf.identifier = t.identifier;

  const build = (conf.build ?? {}) as Record<string, unknown>;
  build.frontendDist = "../dist-ui";
  delete build.beforeBuildCommand;
  delete build.beforeDevCommand;
  conf.build = build;

  const bundle = (conf.bundle ?? {}) as Record<string, unknown>;
  // Map form: <src relative to src-tauri> -> <dest under $RESOURCE>. Lands each
  // file at resource_dir()/<basename>, which release main.rs resolves.
  bundle.resources = {
    "../resources/server.mjs": "server.mjs",
    "../resources/harness.ohbundle": "harness.ohbundle",
    "../resources/org.pub": "org.pub",
    "../resources/min-version.txt": "min-version.txt",
  };
  conf.bundle = bundle;

  writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
}

/**
 * Turn one HarnessDefinition into a branded, signed, ready-to-package Tauri
 * project under `outDir`. apps/desktop is never mutated. KEY HYGIENE: only the
 * PUBLIC key is written into the artifact — the private key is read to sign and
 * otherwise never leaves the caller's disk.
 *
 * Layout produced:
 *   <outDir>/resources/harness.ohbundle   signed definition
 *   <outDir>/resources/org.pub            org PUBLIC key (verify-on-boot)
 *   <outDir>/resources/min-version.txt    anti-rollback FLOOR (this build's def version)
 *   <outDir>/resources/server.mjs         single-file bundled sidecar
 *   <outDir>/src-tauri/                    copied + templated Tauri crate
 *   <outDir>/dist-ui/                      pre-built frontend
 */
export async function buildHarnessApp(
  opts: BuildHarnessAppOptions,
): Promise<BuildHarnessAppResult> {
  const repoRoot = resolve(opts.repoRoot ?? DEFAULT_REPO_ROOT);
  const defDir = resolve(opts.defDir);
  const outDir = resolve(opts.outDir);

  // (a) load the definition for name + branding, then FAIL LOUD before doing any
  //     work if it references files outside its dir (they would not be bundled).
  const def = await loadHarnessDefinition(defDir);
  assertReferencedPathsInside(defDir, def.manifest);

  // EVERY file under the definition dir is base64-embedded into the signed,
  // distributed bundle. The private signing key must therefore live OUTSIDE it —
  // bundling it would ship the org's signing root to every recipient (they could
  // then forge any bundle). Refuse loudly before doing any work rather than leak.
  const keyAbs = resolve(opts.privateKeyPath);
  if (keyAbs === defDir || keyAbs.startsWith(defDir + sep)) {
    throw new Error(
      `buildHarnessApp: the private signing key (${keyAbs}) is INSIDE the definition dir (${defDir}). ` +
        `Every file in the definition dir is bundled into the distributed, signed artifact — bundling the ` +
        `private key would ship your signing root to every recipient. Move the key outside the definition dir.`,
    );
  }

  const name = opts.name ?? def.manifest.name;
  const org = opts.org ?? "org";
  const identifier = `ai.openharness.${idSegment(org)}.${idSegment(name)}`;
  const productName = def.manifest.branding.displayName;

  const resourcesDir = join(outDir, "resources");
  const srcTauriOut = join(outDir, "src-tauri");
  mkdirSync(resourcesDir, { recursive: true });

  // (b) sign the bundle + emit the PUBLIC key (derived from the private key,
  //     which itself is never written into the artifact).
  const privateKeyPem = readFileSync(resolve(opts.privateKeyPath), "utf8");
  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  const bundle = bundleDefinition(defDir, privateKeyPem);
  writeBundle(bundle, join(resourcesDir, "harness.ohbundle"));
  writeFileSync(join(resourcesDir, "org.pub"), publicKeyPem);
  // Bake this build's definition version as the anti-rollback FLOOR. main.rs
  // reads it in release and passes it to the sidecar as OH_MIN_VERSION, so a
  // later swap of an older (but still org-signed) bundle into the resource dir
  // is refused on boot. Trailing newline keeps it a well-formed text file; the
  // sidecar trims before use.
  writeFileSync(join(resourcesDir, "min-version.txt"), `${bundle.manifest.version}\n`);

  // (c) single-file bundle the sidecar. Full bundle, no externals; the banner
  //     is what makes the ESM output actually run (see CJS_INTEROP_BANNER).
  const sidecarEntry = join(repoRoot, "apps", "desktop", "src", "server.ts");
  await esbuild.build({
    entryPoints: [sidecarEntry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(resourcesDir, "server.mjs"),
    banner: { js: CJS_INTEROP_BANNER },
    logLevel: "warning",
  });

  // (d) copy the Tauri crate (never the build target dir) and template the conf.
  const srcTauriIn = join(repoRoot, "apps", "desktop", "src-tauri");
  cpSync(srcTauriIn, srcTauriOut, {
    recursive: true,
    filter: (src) => {
      const rel = relative(srcTauriIn, src);
      return rel !== "target" && !rel.startsWith(`target${sep}`);
    },
  });
  templateTauriConf(join(srcTauriOut, "tauri.conf.json"), { productName, identifier });

  // (e) copy the pre-built UI so frontendDist (../dist-ui) resolves. Build it
  //     first only if it is missing.
  const distUiIn = join(repoRoot, "apps", "desktop", "dist-ui");
  if (!existsSync(distUiIn)) {
    const r = spawnSync("npm", ["run", "build:ui", "--workspace", "@openharness/desktop"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error("failed to build the UI (vite build:ui)");
  }
  cpSync(distUiIn, join(outDir, "dist-ui"), { recursive: true });

  // (f) regenerate the cross-platform icon set from the brand icon, if any.
  //     Absent -> keep the copied defaults.
  if (def.iconPath && existsSync(def.iconPath)) {
    const tauriBin = join(repoRoot, "node_modules", ".bin", "tauri");
    const r = spawnSync(tauriBin, ["icon", def.iconPath, "-o", join(srcTauriOut, "icons")], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error("tauri icon generation failed");
  }

  return {
    outDir,
    identifier,
    productName,
    bundle: { name: bundle.manifest.name, version: bundle.manifest.version },
    resources: ["harness.ohbundle", "org.pub", "min-version.txt", "server.mjs"],
  };
}

#!/usr/bin/env node
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { verifyAuditLog } from "@openharness/audit";
import {
  BundleVerificationError,
  bundleDefinition,
  generateKeypair,
  verifyBundle,
  writeBundle,
} from "@openharness/bundle";
import { runChat } from "./chat.ts";

/** Value that follows a `--flag` token in argv, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * `openharness chat <harness-path> "<message>"` — one live turn against a
 * harness using a bring-your-own-key credential (ANTHROPIC_API_KEY etc. or
 * configDir()/accounts.json). Streams assistant text to stdout as it arrives.
 *
 * Run via the root `npm run chat -- <harness-path> "<message>"` (args reach
 * argv directly) or the `openharness` bin (`openharness chat ...`, where the
 * leading "chat" subcommand token is stripped below).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // `openharness audit verify <file>` — recompute the hash chain and report the
  // first broken entry (exit 1) or OK (exit 0).
  if (args[0] === "audit") {
    const [, sub, file] = args;
    if (sub !== "verify" || !file) {
      process.stderr.write("usage: openharness audit verify <file>\n");
      process.exit(2);
    }
    const result = verifyAuditLog(file);
    if (result.ok) {
      process.stdout.write(`audit log OK: ${file}\n`);
      process.exit(0);
    }
    process.stderr.write(`audit log BROKEN at entry ${result.brokenAt}: ${file}\n`);
    process.exit(1);
  }

  // `openharness keygen --out <prefix>` — write <prefix>.key (private, 0600) + <prefix>.pub.
  if (args[0] === "keygen") {
    const prefix = flag(args, "--out");
    if (!prefix) {
      process.stderr.write("usage: openharness keygen --out <prefix>\n");
      process.exit(2);
    }
    const { publicKey, privateKey } = generateKeypair();
    const keyPath = `${prefix}.key`;
    const pubPath = `${prefix}.pub`;
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    writeFileSync(pubPath, publicKey);
    process.stdout.write(`wrote ${keyPath} (private, 0600) and ${pubPath} (public)\n`);
    process.exit(0);
  }

  if (args[0] === "bundle") {
    // `openharness bundle verify <file> --pubkey <pubkeyfile> [--min-version X]`
    if (args[1] === "verify") {
      const file = args[2];
      const pubkeyFile = flag(args, "--pubkey");
      const minVersion = flag(args, "--min-version");
      if (!file || file.startsWith("--") || !pubkeyFile) {
        process.stderr.write(
          "usage: openharness bundle verify <file> --pubkey <pubkeyfile> [--min-version X]\n",
        );
        process.exit(2);
      }
      try {
        const { manifest } = verifyBundle(file, readFileSync(pubkeyFile, "utf8"), { minVersion });
        process.stdout.write(`bundle OK: ${manifest.name}@${manifest.version} (${file})\n`);
        process.exit(0);
      } catch (e) {
        if (e instanceof BundleVerificationError) {
          process.stderr.write(`bundle REJECTED: ${e.message}\n`);
          process.exit(1);
        }
        throw e;
      }
    }

    // `openharness bundle <defDir> --out <file> --key <privkeyfile>`
    const defDir = args[1];
    const out = flag(args, "--out");
    const keyFile = flag(args, "--key");
    if (!defDir || defDir.startsWith("--") || !out || !keyFile) {
      process.stderr.write("usage: openharness bundle <defDir> --out <file> --key <privkeyfile>\n");
      process.exit(2);
    }
    const bundle = bundleDefinition(defDir, readFileSync(keyFile, "utf8"));
    writeBundle(bundle, out);
    process.stdout.write(
      `wrote bundle ${out}: ${bundle.manifest.name}@${bundle.manifest.version}, ${Object.keys(bundle.manifest.files).length} files\n`,
    );
    process.exit(0);
  }

  if (args[0] === "chat") args.shift();
  const [harnessPath, message] = args;
  if (!harnessPath || message === undefined) {
    process.stderr.write('usage: openharness chat <harness-path> "<message>"\n');
    process.exit(2);
  }
  const { code } = await runChat({ harnessPath, message });
  process.exit(code);
}

main().catch((e: unknown) => {
  process.stderr.write(`${String((e as Error)?.message ?? e)}\n`);
  process.exit(1);
});

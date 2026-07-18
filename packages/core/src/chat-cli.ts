#!/usr/bin/env node
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditExportToNdjson,
  createAuditShipper,
  exportAuditLog,
  httpAuditPush,
  reconcileAuditLogs,
  verifyAuditLog,
} from "@openharness/audit";
import { buildHarnessApp } from "@openharness/build";
import {
  BundleVerificationError,
  bundleDefinition,
  generateKeypair,
  verifyBundle,
  writeBundle,
} from "@openharness/bundle";
import { MaterializeError, ScaffoldError, scaffoldHarness, writeHarnessDefinition } from "@openharness/definition";
import { createOpenHarnessServer } from "@openharness/server";
import { refreshPinnedDefinition } from "./update.ts";
import { runChat } from "./chat.ts";
import { runDoctor } from "./doctor.ts";
import { loginAccount } from "./accounts.ts";

/**
 * Value that follows a `--flag` token in argv, or undefined.
 *
 * A flag is treated as having NO value when it is the last token OR the token
 * that follows is itself another `--flag` — the flags here take
 * paths/urls/ids/versions, never a `--`-prefixed value, so a following `--`
 * token is the next flag, not this one's value.
 */
export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const next = args[i + 1];
  return next.startsWith("--") ? undefined : next;
}

/**
 * True when `--flag` appears in argv but has no usable value (it is the last
 * token, or is immediately followed by another `--flag`). Lets a call site
 * distinguish "flag omitted" from "flag given with no value" and error on the
 * latter instead of silently changing behavior.
 */
export function flagPresentButEmpty(args: string[], name: string): boolean {
  return args.includes(name) && flag(args, name) === undefined;
}

/**
 * Parse and validate a `--port` value. undefined → undefined (server default).
 * Throws (message mentions `--port`) on anything that is not an integer in
 * [0, 65535], so an invalid port surfaces as a clear CLI error instead of a
 * NaN that crashes `server.listen` with a Node-internal message.
 */
export function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || port > 65535) {
    throw new Error(`--port must be an integer in [0, 65535], got: ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * First positional (non-flag) token in argv, skipping leading flags so that
 * documented-optional flags may precede the positional. `valueFlags` names the
 * flags that consume the following token as their value (that value is not
 * mistaken for the positional); any other `--token` is a boolean flag skipped
 * on its own.
 */
export function firstPositional(args: string[], valueFlags: Iterable<string> = []): string | undefined {
  const takesValue = new Set(valueFlags);
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok.startsWith("--")) {
      if (takesValue.has(tok)) i++; // also skip its value
      continue;
    }
    return tok;
  }
  return undefined;
}

const USAGE = `openharness — build and run a company's own governed AI harness

Usage:
  openharness <harness-dir> "<message>"       one live turn (bring your own key)
  openharness chat <harness-dir> "<message>"  same, explicit form
  openharness login <accountId>               run the loopback OAuth (PKCE) login for an
                                              accounts.json oauth account and save it
  openharness init <dir> [--name N] [--display D] [--provider P] [--model M]
                                              scaffold a starter definition
  openharness materialize <spec.json> <out-dir>
                                              write a full definition from a spec + run doctor
  openharness doctor <harness-dir> [--strict-supply-chain]
                                              preflight a definition (no build;
                                              --strict-supply-chain fails on unpinned MCP servers)
  openharness keygen --out <prefix>           write <prefix>.key (0600) + <prefix>.pub
  openharness bundle <dir> --out <file> --key <privkey>            sign a bundle
  openharness bundle verify <file> --pubkey <pub> [--min-version X]  verify a bundle
  openharness build <dir> --key <privkey> --out <dir> [--org X] [--name Y]
                                              definition -> branded, signed app
  openharness serve --bundles <dir> --audit <dir> [--host H] [--port N]
                                              bundle host + audit sink
  openharness audit verify <file>             recompute the audit hash chain
  openharness audit export <file> [--since ISO] [--until ISO] [--type t1,t2] [--out FILE]
                                              compliance export (NDJSON + integrity manifest)
  openharness audit push <file> --server <url> [--source id] [--state path] [--token t]
                                              ship the local log to the authoritative server anchor
  openharness audit reconcile <local> <gateway>
                                              cross-check the local vs authoritative chain (divergence = tamper)
  openharness update --server <url> --pubkey <pub> --updates <dir> --floor <file> [--name N] [--current V] [--token t]
                                              pull + verify a newer signed definition (anti-rollback floor)

Docs: https://github.com/guim4dev/openharness`;

/**
 * `openharness chat <harness-path> "<message>"` — one live turn against a
 * harness using a bring-your-own-key credential (ANTHROPIC_API_KEY etc. or
 * configDir()/accounts.json). Streams assistant text to stdout as it arrives.
 *
 * Run via the root `npm run chat -- <harness-path> "<message>"` (args reach
 * argv directly) or the `openharness` bin (`openharness chat ...`, where the
 * leading "chat" subcommand token is stripped below).
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Top-level help. Only explicit help tokens or no args print the subcommand
  // list — an unknown args[0] is NOT hijacked, since `openharness <dir> "<msg>"`
  // is the implicit-chat shorthand (any non-subcommand first arg is a harness
  // path). Explicit help → stdout, exit 0; no args → stderr, exit 2 (nothing to do).
  if (args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (args.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }

  // `openharness audit verify <file>` — recompute the hash chain and report the
  // first broken entry (exit 1) or OK (exit 0).
  if (args[0] === "audit") {
    const [, sub, file] = args;
    if (sub === "verify" && file) {
      const result = verifyAuditLog(file);
      if (result.ok) {
        process.stdout.write(`audit log OK: ${file}\n`);
        process.exit(0);
      }
      process.stderr.write(`audit log BROKEN at entry ${result.brokenAt}: ${file}\n`);
      process.exit(1);
    }
    if (sub === "export" && file) {
      const since = flag(args, "--since");
      const until = flag(args, "--until");
      const typesRaw = flag(args, "--type");
      const out = flag(args, "--out");
      // `--out` given but value-less (trailing, or followed by another flag)
      // is a user error — do NOT silently fall back to a stdout dump.
      if (flagPresentButEmpty(args, "--out")) {
        process.stderr.write("usage: openharness audit export <file> [...] [--out FILE]  (--out requires a value)\n");
        process.exit(2);
      }
      const exported = exportAuditLog(file, {
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(typesRaw ? { types: typesRaw.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
      });
      const ndjson = auditExportToNdjson(exported);
      if (out) {
        writeFileSync(out, ndjson);
        process.stdout.write(
          `exported ${exported.manifest.count}/${exported.manifest.totalCount} records to ${out} (verified=${exported.manifest.verified}, head=${exported.manifest.headHash ?? "none"})\n`,
        );
      } else {
        process.stdout.write(ndjson);
      }
      // Exit nonzero when the source chain did not verify, so a pipeline can gate.
      process.exit(exported.manifest.verified ? 0 : 1);
    }
    if (sub === "push" && file) {
      const server = flag(args, "--server");
      const source = flag(args, "--source") ?? "default";
      const token = flag(args, "--token");
      const statePath = flag(args, "--state");
      if (!server) {
        process.stderr.write("usage: openharness audit push <file> --server <url> [--source id] [--state path] [--token t]\n");
        process.exit(2);
      }
      const shipper = createAuditShipper({
        logPath: file,
        push: httpAuditPush(server, source, token),
        ...(statePath ? { statePath } : {}),
      });
      const r = await shipper.flush();
      if (r.ok) {
        process.stdout.write(`shipped ${r.shipped} record(s) to ${server} (source=${source}, ackedSeq=${r.ackedSeq})\n`);
        process.exit(0);
      }
      if (r.conflict) {
        process.stderr.write(`audit integrity ALARM: the server rejected the chain — ${r.conflict}\n`);
        process.exit(1);
      }
      process.stderr.write(`audit push failed (retryable): ${r.retryable}\n`);
      process.exit(1);
    }
    if (sub === "reconcile") {
      const localPath = args[2];
      const gatewayPath = args[3];
      if (!localPath || !gatewayPath) {
        process.stderr.write("usage: openharness audit reconcile <local.jsonl> <gateway.jsonl>\n");
        process.exit(2);
      }
      const r = reconcileAuditLogs(localPath, gatewayPath);
      if (r.problems.length > 0) {
        // Untrusted input (unverifiable chain / unparseable / malformed) — fail
        // closed. This is NOT a clean "no divergence": we could not trust the files.
        process.stderr.write(`audit reconcile FAILED — input could not be trusted:\n`);
        for (const p of r.problems) process.stderr.write(`  ${p}\n`);
        process.exit(1);
      }
      if (r.ok) {
        process.stdout.write(`audit chains reconcile: ${r.matched} governed call(s) match, no divergence\n`);
        process.exit(0);
      }
      process.stderr.write(
        `audit DIVERGENCE (tamper evidence): ${r.onlyInGateway.length} governed call(s) missing locally, ` +
          `${r.onlyInLocal.length} local call(s) absent from the authoritative chain\n`,
      );
      for (const c of r.onlyInGateway) process.stderr.write(`  only in gateway: ${c.tool} (${c.argsHash.slice(0, 12)}…)\n`);
      for (const c of r.onlyInLocal) process.stderr.write(`  only in local:   ${c.tool} (${c.argsHash.slice(0, 12)}…)\n`);
      process.exit(1);
    }
    process.stderr.write(
      "usage: openharness audit verify <file> | export <file> [...] | push <file> --server <url> [...] | reconcile <local> <gateway>\n",
    );
    process.exit(2);
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

  // `openharness login <accountId>` — run the loopback OAuth (PKCE) flow for an
  // oauth account defined in accounts.json, then persist the resulting NON-SECRET
  // refs/expiry so the next run resolves it. Tokens are written to the encrypted
  // store by the provider and are NEVER printed here.
  if (args[0] === "login") {
    const accountId = args[1];
    if (!accountId || accountId.startsWith("--")) {
      process.stderr.write("usage: openharness login <accountId>\n");
      process.exit(2);
    }
    await loginAccount(accountId, {
      onAuthorize: (auth) => {
        process.stdout.write(
          `Open this URL in your browser to sign in:\n\n  ${auth.url}\n\n${auth.instructions}\n\nWaiting for the browser redirect…\n`,
        );
      },
    });
    process.stdout.write(
      `\nLogged in '${accountId}'. Credential saved (tokens stored encrypted; never printed).\n`,
    );
    process.exit(0);
  }

  // `openharness update ...` — pull a newer signed definition from the server,
  // verify it under the org pubkey with the persisted anti-rollback floor, and
  // write it to the updates dir (advancing the floor). A tampered/rolled-back
  // bundle is refused (exit 1); an up-to-date server is a clean no-op (exit 0).
  if (args[0] === "update") {
    const server = flag(args, "--server");
    const pubkeyPath = flag(args, "--pubkey");
    const updatesDir = flag(args, "--updates");
    const floorPath = flag(args, "--floor");
    if (!server || !pubkeyPath || !updatesDir || !floorPath) {
      process.stderr.write(
        "usage: openharness update --server <url> --pubkey <pub> --updates <dir> --floor <file> [--name N] [--current V] [--token t]\n",
      );
      process.exit(2);
    }
    const r = await refreshPinnedDefinition({
      serverUrl: server,
      pubkeyPem: readFileSync(pubkeyPath, "utf8"),
      updatesDir,
      floorPath,
      ...(flag(args, "--name") ? { name: flag(args, "--name") } : {}),
      ...(flag(args, "--current") ? { currentVersion: flag(args, "--current") } : {}),
      ...(flag(args, "--token") ? { token: flag(args, "--token") } : {}),
    });
    if (r.rejected) {
      process.stderr.write(`update REJECTED (tamper/rollback): ${r.reason}\n`);
      process.exit(1);
    }
    process.stdout.write(
      r.updated ? `updated to ${r.version} (written to ${updatesDir}, floor advanced)\n` : `already up to date at ${r.version}\n`,
    );
    process.exit(0);
  }

  // `openharness init <dir> [--name X] [--display Y] [--provider P] [--model M]`
  // — scaffold a minimal, valid, offline-safe HarnessDefinition. Refuses to
  // write into an existing, non-empty dir (never overwrites).
  if (args[0] === "init") {
    const dir = args[1];
    if (!dir || dir.startsWith("--")) {
      process.stderr.write(
        "usage: openharness init <dir> [--name <n>] [--display <d>] [--provider <p>] [--model <m>]\n",
      );
      process.exit(2);
    }
    try {
      const result = await scaffoldHarness(dir, {
        name: flag(args, "--name"),
        displayName: flag(args, "--display"),
        provider: flag(args, "--provider"),
        model: flag(args, "--model"),
      });
      process.stdout.write(`scaffolded '${result.name}' at ${result.rootDir}\n`);
      process.stdout.write(`next: npm run chat -- ${dir} "Say hello in one line."\n`);
      process.exit(0);
    } catch (e) {
      if (e instanceof ScaffoldError) {
        process.stderr.write(`${e.message}\n`);
        process.exit(1);
      }
      throw e;
    }
  }

  // `openharness doctor <defDir>` — preflight a definition without building it.
  // Prints every problem; exits 0 when there are no error-level problems
  // (warnings still print), else exits 1.
  if (args[0] === "doctor") {
    // Positional is the first non-flag token, so `--strict-supply-chain` may
    // precede the dir (`openharness doctor --strict-supply-chain <dir>`).
    const defDir = firstPositional(args.slice(1));
    if (!defDir) {
      process.stderr.write("usage: openharness doctor <defDir>\n");
      process.exit(2);
    }
    const report = await runDoctor(defDir, { strictSupplyChain: args.includes("--strict-supply-chain") });
    const errors = report.problems.filter((p) => p.level === "error").length;
    const warns = report.problems.length - errors;
    for (const p of report.problems) {
      const line = `  [${p.level === "error" ? "ERROR" : "warn"}] ${p.code}: ${p.message}\n`;
      (p.level === "error" ? process.stderr : process.stdout).write(line);
    }
    const label = report.defName ?? defDir;
    const warnSuffix = warns ? ` (${warns} warning${warns === 1 ? "" : "s"})` : "";
    if (report.ok) {
      process.stdout.write(`doctor: ${label} OK${warnSuffix}\n`);
      process.exit(0);
    }
    process.stderr.write(
      `doctor: ${label} has ${errors} error${errors === 1 ? "" : "s"}${warns ? ` and ${warns} warning${warns === 1 ? "" : "s"}` : ""}\n`,
    );
    process.exit(1);
  }

  // `openharness materialize <spec.json> <out-dir>` — write a COMPLETE definition
  // from an in-memory spec (`{ manifest, policy?, systemPrompt }` — the shape the
  // visual builder emits) and run doctor on the result. The headless counterpart
  // to the visual builder, for automation. Exits non-zero on a doctor error.
  if (args[0] === "materialize") {
    const [, specPath, outDir] = args;
    if (!specPath || specPath.startsWith("--") || !outDir) {
      process.stderr.write("usage: openharness materialize <spec.json> <out-dir>\n");
      process.exit(2);
    }
    let spec: { manifest: unknown; policy?: unknown; systemPrompt?: string };
    try {
      spec = JSON.parse(readFileSync(specPath, "utf8")) as typeof spec;
    } catch (e) {
      process.stderr.write(`materialize: '${specPath}' is not valid JSON: ${(e as Error).message}\n`);
      process.exit(1);
    }
    try {
      const result = await writeHarnessDefinition(outDir, {
        manifest: spec.manifest,
        ...(spec.policy !== undefined ? { policy: spec.policy } : {}),
        systemPrompt: spec.systemPrompt ?? "",
      });
      const report = await runDoctor(result.rootDir);
      for (const p of report.problems) {
        const line = `  [${p.level === "error" ? "ERROR" : "warn"}] ${p.code}: ${p.message}\n`;
        (p.level === "error" ? process.stderr : process.stdout).write(line);
      }
      process.stdout.write(
        `materialized ${result.files.length} file(s) at ${result.rootDir} — doctor ${report.ok ? "OK" : "FAILED"}\n`,
      );
      process.exit(report.ok ? 0 : 1);
    } catch (e) {
      if (e instanceof MaterializeError) {
        process.stderr.write(`materialize: ${e.message}\n`);
        process.exit(1);
      }
      throw e;
    }
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

  // `openharness build <def-dir> --key <privkeyfile> --out <dir> [--org X] [--name Y]`
  // — turn one HarnessDefinition into a branded, signed, ready-to-package Tauri
  // project. Only the PUBLIC key is ever written into the output.
  if (args[0] === "build") {
    const defDir = args[1];
    const keyFile = flag(args, "--key");
    const out = flag(args, "--out");
    const org = flag(args, "--org");
    const name = flag(args, "--name");
    if (!defDir || defDir.startsWith("--") || !keyFile || !out) {
      process.stderr.write(
        "usage: openharness build <def-dir> --key <privkeyfile> --out <dir> [--org X] [--name Y]\n",
      );
      process.exit(2);
    }
    // Preflight with doctor: never ship a bundle whose harness can't run its own
    // model, is missing its icon, or names an LLM key as an MCP secret. Warnings
    // print but don't block; any error-level problem refuses the build.
    const pre = await runDoctor(defDir);
    for (const p of pre.problems) {
      (p.level === "error" ? process.stderr : process.stdout).write(
        `  [${p.level === "error" ? "ERROR" : "warn"}] ${p.code}: ${p.message}\n`,
      );
    }
    if (!pre.ok) {
      const errs = pre.problems.filter((p) => p.level === "error").length;
      process.stderr.write(
        `build refused: ${pre.defName ?? defDir} has ${errs} doctor error${errs === 1 ? "" : "s"} — fix them (or run 'openharness doctor ${defDir}') before building.\n`,
      );
      process.exit(1);
    }
    const result = await buildHarnessApp({
      defDir,
      privateKeyPath: keyFile,
      outDir: out,
      org,
      name,
    });
    process.stdout.write(
      `built ${result.productName} (${result.identifier}) -> ${result.outDir}\n`,
    );
    process.stdout.write(
      `  bundle ${result.bundle.name}@${result.bundle.version}; resources: ${result.resources.join(", ")}\n`,
    );
    process.exit(0);
  }

  // `openharness serve --bundles <dir> --audit <dir> [--host H] [--port N]` —
  // the thin bundle host + audit sink (DP5). Token comes from env, never argv.
  if (args[0] === "serve") {
    const bundlesDir = flag(args, "--bundles");
    const auditDir = flag(args, "--audit");
    const host = flag(args, "--host");
    const portArg = flag(args, "--port");
    if (!bundlesDir || !auditDir) {
      process.stderr.write(
        "usage: openharness serve --bundles <dir> --audit <dir> [--host H] [--port N]\n",
      );
      process.exit(2);
    }
    let port: number | undefined;
    try {
      port = parsePort(portArg);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(2);
    }
    const token = process.env.OPENHARNESS_SERVER_TOKEN;
    const server = createOpenHarnessServer({
      bundlesDir,
      auditDir,
      token,
      host,
      port,
    });
    const { url } = await server.start();
    process.stdout.write(`openharness server listening at ${url}\n`);
    process.stdout.write(
      `boundary: binds to ${host ?? "127.0.0.1"} only; ${
        token ? "token-gated (Bearer) on /bundle and /audit" : "NO TOKEN SET — /bundle and /audit are open to anyone reaching this host"
      }; no SSO, no org model.\n`,
    );
    return;
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

// Auto-run only when executed as the entry (not when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`${String((e as Error)?.message ?? e)}\n`);
    process.exit(1);
  });
}

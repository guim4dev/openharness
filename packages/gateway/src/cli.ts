#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EncryptedFileSecretStore } from "@openharness/credentials";
import { loadGatewayServerConfig } from "./config.ts";
import { startGatewayFromConfig } from "./serve.ts";

const USAGE = `openharness-gateway — run a governed remote MCP gateway

Usage:
  openharness-gateway serve <config.json>              Start the gateway from a config file.
  openharness-gateway set-secret <id> [--secrets <dir>]  Store an upstream credential (value read from STDIN).
  openharness-gateway --help                           Show this help.

The org's per-upstream credentials the broker resolves after each policy
decision live in an encrypted store beside the config (<config-dir>/secrets, or
set OPENHARNESS_GATEWAY_SECRETS), keyed 'upstream:<id>'. Populate it with
'set-secret' (the value is read from stdin, never argv) before serving — the
config file itself never holds a secret. A KMS-backed store is the production
target (deploy hardening).`;

const UPSTREAM_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Store an org credential for `upstream:<id>` in the encrypted store at
 * `secretsDir`. The value is provided by the caller (read from stdin by the CLI,
 * so it never lands in argv / shell history). Testable without a TTY.
 */
export async function setUpstreamSecret(secretsDir: string, id: string, value: string): Promise<void> {
  if (!UPSTREAM_ID.test(id)) throw new Error(`invalid upstream id '${id}' — use [A-Za-z0-9._-]`);
  if (value.length === 0) throw new Error("refusing to store an empty secret");
  const store = await EncryptedFileSecretStore.open(secretsDir);
  await store.set(`upstream:${id}`, value);
}

/** Read all of stdin as a string, trimming a single trailing newline. */
function readStdin(): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => res(Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "")));
    process.stdin.on("error", rej);
  });
}

/** Read a `--flag <value>` from argv. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * Resolve the encrypted upstream-secret store dir, consistently for every
 * command: an explicit `--secrets <dir>`, else `OPENHARNESS_GATEWAY_SECRETS`,
 * else the config-adjacent default (`<config-dir>/secrets`) when known, else
 * `./secrets`. Keeps `serve` and `set-secret` pointing at the same store.
 */
function secretsDirFor(argv: string[], configDefault?: string): string {
  const explicit = flag(argv, "--secrets");
  if (explicit) return resolve(explicit);
  if (process.env.OPENHARNESS_GATEWAY_SECRETS) return resolve(process.env.OPENHARNESS_GATEWAY_SECRETS);
  return configDefault ?? resolve("secrets");
}

/**
 * Parse the per-approver token map from `OPENHARNESS_GATEWAY_APPROVERS` — a JSON
 * object of approver identity -> bearer token. Real dual control
 * (`approval.requireSecondPerson`) needs this: the single shared admin token
 * resolves to identity "admin", which can't be a distinct second person. Malformed
 * JSON or a non-`{string: string}` shape THROWS (fail closed) — a deployer who
 * sets it expecting dual control must not have it silently dropped. (Empty tokens
 * are rejected downstream at boot.)
 */
export function parseApprovers(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OPENHARNESS_GATEWAY_APPROVERS must be a JSON object of { "approver-identity": "token" }');
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("OPENHARNESS_GATEWAY_APPROVERS must be a JSON object (approver identity -> token)");
  const out: Record<string, string> = {};
  for (const [id, token] of Object.entries(parsed)) {
    if (typeof token !== "string") throw new Error(`OPENHARNESS_GATEWAY_APPROVERS['${id}'] must be a string token`);
    out[id] = token;
  }
  return out;
}

/** Print help / dispatch. Returns without starting a server for non-serve commands. */
export async function main(argv: string[]): Promise<void> {
  const [cmd] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }

  if (cmd === "set-secret") {
    const id = argv[1];
    if (!id || id.startsWith("--")) {
      console.error(`set-secret requires an <id>\n\n${USAGE}`);
      process.exitCode = 1;
      return;
    }
    const value = await readStdin();
    const cfgFlag = flag(argv, "--config");
    const configDefault = cfgFlag ? join(dirname(resolve(cfgFlag)), "secrets") : undefined;
    try {
      await setUpstreamSecret(secretsDirFor(argv, configDefault), id, value);
    } catch (e) {
      console.error(`[openharness-gateway] ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[openharness-gateway] stored credential for upstream '${id}' (value not logged).`);
    return;
  }

  if (cmd !== "serve") {
    console.error(`unknown command '${cmd}'\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const configArg = argv[1];
  if (!configArg || configArg.startsWith("--")) {
    console.error(`serve requires a <config.json> path\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const configPath = resolve(configArg);
  const config = loadGatewayServerConfig(configPath);
  const secretsDir = secretsDirFor(argv, join(dirname(configPath), "secrets"));
  const secretStore = await EncryptedFileSecretStore.open(secretsDir);
  const adminToken = process.env.OPENHARNESS_GATEWAY_ADMIN_TOKEN;
  const approvers = parseApprovers(process.env.OPENHARNESS_GATEWAY_APPROVERS);
  const server = await startGatewayFromConfig(config, {
    secretStore,
    ...(adminToken ? { adminToken } : {}),
    ...(approvers ? { approvers } : {}),
  });
  console.log(`[openharness-gateway] listening at ${server.url}`);

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Auto-run only when executed as the entry (not when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((err) => {
    console.error(`[openharness-gateway] ${(err as Error)?.message ?? String(err)}`);
    process.exit(1);
  });
}

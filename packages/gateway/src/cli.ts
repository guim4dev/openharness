#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EncryptedFileSecretStore } from "@openharness/credentials";
import { loadGatewayServerConfig } from "./config.ts";
import { startGatewayFromConfig } from "./serve.ts";

const USAGE = `openharness-gateway — run a governed remote MCP gateway

Usage:
  openharness-gateway serve <config.json>    Start the gateway from a config file.
  openharness-gateway --help                 Show this help.

The org's per-upstream credentials the broker resolves after each policy
decision live in an encrypted store beside the config (<config-dir>/secrets, or
set OPENHARNESS_GATEWAY_SECRETS), keyed 'upstream:<id>'. Populate it out of band
before serving — the config file itself never holds a secret. A KMS-backed store
is the production target (deploy hardening).`;

/** Print help / dispatch. Returns without starting a server for non-serve commands. */
export async function main(argv: string[]): Promise<void> {
  const [cmd, configArg] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }
  if (cmd !== "serve") {
    console.error(`unknown command '${cmd}'\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (!configArg) {
    console.error(`serve requires a <config.json> path\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const configPath = resolve(configArg);
  const config = loadGatewayServerConfig(configPath);
  const secretsDir = process.env.OPENHARNESS_GATEWAY_SECRETS ?? join(dirname(configPath), "secrets");
  const secretStore = await EncryptedFileSecretStore.open(secretsDir);
  const server = await startGatewayFromConfig(config, { secretStore });
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

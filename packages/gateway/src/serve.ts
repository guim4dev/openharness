import { createFileAuditLog } from "@openharness/audit";
import type { SecretStore } from "@openharness/credentials";
import { SecretStoreKms } from "./broker.ts";
import { createApprovalQueue } from "./approval.ts";
import { createConnectorSessions } from "./sessions.ts";
import { createGithubReadConnector } from "./connectors/github-read.ts";
import { createNotifyConnector } from "./connectors/notify.ts";
import type { Connector } from "./connectors/index.ts";
import { startGatewayHttp, type GatewayHttpServer } from "./http.ts";
import type { ResolvedGatewayServerConfig } from "./config.ts";

/**
 * Connector implementations a config may instantiate by `type`. Kept small and
 * explicit — a signed config must never be able to spin up an arbitrary
 * connector; only vetted, first-party ones are registered here.
 */
const CONNECTOR_FACTORIES: Record<string, () => Connector> = {
  "github-read": () => createGithubReadConnector(),
  notify: () => createNotifyConnector(),
};

export interface StartGatewayFromConfigOptions {
  /**
   * Machine-local secret store holding the org's per-upstream credentials under
   * `upstream:<id>`. The broker resolves them AFTER the policy decision; they
   * never live in the config file.
   */
  secretStore: SecretStore;
  /**
   * Extra/override connector factories by `type`, merged OVER the built-in
   * registry. Lets a deployment register a private connector, and lets a test
   * inject a stubbed one so no real upstream is reached. A `type` present here
   * wins over a built-in of the same name.
   */
  connectorFactories?: Record<string, () => Connector>;
}

/**
 * Boot a governed gateway from a resolved config: wire the credential broker over
 * the secret store, a per-principal connector-session pool from the config's
 * connectors, the authoritative file audit log, and the approval queue, then
 * start the DPoP-authenticated HTTP entry. Responses are signed with the config's
 * private key so clients can verify the pinned pubkey.
 */
export async function startGatewayFromConfig(
  config: ResolvedGatewayServerConfig,
  opts: StartGatewayFromConfigOptions,
): Promise<GatewayHttpServer> {
  const registry: Record<string, () => Connector> = { ...CONNECTOR_FACTORIES, ...(opts.connectorFactories ?? {}) };
  const factories: Record<string, () => Connector> = {};
  for (const c of config.connectors) {
    const factory = registry[c.type];
    if (!factory) {
      throw new Error(
        `gateway config: connector '${c.id}' has unknown type '${c.type}' (known: ${Object.keys(registry).join(", ")})`,
      );
    }
    factories[c.id] = factory;
  }

  return startGatewayHttp({
    catalog: config.catalog,
    gatewayPublicKeyPem: config.gatewayPublicKeyPem,
    gatewayPrivateKeyPem: config.gatewayPrivateKeyPem,
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(config.path !== undefined ? { path: config.path } : {}),
    pipeline: {
      policy: config.policy,
      policyVersion: config.policyVersion,
      broker: new SecretStoreKms(opts.secretStore),
      sessions: createConnectorSessions(factories),
      audit: createFileAuditLog(config.auditPath),
      approval: createApprovalQueue(config.approval ?? { timeoutMs: 30_000 }),
    },
  });
}

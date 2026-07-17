import { createFileAuditLog } from "@openharness/audit";
import type { SecretStore } from "@openharness/credentials";
import { SecretStoreKms, type KmsStore } from "./broker.ts";
import { PooledKmsStore } from "./broker-pool.ts";
import { createApprovalQueue } from "./approval.ts";
import { createConnectorSessions } from "./sessions.ts";
import {
  ChildProcessSandboxHost,
  createSandboxedConnectorSessions,
  type ConnectorDescriptor,
  type SandboxHost,
} from "./connector-sandbox.ts";
import { createStaticKeyIdpVerifier } from "./idp-static.ts";
import { factories as builtinFactories } from "./connectors/registry.ts";
import type { Connector } from "./connectors/index.ts";
import { startGatewayHttp, type GatewayHttpServer } from "./http.ts";
import type { ResolvedGatewayServerConfig } from "./config.ts";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Connector implementations a config may instantiate by `type` — the vetted
 * first-party registry, shared with the out-of-process worker via
 * `connectors/registry.ts` (one source of truth).
 */
const CONNECTOR_FACTORIES: Record<string, () => Connector> = builtinFactories;
/** Absolute path to the built-in connector registry module (worker default). */
const BUILTIN_REGISTRY = fileURLToPath(new URL("./connectors/registry.ts", import.meta.url));
/** Absolute path to the connector worker entry. */
const CONNECTOR_WORKER = fileURLToPath(new URL("./connector-worker.ts", import.meta.url));

export interface StartGatewayFromConfigOptions {
  /**
   * Machine-local secret store holding the org's per-upstream credentials under
   * `upstream:<id>`. The broker resolves them AFTER the policy decision; they
   * never live in the config file.
   */
  secretStore: SecretStore;
  /**
   * Credential broker override. When set, the pipeline uses it instead of the
   * default local `SecretStoreKms(secretStore)` — this is the seam a production
   * deployment fills with a KMS-backed `KmsBrokerStore` (deploy hardening §4), so
   * the gateway holds no long-lived plaintext. `secretStore` is then unused for
   * upstream credentials.
   */
  broker?: KmsStore;
  /**
   * Out-of-process connector sandbox (deploy hardening §5). When set, connector
   * `call()` runs in a warm per-(principal, connector) worker instead of the
   * gateway process — a deployment builds the `SandboxHost` (choosing the worker
   * runtime + vetted registry module) and supplies the in-process descriptors
   * (`tools`/`allowHosts`). When omitted, connectors run in-process as before.
   */
  sandbox?: { host: SandboxHost; descriptors: Record<string, ConnectorDescriptor> };
  /**
   * Out-of-band admin bearer token for the approval surface (deploy hardening —
   * server-side approval). When set, `GET/POST <adminPath>/approvals` are mounted
   * so a policy `ask` is answerable over HTTP. Comes from the environment
   * (`OPENHARNESS_GATEWAY_ADMIN_TOKEN`), never the config file.
   */
  adminToken?: string;
  /**
   * Per-approver bearer tokens (approver identity -> token) for the approval
   * surface — makes `requireSecondPerson` a real control (the `by` is the
   * authenticated approver, not a body field). From the deployment's env/secret
   * store, never the config file. Composes with `adminToken` (identity "admin").
   */
  approvers?: Record<string, string>;
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
  // The in-process connector factories power the NON-sandbox path. In sandbox
  // mode the connectors are instantiated inside the worker from the sandbox
  // registry module, and their types are validated there — so this in-process
  // validation would wrongly reject a sandbox-only type, and is skipped.
  const sandboxActive = !!opts.sandbox || config.sandbox?.kind === "child-process";
  const registry: Record<string, () => Connector> = { ...CONNECTOR_FACTORIES, ...(opts.connectorFactories ?? {}) };
  const factories: Record<string, () => Connector> = {};
  if (!sandboxActive) {
    for (const c of config.connectors) {
      const factory = registry[c.type];
      if (!factory) {
        throw new Error(
          `gateway config: connector '${c.id}' has unknown type '${c.type}' (known: ${Object.keys(registry).join(", ")})`,
        );
      }
      factories[c.id] = factory;
    }
  }

  // IdP token exchange (deploy hardening §3): when the config declares it, mount
  // POST <tokenPath> with a static-key EdDSA-JWT verifier over the configured IdP
  // public key. Requires the gateway private key (present in config) to mint.
  const tx = config.tokenExchange;
  const idp = tx
    ? createStaticKeyIdpVerifier({
        publicKeyPem: tx.idpPublicKeyPem,
        issuer: tx.issuer,
        audience: tx.audience,
        ...(tx.groupsClaim ? { groupsClaim: tx.groupsClaim } : {}),
      })
    : undefined;

  // Credential broker (deploy hardening §4). An explicit `opts.broker` wins (a
  // deployment can inject a KMS-backed one); else the config selects a pooled
  // broker (rotation behind the gateway) drawing each upstream from ordered
  // `upstream:<ref>` secrets; else the default single-credential store.
  const configuredBroker: KmsStore | undefined =
    config.broker?.kind === "pool"
      ? new PooledKmsStore({
          upstreams: config.broker.upstreams,
          resolveRef: async (ref) => {
            const secret = await opts.secretStore.get(`upstream:${ref}`);
            return secret !== undefined ? { secret } : undefined;
          },
        })
      : undefined;

  // Connector sandbox (deploy hardening §5). An explicit `opts.sandbox` wins;
  // else the config selects the child-process sandbox: the worker imports the
  // registry module (built-in first-party by default) for its factories, and we
  // import the SAME module here to snapshot each connector's static descriptor
  // (tools/allowHosts) — the only part the pipeline reads in-process.
  let configuredSandbox: { host: SandboxHost; descriptors: Record<string, ConnectorDescriptor> } | undefined;
  if (config.sandbox?.kind === "child-process") {
    const registryModule = config.sandbox.registryModule ?? BUILTIN_REGISTRY;
    const reg = (await import(pathToFileURL(registryModule).href)) as { factories?: Record<string, () => Connector> };
    const descriptors: Record<string, ConnectorDescriptor> = {};
    for (const c of config.connectors) {
      const make = reg.factories?.[c.type];
      if (!make) throw new Error(`gateway config: sandbox registry has no connector type '${c.type}'`);
      const inst = make();
      descriptors[c.id] = { id: inst.id, tools: inst.tools, allowHosts: inst.allowHosts };
    }
    const host = new ChildProcessSandboxHost({
      workerModule: CONNECTOR_WORKER,
      registryModule,
      execArgv: config.sandbox.execArgv ?? ["--experimental-strip-types", "--no-warnings"],
    });
    configuredSandbox = { host, descriptors };
  }
  const sandbox = opts.sandbox ?? configuredSandbox;

  // `requireSecondPerson` is only a real control if a distinct approver identity
  // can act. The single shared `adminToken` resolves to identity "admin", which
  // always differs from an IdP `sub` — so it would pass the second-person check
  // while letting ONE operator approve their own request. Fail closed at boot
  // rather than provide false dual control: require at least one non-empty
  // per-approver token when requireSecondPerson is set.
  if (config.approval?.requireSecondPerson) {
    const hasApprover = Object.values(opts.approvers ?? {}).some(
      (t) => typeof t === "string" && t.trim() !== "",
    );
    if (!hasApprover)
      throw new Error(
        "approval.requireSecondPerson is set but no per-approver tokens are configured — the shared admin token cannot be a distinct second person (one operator could self-approve). Supply `approvers` (identity -> token) or unset requireSecondPerson.",
      );
  }

  return startGatewayHttp({
    catalog: config.catalog,
    gatewayPublicKeyPem: config.gatewayPublicKeyPem,
    gatewayPrivateKeyPem: config.gatewayPrivateKeyPem,
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(config.path !== undefined ? { path: config.path } : {}),
    ...(idp ? { idp } : {}),
    ...(tx?.tokenPath ? { tokenPath: tx.tokenPath } : {}),
    ...(tx?.ttlMs ? { tokenTtlMs: tx.ttlMs } : {}),
    ...(opts.adminToken ? { adminToken: opts.adminToken } : {}),
    ...(opts.approvers ? { approvers: opts.approvers } : {}),
    pipeline: {
      policy: config.policy,
      policyVersion: config.policyVersion,
      broker: opts.broker ?? configuredBroker ?? new SecretStoreKms(opts.secretStore),
      sessions: sandbox ? createSandboxedConnectorSessions(sandbox) : createConnectorSessions(factories),
      audit: createFileAuditLog(config.auditPath),
      approval: createApprovalQueue(config.approval ?? { timeoutMs: 30_000 }),
    },
  });
}

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { parsePolicy, type Policy } from "@openharness/policy";

/**
 * On-disk configuration for a deployable gateway (`openharness-gateway serve`).
 * Like the harness definition, it references credentials by NAME, never value:
 * the org's per-upstream secrets live in the machine-local secret store under
 * `upstream:<id>` and are resolved by the broker at call time — the config file
 * itself is safe to commit. Key material is referenced by file path (PEM).
 */
const toolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  connectorId: z.string().min(1).optional(),
  upstreamId: z.string().min(1).optional(),
  inputSchema: z.record(z.unknown()).optional(),
});

const connectorSchema = z.object({
  id: z.string().min(1),
  /** Connector implementation to instantiate (see the factory registry in serve.ts). */
  type: z.string().min(1),
});

export const gatewayServerConfigSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().nonnegative().optional(),
  path: z.string().min(1).optional(),
  keys: z.object({
    /** PEM file paths (resolved relative to the config file). */
    publicKey: z.string().min(1),
    privateKey: z.string().min(1),
  }),
  /** A policy.json path (resolved relative to the config) OR an inline policy object. */
  policy: z.union([z.string().min(1), z.record(z.unknown())]),
  policyVersion: z.string().min(1),
  /** Where the authoritative hash-chained audit log is written (required — a gateway must audit). */
  auditPath: z.string().min(1),
  approval: z.object({ timeoutMs: z.number().int().positive(), requireSecondPerson: z.boolean().optional() }).optional(),
  /**
   * IdP token exchange (deploy hardening §3). When present, `POST <tokenPath>`
   * exchanges an EdDSA-JWT subject token from the org IdP (validated against
   * `idpPublicKey` with iss/aud/exp) for a DPoP-bound gateway token. Omit for the
   * dev path where tokens are minted out of band.
   */
  tokenExchange: z
    .object({
      /** PEM file path (relative to the config) of the IdP's Ed25519 public key. */
      idpPublicKey: z.string().min(1),
      issuer: z.string().min(1),
      audience: z.string().min(1),
      groupsClaim: z.string().min(1).optional(),
      tokenPath: z.string().min(1).optional(),
      ttlMs: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Credential broker selection (deploy hardening §4). Omit for the default
   * single-credential store (`upstream:<id>`). `pool` draws each upstream from an
   * ordered list of credential refs (each stored `upstream:<ref>`) and rotates
   * behind the gateway on reported failures.
   */
  broker: z
    .object({
      kind: z.literal("pool"),
      /** upstreamId -> ordered credential refs (each stored under `upstream:<ref>`). */
      upstreams: z.record(z.array(z.string().min(1)).min(1)),
    })
    .optional(),
  catalog: z.array(toolSpecSchema).min(1),
  connectors: z.array(connectorSchema).min(1),
});

export type GatewayServerConfig = z.infer<typeof gatewayServerConfigSchema>;

/** A config with file references resolved: PEM strings in memory, policy parsed. */
export interface ResolvedGatewayServerConfig {
  host?: string;
  port?: number;
  path?: string;
  gatewayPublicKeyPem: string;
  gatewayPrivateKeyPem: string;
  policy: Policy;
  policyVersion: string;
  auditPath: string;
  approval?: { timeoutMs: number; requireSecondPerson?: boolean };
  /** Resolved token-exchange config: the IdP public key read to PEM in memory. */
  tokenExchange?: {
    idpPublicKeyPem: string;
    issuer: string;
    audience: string;
    groupsClaim?: string;
    tokenPath?: string;
    ttlMs?: number;
  };
  /** Credential broker selection (pass-through; no file refs to resolve). */
  broker?: GatewayServerConfig["broker"];
  catalog: GatewayServerConfig["catalog"];
  connectors: GatewayServerConfig["connectors"];
}

/** Parse + resolve a gateway config file (keys read to PEM, policy parsed, paths absolute). */
export function loadGatewayServerConfig(configPath: string): ResolvedGatewayServerConfig {
  const abs = resolve(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`gateway config '${configPath}' is not valid JSON: ${(e as Error).message}`);
  }
  const cfg = gatewayServerConfigSchema.parse(raw);
  const baseDir = dirname(abs);

  const gatewayPublicKeyPem = readFileSync(resolve(baseDir, cfg.keys.publicKey), "utf8");
  const gatewayPrivateKeyPem = readFileSync(resolve(baseDir, cfg.keys.privateKey), "utf8");
  const policyRaw = typeof cfg.policy === "string" ? JSON.parse(readFileSync(resolve(baseDir, cfg.policy), "utf8")) : cfg.policy;
  const policy = parsePolicy(policyRaw);

  const tokenExchange = cfg.tokenExchange
    ? {
        idpPublicKeyPem: readFileSync(resolve(baseDir, cfg.tokenExchange.idpPublicKey), "utf8"),
        issuer: cfg.tokenExchange.issuer,
        audience: cfg.tokenExchange.audience,
        ...(cfg.tokenExchange.groupsClaim ? { groupsClaim: cfg.tokenExchange.groupsClaim } : {}),
        ...(cfg.tokenExchange.tokenPath ? { tokenPath: cfg.tokenExchange.tokenPath } : {}),
        ...(cfg.tokenExchange.ttlMs ? { ttlMs: cfg.tokenExchange.ttlMs } : {}),
      }
    : undefined;

  return {
    ...(cfg.host !== undefined ? { host: cfg.host } : {}),
    ...(cfg.port !== undefined ? { port: cfg.port } : {}),
    ...(cfg.path !== undefined ? { path: cfg.path } : {}),
    gatewayPublicKeyPem,
    gatewayPrivateKeyPem,
    policy,
    policyVersion: cfg.policyVersion,
    auditPath: resolve(baseDir, cfg.auditPath),
    ...(cfg.approval ? { approval: cfg.approval } : {}),
    ...(tokenExchange ? { tokenExchange } : {}),
    ...(cfg.broker ? { broker: cfg.broker } : {}),
    catalog: cfg.catalog,
    connectors: cfg.connectors,
  };
}

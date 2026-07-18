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
   * exchanges an IdP subject token for a DPoP-bound gateway token. Configure the
   * IdP key ONE of two ways (exactly one required):
   *  - `idpPublicKey`: a PEM file path to the IdP's single Ed25519 public key
   *    (the static-key verifier — a mature, offline shape); OR
   *  - `jwksUri`: the IdP's JWKS endpoint, from which RS256/ES256 signing keys are
   *    fetched and selected by `kid` (works with real OIDC IdPs — Okta/Entra/
   *    Auth0/Google). `algorithms` optionally narrows the accepted set.
   * Either way the subject token is validated (sig + iss/aud/exp) before minting.
   * Omit the whole block for the dev path where tokens are minted out of band.
   */
  tokenExchange: z
    .object({
      /** PEM file path (relative to the config) of the IdP's Ed25519 public key. */
      idpPublicKey: z.string().min(1).optional(),
      /** The IdP's JWKS endpoint (https; loopback http allowed for dev). */
      jwksUri: z.string().min(1).optional(),
      /** Accepted JWKS signature algorithms (allowlist). Default RS256 + ES256. */
      algorithms: z.array(z.enum(["RS256", "ES256"])).min(1).optional(),
      issuer: z.string().min(1),
      audience: z.string().min(1),
      groupsClaim: z.string().min(1).optional(),
      tokenPath: z.string().min(1).optional(),
      ttlMs: z.number().int().positive().optional(),
    })
    .refine((tx) => (tx.idpPublicKey === undefined) !== (tx.jwksUri === undefined), {
      message: "tokenExchange requires exactly one of 'idpPublicKey' (static key) or 'jwksUri' (JWKS) — not both, not neither",
    })
    .refine(
      (tx) => {
        if (tx.jwksUri === undefined) return true;
        try {
          const u = new URL(tx.jwksUri);
          const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "[::1]";
          return u.protocol === "https:" || (u.protocol === "http:" && loopback);
        } catch {
          return false;
        }
      },
      {
        message:
          "tokenExchange.jwksUri must be a valid https URL (loopback http allowed for dev) — the IdP signing keys must not be fetched over cleartext http",
      },
    )
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
  /**
   * Out-of-process connector sandbox (deploy hardening §5). When present, each
   * connector's `call()` runs in a warm per-(principal, connector) worker
   * process. `registryModule` (a path, default the built-in first-party
   * registry) is the module the worker imports for its `factories`; `execArgv`
   * are the Node flags for the fork (default strips TS so a `.ts` worker runs).
   */
  sandbox: z
    .object({
      kind: z.literal("child-process"),
      registryModule: z.string().min(1).optional(),
      execArgv: z.array(z.string()).optional(),
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
  /**
   * Resolved token-exchange config. Exactly one IdP-key variant is present: the
   * static-key variant carries `idpPublicKeyPem` (read to PEM in memory); the
   * JWKS variant carries `jwksUri` (+ optional `algorithms`).
   */
  tokenExchange?: {
    issuer: string;
    audience: string;
    groupsClaim?: string;
    tokenPath?: string;
    ttlMs?: number;
  } & ({ idpPublicKeyPem: string } | { jwksUri: string; algorithms?: ("RS256" | "ES256")[] });
  /** Credential broker selection (pass-through; no file refs to resolve). */
  broker?: GatewayServerConfig["broker"];
  /** Sandbox selection; `registryModule` resolved to an absolute path. */
  sandbox?: { kind: "child-process"; registryModule?: string; execArgv?: string[] };
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
        issuer: cfg.tokenExchange.issuer,
        audience: cfg.tokenExchange.audience,
        ...(cfg.tokenExchange.groupsClaim ? { groupsClaim: cfg.tokenExchange.groupsClaim } : {}),
        ...(cfg.tokenExchange.tokenPath ? { tokenPath: cfg.tokenExchange.tokenPath } : {}),
        ...(cfg.tokenExchange.ttlMs ? { ttlMs: cfg.tokenExchange.ttlMs } : {}),
        // The schema's `.refine` guarantees exactly one key variant is set.
        ...(cfg.tokenExchange.jwksUri
          ? {
              jwksUri: cfg.tokenExchange.jwksUri,
              ...(cfg.tokenExchange.algorithms ? { algorithms: cfg.tokenExchange.algorithms } : {}),
            }
          : { idpPublicKeyPem: readFileSync(resolve(baseDir, cfg.tokenExchange.idpPublicKey as string), "utf8") }),
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
    ...(cfg.sandbox
      ? {
          sandbox: {
            kind: cfg.sandbox.kind,
            ...(cfg.sandbox.registryModule ? { registryModule: resolve(baseDir, cfg.sandbox.registryModule) } : {}),
            ...(cfg.sandbox.execArgv ? { execArgv: cfg.sandbox.execArgv } : {}),
          },
        }
      : {}),
    catalog: cfg.catalog,
    connectors: cfg.connectors,
  };
}

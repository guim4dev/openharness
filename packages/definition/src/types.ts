import type { Policy } from "@openharness/policy";

export interface HarnessSkillRef { path: string; mandatory: boolean }
export interface HarnessProviderConfig { provider: string; model: string; credentialProfile: string }
export interface HarnessBranding { displayName: string; icon?: string; accent?: string }

export type McpTransport = "stdio" | "http";

/**
 * One MCP server the harness wires in. `transport` selects the connection:
 * - "stdio": launch `command` (+ `args`, `env`) as a child process and speak MCP over its stdio.
 * - "http":  connect to `url` over streamable HTTP (with optional `headers`).
 * `tools` is an optional per-server allowlist of MCP tool names to expose.
 * `mandatory` servers fail the harness fast when they cannot connect; others are logged and skipped.
 *
 * `secrets` is credential INDIRECTION and is the ONLY place a server's real
 * secret (DB password, API token) participates — by REFERENCE, never by value:
 * - stdio: maps an ENV VAR name -> a credential ref name; at connect the ref is
 *   resolved from the machine-local SecretStore and merged into the child env
 *   (over literal `env`).
 * - http:  maps a HEADER name -> a credential ref name; resolved the same way and
 *   set on the HTTP client's request headers (this is the http auth field).
 * The ref name is all that lives in harness.json / the signed bundle — mirroring
 * how providers reference a `credentialProfile` by name, never the key itself.
 */
export interface McpServerSpec {
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** Literal (non-secret) HTTP request headers for the http transport. */
  headers?: Record<string, string>;
  /** ENV VAR name (stdio) or HEADER name (http) -> credential REF name. Never a value. */
  secrets?: Record<string, string>;
  mandatory?: boolean;
  tools?: string[];
}

export interface HarnessMcpConfig {
  servers: Record<string, McpServerSpec>;
}

export interface HarnessManifest {
  name: string;
  version: string;
  branding: HarnessBranding;
  systemPrompt: string;
  skills: HarnessSkillRef[];
  providers: { default: HarnessProviderConfig } & Record<string, HarnessProviderConfig>;
  /** Optional MCP servers whose tools are bridged into the agent as `mcp__<server>__<tool>`. */
  mcp?: HarnessMcpConfig;
}

/** Resolved definition: all paths absolute, system prompt read into memory. */
export interface HarnessDefinition {
  manifest: HarnessManifest;
  rootDir: string;
  systemPromptText: string;
  skillDirs: { path: string; mandatory: boolean }[];
  iconPath?: string;
  /**
   * Optional access policy loaded from `policy.json` in the definition dir.
   * `undefined` when the file is absent (backward compatible — existing harnesses
   * are unaffected and enforcement is a no-op).
   */
  policy?: Policy;
}

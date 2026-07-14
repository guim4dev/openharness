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
  /**
   * A file path (resolved relative to the definition root, current default
   * behavior) OR a curated-library ref `lib:<name>` resolved against
   * `promptLibrary` — see `resolvePrompt` in `@openharness/prompts`.
   */
  systemPrompt: string;
  /**
   * Optional text appended to the resolved `systemPrompt`, joined by a blank
   * line. Same two forms as `systemPrompt`: a file path or a `lib:<name>` ref.
   * Typically used to layer org-specific detail on top of a shared curated base.
   */
  appendSystemPrompt?: string;
  /**
   * Optional dir path (relative to the definition root) of a curated
   * PromptLibrary — a directory of `.md` files with YAML frontmatter
   * `{ name, description }` that `systemPrompt`/`appendSystemPrompt` can
   * reference via `lib:<name>`. Must live INSIDE the definition dir for
   * `bundleDefinition` to include it (see `@openharness/bundle`).
   */
  promptLibrary?: string;
  skills: HarnessSkillRef[];
  providers: { default: HarnessProviderConfig } & Record<string, HarnessProviderConfig>;
  /** Optional MCP servers whose tools are bridged into the agent as `mcp__<server>__<tool>`. */
  mcp?: HarnessMcpConfig;
  /** Optional remote MCP gateway (v2). See `HarnessGatewayConfig`. */
  gateway?: HarnessGatewayConfig;
}

/**
 * A remote MCP gateway the harness routes governed tools through (v2). The
 * harness connects to `url` (an `@openharness/gateway` MCP server) over HTTP
 * with a DPoP-bound token, PINS the server to `pubkey` (the gateway's ed25519
 * public key, so a hostile network can't present a fake gateway), and exposes
 * `tools` as `mcp__<gateway>__<tool>` — policy-gated locally too (defense in
 * depth). The credential + egress live server-side; the machine never sees them.
 */
export interface HarnessGatewayConfig {
  /** Base URL of the gateway's MCP endpoint. */
  url: string;
  /** The gateway's ed25519 public key (PEM), pinned in the signed definition. */
  pubkey: string;
  /** Tool names the gateway exposes (the pinned catalog the harness may call). */
  tools: string[];
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

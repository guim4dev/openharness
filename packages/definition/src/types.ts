export interface HarnessSkillRef { path: string; mandatory: boolean }
export interface HarnessProviderConfig { provider: string; model: string; credentialProfile: string }
export interface HarnessBranding { displayName: string; icon?: string; accent?: string }

export type McpTransport = "stdio" | "http";

/**
 * One MCP server the harness wires in. `transport` selects the connection:
 * - "stdio": launch `command` (+ `args`, `env`) as a child process and speak MCP over its stdio.
 * - "http":  connect to `url` over streamable HTTP.
 * `tools` is an optional per-server allowlist of MCP tool names to expose.
 * `mandatory` servers fail the harness fast when they cannot connect; others are logged and skipped.
 */
export interface McpServerSpec {
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
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
}

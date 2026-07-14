# @openharness/mcp

Connects MCP servers and bridges their tools into Pi tools for OpenHarness.

Given a `HarnessDefinition`, it connects every declared MCP server (stdio or
streamable-HTTP), enumerates each server's tools, and wraps them as Pi
`ToolDefinition`s named `mcp__<server>__<tool>`. Mandatory servers fail fast;
server `secrets` are resolved by reference at connect time and any ref in the
reserved `api-key:` LLM-credential namespace is hard-rejected (fail-closed).
Depends on `@openharness/definition` and the Pi SDK; consumed by `@openharness/core`.

## API

- `loadMcpTools(definition, options?) -> Promise<LoadMcpToolsResult>` — connect all servers on a harness, bridge their tools, return `{ tools, dispose }`; a mandatory server that fails throws `McpConnectionError`.
- `connectMcpServer(name, spec, resolveSecret?) -> Promise<McpConnection>` — connect one server (default `ConnectFn`); resolves `secrets`, rejecting `api-key:` refs.
- `mcpToolToPiTool(server, tool, callTool) -> ToolDefinition` — bridge one MCP tool; `mcpToolName(server, tool) -> string` builds the `mcp__…` name.
- `McpConnectionError`, plus types `McpConnection`, `McpCallTool`, `McpToolInfo`, `McpCallToolResult`, `McpContentBlock`, `ConnectFn`, `SecretResolver`, `LoadMcpToolsOptions`, `LoadMcpToolsResult`.

## Usage

```ts
import { loadMcpTools } from "@openharness/mcp";
import { EncryptedFileSecretStore } from "@openharness/credentials";

const store = await EncryptedFileSecretStore.open("~/.openharness/acme");
const { tools, dispose } = await loadMcpTools(definition, {
  resolveSecret: store.get.bind(store), // fail-closed on unresolved / api-key: refs
});

console.log(tools.map((t) => t.name)); // ["mcp__github__create_issue", ...]

await dispose(); // closes every open connection
```

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.

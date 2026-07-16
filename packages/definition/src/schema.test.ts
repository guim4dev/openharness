import { expect, test } from "vitest";
import { harnessManifestSchema } from "./schema.ts";

const valid = {
  name: "example",
  version: "0.1.0",
  branding: { displayName: "Acme Assistant", icon: "branding/icon.png", accent: "#4F46E5" },
  systemPrompt: "system-prompt.md",
  skills: [{ path: "skills/triage", mandatory: true }],
  providers: { default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" } },
};

test("accepts a valid manifest", () => {
  const parsed = harnessManifestSchema.parse(valid);
  expect(parsed.name).toBe("example");
  expect(parsed.providers.default.credentialProfile).toBe("work");
});

test("rejects a missing required provider profile", () => {
  const bad = { ...valid, providers: {} };
  expect(() => harnessManifestSchema.parse(bad)).toThrow(/default/);
});

test("rejects a bad accent color", () => {
  const bad = { ...valid, branding: { ...valid.branding, accent: "not-a-hex" } };
  expect(() => harnessManifestSchema.parse(bad)).toThrow();
});

test("accepts an optional mcp section with stdio and http servers", () => {
  const withMcp = {
    ...valid,
    mcp: {
      servers: {
        local: { transport: "stdio", command: "my-mcp", args: ["--flag"], env: { TOKEN: "x" }, tools: ["echo"] },
        remote: { transport: "http", url: "https://mcp.example.com", mandatory: true },
      },
    },
  };
  const parsed = harnessManifestSchema.parse(withMcp);
  expect(parsed.mcp?.servers.local.transport).toBe("stdio");
  expect(parsed.mcp?.servers.local.tools).toEqual(["echo"]);
  expect(parsed.mcp?.servers.remote.url).toBe("https://mcp.example.com");
  expect(parsed.mcp?.servers.remote.mandatory).toBe(true);
});

test("accepts `secrets` (env/header -> credential ref) and http `headers` maps", () => {
  const withSecrets = {
    ...valid,
    mcp: {
      servers: {
        analytics: {
          transport: "stdio",
          command: "mcp-postgres",
          args: ["postgresql://ro@db/analytics"],
          // ENV VAR name -> credential REF name (never the value).
          secrets: { PGPASSWORD: "acme-analytics-ro" },
        },
        remote: {
          transport: "http",
          url: "https://mcp.example.com",
          headers: { "X-Static": "v" },
          // HEADER name -> credential REF name (never the value).
          secrets: { "X-Api-Key": "acme-http-token" },
        },
      },
    },
  };
  const parsed = harnessManifestSchema.parse(withSecrets);
  expect(parsed.mcp?.servers.analytics.secrets).toEqual({ PGPASSWORD: "acme-analytics-ro" });
  expect(parsed.mcp?.servers.remote.headers).toEqual({ "X-Static": "v" });
  expect(parsed.mcp?.servers.remote.secrets).toEqual({ "X-Api-Key": "acme-http-token" });
});

test("a manifest with no mcp section stays valid (backward compatible)", () => {
  const parsed = harnessManifestSchema.parse(valid);
  expect(parsed.mcp).toBeUndefined();
});

test("accepts an optional remote MCP gateway (url + pinned pubkey + tools)", () => {
  const withGateway = {
    ...valid,
    gateway: { url: "https://gw.acme.internal/mcp", pubkey: "-----BEGIN PUBLIC KEY-----\n…", tools: ["github__list_issues"] },
  };
  const parsed = harnessManifestSchema.parse(withGateway);
  expect(parsed.gateway?.url).toBe("https://gw.acme.internal/mcp");
  expect(parsed.gateway?.tools).toEqual(["github__list_issues"]);
  // Absent by default (backward compatible).
  expect(harnessManifestSchema.parse(valid).gateway).toBeUndefined();
});

test("rejects a gateway missing url or pubkey", () => {
  expect(() => harnessManifestSchema.parse({ ...valid, gateway: { tools: [] } })).toThrow();
  expect(() =>
    harnessManifestSchema.parse({ ...valid, gateway: { url: "https://x", tools: [] } }),
  ).toThrow();
});

test("rejects an mcp server NAME containing '__' but allows a single underscore", () => {
  // `__` would break the injective `mcp__<server>__<tool>` bridged-name mapping.
  const bad = { ...valid, mcp: { servers: { "a__b": { transport: "stdio", command: "x" } } } };
  expect(() => harnessManifestSchema.parse(bad)).toThrow(/__|server name/i);
  // A single underscore (e.g. `back_office`) is fine.
  const ok = { ...valid, mcp: { servers: { back_office: { transport: "stdio", command: "x" } } } };
  expect(harnessManifestSchema.parse(ok).mcp?.servers.back_office.command).toBe("x");
});

test("rejects an stdio server missing command", () => {
  const bad = { ...valid, mcp: { servers: { local: { transport: "stdio" } } } };
  expect(() => harnessManifestSchema.parse(bad)).toThrow(/command/);
});

test("rejects an http server missing url", () => {
  const bad = { ...valid, mcp: { servers: { remote: { transport: "http" } } } };
  expect(() => harnessManifestSchema.parse(bad)).toThrow(/url/);
});

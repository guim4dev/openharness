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

test("a manifest with no mcp section stays valid (backward compatible)", () => {
  const parsed = harnessManifestSchema.parse(valid);
  expect(parsed.mcp).toBeUndefined();
});

test("rejects an stdio server missing command", () => {
  const bad = { ...valid, mcp: { servers: { local: { transport: "stdio" } } } };
  expect(() => harnessManifestSchema.parse(bad)).toThrow(/command/);
});

test("rejects an http server missing url", () => {
  const bad = { ...valid, mcp: { servers: { remote: { transport: "http" } } } };
  expect(() => harnessManifestSchema.parse(bad)).toThrow(/url/);
});

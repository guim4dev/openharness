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

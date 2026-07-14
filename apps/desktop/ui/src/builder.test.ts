// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  builderReducer,
  draftFromManifest,
  draftIsValid,
  draftToManifest,
  draftToPolicy,
  emptyDraft,
  useBuilder,
  validateDraft,
  type BuilderAction,
  type BuilderDraft,
} from "./builder.ts";

/** Fold a sequence of edits through the pure reducer. */
function edit(draft: BuilderDraft, ...actions: BuilderAction[]): BuilderDraft {
  return actions.reduce(builderReducer, draft);
}

const filled: BuilderDraft = {
  name: "acme-assistant",
  displayName: "Acme Assistant",
  accent: "#4F46E5",
  systemPrompt: "You are Acme's governed assistant.",
  provider: "anthropic",
  model: "claude-sonnet-5",
  credentialProfile: "work",
  policyDefault: "deny",
  rules: [{ match: "mcp__github__*", action: "ask" }],
  skills: [{ path: "skills/triage", mandatory: true }],
  mcpServers: [{ name: "github", transport: "stdio", command: "npx", url: "", tools: "list_issues, create_issue" }],
};

describe("builderReducer", () => {
  test("setField updates a scalar", () => {
    const d = edit(emptyDraft, { type: "setField", field: "displayName", value: "Acme" });
    expect(d.displayName).toBe("Acme");
    expect(emptyDraft.displayName).toBe(""); // pure — original untouched
  });

  test("add / update / remove rules", () => {
    const withRule = edit(emptyDraft, { type: "addRule" });
    expect(withRule.rules).toHaveLength(1);
    const set = edit(withRule, { type: "updateRule", index: 0, patch: { match: "bash", action: "deny" } });
    expect(set.rules[0]).toEqual({ match: "bash", action: "deny" });
    const removed = edit(set, { type: "removeRule", index: 0 });
    expect(removed.rules).toHaveLength(0);
  });

  test("load replaces the whole draft", () => {
    const d = edit(emptyDraft, { type: "load", draft: filled });
    expect(d.name).toBe("acme-assistant");
    expect(d.rules).toHaveLength(1);
  });
});

describe("serialization", () => {
  test("draftToManifest produces a schema-shaped harness.json", () => {
    const m = draftToManifest(filled) as {
      name: string;
      branding: { displayName: string; accent: string };
      systemPrompt: string;
      providers: { default: { provider: string; model: string; credentialProfile: string } };
    };
    expect(m.name).toBe("acme-assistant");
    expect(m.branding).toEqual({ displayName: "Acme Assistant", accent: "#4F46E5" });
    expect(m.systemPrompt).toBe("system-prompt.md"); // prompt text lives in the sibling file
    expect(m.providers.default.credentialProfile).toBe("work");
  });

  test("draftToPolicy produces a policy.json object", () => {
    expect(draftToPolicy(filled)).toEqual({ default: "deny", rules: [{ match: "mcp__github__*", action: "ask" }] });
  });

  test("serializes skills and MCP servers (tools CSV -> array; empty tools omitted)", () => {
    const m = draftToManifest(filled) as {
      skills: { path: string; mandatory: boolean }[];
      mcp: { servers: Record<string, { transport: string; command?: string; tools?: string[] }> };
    };
    expect(m.skills).toEqual([{ path: "skills/triage", mandatory: true }]);
    expect(m.mcp.servers.github.transport).toBe("stdio");
    expect(m.mcp.servers.github.command).toBe("npx");
    expect(m.mcp.servers.github.tools).toEqual(["list_issues", "create_issue"]);
  });

  test("omits the mcp section entirely when no servers are declared", () => {
    const m = draftToManifest({ ...filled, mcpServers: [] }) as Record<string, unknown>;
    expect(m.mcp).toBeUndefined();
  });

  test("an http MCP server serializes url (not command)", () => {
    const draft: BuilderDraft = {
      ...filled,
      mcpServers: [{ name: "remote", transport: "http", command: "", url: "https://mcp.acme.internal", tools: "" }],
    };
    const m = draftToManifest(draft) as { mcp: { servers: Record<string, { url?: string; command?: string; tools?: string[] }> } };
    expect(m.mcp.servers.remote.url).toBe("https://mcp.acme.internal");
    expect(m.mcp.servers.remote.command).toBeUndefined();
    expect(m.mcp.servers.remote.tools).toBeUndefined(); // empty allowlist omitted
  });

  test("round-trips the edited fields: manifest -> draft -> manifest", () => {
    const manifest = draftToManifest(filled);
    const policy = draftToPolicy(filled);
    const back = draftFromManifest(manifest, policy, filled.systemPrompt);
    expect(draftToManifest(back)).toEqual(manifest);
    expect(draftToPolicy(back)).toEqual(policy);
    // The edited fields survived (carry is an internal passthrough, not compared).
    const { carry: _c, ...editable } = back;
    expect(editable).toEqual(filled);
  });

  test("preserves un-edited manifest fields (gateway pin, version, extra providers) across a round-trip", () => {
    const rich = {
      name: "acme-assistant",
      version: "3.2.1",
      branding: { displayName: "Acme", accent: "#4F46E5", icon: "branding/logo.png" },
      systemPrompt: "system-prompt.md",
      appendSystemPrompt: "lib:acme-base",
      promptLibrary: "prompts",
      skills: [],
      providers: {
        default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" },
        fast: { provider: "anthropic", model: "claude-haiku-4-5", credentialProfile: "work" },
      },
      gateway: { url: "https://gw.acme.internal/mcp", pubkey: "PINNED_PUBKEY_PEM", tools: ["github__list_issues"] },
    };
    const back = draftFromManifest(rich, { default: "deny", rules: [] }, "prompt text");
    const out = draftToManifest(back);
    // The gateway pin — the whole fake-gateway defense — must survive.
    expect(out.gateway).toEqual(rich.gateway);
    expect(out.version).toBe("3.2.1");
    expect(out.appendSystemPrompt).toBe("lib:acme-base");
    expect(out.promptLibrary).toBe("prompts");
    expect((out.branding as { icon?: string }).icon).toBe("branding/logo.png");
    expect((out.providers as { fast?: unknown }).fast).toEqual(rich.providers.fast);
  });
});

describe("validateDraft", () => {
  test("a fully-filled draft is valid", () => {
    expect(validateDraft(filled)).toEqual([]);
    expect(draftIsValid(filled)).toBe(true);
  });

  test("flags required fields, a bad slug, and a bad accent", () => {
    const bad: BuilderDraft = { ...emptyDraft, name: "Acme Assistant", accent: "blue" };
    const fields = validateDraft(bad).map((p) => p.field);
    expect(fields).toContain("name"); // uppercase + space -> bad slug
    expect(fields).toContain("displayName"); // empty
    expect(fields).toContain("accent"); // not hex
    expect(fields).toContain("systemPrompt"); // empty
  });

  test("flags a rule with no match pattern", () => {
    const d: BuilderDraft = { ...filled, rules: [{ match: "", action: "deny" }] };
    expect(validateDraft(d).some((p) => p.field === "rules.0.match")).toBe(true);
  });

  test("flags a MALFORMED parameterized match that parsePolicy would reject", () => {
    // `bash(x` (unbalanced) is valid-looking to a naive non-empty check but is
    // rejected by parsePolicy inside doctor — the builder must not call it valid.
    for (const bad of ["bash(x", "bash(x))", "(x)"]) {
      const d: BuilderDraft = { ...filled, rules: [{ match: bad, action: "deny" }] };
      expect(validateDraft(d).some((p) => p.field === "rules.0.match" && /malformed/.test(p.message)), bad).toBe(true);
    }
    // A well-formed parameterized match is fine.
    const good: BuilderDraft = { ...filled, rules: [{ match: "bash(*rm*)", action: "deny" }] };
    expect(validateDraft(good).some((p) => p.field === "rules.0.match")).toBe(false);
  });

  test("flags a skill with no path", () => {
    const d: BuilderDraft = { ...filled, skills: [{ path: "", mandatory: true }] };
    expect(validateDraft(d).some((p) => p.field === "skills.0.path")).toBe(true);
  });

  test("flags an MCP server missing its transport-required field, and a duplicate name", () => {
    const stdioNoCmd: BuilderDraft = {
      ...filled,
      mcpServers: [{ name: "x", transport: "stdio", command: "", url: "", tools: "" }],
    };
    expect(validateDraft(stdioNoCmd).some((p) => p.field === "mcp.0.command")).toBe(true);

    const httpNoUrl: BuilderDraft = {
      ...filled,
      mcpServers: [{ name: "y", transport: "http", command: "", url: "", tools: "" }],
    };
    expect(validateDraft(httpNoUrl).some((p) => p.field === "mcp.0.url")).toBe(true);

    const dupes: BuilderDraft = {
      ...filled,
      mcpServers: [
        { name: "dup", transport: "stdio", command: "npx", url: "", tools: "" },
        { name: "dup", transport: "stdio", command: "npx", url: "", tools: "" },
      ],
    };
    expect(validateDraft(dupes).some((p) => /duplicated/.test(p.message))).toBe(true);
  });

  test("mirrors doctor's deny-default-with-no-allow trap", () => {
    const d: BuilderDraft = { ...filled, policyDefault: "deny", rules: [{ match: "bash", action: "deny" }] };
    expect(validateDraft(d).some((p) => /can run no tools/.test(p.message))).toBe(true);
  });
});

describe("useBuilder", () => {
  test("edits update the live draft, validation, and serialized outputs", () => {
    const { result } = renderHook(() => useBuilder());
    // Empty draft starts invalid (required fields missing).
    expect(result.current.valid).toBe(false);

    act(() => {
      result.current.setField("name", "acme-assistant");
      result.current.setField("displayName", "Acme Assistant");
      result.current.setField("systemPrompt", "You are governed.");
    });
    expect((result.current.manifest as { name: string }).name).toBe("acme-assistant");
    expect(result.current.valid).toBe(true);
    expect(result.current.problems).toEqual([]);
  });

  test("rule editing flows through and reflects in the live policy", () => {
    const { result } = renderHook(() => useBuilder());
    act(() => result.current.addRule());
    act(() => result.current.updateRule(0, { match: "mcp__github__*", action: "ask" }));
    expect((result.current.policy as { rules: unknown[] }).rules).toEqual([{ match: "mcp__github__*", action: "ask" }]);
    act(() => result.current.removeRule(0));
    expect((result.current.policy as { rules: unknown[] }).rules).toEqual([]);
  });
});

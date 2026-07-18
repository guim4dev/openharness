// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  builderReducer,
  draftFromManifest,
  draftIsValid,
  draftToManifest,
  draftToPolicy,
  draftToSkillContents,
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
  skills: [{ path: "skills/triage", mandatory: true, content: "# Triage\n\nHow the agent triages an incoming report.\n" }],
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

  test("add / update / remove skills (including the SKILL.md body)", () => {
    const withSkill = edit(emptyDraft, { type: "addSkill" });
    expect(withSkill.skills).toHaveLength(1);
    expect(withSkill.skills[0]).toEqual({ path: "", mandatory: true, content: "" });
    const set = edit(
      withSkill,
      { type: "updateSkill", index: 0, patch: { path: "skills/triage", mandatory: false } },
      { type: "updateSkill", index: 0, patch: { content: "# Triage\n\nbody" } },
    );
    expect(set.skills[0]).toEqual({ path: "skills/triage", mandatory: false, content: "# Triage\n\nbody" });
    const removed = edit(set, { type: "removeSkill", index: 0 });
    expect(removed.skills).toHaveLength(0);
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
    // Skill bodies travel alongside the manifest (they live in <path>/SKILL.md,
    // not harness.json), so a faithful round-trip must feed them back in.
    const back = draftFromManifest(manifest, policy, filled.systemPrompt, draftToSkillContents(filled));
    expect(draftToManifest(back)).toEqual(manifest);
    expect(draftToPolicy(back)).toEqual(policy);
    // The edited fields survived (carry is an internal passthrough, not compared).
    const { carry: _c, ...editable } = back;
    expect(editable).toEqual(filled);
  });

  test("draftFromManifest folds each declared skill's SKILL.md body back in (by path)", () => {
    const manifest = draftToManifest(filled);
    const body = "# Triage\n\nHow the agent triages an incoming report.\n";
    const back = draftFromManifest(manifest, undefined, "prompt text", [{ path: "skills/triage", content: body }]);
    expect(back.skills).toEqual([{ path: "skills/triage", mandatory: true, content: body }]);
    // A declared skill with no matching content entry loads with an empty body.
    const orphan = draftFromManifest(manifest, undefined, "prompt text");
    expect(orphan.skills[0].content).toBe("");
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

describe("confirmed-bug regressions", () => {
  // #1 — round-trip loss: env/secrets/args/headers/mandatory were dropped by the
  // builder<->manifest mapping (builder.ts serialize + draftFromManifest).
  test("round-trips ALL MCP server fields (env, secrets, args, headers, mandatory) without loss", () => {
    const draft: BuilderDraft = {
      ...filled,
      mcpServers: [
        {
          name: "github",
          transport: "stdio",
          command: "npx",
          url: "",
          tools: "list_issues, create_issue",
          carry: {
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_HOST: "github.com" },
            secrets: { GITHUB_TOKEN: "github-pat" },
            headers: { "X-Trace": "on" },
            mandatory: true,
          },
        },
      ],
    };
    const manifest = draftToManifest(draft);
    const servers = (manifest.mcp as { servers: Record<string, Record<string, unknown>> }).servers;
    // A direct serialize keeps every field the schema allows.
    expect(servers.github).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_HOST: "github.com" },
      secrets: { GITHUB_TOKEN: "github-pat" },
      headers: { "X-Trace": "on" },
      mandatory: true,
      tools: ["list_issues", "create_issue"],
    });
    // Full round-trip: manifest -> draft -> manifest drops nothing.
    const back = draftFromManifest(manifest, draftToPolicy(draft), draft.systemPrompt, draftToSkillContents(draft));
    expect(draftToManifest(back)).toEqual(manifest);
  });

  // #2 — validation gap: a name with `__` produced a harness.json the schema rejects
  // while the builder reported VALID.
  test("flags an MCP server name containing '__' (which the manifest schema rejects)", () => {
    const d: BuilderDraft = {
      ...filled,
      mcpServers: [{ name: "a__b", transport: "stdio", command: "npx", url: "", tools: "" }],
    };
    expect(validateDraft(d).some((p) => p.field === "mcp.0.name" && /__/.test(p.message))).toBe(true);
    expect(draftIsValid(d)).toBe(false);
  });

  // #3 — prototype assignment: a `__proto__` server was swallowed by the prototype
  // instead of becoming a manifest key.
  test("an MCP server named '__proto__' is a validation error and never silently vanishes", () => {
    const d: BuilderDraft = {
      ...filled,
      mcpServers: [{ name: "__proto__", transport: "stdio", command: "npx", url: "", tools: "" }],
    };
    // (a) It is a validation error...
    expect(draftIsValid(d)).toBe(false);
    // (b) ...and even when serialized it appears as a real own key — the prototype
    // is not polluted, so the server does not vanish.
    const servers = (draftToManifest(d).mcp as { servers: Record<string, unknown> }).servers;
    expect(Object.prototype.hasOwnProperty.call(servers, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(servers)).toBe(null);
  });

  // #4 — duplicate skill paths silently collapse to one SKILL.md, losing a body.
  test("flags two skills sharing the same path (they would collapse to one SKILL.md)", () => {
    const d: BuilderDraft = {
      ...filled,
      skills: [
        { path: "skills/triage", mandatory: true, content: "# A\n" },
        { path: "skills/triage", mandatory: false, content: "# B\n" },
      ],
    };
    expect(validateDraft(d).some((p) => p.field === "skills.1.path" && /duplicated/.test(p.message))).toBe(true);
    expect(draftIsValid(d)).toBe(false);
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
    const d: BuilderDraft = { ...filled, skills: [{ path: "", mandatory: true, content: "" }] };
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

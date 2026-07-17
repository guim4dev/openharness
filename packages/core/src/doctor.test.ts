import { afterAll, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./doctor.ts";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const tmps: string[] = [];

afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

type Manifest = Record<string, unknown>;

/** Write a minimal definition dir (harness.json + system-prompt.md + optional policy.json). */
function writeDef(manifest: Manifest, policy?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "oh-doctor-"));
  tmps.push(dir);
  writeFileSync(join(dir, "harness.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "system-prompt.md"), "You are a test harness.\n");
  if (policy !== undefined) writeFileSync(join(dir, "policy.json"), JSON.stringify(policy, null, 2));
  return dir;
}

function baseManifest(over: Manifest = {}): Manifest {
  return {
    name: "doc-test",
    version: "0.1.0",
    branding: { displayName: "Doc Test" },
    systemPrompt: "system-prompt.md",
    skills: [],
    providers: { default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" } },
    ...over,
  };
}

function codes(problems: { code: string }[]): string[] {
  return problems.map((p) => p.code);
}

test("a clean example harness passes with no error-level problems", async () => {
  const report = await runDoctor(join(repoRoot, "harnesses", "meridian-support"));
  expect(report.ok).toBe(true);
  expect(report.problems.filter((p) => p.level === "error")).toHaveLength(0);
  expect(report.defName).toBe("meridian-support@0.1.0");
});

test("a dir with no harness.json fails loud as load-failed (ok=false)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oh-doctor-empty-"));
  tmps.push(dir);
  const report = await runDoctor(dir);
  expect(report.ok).toBe(false);
  expect(codes(report.problems)).toContain("load-failed");
});

test("a model denied by the harness's OWN policy is an error", async () => {
  const dir = writeDef(baseManifest(), {
    default: "allow",
    rules: [],
    models: { allow: ["openai/gpt-5*"] }, // default is anthropic/claude-sonnet-5 -> denied
  });
  const report = await runDoctor(dir);
  expect(report.ok).toBe(false);
  expect(codes(report.problems)).toContain("model-denied-by-own-policy");
});

test("default-deny with no allow/ask rule is a warning, not an error", async () => {
  const dir = writeDef(baseManifest(), { default: "deny", rules: [] });
  const report = await runDoctor(dir);
  expect(codes(report.problems)).toContain("deny-all");
  expect(report.ok).toBe(true); // warning only
});

test("default-deny with only ask rules does NOT warn deny-all (ask tools run on approval)", async () => {
  const dir = writeDef(baseManifest(), { default: "deny", rules: [{ match: "read", action: "ask" }] });
  const report = await runDoctor(dir);
  expect(codes(report.problems)).not.toContain("deny-all");
  expect(report.ok).toBe(true);
});

test("a non-default provider profile denied by policy is a WARNING (not a build-blocking error)", async () => {
  const dir = writeDef(
    baseManifest({
      providers: {
        default: { provider: "anthropic", model: "claude-sonnet-5", credentialProfile: "work" },
        cheap: { provider: "openai", model: "gpt-5-mini", credentialProfile: "batch" },
      },
    }),
    { default: "allow", rules: [], models: { allow: ["anthropic/claude-*"] } },
  );
  const report = await runDoctor(dir);
  expect(codes(report.problems)).toContain("model-denied-by-own-policy");
  expect(report.ok).toBe(true); // non-default → warn, so ok stays true
});

test("a referenced branding.icon that does not exist is an error", async () => {
  const dir = writeDef(baseManifest({ branding: { displayName: "Doc Test", icon: "branding/icon.png" } }));
  const report = await runDoctor(dir);
  expect(report.ok).toBe(false);
  expect(codes(report.problems)).toContain("icon-missing");
});

test("an MCP secret ref in the reserved api-key: namespace is an error", async () => {
  const dir = writeDef(
    baseManifest({
      mcp: {
        servers: {
          backoffice: { transport: "http", url: "https://x.internal", secrets: { Authorization: "api-key:my-anthropic" } },
        },
      },
    }),
  );
  const report = await runDoctor(dir);
  expect(report.ok).toBe(false);
  expect(codes(report.problems)).toContain("mcp-secret-reserved-namespace");
});

test("a mandatory MCP server with every declared tool denied is a warning", async () => {
  const dir = writeDef(
    baseManifest({
      mcp: {
        servers: {
          db: { transport: "stdio", command: "npx", args: ["-y", "srv"], mandatory: true, tools: ["write_query"] },
        },
      },
    }),
    { default: "allow", rules: [{ match: "mcp__db__write_query", action: "deny" }] },
  );
  const report = await runDoctor(dir);
  expect(codes(report.problems)).toContain("mandatory-mcp-all-denied");
});

test("an unpinned npx MCP server is a supply-chain warning; a pinned one is not", async () => {
  const unpinned = writeDef(
    baseManifest({
      mcp: {
        servers: {
          fs: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/docs"],
          },
        },
      },
    }),
  );
  const rUnpinned = await runDoctor(unpinned);
  expect(codes(rUnpinned.problems)).toContain("mcp-server-unpinned");
  expect(rUnpinned.ok).toBe(true); // warning only

  const pinned = writeDef(
    baseManifest({
      mcp: {
        servers: {
          fs: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem@2025.9.0", "/docs"],
          },
        },
      },
    }),
  );
  expect(codes((await runDoctor(pinned)).problems)).not.toContain("mcp-server-unpinned");
});

test("the unpinned check treats dist-tags and ranges as unpinned, concrete versions as pinned", async () => {
  const mk = (pkg: string) =>
    writeDef(
      baseManifest({
        mcp: {
          servers: { s: { transport: "stdio", command: "npx", args: ["-y", pkg] } },
        },
      }),
    );
  const warns = async (pkg: string) =>
    codes((await runDoctor(mk(pkg))).problems).includes("mcp-server-unpinned");

  // Moving targets — must warn.
  for (const moving of [
    "@scope/srv@latest",
    "@scope/srv@next",
    "@scope/srv@^1.0.0",
    "@scope/srv@~2.0.0",
    "@scope/srv@1.x",
    "@scope/srv@*",
    "srv@latest",
    "srv", // bare name
  ]) {
    expect(await warns(moving), moving).toBe(true);
  }
  // Concrete pins (incl. prerelease) — must NOT warn.
  for (const pinned of ["@scope/srv@2025.9.0", "@scope/srv@1.2.3", "@scope/srv@1.2.3-beta.1", "srv@0.6.2"]) {
    expect(await warns(pinned), pinned).toBe(false);
  }
  // Not a registry fetch (local path) — not flagged.
  expect(await warns("./local-server.js")).toBe(false);
});

test("the unpinned check spans npm-family, PyPI, and container runners", async () => {
  const mk = (command: string, args: string[]) =>
    writeDef(baseManifest({ mcp: { servers: { s: { transport: "stdio", command, args } } } }));
  const warns = async (command: string, args: string[]) =>
    codes((await runDoctor(mk(command, args))).problems).includes("mcp-server-unpinned");

  // Unpinned across runners — must warn.
  expect(await warns("bunx", ["srv"]), "bunx bare").toBe(true);
  expect(await warns("pnpm", ["dlx", "srv@latest"]), "pnpm dlx latest").toBe(true);
  expect(await warns("yarn", ["dlx", "@scope/srv"]), "yarn dlx bare").toBe(true);
  expect(await warns("uvx", ["mcp-server"]), "uvx bare").toBe(true);
  expect(await warns("uv", ["tool", "run", "mcp-server>=1"]), "uv tool run range").toBe(true);
  expect(await warns("docker", ["run", "-i", "--rm", "org/mcp:latest"]), "docker tag").toBe(true);
  expect(await warns("docker", ["run", "-i", "--rm", "org/mcp:1.2.3"]), "docker version tag (mutable)").toBe(true);

  // Pinned across runners — must NOT warn.
  expect(await warns("bunx", ["srv@1.2.3"]), "bunx pinned").toBe(false);
  expect(await warns("pnpm", ["dlx", "@scope/srv@2.0.0"]), "pnpm dlx pinned").toBe(false);
  expect(await warns("uvx", ["mcp-server==1.2.3"]), "uvx ==version").toBe(false);
  expect(
    await warns("docker", ["run", "-i", "--rm", "org/mcp@sha256:" + "a".repeat(64)]),
    "docker digest",
  ).toBe(false);

  // A decoy digest in an UNRELATED arg (env value) must NOT count as pinned — the
  // image is still the mutable `:latest`, so this must warn.
  expect(
    await warns("docker", ["run", "-e", "EXPECTED=@sha256:" + "a".repeat(64), "--rm", "org/mcp:latest"]),
    "docker decoy digest in env",
  ).toBe(true);
});

test("warns when MCP servers are declared but the policy leaves mcp__* on default-allow", async () => {
  const server = { transport: "stdio" as const, command: "npx", args: ["-y", "srv@1.2.3"], tools: ["do_thing"] };
  // default allow + MCP server + NO mcp__* rule -> ungoverned egress warning.
  const ungoverned = writeDef(baseManifest({ mcp: { servers: { s: server } } }), {
    default: "allow",
    rules: [{ match: "bash", action: "deny" }],
  });
  expect(codes((await runDoctor(ungoverned)).problems)).toContain("mcp-egress-ungoverned");

  // An explicit mcp__* rule governs the egress -> no warning.
  const governed = writeDef(baseManifest({ mcp: { servers: { s: server } } }), {
    default: "allow",
    rules: [{ match: "mcp__s__*", action: "ask" }],
  });
  expect(codes((await runDoctor(governed)).problems)).not.toContain("mcp-egress-ungoverned");

  // deny-by-default already governs MCP -> no warning.
  const denyDefault = writeDef(baseManifest({ mcp: { servers: { s: server } } }), {
    default: "deny",
    rules: [{ match: "mcp__s__do_thing", action: "allow" }],
  });
  expect(codes((await runDoctor(denyDefault)).problems)).not.toContain("mcp-egress-ungoverned");

  // A catch-all rule governs everything incl. MCP -> no warning.
  const catchAll = writeDef(baseManifest({ mcp: { servers: { s: server } } }), {
    default: "allow",
    rules: [{ match: "*", action: "ask" }],
  });
  expect(codes((await runDoctor(catchAll)).problems)).not.toContain("mcp-egress-ungoverned");
});

test("strictSupplyChain escalates an unpinned MCP server from warning to a build-failing error", async () => {
  const dir = writeDef(
    baseManifest({ mcp: { servers: { s: { transport: "stdio", command: "npx", args: ["-y", "srv"] } } } }),
  );
  // Default: a warning, still ok.
  const lenient = await runDoctor(dir);
  expect(lenient.ok).toBe(true);
  expect(lenient.problems.find((p) => p.code === "mcp-server-unpinned")?.level).toBe("warn");
  // Strict: an error, not ok (build would refuse).
  const strict = await runDoctor(dir, { strictSupplyChain: true });
  expect(strict.ok).toBe(false);
  expect(strict.problems.find((p) => p.code === "mcp-server-unpinned")?.level).toBe("error");
  // A pinned server is fine under strict too.
  const pinnedDir = writeDef(
    baseManifest({ mcp: { servers: { s: { transport: "stdio", command: "npx", args: ["-y", "srv@1.2.3"] } } } }),
  );
  expect((await runDoctor(pinnedDir, { strictSupplyChain: true })).ok).toBe(true);
});

test("the unpinned check ignores http servers and non-npx commands", async () => {
  const dir = writeDef(
    baseManifest({
      mcp: {
        servers: {
          remote: { transport: "http", url: "https://x.internal" },
          local: { transport: "stdio", command: "/usr/local/bin/my-server", args: ["--port", "0"] },
        },
      },
    }),
  );
  expect(codes((await runDoctor(dir)).problems)).not.toContain("mcp-server-unpinned");
});

test("a parameterized allow rule suppresses the mandatory-mcp-all-denied false positive", async () => {
  // `read(SELECT*)` allows the tool for real (arg-dependent) queries; judging with
  // empty args would wrongly see "deny" and cry "can do nothing". The param-rule
  // guard must skip the check here.
  const dir = writeDef(
    baseManifest({
      mcp: {
        servers: {
          db: { transport: "stdio", command: "npx", args: ["-y", "srv"], mandatory: true, tools: ["read"] },
        },
      },
    }),
    { default: "deny", rules: [{ match: "mcp__db__read(SELECT*)", action: "allow" }] },
  );
  const report = await runDoctor(dir);
  expect(codes(report.problems)).not.toContain("mandatory-mcp-all-denied");
});

// ── artifact provenance (attestation) ──────────────────────────────────────
import { generateKeyPairSync } from "node:crypto";
import { sha256Hex, signProvenance } from "@openharness/build";

const PROV_TARGET = "@modelcontextprotocol/server-filesystem@2025.9.0";
const PROV_BUILDER = "https://github.com/mcp/servers/.github/workflows/release.yml@refs/tags/v2025.9.0";
const provServer = { transport: "stdio" as const, command: "npx", args: ["-y", PROV_TARGET, "/docs"] };

function provKeypair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function provBundle(privateKeyPem: string, builderId = PROV_BUILDER) {
  const bytes = Buffer.from(`artifact ${PROV_TARGET}`);
  const sha256 = sha256Hex(bytes);
  const envelope = signProvenance(
    {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: PROV_TARGET, digest: { sha256 } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: { runDetails: { builder: { id: builderId } } },
    },
    privateKeyPem,
  );
  return { sha256, envelope };
}

test("a valid provenance for the pinned MCP target passes attestation", async () => {
  const { publicKey, privateKey } = provKeypair();
  const dir = writeDef(baseManifest({ mcp: { servers: { fs: provServer } } }));
  const report = await runDoctor(dir, {
    attestations: {
      trustRoot: { keys: [publicKey], allowedBuilders: [PROV_BUILDER] },
      bundles: { [PROV_TARGET]: provBundle(privateKey) },
    },
  });
  expect(codes(report.problems)).not.toContain("artifact-provenance-failed");
  expect(codes(report.problems)).not.toContain("artifact-provenance-missing");
});

test("a provenance from an unlisted builder is an attestation error", async () => {
  const { publicKey, privateKey } = provKeypair();
  const dir = writeDef(baseManifest({ mcp: { servers: { fs: provServer } } }));
  const report = await runDoctor(dir, {
    attestations: {
      trustRoot: { keys: [publicKey], allowedBuilders: [PROV_BUILDER] },
      bundles: { [PROV_TARGET]: provBundle(privateKey, "https://evil/builder") },
    },
  });
  expect(report.ok).toBe(false);
  expect(codes(report.problems)).toContain("artifact-provenance-failed");
});

test("strict supply chain with NO provenance for a pinned target is an error", async () => {
  const { publicKey } = provKeypair();
  const dir = writeDef(baseManifest({ mcp: { servers: { fs: provServer } } }));
  const report = await runDoctor(dir, {
    strictSupplyChain: true,
    attestations: { trustRoot: { keys: [publicKey], allowedBuilders: [PROV_BUILDER] }, bundles: {} },
  });
  expect(report.ok).toBe(false);
  expect(codes(report.problems)).toContain("artifact-provenance-missing");
});

test("without an attestations option, no provenance check runs (opt-in)", async () => {
  const dir = writeDef(baseManifest({ mcp: { servers: { fs: provServer } } }));
  const report = await runDoctor(dir, { strictSupplyChain: true });
  expect(codes(report.problems)).not.toContain("artifact-provenance-failed");
  expect(codes(report.problems)).not.toContain("artifact-provenance-missing");
});

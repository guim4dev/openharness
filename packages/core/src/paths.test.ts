import { afterEach, beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, sep } from "node:path";
import { configDir } from "./paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// configDir() reads OPENHARNESS_APP_ID / OPENHARNESS_DIR from the environment
// when no explicit appId is passed. Stash + restore both around every test in
// this file so a stray value left by another test (or the outer shell) can't
// pollute these assertions, and so nothing here leaks to other test files.
let savedAppId: string | undefined;
let savedDir: string | undefined;

beforeEach(() => {
  savedAppId = process.env.OPENHARNESS_APP_ID;
  savedDir = process.env.OPENHARNESS_DIR;
  delete process.env.OPENHARNESS_APP_ID;
  delete process.env.OPENHARNESS_DIR;
});

afterEach(() => {
  if (savedAppId === undefined) delete process.env.OPENHARNESS_APP_ID;
  else process.env.OPENHARNESS_APP_ID = savedAppId;
  if (savedDir === undefined) delete process.env.OPENHARNESS_DIR;
  else process.env.OPENHARNESS_DIR = savedDir;
});

test("different explicit app ids resolve to different, correctly-suffixed dirs", () => {
  const acme = configDir("ai.openharness.acme.assistant");
  const globex = configDir("ai.openharness.globex.helper");
  expect(acme).not.toBe(globex);
  expect(isAbsolute(acme)).toBe(true);
  expect(isAbsolute(globex)).toBe(true);
  expect(acme.endsWith("ai.openharness.acme.assistant")).toBe(true);
  expect(globex.endsWith("ai.openharness.globex.helper")).toBe(true);
});

test("configDir() with OPENHARNESS_APP_ID unset preserves the default", () => {
  expect(isAbsolute(configDir())).toBe(true);
  expect(configDir().endsWith("openharness")).toBe(true);
});

test("configDir() picks up OPENHARNESS_APP_ID from the environment when no arg is passed", () => {
  process.env.OPENHARNESS_APP_ID = "ai.openharness.acme.assistant";
  expect(configDir().endsWith("ai.openharness.acme.assistant")).toBe(true);
  expect(configDir()).toBe(configDir("ai.openharness.acme.assistant"));
});

test("an explicit appId argument overrides OPENHARNESS_APP_ID", () => {
  process.env.OPENHARNESS_APP_ID = "should-be-ignored";
  expect(configDir("explicit-wins").endsWith("explicit-wins")).toBe(true);
});

test("path traversal attempt sanitizes to a single safe segment, no separators", () => {
  const dir = configDir("../../etc/passwd");
  const segment = dir.slice(dir.lastIndexOf(sep) + 1);
  expect(segment).not.toBe("");
  expect(segment.includes(sep)).toBe(false);
  expect(segment.includes("/")).toBe(false);
  expect(segment.includes("\\")).toBe(false);
  expect(segment).not.toBe("..");
  expect(segment).not.toBe(".");
});

test("space and slash id sanitizes to a single safe segment", () => {
  const dir = configDir("A B/C");
  const segment = dir.slice(dir.lastIndexOf(sep) + 1);
  expect(segment).toBe("a-b-c");
});

test("an id that is only dots falls back to the default app id", () => {
  expect(configDir("..").endsWith("openharness")).toBe(true);
  expect(configDir(".").endsWith("openharness")).toBe(true);
});

test("desktop app's Tauri CSP is a real, non-null policy", () => {
  const confPath = join(repoRoot, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
    app?: { security?: { csp?: unknown } };
  };
  const csp = conf.app?.security?.csp;
  expect(typeof csp).toBe("string");
  expect(csp).not.toBeNull();
  expect(csp as string).toContain("connect-src");
  expect(csp as string).toContain("127.0.0.1");
});

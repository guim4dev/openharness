import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFileSecretStore } from "@openharness/credentials";
import { main, parseApprovers, setUpstreamSecret } from "./cli.ts";

let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logs = [];
  errs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
  errSpy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => void errs.push(String(m)));
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = 0;
});

test("--help prints usage and does not error", async () => {
  await main(["--help"]);
  expect(logs.join("\n")).toMatch(/openharness-gateway/);
  expect(process.exitCode ?? 0).toBe(0);
});

test("no args prints usage", async () => {
  await main([]);
  expect(logs.join("\n")).toMatch(/Usage/);
});

test("an unknown command errors with exit code 1", async () => {
  await main(["frobnicate"]);
  expect(errs.join("\n")).toMatch(/unknown command/);
  expect(process.exitCode).toBe(1);
});

test("serve without a config path errors with exit code 1", async () => {
  await main(["serve"]);
  expect(errs.join("\n")).toMatch(/requires a <config\.json>/);
  expect(process.exitCode).toBe(1);
});

test("--help documents set-secret", async () => {
  await main(["--help"]);
  expect(logs.join("\n")).toMatch(/set-secret/);
});

test("set-secret without an id errors with exit code 1", async () => {
  await main(["set-secret"]);
  expect(errs.join("\n")).toMatch(/requires an <id>/);
  expect(process.exitCode).toBe(1);
});

test("setUpstreamSecret stores upstream:<id> and round-trips through the encrypted store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oh-gw-secret-"));
  try {
    await setUpstreamSecret(dir, "github", "ghp_orgtoken");
    const store = await EncryptedFileSecretStore.open(dir);
    expect(await store.get("upstream:github")).toBe("ghp_orgtoken");
    // Never stored under the LLM-credential namespace.
    expect(await store.get("api-key:github")).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setUpstreamSecret rejects an invalid id and an empty value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oh-gw-secret-"));
  try {
    await expect(setUpstreamSecret(dir, "bad id!", "x")).rejects.toThrow(/invalid upstream id/);
    await expect(setUpstreamSecret(dir, "github", "")).rejects.toThrow(/empty secret/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseApprovers: undefined/blank → undefined; valid JSON map → parsed", () => {
  expect(parseApprovers(undefined)).toBeUndefined();
  expect(parseApprovers("   ")).toBeUndefined();
  expect(parseApprovers('{"alice@acme.com":"tok-a","boss@acme.com":"tok-b"}')).toEqual({
    "alice@acme.com": "tok-a",
    "boss@acme.com": "tok-b",
  });
});

test("parseApprovers FAILS CLOSED on malformed input (never silently drops dual control)", () => {
  expect(() => parseApprovers("not json")).toThrow(/OPENHARNESS_GATEWAY_APPROVERS/);
  expect(() => parseApprovers("[1,2,3]")).toThrow(/JSON object/); // array, not an object
  expect(() => parseApprovers("null")).toThrow(/JSON object/);
  expect(() => parseApprovers('{"alice":123}')).toThrow(/string token/); // non-string value
});

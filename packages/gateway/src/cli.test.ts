import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "./cli.ts";

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

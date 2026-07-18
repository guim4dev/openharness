import { afterEach, expect, test, vi } from "vitest";
import { flag, flagPresentButEmpty, firstPositional, main, parsePort } from "./chat-cli.ts";

class ExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/**
 * Drive main() with a synthetic argv, capturing exit code + streams. process.exit
 * is mocked to throw so main() stops at the exit point (the real bin would too).
 */
async function runMain(argv: string[]): Promise<{ code: number | undefined; out: string; err: string }> {
  const origArgv = process.argv;
  process.argv = ["node", "chat-cli.ts", ...argv];
  let code: number | undefined;
  const out: string[] = [];
  const err: string[] = [];
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    throw new ExitSignal(c);
  }) as never);
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    out.push(String(s));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    err.push(String(s));
    return true;
  });
  try {
    await main();
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else throw e;
  } finally {
    process.argv = origArgv;
    exitSpy.mockRestore();
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, out: out.join(""), err: err.join("") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Finding #1 (MEDIUM, chat-cli.ts flag()): a value-less flag must NOT swallow the
// following token when that token is itself another `--flag`. The flags here take
// paths/urls/ids/versions — never a `--`-prefixed value.
test("flag(): does not swallow the next flag as a value-less flag's value", () => {
  // `--a` is value-less; `--b` follows. flag(--a) must be undefined, not "--b".
  expect(flag(["--a", "--b", "val"], "--a")).toBeUndefined();
  expect(flag(["--b", "val"], "--b")).toBe("val");
});

test("flag(): returns undefined for a trailing flag with no value", () => {
  expect(flag(["export", "file", "--out"], "--out")).toBeUndefined();
});

test("flag(): returns a normal (non-`--`) value unchanged", () => {
  expect(flag(["--out", "report.ndjson"], "--out")).toBe("report.ndjson");
  expect(flag(["--server", "https://x"], "--server")).toBe("https://x");
});

// Finding #3 (LOW, audit export --out): a value-less `--out` must be DETECTABLE so
// the call site can error instead of silently dumping to stdout. Depends on #1: a
// `--out` followed by another flag must count as empty, not as value "--since".
test("flagPresentButEmpty(): trailing --out with no value is detected as empty", () => {
  expect(flagPresentButEmpty(["audit", "export", "f", "--out"], "--out")).toBe(true);
});

test("flagPresentButEmpty(): --out immediately followed by another flag is empty (ties into #1)", () => {
  expect(flagPresentButEmpty(["audit", "export", "f", "--out", "--since", "2020"], "--out")).toBe(true);
});

test("flagPresentButEmpty(): --out with a real value is NOT empty", () => {
  expect(flagPresentButEmpty(["audit", "export", "f", "--out", "report.ndjson"], "--out")).toBe(false);
});

test("flagPresentButEmpty(): --out omitted entirely is NOT empty (legit stdout dump)", () => {
  expect(flagPresentButEmpty(["audit", "export", "f"], "--out")).toBe(false);
});

// Finding #2 (MEDIUM, serve --port): a non-numeric / out-of-range port must be
// rejected with a clear `--port` error, not turned into NaN that crashes listen().
test("parsePort(): rejects a non-numeric value with a --port error", () => {
  expect(() => parsePort("abc")).toThrow(/--port/);
});

test("parsePort(): rejects a partially-numeric value", () => {
  expect(() => parsePort("80abc")).toThrow(/--port/);
});

test("parsePort(): rejects an out-of-range value", () => {
  expect(() => parsePort("70000")).toThrow(/--port/);
});

test("parsePort(): rejects a negative value", () => {
  expect(() => parsePort("-1")).toThrow(/--port/);
});

test("parsePort(): accepts a valid port and undefined", () => {
  expect(parsePort("8080")).toBe(8080);
  expect(parsePort("0")).toBe(0);
  expect(parsePort("65535")).toBe(65535);
  expect(parsePort(undefined)).toBeUndefined();
});

// Finding #4 (LOW, doctor leading flags): the positional is the first NON-flag
// token, so documented-optional flags may precede it.
test("firstPositional(): skips a leading boolean flag before the positional", () => {
  expect(firstPositional(["--strict-supply-chain", "mydir"])).toBe("mydir");
});

test("firstPositional(): a trailing flag after the positional still resolves the positional", () => {
  expect(firstPositional(["mydir", "--strict-supply-chain"])).toBe("mydir");
});

test("firstPositional(): skips a leading value-taking flag and its value", () => {
  expect(firstPositional(["--flag", "v", "mydir"], ["--flag"])).toBe("mydir");
});

test("firstPositional(): returns undefined when only flags are present", () => {
  expect(firstPositional(["--strict-supply-chain"])).toBeUndefined();
});

// Call-site wiring (integration): the fixed helpers must actually take effect.

// Finding #3: `audit export <file> --out` (no value) errors clearly instead of
// silently dumping to stdout — and never touches the source file.
test("serve/audit call site: `audit export <file> --out` errors (exit 2), no stdout dump", async () => {
  const { code, out, err } = await runMain(["audit", "export", "/no/such/audit.log", "--out"]);
  expect(code).toBe(2);
  expect(err).toMatch(/--out/);
  expect(out).toBe(""); // did NOT dump NDJSON to stdout
});

// Finding #2: `serve --port <invalid>` errors with a clear --port message (exit 2)
// and never reaches server creation.
test("serve call site: `serve --port abc` errors with a --port message (exit 2)", async () => {
  const { code, err } = await runMain([
    "serve",
    "--bundles",
    "/tmp/b",
    "--audit",
    "/tmp/a",
    "--port",
    "abc",
  ]);
  expect(code).toBe(2);
  expect(err).toMatch(/--port/);
});

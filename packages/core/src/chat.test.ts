import { afterEach, beforeEach, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runChat } from "./chat.ts";
import { createStubModelRegistry } from "./testing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const exampleHarness = join(here, "..", "..", "..", "harnesses", "example");

let dir: string;
let cwd: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oh-chat-cfg-"));
  cwd = await mkdtemp(join(tmpdir(), "oh-chat-cwd-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test("one-shot streams the stubbed reply to stdout and exits 0 (no network)", async () => {
  let out = "";
  const result = await runChat({
    harnessPath: exampleHarness,
    message: "hello",
    dir,
    env: { ANTHROPIC_API_KEY: "sk-test" },
    cwd,
    agentDir: join(cwd, "agent"),
    noExtensions: true,
    out: (chunk) => {
      out += chunk;
    },
    err: () => {},
    modelRegistryOverride: createStubModelRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      reply: "hello from the stub",
    }),
  });

  expect(result.code).toBe(0);
  expect(out).toContain("hello from the stub");
  expect(out.endsWith("\n")).toBe(true); // newline printed on done
});

test("prints a bring-your-own-key how-to and exits 2 when no accounts resolve", async () => {
  let err = "";
  const result = await runChat({
    harnessPath: exampleHarness,
    message: "hi",
    dir,
    env: {},
    out: () => {},
    err: (line) => {
      err += line;
    },
  });

  expect(result.code).toBe(2);
  expect(err).toContain("ANTHROPIC_API_KEY");
  expect(err).toMatch(/accounts\.json/);
});

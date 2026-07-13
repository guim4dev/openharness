#!/usr/bin/env node
import { runChat } from "./chat.ts";

/**
 * `openharness chat <harness-path> "<message>"` — one live turn against a
 * harness using a bring-your-own-key credential (ANTHROPIC_API_KEY etc. or
 * configDir()/accounts.json). Streams assistant text to stdout as it arrives.
 *
 * Run via the root `npm run chat -- <harness-path> "<message>"` (args reach
 * argv directly) or the `openharness` bin (`openharness chat ...`, where the
 * leading "chat" subcommand token is stripped below).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "chat") args.shift();
  const [harnessPath, message] = args;
  if (!harnessPath || message === undefined) {
    process.stderr.write('usage: openharness chat <harness-path> "<message>"\n');
    process.exit(2);
  }
  const { code } = await runChat({ harnessPath, message });
  process.exit(code);
}

main().catch((e: unknown) => {
  process.stderr.write(`${String((e as Error)?.message ?? e)}\n`);
  process.exit(1);
});

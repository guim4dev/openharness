import { join } from "node:path";
import { loadHarnessDefinition } from "@openharness/definition";
import { createLiveSession } from "./live-session.ts";
import type { CreateLiveSessionOptions } from "./live-session.ts";
import { loadAccounts } from "./accounts.ts";
import { configDir } from "./paths.ts";

export interface RunChatOptions {
  harnessPath: string;
  message: string;
  /** Config root for accounts.json + secrets. Default: `configDir()`. */
  dir?: string;
  /** Environment source. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Sink for streamed assistant text. Default: `process.stdout.write`. */
  out?: (chunk: string) => void;
  /** Sink for diagnostics / how-to. Default: `process.stderr`. */
  err?: (line: string) => void;
  cwd?: string;
  agentDir?: string;
  noExtensions?: boolean;
  /** Test seam: inject a stub ModelRegistry so the turn runs offline. */
  modelRegistryOverride?: CreateLiveSessionOptions["modelRegistryOverride"];
}

export interface RunChatResult {
  /** Process exit code: 0 ok, 2 no credentials, 1 run error. */
  code: number;
}

/**
 * Drive a single chat turn against a harness using bring-your-own-key
 * credentials, streaming assistant text deltas to `out` as they arrive.
 * Returns an exit code rather than calling `process.exit`, so it is testable.
 */
export async function runChat(opts: RunChatOptions): Promise<RunChatResult> {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const err = opts.err ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const dir = opts.dir ?? configDir();
  const env = opts.env ?? process.env;

  const def = await loadHarnessDefinition(opts.harnessPath);
  const provider = def.manifest.providers.default;
  const profile = provider.credentialProfile;

  const { manager, registry, secretStore } = await loadAccounts({ profileName: profile, dir, env });

  if (!manager.activeAccount(profile, provider.provider)) {
    err(
      `${def.manifest.branding.displayName}: no API key configured for provider ` +
        `'${provider.provider}' (profile '${profile}').\n` +
        `Bring your own key one of two ways:\n` +
        `  1. export ANTHROPIC_API_KEY=sk-...   ` +
        `(or OPENAI_API_KEY, GEMINI_API_KEY, OPENCODE_GO_API_KEY)\n` +
        `  2. add ${join(dir, "accounts.json")}`,
    );
    return { code: 2 };
  }

  const live = await createLiveSession({
    harnessPath: opts.harnessPath,
    manager,
    registry,
    secretStore,
    profile,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
    ...(opts.noExtensions ? { noExtensions: true } : {}),
    ...(opts.modelRegistryOverride ? { modelRegistryOverride: opts.modelRegistryOverride } : {}),
  });

  let failure: string | undefined;
  try {
    await live.prompt(opts.message, (event) => {
      if (event.type === "token") out(event.text);
      else if (event.type === "done") out("\n");
      else failure = event.message;
    });
  } catch (e) {
    failure = (e as Error)?.message ?? String(e);
  } finally {
    await live.close();
  }

  if (failure) {
    err(`error: ${failure}`);
    return { code: 1 };
  }
  return { code: 0 };
}

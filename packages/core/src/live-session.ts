import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadHarnessDefinition } from "@openharness/definition";
import type { AuthProviderRegistry, CredentialManager } from "@openharness/credentials";
import { loadMcpTools } from "@openharness/mcp";
import { createOpenHarnessAuthStorage } from "./pi-auth-storage.ts";

/** What a live turn forwards to the caller as it streams. */
export type LiveSessionEvent =
  | { type: "token"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

export interface CreateLiveSessionOptions {
  harnessPath: string;
  manager: CredentialManager;
  registry: AuthProviderRegistry;
  /** Credential profile to drive rotation against. */
  profile: string;
  /**
   * Advanced/test seam: build the Pi ModelRegistry bound to the session's real
   * AuthStorage (e.g. one carrying a stub provider). When omitted, Pi's default
   * disk-backed registry is used and the harness's model is resolved from it.
   */
  modelRegistryOverride?: (authStorage: AuthStorage) => ModelRegistry;
  /** Working directory for the session. Default: process.cwd(). */
  cwd?: string;
  /** Pi global config dir. Default: getAgentDir(). */
  agentDir?: string;
  /** Skip extension/context-file discovery for a hermetic session. Default: false. */
  noExtensions?: boolean;
}

export interface LiveSession {
  /** The underlying Pi AgentSession, for advanced use. */
  readonly session: AgentSession;
  /** Provider id the model + credential slot resolve against (e.g. "anthropic"). */
  readonly providerId: string;
  /**
   * Drive a single turn. Forwards each streamed assistant text delta as a
   * `token` event, then a final `done` carrying the complete assistant text
   * (or an `error` event if the run fails). Awaits run settlement before
   * resolving, so turns are safe to issue sequentially.
   */
  prompt(text: string, onEvent: (event: LiveSessionEvent) => void): Promise<void>;
  /** Dispose the session and any in-flight run. */
  close(): Promise<void>;
}

/**
 * Stand up a real Pi AgentSession for a harness definition, bridging the
 * OpenHarness credential seam into Pi's AuthStorage, and expose a streaming
 * `prompt` over it.
 *
 * Pi launch path (pi-coding-agent@0.80.6):
 *   createAgentSessionServices({ authStorage, resourceLoaderOptions, modelRegistry? })
 *   -> resolve the harness model (registry.find, else resolveCliModel)
 *   -> createAgentSessionFromServices({ services, sessionManager, model })
 * Token deltas arrive on `message_update` where `assistantMessageEvent.type ===
 * "text_delta"`; the run is complete at `agent_end`/settle (we await
 * `waitForIdle()`), and the final text is read via `getLastAssistantText()`.
 */
export async function createLiveSession(opts: CreateLiveSessionOptions): Promise<LiveSession> {
  const def = await loadHarnessDefinition(opts.harnessPath);
  const provider = def.manifest.providers.default;
  const providerId = provider.provider;
  const modelId = provider.model;

  const oh = createOpenHarnessAuthStorage({
    manager: opts.manager,
    registry: opts.registry,
    profile: opts.profile,
  });

  // Seed the runtime credential override before the session's first request.
  await oh.syncActiveProvider(providerId);

  const cwd = opts.cwd ?? process.cwd();
  const agentDir = opts.agentDir ?? getAgentDir();
  const sessionManager = SessionManager.create(cwd);
  const modelRegistry = opts.modelRegistryOverride?.(oh.authStorage);

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    authStorage: oh.authStorage,
    ...(modelRegistry ? { modelRegistry } : {}),
    resourceLoaderOptions: {
      systemPrompt: def.systemPromptText,
      additionalSkillPaths: def.skillDirs.map((s) => s.path),
      ...(opts.noExtensions ? { noExtensions: true, noContextFiles: true } : {}),
    },
  });

  // Resolve the harness model: a directly-registered (e.g. stub) model is found
  // by exact lookup; otherwise fall back to Pi's CLI resolver over the registry.
  let model: Model<Api> | undefined = services.modelRegistry.find(providerId, modelId);
  let thinkingLevel: ReturnType<typeof resolveCliModel>["thinkingLevel"];
  if (!model) {
    const resolved = resolveCliModel({
      cliProvider: providerId,
      cliModel: modelId,
      modelRegistry: services.modelRegistry,
    });
    if (resolved.error || !resolved.model) {
      throw new Error(
        `Model '${providerId}/${modelId}' could not be resolved: ${resolved.error ?? "not found"}`,
      );
    }
    model = resolved.model;
    thinkingLevel = resolved.thinkingLevel;
  }

  // Connect MCP servers declared on the harness and bridge their tools into Pi.
  // A mandatory server that fails to connect throws here (fail fast). No `mcp`
  // section => empty tools + no-op dispose, so hermetic harnesses are unaffected.
  const { tools: mcpTools, dispose: disposeMcp } = await loadMcpTools(def);

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(mcpTools.length ? { customTools: mcpTools } : {}),
  });

  return {
    session,
    providerId,
    async prompt(text, onEvent) {
      // Pick up any credential rotation for this turn before the request fires.
      await oh.syncActiveProvider(providerId);

      const streamed: string[] = [];
      let streamError: string | undefined;

      const unsubscribe = session.subscribe((event) => {
        if (event.type !== "message_update") return;
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta") {
          streamed.push(inner.delta);
          onEvent({ type: "token", text: inner.delta });
        } else if (inner.type === "error") {
          streamError = inner.error.errorMessage ?? "stream error";
        }
      });

      try {
        // The session is idle between turns (we await settlement below), so no
        // streamingBehavior is required here.
        await session.prompt(text);
        await session.waitForIdle();
      } catch (err) {
        onEvent({ type: "error", message: (err as Error)?.message ?? String(err) });
        return;
      } finally {
        unsubscribe();
      }

      if (streamError) {
        onEvent({ type: "error", message: streamError });
        return;
      }
      onEvent({ type: "done", text: session.getLastAssistantText() ?? streamed.join("") });
    },
    async close() {
      if (session.isStreaming) await session.abort();
      session.dispose();
      await disposeMcp();
    },
  };
}

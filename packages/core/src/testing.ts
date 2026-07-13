import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
// AssistantMessageEventStream is re-exported by pi-ai's barrel both as a class
// value (utils/event-stream) and as a type (types.ts), which is ambiguous under
// verbatimModuleSyntax. Import the type here and build instances via the
// unambiguous createAssistantMessageEventStream() factory below.
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

/**
 * A Pi `streamSimple` implementation that emits a canned reply as a fully-formed
 * `AssistantMessageEventStream`, offline. Mirrors the real provider event
 * protocol: start -> text_start -> text_delta* -> text_end -> done. The stream
 * is returned synchronously and populated from a detached async closure so the
 * agent loop's iterator observes buffered events (Pi's StreamFn contract).
 */
export function stubStreamSimple(
  reply: string,
): (model: Model<Api>, ctx: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  return (_model, _ctx, _options) => {
    const stream = createAssistantMessageEventStream();
    const finalMessage = fauxAssistantMessage(reply, { stopReason: "stop" });
    // Split into word-sized chunks so consumers observe real streaming (>1 delta).
    const chunks = reply.match(/\S+\s*/g) ?? [reply];
    void (async () => {
      stream.push({ type: "start", partial: finalMessage });
      stream.push({ type: "text_start", contentIndex: 0, partial: finalMessage });
      for (const delta of chunks) {
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial: finalMessage });
      }
      stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: finalMessage });
      stream.push({ type: "done", reason: "stop", message: finalMessage });
      stream.end(finalMessage);
    })();
    return stream;
  };
}

export interface StubProviderOptions {
  /** Provider name to register under (must match the harness's provider). */
  provider: string;
  /** Model id to register (must match the harness's model). */
  modelId: string;
  /** The canned reply the stub streams token-by-token. */
  reply: string;
}

/**
 * Register an offline stub provider on an existing ModelRegistry. Satisfies the
 * two runtime-only gates validateProviderConfig enforces when `models` is set:
 * a `baseUrl` (never dialed) and a dummy `apiKey` (satisfies the auth gate).
 */
export function registerStubProvider(registry: ModelRegistry, opts: StubProviderOptions): void {
  registry.registerProvider(opts.provider, {
    baseUrl: "http://stub.local",
    apiKey: "stub-key",
    api: "anthropic-messages",
    streamSimple: stubStreamSimple(opts.reply),
    models: [
      {
        id: opts.modelId,
        name: `${opts.modelId} (stub)`,
        api: "anthropic-messages",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    ],
  });
}

/**
 * Factory producing an in-memory ModelRegistry bound to the given AuthStorage
 * with the stub provider registered. Suitable as `createLiveSession`'s
 * `modelRegistryOverride`.
 */
export function createStubModelRegistry(
  opts: StubProviderOptions,
): (authStorage: AuthStorage) => ModelRegistry {
  return (authStorage) => {
    const registry = ModelRegistry.inMemory(authStorage);
    registerStubProvider(registry, opts);
    return registry;
  };
}

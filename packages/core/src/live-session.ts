import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { loadHarnessDefinition } from "@openharness/definition";
import type { HarnessDefinition } from "@openharness/definition";
import { loadVerifiedDefinition } from "@openharness/bundle";
import type { AuthProviderRegistry, CredentialManager, SecretStore } from "@openharness/credentials";
import { loadMcpTools } from "@openharness/mcp";
import type { ConnectFn } from "@openharness/mcp";
import { checkModel } from "@openharness/policy";
import type { Policy } from "@openharness/policy";
import { createFileAuditLog } from "@openharness/audit";
import type { AuditSink } from "@openharness/audit";
import { createOpenHarnessAuthStorage } from "./pi-auth-storage.ts";
import { buildPolicyExtension } from "./policy-extension.ts";

/** What a live turn forwards to the caller as it streams. */
export type LiveSessionEvent =
  | { type: "token"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

export interface CreateLiveSessionOptions {
  /**
   * Path to a harness definition dir loaded WITHOUT signature verification —
   * the dev/local path. Ignored when `verified` is set. Optional so a verified
   * boot needs no on-disk definition at all.
   */
  harnessPath?: string;
  /**
   * Verify-on-boot: when set, the session boots pinned to a cryptographically
   * verified definition instead of an unverified local dir. The bundle at
   * `bundlePath` must carry a signature that validates under the org public key
   * read from `pubkeyPath`, and every bundled file's hash must match; otherwise
   * a `BundleVerificationError` is thrown before any session is created
   * (fail-closed). Takes precedence over `harnessPath`.
   *
   * `minVersion` is the optional anti-rollback floor: a validly-signed bundle
   * whose version is OLDER than this is refused (`BundleVerificationError`), so
   * an attacker with write access to the resource dir cannot swap in an older
   * but still org-signed bundle carrying a more permissive past policy. Omit it
   * for dev / no-floor boots (the signature + hash gates still apply).
   */
  verified?: { bundlePath: string; pubkeyPath: string; minVersion?: string };
  manager: CredentialManager;
  registry: AuthProviderRegistry;
  /** Credential profile to drive rotation against. */
  profile: string;
  /**
   * Machine-local secret store used to resolve MCP servers' `secrets` refs
   * (env-var/header name -> credential ref) at connect time. When omitted, a
   * harness that declares `secrets` on any MCP server fails to connect that
   * server (fail-closed) — a blank secret is never used. Harnesses without MCP
   * `secrets` are unaffected.
   */
  secretStore?: SecretStore;
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
  /**
   * Access policy to enforce. When omitted, falls back to the definition's
   * `policy.json` (if any). When neither is present, enforcement is a no-op.
   */
  policy?: Policy;
  /**
   * Advanced/test seam: extra Pi tools to expose alongside the harness's MCP
   * tools (e.g. a stub tool an integration test drives). Merged with MCP tools.
   */
  customTools?: ToolDefinition[];
  /**
   * Advanced/test seam: override the MCP connection factory used to reach the
   * harness's declared servers. Forwarded verbatim to `loadMcpTools`, so a
   * bridged tool still enters the session as `mcp__<server>__<tool>` and flows
   * through the SAME policy/audit path as production. An integration test injects
   * an in-memory server here; when omitted, the real stdio/http connector is used.
   */
  mcpConnect?: ConnectFn;
  /**
   * Where to write the hash-chained audit log. Auditing is OFF unless BOTH a
   * policy is in effect AND this path is set (opt-in), so existing hermetic
   * sessions are unaffected. The log records external-call events only (tool
   * decisions, tool results, provider requests) — never prompt/message content.
   */
  auditPath?: string;
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
/**
 * Resolve the harness definition for a session. With `verified` set, the
 * definition is loaded through the signed-bundle trust path: the signature over
 * the bundle manifest must validate under the org public key and every file's
 * hash must match, or `loadVerifiedDefinition` throws `BundleVerificationError`.
 * That error is left to propagate UNCHANGED so a caller (e.g. the desktop
 * sidecar) can distinguish an integrity failure from an ordinary startup error
 * and refuse to boot. When `verified.minVersion` is set it is passed through as
 * the anti-rollback floor, so a validly-signed but stale bundle is refused too.
 * Without `verified`, the local dir is loaded unverified.
 */
async function resolveDefinition(opts: CreateLiveSessionOptions): Promise<HarnessDefinition> {
  if (opts.verified) {
    return loadVerifiedDefinition(
      opts.verified.bundlePath,
      readFileSync(opts.verified.pubkeyPath, "utf8"),
      opts.verified.minVersion ? { minVersion: opts.verified.minVersion } : {},
    );
  }
  if (opts.harnessPath) return loadHarnessDefinition(opts.harnessPath);
  throw new Error("createLiveSession requires either `harnessPath` (dev) or a `verified` bundle");
}

export async function createLiveSession(opts: CreateLiveSessionOptions): Promise<LiveSession> {
  const def = await resolveDefinition(opts);
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

  // Resolve the effective policy: an explicit override wins, else the
  // definition's policy.json. The model gate is enforced HERE (fail-closed): a
  // denied model refuses to start the session, since the provider-layer hook
  // cannot block a request.
  const policy = opts.policy ?? def.policy;
  if (policy && checkModel(policy, providerId, modelId) === "deny") {
    throw new Error(`Model '${providerId}/${modelId}' is denied by policy.`);
  }
  // Auditing is opt-in: only when a policy is in effect AND an audit path is
  // given. Kept off by default so hermetic sessions write nothing.
  const auditSink: AuditSink | undefined =
    policy && opts.auditPath ? createFileAuditLog(opts.auditPath) : undefined;
  const policyExtension: InlineExtension[] = policy
    ? [buildPolicyExtension(policy, { providerId, ...(auditSink ? { audit: auditSink } : {}) })]
    : [];

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
      ...(policyExtension.length ? { extensionFactories: policyExtension } : {}),
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
  const { tools: mcpTools, dispose: disposeMcp } = await loadMcpTools(def, {
    ...(opts.mcpConnect ? { connect: opts.mcpConnect } : {}),
    // Resolve MCP `secrets` refs from the machine-local store at connect time.
    // The ref (a name) is all that shipped in the bundle; the value is fetched
    // here and never persisted back into the definition.
    ...(opts.secretStore ? { resolveSecret: (ref: string) => opts.secretStore!.get(ref) } : {}),
  });
  const allTools: ToolDefinition[] = [...mcpTools, ...(opts.customTools ?? [])];

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(allTools.length ? { customTools: allTools } : {}),
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
      await auditSink?.close?.();
    },
  };
}

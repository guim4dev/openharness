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
import { loadGatewayTools } from "./gateway-bridge.ts";
import type { GatewayAuth, LoadGatewayToolsOptions } from "./gateway-bridge.ts";
import { checkModel } from "@openharness/policy";
import type { Policy } from "@openharness/policy";
import { createFileAuditLog, createAuditShipper, httpAuditPush } from "@openharness/audit";
import type { AuditSink, AuditShipper, ShipResult } from "@openharness/audit";
import { createOpenHarnessAuthStorage } from "./pi-auth-storage.ts";
import { buildPolicyExtension } from "./policy-extension.ts";
import { classify } from "./session.ts";

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
   * DPoP auth material for a declared remote `gateway` (a short-lived token bound
   * to the client keypair that signs per-request proofs). REQUIRED when the
   * definition declares a `gateway`: without it the session fails to boot
   * (offline hard-fail) rather than run without the governed remote tools.
   * Ignored when the definition declares no gateway.
   */
  gatewayAuth?: GatewayAuth;
  /**
   * Advanced/test seam: override how the gateway connection is established (and
   * the bridged-tool namespace). Forwarded verbatim to `loadGatewayTools`, so a
   * bridged gateway tool still enters the session as `mcp__<namespace>__<tool>`
   * and flows through the SAME local policy/audit path as production.
   */
  gatewayOptions?: LoadGatewayToolsOptions;
  /**
   * Where to write the hash-chained audit log. Auditing is OFF unless BOTH a
   * policy is in effect AND this path is set (opt-in), so existing hermetic
   * sessions are unaffected. The log records external-call events only (tool
   * decisions, tool results, provider requests) — never prompt/message content.
   */
  auditPath?: string;
  /**
   * Ship the local audit log to the authoritative server anchor. Only active
   * when auditing is on (a policy is in effect AND `auditPath` is set). Records
   * are shipped periodically (unref'd timer, never blocking a turn) and once more
   * on `close()`. A fork/re-chain (409) surfaces via `onShipResult` (default:
   * a loud `console.error`) — the shipper never advances its ack past a conflict.
   */
  auditServer?: {
    url: string;
    source: string;
    token?: string;
    /** Sidecar ack-state path. Default `<auditPath>.shipped.json`. */
    statePath?: string;
    /** Periodic flush interval (ms); 0 disables periodic (still flushes on close). Default 15000. */
    intervalMs?: number;
    /** Observe each ship result (esp. a `conflict` = integrity alarm). */
    onShipResult?: (r: ShipResult) => void;
  };
  /**
   * Out-of-band approval resolver for policy `ask` decisions. When provided it
   * is threaded into the policy extension and takes precedence over the
   * in-process `ctx.ui.confirm` path (the desktop sidecar wires this to a WS
   * approve/deny dialog in the UI). Fail-closed: a rejection is a DENY, and the
   * resolver must deny when no human can be reached. When omitted, `ask` falls
   * back to `ctx.ui.confirm` if a dialog UI exists, else DENY.
   */
  askUser?: (req: { toolName: string; reason?: string }) => Promise<boolean>;
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

  // Optional: ship the local audit log to the authoritative server anchor.
  // Active only when auditing is on. The periodic timer is UNREF'd so it never
  // keeps the process alive, and a flush NEVER throws into a turn — a conflict
  // (fork/re-chain) is surfaced via onShipResult (default: a loud console.error).
  let auditShipper: AuditShipper | undefined;
  let shipTimer: ReturnType<typeof setInterval> | undefined;
  // A serial flush (set when shipping is active) so the periodic timer and close()
  // never flush concurrently; `flushChain` is the tail of the in-flight flush.
  let flushSerial: (() => Promise<ShipResult>) | undefined;
  let flushChain: Promise<unknown> = Promise.resolve();
  if (auditSink && opts.auditPath && opts.auditServer) {
    const as = opts.auditServer;
    auditShipper = createAuditShipper({
      logPath: opts.auditPath,
      push: httpAuditPush(as.url, as.source, as.token),
      ...(as.statePath ? { statePath: as.statePath } : {}),
    });
    const onResult =
      as.onShipResult ??
      ((r: ShipResult) => {
        if (r.conflict) console.error(`[openharness/audit] integrity ALARM shipping to ${as.url}: ${r.conflict}`);
      });
    // Serialize flushes: the periodic timer and close()'s final flush must never
    // run concurrently against the same log / ack-state. Each flush chains after
    // any in-flight one.
    flushSerial = (): Promise<ShipResult> => {
      const run = flushChain.then(() => auditShipper!.flush());
      flushChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
    const flush = (): void => {
      void flushSerial!()
        .then(onResult)
        .catch(() => {
          /* transport hiccup: the next flush (or close) retries from the ack */
        });
    };
    const intervalMs = as.intervalMs ?? 15_000;
    if (intervalMs > 0) {
      shipTimer = setInterval(flush, intervalMs);
      shipTimer.unref?.();
    }
  }
  const policyExtension: InlineExtension[] = policy
    ? [
        buildPolicyExtension(policy, {
          providerId,
          ...(auditSink ? { audit: auditSink } : {}),
          ...(opts.askUser ? { askUser: opts.askUser } : {}),
        }),
      ]
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
    //
    // NAMESPACE GUARD (defense-in-depth): LLM account keys live in the SAME
    // store under `api-key:<id>`. The default connector already rejects such
    // refs, but a custom `mcpConnect` might call this resolver directly, so we
    // also refuse `api-key:*` here — an MCP secret must never resolve an LLM key
    // (which a signed definition could otherwise exfiltrate to any endpoint).
    ...(opts.secretStore
      ? {
          resolveSecret: (ref: string) => {
            if (/^api-key:/.test(ref)) {
              throw new Error(
                `MCP secret ref '${ref}' targets the reserved LLM-credential namespace ('api-key:') — refusing to resolve an LLM key for MCP.`,
              );
            }
            return opts.secretStore!.get(ref);
          },
        }
      : {}),
  });
  // Connect a declared remote gateway (v2) and bridge its governed tools into Pi
  // as `mcp__<namespace>__<tool>`. Fail-closed: a declared gateway is mandatory —
  // missing auth or an unreachable gateway throws here (offline hard-fail) rather
  // than silently starting without the governed remote tools. No `gateway`
  // section => this is skipped entirely (existing harnesses are unaffected).
  let gatewayTools: ToolDefinition[] = [];
  let disposeGateway: () => Promise<void> = async () => {};
  if (def.manifest.gateway) {
    if (!opts.gatewayAuth) {
      throw new Error(
        `Harness declares a remote gateway ('${def.manifest.gateway.url}') but no gatewayAuth was provided — refusing to boot without the governed remote tools (fail-closed).`,
      );
    }
    const loaded = await loadGatewayTools(def.manifest.gateway, opts.gatewayAuth, opts.gatewayOptions ?? {});
    gatewayTools = loaded.tools;
    disposeGateway = loaded.dispose;
  }

  const allTools: ToolDefinition[] = [...mcpTools, ...gatewayTools, ...(opts.customTools ?? [])];

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
      // Pick up any credential rotation for this turn; keep the resolved account
      // so a mid-turn provider failure is reported against the RIGHT one.
      let currentAccount = await oh.syncActiveProvider(providerId);

      const streamed: string[] = [];
      let streamError: string | undefined;

      const unsubscribe = session.subscribe((event) => {
        // Pi retries a failed provider request on its own (after `delayMs`). Use
        // that gap to ROTATE credentials: mark the current account per the error
        // and swap the runtime key to the next healthy account, so Pi's retry
        // hits a different account instead of the same rate-limited one. This is
        // the live-session counterpart of the startSession rotation loop.
        if (event.type === "auto_retry_start") {
          const errorMessage = (event as { errorMessage?: string }).errorMessage;
          const kind = classify(errorMessage);
          if (kind !== "other" && currentAccount) {
            opts.manager.reportResult(currentAccount.id, { ok: false, kind });
            // Fire-and-forget: the AuthStorage runtime override is what Pi reads
            // at request time, and it waits `delayMs` before retrying, so the
            // async re-sync lands first in practice.
            void oh
              .syncActiveProvider(providerId)
              .then((a) => {
                currentAccount = a;
              })
              .catch(() => {
                /* best-effort rotation; the final-failure path still surfaces errors */
              });
          }
          return;
        }
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
      // Per-step fault isolation: one failing teardown step must NEVER orphan the
      // others (MCP subprocesses, the gateway connection, the audit sink's file
      // handle). Each step is guarded; the first error is re-thrown at the very
      // end, after every resource has been released.
      let firstErr: unknown;
      const step = async (fn: () => unknown | Promise<unknown>): Promise<void> => {
        try {
          await fn();
        } catch (e) {
          if (firstErr === undefined) firstErr = e;
        }
      };
      await step(async () => {
        if (session.isStreaming) await session.abort();
      });
      await step(() => session.dispose());
      await step(() => disposeMcp());
      await step(() => disposeGateway());
      // Stop the periodic shipper and ship one final time (serialized with any
      // in-flight periodic flush) so the session's tail reaches the anchor. Never
      // let a ship error mask a clean close.
      if (shipTimer) clearInterval(shipTimer);
      if (auditShipper && flushSerial) {
        try {
          const r = await flushSerial();
          opts.auditServer?.onShipResult?.(r);
          if (r.conflict && !opts.auditServer?.onShipResult)
            console.error(`[openharness/audit] integrity ALARM shipping to ${opts.auditServer?.url}: ${r.conflict}`);
        } catch {
          /* best-effort final ship */
        }
      }
      await step(async () => {
        await auditSink?.close?.();
      });
      if (firstErr !== undefined) throw firstErr;
    },
  };
}

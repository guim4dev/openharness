import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  resolveCliModel,
  SessionManager,
  type AgentSessionRuntimeDiagnostic,
  type CreateAgentSessionRuntimeFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { buildPolicyExtension, checkModel, createOpenHarnessAuthStorage } from "@openharness/core";
import type { AuthProviderRegistry, CredentialManager } from "@openharness/credentials";
import { loadHarnessDefinition } from "@openharness/definition";
import { loadMcpTools } from "@openharness/mcp";
import { buildTuiConfig } from "./build-options.ts";

export interface LaunchTuiOptions {
  harnessPath: string;
  manager: CredentialManager;
  registry: AuthProviderRegistry;
  /** Defaults to the harness's default credentialProfile. */
  profile?: string;
  /** Working directory for the session. Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Loads a HarnessDefinition, bridges the OpenHarness credential seam into a real
 * Pi AuthStorage, assembles the runtime options, and launches Pi's InteractiveMode.
 *
 * The Pi launch API used (pi-coding-agent@0.80.6), mirroring main.ts:615-843:
 *   createAgentSessionServices(...) -> resolveCliModel(...) -> createAgentSessionFromServices(...)
 *   inside a CreateAgentSessionRuntimeFactory, then createAgentSessionRuntime(factory, {...}),
 *   then `new InteractiveMode(runtime, opts)` and `await tui.run()`.
 * There is no `runInteractiveMode(...)` convenience function — the TUI is a class.
 */
export async function launchTui(opts: LaunchTuiOptions): Promise<void> {
  const def = await loadHarnessDefinition(opts.harnessPath);
  const profile = opts.profile ?? def.manifest.providers.default.credentialProfile;

  const oh = createOpenHarnessAuthStorage({
    manager: opts.manager,
    registry: opts.registry,
    profile,
  });

  const providerId = def.manifest.providers.default.provider;

  // Per-turn credential refresh. InteractiveMode owns the prompt loop and exposes
  // no per-turn callback, so we drive rotation from a Pi extension on the
  // `before_agent_start` hook (fires after the user submits, before the agent
  // loop makes the provider request; Pi's per-request getApiKey reads the
  // runtime-override slot this updates). Seeding once before run() only covers
  // the first turn.
  //
  // NOTE: this refreshes account SELECTION between turns (external rotation /
  // manager health changes). It does NOT yet close the failover loop on errors
  // Pi raises mid-turn — under the TUI, Pi owns the request loop, so calling
  // manager.reportResult(...) on a live 429/quota would need a
  // before_provider_request/after_provider_response integration. That is a
  // Phase-2 gap (see recon "unknowns").
  const rotationExtension: InlineExtension = {
    name: "openharness-credential-rotation",
    factory: (pi) => {
      pi.on("before_agent_start", async () => {
        await oh.syncActiveProvider(providerId);
      });
    },
  };

  // Policy enforcement. The model gate is fail-closed at launch (a denied model
  // refuses to start); tool_call/tool_result/redaction enforcement rides the
  // in-process policy extension alongside the rotation hook. Ordering is safe:
  // rotation only uses before_agent_start; tool_call short-circuits on the first
  // block regardless of order.
  if (def.policy && checkModel(def.policy, providerId, def.manifest.providers.default.model) === "deny") {
    throw new Error(`Model '${providerId}/${def.manifest.providers.default.model}' is denied by policy.`);
  }
  const extensionFactories = def.policy
    ? [rotationExtension, buildPolicyExtension(def.policy, { providerId })]
    : [rotationExtension];

  const config = buildTuiConfig(def, {
    authStorage: oh.authStorage,
    extensionFactories,
  });

  // Seed the runtime override before the first turn.
  await oh.syncActiveProvider(config.providerId);

  // Connect MCP servers declared on the harness and bridge their tools. These
  // cannot ride on buildTuiConfig's servicesOptions (that slice of
  // CreateAgentSessionServicesOptions has no tools field) — customTools lives on
  // createAgentSessionFromServices, so we build them here and thread them into
  // the runtime factory below. A mandatory server that fails to connect throws.
  const { tools: mcpTools, dispose: disposeMcp } = await loadMcpTools(def);

  const cwd = opts.cwd ?? process.cwd();
  const agentDir = getAgentDir();
  const sessionManager = SessionManager.create(cwd);

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: runtimeCwd,
    agentDir: runtimeAgentDir,
    sessionManager: runtimeSessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      ...config.servicesOptions,
    });

    const diagnostics: AgentSessionRuntimeDiagnostic[] = [...services.diagnostics];

    const resolved = resolveCliModel({
      cliProvider: config.modelSelection.cliProvider,
      cliModel: config.modelSelection.cliModel,
      modelRegistry: services.modelRegistry,
    });
    if (resolved.error) {
      diagnostics.push({
        type: "error",
        message: `Model '${config.modelSelection.cliProvider}/${config.modelSelection.cliModel}' could not be resolved: ${resolved.error}`,
      });
    } else if (resolved.warning) {
      diagnostics.push({ type: "warning", message: resolved.warning });
    }

    const created = await createAgentSessionFromServices({
      services,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      ...(mcpTools.length ? { customTools: mcpTools } : {}),
    });

    return { ...created, services, diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });

  const tui = new InteractiveMode(runtime, {
    ...config.interactiveOptions,
    modelFallbackMessage: runtime.modelFallbackMessage,
  });
  try {
    await tui.run();
  } finally {
    await disposeMcp();
  }
}

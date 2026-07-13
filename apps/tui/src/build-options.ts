import type {
  AuthStorage,
  CreateAgentSessionServicesOptions,
  InlineExtension,
  InteractiveModeOptions,
} from "@earendil-works/pi-coding-agent";
import type { HarnessDefinition } from "@openharness/definition";

export interface BuildTuiConfigOptions {
  /** A real Pi AuthStorage (from createOpenHarnessAuthStorage(...).authStorage). */
  authStorage: AuthStorage;
  /**
   * Per-turn / lifecycle Pi extensions to load into the resource loader
   * (e.g. the credential-rotation hook wired by launch.ts). Forwarded verbatim;
   * buildTuiConfig never invokes them, so it stays pure.
   */
  extensionFactories?: InlineExtension[];
}

/**
 * Everything needed to stand up the Pi runtime for a harness, split so that
 * cwd/agentDir (per-cwd, supplied by the runtime factory callback) are added by
 * launch.ts rather than baked in here.
 */
export interface TuiConfig {
  /** Provider id the model + credential slot resolve against (e.g. "anthropic"). */
  providerId: string;
  /** Branding display name, for startup messaging. */
  displayName: string;
  /**
   * cwd/agentDir-independent slice of CreateAgentSessionServicesOptions. Carries
   * the auth storage (c), the system-prompt replace surface (a), and the
   * mandatory skill paths (b).
   */
  servicesOptions: Omit<CreateAgentSessionServicesOptions, "cwd" | "agentDir">;
  /** Fed verbatim to resolveCliModel(...) once the model registry exists (d). */
  modelSelection: { cliProvider: string; cliModel: string };
  /** InteractiveMode knobs — all optional/cosmetic; none carry prompt/skills/auth/model. */
  interactiveOptions: InteractiveModeOptions;
}

/**
 * PURE mapping from a HarnessDefinition to Pi runtime options. No I/O, no TTY,
 * no side effects — unit-testable in isolation.
 *
 * Injection points (verified against pi-coding-agent@0.80.6 .d.ts):
 *  (a) resourceLoaderOptions.systemPrompt       — verbatim REPLACE (DefaultResourceLoaderOptions)
 *  (b) resourceLoaderOptions.additionalSkillPaths — additive absolute skill dirs
 *  (c) authStorage                              — real Pi AuthStorage seam
 *  (d) modelSelection -> resolveCliModel(...)   — model set on the session, not on InteractiveMode
 */
export function buildTuiConfig(def: HarnessDefinition, opts: BuildTuiConfigOptions): TuiConfig {
  const provider = def.manifest.providers.default;
  return {
    providerId: provider.provider,
    displayName: def.manifest.branding.displayName,
    servicesOptions: {
      authStorage: opts.authStorage, // (c)
      resourceLoaderOptions: {
        systemPrompt: def.systemPromptText, // (a) — in-memory literal, never a file path
        additionalSkillPaths: def.skillDirs.map((s) => s.path), // (b) — already absolutized by the loader
        ...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
      },
    },
    modelSelection: { cliProvider: provider.provider, cliModel: provider.model }, // (d)
    interactiveOptions: {},
  };
}

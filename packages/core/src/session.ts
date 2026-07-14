import { loadHarnessDefinition } from "@openharness/definition";
import type { CredentialManager, AuthProviderRegistry, SecretStore } from "@openharness/credentials";

export interface ModelProvider {
  streamSimple(
    model: unknown,
    ctx: unknown,
    options: { apiKey?: string; baseUrl?: string },
  ): Promise<{ text: string }>;
}
export interface StartSessionOptions {
  harnessPath: string;
  manager: CredentialManager;
  registry: AuthProviderRegistry;
  secretStore: SecretStore;
  /** In prod: a Pi built-in/custom provider. In tests: a stub. */
  modelProvider: ModelProvider;
}
export interface OpenHarnessSession {
  prompt(text: string): Promise<{ text: string; rotations: number }>;
}

type ErrorKind = "rate_limit" | "quota" | "auth" | "other";

function classify(err: unknown): ErrorKind {
  const status = (err as { status?: number })?.status;
  const msg = String((err as Error)?.message ?? err);
  if (/quota|insufficient_quota|billing/i.test(msg)) return "quota";
  if (status === 429 || /rate.?limit|overloaded/i.test(msg)) return "rate_limit";
  if (status === 401 || status === 403 || /unauthorized|invalid.*key/i.test(msg)) return "auth";
  return "other";
}

export async function startSession(opts: StartSessionOptions): Promise<OpenHarnessSession> {
  const def = await loadHarnessDefinition(opts.harnessPath);
  const profileName = def.manifest.providers.default.credentialProfile;
  const providerId = def.manifest.providers.default.provider;
  const model = { id: def.manifest.providers.default.model };

  return {
    async prompt(text: string) {
      let rotations = 0;
      const maxAttempts = 8;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Scope to the harness's provider so rotation never hands a request to
        // this vendor's endpoint a different vendor's key.
        const account = opts.manager.activeAccount(profileName, providerId);
        if (!account)
          throw new Error(
            `No healthy credential accounts for provider '${providerId}' (profile '${profileName}').`,
          );
        const provider = opts.registry.get(account.authProviderId);
        if (!provider) throw new Error(`Unknown auth provider '${account.authProviderId}'.`);
        const req = await provider.applyToRequest(account.credential, { headers: {} });
        try {
          const out = await opts.modelProvider.streamSimple(model, { text }, {
            apiKey: req.apiKey,
            baseUrl: req.baseUrl,
          });
          opts.manager.reportResult(account.id, { ok: true });
          return { text: out.text, rotations };
        } catch (err) {
          const kind = classify(err);
          if (kind === "other") throw err;
          opts.manager.reportResult(account.id, { ok: false, kind });
          rotations++;
        }
      }
      throw new Error(`All credential accounts for profile '${profileName}' are exhausted.`);
    },
  };
}

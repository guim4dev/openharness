import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Account, AuthProviderRegistry, CredentialManager } from "@openharness/credentials";

export interface OpenHarnessAuthStorage {
  /** A real Pi AuthStorage; pass to createAgentSession({ authStorage }). */
  authStorage: AuthStorage;
  /**
   * Resolve the active account for the profile, push its key as the runtime
   * override for `providerId` (so Pi's getApiKey returns it), and return the
   * account. Returns undefined and clears the override when no account is healthy.
   * Call before each turn to pick up rotation.
   */
  syncActiveProvider(providerId: string): Promise<Account | undefined>;
}

/**
 * Bridges the OpenHarness CredentialManager into Pi's real AuthStorage seam.
 * Pi resolves credentials via AuthStorage.getApiKey(); we drive its highest-
 * priority slot (the runtime override) from our rotation state, so account
 * selection and failover happen in our code while Pi stays unmodified.
 */
export function createOpenHarnessAuthStorage(opts: {
  manager: CredentialManager;
  registry: AuthProviderRegistry;
  profile: string;
}): OpenHarnessAuthStorage {
  const authStorage = AuthStorage.inMemory();
  return {
    authStorage,
    async syncActiveProvider(providerId: string): Promise<Account | undefined> {
      const account = opts.manager.activeAccount(opts.profile);
      if (!account) {
        authStorage.removeRuntimeApiKey(providerId);
        return undefined;
      }
      const provider = opts.registry.get(account.authProviderId);
      if (!provider) throw new Error(`Unknown auth provider '${account.authProviderId}'.`);
      const req = await provider.applyToRequest(account.credential, { headers: {} });
      if (req.apiKey) authStorage.setRuntimeApiKey(providerId, req.apiKey);
      else authStorage.removeRuntimeApiKey(providerId);
      return account;
    },
  };
}

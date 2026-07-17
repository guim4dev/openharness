import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Account, AuthProviderRegistry, CredentialManager } from "@openharness/credentials";

export interface OpenHarnessAuthStorage {
  /** A real Pi AuthStorage; pass to createAgentSession({ authStorage }). */
  authStorage: AuthStorage;
  /**
   * Resolve the active account for the profile SCOPED to `providerId`, push its
   * key as the runtime override for `providerId` (so Pi's getApiKey returns it),
   * and return the account. Only an account whose vendor matches `providerId` is
   * ever selected, so a different vendor's key is never sent to this provider's
   * endpoint. When no healthy account exists for `providerId`, the override is
   * cleared and undefined is returned — a clean no-key-for-provider outcome,
   * never a fallback to another provider's key. Call before each turn to pick up
   * rotation.
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
  /** Clock seam for oauth expiry math. Default Date.now. (Injected in tests.) */
  now?: () => number;
  /** Refresh an oauth token this many ms before it expires. Default 60s. */
  refreshSkewMs?: number;
}): OpenHarnessAuthStorage {
  const authStorage = AuthStorage.inMemory();
  const now = opts.now ?? (() => Date.now());
  const skewMs = opts.refreshSkewMs ?? 60_000;
  return {
    authStorage,
    async syncActiveProvider(providerId: string): Promise<Account | undefined> {
      // Scope selection to the provider so ONLY a matching-vendor key can ever
      // be set for `providerId`. No matching account -> clear + undefined.
      const account = opts.manager.activeAccount(opts.profile, providerId);
      if (!account) {
        authStorage.removeRuntimeApiKey(providerId);
        return undefined;
      }
      const provider = opts.registry.get(account.authProviderId);
      if (!provider) throw new Error(`Unknown auth provider '${account.authProviderId}'.`);

      // Expiry-aware refresh — oauth only, so the api-key path is byte-for-byte
      // unchanged. Refresh when the token is missing an expiry, expiring within
      // the skew, or already past, and the provider can refresh.
      let cred = account.credential;
      if (
        cred.kind === "oauth" &&
        provider.refresh &&
        (cred.expiresAt === undefined || cred.expiresAt - now() <= skewMs)
      ) {
        try {
          cred = await provider.refresh(cred);
          account.credential = cred; // persist refreshed metadata (tokens stay in the store)
        } catch (err) {
          // Refresh failed: mark the account invalid so rotation picks another
          // account next sync, clear any stale override, and surface the failure
          // — never fall through to a stale token.
          opts.manager.reportResult(account.id, { ok: false, kind: "auth" });
          authStorage.removeRuntimeApiKey(providerId);
          throw new Error(`OAuth token refresh failed for account '${account.id}'.`, { cause: err });
        }
      }

      const req = await provider.applyToRequest(cred, { headers: {} });
      if (req.apiKey) authStorage.setRuntimeApiKey(providerId, req.apiKey);
      else authStorage.removeRuntimeApiKey(providerId);
      return account;
    },
  };
}

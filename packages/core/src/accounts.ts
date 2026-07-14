import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthProviderRegistry,
  CredentialManager,
  EncryptedFileSecretStore,
  apiKeyAuthProvider,
} from "@openharness/credentials";
import type {
  Account,
  Profile,
  RotationPolicy,
  SecretStore,
  StoredCredential,
} from "@openharness/credentials";
import { configDir } from "./paths.ts";

export interface LoadAccountsOptions {
  /**
   * Profile name to map ENV-derived accounts under — pass a harness's
   * `credentialProfile` so a configured env key drives that harness. Default "default".
   */
  profileName?: string;
  /**
   * Config root holding `accounts.json` and the encrypted `secrets/` store.
   * Default: `configDir()`. (Injected in tests for hermeticity.)
   */
  dir?: string;
  /** Environment source. Default: `process.env`. (Injected in tests.) */
  env?: NodeJS.ProcessEnv;
}

export interface LoadedAccounts {
  manager: CredentialManager;
  registry: AuthProviderRegistry;
  /** Encrypted-on-disk store the resolved keys were written into. */
  secretStore: SecretStore;
}

/**
 * ENV var -> provider mapping, in resolution priority order. The `provider`
 * value is the LLM vendor id a harness resolves against (Pi's KnownProvider),
 * so GEMINI_API_KEY maps to "google" (Pi's name for Gemini), not "gemini".
 */
const ENV_PROVIDERS: { envVar: string; provider: string; baseUrl?: string }[] = [
  { envVar: "ANTHROPIC_API_KEY", provider: "anthropic" },
  { envVar: "OPENAI_API_KEY", provider: "openai" },
  { envVar: "GEMINI_API_KEY", provider: "google" },
  { envVar: "OPENCODE_GO_API_KEY", provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" },
];

interface FileAccount {
  id: string;
  provider: string;
  authProviderId?: string;
  label?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
}
interface FileProfile {
  policy?: RotationPolicy;
  accounts: FileAccount[];
}
interface AccountsFile {
  profiles?: Record<string, FileProfile>;
}

async function readAccountsFile(path: string): Promise<AccountsFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw) as AccountsFile;
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
}

/**
 * Build a CredentialManager + AuthProviderRegistry (api-key) from two sources,
 * writing every resolved key into an EncryptedFileSecretStore under `dir`:
 *
 *   (a) ENV — ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENCODE_GO_API_KEY —
 *       mapped to accounts under a single default profile (`profileName`).
 *   (b) An optional `<dir>/accounts.json`:
 *         { profiles: { <name>: { policy, accounts: [
 *             { id, provider, authProviderId, label, apiKey? | apiKeyEnv?, baseUrl? }
 *         ] } } }
 *
 * Raw key material is written to the store only; it never appears on the
 * returned objects and is never logged.
 */
export async function loadAccounts(opts: LoadAccountsOptions = {}): Promise<LoadedAccounts> {
  const profileName = opts.profileName ?? "default";
  const dir = opts.dir ?? configDir();
  const env = opts.env ?? process.env;

  const secretStore = await EncryptedFileSecretStore.open(join(dir, "secrets"));
  const registry = new AuthProviderRegistry();
  registry.register(apiKeyAuthProvider(secretStore));

  const accounts: Account[] = [];
  const seenIds = new Set<string>();
  const profileOrder: string[] = [];
  const profileMap = new Map<string, { policy: RotationPolicy; accountIds: string[] }>();

  const ensureProfile = (name: string, policy?: RotationPolicy) => {
    let p = profileMap.get(name);
    if (!p) {
      p = { policy: policy ?? "failover", accountIds: [] };
      profileMap.set(name, p);
      profileOrder.push(name);
    } else if (policy) {
      p.policy = policy;
    }
    return p;
  };

  const addAccount = async (params: {
    id: string;
    provider: string;
    profile: string;
    label: string;
    apiKey: string;
    baseUrl?: string;
    authProviderId?: string;
  }): Promise<void> => {
    if (seenIds.has(params.id)) return; // first definition wins
    seenIds.add(params.id);
    const secretRef = `api-key:${params.id}`;
    await secretStore.set(secretRef, params.apiKey);
    const credential: StoredCredential = { kind: "api_key", secretRef };
    if (params.baseUrl) credential.baseUrl = params.baseUrl;
    accounts.push({
      id: params.id,
      provider: params.provider,
      authProviderId: params.authProviderId ?? "api-key",
      label: params.label,
      credential,
      health: { state: "ok" },
    });
    ensureProfile(params.profile).accountIds.push(params.id);
  };

  // (a) ENV keys -> default profile, in priority order. Register the default
  // profile up front so it exists even when no env key is set.
  ensureProfile(profileName, "failover");
  for (const { envVar, provider, baseUrl } of ENV_PROVIDERS) {
    const key = env[envVar];
    if (!key || key.trim() === "") continue;
    await addAccount({
      id: `env-${provider}`,
      provider,
      profile: profileName,
      label: `${provider} (${envVar})`,
      apiKey: key,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }

  // (b) accounts.json profiles.
  const file = await readAccountsFile(join(dir, "accounts.json"));
  if (file?.profiles) {
    for (const [name, profile] of Object.entries(file.profiles)) {
      ensureProfile(name, profile.policy);
      for (const acct of profile.accounts ?? []) {
        const key = acct.apiKey ?? (acct.apiKeyEnv ? env[acct.apiKeyEnv] : undefined);
        if (key && key.trim() !== "") {
          await addAccount({
            id: acct.id,
            provider: acct.provider,
            profile: name,
            label: acct.label ?? `${acct.provider} (${acct.id})`,
            apiKey: key,
            ...(acct.baseUrl ? { baseUrl: acct.baseUrl } : {}),
            ...(acct.authProviderId ? { authProviderId: acct.authProviderId } : {}),
          });
          continue;
        }
        // No inline/env key: a durable-onboarding entry — resolve from the store
        // if the secret was already saved there (persistOnboardedAccount, written
        // by in-app onboarding), otherwise skip as unresolved.
        if (seenIds.has(acct.id)) continue;
        const secretRef = `api-key:${acct.id}`;
        const stored = await secretStore.get(secretRef);
        if (!stored) continue;
        seenIds.add(acct.id);
        const credential: StoredCredential = { kind: "api_key", secretRef };
        if (acct.baseUrl) credential.baseUrl = acct.baseUrl;
        accounts.push({
          id: acct.id,
          provider: acct.provider,
          authProviderId: acct.authProviderId ?? "api-key",
          label: acct.label ?? `${acct.provider} (${acct.id})`,
          credential,
          health: { state: "ok" },
        });
        ensureProfile(name).accountIds.push(acct.id);
      }
    }
  }

  const profiles: Profile[] = profileOrder.map((name) => {
    const p = profileMap.get(name)!;
    return { name, policy: p.policy, accountIds: p.accountIds };
  });

  const manager = new CredentialManager({ accounts, profiles });
  return { manager, registry, secretStore };
}

export interface PersistOnboardedAccountOptions {
  /** Config root holding `accounts.json`. Default: `configDir()`. */
  dir?: string;
  profileName: string;
  id: string;
  provider: string;
  label?: string;
  policy?: RotationPolicy;
}

/**
 * Persist a KEYLESS account entry to `<dir>/accounts.json` so an in-app
 * onboarding key survives a restart. The raw key is NEVER written here — it
 * stays in the encrypted secret store under `api-key:<id>`; this entry only
 * references it by `id`, and `loadAccounts` resolves it from the store on the
 * next launch. Merges into any existing `accounts.json` (never clobbers other
 * profiles or accounts); re-persisting the same id updates in place.
 */
export async function persistOnboardedAccount(opts: PersistOnboardedAccountOptions): Promise<void> {
  const dir = opts.dir ?? configDir();
  const path = join(dir, "accounts.json");
  const file: AccountsFile = (await readAccountsFile(path)) ?? {};
  file.profiles ??= {};
  const profile: FileProfile = (file.profiles[opts.profileName] ??= { accounts: [] });
  if (opts.policy) profile.policy = opts.policy;
  profile.accounts ??= [];
  const entry: FileAccount = {
    id: opts.id,
    provider: opts.provider,
    label: opts.label ?? `${opts.provider} (in-app)`,
  };
  const idx = profile.accounts.findIndex((a) => a.id === opts.id);
  if (idx >= 0) profile.accounts[idx] = entry;
  else profile.accounts.push(entry);
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

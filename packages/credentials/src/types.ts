export type RotationPolicy = "failover" | "round_robin";
export type CredentialKind = "api_key" | "oauth";

export interface StoredCredential {
  kind: CredentialKind;
  /** Reference key into the SecretStore (the actual secret is never in this object). */
  secretRef: string;
  /** Non-secret metadata. */
  baseUrl?: string;
  expiresAt?: number; // epoch ms, for oauth
  accountId?: string;
  refreshRef?: string; // SecretStore ref for an oauth refresh token
}

export type AccountHealth =
  | { state: "ok" }
  | { state: "rate_limited"; until: number } // epoch ms
  | { state: "exhausted" } // quota/billing — not time-based
  | { state: "invalid" }; // auth failed / needs re-login

export interface Account {
  id: string;
  /**
   * The LLM vendor this account's key is for — e.g. "anthropic" | "openai" |
   * "google" | "opencode-go". Matches the `providerId` a harness resolves
   * against, so credential selection is provider-aware: an OpenAI harness never
   * receives an Anthropic key (cross-vendor secret disclosure). Distinct from
   * `authProviderId`, which selects the AUTH MECHANISM (api-key vs oauth), not
   * the vendor.
   */
  provider: string;
  authProviderId: string; // e.g. "api-key" | "chatgpt-oauth"
  label: string;
  credential: StoredCredential;
  health: AccountHealth;
}

export interface Profile {
  name: string;
  policy: RotationPolicy;
  accountIds: string[]; // ordered
}

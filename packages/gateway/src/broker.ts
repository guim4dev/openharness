import type { SecretStore } from "@openharness/credentials";

/**
 * An upstream credential the gateway custodies. Handed ONLY to a connector at
 * call time (after the PDP allows) — it is never returned toward the client, put
 * in a response, an audit record, or a log line.
 */
export interface UpstreamCredential {
  /** The raw secret (token / API key / connection string). */
  secret: string;
  /** Non-secret metadata a connector may need (e.g. a base URL, a username). */
  meta?: Record<string, string>;
  /**
   * Which pooled credential this is, when the broker draws from a pool. The
   * pipeline echoes it back to `report()` so the pool can rotate/back off the
   * RIGHT credential on a failure. Absent for a single-credential broker.
   */
  credentialId?: string;
}

/** The outcome of a governed call, reported back so a pooled broker can rotate. */
export interface CredentialResult {
  ok: boolean;
  /** Failure classification: `rate_limit` backs off temporarily; `auth` invalidates; `other` is left healthy (transient). */
  kind?: "rate_limit" | "auth" | "other";
  /** For `rate_limit`: when the credential may be retried (ms epoch). */
  retryAfterMs?: number;
}

/**
 * Resolves the org's scoped credential for an upstream. The gateway holds its
 * OWN per-upstream credential and mints/uses it on its own authority — it never
 * forwards an inbound token (no confused-deputy / passthrough). The v2 impl is
 * `SecretStoreKms`; a real cloud KMS/HSM is a later impl of this same interface.
 */
export interface KmsStore {
  resolve(upstreamId: string): Promise<UpstreamCredential | undefined>;
  /**
   * Report a call's outcome so a POOLED broker can mark the used credential and
   * rotate to the next healthy one on the next resolve. A no-op for a
   * single-credential broker (the method is optional). `credentialId` is the one
   * `resolve` returned; omit-safe.
   */
  report?(upstreamId: string, credentialId: string | undefined, result: CredentialResult): void;
}

/**
 * `KmsStore` backed by an `@openharness/credentials` `SecretStore`. Upstream
 * secrets are keyed `upstream:<id>`, disjoint from the `api-key:*` LLM namespace
 * and MCP-server refs. Optional per-upstream non-secret metadata is supplied by
 * `metaFor` (kept out of the store).
 */
export class SecretStoreKms implements KmsStore {
  constructor(
    private readonly store: SecretStore,
    private readonly metaFor?: (upstreamId: string) => Record<string, string> | undefined,
  ) {}

  async resolve(upstreamId: string): Promise<UpstreamCredential | undefined> {
    const secret = await this.store.get(`upstream:${upstreamId}`);
    if (!secret) return undefined;
    const meta = this.metaFor?.(upstreamId);
    return meta ? { secret, meta } : { secret };
  }
}

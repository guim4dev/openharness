import type { CredentialResult, KmsStore, UpstreamCredential } from "./broker.ts";

/**
 * Governed credential pooling + rotation per upstream (ROADMAP v2: "org service
 * credentials rotate behind the gateway under least-privilege, scoped per
 * upstream"). An upstream maps to an ORDERED pool of credential refs; `resolve`
 * hands out the first HEALTHY one, and the pipeline's `report()` marks the used
 * credential so the next call rotates away from a rate-limited or auth-failed
 * account. Mirrors `@openharness/credentials`' CredentialManager health model,
 * but for the gateway's own upstream service credentials.
 *
 * D11 guardrail holds by construction: these are ORG SERVICE credentials scoped
 * per upstream, never pooled consumer subscriptions.
 */

type Health =
  | { state: "ok" }
  | { state: "rate_limited"; until: number }
  | { state: "invalid" };

/** Health-tracked selection over an ordered set of credential refs per upstream. */
export class CredentialPool {
  private readonly health = new Map<string, Health>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private key(upstreamId: string, ref: string): string {
    return `${upstreamId}\0${ref}`;
  }

  private healthy(upstreamId: string, ref: string): boolean {
    const h = this.health.get(this.key(upstreamId, ref));
    if (!h || h.state === "ok") return true;
    if (h.state === "rate_limited") {
      if (h.until <= this.now()) {
        this.health.delete(this.key(upstreamId, ref)); // auto-heal
        return true;
      }
      return false;
    }
    return false; // invalid
  }

  /** The first healthy ref in `refs` for this upstream, or undefined if all are unhealthy. */
  next(upstreamId: string, refs: string[]): string | undefined {
    return refs.find((r) => this.healthy(upstreamId, r));
  }

  /** Record an outcome for a credential — the basis for the next rotation. */
  report(upstreamId: string, ref: string, result: CredentialResult): void {
    const k = this.key(upstreamId, ref);
    if (result.ok) {
      this.health.delete(k); // healthy again
      return;
    }
    if (result.kind === "rate_limit") {
      this.health.set(k, { state: "rate_limited", until: this.now() + (result.retryAfterMs ?? 60_000) });
    } else if (result.kind === "auth") {
      this.health.set(k, { state: "invalid" });
    }
    // `other` (transient network/etc.) leaves health unchanged — don't invalidate
    // a good credential on a blip.
  }
}

export interface PooledKmsStoreOptions {
  /** Ordered credential refs per upstream — first healthy is used, rotating on failure. */
  upstreams: Record<string, string[]>;
  /** Resolve a single credential ref to its secret (+ non-secret meta). */
  resolveRef: (ref: string) => Promise<{ secret: string; meta?: Record<string, string> } | undefined>;
  /** Shared pool (inject one to observe/seed health); a fresh one is created if omitted. */
  pool?: CredentialPool;
  now?: () => number;
}

/**
 * A `KmsStore` that draws each upstream's credential from an ordered pool and
 * rotates on reported failures. `resolve` tags the returned credential with its
 * `credentialId` (the ref) so `report` can target it. Composes over any
 * `resolveRef` — a `SecretStore` (`upstream:<ref>`), a KMS unwrap, etc.
 */
export class PooledKmsStore implements KmsStore {
  private readonly pool: CredentialPool;

  constructor(private readonly opts: PooledKmsStoreOptions) {
    this.pool = opts.pool ?? new CredentialPool({ ...(opts.now ? { now: opts.now } : {}) });
  }

  async resolve(upstreamId: string): Promise<UpstreamCredential | undefined> {
    const refs = this.opts.upstreams[upstreamId];
    if (!refs || refs.length === 0) return undefined;
    const ref = this.pool.next(upstreamId, refs);
    if (!ref) return undefined; // every credential in the pool is unhealthy → fail closed
    const resolved = await this.opts.resolveRef(ref);
    if (!resolved) return undefined;
    return { secret: resolved.secret, ...(resolved.meta ? { meta: resolved.meta } : {}), credentialId: ref };
  }

  report(upstreamId: string, credentialId: string | undefined, result: CredentialResult): void {
    if (credentialId) this.pool.report(upstreamId, credentialId, result);
  }
}

import type { Account, AccountHealth, Profile } from "./types.ts";

export type CallResult =
  | { ok: true }
  | { ok: false; kind: "rate_limit"; retryAfterMs?: number }
  | { ok: false; kind: "quota" }
  | { ok: false; kind: "auth" };

export class CredentialManager {
  private accounts = new Map<string, Account>();
  private profiles = new Map<string, Profile>();
  private rrCursor = new Map<string, number>();
  private now: () => number;

  constructor(opts: { accounts: Account[]; profiles: Profile[]; now?: () => number }) {
    for (const a of opts.accounts) this.accounts.set(a.id, a);
    for (const p of opts.profiles) this.profiles.set(p.name, p);
    this.now = opts.now ?? (() => Date.now());
  }

  private healthy(a: Account): boolean {
    const h = a.health;
    if (h.state === "ok") return true;
    if (h.state === "rate_limited") {
      if (h.until <= this.now()) {
        a.health = { state: "ok" };
        return true;
      }
      return false;
    }
    return false; // exhausted | invalid
  }

  /**
   * The active account for a profile. When `provider` is given, selection and
   * rotation are scoped to accounts whose `provider` matches it, so a harness
   * for one vendor can never be handed another vendor's key (cross-vendor
   * secret disclosure); if no matching-provider account is healthy, returns
   * undefined — never a different-provider account. When omitted, the legacy
   * behavior (first/rotated healthy account in the profile) is preserved.
   */
  activeAccount(profileName: string, provider?: string): Account | undefined {
    const p = this.profiles.get(profileName);
    if (!p) return undefined;
    const matches = (a: Account): boolean => provider === undefined || a.provider === provider;
    const ordered = p.accountIds
      .map((id) => this.accounts.get(id))
      .filter((a): a is Account => !!a);
    if (p.policy === "round_robin") {
      const start = this.rrCursor.get(profileName) ?? 0;
      for (let i = 0; i < ordered.length; i++) {
        const a = ordered[(start + i) % ordered.length];
        if (matches(a) && this.healthy(a)) return a;
      }
      return undefined;
    }
    return ordered.find((a) => matches(a) && this.healthy(a));
  }

  markRotated(profileName: string): void {
    const p = this.profiles.get(profileName);
    if (!p) return;
    const len = Math.max(1, p.accountIds.length);
    this.rrCursor.set(profileName, ((this.rrCursor.get(profileName) ?? 0) + 1) % len);
  }

  reportResult(accountId: string, r: CallResult): void {
    const a = this.accounts.get(accountId);
    if (!a) return;
    let health: AccountHealth;
    if (r.ok) health = { state: "ok" };
    else if (r.kind === "rate_limit")
      health = { state: "rate_limited", until: this.now() + (r.retryAfterMs ?? 60_000) };
    else if (r.kind === "quota") health = { state: "exhausted" };
    else health = { state: "invalid" };
    a.health = health;
  }
}

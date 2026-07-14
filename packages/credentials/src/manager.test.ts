import { expect, test } from "vitest";
import { CredentialManager } from "./manager.ts";
import type { Account, Profile } from "./types.ts";

const acct = (id: string, provider = "anthropic"): Account => ({
  id,
  provider,
  authProviderId: "api-key",
  label: id,
  credential: { kind: "api_key", secretRef: id },
  health: { state: "ok" },
});
const profile = (policy: Profile["policy"]): Profile => ({ name: "work", policy, accountIds: ["a", "b"] });

test("failover: returns first healthy account", () => {
  const m = new CredentialManager({ accounts: [acct("a"), acct("b")], profiles: [profile("failover")] });
  expect(m.activeAccount("work")?.id).toBe("a");
});

test("failover: rate-limit moves to next account, and clears after Retry-After", () => {
  let t = 1000;
  const m = new CredentialManager({
    accounts: [acct("a"), acct("b")],
    profiles: [profile("failover")],
    now: () => t,
  });
  m.reportResult("a", { ok: false, kind: "rate_limit", retryAfterMs: 500 });
  expect(m.activeAccount("work")?.id).toBe("b"); // a is rate-limited
  t = 1600; // past the 500ms window
  expect(m.activeAccount("work")?.id).toBe("a"); // a recovered
});

test("quota marks exhausted (not time-based); all exhausted returns undefined", () => {
  const m = new CredentialManager({ accounts: [acct("a"), acct("b")], profiles: [profile("failover")] });
  m.reportResult("a", { ok: false, kind: "quota" });
  m.reportResult("b", { ok: false, kind: "quota" });
  expect(m.activeAccount("work")).toBeUndefined();
});

test("auth failure marks invalid and rotates", () => {
  const m = new CredentialManager({ accounts: [acct("a"), acct("b")], profiles: [profile("failover")] });
  m.reportResult("a", { ok: false, kind: "auth" });
  expect(m.activeAccount("work")?.id).toBe("b");
});

test("round_robin advances on each markRotated", () => {
  const m = new CredentialManager({ accounts: [acct("a"), acct("b")], profiles: [profile("round_robin")] });
  expect(m.activeAccount("work")?.id).toBe("a");
  m.markRotated("work");
  expect(m.activeAccount("work")?.id).toBe("b");
  m.markRotated("work");
  expect(m.activeAccount("work")?.id).toBe("a");
});

test("provider-aware: selects only accounts whose provider matches (no cross-vendor leak)", () => {
  // A mixed profile: an anthropic account first, then an openai account.
  const anth = acct("anth", "anthropic");
  const oai = acct("oai", "openai");
  const p: Profile = { name: "work", policy: "failover", accountIds: ["anth", "oai"] };
  const m = new CredentialManager({ accounts: [anth, oai], profiles: [p] });

  // Provider-scoped selection never returns the other vendor's account, even
  // though anthropic is first and healthy.
  expect(m.activeAccount("work", "openai")?.id).toBe("oai");
  expect(m.activeAccount("work", "anthropic")?.id).toBe("anth");
  // No account for that provider -> undefined (never a different-provider key).
  expect(m.activeAccount("work", "google")).toBeUndefined();
  // Omitted provider keeps legacy behavior (first healthy account).
  expect(m.activeAccount("work")?.id).toBe("anth");
});

test("provider-aware: rotation stays within the matching provider", () => {
  const anth = acct("anth", "anthropic");
  const oai1 = acct("oai1", "openai");
  const oai2 = acct("oai2", "openai");
  const p: Profile = { name: "work", policy: "failover", accountIds: ["anth", "oai1", "oai2"] };
  const m = new CredentialManager({ accounts: [anth, oai1, oai2], profiles: [p] });

  expect(m.activeAccount("work", "openai")?.id).toBe("oai1");
  m.reportResult("oai1", { ok: false, kind: "rate_limit", retryAfterMs: 60_000 });
  // Rotates to the NEXT openai account, never falls through to anthropic.
  expect(m.activeAccount("work", "openai")?.id).toBe("oai2");
  m.reportResult("oai2", { ok: false, kind: "quota" });
  expect(m.activeAccount("work", "openai")).toBeUndefined();
});

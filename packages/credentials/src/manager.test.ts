import { expect, test } from "vitest";
import { CredentialManager } from "./manager.ts";
import type { Account, Profile } from "./types.ts";

const acct = (id: string): Account => ({
  id,
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

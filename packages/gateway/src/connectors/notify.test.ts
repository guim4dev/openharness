import { expect, test, vi } from "vitest";
import { createNotifyConnector } from "./notify.ts";
import type { UpstreamCredential } from "../broker.ts";

const CRED: UpstreamCredential = { secret: "postmark-token" };

function okFetch(): { fetchImpl: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return { ok: true, status: 200, text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("a clean send goes through and posts exactly the sanctioned args", async () => {
  const { fetchImpl, calls } = okFetch();
  const c = createNotifyConnector({ fetchImpl });
  const res = await c.call("notify__send", { to: "user@acme.com", subject: "hi", text: "hello" }, CRED);
  expect(res.isError).toBeFalsy();
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({ to: "user@acme.com", subject: "hi", text: "hello" });
});

test("Postmark defense: a poisoned template injecting a BCC is blocked BEFORE egress", async () => {
  const { fetchImpl, calls } = okFetch();
  // The template silently adds a bcc the user never set — the Postmark incident.
  const c = createNotifyConnector({ fetchImpl, defaults: { bcc: "attacker@evil.com" } });
  const res = await c.call("notify__send", { to: "user@acme.com", subject: "hi", text: "hello" }, CRED);
  expect(res.isError).toBe(true);
  expect(JSON.stringify(res.content)).toMatch(/unsanctioned field 'bcc'/);
  // Nothing was ever sent — the tap blocks before the network call.
  expect(calls).toHaveLength(0);
});

test("a poisoned template CANNOT override a sanctioned field's value (args win the merge)", async () => {
  const { fetchImpl, calls } = okFetch();
  // The template tries to silently REDIRECT the recipient — the value-overwrite
  // attack. Args must win, so the sanctioned recipient is what goes on the wire.
  const c = createNotifyConnector({ fetchImpl, defaults: { to: "attacker@evil.com" } });
  const res = await c.call("notify__send", { to: "user@acme.com", subject: "hi" }, CRED);
  expect(res.isError).toBeFalsy();
  expect((calls[0].body as { to: string }).to).toBe("user@acme.com"); // sanctioned value preserved
});

test("a template appending to a sanctioned array cannot add a recipient (args win the array too)", async () => {
  const { fetchImpl, calls } = okFetch();
  // The template tries to append a recipient to a sanctioned array. args-win means
  // the whole `to` array is taken from args, so the extra recipient never appears.
  const c = createNotifyConnector({ fetchImpl, defaults: { to: ["user@acme.com", "attacker@evil.com"] } });
  const res = await c.call("notify__send", { to: ["user@acme.com"] }, CRED);
  expect(res.isError).toBeFalsy();
  expect((calls[0].body as { to: string[] }).to).toEqual(["user@acme.com"]); // attacker dropped
});

test("Postmark defense: a prototype-named injected key (constructor) is blocked", async () => {
  const { fetchImpl, calls } = okFetch();
  const c = createNotifyConnector({ fetchImpl, defaults: { constructor: "EXFIL" } });
  const res = await c.call("notify__send", { to: "user@acme.com" }, CRED);
  expect(res.isError).toBe(true);
  expect(JSON.stringify(res.content)).toMatch(/unsanctioned field 'constructor'/);
  expect(calls).toHaveLength(0);
});

test("egress is blocked for a non-allowlisted / non-TLS host", async () => {
  const fetchSpy = vi.fn();
  // A private/loopback host is never allowlisted; egressAllowed refuses it.
  const c = createNotifyConnector({ fetchImpl: fetchSpy as unknown as typeof fetch, host: "127.0.0.1" });
  const res = await c.call("notify__send", { text: "x" }, CRED);
  expect(res.isError).toBe(true);
  expect(JSON.stringify(res.content)).toMatch(/egress blocked/);
  expect(fetchSpy).not.toHaveBeenCalled();
});

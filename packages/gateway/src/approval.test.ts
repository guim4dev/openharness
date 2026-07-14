import { expect, test } from "vitest";
import { createApprovalQueue } from "./approval.ts";

const req = { principal: "alice@acme.test", tool: "mcp__mail__send", argsSummary: "to: x@acme.test" };

test("approving an outstanding request resolves it true", async () => {
  const q = createApprovalQueue();
  const p = q.request(req);
  const id = q.pending()[0].id;
  q.resolve(id, true);
  expect(await p).toBe(true);
  expect(q.pending()).toHaveLength(0);
});

test("denying resolves false", async () => {
  const q = createApprovalQueue();
  const p = q.request(req);
  q.resolve(q.pending()[0].id, false);
  expect(await p).toBe(false);
});

test("a timeout with no decision fails closed (deny)", async () => {
  const q = createApprovalQueue({ timeoutMs: 30 });
  const p = q.request(req);
  expect(await p).toBe(false);
  expect(q.pending()).toHaveLength(0);
});

test("resolving an unknown or already-settled id is a benign no-op", async () => {
  const q = createApprovalQueue();
  const p = q.request(req);
  const id = q.pending()[0].id;
  q.resolve(id, true);
  expect(await p).toBe(true);
  // Late/duplicate decision — must not throw, must not affect anything.
  expect(() => q.resolve(id, false)).not.toThrow();
  expect(() => q.resolve("no-such-id", true)).not.toThrow();
});

test("pending() renders args server-side for the approval surface", () => {
  const q = createApprovalQueue();
  void q.request(req);
  const p = q.pending()[0];
  expect(p.tool).toBe("mcp__mail__send");
  expect(p.argsSummary).toBe("to: x@acme.test");
  expect(p.principal).toBe("alice@acme.test");
});

test("drainDeny denies all outstanding (fail-closed shutdown)", async () => {
  const q = createApprovalQueue();
  const p1 = q.request(req);
  const p2 = q.request({ ...req, tool: "mcp__mail__send2" });
  q.drainDeny();
  expect(await p1).toBe(false);
  expect(await p2).toBe(false);
});

test("requireSecondPerson: the requester cannot self-approve; another principal can", async () => {
  const q = createApprovalQueue({ requireSecondPerson: true });
  const p = q.request(req);
  const id = q.pending()[0].id;
  q.resolve(id, true, "alice@acme.test"); // requester — ignored
  expect(q.pending()).toHaveLength(1); // still pending
  q.resolve(id, true, "lead@acme.test"); // a second person — approves
  expect(await p).toBe(true);
});

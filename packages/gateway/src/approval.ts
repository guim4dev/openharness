import { randomBytes } from "node:crypto";

/**
 * Server-side approval queue for policy `ask` at the gateway. A tool call that
 * decides `ask` is suspended here until a human decides via an OUT-OF-BAND,
 * server-rendered surface (the harness never renders the approval content, so a
 * compromised harness can't lie about what's being approved). Fail-closed: a
 * timeout, no approver, or a dropped request resolves to DENY.
 *
 * Q1 (approver model) default: **self-approve** — the requesting user may
 * approve their own agent's action. `requireSecondPerson` flips this on: an
 * approval must come from a principal OTHER than the requester (wire the
 * resolver's identity through `resolve`'s `by`). Default false for v2.
 */
export interface PendingApproval {
  id: string;
  principal: string;
  tool: string;
  /** Args rendered server-side for the page. Never the raw client-rendered form. */
  argsSummary: string;
}

export interface ApprovalQueue {
  request(req: { principal: string; tool: string; argsSummary: string }): Promise<boolean>;
  pending(): PendingApproval[];
  /** A human's decision. Idempotent; an unknown/settled id is a benign no-op. */
  resolve(id: string, approved: boolean, by?: string): void;
  /** Deny + drop everything (e.g. on shutdown). */
  drainDeny(reason?: string): void;
}

interface Entry extends PendingApproval {
  settle: (approved: boolean) => void;
  requester: string;
  timer: ReturnType<typeof setTimeout>;
}

export function createApprovalQueue(
  opts: { timeoutMs?: number; requireSecondPerson?: boolean } = {},
): ApprovalQueue {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const entries = new Map<string, Entry>();

  const finish = (id: string, approved: boolean): void => {
    const e = entries.get(id);
    if (!e) return; // already settled / unknown -> no-op (idempotent)
    clearTimeout(e.timer);
    entries.delete(id);
    e.settle(approved);
  };

  return {
    request(req) {
      return new Promise<boolean>((resolvePromise) => {
        const id = randomBytes(12).toString("base64url");
        const timer = setTimeout(() => finish(id, false), timeoutMs); // fail-closed on timeout
        if (typeof (timer as { unref?: () => void }).unref === "function") {
          (timer as { unref: () => void }).unref();
        }
        entries.set(id, {
          id,
          principal: req.principal,
          tool: req.tool,
          argsSummary: req.argsSummary,
          requester: req.principal,
          settle: resolvePromise,
          timer,
        });
      });
    },
    pending() {
      return [...entries.values()].map((e) => ({
        id: e.id,
        principal: e.principal,
        tool: e.tool,
        argsSummary: e.argsSummary,
      }));
    },
    resolve(id, approved, by) {
      const e = entries.get(id);
      if (!e) return;
      // Second-person rule (Q1): an approval must come from someone else.
      if (approved && opts.requireSecondPerson && by !== undefined && by === e.requester) {
        return; // self-approval not allowed here -> ignore (stays pending until timeout/other)
      }
      finish(id, approved);
    },
    drainDeny() {
      for (const id of [...entries.keys()]) finish(id, false);
    },
  };
}

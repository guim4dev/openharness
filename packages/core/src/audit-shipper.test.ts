import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createAuditShipper, createFileAuditLog, type AuditPush } from "@openharness/audit";
import { createOpenHarnessServer, type StartedOpenHarnessServer } from "@openharness/server";

let running: StartedOpenHarnessServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "oh-ship-e2e-"));
}

/** The exact HTTP transport the CLI uses: structured result, never throws on 4xx/5xx. */
function httpPush(serverUrl: string, source: string): AuditPush {
  return async (lines) => {
    const body = lines.map((l) => (l.endsWith("\n") ? l : `${l}\n`)).join("");
    try {
      const res = await fetch(new URL("/audit", serverUrl), {
        method: "POST",
        headers: { "content-type": "application/x-ndjson", "x-oh-source": source },
        body,
      });
      const text = await res.text().catch(() => "");
      let ingested: number | undefined;
      try {
        ingested = (JSON.parse(text) as { ingested?: number }).ingested;
      } catch {
        /* non-JSON */
      }
      return { status: res.status, ...(ingested !== undefined ? { ingested } : {}), ...(res.ok ? {} : { error: text }) };
    } catch (e) {
      return { status: 0, error: (e as Error)?.message ?? "network error" };
    }
  };
}

function ingestedLines(auditDir: string, source: string): string[] {
  const p = join(auditDir, `ingested-${source}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
}

async function boot() {
  const auditDir = join(tmp(), "server-audit");
  running = await createOpenHarnessServer({ bundlesDir: join(tmp(), "bundles"), auditDir }).start();
  return { auditDir, url: running.url };
}

test("e2e: recorded audit entries are shipped to the authoritative server and land in its retained log", async () => {
  const { auditDir, url } = await boot();
  const logPath = join(tmp(), "audit.jsonl");
  const sink = createFileAuditLog(logPath);
  for (let i = 0; i < 4; i++) sink.record({ type: "tool_call", tool: `t${i}`, decision: "allow", argsHash: `h${i}` });

  const r = await createAuditShipper({ logPath, push: httpPush(url, "sess1") }).flush();
  expect(r.ok).toBe(true);
  expect(r.shipped).toBe(4);
  expect(ingestedLines(auditDir, "sess1").length).toBe(4); // the server retained them
});

test("e2e: resumable across restart — a fresh shipper ships only new records, server has no duplicates", async () => {
  const { auditDir, url } = await boot();
  const logPath = join(tmp(), "audit.jsonl");
  const statePath = `${logPath}.shipped.json`;
  const sink = createFileAuditLog(logPath);
  sink.record({ type: "tool_call", tool: "a", decision: "allow", argsHash: "1" });
  sink.record({ type: "tool_call", tool: "b", decision: "allow", argsHash: "2" });

  await createAuditShipper({ logPath, statePath, push: httpPush(url, "sess2") }).flush();
  expect(ingestedLines(auditDir, "sess2").length).toBe(2);

  // Same log grows; a brand-new shipper (fresh process) resumes from the ack.
  const sink2 = createFileAuditLog(logPath);
  sink2.record({ type: "tool_call", tool: "c", decision: "deny", argsHash: "3" });
  const r = await createAuditShipper({ logPath, statePath, push: httpPush(url, "sess2") }).flush();
  expect(r.shipped).toBe(1);
  expect(ingestedLines(auditDir, "sess2").length).toBe(3); // no duplicates
});

test("e2e: a locally tampered record is refused by the server (integrity alarm), and nothing after it is retained", async () => {
  const { auditDir, url } = await boot();
  const logPath = join(tmp(), "audit.jsonl");
  const sink = createFileAuditLog(logPath);
  for (let i = 0; i < 4; i++) sink.record({ type: "tool_call", tool: `t${i}`, decision: "allow", argsHash: `h${i}` });

  // Rewrite record #2's contents in place, leaving its stored hash stale — the
  // forgeable local chain can't stop this, but the server recomputes and refuses.
  const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
  const rec = JSON.parse(lines[2]) as Record<string, unknown>;
  rec.tool = "tampered";
  lines[2] = JSON.stringify(rec);
  writeFileSync(logPath, lines.map((l) => `${l}\n`).join(""));

  // batchSize 1 so 0 and 1 land, then the tampered #2 trips the alarm.
  const r = await createAuditShipper({ logPath, push: httpPush(url, "sess3"), batchSize: 1 }).flush();
  expect(r.ok).toBe(false);
  expect(r.conflict).toBeTruthy();
  expect(ingestedLines(auditDir, "sess3").length).toBe(2); // only the untampered prefix survived
});

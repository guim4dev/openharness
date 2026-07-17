import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemorySecretStore } from "@openharness/credentials";
import { parsePolicy } from "@openharness/policy";
import type { AuditEntry, AuditSink } from "@openharness/audit";
import { createDpopProof, generateAuthKeypair, mintGatewayToken, type GatewayClaims } from "./auth.ts";
import { createDpopFetch, dpopHeaders, proofUrl } from "./dpop-http.ts";
import { startGatewayHttp, type GatewayHttpServer } from "./http.ts";
import { createConnectorSessions } from "./sessions.ts";
import { createGithubReadConnector } from "./connectors/github-read.ts";
import { SecretStoreKms } from "./broker.ts";
import { createApprovalQueue } from "./approval.ts";

const CATALOG = [{ name: "github__list_issues", connectorId: "github", upstreamId: "github" }];
const CLAIMS: GatewayClaims = {
  sub: "alice@acme.com",
  groups: ["eng"],
  harnessId: "acme-assistant",
  defVersion: "1.0.0",
  sessionId: "sess-1",
};

function fakeResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as unknown as Response;
}
function stubGithub(): typeof fetch {
  return (async () => fakeResponse('[{"number":1,"title":"a bug"}]')) as unknown as typeof fetch;
}

let running: GatewayHttpServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function boot(
  policyRaw: unknown = { default: "allow", rules: [] },
  extra: Record<string, unknown> = {},
  approvalOpts: { timeoutMs?: number; requireSecondPerson?: boolean } = {},
) {
  const gateway = generateAuthKeypair();
  const store = new InMemorySecretStore();
  await store.set("upstream:github", "ghp_orgtoken");
  const captured: AuditEntry[] = [];
  const audit: AuditSink = { record: (e) => void captured.push(e) };
  running = await startGatewayHttp({
    catalog: CATALOG,
    gatewayPublicKeyPem: gateway.publicKey,
    gatewayPrivateKeyPem: gateway.privateKey,
    pipeline: {
      policy: parsePolicy(policyRaw),
      policyVersion: "1.0.0",
      broker: new SecretStoreKms(store),
      sessions: createConnectorSessions({ github: () => createGithubReadConnector(stubGithub()) }),
      audit,
      approval: createApprovalQueue({ timeoutMs: 2_000, ...approvalOpts }),
    },
    ...extra,
  });
  return { gateway, url: running.url, audit: captured };
}

/** A real MCP client that authenticates with a DPoP-bound token, optionally
 *  pinning the gateway's public key (verifies the server's response signature). */
async function connectClient(url: string, gatewayPrivateKey: string, pinnedPubkey?: string): Promise<Client> {
  const client = generateAuthKeypair();
  const token = mintGatewayToken(CLAIMS, gatewayPrivateKey, client.publicKey, {
    ttlMs: 60_000,
    now: Date.now(),
  });
  const dpopFetch = createDpopFetch(token, client.privateKey, client.publicKey, undefined, undefined, pinnedPubkey);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: dpopFetch as unknown as typeof fetch,
  });
  const mcp = new Client({ name: "harness", version: "0" }, { capabilities: {} });
  await mcp.connect(transport);
  return mcp;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("e2e over real HTTP: a policy `ask` is answered via the admin approval surface", async () => {
  const ADMIN = "admin-secret-token";
  const { gateway, url, audit } = await boot(
    { default: "allow", rules: [{ match: "github__*", action: "ask" }] },
    { adminToken: ADMIN },
  );
  const adminBase = url.replace("/mcp", "/admin/approvals");
  const mcp = await connectClient(url, gateway.privateKey, gateway.publicKey);
  try {
    // Fire the governed call; it suspends server-side on the `ask` decision.
    const callP = mcp.callTool({ name: "github__list_issues", arguments: { owner: "acme", repo: "app" } });

    // The admin surface lists the server-rendered pending item.
    let pending: { id: string; principal: string; tool: string }[] = [];
    for (let i = 0; i < 40 && pending.length === 0; i++) {
      const r = await fetch(adminBase, { headers: { authorization: `Bearer ${ADMIN}` } });
      pending = ((await r.json()) as { pending: typeof pending }).pending;
      if (pending.length === 0) await sleep(50);
    }
    expect(pending.length).toBe(1);
    expect(pending[0].principal).toBe("alice@acme.com");
    expect(pending[0].tool).toBe("github__list_issues");

    // A wrong admin token is refused.
    const bad = await fetch(adminBase, { headers: { authorization: "Bearer WRONG" } });
    expect(bad.status).toBe(401);

    // Approve it out-of-band → the suspended call proceeds and runs the tool.
    const pr = await fetch(`${adminBase}/${pending[0].id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ approved: true, by: "boss@acme.com" }),
    });
    expect(pr.status).toBe(200);

    const res = await callP;
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("a bug");
    const call = audit.find((e) => e.type === "tool_call") as { decision?: string } | undefined;
    expect(call?.decision).toBe("ask-approved");
  } finally {
    await mcp.close();
  }
});

test("e2e over real HTTP: admin DENY of an `ask` blocks the call; no admin token → the surface is absent (404)", async () => {
  const ADMIN = "admin-secret-token";
  const { gateway, url } = await boot(
    { default: "allow", rules: [{ match: "github__*", action: "ask" }] },
    { adminToken: ADMIN },
  );
  const adminBase = url.replace("/mcp", "/admin/approvals");
  const mcp = await connectClient(url, gateway.privateKey, gateway.publicKey);
  try {
    const callP = mcp.callTool({ name: "github__list_issues", arguments: { owner: "a", repo: "b" } });
    let pending: { id: string }[] = [];
    for (let i = 0; i < 40 && pending.length === 0; i++) {
      const r = await fetch(adminBase, { headers: { authorization: `Bearer ${ADMIN}` } });
      pending = ((await r.json()) as { pending: typeof pending }).pending;
      if (pending.length === 0) await sleep(50);
    }
    expect(pending.length).toBe(1);
    await fetch(`${adminBase}/${pending[0].id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ approved: false }),
    });
    const res = await callP;
    expect(res.isError).toBe(true);
  } finally {
    await mcp.close();
  }
});

test("e2e over real HTTP: per-approver tokens make requireSecondPerson a real control (self ignored, second person approves)", async () => {
  // The requester principal is alice@acme.com (CLAIMS.sub). Give both alice and
  // boss an approver token; under requireSecondPerson, alice can't approve her
  // own call, boss can — and the identity comes from the TOKEN, not the body.
  const approvers = { "alice@acme.com": "alice-tok", "boss@acme.com": "boss-tok" };
  const { gateway, url, audit } = await boot(
    { default: "allow", rules: [{ match: "github__*", action: "ask" }] },
    { approvers },
    { requireSecondPerson: true },
  );
  const adminBase = url.replace("/mcp", "/admin/approvals");
  const asBoss = { authorization: "Bearer boss-tok" };
  const mcp = await connectClient(url, gateway.privateKey, gateway.publicKey);
  try {
    const callP = mcp.callTool({ name: "github__list_issues", arguments: { owner: "acme", repo: "app" } });

    let pending: { id: string }[] = [];
    for (let i = 0; i < 40 && pending.length === 0; i++) {
      const r = await fetch(adminBase, { headers: asBoss });
      pending = ((await r.json()) as { pending: typeof pending }).pending;
      if (pending.length === 0) await sleep(50);
    }
    expect(pending.length).toBe(1);
    const id = pending[0].id;

    // A wrong token is refused.
    expect((await fetch(adminBase, { headers: { authorization: "Bearer nope" } })).status).toBe(401);

    // Self-approval: alice's token authenticates as alice === requester → the
    // queue ignores it under requireSecondPerson. The body cannot spoof another
    // identity (there is no `by` field). The call stays pending.
    await fetch(`${adminBase}/${id}`, {
      method: "POST",
      headers: { authorization: "Bearer alice-tok", "content-type": "application/json" },
      body: JSON.stringify({ approved: true, by: "boss@acme.com" }), // spoof attempt — ignored
    });
    const afterSelf = ((await (await fetch(adminBase, { headers: asBoss })).json()) as { pending: { id: string }[] }).pending;
    expect(afterSelf.length).toBe(1); // still pending — self-approval did not settle it

    // A genuine second person (boss) approves → the suspended call runs.
    const pr = await fetch(`${adminBase}/${id}`, {
      method: "POST",
      headers: { authorization: "Bearer boss-tok", "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(pr.status).toBe(200);
    const res = await callP;
    expect(res.isError).toBeFalsy();
    const call = audit.find((e) => e.type === "tool_call") as { decision?: string } | undefined;
    expect(call?.decision).toBe("ask-approved");
  } finally {
    await mcp.close();
  }
});

test("e2e over real HTTP: a gateway with no admin token exposes no admin surface (404)", async () => {
  const { url } = await boot({ default: "allow", rules: [] });
  const r = await fetch(url.replace("/mcp", "/admin/approvals"), { headers: { authorization: "Bearer x" } });
  expect(r.status).toBe(404);
});

test("boot REFUSES an empty approver token — an empty token authenticates any caller (dual-control bypass)", async () => {
  // A per-approver token from an unset env var / a secret store returning "" must
  // fail closed at boot, not silently authenticate an unauthenticated caller as
  // that approver (which would let anyone approve a requireSecondPerson call).
  await expect(boot({ default: "allow", rules: [] }, { approvers: { "auditor@acme.com": "" } })).rejects.toThrow(
    /empty|non-empty/i,
  );
});

test("boot REFUSES an empty admin token", async () => {
  await expect(boot({ default: "allow", rules: [] }, { adminToken: "" })).rejects.toThrow(/empty|non-empty/i);
});

test("e2e over real HTTP: DPoP-authenticated client runs a governed call end-to-end", async () => {
  const { gateway, url, audit } = await boot();
  const mcp = await connectClient(url, gateway.privateKey);
  try {
    const tools = await mcp.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("github__list_issues");

    const res = await mcp.callTool({ name: "github__list_issues", arguments: { owner: "acme", repo: "app" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("a bug");

    const call = audit.find((e) => e.type === "tool_call") as { decision?: string; principal?: string } | undefined;
    expect(call?.decision).toBe("allow");
    expect(call?.principal).toBe("alice@acme.com");
    expect(audit.some((e) => e.type === "tool_result")).toBe(true);
  } finally {
    await mcp.close();
  }
});

test("e2e over real HTTP: IdP token-exchange issues a DPoP token that then runs a governed call", async () => {
  const stubIdp = {
    async verifySubjectToken(t: string) {
      return t === "valid-oidc" ? { sub: "alice@acme.com", groups: ["eng"] } : { deny: "bad" };
    },
  };
  const { gateway, url } = await boot({ default: "allow", rules: [] }, { idp: stubIdp });
  const tokenUrl = url.replace("/mcp", "/token");
  const client = generateAuthKeypair();

  // Exchange the IdP subject token for a DPoP-bound gateway token.
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      authorization: "Bearer valid-oidc",
      "x-oh-dpop-key": Buffer.from(client.publicKey).toString("base64url"),
      "x-oh-harness": "acme-assistant",
      "x-oh-defversion": "1.0.0",
      "x-oh-session": "s1",
    },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { access_token: string; token_type: string };
  expect(body.token_type).toBe("DPoP");

  // Use the exchanged token for a real governed MCP call.
  const dpopFetch = createDpopFetch(body.access_token, client.privateKey, client.publicKey, undefined, undefined, gateway.publicKey);
  const mcp = new Client({ name: "harness", version: "0" }, { capabilities: {} });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: dpopFetch as unknown as typeof fetch }));
  try {
    const call = await mcp.callTool({ name: "github__list_issues", arguments: { owner: "acme", repo: "app" } });
    expect(call.isError).toBeFalsy();
  } finally {
    await mcp.close();
  }

  // A forged subject token is refused — no token issued.
  const bad = await fetch(tokenUrl, {
    method: "POST",
    headers: { authorization: "Bearer forged", "x-oh-dpop-key": Buffer.from(client.publicKey).toString("base64url") },
  });
  expect(bad.status).toBe(401);

  // A garbage bound key is refused at exchange time (clean deny), not minted.
  const badKey = await fetch(tokenUrl, {
    method: "POST",
    headers: { authorization: "Bearer valid-oidc", "x-oh-dpop-key": Buffer.from("not-a-real-key").toString("base64url") },
  });
  expect(badKey.status).toBe(401);

  // The token route does NOT match a sibling prefix path.
  const sibling = await fetch(url.replace("/mcp", "/tokenfoo"), {
    method: "POST",
    headers: { authorization: "Bearer valid-oidc", "x-oh-dpop-key": Buffer.from(client.publicKey).toString("base64url") },
  });
  expect(sibling.status).toBe(404);
});

test("startGatewayHttp rejects an empty path/tokenPath (would shadow every route)", async () => {
  const stubIdp = { async verifySubjectToken() { return { sub: "a", groups: [] }; } };
  await expect(boot({ default: "allow", rules: [] }, { idp: stubIdp, tokenPath: "" })).rejects.toThrow(/tokenPath/);
  await expect(boot({ default: "allow", rules: [] }, { path: "" })).rejects.toThrow(/path/);
});

test("e2e over real HTTP: a client WITHOUT DPoP is rejected at the edge (401)", async () => {
  const { url } = await boot();
  const transport = new StreamableHTTPClientTransport(new URL(url)); // plain fetch, no DPoP
  const mcp = new Client({ name: "attacker", version: "0" }, { capabilities: {} });
  await expect(mcp.connect(transport)).rejects.toThrow();
});

test("e2e over real HTTP: a client pinning the correct pubkey verifies the server; a wrong pin is refused", async () => {
  const { gateway, url } = await boot();

  // Correct pin: the gateway signs each response with its private key -> verified.
  const good = await connectClient(url, gateway.privateKey, gateway.publicKey);
  try {
    const res = await good.callTool({ name: "github__list_issues", arguments: { owner: "acme", repo: "app" } });
    expect(res.isError).toBeFalsy();
  } finally {
    await good.close();
  }

  // Wrong pin: the response signature won't verify -> the client refuses to trust it.
  const impostorPin = generateAuthKeypair().publicKey;
  await expect(connectClient(url, gateway.privateKey, impostorPin)).rejects.toThrow();
});

test("e2e over real HTTP: a malformed request does not crash the shared server", async () => {
  const { gateway, url } = await boot();
  const client = generateAuthKeypair();
  const token = mintGatewayToken(CLAIMS, gateway.privateKey, client.publicKey, { ttlMs: 60_000, now: Date.now() });
  const proof = createDpopProof(client.privateKey, { method: "POST", url: proofUrl(url) }, Date.now());
  const headers = { "content-type": "application/json", ...dpopHeaders(token, proof, client.publicKey) };

  // Authenticated but garbage body — must not take the process down.
  const bad = await fetch(url, { method: "POST", headers, body: "}{ not json" });
  expect(bad.status).toBeGreaterThanOrEqual(400);

  // The server is still alive: a fresh DPoP-authenticated client works.
  const mcp = await connectClient(url, gateway.privateKey);
  try {
    const res = await mcp.callTool({ name: "github__list_issues", arguments: { owner: "acme", repo: "app" } });
    expect(res.isError).toBeFalsy();
  } finally {
    await mcp.close();
  }
});

test("e2e over real HTTP: a captured DPoP proof cannot be replayed (second identical request → 401)", async () => {
  const { gateway, url } = await boot();
  const client = generateAuthKeypair();
  const token = mintGatewayToken(CLAIMS, gateway.privateKey, client.publicKey, { ttlMs: 60_000, now: Date.now() });
  // One fixed proof for POST /mcp — as an attacker who captured a single request would have.
  const proof = createDpopProof(client.privateKey, { method: "POST", url: proofUrl(url) }, Date.now());
  const headers = { "content-type": "application/json", ...dpopHeaders(token, proof, client.publicKey) };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

  // First use passes the edge (whatever the body yields, it is NOT an auth 401).
  const first = await fetch(url, { method: "POST", headers, body });
  expect(first.status).not.toBe(401);

  // Replaying the SAME proof (same jti) is rejected at the edge.
  const second = await fetch(url, { method: "POST", headers, body });
  expect(second.status).toBe(401);
});

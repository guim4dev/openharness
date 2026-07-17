import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  ChildProcessSandboxHost,
  createSandboxedConnectorSessions,
  handleWorkerRequest,
  type ConnectorDescriptor,
} from "./connector-sandbox.ts";
import type { Connector } from "./connectors/index.ts";

const WORKER = fileURLToPath(new URL("./connector-worker.ts", import.meta.url));
const REGISTRY = fileURLToPath(new URL("./__fixtures__/sandbox-connectors.ts", import.meta.url));
// The forked worker must strip TS itself — it is a fresh node, not vitest's transform.
const EXEC_ARGV = ["--experimental-strip-types", "--no-warnings"];

function host(callTimeoutMs = 5_000) {
  return new ChildProcessSandboxHost({ workerModule: WORKER, registryModule: REGISTRY, execArgv: EXEC_ARGV, callTimeoutMs });
}

test("handleWorkerRequest maps a connector result to an ok reply, and a throw to an error reply", async () => {
  const ok: Connector = { id: "x", tools: [], allowHosts: [], async call(t) {
    return { content: [{ type: "text", text: `ran ${t}` }] };
  } };
  const bad: Connector = { id: "x", tools: [], allowHosts: [], async call() {
    throw new Error("nope");
  } };
  const cred = { secret: "s" };
  expect(await handleWorkerRequest(ok, { id: 1, toolName: "t", args: {}, cred })).toEqual({
    id: 1,
    ok: true,
    result: { content: [{ type: "text", text: "ran t" }] },
  });
  expect(await handleWorkerRequest(bad, { id: 2, toolName: "t", args: {}, cred })).toEqual({ id: 2, ok: false, error: "nope" });
});

test("a call runs in a real separate process and the credential + args are marshaled across", async () => {
  const h = host();
  try {
    const r = await h.invoke("alice", "echo", { toolName: "ping", args: { a: 1 }, cred: { secret: "sekret" } });
    const echoed = JSON.parse(r.content[0].text) as { toolName: string; args: unknown; secret: string; pid: number };
    expect(echoed.toolName).toBe("ping");
    expect(echoed.args).toEqual({ a: 1 });
    expect(echoed.secret).toBe("sekret");
    expect(echoed.pid).not.toBe(process.pid); // genuinely a different OS process
  } finally {
    await h.close();
  }
});

test("each (principal, connector) gets its OWN warm worker — state never bleeds across principals", async () => {
  const h = host();
  try {
    const call = (who: string) =>
      h.invoke(who, "echo", { toolName: "t", args: {}, cred: { secret: "s" } }).then((r) => JSON.parse(r.content[0].text) as { pid: number; calls: number });

    const a1 = await call("alice");
    const a2 = await call("alice"); // warm reuse: same pid, counter advances
    const b1 = await call("bob"); //   different principal: different pid, counter resets

    expect(a2.pid).toBe(a1.pid);
    expect(a2.calls).toBe(2);
    expect(b1.pid).not.toBe(a1.pid);
    expect(b1.calls).toBe(1);
    expect(h.size()).toBe(2);
  } finally {
    await h.close();
  }
});

test("a worker CRASH is contained — the call rejects, the worker is dropped, the next call respawns", async () => {
  const h = host();
  try {
    await expect(h.invoke("alice", "crash", { toolName: "t", args: {}, cred: { secret: "s" } })).rejects.toThrow(/exited/);
    expect(h.size()).toBe(0); // crashed worker dropped
    // A different connector for the same principal still works — the crash didn't wedge the host.
    const r = await h.invoke("alice", "echo", { toolName: "t", args: {}, cred: { secret: "s" } });
    expect(r.content[0].text).toContain("\"toolName\":\"t\"");
  } finally {
    await h.close();
  }
});

test("a connector THROW (not a crash) is reported as an error result without killing the worker", async () => {
  const h = host();
  try {
    await expect(h.invoke("alice", "boom", { toolName: "t", args: {}, cred: { secret: "s" } })).rejects.toThrow(/blew up/);
    expect(h.size()).toBe(1); // worker survives a handled throw
  } finally {
    await h.close();
  }
});

test("createSandboxedConnectorSessions exposes descriptors in-process and routes call() through the host", async () => {
  const h = host();
  const descriptors: Record<string, ConnectorDescriptor> = {
    echo: { id: "echo", tools: [], allowHosts: ["none"] },
  };
  const sessions = createSandboxedConnectorSessions({ host: h, descriptors });
  try {
    const c = sessions.for("alice", "echo");
    expect(c.allowHosts).toEqual(["none"]); // static metadata, no subprocess needed
    const r = await c.call("ping", { x: 1 }, { secret: "s" });
    expect(JSON.parse(r.content[0].text).toolName).toBe("ping");
    expect(() => sessions.for("alice", "missing")).toThrow(/unknown connector/);
  } finally {
    await h.close();
  }
});

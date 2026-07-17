import type { Connector } from "../connectors/index.ts";

/**
 * No-network connector registry for sandbox tests. Loaded by the REAL worker
 * entry inside a forked subprocess (under --experimental-strip-types), so it must
 * stay erasable TS with type-only workspace imports. Each factory returns a fresh
 * instance — the worker instantiates exactly one per process, which lets a test
 * prove per-(principal, connector) processes hold independent state.
 */

function echoConnector(): Connector {
  let calls = 0; // per-process state — isolated across workers
  return {
    id: "echo",
    tools: [],
    allowHosts: [],
    async call(toolName, args, cred) {
      calls++;
      return {
        content: [
          {
            type: "text",
            // Echo back the marshaled call + this process's pid and call count,
            // so a test can see the boundary was really crossed and is isolated.
            text: JSON.stringify({ toolName, args, secret: cred.secret, pid: process.pid, calls }),
          },
        ],
      };
    },
  };
}

function crashConnector(): Connector {
  return {
    id: "crash",
    tools: [],
    allowHosts: [],
    async call() {
      // Simulate a connector that hard-crashes its process mid-call.
      process.exit(37);
    },
  };
}

function throwConnector(): Connector {
  return {
    id: "boom",
    tools: [],
    allowHosts: [],
    async call() {
      throw new Error("connector blew up");
    },
  };
}

export const factories: Record<string, () => Connector> = {
  echo: echoConnector,
  crash: crashConnector,
  boom: throwConnector,
};

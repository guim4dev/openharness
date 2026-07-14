import { expect, test } from "vitest";
import { createConnectorSessions } from "./sessions.ts";
import type { Connector } from "./connectors/index.ts";

/** A connector with per-INSTANCE state, to prove sessions don't bleed. */
function makeStatefulConnector(): Connector {
  let calls = 0;
  return {
    id: "stateful",
    tools: [{ name: "count" }],
    allowHosts: [],
    async call() {
      calls += 1;
      return { content: [{ type: "text", text: String(calls) }] };
    },
  };
}

const cred = { secret: "s" };

test("two principals get isolated instances — state never bleeds", async () => {
  const sessions = createConnectorSessions({ stateful: makeStatefulConnector });
  const alice = sessions.for("alice", "stateful");
  const bob = sessions.for("bob", "stateful");
  expect(alice).not.toBe(bob);

  await alice.call("count", {}, cred);
  await alice.call("count", {}, cred);
  const bobFirst = await bob.call("count", {}, cred);
  // Bob's first call is "1" — Alice's two calls didn't leak into his counter.
  expect(bobFirst.content[0].text).toBe("1");
});

test("the same principal reuses its instance (session continuity)", async () => {
  const sessions = createConnectorSessions({ stateful: makeStatefulConnector });
  const a1 = sessions.for("alice", "stateful");
  const a2 = sessions.for("alice", "stateful");
  expect(a1).toBe(a2);
  await a1.call("count", {}, cred);
  const second = await a2.call("count", {}, cred);
  expect(second.content[0].text).toBe("2"); // same counter
  expect(sessions.size()).toBe(1);
});

test("an unknown connector id throws", () => {
  const sessions = createConnectorSessions({});
  expect(() => sessions.for("alice", "nope")).toThrow(/unknown connector/);
});

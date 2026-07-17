import { createGithubReadConnector } from "./github-read.ts";
import { createNotifyConnector } from "./notify.ts";
import type { Connector } from "./index.ts";

/**
 * The vetted first-party connector factories, by `type`. A signed config must
 * never be able to spin up an arbitrary connector — only what's registered here.
 *
 * This is a STANDALONE module (only erasable/relative imports, no
 * `node:child_process`) so the out-of-process connector worker can `import()` it
 * by path under `node --experimental-strip-types` when the sandbox is enabled —
 * AND `serve.ts` imports the same object in-process to instantiate connectors /
 * snapshot descriptors. One source of truth for both sides.
 */
export const factories: Record<string, () => Connector> = {
  "github-read": () => createGithubReadConnector(),
  notify: () => createNotifyConnector(),
};

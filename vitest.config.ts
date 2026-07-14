import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

// Half the cores (min 2) — a concrete number; vitest 2.1.x rejects a "50%"
// string here. Leaves CPU headroom for the child processes several suites spawn.
const workerCap = Math.max(2, Math.floor(cpus().length / 2));

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "apps/*/src/**/*.test.{ts,tsx}",
      "apps/*/ui/src/**/*.test.{ts,tsx}",
    ],
    environment: "node",
    // Several suites spawn real child processes (server.ts via node+tsx, stdio
    // MCP servers) that transpile/boot on startup and are CPU-heavy. On a
    // many-core dev machine vitest would otherwise start ~one worker per core
    // and oversubscribe the CPU, starving those child processes past their
    // timeouts (flaky locally; CI's few cores never hit it). Cap workers to half
    // the cores so the spawned processes get CPU. Scales down cleanly on CI.
    maxWorkers: workerCap,
    minWorkers: 1,
    // Generous default so a CPU-starved child-process/spawn test under the full
    // suite's contention doesn't fail on the stock 5s. Fast tests finish in ms
    // regardless; the few heavy spawn tests set their own (larger) timeouts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

import { pathToFileURL } from "node:url";
import { handleWorkerRequest, type WorkerRequest } from "./connector-worker-protocol.ts";
import type { Connector } from "./connectors/index.ts";

/**
 * Deploy hardening §5 — the connector worker entry. Spawned once per
 * (principal, connector) by `ChildProcessSandboxHost`, it runs in its OWN OS
 * process: separate memory from the gateway (no other principal's in-flight data,
 * no broker handle) and its own crash domain. It instantiates exactly ONE vetted
 * connector — named by `--connector`, resolved from the registry module named by
 * `--registry` (a path, so nothing but data crosses the process boundary) — then
 * serves marshaled `call` requests over the IPC channel. The egress allowlist and
 * forward-proxy tap live inside the connector's `call`, so they run here, inside
 * the sandbox.
 *
 * Kept to erasable TypeScript with type-only workspace imports so it runs under
 * `node --experimental-strip-types` without a bundler.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const connectorId = arg("--connector");
  const registry = arg("--registry");
  if (!connectorId || !registry) {
    process.stderr.write("connector-worker: --connector and --registry are required\n");
    process.exit(2);
    return;
  }

  // Accept a path or a file URL; import() needs a URL for absolute paths.
  const spec = registry.startsWith("file:") ? registry : pathToFileURL(registry).href;
  const mod = (await import(spec)) as { factories?: Record<string, () => Connector> };
  const factory = mod.factories?.[connectorId];
  if (!factory) {
    process.stderr.write(`connector-worker: unknown connector '${connectorId}'\n`);
    process.exit(2);
    return;
  }
  const connector = factory();

  process.on("message", (msg: WorkerRequest) => {
    void handleWorkerRequest(connector, msg).then((reply) => {
      process.send?.(reply);
    });
  });

  // Signal readiness is implicit: the parent buffers sends until the channel is up.
}

void main();

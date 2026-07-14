# @openharness/server

The thin, dumb last piece of the data plane: a `GET /bundle` host + `POST /audit` sink over `node:http`.

Enforcement already happened in-process (policy engine), so this server only distributes signed bundles and is the authoritative anchor for the audit trail — per source it retains the last accepted `{seq, hash}` HEAD and rejects any submission that forks, re-chains from genesis, or skips a seq. Bearer-gated and loopback by default (`127.0.0.1`). Depends on `@openharness/bundle` for the `Bundle` shape and `@openharness/audit` for chain verification.

## API

- `createOpenHarnessServer(opts) -> OpenHarnessServer` — build the host over `OpenHarnessServerOptions` (`bundlesDir`, `auditDir`, optional `token`, `host`, `port`); call `.start()` to listen, returning `{ url, port, close() }`.
- `fetchBundle(serverUrl, token?, name?) -> Promise<Bundle>` — client helper: `GET /bundle`; returns the still-unverified bundle (callers must run `verifyBundle`).
- `pushAudit(serverUrl, token, ndjsonLines) -> Promise<{ ingested }>` — client helper: `POST` NDJSON audit lines.
- Types: `OpenHarnessServerOptions`, `OpenHarnessServer`, `StartedOpenHarnessServer`.

## Usage

```ts
import { createOpenHarnessServer, fetchBundle } from "@openharness/server";
import { verifyBundle } from "@openharness/bundle";

const server = createOpenHarnessServer({
  bundlesDir: "./bundles",
  auditDir: "./audit",
  token: process.env.OH_TOKEN,
});
const { url, close } = await server.start();

const bundle = await fetchBundle(url, process.env.OH_TOKEN, "acme");
verifyBundle(bundle, orgPublicKeyPem); // never trust the fetched bundle unchecked
await close();
```

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.

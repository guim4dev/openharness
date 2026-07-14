# @openharness/core

The runtime that ties Pi to the rest of OpenHarness: it loads a harness definition, resolves bring-your-own-key credentials, enforces policy + audit in-process at Pi's hooks, and drives live streaming turns.

Top of the dependency graph — depends on Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) and on every other `@openharness/*` package; nothing else depends on it. Also ships the `openharness` CLI bin (`chat`, `init`, `doctor`, `keygen`, `bundle`, `bundle verify`, `build`, `serve`, `audit verify`; `--help` prints the list).

## API

- `createLiveSession(opts: CreateLiveSessionOptions) -> Promise<LiveSession>` — stand up a real Pi `AgentSession` for a harness (dev `harnessPath` or a signed `verified` bundle), wired through policy/audit; `.prompt(text, onEvent)` streams `token`/`done`/`error` events.
- `runChat(opts: RunChatOptions) -> Promise<RunChatResult>` — one BYO-key chat turn against a harness, streaming to stdout; returns an exit code (backs the CLI's chat command).
- `loadAccounts(opts?: LoadAccountsOptions) -> Promise<LoadedAccounts>` — build a `CredentialManager` + `AuthProviderRegistry` from env keys and `accounts.json`, writing every key into an encrypted on-disk store.
- `createOpenHarnessAuthStorage({ manager, registry, profile }) -> OpenHarnessAuthStorage` — bridge the credential seam into Pi's `AuthStorage`, driving its runtime key slot from rotation state.
- `buildPolicyExtension(policy: Policy, opts?: PolicyExtensionOptions) -> InlineExtension` — the in-process Pi extension enforcing tool-call decisions, secret redaction, and audit, fail-closed.
- `startSession(opts: StartSessionOptions) -> Promise<OpenHarnessSession>` — provider-agnostic single-turn session with credential rotation/failover over a `ModelProvider` seam.
- `configDir(appId?) -> string` — cross-platform per-app config dir, namespaced and hash-disambiguated per identifier.
- Testing seams: `stubStreamSimple`, `registerStubProvider`, `createStubModelRegistry`, `createToolCallingStubModelRegistry` — offline Pi providers for hermetic tests.
- Re-exported: `checkModel` + `Policy` (from `@openharness/policy`); `createFileAuditLog`, `verifyAuditLog`, `InMemoryAuditSink`, `hashCanonical`, `AUDIT_GENESIS`, and audit types (from `@openharness/audit`).

## Usage

```ts
import { loadAccounts, createLiveSession } from "@openharness/core";

const { manager, registry, secretStore } = await loadAccounts();

const session = await createLiveSession({
  harnessPath: "./acme-harness",
  manager,
  registry,
  secretStore,
  profile: "default",
});

await session.prompt("Say hello in one line.", (event) => {
  if (event.type === "token") process.stdout.write(event.text);
});
await session.close();
```

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.

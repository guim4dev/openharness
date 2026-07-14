# @openharness/credentials

Encrypted secret storage and provider-scoped credential rotation for OpenHarness.

Owns the LLM API keys / OAuth tokens an agent uses: a `SecretStore` holds the raw
secrets, a `CredentialManager` selects a healthy account per profile with
failover or round-robin rotation scoped to the target vendor, and a pluggable
`AuthProvider` registry adapts each auth mechanism. Consumed by
`@openharness/core`; depends on nothing else in the monorepo.

## API

- `SecretStore` — `get`/`set`/`delete(ref)` interface; `InMemorySecretStore` and `EncryptedFileSecretStore.open(dir)` (AES-256-GCM file backend).
- `AuthProvider` / `AuthProviderRegistry` — auth-mechanism interface + registry; `apiKeyAuthProvider(store)` is the built-in paste-a-key provider (covers OpenCode Go).
- `CredentialManager` — `activeAccount(profile, provider?)`, `markRotated(profile)`, `reportResult(accountId, CallResult)`; rotates/fails over healthy accounts, scoped to a vendor.
- `Account`, `Profile`, `StoredCredential`, `AccountHealth`, `RotationPolicy`, `CredentialKind`, `CallResult` — supporting types.

## Usage

```ts
import { EncryptedFileSecretStore, apiKeyAuthProvider, CredentialManager } from "@openharness/credentials";

const store = await EncryptedFileSecretStore.open("~/.openharness/acme");
const credential = await apiKeyAuthProvider(store).callback({ accountId: "anthropic-1", apiKey: "sk-..." });

const mgr = new CredentialManager({
  accounts: [{ id: "anthropic-1", provider: "anthropic", authProviderId: "api-key", label: "Primary", credential, health: { state: "ok" } }],
  profiles: [{ name: "default", policy: "failover", accountIds: ["anthropic-1"] }],
});

const account = mgr.activeAccount("default", "anthropic"); // never a non-anthropic key
mgr.reportResult(account!.id, { ok: false, kind: "rate_limit", retryAfterMs: 30_000 });
```

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.

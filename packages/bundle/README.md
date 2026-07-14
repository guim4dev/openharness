# @openharness/bundle

ed25519-signed `.ohbundle` definition bundles — the distribution + trust format for a `HarnessDefinition`.

Packs a definition directory into a signed, self-contained JSON bundle and verifies it fail-closed on the way back out (bad signature, tampered file, path-traversal, or older-than-floor version all throw). It sits between `@openharness/definition` (what it bundles) and `@openharness/build` / `@openharness/server` (who produce and host bundles); audit's `canonicalJSON` gives it a platform-stable signing input.

## API

- `generateKeypair() -> { publicKey, privateKey }` — ed25519 keypair as PEM (SPKI public, PKCS#8 private).
- `bundleDefinition(defDir, privateKeyPem) -> Bundle` — walk a definition dir, hash + embed every file, sign the manifest.
- `writeBundle(bundle, outPath) -> void` — serialize a bundle to disk (conventionally `.ohbundle`).
- `verifyBundle(bundle | path, publicKeyPem, opts?) -> VerifyBundleResult` — all-or-nothing check: signature, per-file sha256, optional `minVersion` anti-rollback; throws `BundleVerificationError`.
- `extractBundle(bundle, destDir) -> void` — write a (verified) bundle's files back out, refusing paths that escape `destDir`.
- `loadVerifiedDefinition(bundlePath, publicKeyPem, opts?) -> Promise<HarnessDefinition>` — the client trust path: verify, extract to a temp dir, load.
- Types: `Bundle`, `BundleManifest`, `BundleFileEntry`, `VerifyBundleOptions`, `VerifyBundleResult`, `BundleVerificationError`.

## Usage

```ts
import {
  generateKeypair,
  bundleDefinition,
  writeBundle,
  loadVerifiedDefinition,
} from "@openharness/bundle";

const { publicKey, privateKey } = generateKeypair();

const bundle = bundleDefinition("./acme-harness", privateKey);
writeBundle(bundle, "./out/acme.ohbundle");

// Later, on the client — throws unless fully trusted (+ not older than 1.2.0):
const def = await loadVerifiedDefinition("./out/acme.ohbundle", publicKey, {
  minVersion: "1.2.0",
});
```

Part of the [OpenHarness](../../README.md) monorepo; see [ARCHITECTURE](../../docs/ARCHITECTURE.md) for how the packages fit together.

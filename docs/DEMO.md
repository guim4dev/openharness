# OpenHarness — the 90-second demo

The thesis in one sitting: **a company builds its own branded, signed, governed
harness from a single definition — and the app refuses to run a configuration
that wasn't signed by that company.** Supply-chain integrity as white-label.

Every command below is real and was run end-to-end on `main` (Node 22). Paths use
a scratch dir so nothing touches your repo.

## 0. Setup

```bash
cd openharness && npm install
TSX="./node_modules/.bin/tsx packages/core/src/chat-cli.ts"   # or use `npm run chat -- <subcmd>`
OUT=$(mktemp -d)
```

## 1. An org mints its signing key (once)

```bash
$TSX keygen --out "$OUT/org"
# → wrote $OUT/org.key (private, 0600) and $OUT/org.pub (public)
```

The **private key never leaves the org**. Only the public key is baked into the
apps it ships.

## 2. Build two branded apps from two DIFFERENT definitions

This is the point of the substrate: two real orgs, two different businesses,
built from the same `openharness build` — distinct branding, prompts, MCP
tools, and policy each. `harnesses/acme-fintech` (platform engineering at an
80-person fintech) and `harnesses/northwind-ops` (a back-office/ops copilot)
are checked into this repo as realistic definitions, not stand-ins for the
same one:

```bash
$TSX build harnesses/acme-fintech  --key "$OUT/org.key" --out "$OUT/acme"     --org acme     --name engineer
$TSX build harnesses/northwind-ops --key "$OUT/org.key" --out "$OUT/northwind" --org northwind --name ops
```

Each is a complete, ready-to-package Tauri project. They get **distinct
identifiers**, so their credentials / audit / state never collide:

```
acme id     : ai.openharness.acme.engineer      (branding.displayName: "Acme Engineer")
northwind id: ai.openharness.northwind.ops       (branding.displayName: "Northwind Ops Copilot")
```

Each bakes four resources — `harness.ohbundle` (the signed definition),
`org.pub` (the org's public key), `min-version.txt` (the anti-rollback floor),
`server.mjs` (the single-file agent sidecar) — and **never** the private key:

```bash
grep -rl "PRIVATE KEY" "$OUT/acme" "$OUT/northwind"   # → (no output: no key is ever baked)
```

The two also show the format's range: `acme-fintech/policy.json` is
deny-by-default (only allow-listed reads + `git` + its two read-only MCP
servers get through; anything destructive is denied outright), while
`northwind-ops/policy.json` is ask-by-default (reads are allow-listed, but
its back-office server's mutating tools always prompt a human first). Both
harnesses' MCP servers are declared `"mandatory": false` and reference real
npx-installable MCP servers illustratively (`@modelcontextprotocol/server-*`)
— nothing needs to be running for either build above to succeed.

## 3. The app boots pinned to the signed definition

```bash
$TSX bundle verify "$OUT/acme/resources/harness.ohbundle" --pubkey "$OUT/org.pub"
# → bundle OK: acme-fintech@0.1.0
```

At runtime the desktop sidecar loads via `loadVerifiedDefinition` (M1): a valid
bundle boots normally; an invalid one puts the app in a locked "Configuration
could not be verified" screen instead of running.

## 4. The memory hook: flip one byte → the app refuses

```bash
# flip a single byte inside the baked bundle:
node -e 'const fs=require("fs"),p=process.argv[1],b=fs.readFileSync(p);b[Math.floor(b.length/2)]^=1;fs.writeFileSync(p,b)' "$OUT/acme/resources/harness.ohbundle"

# ...then re-verify — it no longer matches the org's signature:
$TSX bundle verify "$OUT/acme/resources/harness.ohbundle" --pubkey "$OUT/org.pub"
# → bundle REJECTED: signature verification failed — bundle is unsigned, tampered, or signed by a different key
```

In the running app this is the integrity-refusal screen. Nobody demos
supply-chain-integrity-as-white-label — this is the beat a buyer retells to their
CISO.

## 5. What the harness does while it runs (governance data plane)

- **MCP tools** are bridged in from `harness.json`'s `mcp` section (`mcp__<server>__<tool>`).
- **`policy.json`** enforces deny-by-default rules + secret redaction at the
  `tool_call` / `tool_result` / `before_provider_request` seams (in-process, can't
  be prompt-jailbroken). Denied actions show a branded "Blocked by policy" result.
- **Audit** appends a hash-chained JSONL line per external call
  (`<app-data-dir>/…`), external calls only — never prompts. The local chain
  catches accidental corruption and naive in-place edits; strong tamper-evidence
  comes from shipping entries to the server, which retains a per-source HEAD and
  refuses any re-chained/forked/gapped submission (the server copy is the anchor).
- **Credentials** are BYO-key with multi-account rotation (org API keys / OpenCode
  Go / Claude Max). Consumer ChatGPT subscriptions are personal-use only (never
  pooled across employees — D11).

## Run it live (one turn, your key)

```bash
export ANTHROPIC_API_KEY=sk-...
npm run chat -- harnesses/example "Say hello in one line."
```

## Package the desktop app (macOS)

```bash
cd "$OUT/acme" && npx tauri build      # requires the Tauri prerequisites (Rust — you have it)
```

Then **validate from a fresh user account / second machine** before trusting the
artifact — a built app resolving repo paths only fails there, and that's the class
of bug that hides until a real install.

## Honest threat model (say it before the buyer finds it)

- Local-first enforcement is bypassable by a determined employee with a debugger.
  Signed builds make config tampering **evident**. The local audit chain is
  keyless and genesis-anchored, so on its own it only catches accidental
  corruption and naive edits — a writer can re-chain a forgery locally. Tamper-
  **evidence** for the audit trail comes from shipping entries to the server,
  which retains a per-source HEAD and rejects re-chained/forked/gapped
  submissions; the server's retained copy is the anchor. The future remote MCP
  gateway (org secrets server-side) doesn't make bypass *pointless* — a patched
  binary still holds a valid session — but it **confines and audits the blast
  radius**: the credential never touches the laptop, so a compromised endpoint
  means abuse limited to one user's policy scope and revocable in one place, not
  stolen org secrets used invisibly. (Design: `specs/2026-07-14-remote-mcp-gateway-design.md`.)
- Until OS code-signing seals the app bundle, the *definition* integrity is
  verified but the shell still trusts whatever sidecar binary sits next to it
  (*code* integrity isn't sealed yet). That's the OS-signing follow-up.

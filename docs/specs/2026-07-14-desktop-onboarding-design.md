# v1.1 — Desktop first-run onboarding (design proposal)

**Status:** DRAFT proposal for review. Not approved for implementation. The open
questions in §6 — especially whether employees bring their own key or the org
provisions it, and the visual design of the panel — are the user's call before
an implementation plan.

**Relationship to the roadmap:** the "first-run desktop onboarding" bullet under
v1.1 in [`../ROADMAP.md`](../ROADMAP.md). Read the desktop pieces in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) first.

---

## 1. Goal

A **non-technical** user opens the branded desktop app and reaches a first
successful turn **without touching a terminal** — including getting a working
credential in place. Today the desktop app assumes the credential already
exists; this closes that gap, which is the whole point of the desktop frontend
existing (the "everyone else" audience, D12's complement).

## 2. What's missing today

The current first-run path (traced through `apps/desktop/src/server.ts` →
`sidecar.ts` → `ui/src/chat.ts`):

1. **No distinct "needs credentials" state.** Credentials come from
   `loadAccounts` (env vars + `<configDir>/accounts.json`). With none for the
   harness's provider, the session still starts and the **first prompt fails**
   with a raw provider auth error, surfaced as a scary red error bubble
   (`ServerMessage` `error`). A non-technical user has no idea what to do.
2. **No in-app way to provide a key.** BYO-key is env-var / `accounts.json`
   only — both inaccessible to a non-technical user. There is no field to paste
   a key and no flow to sign into a subscription.

## 3. Design

Two additions: a **boot-time readiness signal**, and **in-app credential entry**.

### 3a. Readiness signal (`needs_setup`)

The sidecar already can tell whether a credential resolves: the auth layer's
`syncActiveProvider(provider)` returns the active account or `null` (used today
in `packages/core/src/cli.ts`). Add a **non-terminal** server frame:

```
{ type: "needs_setup", provider: string, profile: string, configPath: string }
```

- Distinct from `error` (a failure *within* a trusted session) and from
  `integrity_error` (terminal verification refusal). `needs_setup` is a
  *recoverable* state: once a credential is provided, the app transitions to
  ready **without a restart**.
- Emitted on connect when no account resolves for the harness's provider —
  *before* the user wastes a prompt on a guaranteed auth failure.
- The reducer (`chat.ts`) gains a `needs_setup` status; `App.tsx` renders a
  friendly onboarding panel instead of the chat surface or an error bubble.

**Verified-boot wrinkle (must be handled):** in verified boot the provider is
not known until the bundle is verified *inside* the sidecar (`server.ts` only
learns it post-verification). So the readiness check must run **after**
`createLiveSession` resolves the definition, not in `server.ts` before it. In
dev boot the provider is known from the on-disk manifest and the check can run
earlier. Keep the check in one place (post-session) to avoid two code paths.

### 3b. In-app credential entry

The onboarding panel offers, per the harness's provider:

- **Paste an API key** — a text field. On submit the UI sends a client frame
  `{ type: "set_credential", secret: string }`; the sidecar writes it to the
  **same machine-local encrypted secret store the CLI uses**, re-runs
  `syncActiveProvider`, and — on success — emits `done`/ready so the chat
  surface appears. No restart.
- **Sign into a subscription** (Codex / OpenCode-Go etc.) — a "Connect" button
  that runs the provider's OAuth (PKCE) flow, opening the system browser and
  storing the resulting token in the same local store. (May land after the
  paste-a-key path; see §5.)

### 3c. The security boundary (the sensitive part — state it explicitly)

- The key **never leaves the machine**: it is written to the same local
  encrypted secret store the CLI/`loadAccounts` already use. It never enters
  `harness.json`, the signed bundle, the audit log, or any log line.
- **Durability (as built, v1.1):** an in-app key **survives a restart**. The raw
  key is written to the encrypted store (`api-key:gui-<provider>`), and a *keyless*
  entry — `{ id, provider }`, **no key** — is merged into `<configDir>/accounts.json`
  (`persistOnboardedAccount`). On the next launch `loadAccounts` resolves that
  keyless entry from the already-stored secret, so `accounts.json` never holds
  raw key material and the user doesn't re-onboard. Persistence is best-effort:
  if the `accounts.json` write fails the session is still ready (the account is
  live in-memory). This intentionally reverses §5's earlier `accounts.json`
  de-scope for the single onboarded key only — the encrypted store is still the
  key's home; `accounts.json` gains only a reference.
- The transport for `set_credential` is the **existing** sidecar channel:
  loopback (127.0.0.1) + ephemeral-token-gated WebSocket. No new listener, no new
  network surface — the same boundary that already carries prompts.
- This is **BYO-key made GUI-accessible**, not a new trust surface. Per D11,
  personal consumer subscriptions remain personal (never pooled). The
  provider-scoped selection from v1 (`CredentialManager.activeAccount(profile,
  provider)`) is unchanged — a key entered for provider X is only ever used for
  provider X.
- Redaction/logging audit: confirm the new frame and the store write appear in
  no log or audit line (there is already a build-time key-scan test pattern to
  mirror).

## 4. Smallest testable slice

- `needs_setup` frame + reducer status + a minimal onboarding panel (message +
  the `configPath`, and a paste-a-key field). Fully unit-testable at the reducer
  layer (`chat.ts` is pure and already has 21 tests); the sidecar readiness
  branch is testable like the existing `integrity_error` refusal test.
- `set_credential` → local-store write → re-resolve → ready, with a test that a
  wrong/empty key stays in `needs_setup` (fail-closed, no false "ready").
- The visual polish of the panel (§6) can iterate after the flow is correct.

## 5. Explicitly de-scoped from v1.1

Subscription OAuth flows beyond a documented stub (→ follow-up); multi-account
management UI (add/rotate/remove) in the GUI; editing `accounts.json` from the
app; any change to how keys are *stored* (reuse the existing encrypted store as
is); org-provisioned/managed credentials (that's the v2 gateway, not local BYO).

## 6. Open questions a human must answer first

1. **Who provides the key?** Does each employee bring their own (paste-a-key is
   primary), or does the org pre-provision (then the app should ship configured
   and this whole panel is a fallback)? This decides whether onboarding is the
   main path or an edge case.
2. **Subscriptions in v1.1 or later?** The paste-a-key path is simple; the OAuth
   (Codex/OpenCode-Go) flows are more work — ship key-paste first, or both?
3. **Panel design.** Copy and visual treatment of the onboarding panel are a
   product/design decision (this is the non-technical user's first impression) —
   not specified here on purpose.
4. **Wrong-key UX.** After a rejected key, do we show the provider's error
   verbatim, or a friendly "that key didn't work — check it's for <provider>"?
5. **Env-var precedence.** If an env var *and* an in-app key both exist, which
   wins, and is that surfaced? (Avoid a confusing "I pasted a key but it used the
   old env one.")
6. **Durability across restart. — ✓ Resolved (built).** An in-app key now
   survives a restart: the secret stays in the encrypted store and a keyless
   `accounts.json` entry references it (`persistOnboardedAccount`), which
   `loadAccounts` resolves on the next launch (§3c). This reversed §5's
   `accounts.json` de-scope for the single onboarded key only — the key never
   lands in `accounts.json` as plaintext.

---

*Note:* this proposal deliberately stops at BYO-key made accessible. The harder,
security-sensitive question of the org *managing* credentials centrally is the
v2 remote MCP gateway ([`2026-07-14-remote-mcp-gateway-design.md`](2026-07-14-remote-mcp-gateway-design.md)),
not this local-first onboarding.

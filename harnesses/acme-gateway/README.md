# acme-gateway — example harness (v2 remote MCP gateway)

The example that exercises OpenHarness's **v2 moat**: a harness that reaches a
sensitive upstream (GitHub) through a **remote governed gateway** instead of
holding the credential locally, alongside a locally-bridged read-only MCP server.

## What it shows

- **`gateway`** — the harness declares a remote gateway by `url`, PINS its
  ed25519 `pubkey` (so a hostile network can't present a fake gateway — the
  client verifies a per-request signature and requires TLS off-loopback), and
  lists the `tools` it may call. The gateway's tools bridge into the agent as
  `mcp__gateway__<tool>`. The org's GitHub credential and egress live server-side;
  this machine never sees them. No token passthrough.
- **Supply-chain pinning** — the local `docs` MCP server is pinned to a concrete
  version (`@2025.9.0`), so `openharness doctor` raises no unpinned-server
  warning. (`openharness doctor <dir> --strict-supply-chain` would turn any
  unpinned server into a build-failing error.)
- **Governed egress** — `policy.json` is deny-by-default and names every tool it
  allows, including the bridged gateway tool `mcp__gateway__github__list_issues`,
  so nothing reaches an external system ungoverned.

## Run the gateway it points at

This harness declares a gateway; run one with the deployable server:

```bash
openharness-gateway serve gateway.json   # see packages/gateway/README.md
```

Point `gateway.url` at it, replace `gateway.pubkey` with that gateway's public
key, and provide the harness a DPoP-bound token (the IdP/token-exchange flow is
the deploy-hardening layer). Then:

```bash
openharness doctor harnesses/acme-gateway   # preflights clean
```

## Files

- `harness.json` — branding, provider, the `gateway` block, and the pinned `docs` MCP server.
- `policy.json` — deny-by-default; allows only the triage tools it needs.
- `system-prompt.md` — the assistant's brief.
- `skills/triage/` — the one mandatory skill.

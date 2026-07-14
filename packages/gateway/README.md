# @openharness/gateway

The **remote MCP gateway** (v2) — the governed tool pipeline exposed as an MCP
server that a harness connects to over HTTP. The org's upstream credentials and
egress live here, server-side, so a compromised employee endpoint means *abuse
confined to that user's policy scope, fully audited and revocable in one place* —
not stolen org credentials used invisibly.

## What runs where

```
harness (MCP client)  ──DPoP over HTTP──▶  gateway (this package)
                                             │  1. edge auth  — DPoP token + per-request proof + key binding
                                             │  2. PDP        — the shared policy engine (per-principal, arg-level)
                                             │  3. broker     — resolve the org credential AFTER the allow decision
                                             │  4. connector  — per-user session, egress allowlist + proxy tap
                                             │  5. redact     — return-path secret redaction
                                             ▼  6. audit      — authoritative hash-chained record
                                          upstream (GitHub, …)
```

The harness never sees the credential or the egress. It calls a governed remote
tool exactly like a local one — bridged as `mcp__<gateway>__<tool>`.

## Run it

```bash
openharness-gateway serve gateway.json
```

A minimal `gateway.json` (credentials are referenced by name, never value):

```jsonc
{
  "host": "0.0.0.0",
  "port": 8787,
  "keys": { "publicKey": "keys/gw.pub", "privateKey": "keys/gw.key" }, // ed25519 PEM paths
  "policy": "policy.json",           // a policy.json path, or an inline policy object
  "policyVersion": "1.0.0",
  "auditPath": "audit/gateway.log",  // authoritative hash-chained audit
  "catalog": [                       // the PINNED virtual tool catalog (never proxied live)
    { "name": "github__list_issues", "connectorId": "github", "upstreamId": "github" }
  ],
  "connectors": [                    // connector instances, by vetted type
    { "id": "github", "type": "github-read" }
  ]
}
```

The org's per-upstream secrets live in an encrypted store beside the config
(`<config-dir>/secrets`, or set `OPENHARNESS_GATEWAY_SECRETS`), keyed
`upstream:<id>`. Populate it out of band; the config file itself is safe to
commit. The gateway's `pubkey` is pinned inside the harness's signed definition,
so the harness refuses a gateway that can't prove the matching private key.

## Security model

- **DPoP-bound tokens, single-use proofs.** Every request carries a short-lived
  token bound to the client keypair (`cnf.jkt`) plus a fresh proof signed by the
  client key. A stolen token is useless off the client's machine (no private key
  to sign a proof), and a captured proof can't be replayed (random `jti` +
  server-side replay guard, 60s window).
- **No token passthrough.** The gateway holds its own scoped credential per
  upstream and resolves it only *after* the policy decision — it never forwards a
  token it was handed (the confused-deputy / exfil-proxy vector).
- **Server-side PDP + audit are authoritative.** Enforcement and the hash-chained
  record are here, behind the gateway, so a patched local binary can't skip them.
  The harness keeps a local policy pass as defense-in-depth.
- **Server identity is pinned.** The gateway signs each response against its
  private key; the client verifies against the `pubkey` pinned in the signed
  definition and requires TLS off-loopback — a fake gateway is refused.

## Boundary (declare it before you deploy)

- **Transport:** HTTP (streamable MCP). Bind `host`/`port` as configured; front
  with TLS in production (the harness requires `https` for non-loopback).
- **Endpoint auth:** DPoP (token + per-request proof + key binding). No
  unauthenticated path reaches the pipeline; a bad/missing/replayed proof → 401.
- **Storage:** the encrypted secret store is a local file; a KMS-backed store is
  the production target.
- **Credentials carried:** one scoped credential per upstream (`upstream:<id>`),
  resolved post-decision. Never an LLM key, never a passthrough token.
- **Who reaches it:** whoever can reach `host:port` AND holds a valid
  DPoP-bound token for the pinned key. Scope network exposure accordingly.

## Deferred (deploy hardening)

A real IdP / OAuth 2.1 token-exchange flow for minting tokens, a KMS-backed
credential broker, and a containerized connector sandbox. The connector and
broker sit behind swappable interfaces so an [OpenConnector](../../docs/vision.md#13)
backend can slot in once it matures.

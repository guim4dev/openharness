# OpenHarness gateway — deployment & config reference

The **v2 governed remote MCP gateway** (`@openharness/gateway`) runs the governed
tool pipeline as an MCP server on the org's side of the wire: a pinned tool
catalog, server-side policy (deny-by-default), DPoP-authenticated requests with
**no token passthrough**, a credential broker that resolves the org secret
**only after** the policy decision allows a call, an out-of-process connector
sandbox, return-path redaction, and an authoritative hash-chained audit log. The
config file is safe to commit — it references keys by file path and upstream
credentials by *name*; the credentials themselves live in a machine-local
encrypted store beside the config, **never in the config file**. For where this
sits in the system, see [`ARCHITECTURE.md`](ARCHITECTURE.md) (the `@openharness/gateway`
row and "Honest boundary"); for the design of the three deployment seams
(IdP token exchange, KMS broker, connector sandbox), see
[`specs/2026-07-16-gateway-deploy-hardening-design.md`](specs/2026-07-16-gateway-deploy-hardening-design.md).

This is a reference. For a runnable, copy-pasteable walkthrough (keygen, a
config, `set-secret`, `serve`, a DPoP token exchange, an approval), start with
the hands-on flow instead.

## Quickstart

The complete runnable walkthrough — generate the gateway keypair, write a
config, provision the upstream credential, start the server, exchange an IdP
token, answer an approval — is [`RUNLOCAL.md` §5](RUNLOCAL.md#5-the-v2-governed-remote-mcp-gateway).
The `config.json` it uses is the canonical minimal example; this doc documents
every field that config (and every optional block) can carry.

Two commands drive the gateway, both through the repo's dev runner:

```bash
npm run gateway -- set-secret <upstream> [--secrets <dir>]   # provision a credential (value via STDIN)
npm run gateway -- serve <config.json>                       # start the gateway
```

The installed binary is `openharness-gateway`; `npm run gateway --` is the
no-global-install form used throughout.

---

## Config reference

`openharness-gateway serve <config.json>` loads a JSON file validated by the
`GatewayServerConfig` zod schema in
[`packages/gateway/src/config.ts`](../packages/gateway/src/config.ts). File
references (`keys`, a `policy` path, `auditPath`, `tokenExchange` key paths,
`sandbox.registryModule`) are resolved **relative to the config file's
directory**. Every field below is documented against that schema; unless noted
"required", a field is optional.

### Transport: `host`, `port`, `path`

Where the MCP endpoint listens.

```jsonc
{
  "host": "127.0.0.1",  // bind address; default "127.0.0.1" (loopback)
  "port": 8900,         // TCP port; default 0 (an ephemeral port the OS picks)
  "path": "/mcp"        // MCP route; default "/mcp", must start with "/"
}
```

| field | type | required | default |
|---|---|---|---|
| `host` | string | no | `127.0.0.1` |
| `port` | integer >= 0 | no | `0` (ephemeral) |
| `path` | non-empty string | no | `/mcp` |

The listen URL is printed at boot (`listening at http://<host>:<port><path>`).
The server speaks **plain HTTP** — it does not terminate TLS itself. See
[Transport & exposure](#transport--exposure) for the loopback-vs-TLS rule when
you expose it beyond localhost.

### `keys` (required)

The gateway's own ed25519 signing keypair, as **PEM file paths** (resolved
relative to the config). The public key verifies inbound access tokens; the
private key signs every response (`x-oh-gateway-auth`, bound to the request's
DPoP proof) so a client can verify it is talking to the gateway whose `pubkey`
its harness definition pinned — not an impostor. It is also the key that mints
tokens at the token-exchange endpoint.

```jsonc
{
  "keys": {
    "publicKey": "gw.pub",   // PEM path, required
    "privateKey": "gw.key"   // PEM path, required
  }
}
```

Generate one with `npm run chat -- keygen --out <dir>` (writes `*.key` at `0600`
and `*.pub`). These are **key files by reference** — the config holds paths, not
key material.

### `policy` + `policyVersion` (required)

The server-side policy the pipeline enforces before any tool runs. `policy` is
**either** a path to a `policy.json` (resolved relative to the config) **or** an
inline policy object. `policyVersion` is a required, non-empty version string
recorded alongside decisions in the audit log.

```jsonc
{
  // inline form:
  "policy": {
    "default": "allow",
    "rules": [{ "match": "github__*", "action": "allow" }]
  },
  // or a path form: "policy": "policy.json",
  "policyVersion": "1.0.0"
}
```

| field | type | required |
|---|---|---|
| `policy` | path string **or** inline object | yes |
| `policyVersion` | non-empty string | yes |

The policy engine (`@openharness/policy`) is **deny-by-default, first-match**:
an action can be `allow`, `deny`, or `ask` (suspend for a human — see
[`approval`](#approval)). `deny` and `ask` fail closed, including on internal
compute failure. See [`AUTHORING.md`](AUTHORING.md) for the rule grammar.

### `auditPath` (required)

Where the authoritative hash-chained audit log (JSONL) is written, relative to
the config. A gateway **must** audit, so this field is required.

```jsonc
{ "auditPath": "gateway-audit.jsonl" }
```

The log records SHA-256 fingerprints of already-redacted payloads and
non-sensitive metadata — never raw args, results, or credentials. This is the
gateway's own authoritative chain; a client's local chain can be cross-checked
against it (`audit reconcile`) — see [Transport & exposure](#transport--exposure).

### `catalog` (required)

The **pinned** virtual tool catalog — what a connecting harness sees for
`tools/list`, served from here and hashed into the signed definition, never
proxied live from an upstream. This is what kills rug-pull tool poisoning: a
malicious upstream update can't change what a tool appears to do. At least one
entry is required.

```jsonc
{
  "catalog": [
    {
      "name": "github__list_issues",   // required; the mcp__<server>__<tool> name policy gates
      "description": "List issues",     // optional
      "connectorId": "github",          // optional; which connector backs this tool (routing)
      "upstreamId": "github",           // optional; which credential the broker resolves (defaults to connectorId)
      "inputSchema": {                  // optional; JSON Schema for args (defaults to an open object)
        "type": "object",
        "properties": { "owner": { "type": "string" }, "repo": { "type": "string" } },
        "required": ["owner", "repo"]
      }
    }
  ]
}
```

| tool-spec field | type | required |
|---|---|---|
| `name` | non-empty string | yes |
| `description` | string | no |
| `connectorId` | non-empty string | no |
| `upstreamId` | non-empty string | no (defaults to `connectorId`) |
| `inputSchema` | JSON Schema object | no (defaults to `{ "type": "object", "properties": {} }`) |

`connectorId` routes the call to a `connectors[].id`; `upstreamId` selects which
`upstream:<id>` credential the broker resolves for it (defaulting to
`connectorId`). Constrain `inputSchema` — it is the pinned contract the client
sees and the shape policy argument-matching runs against.

### `connectors` (required)

The connector instances the gateway can route to, each with an `id` (referenced
by a tool's `connectorId`) and a `type` naming a **vetted first-party connector
factory**. A signed config can only spin up a `type` present in the registry
([`packages/gateway/src/connectors/registry.ts`](../packages/gateway/src/connectors/registry.ts)) —
today `github-read` and `notify`. An unknown `type` fails at boot. At least one
entry is required.

```jsonc
{
  "connectors": [
    { "id": "github", "type": "github-read" }  // both non-empty strings, both required
  ]
}
```

| field | type | required |
|---|---|---|
| `id` | non-empty string | yes |
| `type` | non-empty string (a registered factory) | yes |

### `approval`

Server-side, fail-closed handling of a policy `ask`. When a tool is `ask`ed, the
call suspends until a human decides or the timeout elapses (timeout -> **deny**).

```jsonc
{
  "approval": {
    "timeoutMs": 30000,           // required when the block is present; positive integer
    "requireSecondPerson": true   // optional; dual control (approver != requester)
  }
}
```

| field | type | required | note |
|---|---|---|---|
| `approval` | object | no | omit -> `ask` uses a 30s timeout-deny default |
| `approval.timeoutMs` | positive integer | yes (within the block) | ms before an unanswered `ask` denies |
| `approval.requireSecondPerson` | boolean | no | require a distinct approver identity |

To answer an `ask` over HTTP you must also start the gateway with an admin
credential (`OPENHARNESS_GATEWAY_ADMIN_TOKEN`) or per-approver tokens — see
[Secrets & env](#secrets--env). **`requireSecondPerson` is a real control only
with per-approver tokens:** the shared admin token resolves to identity `"admin"`,
which always differs from an IdP `sub`, so it would pass the second-person check
while letting one operator self-approve. The gateway **fails closed at boot** —
`requireSecondPerson: true` with no non-empty per-approver token is a startup
error. (Identity matching is string-shape; see [Known caveats](#known-caveats).)

### `tokenExchange`

Enables the OAuth 2.1 token-exchange endpoint (deploy hardening §3): `POST
<tokenPath>` exchanges an org-IdP subject token for a short-lived, DPoP-bound
gateway token. The `sub`/`groups` claims become IdP-asserted (trustworthy for
per-principal policy) instead of client-asserted. Omit the whole block for the
dev path where tokens are minted out of band.

Configure the IdP verifier **one of exactly two ways** — the schema refines that
exactly one is present (not both, not neither):

**Static-key variant** — a single Ed25519 PEM public key (offline, mature shape):

```jsonc
{
  "tokenExchange": {
    "idpPublicKey": "idp.pub",              // PEM path (relative to config) — EdDSA verifier
    "issuer": "https://idp.local",          // required; expected `iss`
    "audience": "openharness-gateway",      // required; expected `aud`
    "groupsClaim": "groups",                // optional; claim mapped to principal groups
    "tokenPath": "/token",                  // optional; endpoint path (default "/token")
    "ttlMs": 300000                         // optional; minted-token lifetime (default 5 min)
  }
}
```

**JWKS variant** — fetch RS256/ES256 signing keys from a real OIDC IdP
(Okta/Entra/Auth0/Google), selected by `kid`:

```jsonc
{
  "tokenExchange": {
    "jwksUri": "https://idp.acme.com/.well-known/jwks.json",  // must be https (loopback http only for dev)
    "algorithms": ["RS256", "ES256"],        // optional allowlist; default RS256 + ES256
    "issuer": "https://idp.acme.com/",
    "audience": "openharness-gateway",
    "groupsClaim": "groups",
    "tokenPath": "/token",
    "ttlMs": 300000
  }
}
```

| field | type | required | note |
|---|---|---|---|
| `idpPublicKey` | PEM path | one-of | static Ed25519 verifier; mutually exclusive with `jwksUri` |
| `jwksUri` | URL string | one-of | JWKS endpoint; mutually exclusive with `idpPublicKey` |
| `algorithms` | `["RS256"\|"ES256"]` (non-empty) | no | JWKS only; default RS256 + ES256 |
| `issuer` | non-empty string | yes | expected `iss` on the subject token |
| `audience` | non-empty string | yes | expected `aud` on the subject token |
| `groupsClaim` | non-empty string | no | subject-token claim mapped to groups |
| `tokenPath` | non-empty string | no | default `/token` |
| `ttlMs` | positive integer | no | default `300000` (5 min) |

Two schema refinements are enforced at load:

1. **Exactly one of** `idpPublicKey` **or** `jwksUri` — supplying both or neither
   is a validation error.
2. **`jwksUri` must be `https`** — the only `http` allowed is a loopback host
   (`127.0.0.1` / `localhost` / `::1`) for dev. Fetching IdP signing keys over
   cleartext http would let a network attacker swap the JWKS and forge subject
   tokens, so it is refused at construction.

Either way the subject token is validated (signature + `iss`/`aud`/`exp`) before
a gateway token is minted; a subject token that fails validation gets **no**
token (HTTP 401). The token endpoint is not itself DPoP-authenticated — it is the
bootstrap that *issues* the DPoP-bound token.

### `broker`

Credential-broker selection (deploy hardening §4). **Omit** for the default
single-credential store: each upstream resolves one secret from
`upstream:<upstreamId>`. Set `kind: "pool"` to draw each upstream from an
**ordered list of credential refs** (each stored `upstream:<ref>`) and rotate
behind the gateway — a rate-limited or auth-failed credential rotates to the next
ref on the next call.

```jsonc
{
  "broker": {
    "kind": "pool",                                  // required literal
    "upstreams": {                                   // upstreamId -> ordered credential refs (non-empty list each)
      "github": ["github-a", "github-b"]
    }
  }
}
```

| field | type | required |
|---|---|---|
| `broker.kind` | literal `"pool"` | yes (within the block) |
| `broker.upstreams` | record: upstreamId -> non-empty string[] | yes (within the block) |

Provision each ref with `set-secret` (`set-secret github-a`, `set-secret
github-b`). A production KMS-backed broker is injected programmatically by the
deployment (not via this config) — there is no dev-only KMS config selector.

### `sandbox`

Out-of-process connector isolation (deploy hardening §5). **Omit** to run
connectors in-process (guarded by the egress allowlist + forward-proxy tap). Set
`kind: "child-process"` to run each connector's `call()` in a warm
per-(principal, connector) worker process (own memory + crash domain), so a
connector bug or supply-chain compromise can't read other principals' in-flight
data or the broker handle.

```jsonc
{
  "sandbox": {
    "kind": "child-process",                            // required literal
    "registryModule": "./my-connectors.ts",             // optional; module the worker imports for `factories`
    "execArgv": ["--experimental-strip-types", "--no-warnings"]  // optional; Node flags for the fork
  }
}
```

| field | type | required | default |
|---|---|---|---|
| `sandbox.kind` | literal `"child-process"` | yes (within the block) | -- |
| `sandbox.registryModule` | path string | no | built-in first-party registry |
| `sandbox.execArgv` | string[] | no | `["--experimental-strip-types", "--no-warnings"]` |

`registryModule` (resolved relative to the config) is the module the worker
imports for its connector `factories`; the same module is imported in-process to
snapshot each connector's static descriptor (`tools`/`allowHosts`). The default
`execArgv` strips TypeScript so a `.ts` worker runs; a bundled/compiled deploy
sets `"execArgv": []`.

---

## Secrets & env

**No secret ever lives in the config file.** The config carries key file *paths*
and upstream credential *names*; the credentials live in a machine-local
encrypted store, and operator tokens come from the environment.

### Provisioning upstream credentials — `set-secret`

Each upstream credential is stored under `upstream:<id>` in an
`EncryptedFileSecretStore`. The broker resolves it **after** the policy decision
allows a call. The value is read from **STDIN** (never argv/shell history):

```bash
printf 'ghp_your_org_token' | npm run gateway -- set-secret github --secrets "$OH/gw/secrets"
#  -> stored credential for upstream 'github' (value not logged).
```

- The store directory is resolved consistently for both `set-secret` and
  `serve`: an explicit `--secrets <dir>`, else `OPENHARNESS_GATEWAY_SECRETS`,
  else `<config-dir>/secrets`, else `./secrets`. Point both commands at the same
  store.
- An `<id>` must match `[A-Za-z0-9._-]`; an empty value is refused.
- For a `broker` **pool**, store one secret per **ref** (`set-secret github-a`,
  `set-secret github-b`) — the refs, not the upstream id, are the store keys.

### Environment variables

| env var | used by | purpose |
|---|---|---|
| `OPENHARNESS_GATEWAY_ADMIN_TOKEN` | `serve` | Out-of-band admin bearer for the approval surface. When set, `GET/POST <adminPath>/approvals` mount so a policy `ask` is answerable over HTTP. Resolves to approver identity `"admin"`. Never in the config. |
| `OPENHARNESS_GATEWAY_SECRETS` | `serve`, `set-secret` | Overrides the encrypted secret-store directory (below `--secrets`, above the config-adjacent default). |

### Per-approver tokens (`approvers`)

Real dual control (`approval.requireSecondPerson`) needs **per-approver** tokens,
not the single shared admin token. Each maps an approver identity to a bearer
token; the approval surface authenticates the approver by their token and uses
that **identity** as the `by` on the resolution — so an approver can't self-approve
and the identity can't be spoofed via the request body.

The `approvers` map (identity -> token) is passed to `startGatewayFromConfig`
by the deployment, sourced from **its own env / secret store, never the config
file**. The CLI's `serve` wires only `adminToken` from the environment; a
deployment that needs `requireSecondPerson` embeds `startGatewayFromConfig`
(see [`packages/gateway/src/serve.ts`](../packages/gateway/src/serve.ts)) and
supplies `approvers` there. Approver names should match the requester principal
shape (e.g. an email / IdP `sub`) so self-approval is detected. Empty approver
tokens are rejected at boot (an empty bearer would authenticate any caller).

---

## Transport & exposure

**DPoP edge auth, no token passthrough.** Every request to the MCP endpoint is
authenticated at the edge with a request-bound, single-use DPoP proof (token +
proof + key-binding) before anything touches the pipeline. There is no session
affinity — each request re-proves possession of the bound key, which is what
makes a leaked token worthless off the client's machine. A request without a
valid proof is refused with 401 before the pipeline runs. The gateway signs each
response with its private key so the client can verify it against the `pubkey` it
pinned in its harness definition (`gateway: { url, pubkey, tools }`).

**Loopback vs TLS.** The gateway process serves **plain HTTP** and does not
terminate TLS itself — TLS termination is a deployment concern (front it with a
reverse proxy / ingress that terminates TLS). The trust boundary is enforced on
the **client** side: the harness bridge refuses a non-loopback gateway URL that
isn't `https`
([`packages/core/src/gateway-bridge.ts`](../packages/core/src/gateway-bridge.ts),
`requireSecureUrl`):

> `gateway url '<url>' must use https — refusing to send credentials over an
> unencrypted channel (plaintext is allowed only for loopback dev/test).`

So: **loopback (`127.0.0.1` / `localhost` / `::1`) may use `http` for dev; any
other host must be reached over `https`.** Deploy accordingly — bind the gateway
to loopback behind a TLS-terminating proxy, and give clients the `https` URL.
(A separate `https`-only rule governs the IdP `jwksUri`, see
[`tokenExchange`](#tokenexchange).)

**Audit source naming.** The gateway writes its own authoritative chain to
`auditPath`. A client's local chain can be cross-checked against it: `audit
reconcile <local> <gateway>` compares the governed calls and fails closed on
unparseable input. When shipping a local chain to the audit server, each
`--source` gets its own retained chain (`ingested-<source>.jsonl`) and a *new*
chain pushed to an existing source is refused as a fork. See
[`RUNLOCAL.md` §4](RUNLOCAL.md#4-the-audit-anchor--tamper-evidence-that-survives-a-forged-local-log)
for the audit-anchor flow and [`RUNLOCAL.md` §5](RUNLOCAL.md#5-the-v2-governed-remote-mcp-gateway)
for the DPoP token exchange and approval endpoints end to end.

---

## Known caveats

The gateway's governed pipeline is built and exercised end to end; three
deployment seams (IdP, KMS broker, connector runtime) are provider-agnostic
interfaces with offline reference implementations — a real deployment wires the
specific IdP JWKS, the specific KMS/secrets-manager, TLS termination, and (if
sandboxing) the worker runtime. These are the honestly-accepted, tracked limits
relevant to running the gateway (full list in
[`SECURITY.md`](../SECURITY.md#known-limitations-accepted-tracked)):

- **Dual-control identity is string-shape matching.** `requireSecondPerson`
  compares the authenticated approver identity to the requester's `sub`; the
  deployment must issue approver names in the IdP-`sub` shape (e.g. email), or an
  operator holding two aliases could self-approve. Empty approver tokens are
  rejected at boot; `requireSecondPerson` with no per-approver token fails closed.
- **`audit reconcile` is a scoped cross-check, not the anchor.** It compares the
  multiset of gateway-governed `(tool, argsHash)` between a local and a gateway
  chain; it does not catch a reordering, nor a forged local call of a tool the
  gateway recorded zero times. The authoritative tamper signal remains the
  server's push-rejection of a forked/forged chain.
- **The persisted anti-rollback floor is only as durable as the baked version.**
  Relevant if you host update bundles alongside the gateway: the floor file lives
  in the same user-writable dir as the updates, so a local writer can roll back
  to — but never below — the baked bundle's version. A sealed/keychain-backed
  floor is tracked hardening.
- **The encrypted file store's key sits beside the ciphertext** (`secret.key`
  next to `secrets.enc`, both `0600`). This defends against backup/accidental
  disclosure, not against a principal who can read the directory. The
  KMS-backed broker (deploy hardening §4) is the production replacement; an
  OS-keychain backend is the tracked follow-up.
- **Local-first enforcement is bypassable by a determined user with a debugger**
  — but the gateway **confines the blast radius**: org credentials never touch
  the client, so a compromised endpoint means abuse limited to one user's policy
  scope, fully audited and revocable in one place. See
  [`ARCHITECTURE.md` "Honest boundary"](ARCHITECTURE.md#honest-boundary) and
  [`SECURITY.md` "Honest threat-model boundaries"](../SECURITY.md#honest-threat-model-boundaries).

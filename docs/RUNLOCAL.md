# Run OpenHarness locally

A verified, copy-pasteable walkthrough of **everything you can exercise on your
own machine** — from one chat turn to the signed-bundle trust model, the
authoritative audit anchor, and the governed remote MCP gateway. No cloud, no
accounts, no external services. Every command below was run against the current
`main`.

**Prerequisites**

- **Node ≥ 22.19** (`node --version`). That's the only requirement for
  everything except the final desktop *installer*.
- An **LLM API key** for the one step that actually talks to a model (chat).
  Every other step is fully offline.
- **Rust + Tauri prerequisites** ONLY for building the desktop installer
  ([tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)).

Two CLIs drive everything, both run through the repo's dev runner (no global
install): `npm run chat -- <args>` (authoring, bundles, audit, the server) and
`npm run gateway -- <args>` (the v2 governed gateway). Pass CLI args after `--`.

```bash
git clone https://github.com/guim4dev/openharness && cd openharness
npm install
npm test          # the whole suite is green offline
npm run typecheck
```

A scratch dir keeps the walkthrough out of your tree:

```bash
export OH=/tmp/oh-local && mkdir -p "$OH"
```

---

## 1. One live chat turn (bring your own key)

The only step that hits a model. The harness picks the provider matching whichever key it finds.

```bash
export ANTHROPIC_API_KEY=sk-...      # or OPENAI_API_KEY / GEMINI_API_KEY / OPENCODE_GO_API_KEY
npm run chat -- harnesses/example "Say hello in one line."
```

The reply streams to your terminal. Your key is written to an encrypted on-disk
store (never logged); `npm run chat` prints the config path if no key is found.

## 2. Author your own harness

`init` scaffolds a minimal, valid, offline-safe definition; `doctor` preflights
it (structure, policy, model gate, MCP supply-chain pinning) without building.

```bash
npm run chat -- init "$OH/my-harness" --name assistant --display "Acme Assistant"
npm run chat -- doctor "$OH/my-harness"
#  -> doctor: assistant@0.1.0 OK
```

A definition dir is just files — `harness.json`, `system-prompt.md`,
`policy.json`, `skills/`, and a starter `README.md`. Edit them and re-run
`doctor`. See
[`AUTHORING.md`](AUTHORING.md) for every field. Then chat against it exactly like
step 1: `npm run chat -- "$OH/my-harness" "..."`.

## 3. Sign a bundle, verify it, watch a tampered one get refused

The trust model: a definition is signed with the org's key; anything that
doesn't verify under the matching public key is refused.

```bash
npm run chat -- keygen --out "$OH/org"                                  # org.key (0600) + org.pub
npm run chat -- bundle "$OH/my-harness" --out "$OH/assistant.ohbundle" --key "$OH/org.key"
npm run chat -- bundle verify "$OH/assistant.ohbundle" --pubkey "$OH/org.pub"
#  -> bundle OK: assistant@0.1.0

# Flip one byte and verify again — it is refused:
node -e 'const f=process.argv[1],b=require("fs").readFileSync(f);b[b.length>>1]^=1;require("fs").writeFileSync(f+".bad",b)' "$OH/assistant.ohbundle"
npm run chat -- bundle verify "$OH/assistant.ohbundle.bad" --pubkey "$OH/org.pub"
#  -> bundle REJECTED: signature verification failed — ... (exit 1)
```

`bundle verify --min-version X` also refuses a validly-signed but **older**
bundle (anti-rollback). The full branded-app version of this story is in
[`DEMO.md`](DEMO.md).

**Pull a newer definition (update channel).** `openharness update` fetches the
hosted bundle from a server, verifies it under the org pubkey with a persisted
monotonic **floor** as the minimum version, and writes an accepted newer bundle
to an updates dir (advancing the floor). A tampered or rolled-back bundle is
refused; the floor means an attacker who later drops an older org-signed bundle
into the updates dir cannot roll the app back **below the baked version** (the
floor file is user-writable, so a local writer can delete it, dropping the
durable floor to — never below — the version shipped inside the signed app).

```bash
# (host a v0.2.0 bundle via `openharness serve --bundles <dir>`; see §4 for serve)
npm run chat -- update --server http://127.0.0.1:8899 --pubkey "$OH/org.pub" \
    --updates "$OH/updates" --floor "$OH/floor.txt" --name assistant --current 0.1.0
#  -> updated to 0.2.0 (written to .../updates, floor advanced)
#  re-run → "already up to date at 0.2.0"; a rolled-back/tampered bundle → "update REJECTED", exit 1
```

## 4. The audit anchor — tamper-evidence that survives a forged local log

OpenHarness records external-call events to a hash-chained log. That local chain
is a self-consistency check; **the real tamper-evidence is the server**, which
retains a per-source HEAD and refuses any submission that doesn't continue it.
Here you run the server, ship a log to it, and watch a tampered log get refused.

**Terminal A — the bundle host + audit sink:**

```bash
mkdir -p "$OH/srv-bundles" "$OH/srv-audit"
npm run chat -- serve --bundles "$OH/srv-bundles" --audit "$OH/srv-audit" --port 8899
#  -> openharness server listening at http://127.0.0.1:8899
```

**Terminal B — produce a log, verify it, ship it:**

```bash
export OH=/tmp/oh-local
# A real 3-record chained log (a live session writes this for you; here we seed one):
node --import tsx -e 'import {createFileAuditLog} from "@openharness/audit";const s=createFileAuditLog(process.argv[1]);for(let i=0;i<3;i++)s.record({type:"tool_call",tool:`t${i}`,decision:"allow",argsHash:`h${i}`})' "$OH/session.jsonl"

npm run chat -- audit verify "$OH/session.jsonl"
#  -> audit log OK

npm run chat -- audit push "$OH/session.jsonl" --server http://127.0.0.1:8899 --source sess-demo
#  -> shipped 3 record(s) to http://127.0.0.1:8899 (source=sess-demo, ackedSeq=2)

# Idempotent + resumable — a second push ships nothing new:
npm run chat -- audit push "$OH/session.jsonl" --server http://127.0.0.1:8899 --source sess-demo
#  -> shipped 0 record(s) ... (ackedSeq=2)
```

**Cross-check two chains.** `audit reconcile` compares the governed calls in a
local chain against a gateway chain and reports any divergence. It **verifies
both chains first and fails closed** on a corrupt/truncated/unverifiable file
(it never reports "no divergence" on input it couldn't parse). Here we point it
at the copy the server ingested — a well-formed round-trip, so it agrees:

```bash
npm run chat -- audit reconcile "$OH/session.jsonl" "$OH/srv-audit/ingested-sess-demo.jsonl"
#  -> audit chains reconcile: 3 governed call(s) match, no divergence
#  (divergence → "audit DIVERGENCE (tamper evidence): ..." with per-call lines, exit 1;
#   a corrupt/unverifiable file → "audit reconcile FAILED — input could not be trusted", exit 1)
```

Reconcile is a **cross-check, not the anchor**: it's a multiset compare scoped to
the gateway's governed tools, so it does not catch a reordering or a forged call
of a tool the gateway never recorded. The authoritative tamper signal remains the
**server** refusing a forked/forged push (above).

Now forge the local log and ship it to a **fresh** source — the server refuses:

```bash
node --import tsx -e 'import {createFileAuditLog} from "@openharness/audit";const s=createFileAuditLog(process.argv[1]);for(let i=0;i<3;i++)s.record({type:"tool_call",tool:`t${i}`,decision:"allow",argsHash:`h${i}`})' "$OH/forged.jsonl"
node -e 'const f=process.argv[1],fs=require("fs");const L=fs.readFileSync(f,"utf8").split("\n").filter(x=>x.trim());const r=JSON.parse(L[1]);r.tool="HACKED";L[1]=JSON.stringify(r);fs.writeFileSync(f,L.map(x=>x+"\n").join(""))' "$OH/forged.jsonl"

npm run chat -- audit push "$OH/forged.jsonl" --server http://127.0.0.1:8899 --source tamper-demo
#  -> audit integrity ALARM: the server rejected the chain — {"error":"audit rejected: entry 1 hash does not match its contents"}  (exit 1)
```

The local chain alone (`audit verify`) can't catch a motivated forger who
recomputes it — the **server** does. A live session ships automatically: pass
`auditServer` to `createLiveSession`, or run `audit push` on a timer / at
shutdown.

> The server remembers each `--source`'s chain (in `ingested-<source>.jsonl`).
> That's the point — a *new* chain pushed to an existing source is a fork and is
> refused. To start clean, use a fresh `--audit` dir (or a new `--source`).

## 5. The v2 governed remote MCP gateway

The gateway runs the governed pipeline as an MCP server: a pinned tool catalog,
server-side policy, DPoP-authenticated requests (no token passthrough), a
credential broker that resolves the org secret **after** the policy decision,
and an authoritative audit log. The org's per-upstream credential lives in an
encrypted store beside the config — never in the config file.

```bash
export OH=/tmp/oh-local && mkdir -p "$OH/gw"
npm run chat -- keygen --out "$OH/gw/gw"          # the gateway's signing keypair
# The IdP's Ed25519 keypair (for token exchange, below). Any Ed25519 PEM works:
node -e 'const{generateKeyPairSync}=require("crypto"),fs=require("fs");const k=generateKeyPairSync("ed25519",{publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});fs.writeFileSync(process.argv[1],k.publicKey);fs.writeFileSync(process.argv[2],k.privateKey)' "$OH/gw/idp.pub" "$OH/gw/idp.key"

cat > "$OH/gw/config.json" <<'JSON'
{
  "host": "127.0.0.1", "port": 8900,
  "keys": { "publicKey": "gw.pub", "privateKey": "gw.key" },
  "policy": { "default": "allow", "rules": [{ "match": "github__*", "action": "allow" }] },
  "policyVersion": "1.0.0",
  "auditPath": "gateway-audit.jsonl",
  "tokenExchange": { "idpPublicKey": "idp.pub", "issuer": "https://idp.local", "audience": "openharness-gateway" },
  "catalog": [
    { "name": "github__list_issues", "connectorId": "github",
      "inputSchema": { "type": "object", "properties": { "owner": {"type":"string"}, "repo": {"type":"string"} }, "required": ["owner","repo"] } }
  ],
  "connectors": [ { "id": "github", "type": "github-read" } ]
}
JSON

# Store the upstream credential (value read from STDIN, never argv/shell history):
printf 'ghp_your_org_token' | npm run gateway -- set-secret github --secrets "$OH/gw/secrets"
#  -> stored credential for upstream 'github' (value not logged).

npm run gateway -- serve "$OH/gw/config.json"
#  -> [openharness-gateway] listening at http://127.0.0.1:8900/mcp
```

From another terminal, the edge auth is live — a request without a DPoP proof is
refused before it touches the pipeline:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8900/mcp    # -> 401
```

**Token exchange (deploy hardening §3).** Because the config declares
`tokenExchange`, the gateway mints a DPoP-bound token from an org-IdP subject
token. Mint an Ed25519 JWT with the IdP key and exchange it:

```bash
export OH=/tmp/oh-local
TOKEN=$(node -e 'const{sign}=require("crypto"),fs=require("fs");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const h=b({alg:"EdDSA",typ:"JWT"});const p=b({sub:"alice@acme.com",iss:"https://idp.local",aud:"openharness-gateway",exp:Math.floor(Date.now()/1000)+300,groups:["eng"]});process.stdout.write(h+"."+p+"."+sign(null,Buffer.from(h+"."+p),fs.readFileSync(process.argv[1],"utf8")).toString("base64url"))' "$OH/gw/idp.key")
CLIENTPUB=$(node -e 'process.stdout.write(Buffer.from(require("crypto").generateKeyPairSync("ed25519",{publicKeyEncoding:{type:"spki",format:"pem"}}).publicKey).toString("base64url"))')

curl -s -X POST http://127.0.0.1:8900/token -H "authorization: Bearer $TOKEN" -H "x-oh-dpop-key: $CLIENTPUB"
#  -> {"access_token":"...","token_type":"DPoP","expires_in":300}
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8900/token -H "authorization: Bearer nope" -H "x-oh-dpop-key: $CLIENTPUB"
#  -> 401  (a subject token that fails IdP validation gets NO gateway token)
```

**Answering an `ask` (server-side approval).** If your policy `ask`s a tool, the
call suspends server-side until a human decides. Start the gateway with an admin
token in the environment and the approval surface mounts:

```bash
OPENHARNESS_GATEWAY_ADMIN_TOKEN=admin-secret npm run gateway -- serve "$OH/gw/config.json"
# then, out of band:
curl -s http://127.0.0.1:8900/admin/approvals -H 'authorization: Bearer admin-secret'
#  -> {"pending":[{"id":"...","principal":"...","tool":"...","argsSummary":"..."}]}
curl -s -X POST http://127.0.0.1:8900/admin/approvals/<id> -H 'authorization: Bearer admin-secret' \
     -H 'content-type: application/json' -d '{"approved":true,"by":"you@org"}'
#  -> {"ok":true}   (the suspended call proceeds; a wrong/absent admin token → 401/404)
```

For real dual-control (`requireSecondPerson`), wire **per-approver** tokens
instead of the single admin token — the deployment passes an
`approvers` map (identity → token) to `startGatewayFromConfig`. The approver is
then authenticated by their token and that identity is the `by`, so an approver
can't approve their own request and the identity can't be spoofed via the body.

A real client keeps the DPoP *private* key (this demo only sends the public one),
uses the returned `access_token` to sign per-request proofs, and declares the
gateway in its harness definition (`gateway: { url, pubkey, tools }`) — see the
[`harnesses/acme-gateway`](../harnesses/acme-gateway) example. The full governed
call path (allow audited · no-DPoP refused · deny never reaches upstream · IdP
JWT → token → call) is exercised end to end in
`packages/gateway/src/{http,serve}.test.ts`.

**Credential pooling + rotation (config).** Add a `broker` block to rotate each
upstream across an ordered pool of credential refs (each stored `upstream:<ref>`
via `set-secret`); a rate-limited/auth-failed credential rotates behind the
gateway on the next call:

```json
"broker": { "kind": "pool", "upstreams": { "github": ["github-a", "github-b"] } }
```

**Out-of-process connector sandbox (config).** Add `"sandbox": { "kind":
"child-process" }` and each connector's `call()` runs in a warm per-(principal,
connector) worker process (own memory + crash domain). The default worker runs
under `node --experimental-strip-types`; a bundled deploy sets
`"sandbox": { "kind": "child-process", "execArgv": [] }`.

> The IdP token-exchange verifier is **config-selectable**: `tokenExchange`
> takes either `idpPublicKey` (the static single-Ed25519-key verifier used above)
> or **`jwksUri`** (a JWKS-fetching verifier for a real OIDC IdP — Okta/Entra/
> Auth0/Google — that verifies RS256/ES256 keys selected by `kid`, `https`-only).
> Exactly one is required. The KMS credential broker stays programmatic — a real
> KMS is injected via the deployment's own broker, so there's no dev-only KMS
> config selector.

## 6. Build a branded desktop app

Turn a definition into a company-branded, signed app that boots pinned to the
verified definition and refuses a tampered one. The `build` step is offline; the
final installer needs the Tauri/Rust prerequisites.

```bash
npm run chat -- build "$OH/my-harness" --key "$OH/org.key" --out "$OH/dist" --org acme --name assistant
cd "$OH/dist" && npx tauri build      # -> a branded installer (requires Rust + Tauri)
```

The desktop app also runs live in dev (Tauri prerequisites required):

```bash
npm run dev:desktop
```

> **The packaged app needs `node` findable.** It launches a Node sidecar, and a
> GUI app started from Finder/launchd has a MINIMAL PATH (no Homebrew/nvm). The
> launcher resolves `node` for you — it probes PATH, then Homebrew / `/usr/local`,
> then nvm (newest) / volta / asdf, and honors `OH_NODE_PATH=/path/to/node`. If
> `node` still isn't found the app opens in a "Not connected" state (it degrades
> rather than crashing). Running the binary from a terminal — where `node` is on
> PATH — always works.

> **Fixed — the macOS launch crash.** Earlier packaged builds could abort *at
> launch* with `panic … cannot unwind` inside `tao::…::did_finish_launching`.
> Root cause was two of our own launch-time faults (not the upstream
> [tao#1171](https://github.com/tauri-apps/tao/issues/1171), which was only the
> vehicle the panic rode out on): (1) `app.path().resource_dir()` refuses when any
> ancestor of the exe path is a **symlink** (e.g. `/tmp -> /private/tmp` on
> macOS) — the release build now resolves `Contents/Resources` directly from
> `std::env::current_exe()`; (2) the Node sidecar wasn't found under launchd's bare
> PATH — now handled by the `node` resolver above. Both are fixed; the app boots
> from any launch context (verified against a rebuilt DMG). If a
> `did_finish_launching` abort ever recurs, capture the real reason under lldb —
> `lldb -b -o "breakpoint set -n objc_exception_throw" -o run -o "po (id)$x0" -o
> "expression -O -- (id)[(id)$x0 reason]" <app binary>` — and check the exe path
> for a symlink ancestor and `node` on the launch PATH first.

## 7. Clean up

```bash
rm -rf /tmp/oh-local
```

---

Something here didn't match what you saw? That's a bug in this guide — please
open an issue. The commands are meant to be exact.

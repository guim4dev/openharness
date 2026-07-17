# v2 gateway — deploy hardening (design proposal)

**Status:** IMPLEMENTED (seams). All three hardening seams below — token
exchange (§3), KMS broker (§4), connector sandbox (§5) — plus artifact
attestation are now built as **provider-agnostic interfaces + offline reference
implementations + tests**, behind the interfaces this design identified. What
this design flagged as needing real infra + a human decision (§7) is exactly
what remains: a deployment wires the specific IdP JWKS, the specific
KMS/secrets-manager (instance role / workload identity), the worker
runtime/latency budget, and the Sigstore trust-root for attestation. The code
does not pick those for you — it makes each a one-interface swap.

Originally written autonomously (Fable-authored) as decision-support; kept as
the rationale for the shape that was built.

**Relationship to the roadmap:** this is the "Remaining: deploy hardening" line
under the v2 milestone in [`../ROADMAP.md`](../ROADMAP.md), and the "Deferred"
tail of [`2026-07-14-remote-mcp-gateway-design.md`](2026-07-14-remote-mcp-gateway-design.md).
Read that gateway design first — this only hardens its three deployment seams.

---

## 1. Goal, stated honestly

The v2 gateway is built, adversarially hardened, and runnable end to end
(`openharness-gateway set-secret` → `serve`; a harness declares a `gateway`, the
core bridges its tools, DPoP authenticates every request). What it runs on today
is **dev-grade** in exactly three places. Deploy hardening replaces each with the
production mechanism — without changing the governed pipeline, which is done.

The honest claim: this does not add a new security *property*; it makes the
existing v2 properties (no token passthrough, server-side authority, confined
blast radius) hold under a real deployment instead of a single-operator localhost.

## 2. Current state — the three dev-grade seams

1. **Token minting is direct.** `mintGatewayToken(claims, gatewayPrivKey, clientPub, …)`
   signs a DPoP-bound token with the gateway's own ed25519 key. There is no
   identity provider, no user authentication, no expiry/refresh policy beyond the
   `ttlMs` the caller passes. Fine for a test; in production the org's IdP must be
   the source of "who is this employee, and are they still allowed."
2. **The credential broker is a local encrypted file.** `SecretStoreKms` wraps the
   machine-local `EncryptedFileSecretStore` (`upstream:<id>`). The `KmsStore`
   interface already exists and is the ONLY seam the pipeline touches — but the
   one implementation keeps plaintext-decryptable secrets on the gateway host's
   disk under a locally-derived key.
3. **Connectors run in-process.** A connector (`createGithubReadConnector`,
   `createNotifyConnector`) executes in the gateway's own Node process, guarded by
   an egress allowlist + the forward-proxy tap. A connector bug or a malicious
   first-party-looking connector shares the gateway's memory (every principal's
   in-flight requests, the broker handle).

## 3. Token minting → IdP + OAuth 2.1 token exchange (RFC 8693)

**Mature standard:** OAuth 2.1 + Token Exchange (RFC 8693). The harness
authenticates the employee against the org IdP (Okta/Entra/Auth0/Keycloak/…),
obtains a subject token, and exchanges it — at a gateway token endpoint — for the
short-lived, DPoP-bound gateway access token the pipeline already validates. The
`sub`/`groups` claims (today client-asserted, "audit/routing only") become
IdP-asserted and thus trustworthy for per-principal policy.

**Flow (recommended):**
1. Harness does OAuth 2.1 Authorization Code + PKCE against the org IdP → subject token (+ refresh).
2. Harness presents the subject token + its DPoP client pubkey to the gateway's
   `POST /token` (RFC 8693 `grant_type=token-exchange`).
3. Gateway validates the subject token against the IdP's JWKS, maps IdP
   claims → `GatewayClaims`, and mints the DPoP-bound token (the existing
   `mintGatewayToken` internals, now server-side and IdP-gated). Short TTL
   (≤5 min); the harness re-exchanges on expiry using its refresh token.

**Options / trade-offs:**
- *(A) Full token-exchange endpoint on the gateway* (recommended) — the gateway
  is the token authority; cleanest fit with the existing DPoP token. Requires
  wiring one IdP's JWKS + claim mapping.
- *(B) A separate auth service mints tokens; the gateway only validates* — more
  moving parts; better if the org already runs a token service.
- *(C) mTLS instead of DPoP* — rejected: DPoP is already built and binds to a
  client key without a cert PKI.

**Interface change:** add a token-exchange handler alongside `startGatewayHttp`
(reusing `mintGatewayToken`), plus an `IdpVerifier` seam (validate subject token,
return claims) so the IdP is swappable and testable with a stub. The pipeline and
DPoP validation are unchanged.

## 4. Credential broker → KMS-backed `KmsStore`

**Mature standard:** a cloud KMS / secrets manager (AWS KMS + Secrets Manager,
GCP KMS, HashiCorp Vault). The `KmsStore` interface (`resolve(upstreamId) →
UpstreamCredential`) already isolates this — only a new implementation is needed;
no pipeline change.

**Options / trade-offs:**
- *(A) Secrets manager stores the secret; KMS gates decryption* (recommended) —
  the gateway holds no long-lived plaintext; each `resolve` is an authenticated
  fetch/decrypt, auditable in the KMS's own log, and rotation happens out-of-band.
- *(B) Envelope encryption on the existing file store, DEK wrapped by KMS* —
  lighter, but plaintext still transits the gateway host memory on every call
  (unavoidable — the connector needs it) and the file is a second copy to manage.
- *(C) Broker never returns the secret; connectors call a KMS-signed request* —
  strongest (secret never in gateway memory) but only works for upstreams that
  accept a pre-signed request (e.g. SigV4); not general. Worth it later for
  specific high-value upstreams.

**Recommendation:** ship (A) behind the existing `KmsStore` interface as a second
implementation (`AwsSecretsKmsStore` or a Vault one), selected by the gateway
config's connector/broker section. Keep `SecretStoreKms` as the local/dev default.
This is where an [OpenConnector](../vision.md#13) backend could also slot in.

## 5. Connector sandbox → out-of-process isolation

**Threat:** a connector is the one component that makes arbitrary network calls
with a real org credential. In-process, a bug or a supply-chain compromise of a
connector reads other principals' in-flight data and the broker handle.

**Options / trade-offs:**
- *(A) One short-lived container per call* — strongest isolation; highest latency
  (container cold-start per tool call) unless pooled.
- *(B) A warm per-connector worker process (or container), credential passed
  per call, egress via the tap as today* (recommended first slice) — process
  isolation (separate memory) at low latency; the tap + allowlist already live at
  this boundary.
- *(C) gVisor / Firecracker microVM* — strongest kernel isolation; heaviest ops.

**Recommendation:** start with (B) — move the connector runtime behind a
worker-process boundary (the `ConnectorSessions` seam already creates per-
principal connector instances; make "instance" a subprocess with a typed IPC
carrying `{tool, args, cred}` in and a `ConnectorResult` out). The egress
allowlist + tap move into the worker. Revisit (A)/(C) for untrusted
third-party connectors.

## 6. What does NOT change

The governed pipeline (PDP, post-decision broker resolution, return-path
redaction, authoritative audit, fail-closed approval, per-user isolation), the
DPoP token *shape* and its validation, the harness-side bridge, and the pinned
catalog are all done and untouched. Every hardening item swaps a dev
implementation behind an interface that already exists (`KmsStore`,
`ConnectorSessions`) or adds an edge handler (token exchange) — none rewrites the
core. That is the payoff of the v2 seams.

## 7. Open questions a human must answer first

1. **Which IdP** (Okta / Entra / Auth0 / Keycloak / other), and is Authorization
   Code + PKCE acceptable for the harness (desktop app) client type?
2. **Token/refresh policy:** access-token TTL, refresh lifetime, revocation
   propagation SLA (how fast must a de-provisioned employee lose gateway access?).
3. **Which KMS / secrets manager** the org standardizes on — this picks the
   `KmsStore` implementation and its auth (instance role / workload identity).
4. **Latency budget per tool call** — decides connector sandbox (B) warm-worker
   vs (A) per-call container.
5. **Trust tier of connectors:** are all connectors first-party (favors B), or
   must third-party connectors run (pushes toward A/C)?
6. **Where the gateway runs** (the org's k8s / a VM / a managed offering) — feeds
   the v2.x "managed cloud" line and the sandbox choice.

## 8. Smallest defensible slice (once §7 is answered)

Token exchange first (it gates everything else and is pure software once an IdP
is chosen): the `IdpVerifier` seam + a `POST /token` handler + a stub-IdP
integration test, behind the existing DPoP token. Then the KMS `KmsStore` impl
(one provider). The connector sandbox last (biggest ops surface, smallest
incremental risk reduction given the tap already blocks the headline exfil).

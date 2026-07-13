# @openharness/desktop

The OpenHarness desktop app: a [Tauri v2](https://v2.tauri.app) shell (Rust) that
hosts a React chat UI and, on startup, spawns a **Node sidecar** running a real
Pi `AgentSession`. The UI streams assistant tokens from that session over a
loopback WebSocket.

## Layout

```
apps/desktop/
  ui/                 React chat UI (Vite). Reads window.__OPENHARNESS__.
  dist-ui/            Vite production build (Tauri's frontendDist).
  src/
    sidecar.ts        startSidecar(): loopback WS bridge over a Pi session.
    server.ts         Runnable sidecar entry; prints {port,token} on stdout.
    index.ts          Package exports.
  vite.config.ts      UI build (root: ui, outDir: ../dist-ui).
  src-tauri/          Tauri (Rust) shell.
    src/main.rs       Spawns the sidecar, reads the handshake, injects it, opens the window.
    tauri.conf.json   v2 config; frontendDist -> ../dist-ui, devUrl -> :5173.
    Cargo.toml, build.rs, capabilities/default.json, icons/
```

## How the shell and sidecar connect

1. `main.rs` spawns the sidecar (`node --import tsx src/server.ts`) with its cwd
   set to the repo root and `OH_HARNESS_PATH` pointing at a harness definition.
2. `server.ts` calls `startSidecar()`, which stands up a `127.0.0.1` WebSocket
   server on an **ephemeral port** gated by a random per-launch **token**, then
   prints one JSON line to stdout: `{"port":<n>,"token":"<t>"}`.
3. `main.rs` scans stdout for that first parseable JSON line, then creates the
   webview window with an initialization script that sets
   `window.__OPENHARNESS__ = { port, token }` before any page script runs.
4. The UI reads `window.__OPENHARNESS__` and opens
   `ws://127.0.0.1:<port>?token=<token>`. The token is enforced at the WS
   upgrade (401 without it), so the local listener is not unauthenticated.

The sidecar is killed when the app exits (`RunEvent::Exit`). As orphan
protection, stdin is left piped: if the shell dies without a clean exit, the
pipe closes and `server.ts` shuts itself down.

## Run it (manual GUI)

Prereqs: Rust (`cargo`), Node >= 22.19 (Pi requires it), and workspace deps
installed (`npm install` at the repo root).

```bash
cd apps/desktop
npm run dev:desktop     # = tauri dev: builds/serves the UI (vite :5173) and launches the shell
```

`npm run build:desktop` (= `tauri build`) produces a bundled app. Bundling a
distributable also needs the sidecar packaged as a single binary — see
*Limitations* below; it is not wired yet.

You can also run just the sidecar to inspect the handshake:

```bash
cd apps/desktop
OH_HARNESS_PATH=../../harnesses/example npm run sidecar
# -> {"port":54123,"token":"…"}
```

## Live models need a credential account

The sidecar wires the same in-memory credential seam as the Phase-1 smoke CLI,
with **no accounts configured**. It starts and the UI connects, but a prompt
streams back an *error* frame (not tokens) until a credential account exists for
the harness's provider. Configured accounts / live model turns are the
credential layer's job; wire one in `server.ts` (via `CredentialManager` /
`AuthProviderRegistry`) to drive real models.

## Configuration (env, read by the shell / sidecar)

| Var | Default | Meaning |
| --- | --- | --- |
| `OH_HARNESS_PATH` | `harnesses/example` | Harness definition dir the sidecar loads |
| `OH_PROFILE` | harness default | Credential profile to drive |
| `OH_SIDECAR_ENTRY` | `apps/desktop/src/server.ts` | Sidecar entry the shell spawns |
| `OH_CWD` | `process.cwd()` | Working dir for the Pi session |

## Limitations / not yet wired

- **Distribution.** The sidecar runs via `node --import tsx` against the
  workspace sources — great for dev, not self-contained. A real bundle needs the
  harness compiled to a single binary (bun `--compile`, Node SEA, or pkg) and
  wired as a Tauri `externalBin`, which must be reconciled with Pi's native
  `pi-tui` prebuilds and the Node >= 22.19 requirement.
- **Dev paths are compile-time.** The shell resolves the repo root and sidecar
  entry from `CARGO_MANIFEST_DIR`, so a moved/installed binary would need
  `OH_SIDECAR_ENTRY` set (or the distribution work above).
- **No credential account** is configured by default (see above).

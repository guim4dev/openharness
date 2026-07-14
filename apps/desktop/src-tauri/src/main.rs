// Prevents an extra console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Deserialize;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The loopback coordinates the Node sidecar prints as its first JSON line on
/// stdout. The webview opens `ws://127.0.0.1:<port>?token=<token>`.
#[derive(Deserialize)]
struct Handshake {
    port: u16,
    token: String,
}

/// Owns the sidecar child process so it can be killed when the app exits.
struct Sidecar(Mutex<Option<Child>>);

/// Repo root, derived from this crate's location:
/// `<repo>/apps/desktop/src-tauri` -> up 3 -> `<repo>`. Dev only: in release
/// `CARGO_MANIFEST_DIR` is the (nonexistent) build machine's path, so the
/// sidecar's inputs are resolved from the bundled resource dir instead.
#[cfg(debug_assertions)]
fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .map(PathBuf::from)
        .unwrap_or(manifest)
}

/// Where the sidecar's boot inputs live, resolved once per build profile in
/// `.setup`. Debug points at the source checkout; release points at the sealed
/// bundle resources (`resource_dir()`), which only a `Manager` can resolve.
struct SidecarPaths {
    /// Default sidecar entry before the `OH_SIDECAR_ENTRY` override.
    default_entry: PathBuf,
    /// Working directory for the sidecar process.
    working_dir: PathBuf,
    /// Verified-boot inputs `(bundle, org_pubkey)` — release only.
    verified: Option<(PathBuf, PathBuf)>,
    /// Anti-rollback floor file (min-version.txt) baked beside the bundle —
    /// release only. Its contents become `OH_MIN_VERSION` for the sidecar.
    min_version: Option<PathBuf>,
    /// Local dev harness dir default — debug only.
    dev_harness: Option<PathBuf>,
}

/// Spawn the Node sidecar. Cross-platform: invokes the real `node` binary
/// (not a shell shim), so no `cmd /C` / `.cmd` handling is needed. A `.ts`
/// entry is run through the `tsx` loader (dev); a prebuilt `.mjs`/`.js` runs on
/// bare `node` (release). Every default is overridable via env:
///   OH_SIDECAR_ENTRY    sidecar entry (default: dev .ts source / release server.mjs)
///   OH_HARNESS_PATH     dev-boot harness dir (debug default: harnesses/example)
///   OH_BUNDLE_PATH      signed bundle for verified boot (release default: resources)
///   OH_ORG_PUBKEY_PATH  org pubkey for verified boot (release default: resources)
///   OH_MIN_VERSION      anti-rollback floor for verified boot (release default: read
///                       from the baked resources/min-version.txt)
///   OPENHARNESS_APP_ID  config-dir namespace (default: this build's Tauri `identifier`).
///                       Manual override is for advanced/test use only — a normal build
///                       should rely on the Tauri identifier so branded builds (each with
///                       their own templated identifier) get isolated config dirs instead
///                       of falling back to the shared default (see
///                       `packages/core/src/paths.ts::configDir`).
fn spawn_sidecar(app_id: &str, paths: &SidecarPaths) -> std::io::Result<Child> {
    let entry = std::env::var("OH_SIDECAR_ENTRY")
        .map(PathBuf::from)
        .unwrap_or_else(|_| paths.default_entry.clone());

    let mut cmd = Command::new("node");
    if entry.extension().and_then(|e| e.to_str()) == Some("ts") {
        cmd.arg("--import").arg("tsx");
    }
    cmd.arg(&entry)
        .current_dir(&paths.working_dir)
        // Keep stdin piped and retained on the Child: if this process dies
        // without killing the child, the OS closes the pipe and the sidecar
        // sees stdin end and shuts itself down (orphan protection).
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    // Dev boot: default the local (unverified) harness dir.
    if let Some(dir) = &paths.dev_harness {
        if std::env::var_os("OH_HARNESS_PATH").is_none() {
            cmd.env("OH_HARNESS_PATH", dir);
        }
    }

    // Verified boot (release): pin the sidecar to the signed bundle, verified
    // under the shipped org pubkey. A tampered/wrong-key bundle brings the
    // sidecar up in refusal mode rather than trusting unapproved config.
    if let Some((bundle, pubkey)) = &paths.verified {
        if std::env::var_os("OH_BUNDLE_PATH").is_none() {
            cmd.env("OH_BUNDLE_PATH", bundle);
        }
        if std::env::var_os("OH_ORG_PUBKEY_PATH").is_none() {
            cmd.env("OH_ORG_PUBKEY_PATH", pubkey);
        }
    }

    // Anti-rollback floor: read the baked min-version.txt and pass its trimmed
    // contents as OH_MIN_VERSION so the sidecar refuses an older (but still
    // org-signed) bundle. A missing/unreadable file leaves the floor unset (the
    // signature + hash gates still apply), matching the "optional" contract.
    if let Some(path) = &paths.min_version {
        if std::env::var_os("OH_MIN_VERSION").is_none() {
            if let Ok(contents) = std::fs::read_to_string(path) {
                let trimmed = contents.trim();
                if !trimmed.is_empty() {
                    cmd.env("OH_MIN_VERSION", trimmed);
                }
            }
        }
    }

    // Namespace the sidecar's config dir (credentials, audit log, state) to
    // THIS app's identity so distinct brands/builds on the same machine never
    // share a config dir. Only fill it in if the caller hasn't already set one
    // (advanced/test override); otherwise it's always the real Tauri identifier.
    if std::env::var_os("OPENHARNESS_APP_ID").is_none() {
        cmd.env("OPENHARNESS_APP_ID", app_id);
    }

    cmd.spawn()
}

/// Read stdout until the first line that parses as a `Handshake`. Non-JSON
/// chatter (resource-loader logs, etc.) is forwarded to stderr and skipped.
/// Returns the handshake (if any) and the reader positioned past it, so the
/// caller can keep draining the pipe.
fn read_handshake<R: BufRead>(mut reader: R) -> (Option<Handshake>, R) {
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return (None, reader), // EOF before a handshake
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(h) = serde_json::from_str::<Handshake>(trimmed) {
                    return (Some(h), reader);
                }
                eprintln!("[sidecar] {trimmed}");
            }
            Err(e) => {
                eprintln!("[sidecar] read error: {e}");
                return (None, reader);
            }
        }
    }
}

fn main() {
    let builder = tauri::Builder::default().setup(|app| {
        let app_id = app.config().identifier.clone();
        // Brand the window from the (per-brand templated) productName.
        let window_title = app
            .config()
            .product_name
            .clone()
            .unwrap_or_else(|| "OpenHarness".to_string());

        // Dev resolves the sidecar's inputs from the source checkout; release
        // from the sealed bundle resources (`resource_dir()` needs a Manager,
        // hence resolving here in setup rather than in a free function).
        #[cfg(debug_assertions)]
        let paths = {
            let root = repo_root();
            SidecarPaths {
                default_entry: root.join("apps/desktop/src/server.ts"),
                working_dir: root.clone(),
                verified: None,
                min_version: None,
                dev_harness: Some(root.join("harnesses/example")),
            }
        };
        #[cfg(not(debug_assertions))]
        let paths = {
            let res = app.path().resource_dir()?;
            SidecarPaths {
                default_entry: res.join("server.mjs"),
                verified: Some((res.join("harness.ohbundle"), res.join("org.pub"))),
                min_version: Some(res.join("min-version.txt")),
                dev_harness: None,
                working_dir: res,
            }
        };

        let mut child = spawn_sidecar(&app_id, &paths)
            .map_err(|e| format!("failed to spawn Node sidecar (is `node` on PATH?): {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or("sidecar was spawned without a stdout pipe")?;

        let (handshake, reader) = read_handshake(BufReader::new(stdout));

        // Keep draining stdout so a chatty sidecar never fills the pipe buffer
        // and blocks. (The handshake has already been consumed.)
        thread::spawn(move || {
            let mut reader = reader;
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => eprint!("[sidecar] {line}"),
                }
            }
        });

        app.manage(Sidecar(Mutex::new(Some(child))));

        // Inject the loopback coords the UI reads from `window.__OPENHARNESS__`
        // before any page script runs. When the handshake was missed, ship no
        // script — the UI falls back to its "Not connected" state.
        let init_script = handshake.as_ref().map(|h| {
            format!(
                "window.__OPENHARNESS__ = {{ port: {}, token: {} }};",
                h.port,
                serde_json::to_string(&h.token).unwrap_or_else(|_| "\"\"".to_string())
            )
        });
        if init_script.is_none() {
            eprintln!(
                "[openharness] sidecar handshake not received; UI will start disconnected"
            );
        }

        let mut window =
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(&window_title)
                .inner_size(1280.0, 800.0);
        if let Some(script) = &init_script {
            window = window.initialization_script(script);
        }
        window.build()?;

        Ok(())
    });

    builder
        .build(tauri::generate_context!())
        .expect("error while building the OpenHarness application")
        .run(|app_handle, event| {
            // Kill the sidecar when the app is exiting so it never outlives us.
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Sidecar>() {
                    if let Some(mut child) = state.0.lock().ok().and_then(|mut g| g.take()) {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}

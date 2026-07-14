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
/// `<repo>/apps/desktop/src-tauri` -> up 3 -> `<repo>`.
fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .map(PathBuf::from)
        .unwrap_or(manifest)
}

/// Spawn the Node sidecar. Cross-platform: invokes the real `node` binary
/// (not a shell shim), so no `cmd /C` / `.cmd` handling is needed. A `.ts`
/// entry is run through the `tsx` loader (dev); a prebuilt `.mjs`/`.js` runs on
/// bare `node`. Overridable via env for packaging experiments:
///   OH_SIDECAR_ENTRY    path to the sidecar entry (default: apps/desktop/src/server.ts)
///   OH_HARNESS_PATH     harness definition dir the sidecar loads (default: harnesses/example)
///   OPENHARNESS_APP_ID  app id the sidecar namespaces its config dir under (default:
///                       `app_id`, this build's Tauri `identifier` from tauri.conf.json).
///                       Manual override is for advanced/test use only — a normal build
///                       should rely on the Tauri identifier so branded builds (each with
///                       their own templated identifier) get isolated config dirs instead
///                       of falling back to the shared default (see
///                       `packages/core/src/paths.ts::configDir`).
fn spawn_sidecar(app_id: &str) -> std::io::Result<Child> {
    let root = repo_root();
    let entry = std::env::var("OH_SIDECAR_ENTRY")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join("apps/desktop/src/server.ts"));

    let mut cmd = Command::new("node");
    if entry.extension().and_then(|e| e.to_str()) == Some("ts") {
        cmd.arg("--import").arg("tsx");
    }
    cmd.arg(&entry)
        .current_dir(&root)
        // Keep stdin piped and retained on the Child: if this process dies
        // without killing the child, the OS closes the pipe and the sidecar
        // sees stdin end and shuts itself down (orphan protection).
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    if std::env::var_os("OH_HARNESS_PATH").is_none() {
        cmd.env("OH_HARNESS_PATH", root.join("harnesses/example"));
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
        let mut child = spawn_sidecar(&app_id)
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
                .title("OpenHarness")
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

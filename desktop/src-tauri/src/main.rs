// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    net::TcpStream,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, Runtime,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

// ── constants ────────────────────────────────────────────────────────────────

const SERVE_HOST: &str = "127.0.0.1";
const SERVE_PORT: u16 = 7777;
const SERVE_URL: &str = "http://127.0.0.1:7777";
/// How long to poll before giving up while waiting for the server to be ready.
const HEALTH_TIMEOUT_SECS: u64 = 30;
/// Interval between health-check probes.
const HEALTH_POLL_MS: u64 = 250;

// ── shared state ─────────────────────────────────────────────────────────────

struct ServeProcess(Option<CommandChild>);

// ── helpers ──────────────────────────────────────────────────────────────────

/// Block until 127.0.0.1:7777 accepts a TCP connection or the timeout expires.
fn wait_for_server() -> bool {
    let deadline = Instant::now() + Duration::from_secs(HEALTH_TIMEOUT_SECS);
    while Instant::now() < deadline {
        if TcpStream::connect((SERVE_HOST, SERVE_PORT)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(HEALTH_POLL_MS));
    }
    false
}

/// Return `~/.ashlr/.desktop-initialized` — the first-run marker path.
fn desktop_initialized_marker() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".ashlr")
        .join(".desktop-initialized")
}

/// Returns `true` if this is the very first launch (marker absent).
fn is_first_run() -> bool {
    !desktop_initialized_marker().exists()
}

/// Write the first-run marker so subsequent launches skip setup.
fn mark_initialized() {
    let marker = desktop_initialized_marker();
    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&marker, b"");
}

/// Return the path to `~/.ashlr/KILL`.
fn kill_switch_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".ashlr").join("KILL")
}

/// Read whether the kill-switch file currently exists.
fn kill_switch_active() -> bool {
    kill_switch_path().exists()
}

/// Toggle the kill-switch file on/off.  Returns the new state (true = active).
fn toggle_kill_switch() -> bool {
    let p = kill_switch_path();
    if p.exists() {
        let _ = std::fs::remove_file(&p);
        false
    } else {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&p, b"");
        true
    }
}

// ── first-run setup ──────────────────────────────────────────────────────────

/// Run `ashlr setup --yes` via the sidecar (non-blocking, fire-and-forget).
///
/// On completion (success or error) the marker is written so the next launch
/// skips this entirely.  If setup fails the app continues normally — the user
/// will land on the dashboard and can run setup manually.
fn run_first_time_setup(app: &tauri::App<impl Runtime>) {
    eprintln!("[ashlr-desktop] First launch detected — running `ashlr setup --yes`");

    let handle: AppHandle<_> = app.handle().clone();
    let _ = handle.emit("ashlr-setup-started", ());

    match app
        .shell()
        .sidecar("ashlr")
        .expect("ashlr sidecar not configured")
        .args(["setup", "--yes"])
        .spawn()
    {
        Ok((mut rx, _child)) => {
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            eprintln!("[ashlr-setup] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[ashlr-setup] ERR {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(status) => {
                            if status.code == Some(0) {
                                eprintln!("[ashlr-desktop] setup completed successfully");
                            } else {
                                eprintln!(
                                    "[ashlr-desktop] setup exited with code {:?} — continuing anyway",
                                    status.code
                                );
                            }
                            // Always mark initialized — never retry on every launch.
                            mark_initialized();
                            let _ = handle.emit("ashlr-setup-done", status.code);
                            break;
                        }
                        CommandEvent::Error(e) => {
                            eprintln!("[ashlr-desktop] setup spawn error: {e}");
                            mark_initialized();
                            let _ = handle.emit("ashlr-setup-done", -1_i32);
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => {
            // Sidecar could not be launched (e.g. binary missing in dev).
            // Log, mark, and continue — the app is still usable.
            eprintln!("[ashlr-desktop] could not spawn setup sidecar: {e} — skipping first-run setup");
            mark_initialized();
            let _ = handle.emit("ashlr-setup-done", -1_i32);
        }
    }
}

// ── app setup ────────────────────────────────────────────────────────────────

fn setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    // ── first-run: run `ashlr setup --yes` once if the marker is absent ──────
    //
    // Runs before `ashlr serve` so config/engines are in place before the
    // server starts.  Idempotent — skipped entirely if the marker exists.
    if is_first_run() {
        run_first_time_setup(app);
    }

    // ── spawn `ashlr serve` as a sidecar ─────────────────────────────────────
    let (mut rx, child) = app
        .shell()
        .sidecar("ashlr")
        .expect("ashlr sidecar not configured")
        .args(["serve"])
        .spawn()
        .expect("failed to spawn ashlr serve sidecar");

    // Store the child so we can kill it on exit.
    app.manage(Arc::new(Mutex::new(ServeProcess(Some(child)))));

    // Forward stdout/stderr from the sidecar to the Tauri event bus so the
    // DevTools console can see it during development.
    let handle2 = handle.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let _ = handle2
                        .emit("sidecar-stdout", String::from_utf8_lossy(&line).into_owned());
                }
                CommandEvent::Stderr(line) => {
                    let _ = handle2
                        .emit("sidecar-stderr", String::from_utf8_lossy(&line).into_owned());
                }
                CommandEvent::Error(e) => {
                    eprintln!("[ashlr-desktop] sidecar error: {e}");
                }
                CommandEvent::Terminated(status) => {
                    eprintln!(
                        "[ashlr-desktop] sidecar exited with code {:?}",
                        status.code
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    // ── wait for the server, then show the window ─────────────────────────────
    let handle3 = handle.clone();
    thread::spawn(move || {
        if wait_for_server() {
            if let Some(win) = handle3.get_webview_window("main") {
                // The window's URL was already set to SERVE_URL in tauri.conf.json;
                // just make it visible now that the server is ready.
                let _ = win.show();
                let _ = win.set_focus();
            }
        } else {
            eprintln!(
                "[ashlr-desktop] timed out waiting for {SERVE_URL} — showing window anyway"
            );
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.show();
            }
        }
    });

    // ── tray icon ─────────────────────────────────────────────────────────────
    build_tray(app)?;

    Ok(())
}

fn build_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();

    // Menu items
    let open = MenuItemBuilder::with_id("open", "Open Dashboard").build(app)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let daemon_start = MenuItemBuilder::with_id("daemon_start", "Start Daemon").build(app)?;
    let daemon_stop = MenuItemBuilder::with_id("daemon_stop", "Stop Daemon").build(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let kill_label = if kill_switch_active() {
        "Kill Switch: ON  (click to disable)"
    } else {
        "Kill Switch: OFF (click to enable)"
    };
    let kill = MenuItemBuilder::with_id("kill_switch", kill_label).build(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Ashlr").build(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &sep1,
            &daemon_start,
            &daemon_stop,
            &sep2,
            &kill,
            &sep3,
            &quit,
        ],
    )?;

    // Load tray icon from the bundled PNG.
    let icon = Image::from_path(
        handle
            .path()
            .resource_dir()
            .unwrap_or_default()
            .join("icons/tray-icon.png"),
    )
    // Fall back to the app icon if the tray-specific icon is missing during dev.
    .or_else(|_| {
        Image::from_path(
            handle
                .path()
                .resource_dir()
                .unwrap_or_default()
                .join("icons/32x32.png"),
        )
    })?;

    TrayIconBuilder::with_id("main-tray")
        .tooltip("Ashlr")
        .icon(icon)
        .menu(&menu)
        .on_menu_event({
            let handle = handle.clone();
            move |app, event| handle_menu_event(app, event.id().as_ref())
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click on macOS/Windows toggles the window.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }

        "daemon_start" => {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = app2
                    .shell()
                    .sidecar("ashlr")
                    .expect("ashlr sidecar not configured")
                    .args(["daemon", "start"])
                    .output()
                    .await;
                match result {
                    Ok(out) => eprintln!(
                        "[ashlr-desktop] daemon start: {}",
                        String::from_utf8_lossy(&out.stdout)
                    ),
                    Err(e) => eprintln!("[ashlr-desktop] daemon start error: {e}"),
                }
            });
        }

        "daemon_stop" => {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = app2
                    .shell()
                    .sidecar("ashlr")
                    .expect("ashlr sidecar not configured")
                    .args(["daemon", "stop"])
                    .output()
                    .await;
                match result {
                    Ok(out) => eprintln!(
                        "[ashlr-desktop] daemon stop: {}",
                        String::from_utf8_lossy(&out.stdout)
                    ),
                    Err(e) => eprintln!("[ashlr-desktop] daemon stop error: {e}"),
                }
            });
        }

        "kill_switch" => {
            let active = toggle_kill_switch();
            eprintln!(
                "[ashlr-desktop] kill switch {}",
                if active { "ENABLED" } else { "DISABLED" }
            );
            // Update the menu item label to reflect the new state.
            // Tauri v2: retrieve the menu item and set its text.
            if let Some(tray) = app.tray_by_id("main-tray") {
                if let Some(menu) = tray.menu() {
                    if let Some(item) = menu.get("kill_switch") {
                        if let Some(mi) = item.as_menuitem() {
                            let new_label = if active {
                                "Kill Switch: ON  (click to disable)"
                            } else {
                                "Kill Switch: OFF (click to enable)"
                            };
                            let _ = mi.set_text(new_label);
                        }
                    }
                }
            }
        }

        "quit" => {
            // Kill the sidecar before exiting so we never leave orphan processes.
            if let Some(state) = app.try_state::<Arc<Mutex<ServeProcess>>>() {
                let mut guard = state.lock().unwrap();
                if let Some(child) = guard.0.take() {
                    let _ = child.kill();
                }
            }
            app.exit(0);
        }

        _ => {}
    }
}

// ── entry point ───────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| setup(app).map_err(|e| e.into()))
        .on_window_event(|window, event| {
            // Hide (don't close) the window when the user presses the X button
            // so the tray icon remains the only quit path.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error running Ashlr desktop app");
}

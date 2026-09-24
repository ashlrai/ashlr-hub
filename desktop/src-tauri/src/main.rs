// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Ashlr desktop — the native shell around Ashlr Verse.
//!
//! Launch sequence:
//!   1. A small designed **launch window** opens immediately, so the app is
//!      never an invisible process while the server boots.
//!   2. Port 7777 is probed. If something else already holds it, the launch
//!      window says so and offers to adopt the running server, retry, or quit —
//!      it never spins forever.
//!   3. `ashlr verse --port 7777 --no-open --json` is spawned as a sidecar. Its
//!      single startup JSON line carries the read and mutation tokens; that line
//!      is consumed here and never forwarded, logged, or shown.
//!   4. The **Verse window** is built with the saved geometry, a theme-matched
//!      background (no white flash in dark mode), an overlay title bar with the
//!      traffic lights inset into the 48px header strip, and the shell-contract
//!      initialization script (see `shell_contract.rs`). The launch window then
//!      closes.
//!   5. The sidecar is killed on every exit path, not just the tray's Quit —
//!      including signals and a previous run's crash (see `sidecar_guard`).
//!   6. While the window is open the sidecar is SUPERVISED: an unexpected exit
//!      restarts it with backoff and hands the new tokens to the live page
//!      (`sidecar_supervisor`), orphaned sidecars from earlier runs are swept at
//!      startup by argv + start time, and seat health is polled every 30 s for
//!      native notifications (`health_watch`).
//!   7. While Verse is out of sight the shell keeps the operator informed
//!      (V3.10, C8): `activity_watch` polls running chats, finished turns and
//!      the Needs-you queue; `notify` raises a banner only while the window is
//!      not in front; the tray shows "● N" and lists running chats; the Dock
//!      badge counts Needs-you items; an opt-in ⌃⌥Space (`hotkey`) brings the
//!      window forward. None of it can start, stop or steer the fleet.

use std::{
    net::TcpStream,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{Menu, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, LogicalPosition, LogicalSize, Manager, RunEvent,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tauri_plugin_updater::UpdaterExt;

mod activity_watch;
mod app_menu;
mod desktop_prefs;
mod health_watch;
mod hotkey;
mod launch_state;
mod notify;
mod shell_contract;
mod sidecar_guard;
mod sidecar_supervisor;
mod tray;
mod window_state;

use launch_state::{LaunchFailure, LaunchPayload, LaunchPhase};
use sidecar_supervisor::{RestartDecision, RestartPolicy};
use window_state::{MonitorRect, ShellTheme, WindowState};

// ── constants ────────────────────────────────────────────────────────────────

const SERVE_HOST: &str = "127.0.0.1";
const SERVE_PORT: u16 = 7777;
/// Origin the sidecar server listens on. The window only ever loads this origin
/// (see the CSP in tauri.conf.json) and the shell-contract script only runs on it.
const SERVE_ORIGIN: &str = "http://127.0.0.1:7777";
/// The Verse console the main window opens (tauri.conf.json `app.windows[0].url`).
const VERSE_URL: &str = "http://127.0.0.1:7777/verse/";
/// Label of the Verse window declared in tauri.conf.json (`create: false`,
/// built here once the sidecar has printed its tokens).
const MAIN_WINDOW_LABEL: &str = "main";
/// Label of the launch window, also declared with `create: false`.
const LAUNCH_WINDOW_LABEL: &str = "launch";
/// How long to wait for the sidecar to report readiness before the launch
/// window switches to its failure state.
const HEALTH_TIMEOUT_SECS: u64 = 30;
/// Interval between health-check probes.
const HEALTH_POLL_MS: u64 = 250;
/// Timeout for the "is the port already taken?" probe.
const PORT_PROBE_MS: u64 = 300;
/// Minimum gap between window-state writes while the user drags or resizes.
const STATE_FLUSH_THROTTLE_MS: u64 = 400;
/// Event the launch page emits when one of its buttons is pressed.
const LAUNCH_ACTION_EVENT: &str = "splash-action";
/// Event the launch page listens for to render its state.
const LAUNCH_STATE_EVENT: &str = "launch-state";
/// DOM event dispatched in the Verse page after a restarted sidecar's tokens
/// were handed over, so the page can re-establish its session right away
/// instead of on its next 401.
const SIDECAR_RESTARTED_DOM_EVENT: &str = "ashlr:sidecar-restarted";
/// The tray icon tauri.conf.json's `app.trayIcon` creates (Tauri names a
/// config tray `main` when it has no `id`). The shell adopts THAT icon rather
/// than building a second one — building its own left two icons in the menu
/// bar, one of them a menu-less template blob.
const CONFIG_TRAY_ID: &str = "main";
/// Slice the activity watch sleeps in, so Quit and "poll now" are prompt.
const WATCH_SLICE_MS: u64 = 250;

// ── shared state ─────────────────────────────────────────────────────────────

/// Everything the app owns across threads. One managed struct rather than
/// several, so the exit path can reap all of it in one place.
#[derive(Default)]
struct AppState {
    /// The running sidecar, if any. Taken and killed on exit.
    sidecar: Mutex<Option<CommandChild>>,
    /// Latest known window geometry + theme, flushed to disk on a throttle.
    window: Mutex<WindowState>,
    /// Epoch millis of the last window-state write.
    last_flush_ms: AtomicU64,
    /// Redacted sidecar diagnostics for the launch window's failure state.
    diagnostics: Mutex<Vec<String>>,
    /// True once a Verse window exists (or is being built).
    opened: AtomicBool,
    /// Incremented on every start attempt so a stale watcher cannot report a
    /// failure for a sequence the user has already retried past.
    attempt: AtomicU64,
    /// Source of sidecar generations (one per spawn).
    next_generation: AtomicU64,
    /// Generation of the sidecar we currently intend to be running; 0 = none.
    ///
    /// This is how a `Terminated` event tells a crash from a kill we asked for:
    /// every intentional stop (quit, "Try again", a replacement spawn) moves
    /// this away from the dying child's generation BEFORE signalling it, so only
    /// a child that is still the live generation when it exits has crashed.
    live_generation: AtomicU64,
    /// Set once the app is quitting. Nothing restarts after this.
    exiting: AtomicBool,
    /// Backoff + crash budget for unexpected sidecar exits.
    restart: Mutex<RestartPolicy>,
    /// The live sidecar's READ token, for the health and activity polls. Never
    /// logged, never forwarded; cleared whenever that sidecar stops.
    read_token: Mutex<Option<ReadToken>>,
    /// The live sidecar's MUTATION token, for ONE purpose: the tray's
    /// "Stop running chats…" cancel POSTs, after a native confirm. Same
    /// lifetime and rules as `read_token`. `None` for a read-only sidecar or an
    /// adopted server, which is what disables Stop in the tray.
    mutation_token: Mutex<Option<MutationToken>>,
    /// The tray as last rendered (rebuilt only when this changes).
    tray: Mutex<tray::TrayModel>,
    /// The Dock badge as last set; `None` until a window accepted one.
    badge: Mutex<Option<usize>>,
    /// The latest banner's click target (see `notify::PendingClick`).
    pending_click: Mutex<notify::PendingClick>,
    /// Banner burst guard.
    throttle: Mutex<notify::Throttle>,
    /// Settings ▸ Desktop preferences, persisted in `desktop_prefs`.
    prefs: Mutex<desktop_prefs::DesktopPrefs>,
    /// What the OS did with the hotkey preference.
    hotkey: Mutex<hotkey::HotkeyStatus>,
    /// How banners are delivered; `None` until detected (treated as the
    /// osascript fallback, which works for every build).
    delivery: Mutex<Option<notify::Delivery>>,
    /// Ask the activity watch to poll now (after Stop, after a restart).
    poll_now: AtomicBool,
    /// A Stop confirmation is on screen; a second click does not stack another.
    stopping: AtomicBool,
}

/// A read token held for the health poll. Deliberately no `Debug`.
struct ReadToken(String);

/// A mutation token held for the tray's Stop. Deliberately no `Debug`.
struct MutationToken(String);

/// Which sidecar command is backing the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SidecarMode {
    /// `ashlr verse --port 7777 --no-open --json` — serve with dispatch enabled,
    /// prints `{readToken, token}` once the server is listening (preferred).
    Verse,
    /// `ashlr serve --port 7777 --allow-dispatch --json` — same token record,
    /// used only when the bundled CLI predates the `verse` command.
    Serve,
}

impl SidecarMode {
    fn args(self) -> &'static [&'static str] {
        match self {
            SidecarMode::Verse => &["verse", "--port", "7777", "--no-open", "--json"],
            SidecarMode::Serve => &["serve", "--port", "7777", "--allow-dispatch", "--json"],
        }
    }

    fn label(self) -> &'static str {
        match self {
            SidecarMode::Verse => "ashlr verse",
            SidecarMode::Serve => "ashlr serve --allow-dispatch",
        }
    }
}

/// The machine-readable startup record both `ashlr verse --json` and
/// `ashlr serve --json` print on stdout as a single line once listening.
/// Only the fields the window needs are read; the values are never logged
/// (deliberately no `Debug` derive so the struct cannot be printed by accident).
#[derive(Deserialize)]
struct SidecarStartup {
    #[serde(rename = "readToken")]
    read_token: String,
    /// Mutation token — present when dispatch is enabled.
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}

impl SidecarStartup {
    fn as_shell_tokens(&self) -> shell_contract::ShellTokens<'_> {
        shell_contract::ShellTokens {
            read_token: &self.read_token,
            token: self.token.as_deref(),
        }
    }
}

// ── sidecar stdout routing ───────────────────────────────────────────────────

/// Where one sidecar stdout line goes: a startup record is consumed here
/// (`first` says whether this call flipped `ready`, i.e. no window exists yet);
/// anything else is forwarded on the `sidecar-stdout` event bus.
///
/// Every line is checked regardless of `ready`. If the user adopted an
/// already-running server before a slow first boot printed its record, the
/// record must still be routed to the window (and never emitted).
enum StdoutRoute {
    Startup { startup: SidecarStartup, first: bool },
    Forward,
}

fn route_stdout_line(text: &str, ready: &AtomicBool) -> StdoutRoute {
    match parse_startup_line(text) {
        Some(startup) => StdoutRoute::Startup {
            startup,
            first: !ready.swap(true, Ordering::SeqCst),
        },
        None => StdoutRoute::Forward,
    }
}

fn parse_startup_line(line: &str) -> Option<SidecarStartup> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let parsed: SidecarStartup = serde_json::from_str(trimmed).ok()?;
    if parsed.read_token.trim().is_empty() {
        return None;
    }
    if let Some(port) = parsed.port {
        if port != SERVE_PORT {
            eprintln!(
                "[ashlr-desktop] sidecar reported port {port}, expected {SERVE_PORT} — ignoring record"
            );
            return None;
        }
    }
    Some(parsed)
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// One non-blocking probe: is anything accepting connections on 7777?
fn port_is_open() -> bool {
    let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&(SERVE_HOST, SERVE_PORT)) else {
        return false;
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(PORT_PROBE_MS)).is_ok() {
            return true;
        }
    }
    false
}

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

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Lock a mutex, recovering the data from a poisoned lock (a panic elsewhere
/// must not take the exit path's reaping down with it).
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Where `tauri-plugin-shell` resolves the `ashlr` sidecar: next to our own
/// executable (`…/Ashlr.app/Contents/MacOS/ashlr` in the bundle). The orphan
/// sweep compares argv against exactly this path.
fn sidecar_binary_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "ashlr.exe" } else { "ashlr" };
    Some(dir.join(name).to_string_lossy().into_owned())
}

/// Mark the app as quitting: from here on no exit is a crash, and nothing
/// restarts.
fn mark_exiting(handle: &AppHandle) {
    if let Some(state) = handle.try_state::<AppState>() {
        state.exiting.store(true, Ordering::SeqCst);
    }
}

fn is_exiting(handle: &AppHandle) -> bool {
    handle
        .try_state::<AppState>()
        .map(|state| state.exiting.load(Ordering::SeqCst))
        .unwrap_or(true)
}

/// Locate the SPA assets the sidecar server should serve (`index.html`,
/// `app.js`, `styles.css`, `next/`).
///
/// `prepare-sidecar.mjs` stages them at `src-tauri/resources/public/` and
/// `bundle.resources` ships them as `<Resources>/public`; the compiled binary's
/// own default (`<exe dir>/public`) does not exist inside the bundle, so the
/// directory is handed over explicitly via `ASHLR_WEB_PUBLIC`.
fn web_public_dir(handle: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = handle.path().resource_dir() {
        candidates.push(dir.join("public"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("public"));
            candidates.push(dir.join("resources").join("public"));
        }
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("index.html").is_file())
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

// ── theme ────────────────────────────────────────────────────────────────────

/// The theme the window background should use before the page has painted.
///
/// Preference order: the theme the UI last reported (persisted next to the
/// geometry), then the OS appearance, then dark. Guessing from the OS alone is
/// wrong whenever the user has forced a theme inside Verse, which is exactly the
/// case where a white flash is most jarring.
fn startup_theme(saved: Option<ShellTheme>, os_theme: Option<tauri::Theme>) -> ShellTheme {
    if let Some(theme) = saved {
        return theme;
    }
    match os_theme {
        Some(tauri::Theme::Light) => ShellTheme::Light,
        _ => ShellTheme::Dark,
    }
}

fn tauri_color(theme: ShellTheme) -> tauri::window::Color {
    let (r, g, b, a) = theme.canvas_rgba();
    tauri::window::Color(r, g, b, a)
}

// ── window state ─────────────────────────────────────────────────────────────

/// The monitors attached right now, as logical rects.
///
/// Read from the `AppHandle` rather than from a window: the only window alive
/// when the geometry is restored is the launch window, and it is on its way out
/// (or already gone on the crash-recovery path). An empty list makes
/// `WindowState::clamped_to` drop the saved position and centre instead — which
/// is correct when there really is no display information, and silently loses
/// the user's window position when it is merely unavailable.
fn monitor_rects(handle: &AppHandle) -> Vec<MonitorRect> {
    let Ok(monitors) = handle.available_monitors() else {
        return Vec::new();
    };
    monitors
        .into_iter()
        .map(|m| {
            let scale = m.scale_factor();
            let pos = m.position().to_logical::<f64>(scale);
            let size = m.size().to_logical::<f64>(scale);
            MonitorRect {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect()
}

/// Read the live geometry of `window` into `state`, leaving the theme alone.
fn capture_geometry(window: &WebviewWindow, state: &mut WindowState) {
    // A minimised window reports a meaningless rect; keep the last good one.
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    state.maximized = maximized;
    if maximized {
        // Keep the restore-size from before maximising, so un-maximising later
        // lands somewhere sensible.
        return;
    }
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    if let Ok(size) = window.outer_size() {
        let logical = size.to_logical::<f64>(scale);
        if logical.width > 0.0 && logical.height > 0.0 {
            state.width = logical.width;
            state.height = logical.height;
        }
    }
    if let Ok(pos) = window.outer_position() {
        let logical = pos.to_logical::<f64>(scale);
        state.x = Some(logical.x);
        state.y = Some(logical.y);
    }
}

/// Persist the window state, at most once every `STATE_FLUSH_THROTTLE_MS`
/// unless `force` (used on exit, where the last position matters).
fn flush_window_state(state: &AppState, force: bool) {
    let now = now_ms();
    if !force {
        let last = state.last_flush_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last) < STATE_FLUSH_THROTTLE_MS {
            return;
        }
    }
    state.last_flush_ms.store(now, Ordering::Relaxed);
    let snapshot = match state.window.lock() {
        Ok(guard) => *guard,
        Err(poisoned) => *poisoned.into_inner(),
    };
    window_state::store(&snapshot);
}

// ── launch window ────────────────────────────────────────────────────────────

fn build_window_from_config<'a>(
    handle: &'a AppHandle,
    label: &str,
) -> Option<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>> {
    let config = handle
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == label)
        .cloned()?;
    WebviewWindowBuilder::from_config(handle, &config).ok()
}

/// Open the launch window.
///
/// `saved` is the theme the UI last reported, if any. When it is `None` the
/// window background and the page are both left to follow the OS appearance —
/// the native default and `prefers-color-scheme` already agree with each other,
/// and forcing a guess here is how a light-mode Mac ends up with a dark launch
/// window on its very first run.
fn create_launch_window(handle: &AppHandle, saved: Option<ShellTheme>) -> Option<WebviewWindow> {
    let mut builder = build_window_from_config(handle, LAUNCH_WINDOW_LABEL)?;
    if let Some(theme) = saved {
        builder = builder
            .background_color(tauri_color(theme))
            .initialization_script(format!(
                "window.__ASHLR_LAUNCH_THEME__ = {};",
                match theme {
                    ShellTheme::Dark => "\"dark\"",
                    ShellTheme::Light => "\"light\"",
                }
            ));
    }
    let built = builder.build();
    match built {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
            Some(window)
        }
        Err(e) => {
            eprintln!("[ashlr-desktop] could not create the launch window: {e}");
            None
        }
    }
}

/// Push a phase into the launch window. Safe to call before the page has
/// finished loading: the payload is also emitted as a Tauri event, and the page
/// asks for the current state once it is ready.
fn set_launch_phase(handle: &AppHandle, phase: &LaunchPhase) {
    let diagnostics = match handle.try_state::<AppState>() {
        Some(state) => match state.diagnostics.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        },
        None => Vec::new(),
    };
    let payload = phase.payload(&diagnostics);
    let _ = handle.emit(LAUNCH_STATE_EVENT, &payload);
    if let Some(window) = handle.get_webview_window(LAUNCH_WINDOW_LABEL) {
        if let Ok(json) = serde_json::to_string(&payload) {
            let _ = window.eval(format!(
                "window.__ASHLR_LAUNCH_STATE__ = {json}; if (typeof window.__ashlrRenderLaunch === 'function') window.__ashlrRenderLaunch(window.__ASHLR_LAUNCH_STATE__);"
            ));
        }
        // The failure state carries a hint, diagnostics and buttons; the window
        // is not resizable by the user, so it is grown here rather than making
        // the starting state a mostly-empty box.
        let (w, h) = launch_window_size(&payload);
        let _ = window.set_size(LogicalSize::new(w, h));
        let _ = window.center();
        let _ = window.show();
    }
}

/// Launch-window size for a payload.
///
/// Sized from the payload rather than the phase because the failure states are
/// not all the same height: "port is already in use" is diagnosed from the
/// probe and carries no sidecar output, so the tall window it used to get left
/// a dead band of empty canvas above the buttons.
fn launch_window_size(payload: &LaunchPayload) -> (f64, f64) {
    match payload.phase {
        "failed" if payload.detail.is_empty() => (540.0, 330.0),
        "failed" => (540.0, 460.0),
        _ => (480.0, 300.0),
    }
}

fn close_launch_window(handle: &AppHandle) {
    if let Some(window) = handle.get_webview_window(LAUNCH_WINDOW_LABEL) {
        let _ = window.close();
    }
}

fn record_diagnostic(handle: &AppHandle, line: &str) {
    let Some(state) = handle.try_state::<AppState>() else {
        return;
    };
    let mut guard = match state.diagnostics.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    launch_state::push_diagnostic(&mut guard, line);
}

fn clear_diagnostics(handle: &AppHandle) {
    let Some(state) = handle.try_state::<AppState>() else {
        return;
    };
    let mut guard = match state.diagnostics.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.clear();
}

// ── the Verse window ─────────────────────────────────────────────────────────

/// Create the Verse window with saved geometry, theme-matched background, the
/// overlay title bar, and the shell-contract script.
///
/// If the window already exists (the user adopted a running server and the
/// sidecar reported its tokens afterwards), the token script is evaluated into
/// the live page instead so `window.__ASHLR_TOKENS__` still appears there.
fn create_main_window(handle: &AppHandle, startup: Option<&SidecarStartup>) {
    let desktop = desktop_view(handle);
    let script = shell_contract::init_script_with_state(
        SERVE_ORIGIN,
        startup.map(|startup| startup.as_shell_tokens()),
        desktop.as_ref(),
    );

    let saved = handle
        .try_state::<AppState>()
        .map(|state| match state.window.lock() {
            Ok(guard) => *guard,
            Err(poisoned) => *poisoned.into_inner(),
        })
        .unwrap_or_default();
    let theme = startup_theme(saved.theme, handle.get_webview_window(LAUNCH_WINDOW_LABEL).and_then(|w| w.theme().ok()));

    let handle2 = handle.clone();
    let result = handle.run_on_main_thread(move || {
        if let Some(existing) = handle2.get_webview_window(MAIN_WINDOW_LABEL) {
            if let Err(e) = existing.eval(&script) {
                eprintln!("[ashlr-desktop] could not hand tokens to the open window: {e}");
            }
            let _ = existing.show();
            let _ = existing.set_focus();
            close_launch_window(&handle2);
            return;
        }

        let Some(builder) = build_window_from_config(&handle2, MAIN_WINDOW_LABEL) else {
            eprintln!("[ashlr-desktop] window '{MAIN_WINDOW_LABEL}' is missing from tauri.conf.json");
            return;
        };

        // Restore geometry against the monitors that exist right now.
        //
        // `app.windows[0].center` in tauri.conf.json is deliberately `false`:
        // a config-level `center: true` is applied *after* the builder's
        // `.position()` and silently discards the restored position. Centring
        // is done here instead, only when there is no position to restore.
        let monitors = monitor_rects(&handle2);
        if monitors.is_empty() {
            eprintln!(
                "[ashlr-desktop] no monitor information available — centring instead of restoring the saved position"
            );
        }
        let restored = saved.clamped_to(&monitors);

        let mut builder = builder
            .initialization_script(script)
            .background_color(tauri_color(theme))
            .inner_size(restored.width, restored.height);
        builder = match (restored.x, restored.y) {
            (Some(x), Some(y)) => builder.position(x, y),
            _ => builder.center(),
        };
        #[cfg(target_os = "macos")]
        {
            builder = builder.traffic_light_position(LogicalPosition::new(
                shell_contract::TRAFFIC_LIGHT_X,
                shell_contract::TRAFFIC_LIGHT_Y,
            ));
        }

        match builder.build() {
            Ok(win) => {
                if restored.maximized {
                    let _ = win.maximize();
                }
                let _ = win.show();
                let _ = win.set_focus();
                if let Some(state) = handle2.try_state::<AppState>() {
                    if let Ok(mut guard) = state.window.lock() {
                        guard.width = restored.width;
                        guard.height = restored.height;
                        guard.x = restored.x;
                        guard.y = restored.y;
                        guard.maximized = restored.maximized;
                    }
                }
                close_launch_window(&handle2);
            }
            Err(e) => {
                eprintln!("[ashlr-desktop] could not create the Verse window: {e}");
                set_launch_phase(
                    &handle2,
                    &LaunchPhase::Failed(LaunchFailure::SpawnFailed {
                        reason: "the application window could not be created".to_string(),
                    }),
                );
            }
        }
    });
    if let Err(e) = result {
        eprintln!("[ashlr-desktop] could not schedule window creation: {e}");
    }
}

/// Open the Verse window without tokens, against a server we did not start.
fn adopt_running_server(handle: &AppHandle) {
    if let Some(state) = handle.try_state::<AppState>() {
        state.opened.store(true, Ordering::SeqCst);
    }
    eprintln!(
        "[ashlr-desktop] adopting the server already listening on {SERVE_ORIGIN} — opening {VERSE_URL} without tokens"
    );
    create_main_window(handle, None);
}

// ── first-run setup ──────────────────────────────────────────────────────────

/// Run `ashlr setup --yes` via the sidecar (non-blocking, fire-and-forget).
///
/// On completion (success or error) the marker is written so the next launch
/// skips this entirely. If setup fails the app continues normally.
fn run_first_time_setup(app: &tauri::App) {
    eprintln!("[ashlr-desktop] First launch detected — running `ashlr setup --yes`");

    let handle: AppHandle = app.handle().clone();
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
            eprintln!(
                "[ashlr-desktop] could not spawn setup sidecar: {e} — skipping first-run setup"
            );
            mark_initialized();
            let _ = handle.emit("ashlr-setup-done", -1_i32);
        }
    }
}

// ── sidecar server ───────────────────────────────────────────────────────────

/// Kill the running sidecar, if any.
///
/// Every caller means it (quit, "Try again", closing the launch window), so the
/// live generation is dropped FIRST: the child's `Terminated` event then reads
/// as the stop we asked for, not a crash, and any restart still waiting out its
/// backoff sees that it is no longer wanted.
fn reap_sidecar(handle: &AppHandle) {
    let Some(state) = handle.try_state::<AppState>() else {
        return;
    };
    state.live_generation.store(0, Ordering::SeqCst);
    *lock(&state.read_token) = None;
    *lock(&state.mutation_token) = None;
    let mut guard = match state.sidecar.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(child) = guard.take() else {
        // No child of ours to reap. Crucially, do NOT clear the ownership
        // record here: on startup this runs *before* `reclaim_orphan`, and
        // clearing it would delete the only evidence that a previous run
        // crashed while its sidecar is still holding the port.
        return;
    };
    // `CommandChild::kill` signals only the immediate process. The Bun sidecar
    // runs its projection/background workers as separate children, so the tree
    // is stopped as well — otherwise those keep file locks in `~/.ashlr` after
    // the window is gone.
    //
    // ORDER MATTERS. This used to be `child.kill(); kill_tree(pid);`, which
    // achieved nothing: `child.kill()` is SIGKILL, so by the time `kill_tree`
    // shelled out to `pgrep -P <pid>` the workers had already been reparented
    // to pid 1 and the enumeration came back empty. The only pid ever signalled
    // was one that was already dead, and the workers leaked on the ordinary ⌘Q
    // path — the exact failure the extra call was added to prevent.
    //
    // `terminate_tree` walks the tree while the parent is still alive and gives
    // it a bounded SIGTERM grace first, so `ashlr verse` gets to run the
    // shutdown that releases its resource-quota lease.
    let pid = child.pid() as i32;
    sidecar_guard::terminate_tree(pid);
    // Now let Tauri reap its own handle; the process is already gone.
    let _ = child.kill();
    drop(guard);
    sidecar_guard::clear();
}

/// Start (or restart) the whole boot sequence: probe the port, spawn the
/// sidecar, and watch for readiness.
fn start_sequence(handle: AppHandle) {
    let attempt = match handle.try_state::<AppState>() {
        Some(state) => {
            state.attempt.fetch_add(1, Ordering::SeqCst) + 1
        }
        None => 1,
    };
    clear_diagnostics(&handle);
    set_launch_phase(&handle, &LaunchPhase::Starting);

    reap_sidecar(&handle);
    // A boot the operator asked for is a fresh start: a crash budget spent by a
    // previous sidecar must not stop this one from being supervised.
    if let Some(state) = handle.try_state::<AppState>() {
        lock(&state.restart).reset();
    }

    // A previous run that was SIGKILLed (or crashed) never got to reap its
    // sidecar, which is then still holding the port. Without this the app is
    // permanently stuck on the "port is already in use" screen after one crash.
    match sidecar_guard::reclaim_orphan(SERVE_PORT) {
        sidecar_guard::Reclaim::Killed(pid) => {
            eprintln!(
                "[ashlr-desktop] reclaimed the sidecar (pid {pid}) orphaned by a previous run"
            );
            // Give the kernel a moment to release the listening socket, or the
            // probe below still sees the port as taken.
            thread::sleep(Duration::from_millis(PORT_PROBE_MS));
        }
        sidecar_guard::Reclaim::OwnedByLiveApp => eprintln!(
            "[ashlr-desktop] another Ashlr window already owns the sidecar on {SERVE_PORT}"
        ),
        sidecar_guard::Reclaim::StaleRecordCleared | sidecar_guard::Reclaim::NothingRecorded => {}
    }

    // The record above names ONE sidecar. Anything else this bundle spawned
    // and lost track of (a fallback or a retry overwrote the record, two
    // crashes in a row) is found by what it is: parent gone, argv exactly ours,
    // start time unchanged at the moment of the kill.
    sweep_orphans();

    // A port that is already open means our own bind will fail. Say so now
    // rather than after a 30s spinner.
    if port_is_open() {
        eprintln!("[ashlr-desktop] {SERVE_HOST}:{SERVE_PORT} is already in use");
        set_launch_phase(
            &handle,
            &LaunchPhase::Failed(LaunchFailure::PortInUse { port: SERVE_PORT }),
        );
        return;
    }

    spawn_server_sidecar(handle, SidecarMode::Verse, attempt, SpawnKind::Boot);
}

/// Reap this bundle's orphaned sidecars and log (pids and ports only) any
/// other Ashlr servers, which are the operator's to stop.
fn sweep_orphans() {
    let Some(bin) = sidecar_binary_path() else {
        return;
    };
    let arg_sets = [SidecarMode::Verse.args(), SidecarMode::Serve.args()];
    let report = sidecar_supervisor::sweep_orphaned_sidecars(&bin, &arg_sets, None);
    for pid in &report.reaped {
        eprintln!("[ashlr-desktop] reaped an orphaned sidecar (pid {pid}) left by an earlier run");
    }
    for pid in &report.skipped_changed {
        eprintln!("[ashlr-desktop] left pid {pid} alone: it changed identity before it could be verified");
    }
    for (pid, port) in &report.foreign {
        match port {
            Some(port) => eprintln!(
                "[ashlr-desktop] note: another Ashlr server is running (pid {pid}, port {port}) — not ours, left running"
            ),
            None => eprintln!("[ashlr-desktop] note: another Ashlr server is running (pid {pid}) — not ours, left running"),
        }
    }
    if !report.reaped.is_empty() {
        // Same reason as after `reclaim_orphan`: let the socket go.
        thread::sleep(Duration::from_millis(PORT_PROBE_MS));
    }
}

/// True when `attempt` is still the live boot attempt (the user has not
/// pressed "Try again" since it started) and no window is open yet.
fn attempt_is_current(handle: &AppHandle, attempt: u64) -> bool {
    match handle.try_state::<AppState>() {
        Some(state) => {
            state.attempt.load(Ordering::SeqCst) == attempt
                && !state.opened.load(Ordering::SeqCst)
        }
        None => false,
    }
}

/// Why a sidecar is being spawned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SpawnKind {
    /// Part of a boot sequence (launch or "Try again"): failures go to the
    /// launch window, and a Verse-mode exit before readiness falls back to Serve.
    Boot,
    /// Replacing a sidecar that stopped unexpectedly while the window was open:
    /// the new tokens go to the live page without stealing focus, and a failure
    /// is just another exit for the restart policy.
    Restart,
}

/// Spawn the sidecar server in `mode`, watch its stdout for the startup JSON,
/// and create the Verse window once it arrives.
///
/// Token handoff:
///   1. `ashlr verse --port 7777 --no-open --json` starts the server with
///      dispatch enabled and prints ONE JSON line `{readToken, token, ...}`.
///   2. That line is parsed here and never forwarded to the event bus, to
///      stderr, or to the launch window. Every other stdout/stderr line is
///      forwarded as before (and redacted before it can reach the launch
///      window — see `launch_state::redact_diagnostic`).
///   3. The Verse window is then built with the shell-contract initialization
///      script, which sets `window.__ASHLR_TOKENS__`; SessionGate reads it and
///      exchanges the read token for its cookie without a paste prompt.
///
/// If the sidecar exits before printing the record (e.g. a CLI without the
/// `verse` command), `Verse` falls back to `Serve` once; if that also fails the
/// launch window explains why.
///
/// Once a sidecar has served, an exit nobody asked for (see
/// `AppState::live_generation`) goes to [`handle_unexpected_exit`], which
/// restarts it with backoff.
fn spawn_server_sidecar(handle: AppHandle, mode: SidecarMode, attempt: u64, kind: SpawnKind) {
    eprintln!(
        "[ashlr-desktop] {} sidecar: {}",
        if kind == SpawnKind::Restart { "restarting" } else { "starting" },
        mode.label()
    );

    let mut command = handle
        .shell()
        .sidecar("ashlr")
        .expect("ashlr sidecar not configured")
        .args(mode.args());
    match web_public_dir(&handle) {
        Some(public) => {
            eprintln!("[ashlr-desktop] serving web assets from {}", public.display());
            command = command.env("ASHLR_WEB_PUBLIC", &public);
        }
        None => eprintln!(
            "[ashlr-desktop] web assets (public/) not found next to the app — static routes may 404; run desktop/scripts/prepare-sidecar.mjs"
        ),
    }
    let spawned = command.spawn();

    let (mut rx, child) = match spawned {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[ashlr-desktop] failed to spawn {}: {e}", mode.label());
            if kind == SpawnKind::Restart {
                // No new generation was taken, so the crashed one is still the
                // live one and the policy decides whether to try again.
                if let Some(state) = handle.try_state::<AppState>() {
                    let generation = state.live_generation.load(Ordering::SeqCst);
                    if generation != 0 && !is_exiting(&handle) {
                        handle_unexpected_exit(&handle, mode, attempt, generation, Duration::ZERO);
                    }
                }
                return;
            }
            if attempt_is_current(&handle, attempt) {
                set_launch_phase(
                    &handle,
                    &LaunchPhase::Failed(LaunchFailure::SpawnFailed {
                        reason: e.to_string(),
                    }),
                );
            }
            return;
        }
    };
    let spawned_at = Instant::now();
    let pid = child.pid();

    // Record who owns this sidecar before anything else can go wrong, so a
    // crash from here on is repairable by the next launch.
    sidecar_guard::record(pid, SERVE_PORT, mode.args());

    // Take a generation and store the child so we can kill it on exit
    // (replacing a previous one on fallback).
    let generation = match handle.try_state::<AppState>() {
        Some(state) => {
            let generation = state.next_generation.fetch_add(1, Ordering::SeqCst) + 1;
            // Live BEFORE the previous child is signalled below, so its
            // Terminated event reads as a replacement, not a crash.
            state.live_generation.store(generation, Ordering::SeqCst);
            let mut guard = lock(&state.sidecar);
            if let Some(previous) = guard.take() {
                // Same ordering rule as `reap_sidecar`: the tree has to be
                // walked while the parent is alive, or `pgrep -P` finds nothing.
                let previous_pid = previous.pid() as i32;
                sidecar_guard::terminate_tree(previous_pid);
                let _ = previous.kill();
            }
            *guard = Some(child);
            generation
        }
        None => {
            eprintln!("[ashlr-desktop] app state slot missing — child will not be reaped on quit");
            0
        }
    };

    let ready = Arc::new(AtomicBool::new(false));
    // True once this sidecar has actually served (a startup record, or a
    // listening port the watchdog opened the window on). Only a sidecar that
    // served is restarted on exit; one that never came up is a boot failure
    // and belongs to the launch window.
    let served = Arc::new(AtomicBool::new(false));

    // Watchdog: if nothing reports readiness in time, say what we observed
    // instead of leaving a spinner up forever.
    {
        let handle = handle.clone();
        let ready = ready.clone();
        let served = served.clone();
        thread::spawn(move || {
            let listening = wait_for_server();
            thread::sleep(Duration::from_millis(HEALTH_POLL_MS * 4));
            if ready.load(Ordering::SeqCst) || !attempt_is_current(&handle, attempt) {
                return;
            }
            if listening {
                // The server IS up, it just never printed a record we could
                // read (an older CLI, for example). Opening the console
                // token-less works — the SessionGate asks for one.
                eprintln!(
                    "[ashlr-desktop] {SERVE_ORIGIN} is listening but no startup record was seen — showing {VERSE_URL} without tokens"
                );
                if ready.swap(true, Ordering::SeqCst) {
                    return;
                }
                served.store(true, Ordering::SeqCst);
                if let Some(state) = handle.try_state::<AppState>() {
                    state.opened.store(true, Ordering::SeqCst);
                }
                create_main_window(&handle, None);
            } else {
                eprintln!("[ashlr-desktop] timed out waiting for {SERVE_ORIGIN}");
                set_launch_phase(
                    &handle,
                    &LaunchPhase::Failed(LaunchFailure::Timeout {
                        seconds: HEALTH_TIMEOUT_SECS,
                    }),
                );
            }
        });
    }

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line).into_owned();
                    match route_stdout_line(&text, &ready) {
                        StdoutRoute::Startup { startup, first } => {
                            served.store(true, Ordering::SeqCst);
                            if let Some(state) = handle.try_state::<AppState>() {
                                // Only the live sidecar's token may be polled with.
                                if state.live_generation.load(Ordering::SeqCst) == generation {
                                    *lock(&state.read_token) = Some(ReadToken(startup.read_token.clone()));
                                    *lock(&state.mutation_token) = startup.token.clone().map(MutationToken);
                                    // Fresh server: refresh the tray and badge now
                                    // rather than up to 30 s from now.
                                    state.poll_now.store(true, Ordering::SeqCst);
                                }
                            }
                            if kind == SpawnKind::Restart {
                                eprintln!(
                                    "[ashlr-desktop] restarted {} is ready — handing its new tokens to the open window",
                                    mode.label()
                                );
                                hand_tokens_to_open_window(&handle, &startup);
                                continue; // never forward the token line
                            }
                            eprintln!(
                                "[ashlr-desktop] {} is ready (dispatch {}) — {}",
                                mode.label(),
                                if startup.token.is_some() {
                                    "enabled"
                                } else {
                                    "disabled"
                                },
                                if first {
                                    format!("opening {VERSE_URL}")
                                } else {
                                    "handing tokens to the already-open window".to_string()
                                }
                            );
                            if first {
                                // Belt and braces: the record is printed after listen().
                                wait_for_server();
                                set_launch_phase(&handle, &LaunchPhase::Ready);
                            }
                            if let Some(state) = handle.try_state::<AppState>() {
                                state.opened.store(true, Ordering::SeqCst);
                            }
                            create_main_window(&handle, Some(&startup));
                            // never forward the token line
                        }
                        StdoutRoute::Forward => {
                            record_diagnostic(&handle, &text);
                            let _ = handle.emit("sidecar-stdout", text);
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line).into_owned();
                    record_diagnostic(&handle, &text);
                    let _ = handle.emit("sidecar-stderr", text);
                }
                CommandEvent::Error(e) => {
                    eprintln!("[ashlr-desktop] sidecar error: {e}");
                    record_diagnostic(&handle, &e);
                }
                CommandEvent::Terminated(status) => {
                    eprintln!(
                        "[ashlr-desktop] sidecar ({}) exited with code {:?}",
                        mode.label(),
                        status.code
                    );
                    // Was this the sidecar we meant to be running? If not, it
                    // was reaped or replaced on purpose and everything below
                    // belongs to whoever did that.
                    let was_live = match handle.try_state::<AppState>() {
                        Some(state) if generation != 0 => {
                            let live = state.live_generation.load(Ordering::SeqCst) == generation;
                            if live {
                                // Drop the handle to the dead child: its pid can
                                // be recycled, and the replacement path above
                                // would otherwise signal whatever inherits it.
                                let mut guard = lock(&state.sidecar);
                                if guard.as_ref().map(|c| c.pid()) == Some(pid) {
                                    guard.take();
                                }
                                drop(guard);
                                *lock(&state.read_token) = None;
                                *lock(&state.mutation_token) = None;
                            }
                            live
                        }
                        _ => true,
                    };
                    if was_live {
                        // Disarm the guard: this pid is dead. Without this,
                        // `SIDECAR_PID` kept pointing at it for the rest of the
                        // app's life — the common case, since the app then parks
                        // on the "sidecar stopped while starting" screen — and a
                        // later SIGTERM/SIGINT/SIGHUP ran `terminate_handler`,
                        // which signals unconditionally with no argv check. Once
                        // the kernel recycled that pid, the victim was a
                        // stranger's process. `reclaim_orphan` goes to real
                        // trouble to prove a pid is ours before killing it; the
                        // warm paths cannot, so they must not stay armed on a pid
                        // known to be gone.
                        //
                        // ONLY when live: a reaped or replaced child's late
                        // Terminated must not wipe the record and armed pid of
                        // the sidecar that replaced it.
                        //
                        // The fallback below re-`record()`s via
                        // `spawn_server_sidecar`, so the Serve child stays covered.
                        sidecar_guard::clear();
                    }
                    if !was_live || is_exiting(&handle) {
                        break;
                    }
                    if served.load(Ordering::SeqCst) || kind == SpawnKind::Restart {
                        handle_unexpected_exit(&handle, mode, attempt, generation, spawned_at.elapsed());
                    } else if !ready.load(Ordering::SeqCst) && mode == SidecarMode::Verse {
                        eprintln!(
                            "[ashlr-desktop] `ashlr verse` unavailable in this build — falling back to `ashlr serve --allow-dispatch`"
                        );
                        ready.store(true, Ordering::SeqCst);
                        spawn_server_sidecar(handle.clone(), SidecarMode::Serve, attempt, SpawnKind::Boot);
                    } else if !ready.load(Ordering::SeqCst) && attempt_is_current(&handle, attempt) {
                        set_launch_phase(
                            &handle,
                            &LaunchPhase::Failed(LaunchFailure::SidecarExited {
                                code: status.code,
                            }),
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

/// A sidecar that had served stopped without being asked to: restart it with
/// backoff, or — past the crash budget — stop trying and say so natively.
///
/// `generation` is the crashed sidecar's; it stays the live generation until a
/// replacement spawns, which is how the delayed restart knows it is still
/// wanted (a quit or "Try again" in the meantime resets it).
fn handle_unexpected_exit(handle: &AppHandle, mode: SidecarMode, attempt: u64, generation: u64, uptime: Duration) {
    let Some(state) = handle.try_state::<AppState>() else {
        return;
    };
    let decision = lock(&state.restart).on_unexpected_exit(Instant::now(), uptime);
    match decision {
        RestartDecision::Restart { delay, streak } => {
            eprintln!(
                "[ashlr-desktop] the sidecar stopped unexpectedly after {}s — restart #{streak} in {} ms",
                uptime.as_secs(),
                delay.as_millis()
            );
            let handle = handle.clone();
            thread::spawn(move || {
                if !sleep_while_restart_wanted(&handle, generation, delay) {
                    eprintln!("[ashlr-desktop] pending sidecar restart cancelled");
                    return;
                }
                if port_is_open() {
                    // Something else took 7777 while ours was down. Spawning
                    // would only fail to bind; treat it as another exit so the
                    // budget still bounds how long we keep checking.
                    eprintln!("[ashlr-desktop] {SERVE_HOST}:{SERVE_PORT} was taken while the sidecar was down — not restarting yet");
                    handle_unexpected_exit(&handle, mode, attempt, generation, Duration::ZERO);
                    return;
                }
                spawn_server_sidecar(handle, mode, attempt, SpawnKind::Restart);
            });
        }
        RestartDecision::GiveUp { exits_in_window } => {
            eprintln!(
                "[ashlr-desktop] the sidecar stopped {exits_in_window} times in {} minutes — not restarting it again",
                sidecar_supervisor::RESTART_WINDOW.as_secs() / 60
            );
            let body = format!(
                "It stopped {exits_in_window} times in {} minutes, so Ashlr stopped restarting it. Quit and reopen Ashlr.",
                sidecar_supervisor::RESTART_WINDOW.as_secs() / 60
            );
            // Off the caller's thread: this can run inside the async runtime,
            // and delivering a notification may shell out. Deliberately NOT
            // gated on focus: this is about the window itself.
            let handle = handle.clone();
            thread::spawn(move || {
                let delivery = current_delivery(&handle);
                notify::deliver(&handle, delivery, "Ashlr: the local server keeps stopping", &body);
            });
        }
    }
}

/// Sleep `delay` in short slices. False as soon as the restart is no longer
/// wanted: the app is quitting, or the live generation moved (reaped, retried,
/// or already replaced).
fn sleep_while_restart_wanted(handle: &AppHandle, generation: u64, delay: Duration) -> bool {
    let deadline = Instant::now() + delay;
    loop {
        let Some(state) = handle.try_state::<AppState>() else {
            return false;
        };
        if state.exiting.load(Ordering::SeqCst) || state.live_generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        thread::sleep((deadline - now).min(Duration::from_millis(100)));
    }
}

/// The script that gives a restarted sidecar's tokens to the live page.
///
/// Only the token half of the shell contract: re-evaluating the whole init
/// script would stack another drag-region MutationObserver on the page for
/// every restart. Same guarantees as `shell_contract::init_script` — gated to
/// the sidecar origin, and every value JSON-encoded into a literal, never
/// interpolated as text.
fn token_handoff_script(startup: &SidecarStartup) -> String {
    let tokens = serde_json::to_string(&startup.as_shell_tokens()).unwrap_or_else(|_| "null".to_string());
    let origin = serde_json::to_string(SERVE_ORIGIN).unwrap_or_else(|_| "\"\"".to_string());
    let event = serde_json::to_string(SIDECAR_RESTARTED_DOM_EVENT).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function () {{ if (window.location.origin !== {origin}) return; var t = {tokens}; if (!t) return; \
         try {{ window.__ASHLR_TOKENS__ = Object.freeze(t); }} catch (_) {{}} \
         try {{ window.dispatchEvent(new CustomEvent({event})); }} catch (_) {{}} }})();"
    )
}

/// Give a restarted sidecar's tokens to the page that is already open.
///
/// Unlike `create_main_window`'s existing-window branch this never shows or
/// focuses the window: a restart happens in the background, often while the
/// window is hidden in the tray, and must not pop it up. The page's old cookie
/// died with the old server; its next 401 re-runs adoption, which reads the
/// fresh `window.__ASHLR_TOKENS__` set here, and the DOM event lets it do that
/// immediately instead.
///
/// Known limit: the window's INITIALIZATION script still carries the first
/// sidecar's tokens, so a manual reload after a restart falls back to the
/// SessionGate prompt. Rebuilding the window would fix that at the cost of the
/// page's in-memory state, which is the worse trade for a background restart.
fn hand_tokens_to_open_window(handle: &AppHandle, startup: &SidecarStartup) {
    let script = token_handoff_script(startup);
    let handle2 = handle.clone();
    let result = handle.run_on_main_thread(move || match handle2.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => {
            if let Err(e) = window.eval(&script) {
                eprintln!("[ashlr-desktop] could not hand the restarted sidecar's tokens to the window: {e}");
            }
        }
        None => eprintln!("[ashlr-desktop] no Verse window to hand the restarted sidecar's tokens to"),
    });
    if let Err(e) = result {
        eprintln!("[ashlr-desktop] could not schedule the token handoff: {e}");
    }
}

// ── seat health ──────────────────────────────────────────────────────────────

/// Poll `/api/verse/health` every 30 s for the app's lifetime and raise a
/// native notification when a seat newly becomes signed-out, expiring or
/// exhausted (see `health_watch`).
///
/// Idle while there is no read token — before the first startup record, while
/// a crashed sidecar restarts, or when the window adopted a server we did not
/// start (its token is not ours to know).
fn start_health_watch(handle: AppHandle) {
    thread::spawn(move || {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], SERVE_PORT));
        let mut alerts = health_watch::AlertState::default();
        let mut last_error: Option<String> = None;
        loop {
            let deadline = Instant::now() + health_watch::POLL_INTERVAL;
            while Instant::now() < deadline {
                if is_exiting(&handle) {
                    return;
                }
                thread::sleep(Duration::from_secs(1));
            }
            let token = match handle.try_state::<AppState>() {
                Some(state) => lock(&state.read_token).as_ref().map(|t| t.0.clone()),
                None => return,
            };
            let Some(token) = token else {
                continue;
            };
            match health_watch::poll_once(addr, &token) {
                Ok(seats) => {
                    last_error = None;
                    let fresh = alerts.update(&seats);
                    if let Some((title, body)) = health_watch::notification_text(&fresh, now_ms() as i64) {
                        eprintln!("[ashlr-desktop] seat health: {title}");
                        announce(&handle, &notify::Notice::SeatHealth { title, body });
                    }
                }
                Err(e) => {
                    // Log a failure once per kind, not every 30 s. `FetchError`
                    // carries no token or body text, so this is safe to print.
                    let text = format!("{e:?}");
                    if last_error.as_deref() != Some(text.as_str()) {
                        eprintln!("[ashlr-desktop] seat health poll failed ({text}) — will keep trying");
                        last_error = Some(text);
                    }
                }
            }
        }
    });
}

// ── auto-update ──────────────────────────────────────────────────────────────

/// Fire-and-forget update check on launch.
///
/// Intentionally best-effort: any error (network offline, no signing key
/// configured, invalid pubkey placeholder, no new version) is logged to stderr
/// and silently dropped. It never blocks the app start or causes a panic.
fn check_for_updates(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let updater = match handle.updater() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("[ashlr-desktop] updater not available: {e}");
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                eprintln!(
                    "[ashlr-desktop] update available: {} → downloading…",
                    update.version
                );
                let _ = handle.emit("ashlr-update-available", &update.version);
                if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                    eprintln!("[ashlr-desktop] update install failed: {e}");
                } else {
                    eprintln!("[ashlr-desktop] update installed — restart to apply");
                    let _ = handle.emit("ashlr-update-installed", ());
                }
            }
            Ok(None) => eprintln!("[ashlr-desktop] already on latest version"),
            Err(e) => eprintln!("[ashlr-desktop] update check skipped: {e}"),
        }
    });
}

// ── app setup ────────────────────────────────────────────────────────────────

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    // `pkill`, a `kill` from a terminal, or Ctrl-C on a foreground run never
    // reach Tauri's event loop. Arm the reaper before a sidecar can exist.
    sidecar_guard::install_signal_handlers();

    // ── restore the saved window geometry + theme ────────────────────────────
    let saved = window_state::load().unwrap_or_default();
    let prefs = desktop_prefs::load();
    app.manage(AppState {
        window: Mutex::new(saved),
        prefs: Mutex::new(prefs),
        ..Default::default()
    });
    app.manage(app_menu::ZoomLevel::default());

    // ── menu bar ─────────────────────────────────────────────────────────────
    // Built before any window so ⌘C / ⌘V / ⌘Z work in the composer from the
    // first frame.
    let menu = app_menu::build(&handle)?;
    app.set_menu(menu)?;
    // ONE handler for every menu event, app menu and tray alike. Tauri calls a
    // tray's own `on_menu_event` for ANY menu event too, so registering both
    // (as this file used to) ran each tray action twice — harmless for Show,
    // a second stacked confirm dialog for Stop.
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if let Some(action) = tray::parse_tray_id(id) {
            handle_tray_action(app, action);
            return;
        }
        app_menu::handle_menu_event(app, id, MAIN_WINDOW_LABEL);
    });

    // ── the launch window, immediately ───────────────────────────────────────
    create_launch_window(&handle, saved.theme);
    set_launch_phase(&handle, &LaunchPhase::Starting);

    // ── launch-window actions ────────────────────────────────────────────────
    {
        let handle = handle.clone();
        app.listen(LAUNCH_ACTION_EVENT, move |event| {
            let action = serde_json::from_str::<String>(event.payload())
                .unwrap_or_else(|_| event.payload().trim_matches('"').to_string());
            match action.as_str() {
                "retry" => {
                    let handle = handle.clone();
                    thread::spawn(move || start_sequence(handle));
                }
                "use-running" => adopt_running_server(&handle),
                "quit" => {
                    mark_exiting(&handle);
                    reap_sidecar(&handle);
                    handle.exit(0);
                }
                other => eprintln!("[ashlr-desktop] ignoring unknown launch action {other:?}"),
            }
        });
    }

    // ── the UI tells us which theme it settled on ────────────────────────────
    {
        let handle = handle.clone();
        app.listen(shell_contract::THEME_EVENT, move |event| {
            let raw = serde_json::from_str::<String>(event.payload())
                .unwrap_or_else(|_| event.payload().trim_matches('"').to_string());
            let Some(theme) = ShellTheme::parse(&raw) else {
                return;
            };
            let Some(state) = handle.try_state::<AppState>() else {
                return;
            };
            {
                let mut guard = match state.window.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if guard.theme == Some(theme) {
                    return;
                }
                guard.theme = Some(theme);
            }
            if let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.set_background_color(Some(tauri_color(theme)));
            }
            flush_window_state(&state, true);
        });
    }

    // ── first-run: run `ashlr setup --yes` once if the marker is absent ──────
    if is_first_run() {
        run_first_time_setup(app);
    }

    // ── spawn `ashlr verse`; the Verse window opens once it is ready ─────────
    // Off the main thread: the boot sequence now sweeps the process table and
    // may wait out an orphan's shutdown grace, and the launch window must keep
    // painting meanwhile. "Try again" already runs it on a thread.
    {
        let handle = handle.clone();
        thread::spawn(move || start_sequence(handle));
    }

    // ── seat health → native notifications (idle until a token exists) ───────
    start_health_watch(handle.clone());

    // ── desktop preferences: hotkey, notifications (Settings ▸ Desktop) ─────
    {
        let handle = handle.clone();
        app.listen(desktop_prefs::PREFS_EVENT, move |event| {
            apply_prefs_event(&handle, event.payload());
        });
    }
    {
        let handle = handle.clone();
        app.listen(desktop_prefs::STATE_REQUEST_EVENT, move |_| push_desktop_state(&handle));
    }
    if prefs.global_hotkey {
        let status = hotkey::apply(&handle, true);
        if let Some(state) = handle.try_state::<AppState>() {
            *lock(&state.hotkey) = status;
        }
    }
    // How banners reach the OS depends on how this bundle is signed; asking
    // `codesign` takes a few tens of ms, so it is not on the launch path.
    {
        let handle = handle.clone();
        thread::spawn(move || {
            let delivery = notify::detect_delivery();
            eprintln!("[ashlr-desktop] notifications: {} delivery", delivery.wire_name());
            if let Some(state) = handle.try_state::<AppState>() {
                *lock(&state.delivery) = Some(delivery);
            }
            push_desktop_state(&handle);
        });
    }

    // ── tray icon ────────────────────────────────────────────────────────────
    build_tray(app)?;

    // ── running chats / Needs you → tray, Dock badge, banners ───────────────
    start_activity_watch(handle.clone());

    // ── background update check (non-blocking, non-fatal) ────────────────────
    check_for_updates(app.handle().clone());

    Ok(())
}

// ── tray ─────────────────────────────────────────────────────────────────────

/// The menu-bar item (layout, labels and routing in `tray.rs`).
///
/// It lists running chats and can STOP them (native confirm first), open the
/// Needs-you drawer, start a chat, show the window and quit. Autonomy controls
/// (start/stop the daemon, the global kill switch, the autonomy switch) are
/// deliberately NOT here: the kill switch is an emergency stop that also
/// disables the agent's own write tools, and a menu-bar item is far too easy to
/// hit by accident for something with that blast radius. They live in the
/// console, behind a confirm step (SPEC-310C §0.4: the tray may stop chats,
/// never the fleet).
fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();
    let menu = build_tray_menu(handle, &tray::TrayModel::default())?;

    // The app's default window icon, not the config's template image: that PNG
    // is the full-colour app icon, which macOS would flatten to a solid blob
    // as a template. Fall back to loading icons/32x32.png explicitly.
    let icon = if let Some(ico) = app.default_window_icon() {
        ico.clone()
    } else {
        Image::from_path(
            handle
                .path()
                .resource_dir()
                .unwrap_or_default()
                .join("icons/32x32.png"),
        )?
    };

    let tray = match app.tray_by_id(CONFIG_TRAY_ID) {
        Some(existing) => {
            existing.set_icon_with_as_template(Some(icon), false)?;
            existing.set_menu(Some(menu))?;
            existing.set_show_menu_on_left_click(false)?;
            existing.set_tooltip(Some("Ashlr Verse"))?;
            existing
        }
        None => TrayIconBuilder::with_id(CONFIG_TRAY_ID)
            .tooltip("Ashlr Verse")
            .icon(icon)
            .menu(&menu)
            .show_menu_on_left_click(false)
            .build(app)?,
    };
    tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            let app = tray.app_handle();
            if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                if win.is_visible().unwrap_or(false) {
                    let _ = win.hide();
                } else {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        }
    });

    Ok(())
}

/// Turn `tray::menu_rows` into a native menu. Safe off the main thread: Tauri
/// marshals menu construction onto it.
fn build_tray_menu(handle: &AppHandle, model: &tray::TrayModel) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(handle)?;
    for row in tray::menu_rows(model) {
        match row {
            tray::Row::Item { id, label, enabled } => {
                menu.append(&MenuItemBuilder::with_id(id, label).enabled(enabled).build(handle)?)?;
            }
            tray::Row::Separator => menu.append(&PredefinedMenuItem::separator(handle)?)?,
        }
    }
    Ok(menu)
}

fn config_tray(handle: &AppHandle) -> Option<TrayIcon> {
    handle.tray_by_id(CONFIG_TRAY_ID)
}

/// Re-render the tray if `next` differs from what it shows.
fn update_tray(handle: &AppHandle, next: tray::TrayModel) {
    let Some(state) = handle.try_state::<AppState>() else {
        return;
    };
    {
        let mut current = lock(&state.tray);
        if *current == next {
            return;
        }
        *current = next.clone();
    }
    let Some(icon) = config_tray(handle) else {
        return;
    };
    match build_tray_menu(handle, &next) {
        Ok(menu) => {
            let _ = icon.set_menu(Some(menu));
        }
        Err(e) => eprintln!("[ashlr-desktop] could not rebuild the tray menu: {e}"),
    }
    let _ = icon.set_title(tray::tray_title(next.running.len()));
    let _ = icon.set_tooltip(Some(tray::tray_tooltip(&next)));
}

/// The Dock badge: the Needs-you count, cleared at zero.
fn update_badge(handle: &AppHandle, needs_you: usize) {
    let Some(state) = handle.try_state::<AppState>() else {
        return;
    };
    if *lock(&state.badge) == Some(needs_you) {
        return;
    }
    let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) else {
        return; // retried on the next poll once the window exists
    };
    if window.set_badge_count(tray::dock_badge(needs_you)).is_ok() {
        *lock(&state.badge) = Some(needs_you);
    }
}

fn handle_tray_action(app: &AppHandle, action: tray::TrayAction) {
    // An explicit navigation wins over a banner that may never have been
    // clicked: without this, the focus it causes could fire a stale click.
    if let Some(state) = app.try_state::<AppState>() {
        lock(&state.pending_click).clear();
    }
    match action {
        tray::TrayAction::Show => show_main_or_launch(app),
        tray::TrayAction::Quit => {
            // The Exit handler reaps the sidecar; do it here too so the child is
            // gone before the event loop starts tearing down.
            mark_exiting(app);
            reap_sidecar(app);
            app.exit(0);
        }
        tray::TrayAction::NeedsYou => send_page_command(app, shell_contract::COMMAND_OPEN_NEEDS_YOU),
        tray::TrayAction::NewChat => send_page_command(app, shell_contract::COMMAND_NEW_CHAT),
        tray::TrayAction::OpenSession(id) => match notify::ClickTarget::session(&id) {
            Some(target) => send_page_command(app, &target.command()),
            None => show_main_or_launch(app),
        },
        tray::TrayAction::StopChats => {
            // A native confirm blocks until answered; never on the main thread.
            let app = app.clone();
            thread::spawn(move || stop_running_chats(&app));
        }
    }
}

fn show_main_or_launch(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    } else if let Some(win) = app.get_webview_window(LAUNCH_WINDOW_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Bring the Verse window forward and hand the page a desktop command
/// (`ashlr:desktop-command`, parsed by command-catalog.ts). Before the Verse
/// window exists the launch window comes forward instead, and the command is
/// dropped — there is no page to run it.
fn send_page_command(app: &AppHandle, command: &str) {
    let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        show_main_or_launch(app);
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    if let Err(e) = win.eval(shell_contract::command_script(command)) {
        eprintln!("[ashlr-desktop] could not send a command to the page: {e}");
    }
}

/// Tray ▸ Stop running chats…: confirm natively, then cancel every running
/// turn with the mutation token. Chats only — the fleet has its own stop, in
/// the console, behind its own confirm.
fn stop_running_chats(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state.stopping.swap(true, Ordering::SeqCst) {
        return; // a confirm is already on screen
    }
    stop_running_chats_inner(app, &state);
    state.stopping.store(false, Ordering::SeqCst);
}

fn stop_running_chats_inner(app: &AppHandle, state: &AppState) {
    let read = lock(&state.read_token).as_ref().map(|t| t.0.clone());
    let mutation = lock(&state.mutation_token).as_ref().map(|t| t.0.clone());
    let (Some(read), Some(mutation)) = (read, mutation) else {
        // The menu row is disabled in this state; this is the race where the
        // sidecar stopped between rendering and clicking.
        app.dialog()
            .message("Ashlr's local server is restarting. Try again in a moment, or stop the chat from its window.")
            .title("Can't stop chats right now")
            .kind(MessageDialogKind::Info)
            .blocking_show();
        return;
    };
    let shown = lock(&state.tray).running.clone();
    let (title, body) = tray::stop_confirm_text(shown.len());
    let confirmed = app
        .dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Stop chats".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();
    if !confirmed {
        return;
    }

    // The operator confirmed "stop every running chat": use the LIVE list (a
    // chat may have started or ended while the dialog was up), falling back
    // to what the dialog counted if the read fails.
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], SERVE_PORT));
    let ids: Vec<String> = match health_watch::fetch(addr, activity_watch::ACTIVITY_PATH, &read)
        .ok()
        .and_then(|body| String::from_utf8(body).ok())
        .and_then(|text| activity_watch::parse_activity(&text))
    {
        Some(snapshot) => snapshot
            .running
            .into_iter()
            .map(|r| r.session_id)
            .filter(|id| notify::is_valid_session_id(id))
            .collect(),
        None => shown.into_iter().map(|c| c.session_id).collect(),
    };

    let (mut stopped, mut failed) = (0usize, 0usize);
    for id in &ids {
        let path = format!("/api/verse/sessions/{id}/cancel");
        match health_watch::post_json(addr, &path, &mutation, "{}") {
            // `cancelled: false` means the turn had already ended: either way
            // it is no longer running, which is what the operator asked for.
            Ok(_) => stopped += 1,
            Err(e) => {
                failed += 1;
                // FetchError carries no token or body text.
                eprintln!("[ashlr-desktop] could not stop a running chat ({e:?})");
            }
        }
    }
    eprintln!("[ashlr-desktop] tray stop: {stopped} stopped, {failed} failed");
    state.poll_now.store(true, Ordering::SeqCst);
    if let Some(text) = tray::stop_result_text(stopped, failed) {
        app.dialog()
            .message(text)
            .title("Some chats are still running")
            .kind(MessageDialogKind::Warning)
            .blocking_show();
    }
}

// ── activity → banners, tray, badge ──────────────────────────────────────────

/// Where the Verse window stands, for the notification gate and the poll rate.
fn window_presence(handle: &AppHandle) -> notify::WindowPresence {
    match handle.get_webview_window(MAIN_WINDOW_LABEL) {
        None => notify::WindowPresence::ABSENT,
        Some(w) => notify::WindowPresence {
            visible: w.is_visible().unwrap_or(false),
            focused: w.is_focused().unwrap_or(false),
            minimized: w.is_minimized().unwrap_or(false),
        },
    }
}

fn current_delivery(handle: &AppHandle) -> notify::Delivery {
    handle
        .try_state::<AppState>()
        .and_then(|state| *lock(&state.delivery))
        .unwrap_or(notify::Delivery::Script)
}

/// Raise one banner, if the gate, the preference and the burst guard allow.
fn announce(handle: &AppHandle, notice: &notify::Notice) {
    let Some(state) = handle.try_state::<AppState>() else {
        return;
    };
    let enabled = lock(&state.prefs).notifications;
    if !notify::should_deliver(window_presence(handle), enabled) {
        return;
    }
    let now = Instant::now();
    if !lock(&state.throttle).allow(now) {
        eprintln!("[ashlr-desktop] notification suppressed by the burst guard");
        return;
    }
    let rendered = notify::render(notice);
    if let Some(target) = rendered.click.clone() {
        lock(&state.pending_click).arm(target, now);
    }
    notify::deliver(handle, current_delivery(handle), &rendered.title, &rendered.body);
}

/// Sleep until the next poll: `wait`, or sooner when someone asked for a
/// poll now. False when the app is quitting.
fn sleep_until_poll(handle: &AppHandle, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        let Some(state) = handle.try_state::<AppState>() else {
            return false;
        };
        if state.exiting.load(Ordering::SeqCst) {
            return false;
        }
        if state.poll_now.swap(false, Ordering::SeqCst) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        thread::sleep((deadline - now).min(Duration::from_millis(WATCH_SLICE_MS)));
    }
}

/// Poll `/api/verse/activity` for the app's lifetime (see `activity_watch`).
/// Idle while there is no read token, exactly like the health watch.
fn start_activity_watch(handle: AppHandle) {
    thread::spawn(move || {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], SERVE_PORT));
        let mut watch = activity_watch::WatchState::default();
        let mut route_missing = false;
        let mut running = 0usize;
        let mut last_error: Option<String> = None;
        loop {
            let shown = window_presence(&handle).is_shown();
            let wait = activity_watch::next_interval(shown, running, route_missing);
            if !sleep_until_poll(&handle, wait) {
                return;
            }
            let Some(state) = handle.try_state::<AppState>() else {
                return;
            };
            let token = lock(&state.read_token).as_ref().map(|t| t.0.clone());
            let can_stop = lock(&state.mutation_token).is_some();
            let Some(token) = token else {
                // No server of ours (restarting, or an adopted one): what the
                // tray last showed is no longer known to be true.
                running = 0;
                update_tray(&handle, tray::TrayModel::default());
                continue;
            };
            match health_watch::fetch(addr, &activity_watch::request_path(watch.cursor()), &token) {
                Ok(body) => {
                    route_missing = false;
                    let parsed = String::from_utf8(body)
                        .ok()
                        .and_then(|text| activity_watch::parse_activity(&text));
                    let Some(snapshot) = parsed else {
                        log_once(&mut last_error, "malformed activity response");
                        continue;
                    };
                    last_error = None;
                    let fold = watch.fold(snapshot);
                    running = fold.running.len();
                    for notice in &fold.notices {
                        announce(&handle, notice);
                    }
                    update_badge(&handle, fold.needs_you);
                    update_tray(
                        &handle,
                        tray::TrayModel {
                            running: fold.running,
                            needs_you: fold.needs_you,
                            can_stop,
                        },
                    );
                }
                Err(health_watch::FetchError::Status(404)) => {
                    // A sidecar built before C1's route: nothing to watch yet.
                    route_missing = true;
                    log_once(&mut last_error, "activity route not in this build");
                }
                Err(health_watch::FetchError::Status(400)) => {
                    watch.reject_cursor();
                    log_once(&mut last_error, "activity cursor rejected — starting over");
                }
                Err(e) => log_once(&mut last_error, &format!("{e:?}")),
            }
        }
    });
}

/// Log a poll failure once per kind, not every 5 s. Never carries a token.
fn log_once(last: &mut Option<String>, what: &str) {
    if last.as_deref() != Some(what) {
        eprintln!("[ashlr-desktop] activity poll: {what} — will keep trying");
        *last = Some(what.to_string());
    }
}

// ── desktop preferences (Settings ▸ Desktop) ─────────────────────────────────

fn desktop_view(handle: &AppHandle) -> Option<desktop_prefs::DesktopStateView> {
    let state = handle.try_state::<AppState>()?;
    let prefs = *lock(&state.prefs);
    let status = lock(&state.hotkey).clone();
    let delivery = lock(&state.delivery).unwrap_or(notify::Delivery::Script);
    Some(desktop_prefs::DesktopStateView {
        hotkey: desktop_prefs::HotkeyView {
            enabled: prefs.global_hotkey,
            registered: status.registered,
            accelerator: hotkey::SUMMON_DISPLAY.to_string(),
            error: if prefs.global_hotkey { status.error } else { None },
        },
        notifications: desktop_prefs::NotificationsView {
            enabled: prefs.notifications,
            delivery: delivery.wire_name(),
        },
    })
}

/// Hand the live page the current desktop state.
fn push_desktop_state(handle: &AppHandle) {
    let Some(view) = desktop_view(handle) else {
        return;
    };
    if let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.eval(desktop_prefs::state_script(&view));
    }
}

/// A `shell-prefs` event from the page: validate, persist, apply, report back.
fn apply_prefs_event(handle: &AppHandle, payload: &str) {
    let Some(patch) = desktop_prefs::parse_patch(payload) else {
        eprintln!("[ashlr-desktop] ignoring a malformed shell-prefs event");
        return;
    };
    let Some(state) = handle.try_state::<AppState>() else {
        return;
    };
    let prefs = {
        let mut guard = lock(&state.prefs);
        *guard = guard.apply(patch);
        *guard
    };
    desktop_prefs::store(&prefs);
    if patch.global_hotkey.is_some() {
        let status = hotkey::apply(handle, prefs.global_hotkey);
        *lock(&state.hotkey) = status;
    }
    push_desktop_state(handle);
}

/// ⌃⌥Space: bring Verse forward and focus the composer.
fn summon(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        lock(&state.pending_click).clear();
    }
    send_page_command(app, hotkey::SUMMON_COMMAND);
}

// ── window events ────────────────────────────────────────────────────────────

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let handle = window.app_handle().clone();
    let is_main = window.label() == MAIN_WINDOW_LABEL;
    let is_launch = window.label() == LAUNCH_WINDOW_LABEL;

    match event {
        // Closing the Verse window hides it to the tray (standard macOS
        // behaviour: ⌘W closes a window, it does not quit the app). Quit — from
        // ⌘Q, the app menu, or the tray — is the only path that stops the
        // sidecar, and it always does (see RunEvent::ExitRequested).
        WindowEvent::CloseRequested { api, .. } if is_main => {
            if let Some(state) = handle.try_state::<AppState>() {
                if let Some(win) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                    let mut guard = match state.window.lock() {
                        Ok(guard) => guard,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    capture_geometry(&win, &mut guard);
                }
                flush_window_state(&state, true);
            }
            api.prevent_close();
            let _ = window.hide();
        }
        // Closing the launch window before the app ever came up means "give up".
        WindowEvent::CloseRequested { .. } if is_launch => {
            let opened = handle
                .try_state::<AppState>()
                .map(|s| s.opened.load(Ordering::SeqCst))
                .unwrap_or(false);
            if !opened {
                mark_exiting(&handle);
                reap_sidecar(&handle);
                handle.exit(0);
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) if is_main => {
            let Some(state) = handle.try_state::<AppState>() else {
                return;
            };
            let Some(win) = handle.get_webview_window(MAIN_WINDOW_LABEL) else {
                return;
            };
            {
                let mut guard = match state.window.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                capture_geometry(&win, &mut guard);
            }
            flush_window_state(&state, false);
        }
        WindowEvent::Focused(false) if is_main => {
            if let Some(state) = handle.try_state::<AppState>() {
                flush_window_state(&state, true);
            }
        }
        // The notification plugin cannot report a click, but clicking a banner
        // brings the window forward: a focus-regain within 60 s of the latest
        // banner opens what it was about (see `notify::PendingClick`).
        WindowEvent::Focused(true) if is_main => {
            let target = handle
                .try_state::<AppState>()
                .and_then(|state| lock(&state.pending_click).take_fresh(Instant::now()));
            if let (Some(target), Some(win)) = (target, handle.get_webview_window(MAIN_WINDOW_LABEL)) {
                let _ = win.eval(shell_contract::command_script(&target.command()));
            }
        }
        _ => {}
    }
}

// ── entry point ──────────────────────────────────────────────────────────────

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Registering the plugin is only half of it: the Verse page is a
        // REMOTE origin (http://127.0.0.1:7777), so `dialog:allow-open`
        // has to be granted in the capability that carries a `remote`
        // block (capabilities/verse-remote.json). Granting it in
        // capabilities/main.json instead would compile, ship, and then
        // reject every call at runtime — silently, from the page's side.
        .plugin(tauri_plugin_dialog::init())
        // Rust-only (see Cargo.toml): no window is granted `notification:*`.
        .plugin(tauri_plugin_notification::init())
        // Rust-only too; `hotkey::apply` registers ⌃⌥Space when Settings ▸
        // Desktop turns it on. Key-up events are ignored (`is_summon_press`).
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if hotkey::is_summon_press(shortcut, event.state()) {
                        summon(app);
                    }
                })
                .build(),
        )
        .setup(setup)
        .on_window_event(on_window_event)
        .build(tauri::generate_context!())
        .expect("error building Ashlr desktop app");

    app.run(|handle, event| match event {
        // Every quit path lands here: ⌘Q, the app menu, the tray, or a signal.
        // Reaping the sidecar in one place is what keeps orphan `ashlr verse`
        // processes off the machine.
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            eprintln!("[ashlr-desktop] exiting — reaping the sidecar");
            // Before the reap: the sidecar's Terminated event must read as the
            // quit it is, never as a crash to restart.
            mark_exiting(handle);
            if let Some(state) = handle.try_state::<AppState>() {
                if let Some(win) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                    if let Ok(mut guard) = state.window.lock() {
                        capture_geometry(&win, &mut guard);
                    }
                }
                flush_window_state(&state, true);
            }
            reap_sidecar(handle);
        }
        // Clicking the Dock icon while the window is closed to the tray: bring
        // it back, the way every Mac app does.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_main_or_launch(handle),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_startup_record_and_ignores_other_lines() {
        assert!(parse_startup_line("  ashlr serve — local web dashboard").is_none());
        assert!(parse_startup_line("{\"url\":\"http://127.0.0.1:7777\"}").is_none());
        assert!(parse_startup_line("{\"readToken\":\"\",\"token\":\"b\"}").is_none());
        assert!(parse_startup_line("{\"readToken\":\"a\",\"port\":7778}").is_none());

        let parsed = parse_startup_line(
            "{\"url\":\"http://127.0.0.1:7777\",\"port\":7777,\"allowDispatch\":true,\"readToken\":\"aa11\",\"readTokenHeader\":\"X-Ashlr-Token\",\"token\":\"bb22\",\"tokenHeader\":\"X-Ashlr-Token\"}\n",
        )
        .expect("startup record");
        assert_eq!(parsed.read_token, "aa11");
        assert_eq!(parsed.token.as_deref(), Some("bb22"));

        let read_only = parse_startup_line("{\"readToken\":\"aa11\"}").expect("read-only record");
        assert_eq!(read_only.token, None);
    }

    #[test]
    fn startup_record_is_never_forwarded_even_after_ready() {
        let record = "{\"readToken\":\"aa11\",\"token\":\"bb22\"}";

        // The user adopted a running server first: ready is already true and the
        // window is token-less.
        let ready = AtomicBool::new(true);
        match route_stdout_line(record, &ready) {
            StdoutRoute::Startup { startup, first } => {
                assert!(!first, "a late record must not count as the first readiness");
                assert_eq!(startup.read_token, "aa11");
                assert_eq!(startup.token.as_deref(), Some("bb22"));
            }
            StdoutRoute::Forward => panic!("startup record was routed to the sidecar-stdout bus"),
        }
        assert!(ready.load(Ordering::SeqCst));

        // Normal boot: the record arrives first and flips ready.
        let ready = AtomicBool::new(false);
        match route_stdout_line(record, &ready) {
            StdoutRoute::Startup { first, .. } => assert!(first),
            StdoutRoute::Forward => panic!("startup record was not recognised"),
        }
        assert!(ready.load(Ordering::SeqCst));

        // Ordinary output is forwarded and leaves ready alone.
        let ready = AtomicBool::new(false);
        assert!(matches!(
            route_stdout_line("  Listening on http://127.0.0.1:7777", &ready),
            StdoutRoute::Forward
        ));
        assert!(!ready.load(Ordering::SeqCst));
    }

    #[test]
    fn a_forwarded_startup_record_can_never_reach_the_launch_window() {
        // Belt and braces: even if routing regressed and the token line were
        // forwarded, the launch window's redaction would drop it.
        assert_eq!(
            launch_state::redact_diagnostic("{\"readToken\":\"aa11\",\"token\":\"bb22\"}"),
            None
        );
    }

    #[test]
    fn init_script_is_origin_gated_and_json_encoded() {
        let script = shell_contract::init_script(
            SERVE_ORIGIN,
            Some(shell_contract::ShellTokens {
                read_token: "aa11\"</script>",
                token: Some("bb22"),
            }),
        );
        assert!(script.contains("\"origin\":\"http://127.0.0.1:7777\""));
        assert!(script.contains("window.__ASHLR_TOKENS__ = Object.freeze(cfg.tokens)"));
        assert!(script.contains("\"readToken\":\"aa11\\\"</script>\""));
        assert!(script.contains("\"token\":\"bb22\""));

        let no_dispatch = shell_contract::init_script(
            SERVE_ORIGIN,
            Some(shell_contract::ShellTokens {
                read_token: "aa11",
                token: None,
            }),
        );
        assert!(no_dispatch.contains("\"token\":null"));
    }

    #[test]
    fn sidecar_modes_use_port_7777_and_machine_readable_output() {
        assert_eq!(
            SidecarMode::Verse.args(),
            &["verse", "--port", "7777", "--no-open", "--json"]
        );
        assert_eq!(
            SidecarMode::Serve.args(),
            &["serve", "--port", "7777", "--allow-dispatch", "--json"]
        );
    }

    #[test]
    fn the_startup_theme_prefers_what_the_ui_last_reported() {
        // Saved wins even when the OS disagrees — that is the white-flash case.
        assert_eq!(
            startup_theme(Some(ShellTheme::Dark), Some(tauri::Theme::Light)),
            ShellTheme::Dark
        );
        assert_eq!(
            startup_theme(Some(ShellTheme::Light), Some(tauri::Theme::Dark)),
            ShellTheme::Light
        );
        // Nothing saved: follow the OS.
        assert_eq!(startup_theme(None, Some(tauri::Theme::Light)), ShellTheme::Light);
        assert_eq!(startup_theme(None, Some(tauri::Theme::Dark)), ShellTheme::Dark);
        // Nothing at all: dark, because that is the design's primary look and a
        // dark window behind a dark page is the invisible failure.
        assert_eq!(startup_theme(None, None), ShellTheme::Dark);
    }

    #[test]
    fn a_failure_without_diagnostics_does_not_get_a_window_full_of_empty_canvas() {
        let port = LaunchPhase::Failed(LaunchFailure::PortInUse { port: SERVE_PORT }).payload(&[]);
        assert!(port.detail.is_empty(), "the port probe produces no sidecar output");
        let (_, short) = launch_window_size(&port);

        let exited = LaunchPhase::Failed(LaunchFailure::SidecarExited { code: Some(1) })
            .payload(&["EADDRINUSE".to_string(), "stack".to_string()]);
        let (_, tall) = launch_window_size(&exited);

        assert!(tall > short, "a failure with diagnostics needs more room, got {tall} vs {short}");

        let (_, starting) = launch_window_size(&LaunchPhase::Starting.payload(&[]));
        assert!(starting < short, "the starting state is the smallest window");
    }

    #[test]
    fn the_restart_token_handoff_is_origin_gated_json_encoded_and_token_only() {
        let startup = parse_startup_line("{\"readToken\":\"aa11\\\"</script>\",\"token\":\"bb22\"}")
            .expect("record");
        let script = token_handoff_script(&startup);
        assert!(script.contains("if (window.location.origin !== \"http://127.0.0.1:7777\") return;"));
        assert!(script.contains("var t = {\"readToken\":\"aa11\\\"</script>\",\"token\":\"bb22\"};"));
        assert!(script.contains("window.__ASHLR_TOKENS__ = Object.freeze(t)"));
        assert!(script.contains("new CustomEvent(\"ashlr:sidecar-restarted\")"));
        // Only the token half: no second drag-region observer per restart.
        assert!(!script.contains("MutationObserver"));

        let read_only = parse_startup_line("{\"readToken\":\"aa11\"}").expect("record");
        assert!(token_handoff_script(&read_only).contains("\"token\":null"));
    }

    #[test]
    fn the_orphan_sweep_recognises_exactly_the_argument_lists_we_spawn() {
        let bin = "/Applications/Ashlr.app/Contents/MacOS/ashlr";
        let arg_sets = [SidecarMode::Verse.args(), SidecarMode::Serve.args()];
        for mode in [SidecarMode::Verse, SidecarMode::Serve] {
            let row = sidecar_supervisor::ProcInfo {
                pid: 500,
                ppid: 1,
                started: "Wed Sep 23 21:22:29 2026".to_string(),
                args: format!("{bin} {}", mode.args().join(" ")),
            };
            assert!(
                sidecar_supervisor::is_orphaned_sidecar(&row, bin, 42, &arg_sets),
                "{:?} must be recognised as ours",
                mode
            );
        }
    }

    #[test]
    fn the_sidecar_path_is_our_own_executables_sibling() {
        let path = PathBuf::from(sidecar_binary_path().expect("path"));
        let exe = std::env::current_exe().expect("exe");
        assert_eq!(path.parent(), exe.parent());
        let expected = if cfg!(windows) { "ashlr.exe" } else { "ashlr" };
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some(expected));
    }

    #[test]
    fn a_fresh_app_state_has_nothing_live_and_nothing_to_poll_with() {
        let state = AppState::default();
        assert_eq!(state.live_generation.load(Ordering::SeqCst), 0);
        assert!(!state.exiting.load(Ordering::SeqCst));
        assert!(lock(&state.read_token).is_none());
    }

    #[test]
    fn window_background_uses_the_design_canvas_colours() {
        assert_eq!(
            tauri_color(ShellTheme::Dark),
            tauri::window::Color(0x0b, 0x0b, 0x0d, 0xff)
        );
        assert_eq!(
            tauri_color(ShellTheme::Light),
            tauri::window::Color(0xfa, 0xfa, 0xfa, 0xff)
        );
    }
}

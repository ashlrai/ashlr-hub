//! The integrated browser pane (shell contract item 7, protocol v1).
//!
//! Verse shows arbitrary web pages — a dev server on another loopback port, a
//! docs site, a preview deploy — inside its own layout. Each browser tab is a
//! SEPARATE, undecorated `WebviewWindow` labelled `browser-<tab>`, attached to
//! the main window as a child (macOS `addChildWindow`, so it moves with it and
//! stays above it) and positioned over the rectangle the web UI reserves for
//! it. The web UI drives it through one event, `shell-browser`, and hears back
//! through `window.__ASHLR_BROWSER_EVENT__` (see `shell_contract.js`).
//!
//! Why separate windows and not Tauri's multi-webview: multiwebview needs the
//! `unstable` feature and turns the main window's webview into a child webview,
//! which changes how the Verse page itself is hosted. Separate windows leave
//! the Verse window exactly as it was.
//!
//! # Security posture
//!
//! - **Zero IPC for arbitrary sites.** Every capability file lists its windows
//!   by exact label (`main`, `launch`); `browser-*` matches none of them, so a
//!   page in a tab can call no command, emit no event and listen to nothing
//!   (a test below reads `capabilities/*.json` and fails if that changes).
//! - **Fixed scripts only.** Native evaluates exactly two kinds of script in a
//!   tab: the constant `browser_tap.js` (init script) and the constant query
//!   wrappers built by [`query_script`] from a closed enum. No string from the
//!   Verse page or from the tab ever becomes code. The tab's answers come back
//!   as JSON, are decoded by [`decode_tap_result`], and are forwarded to the
//!   Verse page JSON-encoded by [`event_script`] — data, never code.
//! - **URL rule** ([`check_url`] / [`url_rule`]): http and https only, no
//!   userinfo, and never the Verse origin itself (loopback on the Verse port),
//!   so a tab can never become a second, token-less Verse. Applied to what the
//!   web UI asks for AND to every navigation the page makes (`on_navigation`);
//!   `window.open` / `target=_blank` are denied and followed in the same tab.
//!   Downloads are refused (no download handler is installed, so WebKit
//!   cancels them).
//! - **Separate website data.** Tabs never share cookies or storage with the
//!   Verse window (cookies are per host, not per port, so a page on
//!   `127.0.0.1:3000` would otherwise see Verse's `127.0.0.1` cookies). macOS
//!   14+ uses a fixed `data_store_identifier`; older macOS, where that API does
//!   not exist and wry would silently fall back to the SHARED default store,
//!   gets a non-persistent (incognito) store instead; other platforms use
//!   `<app local data>/browser`.
//! - **Read, never act.** Native only navigates, reads (text, console,
//!   network failures, page info, a picked element) and snapshots. It never
//!   types, never fills or submits a form, never enters a credential, never
//!   clicks. The tap never reads form-control values. The operator can of
//!   course click and type in the pane themselves.
//!
//! Requests are handled on ONE worker thread, in the order the page sent them
//! (a burst of `bounds` during a resize must not be applied out of order, and
//! creating a window from the event-handler thread deadlocks on Windows).
//! Queries and screenshots never block that worker: their answers arrive on a
//! callback, raced against a timeout.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, LogicalSize, Manager, PhysicalPosition, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// Event the page emits (`__ASHLR_DESKTOP__.browser.send`).
pub const BROWSER_EVENT: &str = "shell-browser";
/// Native window label prefix; the label is `browser-<tab>`.
pub const LABEL_PREFIX: &str = "browser-";
/// At most this many tab windows exist; opening one more closes the least
/// recently used.
pub const MAX_TABS: usize = 8;
/// Longest URL the page may hand native.
pub const MAX_URL_LEN: usize = 4096;
/// The page caps a message at 16 KB of JSON; native allows headroom for
/// multi-byte characters and drops anything bigger unparsed.
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
/// A query with no answer by then is reported as `timeout`.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
/// Snapshots of a large page take longer than a script query.
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(10);
/// A tab's answer bigger than this is refused rather than pushed through the
/// Verse page (`text` is capped at 20k chars, `dump` at 200+100 entries).
const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;
/// `external` opens the system browser; a script looping on it must not be
/// able to flood the desktop with browser windows.
const EXTERNAL_MIN_INTERVAL: Duration = Duration::from_secs(1);
/// Title / blocked-URL / nav-URL caps for events sent to the page.
const TITLE_MAX_CHARS: usize = 300;
const BLOCKED_URL_MAX_CHARS: usize = 2048;
const NAV_URL_MAX_CHARS: usize = 4096;
/// Largest snapshot width, in points (WebKit scales the snapshot to it).
#[cfg(target_os = "macos")]
const SNAPSHOT_MAX_WIDTH: f64 = 1280.0;
/// Above this a PNG snapshot is re-encoded as JPEG (quality 0.8).
#[cfg(target_os = "macos")]
const SNAPSHOT_PNG_MAX_BYTES: usize = 4 * 1024 * 1024;
/// The macOS website data store every browser tab shares (and the Verse window
/// does not). A fixed identifier so logins in the pane survive a relaunch.
#[cfg(target_os = "macos")]
const DATA_STORE_ID: [u8; 16] = *b"ashlr-browser-v1";

/// The tap injected into every tab (see the file's header for its rules).
pub const TAP_JS: &str = include_str!("browser_tap.js");

// ── wire types ───────────────────────────────────────────────────────────────

/// `{ x, y, width, height }` in CSS px relative to the Verse viewport.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The fixed read-only queries. A closed enum: the page picks one by name and
/// can never supply script text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueryWhat {
    Text,
    Console,
    Info,
    PickStart,
    PickPoll,
    PickCancel,
}

impl QueryWhat {
    /// The `__ashlrTap` call, arguments included. Constants only.
    fn call(self) -> &'static str {
        match self {
            QueryWhat::Text => "text(20000)",
            QueryWhat::Console => "dump(200)",
            QueryWhat::Info => "info()",
            QueryWhat::PickStart => "pickStart()",
            QueryWhat::PickPoll => "pickPoll()",
            QueryWhat::PickCancel => "pickCancel()",
        }
    }
}

/// One `shell-browser` message. Parsed strictly: unknown ops and unknown
/// fields make the whole message invalid, because any script on the Verse page
/// can emit this event.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum BrowserRequest {
    Open {
        tab: String,
        url: String,
        bounds: Bounds,
    },
    Navigate {
        tab: String,
        url: String,
    },
    Back {
        tab: String,
    },
    Forward {
        tab: String,
    },
    Reload {
        tab: String,
    },
    Bounds {
        tab: String,
        bounds: Bounds,
    },
    Hide {},
    Close {
        tab: String,
    },
    Zoom {
        tab: String,
        factor: f64,
    },
    Query {
        tab: String,
        req: String,
        what: QueryWhat,
    },
    Screenshot {
        tab: String,
        req: String,
    },
    External {
        url: String,
    },
}

/// What native tells the page (`detail` of the `ashlr:browser` event).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BrowserEvent {
    Nav {
        tab: String,
        url: String,
        loading: bool,
    },
    Title {
        tab: String,
        title: String,
    },
    Blocked {
        tab: String,
        url: String,
        reason: String,
    },
    Closed {
        tab: String,
    },
    Result {
        req: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

impl BrowserEvent {
    fn nav(tab: &str, url: &str, loading: bool) -> Self {
        BrowserEvent::Nav {
            tab: tab.to_string(),
            url: truncate_chars(url, NAV_URL_MAX_CHARS),
            loading,
        }
    }

    fn title(tab: &str, title: &str) -> Self {
        BrowserEvent::Title {
            tab: tab.to_string(),
            title: truncate_chars(title, TITLE_MAX_CHARS),
        }
    }

    fn blocked(tab: &str, url: &str, reason: &str) -> Self {
        BrowserEvent::Blocked {
            tab: tab.to_string(),
            url: truncate_chars(url, BLOCKED_URL_MAX_CHARS),
            reason: reason.to_string(),
        }
    }

    fn closed(tab: &str) -> Self {
        BrowserEvent::Closed {
            tab: tab.to_string(),
        }
    }

    fn result(req: &str, outcome: Result<Value, String>) -> Self {
        match outcome {
            Ok(data) => BrowserEvent::Result {
                req: req.to_string(),
                ok: true,
                data: Some(data),
                error: None,
            },
            Err(error) => BrowserEvent::Result {
                req: req.to_string(),
                ok: false,
                data: None,
                error: Some(truncate_chars(&error, TITLE_MAX_CHARS)),
            },
        }
    }
}

// ── pure pieces ──────────────────────────────────────────────────────────────

/// `^[a-z0-9]{1,16}$`.
pub fn valid_tab(tab: &str) -> bool {
    (1..=16).contains(&tab.len())
        && tab
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// `^[A-Za-z0-9_-]{1,40}$`.
pub fn valid_req(req: &str) -> bool {
    (1..=40).contains(&req.len())
        && req
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn label_for(tab: &str) -> String {
    format!("{LABEL_PREFIX}{tab}")
}

/// The tab id of a browser window label, if it is one.
pub fn tab_from_label(label: &str) -> Option<&str> {
    label
        .strip_prefix(LABEL_PREFIX)
        .filter(|tab| valid_tab(tab))
}

pub fn is_browser_label(label: &str) -> bool {
    tab_from_label(label).is_some()
}

/// Finite numbers only; x, y ≥ 0; width, height in [1, 10000]. x and y are
/// also capped so the physical-position math can never overflow.
pub fn sanitize_bounds(b: Bounds) -> Option<Bounds> {
    if ![b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite()) {
        return None;
    }
    Some(Bounds {
        x: b.x.clamp(0.0, 100_000.0),
        y: b.y.clamp(0.0, 100_000.0),
        width: b.width.clamp(1.0, 10_000.0),
        height: b.height.clamp(1.0, 10_000.0),
    })
}

/// Keep the tab inside the Verse viewport (`viewport_*` in logical px): a pane
/// rectangle that overruns the window edge must not float over the desktop.
pub fn fit_to_viewport(b: Bounds, viewport_width: f64, viewport_height: f64) -> Bounds {
    let fit = |pos: f64, len: f64, limit: f64| {
        if limit.is_finite() && limit > 0.0 {
            len.min(limit - pos).max(1.0)
        } else {
            len
        }
    };
    Bounds {
        width: fit(b.x, b.width, viewport_width),
        height: fit(b.y, b.height, viewport_height),
        ..b
    }
}

/// Screen position (physical px) of a tab: the Verse window's inner position
/// (physical) plus the pane offset (CSS px) scaled by the window's scale
/// factor.
pub fn screen_position(inner: (i32, i32), scale: f64, b: &Bounds) -> (i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    // `as i32` saturates; the offsets are already capped by sanitize_bounds.
    (
        inner.0.saturating_add((b.x * scale).round() as i32),
        inner.1.saturating_add((b.y * scale).round() as i32),
    )
}

pub fn clamp_zoom(factor: f64) -> f64 {
    if factor.is_finite() {
        factor.clamp(0.25, 5.0)
    } else {
        1.0
    }
}

/// Parse and validate a `shell-browser` payload. `None` for anything that is
/// not exactly one well-formed request.
pub fn parse_request(payload: &str) -> Option<BrowserRequest> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    // Object first: serde would otherwise accept some non-object encodings.
    let value: Value = serde_json::from_str(payload.trim()).ok()?;
    if !value.is_object() {
        return None;
    }
    let request: BrowserRequest = serde_json::from_value(value).ok()?;
    validate(request)
}

fn validate(request: BrowserRequest) -> Option<BrowserRequest> {
    let url_ok = |url: &str| url.len() <= MAX_URL_LEN;
    match request {
        BrowserRequest::Open { tab, url, bounds } => {
            let bounds = sanitize_bounds(bounds)?;
            (valid_tab(&tab) && url_ok(&url)).then_some(BrowserRequest::Open { tab, url, bounds })
        }
        BrowserRequest::Bounds { tab, bounds } => {
            let bounds = sanitize_bounds(bounds)?;
            valid_tab(&tab).then_some(BrowserRequest::Bounds { tab, bounds })
        }
        BrowserRequest::Navigate { ref tab, ref url } => {
            (valid_tab(tab) && url_ok(url)).then_some(request)
        }
        BrowserRequest::Back { ref tab }
        | BrowserRequest::Forward { ref tab }
        | BrowserRequest::Reload { ref tab }
        | BrowserRequest::Close { ref tab } => valid_tab(tab).then_some(request),
        BrowserRequest::Zoom { tab, factor } => {
            (valid_tab(&tab) && factor.is_finite()).then(|| BrowserRequest::Zoom {
                tab,
                factor: clamp_zoom(factor),
            })
        }
        BrowserRequest::Query {
            ref tab, ref req, ..
        }
        | BrowserRequest::Screenshot { ref tab, ref req } => {
            (valid_tab(tab) && valid_req(req)).then_some(request)
        }
        BrowserRequest::External { ref url } => url_ok(url).then_some(request),
        BrowserRequest::Hide {} => Some(request),
    }
}

/// The port of the Verse origin (`http://127.0.0.1:7777` → 7777).
fn verse_port(verse_origin: &str) -> Option<u16> {
    Url::parse(verse_origin).ok()?.port_or_known_default()
}

/// Every spelling of "this machine": `localhost` (and `*.localhost`, which
/// resolves to loopback too), any 127/8 or ::1 address, the IPv4-mapped forms,
/// and the unspecified address (0.0.0.0 / ::), which macOS routes to loopback.
fn is_loopback_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|v4: Ipv4Addr| v4.is_loopback() || v4.is_unspecified())
        }
        Err(_) => false,
    }
}

/// The URL rule for an already-parsed URL (no length cap: this also judges the
/// page's own navigations, and real-world URLs can be long).
pub fn url_rule(url: &Url, verse_origin: &str) -> Result<(), &'static str> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("scheme");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("userinfo");
    }
    if url.host_str().map_or(true, str::is_empty) {
        return Err("invalid");
    }
    // Fail closed: if the Verse origin cannot be parsed, no loopback URL on any
    // port is allowed rather than possibly the Verse one.
    let is_verse_port = match verse_port(verse_origin) {
        Some(port) => url.port_or_known_default() == Some(port),
        None => true,
    };
    if is_verse_port && is_loopback_host(url) {
        return Err("verse-origin");
    }
    Ok(())
}

/// The URL rule for a URL the page asks native to open.
pub fn check_url(raw: &str, verse_origin: &str) -> Result<Url, &'static str> {
    if raw.len() > MAX_URL_LEN {
        return Err("too-long");
    }
    let url = Url::parse(raw).map_err(|_| "invalid")?;
    url_rule(&url, verse_origin)?;
    Ok(url)
}

/// What `on_navigation` does with a navigation the tab's page started.
#[derive(Debug, PartialEq, Eq)]
pub enum NavDecision {
    Allow,
    Block(&'static str),
}

/// `on_navigation` sees EVERY frame's navigations, not only the main frame's,
/// so the in-page schemes a document creates for itself (`about:blank` /
/// `about:srcdoc` iframes, `blob:` and `data:` documents) are let through —
/// blocking them breaks ordinary sites and none of them reaches a host or
/// native. Everything else must pass the URL rule.
pub fn navigation_decision(url: &Url, verse_origin: &str) -> NavDecision {
    match url.scheme() {
        "http" | "https" => match url_rule(url, verse_origin) {
            Ok(()) => NavDecision::Allow,
            Err(reason) => NavDecision::Block(reason),
        },
        "about" if matches!(url.path(), "blank" | "srcdoc") => NavDecision::Allow,
        "blob" | "data" => NavDecision::Allow,
        _ => NavDecision::Block("scheme"),
    }
}

/// The script a `query` evaluates in the tab. Built only from constants.
pub fn query_script(what: QueryWhat) -> String {
    format!(
        "(function(){{try{{var t=window.__ashlrTap;return t?t.{call}:JSON.stringify({{error:'tap-missing'}})}}catch(e){{return JSON.stringify({{error:String(e&&e.message||e)}})}}}})()",
        call = what.call()
    )
}

/// The script that delivers `event` to the Verse page. The event is
/// JSON-encoded, never interpolated, so no title or URL a website chose can
/// break out of the literal. U+2028/U+2029 are escaped too: they are legal in
/// JSON but were line terminators in older JavaScript.
pub fn event_script(event: &BrowserEvent) -> String {
    let json = serde_json::to_string(event)
        .unwrap_or_else(|_| "null".to_string())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        "if (typeof window.__ASHLR_BROWSER_EVENT__ === 'function') window.__ASHLR_BROWSER_EVENT__({json});"
    )
}

/// Decode an `eval_with_callback` answer: the callback receives the JSON
/// encoding of the string the tap returned, so it is decoded twice. An answer
/// carrying an `error` key is a failure.
pub fn decode_tap_result(raw: &str) -> Result<Value, String> {
    if raw.len() > MAX_RESULT_BYTES {
        return Err("too-large".to_string());
    }
    let outer: Value = serde_json::from_str(raw).map_err(|_| "bad-result".to_string())?;
    let Value::String(inner) = outer else {
        return Err("bad-result".to_string());
    };
    let data: Value = serde_json::from_str(&inner).map_err(|_| "bad-result".to_string())?;
    if let Some(error) = data.as_object().and_then(|o| o.get("error")) {
        let message = match error {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        return Err(truncate_chars(&message, TITLE_MAX_CHARS));
    }
    Ok(data)
}

/// At most `max` characters, cut on a character boundary.
pub fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => text[..cut].to_string(),
        None => text.to_string(),
    }
}

/// The least recently used tab other than `keep`.
fn lru_victim(tabs: &HashMap<String, TabState>, open: &[String], keep: &str) -> Option<String> {
    open.iter()
        .filter(|tab| tab.as_str() != keep)
        .min_by_key(|tab| tabs.get(tab.as_str()).map_or(0, |t| t.last_used))
        .cloned()
}

// ── state ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default)]
struct TabState {
    bounds: Option<Bounds>,
    visible: bool,
    last_used: u64,
}

enum Job {
    /// A page request, stamped with the epoch it arrived in.
    Request(BrowserRequest, u64),
    /// A tab window was destroyed (closed by us, or by ⌘W while focused).
    Destroyed(String),
}

/// Managed state (`app.manage`).
#[derive(Default)]
pub struct BrowserPanes {
    tabs: Mutex<HashMap<String, TabState>>,
    worker: Mutex<Option<mpsc::Sender<Job>>>,
    /// Bumped by [`hide_all`]. A request that arrived before the bump (a
    /// `bounds` queued by a page that has since reloaded, or a window that has
    /// since been hidden to the tray) may still update state but never shows a
    /// tab again.
    epoch: AtomicU64,
    clock: AtomicU64,
    last_external: Mutex<Option<Instant>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

impl BrowserPanes {
    fn touch(&self, tab: &str) -> TabState {
        let stamp = self.clock.fetch_add(1, Ordering::Relaxed) + 1;
        let mut tabs = lock(&self.tabs);
        let entry = tabs.entry(tab.to_string()).or_default();
        entry.last_used = stamp;
        *entry
    }
}

// ── entry points (called from main.rs) ───────────────────────────────────────

/// A `shell-browser` event from the Verse page: parse on the listener thread,
/// hand to the worker.
pub fn handle_event(app: &AppHandle, payload: &str) {
    let Some(request) = parse_request(payload) else {
        eprintln!("[ashlr-desktop] ignoring a malformed shell-browser event");
        return;
    };
    let Some(panes) = app.try_state::<BrowserPanes>() else {
        return;
    };
    let epoch = panes.epoch.load(Ordering::SeqCst);
    enqueue(app, &panes, Job::Request(request, epoch));
}

/// Hide every tab window now (Verse hidden to the tray, or the Verse page
/// started (re)loading). Runs on the caller's thread — the main thread for
/// both callers — so the tabs disappear with the Verse window, not after it.
pub fn hide_all(app: &AppHandle) {
    if let Some(panes) = app.try_state::<BrowserPanes>() {
        panes.epoch.fetch_add(1, Ordering::SeqCst);
        for state in lock(&panes.tabs).values_mut() {
            state.visible = false;
        }
    }
    for (label, window) in app.webview_windows() {
        if is_browser_label(&label) {
            let _ = window.hide();
        }
    }
}

/// The Verse window moved, resized or changed scale: re-apply the stored
/// bounds of the visible tab. Runs on the caller's (main) thread so the tab
/// tracks a live resize instead of lagging behind a queue.
pub fn on_main_geometry_changed(app: &AppHandle) {
    let Some(panes) = app.try_state::<BrowserPanes>() else {
        return;
    };
    let visible: Vec<(String, Bounds)> = lock(&panes.tabs)
        .iter()
        .filter(|(_, s)| s.visible)
        .filter_map(|(tab, s)| s.bounds.map(|b| (tab.clone(), b)))
        .collect();
    if visible.is_empty() {
        return;
    }
    let Some(main) = main_window(app) else {
        return;
    };
    for (tab, bounds) in visible {
        if let Some(window) = app.get_webview_window(&label_for(&tab)) {
            apply_geometry(&main, &window, bounds);
        }
    }
}

/// A browser tab window is gone (our `close`, eviction, or ⌘W on the focused
/// tab): forget it and tell the page.
pub fn on_tab_destroyed(app: &AppHandle, label: &str) {
    let Some(tab) = tab_from_label(label) else {
        return;
    };
    if let Some(panes) = app.try_state::<BrowserPanes>() {
        enqueue(app, &panes, Job::Destroyed(tab.to_string()));
    }
}

fn enqueue(app: &AppHandle, panes: &BrowserPanes, job: Job) {
    let mut worker = lock(&panes.worker);
    let job = match worker.as_ref() {
        Some(tx) => match tx.send(job) {
            Ok(()) => return,
            Err(mpsc::SendError(job)) => job,
        },
        None => job,
    };
    let (tx, rx) = mpsc::channel::<Job>();
    let handle = app.clone();
    let spawned = thread::Builder::new()
        .name("ashlr-browser-pane".into())
        .spawn(move || {
            for job in rx {
                run_job(&handle, job);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[ashlr-desktop] could not start the browser-pane worker: {e}");
        return;
    }
    let _ = tx.send(job);
    *worker = Some(tx);
}

// ── the worker ───────────────────────────────────────────────────────────────

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(crate::MAIN_WINDOW_LABEL)
}

fn emit(app: &AppHandle, event: &BrowserEvent) {
    if let Some(main) = main_window(app) {
        let _ = main.eval(event_script(event));
    }
}

fn run_job(app: &AppHandle, job: Job) {
    let Some(panes) = app.try_state::<BrowserPanes>() else {
        return;
    };
    match job {
        Job::Destroyed(tab) => {
            lock(&panes.tabs).remove(&tab);
            emit(app, &BrowserEvent::closed(&tab));
        }
        Job::Request(request, epoch) => {
            let current = epoch == panes.epoch.load(Ordering::SeqCst);
            handle_request(app, &panes, request, current);
        }
    }
}

fn handle_request(app: &AppHandle, panes: &BrowserPanes, request: BrowserRequest, current: bool) {
    let origin = crate::SERVE_ORIGIN;
    match request {
        BrowserRequest::Open { tab, url, bounds } => {
            if app.get_webview_window(&label_for(&tab)).is_none() {
                let url = match check_url(&url, origin) {
                    Ok(url) => url,
                    Err(reason) => {
                        emit(app, &BrowserEvent::blocked(&tab, &url, reason));
                        return;
                    }
                };
                evict_if_full(app, panes, &tab);
                let Some(main) = main_window(app) else {
                    return;
                };
                if let Err(e) = build_tab_window(app, &main, &tab, url, bounds) {
                    eprintln!("[ashlr-desktop] could not open browser tab {tab}: {e}");
                    emit(app, &BrowserEvent::closed(&tab));
                    return;
                }
            }
            lock(&panes.tabs).entry(tab.clone()).or_default().bounds = Some(bounds);
            panes.touch(&tab);
            if current {
                show_only(app, panes, &tab);
            }
        }
        BrowserRequest::Bounds { tab, bounds } => {
            lock(&panes.tabs).entry(tab.clone()).or_default().bounds = Some(bounds);
            if current && app.get_webview_window(&label_for(&tab)).is_some() {
                panes.touch(&tab);
                show_only(app, panes, &tab);
            }
        }
        BrowserRequest::Hide {} => hide_all(app),
        BrowserRequest::Navigate { tab, url } => {
            let Some(window) = tab_window(app, &tab) else {
                return;
            };
            match check_url(&url, origin) {
                Ok(url) => {
                    if let Err(e) = window.navigate(url) {
                        eprintln!("[ashlr-desktop] browser tab {tab}: navigate failed: {e}");
                    }
                }
                Err(reason) => emit(app, &BrowserEvent::blocked(&tab, &url, reason)),
            }
        }
        BrowserRequest::Back { tab } => {
            if let Some(window) = tab_window(app, &tab) {
                let _ = window.eval("history.back()");
            }
        }
        BrowserRequest::Forward { tab } => {
            if let Some(window) = tab_window(app, &tab) {
                let _ = window.eval("history.forward()");
            }
        }
        BrowserRequest::Reload { tab } => {
            if let Some(window) = tab_window(app, &tab) {
                let _ = window.reload();
            }
        }
        BrowserRequest::Close { tab } => match app.get_webview_window(&label_for(&tab)) {
            // `closed` is emitted once, from the Destroyed event.
            Some(window) => {
                let _ = window.hide();
                if window.close().is_err() {
                    lock(&panes.tabs).remove(&tab);
                    emit(app, &BrowserEvent::closed(&tab));
                }
            }
            None => {
                lock(&panes.tabs).remove(&tab);
                emit(app, &BrowserEvent::closed(&tab));
            }
        },
        BrowserRequest::Zoom { tab, factor } => {
            if let Some(window) = tab_window(app, &tab) {
                let _ = window.set_zoom(clamp_zoom(factor));
            }
        }
        BrowserRequest::Query { tab, req, what } => {
            let reply = Reply::new(app, &req);
            let Some(window) = app.get_webview_window(&label_for(&tab)) else {
                reply.send(Err("no-tab".to_string()));
                return;
            };
            reply.arm_timeout(QUERY_TIMEOUT);
            let on_answer = reply.clone();
            if let Err(e) = window.eval_with_callback(query_script(what), move |raw| {
                on_answer.send(decode_tap_result(&raw));
            }) {
                reply.send(Err(format!("eval-failed: {e}")));
            }
        }
        BrowserRequest::Screenshot { tab, req } => {
            let reply = Reply::new(app, &req);
            let Some(window) = app.get_webview_window(&label_for(&tab)) else {
                reply.send(Err("no-tab".to_string()));
                return;
            };
            screenshot(panes, &tab, &window, reply);
        }
        BrowserRequest::External { url } => {
            let url = match check_url(&url, origin) {
                Ok(url) => url,
                Err(reason) => {
                    eprintln!("[ashlr-desktop] refusing to open {reason} URL externally");
                    return;
                }
            };
            {
                let mut last = lock(&panes.last_external);
                if last.is_some_and(|at| at.elapsed() < EXTERNAL_MIN_INTERVAL) {
                    eprintln!("[ashlr-desktop] dropping an external open (rate limited)");
                    return;
                }
                *last = Some(Instant::now());
            }
            open_external(app, url.as_str());
        }
    }
}

/// The tab's window; a request for a tab that no longer exists tells the page
/// the tab is closed so its UI does not wait on it.
fn tab_window(app: &AppHandle, tab: &str) -> Option<WebviewWindow> {
    let window = app.get_webview_window(&label_for(tab));
    if window.is_none() {
        emit(app, &BrowserEvent::closed(tab));
    }
    window
}

/// Rust-side only: the page is granted no `shell:*` permission. The URL has
/// already passed [`check_url`] (http/https, never the Verse origin), and the
/// opener receives it as one argv entry, never through a shell.
#[allow(deprecated)] // Shell::open → tauri-plugin-opener; the shell plugin is already here.
fn open_external(app: &AppHandle, url: &str) {
    use tauri_plugin_shell::ShellExt;
    if let Err(e) = app.shell().open(url, None) {
        eprintln!("[ashlr-desktop] could not open the system browser: {e}");
    }
}

fn evict_if_full(app: &AppHandle, panes: &BrowserPanes, keep: &str) {
    let open: Vec<String> = app
        .webview_windows()
        .keys()
        .filter_map(|label| tab_from_label(label).map(str::to_string))
        .collect();
    if open.len() < MAX_TABS {
        return;
    }
    let victim = lru_victim(&lock(&panes.tabs), &open, keep);
    if let Some(victim) = victim {
        if let Some(window) = app.get_webview_window(&label_for(&victim)) {
            let _ = window.hide();
            let _ = window.close();
        }
    }
}

/// Show `tab`, hide every other tab.
fn show_only(app: &AppHandle, panes: &BrowserPanes, tab: &str) {
    let label = label_for(tab);
    for (other, window) in app.webview_windows() {
        if other != label && is_browser_label(&other) && window.is_visible().unwrap_or(true) {
            let _ = window.hide();
        }
    }
    let bounds = {
        let mut tabs = lock(&panes.tabs);
        for (name, state) in tabs.iter_mut() {
            if name != tab {
                state.visible = false;
            }
        }
        tabs.get(tab).and_then(|s| s.bounds)
    };
    let (Some(main), Some(window), Some(bounds)) =
        (main_window(app), app.get_webview_window(&label), bounds)
    else {
        return;
    };
    // Never float a tab over the desktop while Verse itself is hidden or
    // minimised; the page re-sends `bounds` when it is visible again.
    if !main.is_visible().unwrap_or(false) || main.is_minimized().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    apply_geometry(&main, &window, bounds);
    if !window.is_visible().unwrap_or(false) {
        show_without_focus(&main, &window);
    }
    if let Some(state) = lock(&panes.tabs).get_mut(tab) {
        state.visible = true;
    }
}

fn apply_geometry(main: &WebviewWindow, window: &WebviewWindow, bounds: Bounds) {
    let (Ok(inner), Ok(scale), Ok(size)) = (
        main.inner_position(),
        main.scale_factor(),
        main.inner_size(),
    ) else {
        return;
    };
    let viewport = size.to_logical::<f64>(scale);
    let fitted = fit_to_viewport(bounds, viewport.width, viewport.height);
    let (x, y) = screen_position((inner.x, inner.y), scale, &fitted);
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_size(LogicalSize::new(fitted.width, fitted.height));
}

/// Show a tab without taking keyboard focus from the Verse composer.
///
/// macOS: `show()` is `makeKeyAndOrderFront`, which would steal focus on every
/// tab switch, and ordering a child window out detaches it from its parent.
/// So the tab is (re)attached to the Verse window and ordered front without
/// becoming key; the operator's first click in it focuses it
/// (`accept_first_mouse`).
#[cfg(target_os = "macos")]
fn show_without_focus(main: &WebviewWindow, window: &WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
    // The Verse window is never destroyed while the app runs (closing it hides
    // it to the tray), so its NSWindow pointer stays valid.
    let Ok(parent) = main.ns_window().map(|p| p as usize) else {
        let _ = window.show();
        return;
    };
    let result = window.with_webview(move |webview| {
        let child = webview.ns_window() as *const NSWindow;
        let parent = parent as *const NSWindow;
        // SAFETY: with_webview runs on the main thread; both pointers are live
        // NSWindows owned by tao for the duration of this call.
        unsafe {
            let (Some(child), Some(parent)) = (child.as_ref(), parent.as_ref()) else {
                return;
            };
            parent.addChildWindow_ordered(child, NSWindowOrderingMode::Above);
            child.orderFront(None);
        }
    });
    if result.is_err() {
        let _ = window.show();
    }
}

#[cfg(not(target_os = "macos"))]
fn show_without_focus(main: &WebviewWindow, window: &WebviewWindow) {
    let refocus = main.is_focused().unwrap_or(false);
    let _ = window.show();
    if refocus {
        let _ = main.set_focus();
    }
}

// ── tab windows ──────────────────────────────────────────────────────────────

fn build_tab_window(
    app: &AppHandle,
    main: &WebviewWindow,
    tab: &str,
    url: Url,
    bounds: Bounds,
) -> tauri::Result<WebviewWindow> {
    let label = label_for(tab);

    let nav_app = app.clone();
    let nav_tab = tab.to_string();
    let new_window_app = app.clone();
    let new_window_tab = tab.to_string();
    let load_app = app.clone();
    let title_app = app.clone();

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("Ashlr browser")
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .visible(false)
        .accept_first_mouse(true)
        .initialization_script(TAP_JS)
        .on_navigation(
            move |url| match navigation_decision(url, crate::SERVE_ORIGIN) {
                NavDecision::Allow => true,
                NavDecision::Block(reason) => {
                    emit(
                        &nav_app,
                        &BrowserEvent::blocked(&nav_tab, url.as_str(), reason),
                    );
                    false
                }
            },
        )
        .on_new_window(move |url, _features| {
            // Never a new window: follow the link in the same tab, through the
            // same queue (and so the same URL rule) as a page `navigate`.
            match url_rule(&url, crate::SERVE_ORIGIN) {
                Ok(()) => {
                    if let Some(panes) = new_window_app.try_state::<BrowserPanes>() {
                        let epoch = panes.epoch.load(Ordering::SeqCst);
                        let request = BrowserRequest::Navigate {
                            tab: new_window_tab.clone(),
                            url: url.to_string(),
                        };
                        enqueue(&new_window_app, &panes, Job::Request(request, epoch));
                    }
                }
                Err(reason) => emit(
                    &new_window_app,
                    &BrowserEvent::blocked(&new_window_tab, url.as_str(), reason),
                ),
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            let Some(tab) = tab_from_label(window.label()) else {
                return;
            };
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit(
                &load_app,
                &BrowserEvent::nav(tab, payload.url().as_str(), loading),
            );
        })
        .on_document_title_changed(move |window, title| {
            if let Some(tab) = tab_from_label(window.label()) {
                emit(&title_app, &BrowserEvent::title(tab, &title));
            }
        })
        .parent(main)?;

    // Start at the right place so nothing flashes at the default position.
    if let (Ok(inner), Ok(scale)) = (main.inner_position(), main.scale_factor()) {
        let origin = inner.to_logical::<f64>(scale);
        builder = builder
            .position(origin.x + bounds.x, origin.y + bounds.y)
            .inner_size(bounds.width, bounds.height);
    }

    separate_data_store(builder, app).build()
}

#[cfg(target_os = "macos")]
fn separate_data_store<'a>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    _app: &AppHandle,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    if macos_major_version() >= 14 {
        builder.data_store_identifier(DATA_STORE_ID)
    } else {
        // wry ignores data_store_identifier below macOS 14 and would use the
        // Verse window's default store; a throwaway store keeps them apart.
        builder.incognito(true)
    }
}

#[cfg(not(target_os = "macos"))]
fn separate_data_store<'a>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    app: &AppHandle,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    match app.path().app_local_data_dir() {
        Ok(dir) => builder.data_directory(dir.join("browser")),
        Err(_) => builder.incognito(true),
    }
}

#[cfg(target_os = "macos")]
fn macos_major_version() -> isize {
    objc2_foundation::NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
}

// ── replies ──────────────────────────────────────────────────────────────────

/// Sends exactly one `result` for a request, whichever of the answer and the
/// timeout comes first.
#[derive(Clone)]
struct Reply {
    app: AppHandle,
    req: String,
    done: Arc<AtomicBool>,
}

impl Reply {
    fn new(app: &AppHandle, req: &str) -> Self {
        Self {
            app: app.clone(),
            req: req.to_string(),
            done: Arc::new(AtomicBool::new(false)),
        }
    }

    fn send(&self, outcome: Result<Value, String>) {
        if self.done.swap(true, Ordering::SeqCst) {
            return;
        }
        emit(&self.app, &BrowserEvent::result(&self.req, outcome));
    }

    fn arm_timeout(&self, after: Duration) {
        let reply = self.clone();
        let _ = thread::Builder::new()
            .name("ashlr-browser-timeout".into())
            .spawn(move || {
                thread::sleep(after);
                reply.send(Err("timeout".to_string()));
            });
    }
}

// ── screenshot ───────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn screenshot(panes: &BrowserPanes, tab: &str, window: &WebviewWindow, reply: Reply) {
    let width = lock(&panes.tabs)
        .get(tab)
        .and_then(|s| s.bounds)
        .map_or(SNAPSHOT_MAX_WIDTH, |b| b.width.min(SNAPSHOT_MAX_WIDTH));
    reply.arm_timeout(SCREENSHOT_TIMEOUT);
    let on_image = reply.clone();
    let started = snapshot::take(window, width, move |outcome| {
        on_image.send(outcome.map(|shot| {
            use base64::Engine;
            serde_json::json!({
                "mime": shot.mime,
                "base64": base64::engine::general_purpose::STANDARD.encode(&shot.bytes),
                "width": shot.width,
                "height": shot.height,
            })
        }));
    });
    if let Err(e) = started {
        reply.send(Err(format!("snapshot-failed: {e}")));
    }
}

#[cfg(not(target_os = "macos"))]
fn screenshot(_panes: &BrowserPanes, _tab: &str, _window: &WebviewWindow, reply: Reply) {
    reply.send(Err("unsupported".to_string()));
}

/// `WKWebView takeSnapshotWithConfiguration:` → PNG (JPEG q0.8 above 4 MB).
#[cfg(target_os = "macos")]
mod snapshot {
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::{runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSImageCompressionFactor,
    };
    use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use tauri::WebviewWindow;

    use super::SNAPSHOT_PNG_MAX_BYTES;

    pub struct Shot {
        pub mime: &'static str,
        pub bytes: Vec<u8>,
        pub width: isize,
        pub height: isize,
    }

    /// Start a snapshot; `done` runs once, on the main thread, with the image
    /// or the reason there is none. (If the window disappears first, `done`
    /// never runs and the caller's timeout answers.)
    pub fn take(
        window: &WebviewWindow,
        width_points: f64,
        done: impl FnOnce(Result<Shot, String>) + Send + 'static,
    ) -> tauri::Result<()> {
        let done = Mutex::new(Some(done));
        window.with_webview(move |platform| {
            let finish = move |outcome: Result<Shot, String>| {
                let callback = match done.lock() {
                    Ok(mut guard) => guard.take(),
                    Err(poisoned) => poisoned.into_inner().take(),
                };
                if let Some(callback) = callback {
                    callback(outcome);
                }
            };
            let Some(mtm) = MainThreadMarker::new() else {
                finish(Err("not-main-thread".to_string()));
                return;
            };
            let pointer = platform.inner() as *const WKWebView;
            // SAFETY: on macOS PlatformWebview::inner() is the live WKWebView
            // wry created for this window; with_webview runs on the main thread.
            let Some(webview) = (unsafe { pointer.as_ref() }) else {
                finish(Err("no-webview".to_string()));
                return;
            };
            // SAFETY: plain property setters on a fresh configuration object.
            let config = unsafe { WKSnapshotConfiguration::new(mtm) };
            let width = NSNumber::new_f64(width_points.max(1.0));
            unsafe { config.setSnapshotWidth(Some(&width)) };
            let block = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                // SAFETY: WebKit passes a valid NSImage or null.
                let outcome = match unsafe { image.as_ref() } {
                    Some(image) => encode(image),
                    None => Err("snapshot-failed".to_string()),
                };
                finish(outcome);
            });
            // SAFETY: the block matches WebKit's completion-handler signature
            // and is retained by WebKit until it has been called.
            unsafe {
                webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block)
            };
        })
    }

    fn encode(image: &NSImage) -> Result<Shot, String> {
        let tiff = image
            .TIFFRepresentation()
            .ok_or_else(|| "encode-failed".to_string())?;
        let rep =
            NSBitmapImageRep::imageRepWithData(&tiff).ok_or_else(|| "encode-failed".to_string())?;
        let (width, height) = (rep.pixelsWide(), rep.pixelsHigh());
        let none = NSDictionary::<NSString, AnyObject>::new();
        // SAFETY: an empty properties dictionary is always valid.
        let png =
            unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &none) }
                .ok_or_else(|| "encode-failed".to_string())?;
        if png.len() <= SNAPSHOT_PNG_MAX_BYTES {
            return Ok(Shot {
                mime: "image/png",
                bytes: png.to_vec(),
                width,
                height,
            });
        }
        let quality = NSNumber::new_f64(0.8);
        let quality: &AnyObject = &quality;
        // SAFETY: NSImageCompressionFactor is an AppKit constant; its value is
        // documented as an NSNumber in [0, 1].
        let key: &NSString = unsafe { NSImageCompressionFactor };
        let properties = NSDictionary::<NSString, AnyObject>::from_slices(&[key], &[quality]);
        let jpeg = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties)
        }
        .ok_or_else(|| "encode-failed".to_string())?;
        Ok(Shot {
            mime: "image/jpeg",
            bytes: jpeg.to_vec(),
            width,
            height,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "http://127.0.0.1:7777";

    fn parse(json: &str) -> Option<BrowserRequest> {
        parse_request(json)
    }

    // ── parsing ──────────────────────────────────────────────────────────────

    #[test]
    fn every_op_parses() {
        let b = r#"{"x":10,"y":20,"width":300,"height":200}"#;
        let cases = [
            format!(r#"{{"op":"open","tab":"t1","url":"https://example.com/","bounds":{b}}}"#),
            r#"{"op":"navigate","tab":"t1","url":"http://localhost:3000/"}"#.to_string(),
            r#"{"op":"back","tab":"t1"}"#.to_string(),
            r#"{"op":"forward","tab":"t1"}"#.to_string(),
            r#"{"op":"reload","tab":"t1"}"#.to_string(),
            format!(r#"{{"op":"bounds","tab":"t1","bounds":{b}}}"#),
            r#"{"op":"hide"}"#.to_string(),
            r#"{"op":"close","tab":"t1"}"#.to_string(),
            r#"{"op":"zoom","tab":"t1","factor":1.5}"#.to_string(),
            r#"{"op":"query","tab":"t1","req":"r_1-a","what":"text"}"#.to_string(),
            r#"{"op":"query","tab":"t1","req":"r2","what":"pick-start"}"#.to_string(),
            r#"{"op":"screenshot","tab":"t1","req":"r3"}"#.to_string(),
            r#"{"op":"external","url":"https://example.com/"}"#.to_string(),
        ];
        for case in &cases {
            assert!(parse(case).is_some(), "should parse: {case}");
        }
        assert_eq!(
            parse(r#"{"op":"query","tab":"t1","req":"r","what":"pick-poll"}"#),
            Some(BrowserRequest::Query {
                tab: "t1".into(),
                req: "r".into(),
                what: QueryWhat::PickPoll
            })
        );
    }

    #[test]
    fn unknown_ops_fields_and_shapes_are_rejected() {
        for case in [
            r#"{"op":"eval","tab":"t1","js":"alert(1)"}"#,
            r#"{"op":"back","tab":"t1","extra":1}"#,
            r#"{"op":"hide","tab":"t1"}"#,
            r#"{"op":"navigate","tab":"t1","url":"https://a.b/","script":"x"}"#,
            r#"{"op":"query","tab":"t1","req":"r","what":"eval"}"#,
            r#"{"op":"open","tab":"t1","url":"https://a.b/","bounds":{"x":0,"y":0,"width":1,"height":1,"z":2}}"#,
            r#"{"op":"open","tab":"t1","url":"https://a.b/"}"#,
            r#"{"tab":"t1"}"#,
            r#"["hide"]"#,
            r#""hide""#,
            "null",
            "not json",
            "",
        ] {
            assert_eq!(parse(case), None, "should reject: {case}");
        }
    }

    #[test]
    fn tab_and_request_ids_are_validated() {
        assert!(valid_tab("a"));
        assert!(valid_tab("abc123def4567890"));
        assert!(!valid_tab(""));
        assert!(!valid_tab("abc123def45678901"));
        assert!(!valid_tab("Tab"));
        assert!(!valid_tab("t-1"));
        assert!(!valid_tab("t 1"));
        assert!(!valid_tab("../main"));
        assert!(valid_req("aZ09_-"));
        assert!(valid_req(&"r".repeat(40)));
        assert!(!valid_req(&"r".repeat(41)));
        assert!(!valid_req(""));
        assert!(!valid_req("r.1"));
        assert!(!valid_req("r'1"));
        assert_eq!(parse(r#"{"op":"back","tab":"MAIN"}"#), None);
        assert_eq!(parse(r#"{"op":"back","tab":""}"#), None);
        assert_eq!(parse(r#"{"op":"screenshot","tab":"t1","req":"a b"}"#), None);
        assert_eq!(label_for("t1"), "browser-t1");
        assert_eq!(tab_from_label("browser-t1"), Some("t1"));
        assert_eq!(tab_from_label("main"), None);
        assert_eq!(tab_from_label("browser-"), None);
        assert!(!is_browser_label("launch"));
    }

    #[test]
    fn bounds_are_sanitised() {
        let open = |b: &str| parse(&format!(r#"{{"op":"bounds","tab":"t","bounds":{b}}}"#));
        assert_eq!(
            open(r#"{"x":-5,"y":-1,"width":0,"height":99999}"#),
            Some(BrowserRequest::Bounds {
                tab: "t".into(),
                bounds: Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 10_000.0
                }
            })
        );
        // JSON has no NaN/Infinity, and an out-of-range literal is refused.
        assert_eq!(open(r#"{"x":1e400,"y":0,"width":1,"height":1}"#), None);
        assert_eq!(open(r#"{"x":"1","y":0,"width":1,"height":1}"#), None);
        assert_eq!(
            sanitize_bounds(Bounds {
                x: f64::NAN,
                y: 0.0,
                width: 1.0,
                height: 1.0
            }),
            None
        );
        assert_eq!(
            sanitize_bounds(Bounds {
                x: 0.0,
                y: 0.0,
                width: f64::INFINITY,
                height: 1.0
            }),
            None
        );
        assert_eq!(
            sanitize_bounds(Bounds {
                x: 1e12,
                y: 3.5,
                width: 10.0,
                height: 20.0
            })
            .map(|b| b.x),
            Some(100_000.0)
        );
    }

    #[test]
    fn zoom_is_clamped() {
        assert_eq!(
            parse(r#"{"op":"zoom","tab":"t","factor":99}"#),
            Some(BrowserRequest::Zoom {
                tab: "t".into(),
                factor: 5.0
            })
        );
        assert_eq!(
            parse(r#"{"op":"zoom","tab":"t","factor":0}"#),
            Some(BrowserRequest::Zoom {
                tab: "t".into(),
                factor: 0.25
            })
        );
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
    }

    #[test]
    fn oversized_payloads_and_urls_are_dropped() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(
            parse(&format!(r#"{{"op":"navigate","tab":"t","url":"{long}"}}"#)),
            None
        );
        assert_eq!(
            parse(&format!(r#"{{"op":"external","url":"{long}"}}"#)),
            None
        );
        let huge = format!(
            r#"{{"op":"hide","pad":"{}"}}"#,
            "x".repeat(MAX_PAYLOAD_BYTES)
        );
        assert_eq!(parse(&huge), None);
    }

    // ── URL rule ─────────────────────────────────────────────────────────────

    #[test]
    fn only_http_and_https_pass() {
        assert!(check_url("https://example.com/a?b#c", ORIGIN).is_ok());
        assert!(check_url("http://example.com", ORIGIN).is_ok());
        for (url, reason) in [
            ("javascript:alert(1)", "scheme"),
            ("file:///etc/passwd", "scheme"),
            ("ftp://example.com/", "scheme"),
            ("data:text/html,<b>x</b>", "scheme"),
            ("tauri://localhost/", "scheme"),
            ("ipc://localhost/x", "scheme"),
            ("about:blank", "scheme"),
            ("not a url", "invalid"),
            ("", "invalid"),
            ("/relative", "invalid"),
        ] {
            assert_eq!(check_url(url, ORIGIN).err(), Some(reason), "{url}");
        }
    }

    #[test]
    fn userinfo_is_refused() {
        assert_eq!(
            check_url("https://user@example.com/", ORIGIN).err(),
            Some("userinfo")
        );
        assert_eq!(
            check_url("https://user:pw@example.com/", ORIGIN).err(),
            Some("userinfo")
        );
        assert_eq!(
            check_url("https://:pw@example.com/", ORIGIN).err(),
            Some("userinfo")
        );
    }

    #[test]
    fn the_verse_origin_is_refused_in_every_spelling() {
        for url in [
            "http://127.0.0.1:7777/verse/",
            "http://127.0.0.1:7777",
            "https://127.0.0.1:7777/",
            "http://localhost:7777/",
            "http://LOCALHOST:7777/",
            "http://localhost.:7777/",
            "http://app.localhost:7777/",
            "http://[::1]:7777/",
            "http://[::ffff:127.0.0.1]:7777/",
            "http://0.0.0.0:7777/",
            "http://127.1:7777/",
            "http://2130706433:7777/",
            "http://0x7f.0.0.1:7777/",
            "http://127.0.0.2:7777/",
        ] {
            assert_eq!(check_url(url, ORIGIN).err(), Some("verse-origin"), "{url}");
        }
    }

    #[test]
    fn other_loopback_ports_and_remote_hosts_on_7777_are_fine() {
        for url in [
            "http://127.0.0.1:3000/",
            "http://localhost:5173/",
            "http://[::1]:8080/",
            "http://127.0.0.1/",
            "http://example.com:7777/",
            "http://10.0.0.5:7777/",
        ] {
            assert!(check_url(url, ORIGIN).is_ok(), "{url}");
        }
    }

    #[test]
    fn an_unparsable_verse_origin_fails_closed_for_loopback() {
        assert_eq!(
            check_url("http://127.0.0.1:3000/", "garbage").err(),
            Some("verse-origin")
        );
        assert!(check_url("https://example.com/", "garbage").is_ok());
    }

    #[test]
    fn too_long_urls_are_refused_but_page_navigations_are_not_length_capped() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(check_url(&long, ORIGIN).err(), Some("too-long"));
        let parsed = Url::parse(&long).unwrap();
        assert_eq!(navigation_decision(&parsed, ORIGIN), NavDecision::Allow);
    }

    #[test]
    fn page_navigations_follow_the_rule_but_in_page_schemes_pass() {
        let decide = |u: &str| navigation_decision(&Url::parse(u).unwrap(), ORIGIN);
        assert_eq!(decide("https://example.com/"), NavDecision::Allow);
        assert_eq!(decide("about:blank"), NavDecision::Allow);
        assert_eq!(decide("about:srcdoc"), NavDecision::Allow);
        assert_eq!(decide("data:text/html,hi"), NavDecision::Allow);
        assert_eq!(decide("blob:https://example.com/uuid"), NavDecision::Allow);
        assert_eq!(decide("about:config"), NavDecision::Block("scheme"));
        assert_eq!(decide("file:///etc/passwd"), NavDecision::Block("scheme"));
        assert_eq!(decide("tauri://localhost/"), NavDecision::Block("scheme"));
        assert_eq!(decide("ipc://localhost/cmd"), NavDecision::Block("scheme"));
        assert_eq!(decide("mailto:a@b.c"), NavDecision::Block("scheme"));
        assert_eq!(
            decide("http://localhost:7777/verse/"),
            NavDecision::Block("verse-origin")
        );
        assert_eq!(
            decide("https://u:p@example.com/"),
            NavDecision::Block("userinfo")
        );
    }

    // ── geometry ─────────────────────────────────────────────────────────────

    #[test]
    fn physical_position_is_inner_position_plus_scaled_offset() {
        let b = Bounds {
            x: 100.0,
            y: 48.5,
            width: 400.0,
            height: 300.0,
        };
        assert_eq!(screen_position((0, 0), 1.0, &b), (100, 49));
        assert_eq!(screen_position((200, 150), 2.0, &b), (400, 247));
        assert_eq!(screen_position((-1440, 25), 2.0, &b), (-1240, 122));
        assert_eq!(screen_position((10, 10), f64::NAN, &b), (110, 59));
        assert_eq!(screen_position((10, 10), 0.0, &b), (110, 59));
        assert_eq!(screen_position((i32::MAX, 0), 2.0, &b), (i32::MAX, 97));
    }

    #[test]
    fn tabs_are_kept_inside_the_viewport() {
        let b = Bounds {
            x: 600.0,
            y: 100.0,
            width: 800.0,
            height: 900.0,
        };
        let fitted = fit_to_viewport(b, 1200.0, 800.0);
        assert_eq!((fitted.width, fitted.height), (600.0, 700.0));
        assert_eq!((fitted.x, fitted.y), (600.0, 100.0));
        // Entirely outside → a 1px sliver, never a negative size.
        let outside = fit_to_viewport(Bounds { x: 2000.0, ..b }, 1200.0, 800.0);
        assert_eq!(outside.width, 1.0);
        // Unknown viewport → unchanged.
        assert_eq!(fit_to_viewport(b, 0.0, f64::NAN), b);
    }

    #[test]
    fn the_least_recently_used_tab_is_evicted() {
        let mut tabs = HashMap::new();
        for (tab, used) in [("a", 5), ("b", 2), ("c", 9)] {
            tabs.insert(
                tab.to_string(),
                TabState {
                    last_used: used,
                    ..Default::default()
                },
            );
        }
        let open: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        // "d" has no state (never touched) → oldest.
        assert_eq!(lru_victim(&tabs, &open, "x"), Some("d".into()));
        assert_eq!(lru_victim(&tabs, &open[..3], "x"), Some("b".into()));
        assert_eq!(lru_victim(&tabs, &open[..3], "b"), Some("a".into()));
        assert_eq!(lru_victim(&tabs, &[], "b"), None);
    }

    // ── native → page ────────────────────────────────────────────────────────

    #[test]
    fn events_are_json_encoded_and_cannot_break_out() {
        let script = event_script(&BrowserEvent::title(
            "t1",
            "x\"});alert(1);//</script>\u{2028}",
        ));
        assert!(script.starts_with(
            "if (typeof window.__ASHLR_BROWSER_EVENT__ === 'function') window.__ASHLR_BROWSER_EVENT__({"
        ));
        assert!(script.ends_with("});"));
        assert!(script.contains(r#""kind":"title""#));
        assert!(
            script.contains(r#""title":"x\"});alert(1);//</script>\u2028""#),
            "{script}"
        );
        assert!(!script.contains('\u{2028}'));
        // The payload between the parens is exactly one JSON value.
        let start =
            script.find("__ASHLR_BROWSER_EVENT__(").unwrap() + "__ASHLR_BROWSER_EVENT__(".len();
        let json = &script[start..script.len() - 2];
        let value: Value = serde_json::from_str(json).unwrap();
        assert_eq!(value["tab"], "t1");
    }

    #[test]
    fn event_shapes_match_the_protocol() {
        let as_json = |e: &BrowserEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            as_json(&BrowserEvent::nav("t", "https://a.b/", true)),
            serde_json::json!({"kind":"nav","tab":"t","url":"https://a.b/","loading":true})
        );
        assert_eq!(
            as_json(&BrowserEvent::blocked("t", "file:///x", "scheme")),
            serde_json::json!({"kind":"blocked","tab":"t","url":"file:///x","reason":"scheme"})
        );
        assert_eq!(
            as_json(&BrowserEvent::closed("t")),
            serde_json::json!({"kind":"closed","tab":"t"})
        );
        assert_eq!(
            as_json(&BrowserEvent::result("r1", Ok(serde_json::json!({"a":1})))),
            serde_json::json!({"kind":"result","req":"r1","ok":true,"data":{"a":1}})
        );
        assert_eq!(
            as_json(&BrowserEvent::result("r1", Err("timeout".into()))),
            serde_json::json!({"kind":"result","req":"r1","ok":false,"error":"timeout"})
        );
    }

    #[test]
    fn long_titles_and_urls_are_truncated_on_char_boundaries() {
        let title = "é".repeat(400);
        let BrowserEvent::Title { title: t, .. } = BrowserEvent::title("t", &title) else {
            unreachable!()
        };
        assert_eq!(t.chars().count(), 300);
        let url = format!("data:{}", "✓".repeat(3000));
        let BrowserEvent::Blocked { url: u, .. } = BrowserEvent::blocked("t", &url, "scheme")
        else {
            unreachable!()
        };
        assert_eq!(u.chars().count(), 2048);
        assert_eq!(truncate_chars("abc", 10), "abc");
        assert_eq!(truncate_chars("abc", 0), "");
    }

    // ── tab → native ─────────────────────────────────────────────────────────

    #[test]
    fn tap_results_are_decoded_twice() {
        let raw =
            serde_json::to_string(r#"{"url":"https://a.b/","title":"T","readyState":"complete"}"#)
                .unwrap();
        let data = decode_tap_result(&raw).unwrap();
        assert_eq!(data["readyState"], "complete");
        let failed = serde_json::to_string(r#"{"error":"tap-missing"}"#).unwrap();
        assert_eq!(decode_tap_result(&failed), Err("tap-missing".to_string()));
        let odd = serde_json::to_string(r#"{"error":{"code":1}}"#).unwrap();
        assert_eq!(decode_tap_result(&odd), Err(r#"{"code":1}"#.to_string()));
        // Not a string (a hostile page returned an object), empty (undefined),
        // or a string that is not JSON.
        assert_eq!(
            decode_tap_result(r#"{"url":"x"}"#),
            Err("bad-result".into())
        );
        assert_eq!(decode_tap_result(""), Err("bad-result".into()));
        assert_eq!(decode_tap_result(r#""not json""#), Err("bad-result".into()));
        let big = serde_json::to_string(&"x".repeat(MAX_RESULT_BYTES)).unwrap();
        assert_eq!(decode_tap_result(&big), Err("too-large".into()));
    }

    #[test]
    fn query_scripts_are_fixed_and_wrapped() {
        for (what, call) in [
            (QueryWhat::Text, "t.text(20000)"),
            (QueryWhat::Console, "t.dump(200)"),
            (QueryWhat::Info, "t.info()"),
            (QueryWhat::PickStart, "t.pickStart()"),
            (QueryWhat::PickPoll, "t.pickPoll()"),
            (QueryWhat::PickCancel, "t.pickCancel()"),
        ] {
            let script = query_script(what);
            assert_eq!(
                script,
                format!("(function(){{try{{var t=window.__ashlrTap;return t?{call}:JSON.stringify({{error:'tap-missing'}})}}catch(e){{return JSON.stringify({{error:String(e&&e.message||e)}})}}}})()")
            );
        }
    }

    // ── the tap ──────────────────────────────────────────────────────────────

    #[test]
    fn the_tap_is_read_only_and_locked_down() {
        // Never reads what was typed, never acts on the page.
        for forbidden in [
            ".value",
            ".submit(",
            ".click(",
            "dispatchEvent(",
            "requestSubmit",
            "eval(",
            "new Function",
        ] {
            assert!(
                !TAP_JS.contains(forbidden),
                "browser_tap.js must not contain `{forbidden}`"
            );
        }
        for needle in [
            "Object.defineProperty(window, '__ashlrTap'",
            "configurable: false",
            "writable: false",
            "enumerable: false",
            "hasOwnProperty.call(window, '__ashlrTap')",
            "preventDefault()",
            "stopPropagation()",
            "stopImmediatePropagation()",
            "'Escape'",
            "pointer-events:none",
            "#4f7cff",
            "2147483647",
            "unhandledrejection",
            "'Uncaught ",
            "'loadend'",
            "failed to load ",
            "nth-of-type(",
            "CSS.escape",
            "innerText",
        ] {
            assert!(TAP_JS.contains(needle), "browser_tap.js lost `{needle}`");
        }
        for api in [
            "dump:",
            "text:",
            "info:",
            "pickStart:",
            "pickPoll:",
            "pickCancel:",
        ] {
            assert!(TAP_JS.contains(api), "browser_tap.js lost `{api}`");
        }
        // Buffer sizes the protocol promises.
        assert!(TAP_JS.contains("CONSOLE_MAX = 200"));
        assert!(TAP_JS.contains("NETWORK_MAX = 100"));
        assert!(TAP_JS.contains("ENTRY_TEXT_MAX = 2000"));
        assert!(TAP_JS.contains("URL_MAX = 500"));
    }

    // ── capabilities ─────────────────────────────────────────────────────────

    #[test]
    fn no_capability_reaches_a_browser_tab() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut seen = 0;
        for entry in std::fs::read_dir(&dir).expect("capabilities dir") {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            seen += 1;
            let raw = std::fs::read_to_string(&path).unwrap();
            let json: Value = serde_json::from_str(&raw).unwrap();
            for key in ["windows", "webviews"] {
                for pattern in json[key].as_array().into_iter().flatten() {
                    let pattern = pattern.as_str().unwrap_or("");
                    assert!(
                        !pattern.contains('*')
                            && !pattern.contains('?')
                            && !pattern.starts_with(LABEL_PREFIX),
                        "{} grants `{pattern}`, which could match a browser tab",
                        path.display()
                    );
                }
            }
        }
        assert!(seen >= 1);
    }
}

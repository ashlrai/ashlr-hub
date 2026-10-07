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
//!   tab: the constant `browser_tap.js` (init script) and the tap calls built
//!   by [`tap_script`] from a closed enum. Every call names a CONSTANT tap
//!   function; its argument, when it has one, is a JSON object serialized by
//!   `serde_json` from a VALIDATED Rust value (refs, sigs, numbers, and the
//!   `select` option strings as JSON string literals), with U+2028/U+2029
//!   escaped exactly as [`event_script`] does. No string from the Verse page
//!   or from the tab ever becomes code. The tab's answers come back as JSON,
//!   are decoded by [`decode_tap_result`], and are forwarded to the Verse page
//!   JSON-encoded by [`event_script`] — data, never code.
//! - **The one exception: `evaluate`.** [`evaluate_script`] hands an
//!   operator-supplied expression to the page's own indirect `eval` — the
//!   expression is still a JSON string LITERAL (data) in our script, but the
//!   page then runs it as code, by design. It exists for debugging the
//!   operator's own dev server, so it is refused unless the tab is on a
//!   loopback URL (checked here natively AND re-checked against
//!   `location.origin` inside the script, so a navigation racing the check
//!   cannot redirect it), and it is off by default upstream (the operator
//!   opts in per chat). Nothing else in this file evaluates caller text.
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
//! - **No microphone or camera.** Every tab's WKWebView gets a UI delegate
//!   that denies media capture (`media_guard.rs`; wry's own grants it), and
//!   the tap replaces `navigator.mediaDevices.getUserMedia` before the page
//!   runs. Dictation captures audio in Rust for the Verse window only.
//! - **Acting, as the operator would (macOS).** Besides navigating, reading
//!   (text, console, network, an accessibility-style snapshot, page info, a
//!   picked element) and screenshots, the pane now ACTS: `{"act": …}` clicks,
//!   types, hovers, presses a key, selects an option or scrolls. Clicks and
//!   key presses are real AppKit events delivered into the tab's own window
//!   (`browser_input.rs`) — trusted input, no Accessibility permission, no
//!   `CGEventPost`, never another window. The tap first `prepare`s each act:
//!   it finds the point, re-checks the element is the one the caller judged
//!   (`expect`), and REFUSES password / payment / secret fields — native never
//!   types into those, and the typed text itself never enters a script (only
//!   its length does). The key table is closed (no ⌘V: the operator's
//!   clipboard never reaches a page). Genuine operator input in a tab — seen
//!   by an AppKit event monitor that synthesized events never pass — is
//!   reported as `{kind:"operator"}` so the Verse page can pause the agent.
//!
//! Requests are handled on ONE worker thread, in the order the page sent them
//! (a burst of `bounds` during a resize must not be applied out of order, and
//! creating a window from the event-handler thread deadlocks on Windows).
//! Queries never block that worker: their answers arrive on a callback, raced
//! against a timeout. Acts and screenshots, which need several round trips,
//! each run on a thread of their own (acts one at a time, in arrival order).

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
/// Largest screenshot, in output PIXELS (a model reads it; more pixels cost
/// tokens and add nothing a model can use).
pub const SNAPSHOT_MAX_PX_WIDTH: f64 = 1280.0;
pub const SNAPSHOT_MAX_PX_HEIGHT: f64 = 800.0;
/// An act's fixed time budget; `type` adds [`ACT_PER_CHAR`] per character.
pub const ACT_BASE_TIMEOUT: Duration = Duration::from_secs(5);
pub const ACT_PER_CHAR: Duration = Duration::from_millis(20);
/// Wire limits of the new query forms.
pub const SNAPSHOT_MAX_NODES: u32 = 2000;
pub const NETWORK_MAX_LIMIT: u32 = 500;
pub const TYPE_TEXT_MAX_CHARS: usize = 2000;
pub const SELECT_MAX_VALUES: usize = 50;
pub const SELECT_VALUE_MAX_CHARS: usize = 200;
pub const EVALUATE_MAX_CHARS: usize = 10_000;
pub const SCROLL_MAX_AMOUNT: f64 = 20_000.0;
/// Coordinates the page may name (CSS px), like `sanitize_bounds`' offsets.
pub const COORD_MAX: f64 = 100_000.0;
/// `evaluate` answers at most this many characters of the value.
pub const EVALUATE_VALUE_MAX_CHARS: usize = 20_000;
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

/// What a `query` asks of a tab. A closed enum, externally tagged: the plain
/// queries are bare strings (`"text"`), the ones with arguments are one-key
/// objects (`{"snapshot":{"max_nodes":300}}`). The page picks a tap function
/// by variant and can never supply script text (`evaluate` is the documented
/// exception, see the module header).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueryWhat {
    Text,
    Console,
    Info,
    PickStart,
    PickPoll,
    PickCancel,
    /// Hand control back after an operator takeover (clears the tap's
    /// "the agent is acting" window).
    Resume,
    Snapshot(SnapshotArgs),
    Network(NetworkArgs),
    Resolve(Target),
    /// Not a plain query: see [`ActSpec`].
    Act(ActSpec),
    /// Loopback-only, see [`evaluate_script`].
    Evaluate(EvaluateArgs),
}

/// `{"max_nodes"?: 1..=2000, "root_ref"?: Ref}`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotArgs {
    pub max_nodes: Option<u32>,
    pub root_ref: Option<String>,
}

/// `{"limit"?: 1..=500}`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkArgs {
    pub limit: Option<u32>,
}

/// An element: exactly one of `ref`, `x`+`y` (CSS px in the viewport), or
/// `focused: true` (the document's focused element; `resolve` only).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub focused: Option<bool>,
}

/// `{"expression": 1..=10000 chars}`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluateArgs {
    pub expression: String,
}

/// The tab and page load whose action the operator allowed.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedPage {
    pub tab: String,
    pub url: String,
    pub origin: String,
    pub load_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

/// One act, internally tagged by `kind`. Every field is validated by
/// [`validate`] before anything reaches the tab; see the module header for
/// what each does and what is refused.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ActSpec {
    Click {
        #[serde(rename = "ref")]
        reference: Option<String>,
        x: Option<f64>,
        y: Option<f64>,
        button: Option<MouseButton>,
        #[serde(default)]
        double: bool,
        modifiers: Option<Vec<crate::browser_input::Modifier>>,
        expect: Option<String>,
    },
    Type {
        #[serde(rename = "ref")]
        reference: String,
        text: String,
        #[serde(default)]
        submit: bool,
        #[serde(default)]
        clear: bool,
        expect: Option<String>,
    },
    Select {
        #[serde(rename = "ref")]
        reference: String,
        values: Vec<String>,
        expect: Option<String>,
    },
    Hover {
        #[serde(rename = "ref")]
        reference: Option<String>,
        x: Option<f64>,
        y: Option<f64>,
        expect: Option<String>,
    },
    Key {
        key: String,
    },
    Scroll {
        #[serde(rename = "ref")]
        reference: Option<String>,
        direction: Option<ScrollDirection>,
        amount: Option<f64>,
    },
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl ActSpec {
    fn kind(&self) -> &'static str {
        match self {
            ActSpec::Click { .. } => "click",
            ActSpec::Type { .. } => "type",
            ActSpec::Select { .. } => "select",
            ActSpec::Hover { .. } => "hover",
            ActSpec::Key { .. } => "key",
            ActSpec::Scroll { .. } => "scroll",
        }
    }

    fn reference(&self) -> Option<&str> {
        match self {
            ActSpec::Click { reference, .. }
            | ActSpec::Hover { reference, .. }
            | ActSpec::Scroll { reference, .. } => reference.as_deref(),
            ActSpec::Type { reference, .. } | ActSpec::Select { reference, .. } => {
                Some(reference.as_str())
            }
            ActSpec::Key { .. } => None,
        }
    }

    /// Characters to type (0 for every kind but `type`).
    fn text_chars(&self) -> usize {
        match self {
            ActSpec::Type { text, .. } => text.chars().count(),
            _ => 0,
        }
    }
}

/// The whole act, answer included, must finish within this.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn act_budget(spec: &ActSpec) -> Duration {
    ACT_BASE_TIMEOUT + ACT_PER_CHAR * spec.text_chars() as u32
}

/// How long the tap should treat trusted input as the agent's own.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn act_tap_ms(spec: &ActSpec) -> u64 {
    (1500 + 40 * spec.text_chars() as u64).min(60_000)
}

/// `^e[1-9][0-9]{0,6}$` — an element ref the tap handed out.
pub fn valid_ref(r: &str) -> bool {
    let b = r.as_bytes();
    (2..=8).contains(&b.len())
        && b[0] == b'e'
        && (b'1'..=b'9').contains(&b[1])
        && b[2..].iter().all(u8::is_ascii_digit)
}

/// `^[a-z0-9]{1,16}$` — an element signature (`expect`).
pub fn valid_sig(s: &str) -> bool {
    valid_tab(s)
}

fn valid_coord(v: f64) -> bool {
    v.is_finite() && (0.0..=COORD_MAX).contains(&v)
}

/// Exactly one of `ref` / (`x` and `y`); `focused` only where allowed.
fn valid_target(
    reference: Option<&str>,
    x: Option<f64>,
    y: Option<f64>,
    focused: Option<bool>,
    allow_focused: bool,
) -> bool {
    let by_ref = reference.is_some();
    let by_point = match (x, y) {
        (Some(x), Some(y)) => {
            if !(valid_coord(x) && valid_coord(y)) {
                return false;
            }
            true
        }
        (None, None) => false,
        _ => return false,
    };
    let by_focus = match focused {
        None => false,
        Some(true) if allow_focused => true,
        Some(_) => return false,
    };
    if reference.is_some_and(|r| !valid_ref(r)) {
        return false;
    }
    [by_ref, by_point, by_focus].iter().filter(|b| **b).count() == 1
}

fn valid_expect(expect: &Option<String>) -> bool {
    expect.as_deref().map_or(true, valid_sig)
}

fn valid_act(spec: &ActSpec) -> bool {
    match spec {
        ActSpec::Click {
            reference,
            x,
            y,
            modifiers,
            expect,
            ..
        } => {
            let mods_ok = modifiers.as_ref().map_or(true, |m| {
                m.len() <= 4 && m.iter().enumerate().all(|(i, a)| !m[..i].contains(a))
            });
            mods_ok
                && valid_expect(expect)
                && valid_target(reference.as_deref(), *x, *y, None, false)
        }
        ActSpec::Hover {
            reference,
            x,
            y,
            expect,
        } => valid_expect(expect) && valid_target(reference.as_deref(), *x, *y, None, false),
        ActSpec::Type {
            reference,
            text,
            expect,
            ..
        } => {
            let n = text.chars().count();
            valid_ref(reference)
                && valid_expect(expect)
                && (1..=TYPE_TEXT_MAX_CHARS).contains(&n)
                && text.chars().all(crate::browser_input::text_char_allowed)
        }
        ActSpec::Select {
            reference,
            values,
            expect,
        } => {
            valid_ref(reference)
                && valid_expect(expect)
                && (1..=SELECT_MAX_VALUES).contains(&values.len())
                && values
                    .iter()
                    .all(|v| v.chars().count() <= SELECT_VALUE_MAX_CHARS)
        }
        ActSpec::Key { key } => crate::browser_input::parse_key_combo(key).is_some(),
        ActSpec::Scroll {
            reference,
            direction,
            amount,
        } => {
            (reference.is_some() || direction.is_some())
                && reference.as_deref().map_or(true, valid_ref)
                && amount.map_or(true, |a| {
                    a.is_finite() && (1.0..=SCROLL_MAX_AMOUNT).contains(&a)
                })
        }
    }
}

fn valid_what(what: &QueryWhat) -> bool {
    match what {
        QueryWhat::Text
        | QueryWhat::Console
        | QueryWhat::Info
        | QueryWhat::PickStart
        | QueryWhat::PickPoll
        | QueryWhat::PickCancel
        | QueryWhat::Resume => true,
        QueryWhat::Snapshot(a) => {
            a.max_nodes
                .map_or(true, |n| (1..=SNAPSHOT_MAX_NODES).contains(&n))
                && a.root_ref.as_deref().map_or(true, valid_ref)
        }
        QueryWhat::Network(a) => a
            .limit
            .map_or(true, |n| (1..=NETWORK_MAX_LIMIT).contains(&n)),
        QueryWhat::Resolve(t) => valid_target(t.reference.as_deref(), t.x, t.y, t.focused, true),
        QueryWhat::Act(spec) => valid_act(spec),
        QueryWhat::Evaluate(a) => (1..=EVALUATE_MAX_CHARS).contains(&a.expression.chars().count()),
    }
}

/// A JSON value as a JavaScript expression: `serde_json` output (a JSON text
/// is a valid JS literal) with U+2028/U+2029 escaped, as [`event_script`]
/// does. This is the ONLY way data enters a script this file builds.
pub fn js_json(value: &Value) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "null".to_string())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

impl QueryWhat {
    /// The `__ashlrTap` call, arguments included: a constant function name
    /// and, for the forms with arguments, one JSON object built from the
    /// validated fields. `None` for `act` and `evaluate`, which are not plain
    /// tap calls.
    fn call(&self) -> Option<String> {
        use serde_json::{json, Map};
        let call = match self {
            QueryWhat::Text => "text(20000)".to_string(),
            QueryWhat::Console => "dump(200)".to_string(),
            QueryWhat::Info => "info()".to_string(),
            QueryWhat::PickStart => "pickStart()".to_string(),
            QueryWhat::PickPoll => "pickPoll()".to_string(),
            QueryWhat::PickCancel => "pickCancel()".to_string(),
            QueryWhat::Resume => "resume()".to_string(),
            QueryWhat::Snapshot(a) => {
                let mut o = Map::new();
                if let Some(n) = a.max_nodes {
                    o.insert("maxNodes".into(), json!(n));
                }
                if let Some(r) = &a.root_ref {
                    o.insert("rootRef".into(), json!(r));
                }
                format!("snapshot({})", js_json(&Value::Object(o)))
            }
            QueryWhat::Network(a) => {
                let mut o = Map::new();
                if let Some(n) = a.limit {
                    o.insert("limit".into(), json!(n));
                }
                format!("network({})", js_json(&Value::Object(o)))
            }
            QueryWhat::Resolve(t) => {
                let arg = match (&t.reference, t.x, t.y) {
                    (Some(r), _, _) => json!({ "ref": r }),
                    (None, Some(x), Some(y)) => json!({ "x": x, "y": y }),
                    _ => json!({ "focused": true }),
                };
                format!("resolve({})", js_json(&arg))
            }
            QueryWhat::Act(_) | QueryWhat::Evaluate(_) => return None,
        };
        Some(call)
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
        approved: Option<ApprovedPage>,
    },
    /// `clip`: a rectangle in CSS px of the page's viewport (only the
    /// visible viewport can be captured — WebKit renders anything beyond it
    /// blank).
    Screenshot {
        tab: String,
        req: String,
        clip: Option<Bounds>,
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
    /// The operator pressed a mouse button or a key in this tab (genuine
    /// input — see `browser_input.rs`): the agent should pause.
    Operator {
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

    fn operator(tab: &str) -> Self {
        BrowserEvent::Operator {
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
    // serde reads `{"text": null}` or `{"text": {}}` as the unit variant
    // `"text"`; only the forms that take arguments may be objects, so every
    // query has exactly one spelling.
    if let Some(Value::Object(what)) = value.get("what") {
        const ARG_FORMS: [&str; 5] = ["snapshot", "network", "resolve", "act", "evaluate"];
        if !what.keys().all(|k| ARG_FORMS.contains(&k.as_str())) {
            return None;
        }
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
            ref tab,
            ref req,
            ref what,
            ref approved,
        } => {
            let gate = match what {
                QueryWhat::Act(_) | QueryWhat::Evaluate(_) => {
                    approved.as_ref().is_some_and(|a| valid_approved(tab, a))
                }
                _ => approved.is_none(),
            };
            (valid_tab(tab) && valid_req(req) && valid_what(what) && gate).then_some(request)
        }
        BrowserRequest::Screenshot { tab, req, clip } => {
            let clip = match clip {
                Some(c) => Some(sanitize_bounds(c)?),
                None => None,
            };
            (valid_tab(&tab) && valid_req(&req)).then_some(BrowserRequest::Screenshot {
                tab,
                req,
                clip,
            })
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

fn valid_approved(tab: &str, approved: &ApprovedPage) -> bool {
    if approved.tab != tab
        || !valid_tab(&approved.tab)
        || approved.url.len() > MAX_URL_LEN
        || !(1..=40).contains(&approved.load_id.len())
        || !approved.load_id.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return false;
    }
    let Ok(url) = check_url(&approved.url, crate::SERVE_ORIGIN) else {
        return false;
    };
    url.origin().ascii_serialization() == approved.origin
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

/// The script that makes one tap call (`call` = a constant function name
/// plus, at most, a [`js_json`] argument) and returns its JSON string answer.
pub fn tap_script(call: &str) -> String {
    format!(
        "(function(){{try{{var t=window.__ashlrTap;return t?t.{call}:JSON.stringify({{error:'tap-missing'}})}}catch(e){{return JSON.stringify({{error:String(e&&e.message||e)}})}}}})()"
    )
}

/// The script a plain `query` evaluates in the tab; `None` for `act` and
/// `evaluate`, which have their own paths.
pub fn query_script(what: &QueryWhat) -> Option<String> {
    what.call().map(|call| tap_script(&call))
}

/// The script for `evaluate` — THE deliberate exception to "no caller text
/// becomes code" (see the module header). `expression` is embedded as a JSON
/// string literal and handed to the page's indirect `eval`, so it runs as a
/// global-scope script in the page, exactly as if the operator had typed it
/// into the page's devtools console; it cannot break out of OUR wrapper,
/// which runs first and decides what comes back. `origin` (the loopback
/// origin native just checked) is re-checked against `location.origin`
/// before anything runs, so a navigation between the check and the eval is
/// refused rather than evaluated on another site. A page whose CSP forbids
/// `unsafe-eval` answers with the CSP error. Promises are not awaited.
///
/// Why this is safe enough: the operator opts in per chat upstream (off by
/// default), the target is the operator's OWN loopback dev server (never a
/// third-party site with the operator's logins), the tab has zero IPC, and
/// the answer comes back as data through [`decode_tap_result`] like any other.
pub fn evaluate_script(expression: &str, approved: &ApprovedPage) -> String {
    let expr = js_json(&Value::String(expression.to_string()));
    let origin = js_json(&Value::String(approved.origin.clone()));
    let url = js_json(&Value::String(approved.url.clone()));
    let load_id = js_json(&Value::String(approved.load_id.clone()));
    format!(
        "(function(){{var S=JSON.stringify;try{{if(location.origin!=={origin}||location.href!=={url}||!window.__ashlrTap||JSON.parse(window.__ashlrTap.info()).loadId!=={load_id})return S({{error:'approved-page-changed'}});var r=(0,eval)({expr});if(r!==null&&(typeof r==='object'||typeof r==='function')&&typeof r.then==='function')return S({{value:'(a Promise \\u2014 await is not supported)',type:'promise'}});var v;if(typeof r==='string'){{v=r}}else{{try{{v=S(r)}}catch(e){{v=undefined}}if(typeof v!=='string')v=String(r)}}var cut=v.length>{max};return S({{value:cut?v.slice(0,{max}):v,type:typeof r,truncated:cut}})}}catch(e){{var m;try{{m=String(e&&e.message||e)}}catch(_){{m='error'}}return S({{error:m}})}}}})()",
        max = EVALUATE_VALUE_MAX_CHARS
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
    crate::browser_input::forget_tab(tab);
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

/// Genuine operator input in `tab` (from `browser_input`'s event monitor, on
/// the main thread; `eval` only queues the script, it never blocks).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn emit_operator(app: &AppHandle, tab: &str) {
    if valid_tab(tab) {
        emit(app, &BrowserEvent::operator(tab));
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

/// `evaluate` runs only on the operator's own loopback server: the tab's
/// CURRENT URL (not what was asked for — the page may have navigated) must be
/// loopback and pass the URL rule (so never the Verse origin). Answers the
/// origin the script re-checks in the page.
fn evaluate_target(window: &WebviewWindow, verse_origin: &str) -> Result<String, &'static str> {
    let url = window.url().map_err(|_| "no-url")?;
    loopback_origin(&url, verse_origin)
}

fn page_matches(window: &WebviewWindow, approved: &ApprovedPage) -> bool {
    window.label() == label_for(&approved.tab)
        && window.url().ok().is_some_and(|url| {
            url.as_str() == approved.url && url.origin().ascii_serialization() == approved.origin
        })
}

/// The origin of `url` if it may be evaluated on (see [`evaluate_target`]).
pub fn loopback_origin(url: &Url, verse_origin: &str) -> Result<String, &'static str> {
    if !is_loopback_host(url) || url_rule(url, verse_origin).is_err() {
        return Err("not-loopback");
    }
    Ok(url.origin().ascii_serialization())
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
        BrowserRequest::Query {
            tab,
            req,
            what,
            approved,
        } => {
            let reply = Reply::new(app, &req);
            let Some(window) = app.get_webview_window(&label_for(&tab)) else {
                reply.send(Err("no-tab".to_string()));
                return;
            };
            let script = match what {
                QueryWhat::Act(spec) => {
                    let Some(approved) = approved else {
                        reply.send(Err("missing-approved-page".into()));
                        return;
                    };
                    start_act(window, reply, spec, approved);
                    return;
                }
                QueryWhat::Evaluate(args) => {
                    let Some(approved) = approved.as_ref() else {
                        reply.send(Err("missing-approved-page".into()));
                        return;
                    };
                    let page_origin = match evaluate_target(&window, origin) {
                        Ok(page_origin) => page_origin,
                        Err(reason) => {
                            reply.send(Err(reason.into()));
                            return;
                        }
                    };
                    if page_origin != approved.origin || !page_matches(&window, approved) {
                        reply.send(Err("approved-page-changed".into()));
                        return;
                    }
                    evaluate_script(&args.expression, approved)
                }
                other => match query_script(&other) {
                    Some(script) => script,
                    None => {
                        reply.send(Err("unsupported".to_string()));
                        return;
                    }
                },
            };
            reply.arm_timeout(QUERY_TIMEOUT);
            let on_answer = reply.clone();
            if let Err(e) = window.eval_with_callback(script, move |raw| {
                on_answer.send(decode_tap_result(&raw));
            }) {
                reply.send(Err(format!("eval-failed: {e}")));
            }
        }
        BrowserRequest::Screenshot { tab, req, clip } => {
            let reply = Reply::new(app, &req);
            let Some(window) = app.get_webview_window(&label_for(&tab)) else {
                reply.send(Err("no-tab".to_string()));
                return;
            };
            screenshot(window, clip, reply);
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
        show_without_focus(&main, &window, tab);
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
/// (`accept_first_mouse`). Once ordered in, the window has its window number,
/// which the operator-input monitor needs to recognise the tab.
#[cfg(target_os = "macos")]
fn show_without_focus(main: &WebviewWindow, window: &WebviewWindow, tab: &str) {
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
    // The Verse window is never destroyed while the app runs (closing it hides
    // it to the tray), so its NSWindow pointer stays valid.
    let Ok(parent) = main.ns_window().map(|p| p as usize) else {
        let _ = window.show();
        return;
    };
    let tab = tab.to_string();
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
            crate::browser_input::register_tab_window(child.windowNumber(), &tab);
        }
    });
    if result.is_err() {
        let _ = window.show();
    }
}

#[cfg(not(target_os = "macos"))]
fn show_without_focus(main: &WebviewWindow, window: &WebviewWindow, _tab: &str) {
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
        .title("Phantom browser")
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

    let window = separate_data_store(builder, app).build()?;
    // Microphone / camera: wry's WKUIDelegate grants every WebKit capture
    // request, so an arbitrary site in a tab would get the mic the moment the
    // app holds the permission (dictation). Swap in the deny proxy
    // (media_guard.rs); if that cannot be done, the tab does not exist.
    if let Err(e) = crate::media_guard::apply(&window) {
        let _ = window.destroy();
        return Err(tauri::Error::Io(std::io::Error::other(format!(
            "media-capture guard unavailable: {e}"
        ))));
    }
    Ok(window)
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

    /// Already answered (by the result or by the timeout). A long-running act
    /// checks this before every step: once the page was told `timeout`, it
    /// must not go on clicking or typing behind the caller's back.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn is_done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
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

// ── acting ───────────────────────────────────────────────────────────────────

/// Acts run one at a time, in arrival order: two acts interleaving their key
/// presses in one page would type garbage.
#[cfg(target_os = "macos")]
static ACT_LOCK: Mutex<()> = Mutex::new(());

/// Characters sent per main-thread batch while typing, and the pause per
/// character between batches (taken on the act's own thread, so the main
/// thread is never held up). Real typing is slower; this is fast enough to be
/// practical and slow enough for input handlers that debounce.
#[cfg(target_os = "macos")]
const TYPE_BATCH: usize = 20;
#[cfg(target_os = "macos")]
const TYPE_PACE: Duration = Duration::from_millis(4);
/// Between the focusing click and the first key press.
#[cfg(target_os = "macos")]
const TYPE_FOCUS_SETTLE: Duration = Duration::from_millis(50);

/// `t.<name>(<json>)`: a constant tap function and one [`js_json`] argument.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn tap_call(name: &'static str, arg: &Value) -> String {
    tap_script(&format!("{name}({})", js_json(arg)))
}

/// The argument of the tap's `prepare`: the validated act EXCEPT the text to
/// type — only its length and whether it contains a newline. What is typed
/// travels as key events, never through a script.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn prepare_args(spec: &ActSpec) -> Value {
    use serde_json::{json, Map};
    let mut o = Map::new();
    o.insert("kind".into(), json!(spec.kind()));
    if let Some(r) = spec.reference() {
        o.insert("ref".into(), json!(r));
    }
    let mut put_point = |x: &Option<f64>, y: &Option<f64>| {
        if let (Some(x), Some(y)) = (x, y) {
            o.insert("x".into(), json!(x));
            o.insert("y".into(), json!(y));
        }
    };
    match spec {
        ActSpec::Click { x, y, .. } | ActSpec::Hover { x, y, .. } => put_point(x, y),
        _ => {}
    }
    match spec {
        ActSpec::Click {
            button,
            double,
            modifiers,
            expect,
            ..
        } => {
            if let Some(b) = button {
                o.insert("button".into(), json!(b));
            }
            if *double {
                o.insert("double".into(), json!(true));
            }
            if let Some(m) = modifiers {
                o.insert("modifiers".into(), json!(m));
            }
            if let Some(e) = expect {
                o.insert("expect".into(), json!(e));
            }
        }
        ActSpec::Type {
            text,
            submit,
            clear,
            expect,
            ..
        } => {
            if let Some(e) = expect {
                o.insert("expect".into(), json!(e));
            }
            if *clear {
                o.insert("clear".into(), json!(true));
            }
            if *submit {
                o.insert("submit".into(), json!(true));
            }
            o.insert("textLength".into(), json!(text.chars().count()));
            o.insert("hasNewline".into(), json!(text.contains('\n')));
        }
        ActSpec::Select { values, expect, .. } => {
            o.insert("values".into(), json!(values));
            if let Some(e) = expect {
                o.insert("expect".into(), json!(e));
            }
        }
        ActSpec::Hover { expect, .. } => {
            if let Some(e) = expect {
                o.insert("expect".into(), json!(e));
            }
        }
        ActSpec::Key { key } => {
            o.insert("key".into(), json!(key));
        }
        ActSpec::Scroll {
            direction, amount, ..
        } => {
            if let Some(d) = direction {
                o.insert("direction".into(), json!(d));
            }
            if let Some(a) = amount {
                o.insert("amount".into(), json!(a));
            }
        }
    }
    o.insert("ms".into(), json!(act_tap_ms(spec)));
    Value::Object(o)
}

/// The argument of the tap's `after`: `{kind, ref?}`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn after_args(spec: &ActSpec) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("kind".into(), Value::from(spec.kind()));
    if let Some(r) = spec.reference() {
        o.insert("ref".into(), Value::from(r));
    }
    Value::Object(o)
}

/// An act's answer: what the tap reported while preparing, then after (its
/// fresher keys win), then what native owns — `kind`, the point it acted at
/// (`x`, `y` in CSS px, `null` when the tap did the act itself without one)
/// and whether native input was synthesized (`native`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn act_reply(spec: &ActSpec, prepared: Value, after: Value, native: bool) -> Value {
    let x = prepared.get("x").cloned().unwrap_or(Value::Null);
    let y = prepared.get("y").cloned().unwrap_or(Value::Null);
    let mut out = serde_json::Map::new();
    for part in [prepared, after] {
        if let Value::Object(map) = part {
            out.extend(map);
        }
    }
    out.remove("error");
    out.insert("kind".into(), Value::from(spec.kind()));
    out.insert("x".into(), x);
    out.insert("y".into(), y);
    out.insert("native".into(), Value::Bool(native));
    Value::Object(out)
}

/// Start an act on its own thread. The reply's timeout covers the whole act
/// (including waiting for an earlier act to finish).
fn start_act(window: WebviewWindow, reply: Reply, spec: ActSpec, approved: ApprovedPage) {
    #[cfg(target_os = "macos")]
    {
        let budget = act_budget(&spec);
        reply.arm_timeout(budget);
        let deadline = Instant::now() + budget;
        let worker = reply.clone();
        let spawned = thread::Builder::new()
            .name("ashlr-browser-act".into())
            .spawn(move || {
                let _serial = lock(&ACT_LOCK);
                if worker.is_done() {
                    return;
                }
                let outcome = act::run(&window, &spec, &approved, deadline, &worker);
                worker.send(outcome);
            });
        if spawned.is_err() {
            reply.send(Err("spawn-failed".to_string()));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, spec, approved);
        reply.send(Err("unsupported".to_string()));
    }
}

/// Evaluate a tap call and wait — on the calling thread, never the main
/// thread — for its decoded answer.
#[cfg(target_os = "macos")]
fn eval_blocking(
    window: &WebviewWindow,
    script: String,
    timeout: Duration,
) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel::<String>();
    window
        .eval_with_callback(script, move |raw| {
            let _ = tx.send(raw);
        })
        .map_err(|e| format!("eval-failed: {e}"))?;
    match rx.recv_timeout(timeout) {
        Ok(raw) => decode_tap_result(&raw),
        Err(_) => Err("timeout".to_string()),
    }
}

/// The act itself (macOS): `prepare` in the page → native input unless the
/// tap already did it → `after` in the page.
#[cfg(target_os = "macos")]
mod act {
    use std::{
        thread,
        time::{Duration, Instant},
    };

    use objc2_app_kit::NSWindow;
    use objc2_web_kit::WKWebView;
    use serde_json::{json, Value};
    use tauri::WebviewWindow;

    use super::{
        act_reply, after_args, eval_blocking, page_matches, prepare_args, tap_call, ActSpec,
        ApprovedPage, MouseButton, Reply, TYPE_BATCH, TYPE_FOCUS_SETTLE, TYPE_PACE,
    };
    use crate::browser_input::{self as input, native, Stroke};

    /// Time left, or `timeout` once the deadline passed or the caller was
    /// already told `timeout` — no further input after that.
    fn left(deadline: Instant, reply: &Reply) -> Result<Duration, String> {
        if reply.is_done() {
            return Err("timeout".to_string());
        }
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| "timeout".to_string())
    }

    /// Run `f` on the main thread with the tab's view and window.
    fn on_main<F>(
        window: &WebviewWindow,
        approved: &ApprovedPage,
        deadline: Instant,
        reply: &Reply,
        f: F,
    ) -> Result<(), String>
    where
        F: FnOnce(&WKWebView, &NSWindow, &dyn Fn() -> bool) -> Result<(), &'static str>
            + Send
            + 'static,
    {
        // The tap reports the live document load; the Tauri URL is checked
        // again on the main thread immediately before dispatching input.
        let info = eval_blocking(window, tap_call("info", &json!({})), left(deadline, reply)?)?;
        if info.get("url").and_then(Value::as_str) != Some(approved.url.as_str())
            || info.get("loadId").and_then(Value::as_str) != Some(approved.load_id.as_str())
        {
            return Err("approved-page-changed".into());
        }
        let wait = left(deadline, reply)?;
        let check_window = window.clone();
        let check_page = approved.clone();
        native::on_main(window, wait, move |view, win| {
            let ready = || page_matches(&check_window, &check_page);
            if !ready() {
                return Err("approved-page-changed");
            }
            f(view, win, &ready)
        })?
        .map_err(str::to_string)
    }

    /// The point `prepare` answered: `((x, y), innerWidth)` in CSS px.
    fn point(prepared: &Value) -> Result<((f64, f64), f64), String> {
        let num = |key: &str| {
            prepared
                .get(key)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
                .ok_or_else(|| "bad-prepare".to_string())
        };
        Ok(((num("x")?, num("y")?), num("vw")?))
    }

    fn stroke(combo: &str) -> Result<Stroke, String> {
        input::parse_key_combo(combo).ok_or_else(|| "bad-key".to_string())
    }

    pub fn run(
        window: &WebviewWindow,
        spec: &ActSpec,
        approved: &ApprovedPage,
        deadline: Instant,
        reply: &Reply,
    ) -> Result<Value, String> {
        if !page_matches(window, approved) {
            return Err("approved-page-changed".into());
        }
        let mut args = prepare_args(spec);
        let Value::Object(ref mut fields) = args else {
            return Err("bad-prepare".into());
        };
        fields.insert("approvedUrl".into(), json!(approved.url));
        fields.insert("approvedLoadId".into(), json!(approved.load_id));
        let prepared = eval_blocking(window, tap_call("prepare", &args), left(deadline, reply)?)?;
        if prepared.get("url").and_then(Value::as_str) != Some(approved.url.as_str())
            || prepared.get("loadId").and_then(Value::as_str) != Some(approved.load_id.as_str())
        {
            return Err("approved-page-changed".into());
        }
        let done = prepared.get("done") == Some(&Value::Bool(true));
        if !done {
            perform(window, spec, approved, &prepared, deadline, reply)?;
        }
        let after = eval_blocking(
            window,
            tap_call("after", &after_args(spec)),
            left(deadline, reply)?,
        )?;
        Ok(act_reply(spec, prepared, after, !done))
    }

    fn perform(
        window: &WebviewWindow,
        spec: &ActSpec,
        approved: &ApprovedPage,
        prepared: &Value,
        deadline: Instant,
        reply: &Reply,
    ) -> Result<(), String> {
        match spec {
            // A native right click opens AppKit's context menu, which runs a
            // modal loop on the main thread until someone dismisses it. The
            // tap answers a right click itself (a `contextmenu` event); if it
            // did not, refuse rather than freeze the app.
            ActSpec::Click {
                button: Some(MouseButton::Right),
                ..
            } => Err("right-click-needs-tap".to_string()),
            ActSpec::Click {
                double, modifiers, ..
            } => {
                let (css, vw) = point(prepared)?;
                let flags = input::modifier_flags(modifiers.as_deref().unwrap_or(&[]));
                let double = *double;
                on_main(
                    window,
                    approved,
                    deadline,
                    reply,
                    move |view, win, ready| {
                        native::click(view, win, css, vw, flags, double, || ready())
                    },
                )
            }
            ActSpec::Hover { .. } => {
                let (css, vw) = point(prepared)?;
                on_main(
                    window,
                    approved,
                    deadline,
                    reply,
                    move |view, win, ready| native::hover(view, win, css, vw, || ready()),
                )
            }
            ActSpec::Type {
                reference,
                text,
                submit,
                clear,
                ..
            } => {
                // Everything that can refuse is decided before the first event.
                let multiline = prepared.get("multiline") == Some(&Value::Bool(true));
                let strokes = input::strokes_for_text(text, multiline).map_err(str::to_string)?;
                let (css, vw) = point(prepared)?;
                let enter = stroke("Enter")?;
                let backspace = stroke("Backspace")?;
                // Focus the field the way a person would: click it.
                on_main(
                    window,
                    approved,
                    deadline,
                    reply,
                    move |view, win, ready| native::click(view, win, css, vw, 0, false, || ready()),
                )?;
                thread::sleep(TYPE_FOCUS_SETTLE);
                if *clear {
                    // The tap selects the field's content; Backspace deletes it.
                    eval_blocking(
                        window,
                        tap_call(
                            "clear",
                            &json!({ "ref": reference, "approvedUrl": approved.url, "approvedLoadId": approved.load_id }),
                        ),
                        left(deadline, reply)?,
                    )?;
                    on_main(
                        window,
                        approved,
                        deadline,
                        reply,
                        move |view, win, ready| {
                            native::focus_webview(view, win);
                            native::keys(win, &[backspace], || ready())
                        },
                    )?;
                }
                for chunk in strokes.chunks(TYPE_BATCH) {
                    let batch = chunk.to_vec();
                    on_main(window, approved, deadline, reply, move |_, win, ready| {
                        native::keys(win, &batch, || ready())
                    })?;
                    thread::sleep(TYPE_PACE * chunk.len() as u32);
                }
                if *submit {
                    on_main(window, approved, deadline, reply, move |_, win, ready| {
                        native::keys(win, &[enter], || ready())
                    })?;
                }
                Ok(())
            }
            ActSpec::Key { key } => {
                let combo = stroke(key)?;
                on_main(
                    window,
                    approved,
                    deadline,
                    reply,
                    move |view, win, ready| {
                        native::focus_webview(view, win);
                        native::keys(win, &[combo], || ready())
                    },
                )
            }
            // `select` (a native popup menu would block the app) and `scroll`
            // are done by the tap; an answer without `done` is a tap fault.
            ActSpec::Select { .. } | ActSpec::Scroll { .. } => Err("tap-did-not-act".to_string()),
        }
    }
}

// ── screenshot ───────────────────────────────────────────────────────────────

/// How to take one screenshot (pure; see [`snapshot_plan`]).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SnapshotPlan {
    /// The rectangle captured, in view points (top-left origin).
    pub rect: Bounds,
    /// Whether a clip was asked for (then `rect` goes to
    /// `WKSnapshotConfiguration.rect`; otherwise the whole view is taken).
    pub clipped: bool,
    /// `WKSnapshotConfiguration.snapshotWidth`, in points. WebKit renders at
    /// the window's backing scale, so the image is `width_pts × backing` px.
    pub width_pts: f64,
    /// `rect` in CSS px of the page's viewport.
    pub css: Bounds,
}

/// Size a screenshot so its OUTPUT PIXELS fit 1280×800.
///
/// `view_w`/`view_h`: the webview's size in points; `vw_css`: the page's
/// `innerWidth` in CSS px (so `view_w / vw_css` folds in the page zoom);
/// `clip`: CSS px within the viewport, intersected with it; `backing`: the
/// window's backing scale factor (1 when unknown). `None` for a degenerate
/// view or an empty intersection.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn snapshot_plan(
    view_w: f64,
    view_h: f64,
    vw_css: f64,
    clip: Option<Bounds>,
    backing: f64,
) -> Option<SnapshotPlan> {
    if ![view_w, view_h, vw_css].iter().all(|v| v.is_finite())
        || view_w <= 0.0
        || view_h <= 0.0
        || vw_css <= 0.0
    {
        return None;
    }
    let backing = if backing.is_finite() && backing > 0.0 {
        backing
    } else {
        1.0
    };
    let ratio = view_w / vw_css;
    if !ratio.is_finite() || ratio <= 0.0 {
        return None;
    }
    let rect = match clip {
        Some(c) => {
            if ![c.x, c.y, c.width, c.height].iter().all(|v| v.is_finite()) {
                return None;
            }
            let x0 = (c.x * ratio).max(0.0);
            let y0 = (c.y * ratio).max(0.0);
            let x1 = ((c.x + c.width) * ratio).min(view_w);
            let y1 = ((c.y + c.height) * ratio).min(view_h);
            Bounds {
                x: x0,
                y: y0,
                width: x1 - x0,
                height: y1 - y0,
            }
        }
        None => Bounds {
            x: 0.0,
            y: 0.0,
            width: view_w,
            height: view_h,
        },
    };
    if !(rect.width > 0.0 && rect.height > 0.0) {
        return None;
    }
    let width_pts = rect
        .width
        .min(SNAPSHOT_MAX_PX_WIDTH / backing)
        .min(SNAPSHOT_MAX_PX_HEIGHT / backing * rect.width / rect.height);
    if !(width_pts.is_finite() && width_pts > 0.0) {
        return None;
    }
    Some(SnapshotPlan {
        rect,
        clipped: clip.is_some(),
        width_pts,
        css: Bounds {
            x: rect.x / ratio,
            y: rect.y / ratio,
            width: rect.width / ratio,
            height: rect.height / ratio,
        },
    })
}

/// The screenshot answer: the image, its ACTUAL pixel size, and how its
/// pixels map back onto the page — `scale` = CSS px per image px, `origin` =
/// the captured rectangle's top-left in CSS px, `css` = its size in CSS px.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn screenshot_reply(
    mime: &str,
    base64: String,
    width_px: isize,
    height_px: isize,
    plan: &SnapshotPlan,
) -> Value {
    let scale = if width_px > 0 {
        Value::from(plan.css.width / width_px as f64)
    } else {
        Value::Null
    };
    serde_json::json!({
        "mime": mime,
        "base64": base64,
        "width": width_px,
        "height": height_px,
        "scale": scale,
        "origin": { "x": plan.css.x, "y": plan.css.y },
        "css": { "width": plan.css.width, "height": plan.css.height },
    })
}

#[cfg(target_os = "macos")]
fn screenshot(window: WebviewWindow, clip: Option<Bounds>, reply: Reply) {
    reply.arm_timeout(SCREENSHOT_TIMEOUT);
    let worker = reply.clone();
    let spawned = thread::Builder::new()
        .name("ashlr-browser-shot".into())
        .spawn(move || {
            // The page's viewport width in CSS px maps view points to CSS px.
            // Without it (no tap on this page) a whole-view shot still works,
            // assuming no page zoom; a clip cannot be placed.
            let info = query_script(&QueryWhat::Info)
                .ok_or_else(|| "unsupported".to_string())
                .and_then(|script| eval_blocking(&window, script, QUERY_TIMEOUT));
            let vw = info
                .ok()
                .and_then(|i| i.get("vw").and_then(Value::as_f64))
                .filter(|v| v.is_finite() && *v > 0.0);
            if vw.is_none() && clip.is_some() {
                worker.send(Err("no-viewport".to_string()));
                return;
            }
            let on_image = worker.clone();
            let started = snapshot::take(&window, vw, clip, move |outcome| {
                on_image.send(outcome.map(|(shot, plan)| {
                    use base64::Engine;
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&shot.bytes);
                    screenshot_reply(shot.mime, encoded, shot.width, shot.height, &plan)
                }));
            });
            if let Err(e) = started {
                worker.send(Err(format!("snapshot-failed: {e}")));
            }
        });
    if spawned.is_err() {
        reply.send(Err("spawn-failed".to_string()));
    }
}

#[cfg(not(target_os = "macos"))]
fn screenshot(_window: WebviewWindow, _clip: Option<Bounds>, reply: Reply) {
    reply.send(Err("unsupported".to_string()));
}

/// `WKWebView takeSnapshotWithConfiguration:` → PNG (JPEG q0.8 above 4 MB).
#[cfg(target_os = "macos")]
mod snapshot {
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::{runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSImageCompressionFactor, NSWindow,
    };
    use objc2_foundation::{NSDictionary, NSError, NSNumber, NSPoint, NSRect, NSSize, NSString};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use tauri::WebviewWindow;

    use super::{snapshot_plan, Bounds, SnapshotPlan, SNAPSHOT_PNG_MAX_BYTES};

    pub struct Shot {
        pub mime: &'static str,
        pub bytes: Vec<u8>,
        pub width: isize,
        pub height: isize,
    }

    /// Start a snapshot; `done` runs once, on the main thread, with the image
    /// and the plan it was taken with, or the reason there is none. (If the
    /// window disappears first, `done` never runs and the caller's timeout
    /// answers.) `vw_css`: the page's `innerWidth`, or `None` to assume the
    /// view is 1:1 with CSS px.
    pub fn take(
        window: &WebviewWindow,
        vw_css: Option<f64>,
        clip: Option<Bounds>,
        done: impl FnOnce(Result<(Shot, SnapshotPlan), String>) + Send + 'static,
    ) -> tauri::Result<()> {
        let done = Mutex::new(Some(done));
        window.with_webview(move |platform| {
            let finish = move |outcome: Result<(Shot, SnapshotPlan), String>| {
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
            let ns_window = platform.ns_window() as *const NSWindow;
            // SAFETY: on macOS PlatformWebview::inner() is the live WKWebView
            // wry created for this window and ns_window() its live NSWindow;
            // with_webview runs on the main thread.
            let (Some(webview), ns_window) =
                (unsafe { pointer.as_ref() }, unsafe { ns_window.as_ref() })
            else {
                finish(Err("no-webview".to_string()));
                return;
            };
            let bounds = webview.bounds();
            let (view_w, view_h) = (bounds.size.width, bounds.size.height);
            let backing = ns_window.map_or(1.0, |w| w.backingScaleFactor());
            let Some(plan) = snapshot_plan(view_w, view_h, vw_css.unwrap_or(view_w), clip, backing)
            else {
                finish(Err(if clip.is_some() {
                    "empty-clip".to_string()
                } else {
                    "empty-view".to_string()
                }));
                return;
            };
            // SAFETY: plain property setters on a fresh configuration object.
            let config = unsafe { WKSnapshotConfiguration::new(mtm) };
            let width = NSNumber::new_f64(plan.width_pts);
            unsafe { config.setSnapshotWidth(Some(&width)) };
            if plan.clipped {
                let r = plan.rect;
                let rect = NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.width, r.height));
                // SAFETY: a rect inside the view's bounds (snapshot_plan
                // intersected it), in the view's own (flipped) coordinates.
                unsafe { config.setRect(rect) };
            }
            let block = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                // SAFETY: WebKit passes a valid NSImage or null.
                let outcome = match unsafe { image.as_ref() } {
                    Some(image) => encode(image).map(|shot| (shot, plan)),
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
                what: QueryWhat::PickPoll,
                approved: None,
            })
        );
    }

    #[test]
    fn actions_require_a_matching_approved_tab_origin_and_load() {
        let base = serde_json::json!({
            "op": "query", "tab": "t1", "req": "r1",
            "what": { "act": { "kind": "key", "key": "Enter" } },
        });
        let mut request = base.clone();
        assert!(parse(&request.to_string()).is_none());
        request["approved"] = serde_json::json!({
            "tab": "t1", "url": "http://localhost:3000/", "origin": "http://localhost:3000", "loadId": "L1",
        });
        assert!(parse(&request.to_string()).is_some());
        for (field, bad) in [
            ("tab", "t2"),
            ("origin", "https://localhost:3000"),
            ("loadId", "bad load"),
            ("url", "javascript:alert(1)"),
        ] {
            let mut changed = request.clone();
            changed["approved"][field] = serde_json::Value::String(bad.into());
            assert!(
                parse(&changed.to_string()).is_none(),
                "accepted changed {field}"
            );
        }
        let mut query = request.clone();
        query["what"] = serde_json::json!("info");
        assert!(
            parse(&query.to_string()).is_none(),
            "read queries must not carry an action approval"
        );
        request["what"] = serde_json::json!({ "evaluate": { "expression": "1" } });
        assert!(parse(&request.to_string()).is_some());
        request.as_object_mut().unwrap().remove("approved");
        assert!(parse(&request.to_string()).is_none());
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
            (QueryWhat::Resume, "t.resume()"),
        ] {
            let script = query_script(&what).unwrap();
            assert_eq!(
                script,
                format!("(function(){{try{{var t=window.__ashlrTap;return t?{call}:JSON.stringify({{error:'tap-missing'}})}}catch(e){{return JSON.stringify({{error:String(e&&e.message||e)}})}}}})()")
            );
        }
    }

    // ── new query forms ──────────────────────────────────────────────────────

    fn what(json: &str) -> Option<QueryWhat> {
        let approved = if json.contains("\"act\"") || json.contains("\"evaluate\"") {
            r#", "approved":{"tab":"t1","url":"http://localhost:3000/","origin":"http://localhost:3000","loadId":"L1"}"#
        } else {
            ""
        };
        match parse(&format!(
            r#"{{"op":"query","tab":"t1","req":"r1","what":{json}{approved}}}"#
        ))? {
            BrowserRequest::Query { what, .. } => Some(what),
            _ => None,
        }
    }

    /// The single JSON argument of a `t.<name>(<json>)` tap script, parsed
    /// back: proves the argument is exactly one JSON literal.
    fn tap_arg(script: &str, name: &str) -> Value {
        let open = format!("t.{name}(");
        let start = script.find(&open).expect("tap call") + open.len();
        let end = script
            .find("):JSON.stringify({error:'tap-missing'})")
            .expect("wrapper tail");
        serde_json::from_str(&script[start..end]).expect("one JSON literal")
    }

    #[test]
    fn every_new_query_form_parses() {
        use serde_json::json;
        assert_eq!(what(r#""resume""#), Some(QueryWhat::Resume));
        assert_eq!(
            what(r#"{"snapshot":{"max_nodes":300,"root_ref":"e12"}}"#),
            Some(QueryWhat::Snapshot(SnapshotArgs {
                max_nodes: Some(300),
                root_ref: Some("e12".into())
            }))
        );
        assert!(what(r#"{"snapshot":{}}"#).is_some());
        assert!(what(r#"{"network":{"limit":500}}"#).is_some());
        assert!(what(r#"{"network":{}}"#).is_some());
        assert!(what(r#"{"resolve":{"ref":"e1"}}"#).is_some());
        assert!(what(r#"{"resolve":{"x":0,"y":100000}}"#).is_some());
        assert!(what(r#"{"resolve":{"focused":true}}"#).is_some());
        assert!(what(r#"{"evaluate":{"expression":"document.title"}}"#).is_some());
        for act in [
            json!({"kind":"click","ref":"e1"}),
            json!({"kind":"click","x":10.5,"y":20,"button":"left","double":true,"modifiers":["Shift","Meta"],"expect":"ab12"}),
            json!({"kind":"click","ref":"e9999999","button":"right"}),
            json!({"kind":"type","ref":"e2","text":"hello é 👍","submit":true,"clear":true,"expect":"z"}),
            json!({"kind":"type","ref":"e2","text":"a\nb\tc"}),
            json!({"kind":"select","ref":"e3","values":["One",""]}),
            json!({"kind":"hover","ref":"e4"}),
            json!({"kind":"hover","x":1,"y":2,"expect":"s1"}),
            json!({"kind":"key","key":"Enter"}),
            json!({"kind":"key","key":"Meta+a"}),
            json!({"kind":"scroll","direction":"down"}),
            json!({"kind":"scroll","ref":"e5"}),
            json!({"kind":"scroll","ref":"e5","direction":"left","amount":20000}),
        ] {
            let json = format!(r#"{{"act":{act}}}"#);
            assert!(
                matches!(what(&json), Some(QueryWhat::Act(_))),
                "should parse: {json}"
            );
        }
        assert_eq!(
            what(r#"{"act":{"kind":"type","ref":"e2","text":"hi"}}"#),
            Some(QueryWhat::Act(ActSpec::Type {
                reference: "e2".into(),
                text: "hi".into(),
                submit: false,
                clear: false,
                expect: None
            }))
        );
        // Screenshot with and without a clip; the clip is sanitised.
        assert_eq!(
            parse(
                r#"{"op":"screenshot","tab":"t1","req":"r","clip":{"x":-5,"y":10,"width":0,"height":50}}"#
            ),
            Some(BrowserRequest::Screenshot {
                tab: "t1".into(),
                req: "r".into(),
                clip: Some(Bounds {
                    x: 0.0,
                    y: 10.0,
                    width: 1.0,
                    height: 50.0
                })
            })
        );
        assert!(parse(r#"{"op":"screenshot","tab":"t1","req":"r"}"#).is_some());
    }

    #[test]
    fn malformed_new_query_forms_are_rejected() {
        let long_text = "a".repeat(TYPE_TEXT_MAX_CHARS + 1);
        let long_value = "v".repeat(SELECT_VALUE_MAX_CHARS + 1);
        let many_values = serde_json::to_string(&vec!["v"; SELECT_MAX_VALUES + 1]).unwrap();
        let long_expr = "1".repeat(EVALUATE_MAX_CHARS + 1);
        let cases = [
            // bare strings for forms that need an object, and vice versa
            r#""snapshot""#.to_string(),
            r#""act""#.to_string(),
            r#""evaluate""#.to_string(),
            r#"{"resume":{}}"#.to_string(),
            r#"{"text":null}"#.to_string(),
            r#"{"info":{}}"#.to_string(),
            // two keys in one externally tagged value
            r#"{"snapshot":{},"network":{}}"#.to_string(),
            // unknown fields
            r#"{"snapshot":{"max_nodes":5,"depth":2}}"#.to_string(),
            r#"{"network":{"limit":5,"all":true}}"#.to_string(),
            r#"{"resolve":{"ref":"e1","why":1}}"#.to_string(),
            r#"{"evaluate":{"expression":"1","await":true}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":"e1","bogus":1}}"#.to_string(),
            r#"{"act":{"kind":"type","ref":"e1","text":"x","js":"alert(1)"}}"#.to_string(),
            r#"{"act":{"kind":"key","key":"Enter","ref":"e1"}}"#.to_string(),
            r#"{"act":{"kind":"select","ref":"e1","values":["a"],"text":"x"}}"#.to_string(),
            // unknown kinds / missing kind
            r#"{"act":{"kind":"submit","ref":"e1"}}"#.to_string(),
            r#"{"act":{"kind":"Click","ref":"e1"}}"#.to_string(),
            r#"{"act":{"ref":"e1"}}"#.to_string(),
            // bad refs
            r#"{"act":{"kind":"click","ref":"e0"}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":"e01"}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":"e12345678"}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":"E1"}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":"e1'"}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":""}}"#.to_string(),
            r#"{"snapshot":{"root_ref":"x1"}}"#.to_string(),
            r#"{"resolve":{"ref":"e-1"}}"#.to_string(),
            // bad sigs
            r#"{"act":{"kind":"click","ref":"e1","expect":"AB"}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":"e1","expect":""}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":"e1","expect":"abcdefghijklmnopq"}}"#.to_string(),
            // both / neither targets
            r#"{"act":{"kind":"click","ref":"e1","x":1,"y":2}}"#.to_string(),
            r#"{"act":{"kind":"click"}}"#.to_string(),
            r#"{"act":{"kind":"click","x":1}}"#.to_string(),
            r#"{"act":{"kind":"hover","y":1}}"#.to_string(),
            r#"{"act":{"kind":"hover","ref":"e1","x":1,"y":1}}"#.to_string(),
            r#"{"resolve":{}}"#.to_string(),
            r#"{"resolve":{"ref":"e1","focused":true}}"#.to_string(),
            r#"{"resolve":{"x":1,"y":1,"focused":true}}"#.to_string(),
            r#"{"resolve":{"focused":false}}"#.to_string(),
            r#"{"act":{"kind":"click","focused":true}}"#.to_string(),
            r#"{"act":{"kind":"scroll"}}"#.to_string(),
            r#"{"act":{"kind":"scroll","amount":5}}"#.to_string(),
            // text / values / expression sizes and content
            format!(r#"{{"act":{{"kind":"type","ref":"e1","text":"{long_text}"}}}}"#),
            r#"{"act":{"kind":"type","ref":"e1","text":""}}"#.to_string(),
            r#"{"act":{"kind":"type","ref":"e1","text":"a\rb"}}"#.to_string(),
            r#"{"act":{"kind":"type","ref":"e1","text":"\u007f"}}"#.to_string(),
            r#"{"act":{"kind":"type","ref":"e1","text":""}}"#.to_string(),
            r#"{"act":{"kind":"type","text":"x"}}"#.to_string(),
            format!(r#"{{"act":{{"kind":"select","ref":"e1","values":["{long_value}"]}}}}"#),
            format!(r#"{{"act":{{"kind":"select","ref":"e1","values":{many_values}}}}}"#),
            r#"{"act":{"kind":"select","ref":"e1","values":[]}}"#.to_string(),
            r#"{"act":{"kind":"select","ref":"e1","values":[1]}}"#.to_string(),
            r#"{"evaluate":{"expression":""}}"#.to_string(),
            format!(r#"{{"evaluate":{{"expression":"{long_expr}"}}}}"#),
            // modifiers
            r#"{"act":{"kind":"click","ref":"e1","modifiers":["Shift","Shift"]}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":"e1","modifiers":["Cmd"]}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":"e1","modifiers":"Shift"}}"#.to_string(),
            r#"{"act":{"kind":"click","ref":"e1","button":"middle"}}"#.to_string(),
            // keys outside the table
            r#"{"act":{"kind":"key","key":"Meta+v"}}"#.to_string(),
            r#"{"act":{"kind":"key","key":"Meta+q"}}"#.to_string(),
            r#"{"act":{"kind":"key","key":"F12"}}"#.to_string(),
            // numbers: out of range, wrong type, non-finite literals
            r#"{"snapshot":{"max_nodes":0}}"#.to_string(),
            r#"{"snapshot":{"max_nodes":2001}}"#.to_string(),
            r#"{"snapshot":{"max_nodes":-1}}"#.to_string(),
            r#"{"snapshot":{"max_nodes":1.5}}"#.to_string(),
            r#"{"network":{"limit":0}}"#.to_string(),
            r#"{"network":{"limit":501}}"#.to_string(),
            r#"{"resolve":{"x":-1,"y":0}}"#.to_string(),
            r#"{"resolve":{"x":100001,"y":0}}"#.to_string(),
            r#"{"resolve":{"x":1e400,"y":0}}"#.to_string(),
            r#"{"resolve":{"x":"1","y":0}}"#.to_string(),
            r#"{"resolve":{"x":NaN,"y":0}}"#.to_string(),
            r#"{"act":{"kind":"scroll","direction":"down","amount":0}}"#.to_string(),
            r#"{"act":{"kind":"scroll","direction":"down","amount":20001}}"#.to_string(),
            r#"{"act":{"kind":"scroll","direction":"sideways"}}"#.to_string(),
        ];
        for case in &cases {
            assert_eq!(what(case), None, "should reject: {case}");
        }
        // A screenshot clip with a non-finite or wrongly typed number.
        assert_eq!(
            parse(
                r#"{"op":"screenshot","tab":"t1","req":"r","clip":{"x":1e400,"y":0,"width":1,"height":1}}"#
            ),
            None
        );
        assert_eq!(
            parse(r#"{"op":"screenshot","tab":"t1","req":"r","clip":{"x":0,"y":0,"width":1}}"#),
            None
        );
    }

    #[test]
    fn refs_and_sigs_are_validated() {
        for ok in ["e1", "e9", "e10", "e1234567"] {
            assert!(valid_ref(ok), "{ok}");
        }
        for bad in [
            "",
            "e",
            "e0",
            "e01",
            "e12345678",
            "E1",
            "f1",
            "e1a",
            "e 1",
            "1",
        ] {
            assert!(!valid_ref(bad), "{bad}");
        }
        assert!(valid_sig("a1b2"));
        assert!(!valid_sig("A"));
        assert!(!valid_sig(""));
    }

    #[test]
    fn data_query_scripts_carry_exactly_one_json_argument() {
        let wrap = |call: &str| {
            format!("(function(){{try{{var t=window.__ashlrTap;return t?t.{call}:JSON.stringify({{error:'tap-missing'}})}}catch(e){{return JSON.stringify({{error:String(e&&e.message||e)}})}}}})()")
        };
        let q = |json: &str| query_script(&what(json).unwrap()).unwrap();
        assert_eq!(
            q(r#"{"snapshot":{"max_nodes":300,"root_ref":"e12"}}"#),
            wrap(r#"snapshot({"maxNodes":300,"rootRef":"e12"})"#)
        );
        assert_eq!(q(r#"{"snapshot":{}}"#), wrap("snapshot({})"));
        assert_eq!(
            q(r#"{"network":{"limit":50}}"#),
            wrap(r#"network({"limit":50})"#)
        );
        assert_eq!(q(r#"{"network":{}}"#), wrap("network({})"));
        assert_eq!(
            q(r#"{"resolve":{"ref":"e7"}}"#),
            wrap(r#"resolve({"ref":"e7"})"#)
        );
        assert_eq!(
            q(r#"{"resolve":{"x":10,"y":20.5}}"#),
            wrap(r#"resolve({"x":10.0,"y":20.5})"#)
        );
        assert_eq!(
            q(r#"{"resolve":{"focused":true}}"#),
            wrap(r#"resolve({"focused":true})"#)
        );
        assert_eq!(q(r#""resume""#), wrap("resume()"));
        // act and evaluate are not plain tap calls.
        assert_eq!(
            query_script(&what(r#"{"act":{"kind":"key","key":"a"}}"#).unwrap()),
            None
        );
        assert_eq!(
            query_script(&what(r#"{"evaluate":{"expression":"1"}}"#).unwrap()),
            None
        );
    }

    #[test]
    fn hostile_strings_stay_inside_one_json_literal() {
        let hostile = "\"})alert(1)//\u{2028}</script>\u{2029}'";
        let spec = ActSpec::Select {
            reference: "e3".into(),
            values: vec![hostile.to_string(), "ok".into()],
            expect: None,
        };
        let script = tap_call("prepare", &prepare_args(&spec));
        assert!(!script.contains('\u{2028}') && !script.contains('\u{2029}'));
        assert!(script.contains("\\u2028") && script.contains("\\u2029"));
        let arg = tap_arg(&script, "prepare");
        assert_eq!(arg["values"][0], hostile);
        assert_eq!(arg["values"][1], "ok");
        assert_eq!(arg["kind"], "select");
        // Exactly one tap call, and the wrapper's tail is intact.
        assert_eq!(script.matches("t.prepare(").count(), 1);
        assert!(script
            .ends_with("catch(e){return JSON.stringify({error:String(e&&e.message||e)})}})()"));
        // The same holds for any JSON argument the query forms build.
        let s = js_json(&serde_json::json!({ "rootRef": hostile }));
        assert_eq!(
            serde_json::from_str::<Value>(&s).unwrap()["rootRef"],
            hostile
        );
        assert!(!s.contains('\u{2028}'));
    }

    #[test]
    fn prepare_never_carries_the_typed_text() {
        let secret = "correct horse battery staple\nline two";
        let spec = ActSpec::Type {
            reference: "e2".into(),
            text: secret.into(),
            submit: true,
            clear: true,
            expect: Some("sig1".into()),
        };
        let args = prepare_args(&spec);
        let rendered = tap_call("prepare", &args);
        for part in ["correct", "horse", "staple", "line two"] {
            assert!(
                !rendered.contains(part),
                "prepare leaked `{part}`: {rendered}"
            );
        }
        assert_eq!(
            args,
            serde_json::json!({
                "kind": "type", "ref": "e2", "expect": "sig1", "clear": true, "submit": true,
                "textLength": secret.chars().count(), "hasNewline": true,
                "ms": 1500 + 40 * secret.chars().count() as u64,
            })
        );
        assert!(!after_args(&spec).to_string().contains("horse"));
        assert_eq!(
            after_args(&spec),
            serde_json::json!({"kind":"type","ref":"e2"})
        );
    }

    #[test]
    fn prepare_args_carry_each_kind_faithfully() {
        use serde_json::json;
        let act = |j: &str| match what(&format!(r#"{{"act":{j}}}"#)).unwrap() {
            QueryWhat::Act(spec) => spec,
            _ => unreachable!(),
        };
        assert_eq!(
            prepare_args(&act(
                r#"{"kind":"click","x":5,"y":6,"button":"right","double":true,"modifiers":["Alt"],"expect":"k"}"#
            )),
            json!({"kind":"click","x":5.0,"y":6.0,"button":"right","double":true,"modifiers":["Alt"],"expect":"k","ms":1500})
        );
        assert_eq!(
            prepare_args(&act(r#"{"kind":"key","key":"Shift+Tab"}"#)),
            json!({"kind":"key","key":"Shift+Tab","ms":1500})
        );
        assert_eq!(
            prepare_args(&act(
                r#"{"kind":"scroll","ref":"e4","direction":"up","amount":300}"#
            )),
            json!({"kind":"scroll","ref":"e4","direction":"up","amount":300.0,"ms":1500})
        );
        assert_eq!(
            prepare_args(&act(r#"{"kind":"hover","ref":"e8","expect":"q"}"#)),
            json!({"kind":"hover","ref":"e8","expect":"q","ms":1500})
        );
        // The tap's "acting" window and the act's budget grow with the text.
        let long = act(&format!(
            r#"{{"kind":"type","ref":"e1","text":"{}"}}"#,
            "x".repeat(2000)
        ));
        assert_eq!(act_tap_ms(&long), 60_000);
        assert_eq!(
            act_budget(&long),
            Duration::from_secs(5) + Duration::from_millis(40_000)
        );
        assert_eq!(
            act_budget(&act(r#"{"kind":"key","key":"a"}"#)),
            Duration::from_secs(5)
        );
    }

    #[test]
    fn act_replies_merge_tap_answers_under_native_keys() {
        use serde_json::json;
        let spec = ActSpec::Click {
            reference: Some("e1".into()),
            x: None,
            y: None,
            button: None,
            double: false,
            modifiers: None,
            expect: None,
        };
        let reply = act_reply(
            &spec,
            json!({"x":12,"y":34,"vw":800,"vh":600,"url":"https://a.b/","native":"lie","kind":"lie"}),
            json!({"url":"https://a.b/next","focused":"e1"}),
            true,
        );
        assert_eq!(
            reply,
            json!({"x":12,"y":34,"vw":800,"vh":600,"url":"https://a.b/next","focused":"e1","kind":"click","native":true})
        );
        let done = act_reply(
            &ActSpec::Scroll {
                reference: None,
                direction: Some(ScrollDirection::Down),
                amount: None,
            },
            json!({"done":true,"sy":400}),
            json!({"url":"u"}),
            false,
        );
        assert_eq!(
            done,
            json!({"done":true,"sy":400,"url":"u","kind":"scroll","x":null,"y":null,"native":false})
        );
    }

    #[test]
    fn evaluate_wraps_the_expression_as_one_string_literal() {
        let hostile = "1})();alert(1);(function(){//\u{2028}\"'`${x}";
        let script = evaluate_script(
            hostile,
            &ApprovedPage {
                tab: "t1".into(),
                url: "http://127.0.0.1:3000/".into(),
                origin: "http://127.0.0.1:3000".into(),
                load_id: "L1".into(),
            },
        );
        assert!(!script.contains('\u{2028}'));
        let open = "(0,eval)(";
        let start = script.find(open).unwrap() + open.len();
        let end = script[start..].find(");if(r!==null").unwrap() + start;
        let literal: Value = serde_json::from_str(&script[start..end]).unwrap();
        assert_eq!(literal, Value::String(hostile.to_string()));
        // The origin is re-checked in the page before anything runs.
        assert!(script.contains(r#"location.origin!=="http://127.0.0.1:3000""#));
        assert!(script.contains(r#"location.href!=="http://127.0.0.1:3000/""#));
        assert!(script.contains(r#".loadId!=="L1""#));
        assert!(script.contains("type:'promise'"));
        assert!(script.contains(&format!("v.slice(0,{EVALUATE_VALUE_MAX_CHARS})")));
        assert!(script.ends_with("return S({error:m})}})()"));
    }

    #[test]
    fn evaluate_is_only_for_loopback_pages() {
        let o = |u: &str| loopback_origin(&Url::parse(u).unwrap(), ORIGIN);
        assert_eq!(
            o("http://127.0.0.1:3000/app"),
            Ok("http://127.0.0.1:3000".into())
        );
        assert_eq!(
            o("http://localhost:5173/"),
            Ok("http://localhost:5173".into())
        );
        assert_eq!(o("http://[::1]:8080/"), Ok("http://[::1]:8080".into()));
        for bad in [
            "https://example.com/",
            "http://10.0.0.5:3000/",
            "http://127.0.0.1:7777/verse/",
            "http://localhost:7777/",
            "file:///etc/passwd",
            "about:blank",
            "http://user:pw@127.0.0.1:3000/",
        ] {
            assert_eq!(o(bad), Err("not-loopback"), "{bad}");
        }
    }

    // ── screenshot sizing ────────────────────────────────────────────────────

    fn px(plan: &SnapshotPlan, backing: f64) -> (f64, f64) {
        let w = plan.width_pts * backing;
        (w, w * plan.rect.height / plan.rect.width)
    }

    #[test]
    fn snapshots_fit_1280_by_800_pixels() {
        let eps = 1e-9;
        // Retina 2×, a 1000×700 pt view at 100 % zoom: height-bound.
        let p = snapshot_plan(1000.0, 700.0, 1000.0, None, 2.0).unwrap();
        let (w, h) = px(&p, 2.0);
        assert!((h - 800.0).abs() < eps && w <= 1280.0 + eps, "{w}x{h}");
        assert!(!p.clipped);
        assert_eq!(
            p.css,
            Bounds {
                x: 0.0,
                y: 0.0,
                width: 1000.0,
                height: 700.0
            }
        );
        // A wide, short view at 1×: width-bound.
        let p = snapshot_plan(2000.0, 400.0, 2000.0, None, 1.0).unwrap();
        assert!((p.width_pts - 1280.0).abs() < eps);
        let (_, h) = px(&p, 1.0);
        assert!(h <= 800.0 + eps);
        // A tall, narrow view: height-bound.
        let p = snapshot_plan(400.0, 3000.0, 400.0, None, 2.0).unwrap();
        let (w, h) = px(&p, 2.0);
        assert!((h - 800.0).abs() < eps && w < 1280.0, "{w}x{h}");
        // A small view is never upscaled.
        let p = snapshot_plan(300.0, 200.0, 300.0, None, 2.0).unwrap();
        assert_eq!(p.width_pts, 300.0);
        // The cap holds over a sweep of shapes, scales and zooms.
        for (vw, vh, css, b) in [
            (1440.0, 900.0, 1440.0, 2.0),
            (1440.0, 900.0, 720.0, 3.0),
            (5000.0, 10.0, 5000.0, 1.0),
            (10.0, 5000.0, 10.0, 1.5),
            (1280.0, 800.0, 1280.0, 1.0),
        ] {
            let p = snapshot_plan(vw, vh, css, None, b).unwrap();
            let (w, h) = px(&p, b);
            assert!(
                w <= 1280.0 + 1e-6 && h <= 800.0 + 1e-6,
                "{vw}x{vh}@{b}: {w}x{h}"
            );
        }
    }

    #[test]
    fn snapshot_clips_map_css_px_to_view_points() {
        // Page zoomed 200 %: innerWidth 500 CSS px in a 1000 pt view.
        let clip = Bounds {
            x: 100.0,
            y: 50.0,
            width: 200.0,
            height: 100.0,
        };
        let p = snapshot_plan(1000.0, 800.0, 500.0, Some(clip), 2.0).unwrap();
        assert!(p.clipped);
        assert_eq!(
            p.rect,
            Bounds {
                x: 200.0,
                y: 100.0,
                width: 400.0,
                height: 200.0
            }
        );
        assert_eq!(p.css, clip);
        // 400 pt at 2× would be 800 px wide: under both caps, so unscaled.
        assert_eq!(p.width_pts, 400.0);
        // A clip overrunning the view is intersected with it.
        let over = Bounds {
            x: 400.0,
            y: 300.0,
            width: 900.0,
            height: 900.0,
        };
        let p = snapshot_plan(1000.0, 800.0, 1000.0, Some(over), 1.0).unwrap();
        assert_eq!(
            p.rect,
            Bounds {
                x: 400.0,
                y: 300.0,
                width: 600.0,
                height: 500.0
            }
        );
        assert_eq!(p.css.width, 600.0);
        // Entirely outside, or degenerate inputs → no plan.
        let outside = Bounds {
            x: 2000.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        assert_eq!(
            snapshot_plan(1000.0, 800.0, 1000.0, Some(outside), 1.0),
            None
        );
        for (w, h, vw) in [
            (0.0, 800.0, 1000.0),
            (1000.0, -1.0, 1000.0),
            (1000.0, 800.0, 0.0),
            (f64::NAN, 800.0, 1000.0),
            (1000.0, f64::INFINITY, 1000.0),
            (1000.0, 800.0, 1e-320),
        ] {
            assert_eq!(snapshot_plan(w, h, vw, None, 2.0), None, "{w}x{h} vw={vw}");
        }
        // An unknown backing scale counts as 1×.
        let p = snapshot_plan(2000.0, 400.0, 2000.0, None, f64::NAN).unwrap();
        assert_eq!(p.width_pts, 1280.0);
    }

    #[test]
    fn screenshot_replies_report_actual_pixels_and_the_mapping() {
        let clip = Bounds {
            x: 100.0,
            y: 50.0,
            width: 200.0,
            height: 100.0,
        };
        let plan = snapshot_plan(1000.0, 800.0, 500.0, Some(clip), 2.0).unwrap();
        let reply = screenshot_reply("image/png", "QUJD".into(), 800, 400, &plan);
        assert_eq!(
            reply,
            serde_json::json!({
                "mime": "image/png", "base64": "QUJD", "width": 800, "height": 400,
                "scale": 0.25, "origin": {"x": 100.0, "y": 50.0},
                "css": {"width": 200.0, "height": 100.0},
            })
        );
        assert_eq!(
            screenshot_reply("image/png", String::new(), 0, 0, &plan)["scale"],
            Value::Null
        );
    }

    #[test]
    fn the_operator_event_has_its_shape() {
        assert_eq!(
            serde_json::to_value(BrowserEvent::operator("t1")).unwrap(),
            serde_json::json!({"kind":"operator","tab":"t1"})
        );
        let script = event_script(&BrowserEvent::operator("t1"));
        assert!(script.contains(r#"__ASHLR_BROWSER_EVENT__({"kind":"operator","tab":"t1"})"#));
    }

    // ── the tap ──────────────────────────────────────────────────────────────

    #[test]
    fn the_tap_prepares_input_but_never_submits_evaluates_or_leaks_secrets() {
        // Native synthesises the agent's clicks and keys; the tap never calls
        // an element's click / submit, never evaluates a string.
        for forbidden in [
            ".submit(",
            ".click(",
            "requestSubmit",
            "eval(",
            "new Function",
            "document.cookie",
            "localStorage",
            "sessionStorage",
        ] {
            assert!(
                !TAP_JS.contains(forbidden),
                "browser_tap.js must not contain `{forbidden}`"
            );
        }
        // A field's content is read in exactly one place, after the
        // sensitive-field check has had its say.
        assert_eq!(
            TAP_JS.matches(".value").count(),
            1,
            "browser_tap.js may read a field's content only in fieldValue"
        );
        let field_value = TAP_JS.find("function fieldValue(el)").expect("fieldValue");
        let redacted = TAP_JS[field_value..]
            .find("if (sensitive(el)) return '[redacted]'")
            .expect("fieldValue checks sensitive first");
        let read = TAP_JS[field_value..]
            .find("var v = el.value")
            .expect("the one read");
        assert!(
            redacted < read,
            "the sensitive check must come before the read"
        );
        // Exactly three event dispatches: a <select>'s input + change (a
        // native popup would block the app) and a right click's contextmenu
        // (so would a native context menu).
        assert_eq!(TAP_JS.matches("dispatchEvent(").count(), 3);
        assert!(TAP_JS.contains("el.dispatchEvent(new window.Event('input', { bubbles: true }))"));
        assert!(TAP_JS.contains("el.dispatchEvent(new window.Event('change', { bubbles: true }))"));
        assert!(TAP_JS.contains("el.dispatchEvent(new window.MouseEvent('contextmenu'"));
        // Typing into a secret field is refused here too, and a changed
        // element (its signature) is refused rather than acted on.
        for needle in [
            "if (sensitive(el)) return fail('sensitive-field')",
            "return fail('changed')",
            "return fail('file-input')",
            "return fail('use-select')",
            "return { error: 'obscured' }",
            "if (el.tagName === 'INPUT' && inputType(el) === 'password') return true",
            "attr(el, 'aria-hidden') === 'true'",
            "data-ashlr-ring",
        ] {
            assert!(TAP_JS.contains(needle), "browser_tap.js lost `{needle}`");
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
            "network:",
            "snapshot:",
            "resolve:",
            "prepare:",
            "clear:",
            "after:",
            "resume:",
            "pickStart:",
            "pickPoll:",
            "pickCancel:",
        ] {
            assert!(TAP_JS.contains(api), "browser_tap.js lost `{api}`");
        }
        // Buffer sizes the protocol promises.
        assert!(TAP_JS.contains("CONSOLE_MAX = 200"));
        assert!(TAP_JS.contains("NETWORK_MAX = 100"));
        assert!(TAP_JS.contains("REQUEST_MAX = 300"));
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

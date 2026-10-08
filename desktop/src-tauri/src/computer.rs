//! Desktop control ("computer use") for Verse's agents — the native half
//! (shell contract item 8, protocol v1).
//!
//! The contract every party shares lives in `src/core/verse/computer-types.ts`:
//! a chat seat calls a `computer_*` tool, the sidecar gates it against the
//! chat's grants and queues a command, the Verse window long-polls that queue
//! and hands native ops to this module over ONE event, `shell-computer`
//! (`__ASHLR_DESKTOP__.computer.send`). Native answers through
//! `window.__ASHLR_COMPUTER_EVENT__` (see `shell_contract.js`).
//!
//! # Security posture
//!
//! Any script on the Verse page can emit `shell-computer`, so NATIVE IS THE
//! ENFORCEMENT POINT for everything that keeps the operator safe. Nothing the
//! page says is trusted beyond what it can only narrow:
//!
//! - **Grants only narrow.** Each command carries the chat's grant list (the
//!   sidecar holds grants per chat, in memory). Native clamps every grant to the
//!   app's ceiling ([`app_policy`]) and never widens it: browsers are `read`,
//!   terminals / IDEs `click`, everything else at most `full`.
//! - **Hard denylist** ([`DENIED_BUNDLES`], [`DENIED_EXECUTABLE_PREFIXES`]):
//!   password managers, Keychain Access / Passwords, the macOS authentication
//!   prompts, the Ashlr custody helper and Ashlr itself are never captured or
//!   driven, whatever the grant says. An app with no bundle identifier is denied
//!   (fail closed). Our own process is refused by pid as well.
//! - **The app is resolved natively.** A click targets whatever app is under
//!   the point *now* (accessibility hit test → pid → bundle + executable path),
//!   not what the page claims; typing and keys target the frontmost app.
//! - **Secure text fields.** Native never reads the value of an
//!   `AXSecureTextField`, refuses `type` into one (or while any app holds
//!   secure event input), and allows only Tab / Shift+Tab / Escape there.
//! - **System Settings' privacy panes** ([`DENIED_SETTINGS_TITLES`]) are
//!   checked per action, since the pane is a window of an otherwise grantable
//!   app; an unreadable title counts as denied.
//! - **Takeover and the kill switch** ([`Takeover`]): hardware input newer than
//!   our own last synthetic event (plus a grace window) pauses control until the
//!   operator presses Resume in Verse; Esc (a global shortcut registered only
//!   while the HUD shows) or the page's `kill` stops it until `arm`.
//! - **HUD visibility.** While an agent is acting, an always-on-top orange
//!   border and a pill ("Agent controlling <App> — Esc to stop") show on every
//!   screen. The HUD ignores the mouse, never takes focus and is excluded from
//!   screen sharing.
//! - **Verse window present** is an invariant: acting ops need the Verse window
//!   visible, and hiding / reloading it pauses active control.
//! - **Captures contain only granted apps.** ScreenCaptureKit is given a filter
//!   that includes only the effective-granted apps' windows, so neither denied
//!   apps nor the HUD nor Verse itself ever appear in an image.
//!
//! No new Tauri command or capability exists for this: the page only emits an
//! event over the permission it already has (`core:event:allow-emit`, see
//! `capabilities/verse-remote.json`).
//!
//! Requests are handled in order on ONE worker thread; screenshots finish on
//! ScreenCaptureKit callbacks, raced against a timeout. `resume` / `kill` /
//! `arm` bypass the queue so a stop is never stuck behind a capture. A monitor
//! thread watches for operator input while control is active.

// Off macOS every op answers `unsupported`, so the policy / geometry / input
// helpers the macOS half uses are compiled (and unit-tested) but unused there.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, Shortcut, ShortcutState};

use crate::browser_pane::truncate_chars;

/// Event the page emits (`__ASHLR_DESKTOP__.computer.send`).
pub const COMPUTER_EVENT: &str = "shell-computer";

/// The page caps a message at 16 KB of JSON; native allows headroom for
/// multi-byte characters and drops anything bigger unparsed.
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_TEXT_CHARS: usize = 2000;
pub const MAX_KEYS_CHARS: usize = 64;
pub const MAX_GRANTS: usize = 64;
pub const MAX_APP_CHARS: usize = 200;
pub const MAX_MODIFIERS: usize = 5;
pub const MAX_SCROLL: i64 = 50;
pub const MAX_DEPTH: u8 = 12;
pub const MAX_DISPLAY_INDEX: u32 = 31;
/// `ax-tree` stops after this many nodes (`truncated: true`).
pub const MAX_NODES: usize = 500;
/// Every string read off the screen is cut to this many characters.
pub const STRING_MAX_CHARS: usize = 200;
/// `type` posts text in chunks of at most this many UTF-16 units.
pub const TYPE_CHUNK_UNITS: usize = 20;
/// Hardware input this long after our own last synthetic event is the operator.
pub const GRACE: Duration = Duration::from_millis(350);
/// Active control with no action for this long goes idle (HUD hidden).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10);
/// The takeover monitor's polling interval while control is active.
pub const MONITOR_INTERVAL: Duration = Duration::from_millis(100);
/// An active control request must see the HUD on the main thread before it may post input.
pub const HUD_ACK_TIMEOUT: Duration = Duration::from_secs(2);
/// An Esc shortcut event this soon after WE posted Escape is our own.
pub const OWN_ESCAPE_WINDOW: Duration = Duration::from_millis(400);
/// A screenshot / zoom with no image by then answers `timeout`.
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
/// Captures fit into this box (times the request's `scale`); never upscaled.
pub const FIT_MAX_WIDTH: f64 = 1280.0;
pub const FIT_MAX_HEIGHT: f64 = 800.0;
/// Error text sizes sent to the page.
const ERROR_MAX_CHARS: usize = 300;

pub const TOOK_OVER_MESSAGE: &str =
    "The operator took over. Wait for them to hand control back with Resume in Phantom.";
pub const STOPPED_MESSAGE: &str =
    "The operator stopped computer use. It stays off until they turn it back on in Phantom.";

/// The deep links `open-settings` may open (closed enum; mirrors
/// `COMPUTER_SETTINGS_URLS` in computer-types.ts).
pub const SETTINGS_URL_SCREEN: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
pub const SETTINGS_URL_ACCESSIBILITY: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

// ── app policy lists (MIRRORED from computer-types.ts) ───────────────────────
//
// test/verse-computer-315.test.ts parses these arrays (one string literal per
// line, same order) and fails when they drift from the TS lists. A `*` suffix
// is a prefix match; everything else is exact (case-insensitive). Keep comments
// OUT of the array bodies.

/// Never grantable, at any tier: Ashlr itself, Keychain / Passwords, the macOS
/// authentication prompts and password managers.
#[rustfmt::skip]
pub const DENIED_BUNDLES: &[&str] = &[
    "ai.ashlr.desktop",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.apple.SecurityAgent",
    "com.apple.LocalAuthentication*",
    "com.apple.CoreAuthentication*",
    "com.apple.coreautha*",
    "com.apple.UserNotificationCenter",
    "com.1password.*",
    "com.agilebits.*",
    "com.bitwarden.*",
    "com.lastpass.*",
    "com.dashlane.*",
    "com.callpod.keepermac*",
    "com.keepersecurity.*",
    "org.keepassxc.*",
    "com.keepassium.*",
    "in.sinew.Enpass*",
    "com.nordpass.*",
    "com.roboform.*",
    "com.proton.pass*",
    "me.proton.pass*",
    "com.sttz.KeePassXC*",
];

/// Browsers: `read` at most (agents use the web through the Verse Browser pane).
#[rustfmt::skip]
pub const BROWSER_BUNDLES: &[&str] = &[
    "com.apple.Safari",
    "com.apple.SafariTechnologyPreview",
    "com.google.Chrome*",
    "org.chromium.Chromium",
    "org.mozilla.firefox*",
    "org.mozilla.nightly",
    "com.microsoft.edgemac*",
    "company.thebrowser.Browser",
    "company.thebrowser.dia",
    "com.brave.Browser*",
    "com.operasoftware.Opera*",
    "com.vivaldi.Vivaldi*",
    "app.zen-browser.zen",
    "com.kagi.kagimacOS",
    "ai.perplexity.comet",
    "org.torproject.torbrowser",
];

/// Terminals and IDEs: `click` at most (typing there is shell access).
#[rustfmt::skip]
pub const TERMINAL_IDE_BUNDLES: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp*",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "io.alacritty",
    "com.github.wez.wezterm",
    "co.zeit.hyper",
    "com.mitchellh.ghostty",
    "com.microsoft.VSCode*",
    "com.visualstudio.code.oss",
    "com.vscodium*",
    "com.todesktop.230313mzl4w4u92",
    "com.exafunction.windsurf",
    "dev.zed.Zed*",
    "com.apple.dt.Xcode",
    "com.jetbrains.*",
    "com.google.android.studio*",
    "com.sublimetext.*",
    "com.panic.Nova",
    "com.barebones.bbedit",
    "org.vim.MacVim",
    "org.gnu.Emacs",
    "com.apple.ScriptEditor2",
    "com.apple.Automator",
    "com.apple.shortcuts",
];

/// Executables denied whatever their bundle says (the custody helper has none).
#[rustfmt::skip]
pub const DENIED_EXECUTABLE_PREFIXES: &[&str] = &[
    "/usr/local/libexec/ashlr-custody",
];

/// System Settings windows no agent may act in, by window title.
#[rustfmt::skip]
pub const DENIED_SETTINGS_TITLES: &[&str] = &[
    "Privacy & Security",
    "Privacy",
    "Security",
    "Passwords",
    "Touch ID & Password",
    "Users & Groups",
    "Login Items",
    "Login Items & Extensions",
];

#[rustfmt::skip]
pub const SYSTEM_SETTINGS_BUNDLES: &[&str] = &[
    "com.apple.systempreferences",
    "com.apple.Settings",
];

// ── wire types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Read,
    Click,
    Full,
}

impl Tier {
    pub fn name(self) -> &'static str {
        match self {
            Tier::Read => "read",
            Tier::Click => "click",
            Tier::Full => "full",
        }
    }
}

/// `{ bundleId, tier }` — one app the chat's operator approved.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    #[serde(rename = "bundleId")]
    pub bundle_id: String,
    pub tier: Tier,
}

/// How a screenshot maps onto the screen: global point = origin + px * scale.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Frame {
    pub display: u32,
    pub origin_x: f64,
    pub origin_y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionKind {
    Screen,
    Accessibility,
    PostEvents,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsKind {
    Screen,
    Accessibility,
}

impl SettingsKind {
    /// The one URL each kind opens.
    pub fn url(self) -> &'static str {
        match self {
            SettingsKind::Screen => SETTINGS_URL_SCREEN,
            SettingsKind::Accessibility => SETTINGS_URL_ACCESSIBILITY,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modifier {
    Cmd,
    Shift,
    Option,
    Ctrl,
    #[serde(rename = "fn")]
    Function,
}

impl Modifier {
    pub fn flag(self) -> u64 {
        match self {
            Modifier::Cmd => FLAG_COMMAND,
            Modifier::Shift => FLAG_SHIFT,
            Modifier::Option => FLAG_OPTION,
            Modifier::Ctrl => FLAG_CONTROL,
            Modifier::Function => FLAG_FN,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ProbeTarget {
    Point {
        x: f64,
        y: f64,
    },
    Ref {
        app: String,
        #[serde(rename = "ref")]
        element: String,
    },
    Focus {},
}

/// One `shell-computer` message. Parsed strictly: unknown ops and unknown
/// fields make the whole message invalid, because any script on the Verse page
/// can emit this event.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ComputerRequest {
    Permissions {
        req: String,
    },
    RequestPermission {
        req: String,
        kind: PermissionKind,
    },
    OpenSettings {
        kind: SettingsKind,
    },
    ListApps {
        req: String,
    },
    Screenshot {
        req: String,
        grants: Vec<Grant>,
        #[serde(default)]
        app: Option<String>,
        #[serde(default)]
        display: Option<u32>,
        #[serde(default)]
        scale: Option<f64>,
    },
    Zoom {
        req: String,
        grants: Vec<Grant>,
        frame: Frame,
        region: [f64; 4],
    },
    AxTree {
        req: String,
        grants: Vec<Grant>,
        app: String,
        #[serde(rename = "maxDepth")]
        max_depth: u8,
        #[serde(default)]
        frame: Option<Frame>,
    },
    Probe {
        req: String,
        grants: Vec<Grant>,
        #[serde(default)]
        frame: Option<Frame>,
        target: ProbeTarget,
    },
    AxPress {
        req: String,
        grants: Vec<Grant>,
        app: String,
        #[serde(rename = "ref")]
        element: String,
    },
    Click {
        req: String,
        grants: Vec<Grant>,
        frame: Frame,
        x: f64,
        y: f64,
        button: MouseButton,
        count: u8,
        modifiers: Vec<Modifier>,
    },
    Type {
        req: String,
        grants: Vec<Grant>,
        text: String,
    },
    Key {
        req: String,
        grants: Vec<Grant>,
        keys: String,
    },
    Scroll {
        req: String,
        grants: Vec<Grant>,
        frame: Frame,
        x: f64,
        y: f64,
        dx: i64,
        dy: i64,
    },
    Drag {
        req: String,
        grants: Vec<Grant>,
        frame: Frame,
        from: [f64; 2],
        to: [f64; 2],
    },
    Resume {},
    Kill {},
    Arm {},
}

impl ComputerRequest {
    /// The relay command id this request answers to, if it expects an answer.
    pub fn req(&self) -> Option<&str> {
        use ComputerRequest::*;
        match self {
            Permissions { req }
            | RequestPermission { req, .. }
            | ListApps { req }
            | Screenshot { req, .. }
            | Zoom { req, .. }
            | AxTree { req, .. }
            | Probe { req, .. }
            | AxPress { req, .. }
            | Click { req, .. }
            | Type { req, .. }
            | Key { req, .. }
            | Scroll { req, .. }
            | Drag { req, .. } => Some(req),
            OpenSettings { .. } | Resume {} | Kill {} | Arm {} => None,
        }
    }
}

// ── native → page ────────────────────────────────────────────────────────────

/// Why native refused or failed (`ComputerErrorCode` in computer-types.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    NoPermission,
    OperatorTookOver,
    Stopped,
    NotGranted,
    Tier,
    Denied,
    SecureField,
    OutOfBounds,
    NotFound,
    StaleRef,
    Unsupported,
    Invalid,
    Busy,
    Timeout,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: ErrorCode,
    pub message: String,
}

impl Failure {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub fn unsupported() -> Self {
        Self::new(
            ErrorCode::Unsupported,
            "Computer use needs the macOS desktop app.",
        )
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }

    pub fn from_refusal(refusal: Refusal) -> Self {
        match refusal {
            Refusal::TookOver => Self::new(ErrorCode::OperatorTookOver, TOOK_OVER_MESSAGE),
            Refusal::Stopped => Self::new(ErrorCode::Stopped, STOPPED_MESSAGE),
        }
    }
}

pub type OpResult = Result<Value, Failure>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StateName {
    Idle,
    Active,
    Paused,
    Killed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StateReason {
    OperatorInput,
    Escape,
    Kill,
    Resume,
    Idle,
}

/// What native tells the page (`detail` of the `ashlr:computer` event).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ComputerEvent {
    Result {
        req: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<ErrorCode>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    State {
        state: StateName,
        #[serde(skip_serializing_if = "Option::is_none")]
        app: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<StateReason>,
    },
}

impl ComputerEvent {
    pub fn result(req: &str, outcome: OpResult) -> Self {
        match outcome {
            Ok(data) => ComputerEvent::Result {
                req: req.to_string(),
                ok: true,
                data: Some(data),
                code: None,
                error: None,
            },
            Err(failure) => ComputerEvent::Result {
                req: req.to_string(),
                ok: false,
                data: None,
                code: Some(failure.code),
                error: Some(truncate_chars(&failure.message, ERROR_MAX_CHARS)),
            },
        }
    }

    pub fn state(transition: &Transition) -> Self {
        ComputerEvent::State {
            state: transition.state,
            app: transition
                .app
                .as_deref()
                .map(|a| truncate_chars(a, STRING_MAX_CHARS)),
            reason: transition.reason,
        }
    }
}

/// The script that delivers `event` to the Verse page. JSON-encoded, never
/// interpolated, so no window title or label an app chose can break out of the
/// literal; U+2028/U+2029 are escaped for older JavaScript engines.
pub fn event_script(event: &ComputerEvent) -> String {
    let json = serde_json::to_string(event)
        .unwrap_or_else(|_| "null".to_string())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        "if (typeof window.__ASHLR_COMPUTER_EVENT__ === 'function') window.__ASHLR_COMPUTER_EVENT__({json});"
    )
}

// ── parsing ──────────────────────────────────────────────────────────────────

/// `^[A-Za-z0-9_-]{1,40}$`.
pub fn valid_req(req: &str) -> bool {
    crate::browser_pane::valid_req(req)
}

/// `^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$`.
pub fn valid_bundle(bundle: &str) -> bool {
    let bytes = bundle.as_bytes();
    (1..=200).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'.' || *b == b'-')
}

/// An `app` parameter: a bundle id or an app name (no control characters).
fn valid_app_param(app: &str) -> bool {
    let len = app.chars().count();
    (1..=MAX_APP_CHARS).contains(&len) && !app.chars().any(char::is_control)
}

/// `e1`…`e9999` — refs handed out by `ax-tree`.
pub fn parse_ref(element: &str) -> Option<usize> {
    let digits = element.strip_prefix('e')?;
    if digits.is_empty() || digits.len() > 4 || digits.starts_with('0') {
        return None;
    }
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<usize>().ok().map(|n| n - 1)
}

fn valid_grants(grants: &[Grant]) -> bool {
    grants.len() <= MAX_GRANTS && grants.iter().all(|g| valid_bundle(&g.bundle_id))
}

impl Frame {
    /// Finite, positive, sane magnitudes.
    pub fn is_valid(&self) -> bool {
        let finite = [
            self.origin_x,
            self.origin_y,
            self.width,
            self.height,
            self.scale,
        ]
        .iter()
        .all(|v| v.is_finite());
        finite
            && self.display <= MAX_DISPLAY_INDEX
            && self.origin_x.abs() <= 1_000_000.0
            && self.origin_y.abs() <= 1_000_000.0
            && self.width > 0.0
            && self.width <= 100_000.0
            && self.height > 0.0
            && self.height <= 100_000.0
            && self.scale > 0.0
            && self.scale <= 100.0
    }

    /// Screenshot pixel → global screen point, or `None` outside the image.
    pub fn screen_point(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        if x < 0.0 || y < 0.0 || x > self.width || y > self.height {
            return None;
        }
        Some((
            self.origin_x + x * self.scale,
            self.origin_y + y * self.scale,
        ))
    }

    /// A global-points rectangle in screenshot pixels, or `None` when it does
    /// not intersect the image.
    pub fn rect_to_pixels(&self, rect: Rect) -> Option<Rect> {
        let px = Rect {
            x: (rect.x - self.origin_x) / self.scale,
            y: (rect.y - self.origin_y) / self.scale,
            w: rect.w / self.scale,
            h: rect.h / self.scale,
        };
        let image = Rect {
            x: 0.0,
            y: 0.0,
            w: self.width,
            h: self.height,
        };
        px.intersects(&image).then_some(px)
    }
}

/// Parse and validate a `shell-computer` payload. `Err(Some(req))` when the
/// message is invalid but carries a well-formed `req` (so the page hears
/// `invalid` instead of waiting for a timeout); `Err(None)` for anything else.
pub fn parse_request(payload: &str) -> Result<ComputerRequest, Option<String>> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(None);
    }
    let value: Value = serde_json::from_str(payload.trim()).map_err(|_| None)?;
    let Some(object) = value.as_object() else {
        return Err(None);
    };
    let req = object
        .get("req")
        .and_then(Value::as_str)
        .filter(|r| valid_req(r))
        .map(str::to_string);
    let request: ComputerRequest = serde_json::from_value(value).map_err(|_| req.clone())?;
    validate(request).ok_or(req)
}

fn validate(request: ComputerRequest) -> Option<ComputerRequest> {
    use ComputerRequest::*;
    if let Some(req) = request.req() {
        if !valid_req(req) {
            return None;
        }
    }
    let ok = match &request {
        Permissions { .. }
        | RequestPermission { .. }
        | OpenSettings { .. }
        | ListApps { .. }
        | Resume {}
        | Kill {}
        | Arm {} => true,
        Screenshot {
            grants,
            app,
            display,
            scale,
            ..
        } => {
            valid_grants(grants)
                && app.as_deref().map_or(true, valid_app_param)
                && display.map_or(true, |d| d <= MAX_DISPLAY_INDEX)
                && scale.map_or(true, |s| s.is_finite() && (0.25..=1.0).contains(&s))
        }
        Zoom {
            grants,
            frame,
            region,
            ..
        } => valid_grants(grants) && frame.is_valid() && region.iter().all(|v| v.is_finite()),
        AxTree {
            grants,
            app,
            max_depth,
            frame,
            ..
        } => {
            valid_grants(grants)
                && valid_app_param(app)
                && (1..=MAX_DEPTH).contains(max_depth)
                && frame.as_ref().map_or(true, Frame::is_valid)
        }
        Probe {
            grants,
            frame,
            target,
            ..
        } => {
            valid_grants(grants)
                && frame.as_ref().map_or(true, Frame::is_valid)
                && match target {
                    ProbeTarget::Point { x, y } => x.is_finite() && y.is_finite(),
                    ProbeTarget::Ref { app, element } => {
                        valid_app_param(app) && parse_ref(element).is_some()
                    }
                    ProbeTarget::Focus {} => true,
                }
        }
        AxPress {
            grants,
            app,
            element,
            ..
        } => valid_grants(grants) && valid_app_param(app) && parse_ref(element).is_some(),
        Click {
            grants,
            frame,
            x,
            y,
            count,
            modifiers,
            ..
        } => {
            valid_grants(grants)
                && frame.is_valid()
                && x.is_finite()
                && y.is_finite()
                && (1..=3).contains(count)
                && modifiers.len() <= MAX_MODIFIERS
        }
        Type { grants, text, .. } => {
            let len = text.chars().count();
            valid_grants(grants) && (1..=MAX_TEXT_CHARS).contains(&len)
        }
        Key { grants, keys, .. } => {
            let len = keys.chars().count();
            valid_grants(grants) && (1..=MAX_KEYS_CHARS).contains(&len)
        }
        Scroll {
            grants,
            frame,
            x,
            y,
            ..
        } => valid_grants(grants) && frame.is_valid() && x.is_finite() && y.is_finite(),
        Drag {
            grants,
            frame,
            from,
            to,
            ..
        } => {
            valid_grants(grants)
                && frame.is_valid()
                && from.iter().chain(to.iter()).all(|v| v.is_finite())
        }
    };
    if !ok {
        return None;
    }
    Some(match request {
        Scroll {
            req,
            grants,
            frame,
            x,
            y,
            dx,
            dy,
        } => Scroll {
            req,
            grants,
            frame,
            x,
            y,
            dx: dx.clamp(-MAX_SCROLL, MAX_SCROLL),
            dy: dy.clamp(-MAX_SCROLL, MAX_SCROLL),
        },
        Click {
            req,
            grants,
            frame,
            x,
            y,
            button,
            count,
            mut modifiers,
        } => {
            // Order-preserving de-duplication: `cmd, cmd` is `cmd`.
            let mut seen = Vec::with_capacity(modifiers.len());
            modifiers.retain(|m| {
                if seen.contains(m) {
                    false
                } else {
                    seen.push(*m);
                    true
                }
            });
            Click {
                req,
                grants,
                frame,
                x,
                y,
                button,
                count,
                modifiers,
            }
        }
        other => other,
    })
}

// ── app policy ───────────────────────────────────────────────────────────────

pub fn bundle_matches(pattern: &str, bundle: &str) -> bool {
    let p = pattern.to_ascii_lowercase();
    let b = bundle.to_ascii_lowercase();
    match p.strip_suffix('*') {
        Some(prefix) => b.starts_with(prefix),
        None => b == p,
    }
}

fn in_list(list: &[&str], bundle: &str) -> bool {
    list.iter().any(|pattern| bundle_matches(pattern, bundle))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Browser,
    TerminalIde,
    Denied,
    Other,
}

/// The highest tier an app can ever have (`None` when denied), and why.
/// Fails closed: no or malformed bundle identifier → denied.
pub fn app_policy(bundle: Option<&str>, executable: Option<&str>) -> (Option<Tier>, Category) {
    if let Some(path) = executable {
        if DENIED_EXECUTABLE_PREFIXES
            .iter()
            .any(|p| path.starts_with(p))
        {
            return (None, Category::Denied);
        }
    }
    let Some(bundle) = bundle.filter(|b| valid_bundle(b)) else {
        return (None, Category::Denied);
    };
    if in_list(DENIED_BUNDLES, bundle) {
        (None, Category::Denied)
    } else if in_list(BROWSER_BUNDLES, bundle) {
        (Some(Tier::Read), Category::Browser)
    } else if in_list(TERMINAL_IDE_BUNDLES, bundle) {
        (Some(Tier::Click), Category::TerminalIde)
    } else {
        (Some(Tier::Full), Category::Other)
    }
}

/// The tier an app actually has: the chat's grant clamped to the app's
/// ceiling. `None` when not granted or denied.
pub fn effective_tier(
    grants: &[Grant],
    bundle: Option<&str>,
    executable: Option<&str>,
) -> Option<Tier> {
    let (ceiling, _) = app_policy(bundle, executable);
    let ceiling = ceiling?;
    let bundle = bundle?;
    let granted = grants
        .iter()
        .filter(|g| g.bundle_id.eq_ignore_ascii_case(bundle))
        .map(|g| g.tier)
        .max()?;
    Some(granted.min(ceiling))
}

pub fn is_system_settings(bundle: &str) -> bool {
    in_list(SYSTEM_SETTINGS_BUNDLES, bundle)
}

/// True when a System Settings window title is one of the denied panes.
pub fn is_denied_settings_title(title: &str) -> bool {
    let t = title.trim().to_lowercase();
    if t.is_empty() {
        return false;
    }
    DENIED_SETTINGS_TITLES.iter().any(|denied| {
        let d = denied.to_lowercase();
        t == d || t.starts_with(&format!("{d} "))
    })
}

// ── actions and tiers ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Screenshot,
    Zoom,
    AxTree,
    AxPress,
    Click,
    RightClick,
    ModifierClick,
    Type,
    Key,
    Scroll,
    Drag,
}

impl Action {
    pub fn name(self) -> &'static str {
        match self {
            Action::Screenshot => "screenshot",
            Action::Zoom => "zoom",
            Action::AxTree => "ax-tree",
            Action::AxPress => "ax-press",
            Action::Click => "click",
            Action::RightClick => "right-click",
            Action::ModifierClick => "modifier-click",
            Action::Type => "type",
            Action::Key => "key",
            Action::Scroll => "scroll",
            Action::Drag => "drag",
        }
    }
}

/// The lowest tier that allows an action (mirrors `requiredTier`).
pub fn required_tier(action: Action) -> Tier {
    match action {
        Action::Screenshot | Action::Zoom | Action::AxTree => Tier::Read,
        Action::Click | Action::Scroll | Action::AxPress => Tier::Click,
        Action::RightClick | Action::ModifierClick | Action::Type | Action::Key | Action::Drag => {
            Tier::Full
        }
    }
}

pub fn tier_allows(tier: Tier, action: Action) -> bool {
    tier >= required_tier(action)
}

/// Which action a click is, by button and modifiers (mirrors `clickAction`).
pub fn click_action(button: MouseButton, modifiers: &[Modifier]) -> Action {
    if button != MouseButton::Left {
        Action::RightClick
    } else if modifiers.is_empty() {
        Action::Click
    } else {
        Action::ModifierClick
    }
}

/// Everything about an app native needs to authorize an action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIdent {
    pub pid: i32,
    pub bundle: Option<String>,
    pub name: String,
    pub executable: Option<String>,
}

impl AppIdent {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "bundleId": self.bundle,
            "name": truncate_chars(&self.name, STRING_MAX_CHARS),
            "pid": self.pid,
        })
    }
}

/// The policy decision for one action on one app (pure; the caller supplies
/// our own pid and, for System Settings, the relevant window titles —
/// `None` meaning "could not be read", which is denied).
pub fn authorize(
    grants: &[Grant],
    target: &AppIdent,
    own_pid: i32,
    action: Action,
    settings_titles: Option<&[String]>,
) -> Result<Tier, Failure> {
    if target.pid == own_pid {
        return Err(Failure::new(
            ErrorCode::Denied,
            "Agents may never control Phantom itself.",
        ));
    }
    let (ceiling, category) = app_policy(target.bundle.as_deref(), target.executable.as_deref());
    if ceiling.is_none() {
        let message = if target.bundle.is_none() {
            format!(
                "{} has no app identity, so it cannot be granted.",
                target.name
            )
        } else {
            format!(
                "{} is never available to agents (password managers, the keychain, system authentication prompts and Phantom itself are off limits).",
                target.name
            )
        };
        return Err(Failure::new(ErrorCode::Denied, message));
    }
    let Some(tier) = effective_tier(
        grants,
        target.bundle.as_deref(),
        target.executable.as_deref(),
    ) else {
        return Err(Failure::new(
            ErrorCode::NotGranted,
            format!(
                "{} is not granted to this chat. Ask the operator for access first.",
                target.name
            ),
        ));
    };
    if !tier_allows(tier, action) {
        let why = match category {
            Category::Browser => " (browsers are read-only: use the Phantom Browser pane)",
            Category::TerminalIde => " (terminals and editors are click-only)",
            _ => "",
        };
        return Err(Failure::new(
            ErrorCode::Tier,
            format!(
                "{} is granted {}{why}; {} needs {}.",
                target.name,
                tier.name(),
                action.name(),
                required_tier(action).name()
            ),
        ));
    }
    if target.bundle.as_deref().is_some_and(is_system_settings) {
        let denied = match settings_titles {
            None => true,
            Some(titles) => titles.iter().any(|t| is_denied_settings_title(t)),
        };
        if denied {
            return Err(Failure::new(
                ErrorCode::Denied,
                "System Settings' privacy, security, password and login panes are off limits to agents.",
            ));
        }
    }
    Ok(tier)
}

// ── secure fields ────────────────────────────────────────────────────────────

pub const SECURE_TEXT_FIELD: &str = "AXSecureTextField";

/// A secure (password) field, by accessibility role or subrole.
pub fn is_secure_element(role: Option<&str>, subrole: Option<&str>) -> bool {
    role == Some(SECURE_TEXT_FIELD) || subrole == Some(SECURE_TEXT_FIELD)
}

/// In a secure field only Tab, Shift+Tab and Escape are allowed.
pub fn key_allowed_in_secure_field(combo: &KeyCombo) -> bool {
    match combo.code {
        keycode::TAB => combo.flags == 0 || combo.flags == FLAG_SHIFT,
        keycode::ESCAPE => combo.flags == 0,
        _ => false,
    }
}

// ── keys ─────────────────────────────────────────────────────────────────────

/// `CGEventFlags` masks.
pub const FLAG_SHIFT: u64 = 0x0002_0000;
pub const FLAG_CONTROL: u64 = 0x0004_0000;
pub const FLAG_OPTION: u64 = 0x0008_0000;
pub const FLAG_COMMAND: u64 = 0x0010_0000;
pub const FLAG_FN: u64 = 0x0080_0000;

/// macOS virtual key codes (ANSI layout).
pub mod keycode {
    pub const RETURN: u16 = 36;
    pub const TAB: u16 = 48;
    pub const SPACE: u16 = 49;
    pub const DELETE: u16 = 51;
    pub const ESCAPE: u16 = 53;
    pub const FORWARD_DELETE: u16 = 117;
    pub const HOME: u16 = 115;
    pub const END: u16 = 119;
    pub const PAGE_UP: u16 = 116;
    pub const PAGE_DOWN: u16 = 121;
    pub const LEFT: u16 = 123;
    pub const RIGHT: u16 = 124;
    pub const DOWN: u16 = 125;
    pub const UP: u16 = 126;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyCombo {
    pub code: u16,
    pub flags: u64,
}

impl KeyCombo {
    pub fn is_escape(&self) -> bool {
        self.code == keycode::ESCAPE
    }
}

fn modifier_flag(token: &str) -> Option<u64> {
    Some(match token {
        "cmd" | "command" | "meta" | "super" | "⌘" => FLAG_COMMAND,
        "shift" | "⇧" => FLAG_SHIFT,
        "option" | "opt" | "alt" | "⌥" => FLAG_OPTION,
        "ctrl" | "control" | "⌃" => FLAG_CONTROL,
        "fn" => FLAG_FN,
        _ => return None,
    })
}

fn key_code(token: &str) -> Option<u16> {
    const LETTERS: [(char, u16); 26] = [
        ('a', 0),
        ('b', 11),
        ('c', 8),
        ('d', 2),
        ('e', 14),
        ('f', 3),
        ('g', 5),
        ('h', 4),
        ('i', 34),
        ('j', 38),
        ('k', 40),
        ('l', 37),
        ('m', 46),
        ('n', 45),
        ('o', 31),
        ('p', 35),
        ('q', 12),
        ('r', 15),
        ('s', 1),
        ('t', 17),
        ('u', 32),
        ('v', 9),
        ('w', 13),
        ('x', 7),
        ('y', 16),
        ('z', 6),
    ];
    const DIGITS: [u16; 10] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
    const PUNCTUATION: [(char, u16); 11] = [
        ('-', 27),
        ('=', 24),
        ('[', 33),
        (']', 30),
        ('\\', 42),
        (';', 41),
        ('\'', 39),
        (',', 43),
        ('.', 47),
        ('/', 44),
        ('`', 50),
    ];
    const F_KEYS: [u16; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];

    let mut chars = token.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if let Some((_, code)) = LETTERS.iter().find(|(l, _)| *l == c) {
            return Some(*code);
        }
        if let Some(d) = c.to_digit(10) {
            return Some(DIGITS[d as usize]);
        }
        if let Some((_, code)) = PUNCTUATION.iter().find(|(p, _)| *p == c) {
            return Some(*code);
        }
    }
    if let Some(n) = token
        .strip_prefix('f')
        .and_then(|n| n.parse::<usize>().ok())
    {
        if (1..=12).contains(&n) && !token[1..].starts_with('0') {
            return Some(F_KEYS[n - 1]);
        }
    }
    Some(match token {
        "return" | "enter" => keycode::RETURN,
        "tab" => keycode::TAB,
        "space" => keycode::SPACE,
        "delete" | "backspace" => keycode::DELETE,
        "forwarddelete" => keycode::FORWARD_DELETE,
        "escape" | "esc" => keycode::ESCAPE,
        "home" => keycode::HOME,
        "end" => keycode::END,
        "pageup" => keycode::PAGE_UP,
        "pagedown" => keycode::PAGE_DOWN,
        "left" => keycode::LEFT,
        "right" => keycode::RIGHT,
        "up" => keycode::UP,
        "down" => keycode::DOWN,
        "minus" => 27,
        "equal" | "equals" => 24,
        "comma" => 43,
        "period" => 47,
        "slash" => 44,
        "backslash" => 42,
        "semicolon" => 41,
        "quote" => 39,
        "grave" | "backtick" => 50,
        "bracketleft" => 33,
        "bracketright" => 30,
        _ => return None,
    })
}

/// `"cmd+shift+t"`, `"Return"`, `"Escape"`, `"F5"`, `"ctrl+-"` → key code and
/// flags. Exactly one non-modifier key, last; modifiers at most once each.
pub fn parse_key_combo(keys: &str) -> Option<KeyCombo> {
    let keys = keys.trim();
    if keys.is_empty() || keys.chars().count() > MAX_KEYS_CHARS {
        return None;
    }
    // A trailing "+" names the plus key itself ("cmd++" → cmd and "=" shifted
    // is not supported); treat "…++" as invalid rather than guessing.
    let tokens: Vec<String> = keys.split('+').map(|t| t.trim().to_lowercase()).collect();
    let (key, modifiers) = tokens.split_last()?;
    let mut flags = 0u64;
    for token in modifiers {
        let flag = modifier_flag(token)?;
        if flags & flag != 0 {
            return None;
        }
        flags |= flag;
    }
    let code = key_code(key)?;
    Some(KeyCombo { code, flags })
}

// ── geometry ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.x + other.w
            && other.x < self.x + self.w
            && self.y < other.y + other.h
            && other.y < self.y + self.h
    }

    pub fn contains_point(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }

    pub fn to_array(self) -> [i64; 4] {
        [
            self.x.round() as i64,
            self.y.round() as i64,
            self.w.round() as i64,
            self.h.round() as i64,
        ]
    }
}

/// Fit `w × h` into `max_w × max_h`, keeping the aspect ratio and never
/// upscaling. Always at least 1 × 1.
pub fn fit_size(w: f64, h: f64, max_w: f64, max_h: f64) -> (u32, u32) {
    if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) {
        return (1, 1);
    }
    let ratio = (max_w / w).min(max_h / h).min(1.0);
    let ratio = if ratio.is_finite() && ratio > 0.0 {
        ratio
    } else {
        1.0
    };
    let out_w = (w * ratio).floor().clamp(1.0, 100_000.0) as u32;
    let out_h = (h * ratio).floor().clamp(1.0, 100_000.0) as u32;
    (out_w, out_h)
}

/// A zoom region `[x0, y0, x1, y1]` in screenshot pixels → a global-points
/// rectangle. The region must be non-empty and inside the image.
pub fn region_screen_point(frame: &Frame, region: [f64; 4]) -> Option<Rect> {
    let [x0, y0, x1, y1] = region;
    if !(x0 < x1 && y0 < y1) {
        return None;
    }
    let (sx0, sy0) = frame.screen_point(x0, y0)?;
    let (sx1, sy1) = frame.screen_point(x1, y1)?;
    Some(Rect {
        x: sx0,
        y: sy0,
        w: sx1 - sx0,
        h: sy1 - sy0,
    })
}

/// A global-points rectangle → display-local points (ScreenCaptureKit's
/// `sourceRect`). `None` unless it lies inside the display (half-point slack
/// for rounding).
pub fn to_display_local(rect: Rect, display: Rect) -> Option<Rect> {
    const SLACK: f64 = 0.5;
    let local = Rect {
        x: rect.x - display.x,
        y: rect.y - display.y,
        w: rect.w,
        h: rect.h,
    };
    let inside = local.x >= -SLACK
        && local.y >= -SLACK
        && local.x + local.w <= display.w + SLACK
        && local.y + local.h <= display.h + SLACK
        && local.w > 0.0
        && local.h > 0.0;
    inside.then(|| Rect {
        x: local.x.max(0.0),
        y: local.y.max(0.0),
        w: local.w.min(display.w - local.x.max(0.0)),
        h: local.h.min(display.h - local.y.max(0.0)),
    })
}

/// The frame of a capture of `display` (global points) output at `out_w ×
/// out_h` pixels.
pub fn capture_frame(index: u32, display: Rect, out_w: u32, out_h: u32) -> Frame {
    Frame {
        display: index,
        origin_x: display.x,
        origin_y: display.y,
        width: f64::from(out_w),
        height: f64::from(out_h),
        scale: display.w / f64::from(out_w.max(1)),
    }
}

/// An AppKit rectangle (bottom-left origin on the primary screen) → global
/// top-left points, the space of CoreGraphics events and accessibility.
pub fn cocoa_to_global(rect: Rect, primary_height: f64) -> Rect {
    Rect {
        y: primary_height - (rect.y + rect.h),
        ..rect
    }
}

/// Points along a drag, `from` → `to`, excluding `from`, including `to`.
pub fn drag_path(from: (f64, f64), to: (f64, f64), steps: usize) -> Vec<(f64, f64)> {
    let steps = steps.max(1);
    (1..=steps)
        .map(|i| {
            let t = i as f64 / steps as f64;
            (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t)
        })
        .collect()
}

/// UTF-16 chunks of at most `max_units`, never splitting a surrogate pair.
pub fn utf16_chunks(text: &str, max_units: usize) -> Vec<Vec<u16>> {
    let max_units = max_units.max(2);
    let mut chunks = Vec::new();
    let mut current: Vec<u16> = Vec::with_capacity(max_units);
    let mut buf = [0u16; 2];
    for c in text.chars() {
        let units = c.encode_utf16(&mut buf);
        if current.len() + units.len() > max_units {
            chunks.push(std::mem::take(&mut current));
        }
        current.extend_from_slice(units);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

// ── takeover state machine (pure) ────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Control {
    #[default]
    Idle,
    Active {
        app: String,
    },
    Paused {
        app: Option<String>,
    },
    Killed,
}

/// A state change the page is told about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    pub state: StateName,
    pub app: Option<String>,
    pub reason: Option<StateReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    TookOver,
    Stopped,
}

/// Who is in control. Pure: every time is injected, so it is unit-tested
/// without a clock.
#[derive(Debug, Default)]
pub struct Takeover {
    control: Control,
    last_synth: Option<Instant>,
    last_action: Option<Instant>,
    own_escape_at: Option<Instant>,
}

impl Takeover {
    pub fn control(&self) -> &Control {
        &self.control
    }

    /// `Err` when no action may run now (paused or killed).
    pub fn check(&self) -> Result<(), Refusal> {
        match self.control {
            Control::Paused { .. } => Err(Refusal::TookOver),
            Control::Killed => Err(Refusal::Stopped),
            Control::Idle | Control::Active { .. } => Ok(()),
        }
    }

    /// An acting op is about to post input to `app`.
    pub fn begin_action(&mut self, now: Instant, app: &str) -> Result<Option<Transition>, Refusal> {
        self.check()?;
        self.last_synth = Some(now);
        self.last_action = Some(now);
        let changed = !matches!(&self.control, Control::Active { app: current } if current == app);
        self.control = Control::Active {
            app: app.to_string(),
        };
        Ok(changed.then(|| Transition {
            state: StateName::Active,
            app: Some(app.to_string()),
            reason: None,
        }))
    }

    /// We just posted synthetic input.
    pub fn note_synth(&mut self, now: Instant) {
        if matches!(self.control, Control::Active { .. }) {
            self.last_synth = Some(now);
            self.last_action = Some(now);
        }
    }

    /// The monitor's reading: seconds since the last HID input of any kind.
    /// Input newer than our own last synthetic event + [`GRACE`] is the
    /// operator's hand — pause.
    pub fn observe_input(&mut self, idle_secs: f64, now: Instant) -> Option<Transition> {
        let Control::Active { app } = &self.control else {
            return None;
        };
        let last_synth = self.last_synth?;
        let idle = Duration::try_from_secs_f64(idle_secs).ok()?;
        let last_input = now.checked_sub(idle)?;
        if last_input <= last_synth + GRACE {
            return None;
        }
        let app = app.clone();
        self.control = Control::Paused {
            app: Some(app.clone()),
        };
        Some(Transition {
            state: StateName::Paused,
            app: Some(app),
            reason: Some(StateReason::OperatorInput),
        })
    }

    /// Active with no action for [`IDLE_TIMEOUT`] → idle.
    pub fn tick(&mut self, now: Instant) -> Option<Transition> {
        if !matches!(self.control, Control::Active { .. }) {
            return None;
        }
        let last = self.last_action?;
        if now.saturating_duration_since(last) < IDLE_TIMEOUT {
            return None;
        }
        self.control = Control::Idle;
        Some(Transition {
            state: StateName::Idle,
            app: None,
            reason: Some(StateReason::Idle),
        })
    }

    /// The operator hands control back (Resume in Verse). Paused → idle: the
    /// next action makes control active again.
    pub fn resume(&mut self) -> Option<Transition> {
        if !matches!(self.control, Control::Paused { .. }) {
            return None;
        }
        self.control = Control::Idle;
        Some(Transition {
            state: StateName::Idle,
            app: None,
            reason: Some(StateReason::Resume),
        })
    }

    /// The kill switch (Esc, or KILL in Verse). From any state.
    pub fn kill(&mut self, reason: StateReason) -> Option<Transition> {
        if self.control == Control::Killed {
            return None;
        }
        self.control = Control::Killed;
        Some(Transition {
            state: StateName::Killed,
            app: None,
            reason: Some(reason),
        })
    }

    /// Re-arm after a kill (the operator turned computer use back on).
    pub fn arm(&mut self) -> Option<Transition> {
        if self.control != Control::Killed {
            return None;
        }
        self.control = Control::Idle;
        Some(Transition {
            state: StateName::Idle,
            app: None,
            reason: None,
        })
    }

    /// The Verse window was hidden / closed / reloaded: active control pauses.
    pub fn window_gone(&mut self) -> Option<Transition> {
        let Control::Active { app } = &self.control else {
            return None;
        };
        let app = app.clone();
        self.control = Control::Paused {
            app: Some(app.clone()),
        };
        Some(Transition {
            state: StateName::Paused,
            app: Some(app),
            reason: Some(StateReason::Idle),
        })
    }

    /// We are about to post Escape ourselves.
    pub fn note_own_escape(&mut self, now: Instant) {
        self.own_escape_at = Some(now);
    }

    /// An Esc shortcut event at `now` is our own posted Escape.
    pub fn escape_is_own(&self, now: Instant) -> bool {
        self.own_escape_at
            .is_some_and(|at| now.saturating_duration_since(at) < OWN_ESCAPE_WINDOW)
    }

    /// The app the HUD should name, when it should show.
    pub fn hud_app(&self) -> Option<&str> {
        match &self.control {
            Control::Active { app } => Some(app),
            _ => None,
        }
    }
}

// ── managed state ────────────────────────────────────────────────────────────

/// What the HUD and the Esc shortcut currently look like.
#[derive(Debug, Default)]
struct HudApplied {
    app: Option<String>,
    escape_registered: bool,
}

/// Managed state (`app.manage`).
#[derive(Default)]
pub struct ComputerState {
    takeover: Mutex<Takeover>,
    worker: Mutex<Option<mpsc::Sender<ComputerRequest>>>,
    hud: Mutex<HudApplied>,
    monitor_started: AtomicBool,
    #[cfg(target_os = "macos")]
    refs: Mutex<mac::RefStore>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

// ── entry points (called from main.rs) ───────────────────────────────────────

/// A `shell-computer` event from the Verse page.
pub fn handle_event(app: &AppHandle, payload: &str) {
    let request = match parse_request(payload) {
        Ok(request) => request,
        Err(Some(req)) => {
            emit(
                app,
                &ComputerEvent::result(&req, Err(Failure::invalid("Malformed computer request."))),
            );
            return;
        }
        Err(None) => {
            eprintln!("[ashlr-desktop] ignoring a malformed shell-computer event");
            return;
        }
    };
    let Some(state) = app.try_state::<ComputerState>() else {
        return;
    };
    // The control ops never wait behind a queued capture.
    let transition = match request {
        ComputerRequest::Resume {} => lock(&state.takeover).resume(),
        ComputerRequest::Kill {} => lock(&state.takeover).kill(StateReason::Kill),
        ComputerRequest::Arm {} => lock(&state.takeover).arm(),
        other => {
            enqueue(app, &state, other);
            return;
        }
    };
    apply_transition(app, transition);
}

/// The Verse window was hidden, closed to the tray, or its page (re)loaded:
/// active control pauses and the HUD goes away. Safe on the main thread.
pub fn on_verse_window_gone(app: &AppHandle) {
    let Some(state) = app.try_state::<ComputerState>() else {
        return;
    };
    let transition = lock(&state.takeover).window_gone();
    apply_transition(app, transition);
    // Even without a transition, make sure nothing is left on screen.
    sync_hud(app);
}

/// The Esc global shortcut (registered only while the HUD shows) = KILL.
/// Runs on the main thread (the plugin's handler).
pub fn on_global_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutState) {
    if event != ShortcutState::Pressed || shortcut.id() != escape_shortcut().id() {
        return;
    }
    let Some(state) = app.try_state::<ComputerState>() else {
        return;
    };
    let transition = {
        let mut takeover = lock(&state.takeover);
        if takeover.escape_is_own(Instant::now()) {
            return;
        }
        takeover.kill(StateReason::Escape)
    };
    apply_transition(app, transition);
}

pub fn escape_shortcut() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

fn enqueue(app: &AppHandle, state: &ComputerState, request: ComputerRequest) {
    let mut worker = lock(&state.worker);
    let request = match worker.as_ref() {
        Some(tx) => match tx.send(request) {
            Ok(()) => return,
            Err(mpsc::SendError(request)) => request,
        },
        None => request,
    };
    let (tx, rx) = mpsc::channel::<ComputerRequest>();
    let handle = app.clone();
    let spawned = thread::Builder::new()
        .name("ashlr-computer".into())
        .spawn(move || {
            for request in rx {
                run_request(&handle, request);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[ashlr-desktop] could not start the computer-use worker: {e}");
        if let Some(req) = request.req() {
            emit(
                app,
                &ComputerEvent::result(
                    req,
                    Err(Failure::new(ErrorCode::Busy, "Worker unavailable.")),
                ),
            );
        }
        return;
    }
    let _ = tx.send(request);
    *worker = Some(tx);
}

fn run_request(app: &AppHandle, request: ComputerRequest) {
    let Some(state) = app.try_state::<ComputerState>() else {
        return;
    };
    #[cfg(target_os = "macos")]
    mac::run(app, &state, request);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &state;
        if let Some(req) = request.req() {
            emit(
                app,
                &ComputerEvent::result(req, Err(Failure::unsupported())),
            );
        }
    }
}

// ── emitting, HUD sync, monitor ──────────────────────────────────────────────

fn emit(app: &AppHandle, event: &ComputerEvent) {
    if let Some(main) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        let _ = main.eval(event_script(event));
    }
}

/// Tell the page about a state change, bring the HUD / Esc shortcut in line,
/// and make sure the takeover monitor runs.
fn apply_transition(app: &AppHandle, transition: Option<Transition>) {
    let Some(transition) = transition else {
        return;
    };
    emit(app, &ComputerEvent::state(&transition));
    if transition.state == StateName::Active {
        start_monitor(app);
    }
    sync_hud(app);
}

/// Bring the HUD and the Esc shortcut in line with the takeover state. Runs on
/// a short-lived thread: registering a global shortcut blocks until the main
/// thread has done it, so it must never run ON the main thread. The `hud`
/// lock serialises the syncs, and each one reads the latest state inside it,
/// so the last sync always leaves the latest state applied.
fn sync_hud(app: &AppHandle) {
    let app = app.clone();
    let _ = thread::Builder::new()
        .name("ashlr-computer-hud".into())
        .spawn(move || {
            let Some(state) = app.try_state::<ComputerState>() else {
                return;
            };
            if let Err(error) = sync_hud_now(&app, &state) {
                eprintln!("[ashlr-desktop] computer-use control UI unavailable: {error}");
                // A failed HUD or stop key must not leave control active. This
                // also covers a transition that did not originate in `begin`.
                let transition = {
                    let mut takeover = lock(&state.takeover);
                    matches!(takeover.control(), Control::Active { .. })
                        .then(|| takeover.kill(StateReason::Kill))
                        .flatten()
                };
                apply_transition(&app, transition);
            }
        });
}

/// Apply the visible-control invariant synchronously. The HUD lock prevents
/// an older asynchronous sync from overwriting a newer state.
fn sync_hud_now(app: &AppHandle, state: &ComputerState) -> Result<(), String> {
    let mut applied = lock(&state.hud);
    let desired = lock(&state.takeover).hud_app().map(str::to_string);
    reconcile_hud(
        &mut applied,
        desired,
        |on| set_escape_registered(app, on),
        |name| show_hud(app, name),
    )
}

fn reconcile_hud(
    applied: &mut HudApplied,
    desired: Option<String>,
    mut set_escape: impl FnMut(bool) -> Result<(), String>,
    mut display: impl FnMut(Option<String>) -> Result<(), String>,
) -> Result<(), String> {
    let want_escape = desired.is_some();
    // Install the stop key before making control visible. If this fails,
    // neither the HUD nor a native input event may be enabled.
    if want_escape && !applied.escape_registered {
        set_escape(true)?;
        applied.escape_registered = true;
    }
    if desired != applied.app {
        display(desired.clone())?;
        applied.app = desired;
    }
    if !want_escape && applied.escape_registered {
        set_escape(false)?;
        applied.escape_registered = false;
    }
    Ok(())
}

fn set_escape_registered(app: &AppHandle, registered: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let manager = app.global_shortcut();
    let shortcut = escape_shortcut();
    let result = if registered {
        if manager.is_registered(shortcut) {
            Ok(())
        } else {
            manager.register(shortcut)
        }
    } else if manager.is_registered(shortcut) {
        manager.unregister(shortcut)
    } else {
        Ok(())
    };
    result.map_err(|e| {
        format!(
            "could not {} the computer-use Esc stop key: {e}",
            if registered { "register" } else { "unregister" }
        )
    })
}

/// Temporarily release Esc so an Escape we post reaches the app instead of
/// our own shortcut (the next [`sync_hud`] re-registers it). Worker thread.
fn release_escape_for_own_key(app: &AppHandle, state: &ComputerState) {
    let mut applied = lock(&state.hud);
    if applied.escape_registered {
        if let Err(error) = set_escape_registered(app, false) {
            eprintln!("[ashlr-desktop] {error}");
        } else {
            applied.escape_registered = false;
        }
    }
}

#[cfg(target_os = "macos")]
fn show_hud(app: &AppHandle, desired: Option<String>) -> Result<(), String> {
    let (tx, rx) = mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let shown = match desired {
            Some(name) => {
                // A timed-out callback may run after control was killed.
                let still_active = handle
                    .try_state::<ComputerState>()
                    .is_some_and(|state| lock(&state.takeover).hud_app() == Some(name.as_str()));
                still_active && mac::hud::show(&name)
            }
            None => {
                mac::hud::hide();
                true
            }
        };
        let _ = tx.send(shown);
    })
    .map_err(|e| format!("could not schedule the computer-use HUD: {e}"))?;
    match rx.recv_timeout(HUD_ACK_TIMEOUT) {
        Ok(true) => Ok(()),
        Ok(false) => Err("could not show the computer-use HUD".into()),
        Err(_) => Err("computer-use HUD did not appear in time".into()),
    }
}

#[cfg(not(target_os = "macos"))]
fn show_hud(_app: &AppHandle, _desired: Option<String>) -> Result<(), String> {
    Ok(())
}

/// Seconds since the last hardware input of any kind.
#[cfg(target_os = "macos")]
fn seconds_since_input() -> Option<f64> {
    mac::seconds_since_input()
}

#[cfg(not(target_os = "macos"))]
fn seconds_since_input() -> Option<f64> {
    None
}

/// One thread for the app's lifetime: every [`MONITOR_INTERVAL`] while control
/// is active it checks for operator input and the idle timeout.
fn start_monitor(app: &AppHandle) {
    let Some(state) = app.try_state::<ComputerState>() else {
        return;
    };
    if state.monitor_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("ashlr-computer-monitor".into())
        .spawn(move || loop {
            thread::sleep(MONITOR_INTERVAL);
            let Some(state) = app.try_state::<ComputerState>() else {
                return;
            };
            let active = matches!(lock(&state.takeover).control(), Control::Active { .. });
            if !active {
                thread::sleep(MONITOR_INTERVAL);
                continue;
            }
            let idle = seconds_since_input();
            let now = Instant::now();
            let transition = {
                let mut takeover = lock(&state.takeover);
                idle.and_then(|secs| takeover.observe_input(secs, now))
                    .or_else(|| takeover.tick(now))
            };
            apply_transition(&app, transition);
        });
    if spawned.is_err() {
        state.monitor_started.store(false, Ordering::SeqCst);
    }
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

    fn send(&self, outcome: OpResult) {
        if self.done.swap(true, Ordering::SeqCst) {
            return;
        }
        emit(&self.app, &ComputerEvent::result(&self.req, outcome));
    }

    fn arm_timeout(&self, after: Duration) {
        let reply = self.clone();
        let _ = thread::Builder::new()
            .name("ashlr-computer-timeout".into())
            .spawn(move || {
                thread::sleep(after);
                reply.send(Err(Failure::new(
                    ErrorCode::Timeout,
                    "The capture did not finish in time.",
                )));
            });
    }
}

/// Is the Verse window on screen? ("Verse window present" is an invariant
/// for acting.) Worker thread only (the getters hop to the main thread).
fn verse_window_present(app: &AppHandle) -> bool {
    app.get_webview_window(crate::MAIN_WINDOW_LABEL)
        .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
}

// ── macOS ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod mac {
    //! Everything that touches the OS: ApplicationServices (accessibility),
    //! CoreGraphics (events, permissions), ScreenCaptureKit (loaded at run
    //! time — the app's minimum macOS is 10.15 and SCScreenshotManager needs
    //! 14), AppKit (running apps, the HUD).

    use std::{
        collections::HashMap,
        ffi::c_void,
        sync::{Mutex, OnceLock},
        thread,
        time::{Duration, Instant},
    };

    use block2::RcBlock;
    use objc2::{
        encode::{Encoding, RefEncode},
        msg_send,
        rc::{autoreleasepool, Allocated, Retained},
        runtime::{AnyClass, AnyObject},
        AllocAnyThread, ClassType,
    };
    use objc2_app_kit::{
        NSApplicationActivationPolicy, NSBitmapImageFileType, NSBitmapImageRep,
        NSImageCompressionFactor, NSRunningApplication, NSWorkspace,
    };
    use objc2_foundation::{
        NSArray, NSDictionary, NSError, NSNumber, NSProcessInfo, NSRect, NSString,
    };
    use serde_json::{json, Value};
    use tauri::AppHandle;

    use super::*;

    // ── FFI ──────────────────────────────────────────────────────────────────

    type CFTypeRef = *const c_void;
    type AXUIElementRef = *const c_void;
    type CGEventRef = *mut c_void;
    type CGEventSourceRef = *mut c_void;

    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    /// Opaque `CGImage`, encoded as the runtime expects (`^{CGImage=}`).
    #[repr(C)]
    pub struct CGImage {
        _private: [u8; 0],
    }
    // SAFETY: CGImageRef is `struct CGImage *`; this is its exact encoding.
    unsafe impl RefEncode for CGImage {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGImage", &[]));
    }

    /// Opaque `CGColor` (`^{CGColor=}`).
    #[repr(C)]
    pub struct CGColor {
        _private: [u8; 0],
    }
    // SAFETY: CGColorRef is `struct CGColor *`; this is its exact encoding.
    unsafe impl RefEncode for CGColor {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGColor", &[]));
    }

    const AX_SUCCESS: i32 = 0;
    const AX_VALUE_CGPOINT: u32 = 1;
    const AX_VALUE_CGSIZE: u32 = 2;

    const EVENT_SOURCE_PRIVATE: i32 = -1;
    const EVENT_SOURCE_HID_SYSTEM: i32 = 1;
    const ANY_INPUT_EVENT: u32 = !0;
    const HID_EVENT_TAP: u32 = 0;
    const MOUSE_EVENT_CLICK_STATE: u32 = 1;
    const EVENT_SOURCE_USER_DATA: u32 = 42;
    /// Tags every event we post ("ASHLR" in ASCII-ish hex).
    const USER_DATA_TAG: i64 = 0x41_5348_4c52;
    const SCROLL_UNIT_LINE: u32 = 1;

    const LEFT_MOUSE_DOWN: u32 = 1;
    const LEFT_MOUSE_UP: u32 = 2;
    const RIGHT_MOUSE_DOWN: u32 = 3;
    const RIGHT_MOUSE_UP: u32 = 4;
    const MOUSE_MOVED: u32 = 5;
    const LEFT_MOUSE_DRAGGED: u32 = 6;
    const OTHER_MOUSE_DOWN: u32 = 25;
    const OTHER_MOUSE_UP: u32 = 26;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> u8;
        static kAXTrustedCheckOptionPrompt: CFTypeRef;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFTypeRef,
            value: *mut CFTypeRef,
        ) -> i32;
        fn AXUIElementCopyElementAtPosition(
            application: AXUIElementRef,
            x: f32,
            y: f32,
            element: *mut AXUIElementRef,
        ) -> i32;
        fn AXUIElementPerformAction(element: AXUIElementRef, action: CFTypeRef) -> i32;
        fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> i32;
        fn AXUIElementGetTypeID() -> usize;
        fn AXValueGetTypeID() -> usize;
        fn AXValueGetType(value: CFTypeRef) -> u32;
        fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> u8;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGPreflightPostEventAccess() -> bool;
        fn CGRequestPostEventAccess() -> bool;
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        fn CGEventSourceCreate(state: i32) -> CGEventSourceRef;
        fn CGEventCreateMouseEvent(
            source: CGEventSourceRef,
            event_type: u32,
            position: CGPoint,
            button: u32,
        ) -> CGEventRef;
        fn CGEventCreateKeyboardEvent(source: CGEventSourceRef, key: u16, down: bool)
            -> CGEventRef;
        fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: usize, string: *const u16);
        fn CGEventCreateScrollWheelEvent2(
            source: CGEventSourceRef,
            units: u32,
            wheel_count: u32,
            wheel1: i32,
            wheel2: i32,
            wheel3: i32,
        ) -> CGEventRef;
        fn CGEventSetFlags(event: CGEventRef, flags: u64);
        fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
        fn CGEventPost(tap: u32, event: CGEventRef);
        fn CGMainDisplayID() -> u32;
        fn CGDisplayCopyDisplayMode(display: u32) -> *mut c_void;
        fn CGDisplayModeGetPixelWidth(mode: *mut c_void) -> usize;
        fn CGDisplayModeGetPixelHeight(mode: *mut c_void) -> usize;
        fn CGDisplayModeRelease(mode: *mut c_void);
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
        fn CFRelease(cf: CFTypeRef);
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(boolean: CFTypeRef) -> u8;
        fn CFNumberGetTypeID() -> usize;
        fn CFNumberGetValue(number: CFTypeRef, kind: isize, out: *mut c_void) -> u8;
        fn CFArrayGetTypeID() -> usize;
        fn CFArrayGetCount(array: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
    }

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        /// True while any app holds secure event input (password fields).
        fn IsSecureEventInputEnabled() -> u8;
    }

    /// An owned (+1) CoreFoundation reference, released on drop.
    pub struct Cf(CFTypeRef);

    // SAFETY: CoreFoundation / AXUIElement reference counting is thread-safe,
    // and the accessibility API may be called from any thread.
    unsafe impl Send for Cf {}

    impl Cf {
        /// Take ownership of a +1 reference (`None` for null).
        fn owned(ptr: CFTypeRef) -> Option<Self> {
            (!ptr.is_null()).then_some(Self(ptr))
        }

        /// Retain a borrowed (+0) reference.
        fn retained(ptr: CFTypeRef) -> Option<Self> {
            if ptr.is_null() {
                return None;
            }
            // SAFETY: `ptr` is a live CF object borrowed from its container.
            Some(Self(unsafe { CFRetain(ptr) }))
        }

        fn ptr(&self) -> CFTypeRef {
            self.0
        }

        fn clone_ref(&self) -> Self {
            // SAFETY: self.0 is a live, owned CF object.
            Self(unsafe { CFRetain(self.0) })
        }

        fn type_id(&self) -> usize {
            // SAFETY: self.0 is a live CF object.
            unsafe { CFGetTypeID(self.0) }
        }
    }

    impl Drop for Cf {
        fn drop(&mut self) {
            // SAFETY: we own exactly one reference.
            unsafe { CFRelease(self.0) }
        }
    }

    /// `ax-tree` refs per pid, valid until the next `ax-tree` for that app.
    #[derive(Default)]
    pub struct RefStore {
        by_pid: HashMap<i32, Vec<Cf>>,
        order: Vec<i32>,
    }

    impl RefStore {
        const MAX_APPS: usize = 8;

        fn replace(&mut self, pid: i32, refs: Vec<Cf>) {
            self.order.retain(|p| *p != pid);
            self.order.push(pid);
            self.by_pid.insert(pid, refs);
            while self.order.len() > Self::MAX_APPS {
                let evicted = self.order.remove(0);
                self.by_pid.remove(&evicted);
            }
        }

        fn get(&self, pid: i32, index: usize) -> Option<Cf> {
            self.by_pid.get(&pid)?.get(index).map(Cf::clone_ref)
        }
    }

    fn ns(s: &str) -> Retained<NSString> {
        NSString::from_str(s)
    }

    fn cf_of(s: &NSString) -> CFTypeRef {
        (s as *const NSString).cast()
    }

    // ── accessibility helpers ────────────────────────────────────────────────

    fn ax_attr(element: &Cf, name: &str) -> Option<Cf> {
        let attr = ns(name);
        let mut value: CFTypeRef = std::ptr::null();
        // SAFETY: element is a live AXUIElementRef; attr a live CFString; the
        // out value is +1 on success.
        let err = unsafe { AXUIElementCopyAttributeValue(element.ptr(), cf_of(&attr), &mut value) };
        if err != AX_SUCCESS {
            return None;
        }
        Cf::owned(value)
    }

    fn cf_to_string(value: &Cf) -> Option<String> {
        // SAFETY: type ids are plain functions.
        let (string_id, number_id, bool_id) = unsafe {
            (
                CFStringGetTypeID(),
                CFNumberGetTypeID(),
                CFBooleanGetTypeID(),
            )
        };
        let id = value.type_id();
        if id == string_id {
            // SAFETY: CFString is toll-free bridged with NSString.
            let s: &NSString = unsafe { &*(value.ptr() as *const NSString) };
            return Some(s.to_string());
        }
        if id == number_id {
            let mut out = 0f64;
            const CF_NUMBER_DOUBLE: isize = 13;
            // SAFETY: out is a valid f64 for kCFNumberDoubleType.
            let ok = unsafe {
                CFNumberGetValue(value.ptr(), CF_NUMBER_DOUBLE, (&mut out as *mut f64).cast())
            };
            return (ok != 0 && out.is_finite()).then(|| {
                if out.fract() == 0.0 && out.abs() < 1e15 {
                    format!("{}", out as i64)
                } else {
                    format!("{out}")
                }
            });
        }
        if id == bool_id {
            // SAFETY: value is a CFBoolean.
            return Some(if unsafe { CFBooleanGetValue(value.ptr()) } != 0 {
                "true".into()
            } else {
                "false".into()
            });
        }
        None
    }

    fn ax_string(element: &Cf, name: &str) -> Option<String> {
        let value = ax_attr(element, name)?;
        // SAFETY: plain type id function.
        if value.type_id() != unsafe { CFStringGetTypeID() } {
            return None;
        }
        cf_to_string(&value)
            .map(|s| truncate_chars(s.trim(), STRING_MAX_CHARS))
            .filter(|s| !s.is_empty())
    }

    fn ax_bool(element: &Cf, name: &str) -> Option<bool> {
        let value = ax_attr(element, name)?;
        // SAFETY: plain type id function; value checked to be a CFBoolean.
        unsafe {
            if value.type_id() != CFBooleanGetTypeID() {
                return None;
            }
            Some(CFBooleanGetValue(value.ptr()) != 0)
        }
    }

    fn ax_rect(element: &Cf) -> Option<Rect> {
        let position = ax_attr(element, "AXPosition")?;
        let size = ax_attr(element, "AXSize")?;
        let mut point = CGPoint::default();
        let mut extent = CGSize::default();
        // SAFETY: both values are checked to be AXValues of the right kind
        // before AXValueGetValue writes into a matching struct.
        unsafe {
            let ax_value = AXValueGetTypeID();
            if position.type_id() != ax_value || size.type_id() != ax_value {
                return None;
            }
            if AXValueGetType(position.ptr()) != AX_VALUE_CGPOINT
                || AXValueGetType(size.ptr()) != AX_VALUE_CGSIZE
            {
                return None;
            }
            if AXValueGetValue(
                position.ptr(),
                AX_VALUE_CGPOINT,
                (&mut point as *mut CGPoint).cast(),
            ) == 0
                || AXValueGetValue(
                    size.ptr(),
                    AX_VALUE_CGSIZE,
                    (&mut extent as *mut CGSize).cast(),
                ) == 0
            {
                return None;
            }
        }
        let rect = Rect {
            x: point.x,
            y: point.y,
            w: extent.width,
            h: extent.height,
        };
        [rect.x, rect.y, rect.w, rect.h]
            .iter()
            .all(|v| v.is_finite())
            .then_some(rect)
    }

    fn ax_element(element: &Cf, name: &str) -> Option<Cf> {
        let value = ax_attr(element, name)?;
        // SAFETY: plain type id function.
        (value.type_id() == unsafe { AXUIElementGetTypeID() }).then_some(value)
    }

    fn ax_children(element: &Cf) -> Vec<Cf> {
        let Some(array) = ax_attr(element, "AXChildren") else {
            return Vec::new();
        };
        // SAFETY: the value is checked to be a CFArray; each item is retained
        // before the array is released.
        unsafe {
            if array.type_id() != CFArrayGetTypeID() {
                return Vec::new();
            }
            let count = CFArrayGetCount(array.ptr()).clamp(0, 10_000);
            let ax_type = AXUIElementGetTypeID();
            (0..count)
                .filter_map(|i| Cf::retained(CFArrayGetValueAtIndex(array.ptr(), i)))
                .filter(|child| child.type_id() == ax_type)
                .collect()
        }
    }

    fn ax_pid(element: &Cf) -> Option<i32> {
        let mut pid = 0i32;
        // SAFETY: element is a live AXUIElementRef.
        let err = unsafe { AXUIElementGetPid(element.ptr(), &mut pid) };
        (err == AX_SUCCESS && pid > 0).then_some(pid)
    }

    fn app_element(pid: i32) -> Option<Cf> {
        // SAFETY: returns a +1 AXUIElementRef (or null).
        let element = Cf::owned(unsafe { AXUIElementCreateApplication(pid) })?;
        // SAFETY: element is live; a bounded timeout keeps a hung app from
        // hanging the worker.
        unsafe { AXUIElementSetMessagingTimeout(element.ptr(), 1.0) };
        Some(element)
    }

    fn system_wide() -> Option<Cf> {
        // SAFETY: returns a +1 AXUIElementRef.
        let element = Cf::owned(unsafe { AXUIElementCreateSystemWide() })?;
        // SAFETY: element is live.
        unsafe { AXUIElementSetMessagingTimeout(element.ptr(), 1.0) };
        Some(element)
    }

    fn element_at(x: f64, y: f64) -> Option<Cf> {
        let system = system_wide()?;
        let mut element: AXUIElementRef = std::ptr::null();
        // SAFETY: system is live; the out element is +1 on success.
        let err = unsafe {
            AXUIElementCopyElementAtPosition(system.ptr(), x as f32, y as f32, &mut element)
        };
        if err != AX_SUCCESS {
            return None;
        }
        Cf::owned(element)
    }

    fn focused_element() -> Option<Cf> {
        ax_element(&system_wide()?, "AXFocusedUIElement")
    }

    fn focused_element_of(pid: i32) -> Option<Cf> {
        ax_element(&app_element(pid)?, "AXFocusedUIElement")
    }

    fn is_secure(element: &Cf) -> bool {
        is_secure_element(
            ax_string(element, "AXRole").as_deref(),
            ax_string(element, "AXSubrole").as_deref(),
        )
    }

    fn label_of(element: &Cf) -> Option<String> {
        ax_string(element, "AXTitle")
            .or_else(|| ax_string(element, "AXDescription"))
            .or_else(|| ax_string(element, "AXHelp"))
    }

    fn window_title_of(element: &Cf) -> Option<String> {
        let window = ax_element(element, "AXWindow")?;
        ax_string(&window, "AXTitle")
    }

    /// The titles to judge a System Settings action by: the focused and main
    /// windows, plus the target element's own window. `None` = unreadable.
    fn settings_titles(pid: i32, element: Option<&Cf>) -> Option<Vec<String>> {
        let app = app_element(pid)?;
        let mut titles = Vec::new();
        for attr in ["AXFocusedWindow", "AXMainWindow"] {
            if let Some(window) = ax_element(&app, attr) {
                titles.push(ax_string(&window, "AXTitle").unwrap_or_default());
            }
        }
        if let Some(title) = element.and_then(window_title_of) {
            titles.push(title);
        }
        (!titles.is_empty()).then_some(titles)
    }

    fn element_json(element: &Cf) -> Value {
        json!({
            "role": ax_string(element, "AXRole"),
            "label": label_of(element),
        })
    }

    // ── permissions ──────────────────────────────────────────────────────────

    struct Perms {
        screen: bool,
        accessibility: bool,
        post_events: bool,
    }

    fn perms() -> Perms {
        // SAFETY: plain preflight queries; none prompts.
        unsafe {
            Perms {
                screen: CGPreflightScreenCaptureAccess(),
                accessibility: AXIsProcessTrusted() != 0,
                post_events: CGPreflightPostEventAccess(),
            }
        }
    }

    fn macos_version() -> String {
        let v = NSProcessInfo::processInfo().operatingSystemVersion();
        if v.patchVersion > 0 {
            format!("{}.{}.{}", v.majorVersion, v.minorVersion, v.patchVersion)
        } else {
            format!("{}.{}", v.majorVersion, v.minorVersion)
        }
    }

    fn perms_json() -> Value {
        let p = perms();
        json!({
            "supported": true,
            "macos": macos_version(),
            "screen": p.screen,
            "accessibility": p.accessibility,
            "postEvents": p.post_events,
        })
    }

    fn request_permission(kind: PermissionKind) -> Value {
        // SAFETY: each call may show a system prompt and returns a bool; the
        // options dictionary is a live NSDictionary (toll-free CFDictionary)
        // and kAXTrustedCheckOptionPrompt a CFString constant.
        unsafe {
            match kind {
                PermissionKind::Screen => {
                    let _ = CGRequestScreenCaptureAccess();
                }
                PermissionKind::PostEvents => {
                    let _ = CGRequestPostEventAccess();
                }
                PermissionKind::Accessibility => {
                    let key: &NSString = &*(kAXTrustedCheckOptionPrompt as *const NSString);
                    let yes = NSNumber::new_bool(true);
                    let value: &AnyObject = &yes;
                    let options =
                        NSDictionary::<NSString, AnyObject>::from_slices(&[key], &[value]);
                    let _ = AXIsProcessTrustedWithOptions(Retained::as_ptr(&options).cast());
                }
            }
        }
        perms_json()
    }

    fn need_input_perms() -> Result<(), Failure> {
        let p = perms();
        if !p.accessibility {
            return Err(missing("Accessibility"));
        }
        if !p.post_events {
            return Err(missing("Accessibility (posting input events)"));
        }
        Ok(())
    }

    fn need_accessibility() -> Result<(), Failure> {
        if perms().accessibility {
            Ok(())
        } else {
            Err(missing("Accessibility"))
        }
    }

    fn need_screen() -> Result<(), Failure> {
        if perms().screen {
            Ok(())
        } else {
            Err(missing("Screen Recording"))
        }
    }

    fn missing(name: &str) -> Failure {
        Failure::new(
            ErrorCode::NoPermission,
            format!("Phantom does not have the macOS {name} permission. Ask the operator to grant it in Phantom's computer-use setup."),
        )
    }

    pub fn seconds_since_input() -> Option<f64> {
        // SAFETY: a plain query of the HID system state.
        let secs = unsafe {
            CGEventSourceSecondsSinceLastEventType(EVENT_SOURCE_HID_SYSTEM, ANY_INPUT_EVENT)
        };
        (secs.is_finite() && secs >= 0.0).then_some(secs)
    }

    // ── apps ─────────────────────────────────────────────────────────────────

    fn executable_path(pid: i32) -> Option<String> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: buf is writable for its full length.
        let len = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
        if len <= 0 {
            return None;
        }
        buf.truncate(len as usize);
        String::from_utf8(buf).ok()
    }

    fn pid_of(app: &NSRunningApplication) -> i32 {
        // SAFETY: `@property (readonly) pid_t processIdentifier` (sent
        // dynamically: the typed binding needs objc2-app-kit's `libc`
        // feature, which would add a Cargo.lock edge).
        unsafe { msg_send![app, processIdentifier] }
    }

    fn ident_of(app: &NSRunningApplication) -> AppIdent {
        let pid = pid_of(app);
        let bundle = app.bundleIdentifier().map(|b| b.to_string());
        let name = app
            .localizedName()
            .map(|n| n.to_string())
            .or_else(|| bundle.clone())
            .unwrap_or_else(|| format!("process {pid}"));
        AppIdent {
            pid,
            bundle,
            name,
            executable: executable_path(pid),
        }
    }

    fn ident_for_pid(pid: i32) -> AppIdent {
        // SAFETY: `+runningApplicationWithProcessIdentifier:(pid_t)` returns
        // an autoreleased NSRunningApplication or nil.
        let app: Option<Retained<NSRunningApplication>> = unsafe {
            msg_send![
                NSRunningApplication::class(),
                runningApplicationWithProcessIdentifier: pid
            ]
        };
        match app {
            Some(app) => ident_of(&app),
            None => AppIdent {
                pid,
                bundle: None,
                name: format!("process {pid}"),
                executable: executable_path(pid),
            },
        }
    }

    fn own_pid() -> i32 {
        std::process::id() as i32
    }

    fn frontmost() -> Option<AppIdent> {
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| ident_of(&app))
    }

    /// An `app` parameter (bundle id or exact name, case-insensitive) → the
    /// running app; regular (Dock) apps win over background ones.
    fn find_app(query: &str) -> Result<AppIdent, Failure> {
        let apps = NSWorkspace::sharedWorkspace().runningApplications();
        let mut best: Option<(bool, AppIdent)> = None;
        for app in apps.iter() {
            let bundle_hit = app
                .bundleIdentifier()
                .is_some_and(|b| b.to_string().eq_ignore_ascii_case(query));
            let name_hit = app
                .localizedName()
                .is_some_and(|n| n.to_string().to_lowercase() == query.to_lowercase());
            if !(bundle_hit || name_hit) {
                continue;
            }
            let regular = app.activationPolicy() == NSApplicationActivationPolicy::Regular;
            if best.as_ref().map_or(true, |(r, _)| regular && !r) {
                best = Some((regular, ident_of(&app)));
            }
        }
        best.map(|(_, ident)| ident).ok_or_else(|| {
            Failure::new(
                ErrorCode::NotFound,
                format!("No running app matches \"{}\".", truncate_chars(query, 80)),
            )
        })
    }

    fn list_apps() -> Value {
        let apps = NSWorkspace::sharedWorkspace().runningApplications();
        let list: Vec<Value> = apps
            .iter()
            .filter(|app| app.activationPolicy() == NSApplicationActivationPolicy::Regular)
            .map(|app| {
                let ident = ident_of(&app);
                json!({
                    "bundleId": ident.bundle,
                    "name": truncate_chars(&ident.name, STRING_MAX_CHARS),
                    "pid": ident.pid,
                    "active": app.isActive(),
                    "hidden": app.isHidden(),
                    "path": app.bundleURL().and_then(|u| u.path()).map(|p| p.to_string()),
                })
            })
            .collect();
        json!({ "apps": list })
    }

    // ── takeover plumbing ────────────────────────────────────────────────────

    fn check_takeover(state: &ComputerState) -> Result<(), Failure> {
        lock(&state.takeover).check().map_err(Failure::from_refusal)
    }

    /// Verse visible, takeover allows it: control becomes active for `app`.
    fn begin(handle: &AppHandle, state: &ComputerState, app: &AppIdent) -> Result<(), Failure> {
        if !verse_window_present(handle) {
            return Err(Failure::new(
                ErrorCode::OperatorTookOver,
                "The Phantom window is hidden, so desktop control is paused. Ask the operator to bring Phantom back.",
            ));
        }
        let transition = lock(&state.takeover)
            .begin_action(Instant::now(), &app.name)
            .map_err(Failure::from_refusal)?;
        apply_transition(handle, transition);
        if let Err(error) = sync_hud_now(handle, state) {
            apply_transition(handle, lock(&state.takeover).kill(StateReason::Kill));
            return Err(Failure::new(
                ErrorCode::Failed,
                format!("Computer control stopped because its visible HUD or Esc stop key is unavailable: {error}"),
            ));
        }
        // An asynchronous sync or operator input may have stopped control
        // while the main thread acknowledged the HUD.
        check_takeover(state)
    }

    fn note_synth(state: &ComputerState) {
        lock(&state.takeover).note_synth(Instant::now());
    }

    // ── input events ─────────────────────────────────────────────────────────

    struct Poster {
        source: CGEventSourceRef,
    }

    impl Poster {
        fn new() -> Result<Self, Failure> {
            // SAFETY: returns a +1 event source or null.
            let source = unsafe { CGEventSourceCreate(EVENT_SOURCE_PRIVATE) };
            if source.is_null() {
                return Err(Failure::new(
                    ErrorCode::Failed,
                    "Could not create an input source.",
                ));
            }
            Ok(Self { source })
        }

        fn post(&self, event: CGEventRef, flags: u64) {
            if event.is_null() {
                return;
            }
            // SAFETY: event is a +1 CGEvent we created; released after posting.
            unsafe {
                CGEventSetFlags(event, flags);
                CGEventSetIntegerValueField(event, EVENT_SOURCE_USER_DATA, USER_DATA_TAG);
                CGEventPost(HID_EVENT_TAP, event);
                CFRelease(event as CFTypeRef);
            }
        }

        fn mouse(&self, kind: u32, at: (f64, f64), button: u32, click_state: i64, flags: u64) {
            let point = CGPoint { x: at.0, y: at.1 };
            // SAFETY: source is live; returns a +1 event or null.
            let event = unsafe { CGEventCreateMouseEvent(self.source, kind, point, button) };
            if event.is_null() {
                return;
            }
            if click_state > 0 {
                // SAFETY: event is live.
                unsafe { CGEventSetIntegerValueField(event, MOUSE_EVENT_CLICK_STATE, click_state) };
            }
            self.post(event, flags);
        }

        fn key(&self, code: u16, down: bool, flags: u64) {
            // SAFETY: source is live; returns a +1 event or null.
            let event = unsafe { CGEventCreateKeyboardEvent(self.source, code, down) };
            self.post(event, flags);
        }

        fn unicode(&self, units: &[u16]) {
            for down in [true, false] {
                // SAFETY: source is live; `units` outlives the call.
                unsafe {
                    let event = CGEventCreateKeyboardEvent(self.source, 0, down);
                    if event.is_null() {
                        return;
                    }
                    CGEventKeyboardSetUnicodeString(event, units.len(), units.as_ptr());
                    self.post(event, 0);
                }
            }
        }

        fn scroll(&self, dx: i64, dy: i64) {
            // Positive dy scrolls DOWN (like a browser's deltaY); CoreGraphics'
            // positive wheel1 scrolls up, hence the negation.
            let wheel1 = (-dy).clamp(-MAX_SCROLL, MAX_SCROLL) as i32;
            let wheel2 = (-dx).clamp(-MAX_SCROLL, MAX_SCROLL) as i32;
            // SAFETY: source is live; returns a +1 event or null.
            let event = unsafe {
                CGEventCreateScrollWheelEvent2(self.source, SCROLL_UNIT_LINE, 2, wheel1, wheel2, 0)
            };
            self.post(event, 0);
        }
    }

    impl Drop for Poster {
        fn drop(&mut self) {
            // SAFETY: we own the source.
            unsafe { CFRelease(self.source as CFTypeRef) }
        }
    }

    fn pause(ms: u64) {
        thread::sleep(Duration::from_millis(ms));
    }

    /// The app (and element) under a global point.
    struct Hit {
        app: AppIdent,
        element: Cf,
    }

    fn hit(at: (f64, f64)) -> Result<Hit, Failure> {
        let not_found = || {
            Failure::new(
                ErrorCode::NotFound,
                "Nothing accessible is under that point.",
            )
        };
        let mut element = element_at(at.0, at.1).ok_or_else(not_found)?;
        let mut pid = ax_pid(&element).ok_or_else(not_found)?;
        // The HUD floats above every app (click-through, but the hit test may
        // still land on it). Under a HUD rectangle, look through our own
        // overlay windows to the real window below — which is refused all the
        // same if it is Verse itself.
        if pid == own_pid() && in_hud(at) {
            if let Some(owner) = window_owner_below_hud(at) {
                if owner != own_pid() {
                    let app = app_element(owner).ok_or_else(not_found)?;
                    let mut below: AXUIElementRef = std::ptr::null();
                    // SAFETY: app is a live application element; the out
                    // element is +1 on success.
                    let err = unsafe {
                        AXUIElementCopyElementAtPosition(
                            app.ptr(),
                            at.0 as f32,
                            at.1 as f32,
                            &mut below,
                        )
                    };
                    element = if err == AX_SUCCESS {
                        Cf::owned(below).ok_or_else(not_found)?
                    } else {
                        app
                    };
                    pid = owner;
                }
            }
        }
        Ok(Hit {
            app: ident_for_pid(pid),
            element,
        })
    }

    /// The HUD's windows, in global (top-left origin) points.
    static HUD_RECTS: Mutex<Vec<Rect>> = Mutex::new(Vec::new());

    fn set_hud_rects(rects: Vec<Rect>) {
        *lock(&HUD_RECTS) = rects;
    }

    fn in_hud(at: (f64, f64)) -> bool {
        lock(&HUD_RECTS)
            .iter()
            .any(|r| r.contains_point(at.0, at.1))
    }

    /// The owner of the front-most on-screen window containing `at`, skipping
    /// our own overlay windows (any window of ours above the normal layer).
    fn window_owner_below_hud(at: (f64, f64)) -> Option<i32> {
        const ON_SCREEN_ONLY: u32 = 1;
        const EXCLUDE_DESKTOP: u32 = 16;
        // SAFETY: returns a +1 CFArray of CFDictionaries (or null).
        let list =
            Cf::owned(unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0) })?;
        // SAFETY: CFArray / CFDictionary are toll-free bridged with NSArray /
        // NSDictionary, and CGWindowList's dictionaries have NSString keys.
        let windows: &NSArray<NSDictionary<NSString, AnyObject>> =
            unsafe { &*(list.ptr() as *const NSArray<NSDictionary<NSString, AnyObject>>) };
        let number = |dict: &NSDictionary<NSString, AnyObject>, key: &str| -> Option<f64> {
            let value = dict.objectForKey(&ns(key))?;
            value.downcast_ref::<NSNumber>().map(|n| n.as_f64())
        };
        let own = own_pid();
        for window in windows.iter() {
            let Some(pid) = number(&window, "kCGWindowOwnerPID") else {
                continue;
            };
            let pid = pid as i32;
            let layer = number(&window, "kCGWindowLayer").unwrap_or(0.0);
            if pid == own && layer != 0.0 {
                continue;
            }
            let Some(bounds) = window.objectForKey(&ns("kCGWindowBounds")) else {
                continue;
            };
            // SAFETY: kCGWindowBounds is a CFDictionary with NSString keys.
            let bounds: &NSDictionary<NSString, AnyObject> = unsafe {
                &*(Retained::as_ptr(&bounds) as *const NSDictionary<NSString, AnyObject>)
            };
            let (Some(x), Some(y), Some(w), Some(h)) = (
                number(bounds, "X"),
                number(bounds, "Y"),
                number(bounds, "Width"),
                number(bounds, "Height"),
            ) else {
                continue;
            };
            if (Rect { x, y, w, h }).contains_point(at.0, at.1) {
                return Some(pid);
            }
        }
        None
    }

    fn authorize_hit(grants: &[Grant], hit: &Hit, action: Action) -> Result<(), Failure> {
        let titles = hit
            .app
            .bundle
            .as_deref()
            .is_some_and(is_system_settings)
            .then(|| settings_titles(hit.app.pid, Some(&hit.element)))
            .flatten();
        authorize(grants, &hit.app, own_pid(), action, titles.as_deref()).map(|_| ())
    }

    fn authorize_app(
        grants: &[Grant],
        app: &AppIdent,
        action: Action,
        element: Option<&Cf>,
    ) -> Result<(), Failure> {
        let titles = app
            .bundle
            .as_deref()
            .is_some_and(is_system_settings)
            .then(|| settings_titles(app.pid, element))
            .flatten();
        authorize(grants, app, own_pid(), action, titles.as_deref()).map(|_| ())
    }

    fn out_of_bounds() -> Failure {
        Failure::new(
            ErrorCode::OutOfBounds,
            "That point is outside the screenshot.",
        )
    }

    fn hit_result(hit: &Hit) -> Value {
        let mut value = element_json(&hit.element);
        value["app"] = hit.app.to_json();
        value
    }

    fn secure_focus(pid: i32) -> bool {
        // SAFETY: a plain Carbon query.
        let secure_input = unsafe { IsSecureEventInputEnabled() } != 0;
        secure_input || focused_element_of(pid).is_some_and(|el| is_secure(&el))
    }

    #[allow(clippy::too_many_arguments)]
    fn click(
        handle: &AppHandle,
        state: &ComputerState,
        grants: &[Grant],
        frame: &Frame,
        x: f64,
        y: f64,
        button: MouseButton,
        count: u8,
        modifiers: &[Modifier],
    ) -> OpResult {
        need_input_perms()?;
        check_takeover(state)?;
        let at = frame.screen_point(x, y).ok_or_else(out_of_bounds)?;
        let target = hit(at)?;
        authorize_hit(grants, &target, click_action(button, modifiers))?;
        let flags = modifiers.iter().fold(0u64, |f, m| f | m.flag());
        let (down, up, code) = match button {
            MouseButton::Left => (LEFT_MOUSE_DOWN, LEFT_MOUSE_UP, 0),
            MouseButton::Right => (RIGHT_MOUSE_DOWN, RIGHT_MOUSE_UP, 1),
            MouseButton::Middle => (OTHER_MOUSE_DOWN, OTHER_MOUSE_UP, 2),
        };
        begin(handle, state, &target.app)?;
        let poster = Poster::new()?;
        poster.mouse(MOUSE_MOVED, at, 0, 0, 0);
        pause(30);
        for n in 1..=i64::from(count.clamp(1, 3)) {
            poster.mouse(down, at, code, n, flags);
            poster.mouse(up, at, code, n, flags);
            pause(25);
        }
        note_synth(state);
        Ok(hit_result(&target))
    }

    fn scroll(
        handle: &AppHandle,
        state: &ComputerState,
        grants: &[Grant],
        frame: &Frame,
        at: (f64, f64),
        delta: (i64, i64),
    ) -> OpResult {
        need_input_perms()?;
        check_takeover(state)?;
        let at = frame.screen_point(at.0, at.1).ok_or_else(out_of_bounds)?;
        let target = hit(at)?;
        authorize_hit(grants, &target, Action::Scroll)?;
        begin(handle, state, &target.app)?;
        let poster = Poster::new()?;
        poster.mouse(MOUSE_MOVED, at, 0, 0, 0);
        pause(30);
        poster.scroll(delta.0, delta.1);
        note_synth(state);
        Ok(hit_result(&target))
    }

    fn drag(
        handle: &AppHandle,
        state: &ComputerState,
        grants: &[Grant],
        frame: &Frame,
        from: [f64; 2],
        to: [f64; 2],
    ) -> OpResult {
        need_input_perms()?;
        check_takeover(state)?;
        let start = frame
            .screen_point(from[0], from[1])
            .ok_or_else(out_of_bounds)?;
        let end = frame.screen_point(to[0], to[1]).ok_or_else(out_of_bounds)?;
        let source = hit(start)?;
        authorize_hit(grants, &source, Action::Drag)?;
        // The drop target must allow a drag too (dropping text onto a
        // terminal would be typing by another door).
        let target = hit(end)?;
        authorize_hit(grants, &target, Action::Drag)?;
        begin(handle, state, &source.app)?;
        let poster = Poster::new()?;
        poster.mouse(MOUSE_MOVED, start, 0, 0, 0);
        pause(30);
        poster.mouse(LEFT_MOUSE_DOWN, start, 0, 1, 0);
        pause(40);
        for point in drag_path(start, end, 10) {
            poster.mouse(LEFT_MOUSE_DRAGGED, point, 0, 1, 0);
            note_synth(state);
            pause(16);
        }
        poster.mouse(LEFT_MOUSE_UP, end, 0, 1, 0);
        note_synth(state);
        Ok(hit_result(&source))
    }

    fn type_text(
        handle: &AppHandle,
        state: &ComputerState,
        grants: &[Grant],
        text: &str,
    ) -> OpResult {
        need_input_perms()?;
        check_takeover(state)?;
        let app =
            frontmost().ok_or_else(|| Failure::new(ErrorCode::NotFound, "No app is frontmost."))?;
        let focus = focused_element_of(app.pid);
        authorize_app(grants, &app, Action::Type, focus.as_ref())?;
        if secure_focus(app.pid) {
            return Err(Failure::new(
                ErrorCode::SecureField,
                "The focused field is a password field. Agents never type into secure fields; ask the operator.",
            ));
        }
        begin(handle, state, &app)?;
        let poster = Poster::new()?;
        let mut typed = 0usize;
        for chunk in utf16_chunks(text, TYPE_CHUNK_UNITS) {
            // A takeover or kill mid-text stops at the next chunk.
            check_takeover(state)?;
            poster.unicode(&chunk);
            typed += String::from_utf16_lossy(&chunk).chars().count();
            note_synth(state);
            pause(8);
        }
        Ok(json!({ "app": app.to_json(), "chars": typed }))
    }

    fn key(handle: &AppHandle, state: &ComputerState, grants: &[Grant], keys: &str) -> OpResult {
        let combo = parse_key_combo(keys).ok_or_else(|| {
            Failure::invalid(format!(
                "Unknown key combination \"{}\".",
                truncate_chars(keys, 64)
            ))
        })?;
        need_input_perms()?;
        check_takeover(state)?;
        let app =
            frontmost().ok_or_else(|| Failure::new(ErrorCode::NotFound, "No app is frontmost."))?;
        let focus = focused_element_of(app.pid);
        authorize_app(grants, &app, Action::Key, focus.as_ref())?;
        if secure_focus(app.pid) && !key_allowed_in_secure_field(&combo) {
            return Err(Failure::new(
                ErrorCode::SecureField,
                "The focused field is a password field: only Tab, Shift+Tab and Escape are allowed there.",
            ));
        }
        begin(handle, state, &app)?;
        // A failure to create the input source must not leave our Esc stop key
        // temporarily unregistered.
        let poster = Poster::new()?;
        if combo.is_escape() {
            // Our own Escape must reach the app, not our Esc stop key.
            lock(&state.takeover).note_own_escape(Instant::now());
            release_escape_for_own_key(handle, state);
        }
        poster.key(combo.code, true, combo.flags);
        pause(12);
        poster.key(combo.code, false, combo.flags);
        note_synth(state);
        if combo.is_escape() {
            pause(60);
            sync_hud(handle);
        }
        Ok(json!({ "app": app.to_json() }))
    }

    fn ax_tree(
        state: &ComputerState,
        grants: &[Grant],
        query: &str,
        max_depth: u8,
        frame: Option<&Frame>,
    ) -> OpResult {
        need_accessibility()?;
        check_takeover(state)?;
        let app = find_app(query)?;
        authorize_app(grants, &app, Action::AxTree, None)?;
        let root = app_element(app.pid).ok_or_else(|| {
            Failure::new(
                ErrorCode::Failed,
                "Could not reach that app's accessibility tree.",
            )
        })?;
        let mut nodes = Vec::new();
        let mut refs = Vec::new();
        let mut truncated = false;
        let mut stack: Vec<(Cf, u8)> = vec![(root, 0)];
        while let Some((element, depth)) = stack.pop() {
            if nodes.len() >= MAX_NODES {
                truncated = true;
                break;
            }
            let role = ax_string(&element, "AXRole");
            let subrole = ax_string(&element, "AXSubrole");
            let secure = is_secure_element(role.as_deref(), subrole.as_deref());
            let mut node = serde_json::Map::new();
            node.insert("ref".into(), json!(format!("e{}", refs.len() + 1)));
            node.insert("depth".into(), json!(depth));
            node.insert("role".into(), json!(role));
            if let Some(subrole) = &subrole {
                node.insert("subrole".into(), json!(subrole));
            }
            if let Some(title) = ax_string(&element, "AXTitle") {
                node.insert("title".into(), json!(title));
            }
            if let Some(description) = ax_string(&element, "AXDescription") {
                node.insert("description".into(), json!(description));
            }
            // NEVER read the value of a secure field.
            if !secure {
                if let Some(value) = ax_attr(&element, "AXValue").and_then(|v| cf_to_string(&v)) {
                    let value = truncate_chars(&value, STRING_MAX_CHARS);
                    if !value.is_empty() {
                        node.insert("value".into(), json!(value));
                    }
                }
            }
            node.insert(
                "enabled".into(),
                json!(ax_bool(&element, "AXEnabled").unwrap_or(true)),
            );
            node.insert(
                "focused".into(),
                json!(ax_bool(&element, "AXFocused").unwrap_or(false)),
            );
            node.insert("secure".into(), json!(secure));
            if let Some(frame) = frame {
                if let Some(px) = ax_rect(&element).and_then(|r| frame.rect_to_pixels(r)) {
                    node.insert("frame".into(), json!(px.to_array()));
                }
            }
            if depth < max_depth {
                let children = ax_children(&element);
                for child in children.into_iter().rev() {
                    stack.push((child, depth + 1));
                }
            }
            nodes.push(Value::Object(node));
            refs.push(element);
        }
        if !stack.is_empty() {
            truncated = true;
        }
        lock(&state.refs).replace(app.pid, refs);
        Ok(json!({
            "app": app.to_json(),
            "nodes": nodes,
            "truncated": truncated,
        }))
    }

    fn resolve_ref(
        state: &ComputerState,
        query: &str,
        element: &str,
    ) -> Result<(AppIdent, Cf), Failure> {
        let app = find_app(query)?;
        let stale = || {
            Failure::new(
                ErrorCode::StaleRef,
                "That element reference is stale. Read the accessibility tree again.",
            )
        };
        let index = parse_ref(element).ok_or_else(stale)?;
        let found = lock(&state.refs).get(app.pid, index).ok_or_else(stale)?;
        if ax_pid(&found) != Some(app.pid) {
            return Err(stale());
        }
        Ok((app, found))
    }

    fn probe(
        state: &ComputerState,
        grants: &[Grant],
        frame: Option<&Frame>,
        target: &ProbeTarget,
    ) -> OpResult {
        need_accessibility()?;
        check_takeover(state)?;
        let element = match target {
            ProbeTarget::Point { x, y } => {
                let frame = frame
                    .ok_or_else(|| Failure::invalid("A point probe needs the screenshot frame."))?;
                let at = frame.screen_point(*x, *y).ok_or_else(out_of_bounds)?;
                element_at(at.0, at.1)
            }
            ProbeTarget::Ref { app, element } => Some(resolve_ref(state, app, element)?.1),
            ProbeTarget::Focus {} => focused_element(),
        };
        let Some(element) = element else {
            return Ok(json!({
                "app": null, "role": null, "subrole": null, "label": null,
                "secure": false, "windowTitle": null,
            }));
        };
        let pid = ax_pid(&element).ok_or_else(|| {
            Failure::new(
                ErrorCode::NotFound,
                "Could not tell which app owns that element.",
            )
        })?;
        let app = ident_for_pid(pid);
        authorize_app(grants, &app, Action::AxTree, Some(&element))?;
        let role = ax_string(&element, "AXRole");
        let subrole = ax_string(&element, "AXSubrole");
        Ok(json!({
            "app": app.to_json(),
            "secure": is_secure_element(role.as_deref(), subrole.as_deref()),
            "role": role,
            "subrole": subrole,
            "label": label_of(&element),
            "windowTitle": window_title_of(&element),
        }))
    }

    fn ax_press(
        handle: &AppHandle,
        state: &ComputerState,
        grants: &[Grant],
        query: &str,
        element: &str,
    ) -> OpResult {
        need_accessibility()?;
        check_takeover(state)?;
        let (app, target) = resolve_ref(state, query, element)?;
        authorize_app(grants, &app, Action::AxPress, Some(&target))?;
        begin(handle, state, &app)?;
        let action = ns("AXPress");
        // SAFETY: target is a live AXUIElementRef, action a live CFString.
        let err = unsafe { AXUIElementPerformAction(target.ptr(), cf_of(&action)) };
        note_synth(state);
        if err != AX_SUCCESS {
            return Err(Failure::new(
                ErrorCode::Failed,
                format!("The app refused the press (AX error {err})."),
            ));
        }
        let mut value = element_json(&target);
        value["app"] = app.to_json();
        Ok(value)
    }

    fn open_settings(kind: SettingsKind) {
        match std::process::Command::new("/usr/bin/open")
            .arg(kind.url())
            .spawn()
        {
            Ok(mut child) => {
                let _ = thread::Builder::new()
                    .name("ashlr-computer-open".into())
                    .spawn(move || {
                        let _ = child.wait();
                    });
            }
            Err(e) => eprintln!("[ashlr-desktop] could not open System Settings: {e}"),
        }
    }

    // ── dispatch ─────────────────────────────────────────────────────────────

    pub fn run(handle: &AppHandle, state: &ComputerState, request: ComputerRequest) {
        autoreleasepool(|_| run_inner(handle, state, request));
    }

    fn run_inner(handle: &AppHandle, state: &ComputerState, request: ComputerRequest) {
        use ComputerRequest as R;
        let answer =
            |req: &str, outcome: OpResult| emit(handle, &ComputerEvent::result(req, outcome));
        match request {
            R::Permissions { req } => answer(&req, Ok(perms_json())),
            R::RequestPermission { req, kind } => answer(&req, Ok(request_permission(kind))),
            R::OpenSettings { kind } => open_settings(kind),
            R::ListApps { req } => answer(&req, Ok(list_apps())),
            R::Screenshot {
                req,
                grants,
                app,
                display,
                scale,
            } => {
                let reply = Reply::new(handle, &req);
                let request = capture::Request {
                    grants,
                    only_app: app,
                    display,
                    scale: scale.unwrap_or(1.0),
                    zoom: None,
                };
                start_capture(state, request, reply);
            }
            R::Zoom {
                req,
                grants,
                frame,
                region,
            } => {
                let reply = Reply::new(handle, &req);
                let Some(rect) = region_screen_point(&frame, region) else {
                    reply.send(Err(Failure::new(
                        ErrorCode::OutOfBounds,
                        "The zoom region must be a non-empty rectangle inside the screenshot.",
                    )));
                    return;
                };
                let request = capture::Request {
                    grants,
                    only_app: None,
                    display: Some(frame.display),
                    scale: 1.0,
                    zoom: Some(rect),
                };
                start_capture(state, request, reply);
            }
            R::AxTree {
                req,
                grants,
                app,
                max_depth,
                frame,
            } => answer(
                &req,
                ax_tree(state, &grants, &app, max_depth, frame.as_ref()),
            ),
            R::Probe {
                req,
                grants,
                frame,
                target,
            } => answer(&req, probe(state, &grants, frame.as_ref(), &target)),
            R::AxPress {
                req,
                grants,
                app,
                element,
            } => answer(&req, ax_press(handle, state, &grants, &app, &element)),
            R::Click {
                req,
                grants,
                frame,
                x,
                y,
                button,
                count,
                modifiers,
            } => answer(
                &req,
                click(
                    handle, state, &grants, &frame, x, y, button, count, &modifiers,
                ),
            ),
            R::Type { req, grants, text } => answer(&req, type_text(handle, state, &grants, &text)),
            R::Key { req, grants, keys } => answer(&req, key(handle, state, &grants, &keys)),
            R::Scroll {
                req,
                grants,
                frame,
                x,
                y,
                dx,
                dy,
            } => answer(
                &req,
                scroll(handle, state, &grants, &frame, (x, y), (dx, dy)),
            ),
            R::Drag {
                req,
                grants,
                frame,
                from,
                to,
            } => answer(&req, drag(handle, state, &grants, &frame, from, to)),
            // Handled on the listener thread (see `handle_event`).
            R::Resume {} | R::Kill {} | R::Arm {} => {}
        }
    }

    fn start_capture(state: &ComputerState, request: capture::Request, reply: Reply) {
        if let Err(failure) = need_screen().and_then(|()| check_takeover(state)) {
            reply.send(Err(failure));
            return;
        }
        reply.arm_timeout(CAPTURE_TIMEOUT);
        let frontmost_pid = frontmost().map(|a| a.pid);
        let done = reply.clone();
        if let Err(failure) =
            capture::start(request, frontmost_pid, move |outcome| done.send(outcome))
        {
            reply.send(Err(failure));
        }
    }

    // ── ScreenCaptureKit ─────────────────────────────────────────────────────

    mod capture {
        use super::*;

        pub struct Request {
            pub grants: Vec<Grant>,
            pub only_app: Option<String>,
            pub display: Option<u32>,
            pub scale: f64,
            /// A zoom: the global-points rectangle to capture.
            pub zoom: Option<Rect>,
        }

        const SCK_PATH: &std::ffi::CStr =
            c"/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit";

        /// Load ScreenCaptureKit once, at first use (never linked: the app's
        /// minimum macOS predates it).
        fn load() -> bool {
            static LOADED: OnceLock<bool> = OnceLock::new();
            *LOADED.get_or_init(|| {
                // SAFETY: a constant, NUL-terminated system path.
                let handle = unsafe { libc::dlopen(SCK_PATH.as_ptr(), libc::RTLD_LAZY) };
                !handle.is_null()
            })
        }

        fn class(name: &std::ffi::CStr) -> Option<&'static AnyClass> {
            AnyClass::get(name)
        }

        fn unsupported() -> Failure {
            Failure::new(
                ErrorCode::Unsupported,
                "Screenshots need macOS 14 or later (ScreenCaptureKit).",
            )
        }

        type Done = Box<dyn FnOnce(OpResult) + Send>;

        pub fn start(
            request: Request,
            frontmost_pid: Option<i32>,
            done: impl FnOnce(OpResult) + Send + 'static,
        ) -> Result<(), Failure> {
            if !load() {
                return Err(unsupported());
            }
            let (Some(content_class), Some(_), Some(_), Some(_)) = (
                class(c"SCShareableContent"),
                class(c"SCContentFilter"),
                class(c"SCStreamConfiguration"),
                class(c"SCScreenshotManager"),
            ) else {
                return Err(unsupported());
            };
            let slot: Mutex<Option<(Request, Done)>> = Mutex::new(Some((request, Box::new(done))));
            let block = RcBlock::new(move |content: *mut AnyObject, _error: *mut NSError| {
                let taken = match slot.lock() {
                    Ok(mut guard) => guard.take(),
                    Err(poisoned) => poisoned.into_inner().take(),
                };
                let Some((request, done)) = taken else {
                    return;
                };
                autoreleasepool(|_| {
                    // SAFETY: ScreenCaptureKit passes a valid object or nil.
                    let Some(content) = (unsafe { content.as_ref() }) else {
                        done(Err(Failure::new(
                            ErrorCode::NoPermission,
                            "macOS refused the screen capture (Screen Recording permission).",
                        )));
                        return;
                    };
                    if let Err((failure, done)) =
                        with_content(content, request, frontmost_pid, done)
                    {
                        done(Err(failure));
                    }
                });
            });
            // SAFETY: the selector and block signature match
            // +[SCShareableContent getShareableContentExcludingDesktopWindows:
            // onScreenWindowsOnly:completionHandler:]; the block is copied by
            // the callee.
            unsafe {
                let _: () = msg_send![
                    content_class,
                    getShareableContentExcludingDesktopWindows: true,
                    onScreenWindowsOnly: true,
                    completionHandler: &*block
                ];
            }
            Ok(())
        }

        struct Display {
            object: Retained<AnyObject>,
            id: u32,
            frame: Rect,
        }

        fn string_prop(object: &AnyObject, selector: &str) -> Option<String> {
            // SAFETY: each selector passed is an NSString-returning property
            // of the SCK object it is sent to.
            let value: Option<Retained<NSString>> = unsafe {
                match selector {
                    "bundleIdentifier" => msg_send![object, bundleIdentifier],
                    "applicationName" => msg_send![object, applicationName],
                    _ => None,
                }
            };
            value.map(|s| s.to_string()).filter(|s| !s.is_empty())
        }

        fn array_prop(object: &AnyObject, selector: &str) -> Vec<Retained<AnyObject>> {
            // SAFETY: each selector is an NSArray-returning property of
            // SCShareableContent.
            let value: Option<Retained<NSArray<AnyObject>>> = unsafe {
                match selector {
                    "displays" => msg_send![object, displays],
                    "windows" => msg_send![object, windows],
                    "applications" => msg_send![object, applications],
                    _ => None,
                }
            };
            value.map(|a| a.to_vec()).unwrap_or_default()
        }

        fn rect_of(object: &AnyObject) -> Rect {
            // SAFETY: SCDisplay and SCWindow both have `@property CGRect frame`.
            let r: NSRect = unsafe { msg_send![object, frame] };
            Rect {
                x: r.origin.x,
                y: r.origin.y,
                w: r.size.width,
                h: r.size.height,
            }
        }

        fn displays(content: &AnyObject) -> Vec<Display> {
            array_prop(content, "displays")
                .into_iter()
                .map(|object| {
                    // SAFETY: SCDisplay has `@property CGDirectDisplayID displayID`.
                    let id: u32 = unsafe { msg_send![&*object, displayID] };
                    let frame = rect_of(&object);
                    Display { object, id, frame }
                })
                .collect()
        }

        /// Backing pixels per point for a display (1.0 when unknown).
        fn pixel_ratio(display: &Display) -> f64 {
            // SAFETY: CGDisplayCopyDisplayMode returns a +1 mode or null,
            // released below.
            unsafe {
                let mode = CGDisplayCopyDisplayMode(display.id);
                if mode.is_null() {
                    return 1.0;
                }
                let pixels = CGDisplayModeGetPixelWidth(mode) as f64;
                let _ = CGDisplayModeGetPixelHeight(mode);
                CGDisplayModeRelease(mode);
                let ratio = pixels / display.frame.w;
                if ratio.is_finite() && ratio >= 1.0 {
                    ratio
                } else {
                    1.0
                }
            }
        }

        struct Included {
            object: Retained<AnyObject>,
            pid: i32,
            bundle: String,
            name: String,
        }

        #[allow(clippy::type_complexity)]
        fn with_content(
            content: &AnyObject,
            request: Request,
            frontmost_pid: Option<i32>,
            done: Done,
        ) -> Result<(), (Failure, Done)> {
            let own = own_pid();
            // The apps whose windows may appear: effective-granted, never
            // denied, never us; System Settings only when its window is not a
            // denied pane (unreadable counts as denied).
            let mut included: Vec<Included> = Vec::new();
            let mut only_found = false;
            for object in array_prop(content, "applications") {
                // SAFETY: SCRunningApplication has `@property pid_t processID`.
                let pid: i32 = unsafe { msg_send![&*object, processID] };
                let bundle = string_prop(&object, "bundleIdentifier");
                let name = string_prop(&object, "applicationName")
                    .or_else(|| bundle.clone())
                    .unwrap_or_default();
                if let Some(query) = &request.only_app {
                    let hit = bundle
                        .as_deref()
                        .is_some_and(|b| b.eq_ignore_ascii_case(query))
                        || name.to_lowercase() == query.to_lowercase();
                    if !hit {
                        continue;
                    }
                    only_found = true;
                }
                if pid == own || pid <= 0 {
                    continue;
                }
                let executable = executable_path(pid);
                let action = if request.zoom.is_some() {
                    Action::Zoom
                } else {
                    Action::Screenshot
                };
                let allowed =
                    effective_tier(&request.grants, bundle.as_deref(), executable.as_deref())
                        .is_some_and(|tier| tier_allows(tier, action));
                if !allowed {
                    continue;
                }
                let Some(bundle) = bundle else { continue };
                if is_system_settings(&bundle) {
                    let blocked = match settings_titles(pid, None) {
                        None => true,
                        Some(titles) => titles.iter().any(|t| is_denied_settings_title(t)),
                    };
                    if blocked {
                        continue;
                    }
                }
                included.push(Included {
                    object,
                    pid,
                    bundle,
                    name,
                });
            }
            if included.is_empty() {
                let failure = match (&request.only_app, only_found) {
                    (Some(query), false) => Failure::new(
                        ErrorCode::NotFound,
                        format!("No running app matches \"{}\".", truncate_chars(query, 80)),
                    ),
                    (Some(query), true) => Failure::new(
                        ErrorCode::NotGranted,
                        format!(
                            "{} is not granted to this chat (or is off limits).",
                            truncate_chars(query, 80)
                        ),
                    ),
                    (None, _) => Failure::new(
                        ErrorCode::NotGranted,
                        "None of the apps granted to this chat is running with a window.",
                    ),
                };
                return Err((failure, done));
            }

            let displays = displays(content);
            if displays.is_empty() {
                return Err((
                    Failure::new(ErrorCode::Failed, "No display to capture."),
                    done,
                ));
            }
            let index = match request.display {
                Some(i) if (i as usize) < displays.len() => i as usize,
                Some(_) => {
                    return Err((
                        Failure::new(ErrorCode::NotFound, "There is no display with that index."),
                        done,
                    ))
                }
                None => default_display(content, &displays, &included, frontmost_pid),
            };
            let display = &displays[index];
            let ratio = pixel_ratio(display);

            let (source, out_w, out_h) = match request.zoom {
                Some(rect) => {
                    let Some(local) = to_display_local(rect, display.frame) else {
                        return Err((
                            Failure::new(
                                ErrorCode::OutOfBounds,
                                "The zoom region is not on that display.",
                            ),
                            done,
                        ));
                    };
                    let (w, h) = fit_size(
                        local.w * ratio,
                        local.h * ratio,
                        FIT_MAX_WIDTH,
                        FIT_MAX_HEIGHT,
                    );
                    (Some(local), w, h)
                }
                None => {
                    let scale = request.scale.clamp(0.25, 1.0);
                    let (w, h) = fit_size(
                        display.frame.w * ratio,
                        display.frame.h * ratio,
                        FIT_MAX_WIDTH * scale,
                        FIT_MAX_HEIGHT * scale,
                    );
                    (None, w, h)
                }
            };

            let apps: Vec<Retained<AnyObject>> =
                included.iter().map(|i| i.object.clone()).collect();
            let apps_json: Vec<Value> = included
                .iter()
                .map(|i| json!({ "bundleId": i.bundle, "name": truncate_chars(&i.name, STRING_MAX_CHARS) }))
                .collect();
            let apps_array = NSArray::<AnyObject>::from_retained_slice(&apps);
            let no_windows = NSArray::<AnyObject>::new();
            let (Some(filter_class), Some(config_class), Some(manager_class)) = (
                class(c"SCContentFilter"),
                class(c"SCStreamConfiguration"),
                class(c"SCScreenshotManager"),
            ) else {
                return Err((unsupported(), done));
            };
            // SAFETY: selectors and argument types match SCContentFilter /
            // SCStreamConfiguration (CGRect sourceRect, size_t width/height,
            // BOOL showsCursor); every object is live for the call.
            let (filter, config) = unsafe {
                let alloc: Allocated<AnyObject> = msg_send![filter_class, alloc];
                let filter: Option<Retained<AnyObject>> = msg_send![
                    alloc,
                    initWithDisplay: &*display.object,
                    includingApplications: &*apps_array,
                    exceptingWindows: &*no_windows
                ];
                let config: Option<Retained<AnyObject>> = msg_send![config_class, new];
                (filter, config)
            };
            let (Some(filter), Some(config)) = (filter, config) else {
                return Err((
                    Failure::new(ErrorCode::Failed, "Could not set up the capture."),
                    done,
                ));
            };
            // SAFETY: see above.
            unsafe {
                let _: () = msg_send![&*config, setWidth: out_w as usize];
                let _: () = msg_send![&*config, setHeight: out_h as usize];
                let _: () = msg_send![&*config, setShowsCursor: request.zoom.is_none()];
                if let Some(local) = source {
                    let rect = NSRect::new(
                        objc2_foundation::NSPoint::new(local.x, local.y),
                        objc2_foundation::NSSize::new(local.w, local.h),
                    );
                    let _: () = msg_send![&*config, setSourceRect: rect];
                }
            }

            let frame = capture_frame(index as u32, display.frame, out_w, out_h);
            let zoom = request.zoom.is_some();
            let slot: Mutex<Option<Done>> = Mutex::new(Some(done));
            let block = RcBlock::new(move |image: *mut CGImage, _error: *mut NSError| {
                let taken = match slot.lock() {
                    Ok(mut guard) => guard.take(),
                    Err(poisoned) => poisoned.into_inner().take(),
                };
                let Some(done) = taken else {
                    return;
                };
                autoreleasepool(|_| {
                    let outcome = encode(image).map(|shot| {
                        use base64::Engine;
                        let mut data = json!({
                            "mime": shot.mime,
                            "base64": base64::engine::general_purpose::STANDARD.encode(&shot.bytes),
                            "width": shot.width,
                            "height": shot.height,
                        });
                        if !zoom {
                            data["frame"] = json!(frame);
                            data["display"] = json!(frame.display);
                            data["apps"] = json!(apps_json);
                        }
                        data
                    });
                    done(outcome);
                });
            });
            // SAFETY: +[SCScreenshotManager captureImageWithFilter:
            // configuration:completionHandler:] (macOS 14+, class checked
            // above); the block matches `void (^)(CGImageRef, NSError *)`.
            unsafe {
                let _: () = msg_send![
                    manager_class,
                    captureImageWithFilter: &*filter,
                    configuration: &*config,
                    completionHandler: &*block
                ];
            }
            Ok(())
        }

        /// The display holding the frontmost granted app's window, else the
        /// first granted app's window, else the main display.
        fn default_display(
            content: &AnyObject,
            displays: &[Display],
            included: &[Included],
            frontmost_pid: Option<i32>,
        ) -> usize {
            let windows: Vec<(i32, Rect)> = array_prop(content, "windows")
                .into_iter()
                .filter_map(|window| {
                    // SAFETY: SCWindow has `owningApplication` (nullable),
                    // `windowLayer` (NSInteger) and `isOnScreen` (BOOL).
                    let (owner, layer, on_screen): (Option<Retained<AnyObject>>, isize, bool) = unsafe {
                        (
                            msg_send![&*window, owningApplication],
                            msg_send![&*window, windowLayer],
                            msg_send![&*window, isOnScreen],
                        )
                    };
                    let owner = owner?;
                    // SAFETY: SCRunningApplication.processID.
                    let pid: i32 = unsafe { msg_send![&*owner, processID] };
                    (layer == 0 && on_screen).then(|| (pid, rect_of(&window)))
                })
                .collect();
            let display_of = |rect: &Rect| {
                let (cx, cy) = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0);
                displays.iter().position(|d| d.frame.contains_point(cx, cy))
            };
            let granted = |pid: i32| included.iter().any(|i| i.pid == pid);
            if let Some(front) = frontmost_pid.filter(|p| granted(*p)) {
                if let Some(index) = windows
                    .iter()
                    .find(|(pid, _)| *pid == front)
                    .and_then(|(_, r)| display_of(r))
                {
                    return index;
                }
            }
            if let Some(index) = windows
                .iter()
                .filter(|(pid, _)| granted(*pid))
                .find_map(|(_, r)| display_of(r))
            {
                return index;
            }
            // SAFETY: a plain CoreGraphics query.
            let main = unsafe { CGMainDisplayID() };
            displays.iter().position(|d| d.id == main).unwrap_or(0)
        }

        struct Shot {
            mime: &'static str,
            bytes: Vec<u8>,
            width: isize,
            height: isize,
        }

        /// CGImage → PNG (JPEG q0.8 above 4 MB), like the browser pane.
        fn encode(image: *mut CGImage) -> OpResult2<Shot> {
            const PNG_MAX_BYTES: usize = 4 * 1024 * 1024;
            let failed = || Failure::new(ErrorCode::Failed, "The capture produced no image.");
            if image.is_null() {
                return Err(failed());
            }
            // SAFETY: image is a live CGImage for the duration of the
            // completion handler; initWithCGImage: retains what it needs.
            let rep: Option<Retained<NSBitmapImageRep>> =
                unsafe { msg_send![NSBitmapImageRep::alloc(), initWithCGImage: image] };
            let rep = rep.ok_or_else(failed)?;
            let (width, height) = (rep.pixelsWide(), rep.pixelsHigh());
            let none = NSDictionary::<NSString, AnyObject>::new();
            // SAFETY: an empty properties dictionary is always valid.
            let png = unsafe {
                rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &none)
            }
            .ok_or_else(failed)?;
            if png.len() <= PNG_MAX_BYTES {
                return Ok(Shot {
                    mime: "image/png",
                    bytes: png.to_vec(),
                    width,
                    height,
                });
            }
            let quality = NSNumber::new_f64(0.8);
            let quality: &AnyObject = &quality;
            // SAFETY: NSImageCompressionFactor is an AppKit NSString constant.
            let key: &NSString = unsafe { NSImageCompressionFactor };
            let properties = NSDictionary::<NSString, AnyObject>::from_slices(&[key], &[quality]);
            // SAFETY: documented property dictionary for JPEG.
            let jpeg = unsafe {
                rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties)
            }
            .ok_or_else(failed)?;
            Ok(Shot {
                mime: "image/jpeg",
                bytes: jpeg.to_vec(),
                width,
                height,
            })
        }

        type OpResult2<T> = Result<T, Failure>;
    }

    // ── HUD ──────────────────────────────────────────────────────────────────

    pub mod hud {
        //! The always-on-top "an agent is driving" border + pill. Main thread
        //! only (every entry point is called from `run_on_main_thread`); the
        //! windows live in a thread-local so they never cross threads.

        use std::cell::RefCell;

        use objc2::{msg_send, rc::Retained, runtime::AnyObject, MainThreadMarker, MainThreadOnly};
        use objc2_app_kit::{
            NSBackingStoreType, NSColor, NSFont, NSPopUpMenuWindowLevel, NSScreen, NSTextField,
            NSWindow, NSWindowCollectionBehavior, NSWindowSharingType, NSWindowStyleMask,
        };
        use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

        use super::CGColor;
        use crate::browser_pane::truncate_chars;
        use crate::computer::{cocoa_to_global, Rect};

        const BORDER: f64 = 5.0;
        const PILL_HEIGHT: f64 = 28.0;
        const PILL_PADDING: f64 = 14.0;

        thread_local! {
            static WINDOWS: RefCell<Vec<Retained<NSWindow>>> = const { RefCell::new(Vec::new()) };
        }

        fn orange() -> Retained<NSColor> {
            // #FF7A1A
            NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 122.0 / 255.0, 26.0 / 255.0, 1.0)
        }

        fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
            NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
        }

        fn window(
            mtm: MainThreadMarker,
            frame: NSRect,
            background: &NSColor,
        ) -> Retained<NSWindow> {
            // SAFETY: a plain borderless window created on the main thread.
            let window = unsafe {
                NSWindow::initWithContentRect_styleMask_backing_defer(
                    NSWindow::alloc(mtm),
                    frame,
                    NSWindowStyleMask::Borderless,
                    NSBackingStoreType::Buffered,
                    false,
                )
            };
            // SAFETY: we keep our own strong reference; closing must not free it.
            unsafe { window.setReleasedWhenClosed(false) };
            window.setOpaque(false);
            window.setHasShadow(false);
            window.setBackgroundColor(Some(background));
            window.setIgnoresMouseEvents(true);
            window.setLevel(NSPopUpMenuWindowLevel + 1);
            // Never in a screenshot or a screen share.
            window.setSharingType(NSWindowSharingType::None);
            window.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
            window
        }

        pub fn hide() {
            super::set_hud_rects(Vec::new());
            WINDOWS.with(|cell| {
                for window in cell.borrow_mut().drain(..) {
                    window.orderOut(None);
                    window.close();
                }
            });
        }

        pub fn show(app_name: &str) -> bool {
            let Some(mtm) = MainThreadMarker::new() else {
                return false;
            };
            hide();
            let color = orange();
            let mut windows = Vec::new();
            let screens = NSScreen::screens(mtm);
            if screens.is_empty() {
                return false;
            }
            // AppKit frames are bottom-left based on the primary screen;
            // hit tests use top-left global points.
            let primary_height = screens.iter().next().map_or(0.0, |s| s.frame().size.height);
            for (index, screen) in screens.iter().enumerate() {
                let f = screen.frame();
                let (x, y, w, h) = (f.origin.x, f.origin.y, f.size.width, f.size.height);
                for edge in [
                    rect(x, y + h - BORDER, w, BORDER),
                    rect(x, y, w, BORDER),
                    rect(x, y, BORDER, h),
                    rect(x + w - BORDER, y, BORDER, h),
                ] {
                    windows.push(window(mtm, edge, &color));
                }
                // The pill on the menu-bar screen (the first one).
                if index == 0 {
                    let visible = screen.visibleFrame();
                    let text = format!(
                        "Agent controlling {} \u{2014} Esc to stop",
                        truncate_chars(app_name, 40)
                    );
                    let label = NSTextField::labelWithString(&NSString::from_str(&text), mtm);
                    label.setTextColor(Some(&NSColor::whiteColor()));
                    label.setFont(Some(&NSFont::boldSystemFontOfSize(13.0)));
                    label.sizeToFit();
                    let size = label.frame().size;
                    let pill_w = (size.width + PILL_PADDING * 2.0).min(w - 40.0).max(80.0);
                    let pill_x = x + (w - pill_w) / 2.0;
                    let pill_y = visible.origin.y + visible.size.height - PILL_HEIGHT - 8.0;
                    let pill = window(
                        mtm,
                        rect(pill_x, pill_y, pill_w, PILL_HEIGHT),
                        &NSColor::clearColor(),
                    );
                    if let Some(content) = pill.contentView() {
                        content.setWantsLayer(true);
                        // SAFETY: a layer-backed view has a CALayer; the
                        // CGColor is owned by `color`, which outlives the call
                        // (CALayer retains what it keeps).
                        unsafe {
                            let layer: Option<Retained<AnyObject>> = msg_send![&*content, layer];
                            if let Some(layer) = layer {
                                let cg: *mut CGColor = msg_send![&*color, CGColor];
                                let _: () = msg_send![&*layer, setBackgroundColor: cg];
                                let _: () = msg_send![&*layer, setCornerRadius: PILL_HEIGHT / 2.0];
                            }
                        }
                        label.setFrameOrigin(NSPoint::new(
                            (pill_w - size.width) / 2.0,
                            (PILL_HEIGHT - size.height) / 2.0,
                        ));
                        content.addSubview(&label);
                    }
                    windows.push(pill);
                }
            }
            let rects = windows
                .iter()
                .map(|w| {
                    let f = w.frame();
                    cocoa_to_global(
                        Rect {
                            x: f.origin.x,
                            y: f.origin.y,
                            w: f.size.width,
                            h: f.size.height,
                        },
                        primary_height,
                    )
                })
                .collect();
            super::set_hud_rects(rects);
            for window in &windows {
                window.orderFrontRegardless();
            }
            WINDOWS.with(|cell| *cell.borrow_mut() = windows);
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_ui_never_reports_ready_without_a_stop_key_and_visible_hud() {
        use std::{cell::RefCell, rc::Rc};

        let mut applied = HudApplied::default();
        let calls = Rc::new(RefCell::new(Vec::new()));
        let stop_calls = calls.clone();
        let show_calls = calls.clone();
        assert!(reconcile_hud(
            &mut applied,
            Some("TextEdit".into()),
            move |_| {
                stop_calls.borrow_mut().push("register");
                Err("Esc unavailable".into())
            },
            move |_| {
                show_calls.borrow_mut().push("show");
                Ok(())
            },
        )
        .is_err());
        assert_eq!(&*calls.borrow(), &["register"]);
        assert!(!applied.escape_registered);
        assert!(applied.app.is_none());

        calls.borrow_mut().clear();
        let stop_calls = calls.clone();
        let show_calls = calls.clone();
        assert!(reconcile_hud(
            &mut applied,
            Some("TextEdit".into()),
            move |_| {
                stop_calls.borrow_mut().push("register");
                Ok(())
            },
            move |_| {
                show_calls.borrow_mut().push("show");
                Err("HUD unavailable".into())
            },
        )
        .is_err());
        assert_eq!(&*calls.borrow(), &["register", "show"]);
        assert!(applied.escape_registered);
        assert!(applied.app.is_none());

        calls.borrow_mut().clear();
        let stop_calls = calls.clone();
        let show_calls = calls.clone();
        reconcile_hud(
            &mut applied,
            Some("TextEdit".into()),
            move |_| {
                stop_calls.borrow_mut().push("register");
                Ok(())
            },
            move |_| {
                show_calls.borrow_mut().push("show");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(&*calls.borrow(), &["show"]);
        assert!(applied.escape_registered);
        assert_eq!(applied.app.as_deref(), Some("TextEdit"));
    }

    fn parse(json: &str) -> Option<ComputerRequest> {
        parse_request(json).ok()
    }

    const G: &str = r#"[{"bundleId":"com.apple.TextEdit","tier":"full"}]"#;
    const F: &str =
        r#"{"display":0,"originX":0,"originY":0,"width":1280,"height":800,"scale":1.35}"#;

    fn frame() -> Frame {
        Frame {
            display: 0,
            origin_x: 100.0,
            origin_y: 50.0,
            width: 1000.0,
            height: 500.0,
            scale: 2.0,
        }
    }

    fn grant(bundle: &str, tier: Tier) -> Grant {
        Grant {
            bundle_id: bundle.into(),
            tier,
        }
    }

    fn ident(pid: i32, bundle: Option<&str>, name: &str) -> AppIdent {
        AppIdent {
            pid,
            bundle: bundle.map(str::to_string),
            name: name.into(),
            executable: None,
        }
    }

    // ── parsing ──────────────────────────────────────────────────────────────

    #[test]
    fn every_op_parses() {
        let cases = [
            r#"{"op":"permissions","req":"r1"}"#.to_string(),
            r#"{"op":"request-permission","req":"r1","kind":"screen"}"#.to_string(),
            r#"{"op":"request-permission","req":"r1","kind":"accessibility"}"#.to_string(),
            r#"{"op":"request-permission","req":"r1","kind":"post-events"}"#.to_string(),
            r#"{"op":"open-settings","kind":"screen"}"#.to_string(),
            r#"{"op":"open-settings","kind":"accessibility"}"#.to_string(),
            r#"{"op":"list-apps","req":"cc_abc-DEF_123"}"#.to_string(),
            format!(r#"{{"op":"screenshot","req":"r1","grants":{G}}}"#),
            format!(
                r#"{{"op":"screenshot","req":"r1","grants":{G},"app":"TextEdit","display":1,"scale":0.5}}"#
            ),
            format!(r#"{{"op":"zoom","req":"r1","grants":{G},"frame":{F},"region":[0,0,100,50]}}"#),
            format!(
                r#"{{"op":"ax-tree","req":"r1","grants":{G},"app":"com.apple.TextEdit","maxDepth":6}}"#
            ),
            format!(
                r#"{{"op":"ax-tree","req":"r1","grants":{G},"app":"TextEdit","maxDepth":12,"frame":{F}}}"#
            ),
            format!(
                r#"{{"op":"probe","req":"r1","grants":{G},"frame":{F},"target":{{"kind":"point","x":5,"y":6}}}}"#
            ),
            format!(
                r#"{{"op":"probe","req":"r1","grants":{G},"target":{{"kind":"ref","app":"TextEdit","ref":"e12"}}}}"#
            ),
            format!(r#"{{"op":"probe","req":"r1","grants":{G},"target":{{"kind":"focus"}}}}"#),
            format!(r#"{{"op":"ax-press","req":"r1","grants":{G},"app":"TextEdit","ref":"e3"}}"#),
            format!(
                r#"{{"op":"click","req":"r1","grants":{G},"frame":{F},"x":10,"y":20,"button":"left","count":2,"modifiers":["cmd","shift","option","ctrl","fn"]}}"#
            ),
            format!(r#"{{"op":"type","req":"r1","grants":{G},"text":"hello"}}"#),
            format!(r#"{{"op":"key","req":"r1","grants":{G},"keys":"cmd+shift+t"}}"#),
            format!(
                r#"{{"op":"scroll","req":"r1","grants":{G},"frame":{F},"x":1,"y":2,"dx":0,"dy":-3}}"#
            ),
            format!(
                r#"{{"op":"drag","req":"r1","grants":{G},"frame":{F},"from":[1,2],"to":[30,40]}}"#
            ),
            r#"{"op":"resume"}"#.to_string(),
            r#"{"op":"kill"}"#.to_string(),
            r#"{"op":"arm"}"#.to_string(),
        ];
        for case in &cases {
            assert!(parse(case).is_some(), "should parse: {case}");
        }
        assert_eq!(
            parse(&format!(
                r#"{{"op":"ax-press","req":"r1","grants":{G},"app":"TextEdit","ref":"e3"}}"#
            )),
            Some(ComputerRequest::AxPress {
                req: "r1".into(),
                grants: vec![grant("com.apple.TextEdit", Tier::Full)],
                app: "TextEdit".into(),
                element: "e3".into(),
            })
        );
        let Some(ComputerRequest::Zoom { frame, .. }) = parse(&format!(
            r#"{{"op":"zoom","req":"r1","grants":[],"frame":{F},"region":[0,0,1,1]}}"#
        )) else {
            panic!("zoom")
        };
        assert_eq!(frame.scale, 1.35);
        assert_eq!(frame.width, 1280.0);
    }

    #[test]
    fn unknown_ops_fields_and_shapes_are_rejected() {
        for case in [
            r#"{"op":"eval","req":"r1","js":"x"}"#.to_string(),
            r#"{"op":"permissions","req":"r1","extra":1}"#.to_string(),
            r#"{"op":"kill","req":"r1"}"#.to_string(),
            r#"{"op":"open-settings","kind":"camera"}"#.to_string(),
            r#"{"op":"open-settings","kind":"screen","url":"file:///"}"#.to_string(),
            r#"{"op":"request-permission","req":"r1","kind":"microphone"}"#.to_string(),
            r#"{"op":"screenshot","req":"r1","grants":[{"bundleId":"a.b","tier":"root"}]}"#
                .to_string(),
            r#"{"op":"screenshot","req":"r1","grants":[{"bundleId":"a.b","tier":"read","x":1}]}"#
                .to_string(),
            format!(
                r#"{{"op":"click","req":"r1","grants":{G},"frame":{F},"x":1,"y":2,"button":"left","count":1,"modifiers":["hyper"]}}"#
            ),
            format!(
                r#"{{"op":"click","req":"r1","grants":{G},"frame":{F},"x":1,"y":2,"button":"back","count":1,"modifiers":[]}}"#
            ),
            format!(
                r#"{{"op":"click","req":"r1","grants":{G},"frame":{F},"x":1,"y":2,"button":"left","modifiers":[]}}"#
            ),
            format!(
                r#"{{"op":"zoom","req":"r1","grants":{G},"frame":{{"display":0,"originX":0,"originY":0,"width":1,"height":1,"scale":1,"z":0}},"region":[0,0,1,1]}}"#
            ),
            format!(r#"{{"op":"zoom","req":"r1","grants":{G},"frame":{F},"region":[0,0,1]}}"#),
            format!(r#"{{"op":"probe","req":"r1","grants":{G},"target":{{"kind":"window"}}}}"#),
            format!(
                r#"{{"op":"probe","req":"r1","grants":{G},"target":{{"kind":"focus","x":1}}}}"#
            ),
            r#"{"req":"r1"}"#.to_string(),
            r#"["kill"]"#.to_string(),
            r#""kill""#.to_string(),
            "not json".to_string(),
        ] {
            assert!(parse(&case).is_none(), "should reject: {case}");
        }
    }

    #[test]
    fn values_out_of_range_are_rejected() {
        let long_text = "a".repeat(MAX_TEXT_CHARS + 1);
        let long_keys = "a".repeat(MAX_KEYS_CHARS + 1);
        let too_many: Vec<String> = (0..=MAX_GRANTS)
            .map(|i| format!(r#"{{"bundleId":"a.b{i}","tier":"read"}}"#))
            .collect();
        let too_many = format!("[{}]", too_many.join(","));
        for case in [
            // bad req
            r#"{"op":"permissions","req":""}"#.to_string(),
            r#"{"op":"permissions","req":"has space"}"#.to_string(),
            format!(r#"{{"op":"permissions","req":"{}"}}"#, "r".repeat(41)),
            // bad bundle ids
            r#"{"op":"screenshot","req":"r1","grants":[{"bundleId":".a","tier":"read"}]}"#
                .to_string(),
            r#"{"op":"screenshot","req":"r1","grants":[{"bundleId":"a b","tier":"read"}]}"#
                .to_string(),
            r#"{"op":"screenshot","req":"r1","grants":[{"bundleId":"","tier":"read"}]}"#
                .to_string(),
            format!(r#"{{"op":"screenshot","req":"r1","grants":{too_many}}}"#),
            // scale, display
            format!(r#"{{"op":"screenshot","req":"r1","grants":{G},"scale":0.1}}"#),
            format!(r#"{{"op":"screenshot","req":"r1","grants":{G},"scale":1.5}}"#),
            format!(r#"{{"op":"screenshot","req":"r1","grants":{G},"display":-1}}"#),
            format!(r#"{{"op":"screenshot","req":"r1","grants":{G},"display":99}}"#),
            format!(r#"{{"op":"screenshot","req":"r1","grants":{G},"app":""}}"#),
            // NaN-ish / non-finite / bad frames
            format!(
                r#"{{"op":"click","req":"r1","grants":{G},"frame":{F},"x":1e999,"y":2,"button":"left","count":1,"modifiers":[]}}"#
            ),
            format!(
                r#"{{"op":"click","req":"r1","grants":{G},"frame":{F},"x":null,"y":2,"button":"left","count":1,"modifiers":[]}}"#
            ),
            format!(
                r#"{{"op":"click","req":"r1","grants":{G},"frame":{{"display":0,"originX":0,"originY":0,"width":0,"height":1,"scale":1}},"x":0,"y":0,"button":"left","count":1,"modifiers":[]}}"#
            ),
            format!(
                r#"{{"op":"click","req":"r1","grants":{G},"frame":{{"display":0,"originX":0,"originY":0,"width":1,"height":1,"scale":-1}},"x":0,"y":0,"button":"left","count":1,"modifiers":[]}}"#
            ),
            // counts, depth, refs
            format!(
                r#"{{"op":"click","req":"r1","grants":{G},"frame":{F},"x":1,"y":2,"button":"left","count":0,"modifiers":[]}}"#
            ),
            format!(
                r#"{{"op":"click","req":"r1","grants":{G},"frame":{F},"x":1,"y":2,"button":"left","count":4,"modifiers":[]}}"#
            ),
            format!(r#"{{"op":"ax-tree","req":"r1","grants":{G},"app":"x","maxDepth":0}}"#),
            format!(r#"{{"op":"ax-tree","req":"r1","grants":{G},"app":"x","maxDepth":13}}"#),
            format!(r#"{{"op":"ax-press","req":"r1","grants":{G},"app":"x","ref":"e0"}}"#),
            format!(r#"{{"op":"ax-press","req":"r1","grants":{G},"app":"x","ref":"x3"}}"#),
            format!(r#"{{"op":"ax-press","req":"r1","grants":{G},"app":"x","ref":"e12345"}}"#),
            // text / keys
            format!(r#"{{"op":"type","req":"r1","grants":{G},"text":""}}"#),
            format!(r#"{{"op":"type","req":"r1","grants":{G},"text":"{long_text}"}}"#),
            format!(r#"{{"op":"key","req":"r1","grants":{G},"keys":"{long_keys}"}}"#),
            // scroll deltas must be integers
            format!(
                r#"{{"op":"scroll","req":"r1","grants":{G},"frame":{F},"x":1,"y":2,"dx":0.5,"dy":1}}"#
            ),
        ] {
            assert!(parse(&case).is_none(), "should reject: {case}");
        }
        // Exactly the limits are fine.
        let ok_text = "é".repeat(MAX_TEXT_CHARS);
        assert!(parse(&format!(
            r#"{{"op":"type","req":"r1","grants":{G},"text":"{ok_text}"}}"#
        ))
        .is_some());
    }

    #[test]
    fn invalid_messages_with_a_good_req_are_answered() {
        assert_eq!(
            parse_request(r#"{"op":"click","req":"r9","bogus":1}"#),
            Err(Some("r9".into()))
        );
        assert_eq!(
            parse_request(r#"{"op":"click","req":"bad req"}"#),
            Err(None)
        );
        assert_eq!(parse_request(r#"{"op":"nope"}"#), Err(None));
    }

    #[test]
    fn scroll_is_clamped_and_modifiers_deduplicated() {
        let Some(ComputerRequest::Scroll { dx, dy, .. }) = parse(&format!(
            r#"{{"op":"scroll","req":"r1","grants":{G},"frame":{F},"x":1,"y":2,"dx":-9000,"dy":51}}"#
        )) else {
            panic!("scroll")
        };
        assert_eq!((dx, dy), (-50, 50));
        let Some(ComputerRequest::Click { modifiers, .. }) = parse(&format!(
            r#"{{"op":"click","req":"r1","grants":{G},"frame":{F},"x":1,"y":2,"button":"left","count":1,"modifiers":["cmd","shift","cmd"]}}"#
        )) else {
            panic!("click")
        };
        assert_eq!(modifiers, vec![Modifier::Cmd, Modifier::Shift]);
    }

    #[test]
    fn oversized_payloads_are_dropped_unparsed() {
        let big = format!(
            r#"{{"op":"permissions","req":"r1","pad":"{}"}}"#,
            "x".repeat(MAX_PAYLOAD_BYTES)
        );
        assert_eq!(parse_request(&big), Err(None));
    }

    #[test]
    fn settings_urls_come_from_a_closed_enum() {
        assert_eq!(
            SettingsKind::Screen.url(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        );
        assert_eq!(
            SettingsKind::Accessibility.url(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
    }

    // ── policy ───────────────────────────────────────────────────────────────

    #[test]
    fn the_denylist_is_absolute_and_prefix_aware() {
        for bundle in [
            "ai.ashlr.desktop",
            "AI.Ashlr.Desktop",
            "com.apple.keychainaccess",
            "com.apple.Passwords",
            "com.apple.SecurityAgent",
            "com.apple.LocalAuthentication.UIAgent",
            "com.1password.1password",
            "com.1password.x",
            "com.agilebits.onepassword7",
            "com.bitwarden.desktop",
            "org.keepassxc.keepassxc",
            "com.proton.pass.desktop",
        ] {
            assert_eq!(
                app_policy(Some(bundle), None),
                (None, Category::Denied),
                "{bundle}"
            );
            assert_eq!(
                effective_tier(&[grant(bundle, Tier::Full)], Some(bundle), None),
                None,
                "{bundle}"
            );
        }
        // Prefix patterns do not over-match.
        assert_ne!(
            app_policy(Some("com.1passwordx.app"), None).1,
            Category::Denied
        );
        assert_ne!(
            app_policy(Some("com.apple.SecurityAgentX"), None).1,
            Category::Denied
        );
    }

    #[test]
    fn the_custody_helper_and_unidentified_processes_are_denied() {
        assert_eq!(
            app_policy(
                Some("com.example.app"),
                Some("/usr/local/libexec/ashlr-custody")
            ),
            (None, Category::Denied)
        );
        assert_eq!(
            app_policy(
                Some("com.example.app"),
                Some("/usr/local/libexec/ashlr-custody-helper")
            ),
            (None, Category::Denied)
        );
        assert_eq!(app_policy(None, None), (None, Category::Denied));
        assert_eq!(app_policy(Some("-bad"), None), (None, Category::Denied));
        assert_eq!(app_policy(Some(""), None), (None, Category::Denied));
    }

    #[test]
    fn ceilings_by_category() {
        assert_eq!(
            app_policy(Some("com.apple.Safari"), None),
            (Some(Tier::Read), Category::Browser)
        );
        assert_eq!(
            app_policy(Some("com.google.Chrome.canary"), None).0,
            Some(Tier::Read)
        );
        assert_eq!(
            app_policy(Some("com.apple.Terminal"), None),
            (Some(Tier::Click), Category::TerminalIde)
        );
        assert_eq!(
            app_policy(Some("com.microsoft.VSCodeInsiders"), None).0,
            Some(Tier::Click)
        );
        assert_eq!(
            app_policy(Some("com.jetbrains.intellij"), None).0,
            Some(Tier::Click)
        );
        assert_eq!(
            app_policy(Some("com.apple.TextEdit"), None),
            (Some(Tier::Full), Category::Other)
        );
        assert_eq!(
            app_policy(Some("com.apple.systempreferences"), None).0,
            Some(Tier::Full)
        );
    }

    #[test]
    fn grants_are_clamped_and_never_widened() {
        let grants = [
            grant("com.apple.Safari", Tier::Full),
            grant("com.apple.Terminal", Tier::Full),
            grant("com.apple.TextEdit", Tier::Click),
            grant("com.apple.Notes", Tier::Full),
        ];
        assert_eq!(
            effective_tier(&grants, Some("com.apple.Safari"), None),
            Some(Tier::Read)
        );
        assert_eq!(
            effective_tier(&grants, Some("com.apple.terminal"), None),
            Some(Tier::Click)
        );
        assert_eq!(
            effective_tier(&grants, Some("com.apple.TextEdit"), None),
            Some(Tier::Click)
        );
        assert_eq!(
            effective_tier(&grants, Some("com.apple.Notes"), None),
            Some(Tier::Full)
        );
        assert_eq!(effective_tier(&grants, Some("com.apple.Mail"), None), None);
        assert_eq!(effective_tier(&[], Some("com.apple.Notes"), None), None);
    }

    #[test]
    fn required_tiers_mirror_the_contract() {
        use Action::*;
        for (action, tier) in [
            (Screenshot, Tier::Read),
            (Zoom, Tier::Read),
            (AxTree, Tier::Read),
            (Click, Tier::Click),
            (Scroll, Tier::Click),
            (AxPress, Tier::Click),
            (RightClick, Tier::Full),
            (ModifierClick, Tier::Full),
            (Type, Tier::Full),
            (Key, Tier::Full),
            (Drag, Tier::Full),
        ] {
            assert_eq!(required_tier(action), tier, "{action:?}");
        }
        assert!(tier_allows(Tier::Read, Screenshot));
        assert!(!tier_allows(Tier::Read, Click));
        assert!(tier_allows(Tier::Click, Click));
        assert!(!tier_allows(Tier::Click, Type));
        assert!(tier_allows(Tier::Full, Drag));
        assert_eq!(click_action(MouseButton::Left, &[]), Click);
        assert_eq!(click_action(MouseButton::Right, &[]), RightClick);
        assert_eq!(click_action(MouseButton::Middle, &[]), RightClick);
        assert_eq!(
            click_action(MouseButton::Left, &[Modifier::Cmd]),
            ModifierClick
        );
        assert!(!tier_allows(
            Tier::Click,
            click_action(MouseButton::Right, &[])
        ));
        assert!(!tier_allows(
            Tier::Click,
            click_action(MouseButton::Left, &[Modifier::Shift])
        ));
    }

    #[test]
    fn authorize_applies_every_rule_in_order() {
        let grants = [
            grant("com.apple.Terminal", Tier::Full),
            grant("com.apple.TextEdit", Tier::Full),
            grant("com.apple.systempreferences", Tier::Full),
            grant("com.1password.1password", Tier::Full),
        ];
        let own = 42;
        let code = |r: Result<Tier, Failure>| r.map_err(|f| f.code);
        assert_eq!(
            code(authorize(
                &grants,
                &ident(own, Some("com.apple.TextEdit"), "TextEdit"),
                own,
                Action::Click,
                None
            )),
            Err(ErrorCode::Denied)
        );
        assert_eq!(
            code(authorize(
                &grants,
                &ident(1, Some("com.1password.1password"), "1Password"),
                own,
                Action::AxTree,
                None
            )),
            Err(ErrorCode::Denied)
        );
        assert_eq!(
            code(authorize(
                &grants,
                &ident(1, None, "helper"),
                own,
                Action::AxTree,
                None
            )),
            Err(ErrorCode::Denied)
        );
        assert_eq!(
            code(authorize(
                &grants,
                &ident(1, Some("com.apple.Mail"), "Mail"),
                own,
                Action::Screenshot,
                None
            )),
            Err(ErrorCode::NotGranted)
        );
        assert_eq!(
            code(authorize(
                &grants,
                &ident(1, Some("com.apple.Terminal"), "Terminal"),
                own,
                Action::Type,
                None
            )),
            Err(ErrorCode::Tier)
        );
        assert_eq!(
            code(authorize(
                &grants,
                &ident(1, Some("com.apple.Terminal"), "Terminal"),
                own,
                Action::Click,
                None
            )),
            Ok(Tier::Click)
        );
        let custody = AppIdent {
            executable: Some("/usr/local/libexec/ashlr-custody".into()),
            ..ident(1, Some("com.apple.TextEdit"), "custody")
        };
        assert_eq!(
            code(authorize(&grants, &custody, own, Action::Screenshot, None)),
            Err(ErrorCode::Denied)
        );
        // System Settings: judged by window title; unreadable = denied.
        let settings = ident(7, Some("com.apple.systempreferences"), "System Settings");
        let wifi = vec!["Wi-Fi".to_string()];
        let privacy = vec!["Wi-Fi".to_string(), "Privacy & Security".to_string()];
        assert_eq!(
            code(authorize(
                &grants,
                &settings,
                own,
                Action::Click,
                Some(&wifi)
            )),
            Ok(Tier::Full)
        );
        assert_eq!(
            code(authorize(
                &grants,
                &settings,
                own,
                Action::Click,
                Some(&privacy)
            )),
            Err(ErrorCode::Denied)
        );
        assert_eq!(
            code(authorize(&grants, &settings, own, Action::Click, None)),
            Err(ErrorCode::Denied)
        );
    }

    #[test]
    fn system_settings_privacy_titles_are_denied() {
        for title in [
            "Privacy & Security",
            "privacy & security",
            "  Privacy  ",
            "Security",
            "Passwords",
            "Touch ID & Password",
            "Users & Groups",
            "Login Items",
            "Login Items & Extensions",
            "Privacy & Security Accessibility",
        ] {
            assert!(is_denied_settings_title(title), "{title}");
        }
        for title in ["", "Wi-Fi", "Displays", "Securityx", "General"] {
            assert!(!is_denied_settings_title(title), "{title}");
        }
        assert!(is_system_settings("com.apple.systempreferences"));
        assert!(is_system_settings("com.apple.Settings"));
        assert!(!is_system_settings("com.apple.TextEdit"));
    }

    // ── secure fields ────────────────────────────────────────────────────────

    #[test]
    fn secure_fields_allow_only_tab_shift_tab_and_escape() {
        assert!(is_secure_element(Some("AXSecureTextField"), None));
        assert!(is_secure_element(
            Some("AXTextField"),
            Some("AXSecureTextField")
        ));
        assert!(!is_secure_element(Some("AXTextField"), None));
        assert!(!is_secure_element(None, None));
        let allowed = ["Tab", "shift+Tab", "Escape", "esc"];
        for keys in allowed {
            let combo = parse_key_combo(keys).unwrap();
            assert!(key_allowed_in_secure_field(&combo), "{keys}");
        }
        for keys in [
            "Return",
            "a",
            "cmd+v",
            "cmd+a",
            "ctrl+Tab",
            "cmd+Tab",
            "Space",
            "Delete",
            "shift+Escape",
        ] {
            let combo = parse_key_combo(keys).unwrap();
            assert!(!key_allowed_in_secure_field(&combo), "{keys}");
        }
    }

    // ── keys ─────────────────────────────────────────────────────────────────

    #[test]
    fn key_combos_parse() {
        let k = |s: &str| parse_key_combo(s);
        assert_eq!(
            k("cmd+shift+t"),
            Some(KeyCombo {
                code: 17,
                flags: FLAG_COMMAND | FLAG_SHIFT
            })
        );
        assert_eq!(
            k("Return"),
            Some(KeyCombo {
                code: keycode::RETURN,
                flags: 0
            })
        );
        assert_eq!(k("enter"), k("Return"));
        assert_eq!(k("Escape").unwrap().code, keycode::ESCAPE);
        assert_eq!(k("Tab").unwrap().code, keycode::TAB);
        assert_eq!(k("Space").unwrap().code, keycode::SPACE);
        assert_eq!(k("Backspace").unwrap().code, keycode::DELETE);
        assert_eq!(k("Delete").unwrap().code, keycode::DELETE);
        assert_eq!(k("ForwardDelete").unwrap().code, keycode::FORWARD_DELETE);
        assert_eq!(k("Up").unwrap().code, keycode::UP);
        assert_eq!(k("Down").unwrap().code, keycode::DOWN);
        assert_eq!(k("Left").unwrap().code, keycode::LEFT);
        assert_eq!(k("Right").unwrap().code, keycode::RIGHT);
        assert_eq!(k("Home").unwrap().code, keycode::HOME);
        assert_eq!(k("End").unwrap().code, keycode::END);
        assert_eq!(k("PageUp").unwrap().code, keycode::PAGE_UP);
        assert_eq!(k("PageDown").unwrap().code, keycode::PAGE_DOWN);
        assert_eq!(k("F1").unwrap().code, 122);
        assert_eq!(k("F12").unwrap().code, 111);
        assert_eq!(k("a").unwrap().code, 0);
        assert_eq!(k("Z").unwrap().code, 6);
        assert_eq!(k("0").unwrap().code, 29);
        assert_eq!(k("9").unwrap().code, 25);
        assert_eq!(
            k("cmd+,"),
            Some(KeyCombo {
                code: 43,
                flags: FLAG_COMMAND
            })
        );
        assert_eq!(
            k("ctrl+-"),
            Some(KeyCombo {
                code: 27,
                flags: FLAG_CONTROL
            })
        );
        assert_eq!(k("option+/").unwrap().flags, FLAG_OPTION);
        assert_eq!(k("alt+left").unwrap().flags, FLAG_OPTION);
        assert_eq!(k("fn+F5").unwrap().flags, FLAG_FN);
        assert_eq!(
            k(" Cmd + S ").unwrap(),
            KeyCombo {
                code: 1,
                flags: FLAG_COMMAND
            }
        );
        for bad in [
            "",
            "cmd",
            "cmd+",
            "cmd+cmd+s",
            "F0",
            "F13",
            "F01",
            "hyper+a",
            "a+b",
            "ab",
            "cmd++",
            "!",
            "é",
        ] {
            assert_eq!(k(bad), None, "{bad}");
        }
    }

    // ── geometry ─────────────────────────────────────────────────────────────

    #[test]
    fn frame_coordinates_scale_and_bound() {
        let f = frame();
        assert_eq!(f.screen_point(0.0, 0.0), Some((100.0, 50.0)));
        assert_eq!(f.screen_point(10.0, 20.0), Some((120.0, 90.0)));
        assert_eq!(f.screen_point(1000.0, 500.0), Some((2100.0, 1050.0)));
        assert_eq!(f.screen_point(-1.0, 0.0), None);
        assert_eq!(f.screen_point(0.0, 500.1), None);
        assert_eq!(f.screen_point(1000.5, 0.0), None);
        assert_eq!(f.screen_point(f64::NAN, 0.0), None);
        assert_eq!(f.screen_point(f64::INFINITY, 0.0), None);
    }

    #[test]
    fn fit_size_keeps_aspect_and_never_upscales() {
        let (w, h) = fit_size(3456.0, 2234.0, FIT_MAX_WIDTH, FIT_MAX_HEIGHT);
        assert!(w <= 1280 && h <= 800, "{w}x{h}");
        assert_eq!(h, 800);
        let aspect = f64::from(w) / f64::from(h);
        assert!((aspect - 3456.0 / 2234.0).abs() < 0.01, "{aspect}");
        assert_eq!(
            fit_size(1024.0, 640.0, FIT_MAX_WIDTH, FIT_MAX_HEIGHT),
            (1024, 640)
        );
        assert_eq!(
            fit_size(2560.0, 1600.0, FIT_MAX_WIDTH, FIT_MAX_HEIGHT),
            (1280, 800)
        );
        assert_eq!(
            fit_size(2560.0, 1600.0, FIT_MAX_WIDTH * 0.5, FIT_MAX_HEIGHT * 0.5),
            (640, 400)
        );
        assert_eq!(fit_size(0.0, 10.0, 100.0, 100.0), (1, 1));
        assert_eq!(fit_size(f64::NAN, 10.0, 100.0, 100.0), (1, 1));
    }

    #[test]
    fn zoom_regions_become_display_local_source_rects() {
        let f = frame();
        let rect = region_screen_point(&f, [10.0, 20.0, 110.0, 70.0]).unwrap();
        assert_eq!(
            rect,
            Rect {
                x: 120.0,
                y: 90.0,
                w: 200.0,
                h: 100.0
            }
        );
        let display = Rect {
            x: 100.0,
            y: 50.0,
            w: 2000.0,
            h: 1000.0,
        };
        assert_eq!(
            to_display_local(rect, display),
            Some(Rect {
                x: 20.0,
                y: 40.0,
                w: 200.0,
                h: 100.0
            })
        );
        // Empty, inverted and out-of-image regions are refused.
        assert_eq!(region_screen_point(&f, [10.0, 10.0, 10.0, 20.0]), None);
        assert_eq!(region_screen_point(&f, [50.0, 10.0, 10.0, 20.0]), None);
        assert_eq!(region_screen_point(&f, [0.0, 0.0, 1001.0, 20.0]), None);
        assert_eq!(region_screen_point(&f, [-1.0, 0.0, 10.0, 20.0]), None);
        // Not on that display.
        let elsewhere = Rect {
            x: 5000.0,
            y: 0.0,
            w: 1000.0,
            h: 1000.0,
        };
        assert_eq!(to_display_local(rect, elsewhere), None);
    }

    #[test]
    fn capture_frames_and_ax_rects_round_trip() {
        let display = Rect {
            x: -1728.0,
            y: 0.0,
            w: 1728.0,
            h: 1117.0,
        };
        let (w, h) = fit_size(3456.0, 2234.0, FIT_MAX_WIDTH, FIT_MAX_HEIGHT);
        let f = capture_frame(1, display, w, h);
        assert_eq!(f.display, 1);
        assert_eq!((f.origin_x, f.origin_y), (-1728.0, 0.0));
        assert!((f.scale - 1728.0 / f64::from(w)).abs() < 1e-9);
        let (sx, sy) = f.screen_point(f.width, f.height).unwrap();
        assert!((sx - 0.0).abs() < 1e-6 && (sy - 1117.0).abs() < 1.0);
        // A 200×100-point control at the display's origin.
        let px = f
            .rect_to_pixels(Rect {
                x: -1728.0,
                y: 0.0,
                w: 200.0,
                h: 100.0,
            })
            .unwrap();
        assert_eq!(px.to_array()[0], 0);
        assert!(px.w > 100.0);
        assert_eq!(
            f.rect_to_pixels(Rect {
                x: 10.0,
                y: 0.0,
                w: 5.0,
                h: 5.0
            }),
            None
        );
        let json = serde_json::to_value(f).unwrap();
        assert_eq!(json["originX"], -1728.0);
        assert!(json.get("scale").is_some());
    }

    #[test]
    fn hud_rects_convert_from_appkit_to_global_points() {
        // A 5-pt border along the top of a 1117-pt primary screen.
        let top = cocoa_to_global(
            Rect {
                x: 0.0,
                y: 1112.0,
                w: 1728.0,
                h: 5.0,
            },
            1117.0,
        );
        assert_eq!(
            top,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 1728.0,
                h: 5.0
            }
        );
        let bottom = cocoa_to_global(
            Rect {
                x: 0.0,
                y: 0.0,
                w: 1728.0,
                h: 5.0,
            },
            1117.0,
        );
        assert_eq!(bottom.y, 1112.0);
        assert!(top.contains_point(10.0, 4.9));
        assert!(!top.contains_point(10.0, 5.0));
    }

    #[test]
    fn drags_interpolate_and_text_chunks_keep_surrogates_whole() {
        let path = drag_path((0.0, 0.0), (100.0, 50.0), 10);
        assert_eq!(path.len(), 10);
        assert_eq!(path[0], (10.0, 5.0));
        assert_eq!(*path.last().unwrap(), (100.0, 50.0));
        let text = format!("{}😀{}", "a".repeat(19), "b".repeat(25));
        let chunks = utf16_chunks(&text, TYPE_CHUNK_UNITS);
        assert!(chunks.iter().all(|c| c.len() <= TYPE_CHUNK_UNITS));
        assert_eq!(chunks[0].len(), 19, "the emoji does not split");
        let joined: Vec<u16> = chunks.concat();
        assert_eq!(String::from_utf16(&joined).unwrap(), text);
        assert!(utf16_chunks("", 20).is_empty());
    }

    // ── takeover ─────────────────────────────────────────────────────────────

    #[test]
    fn actions_activate_and_operator_input_pauses_after_the_grace_window() {
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let mut t = Takeover::default();
        assert_eq!(t.control(), &Control::Idle);
        let start = t.begin_action(t0, "TextEdit").unwrap().unwrap();
        assert_eq!(start.state, StateName::Active);
        assert_eq!(start.app.as_deref(), Some("TextEdit"));
        assert_eq!(t.hud_app(), Some("TextEdit"));
        // Same app again: no new transition.
        assert_eq!(t.begin_action(ms(10), "TextEdit"), Ok(None));
        t.note_synth(ms(20));
        // Our own events (idle measured from our last synthetic event) and
        // input inside the grace window do not pause.
        assert_eq!(t.observe_input(0.0, ms(20)), None);
        assert_eq!(t.observe_input(0.0, ms(20 + 350)), None);
        // Input newer than last_synth + grace: the operator took over.
        let paused = t.observe_input(0.0, ms(20 + 351)).unwrap();
        assert_eq!(paused.state, StateName::Paused);
        assert_eq!(paused.reason, Some(StateReason::OperatorInput));
        assert_eq!(t.hud_app(), None);
        assert_eq!(t.begin_action(ms(500), "TextEdit"), Err(Refusal::TookOver));
        assert_eq!(t.check(), Err(Refusal::TookOver));
        // Old input (before our action) never pauses.
        let mut t = Takeover::default();
        t.begin_action(t0, "Notes").unwrap();
        assert_eq!(t.observe_input(5.0, ms(1000)), None);
        // Nonsense readings are ignored.
        assert_eq!(t.observe_input(f64::NAN, ms(1000)), None);
        assert_eq!(t.observe_input(-1.0, ms(1000)), None);
    }

    #[test]
    fn resume_kill_arm_and_idle() {
        let t0 = Instant::now();
        let mut t = Takeover::default();
        t.begin_action(t0, "Notes").unwrap();
        // Switching apps is a transition (the HUD names the new app).
        let switched = t.begin_action(t0, "Mail").unwrap().unwrap();
        assert_eq!(switched.app.as_deref(), Some("Mail"));
        t.observe_input(0.0, t0 + Duration::from_secs(1)).unwrap();
        let resumed = t.resume().unwrap();
        assert_eq!(
            (resumed.state, resumed.reason),
            (StateName::Idle, Some(StateReason::Resume))
        );
        assert_eq!(t.resume(), None);
        assert!(t.begin_action(t0 + Duration::from_secs(2), "Notes").is_ok());
        // Kill from active; nothing runs until armed; resume does not re-arm.
        let killed = t.kill(StateReason::Escape).unwrap();
        assert_eq!(
            (killed.state, killed.reason),
            (StateName::Killed, Some(StateReason::Escape))
        );
        assert_eq!(t.kill(StateReason::Kill), None);
        assert_eq!(t.begin_action(t0, "Notes"), Err(Refusal::Stopped));
        assert_eq!(t.resume(), None);
        assert_eq!(t.check(), Err(Refusal::Stopped));
        let armed = t.arm().unwrap();
        assert_eq!(armed.state, StateName::Idle);
        assert_eq!(t.arm(), None);
        // Kill from idle and from paused too.
        assert!(Takeover::default().kill(StateReason::Kill).is_some());
        // Idle timeout: 10 s after the last action.
        let mut t = Takeover::default();
        t.begin_action(t0, "Notes").unwrap();
        t.note_synth(t0 + Duration::from_secs(2));
        assert_eq!(t.tick(t0 + Duration::from_secs(11)), None);
        let idle = t.tick(t0 + Duration::from_secs(12)).unwrap();
        assert_eq!(
            (idle.state, idle.reason),
            (StateName::Idle, Some(StateReason::Idle))
        );
        assert_eq!(t.tick(t0 + Duration::from_secs(30)), None);
        // note_synth outside active control changes nothing.
        t.note_synth(t0 + Duration::from_secs(40));
        assert_eq!(t.control(), &Control::Idle);
    }

    #[test]
    fn the_verse_window_going_away_pauses_active_control_only() {
        let t0 = Instant::now();
        let mut t = Takeover::default();
        assert_eq!(t.window_gone(), None);
        t.begin_action(t0, "Notes").unwrap();
        let paused = t.window_gone().unwrap();
        assert_eq!(
            (paused.state, paused.reason),
            (StateName::Paused, Some(StateReason::Idle))
        );
        let mut killed = Takeover::default();
        killed.kill(StateReason::Kill);
        assert_eq!(killed.window_gone(), None);
        assert_eq!(killed.control(), &Control::Killed);
    }

    #[test]
    fn our_own_escape_does_not_trip_the_stop_key() {
        let t0 = Instant::now();
        let mut t = Takeover::default();
        assert!(!t.escape_is_own(t0));
        t.note_own_escape(t0);
        assert!(t.escape_is_own(t0 + Duration::from_millis(399)));
        assert!(!t.escape_is_own(t0 + Duration::from_millis(400)));
        assert_eq!(escape_shortcut(), Shortcut::new(None, Code::Escape));
    }

    // ── native → page ────────────────────────────────────────────────────────

    #[test]
    fn events_are_json_encoded_and_cannot_break_out() {
        let script = event_script(&ComputerEvent::result(
            "r1",
            Err(Failure::new(
                ErrorCode::Denied,
                "x\"});alert(1);//</script>\u{2028}",
            )),
        ));
        assert!(script.starts_with(
            "if (typeof window.__ASHLR_COMPUTER_EVENT__ === 'function') window.__ASHLR_COMPUTER_EVENT__({"
        ));
        assert!(script.ends_with("});"));
        assert!(!script.contains('\u{2028}'));
        let start =
            script.find("__ASHLR_COMPUTER_EVENT__(").unwrap() + "__ASHLR_COMPUTER_EVENT__(".len();
        let value: Value = serde_json::from_str(&script[start..script.len() - 2]).unwrap();
        assert_eq!(value["error"], "x\"});alert(1);//</script>\u{2028}");
        assert_eq!(value["code"], "denied");
    }

    #[test]
    fn event_shapes_match_the_protocol() {
        let as_json = |e: &ComputerEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            as_json(&ComputerEvent::result("r1", Ok(serde_json::json!({"a":1})))),
            serde_json::json!({"kind":"result","req":"r1","ok":true,"data":{"a":1}})
        );
        assert_eq!(
            as_json(&ComputerEvent::result(
                "r1",
                Err(Failure::from_refusal(Refusal::TookOver))
            )),
            serde_json::json!({"kind":"result","req":"r1","ok":false,"code":"operator-took-over","error":TOOK_OVER_MESSAGE})
        );
        assert_eq!(
            as_json(&ComputerEvent::state(&Transition {
                state: StateName::Paused,
                app: Some("Notes".into()),
                reason: Some(StateReason::OperatorInput),
            })),
            serde_json::json!({"kind":"state","state":"paused","app":"Notes","reason":"operator-input"})
        );
        assert_eq!(
            as_json(&ComputerEvent::state(&Transition {
                state: StateName::Idle,
                app: None,
                reason: None
            })),
            serde_json::json!({"kind":"state","state":"idle"})
        );
        let codes = [
            (ErrorCode::NoPermission, "no-permission"),
            (ErrorCode::OperatorTookOver, "operator-took-over"),
            (ErrorCode::Stopped, "stopped"),
            (ErrorCode::NotGranted, "not-granted"),
            (ErrorCode::Tier, "tier"),
            (ErrorCode::Denied, "denied"),
            (ErrorCode::SecureField, "secure-field"),
            (ErrorCode::OutOfBounds, "out-of-bounds"),
            (ErrorCode::NotFound, "not-found"),
            (ErrorCode::StaleRef, "stale-ref"),
            (ErrorCode::Unsupported, "unsupported"),
            (ErrorCode::Invalid, "invalid"),
            (ErrorCode::Busy, "busy"),
            (ErrorCode::Timeout, "timeout"),
            (ErrorCode::Failed, "failed"),
        ];
        for (code, name) in codes {
            assert_eq!(serde_json::to_value(code).unwrap(), name);
        }
        for (reason, name) in [
            (StateReason::OperatorInput, "operator-input"),
            (StateReason::Escape, "escape"),
            (StateReason::Kill, "kill"),
            (StateReason::Resume, "resume"),
            (StateReason::Idle, "idle"),
        ] {
            assert_eq!(serde_json::to_value(reason).unwrap(), name);
        }
        let id = AppIdent {
            pid: 9,
            bundle: Some("com.apple.Notes".into()),
            name: "Notes".into(),
            executable: Some("/x".into()),
        };
        assert_eq!(
            id.to_json(),
            serde_json::json!({"bundleId":"com.apple.Notes","name":"Notes","pid":9})
        );
    }

    #[test]
    fn long_errors_are_truncated_on_char_boundaries() {
        let ComputerEvent::Result { error: Some(e), .. } =
            ComputerEvent::result("r", Err(Failure::new(ErrorCode::Failed, "é".repeat(1000))))
        else {
            unreachable!()
        };
        assert_eq!(e.chars().count(), ERROR_MAX_CHARS);
    }

    #[test]
    fn the_policy_lists_keep_one_literal_per_line() {
        // test/verse-computer-315.test.ts parses this file; keep the shape.
        let source = include_str!("computer.rs");
        for name in [
            "DENIED_BUNDLES",
            "BROWSER_BUNDLES",
            "TERMINAL_IDE_BUNDLES",
            "DENIED_EXECUTABLE_PREFIXES",
            "DENIED_SETTINGS_TITLES",
            "SYSTEM_SETTINGS_BUNDLES",
        ] {
            let header = format!("pub const {name}: &[&str] = &[\n");
            let start = source
                .find(&header)
                .unwrap_or_else(|| panic!("{name} header"))
                + header.len();
            let body = &source[start..start + source[start..].find("];").unwrap()];
            for line in body.lines() {
                let line = line.trim();
                assert!(
                    line.starts_with('"') && line.ends_with("\","),
                    "{name}: `{line}` is not one literal per line"
                );
            }
        }
        assert_eq!(DENIED_BUNDLES.len(), 23);
        assert_eq!(BROWSER_BUNDLES.len(), 16);
        assert_eq!(TERMINAL_IDE_BUNDLES.len(), 26);
    }
}

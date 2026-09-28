//! Input for the integrated browser pane (`browser_pane.rs`): the agent's
//! synthesized clicks and key presses, and the operator's own input.
//!
//! # How the agent acts
//!
//! The agent's clicks and key presses are REAL AppKit events: an `NSEvent`
//! built with `mouseEventWithType:…` / `keyEventWithType:…` and handed to the
//! tab's own `NSWindow` with `sendEvent:`. WebKit treats them exactly like the
//! operator's, so the page sees `isTrusted == true` events, focus moves the way
//! it would for a person, and frameworks that ignore synthetic DOM events
//! (`element.click()`, `dispatchEvent`) still react. This needs NO
//! Accessibility permission and no `CGEventPost`: the events never touch the
//! window server or any other app — they are delivered straight into a window
//! this process owns, and only ever to a browser tab window (never the Verse
//! window, never another app). Verified on macOS with a prototype: clicks,
//! focus and typing (non-ASCII included) arrive trusted even while the tab
//! window is not key. Hover (`mouseMoved`) is best effort: a background app
//! gets no tracking-area updates, so the tap reports whether `:hover` took.
//!
//! What is typed is chosen by the caller from VALIDATED data only: the text of
//! a `type` act (character by character, as key events — never as script) and
//! a key combo from the closed table in [`parse_key_combo`]. That table is
//! deliberately small: ⌘ is allowed only for select-all and undo, so the agent
//! can never paste the operator's clipboard into a page (⌘V), close or quit
//! anything (⌘W / ⌘Q), or reach any other menu command.
//!
//! # How the operator takes over
//!
//! [`install`] adds ONE local `NSEvent` monitor for mouse-down and key-down.
//! Local monitors run inside `NSApplication`'s event dispatch, and the events
//! this module synthesizes go straight to `NSWindow sendEvent:` without ever
//! passing through the application's queue — so the monitor sees ONLY genuine
//! operator input. That is the whole discriminator; no timing heuristics. When
//! the operator presses a mouse button or a key in a browser tab window, the
//! Verse page hears `{kind:"operator", tab}` (at most twice a second per tab)
//! and pauses the agent. The monitor never swallows or changes an event.

use serde::{Deserialize, Serialize};

// ── pure pieces (every platform; unit-tested) ────────────────────────────────

/// A modifier key. The wire spelling is the DOM `KeyboardEvent.key` name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Modifier {
    Shift,
    Alt,
    Control,
    Meta,
}

impl Modifier {
    /// The `NSEventModifierFlags` bit (Shift 1<<17, Control 1<<18,
    /// Option 1<<19, Command 1<<20).
    pub fn flag(self) -> usize {
        match self {
            Modifier::Shift => 1 << 17,
            Modifier::Control => 1 << 18,
            Modifier::Alt => 1 << 19,
            Modifier::Meta => 1 << 20,
        }
    }

    fn parse(name: &str) -> Option<Self> {
        match name {
            "Shift" => Some(Modifier::Shift),
            "Alt" => Some(Modifier::Alt),
            "Control" => Some(Modifier::Control),
            "Meta" => Some(Modifier::Meta),
            _ => None,
        }
    }
}

/// The combined flag bits of `mods`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn modifier_flags(mods: &[Modifier]) -> usize {
    mods.iter().fold(0, |acc, m| acc | m.flag())
}

/// One key press (a keyDown/keyUp pair) exactly as AppKit describes it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stroke {
    /// The virtual key code (`kVK_*`); 0 for "a character, no physical key".
    pub key_code: u16,
    /// `characters` of the event (what the key produces with modifiers).
    pub chars: String,
    /// `charactersIgnoringModifiers`.
    pub base: String,
    /// `NSEventModifierFlags` bits.
    pub flags: usize,
}

impl Stroke {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn plain(key_code: u16, chars: &str) -> Self {
        Stroke {
            key_code,
            chars: chars.to_string(),
            base: chars.to_string(),
            flags: 0,
        }
    }
}

/// A validated key combo from the closed table (see [`parse_key_combo`]).
pub type KeyCombo = Stroke;

/// Longest combo string accepted.
pub const KEY_COMBO_MAX_CHARS: usize = 32;

/// The named keys: DOM name → (macOS virtual key code, AppKit characters).
/// The arrow / Home / End / Page / Delete characters are AppKit's
/// function-key code points (`NSUpArrowFunctionKey` = U+F700 …).
const NAMED_KEYS: &[(&str, u16, &str)] = &[
    ("Enter", 36, "\r"),
    ("Tab", 48, "\t"),
    ("Escape", 53, "\u{1b}"),
    ("Backspace", 51, "\u{7f}"),
    ("Delete", 117, "\u{f728}"),
    ("ArrowUp", 126, "\u{f700}"),
    ("ArrowDown", 125, "\u{f701}"),
    ("ArrowLeft", 123, "\u{f702}"),
    ("ArrowRight", 124, "\u{f703}"),
    ("Home", 115, "\u{f729}"),
    ("End", 119, "\u{f72b}"),
    ("PageUp", 116, "\u{f72c}"),
    ("PageDown", 121, "\u{f72d}"),
    ("Space", 49, " "),
];

/// Parse `Mod+Mod+Key` against the closed table.
///
/// - Modifiers: `Shift`, `Alt`, `Control`, `Meta`, each at most once.
/// - Key: a name from [`NAMED_KEYS`], or exactly one printable ASCII
///   character `!`..=`~` (key code 0; `+` itself is written `Shift++` or `+`).
/// - `Meta` (⌘) only with `a` (select all) or `z` (undo), optionally with
///   `Shift` (redo). Everything else ⌘ reaches — paste the operator's
///   clipboard, close, quit, print, any menu item — is refused.
///
/// `base` (charactersIgnoringModifiers) is the key's own character;
/// `chars` follows AppKit: Shift upper-cases a letter, Control+letter is the
/// matching control character, otherwise the base character.
pub fn parse_key_combo(combo: &str) -> Option<KeyCombo> {
    if combo.is_empty() || combo.chars().count() > KEY_COMBO_MAX_CHARS {
        return None;
    }
    // The key is everything after the last `+`, except that the key may BE
    // `+` ("+", "Shift++").
    let (mods_part, key) = if combo == "+" {
        ("", "+")
    } else if let Some(mods) = combo.strip_suffix("++") {
        (mods, "+")
    } else {
        match combo.rsplit_once('+') {
            Some((mods, key)) => {
                if mods.is_empty() {
                    return None; // "+a"
                }
                (mods, key)
            }
            None => ("", combo),
        }
    };
    let mut mods: Vec<Modifier> = Vec::new();
    if !mods_part.is_empty() {
        for name in mods_part.split('+') {
            let m = Modifier::parse(name)?;
            if mods.contains(&m) {
                return None;
            }
            mods.push(m);
        }
    }

    let (key_code, base) =
        if let Some(&(_, code, chars)) = NAMED_KEYS.iter().find(|(name, _, _)| *name == key) {
            (code, chars.to_string())
        } else {
            let mut it = key.chars();
            match (it.next(), it.next()) {
                (Some(c), None) if ('!'..='~').contains(&c) => (0, c.to_string()),
                _ => return None,
            }
        };

    if mods.contains(&Modifier::Meta) {
        let allowed_key = key == "a" || key == "z";
        let only_shift_besides = mods
            .iter()
            .all(|m| matches!(m, Modifier::Meta | Modifier::Shift));
        if !allowed_key || !only_shift_besides {
            return None;
        }
    }

    let mut chars = base.clone();
    if base.len() == 1 {
        let c = base.as_bytes()[0];
        if c.is_ascii_lowercase() {
            if mods.contains(&Modifier::Control) {
                chars = ((c - b'a' + 1) as char).to_string();
            } else if mods.contains(&Modifier::Shift) {
                chars = (c.to_ascii_uppercase() as char).to_string();
            }
        }
    }
    Some(Stroke {
        key_code,
        chars,
        base,
        flags: modifier_flags(&mods),
    })
}

/// The key presses that type `text`. `\n` is Enter (key code 36, `"\r"`) and
/// is only allowed in a multi-line field — in a single-line input Enter would
/// SUBMIT the form, which is not what "type this text" asked for; that is
/// refused before anything is sent. `\t` is Tab (48). Every other character
/// is one key press with key code 0 and that character, which WebKit inserts
/// as typed text (any script, any plane).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn strokes_for_text(text: &str, multiline: bool) -> Result<Vec<Stroke>, &'static str> {
    let mut out = Vec::with_capacity(text.chars().count());
    let mut buf = [0u8; 4];
    for c in text.chars() {
        match c {
            '\n' if multiline => out.push(Stroke::plain(36, "\r")),
            '\n' => return Err("newline-in-single-line-field"),
            '\t' => out.push(Stroke::plain(48, "\t")),
            c if !text_char_allowed(c) => return Err("unsupported-char"),
            c => out.push(Stroke::plain(0, c.encode_utf8(&mut buf))),
        }
    }
    Ok(out)
}

/// Characters a `type` act may carry. Control characters other than `\n` and
/// `\t` would be interpreted as editing commands (a raw `\r` is Enter, `\x7f`
/// is Backspace, `\x1b` is Escape), and AppKit's function-key range
/// U+F700–U+F8FF would be read as arrow / delete / F-keys — so neither can
/// smuggle a key press past the closed key table.
pub fn text_char_allowed(c: char) -> bool {
    c == '\n' || c == '\t' || !(c.is_control() || ('\u{f700}'..='\u{f8ff}').contains(&c))
}

/// Map a point in CSS px of the tab's viewport to the webview's own
/// coordinate space (points, top-left origin — `WKWebView` is flipped).
///
/// `ratio = view width (pt) / window.innerWidth (CSS px)`, which folds in the
/// page zoom. A point up to one CSS px (plus one point of rounding) outside
/// the view is clamped onto its edge — the tap rounds element centres — but a
/// point further out, a non-finite number, or a nonsensical viewport is
/// refused: clicking "somewhere near" is never acceptable.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn css_to_view(
    css_x: f64,
    css_y: f64,
    vw_css: f64,
    view_w: f64,
    view_h: f64,
) -> Result<(f64, f64), &'static str> {
    let all_finite = [css_x, css_y, vw_css, view_w, view_h]
        .iter()
        .all(|v| v.is_finite());
    if !all_finite || vw_css <= 0.0 || view_w <= 0.0 || view_h <= 0.0 {
        return Err("bad-point");
    }
    let ratio = view_w / vw_css;
    if !ratio.is_finite() || ratio <= 0.0 {
        return Err("bad-point");
    }
    let (x, y) = (css_x * ratio, css_y * ratio);
    let tolerance = ratio + 1.0;
    if x < -tolerance || y < -tolerance || x > view_w + tolerance || y > view_h + tolerance {
        return Err("bad-point");
    }
    let max_x = (view_w - 1.0).max(0.0);
    let max_y = (view_h - 1.0).max(0.0);
    Ok((x.clamp(0.0, max_x), y.clamp(0.0, max_y)))
}

// ── operator input (the monitor) ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod registry {
    use std::{
        collections::HashMap,
        sync::{Mutex, MutexGuard, OnceLock},
        time::{Duration, Instant},
    };

    /// Browser tab windows by `NSWindow.windowNumber`.
    static TABS: OnceLock<Mutex<HashMap<isize, String>>> = OnceLock::new();
    /// When each tab last reported operator input.
    static LAST: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    /// A burst of key presses is one takeover, not dozens of events.
    pub const THROTTLE: Duration = Duration::from_millis(500);

    fn lock<T>(m: &'static OnceLock<Mutex<T>>, init: fn() -> T) -> MutexGuard<'static, T> {
        let m = m.get_or_init(|| Mutex::new(init()));
        match m.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    pub fn register(number: isize, tab: &str) {
        if number <= 0 {
            return;
        }
        let mut tabs = lock(&TABS, HashMap::new);
        tabs.retain(|_, t| t != tab);
        tabs.insert(number, tab.to_string());
    }

    pub fn forget(tab: &str) {
        lock(&TABS, HashMap::new).retain(|_, t| t != tab);
        lock(&LAST, HashMap::new).remove(tab);
    }

    /// The tab whose window has `number`, if it should be reported now.
    pub fn due(number: isize) -> Option<String> {
        let tab = lock(&TABS, HashMap::new).get(&number).cloned()?;
        let mut last = lock(&LAST, HashMap::new);
        let now = Instant::now();
        if last
            .get(&tab)
            .is_some_and(|at| now.duration_since(*at) < THROTTLE)
        {
            return None;
        }
        last.insert(tab.clone(), now);
        Some(tab)
    }
}

/// Remember that the tab window numbered `number` shows `tab` (called each
/// time a tab is shown: a window number is only assigned once the window has
/// been ordered in).
#[cfg(target_os = "macos")]
pub fn register_tab_window(number: isize, tab: &str) {
    registry::register(number, tab);
}

/// A tab window is gone.
pub fn forget_tab(_tab: &str) {
    #[cfg(target_os = "macos")]
    registry::forget(_tab);
}

/// Install the operator-input monitor. Call ONCE, on the main thread, at
/// startup. Elsewhere than macOS there is no native acting, so nothing to
/// hand back from.
#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) {
    use std::{panic::AssertUnwindSafe, ptr::NonNull, sync::OnceLock};

    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};

    static INSTALLED: OnceLock<()> = OnceLock::new();
    if INSTALLED.set(()).is_err() {
        return;
    }
    let app = app.clone();
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // Never unwind into AppKit, and never block or swallow: look the
        // window number up, maybe queue one eval, hand the event back as is.
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            // SAFETY: AppKit passes a valid NSEvent for the handler's duration.
            let number = unsafe { event.as_ref() }.windowNumber();
            if let Some(tab) = registry::due(number) {
                crate::browser_pane::emit_operator(&app, &tab);
            }
        }));
        event.as_ptr()
    });
    let mask = NSEventMask::LeftMouseDown
        | NSEventMask::RightMouseDown
        | NSEventMask::OtherMouseDown
        | NSEventMask::KeyDown;
    // SAFETY: the handler returns the event it was given (a valid pointer).
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler) };
    match monitor {
        // The monitor lives as long as the app; AppKit keeps the handler.
        Some(monitor) => std::mem::forget(monitor),
        None => eprintln!("[ashlr-desktop] could not install the browser-pane input monitor"),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) {}

// ── native synthesis (macOS) ─────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub mod native {
    use std::{sync::mpsc, time::Duration};

    use objc2::rc::Retained;
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
    use objc2_foundation::{NSPoint, NSProcessInfo, NSString};
    use objc2_web_kit::WKWebView;
    use tauri::WebviewWindow;

    use super::{css_to_view, Stroke};

    /// Run `f` on the main thread with the tab's WKWebView and NSWindow and
    /// wait (at most `timeout`) for its result. Never call from the main
    /// thread.
    pub fn on_main<R, F>(window: &WebviewWindow, timeout: Duration, f: F) -> Result<R, String>
    where
        R: Send + 'static,
        F: FnOnce(&WKWebView, &NSWindow) -> R + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Option<R>>();
        window
            .with_webview(move |platform| {
                let webview = platform.inner() as *const WKWebView;
                let ns_window = platform.ns_window() as *const NSWindow;
                // SAFETY: with_webview runs on the main thread; on macOS
                // inner() is the live WKWebView wry created for this window
                // and ns_window() its live NSWindow.
                let out = unsafe {
                    match (webview.as_ref(), ns_window.as_ref()) {
                        (Some(w), Some(n)) => Some(f(w, n)),
                        _ => None,
                    }
                };
                let _ = tx.send(out);
            })
            .map_err(|e| format!("webview-unavailable: {e}"))?;
        match rx.recv_timeout(timeout) {
            Ok(Some(value)) => Ok(value),
            Ok(None) => Err("no-webview".to_string()),
            Err(_) => Err("timeout".to_string()),
        }
    }

    fn now() -> f64 {
        NSProcessInfo::processInfo().systemUptime()
    }

    /// The view's size in points.
    pub fn view_size(webview: &WKWebView) -> (f64, f64) {
        let b = webview.bounds();
        (b.size.width, b.size.height)
    }

    /// CSS px in the viewport → window base coordinates for an NSEvent.
    fn window_point(
        webview: &WKWebView,
        css_x: f64,
        css_y: f64,
        vw: f64,
    ) -> Result<NSPoint, &'static str> {
        let (w, h) = view_size(webview);
        let (x, y) = css_to_view(css_x, css_y, vw, w, h)?;
        // WKWebView is flipped (top-left origin) — checked, not assumed.
        let y = if webview.isFlipped() { y } else { h - y };
        let point = webview.convertPoint_toView(NSPoint::new(x, y), None);
        if point.x.is_finite() && point.y.is_finite() {
            Ok(point)
        } else {
            Err("bad-point")
        }
    }

    fn mouse(
        ty: NSEventType,
        at: NSPoint,
        flags: usize,
        window: &NSWindow,
        clicks: isize,
        pressure: f32,
    ) -> Option<Retained<NSEvent>> {
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            ty,
            at,
            NSEventModifierFlags(flags),
            now(),
            window.windowNumber(),
            None,
            0,
            clicks,
            pressure,
        )
    }

    /// A left click (or double click) at a viewport point, with modifiers.
    pub fn click(
        webview: &WKWebView,
        window: &NSWindow,
        css: (f64, f64),
        vw: f64,
        flags: usize,
        double: bool,
        mut approved: impl FnMut() -> bool,
    ) -> Result<(), &'static str> {
        let at = window_point(webview, css.0, css.1, vw)?;
        let rounds: &[isize] = if double { &[1, 2] } else { &[1] };
        let mut events = Vec::with_capacity(rounds.len() * 2);
        for &count in rounds {
            events.push(mouse(
                NSEventType::LeftMouseDown,
                at,
                flags,
                window,
                count,
                1.0,
            ));
            events.push(mouse(
                NSEventType::LeftMouseUp,
                at,
                flags,
                window,
                count,
                0.0,
            ));
        }
        // Build every event first: half a click (down without up) would leave
        // the page in a drag.
        let events: Option<Vec<_>> = events.into_iter().collect();
        let events = events.ok_or("event-failed")?;
        // `NSWindow sendEvent:` implements click-to-focus: a mouse-down makes
        // the tab window key. The operator is typing in the Verse composer
        // while the agent works; if the tab stayed key, their next keystrokes
        // would land in the web page. So an agent click that took key status
        // gives it straight back to the Verse window (the tab's parent).
        // WebKit keeps the page's focused element and still accepts our key
        // events in a non-key window.
        let was_key = window.isKeyWindow();
        let mut pressed = false;
        for event in &events {
            if !approved() {
                // If navigation began after mouse-down, release the button
                // before aborting so the webview cannot remain in a drag.
                if pressed {
                    window.sendEvent(event);
                }
                return Err("approved-page-changed");
            }
            window.sendEvent(event);
            pressed = !pressed;
        }
        if !was_key && window.isKeyWindow() {
            if let Some(parent) = window.parentWindow() {
                parent.makeKeyWindow();
            }
        }
        Ok(())
    }

    /// Move the pointer to a viewport point (best effort: WebKit only
    /// updates `:hover` for a background window if it takes this path).
    pub fn hover(
        webview: &WKWebView,
        window: &NSWindow,
        css: (f64, f64),
        vw: f64,
        mut approved: impl FnMut() -> bool,
    ) -> Result<(), &'static str> {
        let at = window_point(webview, css.0, css.1, vw)?;
        window.setAcceptsMouseMovedEvents(true);
        let event = mouse(NSEventType::MouseMoved, at, 0, window, 0, 0.0).ok_or("event-failed")?;
        if !approved() {
            return Err("approved-page-changed");
        }
        window.sendEvent(&event);
        if !approved() {
            return Err("approved-page-changed");
        }
        webview.mouseMoved(&event);
        Ok(())
    }

    /// Make the webview the window's first responder (so key events reach
    /// the page) without making the window key.
    pub fn focus_webview(webview: &WKWebView, window: &NSWindow) {
        let current = window.firstResponder();
        let is_webview = current.as_deref().is_some_and(|r| {
            std::ptr::eq(r as *const _ as *const u8, webview as *const _ as *const u8)
        });
        if !is_webview {
            window.makeFirstResponder(Some(webview));
        }
    }

    /// Key presses (keyDown + keyUp each), in order.
    pub fn keys(
        window: &NSWindow,
        strokes: &[Stroke],
        mut approved: impl FnMut() -> bool,
    ) -> Result<(), &'static str> {
        let number = window.windowNumber();
        let mut events = Vec::with_capacity(strokes.len() * 2);
        for s in strokes {
            let chars = NSString::from_str(&s.chars);
            let base = NSString::from_str(&s.base);
            for ty in [NSEventType::KeyDown, NSEventType::KeyUp] {
                let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                    ty,
                    NSPoint::new(0.0, 0.0),
                    NSEventModifierFlags(s.flags),
                    now(),
                    number,
                    None,
                    &chars,
                    &base,
                    false,
                    s.key_code,
                );
                events.push(event.ok_or("event-failed")?);
            }
        }
        let mut pressed = false;
        for event in &events {
            if !approved() {
                // A matching key-up is still needed after key-down, even if
                // the page changed in between.
                if pressed {
                    window.sendEvent(event);
                }
                return Err("approved-page-changed");
            }
            window.sendEvent(event);
            pressed = !pressed;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_keys_and_printable_characters_parse() {
        let enter = parse_key_combo("Enter").unwrap();
        assert_eq!((enter.key_code, enter.chars.as_str()), (36, "\r"));
        for (name, code, chars) in NAMED_KEYS {
            let s = parse_key_combo(name).unwrap();
            assert_eq!(
                (s.key_code, s.chars.as_str(), s.base.as_str()),
                (*code, *chars, *chars)
            );
            assert_eq!(s.flags, 0);
        }
        let a = parse_key_combo("a").unwrap();
        assert_eq!((a.key_code, a.chars.as_str()), (0, "a"));
        let tilde = parse_key_combo("~").unwrap();
        assert_eq!(tilde.chars, "~");
        let plus = parse_key_combo("+").unwrap();
        assert_eq!(plus.chars, "+");
        let shift_plus = parse_key_combo("Shift++").unwrap();
        assert_eq!(
            (shift_plus.chars.as_str(), shift_plus.flags),
            ("+", 1 << 17)
        );
    }

    #[test]
    fn modifiers_combine_and_follow_appkit() {
        let s = parse_key_combo("Shift+Tab").unwrap();
        assert_eq!((s.key_code, s.flags), (48, 1 << 17));
        let s = parse_key_combo("Control+Alt+ArrowLeft").unwrap();
        assert_eq!(s.flags, (1 << 18) | (1 << 19));
        let s = parse_key_combo("Shift+a").unwrap();
        assert_eq!((s.chars.as_str(), s.base.as_str()), ("A", "a"));
        let s = parse_key_combo("Control+a").unwrap();
        assert_eq!((s.chars.as_str(), s.base.as_str()), ("\u{1}", "a"));
        let s = parse_key_combo("Meta+a").unwrap();
        assert_eq!((s.chars.as_str(), s.flags), ("a", 1 << 20));
        let s = parse_key_combo("Meta+z").unwrap();
        assert_eq!(s.base, "z");
        let s = parse_key_combo("Meta+Shift+z").unwrap();
        assert_eq!(s.flags, (1 << 20) | (1 << 17));
    }

    #[test]
    fn dangerous_or_malformed_combos_are_refused() {
        for bad in [
            "",
            "Meta+v",
            "Meta+q",
            "Meta+w",
            "Meta+c",
            "Meta+x",
            "Meta+Enter",
            "Meta+A",
            "Meta+Alt+z",
            "Control+Meta+a",
            "Meta",
            "Shift",
            "Shift+Shift+a",
            "Hyper+a",
            "shift+a",
            "enter",
            "F5",
            "ab",
            " ",
            "é",
            "\u{7f}",
            "+a",
            "Shift+",
            "Shift+ +a",
            "Control++Enter",
            "Shift+Alt+Control+Control+a",
        ] {
            assert_eq!(parse_key_combo(bad), None, "should refuse {bad:?}");
        }
        let long = format!("{}a", "Shift+".repeat(6));
        assert!(long.chars().count() > KEY_COMBO_MAX_CHARS);
        assert_eq!(parse_key_combo(&long), None);
    }

    #[test]
    fn text_becomes_key_presses() {
        let s = strokes_for_text("hé\t👍", false).unwrap();
        let chars: Vec<_> = s.iter().map(|s| (s.key_code, s.chars.as_str())).collect();
        assert_eq!(chars, vec![(0, "h"), (0, "é"), (48, "\t"), (0, "👍")]);
        assert!(s.iter().all(|s| s.flags == 0 && s.chars == s.base));
        let lines = strokes_for_text("a\nb", true).unwrap();
        assert_eq!(lines[1], Stroke::plain(36, "\r"));
        assert_eq!(
            strokes_for_text("a\nb", false),
            Err("newline-in-single-line-field")
        );
        for bad in ["a\rb", "\u{7f}", "\u{1b}", "x\u{f728}", "\u{0}"] {
            assert_eq!(
                strokes_for_text(bad, true),
                Err("unsupported-char"),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn css_points_map_onto_the_view() {
        // 800 CSS px shown in a 800 pt view: 1:1.
        assert_eq!(
            css_to_view(10.0, 20.0, 800.0, 800.0, 600.0),
            Ok((10.0, 20.0))
        );
        // Page zoomed to 200 %: innerWidth halves, so CSS px double.
        assert_eq!(
            css_to_view(10.0, 20.0, 400.0, 800.0, 600.0),
            Ok((20.0, 40.0))
        );
        // Rounding just past the edge is clamped onto it…
        assert_eq!(
            css_to_view(800.5, 600.5, 800.0, 800.0, 600.0),
            Ok((799.0, 599.0))
        );
        assert_eq!(css_to_view(-0.5, 0.0, 800.0, 800.0, 600.0), Ok((0.0, 0.0)));
        // …but a point off the page, or nonsense, is refused.
        for (x, y, vw, w, h) in [
            (900.0, 10.0, 800.0, 800.0, 600.0),
            (10.0, -50.0, 800.0, 800.0, 600.0),
            (f64::NAN, 10.0, 800.0, 800.0, 600.0),
            (10.0, f64::INFINITY, 800.0, 800.0, 600.0),
            (10.0, 10.0, 0.0, 800.0, 600.0),
            (10.0, 10.0, -1.0, 800.0, 600.0),
            (10.0, 10.0, f64::NAN, 800.0, 600.0),
            (10.0, 10.0, 800.0, 0.0, 600.0),
            (10.0, 10.0, 1e-320, 800.0, 600.0),
        ] {
            assert_eq!(
                css_to_view(x, y, vw, w, h),
                Err("bad-point"),
                "{x},{y},{vw},{w},{h}"
            );
        }
    }

    #[test]
    fn modifier_flags_are_appkits() {
        assert_eq!(
            modifier_flags(&[
                Modifier::Shift,
                Modifier::Control,
                Modifier::Alt,
                Modifier::Meta
            ]),
            0x1e_0000
        );
        assert_eq!(modifier_flags(&[]), 0);
        let parsed: Vec<Modifier> = serde_json::from_str(r#"["Shift","Meta"]"#).unwrap();
        assert_eq!(parsed, vec![Modifier::Shift, Modifier::Meta]);
        assert!(serde_json::from_str::<Vec<Modifier>>(r#"["Cmd"]"#).is_err());
    }
}

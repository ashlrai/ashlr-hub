//! Native notifications: what they say, when they are allowed, and how they
//! reach the OS.
//!
//! Every word a notification shows is rendered HERE, from a fixed template:
//!
//!   * "Finished: ‹chat title›" / "Failed: ‹chat title›" — a chat turn ended,
//!   * "Finished: N chats" — several ended in one poll (one banner, not a burst),
//!   * "Needs you: N new" — new items in the Needs-you drawer, described by
//!     CATEGORY COUNTS only ("2 approvals · 1 fleet decision"),
//!   * seat health — `health_watch` renders that text from its own templates.
//!
//! The only server-supplied text that can reach a banner is a chat title, and
//! it passes [`sanitize_title`] first: control and bidi-override characters are
//! stripped (a title cannot fake a line break or flip "Finished" into
//! something else visually) and it is capped at [`TITLE_MAX_CHARS`]. Needs-you
//! item titles are producer text (Track B, other chats) and never appear.
//!
//! WHEN: only while the Verse window is not in front of the operator
//! ([`should_deliver`]) — a banner about something already on screen is noise.
//! The one exception is the "local server keeps stopping" alert, which is about
//! the window itself and goes out regardless.
//!
//! CLICKS: `tauri-plugin-notification` cannot report a click on desktop. So
//! each banner ARMS a [`PendingClick`]; if the window regains focus within
//! [`CLICK_WINDOW`] (which is what clicking a banner does), Rust sends the page
//! `open-session:<id>` or `open-needs-you`. Focus regained for another reason
//! inside that window also navigates — the documented trade the spec accepts.
//!
//! HOW: a Developer ID–signed bundle uses the plugin (Ashlr's icon, grouped
//! under Ashlr in Notification Centre). Anything else — ad-hoc signed (every
//! local `cargo tauri build`), unsigned, or `cargo run` — uses `osascript`,
//! because macOS may silently drop plugin notifications from an app it cannot
//! identify. osascript banners show as Script Editor; that is the honest cost
//! of an unsigned build, and Settings ▸ Desktop says so (`delivery: "script"`).

use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

/// Longest chat title a banner shows, in characters (SPEC-310C §1).
pub const TITLE_MAX_CHARS: usize = 60;
/// How long after a banner a focus-regain counts as "clicked it".
pub const CLICK_WINDOW: Duration = Duration::from_secs(60);
/// Burst guard: at most this many banners per [`THROTTLE_WINDOW`]. A healthy
/// app never gets close (completions are already coalesced per poll); this is
/// the backstop for a server that suddenly reports a flood.
pub const THROTTLE_MAX: usize = 6;
pub const THROTTLE_WINDOW: Duration = Duration::from_secs(60);
/// What a title that sanitizes down to nothing is called.
const UNTITLED: &str = "Untitled chat";

// ── title sanitizer ──────────────────────────────────────────────────────────

/// Characters that change how text RENDERS without being visible: bidi
/// embeddings/overrides/isolates, zero-width joiners and spaces, the BOM.
/// `char::is_control` covers C0/C1 but none of these (they are Unicode `Cf`).
fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'                    // soft hyphen
        | '\u{061C}'                  // Arabic letter mark
        | '\u{180E}'                  // Mongolian vowel separator
        | '\u{200B}'..='\u{200F}'     // zero-width space/joiners, LRM, RLM
        | '\u{202A}'..='\u{202E}'     // LRE RLE PDF LRO RLO
        | '\u{2060}'..='\u{2064}'     // word joiner, invisible operators
        | '\u{2066}'..='\u{2069}'     // LRI RLI FSI PDI
        | '\u{206A}'..='\u{206F}'     // deprecated format controls
        | '\u{FEFF}'                  // BOM / zero-width no-break space
        | '\u{FFF9}'..='\u{FFFB}' // interlinear annotation
    )
}

/// A chat title as a banner may show it: control and bidi characters gone,
/// whitespace collapsed to single spaces, at most [`TITLE_MAX_CHARS`]
/// characters (an ellipsis marks a cut), never empty.
pub fn sanitize_title(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(TITLE_MAX_CHARS * 4));
    let mut pending_space = false;
    for c in raw.chars() {
        if is_invisible_format(c) {
            continue;
        }
        // A control character (newline, tab, ESC, C1…) is a word break, not
        // text: "a\nb" reads "a b", never "ab" and never two lines.
        if c.is_control() || c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
    }
    if out.is_empty() {
        return UNTITLED.to_string();
    }
    if out.chars().count() > TITLE_MAX_CHARS {
        let mut cut: String = out.chars().take(TITLE_MAX_CHARS - 1).collect();
        // Do not leave "word …" with a dangling space before the ellipsis.
        while cut.ends_with(' ') {
            cut.pop();
        }
        cut.push('…');
        return cut;
    }
    out
}

// ── click targets ────────────────────────────────────────────────────────────

/// A session id the page will accept in `open-session:<id>` — the same shape
/// as C0's `OPEN_SESSION_COMMAND_RE` (`^[A-Za-z0-9._-]{1,128}$`), checked here
/// so Rust never builds a command the page would reject (or one that could
/// smuggle a second command).
pub fn is_valid_session_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Where a clicked banner takes the operator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClickTarget {
    Session(String),
    NeedsYou,
}

impl ClickTarget {
    /// `None` for an id the page would refuse.
    pub fn session(id: &str) -> Option<Self> {
        is_valid_session_id(id).then(|| Self::Session(id.to_string()))
    }

    /// The desktop command (`ashlr:desktop-command`) this target sends.
    pub fn command(&self) -> String {
        match self {
            Self::Session(id) => format!("open-session:{id}"),
            Self::NeedsYou => "open-needs-you".to_string(),
        }
    }
}

/// The most recent banner's target, armed when it is shown and taken the next
/// time the window gains focus. Only the latest banner counts: that is the one
/// on top of Notification Centre, so the one most likely clicked.
#[derive(Debug, Default)]
pub struct PendingClick {
    slot: Option<(ClickTarget, Instant)>,
}

impl PendingClick {
    pub fn arm(&mut self, target: ClickTarget, now: Instant) {
        self.slot = Some((target, now));
    }

    /// The armed target if it is at most [`CLICK_WINDOW`] old. Always disarms:
    /// one focus-regain consumes it, fresh or stale.
    pub fn take_fresh(&mut self, now: Instant) -> Option<ClickTarget> {
        let (target, at) = self.slot.take()?;
        (now.saturating_duration_since(at) <= CLICK_WINDOW).then_some(target)
    }

    /// Forget the armed target — an explicit navigation (tray, hotkey) wins
    /// over a banner that may never have been clicked.
    pub fn clear(&mut self) {
        self.slot = None;
    }
}

// ── when ─────────────────────────────────────────────────────────────────────

/// Is the Verse window in front of the operator right now?
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowPresence {
    pub visible: bool,
    pub focused: bool,
    pub minimized: bool,
}

impl WindowPresence {
    /// No window at all (still launching, or it failed to build).
    pub const ABSENT: Self = Self {
        visible: false,
        focused: false,
        minimized: false,
    };

    /// On screen and not tucked into the Dock.
    pub fn is_shown(self) -> bool {
        self.visible && !self.minimized
    }

    /// The operator is looking at it.
    pub fn is_in_front(self) -> bool {
        self.is_shown() && self.focused
    }
}

/// Banners go out only while the window is NOT in front, and only when the
/// operator has not switched them off in Settings ▸ Desktop.
pub fn should_deliver(presence: WindowPresence, enabled: bool) -> bool {
    enabled && !presence.is_in_front()
}

/// A sliding-window cap on banners.
#[derive(Debug, Default)]
pub struct Throttle {
    sent: VecDeque<Instant>,
}

impl Throttle {
    /// True (and counted) when one more banner fits in the window.
    pub fn allow(&mut self, now: Instant) -> bool {
        while let Some(&first) = self.sent.front() {
            if now.saturating_duration_since(first) >= THROTTLE_WINDOW {
                self.sent.pop_front();
            } else {
                break;
            }
        }
        if self.sent.len() >= THROTTLE_MAX {
            return false;
        }
        self.sent.push_back(now);
        true
    }
}

// ── what ─────────────────────────────────────────────────────────────────────

/// How many new Needs-you items fall in each drawer split. The split is a
/// pure function of the item's `kind` (C0's `NEEDS_YOU_KIND_CATEGORY`), so a
/// producer cannot relabel its item into friendlier words.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NeedsYouCounts {
    pub approvals: usize,
    pub fleet: usize,
    pub chats: usize,
    pub accounts: usize,
    /// A kind this build does not know (a newer server). Counted, not named.
    pub other: usize,
}

impl NeedsYouCounts {
    /// Mirror of C0's `NEEDS_YOU_KIND_CATEGORY` (core/verse/workbench-types.ts).
    pub fn add_kind(&mut self, kind: &str) {
        match kind {
            "approval" | "owner-lane-pr" | "class-c" => self.approvals += 1,
            "veto-window" | "leader-question" | "owner-hold" | "quarantine" | "revert"
            | "grant" | "kill" => self.fleet += 1,
            "chat-failed" | "queue-held" => self.chats += 1,
            "reconnect" | "repin" => self.accounts += 1,
            _ => self.other += 1,
        }
    }

    pub fn total(&self) -> usize {
        self.approvals + self.fleet + self.chats + self.accounts + self.other
    }

    /// "2 approvals · 1 fleet decision" — categories in drawer order.
    pub fn describe(&self) -> String {
        let parts: Vec<String> = [
            (self.approvals, "approval", "approvals"),
            (self.fleet, "fleet decision", "fleet decisions"),
            (self.chats, "chat", "chats"),
            (self.accounts, "account", "accounts"),
            (self.other, "other item", "other items"),
        ]
        .iter()
        .filter(|(n, _, _)| *n > 0)
        .map(|(n, one, many)| format!("{n} {}", if *n == 1 { *one } else { *many }))
        .collect();
        parts.join(" · ")
    }
}

/// Something worth a banner. Titles are raw here and sanitized in [`render`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    Finished {
        session_id: String,
        title: String,
        duration_ms: Option<u64>,
    },
    Failed {
        session_id: String,
        title: String,
    },
    /// Several turns ended in one poll. `focus` is the chat a click opens:
    /// the newest failure if any, otherwise the newest finish.
    Chats {
        finished: usize,
        failed: usize,
        focus: Option<String>,
    },
    NeedsYou {
        new: NeedsYouCounts,
        waiting: usize,
    },
    /// Seat health — `health_watch::notification_text` already rendered it
    /// from its own templates.
    SeatHealth {
        title: String,
        body: String,
    },
}

/// A banner ready for the OS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rendered {
    pub title: String,
    pub body: String,
    pub click: Option<ClickTarget>,
}

/// "42s", "2m 14s", "1h 05m" — how long a turn ran.
pub fn turn_duration(ms: u64) -> String {
    let secs = ms / 1000;
    if secs < 1 {
        return "under a second".to_string();
    }
    if secs < 60 {
        return format!("{secs}s");
    }
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if h > 0 {
        format!("{h}h {m:02}m")
    } else {
        format!("{m}m {s:02}s")
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Turn a notice into banner text. Pure; every string is a template.
pub fn render(notice: &Notice) -> Rendered {
    match notice {
        Notice::Finished {
            session_id,
            title,
            duration_ms,
        } => Rendered {
            title: format!("Finished: {}", sanitize_title(title)),
            body: match duration_ms {
                Some(ms) => format!("Done in {}. Click to open the chat.", turn_duration(*ms)),
                None => "Click to open the chat.".to_string(),
            },
            click: ClickTarget::session(session_id),
        },
        Notice::Failed { session_id, title } => Rendered {
            title: format!("Failed: {}", sanitize_title(title)),
            body: "The turn stopped with an error. Click to see what happened.".to_string(),
            click: ClickTarget::session(session_id),
        },
        Notice::Chats {
            finished,
            failed,
            focus,
        } => {
            let total = finished + failed;
            let title = if *failed > 0 {
                format!(
                    "Finished: {}, {} failed",
                    plural(total, "chat", "chats"),
                    failed
                )
            } else {
                format!("Finished: {}", plural(total, "chat", "chats"))
            };
            Rendered {
                title,
                body: "Open Ashlr to review them.".to_string(),
                click: focus.as_deref().and_then(ClickTarget::session),
            }
        }
        Notice::NeedsYou { new, waiting } => {
            let described = new.describe();
            let body = if *waiting > new.total() {
                format!("{described} ({waiting} waiting in all)")
            } else {
                described
            };
            Rendered {
                title: format!("Needs you: {} new", new.total()),
                body,
                click: Some(ClickTarget::NeedsYou),
            }
        }
        Notice::SeatHealth { title, body } => Rendered {
            title: title.clone(),
            body: body.clone(),
            // Account problems are fixed from the drawer's Accounts split.
            click: Some(ClickTarget::NeedsYou),
        },
    }
}

// ── how ──────────────────────────────────────────────────────────────────────

/// How the running bundle is signed, from `codesign -dv` output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signing {
    /// A real identity with a Team ID (Developer ID or Apple Development).
    Developer,
    /// Ad-hoc — what the linker and a local `cargo tauri build` produce.
    AdHoc,
    Unsigned,
    /// Not in a bundle, codesign missing, or output we do not recognise.
    Unknown,
}

/// Classify `codesign -dv --verbose=2 <bundle>` STDERR (codesign reports on
/// stderr). Conservative: anything short of a Team ID is not `Developer`.
pub fn classify_codesign(stderr: &str) -> Signing {
    if stderr.contains("not signed at all") {
        return Signing::Unsigned;
    }
    if stderr.lines().any(|l| l.trim() == "Signature=adhoc") {
        return Signing::AdHoc;
    }
    let team = stderr
        .lines()
        .find_map(|l| l.trim().strip_prefix("TeamIdentifier="))
        .map(str::trim);
    match team {
        Some(t) if !t.is_empty() && t != "not set" => Signing::Developer,
        _ => Signing::Unknown,
    }
}

/// How a banner reaches the OS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// `tauri-plugin-notification`.
    Native,
    /// `osascript display notification` (macOS, unsigned builds).
    Script,
}

impl Delivery {
    /// The word Settings ▸ Desktop shows (`DesktopState.notifications.delivery`).
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Script => "script",
        }
    }
}

/// macOS: only a Developer-signed bundle uses the plugin. Elsewhere the plugin
/// has no identity requirement (and Linux bundles are quarantined anyway).
pub fn delivery_for(signing: Signing, macos: bool) -> Delivery {
    if !macos || signing == Signing::Developer {
        Delivery::Native
    } else {
        Delivery::Script
    }
}

/// The `.app` bundle the executable runs from, if any.
fn bundle_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(|p| p.to_path_buf())
}

/// Decide once per launch (spawns `codesign`, ~20 ms). Off the main thread.
pub fn detect_delivery() -> Delivery {
    let macos = cfg!(target_os = "macos");
    if !macos {
        return delivery_for(Signing::Unknown, false);
    }
    let signing = match bundle_path() {
        None => Signing::Unknown, // `cargo run` / `tauri dev`
        Some(bundle) => match std::process::Command::new("/usr/bin/codesign")
            .args(["-dv", "--verbose=2"])
            .arg(&bundle)
            .output()
        {
            Ok(out) => classify_codesign(&String::from_utf8_lossy(&out.stderr)),
            Err(_) => Signing::Unknown,
        },
    };
    delivery_for(signing, true)
}

/// Show one banner. Best effort: a failure is logged (title only — never a
/// token, and the title is our own template), never raised.
pub fn deliver<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    delivery: Delivery,
    title: &str,
    body: &str,
) {
    match delivery {
        Delivery::Native => {
            use tauri_plugin_notification::NotificationExt;
            if let Err(e) = app.notification().builder().title(title).body(body).show() {
                eprintln!(
                    "[ashlr-desktop] native notification failed ({e}) — using the script fallback"
                );
                deliver_script(title, body);
            }
        }
        Delivery::Script => deliver_script(title, body),
    }
}

/// The osascript / notify-send path (moved here from `health_watch`).
pub fn deliver_script(title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    {
        // Text travels as argv to an AppleScript `on run`, never spliced into
        // the script source — a title like `"; do shell script "…` is just text.
        let result = std::process::Command::new("/usr/bin/osascript")
            .args([
                "-e",
                "on run argv",
                "-e",
                "display notification (item 2 of argv) with title (item 1 of argv)",
                "-e",
                "end run",
                title,
                body,
            ])
            .output();
        if let Err(e) = result {
            eprintln!("[ashlr-desktop] could not show a notification: {e}");
        }
    }
    #[cfg(target_os = "linux")]
    {
        let result = std::process::Command::new("notify-send")
            .args(["--app-name=Ashlr", "--", title, body])
            .output();
        if result.is_err() {
            eprintln!("[ashlr-desktop] notification (notify-send unavailable): {title}");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = body;
        eprintln!("[ashlr-desktop] notification: {title}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── sanitizer ────────────────────────────────────────────────────────────

    #[test]
    fn titles_lose_control_and_bidi_characters() {
        assert_eq!(sanitize_title("Fix\nthe\tbuild\r\n"), "Fix the build");
        assert_eq!(sanitize_title("\u{1b}[31mred\u{1b}[0m"), "[31mred [0m");
        // RLO would render "Finished: gnitset" as "Finished: testing" reversed.
        assert_eq!(sanitize_title("a\u{202e}gnitset\u{202c}b"), "agnitsetb");
        assert_eq!(sanitize_title("x\u{2066}y\u{2069}z\u{200f}\u{feff}"), "xyz");
        assert_eq!(sanitize_title("zero\u{200b}width"), "zerowidth");
        assert_eq!(sanitize_title("c1\u{85}next line"), "c1 next line");
        assert_eq!(sanitize_title("  lots   of    space  "), "lots of space");
    }

    #[test]
    fn an_empty_or_invisible_title_gets_a_name() {
        assert_eq!(sanitize_title(""), "Untitled chat");
        assert_eq!(sanitize_title(" \n\t "), "Untitled chat");
        assert_eq!(sanitize_title("\u{202e}\u{200b}"), "Untitled chat");
    }

    #[test]
    fn titles_are_capped_at_sixty_characters_with_an_ellipsis() {
        let long = "word ".repeat(40);
        let out = sanitize_title(&long);
        assert!(out.chars().count() <= TITLE_MAX_CHARS, "{out}");
        assert!(out.ends_with('…'));
        assert!(
            !out.ends_with(" …"),
            "no dangling space before the ellipsis: {out:?}"
        );

        let exact = "x".repeat(TITLE_MAX_CHARS);
        assert_eq!(sanitize_title(&exact), exact, "exactly 60 is not cut");

        // Characters, not bytes: 61 emoji become 59 + ellipsis, never a split code point.
        let emoji = "🦀".repeat(61);
        let out = sanitize_title(&emoji);
        assert_eq!(out.chars().count(), TITLE_MAX_CHARS);
        assert!(out.starts_with("🦀🦀"));
    }

    // ── click targets ────────────────────────────────────────────────────────

    #[test]
    fn open_session_ids_match_the_pages_regex() {
        // The same cases C0's parseDesktopCommand test uses.
        for good in ["vs_01J9-abc.def", "a", "A.B_C-9", &"x".repeat(128)] {
            assert!(is_valid_session_id(good), "{good}");
            assert_eq!(
                ClickTarget::session(good).map(|t| t.command()),
                Some(format!("open-session:{good}"))
            );
        }
        for bad in [
            "",
            &"x".repeat(129),
            "a b",
            "a:b",
            "a/b",
            "a\nopen-needs-you",
            "../etc",
            "é",
            "id\"",
        ] {
            assert!(!is_valid_session_id(bad), "{bad:?}");
            assert_eq!(ClickTarget::session(bad), None, "{bad:?}");
        }
        assert_eq!(ClickTarget::NeedsYou.command(), "open-needs-you");
    }

    #[test]
    fn a_click_counts_only_within_sixty_seconds_and_only_once() {
        let t0 = Instant::now();
        let mut pending = PendingClick::default();
        assert_eq!(pending.take_fresh(t0), None);

        pending.arm(ClickTarget::NeedsYou, t0);
        assert_eq!(
            pending.take_fresh(t0 + Duration::from_secs(59)),
            Some(ClickTarget::NeedsYou)
        );
        assert_eq!(
            pending.take_fresh(t0 + Duration::from_secs(59)),
            None,
            "consumed"
        );

        pending.arm(ClickTarget::NeedsYou, t0);
        assert_eq!(
            pending.take_fresh(t0 + CLICK_WINDOW),
            Some(ClickTarget::NeedsYou)
        );

        pending.arm(ClickTarget::NeedsYou, t0);
        assert_eq!(
            pending.take_fresh(t0 + Duration::from_secs(61)),
            None,
            "stale"
        );
        assert_eq!(pending.take_fresh(t0), None, "a stale take still disarms");

        // Only the latest banner counts.
        pending.arm(ClickTarget::session("first").unwrap(), t0);
        pending.arm(ClickTarget::session("second").unwrap(), t0);
        assert_eq!(pending.take_fresh(t0), ClickTarget::session("second"));

        pending.arm(ClickTarget::NeedsYou, t0);
        pending.clear();
        assert_eq!(pending.take_fresh(t0), None);
    }

    // ── gate ─────────────────────────────────────────────────────────────────

    #[test]
    fn notifications_go_out_only_while_the_window_is_not_in_front() {
        let front = WindowPresence {
            visible: true,
            focused: true,
            minimized: false,
        };
        assert!(
            !should_deliver(front, true),
            "the operator is looking at it"
        );

        let background = WindowPresence {
            focused: false,
            ..front
        };
        assert!(should_deliver(background, true), "another app is in front");

        let hidden = WindowPresence {
            visible: false,
            ..front
        };
        assert!(should_deliver(hidden, true), "closed to the tray");

        let minimized = WindowPresence {
            minimized: true,
            ..front
        };
        assert!(should_deliver(minimized, true), "in the Dock");

        assert!(should_deliver(WindowPresence::ABSENT, true));
        for presence in [front, background, hidden, WindowPresence::ABSENT] {
            assert!(!should_deliver(presence, false), "switched off in Settings");
        }
    }

    #[test]
    fn the_burst_guard_caps_banners_per_minute() {
        let t0 = Instant::now();
        let mut throttle = Throttle::default();
        for i in 0..THROTTLE_MAX {
            assert!(
                throttle.allow(t0 + Duration::from_secs(i as u64)),
                "banner {i}"
            );
        }
        assert!(!throttle.allow(t0 + Duration::from_secs(10)));
        // The first one ages out of the window.
        assert!(throttle.allow(t0 + THROTTLE_WINDOW));
        assert!(!throttle.allow(t0 + THROTTLE_WINDOW));
    }

    // ── templates ────────────────────────────────────────────────────────────

    #[test]
    fn a_finished_turn_names_the_chat_and_how_long_it_took() {
        let r = render(&Notice::Finished {
            session_id: "vs_1".into(),
            title: "Refactor\nthe router".into(),
            duration_ms: Some(134_000),
        });
        assert_eq!(r.title, "Finished: Refactor the router");
        assert_eq!(r.body, "Done in 2m 14s. Click to open the chat.");
        assert_eq!(r.click, Some(ClickTarget::Session("vs_1".into())));

        let r = render(&Notice::Finished {
            session_id: "vs_1".into(),
            title: "x".into(),
            duration_ms: None,
        });
        assert_eq!(r.body, "Click to open the chat.");
    }

    #[test]
    fn a_failed_turn_says_failed_and_opens_the_chat() {
        let r = render(&Notice::Failed {
            session_id: "vs_2".into(),
            title: "Deploy".into(),
        });
        assert_eq!(r.title, "Failed: Deploy");
        assert!(r.body.contains("error"));
        assert_eq!(r.click, Some(ClickTarget::Session("vs_2".into())));
    }

    #[test]
    fn a_hostile_session_id_yields_a_banner_with_no_click_target() {
        let r = render(&Notice::Finished {
            session_id: "x\nopen-settings".into(),
            title: "t".into(),
            duration_ms: None,
        });
        assert_eq!(r.click, None);
    }

    #[test]
    fn a_burst_of_endings_is_one_banner() {
        let r = render(&Notice::Chats {
            finished: 3,
            failed: 1,
            focus: Some("vs_9".into()),
        });
        assert_eq!(r.title, "Finished: 4 chats, 1 failed");
        assert_eq!(r.click, Some(ClickTarget::Session("vs_9".into())));
        let r = render(&Notice::Chats {
            finished: 3,
            failed: 0,
            focus: None,
        });
        assert_eq!(r.title, "Finished: 3 chats");
        assert_eq!(r.click, None);
    }

    #[test]
    fn needs_you_is_described_by_category_counts_never_item_text() {
        let mut new = NeedsYouCounts::default();
        for kind in [
            "approval",
            "class-c",
            "veto-window",
            "reconnect",
            "brand-new-kind",
        ] {
            new.add_kind(kind);
        }
        let r = render(&Notice::NeedsYou { new, waiting: 5 });
        assert_eq!(r.title, "Needs you: 5 new");
        assert_eq!(
            r.body,
            "2 approvals · 1 fleet decision · 1 account · 1 other item"
        );
        assert_eq!(r.click, Some(ClickTarget::NeedsYou));

        let mut one = NeedsYouCounts::default();
        one.add_kind("owner-hold");
        let r = render(&Notice::NeedsYou {
            new: one,
            waiting: 4,
        });
        assert_eq!(r.title, "Needs you: 1 new");
        assert_eq!(r.body, "1 fleet decision (4 waiting in all)");
    }

    #[test]
    fn every_known_needs_you_kind_has_a_category() {
        // C0's NEEDS_YOU_KINDS; a kind missing here would read "other item".
        for kind in [
            "approval",
            "owner-lane-pr",
            "class-c",
            "veto-window",
            "leader-question",
            "owner-hold",
            "quarantine",
            "revert",
            "grant",
            "kill",
            "chat-failed",
            "queue-held",
            "reconnect",
            "repin",
        ] {
            let mut c = NeedsYouCounts::default();
            c.add_kind(kind);
            assert_eq!(c.other, 0, "{kind} fell through to other");
            assert_eq!(c.total(), 1);
        }
    }

    #[test]
    fn turn_durations_read_like_a_person_wrote_them() {
        assert_eq!(turn_duration(0), "under a second");
        assert_eq!(turn_duration(999), "under a second");
        assert_eq!(turn_duration(42_000), "42s");
        assert_eq!(turn_duration(62_000), "1m 02s");
        assert_eq!(turn_duration(3_600_000 + 5 * 60_000), "1h 05m");
    }

    // ── delivery ─────────────────────────────────────────────────────────────

    #[test]
    fn codesign_output_is_classified_conservatively() {
        let developer = "Executable=/Applications/Ashlr.app/Contents/MacOS/ashlr-desktop\n\
            Identifier=ai.ashlr.desktop\nFormat=app bundle with Mach-O thin (arm64)\n\
            Authority=Developer ID Application: Mason Wyatt (ABCDE12345)\n\
            Authority=Developer ID Certification Authority\nTeamIdentifier=ABCDE12345\n";
        assert_eq!(classify_codesign(developer), Signing::Developer);

        let adhoc = "Executable=/x/Ashlr.app/Contents/MacOS/ashlr-desktop\nIdentifier=ashlr_desktop-55554944\n\
            Signature=adhoc\nInfo.plist=not bound\nTeamIdentifier=not set\n";
        assert_eq!(classify_codesign(adhoc), Signing::AdHoc);

        assert_eq!(
            classify_codesign("/x/Ashlr.app: code object is not signed at all\n"),
            Signing::Unsigned
        );
        assert_eq!(
            classify_codesign("TeamIdentifier=not set\n"),
            Signing::Unknown
        );
        assert_eq!(classify_codesign(""), Signing::Unknown);
        assert_eq!(classify_codesign("TeamIdentifier=\n"), Signing::Unknown);
    }

    #[test]
    fn unsigned_builds_fall_back_to_osascript_on_macos() {
        assert_eq!(delivery_for(Signing::Developer, true), Delivery::Native);
        for s in [Signing::AdHoc, Signing::Unsigned, Signing::Unknown] {
            assert_eq!(delivery_for(s, true), Delivery::Script, "{s:?}");
        }
        assert_eq!(delivery_for(Signing::Unknown, false), Delivery::Native);
        assert_eq!(Delivery::Native.wire_name(), "native");
        assert_eq!(Delivery::Script.wire_name(), "script");
    }
}

//! What the shell watches while Verse is out of sight: running chats, finished
//! turns and the Needs-you queue, from `GET /api/verse/activity?since=`
//! (C1's route; contract `VerseActivityResponse` in
//! `src/core/verse/workbench-types.ts`).
//!
//! Rust polls it through `health_watch::fetch` — the same tiny loopback client,
//! read token in a header, body cap, hard timeouts — every
//! [`ACTIVE_INTERVAL`], or every [`IDLE_INTERVAL`] while the window is hidden
//! AND nothing is running (a hidden, idle app has nothing to announce soon; the
//! 5 s cadence while a chat runs is what makes "Finished" feel immediate). A
//! build without the route (404) is checked every [`IDLE_INTERVAL`] too.
//!
//! One poll folds into a [`Fold`]: the banners to show, the tray's running
//! list, and the dock badge count. Decisions live here as pure functions; the
//! thread, the window and the OS calls live in `main.rs`.
//!
//! Honesty rules this module keeps:
//!   * The FIRST poll is a baseline — history is not news, so nothing already
//!     finished or already waiting when the app started raises a banner.
//!   * A cursor the server rejects (400) is dropped, never retried forever; a
//!     restarted server (new boot id) resets completions server-side.
//!   * Only fields this module reads are parsed; unknown fields are ignored so
//!     C1 can grow the response without breaking the shell.

use std::{collections::HashSet, collections::VecDeque, time::Duration};

use serde::Deserialize;

use crate::notify::{self, NeedsYouCounts, Notice};

pub const ACTIVITY_PATH: &str = "/api/verse/activity";
/// While the window is shown or anything runs. Well above the spec's 2 s floor.
pub const ACTIVE_INTERVAL: Duration = Duration::from_secs(5);
/// While hidden and idle, and while the route is missing from this build.
pub const IDLE_INTERVAL: Duration = Duration::from_secs(30);
/// Up to this many endings in one poll get their own banner; more become one.
pub const MAX_INDIVIDUAL_ENDINGS: usize = 2;
/// Failed-chat sessions remembered so a `chat-failed` Needs-you item that
/// shows up a poll later does not announce the same failure twice.
const RECENT_FAILURES: usize = 64;
/// Longest Needs-you id remembered (ids are `<source>:<kind>:<ref>`).
const MAX_ITEM_ID_CHARS: usize = 256;

// ── wire shape (the subset the shell reads) ─────────────────────────────────

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct RunningChat {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct ItemSubject {
    #[serde(rename = "sessionId", default)]
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct NeedsYouRef {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub subject: ItemSubject,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Completion {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(default)]
    pub title: String,
    /// `ok` | `failed` | `cancelled`.
    pub outcome: String,
    #[serde(rename = "durationMs", default)]
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct Counts {
    #[serde(rename = "needsYou", default)]
    pub needs_you: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct ActivitySnapshot {
    pub cursor: String,
    #[serde(default)]
    pub running: Vec<RunningChat>,
    #[serde(rename = "needsYou", default)]
    pub needs_you: Vec<NeedsYouRef>,
    #[serde(default)]
    pub completions: Vec<Completion>,
    #[serde(default)]
    pub counts: Counts,
}

/// Parse a response body. `None` for anything that is not one.
pub fn parse_activity(body: &str) -> Option<ActivitySnapshot> {
    serde_json::from_str(body).ok()
}

/// A cursor we are willing to echo back: the route's own `v1.<boot>.<m>.<seq>`
/// shape needs nothing outside `[A-Za-z0-9._-]`, so nothing else is sent (no
/// query-string injection, no URL encoding to get wrong).
pub fn is_safe_cursor(cursor: &str) -> bool {
    (1..=128).contains(&cursor.len())
        && cursor
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `/api/verse/activity` or `/api/verse/activity?since=<cursor>`.
pub fn request_path(cursor: Option<&str>) -> String {
    match cursor {
        Some(c) if is_safe_cursor(c) => format!("{ACTIVITY_PATH}?since={c}"),
        _ => ACTIVITY_PATH.to_string(),
    }
}

// ── folding ──────────────────────────────────────────────────────────────────

/// One running chat as the tray lists it (title NOT yet sanitized — the tray
/// sanitizes at render time with the same function banners use).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayChat {
    pub session_id: String,
    pub title: String,
}

/// What one poll means for the shell.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fold {
    pub notices: Vec<Notice>,
    /// Every running chat with a usable id, in server order.
    pub running: Vec<TrayChat>,
    /// The dock badge and the tray's "Needs you (N)".
    pub needs_you: usize,
}

#[derive(Debug, Default)]
pub struct WatchState {
    cursor: Option<String>,
    baselined: bool,
    known_items: HashSet<String>,
    recent_failures: VecDeque<String>,
}

impl WatchState {
    pub fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref()
    }

    /// The server refused our cursor (400): start over without one. The
    /// baseline and the known items are kept, so this is not "history".
    pub fn reject_cursor(&mut self) {
        self.cursor = None;
    }

    fn remember_failure(&mut self, session_id: &str) {
        if self.recent_failures.iter().any(|s| s == session_id) {
            return;
        }
        if self.recent_failures.len() >= RECENT_FAILURES {
            self.recent_failures.pop_front();
        }
        self.recent_failures.push_back(session_id.to_string());
    }

    fn failure_already_announced(&self, item: &NeedsYouRef) -> bool {
        item.kind == "chat-failed"
            && item
                .subject
                .session_id
                .as_deref()
                .is_some_and(|sid| self.recent_failures.iter().any(|s| s == sid))
    }

    /// Fold one snapshot in.
    pub fn fold(&mut self, snap: ActivitySnapshot) -> Fold {
        let first = !self.baselined;
        self.baselined = true;
        self.cursor = is_safe_cursor(&snap.cursor).then(|| snap.cursor.clone());

        let mut notices = Vec::new();

        // ── endings ──────────────────────────────────────────────────────────
        let endings: Vec<&Completion> = snap
            .completions
            .iter()
            .filter(|c| notify::is_valid_session_id(&c.session_id))
            // A cancel is the operator's own act (or the tray's Stop): no news.
            .filter(|c| c.outcome == "ok" || c.outcome == "failed")
            .collect();
        for c in &endings {
            if c.outcome == "failed" {
                self.remember_failure(&c.session_id);
            }
        }
        if !first && !endings.is_empty() {
            if endings.len() <= MAX_INDIVIDUAL_ENDINGS {
                for c in &endings {
                    notices.push(if c.outcome == "failed" {
                        Notice::Failed {
                            session_id: c.session_id.clone(),
                            title: c.title.clone(),
                        }
                    } else {
                        Notice::Finished {
                            session_id: c.session_id.clone(),
                            title: c.title.clone(),
                            duration_ms: c.duration_ms,
                        }
                    });
                }
            } else {
                let failed = endings.iter().filter(|c| c.outcome == "failed").count();
                // Oldest first on the wire, so the LAST match is the newest.
                let focus = endings
                    .iter()
                    .rev()
                    .find(|c| c.outcome == "failed")
                    .or_else(|| endings.last())
                    .map(|c| c.session_id.clone());
                notices.push(Notice::Chats {
                    finished: endings.len() - failed,
                    failed,
                    focus,
                });
            }
        }

        // ── needs you ────────────────────────────────────────────────────────
        let items: Vec<&NeedsYouRef> = snap
            .needs_you
            .iter()
            .filter(|i| !i.id.is_empty() && i.id.chars().count() <= MAX_ITEM_ID_CHARS)
            .collect();
        let mut new = NeedsYouCounts::default();
        for item in &items {
            if !self.known_items.contains(&item.id) && !self.failure_already_announced(item) {
                new.add_kind(&item.kind);
            }
        }
        // Items that resolved drop out, so one that comes back is news again.
        self.known_items = items.iter().map(|i| i.id.clone()).collect();
        let waiting = snap
            .counts
            .needs_you
            .unwrap_or(items.len())
            .max(items.len());
        if !first && new.total() > 0 {
            notices.push(Notice::NeedsYou { new, waiting });
        }

        let running = snap
            .running
            .iter()
            .filter(|r| notify::is_valid_session_id(&r.session_id))
            .map(|r| TrayChat {
                session_id: r.session_id.clone(),
                title: r.title.clone(),
            })
            .collect();

        Fold {
            notices,
            running,
            needs_you: waiting,
        }
    }
}

/// How long until the next poll.
///
/// `shown` is the window on screen (visible, not minimized). `route_missing`
/// is a 404 from a build without C1's route.
pub fn next_interval(shown: bool, running: usize, route_missing: bool) -> Duration {
    if route_missing {
        return IDLE_INTERVAL;
    }
    if shown || running > 0 {
        ACTIVE_INTERVAL
    } else {
        IDLE_INTERVAL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(json: &str) -> ActivitySnapshot {
        parse_activity(json).expect("snapshot")
    }

    const EMPTY: &str = r#"{"cursor":"v1.ab12.e.0","running":[],"needsYou":[],"completions":[],
        "counts":{"running":0,"needsYou":0,"unread":0},"sources":{},"autonomy":null,"capacity":null,"mind":null,
        "generatedAt":"2026-09-24T10:00:00.000Z"}"#;

    #[test]
    fn parses_the_contract_shape_and_ignores_fields_it_does_not_read() {
        let s = snap(
            r#"{"cursor":"v1.ab12.e.7","generatedAt":"x",
            "running":[{"sessionId":"vs_1","title":"Fix CI","engine":"claude","seatId":"claude-a",
                        "startedAt":"x","live":{"phase":"tool","tool":"npm test","elapsedMs":62000,"thinkingTail":null}}],
            "needsYou":[{"id":"fleet:owner-hold:ashlrai/x","source":"fleet","kind":"owner-hold","severity":"warn",
                         "title":"anything","detail":null,"since":"x","expiresAt":null,
                         "subject":{"repo":"ashlrai/x","pr":null,"seatId":null,"sessionId":null,"engine":null},
                         "target":{"kind":"section","section":"fleet","anchor":null},"actions":[]}],
            "completions":[{"sessionId":"vs_2","title":"Docs","outcome":"ok","at":"x","durationMs":1200}],
            "counts":{"running":1,"needsYou":1,"unread":2},"sources":{"authority":"ok"},
            "autonomy":null,"capacity":null,"mind":null}"#,
        );
        assert_eq!(s.cursor, "v1.ab12.e.7");
        assert_eq!(s.running[0].session_id, "vs_1");
        assert_eq!(s.needs_you[0].kind, "owner-hold");
        assert_eq!(s.completions[0].duration_ms, Some(1200));
        assert_eq!(s.counts.needs_you, Some(1));
    }

    #[test]
    fn anything_that_is_not_a_snapshot_is_rejected() {
        for bad in [
            "",
            "{}",
            "<html>",
            r#"{"cursor":1}"#,
            r#"{"code":"API_MODULE_UNAVAILABLE"}"#,
        ] {
            assert_eq!(parse_activity(bad), None, "{bad}");
        }
    }

    #[test]
    fn only_cursors_of_the_routes_own_shape_are_echoed() {
        assert_eq!(request_path(None), "/api/verse/activity");
        assert_eq!(
            request_path(Some("v1.ab12.e.42")),
            "/api/verse/activity?since=v1.ab12.e.42"
        );
        for hostile in [
            "",
            "a&b=c",
            "a b",
            "a#b",
            "x\r\nHost: evil",
            &"x".repeat(129),
        ] {
            assert_eq!(
                request_path(Some(hostile)),
                "/api/verse/activity",
                "{hostile:?}"
            );
        }
    }

    #[test]
    fn the_first_poll_is_a_baseline_not_news() {
        let mut state = WatchState::default();
        let first = state.fold(snap(
            r#"{"cursor":"v1.a.e.1",
            "needsYou":[{"id":"a:approval:1","kind":"approval"}],
            "completions":[{"sessionId":"vs_1","title":"Old","outcome":"ok"}]}"#,
        ));
        assert!(first.notices.is_empty(), "{:?}", first.notices);
        assert_eq!(first.needs_you, 1);
        assert_eq!(state.cursor(), Some("v1.a.e.1"));

        // The same item next poll is still not news.
        let second = state.fold(snap(
            r#"{"cursor":"v1.a.e.2","needsYou":[{"id":"a:approval:1","kind":"approval"}]}"#,
        ));
        assert!(second.notices.is_empty());
    }

    #[test]
    fn finished_and_failed_turns_each_get_a_banner_cancelled_ones_do_not() {
        let mut state = WatchState::default();
        state.fold(snap(EMPTY));
        let fold = state.fold(snap(
            r#"{"cursor":"v1.a.e.3","completions":[
                {"sessionId":"vs_1","title":"Build","outcome":"ok","durationMs":62000},
                {"sessionId":"vs_2","title":"Stopped","outcome":"cancelled"},
                {"sessionId":"vs_3","title":"Deploy","outcome":"failed"}]}"#,
        ));
        assert_eq!(
            fold.notices,
            vec![
                Notice::Finished {
                    session_id: "vs_1".into(),
                    title: "Build".into(),
                    duration_ms: Some(62000)
                },
                Notice::Failed {
                    session_id: "vs_3".into(),
                    title: "Deploy".into()
                },
            ]
        );
    }

    #[test]
    fn a_burst_of_endings_becomes_one_banner_focused_on_the_newest_failure() {
        let mut state = WatchState::default();
        state.fold(snap(EMPTY));
        let fold = state.fold(snap(
            r#"{"cursor":"v1.a.e.9","completions":[
                {"sessionId":"vs_1","outcome":"failed"},
                {"sessionId":"vs_2","outcome":"ok"},
                {"sessionId":"vs_3","outcome":"failed"},
                {"sessionId":"vs_4","outcome":"ok"}]}"#,
        ));
        assert_eq!(
            fold.notices,
            vec![Notice::Chats {
                finished: 2,
                failed: 2,
                focus: Some("vs_3".into())
            }]
        );
    }

    #[test]
    fn endings_with_ids_the_page_would_refuse_are_dropped() {
        let mut state = WatchState::default();
        state.fold(snap(EMPTY));
        let fold = state.fold(snap(
            r#"{"cursor":"v1.a.e.3","completions":[{"sessionId":"x\nopen-settings","outcome":"ok"}],
                "running":[{"sessionId":"bad id","title":"t"},{"sessionId":"vs_ok","title":"t"}]}"#,
        ));
        assert!(fold.notices.is_empty());
        assert_eq!(fold.running.len(), 1);
        assert_eq!(fold.running[0].session_id, "vs_ok");
    }

    #[test]
    fn new_needs_you_items_are_counted_by_category_and_announced_once() {
        let mut state = WatchState::default();
        state.fold(snap(
            r#"{"cursor":"c1","needsYou":[{"id":"a:approval:1","kind":"approval"}]}"#,
        ));
        let fold = state.fold(snap(
            r#"{"cursor":"c2","counts":{"needsYou":3},"needsYou":[
                {"id":"a:approval:1","kind":"approval"},
                {"id":"fleet:veto-window:x","kind":"veto-window"},
                {"id":"accounts:reconnect:grok-a","kind":"reconnect"}]}"#,
        ));
        let mut expected = NeedsYouCounts::default();
        expected.add_kind("veto-window");
        expected.add_kind("reconnect");
        assert_eq!(
            fold.notices,
            vec![Notice::NeedsYou {
                new: expected,
                waiting: 3
            }]
        );
        assert_eq!(fold.needs_you, 3);

        // Same set again: silent.
        let again = state.fold(snap(
            r#"{"cursor":"c3","needsYou":[
                {"id":"a:approval:1","kind":"approval"},
                {"id":"fleet:veto-window:x","kind":"veto-window"},
                {"id":"accounts:reconnect:grok-a","kind":"reconnect"}]}"#,
        ));
        assert!(again.notices.is_empty());

        // Resolved, then back: news again.
        state.fold(snap(r#"{"cursor":"c4","needsYou":[]}"#));
        let back = state.fold(snap(
            r#"{"cursor":"c5","needsYou":[{"id":"a:approval:1","kind":"approval"}]}"#,
        ));
        assert_eq!(back.notices.len(), 1);
    }

    #[test]
    fn a_failed_chat_is_not_announced_twice_when_its_needs_you_item_lands_later() {
        let mut state = WatchState::default();
        state.fold(snap(EMPTY));
        let failed = state.fold(snap(
            r#"{"cursor":"c2","completions":[{"sessionId":"vs_7","title":"T","outcome":"failed"}]}"#,
        ));
        assert_eq!(failed.notices.len(), 1);
        let item = state.fold(snap(
            r#"{"cursor":"c3","needsYou":[{"id":"chats:chat-failed:vs_7","kind":"chat-failed",
                "subject":{"sessionId":"vs_7"}}]}"#,
        ));
        assert!(item.notices.is_empty(), "{:?}", item.notices);
        assert_eq!(item.needs_you, 1, "still counted on the badge");

        // A failure we never announced (it predates the app) is news.
        let other = state.fold(snap(
            r#"{"cursor":"c4","needsYou":[{"id":"chats:chat-failed:vs_7","kind":"chat-failed","subject":{"sessionId":"vs_7"}},
                {"id":"chats:chat-failed:vs_8","kind":"chat-failed","subject":{"sessionId":"vs_8"}}]}"#,
        ));
        assert_eq!(other.notices.len(), 1);
    }

    #[test]
    fn the_badge_never_undercounts_the_items_in_hand() {
        let mut state = WatchState::default();
        let fold = state.fold(snap(
            r#"{"cursor":"c1","counts":{"needsYou":0},"needsYou":[{"id":"a","kind":"approval"},{"id":"b","kind":"repin"}]}"#,
        ));
        assert_eq!(fold.needs_you, 2);
        let fold = state.fold(snap(r#"{"cursor":"c2"}"#));
        assert_eq!(fold.needs_you, 0);
    }

    #[test]
    fn a_rejected_cursor_is_dropped_and_an_unsafe_one_never_stored() {
        let mut state = WatchState::default();
        state.fold(snap(r#"{"cursor":"v1.a.e.1"}"#));
        assert_eq!(state.cursor(), Some("v1.a.e.1"));
        state.reject_cursor();
        assert_eq!(state.cursor(), None);
        state.fold(snap(r#"{"cursor":"a&b"}"#));
        assert_eq!(state.cursor(), None);
    }

    /// Live check against a REAL sidecar server (not run by default):
    /// `ASHLR_LIVE_ACTIVITY_PORT=… ASHLR_LIVE_ACTIVITY_TOKEN=… [ASHLR_LIVE_MUTATION_TOKEN=…]
    ///  cargo test -- --ignored live_activity`.
    /// Proves the real route's response parses, its cursor is one we echo, a
    /// `since=` poll is accepted, and (with a mutation token) that the tray's
    /// cancel POST passes the sidecar's mutation gate: an unknown session is a
    /// 404 (gate passed, route answered), a wrong token a 401.
    #[test]
    #[ignore]
    fn live_activity_poll_and_cancel_against_a_running_server() {
        use crate::health_watch::{fetch, post_json, FetchError};
        let port: u16 = std::env::var("ASHLR_LIVE_ACTIVITY_PORT")
            .expect("ASHLR_LIVE_ACTIVITY_PORT")
            .parse()
            .expect("port");
        let token = std::env::var("ASHLR_LIVE_ACTIVITY_TOKEN").expect("ASHLR_LIVE_ACTIVITY_TOKEN");
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));

        let started = std::time::Instant::now();
        let body = fetch(addr, &request_path(None), &token).expect("first poll");
        let first_ms = started.elapsed().as_secs_f64() * 1000.0;
        let snap = parse_activity(std::str::from_utf8(&body).expect("utf8")).expect("parses");
        assert!(is_safe_cursor(&snap.cursor), "cursor {:?}", snap.cursor);
        let mut state = WatchState::default();
        let fold = state.fold(snap);
        assert!(fold.notices.is_empty(), "first poll is a baseline");

        let started = std::time::Instant::now();
        let body = fetch(addr, &request_path(state.cursor()), &token).expect("since poll");
        let since_ms = started.elapsed().as_secs_f64() * 1000.0;
        let snap = parse_activity(std::str::from_utf8(&body).expect("utf8")).expect("parses");
        state.fold(snap);
        eprintln!(
            "live activity: first {first_ms:.2} ms, since {since_ms:.2} ms (loopback round trip incl. connect), cursor {:?}",
            state.cursor()
        );

        assert_eq!(
            fetch(addr, &request_path(None), "wrong-token").expect_err("bad token"),
            FetchError::Status(401)
        );

        if let Ok(mutation) = std::env::var("ASHLR_LIVE_MUTATION_TOKEN") {
            let path = "/api/verse/sessions/vs_does-not-exist/cancel";
            assert_eq!(
                post_json(addr, path, &mutation, "{}").expect_err("unknown session"),
                FetchError::Status(404)
            );
            assert_eq!(
                post_json(addr, path, "wrong-token", "{}").expect_err("bad token"),
                FetchError::Status(401)
            );
        }
    }

    #[test]
    fn polling_slows_only_while_hidden_and_idle() {
        assert_eq!(next_interval(true, 0, false), ACTIVE_INTERVAL);
        assert_eq!(next_interval(false, 2, false), ACTIVE_INTERVAL);
        assert_eq!(next_interval(false, 0, false), IDLE_INTERVAL);
        assert_eq!(next_interval(true, 3, true), IDLE_INTERVAL, "route missing");
        assert!(
            ACTIVE_INTERVAL >= Duration::from_secs(2),
            "no polling faster than 2 s"
        );
        assert_eq!(ACTIVE_INTERVAL, Duration::from_secs(5));
        assert_eq!(IDLE_INTERVAL, Duration::from_secs(30));
    }
}

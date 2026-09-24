//! The menu-bar (tray) item: what it lists and what each row does.
//!
//! ```text
//!  ● 2                          ← title while chats run (macOS menu bar)
//!  ┌──────────────────────────┐
//!  │ Running                  │ ← disabled header
//!  │   Fix the flaky test     │ → open that chat
//!  │   Refactor router        │
//!  │ ──────────────────────── │
//!  │ Needs you (3)…           │ → the Needs-you drawer
//!  │ New chat                 │ → Chat, composer focused
//!  │ Stop running chats…      │ → native confirm, then cancel each turn
//!  │ ──────────────────────── │
//!  │ Show Ashlr Verse         │
//!  │ Quit Ashlr               │
//!  └──────────────────────────┘
//! ```
//!
//! The tray may stop CHATS, never the fleet (SPEC-310C §0.4). Autonomy
//! controls — starting or stopping the daemon, the kill switch, the autonomy
//! switch — stay in the console behind their confirm and Touch ID steps: a
//! menu-bar row is far too easy to hit by accident for that blast radius. A
//! test below pins that no row here names the fleet, the daemon or the kill
//! switch.
//!
//! This module is pure: rows are described as data ([`menu_rows`]) and turned
//! into a Tauri menu by `main.rs`, so the layout, the labels and the id
//! routing are all testable without a window.

use crate::{activity_watch::TrayChat, notify};

pub const ID_SHOW: &str = "tray.show";
pub const ID_QUIT: &str = "tray.quit";
pub const ID_NEEDS_YOU: &str = "tray.needs-you";
pub const ID_NEW_CHAT: &str = "tray.new-chat";
pub const ID_STOP_CHATS: &str = "tray.stop-chats";
pub const SESSION_PREFIX: &str = "tray.session:";
/// Disabled rows need ids too; nothing routes them.
const ID_RUNNING_HEADER: &str = "tray.header.running";
const ID_RUNNING_MORE: &str = "tray.header.more";

/// At most this many running chats are listed; the rest are counted.
pub const MAX_LISTED_CHATS: usize = 8;

/// What a tray row does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrayAction {
    Show,
    Quit,
    NeedsYou,
    NewChat,
    StopChats,
    OpenSession(String),
}

/// Route a menu id. `None` for every id that is not a tray action (the app
/// menu's own items share the same event stream).
pub fn parse_tray_id(id: &str) -> Option<TrayAction> {
    match id {
        ID_SHOW => Some(TrayAction::Show),
        ID_QUIT => Some(TrayAction::Quit),
        ID_NEEDS_YOU => Some(TrayAction::NeedsYou),
        ID_NEW_CHAT => Some(TrayAction::NewChat),
        ID_STOP_CHATS => Some(TrayAction::StopChats),
        _ => {
            let sid = id.strip_prefix(SESSION_PREFIX)?;
            notify::is_valid_session_id(sid).then(|| TrayAction::OpenSession(sid.to_string()))
        }
    }
}

/// Everything the tray shows. Rebuilt only when this changes, so an open menu
/// is not torn down under the pointer every poll.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrayModel {
    pub running: Vec<TrayChat>,
    pub needs_you: usize,
    /// False when the window was opened against a server we did not start (no
    /// mutation token): Stop cannot work, so it is shown disabled.
    pub can_stop: bool,
}

/// The menu-bar title: "● N" while chats run, nothing otherwise.
pub fn tray_title(running: usize) -> Option<String> {
    (running > 0).then(|| format!("● {running}"))
}

/// The Dock badge for a Needs-you count: the number, or no badge at all at
/// zero (a "0" badge reads as "something is here").
pub fn dock_badge(needs_you: usize) -> Option<i64> {
    (needs_you > 0).then(|| i64::try_from(needs_you).unwrap_or(i64::MAX))
}

/// The tooltip, which also serves VoiceOver.
pub fn tray_tooltip(model: &TrayModel) -> String {
    let mut parts = vec!["Ashlr Verse".to_string()];
    match model.running.len() {
        0 => {}
        1 => parts.push("1 chat running".to_string()),
        n => parts.push(format!("{n} chats running")),
    }
    if model.needs_you > 0 {
        parts.push(format!("{} need you", model.needs_you));
    }
    parts.join(" — ")
}

/// One row of the menu, as data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Row {
    Item {
        id: String,
        label: String,
        enabled: bool,
    },
    Separator,
}

fn item(id: &str, label: impl Into<String>, enabled: bool) -> Row {
    Row::Item {
        id: id.to_string(),
        label: label.into(),
        enabled,
    }
}

/// The menu for a model, top to bottom.
pub fn menu_rows(model: &TrayModel) -> Vec<Row> {
    let mut rows = Vec::new();
    if !model.running.is_empty() {
        rows.push(item(ID_RUNNING_HEADER, "Running", false));
        for chat in model.running.iter().take(MAX_LISTED_CHATS) {
            rows.push(item(
                &format!("{SESSION_PREFIX}{}", chat.session_id),
                // Indented under the header, the way macOS lists sub-items.
                format!("   {}", notify::sanitize_title(&chat.title)),
                true,
            ));
        }
        let hidden = model.running.len().saturating_sub(MAX_LISTED_CHATS);
        if hidden > 0 {
            rows.push(item(
                ID_RUNNING_MORE,
                format!("   {hidden} more running"),
                false,
            ));
        }
        rows.push(Row::Separator);
    }
    let needs = if model.needs_you > 0 {
        format!("Needs you ({})…", model.needs_you)
    } else {
        "Needs you…".to_string()
    };
    rows.push(item(ID_NEEDS_YOU, needs, true));
    rows.push(item(ID_NEW_CHAT, "New chat", true));
    rows.push(item(
        ID_STOP_CHATS,
        "Stop running chats…",
        model.can_stop && !model.running.is_empty(),
    ));
    rows.push(Row::Separator);
    rows.push(item(ID_SHOW, "Show Ashlr Verse", true));
    rows.push(item(ID_QUIT, "Quit Ashlr", true));
    rows
}

/// Native confirm copy for Stop — the catalog's `chats.stop-all` guard, with
/// the count the operator is about to stop.
pub fn stop_confirm_text(running: usize) -> (String, String) {
    let title = match running {
        1 => "Stop the running chat?".to_string(),
        _ => "Stop every running chat?".to_string(),
    };
    let body = match running {
        0 => "No chat is running right now.".to_string(),
        1 => "Its turn is cancelled. Queued follow-ups are held, not sent. Autonomous fleet work is not affected."
            .to_string(),
        n => format!(
            "{n} running turns are cancelled. Queued follow-ups are held, not sent. Autonomous fleet work is not affected."
        ),
    };
    (title, body)
}

/// What to tell the operator after Stop, if anything went wrong. `None` when
/// every chat stopped (the tray title clearing is the confirmation).
pub fn stop_result_text(stopped: usize, failed: usize) -> Option<String> {
    (failed > 0).then(|| {
        format!(
            "Stopped {stopped} of {}. {failed} could not be stopped — open Ashlr and stop {} from the chat.",
            stopped + failed,
            if failed == 1 { "it" } else { "them" }
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(id: &str, title: &str) -> TrayChat {
        TrayChat {
            session_id: id.to_string(),
            title: title.to_string(),
        }
    }

    fn labels(rows: &[Row]) -> Vec<String> {
        rows.iter()
            .map(|r| match r {
                Row::Item { label, enabled, .. } => {
                    format!("{}{label}", if *enabled { "" } else { "(off) " })
                }
                Row::Separator => "—".to_string(),
            })
            .collect()
    }

    #[test]
    fn an_idle_tray_offers_needs_you_new_chat_show_and_quit() {
        let rows = menu_rows(&TrayModel {
            can_stop: true,
            ..Default::default()
        });
        assert_eq!(
            labels(&rows),
            [
                "Needs you…",
                "New chat",
                "(off) Stop running chats…",
                "—",
                "Show Ashlr Verse",
                "Quit Ashlr"
            ]
        );
        assert_eq!(tray_title(0), None);
    }

    #[test]
    fn running_chats_are_listed_titled_and_counted() {
        let model = TrayModel {
            running: vec![chat("vs_1", "Fix\nCI"), chat("vs_2", "Docs")],
            needs_you: 3,
            can_stop: true,
        };
        let rows = menu_rows(&model);
        assert_eq!(
            labels(&rows),
            [
                "(off) Running",
                "   Fix CI",
                "   Docs",
                "—",
                "Needs you (3)…",
                "New chat",
                "Stop running chats…",
                "—",
                "Show Ashlr Verse",
                "Quit Ashlr"
            ]
        );
        assert_eq!(tray_title(2).as_deref(), Some("● 2"));
        assert_eq!(
            tray_tooltip(&model),
            "Ashlr Verse — 2 chats running — 3 need you"
        );
        match &rows[1] {
            Row::Item { id, .. } => assert_eq!(
                parse_tray_id(id),
                Some(TrayAction::OpenSession("vs_1".into()))
            ),
            Row::Separator => panic!("expected a chat row"),
        }
    }

    #[test]
    fn a_long_running_list_is_capped_with_a_count() {
        let running: Vec<TrayChat> = (0..11).map(|i| chat(&format!("vs_{i}"), "t")).collect();
        let rows = menu_rows(&TrayModel {
            running,
            needs_you: 0,
            can_stop: true,
        });
        let chats = rows
            .iter()
            .filter(|r| matches!(r, Row::Item { id, .. } if id.starts_with(SESSION_PREFIX)))
            .count();
        assert_eq!(chats, MAX_LISTED_CHATS);
        assert!(labels(&rows).contains(&"(off)    3 more running".to_string()));
    }

    #[test]
    fn the_dock_badge_counts_needs_you_and_clears_at_zero() {
        assert_eq!(dock_badge(0), None);
        assert_eq!(dock_badge(1), Some(1));
        assert_eq!(dock_badge(12), Some(12));
    }

    #[test]
    fn stop_is_disabled_without_a_mutation_token() {
        let rows = menu_rows(&TrayModel {
            running: vec![chat("vs_1", "t")],
            needs_you: 0,
            can_stop: false,
        });
        assert!(labels(&rows).contains(&"(off) Stop running chats…".to_string()));
    }

    #[test]
    fn menu_ids_route_to_exactly_the_actions_they_name() {
        assert_eq!(parse_tray_id("tray.show"), Some(TrayAction::Show));
        assert_eq!(parse_tray_id("tray.quit"), Some(TrayAction::Quit));
        assert_eq!(parse_tray_id("tray.needs-you"), Some(TrayAction::NeedsYou));
        assert_eq!(parse_tray_id("tray.new-chat"), Some(TrayAction::NewChat));
        assert_eq!(
            parse_tray_id("tray.stop-chats"),
            Some(TrayAction::StopChats)
        );
        assert_eq!(
            parse_tray_id("tray.session:vs_01J9-abc.def"),
            Some(TrayAction::OpenSession("vs_01J9-abc.def".into()))
        );
        for other in [
            "app.settings",
            "view.reload",
            "tray.header.running",
            "tray.header.more",
            "tray.session:",
            "tray.session:a b",
            "tray.session:x\nopen-settings",
            "",
        ] {
            assert_eq!(parse_tray_id(other), None, "{other:?}");
        }
    }

    #[test]
    fn the_tray_can_stop_chats_but_never_touches_the_fleet() {
        // SPEC-310C §0.4 and the README's tray table: no autonomy control here.
        let everything = menu_rows(&TrayModel {
            running: vec![chat("vs_1", "t")],
            needs_you: 1,
            can_stop: true,
        });
        for row in &everything {
            if let Row::Item { id, label, .. } = row {
                let text = format!("{id} {label}").to_ascii_lowercase();
                for banned in ["fleet", "daemon", "kill", "autonomy", "autonomous"] {
                    assert!(!text.contains(banned), "tray row {text:?} names {banned}");
                }
            }
        }
        let (title, body) = stop_confirm_text(2);
        assert_eq!(title, "Stop every running chat?");
        assert!(body.contains("2 running turns are cancelled"));
        assert!(body.contains("fleet work is not affected"));
        assert_eq!(stop_confirm_text(1).0, "Stop the running chat?");
    }

    #[test]
    fn stop_reports_only_partial_failure() {
        assert_eq!(stop_result_text(3, 0), None);
        assert_eq!(
            stop_result_text(2, 1).as_deref(),
            Some("Stopped 2 of 3. 1 could not be stopped — open Ashlr and stop it from the chat.")
        );
        assert!(stop_result_text(0, 2).unwrap().contains("stop them"));
    }
}

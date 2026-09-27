//! The dictation hotkeys: ⌃⌥V dictates, ⌃⌥⇧V dictates a command (the words
//! become a command-palette query). Same registration pattern as `hotkey.rs`
//! (tauri-plugin-global-shortcut, Rust only, no IPC granted to any window).
//!
//! One chord, two gestures, decided on key UP:
//!
//! - **Hold** (released after ≥ [`HOLD_THRESHOLD`]): push-to-talk — listening
//!   starts on key DOWN (so the first word is never lost to the threshold) and
//!   the transcript is finalised on key UP.
//! - **Tap** (released sooner): latch — keep listening hands-free until the
//!   chord is pressed again.
//! - **Esc** cancels (the audio is discarded). Escape is registered globally
//!   ONLY while a dictation is live, and released as soon as it ends, so it is
//!   never stolen from other apps otherwise.
//!
//! Why not fn: Wispr Flow owns it, and it is not a registrable hotkey anyway.
//! Why ⌃⌥V: next to the ⌃⌥Space summon chord, free in macOS and the common
//! editors, and V for voice.

use std::str::FromStr;
use std::time::{Duration, Instant};

use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

pub const DICTATE_ACCELERATOR: &str = "Control+Alt+KeyV";
pub const COMMAND_ACCELERATOR: &str = "Control+Alt+Shift+KeyV";
pub const CANCEL_ACCELERATOR: &str = "Escape";
pub const DICTATE_DISPLAY: &str = "⌃⌥V";
pub const COMMAND_DISPLAY: &str = "⌃⌥⇧V";
/// Held at least this long = push-to-talk; shorter = tap to latch.
pub const HOLD_THRESHOLD: Duration = Duration::from_millis(250);

fn parse(accelerator: &str) -> Shortcut {
    Shortcut::from_str(accelerator).unwrap_or_else(|_| {
        use tauri_plugin_global_shortcut::{Code, Modifiers};
        match accelerator {
            COMMAND_ACCELERATOR => Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
                Code::KeyV,
            ),
            CANCEL_ACCELERATOR => Shortcut::new(None, Code::Escape),
            _ => Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV),
        }
    })
}

pub fn dictate_shortcut() -> Shortcut {
    parse(DICTATE_ACCELERATOR)
}
pub fn command_shortcut() -> Shortcut {
    parse(COMMAND_ACCELERATOR)
}
pub fn cancel_shortcut() -> Shortcut {
    parse(CANCEL_ACCELERATOR)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chord {
    Dictate,
    Command,
    Cancel,
}

pub fn classify(shortcut: &Shortcut) -> Option<Chord> {
    let id = shortcut.id();
    if id == dictate_shortcut().id() {
        Some(Chord::Dictate)
    } else if id == command_shortcut().id() {
        Some(Chord::Command)
    } else if id == cancel_shortcut().id() {
        Some(Chord::Cancel)
    } else {
        None
    }
}

/// What the hub should do in response to a key event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Start listening now (key down). `command` for ⌃⌥⇧V.
    Start {
        command: bool,
    },
    /// Finalise the transcript.
    Stop,
    /// It was a tap: keep listening until the next press.
    Latch,
    /// Discard.
    Cancel,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum State {
    #[default]
    Idle,
    /// Down since `at`; waiting for the release to learn hold vs tap.
    Held {
        at: Instant,
    },
    Latched,
}

/// Hold/tap state machine. Pure: the caller passes the clock.
#[derive(Debug, Default)]
pub struct Tracker {
    state: State,
}

impl Tracker {
    pub fn on_event(&mut self, chord: Chord, key: ShortcutState, now: Instant) -> Action {
        match (chord, key, self.state) {
            (Chord::Cancel, ShortcutState::Pressed, State::Idle) => Action::None,
            (Chord::Cancel, ShortcutState::Pressed, _) => {
                self.state = State::Idle;
                Action::Cancel
            }
            (Chord::Cancel, ShortcutState::Released, _) => Action::None,
            (_, ShortcutState::Pressed, State::Idle) => {
                self.state = State::Held { at: now };
                Action::Start {
                    command: chord == Chord::Command,
                }
            }
            // Auto-repeat while held: ignore.
            (_, ShortcutState::Pressed, State::Held { .. }) => Action::None,
            // Any dictation chord while latched ends it.
            (_, ShortcutState::Pressed, State::Latched) => {
                self.state = State::Idle;
                Action::Stop
            }
            (_, ShortcutState::Released, State::Held { at }) => {
                if now.saturating_duration_since(at) >= HOLD_THRESHOLD {
                    self.state = State::Idle;
                    Action::Stop
                } else {
                    self.state = State::Latched;
                    Action::Latch
                }
            }
            (_, ShortcutState::Released, _) => Action::None,
        }
    }

    /// The session ended some other way (the pill's stop button, an error):
    /// the next press starts fresh.
    pub fn reset(&mut self) {
        self.state = State::Idle;
    }

    pub fn is_idle(&self) -> bool {
        self.state == State::Idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ShortcutState::{Pressed, Released};

    fn at(ms: u64, base: Instant) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn the_chords_parse_and_are_distinct_from_summon_and_each_other() {
        use tauri_plugin_global_shortcut::{Code, Modifiers};
        assert_eq!(
            Shortcut::from_str(DICTATE_ACCELERATOR).expect("parses"),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV)
        );
        assert_eq!(
            Shortcut::from_str(COMMAND_ACCELERATOR).expect("parses"),
            Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
                Code::KeyV
            )
        );
        assert_eq!(
            Shortcut::from_str(CANCEL_ACCELERATOR).expect("parses"),
            Shortcut::new(None, Code::Escape)
        );
        let ids = [
            dictate_shortcut().id(),
            command_shortcut().id(),
            cancel_shortcut().id(),
            crate::hotkey::summon_shortcut().id(),
        ];
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(a, b);
            }
        }
        assert_eq!(classify(&dictate_shortcut()), Some(Chord::Dictate));
        assert_eq!(classify(&command_shortcut()), Some(Chord::Command));
        assert_eq!(classify(&cancel_shortcut()), Some(Chord::Cancel));
        assert_eq!(classify(&crate::hotkey::summon_shortcut()), None);
    }

    #[test]
    fn a_hold_is_push_to_talk() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        assert_eq!(
            t.on_event(Chord::Dictate, Pressed, t0),
            Action::Start { command: false },
            "listening starts on key down"
        );
        assert_eq!(
            t.on_event(Chord::Dictate, Pressed, at(100, t0)),
            Action::None,
            "auto-repeat"
        );
        assert_eq!(
            t.on_event(Chord::Dictate, Released, at(1800, t0)),
            Action::Stop
        );
        assert!(t.is_idle());
    }

    #[test]
    fn exactly_the_threshold_counts_as_a_hold() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        t.on_event(Chord::Dictate, Pressed, t0);
        assert_eq!(
            t.on_event(Chord::Dictate, Released, t0 + HOLD_THRESHOLD),
            Action::Stop
        );
    }

    #[test]
    fn a_tap_latches_until_the_next_press() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        t.on_event(Chord::Dictate, Pressed, t0);
        assert_eq!(
            t.on_event(Chord::Dictate, Released, at(120, t0)),
            Action::Latch
        );
        assert!(!t.is_idle());
        // Talking hands-free for a while; the next press ends it.
        assert_eq!(
            t.on_event(Chord::Dictate, Pressed, at(9000, t0)),
            Action::Stop
        );
        // …and its release does nothing.
        assert_eq!(
            t.on_event(Chord::Dictate, Released, at(9100, t0)),
            Action::None
        );
        assert!(t.is_idle());
    }

    #[test]
    fn the_command_chord_starts_a_command_session_and_either_chord_ends_a_latch() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        assert_eq!(
            t.on_event(Chord::Command, Pressed, t0),
            Action::Start { command: true }
        );
        assert_eq!(
            t.on_event(Chord::Command, Released, at(50, t0)),
            Action::Latch
        );
        assert_eq!(
            t.on_event(Chord::Dictate, Pressed, at(3000, t0)),
            Action::Stop
        );
    }

    #[test]
    fn escape_cancels_held_or_latched_and_is_inert_when_idle() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        assert_eq!(t.on_event(Chord::Cancel, Pressed, t0), Action::None);
        t.on_event(Chord::Dictate, Pressed, t0);
        assert_eq!(
            t.on_event(Chord::Cancel, Pressed, at(500, t0)),
            Action::Cancel
        );
        assert!(t.is_idle());
        // The chord's own release after a cancel does nothing.
        assert_eq!(
            t.on_event(Chord::Dictate, Released, at(900, t0)),
            Action::None
        );

        t.on_event(Chord::Dictate, Pressed, at(1000, t0));
        t.on_event(Chord::Dictate, Released, at(1100, t0));
        assert_eq!(
            t.on_event(Chord::Cancel, Pressed, at(4000, t0)),
            Action::Cancel
        );
        assert_eq!(
            t.on_event(Chord::Cancel, Released, at(4050, t0)),
            Action::None
        );
    }

    #[test]
    fn a_session_ended_elsewhere_resets_the_tracker() {
        let t0 = Instant::now();
        let mut t = Tracker::default();
        t.on_event(Chord::Dictate, Pressed, t0);
        t.on_event(Chord::Dictate, Released, at(100, t0));
        t.reset();
        assert_eq!(
            t.on_event(Chord::Dictate, Pressed, at(5000, t0)),
            Action::Start { command: false },
            "a fresh press starts a new dictation instead of stopping a dead one"
        );
    }
}

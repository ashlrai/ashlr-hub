//! The system-wide "show Verse" hotkey: ⌃⌥Space from anywhere in macOS brings
//! the window forward and focuses the composer (SPEC-310C §1, `app.summon` in
//! `src/web-ui/routes/verse/shell/command-catalog.ts`).
//!
//! Off by default; Settings ▸ Desktop turns it on (see `desktop_prefs`).
//! Registered from Rust through `tauri-plugin-global-shortcut`; the plugin's
//! IPC commands are granted to no window, so page code cannot register a key.
//!
//! The chord is fixed, not configurable: the catalog, the shortcuts overlay and
//! this file must agree, and a vitest reads [`SUMMON_ACCELERATOR`] out of this
//! file to prove they do. ⌃⌥Space was chosen because ⌘Space is Spotlight,
//! ⌃Space switches input sources, and ⌥Space types a non-breaking space in
//! every text field on the Mac.

use std::str::FromStr;

use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

/// Tauri accelerator syntax. MUST equal the catalog's
/// `native: { kind: 'global-hotkey', accelerator: 'Control+Alt+Space' }`.
pub const SUMMON_ACCELERATOR: &str = "Control+Alt+Space";
/// How Settings and the tray print it.
pub const SUMMON_DISPLAY: &str = "⌃⌥Space";
/// The desktop command the page runs when the hotkey fires (C0's
/// `DESKTOP_COMMANDS['focus-composer']` → `app.summon`).
pub const SUMMON_COMMAND: &str = crate::shell_contract::COMMAND_FOCUS_COMPOSER;

pub fn summon_shortcut() -> Shortcut {
    // The constant is a compile-time literal the tests parse, so this cannot
    // fail at runtime; the fallback keeps it panic-free regardless.
    Shortcut::from_str(SUMMON_ACCELERATOR).unwrap_or_else(|_| {
        use tauri_plugin_global_shortcut::{Code, Modifiers};
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
    })
}

/// True for the event that should summon: the summon chord, on key DOWN (the
/// plugin reports press and release; acting on both would toggle twice).
pub fn is_summon_press(shortcut: &Shortcut, state: ShortcutState) -> bool {
    state == ShortcutState::Pressed && shortcut.id() == summon_shortcut().id()
}

/// What happened when we tried to honour the preference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HotkeyStatus {
    pub enabled: bool,
    pub registered: bool,
    pub error: Option<String>,
}

impl HotkeyStatus {
    pub const OFF: Self = Self {
        enabled: false,
        registered: false,
        error: None,
    };
}

impl Default for HotkeyStatus {
    fn default() -> Self {
        Self::OFF
    }
}

/// Operator copy for a registration failure. The plugin's own error text is
/// logged, not shown: it is developer language ("HotKey already registered:
/// HotKey { mods: … }").
pub fn failure_copy() -> String {
    format!("Another app is already using {SUMMON_DISPLAY}. Quit it or change its shortcut, then turn this on again.")
}

/// The status after a register/unregister attempt.
pub fn status_after(enabled: bool, result: Result<(), String>) -> HotkeyStatus {
    match (enabled, result) {
        (false, _) => HotkeyStatus::OFF,
        (true, Ok(())) => HotkeyStatus {
            enabled: true,
            registered: true,
            error: None,
        },
        (true, Err(_)) => HotkeyStatus {
            enabled: true,
            registered: false,
            error: Some(failure_copy()),
        },
    }
}

/// Register or unregister the summon hotkey to match `enabled`.
pub fn apply<R: tauri::Runtime>(app: &tauri::AppHandle<R>, enabled: bool) -> HotkeyStatus {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let manager = app.global_shortcut();
    let shortcut = summon_shortcut();
    let already = manager.is_registered(shortcut);
    let result = match (enabled, already) {
        (true, true) | (false, false) => Ok(()),
        (true, false) => manager.register(shortcut).map_err(|e| e.to_string()),
        (false, true) => manager.unregister(shortcut).map_err(|e| e.to_string()),
    };
    if let Err(e) = &result {
        eprintln!(
            "[ashlr-desktop] could not {} {SUMMON_ACCELERATOR}: {e}",
            if enabled { "register" } else { "unregister" }
        );
    }
    status_after(enabled, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summon_chord_parses_as_control_option_space() {
        use tauri_plugin_global_shortcut::{Code, Modifiers};
        let parsed = Shortcut::from_str(SUMMON_ACCELERATOR).expect("accelerator parses");
        assert_eq!(
            parsed,
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
        );
        assert_eq!(summon_shortcut(), parsed);
    }

    #[test]
    fn only_a_key_down_of_the_summon_chord_summons() {
        use tauri_plugin_global_shortcut::{Code, Modifiers};
        let summon = summon_shortcut();
        assert!(is_summon_press(&summon, ShortcutState::Pressed));
        assert!(
            !is_summon_press(&summon, ShortcutState::Released),
            "release must not toggle again"
        );
        let other = Shortcut::new(Some(Modifiers::SUPER), Code::Space);
        assert!(!is_summon_press(&other, ShortcutState::Pressed));
    }

    #[test]
    fn the_chord_is_not_one_macos_or_the_menu_already_owns() {
        // ⌘Space Spotlight, ⌃Space input sources, ⌥Space non-breaking space.
        for taken in ["Super+Space", "Control+Space", "Alt+Space"] {
            assert_ne!(
                Shortcut::from_str(taken).expect(taken).id(),
                summon_shortcut().id(),
                "{taken}"
            );
        }
    }

    #[test]
    fn status_reports_the_choice_and_what_the_os_granted() {
        assert_eq!(status_after(false, Ok(())), HotkeyStatus::OFF);
        assert_eq!(status_after(false, Err("x".into())), HotkeyStatus::OFF);
        assert_eq!(
            status_after(true, Ok(())),
            HotkeyStatus {
                enabled: true,
                registered: true,
                error: None
            }
        );
        let taken = status_after(true, Err("HotKey already registered: HotKey { … }".into()));
        assert!(taken.enabled && !taken.registered);
        let copy = taken.error.expect("copy");
        assert!(copy.contains("⌃⌥Space"));
        assert!(
            !copy.contains("HotKey {"),
            "developer text never reaches the UI"
        );
    }

    #[test]
    fn the_hotkey_asks_the_page_to_focus_the_composer() {
        assert_eq!(SUMMON_COMMAND, "focus-composer");
    }
}

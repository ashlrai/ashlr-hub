//! The desktop-only preferences Settings ▸ Desktop controls, and the state
//! the page shows beside them.
//!
//! | Preference      | Default | Why the default |
//! |-----------------|---------|-----------------|
//! | `globalHotkey`  | off     | A system-wide key steals that chord from every other app; the operator opts in. |
//! | `automaticUpdates` | on | Signed staging and guarded idle adoption; no Stop clear or resident restart. |
//! | `automaticAwake` | on | Process-owned idle-sleep requests follow observed local work; system settings remain unchanged. |
//! | `notifications` | on      | The point of a tray app is hearing about work while the window is hidden. |
//!
//! Stored at `~/.ashlr/desktop/prefs.json` (0600, atomic write) next to the
//! window geometry, so the hotkey is live from launch — before the page loads.
//!
//! The page changes them by emitting `shell-prefs` (the one event channel the
//! Verse capability already grants; no new permission). The payload is parsed
//! STRICTLY — an object with only known keys, booleans only — because any
//! script on the page can emit it. The worst a hostile emit can do is switch a
//! hotkey, banners, or an idle-sleep request, both visible and reversible in Settings.

use std::{fs, path::Path, path::PathBuf};

use serde::{Deserialize, Serialize};

/// Event the page emits to change a preference.
pub const PREFS_EVENT: &str = "shell-prefs";
/// Event the page emits to ask for the current [`DesktopStateView`].
pub const STATE_REQUEST_EVENT: &str = "shell-state-request";

fn yes() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPrefs {
    #[serde(default)]
    pub global_hotkey: bool,
    #[serde(default = "yes")]
    pub notifications: bool,
    #[serde(default = "yes")]
    pub automatic_awake: bool,
    #[serde(default = "yes")]
    pub automatic_updates: bool,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self {
            global_hotkey: false,
            notifications: true,
            automatic_awake: true,
            automatic_updates: true,
        }
    }
}

/// A change the page asked for. Unknown keys make the whole patch invalid.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrefsPatch {
    #[serde(default)]
    pub global_hotkey: Option<bool>,
    #[serde(default)]
    pub notifications: Option<bool>,
    #[serde(default)]
    pub automatic_awake: Option<bool>,
    #[serde(default)]
    pub automatic_updates: Option<bool>,
}

/// Parse a `shell-prefs` payload. `None` for anything but an object carrying at
/// least one known key with a boolean value.
pub fn parse_patch(payload: &str) -> Option<PrefsPatch> {
    // Object first: serde would otherwise read `[true]` as a positional struct.
    let value: serde_json::Value = serde_json::from_str(payload.trim()).ok()?;
    if !value.is_object() {
        return None;
    }
    let patch: PrefsPatch = serde_json::from_value(value).ok()?;
    (patch.global_hotkey.is_some()
        || patch.notifications.is_some()
        || patch.automatic_awake.is_some()
        || patch.automatic_updates.is_some())
    .then_some(patch)
}

impl DesktopPrefs {
    pub fn apply(self, patch: PrefsPatch) -> Self {
        Self {
            global_hotkey: patch.global_hotkey.unwrap_or(self.global_hotkey),
            notifications: patch.notifications.unwrap_or(self.notifications),
            automatic_awake: patch.automatic_awake.unwrap_or(self.automatic_awake),
            automatic_updates: patch.automatic_updates.unwrap_or(self.automatic_updates),
        }
    }
}

/// Other existing preferences may remain in-memory after a write failure, but
/// automatic installation must never acknowledge a setting that will reset on launch.
pub fn retained_preferences(
    previous: DesktopPrefs,
    candidate: DesktopPrefs,
    patch: PrefsPatch,
    saved: bool,
) -> DesktopPrefs {
    if !saved && patch.automatic_updates.is_some() {
        DesktopPrefs {
            automatic_updates: previous.automatic_updates,
            ..candidate
        }
    } else {
        candidate
    }
}
/// `~/.ashlr/desktop/prefs.json`.
pub fn prefs_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".ashlr")
        .join("desktop")
        .join("prefs.json")
}

/// Missing or malformed → defaults (a broken file must not brick the app).
pub fn load_from(path: &Path) -> DesktopPrefs {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Atomic (temp + rename), owner-only. Best effort: an unwritable home keeps
/// the change for this run and says so once.
pub fn store_to(path: &Path, prefs: &DesktopPrefs) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if fs::create_dir_all(parent).is_err() {
        return false;
    }
    let Ok(json) = serde_json::to_string_pretty(prefs) else {
        return false;
    };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, json).is_err() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    true
}

pub fn load() -> DesktopPrefs {
    load_from(&prefs_path())
}

pub fn store(prefs: &DesktopPrefs) -> bool {
    let saved = store_to(&prefs_path(), prefs);
    if !saved {
        eprintln!(
            "[ashlr-desktop] could not save desktop preferences — the change lasts until quit"
        );
    }
    saved
}

// ── what the page sees ───────────────────────────────────────────────────────

/// `DesktopState` in `src/web-ui/app/desktop-shell.ts`. Every string here is
/// ours; nothing comes from the server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DesktopStateView {
    pub hotkey: HotkeyView,
    pub notifications: NotificationsView,
    pub power: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HotkeyView {
    /// The operator's choice.
    pub enabled: bool,
    /// Whether the OS actually gave us the chord.
    pub registered: bool,
    /// Display form, macOS glyphs ("⌃⌥Space").
    pub accelerator: String,
    /// Operator-language reason `registered` is false while `enabled` is true.
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NotificationsView {
    pub enabled: bool,
    /// `native` (signed build) or `script` (osascript fallback).
    pub delivery: &'static str,
}

/// The script that hands a new state to the live page (see shell_contract.js
/// `__ASHLR_DESKTOP_STATE__`). JSON-encoded, never interpolated.
pub fn state_script(view: &DesktopStateView) -> String {
    let json = serde_json::to_string(view).unwrap_or_else(|_| "null".to_string());
    format!(
        "if (typeof window.__ASHLR_DESKTOP_STATE__ === 'function') window.__ASHLR_DESKTOP_STATE__({json});"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        // Under the OS temp dir, never the real ~/.ashlr.
        let dir = std::env::temp_dir().join(format!(
            "ashlr-desktop-prefs-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn defaults_are_hotkey_off_and_notifications_on() {
        let prefs = DesktopPrefs::default();
        assert!(!prefs.global_hotkey);
        assert!(prefs.notifications);
        assert!(prefs.automatic_updates);
        // A file from before a key existed gets that key's default.
        assert_eq!(serde_json::from_str::<DesktopPrefs>("{}").unwrap(), prefs);
    }

    #[test]
    fn patches_are_strict_objects_of_known_booleans() {
        assert_eq!(
            parse_patch(r#"{"globalHotkey":true}"#),
            Some(PrefsPatch {
                global_hotkey: Some(true),
                notifications: None,
                automatic_awake: None,
                automatic_updates: None
            })
        );
        assert_eq!(
            parse_patch(r#" {"notifications":false,"globalHotkey":false} "#),
            Some(PrefsPatch {
                global_hotkey: Some(false),
                notifications: Some(false),
                automatic_awake: None,
                automatic_updates: None
            })
        );
        for bad in [
            "",
            "null",
            "true",
            "{}",
            r#""globalHotkey""#,
            r#"{"globalHotkey":"yes"}"#,
            r#"{"globalHotkey":1}"#,
            r#"{"globalHotkey":true,"accelerator":"Cmd+Q"}"#,
            r#"{"__proto__":{"globalHotkey":true}}"#,
            "[true]",
        ] {
            assert_eq!(parse_patch(bad), None, "{bad}");
        }
    }

    #[test]
    fn automatic_awake_defaults_on_and_can_be_disabled_independently() {
        let prefs = DesktopPrefs::default();
        assert!(prefs.automatic_awake);
        let patch = parse_patch(r#"{"automaticAwake":false}"#).unwrap();
        let disabled = prefs.apply(patch);
        assert!(!disabled.automatic_awake);
        assert_eq!(disabled.global_hotkey, prefs.global_hotkey);
        assert_eq!(disabled.notifications, prefs.notifications);
        let raw = serde_json::to_string(&disabled).unwrap();
        assert_eq!(
            serde_json::from_str::<DesktopPrefs>(&raw).unwrap(),
            disabled
        );
        assert!(parse_patch(r#"{"automaticAwake":"yes"}"#).is_none());
    }

    #[test]
    fn automatic_updates_is_default_on_and_explicit_false_round_trips() {
        let prefs = DesktopPrefs::default();
        let disabled = prefs.apply(parse_patch(r#"{"automaticUpdates":false}"#).unwrap());
        assert!(!disabled.automatic_updates);
        assert_eq!(disabled.automatic_awake, prefs.automatic_awake);
        assert_eq!(disabled.notifications, prefs.notifications);
        assert_eq!(
            serde_json::from_str::<DesktopPrefs>(&serde_json::to_string(&disabled).unwrap())
                .unwrap(),
            disabled
        );
        assert!(parse_patch(r#"{"automaticUpdates":"yes"}"#).is_none());
        assert_eq!(
            serde_json::from_str::<DesktopPrefs>(r#"{"automaticAwake":false}"#)
                .unwrap()
                .automatic_updates,
            true
        );
    }

    #[test]
    fn a_patch_changes_only_what_it_names() {
        let prefs = DesktopPrefs::default().apply(PrefsPatch {
            global_hotkey: Some(true),
            notifications: None,
            automatic_awake: None,
            automatic_updates: None,
        });
        assert_eq!(
            prefs,
            DesktopPrefs {
                global_hotkey: true,
                notifications: true,
                automatic_awake: true,
                automatic_updates: true
            }
        );
    }

    #[test]
    fn prefs_round_trip_owner_only_and_survive_a_corrupt_file() {
        let dir = tmp_dir("rt");
        let path = dir.join("desktop").join("prefs.json");
        assert_eq!(
            load_from(&path),
            DesktopPrefs::default(),
            "missing file → defaults"
        );

        let wanted = DesktopPrefs {
            global_hotkey: true,
            notifications: false,
            automatic_awake: true,
            automatic_updates: true,
        };
        assert!(store_to(&path, &wanted));
        assert_eq!(load_from(&path), wanted);
        assert!(
            !path.with_extension("json.tmp").exists(),
            "no temp file left behind"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        fs::write(&path, "{not json").unwrap();
        assert_eq!(load_from(&path), DesktopPrefs::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_real_prefs_path_is_under_the_desktop_state_dir() {
        let path = prefs_path();
        assert!(path.ends_with(".ashlr/desktop/prefs.json"), "{path:?}");
    }

    #[test]
    fn the_state_script_is_json_encoded_and_guarded() {
        let view = DesktopStateView {
            power: None,
            hotkey: HotkeyView {
                enabled: true,
                registered: false,
                accelerator: "⌃⌥Space".into(),
                error: Some("x\"); alert(1); (\"".into()),
            },
            notifications: NotificationsView {
                enabled: true,
                delivery: "script",
            },
        };
        let script = state_script(&view);
        assert!(script.starts_with("if (typeof window.__ASHLR_DESKTOP_STATE__ === 'function')"));
        assert!(
            script.contains(r#""error":"x\"); alert(1); (\"""#),
            "{script}"
        );
        assert!(script.contains(r#""delivery":"script""#));
        assert!(script.contains(r#""accelerator":"⌃⌥Space""#));
    }
    #[test]
    fn failed_persistence_retains_update_choice_without_changing_other_preferences() {
        let old = DesktopPrefs::default();
        let patch = parse_patch(r#"{"automaticUpdates":false,"notifications":false}"#).unwrap();
        let actual = retained_preferences(old, old.apply(patch), patch, false);
        assert!(actual.automatic_updates);
        assert!(!actual.notifications);
        assert!(!retained_preferences(old, old.apply(patch), patch, true).automatic_updates);
    }
}

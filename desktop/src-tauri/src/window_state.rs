//! Window geometry + theme persistence for the Verse window.
//!
//! State lives at `~/.ashlr/desktop/window-state.json` and holds only geometry
//! and the last resolved UI theme. Nothing here ever touches a token, a launcher
//! command, or an env value.
//!
//! Two reasons the theme is stored next to the geometry:
//!   * the window's native background colour must match the UI before the first
//!     frame paints, otherwise a dark-mode launch flashes white while WKWebView
//!     is still blank;
//!   * the OS appearance is not a reliable proxy — the user can force light or
//!     dark inside Verse independently of macOS.
//!
//! Everything in this module is pure except [`load`] / [`store`], so the
//! clamping rules can be unit-tested without a window server.

use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};

/// Default window size — matches the previous hard-coded tauri.conf.json values.
pub const DEFAULT_WIDTH: f64 = 1280.0;
pub const DEFAULT_HEIGHT: f64 = 820.0;

/// Minimum size. `docs/VERSE-DESIGN-V2.md` §6 requires the layout to work down
/// to 900px wide (resources panel collapses, then the sidebar overlays), so the
/// floor is set there rather than at the old 960px.
pub const MIN_WIDTH: f64 = 900.0;
pub const MIN_HEIGHT: f64 = 620.0;

/// How much of the window's top strip must land inside a monitor for a restored
/// position to be considered reachable. Roughly the draggable title strip, so a
/// window can never be restored with its only drag handle off-screen.
const VISIBLE_STRIP_H: f64 = 48.0;
/// Minimum horizontal overlap with a monitor for a restored position to count.
const VISIBLE_STRIP_W: f64 = 120.0;

/// The UI theme actually in force, as reported by the web UI (see
/// `shell_contract.rs` — the page emits `shell-theme` when it resolves).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellTheme {
    Light,
    Dark,
}

impl ShellTheme {
    /// Canvas colour for this theme, straight from `docs/VERSE-DESIGN-V2.md` §2
    /// (dark `--bg-canvas #0b0b0d`, light canvas `--gray-50 #fafafa`).
    pub fn canvas_rgba(self) -> (u8, u8, u8, u8) {
        match self {
            ShellTheme::Dark => (0x0b, 0x0b, 0x0d, 0xff),
            ShellTheme::Light => (0xfa, 0xfa, 0xfa, 0xff),
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "dark" => Some(ShellTheme::Dark),
            "light" => Some(ShellTheme::Light),
            _ => None,
        }
    }
}

/// A monitor's logical work area, in the same coordinate space as window
/// positions.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MonitorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    /// Absent on first run (the window is then centred).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<ShellTheme>,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            x: None,
            y: None,
            maximized: false,
            theme: None,
        }
    }
}

impl WindowState {
    /// Drop anything that cannot be turned into a usable window: NaN/infinite
    /// numbers from a corrupted file, sizes below the minimum, absurd sizes.
    pub fn sanitized(mut self) -> Self {
        if !self.width.is_finite() || !self.height.is_finite() {
            self.width = DEFAULT_WIDTH;
            self.height = DEFAULT_HEIGHT;
        }
        self.width = self.width.clamp(MIN_WIDTH, 100_000.0);
        self.height = self.height.clamp(MIN_HEIGHT, 100_000.0);
        if let Some(x) = self.x {
            if !x.is_finite() {
                self.x = None;
            }
        }
        if let Some(y) = self.y {
            if !y.is_finite() {
                self.y = None;
            }
        }
        if self.x.is_none() || self.y.is_none() {
            self.x = None;
            self.y = None;
        }
        self
    }

    /// Fit the state to the monitors that actually exist right now.
    ///
    /// A saved position is kept only when a meaningful slice of the window's
    /// draggable top strip lands inside some monitor; otherwise the position is
    /// dropped and the caller centres the window. This is what keeps an
    /// external-display layout from restoring off-screen after the display is
    /// unplugged.
    pub fn clamped_to(mut self, monitors: &[MonitorRect]) -> Self {
        self = self.sanitized();
        if monitors.is_empty() {
            self.x = None;
            self.y = None;
            return self;
        }

        let widest = monitors.iter().fold(0.0_f64, |a, m| a.max(m.width));
        let tallest = monitors.iter().fold(0.0_f64, |a, m| a.max(m.height));
        if widest >= MIN_WIDTH {
            self.width = self.width.min(widest);
        }
        if tallest >= MIN_HEIGHT {
            self.height = self.height.min(tallest);
        }

        let (Some(x), Some(y)) = (self.x, self.y) else {
            return self;
        };
        let strip_w = VISIBLE_STRIP_W.min(self.width);
        let strip_h = VISIBLE_STRIP_H.min(self.height);
        let reachable = monitors.iter().any(|m| {
            let overlap_x = (x + self.width).min(m.x + m.width) - x.max(m.x);
            let overlap_y = (y + strip_h).min(m.y + m.height) - y.max(m.y);
            overlap_x >= strip_w && overlap_y > 0.0
        });
        if !reachable {
            self.x = None;
            self.y = None;
        }
        self
    }
}

/// `~/.ashlr/desktop/window-state.json`.
pub fn state_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".ashlr")
        .join("desktop")
        .join("window-state.json")
}

/// Read the persisted state. A missing, unreadable, or malformed file is not an
/// error — the app simply starts at its default geometry.
pub fn load() -> Option<WindowState> {
    let raw = fs::read_to_string(state_path()).ok()?;
    let parsed: WindowState = serde_json::from_str(&raw).ok()?;
    Some(parsed.sanitized())
}

/// Persist atomically (temp + rename) so a crash mid-write cannot leave a
/// truncated file that makes the next launch lose its geometry.
pub fn store(state: &WindowState) {
    let path = state_path();
    let Some(parent) = path.parent() else { return };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(json) = serde_json::to_string_pretty(state) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, json).is_err() {
        return;
    }
    if fs::rename(&tmp, &path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: f64, y: f64, w: f64, h: f64) -> MonitorRect {
        MonitorRect {
            x,
            y,
            width: w,
            height: h,
        }
    }

    #[test]
    fn corrupt_numbers_fall_back_to_defaults() {
        let s = WindowState {
            width: f64::NAN,
            height: f64::INFINITY,
            x: Some(f64::NAN),
            y: Some(10.0),
            maximized: false,
            theme: None,
        }
        .sanitized();
        assert_eq!(s.width, DEFAULT_WIDTH);
        assert_eq!(s.height, DEFAULT_HEIGHT);
        assert_eq!(s.x, None, "a half-valid position is discarded entirely");
        assert_eq!(s.y, None);
    }

    #[test]
    fn size_never_restores_below_the_minimum() {
        let s = WindowState {
            width: 120.0,
            height: 80.0,
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.width, MIN_WIDTH);
        assert_eq!(s.height, MIN_HEIGHT);
    }

    #[test]
    fn the_real_two_monitor_layout_on_this_mac_keeps_the_saved_position() {
        // 1920x1080 main display with the scaled Retina laptop screen to its
        // right — the exact layout the app failed to restore on.
        let monitors = [
            MonitorRect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 },
            MonitorRect { x: 1920.0, y: 0.0, width: 1512.0, height: 982.0 },
        ];
        let saved = WindowState {
            width: 1150.0,
            height: 760.0,
            x: Some(140.0),
            y: Some(90.0),
            maximized: false,
            theme: None,
        };
        let restored = saved.clamped_to(&monitors);
        assert_eq!(restored.x, Some(140.0), "saved x was dropped");
        assert_eq!(restored.y, Some(90.0), "saved y was dropped");
        assert_eq!(restored.width, 1150.0);
        assert_eq!(restored.height, 760.0);
    }

    #[test]
    fn position_on_a_still_present_monitor_is_kept() {
        let s = WindowState {
            width: 1280.0,
            height: 820.0,
            x: Some(100.0),
            y: Some(60.0),
            maximized: false,
            theme: Some(ShellTheme::Dark),
        }
        .clamped_to(&[mon(0.0, 0.0, 1920.0, 1080.0)]);
        assert_eq!(s.x, Some(100.0));
        assert_eq!(s.y, Some(60.0));
        assert_eq!(s.theme, Some(ShellTheme::Dark));
    }

    #[test]
    fn position_on_an_unplugged_monitor_is_dropped() {
        // Saved on a second display to the right that no longer exists.
        let s = WindowState {
            width: 1280.0,
            height: 820.0,
            x: Some(2400.0),
            y: Some(200.0),
            ..Default::default()
        }
        .clamped_to(&[mon(0.0, 0.0, 1920.0, 1080.0)]);
        assert_eq!(s.x, None);
        assert_eq!(s.y, None);
    }

    #[test]
    fn a_window_dragged_mostly_off_the_bottom_is_still_reachable_by_its_strip() {
        // Top strip on-screen: keep it. The user put it there deliberately.
        let on = WindowState {
            width: 1000.0,
            height: 820.0,
            x: Some(40.0),
            y: Some(1040.0),
            ..Default::default()
        }
        .clamped_to(&[mon(0.0, 0.0, 1920.0, 1080.0)]);
        assert_eq!(on.y, Some(1040.0));

        // Title strip entirely below the screen: unreachable, so re-centre.
        let off = WindowState {
            width: 1000.0,
            height: 820.0,
            x: Some(40.0),
            y: Some(1120.0),
            ..Default::default()
        }
        .clamped_to(&[mon(0.0, 0.0, 1920.0, 1080.0)]);
        assert_eq!(off.y, None);
    }

    #[test]
    fn secondary_monitor_positions_survive() {
        let s = WindowState {
            width: 1280.0,
            height: 820.0,
            x: Some(2100.0),
            y: Some(100.0),
            ..Default::default()
        }
        .clamped_to(&[mon(0.0, 0.0, 1920.0, 1080.0), mon(1920.0, 0.0, 2560.0, 1440.0)]);
        assert_eq!(s.x, Some(2100.0));
    }

    #[test]
    fn size_is_capped_to_the_largest_monitor() {
        let s = WindowState {
            width: 5000.0,
            height: 4000.0,
            ..Default::default()
        }
        .clamped_to(&[mon(0.0, 0.0, 1920.0, 1080.0)]);
        assert_eq!(s.width, 1920.0);
        assert_eq!(s.height, 1080.0);
    }

    #[test]
    fn no_monitors_means_centre_rather_than_guess() {
        let s = WindowState {
            width: 1280.0,
            height: 820.0,
            x: Some(10.0),
            y: Some(10.0),
            ..Default::default()
        }
        .clamped_to(&[]);
        assert_eq!((s.x, s.y), (None, None));
    }

    #[test]
    fn theme_round_trips_through_json_and_carries_the_design_canvas() {
        let json = serde_json::to_string(&WindowState {
            width: 1000.0,
            height: 700.0,
            x: Some(1.0),
            y: Some(2.0),
            maximized: true,
            theme: Some(ShellTheme::Dark),
        })
        .expect("serialize");
        let back: WindowState = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.theme, Some(ShellTheme::Dark));
        assert!(back.maximized);
        assert_eq!(ShellTheme::Dark.canvas_rgba(), (0x0b, 0x0b, 0x0d, 0xff));
        assert_eq!(ShellTheme::Light.canvas_rgba(), (0xfa, 0xfa, 0xfa, 0xff));
    }

    #[test]
    fn theme_parsing_is_tolerant_but_closed() {
        assert_eq!(ShellTheme::parse(" Dark "), Some(ShellTheme::Dark));
        assert_eq!(ShellTheme::parse("LIGHT"), Some(ShellTheme::Light));
        assert_eq!(ShellTheme::parse("system"), None);
        assert_eq!(ShellTheme::parse(""), None);
    }

    #[test]
    fn a_state_file_missing_optional_fields_still_loads() {
        let back: WindowState =
            serde_json::from_str(r#"{"width":1000,"height":700}"#).expect("deserialize");
        assert_eq!(back.x, None);
        assert!(!back.maximized);
        assert_eq!(back.theme, None);
    }
}

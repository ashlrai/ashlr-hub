//! The macOS menu bar.
//!
//! Without a real menu bar a Tauri window gets no Edit menu, which means no
//! ⌘C / ⌘V / ⌘Z inside the Verse composer — WKWebView routes those through the
//! responder chain, and with no menu item to claim them nothing happens. The
//! Edit submenu below exists primarily for that.
//!
//! Accelerators are split deliberately between native and web:
//!   * native takes ⌘, ⌘R ⌘+ ⌘- ⌘0 ⇧⌘L and the standard Edit/Window set;
//!   * ⌘1–⌘5, ⌘K and ⌘N stay unbound here so they reach the page, which owns
//!     them (`docs/VERSE-CONTRACT-V2.md`, shell contract).
//!
//! Menu items that belong to the UI rather than the window (Settings, theme)
//! are delivered to the page by evaluating [`shell_contract::command_script`] —
//! no IPC, no Tauri API in page code.

use std::sync::Mutex;

use tauri::{
    menu::{AboutMetadataBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu},
    AppHandle, Manager, Runtime,
};

use crate::shell_contract;

/// Menu item ids handled by [`handle_menu_event`].
pub const ID_SETTINGS: &str = "app.settings";
pub const ID_RELOAD: &str = "view.reload";
pub const ID_TOGGLE_THEME: &str = "view.toggle-theme";
pub const ID_ZOOM_IN: &str = "view.zoom-in";
pub const ID_ZOOM_OUT: &str = "view.zoom-out";
pub const ID_ZOOM_RESET: &str = "view.zoom-reset";

const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 2.0;
const ZOOM_STEP: f64 = 0.1;

/// Current webview zoom, managed state so the menu is stateless.
pub struct ZoomLevel(pub Mutex<f64>);

impl Default for ZoomLevel {
    fn default() -> Self {
        Self(Mutex::new(1.0))
    }
}

/// Clamp a zoom factor to the range the View menu allows.
///
/// Pure so the stepping rules can be tested without a webview.
pub fn clamp_zoom(value: f64) -> f64 {
    if !value.is_finite() {
        return 1.0;
    }
    // Round to the nearest step so repeated in/out returns exactly to 1.0
    // instead of drifting on float error.
    let stepped = (value / ZOOM_STEP).round() * ZOOM_STEP;
    stepped.clamp(ZOOM_MIN, ZOOM_MAX)
}

/// The next zoom factor for a menu id, or `None` if the id is not a zoom item.
pub fn next_zoom(current: f64, id: &str) -> Option<f64> {
    match id {
        ID_ZOOM_IN => Some(clamp_zoom(current + ZOOM_STEP)),
        ID_ZOOM_OUT => Some(clamp_zoom(current - ZOOM_STEP)),
        ID_ZOOM_RESET => Some(1.0),
        _ => None,
    }
}

/// Build the full application menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = PredefinedMenuItem::about(
        app,
        Some("About Ashlr"),
        Some(
            AboutMetadataBuilder::new()
                .name(Some("Ashlr Verse"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .copyright(Some("Copyright © 2024 Mason Wyatt / Evero Consulting"))
                .build(),
        ),
    )?;
    let settings = MenuItemBuilder::with_id(ID_SETTINGS, "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let app_menu = Submenu::with_items(
        app,
        "Ashlr",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Hide Ashlr"))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit Ashlr"))?,
        ],
    )?;

    // Without these, copy/paste/undo do nothing in the composer.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItemBuilder::with_id(ID_RELOAD, "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItemBuilder::with_id(ID_TOGGLE_THEME, "Toggle Light / Dark")
                .accelerator("Shift+CmdOrCtrl+L")
                .build(app)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItemBuilder::with_id(ID_ZOOM_IN, "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
            &MenuItemBuilder::with_id(ID_ZOOM_OUT, "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
            &MenuItemBuilder::with_id(ID_ZOOM_RESET, "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

/// Route a menu activation. Unknown ids (every predefined item) are ignored —
/// the OS already handled them.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str, main_window_label: &str) {
    let Some(window) = app.get_webview_window(main_window_label) else {
        return;
    };

    match id {
        ID_SETTINGS => {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.eval(shell_contract::command_script(
                shell_contract::COMMAND_OPEN_SETTINGS,
            ));
        }
        ID_TOGGLE_THEME => {
            let _ = window.eval(shell_contract::command_script(
                shell_contract::COMMAND_TOGGLE_THEME,
            ));
        }
        ID_RELOAD => {
            let _ = window.reload();
        }
        ID_ZOOM_IN | ID_ZOOM_OUT | ID_ZOOM_RESET => {
            let state = app.state::<ZoomLevel>();
            let mut guard = match state.0.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            if let Some(next) = next_zoom(*guard, id) {
                if window.set_zoom(next).is_ok() {
                    *guard = next;
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_is_bounded_in_both_directions() {
        assert_eq!(clamp_zoom(5.0), ZOOM_MAX);
        assert_eq!(clamp_zoom(0.01), ZOOM_MIN);
        // A non-finite factor is not a zoom level the user can have reached;
        // reset rather than pinning them to the ceiling.
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
        assert_eq!(clamp_zoom(f64::INFINITY), 1.0);
        assert_eq!(clamp_zoom(f64::NEG_INFINITY), 1.0);
    }

    #[test]
    fn stepping_in_then_out_returns_exactly_to_one() {
        let mut zoom = 1.0;
        for _ in 0..5 {
            zoom = next_zoom(zoom, ID_ZOOM_IN).expect("zoom in");
        }
        for _ in 0..5 {
            zoom = next_zoom(zoom, ID_ZOOM_OUT).expect("zoom out");
        }
        assert!(
            (zoom - 1.0).abs() < 1e-9,
            "float drift left zoom at {zoom} instead of 1.0"
        );
    }

    #[test]
    fn actual_size_always_returns_to_one() {
        assert_eq!(next_zoom(1.7, ID_ZOOM_RESET), Some(1.0));
        assert_eq!(next_zoom(0.6, ID_ZOOM_RESET), Some(1.0));
    }

    #[test]
    fn zoom_out_stops_at_the_floor_rather_than_inverting() {
        let mut zoom = 1.0;
        for _ in 0..40 {
            zoom = next_zoom(zoom, ID_ZOOM_OUT).expect("zoom out");
        }
        assert_eq!(zoom, ZOOM_MIN);
        assert!(zoom > 0.0);
    }

    #[test]
    fn non_zoom_ids_are_not_treated_as_zoom() {
        assert_eq!(next_zoom(1.0, ID_SETTINGS), None);
        assert_eq!(next_zoom(1.0, "whatever"), None);
    }

    #[test]
    fn the_web_uis_own_shortcuts_are_not_claimed_natively() {
        // docs/VERSE-CONTRACT-V2.md gives the page ⌘1–⌘5, ⌘K and ⌘N. A native
        // accelerator would swallow them before the webview ever sees them.
        let source = include_str!("app_menu.rs");
        for reserved in [
            "CmdOrCtrl+1",
            "CmdOrCtrl+2",
            "CmdOrCtrl+3",
            "CmdOrCtrl+4",
            "CmdOrCtrl+5",
            "CmdOrCtrl+K",
            "CmdOrCtrl+N",
        ] {
            assert!(
                !source.contains(&format!(".accelerator(\"{reserved}\")")),
                "native menu claimed {reserved}, which belongs to the web UI"
            );
        }
    }
}

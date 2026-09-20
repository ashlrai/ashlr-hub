//! The single native→web surface of the desktop app.
//!
//! One webview initialization script is injected into the Verse page before any
//! page script runs. It carries four things, all documented for the web UI in
//! `desktop/README.md` under "Desktop shell contract":
//!
//! 1. `window.__ASHLR_TOKENS__` — the sidecar's read/mutation tokens, so the
//!    SessionGate never asks for a paste. Present only once the sidecar has
//!    reported readiness.
//! 2. `data-app-shell="desktop"` / `data-app-platform` on `<html>`, plus the
//!    `--app-titlebar-height` and `--app-traffic-light-inset` CSS variables, so
//!    the web UI can inset its rail and header strip under the traffic lights.
//! 3. Mirroring of `data-app-region="drag" | "no-drag"` onto Tauri's own
//!    `data-tauri-drag-region`, so the top strip drags the window.
//! 4. `window.__ASHLR_DESKTOP_COMMAND__(name)`, which the macOS menu bar calls
//!    by `eval` to dispatch an `ashlr:desktop-command` window event.
//!
//! The script is origin-gated to the sidecar origin. Token values are
//! JSON-encoded into a config object, never string-interpolated, so no token
//! content can break out of the literal.

use serde::Serialize;

/// Height in CSS px of the strip at the top of the window reserved for
/// dragging. Matches the 48px header strip in `docs/VERSE-DESIGN-V2.md` §4, so
/// the header strip and the drag strip are the same band.
pub const TITLEBAR_HEIGHT: u32 = 48;

/// Width in CSS px at the top-left that must stay clear of interactive
/// controls, because the macOS traffic lights float there. Wider than the 56px
/// rail on purpose: the three buttons plus their inset overrun the rail.
pub const TRAFFIC_LIGHT_INSET: u32 = 92;

/// Physical offset of the traffic-light cluster inside the window, chosen so the
/// buttons sit vertically centred in the 48px strip.
pub const TRAFFIC_LIGHT_X: f64 = 18.0;
pub const TRAFFIC_LIGHT_Y: f64 = 18.0;

/// Event the page emits when its theme resolves (see `reportTheme`).
pub const THEME_EVENT: &str = "shell-theme";

/// Commands the menu bar can send to the page.
pub const COMMAND_OPEN_SETTINGS: &str = "open-settings";
pub const COMMAND_TOGGLE_THEME: &str = "toggle-theme";

const SHELL_JS: &str = include_str!("shell_contract.js");

/// Tokens as the page sees them. Deliberately no `Debug`: the struct must not
/// be printable by accident.
#[derive(Serialize)]
pub struct ShellTokens<'a> {
    #[serde(rename = "readToken")]
    pub read_token: &'a str,
    pub token: Option<&'a str>,
}

#[derive(Serialize)]
struct ShellConfig<'a> {
    origin: &'a str,
    platform: &'a str,
    version: &'a str,
    #[serde(rename = "titlebarHeight")]
    titlebar_height: u32,
    #[serde(rename = "trafficLightInset")]
    traffic_light_inset: u32,
    tokens: Option<ShellTokens<'a>>,
}

/// Build the initialization script for a window pointed at `origin`.
///
/// `tokens` is `None` before the sidecar has reported readiness (or when the
/// user chose to adopt an already-running server); the shell contract still
/// applies, and the SessionGate asks for a token as usual.
pub fn init_script(origin: &str, tokens: Option<ShellTokens<'_>>) -> String {
    let config = ShellConfig {
        origin,
        platform: std::env::consts::OS,
        version: env!("CARGO_PKG_VERSION"),
        titlebar_height: TITLEBAR_HEIGHT,
        traffic_light_inset: TRAFFIC_LIGHT_INSET,
        tokens,
    };
    let json = serde_json::to_string(&config).unwrap_or_else(|_| "null".to_string());
    format!("var __ASHLR_SHELL_CONFIG = {json};\n{SHELL_JS}")
}

/// A one-line script the menu bar evaluates to send `command` to the page.
pub fn command_script(command: &str) -> String {
    let encoded = serde_json::to_string(command).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "if (typeof window.__ASHLR_DESKTOP_COMMAND__ === 'function') window.__ASHLR_DESKTOP_COMMAND__({encoded});"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "http://127.0.0.1:7777";

    #[test]
    fn the_script_is_origin_gated() {
        let script = init_script(ORIGIN, None);
        assert!(script.contains("\"origin\":\"http://127.0.0.1:7777\""));
        assert!(script.contains("if (window.location.origin !== cfg.origin) return"));
    }

    #[test]
    fn tokens_are_json_encoded_and_cannot_break_out_of_the_literal() {
        let script = init_script(
            ORIGIN,
            Some(ShellTokens {
                read_token: "aa11\"</script>",
                token: Some("bb22"),
            }),
        );
        assert!(script.contains(r#""readToken":"aa11\"</script>""#));
        assert!(script.contains(r#""token":"bb22""#));
        assert!(script.contains("window.__ASHLR_TOKENS__ = Object.freeze(cfg.tokens)"));
    }

    #[test]
    fn a_read_only_sidecar_yields_a_null_mutation_token() {
        let script = init_script(
            ORIGIN,
            Some(ShellTokens {
                read_token: "aa11",
                token: None,
            }),
        );
        assert!(script.contains(r#""token":null"#));
    }

    #[test]
    fn without_tokens_the_shell_contract_still_applies() {
        let script = init_script(ORIGIN, None);
        assert!(script.contains(r#""tokens":null"#));
        assert!(!script.contains("readToken"));
        assert!(script.contains("data-app-shell"));
    }

    #[test]
    fn the_documented_web_ui_contract_is_present_verbatim() {
        let script = init_script(ORIGIN, None);
        // Attributes and variables desktop/README.md promises owner C.
        for needle in [
            "data-app-shell",
            "data-app-platform",
            "--app-titlebar-height",
            "--app-traffic-light-inset",
            "data-app-region",
            "data-tauri-drag-region",
            "ashlr:desktop-command",
            "window.__ASHLR_DESKTOP__",
            "reportTheme",
        ] {
            assert!(script.contains(needle), "shell contract lost `{needle}`");
        }
        assert!(script.contains(&format!("\"titlebarHeight\":{TITLEBAR_HEIGHT}")));
        assert!(script.contains(&format!("\"trafficLightInset\":{TRAFFIC_LIGHT_INSET}")));
    }

    #[test]
    fn drag_regions_map_onto_tauris_own_attribute_in_both_directions() {
        let script = init_script(ORIGIN, None);
        assert!(script.contains("if (value === 'drag')"));
        assert!(script.contains("setAttribute(TAURI_ATTR, 'deep')"));
        assert!(script.contains("} else if (value === 'no-drag') {"));
        assert!(script.contains("setAttribute(TAURI_ATTR, 'false')"));
        // and a MutationObserver so late-rendered React chrome is covered
        assert!(script.contains("new MutationObserver"));
    }

    #[test]
    fn menu_commands_are_encoded_not_interpolated() {
        let script = command_script(COMMAND_OPEN_SETTINGS);
        assert!(script.contains("window.__ASHLR_DESKTOP_COMMAND__(\"open-settings\")"));
        let hostile = command_script("x\");alert(1);//");
        assert!(
            hostile.contains(r#"__ASHLR_DESKTOP_COMMAND__("x\");alert(1);//")"#),
            "got {hostile}"
        );
    }

    #[test]
    fn the_titlebar_band_matches_the_design_language() {
        // docs/VERSE-DESIGN-V2.md §4: 56px rail, 48px header strip.
        assert_eq!(TITLEBAR_HEIGHT, 48);
        assert!(
            TRAFFIC_LIGHT_INSET > 56,
            "the traffic lights overrun the 56px rail and the UI must know it"
        );
    }
}

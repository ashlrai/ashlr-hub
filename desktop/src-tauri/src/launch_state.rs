//! The launch window's state machine and its redaction rules.
//!
//! The desktop app shows a small designed window the moment it starts, long
//! before the sidecar has finished booting, and that window has to be able to
//! say *why* nothing happened when the sidecar never becomes ready. This module
//! owns that vocabulary so it can be unit-tested without a window server.
//!
//! ## Security
//!
//! The launch window renders a `detail` string that may contain sidecar
//! diagnostics. The sidecar's startup record (which carries the read and
//! mutation tokens) is consumed on the stdout side and never reaches here, but
//! this module still refuses, structurally, to carry any line that mentions a
//! token or a credential-shaped env var — see [`redact_diagnostic`]. Nothing in
//! a launch payload is ever a command line, a token, or an env value.

use serde::Serialize;

/// Maximum number of diagnostic lines kept for the failure detail.
pub const MAX_DIAGNOSTIC_LINES: usize = 6;
/// Maximum length of any one diagnostic line before it is truncated.
pub const MAX_DIAGNOSTIC_LINE_LEN: usize = 240;

/// Why the sidecar never became ready.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchFailure {
    /// Something is already listening on the port, so our sidecar cannot bind.
    PortInUse { port: u16 },
    /// The sidecar binary could not be spawned at all.
    SpawnFailed { reason: String },
    /// The sidecar started and then exited without ever reporting readiness.
    SidecarExited { code: Option<i32> },
    /// The sidecar is alive but never reported readiness in time.
    Timeout { seconds: u64 },
}

/// What the launch window is currently showing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchPhase {
    /// Sidecar spawned, waiting for it to listen and print its startup record.
    Starting,
    /// Tokens in hand, the Verse window is being built — the launch window is
    /// about to close.
    Ready,
    /// Terminal: the launch window stays up and explains itself.
    Failed(LaunchFailure),
}

/// An action button the launch window may offer. The launch page emits the
/// matching id back over the `splash-action` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchAction {
    pub id: &'static str,
    pub label: &'static str,
    /// Rendered as the single emphasised button.
    pub primary: bool,
}

const ACTION_RETRY: LaunchAction = LaunchAction {
    id: "retry",
    label: "Try again",
    primary: true,
};
/// Same action, demoted: when adopting an already-running server is the better
/// first move, retrying must not compete for the eye.
const ACTION_RETRY_SECONDARY: LaunchAction = LaunchAction {
    primary: false,
    ..ACTION_RETRY
};
const ACTION_USE_RUNNING: LaunchAction = LaunchAction {
    id: "use-running",
    label: "Use the server that is already running",
    primary: true,
};
const ACTION_QUIT: LaunchAction = LaunchAction {
    id: "quit",
    label: "Quit",
    primary: false,
};

/// The serialisable payload handed to the launch page.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPayload {
    /// `starting` | `ready` | `failed`.
    pub phase: &'static str,
    pub headline: String,
    /// One sentence saying what is happening or what went wrong.
    pub message: String,
    /// What the user can do about it. Empty while starting.
    pub hint: String,
    /// Redacted sidecar diagnostics, newest last. Empty while starting.
    pub detail: Vec<String>,
    pub actions: Vec<LaunchAction>,
}

impl LaunchPhase {
    pub fn payload(&self, diagnostics: &[String]) -> LaunchPayload {
        match self {
            LaunchPhase::Starting => LaunchPayload {
                phase: "starting",
                headline: "Starting Ashlr Verse".to_string(),
                message: "Bringing up the local server on 127.0.0.1:7777.".to_string(),
                hint: String::new(),
                detail: Vec::new(),
                actions: Vec::new(),
            },
            LaunchPhase::Ready => LaunchPayload {
                phase: "ready",
                headline: "Ready".to_string(),
                message: "Opening the console.".to_string(),
                hint: String::new(),
                detail: Vec::new(),
                actions: Vec::new(),
            },
            LaunchPhase::Failed(failure) => {
                let (headline, message, hint, actions) = failure.describe();
                LaunchPayload {
                    phase: "failed",
                    headline: headline.to_string(),
                    message,
                    hint,
                    detail: diagnostics.to_vec(),
                    actions,
                }
            }
        }
    }
}

impl LaunchFailure {
    fn describe(&self) -> (&'static str, String, String, Vec<LaunchAction>) {
        match self {
            LaunchFailure::PortInUse { port } => (
                "Port is already in use",
                format!(
                    "Something is already listening on 127.0.0.1:{port}, so Ashlr could not start its own server there."
                ),
                format!(
                    "If that is your own `ashlr verse` or `ashlr serve`, use it — you will be asked to paste its read token once. Otherwise find the process with `lsof -ti tcp:{port}`, stop it, and try again."
                ),
                vec![ACTION_USE_RUNNING, ACTION_RETRY_SECONDARY, ACTION_QUIT],
            ),
            LaunchFailure::SpawnFailed { reason } => (
                "The Ashlr server could not be launched",
                format!("The bundled `ashlr` sidecar failed to start: {reason}"),
                "This usually means the app bundle is incomplete. Reinstall Ashlr, or rebuild it with `node desktop/scripts/prepare-sidecar.mjs` before `cargo tauri build`.".to_string(),
                vec![ACTION_RETRY, ACTION_QUIT],
            ),
            LaunchFailure::SidecarExited { code } => (
                "The Ashlr server stopped while starting",
                match code {
                    Some(code) => format!("The bundled `ashlr` sidecar exited with code {code} before it was ready."),
                    None => "The bundled `ashlr` sidecar was terminated before it was ready.".to_string(),
                },
                "The lines below are the last output it produced. Running `ashlr verse --no-open` in a terminal shows the same failure with full context.".to_string(),
                vec![ACTION_RETRY, ACTION_QUIT],
            ),
            LaunchFailure::Timeout { seconds } => (
                "The Ashlr server did not come up",
                format!(
                    "The server did not report that it was listening within {seconds} seconds."
                ),
                "It may still be starting on a slow first run. Try again, or run `ashlr verse --no-open` in a terminal to see where it stalls.".to_string(),
                vec![ACTION_RETRY, ACTION_QUIT],
            ),
        }
    }
}

/// True when a diagnostic line may contain a secret and must not be shown.
///
/// Deliberately over-broad: a dropped log line costs nothing, a leaked token is
/// unrecoverable. Any JSON object is dropped outright because the sidecar's
/// startup record is a JSON object.
fn looks_secret(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    if lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("authorization")
        || lower.contains("bearer")
        || lower.contains("credential")
    {
        return true;
    }
    let trimmed = line.trim();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}

/// Normalise one sidecar output line for display, or drop it.
///
/// Returns `None` for blank lines and for anything that could carry a secret.
pub fn redact_diagnostic(line: &str) -> Option<String> {
    let trimmed = line.trim_end_matches(['\r', '\n']).trim();
    if trimmed.is_empty() || looks_secret(trimmed) {
        return None;
    }
    if trimmed.chars().count() > MAX_DIAGNOSTIC_LINE_LEN {
        let cut: String = trimmed.chars().take(MAX_DIAGNOSTIC_LINE_LEN).collect();
        return Some(format!("{cut}…"));
    }
    Some(trimmed.to_string())
}

/// Append a redacted line to a bounded ring of diagnostics.
pub fn push_diagnostic(buffer: &mut Vec<String>, line: &str) {
    let Some(clean) = redact_diagnostic(line) else {
        return;
    };
    buffer.push(clean);
    while buffer.len() > MAX_DIAGNOSTIC_LINES {
        buffer.remove(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starting_payload_offers_no_actions_and_no_detail() {
        let p = LaunchPhase::Starting.payload(&["noise".to_string()]);
        assert_eq!(p.phase, "starting");
        assert!(p.actions.is_empty());
        assert!(p.detail.is_empty(), "diagnostics only surface on failure");
        assert!(p.hint.is_empty());
    }

    #[test]
    fn every_failure_names_a_cause_and_offers_a_way_out() {
        let failures = [
            LaunchFailure::PortInUse { port: 7777 },
            LaunchFailure::SpawnFailed {
                reason: "No such file or directory".to_string(),
            },
            LaunchFailure::SidecarExited { code: Some(1) },
            LaunchFailure::SidecarExited { code: None },
            LaunchFailure::Timeout { seconds: 30 },
        ];
        for failure in failures {
            let p = LaunchPhase::Failed(failure.clone()).payload(&[]);
            assert_eq!(p.phase, "failed");
            assert!(!p.headline.is_empty(), "{failure:?} has no headline");
            assert!(!p.message.is_empty(), "{failure:?} has no message");
            assert!(!p.hint.is_empty(), "{failure:?} gives the user nothing to do");
            assert!(
                p.actions.iter().any(|a| a.id == "quit"),
                "{failure:?} offers no way out"
            );
            assert_eq!(
                p.actions.iter().filter(|a| a.primary).count(),
                1,
                "{failure:?} must have exactly one primary action"
            );
        }
    }

    #[test]
    fn port_in_use_offers_adopting_the_running_server_and_names_the_command() {
        let p = LaunchPhase::Failed(LaunchFailure::PortInUse { port: 7777 }).payload(&[]);
        assert!(p.actions.iter().any(|a| a.id == "use-running"));
        assert!(p.hint.contains("lsof -ti tcp:7777"));
        assert!(p.message.contains("7777"));
    }

    #[test]
    fn exit_code_is_reported_verbatim_rather_than_as_a_spinner() {
        let p = LaunchPhase::Failed(LaunchFailure::SidecarExited { code: Some(9) }).payload(&[]);
        assert!(p.message.contains("code 9"), "got {:?}", p.message);
    }

    #[test]
    fn the_startup_record_can_never_reach_the_launch_window() {
        // The real record, verbatim.
        assert_eq!(
            redact_diagnostic(
                r#"{"url":"http://127.0.0.1:7777","readToken":"aa11","token":"bb22"}"#
            ),
            None
        );
        // Any JSON object or array at all.
        assert_eq!(redact_diagnostic("{\"anything\":1}"), None);
        assert_eq!(redact_diagnostic("[1,2,3]"), None);
        // Prose that merely mentions a token.
        assert_eq!(redact_diagnostic("read token: aa11"), None);
        assert_eq!(redact_diagnostic("X-Ashlr-TOKEN header required"), None);
        assert_eq!(redact_diagnostic("Authorization: Bearer x"), None);
        assert_eq!(redact_diagnostic("ANTHROPIC_API_KEY is unset"), None);
        assert_eq!(redact_diagnostic("   "), None);
    }

    #[test]
    fn ordinary_diagnostics_survive_and_are_truncated() {
        assert_eq!(
            redact_diagnostic("  EADDRINUSE 127.0.0.1:7777\n"),
            Some("EADDRINUSE 127.0.0.1:7777".to_string())
        );
        let long = "x".repeat(MAX_DIAGNOSTIC_LINE_LEN + 50);
        let out = redact_diagnostic(&long).expect("kept");
        assert_eq!(out.chars().count(), MAX_DIAGNOSTIC_LINE_LEN + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn the_diagnostic_ring_keeps_the_newest_lines_only() {
        let mut buf = Vec::new();
        for i in 0..(MAX_DIAGNOSTIC_LINES + 4) {
            push_diagnostic(&mut buf, &format!("line {i}"));
        }
        assert_eq!(buf.len(), MAX_DIAGNOSTIC_LINES);
        assert_eq!(buf.last().unwrap(), &format!("line {}", MAX_DIAGNOSTIC_LINES + 3));
        // Secrets are dropped rather than buffered.
        push_diagnostic(&mut buf, "token=abc");
        assert_eq!(buf.last().unwrap(), &format!("line {}", MAX_DIAGNOSTIC_LINES + 3));
    }

    #[test]
    fn payloads_serialize_to_the_shape_the_launch_page_reads() {
        let json = serde_json::to_value(
            LaunchPhase::Failed(LaunchFailure::Timeout { seconds: 30 }).payload(&["boom".into()]),
        )
        .expect("serialize");
        assert_eq!(json["phase"], "failed");
        assert_eq!(json["detail"][0], "boom");
        assert_eq!(json["actions"][0]["id"], "retry");
        assert_eq!(json["actions"][0]["primary"], true);
    }
}

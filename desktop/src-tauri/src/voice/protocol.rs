//! The dictation wire protocol between the Verse page and native (shell
//! contract item 8, `voice` v1).
//!
//! Page → native: `window.__ASHLR_DESKTOP__.voice.send(msg)` emits the
//! `shell-voice` event (the one `core:event:allow-emit` permission the Verse
//! capability already grants — no new capability, no new command). Any script
//! on the page can emit it, so it is parsed STRICTLY here: a closed set of ops,
//! unknown fields rejected, every string bounded. The worst a hostile emit can
//! do is start or stop dictation, which the pill shows, or open the Privacy
//! pane / start the model download, both visible and harmless.
//!
//! Native → page: `window.__ASHLR_VOICE_EVENT__(<json>)` (defined
//! non-writable by `shell_contract.js`), re-dispatched as the `ashlr:voice`
//! window event. `event` names the channel — `voice://state`,
//! `voice://level`, `voice://partial`, `voice://final`, `voice://error` — and
//! the payload is data, never code (JSON-encoded, see [`event_script`]).

use serde::{Deserialize, Serialize};

/// Event the page emits (`__ASHLR_DESKTOP__.voice.send`).
pub const VOICE_EVENT: &str = "shell-voice";

/// Largest payload native parses; the page caps a message at 8 KB of JSON.
const MAX_PAYLOAD_BYTES: usize = 16 * 1024;
/// Session ids are minted by the page (`v-…`) or native (`hk-…`).
const SESSION_MAX: usize = 64;
const CWD_MAX: usize = 4096;

/// How the final text is post-processed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// Chat / Leader composers: lexicon normalization, identifier biasing.
    Prose,
    /// Terminal: the engine's words exactly (trimmed), no cleanup at all.
    Verbatim,
    /// ⌃⌥⇧V: the words go to the command palette as a query.
    Command,
}

/// A one-click fix the page can ask for from an error state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FixAction {
    /// Show the macOS microphone prompt (status `undetermined`).
    RequestMic,
    /// System Settings ▸ Privacy & Security ▸ Microphone.
    OpenMicSettings,
    /// System Settings ▸ Sound ▸ Input (no input device).
    OpenSoundSettings,
    /// Download (or re-download after a checksum failure) the Parakeet model.
    DownloadModel,
    /// Stop an in-flight model download.
    CancelDownload,
    /// Try `lexicon serve` again now instead of waiting for the next final.
    RetryLexicon,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub enum VoiceRequest {
    /// Push a fresh `voice://state`.
    Status,
    /// Start listening for a surface the page picked (the mic button).
    Start {
        session: String,
        mode: Mode,
        #[serde(default)]
        cwd: Option<String>,
    },
    /// Bind a hotkey-started session to the focused Verse input.
    Context {
        session: String,
        mode: Mode,
        #[serde(default)]
        cwd: Option<String>,
    },
    /// Stop listening and transcribe (final pass).
    Stop {
        session: String,
    },
    /// Stop listening and throw the audio away.
    Cancel {
        session: String,
    },
    Fix {
        action: FixAction,
    },
}

pub fn valid_session(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= SESSION_MAX
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A chat's working folder: absolute, bounded, no NUL. Only ever forwarded to
/// `lexicon serve` as its `cwd` (which applies its own trust gate).
pub fn valid_cwd(cwd: &str) -> bool {
    cwd.starts_with('/') && cwd.len() <= CWD_MAX && !cwd.contains('\0')
}

/// Parse a `shell-voice` payload. `None` for anything malformed.
pub fn parse_request(payload: &str) -> Option<VoiceRequest> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(payload.trim()).ok()?;
    let object = value.as_object()?;
    // serde's `deny_unknown_fields` does not reach unit variants of an
    // internally tagged enum (`{"op":"status","x":1}` would pass), so the
    // allowed keys are checked here, per op, for every variant.
    let allowed: &[&str] = match object.get("op")?.as_str()? {
        "status" => &["op"],
        "start" | "context" => &["op", "session", "mode", "cwd"],
        "stop" | "cancel" => &["op", "session"],
        "fix" => &["op", "action"],
        _ => return None,
    };
    if object.keys().any(|k| !allowed.contains(&k.as_str())) {
        return None;
    }
    let request: VoiceRequest = serde_json::from_value(value).ok()?;
    let ok = match &request {
        VoiceRequest::Start { session, cwd, .. } | VoiceRequest::Context { session, cwd, .. } => {
            valid_session(session) && cwd.as_deref().map_or(true, valid_cwd)
        }
        VoiceRequest::Stop { session } | VoiceRequest::Cancel { session } => valid_session(session),
        VoiceRequest::Status | VoiceRequest::Fix { .. } => true,
    };
    ok.then_some(request)
}

// ── native → page ────────────────────────────────────────────────────────────

/// macOS microphone authorization (`AVAuthorizationStatus`), plus two states
/// the page needs to tell apart from "denied".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MicStatus {
    Granted,
    Denied,
    Restricted,
    Undetermined,
    /// This build's Info.plist has no `NSMicrophoneUsageDescription`: asking
    /// macOS would kill the process, so native never asks.
    NoUsageDescription,
    /// Not macOS.
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelPhase {
    Missing,
    Downloading,
    Verifying,
    Ready,
    Loading,
    Loaded,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineView {
    /// `parakeet` | `whisper` | `none`.
    pub id: &'static str,
    /// Pill copy: "local Parakeet", "local Whisper".
    pub label: &'static str,
    pub model: ModelPhase,
    /// 0..=1 while downloading.
    pub progress: Option<f64>,
    pub total_bytes: u64,
    /// Operator-language reason for `failed`.
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyView {
    pub accelerator: &'static str,
    pub command_accelerator: &'static str,
    pub registered: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    Button,
    Hotkey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Listening,
    Finalizing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub id: String,
    pub origin: Origin,
    pub mode: Mode,
    pub phase: Phase,
    /// Latched (tap) vs held (push-to-talk) — hotkey sessions only.
    pub latched: bool,
}

/// `live` — `lexicon serve` answered; `cached` — it did not, the last term map
/// was applied locally; `none` — neither is available.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LexiconStatus {
    Live,
    Cached,
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    pub version: u32,
    pub mic: MicStatus,
    pub engine: EngineView,
    pub hotkey: HotkeyView,
    pub lexicon: LexiconStatus,
    pub session: Option<SessionView>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    MicDenied,
    MicRestricted,
    MicUndetermined,
    NoUsageDescription,
    NoInputDevice,
    CaptureFailed,
    ModelMissing,
    ModelDownloadFailed,
    ModelLoadFailed,
    EngineFailed,
    NoSpeech,
    Busy,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "event")]
pub enum VoiceEvent {
    #[serde(rename = "voice://state")]
    State { state: StateView },
    #[serde(rename = "voice://level")]
    Level { session: String, level: f32 },
    #[serde(rename = "voice://partial")]
    Partial { session: String, text: String },
    #[serde(rename = "voice://final")]
    Final {
        session: String,
        text: String,
        mode: Mode,
        engine: &'static str,
        lexicon: LexiconStatus,
        /// Release → final text, in ms (what dictation feels like).
        #[serde(rename = "latencyMs")]
        latency_ms: u64,
        #[serde(rename = "audioMs")]
        audio_ms: u64,
    },
    #[serde(rename = "voice://error")]
    Error {
        session: Option<String>,
        code: ErrorCode,
        message: String,
    },
}

/// The script that hands `event` to the page. JSON-encoded, never
/// interpolated: no transcript can break out of the literal.
pub fn event_script(event: &VoiceEvent) -> String {
    let json = serde_json::to_string(event).unwrap_or_else(|_| "null".to_string());
    format!(
        "if (typeof window.__ASHLR_VOICE_EVENT__ === 'function') window.__ASHLR_VOICE_EVENT__({json});"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_op_parses() {
        assert_eq!(
            parse_request(r#"{"op":"status"}"#),
            Some(VoiceRequest::Status)
        );
        assert_eq!(
            parse_request(r#"{"op":"start","session":"v-1","mode":"prose","cwd":"/Users/m/repo"}"#),
            Some(VoiceRequest::Start {
                session: "v-1".into(),
                mode: Mode::Prose,
                cwd: Some("/Users/m/repo".into())
            })
        );
        assert_eq!(
            parse_request(r#"{"op":"start","session":"v_2","mode":"verbatim"}"#),
            Some(VoiceRequest::Start {
                session: "v_2".into(),
                mode: Mode::Verbatim,
                cwd: None
            })
        );
        assert_eq!(
            parse_request(r#"{"op":"context","session":"hk-3","mode":"command","cwd":null}"#),
            Some(VoiceRequest::Context {
                session: "hk-3".into(),
                mode: Mode::Command,
                cwd: None
            })
        );
        assert_eq!(
            parse_request(r#"{"op":"stop","session":"v-1"}"#),
            Some(VoiceRequest::Stop {
                session: "v-1".into()
            })
        );
        assert_eq!(
            parse_request(r#"{"op":"cancel","session":"v-1"}"#),
            Some(VoiceRequest::Cancel {
                session: "v-1".into()
            })
        );
        for (raw, action) in [
            ("request-mic", FixAction::RequestMic),
            ("open-mic-settings", FixAction::OpenMicSettings),
            ("open-sound-settings", FixAction::OpenSoundSettings),
            ("download-model", FixAction::DownloadModel),
            ("cancel-download", FixAction::CancelDownload),
            ("retry-lexicon", FixAction::RetryLexicon),
        ] {
            assert_eq!(
                parse_request(&format!(r#"{{"op":"fix","action":"{raw}"}}"#)),
                Some(VoiceRequest::Fix { action }),
                "{raw}"
            );
        }
    }

    #[test]
    fn anything_else_is_dropped() {
        let long_session = format!(r#"{{"op":"stop","session":"{}"}}"#, "a".repeat(65));
        let long_cwd = format!(
            r#"{{"op":"start","session":"v","mode":"prose","cwd":"/{}"}}"#,
            "a".repeat(4096)
        );
        let huge = format!(r#"{{"op":"status","x":"{}"}}"#, "a".repeat(20_000));
        for bad in [
            "",
            "null",
            "[]",
            r#""status""#,
            r#"{"op":"record"}"#,
            r#"{"op":"status","extra":1}"#,
            r#"{"op":"start","session":"v","mode":"shout"}"#,
            r#"{"op":"start","session":"","mode":"prose"}"#,
            r#"{"op":"start","session":"v 1","mode":"prose"}"#,
            r#"{"op":"start","session":"v","mode":"prose","cwd":"relative/path"}"#,
            r#"{"op":"start","session":"v","mode":"prose","cwd":"/a\u0000b"}"#,
            r#"{"op":"start","session":"v","mode":"prose","script":"alert(1)"}"#,
            r#"{"op":"fix","action":"rm -rf"}"#,
            r#"{"op":"fix","action":"open-url","url":"https://evil"}"#,
            r#"{"op":"stop"}"#,
            &long_session,
            &long_cwd,
            &huge,
        ] {
            assert_eq!(parse_request(bad), None, "{bad}");
        }
    }

    #[test]
    fn events_are_json_encoded_and_cannot_break_out() {
        let script = event_script(&VoiceEvent::Partial {
            session: "v-1".into(),
            text: "x\"});alert(1);//</script>".into(),
        });
        assert!(script.starts_with(
            "if (typeof window.__ASHLR_VOICE_EVENT__ === 'function') window.__ASHLR_VOICE_EVENT__({"
        ));
        assert!(script.ends_with("});"));
        let start = script.find("__ASHLR_VOICE_EVENT__(").unwrap() + "__ASHLR_VOICE_EVENT__(".len();
        let json = &script[start..script.len() - 2];
        let parsed: serde_json::Value = serde_json::from_str(json).expect("the argument is JSON");
        assert_eq!(parsed["event"], "voice://partial");
        assert_eq!(parsed["text"], "x\"});alert(1);//</script>");
    }

    #[test]
    fn event_shapes_match_the_web_contract() {
        let json = |e: &VoiceEvent| serde_json::to_value(e).unwrap();
        let fin = json(&VoiceEvent::Final {
            session: "v".into(),
            text: "Hello".into(),
            mode: Mode::Prose,
            engine: "parakeet",
            lexicon: LexiconStatus::Cached,
            latency_ms: 180,
            audio_ms: 2400,
        });
        assert_eq!(fin["event"], "voice://final");
        assert_eq!(fin["lexicon"], "cached");
        assert_eq!(fin["latencyMs"], 180);
        assert_eq!(fin["audioMs"], 2400);
        let err = json(&VoiceEvent::Error {
            session: None,
            code: ErrorCode::NoUsageDescription,
            message: "m".into(),
        });
        assert_eq!(err["event"], "voice://error");
        assert_eq!(err["code"], "no-usage-description");
        assert!(err["session"].is_null());
        let level = json(&VoiceEvent::Level {
            session: "v".into(),
            level: 0.5,
        });
        assert_eq!(level["event"], "voice://level");
        let state = json(&VoiceEvent::State {
            state: StateView {
                version: 1,
                mic: MicStatus::Undetermined,
                engine: EngineView {
                    id: "parakeet",
                    label: "local Parakeet",
                    model: ModelPhase::Downloading,
                    progress: Some(0.25),
                    total_bytes: 10,
                    error: None,
                },
                hotkey: HotkeyView {
                    accelerator: "⌃⌥V",
                    command_accelerator: "⌃⌥⇧V",
                    registered: true,
                    error: None,
                },
                lexicon: LexiconStatus::Live,
                session: Some(SessionView {
                    id: "hk-1".into(),
                    origin: Origin::Hotkey,
                    mode: Mode::Prose,
                    phase: Phase::Listening,
                    latched: false,
                }),
            },
        });
        assert_eq!(state["event"], "voice://state");
        assert_eq!(state["state"]["mic"], "undetermined");
        assert_eq!(state["state"]["engine"]["model"], "downloading");
        assert_eq!(state["state"]["engine"]["totalBytes"], 10);
        assert_eq!(state["state"]["hotkey"]["commandAccelerator"], "⌃⌥⇧V");
        assert_eq!(state["state"]["session"]["origin"], "hotkey");
        assert_eq!(state["state"]["session"]["phase"], "listening");
    }
}

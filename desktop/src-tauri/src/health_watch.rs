//! Seat health, surfaced natively.
//!
//! The sidecar's account-health sweep (`GET /api/verse/health`, contract in
//! `src/core/verse/health-types.ts`) knows when a seat is signed out, about to
//! expire, or out of usage. Inside the window that shows up as a banner — which
//! nobody sees while Ashlr sits hidden in the tray and autonomous work quietly
//! stalls on a dead seat. The desktop shell polls that route every
//! [`POLL_INTERVAL`] and raises ONE native notification per seat per bad state:
//!
//!   * only `signed-out`, `expiring` and `exhausted` alert (the states with an
//!     operator action or a reset time); `binary-skew` / `unknown` do not,
//!   * a seat alerts again only after it recovered and then degraded, or moved
//!     between two bad states — never every 30 s,
//!   * several seats degrading together make one notification, not a burst.
//!
//! PRIVACY. Nothing the server returns as free text reaches a notification:
//! `reasons` are ignored, the seat id is reduced to `[A-Za-z0-9._-]`, and times
//! are rendered by this module from the timestamps. The read token lives only in
//! the request header — never in an error, a log line, or a notification. The
//! notification itself is delivered through the OS (`osascript` on macOS,
//! `notify-send` on Linux) with the text passed as ARGV, so no quoting bug can
//! turn a seat name into script.
//!
//! The HTTP client is a deliberately tiny HTTP/1.1 GET over `std::net`: one
//! loopback origin, one route, a body cap and hard timeouts. It sends no
//! `Accept-Encoding`, so the server answers identity-encoded, and it decodes
//! `Transfer-Encoding: chunked` because Node uses it whenever a handler streams.

use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::Duration,
};

use serde::Deserialize;

/// How often the shell asks. The spec's floor for any new polling is 2 s; 30 s
/// is plenty for states that change on the scale of minutes to hours.
pub const POLL_INTERVAL: Duration = Duration::from_secs(30);
pub const HEALTH_PATH: &str = "/api/verse/health";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
/// A health report is a few KB; anything past this is not one.
const MAX_RESPONSE_BYTES: usize = 1 << 20;
/// Notification body cap (macOS truncates long bodies anyway).
const MAX_BODY_CHARS: usize = 220;

// ── wire shape (subset of SeatHealthReport) ─────────────────────────────────

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct SeatHealth {
    #[serde(rename = "seatId")]
    pub seat_id: String,
    #[serde(default)]
    pub engine: String,
    pub connection: String,
    #[serde(rename = "credentialExpiresAt", default)]
    pub credential_expires_at: Option<String>,
    #[serde(rename = "resetAt", default)]
    pub reset_at: Option<String>,
}

#[derive(Deserialize)]
struct HealthResponse {
    seats: Vec<SeatHealth>,
}

/// Parse a `VerseHealthResponse` body. `None` for anything that is not one.
pub fn parse_health(body: &str) -> Option<Vec<SeatHealth>> {
    serde_json::from_str::<HealthResponse>(body)
        .ok()
        .map(|r| r.seats)
}

// ── alert state ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AlertKind {
    SignedOut,
    Expiring,
    Exhausted,
}

impl AlertKind {
    pub fn from_connection(connection: &str) -> Option<Self> {
        match connection {
            "signed-out" => Some(Self::SignedOut),
            "expiring" => Some(Self::Expiring),
            "exhausted" => Some(Self::Exhausted),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub kind: AlertKind,
    pub seat: SeatHealth,
}

/// Remembers which bad state each seat was last notified for.
#[derive(Debug, Default)]
pub struct AlertState {
    notified: HashMap<String, AlertKind>,
}

impl AlertState {
    /// Fold one report in; return the alerts that are NEW since the last report.
    pub fn update(&mut self, seats: &[SeatHealth]) -> Vec<Alert> {
        let mut fresh = Vec::new();
        let mut seen: HashMap<String, AlertKind> = HashMap::new();
        for seat in seats {
            let Some(kind) = AlertKind::from_connection(&seat.connection) else {
                continue; // healthy / skewed / unknown: forget any previous alert
            };
            if self.notified.get(&seat.seat_id) != Some(&kind) {
                fresh.push(Alert {
                    kind,
                    seat: seat.clone(),
                });
            }
            seen.insert(seat.seat_id.clone(), kind);
        }
        // Seats that recovered or disappeared drop out, so a later relapse
        // alerts again.
        self.notified = seen;
        fresh
    }
}

// ── notification text ────────────────────────────────────────────────────────

/// A seat id as it may appear in a notification: `[A-Za-z0-9._-]`, ≤ 40 chars.
pub fn safe_label(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(40)
        .collect();
    if cleaned.is_empty() {
        "a seat".to_string()
    } else {
        cleaned
    }
}

fn engine_name(engine: &str) -> Option<&'static str> {
    match engine {
        "claude" => Some("Claude"),
        "codex" => Some("Codex"),
        "grok" => Some("Grok"),
        "local" => Some("Local"),
        _ => None,
    }
}

fn seat_name(seat: &SeatHealth) -> String {
    let id = safe_label(&seat.seat_id);
    match engine_name(&seat.engine) {
        Some(engine) => format!("{engine} ({id})"),
        None => id,
    }
}

/// "3d 4h", "2h 10m", "45m", "under a minute".
pub fn human_duration(ms: i64) -> String {
    if ms < 60_000 {
        return "under a minute".to_string();
    }
    let minutes = ms / 60_000;
    let (days, hours, mins) = (minutes / 1440, (minutes % 1440) / 60, minutes % 60);
    if days > 0 {
        if hours > 0 {
            format!("{days}d {hours}h")
        } else {
            format!("{days}d")
        }
    } else if hours > 0 {
        if mins > 0 {
            format!("{hours}h {mins}m")
        } else {
            format!("{hours}h")
        }
    } else {
        format!("{mins}m")
    }
}

fn relative(iso: Option<&str>, now_ms: i64) -> Option<String> {
    let at = parse_iso8601_ms(iso?)?;
    Some(human_duration(at - now_ms))
}

fn short_line(alert: &Alert, now_ms: i64) -> String {
    let name = seat_name(&alert.seat);
    match alert.kind {
        AlertKind::SignedOut => format!("{name} is signed out"),
        AlertKind::Expiring => {
            match relative(alert.seat.credential_expires_at.as_deref(), now_ms) {
                Some(left) => format!("{name} sign-in expires in {left}"),
                None => format!("{name} sign-in expires soon"),
            }
        }
        AlertKind::Exhausted => match relative(alert.seat.reset_at.as_deref(), now_ms) {
            Some(left) => format!("{name} is out of usage (resets in {left})"),
            None => format!("{name} is out of usage"),
        },
    }
}

/// `(title, body)` for one batch of fresh alerts; `None` when there are none.
pub fn notification_text(alerts: &[Alert], now_ms: i64) -> Option<(String, String)> {
    match alerts {
        [] => None,
        [alert] => {
            let title = format!("Ashlr: {}", short_line(alert, now_ms));
            let body = match alert.kind {
                AlertKind::SignedOut => "Open Ashlr and choose Reconnect to sign in again.",
                AlertKind::Expiring => {
                    "Reconnect before it lapses so running work is not interrupted."
                }
                AlertKind::Exhausted => "Ashlr routes new work to seats that still have headroom.",
            };
            Some((title, body.to_string()))
        }
        many => {
            let title = format!("Ashlr: {} seats need attention", many.len());
            let mut body = many
                .iter()
                .map(|a| short_line(a, now_ms))
                .collect::<Vec<_>>()
                .join(" · ");
            if body.chars().count() > MAX_BODY_CHARS {
                body = body.chars().take(MAX_BODY_CHARS - 1).collect::<String>() + "…";
            }
            Some((title, body))
        }
    }
}

// ── ISO-8601 ─────────────────────────────────────────────────────────────────

/// Epoch millis of an RFC 3339 timestamp (`2026-09-23T21:22:29.123Z`,
/// `…+02:00`). `None` for anything else — an unparseable time is shown as
/// "soon"/omitted, never guessed.
pub fn parse_iso8601_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = s.get(range)?;
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = &s[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digits == 0 {
            return None;
        }
        let padded: String = frac[..digits]
            .chars()
            .chain("000".chars())
            .take(3)
            .collect();
        millis = padded.parse().ok()?;
        rest = &frac[digits..];
    }
    let offset_minutes = match rest {
        "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let tz = &rest[1..];
            if tz.len() != 5 || tz.as_bytes()[2] != b':' {
                return None;
            }
            let h: i64 = tz[0..2].parse().ok()?;
            let m: i64 = tz[3..5].parse().ok()?;
            sign * (h * 60 + m)
        }
    };
    // Days from civil (Howard Hinnant), valid for the proleptic Gregorian calendar.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
    Some(secs * 1000 + millis)
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/// Why a poll produced no report. Deliberately carries no request or body text.
#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    Connect,
    Io,
    TooLarge,
    Malformed,
    Status(u16),
}

/// Split a raw HTTP/1.1 response into `(status, decoded body)`.
pub fn parse_http_response(raw: &[u8]) -> Result<(u16, Vec<u8>), FetchError> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or(FetchError::Malformed)?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| FetchError::Malformed)?;
    let body = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or(FetchError::Malformed)?;
    let mut parts = status_line.split_whitespace();
    if !parts.next().is_some_and(|v| v.starts_with("HTTP/1.")) {
        return Err(FetchError::Malformed);
    }
    let status: u16 = parts
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or(FetchError::Malformed)?;
    let mut chunked = false;
    let mut length: Option<usize> = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        } else if name == "content-length" {
            length = value.parse().ok();
        }
    }
    let decoded = if chunked {
        decode_chunked(body)?
    } else if let Some(len) = length {
        if body.len() < len {
            return Err(FetchError::Malformed);
        }
        body[..len].to_vec()
    } else {
        body.to_vec()
    };
    Ok((status, decoded))
}

fn decode_chunked(mut body: &[u8]) -> Result<Vec<u8>, FetchError> {
    let mut out = Vec::new();
    loop {
        let line_end = body
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or(FetchError::Malformed)?;
        let size_text =
            std::str::from_utf8(&body[..line_end]).map_err(|_| FetchError::Malformed)?;
        let size_hex = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16).map_err(|_| FetchError::Malformed)?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if body.len() < size + 2 {
            return Err(FetchError::Malformed);
        }
        out.extend_from_slice(&body[..size]);
        if out.len() > MAX_RESPONSE_BYTES {
            return Err(FetchError::TooLarge);
        }
        body = &body[size + 2..];
    }
}

/// GET `path` from the loopback server with the read token.
pub fn fetch(addr: SocketAddr, path: &str, read_token: &str) -> Result<Vec<u8>, FetchError> {
    let mut stream =
        TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|_| FetchError::Connect)?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|_| FetchError::Io)?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|_| FetchError::Io)?;
    // Host must match the server's allowlist (anti DNS-rebinding), so it is the
    // literal loopback address and port, exactly as the window uses.
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nX-Ashlr-Token: {read_token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| FetchError::Io)?;
    let mut raw = Vec::new();
    (&mut stream)
        .take(MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| FetchError::Io)?;
    if raw.len() > MAX_RESPONSE_BYTES {
        return Err(FetchError::TooLarge);
    }
    let (status, body) = parse_http_response(&raw)?;
    if status != 200 {
        return Err(FetchError::Status(status));
    }
    Ok(body)
}

/// One poll: fetch + parse.
pub fn poll_once(addr: SocketAddr, read_token: &str) -> Result<Vec<SeatHealth>, FetchError> {
    let body = fetch(addr, HEALTH_PATH, read_token)?;
    let text = std::str::from_utf8(&body).map_err(|_| FetchError::Malformed)?;
    parse_health(text).ok_or(FetchError::Malformed)
}

// ── delivery ─────────────────────────────────────────────────────────────────

/// Show a native notification. Best effort: failure is logged, never raised.
pub fn notify(title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    {
        // Text travels as argv to an AppleScript `on run`, never spliced into
        // the script source — a seat named `"; do shell script "…` is just text.
        let result = std::process::Command::new("/usr/bin/osascript")
            .args([
                "-e",
                "on run argv",
                "-e",
                "display notification (item 2 of argv) with title (item 1 of argv)",
                "-e",
                "end run",
                title,
                body,
            ])
            .output();
        if let Err(e) = result {
            eprintln!("[ashlr-desktop] could not show a notification: {e}");
        }
    }
    #[cfg(target_os = "linux")]
    {
        let result = std::process::Command::new("notify-send")
            .args(["--app-name=Ashlr", "--", title, body])
            .output();
        if result.is_err() {
            eprintln!("[ashlr-desktop] notification (notify-send unavailable): {title} — {body}");
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        eprintln!("[ashlr-desktop] notification: {title} — {body}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn seat(id: &str, engine: &str, connection: &str) -> SeatHealth {
        SeatHealth {
            seat_id: id.to_string(),
            engine: engine.to_string(),
            connection: connection.to_string(),
            credential_expires_at: None,
            reset_at: None,
        }
    }

    const NOW: i64 = 1_790_000_000_000; // 2026-09-21T…Z

    #[test]
    fn parses_the_contract_shape_and_ignores_fields_it_does_not_use() {
        let body = r#"{"checkedAt":"2026-09-23T10:00:00.000Z","seats":[
            {"seatId":"claude-a","engine":"claude","connection":"exhausted","checkedAt":"2026-09-23T10:00:00.000Z",
             "cliVersion":"2.1.280","newestCliVersion":null,"credentialExpiresAt":null,"lastRefreshAt":null,
             "resetAt":"2026-09-23T12:10:00.000Z","reasons":["weekly window spent"],"fix":{"kind":"wait"}},
            {"seatId":"codex","engine":"codex","connection":"signed-out","checkedAt":"x","cliVersion":null,
             "newestCliVersion":null,"credentialExpiresAt":null,"lastRefreshAt":null,"resetAt":null,"reasons":[],
             "fix":{"kind":"reauth","command":["codex","login"]}}]}"#;
        let seats = parse_health(body).expect("report");
        assert_eq!(seats.len(), 2);
        assert_eq!(seats[0].seat_id, "claude-a");
        assert_eq!(seats[0].connection, "exhausted");
        assert_eq!(
            seats[0].reset_at.as_deref(),
            Some("2026-09-23T12:10:00.000Z")
        );
        assert_eq!(seats[1].credential_expires_at, None);
    }

    #[test]
    fn anything_that_is_not_a_report_is_rejected() {
        assert_eq!(parse_health(""), None);
        assert_eq!(parse_health("{}"), None);
        assert_eq!(parse_health(r#"{"seats":{}}"#), None);
        assert_eq!(parse_health(r#"{"code":"API_MODULE_UNAVAILABLE"}"#), None);
        assert_eq!(parse_health("<html>"), None);
    }

    #[test]
    fn only_actionable_states_alert() {
        assert_eq!(
            AlertKind::from_connection("signed-out"),
            Some(AlertKind::SignedOut)
        );
        assert_eq!(
            AlertKind::from_connection("expiring"),
            Some(AlertKind::Expiring)
        );
        assert_eq!(
            AlertKind::from_connection("exhausted"),
            Some(AlertKind::Exhausted)
        );
        for quiet in ["connected", "binary-skew", "unknown", "", "SIGNED-OUT"] {
            assert_eq!(AlertKind::from_connection(quiet), None, "{quiet}");
        }
    }

    #[test]
    fn a_seat_alerts_once_per_bad_state_not_every_poll() {
        let mut state = AlertState::default();
        let bad = vec![
            seat("claude-a", "claude", "exhausted"),
            seat("grok-a", "grok", "connected"),
        ];
        let first = state.update(&bad);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].kind, AlertKind::Exhausted);
        assert!(
            state.update(&bad).is_empty(),
            "the same state must not re-alert"
        );
        assert!(state.update(&bad).is_empty());

        // A move between two bad states is news.
        let worse = vec![seat("claude-a", "claude", "signed-out")];
        assert_eq!(state.update(&worse).len(), 1);

        // Recovery is silent and re-arms the alert.
        assert!(state
            .update(&[seat("claude-a", "claude", "connected")])
            .is_empty());
        assert_eq!(state.update(&worse).len(), 1);
    }

    #[test]
    fn a_seat_that_disappears_is_forgotten() {
        let mut state = AlertState::default();
        assert_eq!(
            state.update(&[seat("codex", "codex", "signed-out")]).len(),
            1
        );
        assert!(state.update(&[]).is_empty());
        assert_eq!(
            state.update(&[seat("codex", "codex", "signed-out")]).len(),
            1
        );
    }

    #[test]
    fn unknown_and_skewed_seats_never_alert() {
        let mut state = AlertState::default();
        assert!(state
            .update(&[
                seat("a", "claude", "unknown"),
                seat("b", "codex", "binary-skew")
            ])
            .is_empty());
    }

    #[test]
    fn single_alert_text_is_built_from_our_own_templates() {
        let mut exhausted = seat("claude-a", "claude", "exhausted");
        exhausted.reset_at = Some("2026-09-21T16:26:40Z".to_string()); // NOW + 2h 13m 20s
        let (title, body) = notification_text(
            &[Alert {
                kind: AlertKind::Exhausted,
                seat: exhausted,
            }],
            NOW,
        )
        .expect("text");
        assert_eq!(
            title,
            "Ashlr: Claude (claude-a) is out of usage (resets in 2h 13m)"
        );
        assert!(body.contains("headroom"));

        let (title, body) = notification_text(
            &[Alert {
                kind: AlertKind::SignedOut,
                seat: seat("codex", "codex", "signed-out"),
            }],
            NOW,
        )
        .expect("text");
        assert_eq!(title, "Ashlr: Codex (codex) is signed out");
        assert!(body.contains("Reconnect"));
    }

    #[test]
    fn expiring_without_a_parseable_time_says_soon_rather_than_guessing() {
        let mut expiring = seat("claude-a", "claude", "expiring");
        expiring.credential_expires_at = Some("tomorrow-ish".to_string());
        let (title, _) = notification_text(
            &[Alert {
                kind: AlertKind::Expiring,
                seat: expiring,
            }],
            NOW,
        )
        .expect("text");
        assert_eq!(title, "Ashlr: Claude (claude-a) sign-in expires soon");
    }

    #[test]
    fn several_alerts_become_one_notification() {
        let alerts: Vec<Alert> = ["a", "b", "c"]
            .iter()
            .map(|id| Alert {
                kind: AlertKind::SignedOut,
                seat: seat(id, "grok", "signed-out"),
            })
            .collect();
        let (title, body) = notification_text(&alerts, NOW).expect("text");
        assert_eq!(title, "Ashlr: 3 seats need attention");
        assert_eq!(
            body,
            "Grok (a) is signed out · Grok (b) is signed out · Grok (c) is signed out"
        );
        assert_eq!(notification_text(&[], NOW), None);
    }

    #[test]
    fn server_supplied_text_cannot_inject_into_a_notification() {
        let evil = seat(
            "\"; do shell script \"rm -rf ~\" --",
            "claude\u{202e}",
            "signed-out",
        );
        let (title, _) = notification_text(
            &[Alert {
                kind: AlertKind::SignedOut,
                seat: evil,
            }],
            NOW,
        )
        .expect("text");
        assert_eq!(title, "Ashlr: doshellscriptrm-rf-- is signed out");
        assert_eq!(safe_label(""), "a seat");
        assert_eq!(safe_label(&"x".repeat(100)).len(), 40);
    }

    #[test]
    fn a_long_batch_body_is_capped() {
        let alerts: Vec<Alert> = (0..40)
            .map(|i| Alert {
                kind: AlertKind::Exhausted,
                seat: seat(&format!("seat-{i}"), "claude", "exhausted"),
            })
            .collect();
        let (_, body) = notification_text(&alerts, NOW).expect("text");
        assert!(body.chars().count() <= MAX_BODY_CHARS);
        assert!(body.ends_with('…'));
    }

    #[test]
    fn durations_read_like_a_person_wrote_them() {
        assert_eq!(human_duration(-5_000), "under a minute");
        assert_eq!(human_duration(59_999), "under a minute");
        assert_eq!(human_duration(45 * 60_000), "45m");
        assert_eq!(human_duration(2 * 3_600_000), "2h");
        assert_eq!(human_duration(2 * 3_600_000 + 10 * 60_000), "2h 10m");
        assert_eq!(
            human_duration(3 * 86_400_000 + 4 * 3_600_000 + 59 * 60_000),
            "3d 4h"
        );
        assert_eq!(human_duration(86_400_000), "1d");
    }

    #[test]
    fn iso_timestamps_parse_to_epoch_millis() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.5Z"), Some(500));
        assert_eq!(parse_iso8601_ms("2026-09-21T14:13:20.000Z"), Some(NOW));
        assert_eq!(parse_iso8601_ms("2026-09-21T16:13:20+02:00"), Some(NOW));
        assert_eq!(parse_iso8601_ms("2026-09-21T09:13:20-05:00"), Some(NOW));
        assert_eq!(
            parse_iso8601_ms("2000-02-29T00:00:00Z"),
            Some(951_782_400_000)
        );
        for bad in [
            "",
            "2026-09-21",
            "2026-13-01T00:00:00Z",
            "2026-09-21T25:00:00Z",
            "2026-09-21T14:13:20",
            "2026-09-21T14:13:20.Z",
            "garbage-in-garbage-out",
        ] {
            assert_eq!(parse_iso8601_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn http_responses_decode_by_length_chunks_or_close() {
        let (status, body) =
            parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}trailing")
                .expect("length");
        assert_eq!((status, body.as_slice()), (200, b"{}".as_slice()));

        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"se\r\n6;ext=1\r\nats\":[\r\n2\r\n]}\r\n0\r\n\r\n";
        let (_, body) = parse_http_response(chunked).expect("chunked");
        assert_eq!(body, b"{\"seats\":[]}");

        let (_, body) =
            parse_http_response(b"HTTP/1.0 200 OK\r\n\r\nabc").expect("close-delimited");
        assert_eq!(body, b"abc");

        let (status, _) =
            parse_http_response(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
                .expect("401");
        assert_eq!(status, 401);
    }

    #[test]
    fn malformed_http_is_an_error_not_a_panic() {
        for raw in [
            b"".as_slice(),
            b"HTTP/1.1 200 OK\r\n",
            b"SSH-2.0-OpenSSH\r\n\r\n",
            b"HTTP/1.1 abc OK\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nshort\r\n",
        ] {
            assert!(
                parse_http_response(raw).is_err(),
                "{:?}",
                String::from_utf8_lossy(raw)
            );
        }
    }

    /// Serve exactly one canned response and hand back the request it received.
    fn one_shot_server(response: &'static [u8]) -> (SocketAddr, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            let mut request = Vec::new();
            loop {
                let n = socket.read(&mut buf).expect("read");
                request.extend_from_slice(&buf[..n]);
                if n == 0 || request.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            socket.write_all(response).expect("write");
            String::from_utf8_lossy(&request).into_owned()
        });
        (addr, handle)
    }

    #[test]
    fn a_real_loopback_poll_sends_the_token_header_and_reads_a_chunked_report() {
        let (addr, server) = one_shot_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n\
              29\r\n{\"seats\":[{\"seatId\":\"c\",\"engine\":\"codex\",\r\n\
              1c\r\n\"connection\":\"signed-out\"}]}\r\n0\r\n\r\n",
        );
        let seats = poll_once(addr, "read-token-value").expect("poll");
        assert_eq!(seats, vec![seat("c", "codex", "signed-out")]);
        let request = server.join().expect("server");
        assert!(
            request.starts_with("GET /api/verse/health HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(request.contains(&format!("Host: {addr}\r\n")));
        assert!(request.contains("X-Ashlr-Token: read-token-value\r\n"));
        assert!(
            !request.to_ascii_lowercase().contains("accept-encoding"),
            "must ask for identity encoding"
        );
    }

    #[test]
    fn a_rejected_token_is_a_status_error_that_carries_no_token() {
        let (addr, server) =
            one_shot_server(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}");
        let err = poll_once(addr, "secret-read-token").expect_err("401");
        assert_eq!(err, FetchError::Status(401));
        assert!(!format!("{err:?}").contains("secret"));
        let _ = server.join();
    }

    /// Live check against a REAL sidecar server (not run by default):
    /// `ASHLR_LIVE_HEALTH_PORT=… ASHLR_LIVE_HEALTH_TOKEN=… cargo test -- --ignored live_`.
    /// Proves the Host header passes the server's allowlist, the read token is
    /// accepted as read authority, and the real response parses.
    #[test]
    #[ignore]
    fn live_poll_against_a_running_server() {
        let port: u16 = std::env::var("ASHLR_LIVE_HEALTH_PORT")
            .expect("ASHLR_LIVE_HEALTH_PORT")
            .parse()
            .expect("port");
        let token = std::env::var("ASHLR_LIVE_HEALTH_TOKEN").expect("ASHLR_LIVE_HEALTH_TOKEN");
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let seats = poll_once(addr, &token).expect("live poll");
        eprintln!(
            "live health: {} seat(s): {:?}",
            seats.len(),
            seats
                .iter()
                .map(|s| (&s.seat_id, &s.connection))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            poll_once(addr, "wrong-token").expect_err("bad token"),
            FetchError::Status(401)
        );
    }

    #[test]
    fn nothing_listening_is_a_connect_error() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        drop(listener);
        assert_eq!(
            poll_once(addr, "t").expect_err("closed"),
            FetchError::Connect
        );
    }
}

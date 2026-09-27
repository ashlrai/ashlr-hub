//! Fleet operations the operator runs from the Fleet tab, with no Terminal
//! (shell contract item 8, protocol v1).
//!
//! Three things used to need Terminal.app: starting / restarting / stopping
//! the resident daemon (`ashlr authority resident start|stop`, which refuses
//! any non-interactive context), and installing or upgrading the custody
//! helper (`sudo scripts/install-custody.sh`). This module does them from a
//! click in the Fleet tab.
//!
//! # Wire
//!
//! The page emits `shell-fleet` (over the event permission it already has — no
//! new command, no new capability) with `{ id, op, checkout? }`:
//!
//! | op                 | effect                                                                 |
//! |--------------------|------------------------------------------------------------------------|
//! | `resident-start`   | native confirm → `ashlr authority resident start` with a gesture token |
//! | `resident-restart` | native confirm → `resident stop`, then `resident start` (gesture)       |
//! | `resident-stop`    | `ashlr authority resident stop` (lowering: no confirm, no gesture)      |
//! | `custody-install`  | native confirm → macOS admin prompt → `install-custody.sh` as root       |
//!
//! Native answers through `window.__ASHLR_FLEET_EVENT__({ id, op, phase, … })`,
//! which `shell_contract.js` defines non-writable. Phases: `confirming`,
//! `running`, then exactly one of `done`, `failed`, `cancelled`.
//!
//! # Why this is the operator and not an agent
//!
//! The CLI's `resident start` refuses agents by environment markers and by
//! requiring a TTY, because a TTY meant "Mason is typing". Here the equivalent
//! proof is a NATIVE modal dialog that only a person can click: page script
//! can ask for the dialog but can never answer it, and a seat's tools (a CLI
//! process, an MCP server) cannot reach this event bus at all — it exists only
//! inside the Verse webview. Only after the click does native mint a one-time
//! gesture token: a random 128-bit name written 0600 under
//! `~/.ashlr/authority/native-gestures/` (a directory every confined fleet
//! agent is denied by its sandbox profile), handed to the CLI in
//! `ASHLR_NATIVE_GESTURE`. The CLI (`authority/resident.ts`
//! `consumeNativeGesture`) accepts it in place of the TTY only when the file
//! is fresh (≤ 120 s), private, owned by this user and names the op, and it
//! deletes the file before trusting it, so a token works once. The agent
//! markers and the login-HOME check still apply: the child gets a scrubbed
//! environment built here, never the app's own.
//!
//! What the gesture does NOT change: the CLI still re-verifies the admission
//! (clean compiled release, active Touch-ID grant, Stop off, switch not Off)
//! and mints its own single-use capability; it writes no grant and raises
//! nothing. The residual risk is the one docs/RESIDENT-RUNTIME.md already
//! accepts: an UNCONFINED process running as Mason could forge the file just
//! as it could run `ashlr daemon start` in the foreground — and gets only the
//! daemon Mason already authorized.
//!
//! The custody install is gated by macOS itself: `osascript … with
//! administrator privileges` shows the system authorization prompt, and the
//! dialog before it shows the exact command, checkout and script digest.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Event the page emits (`__ASHLR_DESKTOP__.fleet.send`).
pub const FLEET_EVENT: &str = "shell-fleet";
/// Largest request the page may send (it is a few short fields).
const MAX_PAYLOAD_BYTES: usize = 4 * 1024;
/// Longest checkout path accepted.
const MAX_PATH_CHARS: usize = 1024;
/// Output returned to the page is the tail of the child's output, this long.
const OUTPUT_TAIL_BYTES: usize = 6 * 1024;
/// `resident start` verifies the grant and the build, then bootstraps launchd.
const RESIDENT_TIMEOUT: Duration = Duration::from_secs(120);
/// `resident status --json` and the login-shell probe.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// `swift test` + `swift build -c release` of the helper can take minutes.
const CUSTODY_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// Directory (under the user's home) the gesture tokens live in. The CLI
/// accepts a token at most `NATIVE_GESTURE_TTL_MS` (120 s) old
/// (src/core/authority/resident.ts); native discards it right after the run.
pub const GESTURE_DIR_RELATIVE: &str = ".ashlr/authority/native-gestures";

/// One operation at a time: a second click while a dialog or a run is open is
/// answered `busy` instead of stacking another dialog.
static BUSY: AtomicBool = AtomicBool::new(false);

// ── wire types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FleetOp {
    ResidentStart,
    ResidentRestart,
    ResidentStop,
    CustodyInstall,
}

impl FleetOp {
    /// The gesture op name the CLI checks (only starts need one).
    fn gesture_name(self) -> Option<&'static str> {
        match self {
            FleetOp::ResidentStart | FleetOp::ResidentRestart => Some("resident-start"),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FleetRequest {
    pub id: String,
    pub op: FleetOp,
    #[serde(default)]
    pub checkout: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Confirming,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Serialize)]
pub struct FleetEvent<'a> {
    pub id: &'a str,
    pub op: FleetOp,
    pub phase: Phase,
    /// One plain sentence for the page (never output, never a secret).
    pub message: String,
    /// The exact command native ran (or would run), for the page to show.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Tail of the child's combined output, capped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

/// Parse a page request strictly. `None` for anything malformed.
pub fn parse_request(payload: &str) -> Option<FleetRequest> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    // Tauri delivers the payload JSON-encoded; a string payload is encoded twice.
    let value: Value = serde_json::from_str(payload).ok()?;
    let value = match value {
        Value::String(inner) => serde_json::from_str::<Value>(&inner).ok()?,
        other => other,
    };
    let req: FleetRequest = serde_json::from_value(value).ok()?;
    if req.id.is_empty()
        || req.id.len() > 64
        || !req
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    match (req.op, &req.checkout) {
        (FleetOp::CustodyInstall, Some(path)) if !path.is_empty() && path.chars().count() <= MAX_PATH_CHARS => {}
        (FleetOp::CustodyInstall, _) => return None,
        (_, None) => {}
        (_, Some(_)) => return None,
    }
    Some(req)
}

/// The script native evaluates in the Verse window to deliver `event`.
pub fn event_script(event: &FleetEvent<'_>) -> String {
    let json = serde_json::to_string(event)
        .unwrap_or_else(|_| "null".to_string())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!("if (typeof window.__ASHLR_FLEET_EVENT__ === 'function') window.__ASHLR_FLEET_EVENT__({json});")
}

fn send(app: &AppHandle, event: FleetEvent<'_>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval(event_script(&event));
    }
}

fn event<'a>(req: &'a FleetRequest, phase: Phase, message: impl Into<String>) -> FleetEvent<'a> {
    FleetEvent {
        id: &req.id,
        op: req.op,
        phase,
        message: message.into(),
        command: None,
        exit_code: None,
        output: None,
    }
}

// ── entry point ──────────────────────────────────────────────────────────────

/// Handle one `shell-fleet` event. Returns at once; the work (dialogs block)
/// runs on its own thread.
pub fn handle_event(app: &AppHandle, payload: &str) {
    let Some(req) = parse_request(payload) else {
        eprintln!("[ashlr-desktop] ignoring a malformed shell-fleet request");
        return;
    };
    if BUSY.swap(true, Ordering::SeqCst) {
        send(app, event(&req, Phase::Failed, "Another fleet operation is already open — finish or cancel it first."));
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        run(&app, &req);
        BUSY.store(false, Ordering::SeqCst);
    });
}

fn run(app: &AppHandle, req: &FleetRequest) {
    if !cfg!(target_os = "macos") {
        send(app, event(req, Phase::Failed, "Fleet operations need macOS (launchd and the Secure Enclave)."));
        return;
    }
    match req.op {
        FleetOp::ResidentStop => resident_stop(app, req),
        FleetOp::ResidentStart | FleetOp::ResidentRestart => resident_start(app, req),
        FleetOp::CustodyInstall => custody_install(app, req),
    }
}

// ── the ashlr CLI the operator would type ─────────────────────────────────────

/// Where the operator's own `ashlr` lives and the PATH that runs it (its
/// `#!/usr/bin/env node` needs node on PATH). Asked of a LOGIN shell, exactly
/// as Terminal would resolve it — never the bundled sidecar, which is a
/// single-file binary the resident admission refuses ("not a compiled
/// release"), and never a path the page supplied.
#[derive(Debug, Clone)]
pub struct Cli {
    pub bin: PathBuf,
    pub path_env: String,
}

pub fn home_dir() -> Option<PathBuf> {
    // The password database, not $HOME: the CLI's own login-HOME check
    // compares against the same source.
    #[cfg(unix)]
    unsafe {
        let pw = libc::getpwuid(libc::geteuid());
        if !pw.is_null() && !(*pw).pw_dir.is_null() {
            let dir = std::ffi::CStr::from_ptr((*pw).pw_dir).to_string_lossy().into_owned();
            if dir.starts_with('/') {
                return Some(PathBuf::from(dir));
            }
        }
    }
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_absolute())
}

fn user_name() -> String {
    #[cfg(unix)]
    unsafe {
        let pw = libc::getpwuid(libc::geteuid());
        if !pw.is_null() && !(*pw).pw_name.is_null() {
            return std::ffi::CStr::from_ptr((*pw).pw_name).to_string_lossy().into_owned();
        }
    }
    std::env::var("USER").unwrap_or_default()
}

fn login_shell() -> String {
    let shell = std::env::var("SHELL").unwrap_or_default();
    if shell.starts_with('/') && Path::new(&shell).is_file() {
        shell
    } else {
        "/bin/zsh".to_string()
    }
}

/// The scrubbed environment every child gets: identity, locale, a temp dir and
/// the PATH given — nothing the app itself was started with (no agent marker,
/// no `ASHLR_*`, no provider credential).
fn base_env(home: &Path, path_env: &str) -> Vec<(String, String)> {
    let mut env = vec![
        ("HOME".to_string(), home.to_string_lossy().into_owned()),
        ("USER".to_string(), user_name()),
        ("LOGNAME".to_string(), user_name()),
        ("SHELL".to_string(), login_shell()),
        ("PATH".to_string(), path_env.to_string()),
        ("LANG".to_string(), "en_US.UTF-8".to_string()),
    ];
    if let Ok(tmp) = std::env::var("TMPDIR") {
        if tmp.starts_with('/') {
            env.push(("TMPDIR".to_string(), tmp));
        }
    }
    env
}

const BIN_MARK: &str = "__ASHLR_FLEET_BIN__";
const PATH_MARK: &str = "__ASHLR_FLEET_PATH__";

/// PURE: pick the marked lines out of a login shell's output (startup files
/// may print anything before them).
pub fn parse_cli_probe(stdout: &str) -> Option<(PathBuf, String)> {
    let mut bin = None;
    let mut path = None;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix(BIN_MARK) {
            bin = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix(PATH_MARK) {
            path = Some(rest.trim().to_string());
        }
    }
    let bin = bin.filter(|b| b.starts_with('/'))?;
    let path = path.filter(|p| !p.is_empty() && p.len() < 8192)?;
    Some((PathBuf::from(bin), path))
}

pub fn resolve_cli(home: &Path) -> Result<Cli, String> {
    let script = format!("printf '\\n{BIN_MARK}%s\\n{PATH_MARK}%s\\n' \"$(command -v ashlr)\" \"$PATH\"");
    let fallback_path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    let out = run_child(
        Command::new(login_shell()).arg("-l").arg("-c").arg(&script),
        &base_env(home, fallback_path),
        PROBE_TIMEOUT,
    );
    if let Ok(result) = &out {
        if let Some((bin, path_env)) = parse_cli_probe(&result.stdout) {
            if bin.is_file() {
                return Ok(Cli { bin, path_env });
            }
        }
    }
    for candidate in ["/opt/homebrew/bin/ashlr", "/usr/local/bin/ashlr"] {
        let bin = PathBuf::from(candidate);
        if bin.is_file() {
            return Ok(Cli { bin, path_env: fallback_path.to_string() });
        }
    }
    Err("The ashlr command-line tool was not found on your login PATH. Install it (npm i -g ashlr-hub) and try again.".to_string())
}

// ── child processes ───────────────────────────────────────────────────────────

pub struct ChildResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

fn run_child(cmd: &mut Command, env: &[(String, String)], timeout: Duration) -> Result<ChildResult, String> {
    cmd.env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("could not start: {e}"))?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_reader = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.take(4 * 1024 * 1024).read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.take(4 * 1024 * 1024).read_to_end(&mut buf);
        }
        buf
    });
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => break None,
        }
    };
    let stdout = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).into_owned();
    Ok(ChildResult { code: status.and_then(|s| s.code()), stdout, stderr, timed_out })
}

/// PURE: the last `max` bytes of `text`, on a char boundary.
pub fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

fn combined(result: &ChildResult) -> String {
    let mut text = result.stdout.trim_end().to_string();
    if !result.stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(result.stderr.trim_end());
    }
    tail(&text, OUTPUT_TAIL_BYTES)
}

// ── the gesture token ─────────────────────────────────────────────────────────

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    let mut file = std::fs::File::open("/dev/urandom").map_err(|e| format!("no randomness: {e}"))?;
    file.read_exact(&mut buf).map_err(|e| format!("no randomness: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// PURE: the gesture file body the CLI parses.
pub fn gesture_body(op: &str, created_ms: u128) -> String {
    format!("{{\"v\":1,\"op\":\"{op}\",\"createdAt\":{created_ms}}}")
}

/// Write a one-time gesture token after the operator clicked the native
/// dialog; returns its name (32 hex) for `ASHLR_NATIVE_GESTURE`.
fn mint_gesture(home: &Path, op: &str) -> Result<String, String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = home.join(GESTURE_DIR_RELATIVE);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|e| format!("could not prepare the gesture directory: {e}"))?;
    let name = random_hex(16)?;
    let created_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join(format!("{name}.json")))
        .map_err(|e| format!("could not write the gesture token: {e}"))?;
    file.write_all(gesture_body(op, created_ms).as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("could not write the gesture token: {e}"))?;
    Ok(name)
}

/// Remove a gesture the CLI did not consume (it refused before reading it).
fn discard_gesture(home: &Path, name: &str) {
    let _ = std::fs::remove_file(home.join(GESTURE_DIR_RELATIVE).join(format!("{name}.json")));
}

// ── resident daemon ───────────────────────────────────────────────────────────

/// What `ashlr authority resident status --json` says, as far as the dialog needs.
#[derive(Debug, Default, Clone)]
pub struct ResidentPlan {
    pub admitted: bool,
    pub reason: String,
    pub grant_seq: Option<i64>,
    pub expires_at: Option<String>,
    pub revision: Option<String>,
    pub service_state: String,
    pub plist: String,
    pub plist_path: Option<String>,
    pub budget_usd: Option<f64>,
}

/// PURE: read the status JSON (`ashlr.resident-status.v1`).
pub fn parse_resident_status(stdout: &str) -> Option<ResidentPlan> {
    let start = stdout.find('{')?;
    let value: Value = serde_json::from_str(stdout[start..].trim()).ok()?;
    if value.get("schema")?.as_str()? != "ashlr.resident-status.v1" {
        return None;
    }
    let admission = value.get("admission")?;
    let service = value.get("service")?;
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Some(ResidentPlan {
        admitted: admission.get("ok").and_then(Value::as_bool).unwrap_or(false),
        reason: s(admission, "reason").unwrap_or_default(),
        grant_seq: admission.get("grantSeq").and_then(Value::as_i64),
        expires_at: s(admission, "expiresAt"),
        revision: s(admission, "revision"),
        service_state: s(service, "state").unwrap_or_else(|| "unknown".to_string()),
        plist: s(service, "plist").unwrap_or_else(|| "unknown".to_string()),
        plist_path: s(service, "plistPath"),
        budget_usd: service.get("expectedBudgetUsd").and_then(Value::as_f64),
    })
}

/// PURE: the confirm dialog's text.
pub fn resident_dialog_text(op: FleetOp, cli: &Path, plan: &ResidentPlan) -> (String, String) {
    let title = if op == FleetOp::ResidentRestart { "Restart the fleet daemon?" } else { "Start the fleet daemon?" };
    let rev = plan.revision.as_deref().map(|r| &r[..r.len().min(12)]).unwrap_or("?");
    let budget = plan.budget_usd.map(|b| format!("${b}/day")).unwrap_or_else(|| "?".to_string());
    let action = if op == FleetOp::ResidentRestart {
        "ashlr authority resident stop, then ashlr authority resident start"
    } else {
        "ashlr authority resident start"
    };
    let body = format!(
        "The resident daemon (ai.ashlr.daemon) runs the fleet under your standing grant.\n\n\
         Grant #{} · expires {}\nRelease {}\nService {} ({}, plist {})\nBudget {} (config daemon.dailyBudgetUsd)\n\n\
         Runs: {}\n({})\n\nlaunchd: enable + bootstrap gui/{}/ai.ashlr.daemon. Every tick re-verifies the grant, Stop and the switch; Stop in the Fleet tab halts it at once.",
        plan.grant_seq.map(|n| n.to_string()).unwrap_or_else(|| "?".to_string()),
        plan.expires_at.as_deref().unwrap_or("?"),
        rev,
        plan.plist_path.as_deref().unwrap_or("~/Library/LaunchAgents/ai.ashlr.daemon.plist"),
        plan.service_state,
        plan.plist,
        budget,
        action,
        cli.display(),
        unsafe { libc::geteuid() },
    );
    (title.to_string(), body)
}

fn resident_command(cli: &Cli, sub: &str) -> String {
    format!("{} authority resident {sub}", cli.bin.display())
}

fn resident_stop(app: &AppHandle, req: &FleetRequest) {
    let Some(home) = home_dir() else {
        send(app, event(req, Phase::Failed, "Your home folder could not be read."));
        return;
    };
    let cli = match resolve_cli(&home) {
        Ok(cli) => cli,
        Err(message) => return send(app, event(req, Phase::Failed, message)),
    };
    let mut running = event(req, Phase::Running, "Stopping the fleet daemon…");
    running.command = Some(resident_command(&cli, "stop"));
    send(app, running);
    finish(app, req, &cli, "stop", None, &home, RESIDENT_TIMEOUT, "The fleet daemon is stopped and its service removed. Stop and the grant are unchanged.");
}

fn resident_start(app: &AppHandle, req: &FleetRequest) {
    let Some(home) = home_dir() else {
        send(app, event(req, Phase::Failed, "Your home folder could not be read."));
        return;
    };
    send(app, event(req, Phase::Confirming, "Checking the grant and the release…"));
    let cli = match resolve_cli(&home) {
        Ok(cli) => cli,
        Err(message) => return send(app, event(req, Phase::Failed, message)),
    };
    let status = run_child(
        Command::new(&cli.bin).args(["authority", "resident", "status", "--json"]),
        &base_env(&home, &cli.path_env),
        PROBE_TIMEOUT,
    );
    let plan = match status.as_ref().ok().and_then(|r| parse_resident_status(&r.stdout)) {
        Some(plan) => plan,
        None => {
            let mut failed = event(req, Phase::Failed, "The resident status could not be read from the ashlr CLI.");
            failed.command = Some(resident_command(&cli, "status --json"));
            failed.output = status.ok().map(|r| combined(&r));
            return send(app, failed);
        }
    };
    if !plan.admitted {
        let mut failed = event(req, Phase::Failed, format!("Not admitted: {}", plan.reason));
        failed.command = Some(resident_command(&cli, "status"));
        return send(app, failed);
    }
    let (title, body) = resident_dialog_text(req.op, &cli.bin, &plan);
    let confirmed = app
        .dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            if req.op == FleetOp::ResidentRestart { "Restart" } else { "Start" }.to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();
    if !confirmed {
        return send(app, event(req, Phase::Cancelled, "Nothing was changed."));
    }
    if req.op == FleetOp::ResidentRestart {
        let mut running = event(req, Phase::Running, "Stopping the fleet daemon before the restart…");
        running.command = Some(resident_command(&cli, "stop"));
        send(app, running);
        match run_child(
            Command::new(&cli.bin).args(["authority", "resident", "stop"]),
            &base_env(&home, &cli.path_env),
            RESIDENT_TIMEOUT,
        ) {
            Ok(r) if r.code == Some(0) => {}
            Ok(r) => {
                let mut failed = event(req, Phase::Failed, "The daemon could not be stopped, so it was not restarted.");
                failed.exit_code = r.code;
                failed.output = Some(combined(&r));
                return send(app, failed);
            }
            Err(e) => return send(app, event(req, Phase::Failed, e)),
        }
    }
    // Minted only now — after the click — and only for this op.
    let gesture = match mint_gesture(&home, req.op.gesture_name().unwrap_or("resident-start")) {
        Ok(g) => g,
        Err(e) => return send(app, event(req, Phase::Failed, e)),
    };
    let mut running = event(req, Phase::Running, "Starting the fleet daemon…");
    running.command = Some(resident_command(&cli, "start"));
    send(app, running);
    finish(
        app,
        req,
        &cli,
        "start",
        Some(&gesture),
        &home,
        RESIDENT_TIMEOUT,
        "The fleet daemon is running under your grant.",
    );
    discard_gesture(&home, &gesture);
}

#[allow(clippy::too_many_arguments)]
fn finish(
    app: &AppHandle,
    req: &FleetRequest,
    cli: &Cli,
    sub: &str,
    gesture: Option<&str>,
    home: &Path,
    timeout: Duration,
    ok_message: &str,
) {
    let mut env = base_env(home, &cli.path_env);
    if let Some(g) = gesture {
        env.push(("ASHLR_NATIVE_GESTURE".to_string(), g.to_string()));
    }
    let result = run_child(Command::new(&cli.bin).args(["authority", "resident", sub]), &env, timeout);
    let mut done = match &result {
        Ok(r) if r.code == Some(0) => event(req, Phase::Done, ok_message),
        Ok(r) if r.timed_out => event(req, Phase::Failed, "The ashlr CLI did not finish in time."),
        Ok(_) => event(req, Phase::Failed, format!("ashlr authority resident {sub} did not succeed — see its output.")),
        Err(e) => event(req, Phase::Failed, e.clone()),
    };
    done.command = Some(resident_command(cli, sub));
    if let Ok(r) = &result {
        done.exit_code = r.code;
        done.output = Some(combined(r));
    }
    send(app, done);
}

// ── custody helper ────────────────────────────────────────────────────────────

/// A checked ashlr-hub checkout the install script can run from.
#[derive(Debug)]
pub struct Checkout {
    pub root: PathBuf,
    pub script: PathBuf,
    pub script_sha256: String,
}

/// Is `root` an ashlr-hub checkout? The page names it (the server found it
/// among the enrolled repos); native re-checks everything before showing it.
pub fn validate_checkout(raw: &str) -> Result<Checkout, String> {
    // The server's public JSON spells this user's home as `~` (it never ships
    // the home path); expand it against the password database.
    let expanded: PathBuf = match raw.strip_prefix("~/") {
        Some(rest) => match home_dir() {
            Some(home) => home.join(rest),
            None => return Err("Your home folder could not be read.".to_string()),
        },
        None => PathBuf::from(raw),
    };
    let path = expanded.as_path();
    if !path.is_absolute() {
        return Err("The checkout path must be absolute.".to_string());
    }
    let root = std::fs::canonicalize(path).map_err(|_| "That checkout does not exist.".to_string())?;
    let script = root.join("scripts/install-custody.sh");
    let meta = std::fs::symlink_metadata(&script).map_err(|_| "scripts/install-custody.sh is missing from that checkout.".to_string())?;
    if !meta.file_type().is_file() {
        return Err("scripts/install-custody.sh is not a regular file.".to_string());
    }
    if !root.join("tools/custody/Package.swift").is_file() {
        return Err("tools/custody is missing from that checkout.".to_string());
    }
    if !is_hub_checkout(&root) {
        return Err("That folder is not an ashlrai/ashlr-hub checkout.".to_string());
    }
    let bytes = std::fs::read(&script).map_err(|_| "scripts/install-custody.sh could not be read.".to_string())?;
    let digest = Sha256::digest(&bytes);
    let script_sha256 = digest.iter().map(|b| format!("{b:02x}")).collect();
    Ok(Checkout { root, script, script_sha256 })
}

/// PURE (given the text): does a git config name the ashlr-hub remote?
pub fn config_names_hub(config: &str) -> bool {
    config.lines().any(|line| {
        let line = line.trim();
        line.starts_with("url") && (line.contains("ashlrai/ashlr-hub.git") || line.trim_end().ends_with("ashlrai/ashlr-hub"))
    })
}

fn is_hub_checkout(root: &Path) -> bool {
    let git = root.join(".git");
    let config = if git.is_dir() {
        git.join("config")
    } else if let Ok(text) = std::fs::read_to_string(&git) {
        // A worktree: `.git` is a file `gitdir: <main>/.git/worktrees/<name>`.
        let Some(dir) = text.trim().strip_prefix("gitdir:") else { return false };
        let dir = PathBuf::from(dir.trim());
        match dir.parent().and_then(Path::parent) {
            Some(common) => common.join("config"),
            None => return false,
        }
    } else {
        return false;
    };
    std::fs::read_to_string(config).map(|t| config_names_hub(&t)).unwrap_or(false)
}

/// PURE: the AppleScript that asks macOS for an administrator and runs the
/// install. Every value arrives as argv and goes through `quoted form of`, so
/// no path can become script.
pub const CUSTODY_OSASCRIPT: [&str; 3] = [
    "on run argv",
    "do shell script \"/usr/bin/env SUDO_USER=\" & quoted form of (item 1 of argv) & \" /bin/bash \" & quoted form of (item 2 of argv) & \" 2>&1\" with prompt (item 3 of argv) with administrator privileges",
    "end run",
];

pub fn custody_command_line(checkout: &Checkout, user: &str) -> String {
    format!("sudo SUDO_USER={user} /bin/bash {}", checkout.script.display())
}

fn custody_install(app: &AppHandle, req: &FleetRequest) {
    let Some(home) = home_dir() else {
        send(app, event(req, Phase::Failed, "Your home folder could not be read."));
        return;
    };
    let checkout = match validate_checkout(req.checkout.as_deref().unwrap_or("")) {
        Ok(c) => c,
        Err(message) => return send(app, event(req, Phase::Failed, message)),
    };
    let user = user_name();
    if user.is_empty() || user == "root" {
        return send(app, event(req, Phase::Failed, "Run the app from your own account, not root."));
    }
    let command_line = custody_command_line(&checkout, &user);
    let mut confirming = event(req, Phase::Confirming, "Waiting for you to confirm the install…");
    confirming.command = Some(command_line.clone());
    send(app, confirming);
    let body = format!(
        "This builds and installs the custody helper that holds your Secure Enclave signing key.\n\n\
         Runs as root (macOS asks for your admin password next):\n{command_line}\n\n\
         Checkout {}\ninstall-custody.sh sha256 {}\n\n\
         It runs swift test + swift build as {user} (never as root), codesigns the binary, and installs it root:wheel 0755 at /usr/local/libexec/ashlr-custody. It creates no key, grant or Keychain item.",
        checkout.root.display(),
        &checkout.script_sha256[..16],
    );
    let confirmed = app
        .dialog()
        .message(body)
        .title("Install the custody helper?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Continue".to_string(), "Cancel".to_string()))
        .blocking_show();
    if !confirmed {
        return send(app, event(req, Phase::Cancelled, "Nothing was changed."));
    }
    let mut running = event(req, Phase::Running, "Building and installing the custody helper (this takes a few minutes)…");
    running.command = Some(command_line.clone());
    send(app, running);
    let mut cmd = Command::new("/usr/bin/osascript");
    for line in CUSTODY_OSASCRIPT {
        cmd.arg("-e").arg(line);
    }
    cmd.arg(&user)
        .arg(checkout.script.as_os_str())
        .arg("Ashlr wants to install the custody helper at /usr/local/libexec/ashlr-custody.");
    let result = run_child(&mut cmd, &base_env(&home, "/usr/bin:/bin:/usr/sbin:/sbin"), CUSTODY_TIMEOUT);
    let mut done = match &result {
        Ok(r) if r.code == Some(0) => event(req, Phase::Done, "The custody helper is installed."),
        // osascript's "User canceled." is error -128.
        Ok(r) if r.stderr.contains("-128") => event(req, Phase::Cancelled, "The administrator prompt was cancelled; nothing was installed."),
        Ok(r) if r.timed_out => event(req, Phase::Failed, "The install did not finish in time."),
        Ok(_) => event(req, Phase::Failed, "The install did not succeed — see its output."),
        Err(e) => event(req, Phase::Failed, e.clone()),
    };
    done.command = Some(command_line);
    if let Ok(r) = &result {
        done.exit_code = r.code;
        done.output = Some(combined(r));
    }
    send(app, done);
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_known_ops_and_fields() {
        assert!(parse_request(r#"{"id":"a1","op":"resident-start"}"#).is_some());
        assert!(parse_request(r#""{\"id\":\"a1\",\"op\":\"resident-stop\"}""#).is_some());
        assert!(parse_request(r#"{"id":"a1","op":"rm-rf"}"#).is_none());
        assert!(parse_request(r#"{"id":"a1","op":"resident-start","extra":1}"#).is_none());
        assert!(parse_request(r#"{"id":"a b","op":"resident-start"}"#).is_none());
        // A checkout only with custody-install, and custody-install only with one.
        assert!(parse_request(r#"{"id":"a1","op":"resident-start","checkout":"/x"}"#).is_none());
        assert!(parse_request(r#"{"id":"a1","op":"custody-install"}"#).is_none());
        assert!(parse_request(r#"{"id":"a1","op":"custody-install","checkout":"/x"}"#).is_some());
    }

    #[test]
    fn event_script_is_data_not_code() {
        let req = parse_request(r#"{"id":"a1","op":"resident-stop"}"#).unwrap();
        let mut ev = event(&req, Phase::Failed, "a\u{2028}b</script>'); alert(1); //");
        ev.output = Some("x".to_string());
        let script = event_script(&ev);
        assert!(script.starts_with("if (typeof window.__ASHLR_FLEET_EVENT__ === 'function')"));
        assert!(!script.contains('\u{2028}'));
        assert!(script.contains("\"phase\":\"failed\""));
    }

    #[test]
    fn cli_probe_ignores_profile_noise() {
        let out = "welcome!\n\n__ASHLR_FLEET_BIN__/opt/homebrew/bin/ashlr\n__ASHLR_FLEET_PATH__/opt/homebrew/bin:/usr/bin\n";
        let (bin, path) = parse_cli_probe(out).unwrap();
        assert_eq!(bin, PathBuf::from("/opt/homebrew/bin/ashlr"));
        assert_eq!(path, "/opt/homebrew/bin:/usr/bin");
        assert!(parse_cli_probe("__ASHLR_FLEET_BIN__\n__ASHLR_FLEET_PATH__/usr/bin\n").is_none());
        assert!(parse_cli_probe("__ASHLR_FLEET_BIN__ashlr\n__ASHLR_FLEET_PATH__/usr/bin\n").is_none());
    }

    #[test]
    fn resident_status_parses_the_cli_schema() {
        let json = r#"{"schema":"ashlr.resident-status.v1","admission":{"ok":true,"reason":"ok","grantSeq":2,"expiresAt":"2026-10-26T00:00:00.000Z","revision":"abcdef0123456789"},"service":{"state":"not-loaded","plist":"absent","plistPath":"/Users/m/Library/LaunchAgents/ai.ashlr.daemon.plist","expectedBudgetUsd":25}}"#;
        let plan = parse_resident_status(&format!("noise\n{json}")).unwrap();
        assert!(plan.admitted);
        assert_eq!(plan.grant_seq, Some(2));
        assert_eq!(plan.budget_usd, Some(25.0));
        let (title, body) = resident_dialog_text(FleetOp::ResidentStart, Path::new("/opt/homebrew/bin/ashlr"), &plan);
        assert_eq!(title, "Start the fleet daemon?");
        assert!(body.contains("Grant #2"));
        assert!(body.contains("abcdef012345"));
        assert!(body.contains("$25/day"));
        assert!(parse_resident_status(r#"{"schema":"other"}"#).is_none());
    }

    #[test]
    fn gesture_body_matches_the_cli_parser() {
        assert_eq!(gesture_body("resident-start", 5), r#"{"v":1,"op":"resident-start","createdAt":5}"#);
    }

    #[test]
    fn hub_remote_detection() {
        assert!(config_names_hub("[remote \"origin\"]\n\turl = git@github.com:ashlrai/ashlr-hub.git\n"));
        assert!(config_names_hub("[remote \"origin\"]\n\turl = https://github.com/ashlrai/ashlr-hub\n"));
        assert!(!config_names_hub("[remote \"origin\"]\n\turl = https://github.com/evil/ashlr-hub-fork\n"));
    }

    #[test]
    fn osascript_never_interpolates_values() {
        for line in CUSTODY_OSASCRIPT {
            assert!(!line.contains("/Users/"));
        }
        assert!(CUSTODY_OSASCRIPT[1].contains("quoted form of (item 2 of argv)"));
    }

    #[test]
    fn tail_keeps_the_end_on_a_char_boundary() {
        assert_eq!(tail("abc", 10), "abc");
        let t = tail("ééééé", 3);
        assert!(t.starts_with('…'));
    }
}

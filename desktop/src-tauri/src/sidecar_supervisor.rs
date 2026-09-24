//! Keeping the sidecar alive, and cleaning up after sidecars nobody owns.
//!
//! Two jobs, both deliberately free of Tauri types so every decision here is
//! unit-testable:
//!
//! 1. **Restart with backoff.** `ashlr verse` can die while the window is open
//!    (an unhandled rejection, an OOM kill, a native crash in a worker). Before
//!    this module the window then sat on a dead origin until the operator quit
//!    and relaunched. [`RestartPolicy`] decides, per unexpected exit, whether to
//!    restart and after how long: exponential from 1 s to a 30 s cap, the streak
//!    forgiven once a sidecar has stayed up for a minute, and a hard stop after
//!    too many exits inside ten minutes — a sidecar that crashes on boot every
//!    time must not become a CPU-burning restart loop.
//!
//! 2. **Orphan sweep.** [`sidecar_guard::reclaim_orphan`] repairs the one
//!    sidecar the ownership record names. The record is a single slot, though:
//!    a Serve fallback, a retry, or two crashes in a row overwrite it, and every
//!    sidecar it forgot keeps running — reparented to launchd, holding memory
//!    and, if it still has 7777, the port. [`plan_sweep`] finds those by what a
//!    process IS rather than by what a file says:
//!
//!      * its parent is pid 1 (its desktop app is gone — a sidecar whose app is
//!        alive has that app as its parent, so another running copy of Ashlr can
//!        never lose its server to this),
//!      * its argv is EXACTLY this bundle's sidecar binary followed by one of the
//!        argument lists this app spawns — not a prefix, not a substring, so
//!        `ashlr-evil verse …` or a user's own `ashlr verse --port 7777` from a
//!        terminal (a different binary path) is never a match.
//!
//!    Pid recycling is closed off by START TIME: the sweep snapshots each
//!    candidate's start time and argv, and [`still_same_process`] re-reads both
//!    immediately before the kill. A pid that exited and was reused in between
//!    has a different start time and is left alone.
//!
//! Servers that look like Ashlr but are not ours (the npm CLI's `ashlr serve`,
//! a `node dist/cli/index.js verse` dev server) are REPORTED, never killed:
//! the operator started those and decides their fate.

use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

// ── restart policy ───────────────────────────────────────────────────────────

/// First restart delay.
pub const RESTART_BASE: Duration = Duration::from_secs(1);
/// Longest delay between restarts.
pub const RESTART_MAX: Duration = Duration::from_secs(30);
/// A sidecar that stayed up this long was healthy: its exit starts a new streak.
pub const RESTART_STABLE_AFTER: Duration = Duration::from_secs(60);
/// Window over which exits are counted toward giving up.
pub const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);
/// More unexpected exits than this inside [`RESTART_WINDOW`] and we stop.
pub const RESTART_MAX_IN_WINDOW: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestartDecision {
    /// Restart after `delay`. `streak` is 1 for the first restart of a streak.
    Restart { delay: Duration, streak: u32 },
    /// Too many exits in [`RESTART_WINDOW`]; leave it stopped and tell the operator.
    GiveUp { exits_in_window: usize },
}

/// Exponential backoff with a crash budget. See the module docs.
#[derive(Debug)]
pub struct RestartPolicy {
    streak: u32,
    exits: VecDeque<Instant>,
    gave_up: bool,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl RestartPolicy {
    pub fn new() -> Self {
        Self {
            streak: 0,
            exits: VecDeque::new(),
            gave_up: false,
        }
    }

    /// The sidecar exited unexpectedly at `now` after running for `uptime`.
    pub fn on_unexpected_exit(&mut self, now: Instant, uptime: Duration) -> RestartDecision {
        if uptime >= RESTART_STABLE_AFTER {
            self.streak = 0;
        }
        while let Some(front) = self.exits.front() {
            if now.saturating_duration_since(*front) > RESTART_WINDOW {
                self.exits.pop_front();
            } else {
                break;
            }
        }
        self.exits.push_back(now);
        if self.gave_up || self.exits.len() > RESTART_MAX_IN_WINDOW {
            // Sticky: once we have given up, a later exit (there should be
            // none — nothing is running) must not quietly resume the loop.
            self.gave_up = true;
            return RestartDecision::GiveUp {
                exits_in_window: self.exits.len(),
            };
        }
        self.streak = self.streak.saturating_add(1);
        RestartDecision::Restart {
            delay: backoff_delay(self.streak),
            streak: self.streak,
        }
    }

    /// The operator asked for a fresh start ("Try again"): forget the history.
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    #[cfg(test)]
    pub fn has_given_up(&self) -> bool {
        self.gave_up
    }
}

/// 1 s, 2 s, 4 s, … capped at [`RESTART_MAX`]. `streak` is 1-based.
pub fn backoff_delay(streak: u32) -> Duration {
    let exponent = streak.saturating_sub(1).min(16);
    let millis = (RESTART_BASE.as_millis() as u64).saturating_mul(1u64 << exponent);
    Duration::from_millis(millis).min(RESTART_MAX)
}

// ── process table ────────────────────────────────────────────────────────────

/// One row of `ps -axww -o pid=,ppid=,lstart=,args=`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: i32,
    pub ppid: i32,
    /// `lstart` exactly as `ps` printed it (whitespace-normalised), e.g.
    /// `Wed Sep 9 20:44:42 2026`. Compared as an opaque identity token, never
    /// parsed — equality is all the recycling check needs.
    pub started: String,
    pub args: String,
}

/// Parse one `pid ppid lstart(5 tokens) args…` line.
///
/// `lstart` is always five whitespace-separated fields on macOS and procps
/// (`Wed Sep  9 20:44:42 2026` — the day is space-padded, which is why this
/// splits on runs of whitespace instead of fixed columns).
pub fn parse_ps_line(line: &str) -> Option<ProcInfo> {
    fn take(rest: &mut &str) -> Option<String> {
        let trimmed = rest.trim_start();
        if trimmed.is_empty() {
            return None;
        }
        let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
        let token = trimmed[..end].to_string();
        *rest = &trimmed[end..];
        Some(token)
    }
    let mut rest = line.trim_start();
    let pid: i32 = take(&mut rest)?.parse().ok()?;
    let ppid: i32 = take(&mut rest)?.parse().ok()?;
    let mut started = Vec::with_capacity(5);
    for _ in 0..5 {
        started.push(take(&mut rest)?);
    }
    let args = rest.trim().to_string();
    if args.is_empty() {
        return None;
    }
    Some(ProcInfo {
        pid,
        ppid,
        started: started.join(" "),
        args,
    })
}

/// Is `proc_` a sidecar of THIS app bundle whose app is gone?
///
/// `arg_sets` are the exact argument lists this app spawns the sidecar with.
pub fn is_orphaned_sidecar(
    proc_: &ProcInfo,
    sidecar_bin: &str,
    own_pid: i32,
    arg_sets: &[&[&str]],
) -> bool {
    if proc_.pid <= 1 || proc_.pid == own_pid || proc_.ppid != 1 || sidecar_bin.is_empty() {
        return false;
    }
    arg_sets
        .iter()
        .any(|args| proc_.args == format!("{sidecar_bin} {}", args.join(" ")))
}

/// Does this row look like an Ashlr web server (`verse` / `serve` subcommand of
/// an `ashlr` binary or the CLI's `index.js`)? Used ONLY to report foreign
/// servers, never to decide a kill.
pub fn looks_like_ashlr_server(proc_: &ProcInfo) -> bool {
    let tokens: Vec<&str> = proc_.args.split_whitespace().collect();
    tokens.windows(2).any(|pair| {
        let program = pair[0].rsplit('/').next().unwrap_or(pair[0]);
        let is_ashlr =
            program == "ashlr" || program == "ashlr.exe" || pair[0].ends_with("cli/index.js");
        is_ashlr && (pair[1] == "verse" || pair[1] == "serve")
    })
}

/// The `--port N` of a server row, when present. Reported instead of argv so a
/// log line never carries a user's paths.
pub fn port_of(proc_: &ProcInfo) -> Option<u16> {
    let tokens: Vec<&str> = proc_.args.split_whitespace().collect();
    tokens
        .windows(2)
        .find(|pair| pair[0] == "--port")
        .and_then(|pair| pair[1].parse().ok())
}

/// What a sweep would do with a process table.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepPlan {
    /// Our orphans — to be re-verified by start time, then terminated.
    pub reap: Vec<ProcInfo>,
    /// Ashlr-looking servers that are NOT ours — reported only.
    pub foreign: Vec<ProcInfo>,
}

/// Split a process table into our orphans and foreign Ashlr servers.
pub fn plan_sweep(
    table: &[ProcInfo],
    sidecar_bin: &str,
    own_pid: i32,
    arg_sets: &[&[&str]],
) -> SweepPlan {
    let mut plan = SweepPlan::default();
    for row in table {
        if is_orphaned_sidecar(row, sidecar_bin, own_pid, arg_sets) {
            plan.reap.push(row.clone());
        } else if row.pid != own_pid && looks_like_ashlr_server(row) {
            // Includes our own LIVE sidecars (their parent is alive). Those are
            // filtered by the caller, which knows its own child's pid.
            plan.foreign.push(row.clone());
        }
    }
    plan
}

/// The whole process table, or empty when it cannot be read (then nothing is
/// reaped — an unreadable table is never a reason to kill).
#[cfg(unix)]
pub fn read_process_table() -> Vec<ProcInfo> {
    let Ok(out) = std::process::Command::new("/bin/ps")
        .args(["-axww", "-o", "pid=,ppid=,lstart=,args="])
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_ps_line)
        .collect()
}

#[cfg(not(unix))]
pub fn read_process_table() -> Vec<ProcInfo> {
    Vec::new()
}

/// Re-read `snapshot.pid` and confirm it is still the same process: same
/// start time, same argv, same (launchd) parent. This is the pid-recycling
/// guard, so any read failure answers `false`.
#[cfg(unix)]
pub fn still_same_process(snapshot: &ProcInfo) -> bool {
    let Ok(out) = std::process::Command::new("/bin/ps")
        .args([
            "-ww",
            "-p",
            &snapshot.pid.to_string(),
            "-o",
            "pid=,ppid=,lstart=,args=",
        ])
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    match text.lines().find_map(parse_ps_line) {
        Some(now) => now == *snapshot,
        None => false,
    }
}

#[cfg(not(unix))]
pub fn still_same_process(_snapshot: &ProcInfo) -> bool {
    false
}

/// Outcome of [`sweep_orphaned_sidecars`], for honest logging.
#[derive(Debug, Default)]
pub struct SweepReport {
    pub reaped: Vec<i32>,
    /// Candidates whose identity changed between the snapshot and the kill.
    pub skipped_changed: Vec<i32>,
    /// `(pid, port)` of Ashlr servers that are not ours — left running.
    pub foreign: Vec<(i32, Option<u16>)>,
}

/// Find and stop this bundle's orphaned sidecars; report foreign servers.
///
/// `keep_pid` is a sidecar this process owns right now (never reaped, never
/// reported). Runs `ps` and may wait out [`crate::sidecar_guard::terminate_tree`]'s
/// grace per orphan, so call it off the main thread.
pub fn sweep_orphaned_sidecars(
    sidecar_bin: &str,
    arg_sets: &[&[&str]],
    keep_pid: Option<i32>,
) -> SweepReport {
    let own_pid = std::process::id() as i32;
    let table = read_process_table();
    let plan = plan_sweep(&table, sidecar_bin, own_pid, arg_sets);
    let mut report = SweepReport::default();
    for orphan in plan.reap {
        if Some(orphan.pid) == keep_pid {
            continue;
        }
        if still_same_process(&orphan) {
            crate::sidecar_guard::terminate_tree(orphan.pid);
            report.reaped.push(orphan.pid);
        } else {
            report.skipped_changed.push(orphan.pid);
        }
    }
    for row in plan.foreign {
        if Some(row.pid) == keep_pid || row.ppid == own_pid {
            continue;
        }
        report.foreign.push((row.pid, port_of(&row)));
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIN: &str = "/Applications/Ashlr.app/Contents/MacOS/ashlr";
    const VERSE: &[&str] = &["verse", "--port", "7777", "--no-open", "--json"];
    const SERVE: &[&str] = &["serve", "--port", "7777", "--allow-dispatch", "--json"];
    const SETS: &[&[&str]] = &[VERSE, SERVE];

    fn row(pid: i32, ppid: i32, args: &str) -> ProcInfo {
        ProcInfo {
            pid,
            ppid,
            started: "Wed Sep 23 21:22:29 2026".to_string(),
            args: args.to_string(),
        }
    }

    // ── backoff ──────────────────────────────────────────────────────────────

    #[test]
    fn backoff_doubles_from_one_second_and_caps_at_thirty() {
        let delays: Vec<u64> = (1..=8).map(|n| backoff_delay(n).as_secs()).collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 16, 30, 30, 30]);
        // Absurd streaks neither overflow nor exceed the cap.
        assert_eq!(backoff_delay(u32::MAX), RESTART_MAX);
        assert_eq!(backoff_delay(0), RESTART_BASE);
    }

    #[test]
    fn quick_crashes_back_off_then_give_up_inside_the_window() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        let quick = Duration::from_secs(2);
        let mut delays = Vec::new();
        for i in 0..RESTART_MAX_IN_WINDOW {
            match policy.on_unexpected_exit(t0 + Duration::from_secs(i as u64 * 10), quick) {
                RestartDecision::Restart { delay, streak } => {
                    assert_eq!(streak as usize, i + 1);
                    delays.push(delay.as_secs());
                }
                other => panic!("exit {i} should restart, got {other:?}"),
            }
        }
        assert_eq!(delays, vec![1, 2, 4, 8, 16]);
        // The sixth exit inside ten minutes is one too many.
        assert_eq!(
            policy.on_unexpected_exit(t0 + Duration::from_secs(60), quick),
            RestartDecision::GiveUp { exits_in_window: 6 }
        );
        assert!(policy.has_given_up());
        // Sticky, even far outside the window.
        assert!(matches!(
            policy.on_unexpected_exit(t0 + Duration::from_secs(3600), RESTART_STABLE_AFTER),
            RestartDecision::GiveUp { .. }
        ));
    }

    #[test]
    fn a_sidecar_that_ran_for_a_minute_starts_a_fresh_streak() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        let _ = policy.on_unexpected_exit(t0, Duration::from_secs(1));
        let _ = policy.on_unexpected_exit(t0 + Duration::from_secs(5), Duration::from_secs(1));
        match policy.on_unexpected_exit(t0 + Duration::from_secs(200), RESTART_STABLE_AFTER) {
            RestartDecision::Restart { delay, streak } => {
                assert_eq!(streak, 1);
                assert_eq!(delay, RESTART_BASE);
            }
            other => panic!("expected a restart, got {other:?}"),
        }
    }

    #[test]
    fn exits_older_than_the_window_do_not_count_toward_giving_up() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        // One stable crash every eleven minutes, forever: never gives up.
        for i in 0..20u64 {
            let decision = policy
                .on_unexpected_exit(t0 + Duration::from_secs(i * 11 * 60), RESTART_STABLE_AFTER);
            assert!(
                matches!(decision, RestartDecision::Restart { streak: 1, .. }),
                "exit {i}: {decision:?}"
            );
        }
    }

    #[test]
    fn reset_forgets_everything_including_giving_up() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        for i in 0..=RESTART_MAX_IN_WINDOW {
            let _ = policy.on_unexpected_exit(t0 + Duration::from_secs(i as u64), Duration::ZERO);
        }
        assert!(policy.has_given_up());
        policy.reset();
        assert!(!policy.has_given_up());
        assert!(matches!(
            policy.on_unexpected_exit(t0 + Duration::from_secs(30), Duration::ZERO),
            RestartDecision::Restart { streak: 1, .. }
        ));
    }

    // ── ps parsing ───────────────────────────────────────────────────────────

    #[test]
    fn parses_macos_ps_rows_including_a_space_padded_day() {
        let parsed = parse_ps_line(
            "31498     1 Wed Sep  9 20:44:42 2026     /Applications/Ashlr.app/Contents/MacOS/ashlr verse --port 7777 --no-open --json",
        )
        .expect("row");
        assert_eq!(parsed.pid, 31498);
        assert_eq!(parsed.ppid, 1);
        assert_eq!(parsed.started, "Wed Sep 9 20:44:42 2026");
        assert_eq!(
            parsed.args,
            format!("{BIN} verse --port 7777 --no-open --json")
        );
    }

    #[test]
    fn keeps_spaces_inside_argv() {
        let parsed = parse_ps_line(
            "7 1 Mon Sep 21 11:59:17 2026 /Applications/Ashlr Verse.app/Contents/MacOS/ashlr verse",
        )
        .expect("row");
        assert_eq!(
            parsed.args,
            "/Applications/Ashlr Verse.app/Contents/MacOS/ashlr verse"
        );
    }

    #[test]
    fn malformed_rows_are_skipped_not_guessed() {
        assert_eq!(parse_ps_line(""), None);
        assert_eq!(parse_ps_line("abc 1 Wed Sep 9 20:44:42 2026 /bin/x"), None);
        assert_eq!(parse_ps_line("12 1 Wed Sep 9"), None, "truncated lstart");
        assert_eq!(
            parse_ps_line("12 1 Wed Sep 9 20:44:42 2026"),
            None,
            "no argv"
        );
    }

    // ── orphan identification ────────────────────────────────────────────────

    #[test]
    fn an_orphaned_sidecar_of_this_bundle_is_identified_in_both_modes() {
        assert!(is_orphaned_sidecar(
            &row(500, 1, &format!("{BIN} verse --port 7777 --no-open --json")),
            BIN,
            42,
            SETS
        ));
        assert!(is_orphaned_sidecar(
            &row(
                501,
                1,
                &format!("{BIN} serve --port 7777 --allow-dispatch --json")
            ),
            BIN,
            42,
            SETS
        ));
    }

    #[test]
    fn a_sidecar_whose_app_is_alive_is_never_an_orphan() {
        // Another running copy of Ashlr is its parent.
        assert!(!is_orphaned_sidecar(
            &row(
                500,
                777,
                &format!("{BIN} verse --port 7777 --no-open --json")
            ),
            BIN,
            42,
            SETS
        ));
    }

    #[test]
    fn only_an_exact_argv_match_counts() {
        let cases = [
            // A sibling binary whose path merely starts with ours.
            format!("{BIN}-evil verse --port 7777 --no-open --json"),
            // The same binary run by hand with other flags.
            format!("{BIN} verse --port 7777"),
            format!("{BIN} verse --port 7777 --no-open --json --extra"),
            // The npm CLI — the operator's, not ours.
            "/usr/local/bin/ashlr verse --port 7777 --no-open --json".to_string(),
            "/opt/homebrew/bin/node /x/dist/cli/index.js verse --port 7971 --no-open".to_string(),
        ];
        for args in cases {
            assert!(
                !is_orphaned_sidecar(&row(500, 1, &args), BIN, 42, SETS),
                "{args}"
            );
        }
    }

    #[test]
    fn our_own_pid_pid_one_and_an_empty_binary_path_are_never_candidates() {
        let args = format!("{BIN} verse --port 7777 --no-open --json");
        assert!(!is_orphaned_sidecar(&row(42, 1, &args), BIN, 42, SETS));
        assert!(!is_orphaned_sidecar(&row(1, 1, &args), BIN, 42, SETS));
        assert!(!is_orphaned_sidecar(&row(0, 1, &args), BIN, 42, SETS));
        assert!(!is_orphaned_sidecar(
            &row(500, 1, " verse --port 7777 --no-open --json"),
            "",
            42,
            SETS
        ));
    }

    #[test]
    fn the_plan_reaps_our_orphans_and_only_reports_foreign_servers() {
        let table = vec![
            row(10, 1, &format!("{BIN} verse --port 7777 --no-open --json")),
            row(11, 9, &format!("{BIN} verse --port 7777 --no-open --json")),
            row(12, 1, "/Users/me/.hermes/node/bin/node /Users/me/.local/share/ashlr/current/bin/ashlr serve --port 4317"),
            row(13, 1, "/opt/homebrew/bin/node /repo/dist/cli/index.js verse --port 7971 --no-open --no-accounts"),
            row(14, 1, "/usr/sbin/cfprefsd agent"),
            row(15, 1, "/usr/bin/python3 serve.py --port 8000"),
        ];
        let plan = plan_sweep(&table, BIN, 42, SETS);
        assert_eq!(
            plan.reap.iter().map(|p| p.pid).collect::<Vec<_>>(),
            vec![10]
        );
        assert_eq!(
            plan.foreign.iter().map(|p| p.pid).collect::<Vec<_>>(),
            vec![11, 12, 13]
        );
        assert_eq!(port_of(&table[2]), Some(4317));
        assert_eq!(port_of(&table[3]), Some(7971));
        assert_eq!(port_of(&table[4]), None);
    }

    // ── start-time identity (real processes) ─────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn identity_holds_for_a_live_process_and_breaks_once_it_is_gone() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id() as i32;
        let snapshot = read_process_table()
            .into_iter()
            .find(|p| p.pid == pid)
            .expect("the child is in the process table");
        assert!(snapshot.args.ends_with("sleep 30"), "{}", snapshot.args);
        assert!(still_same_process(&snapshot));

        // Same pid, different start time: what a recycled pid looks like.
        let recycled = ProcInfo {
            started: "Thu Jan 1 00:00:00 1970".to_string(),
            ..snapshot.clone()
        };
        assert!(
            !still_same_process(&recycled),
            "a changed start time must veto the kill"
        );

        let _ = child.kill();
        let _ = child.wait();
        assert!(
            !still_same_process(&snapshot),
            "a gone process is never the same process"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_real_sweep_leaves_foreign_processes_alone() {
        // A binary path that cannot exist: nothing on this machine matches, so
        // the real sweep must reap nothing — whatever else is running.
        let report =
            sweep_orphaned_sidecars("/nonexistent/Ashlr.app/Contents/MacOS/ashlr", SETS, None);
        assert!(report.reaped.is_empty());
        assert!(report.skipped_changed.is_empty());
    }
}

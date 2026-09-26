/**
 * `ashlr leader` — V3.10 Track B (unit U8). Registered by B-U1 in src/cli/index.ts.
 *
 *   ashlr leader show [--json]               the latest memo, actions, hit-rate
 *   ashlr leader run [--force]               run the Leader now (waits for the memo)
 *   ashlr leader tick [--wait]               apply due class-B actions, grade moves,
 *                                            and start a run if one is due
 *   ashlr leader veto <actionId> [--note T]  undo one action
 *   ashlr leader veto --memo <memoId> [--note T]   undo a whole memo
 *   ashlr leader oversight-plist --print [--bin P]  print (never install) the
 *                                            nightly ai.ashlr.oversight plist
 *
 * `run` spends at most one Leader call on a seat the router allows (with no
 * standing grant: a free local model or nothing). `veto` only lowers what
 * autonomy is doing. Exit codes: 0 success, 1 error / refused, 2 bad usage.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { loadConfig } from '../core/config.js';
import type { LeaderAction, LeaderMemo, LeaderStateV1 } from '../core/vision/leader-types.js';

const USAGE = `ashlr leader — the Leader (Visionary): memo, actions, veto

Usage:
  ashlr leader show [--json]
  ashlr leader run [--force]
  ashlr leader tick [--wait]
  ashlr leader veto <actionId> [--note "why"]
  ashlr leader veto --memo <memoId> [--note "why"]
  ashlr leader oversight-plist --print [--bin /path/to/ashlr]`;

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function option(args: string[], name: string): string | null | undefined {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  args.splice(i, 2);
  return value;
}

function line(action: LeaderAction): string {
  const when = action.status === 'scheduled' && action.applyAfter ? ` (applies ${action.applyAfter})` : '';
  const reason = action.statusReason ? ` — ${action.statusReason}` : '';
  return `  [${action.class}] ${action.status.padEnd(9)} ${action.id}  ${action.summary}${when}${reason}`;
}

function printMemo(memo: LeaderMemo | null): void {
  if (!memo) {
    console.log('No memo yet.');
    return;
  }
  console.log(`Memo ${memo.id} — ${memo.at} — ${memo.status}${memo.dryRun ? ' (dry run)' : ''}`);
  if (memo.seatId) console.log(`  seat: ${memo.seatId} (${memo.model ?? 'unknown model'})`);
  if (memo.statusReason) console.log(`  note: ${memo.statusReason}`);
  if (memo.bottleneck) console.log(`\nTHE BOTTLENECK: ${memo.bottleneck.statement}`);
  if (memo.move) {
    const d = memo.move.expectedDelta;
    console.log(`THE MOVE: ${memo.move.statement}${d ? `  (${d.metric} ${d.delta >= 0 ? '+' : ''}${d.delta} by ${d.byDate.slice(0, 10)})` : ''}`);
  }
  if (memo.killList.length > 0) {
    console.log('\nKill list:');
    for (const k of memo.killList) console.log(`  - ${k.target.kind} ${k.target.id}: ${k.why}`);
  }
  if (memo.questionsForMason.length > 0) {
    console.log('\nQuestions for you:');
    for (const q of memo.questionsForMason) console.log(`  - ${q}`);
  }
  if (memo.actions.length > 0) {
    console.log('\nActions:');
    for (const a of memo.actions) console.log(line(a));
  }
}

function printState(state: LeaderStateV1): void {
  printMemo(state.latest);
  const hr = state.hitRate;
  console.log(`\nHit-rate (${hr.windowDays} d): ${hr.rate === null ? 'not graded yet' : `${Math.round(hr.rate * 100)}% of ${hr.graded}`}`);
  console.log(`Runs today: ${state.runsToday}; next scheduled run: ${state.nextRunAt ?? 'unknown'}`);
  if (state.lastRun) console.log(`Last run: ${state.lastRun.at} — ${state.lastRun.outcome}${state.lastRun.reason ? ` (${state.lastRun.reason})` : ''}`);
  const health = state.health;
  if (health) {
    console.log(`Leader: ${health.status} — ${health.summary}`);
    if (health.nextDueAt) console.log(`Next due: ${health.nextDueAt} (${health.nextDueReason ?? ''})`);
    for (const a of health.seats) {
      console.log(`  seat ${a.seatId} [${a.outcome}]${a.ms !== null ? ` ${Math.round(a.ms / 1000)} s` : ''}${a.reason ? ` — ${a.reason}` : ''}`);
    }
  }
  const live = state.actions.filter((a) => a.status === 'scheduled');
  if (live.length > 0) {
    console.log('\nWaiting on their veto window:');
    for (const a of live) console.log(line(a));
  }
}

// ---------------------------------------------------------------------------
// Wake (3.14): let the comms poller start a tick when a time-based run is due
// ---------------------------------------------------------------------------

/** Minimum gap between two background ticks started by the poller. */
export const LEADER_WAKE_THROTTLE_MS = 10 * 60_000;

export interface LeaderWakeDeps {
  now(): number;
  /** Start `ashlr leader tick --wait` detached; false when it could not be started. */
  spawnTick(): boolean;
  readLastWake(): number;
  writeLastWake(ms: number): void;
}

function wakeStampPath(root: string): string {
  return join(root, '.wake.json');
}

async function defaultWakeDeps(): Promise<LeaderWakeDeps> {
  const { leaderRoot } = await import('../core/vision/leader-memo.js');
  const root = leaderRoot();
  return {
    now: () => Date.now(),
    spawnTick: () => {
      // The same node + ashlr entry point this process runs under (launchd
      // gives absolute paths); never a PATH lookup.
      const entry = process.argv[1];
      // Never from a test runner: argv[1] would be the runner, not ashlr (and a
      // stray child could touch real state — see the 2026 poisoned-daemon incident).
      if (process.env['VITEST']) return false;
      if (!entry || !isAbsolute(entry) || !existsSync(entry)) return false;
      try {
        const child = spawn(process.execPath, [entry, 'leader', 'tick', '--wait'], { detached: true, stdio: 'ignore', env: process.env });
        child.on('error', () => undefined);
        child.unref();
        return true;
      } catch {
        return false;
      }
    },
    readLastWake: () => {
      try {
        const parsed = JSON.parse(readFileSync(wakeStampPath(root), 'utf8')) as { at?: unknown };
        return typeof parsed.at === 'number' ? parsed.at : 0;
      } catch {
        return 0;
      }
    },
    writeLastWake: (ms) => {
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(wakeStampPath(root), JSON.stringify({ at: ms }), { mode: 0o600 });
      } catch { /* a missed stamp only means an extra (lock-guarded) tick */ }
    },
  };
}

/**
 * Called from `ashlr comms cycle` (every 3 minutes under ai.ashlr.comms-poll),
 * so retries and working-hours check-ins happen without the daemon. Cheap:
 * reads the Leader state file only, and starts a background tick at most
 * every 10 minutes, only when a time-based run could be due. The tick runs
 * under the Leader's run lock, so an overlap exits at once. Never throws.
 */
export async function wakeLeaderIfDue(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  deps?: LeaderWakeDeps,
): Promise<{ started: boolean; why: string }> {
  try {
    const d = deps ?? await defaultWakeDeps();
    const nowMs = d.now();
    if (nowMs - d.readLastWake() < LEADER_WAKE_THROTTLE_MS) return { started: false, why: 'woke the Leader recently' };
    const [leader, cadenceMod] = await Promise.all([import('../core/vision/leader.js'), import('../core/vision/leader-cadence.js')]);
    const wake = leader.leaderWakeDue(nowMs, leader.readLeaderRunState(), cadenceMod.resolveLeaderCadence(cfg));
    if (!wake.due) return { started: false, why: wake.why };
    d.writeLastWake(nowMs);
    return d.spawnTick() ? { started: true, why: wake.why } : { started: false, why: 'the tick could not be started' };
  } catch {
    return { started: false, why: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Nightly oversight plist (printed, never installed)
// ---------------------------------------------------------------------------

export interface OversightPlistOptions {
  home: string;
  /** Absolute path of the `ashlr` launcher the job runs. */
  ashlrBin: string;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The zsh body ai.ashlr.oversight runs. WHY each line:
 *  - `leader tick --wait` replaces `ashlr vision review` (legacy Strategist,
 *    Claude CLI first with no budget gate). A run starts only when one is
 *    due, on a seat the router admits; the 07:00 slot catches the 06:30
 *    cadence when the daemon is dark, and is a cheap no-op when it already ran.
 *  - `fleet oversight` and `comms digest` are read-only snapshots (no model).
 *  - `comms ask-vision` posts the newest memo; its own tick finds nothing due
 *    right after the one above, so it never pays for a second run.
 *  - `ashlr manager` is deliberately NOT here: its judge resolves the Claude
 *    CLI outside the SeatRouter, so it would spend the reserve unattended.
 */
export function oversightScript(ashlrBin: string): string {
  const bin = shellQuote(ashlrBin);
  return [
    'LOG="$HOME/.ashlr/oversight.log"',
    '{',
    '  echo "=== oversight run $(date) ==="',
    `  ${bin} leader tick --wait`,
    `  ${bin} fleet oversight`,
    '  echo "=== oversight done $(date) ==="',
    `  ${bin} comms digest`,
    `  ${bin} comms ask-vision`,
    '} >> "$LOG" 2>&1',
  ].join('\n');
}

/**
 * PURE: the ai.ashlr.oversight LaunchAgent, self-contained (the script is
 * inline, so nothing depends on an unreviewed ~/.ashlr/oversight.sh). Same
 * label, 07:00 schedule and log paths as the plist it replaces, so swapping it
 * in is a like-for-like `launchctl bootout` + `bootstrap` Mason runs himself.
 * (The XML comment must never contain "--", which XML forbids in comments.)
 */
export function buildOversightPlist(opts: OversightPlistOptions): string {
  const home = xmlEscape(opts.home);
  const pathEnv = xmlEscape(`${opts.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Printed by ashlr leader oversight-plist. Review, then install by hand: docs/AUTHORITY.md, Nightly oversight. -->
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>ai.ashlr.oversight</string>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>${home}</string>
\t\t<key>PATH</key>
\t\t<string>${pathEnv}</string>
\t</dict>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/zsh</string>
\t\t<string>-c</string>
\t\t<string>${xmlEscape(oversightScript(opts.ashlrBin))}</string>
\t</array>
\t<key>StartCalendarInterval</key>
\t<dict>
\t\t<key>Hour</key>
\t\t<integer>7</integer>
\t\t<key>Minute</key>
\t\t<integer>0</integer>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${home}/.ashlr/oversight.launchd.out.log</string>
\t<key>StandardErrorPath</key>
\t<string>${home}/.ashlr/oversight.launchd.err.log</string>
</dict>
</plist>
`;
}

async function runOversightPlist(args: string[]): Promise<number> {
  const print = flag(args, '--print');
  const binOpt = option(args, '--bin');
  // --print is required so nobody mistakes this for an installer: it writes
  // nothing and never calls launchctl (activation is Mason's step).
  if (!print || binOpt === undefined || args.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const { homedir } = await import('node:os');
  const { isAbsolute, join } = await import('node:path');
  const home = process.env['HOME'] || homedir();
  // Default: the stable ~/.local/bin/ashlr symlink the installer maintains,
  // so a new release is picked up without regenerating the plist.
  const ashlrBin = binOpt ?? join(home, '.local', 'bin', 'ashlr');
  if (!isAbsolute(ashlrBin)) {
    console.error('oversight-plist: --bin must be an absolute path (launchd has no shell PATH lookup you can rely on).');
    return 2;
  }
  process.stdout.write(buildOversightPlist({ home, ashlrBin }));
  return 0;
}

export async function runLeaderCli(argv: string[]): Promise<number> {
  const args = [...argv];
  const sub = args.shift();
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  // Before the core import: printing a plist needs no Leader state.
  if (sub === 'oversight-plist') return runOversightPlist(args);
  const leader = await import('../core/vision/leader.js');

  if (sub === 'show') {
    const json = flag(args, '--json');
    if (args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const state = leader.buildLeaderState(Date.now());
    if (json) console.log(JSON.stringify(state, null, 2));
    else printState(state);
    return 0;
  }

  if (sub === 'run' || sub === 'tick') {
    const force = sub === 'run' && flag(args, '--force');
    const wait = sub === 'tick' && flag(args, '--wait');
    if (args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const deps = await leader.loadDefaultLeaderRunDeps(loadConfig());
    if (sub === 'run') {
      console.log('Running the Leader (a local model can take several minutes)…');
      const result = await leader.runLeader(deps, 'manual', { force });
      if (!result.memo) {
        console.log(`${result.outcome}: ${result.reason ?? ''}`);
        return result.outcome === 'skipped-unchanged' ? 0 : 1;
      }
      printMemo(result.memo);
      return result.outcome === 'ok' ? 0 : 1;
    }
    const tick = await leader.leaderTick(deps, { awaitRun: wait });
    console.log(`Applied ${tick.applied.length} due action(s); graded ${tick.graded.length} move(s).`);
    console.log(tick.due.due ? `Run due (${tick.due.trigger}): ${tick.due.reason}${tick.started ? ' — started.' : ''}` : `No run due: ${tick.due.reason}`);
    if (tick.run?.memo) printMemo(tick.run.memo);
    return 0;
  }

  if (sub === 'veto') {
    const noteOpt = option(args, '--note');
    const memoOpt = option(args, '--memo');
    if (noteOpt === undefined || memoOpt === undefined) {
      console.error(USAGE);
      return 2;
    }
    const target = memoOpt ?? args.shift() ?? null;
    if (!target || args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const apply = await import('../core/vision/leader-apply.js');
    const deps = await apply.loadDefaultLeaderDeps();
    const result = memoOpt
      ? await apply.vetoLeaderMemo(deps, target, noteOpt)
      : await apply.vetoLeaderAction(deps, target, noteOpt);
    console.log(result.message);
    for (const r of result.records) console.log(`  ${r.actionId}: ${r.restored ? 'restored exactly' : 'not exact'} — ${r.detail}`);
    return result.ok ? 0 : 1;
  }

  console.error(USAGE);
  return 2;
}

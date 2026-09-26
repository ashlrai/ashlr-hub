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
 * 3.14 — talk to the Leader (vision/leader-thread.ts; the same thread Verse
 * and Telegram use):
 *   ashlr leader say "<text>"                 say something; prints the reply
 *   ashlr leader thread [--limit n] [--json]  the conversation, oldest first
 *   ashlr leader answer <questionId> "<text>" answer one of the memo's questions
 *   ashlr leader approve <actionId>           approve a pending action (class B
 *                                            applies now only if the grant
 *                                            still allows it; dry run / class C
 *                                            are recorded, never applied)
 *   ashlr leader directives [list] [--all] [--json]
 *   ashlr leader directives add "<text>" [--kind focus|stop|priority|guidance]
 *   ashlr leader directives retire <directiveId>
 *
 * `run` spends at most one Leader call on a seat the router allows (with no
 * standing grant: a free local model or nothing). `veto` only lowers what
 * autonomy is doing. Exit codes: 0 success, 1 error / refused, 2 bad usage.
 */
import { loadConfig } from '../core/config.js';
import type { LeaderAction, LeaderMemo, LeaderStateV1 } from '../core/vision/leader-types.js';

const USAGE = `ashlr leader — the Leader (Visionary): memo, actions, veto

Usage:
  ashlr leader show [--json]
  ashlr leader run [--force]
  ashlr leader tick [--wait]
  ashlr leader veto <actionId> [--note "why"]
  ashlr leader veto --memo <memoId> [--note "why"]
  ashlr leader oversight-plist --print [--bin /path/to/ashlr]
  ashlr leader say "<text>"
  ashlr leader thread [--limit n] [--json]
  ashlr leader answer <questionId> "<text>"
  ashlr leader approve <actionId>
  ashlr leader directives [list] [--all] [--json]
  ashlr leader directives add "<text>" [--kind focus|stop|priority|guidance]
  ashlr leader directives retire <directiveId>`;

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
  const live = state.actions.filter((a) => a.status === 'scheduled');
  if (live.length > 0) {
    console.log('\nWaiting on their veto window:');
    for (const a of live) console.log(line(a));
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

// ---------------------------------------------------------------------------
// The thread (3.14)
// ---------------------------------------------------------------------------

type ThreadModule = typeof import('../core/vision/leader-thread.js');

function printThreadMessage(m: import('../core/vision/leader-thread.js').LeaderThreadMessage): void {
  const who = m.from === 'mason' ? 'You' : 'Leader';
  const tag = m.kind === 'message' ? '' : ` [${m.kind}${m.questionId ? ` ${m.questionId}` : ''}]`;
  console.log(`${m.at.slice(0, 16).replace('T', ' ')} ${who} (${m.channel})${tag} ${m.id}`);
  for (const l of m.text.split('\n')) console.log(`  ${l}`);
}

/** Thread errors are the caller's (bad id, empty text): exit 1 with the reason, never a stack. */
async function threadCall(thread: ThreadModule, fn: () => Promise<number> | number): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof thread.LeaderThreadError) {
      console.error(err.message);
      return err.code === 400 ? 2 : 1;
    }
    throw err;
  }
}

async function runThreadCli(sub: string, args: string[]): Promise<number> {
  const thread = await import('../core/vision/leader-thread.js');
  if (sub === 'say') {
    const text = args.join(' ').trim();
    if (text.length === 0) {
      console.error(USAGE);
      return 2;
    }
    return threadCall(thread, async () => {
      const result = await thread.appendMasonMessage(text, { channel: 'cli', cfg: loadConfig() });
      if (result.directive) console.log(`Standing directive recorded: ${result.directive.id} (${result.directive.kind}) ${result.directive.text}`);
      if (result.reply) console.log(result.reply.text);
      return 0;
    });
  }
  if (sub === 'thread') {
    const json = flag(args, '--json');
    const limitOpt = option(args, '--limit');
    if (limitOpt === undefined || args.length > 0 || (limitOpt !== null && !/^\d{1,3}$/.test(limitOpt))) {
      console.error(USAGE);
      return 2;
    }
    return threadCall(thread, () => {
      const messages = thread.listThread(limitOpt === null ? {} : { limit: Number(limitOpt) });
      if (json) console.log(JSON.stringify({ messages }, null, 2));
      else if (messages.length === 0) console.log('No messages yet. Say something: ashlr leader say "…"');
      else for (const m of messages) printThreadMessage(m);
      return 0;
    });
  }
  if (sub === 'answer') {
    const questionId = args.shift();
    const text = args.join(' ').trim();
    if (!questionId || text.length === 0) {
      console.error(USAGE);
      return 2;
    }
    return threadCall(thread, async () => {
      const result = await thread.answerLeaderQuestion(questionId, text, { channel: 'cli', cfg: loadConfig() });
      console.log(`Answer recorded for ${questionId}.`);
      if (result.reply) console.log(result.reply.text);
      return 0;
    });
  }
  if (sub === 'approve') {
    const actionId = args.shift();
    if (!actionId || args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    return threadCall(thread, async () => {
      const result = await thread.approveLeaderAction(actionId, { channel: 'cli', cfg: loadConfig() });
      console.log(result.message);
      return result.ok ? 0 : 1;
    });
  }
  return runDirectivesCli(args);
}

async function runDirectivesCli(args: string[]): Promise<number> {
  const operator = await import('../core/vision/leader-operator.js');
  const action = args[0] && !args[0].startsWith('--') ? args.shift()! : 'list';
  if (action === 'list') {
    const all = flag(args, '--all');
    const json = flag(args, '--json');
    if (args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const directives = operator.listOperatorDirectives({ includeRetired: all });
    if (json) console.log(JSON.stringify({ directives }, null, 2));
    else if (directives.length === 0) console.log('No standing directives. Add one: ashlr leader directives add "focus on …"');
    else for (const d of directives) console.log(`  ${d.id} [${d.kind}]${d.retiredAt ? ` (retired ${d.retiredAt.slice(0, 10)})` : ''} ${d.text}`);
    return 0;
  }
  if (action === 'add') {
    const kindOpt = option(args, '--kind');
    const text = args.join(' ').trim();
    if (kindOpt === undefined || text.length === 0 || (kindOpt !== null && !operator.isOperatorDirectiveKind(kindOpt))) {
      console.error(USAGE);
      return 2;
    }
    const result = operator.addOperatorDirective({ kind: (kindOpt ?? 'guidance') as import('../core/vision/leader-operator.js').OperatorDirectiveKind, text, source: 'direct', channel: 'cli' });
    if (!result.ok) {
      console.error(result.reason);
      return result.code === 400 ? 2 : 1;
    }
    console.log(`${result.duplicate ? 'Already in force' : 'Recorded'}: ${result.directive.id} [${result.directive.kind}] ${result.directive.text}`);
    return 0;
  }
  if (action === 'retire') {
    const id = args.shift();
    if (!id || args.length > 0) {
      console.error(USAGE);
      return 2;
    }
    const result = operator.retireOperatorDirective(id, 'cli');
    if (!result.ok) {
      console.error(result.reason);
      return result.code === 400 ? 2 : 1;
    }
    console.log(`Retired: ${result.directive.id} ${result.directive.text}`);
    return 0;
  }
  console.error(USAGE);
  return 2;
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
  if (sub === 'say' || sub === 'thread' || sub === 'answer' || sub === 'approve' || sub === 'directives') return runThreadCli(sub, args);
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

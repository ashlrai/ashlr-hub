/**
 * Overnight API — V3.10 Track B unit U5 (SPEC-310B §3 "Overnight backend").
 *
 * The backend the Overnight panel has been waiting for, over
 * daemon/overnight-status.ts's existing wire shape (the client's
 * routes/verse/autonomy/overnight-contract.ts), including `discarded[]`:
 *
 *   GET  /api/verse/overnight         → OvernightStatus (+ `daemon`, `pending`)
 *   POST /api/verse/overnight         → OvernightActionResult, after ONE of
 *                                         {action:'arm', stopRule} | {action:'disarm'}
 *   GET  /api/verse/overnight/report  → OvernightReportV1 — the morning report
 *
 * ARMING NEVER STARTS ANYTHING. A resident daemon (launchd keeps it running)
 * adopts the armed record at the top of its next iteration; with no daemon
 * running the record simply waits, and the note says so. The run then ends by
 * PAUSING at its stop rule — never by the kill switch. Disarm stops the NEXT
 * run; halting a live one is the daemon pause (`POST /api/verse/daemon`), a
 * separate route on purpose (overnight-queries.ts explains why).
 *
 * Refusal ladder for arm, in order: kill switch engaged (or unreadable) →
 * nothing enrolled → a run already armed or running → a stop rule that does
 * not resolve (400, the run-window module's own sentence). Every refusal is a
 * `{ ok: false, note }` the panel renders verbatim.
 *
 * Security posture matches every Verse route: GETs sit behind the read
 * session in server.ts; a POST is 404 unless the server allows dispatch, then
 * the mutation token + JSON gate, then the shared body cap. Unknown keys and
 * query parameters are 400s. Every response goes through sendJson() →
 * sanitizePublicJson(). Nothing here returns a path, a token or a command.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { VERSE_OVERNIGHT_PATH } from '../fleet/fleet-types.js';
import {
  disarmOvernightRun,
  overnightRunInProgress,
  pendingOvernightRun,
  readOvernightStatus,
  requestOvernightRun,
  type OvernightGate,
  type OvernightRun,
  type OvernightStatus,
} from '../daemon/overnight-status.js';
import { RUN_WINDOW_MAX_ITERATIONS, resolveRunWindow, type RunWindowStopRule } from '../daemon/run-window.js';
import { probeDaemonLiveness, type DaemonLivenessV1 } from '../daemon/liveness.js';
import { readPostMergeHalts } from '../daemon/post-merge-halt.js';
import { currentStandingPolicy } from '../authority/effective-config.js';
import { listEnrolled, readKillSwitch } from '../sandbox/policy.js';
import { isMirrorPath } from '../fleet/mirrors.js';
import { audit } from '../sandbox/audit.js';

export const VERSE_OVERNIGHT_REPORT_PATH = `${VERSE_OVERNIGHT_PATH}/report`;

// ---------------------------------------------------------------------------
// Wire shapes (additive over overnight-status.ts's OvernightStatus)
// ---------------------------------------------------------------------------

export interface OvernightDaemonView {
  state: DaemonLivenessV1['state'];
  /** true running, false not, null unknown. */
  alive: boolean | null;
  reason: string;
}

/** GET /api/verse/overnight. */
export interface OvernightStatusView extends OvernightStatus {
  /** Armed but not yet taken by a daemon (no start time claimed). */
  pending: boolean;
  /** Is there a daemon to take (or running) the run — liveness, not the recorded flag. */
  daemon: OvernightDaemonView;
}

/** POST /api/verse/overnight — the receipt. */
export interface OvernightActionResult {
  ok: boolean;
  note: string | null;
  status: OvernightStatusView | null;
}

export interface OvernightReportHalt {
  at: string;
  detail: string;
  revertPlan: string[];
}

/** GET /api/verse/overnight/report — what happened, in one screen, for the morning. */
export interface OvernightReportV1 {
  v: 1;
  generatedAt: string;
  /** none = no run was ever armed; pending / running / concluded otherwise. */
  state: 'none' | 'pending' | 'running' | 'concluded';
  /** One sentence with units, e.g. "Last night: 7 merged, 2 discarded — stopped at 07:00." */
  headline: string;
  run: OvernightRun | null;
  counts: { merged: number; discarded: number; reverted: number; halts: number } | null;
  /** From the run's start to now (running) or to its last activity (concluded); null when not started. */
  durationMs: number | null;
  halts: OvernightReportHalt[];
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export interface OvernightApiDeps {
  now(): number;
  liveness(): DaemonLivenessV1;
  killSwitch(): 'active' | 'inactive' | 'unknown';
  /** Enrolled repositories — Mason's checkouts, WITHOUT the fleet's mirror clones; null = unreadable. */
  enrolledCount(): number | null;
  /** Enrolled fleet mirror clones (~/.ashlr/fleet/mirrors/…), counted apart; null = unreadable. */
  mirrorCount(): number | null;
  /** Does a standing policy let anything merge right now? */
  autoMerge(): boolean;
  halts(): OvernightReportHalt[];
}

function safeIsMirror(path: string): boolean {
  try {
    return isMirrorPath(path);
  } catch {
    return false;
  }
}

function defaultDeps(): OvernightApiDeps {
  return {
    now: () => Date.now(),
    liveness: () => probeDaemonLiveness(),
    killSwitch: () => {
      try {
        return readKillSwitch().state;
      } catch {
        return 'unknown';
      }
    },
    // WHY TWO COUNTS (R3f): the registry now holds Mason's checkouts AND the
    // standing fleet's mirror clones of them, so one length double-counts
    // every granted repo. Repositories are the checkouts; mirrors are shown
    // apart. A path that cannot be classified counts as a repository.
    enrolledCount: () => {
      try {
        return listEnrolled().filter((path) => !safeIsMirror(path)).length;
      } catch {
        return null;
      }
    },
    mirrorCount: () => {
      try {
        return listEnrolled().filter((path) => safeIsMirror(path)).length;
      } catch {
        return null;
      }
    },
    autoMerge: () => {
      try {
        const policy = currentStandingPolicy();
        return policy !== null && policy.switch === 'autonomous' && policy.repos.some((r) => r.stage === 'merge');
      } catch {
        return false;
      }
    },
    halts: () => readPostMergeHalts(20).map((h) => ({
      at: h.haltedAt,
      detail: h.detail,
      revertPlan: [...h.revertPlan],
    })),
  };
}

let deps: OvernightApiDeps = defaultDeps();

/** Test hook: replace (or with no argument restore) the dependencies. */
export function setOvernightApiDepsForTest(next?: Partial<OvernightApiDeps>): void {
  deps = next ? { ...defaultDeps(), ...next } : defaultDeps();
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function daemonView(): OvernightDaemonView {
  try {
    const live = deps.liveness();
    return { state: live.state, alive: live.alive, reason: live.reason };
  } catch {
    return { state: 'unknown', alive: null, reason: 'Daemon liveness could not be probed.' };
  }
}

export function overnightStatusView(status: OvernightStatus = readOvernightStatus()): OvernightStatusView {
  return { ...status, pending: pendingOvernightRun(status) !== null, daemon: daemonView() };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Pure: the morning report for a status and the halt records. */
export function buildOvernightReport(
  status: OvernightStatus,
  halts: readonly OvernightReportHalt[],
  nowMs: number,
): OvernightReportV1 {
  const generatedAt = new Date(nowMs).toISOString();
  const run = status.run;
  if (!run) {
    return {
      v: 1,
      generatedAt,
      state: 'none',
      headline: 'No overnight run has been armed yet.',
      run: null,
      counts: null,
      durationMs: null,
      halts: [],
    };
  }
  const state: OvernightReportV1['state'] = run.startedAt === null
    ? (status.armed ? 'pending' : 'concluded')
    : status.armed ? 'running' : 'concluded';
  const startedMs = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const runHalts = Number.isFinite(startedMs)
    ? halts.filter((h) => Date.parse(h.at) >= startedMs)
    : [];
  const reverted = run.discarded.filter((d) => /revert/i.test(d.reason)).length;
  const counts = {
    merged: run.merged.length,
    discarded: run.discarded.length,
    reverted,
    halts: runHalts.length,
  };
  const lastActivityMs = [...run.merged.map((m) => m.at), ...run.discarded.map((d) => d.at)]
    .map((at) => (at ? Date.parse(at) : NaN))
    .filter((ms) => Number.isFinite(ms))
    .reduce((max, ms) => Math.max(max, ms), Number.NEGATIVE_INFINITY);
  const durationMs = !Number.isFinite(startedMs)
    ? null
    : state === 'running'
      ? Math.max(0, nowMs - startedMs)
      : Number.isFinite(lastActivityMs) ? Math.max(0, lastActivityMs - startedMs) : null;
  let headline: string;
  if (state === 'pending') {
    headline = 'An overnight run is armed and waiting for the daemon to take it.';
  } else {
    const tally = `${plural(counts.merged, 'merge')}, ${counts.discarded} discarded${reverted > 0 ? ` (${reverted} reverted)` : ''}`
      + `${counts.halts > 0 ? `, ${plural(counts.halts, 'halt')}` : ''}`;
    headline = state === 'running'
      ? `Overnight run in progress: ${tally} so far.`
      : `Last run: ${tally}.${run.activity ? ` ${run.activity}` : ''}`;
  }
  return { v: 1, generatedAt, state, headline, run, counts, durationMs, halts: runHalts.slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function noQuery(req: IncomingMessage, res: ServerResponse): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return false;
  }
  for (const key of params.keys()) {
    sendInvalid(res, `unknown query parameter: ${key}`);
    return false;
  }
  return true;
}

async function readMutationBody(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'invalid JSON body');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  return parsed as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

/** Strict: exactly one stop-rule form, nothing else. */
export function parseStopRule(value: unknown): RunWindowStopRule | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'stopRule must be an object';
  const rule = value as Record<string, unknown>;
  switch (rule['kind']) {
    case 'until-paused':
      return exactKeys(rule, ['kind']) ? { kind: 'until-paused' } : 'an until-paused stop rule takes no other fields';
    case 'at-time': {
      if (!exactKeys(rule, ['kind', 'at'])) return 'an at-time stop rule takes exactly {kind, at}';
      const at = rule['at'];
      if (typeof at !== 'string' || at.length > 40) return 'at must be an ISO-8601 instant';
      return { kind: 'at-time', at };
    }
    case 'after-iterations': {
      if (!exactKeys(rule, ['kind', 'iterations'])) return 'an after-iterations stop rule takes exactly {kind, iterations}';
      const iterations = rule['iterations'];
      if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 1 || iterations > RUN_WINDOW_MAX_ITERATIONS) {
        return `iterations must be a whole number from 1 to ${RUN_WINDOW_MAX_ITERATIONS}`;
      }
      return { kind: 'after-iterations', iterations };
    }
    default:
      return 'stopRule.kind must be one of: until-paused, at-time, after-iterations';
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function refusal(res: ServerResponse, status: 409 | 500, note: string): void {
  sendJson(res, status, { ok: false, note, status: overnightStatusView() } satisfies OvernightActionResult);
}

function auditAction(action: 'arm' | 'disarm', summary: string, ok: boolean): void {
  try {
    audit({ action: `verse:overnight:${action}`, repo: null, sandboxId: null, summary, result: ok ? 'ok' : 'refused' });
  } catch { /* audit is best effort */ }
}

function arm(res: ServerResponse, body: Record<string, unknown>): void {
  if (!exactKeys(body, ['action', 'stopRule'])) {
    sendInvalid(res, 'arm takes exactly {action, stopRule}');
    return;
  }
  const rule = parseStopRule(body['stopRule']);
  if (typeof rule === 'string') {
    sendInvalid(res, rule);
    return;
  }
  const kill = deps.killSwitch();
  if (kill !== 'inactive') {
    const note = kill === 'active'
      ? 'Refused: the global kill switch is engaged. Clear it before arming a run.'
      : 'Refused: the kill switch state could not be read, so a run is not armed (failing closed).';
    auditAction('arm', note, false);
    refusal(res, 409, note);
    return;
  }
  const checkouts = deps.enrolledCount();
  const mirrors = checkouts === null ? null : deps.mirrorCount();
  // A run has work when anything is enrolled. The recorded repo count is the
  // checkouts; only when the registry holds nothing but mirrors (a standing
  // fleet whose grant covers repos Mason never enrolled) are the mirrors the
  // repositories — each mirror is one repo, so counting both would double it.
  const enrolled = checkouts === null
    ? null
    : checkouts > 0 ? checkouts : (mirrors ?? 0);
  if (enrolled === null || enrolled === 0) {
    const note = enrolled === null
      ? 'Refused: the enrollment registry could not be read, so it is not known what a run would work on.'
      : 'Refused: no repositories are enrolled, so a run would do nothing. Add scope first.';
    auditAction('arm', note, false);
    refusal(res, 409, note);
    return;
  }
  const current = readOvernightStatus();
  if (pendingOvernightRun(current) !== null || overnightRunInProgress(current)) {
    const note = pendingOvernightRun(current) !== null
      ? 'A run is already armed and waiting for the daemon. Disarm it first to change the stop rule.'
      : 'A run is already in progress. Pause the daemon to stop it now, or disarm to keep a new one from starting.';
    auditAction('arm', note, false);
    refusal(res, 409, note);
    return;
  }
  // Resolve NOW so a stop time already past is refused at the click, in the
  // run-window module's own sentence, instead of being recorded and refused
  // by the daemon later.
  const resolved = resolveRunWindow(rule, { nowMs: deps.now() });
  if (!resolved.ok) {
    sendInvalid(res, resolved.reason);
    return;
  }
  const gate: OvernightGate = {
    // The pre-merge gate is structural (verify runs typecheck + tests + lint
    // and fails closed without them), exactly as the CLI-armed record says.
    tests: true,
    lint: true,
    typecheck: true,
    autoMerge: deps.autoMerge(),
    branch: null,
  };
  // Mirrors are recorded apart from the repo count (the report shows both;
  // one number would double-count every granted repo and its mirror).
  const status = requestOvernightRun(rule, { repos: enrolled, mirrors, gate });
  // Honest about persistence: only a record that reads back armed is armed.
  const reread = readOvernightStatus();
  if (!reread.armed || reread.run?.runId !== status.run?.runId) {
    const note = 'The run could not be recorded (the overnight status file was not written). Nothing is armed.';
    auditAction('arm', note, false);
    refusal(res, 500, note);
    return;
  }
  const daemon = daemonView();
  const scope = checkouts !== null && checkouts > 0 && mirrors !== null && mirrors > 0
    ? ` Scope: ${checkouts} enrolled ${checkouts === 1 ? 'repository' : 'repositories'}, plus ${mirrors} fleet ${mirrors === 1 ? 'mirror' : 'mirrors'} the standing fleet works in.`
    : checkouts === 0 && mirrors !== null && mirrors > 0
      ? ` Scope: ${mirrors} fleet ${mirrors === 1 ? 'mirror' : 'mirrors'} (no checkouts are enrolled).`
      : '';
  const note = (daemon.alive === true
    ? `Armed — ${resolved.window.describe}. The running daemon takes it on its next cycle; it ends by pausing, never by the kill switch.`
    : `Armed — ${resolved.window.describe}. No daemon is running right now (${daemon.reason.replace(/\.$/, '')}), `
      + 'so it starts when the daemon next does. Arming never starts one.') + scope;
  auditAction('arm', `overnight run armed: ${resolved.window.describe}`, true);
  sendJson(res, 200, { ok: true, note, status: overnightStatusView(reread) } satisfies OvernightActionResult);
}

function disarm(res: ServerResponse, body: Record<string, unknown>): void {
  if (!exactKeys(body, ['action'])) {
    sendInvalid(res, 'disarm takes exactly {action}');
    return;
  }
  const before = readOvernightStatus();
  const wasPending = pendingOvernightRun(before) !== null;
  const wasRunning = overnightRunInProgress(before);
  if (!before.armed) {
    sendJson(res, 200, { ok: true, note: 'Nothing was armed.', status: overnightStatusView(before) } satisfies OvernightActionResult);
    return;
  }
  if (wasRunning) {
    // Arming is one-shot: once a daemon took the run there is no "next" run
    // to prevent, and clearing `armed` would make a running window read as
    // concluded. Stopping it now is the daemon pause, on purpose.
    sendJson(res, 200, {
      ok: true,
      note: 'The run in flight is not stopped by disarming — it ends at its stop rule. Pause the daemon to stop it now.',
      status: overnightStatusView(before),
    } satisfies OvernightActionResult);
    return;
  }
  const after = disarmOvernightRun();
  const reread = readOvernightStatus();
  if (reread.armed) {
    refusal(res, 500, 'The run could not be disarmed (the overnight status file was not written).');
    return;
  }
  const note = wasPending ? 'Disarmed: the armed run will not start.' : 'Disarmed.';
  auditAction('disarm', note, true);
  sendJson(res, 200, { ok: true, note, status: overnightStatusView(after) } satisfies OvernightActionResult);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * The overnight route family. Returns false for any path outside it so the
 * next module (or the 404) runs.
 */
export const handleOvernightApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path !== VERSE_OVERNIGHT_PATH && path !== VERSE_OVERNIGHT_REPORT_PATH) return false;
  try {
    if (path === VERSE_OVERNIGHT_REPORT_PATH) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (!noQuery(req, res)) return true;
      let halts: OvernightReportHalt[] = [];
      try {
        halts = deps.halts();
      } catch {
        halts = [];
      }
      sendJson(res, 200, buildOvernightReport(readOvernightStatus(), halts, deps.now()));
      return true;
    }
    if (method === 'GET') {
      if (!noQuery(req, res)) return true;
      sendJson(res, 200, overnightStatusView());
      return true;
    }
    if (method === 'POST') {
      const body = await readMutationBody(ctx, req, res);
      if (!body) return true;
      if (body['action'] === 'arm') arm(res, body);
      else if (body['action'] === 'disarm') disarm(res, body);
      else sendInvalid(res, 'action must be one of: arm, disarm');
      return true;
    }
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch {
    sendJson(res, 500, { error: 'overnight request failed' });
    return true;
  }
};

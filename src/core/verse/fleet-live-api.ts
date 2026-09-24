/**
 * Fleet live API — V3.10 Track B unit U5 (SPEC-310B §3, §6 "Fleet").
 *
 *   GET  /api/verse/fleet/live  → FleetLiveSnapshotV1 (core/fleet/fleet-types.ts)
 *   POST /api/verse/fleet/live  → FleetLiveActionResult, after ONE of
 *                                   {action:'pause-repo', repo, reason}
 *                                 | {action:'resume-repo', repo, kind?}
 *   needsYouItems()             → R1 (SPEC-310BC-COORD §4): owner-hold and
 *                                 quarantined repos, reverts in the last 24 h,
 *                                 open owner-lane PRs.
 *
 * WHERE EACH NUMBER COMES FROM (read-only, never a counter of its own):
 *   - merges, reverts, gates, PRs, post-merge verdicts — the authority ledger
 *     (authority/ledger.ts `readLedger`, 30 days);
 *   - lanes, presence, production holds, parked items — the last standing
 *     tick (fleet/fleet-runtime-journal.ts tick.json);
 *   - "why this seat" per dispatch — the runtime journal (runs.jsonl);
 *   - agents producing right now — the agent-action ledger's
 *     `daemon:dispatch-start` rows without a terminal row (only while a live
 *     daemon provably runs — see daemon/liveness.ts);
 *   - queued / parked asks — the fleet task queue;
 *   - holds — fleet/quarantine.ts;
 *   - the watching / reverting phases and post-merge green % — U4's
 *     post-merge watch store (fleet/post-merge-watch.ts listPostMergeWatches /
 *     postMergeGreenPct), which sees a red CI before its verdict is ledgered;
 *     the ledger's post-merge rows are the fallback when the store is empty
 *     or unreadable (the ledger is the append-only record of the same verdicts).
 * Honesty rule: a source that cannot be read makes its numbers `null`, never
 * zero, and the state line says which source is missing. "Dark" is a state
 * with its own sentence ("Fleet dark since …"), not an error.
 *
 * PERFORMANCE: the snapshot is built OFF the request path by one coalesced
 * async refresh (≤ 2 s old for a GET; a background refresh every 15 s once
 * anything has asked, so `needsYouItems()` — which activity calls every 5 s
 * — answers from memory in microseconds and never does I/O on its caller's
 * stack). The ledger read yields to the event loop (20 ms budget).
 *
 * POSTs act as `mason` (the only caller that passes Verse's mutation gate):
 * pause sets an `owner-hold`; resume clears one kind, or every active hold on
 * the repo. The hold store is fleet/quarantine.ts, which ledgers each change.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import type { NeedsYouItem } from './workbench-types.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import {
  FLEET_ENGINES,
  GATE_ORDER,
  REPO_HOLD_KINDS,
  VERSE_FLEET_LIVE_PATH,
  type FleetEngine,
  type FleetFunnelStage,
  type FleetGateFunnel,
  type FleetLaneState,
  type FleetLiveRun,
  type FleetLiveSnapshotV1,
  type FleetLiveState,
  type FleetLiveSummary,
  type FleetPhase,
  type FleetRepoRow,
  type FleetRunOutcome,
  type GateId,
  type LandingRecord,
  type RepoHold,
  type RepoHoldChange,
  type RepoHoldKind,
  type SetRepoHoldRequest,
} from '../fleet/fleet-types.js';
import type { EffectivePolicy, LedgerEntry, LedgerReadOptions, LedgerReadResult } from '../authority/types.js';
import { STANDING_GRANT_PATTERNS } from '../authority/types.js';
import { currentStandingPolicy } from '../authority/effective-config.js';
import { readLedger } from '../authority/ledger.js';
import { listRepoHolds, setRepoHold } from '../fleet/quarantine.js';
import { listPostMergeWatches, postMergeGreenPct, type PostMergeWatchView } from '../fleet/post-merge-watch.js';
import { listTasks, type TaskQueueRead } from '../fleet/task-source.js';
import { readJournalSince, readTickState, type FleetJournalRecord, type FleetTickStateV1 } from '../fleet/fleet-runtime-journal.js';
import { fleetLaneOf } from '../fleet/dispatch-router.js';
import { openFleetPrsFromLedger } from '../fleet/backpressure.js';
import { repoIdentityOfPath } from '../fleet/repo-identity.js';
import { readAgentActionsDetailed } from '../fleet/agent-action-ledger.js';
import { probeDaemonLiveness, type DaemonLivenessV1 } from '../daemon/liveness.js';
import { daemonPaused } from '../daemon/pause.js';
import { listEnrolled, readKillSwitch } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';
import { scrubSecrets } from '../util/scrub.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A GET serves a snapshot at most this old; older ones are rebuilt first. */
const GET_MAX_AGE_MS = 2_000;
/** Background refresh cadence once anything has asked (≥ 2 s rule). */
export const FLEET_LIVE_REFRESH_MS = 15_000;
/** needsYouItems refuses (activity reports the source as erroring) past this age. */
export const NEEDS_YOU_MAX_AGE_MS = 2 * 60_000;
/** A dispatch start with no terminal row is only "producing" this long (a crash leaves orphans). */
const IN_FLIGHT_MAX_AGE_MS = 3 * HOUR_MS;
const MAX_RUNS = 200;
const REVERT_NEEDS_YOU_MS = DAY_MS;

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface InFlightDispatch {
  runId: string;
  itemId: string | null;
  repoPath: string | null;
  backend: string | null;
  model: string | null;
  startedAt: string;
}

export interface FleetLiveDeps {
  now(): number;
  policy(): EffectivePolicy | null;
  killSwitch(): 'active' | 'inactive' | 'unknown';
  /** true = paused (or unreadable — dispatch treats that as paused). */
  paused(): boolean;
  liveness(): DaemonLivenessV1;
  tickState(): FleetTickStateV1 | null;
  journal(sinceMs: number): Promise<FleetJournalRecord[]>;
  ledger(opts: LedgerReadOptions): Promise<LedgerReadResult>;
  /** Throws when the hold store cannot be read (never read as "no holds"). */
  holds(nowMs: number): RepoHold[];
  setHold(req: SetRepoHoldRequest): RepoHoldChange;
  tasks(): TaskQueueRead;
  /** Dispatches started and not finished since `sinceMs`; null = unknown. */
  inFlight(sinceMs: number): InFlightDispatch[] | null;
  enrolled(): string[];
  repoIdentity(path: string): string | null;
  /** U4's open + recently finished watches. Throws when the store is corrupt (read as unknown). */
  watches(): PostMergeWatchView[];
  /** U4's post-merge green % over finished `merge` watches; throws like `watches`. */
  greenPct(opts: { repo?: string; sinceMs: number; nowMs: number }): { finished: number; green: number; pct: number | null };
}

function inFlightDefault(sinceMs: number): InFlightDispatch[] | null {
  const read = readAgentActionsDetailed({
    sinceMs,
    maxBytes: 4 * 1024 * 1024,
    inspectionOnly: true,
    filter: (event) => event.kind === 'dispatch',
  });
  if (read.sourceState === 'degraded') return null;
  const ended = new Set<string>();
  for (const event of read.events) {
    if (event.runId && (event.action === 'daemon:dispatch' || event.action === 'daemon:dispatch-skip')) ended.add(event.runId);
  }
  const out: InFlightDispatch[] = [];
  for (const event of read.events) {
    if (event.action !== 'daemon:dispatch-start' || !event.runId || ended.has(event.runId)) continue;
    out.push({
      runId: event.runId,
      itemId: event.itemId ?? null,
      repoPath: event.repo ?? null,
      backend: event.backend ?? null,
      model: event.model ?? null,
      startedAt: event.ts,
    });
  }
  return out;
}

function defaultDeps(): FleetLiveDeps {
  return {
    now: () => Date.now(),
    policy: () => currentStandingPolicy(),
    killSwitch: () => readKillSwitch().state,
    paused: () => daemonPaused(),
    liveness: () => probeDaemonLiveness(),
    tickState: () => readTickState(),
    journal: (sinceMs) => readJournalSince(sinceMs),
    ledger: (opts) => readLedger(opts),
    holds: (nowMs) => listRepoHolds({ nowMs }),
    setHold: (req) => setRepoHold(req),
    tasks: () => listTasks({ status: ['queued', 'parked'] }),
    inFlight: inFlightDefault,
    enrolled: () => listEnrolled(),
    repoIdentity: (path) => repoIdentityOfPath(path),
    watches: () => listPostMergeWatches(),
    greenPct: (opts) => postMergeGreenPct(opts),
  };
}

let deps: FleetLiveDeps = defaultDeps();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function msOf(at: string | null | undefined): number {
  if (!at) return Number.NaN;
  return Date.parse(at);
}

/** Local midnight of `nowMs` (the operator's "today"). */
function localDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function dirLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function pct(green: number, total: number): number | null {
  return total === 0 ? null : Math.round((green / total) * 1000) / 10;
}

/** The phase a proposal is in after passing `gate` (the NEXT gate's phase). */
function phaseAfterPass(gate: GateId): FleetPhase {
  const next = GATE_ORDER[GATE_ORDER.indexOf(gate) + 1] ?? null;
  if (next === null) return 'landing';
  return phaseOfGate(next);
}

function phaseOfGate(gate: GateId): FleetPhase {
  switch (gate) {
    case 'G4':
    case 'G5':
    case 'G6':
      return 'judging';
    case 'G7':
      return 'landing';
    default:
      return 'verifying';
  }
}

interface ProposalProgress {
  phase: FleetPhase;
  phaseStartedAt: string | null;
  endedAt: string | null;
  outcome: FleetRunOutcome | null;
  prNumber: number | null;
  landingId: string | null;
}

/**
 * Where each proposal is, from ledger rows (oldest first). Exported for the
 * tests; the Fleet swimlane draws one bar per phase transition from it.
 */
export function proposalProgressFromLedger(rows: readonly LedgerEntry[]): Map<string, ProposalProgress> {
  const out = new Map<string, ProposalProgress>();
  const proposalOfLanding = new Map<string, string>();
  const get = (id: string): ProposalProgress => {
    let p = out.get(id);
    if (!p) {
      p = { phase: 'verifying', phaseStartedAt: null, endedAt: null, outcome: null, prNumber: null, landingId: null };
      out.set(id, p);
    }
    return p;
  };
  const move = (p: ProposalProgress, phase: FleetPhase, at: string): void => {
    if (p.phase !== phase) {
      p.phase = phase;
      p.phaseStartedAt = at;
    } else if (p.phaseStartedAt === null) {
      p.phaseStartedAt = at;
    }
  };
  for (const row of rows) {
    switch (row.kind) {
      case 'gate:result': {
        const r = row.data;
        const p = get(r.proposalId);
        if (p.outcome !== null && p.outcome !== 'owner-lane') break;
        if (r.verdict === 'pass') move(p, phaseAfterPass(r.gate), r.at);
        else if (r.verdict === 'wait') move(p, phaseOfGate(r.gate), r.at);
        else if (r.verdict === 'owner-lane') {
          move(p, 'landing', r.at);
          p.outcome = 'owner-lane';
        } else {
          move(p, phaseOfGate(r.gate), r.at);
          p.outcome = 'refused';
          p.endedAt = r.at;
        }
        break;
      }
      case 'gate:would-merge': {
        const p = get(row.data.proposalId);
        move(p, 'landing', row.data.at);
        p.outcome = 'proposed';
        p.endedAt = row.data.at;
        break;
      }
      case 'pr:opened': {
        if (!row.data.proposalId || row.data.kind !== 'change') break;
        const p = get(row.data.proposalId);
        p.prNumber = row.data.number;
        if (p.outcome === null) move(p, 'landing', row.data.at);
        if (row.data.ownerLane) p.outcome = 'owner-lane';
        break;
      }
      case 'merge:landed': {
        const r = row.data;
        if (!r.proposalId) break;
        proposalOfLanding.set(r.id, r.proposalId);
        const p = get(r.proposalId);
        p.prNumber = r.prNumber;
        p.landingId = r.id;
        move(p, 'watching', r.landedAt);
        p.outcome = null;
        p.endedAt = null;
        break;
      }
      case 'post-merge:result': {
        const id = proposalOfLanding.get(row.data.landingId);
        if (!id) break;
        const p = get(id);
        if (row.data.verdict === 'green') {
          p.outcome = 'merged';
          p.endedAt = row.data.checkedAt;
        } else {
          move(p, 'reverting', row.data.checkedAt);
        }
        break;
      }
      case 'revert:landed': {
        const id = row.data.revertsLandingId ? proposalOfLanding.get(row.data.revertsLandingId) : undefined;
        if (!id) break;
        const p = get(id);
        move(p, 'reverting', row.data.landedAt);
        p.outcome = 'reverted';
        p.endedAt = row.data.landedAt;
        break;
      }
      case 'revert:failed': {
        const id = proposalOfLanding.get(row.data.landingId);
        if (!id) break;
        const p = get(id);
        p.outcome = 'failed';
        p.endedAt = row.at;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** The gate funnel over rows inside [fromMs, toMs]. */
export function gateFunnelFromLedger(rows: readonly LedgerEntry[], fromMs: number, toMs: number): FleetGateFunnel {
  // The last row per (proposal, gate) is what that gate decided.
  const last = new Map<string, { gate: GateId; verdict: string; code: string; reason: string }>();
  for (const row of rows) {
    if (row.kind !== 'gate:result') continue;
    const at = msOf(row.data.at);
    if (!(at >= fromMs && at <= toMs)) continue;
    last.set(`${row.data.proposalId}|${row.data.gate}`, {
      gate: row.data.gate,
      verdict: row.data.verdict,
      code: row.data.code,
      reason: row.data.reason,
    });
  }
  const stages: FleetFunnelStage[] = GATE_ORDER.map((gate) => ({ gate, entered: 0, passed: 0, refusals: [] }));
  const refusals = new Map<string, Map<string, { reason: string; count: number }>>();
  for (const decision of last.values()) {
    const stage = stages.find((s) => s.gate === decision.gate)!;
    stage.entered += 1;
    if (decision.verdict === 'pass') {
      stage.passed += 1;
      continue;
    }
    const code = decision.verdict === 'refuse' ? decision.code : `${decision.verdict}:${decision.code}`;
    const byCode = refusals.get(decision.gate) ?? new Map<string, { reason: string; count: number }>();
    const entry = byCode.get(code) ?? { reason: scrubSecrets(decision.reason).slice(0, 300), count: 0 };
    entry.count += 1;
    byCode.set(code, entry);
    refusals.set(decision.gate, byCode);
  }
  for (const stage of stages) {
    const byCode = refusals.get(stage.gate);
    if (!byCode) continue;
    stage.refusals = [...byCode.entries()]
      .map(([code, v]) => ({ code, reason: v.reason, count: v.count }))
      .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));
  }
  return { from: iso(fromMs), to: iso(toMs), stages };
}

function postMergeGreen(rows: readonly LedgerEntry[], repo: string | null, fromMs: number, toMs: number): { green: number; total: number } {
  let green = 0;
  let total = 0;
  for (const row of rows) {
    if (row.kind !== 'post-merge:result') continue;
    if (repo !== null && !sameRepo(row.data.repo, repo)) continue;
    const at = msOf(row.data.checkedAt);
    if (!(at >= fromMs && at < toMs)) continue;
    total += 1;
    if (row.data.verdict === 'green') green += 1;
  }
  return { green, total };
}

function landingsOf(rows: readonly LedgerEntry[], kind: 'merge:landed' | 'revert:landed'): LandingRecord[] {
  const out: LandingRecord[] = [];
  for (const row of rows) if (row.kind === kind) out.push(row.data);
  return out;
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

interface BuiltState {
  atMs: number;
  snapshot: FleetLiveSnapshotV1;
  needsYou: NeedsYouItem[];
  /** Why needsYou cannot vouch for an all-clear; null when it can. */
  needsYouProblem: string | null;
}

const LEDGER_KINDS: NonNullable<LedgerReadOptions['kinds']> = [
  'gate:result',
  'gate:would-merge',
  'pr:opened',
  'pr:closed',
  'pr:reopened',
  'merge:landed',
  'post-merge:result',
  'revert:landed',
  'revert:failed',
];

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const UNKNOWN_LIVENESS: DaemonLivenessV1 = {
  v: 1,
  checkedAt: new Date(0).toISOString(),
  state: 'unknown',
  alive: null,
  pid: null,
  recorded: { running: null, pid: null, startedAt: null, lastTickAt: null },
  lock: null,
  activity: null,
  staleRecord: false,
  reason: 'Daemon liveness could not be probed.',
};

function formatDay(atIso: string | null): string {
  if (!atIso) return 'an unknown time';
  const ms = msOf(atIso);
  if (!Number.isFinite(ms)) return 'an unknown time';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Build the snapshot and the Needs-you items from every source. Never throws. */
export async function buildFleetLiveSnapshot(d: FleetLiveDeps = deps): Promise<BuiltState> {
  const nowMs = d.now();
  const generatedAt = iso(nowMs);
  const since12h = nowMs - 12 * HOUR_MS;
  const since7d = nowMs - 7 * DAY_MS;
  const since30d = nowMs - 30 * DAY_MS;
  const todayMs = localDayStart(nowMs);

  const policy = safely(() => d.policy(), null);
  const kill = safely(() => d.killSwitch(), 'unknown' as const);
  const paused = safely(() => d.paused(), true);
  const live = safely(() => d.liveness(), UNKNOWN_LIVENESS);
  const tick = safely(() => d.tickState(), null);
  const problems: string[] = [];

  let rows: LedgerEntry[] | null = null;
  try {
    const read = await d.ledger({ sinceAt: iso(since30d), kinds: LEDGER_KINDS });
    if (read.chain === 'broken') problems.push(`the authority ledger is broken (${read.reason ?? 'no reason given'})`);
    else rows = read.entries;
  } catch {
    problems.push('the authority ledger could not be read');
  }
  let holds: RepoHold[] | null = null;
  try {
    holds = d.holds(nowMs);
  } catch {
    problems.push('repo holds could not be read');
  }
  let journal: FleetJournalRecord[] = [];
  let journalKnown = true;
  try {
    journal = await d.journal(since12h);
  } catch {
    journalKnown = false;
  }
  const tasks = safely(() => d.tasks(), { ok: false, reason: 'the task queue could not be read' } as TaskQueueRead);
  const inFlightRaw = live.alive === true ? safely(() => d.inFlight(since12h), null) : [];
  const inFlight = (inFlightRaw ?? []).filter((f) => nowMs - msOf(f.startedAt) <= IN_FLIGHT_MAX_AGE_MS);

  // Enrolled path → owner/name.
  const identity = new Map<string, string | null>();
  const repoLabel = (path: string | null): string => {
    if (!path) return 'unknown';
    if (!identity.has(path)) identity.set(path, safely(() => d.repoIdentity(path), null));
    return identity.get(path) ?? dirLabel(path);
  };
  const enrolled = safely(() => d.enrolled(), [] as string[]);
  for (const path of enrolled) repoLabel(path);

  // ── Runs ────────────────────────────────────────────────────────────────
  const progress = rows ? proposalProgressFromLedger(rows) : new Map<string, ProposalProgress>();
  // U4's watch store is live where the ledger is final: a watch that saw red
  // CI is `reverting` before any post-merge row exists. Only proposals still
  // open (no outcome) move; a finished outcome in the ledger always wins.
  let watches: PostMergeWatchView[] | null = null;
  try {
    watches = d.watches();
  } catch {
    problems.push('the post-merge watches could not be read');
  }
  if (watches) {
    const proposalOfLanding = new Map<string, ProposalProgress>();
    for (const p of progress.values()) if (p.landingId) proposalOfLanding.set(p.landingId, p);
    for (const view of watches) {
      if (view.phase === 'done' || view.kind !== 'merge') continue;
      const p = proposalOfLanding.get(view.landingId);
      if (!p || p.outcome !== null) continue;
      if (p.phase !== view.phase) {
        p.phase = view.phase;
        p.phaseStartedAt = view.checkedAt ?? view.landedAt;
      }
    }
  }
  /** Post-merge green %: U4's watch store, else the ledger's verdict rows (null = unknown / none). */
  const greenPctOf = (repo: string | null, fromMs: number): number | null => {
    if (watches) {
      try {
        const g = d.greenPct({ ...(repo !== null ? { repo } : {}), sinceMs: fromMs, nowMs });
        if (g.finished > 0) return g.pct;
      } catch { /* fall through to the ledger */ }
    }
    if (!rows) return null;
    const g = postMergeGreen(rows, repo, fromMs, nowMs + 1);
    return pct(g.green, g.total);
  };
  const runs = new Map<string, FleetLiveRun>();
  for (const f of inFlight) {
    runs.set(f.runId, {
      id: f.runId,
      taskId: null,
      repo: repoLabel(f.repoPath),
      title: f.itemId ?? 'dispatch',
      lane: fleetLaneOf(f.backend),
      seatId: null,
      engine: f.backend,
      model: f.model,
      phase: 'producing',
      startedAt: f.startedAt,
      phaseStartedAt: f.startedAt,
      endedAt: null,
      outcome: null,
      prNumber: null,
      hold: null,
      seatDecision: null,
    });
  }
  const heldByItem = new Map<string, FleetLiveRun>();
  const dispatchedItems = new Set<string>();
  for (const row of journal) {
    if (row.type !== 'dispatch') continue;
    if (!row.dispatched) {
      if (!row.hold) continue;
      heldByItem.set(row.itemId, {
        id: `held:${row.itemId}`,
        taskId: row.taskId,
        repo: row.repo,
        title: row.title,
        lane: null,
        seatId: null,
        engine: null,
        model: null,
        phase: 'parked',
        startedAt: null,
        phaseStartedAt: row.at,
        endedAt: null,
        outcome: null,
        prNumber: null,
        hold: row.hold,
        seatDecision: row.seatDecision,
      });
      continue;
    }
    dispatchedItems.add(row.itemId);
    const id = row.runId ?? `${row.itemId}@${row.at}`;
    const started = runs.get(id);
    const base: FleetLiveRun = {
      id,
      taskId: row.taskId,
      repo: row.repo,
      title: row.title,
      lane: row.lane,
      seatId: row.seatId,
      engine: row.backend,
      model: row.model,
      phase: 'producing',
      startedAt: started?.startedAt ?? null,
      phaseStartedAt: started?.startedAt ?? null,
      endedAt: row.at,
      outcome: 'failed',
      prNumber: null,
      hold: null,
      seatDecision: row.seatDecision,
    };
    if (row.proposalId) {
      const p = progress.get(row.proposalId);
      runs.set(id, {
        ...base,
        phase: p?.phase ?? 'verifying',
        phaseStartedAt: p?.phaseStartedAt ?? row.at,
        endedAt: p?.endedAt ?? null,
        outcome: p?.outcome ?? null,
        prNumber: p?.prNumber ?? null,
      });
    } else {
      runs.set(id, base);
    }
  }
  for (const [itemId, run] of heldByItem) {
    if (!dispatchedItems.has(itemId)) runs.set(run.id, run);
  }
  for (const held of tick?.held ?? []) {
    const id = `held:${held.itemId}`;
    if (runs.has(id) || dispatchedItems.has(held.itemId)) continue;
    runs.set(id, {
      id,
      taskId: null,
      repo: held.repo,
      title: held.title,
      lane: null,
      seatId: null,
      engine: null,
      model: null,
      phase: 'parked',
      startedAt: null,
      phaseStartedAt: held.at,
      endedAt: null,
      outcome: null,
      prNumber: null,
      hold: held.hold,
      seatDecision: held.seatDecision,
    });
  }
  let queuedTasks: number | null = null;
  let parkedTasks: number | null = null;
  if (tasks.ok) {
    queuedTasks = 0;
    parkedTasks = 0;
    for (const task of tasks.tasks) {
      if (task.status !== 'queued' && task.status !== 'parked') continue;
      if (task.status === 'queued') queuedTasks += 1;
      else parkedTasks += 1;
      runs.set(`task:${task.id}`, {
        id: `task:${task.id}`,
        taskId: task.id,
        repo: task.repo,
        title: task.title,
        lane: null,
        seatId: null,
        engine: null,
        model: null,
        phase: task.status,
        startedAt: null,
        phaseStartedAt: task.updatedAt,
        endedAt: null,
        outcome: null,
        prNumber: null,
        hold: task.status === 'parked'
          ? {
              kind: task.parkedUntil === null ? 'split' : 'park',
              reason: task.parkedUntil === null
                ? 'Parked: too large for any seat — it needs splitting into smaller slices.'
                : `Parked until ${task.parkedUntil}, when a seat is expected to reopen.`,
              nextEligibleAt: task.parkedUntil,
            }
          : null,
        seatDecision: null,
      });
    }
  }
  const runList = [...runs.values()]
    .sort((a, b) => {
      const at = (r: FleetLiveRun): number => Math.max(msOf(r.phaseStartedAt) || 0, msOf(r.endedAt) || 0, msOf(r.startedAt) || 0);
      return at(b) - at(a);
    })
    .slice(0, MAX_RUNS);

  // ── Summary ─────────────────────────────────────────────────────────────
  const merges = rows ? landingsOf(rows, 'merge:landed') : null;
  const reverts = rows ? landingsOf(rows, 'revert:landed') : null;
  const building = journalKnown && inFlightRaw !== null
    ? runList.filter((r) => r.endedAt === null && (r.phase === 'producing' || r.phase === 'verifying' || r.phase === 'judging' || r.phase === 'landing')).length
    : null;
  const heldCount = runList.filter((r) => r.phase === 'parked' && r.taskId === null).length;

  const cycle = merges
    ? median(merges
      .filter((m) => msOf(m.landedAt) >= since7d && m.proposedAt !== null)
      .map((m) => msOf(m.landedAt) - msOf(m.proposedAt))
      .filter((ms) => Number.isFinite(ms) && ms >= 0))
    : null;
  const summary: FleetLiveSummary = {
    building,
    queued: queuedTasks,
    parked: parkedTasks === null ? null : parkedTasks + heldCount,
    waitingVerify: tick?.waitingVerify ?? null,
    mergedToday: merges ? merges.filter((m) => msOf(m.landedAt) >= todayMs).length : null,
    revertsToday: reverts ? reverts.filter((m) => msOf(m.landedAt) >= todayMs).length : null,
    merged7d: merges ? merges.filter((m) => msOf(m.landedAt) >= since7d).length : null,
    postMergeGreenPct7d: greenPctOf(null, since7d),
    cycleTimeP50Ms7d: cycle,
  };

  // ── Lanes ───────────────────────────────────────────────────────────────
  const busy: Partial<Record<FleetEngine, number>> = {};
  for (const run of runList) {
    if (run.phase === 'producing' && run.endedAt === null && run.lane) busy[run.lane] = (busy[run.lane] ?? 0) + 1;
  }

  // ── State ───────────────────────────────────────────────────────────────
  const lastActivityCandidates = [
    tick?.at ?? null,
    live.recorded.lastTickAt,
    journal.length > 0 ? journal[journal.length - 1]!.at : null,
    rows && rows.length > 0 ? rows[rows.length - 1]!.at : null,
  ].filter((v): v is string => typeof v === 'string' && Number.isFinite(msOf(v)));
  const lastActivityAt = lastActivityCandidates.length > 0
    ? lastActivityCandidates.reduce((a, b) => (msOf(a) >= msOf(b) ? a : b))
    : null;
  let state: FleetLiveState;
  let stateReason: string | null;
  if (kill === 'active') {
    state = 'stopped';
    stateReason = 'Stop is in force — the kill switch is engaged.';
  } else if (kill === 'unknown') {
    state = 'stopped';
    stateReason = 'The kill switch could not be read, so the fleet is treated as stopped.';
  } else if (policy === null) {
    state = 'dark';
    stateReason = `No standing grant is in force. Fleet dark since ${formatDay(lastActivityAt)}.`;
  } else if (live.alive !== true) {
    state = 'dark';
    stateReason = `${live.reason} Fleet dark since ${formatDay(lastActivityAt)}.`;
  } else if (paused) {
    state = 'paused';
    stateReason = 'Autonomous dispatch is paused (the daemon is parked; your own tools are unaffected).';
  } else if ((building ?? 0) > 0) {
    state = 'running';
    stateReason = tick?.holdProduction ? `New work is held: ${tick.holdProduction}` : null;
  } else {
    state = 'idle';
    stateReason = tick?.holdProduction ? `New work is held: ${tick.holdProduction}` : null;
  }
  if (problems.length > 0) stateReason = `${stateReason ? `${stateReason} ` : ''}Unknown: ${problems.join('; ')}.`;

  const standingTickFresh = tick !== null && tick.standing !== null && nowMs - msOf(tick.at) <= 10 * 60_000;
  const lanes: FleetLaneState[] = standingTickFresh
    ? tick.lanes.map((lane) => ({ ...lane, busy: busy[lane.lane] ?? 0 }))
    : FLEET_ENGINES.map((lane) => ({
        lane,
        slots: 0,
        busy: busy[lane] ?? 0,
        capReason: state === 'dark' || state === 'stopped' || state === 'paused'
          ? stateReason ?? 'The fleet is not running.'
          : 'No standing tick has reported lanes in the last 10 minutes.',
      }));

  // ── Funnel ──────────────────────────────────────────────────────────────
  const funnel = rows ? gateFunnelFromLedger(rows, since7d, nowMs) : null;

  // ── Repos ───────────────────────────────────────────────────────────────
  const repoNames = new Set<string>();
  for (const r of policy?.repos ?? []) repoNames.add(r.nameWithOwner);
  for (const path of enrolled) {
    const nwo = identity.get(path);
    if (nwo) repoNames.add(nwo);
  }
  for (const h of holds ?? []) repoNames.add(h.repo);
  const openPrs = rows ? openFleetPrsFromLedger(rows) : null;
  const repos: FleetRepoRow[] = [...repoNames]
    .filter((name) => STANDING_GRANT_PATTERNS.nameWithOwner.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((repo) => {
      const grant = policy?.repos.find((r) => sameRepo(r.nameWithOwner, repo)) ?? null;
      const repoMerges = merges?.filter((m) => sameRepo(m.repo, repo)) ?? null;
      const lastMerge = repoMerges && repoMerges.length > 0
        ? repoMerges.reduce((a, b) => (msOf(a.landedAt) >= msOf(b.landedAt) ? a : b)).landedAt
        : null;
      const trend: (number | null)[] = [];
      for (let i = 13; i >= 0; i -= 1) {
        const dayStart = localDayStart(todayMs - i * DAY_MS + 12 * HOUR_MS);
        if (!rows) {
          trend.push(null);
          continue;
        }
        const g = postMergeGreen(rows, repo, dayStart, dayStart + DAY_MS);
        trend.push(pct(g.green, g.total));
      }
      return {
        repo,
        stage: grant?.stage ?? null,
        enforcement: grant?.enforcement ?? null,
        lastMergeAt: repoMerges === null ? null : lastMerge,
        mergesToday: repoMerges ? repoMerges.filter((m) => msOf(m.landedAt) >= todayMs).length : null,
        maxMergesPerDay: grant?.maxMergesPerDay ?? null,
        greenPct7d: greenPctOf(repo, since7d),
        greenTrend: trend,
        openFleetPrs: openPrs === null ? null : Object.entries(openPrs).reduce((n, [k, v]) => (sameRepo(k, repo) ? n + v : n), 0),
        holds: (holds ?? []).filter((h) => sameRepo(h.repo, repo)),
      };
    });

  const snapshot: FleetLiveSnapshotV1 = {
    v: 1,
    generatedAt,
    state,
    stateReason,
    lastActivityAt,
    summary,
    lanes,
    runs: runList,
    funnel,
    repos,
  };

  // ── Needs you (R1) ──────────────────────────────────────────────────────
  const needsYouProblem = holds === null
    ? 'repo holds could not be read'
    : rows === null
      ? 'the authority ledger could not be read'
      : null;
  const needsYou = needsYouProblem === null ? needsYouFrom(holds ?? [], rows ?? [], nowMs) : [];
  return { atMs: nowMs, snapshot, needsYou, needsYouProblem };
}

// ---------------------------------------------------------------------------
// Needs-you items
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  const clean = scrubSecrets(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function prUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

function resumeAction(repo: string, kind: RepoHoldKind, label: string, body: string): NeedsYouItem['actions'][number] {
  return {
    kind: 'resume',
    label,
    request: { method: 'POST', path: VERSE_FLEET_LIVE_PATH, body: { action: 'resume-repo', repo, kind } },
    confirm: { title: `Resume ${repo}?`, body, confirmLabel: 'Resume' },
    destructive: false,
  };
}

/** Pure: the fleet's Needs-you items from holds and ledger rows. */
export function needsYouFrom(holds: readonly RepoHold[], rows: readonly LedgerEntry[], nowMs: number): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const subject = (repo: string, pr: number | null = null): NeedsYouItem['subject'] => ({
    repo,
    pr,
    seatId: null,
    sessionId: null,
    engine: null,
  });
  for (const hold of holds) {
    if (hold.kind === 'owner-hold') {
      items.push({
        id: `fleet:owner-hold:${hold.repo}`,
        source: 'fleet',
        kind: 'owner-hold',
        severity: 'high',
        title: clip(`${hold.repo} is on owner-hold — the fleet will not touch it until you resume it`, 120),
        detail: clip(hold.reason, 400),
        since: hold.since,
        expiresAt: hold.until,
        subject: subject(hold.repo),
        target: { kind: 'section', section: 'fleet', anchor: `repo:${hold.repo}` },
        actions: [resumeAction(hold.repo, 'owner-hold', 'Resume repo',
          'Clears the owner-hold. The fleet may produce and merge there again, within the grant.')],
      });
    } else if (hold.kind === 'quarantine') {
      items.push({
        id: `fleet:quarantine:${hold.repo}`,
        source: 'fleet',
        kind: 'quarantine',
        severity: 'warn',
        title: clip(`${hold.repo} is quarantined after a red post-merge check${hold.until ? ` (until ${new Date(msOf(hold.until)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })})` : ''}`, 120),
        detail: clip(hold.reason, 400),
        since: hold.since,
        expiresAt: hold.until,
        subject: subject(hold.repo),
        target: { kind: 'section', section: 'fleet', anchor: `repo:${hold.repo}` },
        actions: [resumeAction(hold.repo, 'quarantine', 'Resume early',
          'Ends the quarantine now instead of at its expiry. Do this only if you know the red check is fixed.')],
      });
    }
  }
  // Reverts in the last 24 h, with the verdict that caused them when known.
  const resultByLanding = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === 'post-merge:result' && row.data.verdict === 'red') resultByLanding.set(row.data.landingId, row.data.detail);
  }
  for (const row of rows) {
    if (row.kind !== 'revert:landed') continue;
    const r = row.data;
    const at = msOf(r.landedAt);
    if (!(nowMs - at <= REVERT_NEEDS_YOU_MS)) continue;
    const why = r.revertsLandingId ? resultByLanding.get(r.revertsLandingId) ?? null : null;
    items.push({
      id: `fleet:revert:${r.id}`,
      source: 'fleet',
      kind: 'revert',
      severity: 'warn',
      title: clip(`A fleet merge on ${r.repo} was reverted (revert PR #${r.prNumber})`, 120),
      detail: why ? clip(why, 400) : null,
      since: r.landedAt,
      expiresAt: iso(at + REVERT_NEEDS_YOU_MS),
      subject: subject(r.repo, r.prNumber),
      target: { kind: 'url', url: prUrl(r.repo, r.prNumber) },
      actions: [],
    });
  }
  // Open owner-lane PRs.
  const open = new Map<string, { repo: string; number: number; at: string; ownerLane: boolean }>();
  for (const row of rows) {
    if (row.kind === 'pr:opened' && row.data.kind === 'change') {
      open.set(`${row.data.repo.toLowerCase()}#${row.data.number}`, { repo: row.data.repo, number: row.data.number, at: row.data.at, ownerLane: row.data.ownerLane });
    } else if (row.kind === 'pr:closed') {
      open.delete(`${row.data.repo.toLowerCase()}#${row.data.number}`);
    } else if (row.kind === 'merge:landed' || row.kind === 'revert:landed') {
      open.delete(`${row.data.repo.toLowerCase()}#${row.data.prNumber}`);
    }
  }
  for (const pr of open.values()) {
    if (!pr.ownerLane) continue;
    items.push({
      id: `fleet:owner-lane-pr:${pr.repo}#${pr.number}`,
      source: 'fleet',
      kind: 'owner-lane-pr',
      severity: 'info',
      title: clip(`Owner-lane PR #${pr.number} on ${pr.repo} waits for your review`, 120),
      detail: 'It touches a protected path, so the fleet will never merge it — only you can.',
      since: pr.at,
      expiresAt: null,
      subject: subject(pr.repo, pr.number),
      target: { kind: 'url', url: prUrl(pr.repo, pr.number) },
      actions: [],
    });
  }
  const rank = { high: 0, warn: 1, info: 2 } as const;
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || msOf(b.since) - msOf(a.since));
}

// ---------------------------------------------------------------------------
// Cache + refresher
// ---------------------------------------------------------------------------

let cache: BuiltState | null = null;
let inflight: Promise<BuiltState> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function refresh(): Promise<BuiltState> {
  if (inflight) return inflight;
  inflight = buildFleetLiveSnapshot(deps)
    .then((built) => {
      cache = built;
      return built;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function ensureRefresher(): void {
  if (timer) return;
  timer = setInterval(() => {
    void refresh().catch(() => undefined);
  }, FLEET_LIVE_REFRESH_MS);
  (timer as { unref?: () => void }).unref?.();
}

/** Test hook: replace (or with no argument restore) the dependencies; drops the cache and stops the refresher. */
export function setFleetLiveDepsForTest(next?: Partial<FleetLiveDeps>): void {
  deps = next ? { ...defaultDeps(), ...next } : defaultDeps();
  resetFleetLiveApiForTest();
}

/** Test hook: drop the cache and stop the background refresher. */
export function resetFleetLiveApiForTest(): void {
  cache = null;
  inflight = null;
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * R1 (SPEC-310BC-COORD §4): the fleet's Needs-you items — owner-hold and
 * quarantined repos, reverts in the last 24 h, open owner-lane PRs. Stop is
 * the authority source's item (authority-api), not duplicated here.
 *
 * PURE and served from cache: no I/O on the caller's stack. With no snapshot
 * yet, one too old, or a source that could not be read, it THROWS — activity
 * then reports the fleet source as erroring instead of an all-clear it cannot
 * vouch for — and schedules a refresh off the caller's stack.
 */
export function needsYouItems(): NeedsYouItem[] {
  ensureRefresher();
  const current = cache;
  const nowMs = Date.now();
  if (!current || nowMs - current.atMs > NEEDS_YOU_MAX_AGE_MS) {
    setImmediate(() => {
      void refresh().catch(() => undefined);
    });
    throw new Error(current ? 'fleet state is stale; refreshing' : 'fleet state has not been read yet; reading');
  }
  if (current.needsYouProblem !== null) throw new Error(`fleet state is incomplete: ${current.needsYouProblem}`);
  return current.needsYou.map((item) => ({ ...item, actions: item.actions.map((a) => ({ ...a })) }));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface FleetLiveActionResult {
  ok: boolean;
  /** The server's own sentence about what happened, rendered verbatim. */
  note: string;
  /** The (repo, kind) holds changed, before and after. */
  changes: RepoHoldChange[];
  snapshot: FleetLiveSnapshotV1 | null;
}

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
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

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const own = Object.keys(value);
  if (!required.every((k) => Object.prototype.hasOwnProperty.call(value, k))) return false;
  return own.every((k) => required.includes(k) || optional.includes(k));
}

async function applyAction(res: ServerResponse, body: Record<string, unknown>): Promise<void> {
  const action = body['action'];
  const repo = body['repo'];
  if (typeof repo !== 'string' || !STANDING_GRANT_PATTERNS.nameWithOwner.test(repo)) {
    sendInvalid(res, 'repo must be a GitHub owner/name');
    return;
  }
  const changes: RepoHoldChange[] = [];
  let note: string;
  let ok = true;
  if (action === 'pause-repo') {
    if (!exactKeys(body, ['action', 'repo', 'reason'])) {
      sendInvalid(res, 'pause-repo takes exactly {action, repo, reason}');
      return;
    }
    const reason = body['reason'];
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 400) {
      sendInvalid(res, 'reason must be a non-empty sentence of at most 400 characters');
      return;
    }
    const change = deps.setHold({
      repo,
      kind: 'owner-hold',
      hold: { reason: clip(`Paused by you: ${reason}`, 480), until: null },
      actor: 'mason',
    });
    changes.push(change);
    ok = change.ok;
    note = change.ok
      ? `${repo} is paused (owner-hold). The fleet produces and merges nothing there until you resume it.`
      : `${repo} could not be paused: ${change.reason ?? 'the hold store refused the change'}.`;
  } else if (action === 'resume-repo') {
    if (!exactKeys(body, ['action', 'repo'], ['kind'])) {
      sendInvalid(res, 'resume-repo takes {action, repo} and an optional kind');
      return;
    }
    const kind = body['kind'];
    if (kind !== undefined && !(REPO_HOLD_KINDS as readonly unknown[]).includes(kind)) {
      sendInvalid(res, `kind must be one of: ${REPO_HOLD_KINDS.join(', ')}`);
      return;
    }
    let kinds: RepoHoldKind[];
    if (kind !== undefined) {
      kinds = [kind as RepoHoldKind];
    } else {
      let active: RepoHold[];
      try {
        active = deps.holds(deps.now()).filter((h) => sameRepo(h.repo, repo));
      } catch {
        sendJson(res, 409, {
          ok: false,
          note: `${repo} was not resumed: its holds could not be read, so it is not known what to clear.`,
          changes: [],
          snapshot: null,
        } satisfies FleetLiveActionResult);
        return;
      }
      kinds = [...new Set(active.map((h) => h.kind))];
    }
    if (kinds.length === 0) {
      note = `${repo} has no active hold to clear.`;
    } else {
      for (const k of kinds) {
        const change = deps.setHold({ repo, kind: k, hold: null, actor: 'mason' });
        changes.push(change);
        if (!change.ok) ok = false;
      }
      const failed = changes.filter((c) => !c.ok);
      note = failed.length === 0
        ? `${repo} resumed (${kinds.join(' + ')} cleared). The fleet may work there again within the grant.`
        : `${repo} was not fully resumed: ${failed.map((c) => c.reason ?? 'refused').join('; ')}.`;
    }
  } else {
    sendInvalid(res, 'action must be one of: pause-repo, resume-repo');
    return;
  }
  try {
    audit({
      action: `verse:fleet:${action}`,
      repo,
      sandboxId: null,
      summary: note,
      result: ok ? 'ok' : 'refused',
    });
  } catch { /* audit is best effort */ }
  // The hold changed: the next read must not serve the old snapshot.
  cache = null;
  let snapshot: FleetLiveSnapshotV1 | null = null;
  try {
    snapshot = (await refresh()).snapshot;
  } catch {
    snapshot = null;
  }
  sendJson(res, ok ? 200 : 409, { ok, note, changes, snapshot } satisfies FleetLiveActionResult);
}

/**
 * The Fleet live route family. Owns exactly `/api/verse/fleet/live` — never
 * `/api/verse/fleet/history` (Track A's module). Returns false for anything
 * else so the next module (or the 404) runs.
 */
export const handleFleetLiveApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path !== VERSE_FLEET_LIVE_PATH) return false;
  try {
    if (method === 'GET') {
      let params: URLSearchParams;
      try {
        params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      } catch {
        sendInvalid(res, 'invalid query string');
        return true;
      }
      for (const key of params.keys()) {
        sendInvalid(res, `unknown query parameter: ${key}`);
        return true;
      }
      ensureRefresher();
      const current = cache && deps.now() - cache.atMs <= GET_MAX_AGE_MS ? cache : await refresh();
      sendJson(res, 200, current.snapshot);
      return true;
    }
    if (method === 'POST') {
      const body = await readMutationBody(ctx, req, res);
      if (!body) return true;
      await applyAction(res, body);
      return true;
    }
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch {
    sendJson(res, 500, { error: 'fleet live request failed' });
    return true;
  }
};


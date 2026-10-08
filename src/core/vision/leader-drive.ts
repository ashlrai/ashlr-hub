/**
 * The Leader's self-improvement drive (3.15) — every day it picks the
 * highest-leverage improvements to Phantom and launches them through the
 * cheapest capable lane, within budgets, then reports what happened.
 *
 * WHERE IDEAS COME FROM (all local reads, deterministic):
 *   retros       recurring failure causes over 14 days (learn/retro, #535)
 *   failures     the Leader's own run failures (leader state)
 *   needs-you    escalations that sat unanswered (friction for Mason)
 *   usage        cloud tasks that failed / expired (lane reliability)
 *   competitive  the open gates in docs/VERSE-COMPETITIVE-ACCEPTANCE.md
 *
 * HOW IT PICKS (`selectImprovements`, pure): highest leverage first, one per
 * idea per cooldown, optional explicit daily limits, and never a paid lane
 * in reserve mode or when that lane's own budget gate says no. Lanes, cheapest capable first:
 *   small → fleet   (work.dispatch — local / grok, free)
 *   PR    → cloud   (cloud.launch purpose self-improve — the cloud budget's
 *                    stricter self-improvement gate), else
 *           devin   (devin.launch — fleet origin, Devin reserve), else
 *           backlog (backlog.add — queued, spends nothing)
 *
 * AUTHORITY: every pick becomes an ordinary action through leader-apply's
 * `enactLeaderActions` — the same classification, dry-run rule, ledger rows,
 * veto windows and budget gates as a memo's actions. The drive adds no power.
 *
 * `enactDirectLeaderActions` is the shared entry for work that did not come
 * from a memo (the drive, and Mason's "go build X" on the Telegram line,
 * where his request is his approval of a class-B launch — applied at once
 * through `applyApprovedLeaderAction`, which re-checks the grant).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BudgetMode } from '../routing/types.js';
import type { CloudTaskV1 } from '../cloud/types.js';
import type { RetroV1 } from '../learn/retro/types.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { applyApprovedLeaderAction, enactLeaderActions, isLeaderDryRun, listLeaderActions, type LeaderApplyDeps } from './leader-apply.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { actionIdFor, buildLeaderActionDraft, leaderRoot, newMemoId, type AnyLeaderActionDraft } from './leader-memo.js';
import type { LeaderAction } from './leader-types.js';
import type { LeaderRunDeps } from './leader.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const DRIVE_LIMITS = Object.freeze({
  /** No arbitrary daily work ceiling; resource admission remains authoritative. */
  maxPerDay: null,
  /** Paid launches still pass each lane's live budget and reserve gates. */
  maxPaidPerDay: null,
  /** An idea is not picked again within this many days. */
  cooldownDays: 7,
  /** Local hour (America/New_York by default) the drive may run from — after the morning brief. */
  fromHour: 9,
  retroWindowDays: 14,
  historyKeep: 200,
});

export const VERSE_REPO = 'ashlrai/phantom';

// ---------------------------------------------------------------------------
// Candidates (pure)
// ---------------------------------------------------------------------------

export type ImprovementSource = 'retro' | 'failure' | 'needs-you' | 'usage' | 'competitive';

export interface ImprovementCandidate {
  /** Stable across days (the cooldown keys on it). */
  id: string;
  title: string;
  /** A complete brief for the worker (what, why, how to verify). */
  brief: string;
  source: ImprovementSource;
  /** Higher = more leverage. Deterministic from the evidence. */
  leverage: number;
  size: 'small' | 'pr';
  evidence: string;
}

export interface DriveInputs {
  retros: readonly Pick<RetroV1, 'endKind' | 'endedAt' | 'rootCause' | 'repo'>[];
  leader: { consecutiveFailures: number; lastFailureReason: string | null };
  /** Escalated (class C) Leader actions and how long they have waited. */
  escalations: readonly Pick<LeaderAction, 'id' | 'createdAt' | 'status' | 'summary'>[];
  cloudTasks: readonly Pick<CloudTaskV1, 'state' | 'updatedAt' | 'failure'>[];
  /** docs/VERSE-COMPETITIVE-ACCEPTANCE.md text; null = not available. */
  competitive: string | null;
}

const FAILURE_END_KINDS = new Set(['reverted', 'closed', 'gate-refused', 'owner-laned', 'verify-failed', 'failed', 'expired', 'vetoed']);

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function brief(what: string, evidence: string): string {
  return `In ${VERSE_REPO} (Phantom): ${what}\n\nEvidence: ${evidence}\n\nFirst verify the premise against the code; if it is already fixed, say so and stop. Otherwise deliver one focused change with tests that prove it, and say in the PR how you verified it.`;
}

/** The open gates of the competitive acceptance table: `| Gate | Evidence | Current boundary |`. */
export function competitiveGaps(doc: string): { gate: string; boundary: string }[] {
  const out: { gate: string; boundary: string }[] = [];
  let inTable = false;
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (/^\|\s*Gate\s*\|/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.trim().startsWith('|')) {
      inTable = false;
      continue;
    }
    if (/^[-\s|:]+$/.test(line)) continue;
    const gate = cells[1];
    const boundary = cells[3];
    if (gate && boundary) out.push({ gate, boundary });
  }
  return out;
}

export function collectImprovementCandidates(inputs: DriveInputs, nowMs: number): ImprovementCandidate[] {
  const out: ImprovementCandidate[] = [];
  const since = nowMs - DRIVE_LIMITS.retroWindowDays * 86_400_000;

  // Retros: recurring failure causes.
  const causes = new Map<string, { label: string; detail: string; count: number }>();
  for (const r of inputs.retros) {
    if (!FAILURE_END_KINDS.has(r.endKind) || !r.rootCause) continue;
    const at = Date.parse(r.endedAt);
    if (!Number.isFinite(at) || at < since) continue;
    const c = causes.get(r.rootCause.code) ?? { label: r.rootCause.label, detail: r.rootCause.detail, count: 0 };
    c.count += 1;
    causes.set(r.rootCause.code, c);
  }
  for (const [code, c] of causes) {
    if (c.count < 2) continue;
    const title = clip(`Stop "${c.label}" failures (${c.count} in ${DRIVE_LIMITS.retroWindowDays}d)`, 120);
    const evidence = `${c.count} fleet/cloud tasks ended with root cause ${code} in the last ${DRIVE_LIMITS.retroWindowDays} days; latest: ${clip(c.detail, 200)}`;
    out.push({ id: `retro:${code}`, title, brief: brief(`remove the cause of the recurring "${c.label}" task failures (${code}).`, evidence), source: 'retro', leverage: 2 + c.count * 2, size: 'pr', evidence });
  }

  // The Leader's own reliability.
  if (inputs.leader.consecutiveFailures >= 2) {
    const evidence = `${inputs.leader.consecutiveFailures} Leader runs in a row produced no memo; last reason: ${clip(inputs.leader.lastFailureReason ?? 'unknown', 200)}`;
    out.push({ id: 'failure:leader-runs', title: 'Make the Leader run reliably', brief: brief('make the Leader memo run succeed reliably (seat chain, timeouts, parse).', evidence), source: 'failure', leverage: 6 + inputs.leader.consecutiveFailures, size: 'pr', evidence });
  }

  // Needs-you friction: escalations that waited more than a day.
  const stale = inputs.escalations.filter((a) => a.status === 'escalated' && nowMs - Date.parse(a.createdAt) > 86_400_000);
  if (stale.length >= 2) {
    const evidence = `${stale.length} escalated Leader asks waited over 24 h (e.g. "${clip(stale[0]!.summary, 120)}")`;
    out.push({ id: 'needs-you:stale-escalations', title: 'Cut Needs-you friction for escalations', brief: brief('make escalated Leader asks answerable in one tap (clear summary, Approve / Veto, the grant step they need).', evidence), source: 'needs-you', leverage: 3 + stale.length, size: 'small', evidence });
  }

  // Usage: cloud lane reliability.
  const failedCloud = inputs.cloudTasks.filter((t) => (t.state === 'failed' || t.state === 'expired') && Date.parse(t.updatedAt) >= nowMs - 7 * 86_400_000);
  if (failedCloud.length >= 2) {
    const codes = [...new Set(failedCloud.map((t) => t.failure ?? 'unknown'))].slice(0, 4).join(', ');
    const evidence = `${failedCloud.length} cloud tasks failed or expired in 7 days (${codes})`;
    out.push({ id: `usage:cloud-failures:${slug(codes)}`, title: `Fix cloud task failures (${codes})`, brief: brief(`fix the most common cloud-task failure (${codes}).`, evidence), source: 'usage', leverage: 3 + failedCloud.length, size: 'pr', evidence });
  }

  // Competitive gates still open.
  if (inputs.competitive) {
    for (const { gate, boundary } of competitiveGaps(inputs.competitive).slice(0, 5)) {
      const evidence = `Competitive acceptance gate "${gate}": ${clip(boundary, 240)}`;
      out.push({ id: `competitive:${slug(gate)}`, title: clip(`Close the "${gate}" gap`, 120), brief: brief(`move the "${gate}" acceptance gate forward by one verifiable step.`, evidence), source: 'competitive', leverage: 3, size: 'pr', evidence });
    }
  }
  return out.sort((a, b) => b.leverage - a.leverage || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Selection (pure)
// ---------------------------------------------------------------------------

export type DriveLane = 'fleet' | 'cloud' | 'devin' | 'backlog';

export interface DriveBudget {
  mode: BudgetMode;
  /** The cloud budget's self-improvement gate; null = no cloud lane. */
  cloud: { ok: boolean; reason: string | null } | null;
  /** The Devin fleet gate (fleet opt-in + reserve); null = no Devin lane. */
  devin: { ok: boolean; reason: string | null } | null;
  /** A local / grok fleet lane exists for small work. */
  fleet: boolean;
}

export interface DriveHistoryEntry {
  candidateId: string;
  at: string;
  lane: DriveLane;
  actionId: string | null;
  status: string;
}

export interface DriveSelection {
  candidate: ImprovementCandidate;
  lane: DriveLane;
  /** Why this lane (plain). */
  why: string;
}

export interface DriveSelectionLimits {
  maxPerDay?: number | null;
  maxPaidPerDay?: number | null;
  cooldownDays?: number;
}

/** Pick today's improvements. Null/omitted limits add no ceiling to admitted work. */
export function selectImprovements(
  candidates: readonly ImprovementCandidate[],
  budget: DriveBudget,
  history: readonly DriveHistoryEntry[],
  nowMs: number,
  limits: DriveSelectionLimits = DRIVE_LIMITS,
): DriveSelection[] {
  const maxPerDay = limits.maxPerDay ?? null;
  const maxPaidPerDay = limits.maxPaidPerDay ?? null;
  for (const limit of [maxPerDay, maxPaidPerDay]) {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('Daily drive limits must be nonnegative safe integers or null.');
  }
  const cooldownFrom = nowMs - (limits.cooldownDays ?? DRIVE_LIMITS.cooldownDays) * 86_400_000;
  const recent = new Set(history.filter((h) => Date.parse(h.at) >= cooldownFrom).map((h) => h.candidateId));
  const out: DriveSelection[] = [];
  let paid = 0;
  const paidAllowed = budget.mode !== 'reserve';
  for (const c of candidates) {
    if (maxPerDay !== null && out.length >= maxPerDay) break;
    if (recent.has(c.id)) continue;
    let lane: DriveLane;
    let why: string;
    if (c.size === 'small' && budget.fleet) {
      lane = 'fleet';
      why = 'small change: the free local / grok fleet';
    } else if (paidAllowed && (maxPaidPerDay === null || paid < maxPaidPerDay) && budget.cloud?.ok) {
      lane = 'cloud';
      why = 'PR-sized: a cloud session inside the self-improvement budget';
    } else if (paidAllowed && (maxPaidPerDay === null || paid < maxPaidPerDay) && budget.devin?.ok) {
      lane = 'devin';
      why = `PR-sized: Devin (cloud ${budget.cloud ? `unavailable: ${budget.cloud.reason ?? 'refused'}` : 'lane absent'})`;
    } else {
      lane = 'backlog';
      why = !paidAllowed
        ? 'budget is in reserve: queued, nothing spent'
        : maxPaidPerDay !== null && paid >= maxPaidPerDay
          ? `today's explicit paid launch limit is reached: queued`
          : 'no paid lane has budget: queued';
    }
    if (lane === 'cloud' || lane === 'devin') paid += 1;
    out.push({ candidate: c, lane, why });
  }
  return out;
}

/** The action a selection becomes. Null when the params do not validate (never forced through). */
export function draftForSelection(sel: DriveSelection, repo: string = VERSE_REPO): AnyLeaderActionDraft | null {
  const c = sel.candidate;
  const why = `${c.evidence} — lane: ${sel.why}.`;
  switch (sel.lane) {
    case 'fleet':
      return buildLeaderActionDraft('work.dispatch', { task: { repo, title: c.title, detail: c.brief, difficulty: 'medium', value: 3 } }, `Self-improve: ${c.title}`, why);
    case 'cloud':
      return buildLeaderActionDraft('cloud.launch', { repo, title: c.title.slice(0, 80), prompt: c.brief, purpose: 'self-improve' }, `Self-improve (cloud): ${c.title}`, why);
    case 'devin':
      return buildLeaderActionDraft('devin.launch', { repo, title: c.title.slice(0, 80), prompt: c.brief }, `Self-improve (Devin): ${c.title}`, why);
    case 'backlog':
      return buildLeaderActionDraft('backlog.add', { repo, title: c.title, prompt: c.brief, priority: 2 }, `Self-improve (queued): ${c.title}`, why);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Direct enactment (drive + Mason's task requests)
// ---------------------------------------------------------------------------

export interface DirectEnactResult {
  memoId: string;
  actions: LeaderAction[];
}

/**
 * Plan, record and apply actions that did not come from a memo. They get a
 * fresh memo id (so veto-by-memo undoes the batch) and go through
 * `enactLeaderActions` exactly like a memo's. With `approvedVia` (Mason asked
 * for this work himself), each class-B action is approved at once through
 * `applyApprovedLeaderAction` — the same ledger + grant re-check as an
 * Approve tap — and no separate veto question is sent.
 */
export async function enactDirectLeaderActions(
  apply: LeaderApplyDeps,
  drafts: readonly AnyLeaderActionDraft[],
  opts: { approvedVia?: string } = {},
): Promise<DirectEnactResult> {
  const memoId = newMemoId(apply.now());
  const deps: LeaderApplyDeps = opts.approvedVia ? { ...apply, notify: () => undefined } : apply;
  let actions = await enactLeaderActions(deps, memoId, drafts, [], { idFor: (i) => actionIdFor(memoId, i) });
  if (opts.approvedVia) {
    const next: LeaderAction[] = [];
    for (const action of actions) {
      if (action.status === 'scheduled' && action.class === 'B') {
        const res = await applyApprovedLeaderAction(deps, action.id, { via: opts.approvedVia });
        next.push(res.action ?? action);
      } else {
        next.push(action);
      }
    }
    actions = next;
  }
  return { memoId, actions };
}

// ---------------------------------------------------------------------------
// The daily run
// ---------------------------------------------------------------------------

export interface DriveReport {
  day: string;
  at: string;
  text: string;
  /** Class-B actions still inside their veto window (the line gives them Approve / Veto). */
  actionIds: string[];
  /** Set by the Leader line once the report reached the thread / Telegram. */
  postedAt: string | null;
}

interface DriveStateV1 {
  v: 1;
  /** Local day (YYYY-MM-DD in the drive's timezone) of the last run. */
  lastRunDay: string | null;
  history: DriveHistoryEntry[];
  /**
   * The last run's report. The drive does not talk to Mason itself (that
   * would pull the thread into the Leader's trust closure): the Leader line
   * (comms/leader-line.ts) posts it and marks it posted.
   */
  lastReport?: DriveReport | null;
}

export function driveStatePath(): string {
  return join(leaderRoot(), 'drive-state.json');
}

export function readDriveState(): DriveStateV1 {
  const read = readPrivateFileCapped(driveStatePath(), 256 * 1024);
  if (!read || read.truncated) return { v: 1, lastRunDay: null, history: [] };
  try {
    const parsed = JSON.parse(read.text) as Partial<DriveStateV1>;
    if (parsed.v !== 1) return { v: 1, lastRunDay: null, history: [] };
    const report = parsed.lastReport;
    return {
      v: 1,
      lastRunDay: typeof parsed.lastRunDay === 'string' ? parsed.lastRunDay : null,
      history: Array.isArray(parsed.history) ? parsed.history.filter((h): h is DriveHistoryEntry => !!h && typeof h.candidateId === 'string' && typeof h.at === 'string') : [],
      lastReport: report && typeof report.text === 'string' && typeof report.day === 'string'
        ? { day: report.day, at: String(report.at), text: report.text, actionIds: Array.isArray(report.actionIds) ? report.actionIds.filter((x): x is string => typeof x === 'string') : [], postedAt: typeof report.postedAt === 'string' ? report.postedAt : null }
        : null,
    };
  } catch {
    return { v: 1, lastRunDay: null, history: [] };
  }
}

/** The Leader line marks the report posted (idempotent). */
export function markDriveReportPosted(day: string, nowMs: number): boolean {
  const state = readDriveState();
  if (!state.lastReport || state.lastReport.day !== day || state.lastReport.postedAt) return false;
  state.lastReport.postedAt = new Date(nowMs).toISOString();
  writeDriveState(state);
  return true;
}

function writeDriveState(state: DriveStateV1): void {
  ensurePrivateDirectory(leaderRoot());
  writePrivateFileAtomic(driveStatePath(), `${JSON.stringify({ ...state, history: state.history.slice(-DRIVE_LIMITS.historyKeep) })}\n`);
}

/** Wall-clock parts in a timezone (the drive and the briefs run on Mason's clock). */
export function zonedParts(nowMs: number, timeZone: string): { day: string; hour: number; minute: number; weekday: string } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  return { day: `${parts['year']}-${parts['month']}-${parts['day']}`, hour: Number(parts['hour']) % 24, minute: Number(parts['minute']), weekday: String(parts['weekday']) };
}

export interface DriveSources {
  retros(): Promise<DriveInputs['retros']>;
  leader(): DriveInputs['leader'];
  escalations(): DriveInputs['escalations'];
  cloudTasks(): DriveInputs['cloudTasks'];
  competitive(): string | null;
  budget(mode: BudgetMode): Promise<DriveBudget>;
}

async function defaultDriveSources(deps: LeaderRunDeps): Promise<DriveSources> {
  const [cloudStore, leader] = await Promise.all([
    import('../cloud/store.js').catch(() => null),
    import('./leader.js').catch(() => null),
  ]);
  return {
    retros: async () => {
      const { listRetros } = await import('../learn/retro/store.js');
      return listRetros(300);
    },
    leader: () => {
      const state = leader?.readLeaderRunState();
      return { consecutiveFailures: state?.consecutiveFailures ?? 0, lastFailureReason: state?.lastFailure?.reason ?? null };
    },
    escalations: () => listLeaderActions(200).filter((a) => a.status === 'escalated'),
    cloudTasks: () => cloudStore?.listCloudTasks(200) ?? [],
    competitive: () => {
      for (const rel of ['../../../docs/VERSE-COMPETITIVE-ACCEPTANCE.md', '../../../../docs/VERSE-COMPETITIVE-ACCEPTANCE.md']) {
        try {
          return readFileSync(new URL(rel, import.meta.url), 'utf8').slice(0, 64 * 1024);
        } catch { /* try the next layout (src vs dist) */ }
      }
      return null;
    },
    budget: async (mode) => {
      let cloud: DriveBudget['cloud'] = null;
      let devin: DriveBudget['devin'] = null;
      try {
        const [store, budget] = await Promise.all([import('../cloud/store.js'), import('../cloud/budget.js')]);
        cloud = budget.cloudBudgetView(store.listCloudTasks(), store.readCloudBudget(), new Date(deps.now())).canSelfImprove;
      } catch { cloud = null; }
      try {
        const fleetOn = deps.apply.powers?.devin?.fleetEnabled() ?? false;
        if (fleetOn) {
          const [store, budget] = await Promise.all([import('../devin/store.js'), import('../devin/budget.js')]);
          devin = budget.devinBudgetView(store.listDevinTasks(), store.readDevinBudget(), new Date(deps.now())).canFleetLaunch;
        }
      } catch { devin = null; }
      return { mode, cloud, devin, fleet: true };
    },
  };
}

export interface DriveRunResult {
  ran: boolean;
  reason: string;
  selections: DriveSelection[];
  actions: LeaderAction[];
}

/** One-line-per-pick report in the Leader's voice. */
export function driveReportText(selections: readonly DriveSelection[], actions: readonly LeaderAction[]): string {
  if (selections.length === 0) return 'Self-improvement: nothing clears the bar today. Backlog is clean.';
  const lines = [`Self-improvement — ${selections.length} move${selections.length === 1 ? '' : 's'} on Phantom today:`];
  selections.forEach((s, i) => {
    const a = actions[i];
    const state = !a ? 'not planned'
      : a.status === 'applied' ? (a.kind === 'backlog.add' ? 'queued' : 'launched')
        : a.status === 'scheduled' ? `launches ${a.applyAfter ? a.applyAfter.slice(11, 16) : 'soon'} unless you veto`
          : a.status === 'escalated' ? 'needs you (outside the grant)'
            : `${a.status}${a.statusReason ? ` — ${clip(a.statusReason, 80)}` : ''}`;
    lines.push(`• [${s.lane}] ${clip(s.candidate.title, 90)} — ${state}`);
  });
  return lines.join('\n');
}

export async function runLeaderDrive(
  deps: LeaderRunDeps,
  opts: { sources?: DriveSources; timeZone?: string; force?: boolean } = {},
): Promise<DriveRunResult> {
  const nowMs = deps.now();
  const timeZone = opts.timeZone ?? 'America/New_York';
  const today = zonedParts(nowMs, timeZone).day;
  // One drive per day ACROSS processes (the daemon's tick and the comms
  // poller's `leader tick` both reach here): take the lock, re-check, and
  // claim the day BEFORE acting — a crash loses a day, never double-spends.
  ensurePrivateDirectory(leaderRoot());
  const lock = acquireLocalStoreLock(join(leaderRoot(), '.drive.lock'), 0);
  if (!lock) return { ran: false, reason: 'another process is running the drive', selections: [], actions: [] };
  try {
    const state = readDriveState();
    if (!opts.force && state.lastRunDay === today) return { ran: false, reason: 'already ran today', selections: [], actions: [] };
    writeDriveState({ ...state, lastRunDay: today });
    const src = opts.sources ?? (await defaultDriveSources(deps));

    let mode: BudgetMode = 'balanced';
    try { mode = deps.apply.budget.load().mode; } catch { /* balanced is the default */ }
    let retros: DriveInputs['retros'] = [];
    try { retros = await src.retros(); } catch { retros = []; }
    const safe = <T>(fn: () => T, fallback: T): T => {
      try { return fn(); } catch { return fallback; }
    };
    const candidates = collectImprovementCandidates({
      retros,
      leader: safe(() => src.leader(), { consecutiveFailures: 0, lastFailureReason: null }),
      escalations: safe(() => src.escalations(), []),
      cloudTasks: safe(() => src.cloudTasks(), []),
      competitive: safe(() => src.competitive(), null),
    }, nowMs);
    const budget = await src.budget(mode).catch((): DriveBudget => ({ mode, cloud: null, devin: null, fleet: true }));
    const selections = selectImprovements(candidates, budget, state.history, nowMs);
    const planned = selections.map((s) => ({ s, draft: draftForSelection(s) })).filter((x): x is { s: DriveSelection; draft: AnyLeaderActionDraft } => x.draft !== null);

    // Dry run (no grant / Propose / shadow stage): nothing is enacted and
    // nobody is pinged; the picks wait in the report for the next brief.
    let dryRun = false;
    try { dryRun = isLeaderDryRun(deps.apply.standingPolicy()); } catch { dryRun = true; }
    let actions: LeaderAction[] = [];
    if (planned.length > 0 && !dryRun) {
      ({ actions } = await enactDirectLeaderActions(deps.apply, planned.map((p) => p.draft)));
    }
    const fresh = readDriveState();
    fresh.lastRunDay = today;
    if (!dryRun) {
      planned.forEach((p, i) => {
        fresh.history.push({ candidateId: p.s.candidate.id, at: new Date(nowMs).toISOString(), lane: p.s.lane, actionId: actions[i]?.id ?? null, status: actions[i]?.status ?? 'not-planned' });
      });
    }
    fresh.lastReport = {
      day: today,
      at: new Date(nowMs).toISOString(),
      text: dryRun
        ? `Self-improvement (dry run — no standing grant, nothing launched): ${planned.map((p) => `${p.s.candidate.title} [${p.s.lane}]`).join('; ') || 'nothing clears the bar'}`
        : driveReportText(planned.map((p) => p.s), actions),
      actionIds: actions.filter((a) => a.status === 'scheduled' && a.class === 'B').map((a) => a.id),
      // A dry-run report rides the next brief; it is never its own ping.
      postedAt: dryRun ? new Date(nowMs).toISOString() : null,
    };
    writeDriveState(fresh);
    return { ran: true, reason: dryRun ? 'dry run' : 'ok', selections: planned.map((p) => p.s), actions };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/** Is the drive switched on? `foundry.leader.selfImprove: false` turns it off (default on). */
export function driveEnabled(cfg: unknown): boolean {
  const leader = (cfg as { foundry?: { leader?: { selfImprove?: unknown } } } | undefined)?.foundry?.leader;
  return leader?.selfImprove !== false;
}

/**
 * The tick's entry: once per local day, from DRIVE_LIMITS.fromHour. Off under
 * the test runner unless ASHLR_LEADER_DRIVE=1 (like the cloud scheduler), so
 * a unit test's leaderTick never launches anything.
 */
export async function runLeaderDriveIfDue(deps: LeaderRunDeps, opts: { timeZone?: string } = {}): Promise<DriveRunResult> {
  const idle = (reason: string): DriveRunResult => ({ ran: false, reason, selections: [], actions: [] });
  if ((process.env['VITEST'] || process.env['NODE_ENV'] === 'test') && process.env['ASHLR_LEADER_DRIVE'] !== '1') return idle('test runner');
  if (!driveEnabled(deps.cfg)) return idle('switched off (foundry.leader.selfImprove: false)');
  const tz = opts.timeZone ?? (deps.cfg as { comms?: { timeZone?: string } }).comms?.timeZone ?? 'America/New_York';
  const now = zonedParts(deps.now(), tz);
  if (now.hour < DRIVE_LIMITS.fromHour) return idle('before the drive hour');
  if (readDriveState().lastRunDay === now.day) return idle('already ran today');
  return runLeaderDrive(deps, { timeZone: tz });
}

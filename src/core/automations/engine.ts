/**
 * The automations engine: poll triggers → dedupe → (triage) → queue →
 * dispatch within limits → watch until settled. One tick at a time per
 * process; every state change is a read-modify-write under the store lock and
 * a journal line.
 *
 * ORDER OF CHECKS for a queued firing (cheapest refusal first, and each one
 * only DEFERS — the firing stays queued and is retried next tick):
 *   1. KILL/Stop (every lane) and the standing grant + repo (every working lane)
 *   2. the automation's own limits: max concurrent, max per local day, and
 *      the monthly spend cap against the lane's per-session estimate
 *   3. the lane's own entry point, with ITS gates (budget, seat, opt-in)
 * A firing is claimed (`dispatching`) before the lane call, so a crash can
 * never send it twice: a stale claim is marked failed, never retried.
 *
 * Nothing here polls on the caller's stack of a Verse GET: the Verse server
 * runs `runAutomationsTick` on its own timer, and the routes only read.
 */
import { createHash } from 'node:crypto';

import { localDayKey } from '../cloud/budget.js';
import { pollIssues, pollRedBranch, untrustedText, untrustedTitle, type AutomationGh, type TriggerEvent } from './github.js';
import {
  dispatchToLane,
  grantRepos,
  KILL_REASON,
  laneGateRefusal,
  NO_GRANT_REASON,
  repoInPolicy,
  resolveLaneDeps,
  type AutomationLaneDeps,
  type LaneOutcome,
} from './lanes.js';
import { describeRrule, nextOccurrence, parseRrule } from './rrule.js';
import {
  appendAutomationJournal,
  emptyCursor,
  journalRecord,
  mutateAutomationState,
  newFiringId,
  readAutomations,
  readAutomationState,
  type AutomationJournalEvent,
  type AutomationJournalRecord,
} from './store.js';
import { AUTOMATION_TEMPLATES } from './templates.js';
import { defaultAutomationDecider, triageFiring, type AutomationDecider } from './triage.js';
import {
  AUTOMATION_ACTIVE_STATES,
  AUTOMATION_ALL_GRANT_REPOS,
  AUTOMATION_LIMITS,
  AUTOMATION_REPO_PATTERN,
  type AutomationCursor,
  type AutomationFireRequest,
  type AutomationFireResponse,
  type AutomationFiringV1,
  type AutomationPlannedTask,
  type AutomationsOverviewResponse,
  type AutomationSourceKind,
  type AutomationStateV1,
  type AutomationStats,
  type AutomationTriggerKind,
  type AutomationV1,
  type AutomationView,
  type AutomationWebhookRequest,
} from './types.js';

export interface AutomationEngineDeps extends AutomationLaneDeps {
  gh?: AutomationGh;
  now?: () => Date;
  /** undefined = Jev via the typed client; null = rules only (no paid call). */
  decider?: AutomationDecider | null;
}

interface Ctx {
  lane: Required<AutomationLaneDeps>;
  gh: AutomationGh;
  now: () => Date;
  decider: AutomationDecider | null;
}

const defaultGh: AutomationGh = async (args) => (await import('../cloud/tracker.js')).defaultCloudGh(args);

function ctxOf(deps: AutomationEngineDeps = {}): Ctx {
  return {
    lane: resolveLaneDeps(deps),
    gh: deps.gh ?? defaultGh,
    now: deps.now ?? (() => new Date()),
    decider: deps.decider === undefined ? defaultAutomationDecider : deps.decider,
  };
}

/** A dropped key is not re-dropped (or re-offered) for this long — a red sha polled every 10 min would otherwise spam. */
const DROP_QUIET_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Dedupe keys
// ---------------------------------------------------------------------------

export function defaultDedupeTemplate(kind: AutomationTriggerKind): string {
  switch (kind) {
    case 'github-issues': return '{repo}#{number}';
    case 'ci-red': return '{repo}@{sha}';
    case 'schedule': return '{repo}@{occurrence}';
    case 'webhook': return '{key}';
    case 'telegram': return '{repo}:{key}';
  }
}

export function renderDedupeKey(template: string, repo: string, vars: TriggerEvent['vars']): string {
  return template
    .replace(/\{(repo|number|sha|occurrence|key)\}/g, (_m, name: string) => (name === 'repo' ? repo.toLowerCase() : vars[name as keyof TriggerEvent['vars']] ?? '-'))
    .replace(/[^A-Za-z0-9._:#@/+-]/g, '_')
    .slice(0, 160);
}

const seenKey = (automationId: string, dedupeKey: string): string => `${automationId}\u0000${dedupeKey}`;

export function textKey(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const monthKey = (d: Date): string => localDayKey(d).slice(0, 7);
const at = (iso: string | null): Date | null => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : null);

export function automationStats(automation: AutomationV1, state: AutomationStateV1, now: Date): AutomationStats {
  const today = localDayKey(now);
  const month = monthKey(now);
  const windowStart = now.getTime() - AUTOMATION_LIMITS.successWindowMs;
  let lastFiredAt: string | null = null;
  let queued = 0;
  let active = 0;
  let firedToday = 0;
  let spent = 0;
  let succeeded = 0;
  let failed = 0;
  for (const f of state.firings) {
    if (f.automationId !== automation.id) continue;
    if (f.state !== 'dropped' && (lastFiredAt === null || f.createdAt > lastFiredAt)) lastFiredAt = f.createdAt;
    if (f.state === 'queued') queued += 1;
    if (AUTOMATION_ACTIVE_STATES.includes(f.state)) active += 1;
    const dispatched = at(f.dispatchedAt);
    if (dispatched && localDayKey(dispatched) === today) firedToday += 1;
    if (dispatched && monthKey(dispatched) === month) spent += f.spendUsd;
    const settled = at(f.settledAt);
    if (settled && settled.getTime() >= windowStart) {
      if (f.state === 'succeeded') succeeded += 1;
      if (f.state === 'failed') failed += 1;
    }
  }
  const cursor = state.cursors[automation.id] ?? null;
  let nextRunAt: string | null = null;
  const t = automation.trigger;
  if (automation.enabled) {
    if (t.kind === 'schedule') {
      const parsed = parseRrule(t.rrule);
      nextRunAt = cursor?.nextRunAt ?? (parsed.ok ? nextOccurrence(parsed.rule, now)?.toISOString() ?? null : null);
    } else if (t.kind === 'github-issues' || t.kind === 'ci-red') {
      const last = at(cursor?.lastPolledAt ?? null);
      nextRunAt = last ? new Date(Math.max(now.getTime(), last.getTime() + t.pollMinutes * 60_000)).toISOString() : now.toISOString();
    }
  }
  return {
    lastFiredAt,
    nextRunAt,
    queued,
    active,
    firedToday,
    spentThisMonthUsd: Math.round(spent * 100) / 100,
    successRate: succeeded + failed === 0 ? null : Math.round((succeeded / (succeeded + failed)) * 1000) / 1000,
    succeeded,
    failed,
    lastError: cursor?.lastError ?? null,
  };
}

function reposPhrase(repos: readonly string[]): string {
  if (repos[0] === AUTOMATION_ALL_GRANT_REPOS) return 'every repo in the standing grant';
  return repos.length === 1 ? repos[0]! : `${repos.length} repos`;
}

export function triggerSummary(automation: AutomationV1): string {
  const t = automation.trigger;
  const repos = reposPhrase(automation.repos);
  switch (t.kind) {
    case 'github-issues': {
      const what = t.includePrs ? 'Issues and PRs' : 'Issues';
      const labels = t.labels.length > 0 ? ` labelled ${t.labels.join(' + ')}` : '';
      const query = t.query ? ` matching “${t.query}”` : '';
      return `${what}${labels}${query} on ${repos}, checked every ${t.pollMinutes} min`;
    }
    case 'ci-red':
      return `Failing checks on ${t.branch ?? 'the default branch'} of ${repos}, checked every ${t.pollMinutes} min`;
    case 'schedule': {
      const parsed = parseRrule(t.rrule);
      return `${parsed.ok ? describeRrule(parsed.rule) : t.rrule} on ${repos}`;
    }
    case 'webhook':
      return `Local webhook (POST /api/verse/automations/${automation.id}/webhook) for ${repos}`;
    case 'telegram':
      return `Telegram /task <repo> <text> for ${repos}`;
  }
}

export function automationView(automation: AutomationV1, state: AutomationStateV1, now: Date): AutomationView {
  return { automation, stats: automationStats(automation, state, now), triggerSummary: triggerSummary(automation) };
}

// ---------------------------------------------------------------------------
// Repos in scope
// ---------------------------------------------------------------------------

async function reposFor(automation: AutomationV1, ctx: Ctx): Promise<string[]> {
  if (automation.repos[0] !== AUTOMATION_ALL_GRANT_REPOS) return [...automation.repos];
  let policy = null;
  try { policy = await ctx.lane.policy(); } catch { policy = null; }
  return grantRepos(policy).slice(0, AUTOMATION_LIMITS.maxRepos);
}

async function repoInScope(automation: AutomationV1, repo: string, ctx: Ctx): Promise<boolean> {
  if (automation.repos[0] === AUTOMATION_ALL_GRANT_REPOS) {
    let policy = null;
    try { policy = await ctx.lane.policy(); } catch { policy = null; }
    return policy !== null && repoInPolicy(policy, repo);
  }
  return automation.repos.some((r) => r.toLowerCase() === repo.toLowerCase());
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export function pollDue(automation: AutomationV1, cursor: AutomationCursor, now: Date): boolean {
  const t = automation.trigger;
  if (t.kind === 'github-issues' || t.kind === 'ci-red') {
    const last = at(cursor.lastPolledAt);
    return last === null || now.getTime() - last.getTime() >= t.pollMinutes * 60_000 || now.getTime() < last.getTime();
  }
  if (t.kind === 'schedule') {
    const next = at(cursor.nextRunAt);
    return next === null || now.getTime() >= next.getTime();
  }
  return false;
}

interface Collected {
  events: TriggerEvent[];
  cursor: AutomationCursor;
  sourceKind: AutomationSourceKind;
}

function localStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Read the trigger's source. `force` ignores the poll interval / schedule (a manual run). */
async function collectEvents(automation: AutomationV1, cursorIn: AutomationCursor, ctx: Ctx, now: Date, force: boolean): Promise<Collected> {
  const cursor: AutomationCursor = JSON.parse(JSON.stringify(cursorIn)) as AutomationCursor;
  const t = automation.trigger;
  const events: TriggerEvent[] = [];
  const nowIso = now.toISOString();
  switch (t.kind) {
    case 'github-issues':
    case 'ci-red': {
      const repos = await reposFor(automation, ctx);
      const errors: string[] = [];
      for (const repo of repos) {
        if (t.kind === 'github-issues') {
          const etagKey = `issues:${repo}`;
          const res = await pollIssues(ctx.gh, t, repo, { since: cursor.since[repo] ?? null, etag: cursor.etags[etagKey] ?? null });
          if (res.error) errors.push(`${repo}: ${res.error}`);
          if (res.since) cursor.since[repo] = res.since;
          if (res.etag) cursor.etags[etagKey] = res.etag;
          events.push(...res.events);
        } else {
          const etagKey = `checks:${repo}`;
          const res = await pollRedBranch(ctx.gh, t, repo, { branch: cursor.branches[repo] ?? null, etag: cursor.etags[etagKey] ?? null });
          if (res.error) errors.push(`${repo}: ${res.error}`);
          if (res.branch && !t.branch) cursor.branches[repo] = res.branch;
          if (res.etag) cursor.etags[etagKey] = res.etag;
          events.push(...res.events);
        }
      }
      cursor.lastPolledAt = nowIso;
      cursor.lastError = errors[0] ?? (repos.length === 0 ? 'No repos to check — the standing grant lists none.' : null);
      return { events, cursor, sourceKind: t.kind };
    }
    case 'schedule': {
      const parsed = parseRrule(t.rrule);
      if (!parsed.ok) {
        cursor.lastError = parsed.error;
        return { events, cursor, sourceKind: 'schedule' };
      }
      let occurrence: string | null = null;
      let sourceKind: AutomationSourceKind = 'schedule';
      if (force) {
        occurrence = `manual-${nowIso.slice(0, 16)}`;
        sourceKind = 'manual';
      } else if (cursor.nextRunAt === null) {
        // First sight: schedule the next occurrence; never fire a missed past one.
        cursor.nextRunAt = nextOccurrence(parsed.rule, now)?.toISOString() ?? null;
      } else if (now.getTime() >= Date.parse(cursor.nextRunAt)) {
        occurrence = cursor.nextRunAt;
        // Missed occurrences (machine asleep) collapse into this one firing.
        cursor.nextRunAt = nextOccurrence(parsed.rule, now)?.toISOString() ?? null;
      }
      if (occurrence) {
        const repos = await reposFor(automation, ctx);
        const label = occurrence.startsWith('manual-') ? 'run now' : localStamp(occurrence);
        for (const repo of repos) {
          events.push({ repo, vars: { occurrence }, title: `${automation.name} — ${repo} (${label})`, text: '', url: null, ref: occurrence });
        }
        cursor.lastError = repos.length === 0 ? 'No repos to run on — the standing grant lists none.' : null;
      }
      cursor.lastPolledAt = nowIso;
      return { events, cursor, sourceKind };
    }
    case 'webhook':
    case 'telegram':
      return { events, cursor, sourceKind: t.kind };
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface LimitCounts {
  active: number;
  firedToday: number;
  spentThisMonthUsd: number;
  queued: number;
}

export function limitCounts(automationId: string, state: AutomationStateV1, now: Date): LimitCounts {
  const today = localDayKey(now);
  const month = monthKey(now);
  const counts: LimitCounts = { active: 0, firedToday: 0, spentThisMonthUsd: 0, queued: 0 };
  for (const f of state.firings) {
    if (f.automationId !== automationId) continue;
    if (AUTOMATION_ACTIVE_STATES.includes(f.state)) counts.active += 1;
    if (f.state === 'queued') counts.queued += 1;
    const d = at(f.dispatchedAt);
    if (d && localDayKey(d) === today) counts.firedToday += 1;
    if (d && monthKey(d) === month) counts.spentThisMonthUsd += f.spendUsd;
  }
  return counts;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Null when the automation's own limits allow one more dispatch costing `estimateUsd`. */
export function limitRefusal(automation: AutomationV1, counts: LimitCounts, estimateUsd: number): string | null {
  if (counts.active >= automation.maxConcurrent) {
    return `Waiting: ${counts.active} of ${automation.maxConcurrent} ${plural(automation.maxConcurrent, 'task', 'tasks')} from this automation still in flight.`;
  }
  if (counts.firedToday >= automation.maxPerDay) {
    return `Waiting: ${counts.firedToday} of ${automation.maxPerDay} ${plural(automation.maxPerDay, 'task', 'tasks')} already sent today.`;
  }
  if (!Number.isFinite(estimateUsd)) return 'Waiting: the lane\'s cost estimate could not be read, and unknown spend is not free.';
  if (estimateUsd > 0 && counts.spentThisMonthUsd + estimateUsd > automation.spendCapUsd) {
    return `Waiting: about $${counts.spentThisMonthUsd.toFixed(2)} of this automation's $${automation.spendCapUsd.toFixed(2)} monthly cap is used; another task (~$${estimateUsd.toFixed(2)}) would exceed it.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

interface Candidate {
  event: TriggerEvent;
  dedupeKey: string;
  sourceKind: AutomationSourceKind;
}

function candidatesFor(automation: AutomationV1, events: readonly TriggerEvent[], sourceKind: AutomationSourceKind): Candidate[] {
  const template = automation.dedupeKey ?? defaultDedupeTemplate(automation.trigger.kind);
  const out: Candidate[] = [];
  const keys = new Set<string>();
  for (const event of events) {
    const dedupeKey = renderDedupeKey(template, event.repo, event.vars);
    if (keys.has(dedupeKey)) continue;
    keys.add(dedupeKey);
    out.push({ event, dedupeKey, sourceKind });
  }
  return out;
}

function recentlyDropped(state: AutomationStateV1, automationId: string, dedupeKey: string, nowMs: number): boolean {
  return state.firings.some((f) => f.automationId === automationId && f.dedupeKey === dedupeKey && f.state === 'dropped'
    && nowMs - Date.parse(f.createdAt) < DROP_QUIET_MS);
}

function newFiring(automation: AutomationV1, c: Candidate, now: Date, lane: AutomationV1['lane'], playbookId: string | null): AutomationFiringV1 {
  const iso = now.toISOString();
  return {
    v: 1,
    id: newFiringId(now),
    automationId: automation.id,
    dedupeKey: c.dedupeKey,
    source: { kind: c.sourceKind, url: c.event.url, ref: c.event.ref.slice(0, 80) },
    repo: c.event.repo,
    title: c.event.title.slice(0, AUTOMATION_LIMITS.eventTitleMaxChars),
    text: c.event.text.slice(0, AUTOMATION_LIMITS.eventTextMaxChars),
    lane,
    playbookId,
    state: 'queued',
    reason: 'Queued.',
    laneRef: null,
    spendUsd: 0,
    attempts: 0,
    createdAt: iso,
    dispatchedAt: null,
    settledAt: null,
    updatedAt: iso,
  };
}

interface IntakeResult {
  queued: AutomationFiringV1[];
  deduped: Candidate[];
  dropped: AutomationFiringV1[];
}

/**
 * Turn candidates into queued firings: one per dedupe key, ever (within
 * retention). Capacity = queue depth + free concurrency slots; beyond that a
 * candidate is recorded as `dropped` (and its key left free). Triage (a paid
 * call) runs only for candidates that will actually be queued.
 */
async function intake(automation: AutomationV1, candidates: readonly Candidate[], ctx: Ctx, now: Date): Promise<IntakeResult> {
  const result: IntakeResult = { queued: [], deduped: [], dropped: [] };
  if (candidates.length === 0) return result;
  const nowMs = now.getTime();
  const snapshot = await readAutomationState();
  const counts = limitCounts(automation.id, snapshot, now);
  let capacity = automation.queueDepth + Math.max(0, automation.maxConcurrent - counts.active) - counts.queued;
  const plan: Array<{ c: Candidate; keep: boolean }> = [];
  for (const c of candidates) {
    if (seenKey(automation.id, c.dedupeKey) in snapshot.seen || recentlyDropped(snapshot, automation.id, c.dedupeKey, nowMs)) {
      result.deduped.push(c);
      continue;
    }
    plan.push({ c, keep: capacity > 0 });
    capacity -= 1;
  }
  const triaged = new Map<string, Awaited<ReturnType<typeof triageFiring>>>();
  for (const { c, keep } of plan) {
    if (keep) triaged.set(c.dedupeKey, await triageFiring(automation, c.event, ctx.decider));
  }

  const journal: AutomationJournalRecord[] = [];
  await mutateAutomationState((state) => {
    for (const { c, keep } of plan) {
      const key = seenKey(automation.id, c.dedupeKey);
      if (key in state.seen || recentlyDropped(state, automation.id, c.dedupeKey, nowMs)) {
        result.deduped.push(c);
        continue;
      }
      const t = triaged.get(c.dedupeKey);
      const firing = newFiring(automation, c, now, t?.lane ?? automation.lane, t?.playbookId ?? automation.playbookId);
      if (t) firing.triage = t.record;
      if (!keep) {
        Object.assign(firing, { state: 'dropped', settledAt: firing.createdAt, reason: `Dropped: this automation's queue is full (${automation.queueDepth} waiting).` });
        state.firings.push(firing);
        result.dropped.push(firing);
        journal.push(journalRecord(firing, 'dropped', firing.createdAt));
        continue;
      }
      state.seen[key] = nowMs;
      state.firings.push(firing);
      result.queued.push(firing);
      journal.push(journalRecord(firing, 'fired', firing.createdAt));
    }
  }, () => ctx.now().getTime());
  await appendAutomationJournal(journal);
  return result;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function updateQueuedReason(firingId: string, reason: string, ctx: Ctx, event: AutomationJournalEvent | null): Promise<void> {
  let record: AutomationJournalRecord | null = null;
  await mutateAutomationState((state) => {
    const f = state.firings.find((x) => x.id === firingId);
    if (!f || f.state !== 'queued' || f.reason === reason) return;
    f.reason = reason;
    f.updatedAt = ctx.now().toISOString();
    if (event) record = journalRecord(f, event, f.updatedAt);
  });
  if (record) await appendAutomationJournal([record]);
}

function applyOutcome(f: AutomationFiringV1, outcome: LaneOutcome, iso: string): AutomationJournalEvent {
  f.updatedAt = iso;
  switch (outcome.kind) {
    case 'dispatched':
      Object.assign(f, { state: 'dispatched', laneRef: outcome.ref, spendUsd: outcome.spendUsd, dispatchedAt: iso, reason: outcome.reason });
      return 'dispatched';
    case 'review':
      Object.assign(f, { state: 'awaiting-review', dispatchedAt: iso, reason: outcome.reason });
      return 'dispatched';
    case 'deferred':
      Object.assign(f, { state: 'queued', reason: `Waiting: ${outcome.reason}` });
      return 'deferred';
    case 'refused':
      Object.assign(f, { state: 'refused', settledAt: iso, reason: outcome.reason });
      return 'refused';
    case 'failed':
      // It reached the lane, so it counts toward the per-day limit.
      Object.assign(f, { state: 'failed', laneRef: outcome.ref, dispatchedAt: iso, settledAt: iso, reason: outcome.reason });
      return 'settled';
  }
}

/**
 * Dispatch this automation's queued firings, oldest first, until a limit
 * stops it. A gate refusal for one repo defers that firing and moves on (KILL
 * and no-grant stop the whole pass).
 */
async function drainAutomation(automation: AutomationV1, ctx: Ctx): Promise<AutomationFiringV1[]> {
  const touched: AutomationFiringV1[] = [];
  const snapshot = await readAutomationState();
  const queue = snapshot.firings
    .filter((f) => f.automationId === automation.id && f.state === 'queued')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .slice(0, automation.maxConcurrent + automation.queueDepth);
  for (const queued of queue) {
    const gate = await laneGateRefusal(queued.lane, queued.repo, ctx.lane);
    if (gate) {
      await updateQueuedReason(queued.id, `Waiting: ${gate}`, ctx, 'deferred');
      if (gate === KILL_REASON || gate === NO_GRANT_REASON) break;
      continue;
    }
    let estimate: number;
    try { estimate = await ctx.lane.estimateUsd(queued.lane); } catch { estimate = Number.POSITIVE_INFINITY; }

    // Claim under the lock, re-checking limits against the CURRENT state.
    type Claim = { ok: true; firing: AutomationFiringV1 } | { ok: false; reason: string | null };
    const claim = await mutateAutomationState<Claim>((state) => {
      const f = state.firings.find((x) => x.id === queued.id);
      if (!f || f.state !== 'queued') return { ok: false, reason: null };
      const refusal = limitRefusal(automation, limitCounts(automation.id, state, ctx.now()), estimate);
      if (refusal) {
        if (f.reason !== refusal) Object.assign(f, { reason: refusal, updatedAt: ctx.now().toISOString() });
        return { ok: false, reason: refusal };
      }
      Object.assign(f, { state: 'dispatching', attempts: f.attempts + 1, reason: 'Handing to the lane.', updatedAt: ctx.now().toISOString() });
      return { ok: true, firing: { ...f } };
    });
    if (!claim.ok) {
      if (claim.reason) break; // a limit: later firings are held by the same limit
      continue;
    }

    let outcome: LaneOutcome;
    try {
      outcome = await dispatchToLane(automation, claim.firing, ctx.lane);
    } catch {
      outcome = { kind: 'failed', reason: 'The lane call failed unexpectedly; check the lane before re-running.', ref: null };
    }
    let record: AutomationJournalRecord | null = null;
    await mutateAutomationState((state) => {
      const f = state.firings.find((x) => x.id === claim.firing.id);
      if (!f) return;
      const event = applyOutcome(f, outcome, ctx.now().toISOString());
      record = journalRecord(f, event, f.updatedAt);
      touched.push({ ...f });
    });
    if (record) await appendAutomationJournal([record]);
    if (outcome.kind === 'deferred') break; // the lane's own gate (budget, seat) will say the same for the next one
  }
  return touched;
}

/** Keep at most `queueDepth` waiting: the newest extras are dropped and their keys freed. */
async function trimQueue(automation: AutomationV1, ctx: Ctx): Promise<void> {
  const journal: AutomationJournalRecord[] = [];
  await mutateAutomationState((state) => {
    const queued = state.firings
      .filter((f) => f.automationId === automation.id && f.state === 'queued')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const f of queued.slice(automation.queueDepth)) {
      const iso = ctx.now().toISOString();
      Object.assign(f, { state: 'dropped', settledAt: iso, updatedAt: iso, reason: `Dropped: this automation's queue is full (${automation.queueDepth} waiting).` });
      delete state.seen[seenKey(automation.id, f.dedupeKey)];
      journal.push(journalRecord(f, 'dropped', iso));
    }
  });
  await appendAutomationJournal(journal);
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

async function settle(ctx: Ctx): Promise<number> {
  const snapshot = await readAutomationState();
  const statuses = new Map<string, 'succeeded' | 'failed'>();
  for (const f of snapshot.firings) {
    if (f.state !== 'dispatched' || !f.laneRef) continue;
    let status;
    try { status = await ctx.lane.laneStatus(f.laneRef); } catch { status = 'unknown' as const; }
    if (status === 'succeeded' || status === 'failed') statuses.set(f.id, status);
  }
  const journal: AutomationJournalRecord[] = [];
  let changed = 0;
  await mutateAutomationState((state) => {
    const now = ctx.now();
    const iso = now.toISOString();
    for (const f of state.firings) {
      const status = statuses.get(f.id);
      if (f.state === 'dispatched' && status) {
        Object.assign(f, {
          state: status,
          settledAt: iso,
          updatedAt: iso,
          reason: status === 'succeeded' ? 'Done: the lane finished the task.' : 'The lane\'s task ended without landing.',
        });
      } else if (f.state === 'dispatching' && now.getTime() - Date.parse(f.updatedAt) > AUTOMATION_LIMITS.dispatchingStaleMs) {
        // The process died mid-launch. Never re-send: the lane may have it.
        Object.assign(f, { state: 'failed', settledAt: iso, updatedAt: iso, dispatchedAt: f.dispatchedAt ?? f.updatedAt, reason: 'Interrupted while handing to the lane — check the lane before firing again.' });
      } else if (f.state === 'queued' && now.getTime() - Date.parse(f.createdAt) > AUTOMATION_LIMITS.queuedExpiryMs) {
        Object.assign(f, { state: 'dropped', settledAt: iso, updatedAt: iso, reason: `Dropped after waiting 7 days (${f.reason ?? 'no slot'}).` });
        delete state.seen[seenKey(f.automationId, f.dedupeKey)];
      } else {
        continue;
      }
      changed += 1;
      // Object.assign above changed the state; read it back untyped-narrowed.
      const settledState: string = f.state;
      journal.push(journalRecord(f, settledState === 'dropped' ? 'dropped' : 'settled', iso));
    }
  });
  await appendAutomationJournal(journal);
  return changed;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export interface AutomationsTickSummary {
  polled: number;
  queued: number;
  dispatched: number;
  settled: number;
  blocked: string | null;
}

let tickInFlight: Promise<AutomationsTickSummary> | null = null;
let lastBlocked: { reason: string | null; at: number } = { reason: null, at: 0 };

/** The last tick's "why nothing dispatches" (KILL / no grant); cached so GET routes stay cheap. */
export function lastBlockedReason(): string | null {
  return lastBlocked.reason;
}

async function blockedNow(ctx: Ctx): Promise<string | null> {
  let kill = true;
  try { kill = await ctx.lane.killActive(); } catch { kill = true; }
  if (kill) return KILL_REASON;
  let policy = null;
  try { policy = await ctx.lane.policy(); } catch { policy = null; }
  return policy ? null : NO_GRANT_REASON;
}

async function tickOnce(deps: AutomationEngineDeps): Promise<AutomationsTickSummary> {
  const ctx = ctxOf(deps);
  const summary: AutomationsTickSummary = { polled: 0, queued: 0, dispatched: 0, settled: 0, blocked: null };
  summary.settled = await settle(ctx);
  summary.blocked = await blockedNow(ctx);
  lastBlocked = { reason: summary.blocked, at: Date.now() };
  const { automations } = await readAutomations();
  const enabled = automations.filter((a) => a.enabled);
  const state = await readAutomationState();
  for (const automation of enabled) {
    const now = ctx.now();
    const cursor = state.cursors[automation.id] ?? emptyCursor();
    if (!pollDue(automation, cursor, now)) continue;
    let collected: Collected;
    try {
      collected = await collectEvents(automation, cursor, ctx, now, false);
    } catch {
      collected = { events: [], cursor: { ...cursor, lastPolledAt: now.toISOString(), lastError: 'The trigger check failed; it will retry.' }, sourceKind: automation.trigger.kind };
    }
    summary.polled += 1;
    await mutateAutomationState((s) => { s.cursors[automation.id] = collected.cursor; });
    const res = await intake(automation, candidatesFor(automation, collected.events, collected.sourceKind), ctx, now);
    summary.queued += res.queued.length;
  }
  for (const automation of enabled) {
    const touched = await drainAutomation(automation, ctx);
    summary.dispatched += touched.filter((f) => f.state === 'dispatched' || f.state === 'awaiting-review').length;
    await trimQueue(automation, ctx);
  }
  return summary;
}

/** One tick (joins a tick already running in this process). Never throws. */
export function runAutomationsTick(deps: AutomationEngineDeps = {}): Promise<AutomationsTickSummary> {
  if (tickInFlight) return tickInFlight;
  const run = tickOnce(deps)
    .catch((): AutomationsTickSummary => ({ polled: 0, queued: 0, dispatched: 0, settled: 0, blocked: 'The automations tick failed; it will retry.' }))
    .finally(() => { tickInFlight = null; });
  tickInFlight = run;
  return run;
}

// ---------------------------------------------------------------------------
// Manual fire / webhook / Telegram
// ---------------------------------------------------------------------------

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,79}$/;
const HTTPS_URL = /^https:\/\/[^\s<>"']{1,2040}$/;

function eventFromText(repo: string, input: { title?: unknown; text?: unknown; key?: unknown; url?: unknown }): TriggerEvent | string {
  const text = untrustedText(input.text);
  if (text === '') return 'Describe the task (text is empty).';
  const title = untrustedTitle(input.title) || untrustedTitle(text.split('\n').find((l) => l.trim() !== '') ?? '');
  let key: string;
  if (input.key !== undefined && input.key !== null && input.key !== '') {
    if (typeof input.key !== 'string' || !KEY_RE.test(input.key)) return 'key must be a short id (letters, digits, . _ : # -).';
    key = input.key;
  } else {
    key = textKey(`${repo}\n${text}`);
  }
  let url: string | null = null;
  if (input.url !== undefined && input.url !== null && input.url !== '') {
    if (typeof input.url !== 'string' || !HTTPS_URL.test(input.url)) return 'url must be an https link.';
    url = input.url;
  }
  return { repo, vars: { key }, title: title || 'Task', text, url, ref: key.slice(0, 40) };
}

async function pickRepo(automation: AutomationV1, given: unknown, ctx: Ctx): Promise<string | { error: string }> {
  let repo = typeof given === 'string' ? given.trim() : '';
  if (repo === '') {
    if (automation.repos.length === 1 && automation.repos[0] !== AUTOMATION_ALL_GRANT_REPOS) repo = automation.repos[0]!;
    else return { error: 'Say which repo (owner/name) — this automation covers more than one.' };
  }
  if (!AUTOMATION_REPO_PATTERN.test(repo)) return { error: 'repo must look like owner/name.' };
  if (!(await repoInScope(automation, repo, ctx))) return { error: `${repo} is not one of this automation's repos.` };
  return repo;
}

async function planFor(automation: AutomationV1, candidates: readonly Candidate[], ctx: Ctx, now: Date): Promise<AutomationPlannedTask[]> {
  const state = await readAutomationState();
  const counts = limitCounts(automation.id, state, now);
  let capacity = automation.queueDepth + Math.max(0, automation.maxConcurrent - counts.active) - counts.queued;
  const planned: AutomationPlannedTask[] = [];
  for (const c of candidates) {
    const base = { dedupeKey: c.dedupeKey, repo: c.event.repo, title: c.event.title, lane: automation.lane };
    if (seenKey(automation.id, c.dedupeKey) in state.seen || recentlyDropped(state, automation.id, c.dedupeKey, now.getTime())) {
      planned.push({ ...base, verdict: 'dedupe: already handled' });
      continue;
    }
    if (capacity <= 0) {
      planned.push({ ...base, verdict: 'drop: queue full' });
      continue;
    }
    capacity -= 1;
    const gate = await laneGateRefusal(automation.lane, c.event.repo, ctx.lane);
    if (gate) {
      planned.push({ ...base, verdict: `queue, then wait: ${gate}` });
      continue;
    }
    let estimate: number;
    try { estimate = await ctx.lane.estimateUsd(automation.lane); } catch { estimate = Number.POSITIVE_INFINITY; }
    const refusal = limitRefusal(automation, counts, estimate);
    if (refusal) {
      planned.push({ ...base, verdict: `queue, then ${refusal.charAt(0).toLowerCase()}${refusal.slice(1)}` });
      continue;
    }
    counts.active += 1;
    counts.firedToday += 1;
    counts.spentThisMonthUsd += Number.isFinite(estimate) ? estimate : 0;
    planned.push({ ...base, verdict: automation.triage ? `dispatch to ${automation.lane} (triage may re-route; skipped in a dry run)` : `dispatch to ${automation.lane}` });
  }
  return planned;
}

/**
 * Fire an automation by hand (CLI `fire`, the view's "Run now"). Polling
 * triggers are checked NOW regardless of their interval; a schedule runs one
 * extra occurrence; webhook/Telegram automations need `repo` + `text`.
 * `dryRun` reads GitHub but writes nothing — no cursor, no firing, no journal.
 */
export async function fireAutomation(id: string, req: AutomationFireRequest = {}, deps: AutomationEngineDeps = {}): Promise<AutomationFireResponse> {
  const ctx = ctxOf(deps);
  const now = ctx.now();
  const dryRun = req.dryRun === true;
  const refuse = (error: string): AutomationFireResponse => ({ ok: false, dryRun, planned: [], firings: [], error });
  const { automations } = await readAutomations();
  const automation = automations.find((a) => a.id === id);
  if (!automation) return refuse(`No automation ${id}.`);

  let candidates: Candidate[];
  let cursor: AutomationCursor | null = null;
  if (typeof req.text === 'string' && req.text.trim() !== '') {
    const repo = await pickRepo(automation, req.repo, ctx);
    if (typeof repo !== 'string') return refuse(repo.error);
    const event = eventFromText(repo, { title: req.title, text: req.text });
    if (typeof event === 'string') return refuse(event);
    candidates = candidatesFor(automation, [event], 'manual');
  } else if (automation.trigger.kind === 'webhook' || automation.trigger.kind === 'telegram') {
    return refuse('This automation fires on a webhook or Telegram message — pass a repo and text to fire it by hand.');
  } else {
    const state = await readAutomationState();
    const collected = await collectEvents(automation, state.cursors[automation.id] ?? emptyCursor(), ctx, now, true);
    cursor = collected.cursor;
    candidates = candidatesFor(automation, collected.events, collected.sourceKind);
    if (collected.events.length === 0 && collected.cursor.lastError) {
      if (!dryRun) await mutateAutomationState((s) => { s.cursors[automation.id] = collected.cursor; });
      return refuse(collected.cursor.lastError);
    }
  }

  if (dryRun) return { ok: true, dryRun, planned: await planFor(automation, candidates, ctx, now), firings: [], error: null };

  if (cursor) {
    const next = cursor;
    await mutateAutomationState((s) => { s.cursors[automation.id] = next; });
  }
  const res = await intake(automation, candidates, ctx, now);
  const touched = await drainAutomation(automation, ctx);
  await trimQueue(automation, ctx);
  const byId = new Map<string, AutomationFiringV1>();
  for (const f of [...res.queued, ...res.dropped, ...touched]) byId.set(f.id, f);
  const planned: AutomationPlannedTask[] = res.deduped.map((c) => ({ dedupeKey: c.dedupeKey, repo: c.event.repo, title: c.event.title, lane: automation.lane, verdict: 'dedupe: already handled' }));
  return { ok: true, dryRun, planned, firings: [...byId.values()], error: null };
}

export interface WebhookResult {
  ok: boolean;
  status: 200 | 400 | 404 | 409;
  firing: AutomationFiringV1 | null;
  deduped: boolean;
  error: string | null;
}

/** A local tool (n8n, a Linear bridge) hands over one task. The route has already checked loopback + the mutation token. */
export async function receiveWebhook(id: string, body: AutomationWebhookRequest, deps: AutomationEngineDeps = {}): Promise<WebhookResult> {
  const ctx = ctxOf(deps);
  const { automations } = await readAutomations();
  const automation = automations.find((a) => a.id === id);
  if (!automation || automation.trigger.kind !== 'webhook') return { ok: false, status: 404, firing: null, deduped: false, error: 'No webhook automation with that id.' };
  if (!automation.enabled) return { ok: false, status: 409, firing: null, deduped: false, error: 'This automation is turned off.' };
  const repo = await pickRepo(automation, body.repo, ctx);
  if (typeof repo !== 'string') return { ok: false, status: 400, firing: null, deduped: false, error: repo.error };
  const event = eventFromText(repo, body as unknown as Record<string, unknown>);
  if (typeof event === 'string') return { ok: false, status: 400, firing: null, deduped: false, error: event };
  const res = await intake(automation, candidatesFor(automation, [event], 'webhook'), ctx, ctx.now());
  if (res.deduped.length > 0) return { ok: true, status: 200, firing: null, deduped: true, error: null };
  if (res.dropped.length > 0) return { ok: false, status: 409, firing: res.dropped[0]!, deduped: false, error: res.dropped[0]!.reason };
  const touched = await drainAutomation(automation, ctx);
  const firing = touched.find((f) => f.id === res.queued[0]?.id) ?? res.queued[0] ?? null;
  return { ok: true, status: 200, firing, deduped: false, error: null };
}

/** Telegram `/task <owner/repo> <text>` → the first enabled Telegram automation covering that repo. */
export async function receiveTelegramTask(repo: string, text: string, deps: AutomationEngineDeps = {}): Promise<{ ok: boolean; message: string }> {
  const ctx = ctxOf(deps);
  if (!AUTOMATION_REPO_PATTERN.test(repo)) return { ok: false, message: 'Usage: /task <owner/repo> <what to do>' };
  const { automations } = await readAutomations();
  let chosen: AutomationV1 | null = null;
  for (const a of automations.filter((x) => x.enabled && x.trigger.kind === 'telegram').sort((x, y) => x.name.localeCompare(y.name))) {
    if (await repoInScope(a, repo, ctx)) { chosen = a; break; }
  }
  if (!chosen) return { ok: false, message: `No enabled Telegram automation covers ${repo}. Add one in Verse → Automations.` };
  const event = eventFromText(repo, { text });
  if (typeof event === 'string') return { ok: false, message: event };
  const res = await intake(chosen, candidatesFor(chosen, [event], 'telegram'), ctx, ctx.now());
  if (res.deduped.length > 0) return { ok: true, message: 'Already taken — that exact task was handed over before.' };
  if (res.dropped.length > 0) return { ok: false, message: res.dropped[0]!.reason ?? 'Dropped: the queue is full.' };
  const touched = await drainAutomation(chosen, ctx);
  const firing = touched.find((f) => f.id === res.queued[0]?.id) ?? res.queued[0];
  if (!firing) return { ok: false, message: 'Nothing was queued.' };
  const where = firing.lane === 'leader-review' ? 'review in Needs-you' : `the ${firing.lane} lane`;
  return { ok: true, message: firing.state === 'queued' ? `Queued for ${where}. ${firing.reason ?? ''}`.trim() : `Sent to ${where}: ${firing.title}` };
}

// ---------------------------------------------------------------------------
// Review (leader-review lane)
// ---------------------------------------------------------------------------

export type ReviewResult = { ok: true; firing: AutomationFiringV1 } | { ok: false; status: 404 | 409; error: string };

/**
 * Approve: the firing goes to its automation's working lane (fleet when the
 * automation itself is review-only), through the same gates as any dispatch.
 * Reject: closed. Only Mason reaches this (mutation token).
 */
export async function reviewFiring(firingId: string, decision: 'approve' | 'reject', deps: AutomationEngineDeps = {}): Promise<ReviewResult> {
  const ctx = ctxOf(deps);
  const state = await readAutomationState();
  const firing = state.firings.find((f) => f.id === firingId);
  if (!firing) return { ok: false, status: 404, error: 'No such firing.' };
  if (firing.state !== 'awaiting-review') return { ok: false, status: 409, error: `This firing is ${firing.state}, not waiting for review.` };
  const { automations } = await readAutomations();
  const automation = automations.find((a) => a.id === firing.automationId);

  let outcome: LaneOutcome | null = null;
  let lane = firing.lane;
  if (decision === 'approve') {
    if (!automation) return { ok: false, status: 409, error: 'Its automation was deleted; reject it instead.' };
    lane = automation.lane === 'leader-review' ? 'fleet' : automation.lane;
    const gate = await laneGateRefusal(lane, firing.repo, ctx.lane);
    if (gate) return { ok: false, status: 409, error: gate };
    outcome = await dispatchToLane(automation, { ...firing, lane }, ctx.lane);
    if (outcome.kind === 'deferred' || outcome.kind === 'refused') return { ok: false, status: 409, error: outcome.reason };
  }
  let result: ReviewResult = { ok: false, status: 409, error: 'The firing changed while it was being reviewed.' };
  let record: AutomationJournalRecord | null = null;
  await mutateAutomationState((s) => {
    const f = s.firings.find((x) => x.id === firingId);
    if (!f || f.state !== 'awaiting-review') return;
    const iso = ctx.now().toISOString();
    if (outcome) {
      f.lane = lane;
      applyOutcome(f, outcome, iso);
      f.reason = `Approved in Needs-you. ${f.reason ?? ''}`.trim();
    } else {
      Object.assign(f, { state: 'rejected', settledAt: iso, updatedAt: iso, reason: 'Rejected in Needs-you.' });
    }
    record = journalRecord(f, 'reviewed', iso);
    result = { ok: true, firing: { ...f } };
  });
  if (record) await appendAutomationJournal([record]);
  return result;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const OVERVIEW_FIRINGS = 100;

/** Disk reads only (async) — the blocked reason is the last tick's, never computed here. */
export async function automationsOverview(opts: { schedulerRunning: boolean; now?: Date } = { schedulerRunning: false }): Promise<AutomationsOverviewResponse> {
  const now = opts.now ?? new Date();
  const [{ automations }, state] = await Promise.all([readAutomations(), readAutomationState()]);
  return {
    generatedAt: now.toISOString(),
    automations: automations.map((a) => automationView(a, state, now)),
    firings: [...state.firings].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, OVERVIEW_FIRINGS),
    templates: [...AUTOMATION_TEMPLATES],
    blocked: opts.schedulerRunning ? lastBlockedReason() : 'The automations scheduler is not running in this process (Verse server off, test run, or ASHLR_AUTOMATIONS_AUTO=0).',
    schedulerRunning: opts.schedulerRunning,
  };
}

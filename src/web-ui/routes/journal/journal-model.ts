/**
 * routes/journal/journal-model.ts — pure merge/sort of every history source
 * the read API actually exposes into one chronological feed. No React, no
 * fetch — trivially unit-testable, same split as data/cache.ts.
 *
 * HONESTY, spelled out because it matters for this specific view: the
 * operator's real machine has ~672 historical proposals and weeks of
 * daemon-activity JSONL on disk, per the build brief. None of that is
 * reachable through the current read-only web API — there is no bulk
 * historical-proposal endpoint (only `/api/inbox`, pending-only) and no
 * endpoint for the JSONL files. This model merges what IS exposed:
 *   - up to 200 daemon tick/merge/info/dispatch log lines (/api/logs-observation)
 *   - up to 20 recent merges / 20 recent ticks / 20 recent agent actions
 *     (/api/fleet-activity — each independently capped server-side)
 *   - up to 200 recent runs (/api/runs)
 *   - all currently-pending proposals (/api/inbox)
 * JournalView surfaces that window explicitly rather than implying this is
 * the full history — see its "windowNote" caption.
 */
import type {
  ControlLogEntry,
  FleetActivitySnapshot,
  RunState,
  SourceQuality,
} from '../../data/api-types.js';
import type { ControlLogsObservation, InboxProposal } from '../../data/queries.js';

export type JournalSource = 'daemon-tick' | 'merge' | 'agent-action' | 'run' | 'proposal';

export interface JournalDrillIn {
  proposalId?: string;
  runId?: string;
}

export interface JournalEntry {
  id: string;
  ts: string;
  source: JournalSource;
  title: string;
  detail: string;
  repo?: string;
  /** Fed straight to <StatusBadge status=.../> — statusToTone() decides the color. */
  statusLabel: string;
  sourceQuality?: SourceQuality;
  drillIn?: JournalDrillIn;
}

export interface JournalBuildInputs {
  logs?: ControlLogsObservation;
  fleetActivity?: FleetActivitySnapshot;
  runs?: RunState[];
  inbox?: { pending: number; proposals: InboxProposal[] };
}

function logKindToStatus(kind: ControlLogEntry['kind']): string {
  switch (kind) {
    case 'merge':
      return 'merged';
    case 'dispatch':
      return 'running';
    case 'tick':
      return 'info';
    case 'info':
    default:
      return 'pending';
  }
}

export function buildJournalEntries(input: JournalBuildInputs): JournalEntry[] {
  const out: JournalEntry[] = [];

  for (const [i, entry] of (input.logs?.entries ?? []).entries()) {
    out.push({
      id: `log-${entry.ts}-${i}`,
      ts: entry.ts,
      source: 'daemon-tick',
      title: entry.kind === 'merge' ? 'Daemon merge' : entry.kind === 'dispatch' ? 'Daemon dispatch' : 'Daemon tick',
      detail: entry.msg + (entry.dryRun ? ' (dry run)' : ''),
      statusLabel: logKindToStatus(entry.kind),
      sourceQuality: input.logs?.sourceQuality,
    });
  }

  for (const [i, tick] of (input.fleetActivity?.recentTicks ?? []).entries()) {
    out.push({
      id: `fleet-tick-${tick.ts}-${i}`,
      ts: tick.ts,
      source: 'daemon-tick',
      title: 'Fleet tick',
      detail:
        [tick.reason, tick.directionReason].filter(Boolean).join(' — ') ||
        `${tick.merged} merged, $${tick.spentUsd.toFixed(2)} spent`,
      statusLabel: tick.dryRun ? 'pending' : 'info',
      sourceQuality: input.fleetActivity?.recentTicksSourceQuality,
    });
  }

  for (const [i, merge] of (input.fleetActivity?.recentMerges ?? []).entries()) {
    out.push({
      id: `merge-${merge.ts}-${i}`,
      ts: merge.ts,
      source: 'merge',
      title: `Merged in ${merge.repo ?? 'unknown repo'}`,
      detail: `${merge.engine ?? 'unknown engine'}${merge.proposalId ? ` · proposal ${merge.proposalId}` : ''}`,
      repo: merge.repo ?? undefined,
      statusLabel: 'merged',
      sourceQuality: input.fleetActivity?.recentMergesSourceQuality,
      drillIn: merge.proposalId ? { proposalId: merge.proposalId } : undefined,
    });
  }

  for (const [i, action] of (input.fleetActivity?.recentActions ?? []).entries()) {
    out.push({
      id: `action-${action.ts}-${i}`,
      ts: action.ts,
      source: 'agent-action',
      title: action.proseDigest ?? action.summary ?? action.action,
      detail: action.summary,
      repo: action.repo,
      statusLabel: action.outcome,
      // Every sibling block above wires its matching sourceQuality field
      // through (recentMergesSourceQuality, recentTicksSourceQuality below) so
      // a degraded read renders as genuinely unknown, not silently as healthy.
      // This block previously omitted it even though the backend already
      // populates recentActionsSource — fixed so agent-action rows don't
      // conflate "empty" with "couldn't look" next to rows that don't.
      sourceQuality: input.fleetActivity?.recentActionsSource,
      drillIn: action.proposalId ? { proposalId: action.proposalId } : action.runId ? { runId: action.runId } : undefined,
    });
  }

  for (const run of input.runs ?? []) {
    out.push({
      id: `run-${run.id}`,
      ts: run.updatedAt,
      source: 'run',
      title: run.goal,
      detail: run.result ?? run.terminationReason ?? `${run.steps.length} step(s), ${run.tasks.length} task(s)`,
      statusLabel: run.status,
      drillIn: { runId: run.id },
    });
  }

  for (const proposal of input.inbox?.proposals ?? []) {
    out.push({
      id: `proposal-pending-${proposal.id}`,
      ts: proposal.createdAt,
      source: 'proposal',
      title: proposal.title,
      detail: `${proposal.kind} · ${proposal.origin}`,
      repo: proposal.repo,
      statusLabel: 'pending',
      drillIn: { proposalId: proposal.id },
    });
  }

  out.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return out;
}

export interface JournalFilterState {
  sources: Set<JournalSource>;
  query: string;
  windowMs: number | null; // null = all available
}

/** Milliseconds since local midnight — used for the "today" quick-filter
 * (JournalFilters.tsx) and for the command palette's "open journal, filtered
 * to today" action, which needs the same number before the view even
 * mounts. A pure function (no Date.now() smuggled in as a default) so both
 * call sites and tests get the identical value for a given `now`. */
export function startOfTodayMs(now: Date = new Date()): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return now.getTime() - start.getTime();
}

export function filterJournalEntries(entries: JournalEntry[], filter: JournalFilterState): JournalEntry[] {
  const now = Date.now();
  const q = filter.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (!filter.sources.has(e.source)) return false;
    if (filter.windowMs !== null && now - new Date(e.ts).getTime() > filter.windowMs) return false;
    if (q) {
      const haystack = `${e.title} ${e.detail} ${e.repo ?? ''} ${e.statusLabel}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/** Hourly density buckets for the scrub timeline, oldest-first. */
export function bucketByHour(entries: JournalEntry[], hours: number): { bucketStartMs: number; count: number }[] {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const buckets: { bucketStartMs: number; count: number }[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    buckets.push({ bucketStartMs: now - i * hourMs, count: 0 });
  }
  for (const e of entries) {
    const t = new Date(e.ts).getTime();
    const age = now - t;
    if (age < 0 || age > hours * hourMs) continue;
    const idx = hours - 1 - Math.floor(age / hourMs);
    if (idx >= 0 && idx < buckets.length) buckets[idx]!.count += 1;
  }
  return buckets;
}

/**
 * data/queries.ts — one typed accessor per backend resource. Each pairs a
 * stable cache key (also the SSE invalidation target — see sse.ts's
 * EVENT_TO_CACHE_KEYS) with the exact GET call and response type. Views
 * never call apiGet directly; they call these through useQuery (hooks.ts)
 * so caching, de-dupe, and SSE-driven refresh are automatic.
 */
import { apiGet } from './client.js';
import type {
  ControlLogEntry,
  ControlSnapshot,
  DashboardSnapshot,
  DecisionEntry,
  FleetActivitySnapshot,
  FleetStatus,
  Proposal,
  ProposalStatus,
  PublicDaemonObservation,
  RunState,
  SwarmRun,
  ActivityRollup,
  GenomeEntry,
  RecallHit,
  PortfolioSummary,
  ModelStatsReadResult,
} from './api-types.js';
import type { SourceQuality } from './api-types.js';

export interface QueryDef<T> {
  key: string;
  fetch: (signal?: AbortSignal) => Promise<T>;
}

export const dashboardSnapshotQuery: QueryDef<DashboardSnapshot> = {
  key: 'dashboard-snapshot',
  fetch: (signal) => apiGet<DashboardSnapshot>('/api/snapshot', signal),
};

export const controlSnapshotQuery: QueryDef<ControlSnapshot> = {
  key: 'control-snapshot',
  fetch: (signal) => apiGet<ControlSnapshot>('/api/control', signal),
};

// NOTE: there is no standalone GET /api/visibility route — VisibilitySnapshot
// is an optional field on DashboardSnapshot (`.visibility`), populated by
// buildSnapshot() server-side. Read it off dashboardSnapshotQuery's data
// rather than issuing a second request for it.

/**
 * GET /api/runs returns the bare array (see src/core/web/api.ts:1121-1125,
 * `listRuns({limit:200})` -> `RunState[]`) — NOT `{runs: [...]}`. The prior
 * `RunSummary`/`runsQuery` pair here was speculative and didn't match the
 * real response shape; it was unused (FleetDashboardView reads its compact
 * run summaries off `DashboardSnapshot['runs']` instead, a different,
 * deliberately-thin shape). Replaced with the real, fully-typed contract.
 */
export const runsQuery: QueryDef<RunState[]> = {
  key: 'runs',
  fetch: (signal) => apiGet<RunState[]>('/api/runs', signal),
};

export function runDetailQuery(id: string): QueryDef<RunState> {
  return {
    key: `run-detail-${id}`,
    fetch: (signal) => apiGet<RunState>(`/api/run/${encodeURIComponent(id)}`, signal),
  };
}

export const swarmsQuery: QueryDef<SwarmRun[]> = {
  key: 'swarms',
  fetch: (signal) => apiGet<SwarmRun[]>('/api/swarms', signal),
};

export function swarmDetailQuery(id: string): QueryDef<SwarmRun> {
  return {
    key: `swarm-detail-${id}`,
    fetch: (signal) => apiGet<SwarmRun>(`/api/swarm/${encodeURIComponent(id)}`, signal),
  };
}

/**
 * Same PublicDaemonObservation the backend embeds at ControlSnapshot.daemonObservation
 * — fetched standalone here because /control/daemon renders a fuller detail page
 * than DaemonPanel's dashboard-compact view and wants the raw observation
 * (including `ticks`) independent of whether the rest of /api/control succeeds.
 * Cache key 'daemon' deliberately matches sse.ts's existing (previously orphaned)
 * `daemon` / `daemon-observation` -> ['daemon'] mapping so this now actually
 * live-updates.
 */
export const daemonObservationQuery: QueryDef<PublicDaemonObservation> = {
  key: 'daemon',
  fetch: (signal) => apiGet<PublicDaemonObservation>('/api/daemon-observation', signal),
};

export const fleetStatusQuery: QueryDef<FleetStatus> = {
  key: 'fleet',
  fetch: (signal) => apiGet<FleetStatus>('/api/fleet', signal),
};

export const fleetActivityQuery: QueryDef<FleetActivitySnapshot> = {
  key: 'fleet-activity',
  fetch: (signal) => apiGet<FleetActivitySnapshot>('/api/fleet-activity', signal),
};

/**
 * GET /api/goals returns a bare array of ad-hoc per-goal projections built
 * inline in src/core/web/api.ts (`path === '/api/goals'`, ~line 1654) — there
 * is no exported backend type for this shape (unlike every other resource
 * here), so this interface is hand-written to match that handler exactly
 * rather than re-exported. Keep it in sync with api.ts if that handler's
 * shape changes.
 */
export interface GoalMilestoneSummary {
  title: string;
  status: string;
  order: number;
}

export interface GoalSummary {
  id: string;
  objective: string;
  status: string;
  milestones: GoalMilestoneSummary[];
  progress: {
    fractionDone: number;
    counts: Record<string, number>;
    nextActionableId: string | null;
  };
}

export const goalsQuery: QueryDef<GoalSummary[]> = {
  key: 'goals',
  fetch: (signal) => apiGet<GoalSummary[]>('/api/goals', signal),
};

/**
 * GET /api/vision/mission — buildVisionMissionSnapshot() in src/core/web/api.ts
 * is itself typed `Promise<Record<string, unknown>>` on the backend (no
 * exported interface to import), so this is a narrow hand-written contract
 * covering only the fields the Goals view actually reads: top-level `state`
 * (mirrors the SourceQuality.sourceState vocabulary) and the per-source
 * epistemic breakdown under `sources`. `briefing`/`preview`/`shadow` are
 * deliberately left as `unknown` — the view does not render briefing prose.
 */
export interface VisionMissionSourceStatus {
  sourceState: 'healthy' | 'degraded' | 'missing' | 'unknown';
  sourcePresent?: boolean;
  complete: boolean;
  reason?: string;
}

export interface VisionMissionSnapshot {
  schemaVersion: number;
  state: string;
  authority: string;
  briefing: unknown;
  sources: {
    briefing: VisionMissionSourceStatus | null;
    goals: VisionMissionSourceStatus | null;
    enrollment: VisionMissionSourceStatus | null;
    proposals: VisionMissionSourceStatus | null;
  };
}

export const visionMissionQuery: QueryDef<VisionMissionSnapshot> = {
  key: 'vision-mission',
  fetch: (signal) => apiGet<VisionMissionSnapshot>('/api/vision/mission', signal),
};

export interface InboxProposal {
  id: string;
  title: string;
  kind: string;
  repo: string;
  origin: string;
  createdAt: string;
}

export const inboxQuery: QueryDef<{ pending: number; proposals: InboxProposal[] }> = {
  key: 'inbox',
  fetch: (signal) => apiGet('/api/inbox', signal),
};

/**
 * `?status=&since=&limit=` view over GET /api/inbox (src/core/web/api.ts
 * INBOX_STATUS_QUERY_VALUES) — the history surface `inboxQuery` above never
 * had: it's hardcoded pending-only. `status: undefined` = server default
 * (pending); `'all'` = every status. Keyed per filter combo so switching
 * status/since/limit doesn't fight over one cache entry, and so sse.ts can
 * sweep every live combo (`invalidatePrefix('inbox-list:')`) on the 'inbox'
 * SSE event without knowing which combos are mounted.
 */
export type InboxHistoryStatus = ProposalStatus | 'all';

export interface InboxListFilters {
  status?: InboxHistoryStatus;
  /** ISO timestamp or YYYY-MM-DD, passed straight through to the server. */
  since?: string;
  limit?: number;
}

export interface InboxListResponse {
  pending: number;
  total: number;
  /**
   * Full `Proposal[]`, not the narrow `InboxProposal` shape above — the
   * server has always sent full sanitized Proposal records here
   * (`listProposals()`); `InboxProposal` just under-typed it for the
   * original pending-badge use case. The history view needs `status` and
   * `decisionReason` per row (triage: "why was this rejected") without an
   * N+1 decisions-ledger read per row, and both live directly on Proposal.
   */
  proposals: Proposal[];
  /** True when more rows matched than were returned (hit the server cap). */
  truncated: boolean;
  filters: { status: InboxHistoryStatus; since: string | null; limit: number | null };
}

export function inboxListQuery(filters: InboxListFilters = {}): QueryDef<InboxListResponse> {
  const params = new URLSearchParams();
  if (filters.status !== undefined) params.set('status', filters.status);
  if (filters.since !== undefined) params.set('since', filters.since);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return {
    key: `inbox-list:${filters.status ?? 'pending'}:${filters.since ?? ''}:${filters.limit ?? ''}`,
    fetch: (signal) => apiGet<InboxListResponse>(`/api/inbox${qs ? `?${qs}` : ''}`, signal),
  };
}

/**
 * Evidence behind a judge's verdict for one proposal — joined server-side
 * (src/core/web/api.ts GET /api/inbox/:id) from the decisions ledger, which
 * is the ONLY place `judgeReasonCode` lives (Proposal itself never carries
 * it). `judge-parse-failure`/`judge-network-failure` are infra failures,
 * never a considered `judge-review` — render them distinctly, never folded
 * together. When the ledger read is degraded or no row matches this
 * proposal, `sourceQuality` says so; render "unknown" via <Epistemic/>
 * rather than treating an empty `decisions` array as "never judged".
 */
export interface InboxDecisionEvidence {
  sourceQuality: SourceQuality;
  decisions: DecisionEntry[];
}

/**
 * GET /api/inbox/:id — full proposal detail including diff/taste/verdict
 * (src/core/web/api.ts:1240-1255, `loadProposal(id)`) plus `decisionEvidence`
 * (readDecisionsDetailed({proposalId}), added alongside the inbox history
 * view). Used by the work journal's "why did it do that" drill-in (M416) —
 * `/api/inbox` only ever returns pending proposals, but a decided
 * proposal's id (surfaced via fleet-activity's recentMerges/recentActions,
 * or via inboxListQuery's history view) still resolves here as long as its
 * on-disk record hasn't been pruned.
 */
export function proposalDetailQuery(id: string): QueryDef<Proposal & { decisionEvidence: InboxDecisionEvidence }> {
  return {
    key: `proposal-detail-${id}`,
    fetch: (signal) =>
      apiGet<Proposal & { decisionEvidence: InboxDecisionEvidence }>(`/api/inbox/${encodeURIComponent(id)}`, signal),
  };
}

/**
 * GET /api/logs-observation?tail=200 — the provenance-bearing sibling of
 * GET /api/logs (src/core/web/api.ts:~1543-1560): same daemon tick/merge
 * log, plus `sourceQuality` so a degraded/incomplete log can be rendered
 * honestly via <Epistemic/> instead of silently showing a truncated or
 * stale list as complete. `entries` is `null` when the source itself is not
 * healthy+complete (server-side contract, not a client guess). Used by the
 * work journal (M416) as one of several merged history sources — NOT a
 * substitute for full on-disk history: this is capped at 200 entries
 * server-side and only carries daemon tick/merge/info/dispatch events, not
 * raw run stdout or the ~672 historical proposals living only on disk.
 */
export interface ControlLogsObservation {
  entries: ControlLogEntry[] | null;
  sourceQuality: SourceQuality;
}

export const controlLogsObservationQuery: QueryDef<ControlLogsObservation> = {
  key: 'control-logs-observation',
  fetch: (signal) => apiGet<ControlLogsObservation>('/api/logs-observation?tail=200', signal),
};

// ---------------------------------------------------------------------------
// Intelligence + Portfolio (charts/dataviz work)
// ---------------------------------------------------------------------------

export type PulseWindow = '1d' | '7d' | '30d';

/** GET /api/pulse?window= — buildRollup() (src/core/observability/rollup.ts).
 * Parameterized like runDetailQuery/swarmDetailQuery above: a distinct cache
 * key per window so switching windows doesn't fight over one cache entry. */
export function pulseQuery(window: PulseWindow): QueryDef<ActivityRollup> {
  return {
    key: `pulse-${window}`,
    fetch: (signal) => apiGet<ActivityRollup>(`/api/pulse?window=${window}`, signal),
  };
}

/**
 * GET /api/genome[?q=] — src/core/web/api.ts:1189-1201. Two response shapes
 * depending on `q`: empty/absent `q` returns `GenomeEntry[]` (list mode,
 * `loadGenome()`); a non-empty `q` returns `RecallHit[]` (query mode,
 * `recall()`, `{entry, score, method}`). Use `isRecallHit` to discriminate —
 * the view can't know which shape it got from the type alone since both are
 * arrays. Keyed per query string so a debounced search doesn't stomp the
 * browse-mode cache entry.
 */
export type GenomeResult = GenomeEntry[] | RecallHit[];

export function isRecallHit(item: GenomeEntry | RecallHit): item is RecallHit {
  return typeof item === 'object' && item !== null && 'entry' in item && 'score' in item;
}

export function genomeQuery(q: string): QueryDef<GenomeResult> {
  const trimmed = q.trim();
  return {
    key: trimmed ? `genome-search-${trimmed}` : 'genome-list',
    fetch: (signal) =>
      apiGet<GenomeResult>(trimmed ? `/api/genome?q=${encodeURIComponent(trimmed)}` : '/api/genome', signal),
  };
}

export type ModelStatsWindow = '7d' | '30d' | 'all';

/** GET /api/models?window= — computeModelStatsDetailed() joined per-model
 * economics (src/core/fleet/model-stats.ts). NOTE: a second, dead
 * `/api/models` handler later in api.ts's if-chain (local-model provider
 * probe off ControlSnapshot.models) is unreachable — this one always wins
 * since route matching is first-match. */
export function modelsQuery(window: ModelStatsWindow): QueryDef<ModelStatsReadResult & { window: ModelStatsWindow }> {
  return {
    key: `models-${window}`,
    fetch: (signal) => apiGet(`/api/models?window=${window}`, signal),
  };
}

/**
 * GET /api/portfolio — src/core/web/api.ts:1105-1109. Returns
 * `DashboardSnapshot.portfolio ?? null`: `null` on an older producer or
 * empty enrollment, not an error — render that as an honest "not available"
 * state, never as a zeroed chart.
 */
export const portfolioQuery: QueryDef<PortfolioSummary | null> = {
  key: 'portfolio',
  fetch: (signal) => apiGet<PortfolioSummary | null>('/api/portfolio', signal),
};

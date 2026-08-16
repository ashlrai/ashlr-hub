/**
 * data/queries.ts — one typed accessor per backend resource. Each pairs a
 * stable cache key (also the SSE invalidation target — see sse.ts's
 * EVENT_TO_CACHE_KEYS) with the exact GET call and response type. Views
 * never call apiGet directly; they call these through useQuery (hooks.ts)
 * so caching, de-dupe, and SSE-driven refresh are automatic.
 */
import { apiGet } from './client.js';
import type { ControlSnapshot, DashboardSnapshot } from './api-types.js';

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

export interface RunSummary {
  id: string;
  goal: string;
  status: string;
  tokens: number;
}

export const runsQuery: QueryDef<{ runs: RunSummary[] }> = {
  key: 'runs',
  fetch: (signal) => apiGet('/api/runs', signal),
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

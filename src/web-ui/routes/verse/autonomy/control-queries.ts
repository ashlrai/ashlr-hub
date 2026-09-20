/**
 * routes/verse/autonomy/control-queries.ts — every `/api/verse/{control,caps,
 * scope,audit,daemon,safety}` call the Autonomy cockpit makes, plus the two
 * existing read-only feeds it borrows (`/api/goals`, `/api/backlog`).
 *
 * Same contract as routes/verse/verse-queries.ts: reads are QueryDefs consumed
 * through useQuery (cache-backed, so a background refresh never blanks a
 * populated panel); writes pull the held mutation token from auth-store, touch
 * the hold on success, and invalidate exactly the keys they affect.
 *
 * Two deliberate choices worth knowing before editing:
 *
 *  1. **The envelopes are now fixed, so nothing is normalized.**
 *     `/api/verse/scope` and `/api/verse/audit` are declared in
 *     `src/core/verse/control-types.ts` (`VerseScope`, `VerseAuditResponse`)
 *     and the handlers serialize exactly those, so these fetchers are typed
 *     straight through. The speculative bare-array/wrapper normalization that
 *     let this surface ship before the routes existed has been deleted.
 *     `/api/backlog` keeps its normalizer — that route really does answer
 *     `loadBacklog() ?? null` and is not part of the V2 contract.
 *  2. **Emergency stop is not a route of its own.** The global kill switch is
 *     `POST /api/fleet/pause` (and `/resume` to clear), already wrapped in
 *     data/mutations.ts. It is re-exported here under honest names so no call
 *     site in this folder can accidentally call it "pause".
 */
import { VERSE_AUDIT_MAX_LIMIT } from './control-types.js';
import type { GoalSummary, QueryDef } from '../../../data/queries.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { invalidate } from '../../../data/cache.js';
import { pauseFleet, resumeFleet } from '../../../data/mutations.js';
import type {
  VerseAuditFilters,
  VerseAuditPage,
  VerseCaps,
  VerseCapsApplyResult,
  VerseCapsPatch,
  VerseControlSnapshot,
  VerseDaemonAction,
  VerseDaemonActionResult,
  VerseSafetyReport,
  VerseScope,
  VerseScopePatch,
} from './control-types.js';

export const VERSE_CONTROL_KEY = 'verse-control';
export const VERSE_CAPS_KEY = 'verse-caps';
export const VERSE_SCOPE_KEY = 'verse-scope';
export const VERSE_SAFETY_KEY = 'verse-safety';
export const VERSE_AUDIT_PREFIX = 'verse-audit:';

/**
 * Server-side cap on `/api/verse/audit`, re-exported from the backend
 * contract module so the client cannot drift from the value the route
 * actually clamps to.
 */
export const VERSE_AUDIT_MAX = VERSE_AUDIT_MAX_LIMIT;
/** Enough rows that the table is the real "while I was asleep" view. */
export const VERSE_AUDIT_DEFAULT_LIMIT = 200;

export const verseControlQuery: QueryDef<VerseControlSnapshot> = {
  key: VERSE_CONTROL_KEY,
  fetch: (signal) => apiGet<VerseControlSnapshot>('/api/verse/control', signal),
};

export const verseCapsQuery: QueryDef<VerseCaps> = {
  key: VERSE_CAPS_KEY,
  fetch: (signal) => apiGet<VerseCaps>('/api/verse/caps', signal),
};

export const verseSafetyQuery: QueryDef<VerseSafetyReport> = {
  key: VERSE_SAFETY_KEY,
  fetch: (signal) => apiGet<VerseSafetyReport>('/api/verse/safety', signal),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const verseScopeQuery: QueryDef<VerseScope> = {
  key: VERSE_SCOPE_KEY,
  fetch: (signal) => apiGet<VerseScope>('/api/verse/scope', signal),
};

export function verseAuditQuery(filters: VerseAuditFilters = {}): QueryDef<VerseAuditPage> {
  const limit = Math.min(filters.limit ?? VERSE_AUDIT_DEFAULT_LIMIT, VERSE_AUDIT_MAX);
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (filters.action) params.set('action', filters.action);
  if (filters.result) params.set('result', filters.result);
  return {
    key: `${VERSE_AUDIT_PREFIX}${limit}:${filters.action ?? ''}:${filters.result ?? ''}`,
    fetch: (signal) => apiGet<VerseAuditPage>(`/api/verse/audit?${params.toString()}`, signal),
  };
}

/**
 * Read-only in V2 — the contract is explicit that no goal-mutation routes get
 * built here. `/api/goals` returns a bare array; `/api/backlog` returns
 * `loadBacklog() ?? null`, i.e. `null` is "no backlog on disk", not an error.
 */
export const verseGoalsQuery: QueryDef<GoalSummary[]> = {
  key: 'goals',
  fetch: (signal) => apiGet<GoalSummary[]>('/api/goals', signal),
};

/** One backlog row, narrowed to what the read-only summary renders. */
export interface VerseBacklogItem {
  id?: string;
  title?: string;
  repo?: string;
  score?: number;
  source?: string;
}

export interface VerseBacklogSummary {
  items: VerseBacklogItem[];
  /** True when the server answered `null` — no backlog has been built yet. */
  absent: boolean;
}

export function normalizeBacklog(raw: unknown): VerseBacklogSummary {
  if (raw === null || raw === undefined) return { items: [], absent: true };
  if (Array.isArray(raw)) return { items: raw as VerseBacklogItem[], absent: false };
  if (isRecord(raw) && Array.isArray(raw['items'])) {
    return { items: raw['items'] as VerseBacklogItem[], absent: false };
  }
  return { items: [], absent: true };
}

export const verseBacklogQuery: QueryDef<VerseBacklogSummary> = {
  key: 'backlog',
  fetch: (signal) => apiGet<unknown>('/api/backlog', signal).then(normalizeBacklog),
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Thrown before any network call when no mutation token is held. */
export class VerseControlLockedError extends Error {
  constructor() {
    super('Unlock actions with the mutation token before changing the loop.');
    this.name = 'VerseControlLockedError';
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

/** Every panel in the cockpit reads through one of these three. */
export function invalidateControl(): void {
  invalidate(VERSE_CONTROL_KEY);
}

export async function updateVerseCaps(patch: VerseCapsPatch): Promise<VerseCapsApplyResult> {
  const result = await post<VerseCapsApplyResult>('/api/verse/caps', patch);
  invalidate(VERSE_CAPS_KEY);
  invalidateControl();
  return result;
}

export async function updateVerseScope(patch: VerseScopePatch): Promise<void> {
  await post<unknown>('/api/verse/scope', patch);
  invalidate(VERSE_SCOPE_KEY);
  invalidateControl();
}

export async function runDaemonAction(action: VerseDaemonAction): Promise<VerseDaemonActionResult> {
  const result = await post<VerseDaemonActionResult>('/api/verse/daemon', { action });
  invalidateControl();
  invalidate('daemon');
  return result;
}

/**
 * ENGAGE the global kill switch (`~/.ashlr/KILL`). This is `POST
 * /api/fleet/pause` under its honest name: it stops the daemon AND refuses
 * the agent's own mcp-native write tools. Never surface it as "pause".
 */
export async function engageEmergencyStop(): Promise<void> {
  await pauseFleet();
  invalidateControl();
}

/** Clear the kill switch — writes become possible again fleet-wide. */
export async function releaseEmergencyStop(): Promise<void> {
  await resumeFleet();
  invalidateControl();
}

/**
 * routes/verse/command/surface-data.ts — every read and write behind the
 * four 3.10 surfaces (Command, Fleet, Growth, Mind), in one place (unit C7).
 *
 *   GET  /api/verse/authority         AuthorityStatusV1     (B-U1)
 *   GET  /api/verse/authority/draft   AuthorityGrantDraft   (B-U1)
 *   POST /api/verse/authority         AuthorityActionRequest
 *   GET  /api/verse/fleet/live        FleetLiveSnapshotV1   (B-U5)
 *   POST /api/verse/fleet/live        FleetLiveActionRequest
 *   GET  /api/verse/leader            LeaderStateV1         (B-U8)
 *   POST /api/verse/leader            LeaderActionRequest
 *   GET  /api/verse/learning          LearningStateV1       (B-U9)
 *   GET  /api/verse/activity          VerseActivityResponse (C1 — read through
 *                                     the shell's ONE useActivity poll, never a
 *                                     second loop from here)
 *   GET  /api/verse/fleet/history     FleetHistoryResponse  (A8)
 *   GET  /api/reasoning/digest        ReasoningDigest       (A7)
 *   GET  /api/verse/budget            BudgetView            (A9 — budget-queries.ts)
 *   GET  /api/verse/budget/history    CapacityHistoryResponse (3.10.1 — recorded
 *                                     seat window history for the burn-downs)
 *   GET  /api/models                  per-model ROI         (data/queries.ts)
 *
 * WHY every read is OPTIONAL: Track B's modules land in parallel with these
 * surfaces (SPEC-310BC-COORD), and C0's mount answers 404 for a family that
 * has not landed. A 404 is "this card has no source yet", never "Command is
 * broken" — so a read resolves to `{ value: null, available: false, reason }`
 * and the card renders a designed not-available state from `reason`. A body
 * this client cannot narrow is treated the same way (available, but nothing
 * shown rather than guessed). 401 and aborts still propagate: an expired
 * read session is the whole app's state, not one card's.
 *
 * Writes pull the held mutation token (VerseControlLockedError without one —
 * the surfaces route every write through useGuardedAction, which opens the
 * token dialog first) and invalidate exactly the keys they change.
 */
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { refreshActivity } from '../shell/useActivity.js';
import type { OptionalFleetRead } from '../autonomy/fleet-contract.js';
import type {
  AuthorityActionRequest,
  AuthorityGrantDraft,
  AuthorityStatusV1,
} from '../../../../core/authority/types.js';
import type { FleetLiveActionRequest, FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { LeaderActionRequest, LeaderStateV1 } from '../../../../core/vision/leader-types.js';
import type { LearningStateV1 } from '../../../../core/learn/harness-types.js';
import type { VerseActivityResponse } from '../../../../core/verse/workbench-types.js';
import type { FleetHistoryResponse } from '../../../../core/verse/fleet-history-types.js';
import type { ReasoningDigest } from '../../../../core/reasoning/types.js';
import type { CapacityHistoryResponse } from '../../../../core/routing/capacity-history-types.js';

/** A read that is allowed to be absent (the autonomy folder's shape, reused). */
export type OptionalRead<T> = OptionalFleetRead<T>;

export const AUTHORITY_PATH = '/api/verse/authority';
export const AUTHORITY_DRAFT_PATH = '/api/verse/authority/draft';
export const FLEET_LIVE_PATH = '/api/verse/fleet/live';
export const LEADER_PATH = '/api/verse/leader';
export const LEARNING_PATH = '/api/verse/learning';
export const FLEET_HISTORY_PATH = '/api/verse/fleet/history?days=90';
export const REASONING_DIGEST_PATH = '/api/reasoning/digest?days=30';
/** Eight days: the whole weekly window plus the day before it opened. */
export const SEAT_HISTORY_PATH = '/api/verse/budget/history?days=8';

export const SURFACE_KEYS = Object.freeze({
  authority: 'verse-authority',
  authorityDraft: 'verse-authority-draft',
  fleetLive: 'verse-fleet-live',
  leader: 'verse-leader',
  learning: 'verse-learning',
  fleetHistory: 'verse-fleet-history-90d',
  reasoningDigest: 'verse-reasoning-digest-30d',
  seatHistory: 'verse-seat-history-8d',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Structural guards: just enough to know the body is the contract's shape
 * (version tag + the arrays the cards iterate), so a mismatched server can
 * never crash a render with `undefined.map`. Field-level honesty (null =
 * unknown) is the cards' job.
 */
export const narrow = {
  authority(raw: unknown): AuthorityStatusV1 | null {
    return isRecord(raw) && raw['v'] === 1 && typeof raw['switch'] === 'string' && isRecord(raw['grant']) ? (raw as unknown as AuthorityStatusV1) : null;
  },
  draft(raw: unknown): AuthorityGrantDraft | null {
    return isRecord(raw) && isRecord(raw['payload']) && typeof raw['digest'] === 'string' ? (raw as unknown as AuthorityGrantDraft) : null;
  },
  fleetLive(raw: unknown): FleetLiveSnapshotV1 | null {
    return isRecord(raw) && raw['v'] === 1 && Array.isArray(raw['runs']) && Array.isArray(raw['repos']) && Array.isArray(raw['lanes']) && isRecord(raw['summary'])
      ? (raw as unknown as FleetLiveSnapshotV1)
      : null;
  },
  leader(raw: unknown): LeaderStateV1 | null {
    return isRecord(raw) && raw['v'] === 1 && Array.isArray(raw['timeline']) && Array.isArray(raw['actions']) && isRecord(raw['hitRate'])
      ? (raw as unknown as LeaderStateV1)
      : null;
  },
  learning(raw: unknown): LearningStateV1 | null {
    return isRecord(raw) && raw['v'] === 1 && Array.isArray(raw['versions']) && Array.isArray(raw['experiments']) ? (raw as unknown as LearningStateV1) : null;
  },
  activity(raw: unknown): VerseActivityResponse | null {
    return isRecord(raw) && Array.isArray(raw['needsYou']) && Array.isArray(raw['running']) && isRecord(raw['sources']) ? (raw as unknown as VerseActivityResponse) : null;
  },
  fleetHistory(raw: unknown): FleetHistoryResponse | null {
    return isRecord(raw) && Array.isArray(raw['days']) && isRecord(raw['sources']) && isRecord(raw['funnel']) ? (raw as unknown as FleetHistoryResponse) : null;
  },
  reasoningDigest(raw: unknown): ReasoningDigest | null {
    return isRecord(raw) && Array.isArray(raw['insights']) && Array.isArray(raw['trends']) && isRecord(raw['totals']) ? (raw as unknown as ReasoningDigest) : null;
  },
  /** Series and points are re-checked one by one where they are merged (command-model mergeSeatHistory). */
  seatHistory(raw: unknown): CapacityHistoryResponse | null {
    return isRecord(raw) && raw['v'] === 1 && Array.isArray(raw['series']) ? (raw as unknown as CapacityHistoryResponse) : null;
  },
};

/** Operator words for a source that did not answer (never a path, never a trace). */
function absence(what: string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return `${what} is not in this build yet, so this card has no source.`;
    if (err.status === 503) return `${what} failed to load on the server.`;
    // A refusal the route explained (409 with a sentence): say it, not the status.
    if (err.detail && err.status < 500) return /[.!?]$/.test(err.detail) ? err.detail : `${err.detail}.`;
    return `${what} answered HTTP ${err.status}.`;
  }
  return `${what} could not be reached.`;
}

/** A QueryDef whose value is an OptionalRead: 404 / unreachable / unrecognised all resolve, never throw. */
export function optionalQuery<T>(key: string, path: string, what: string, guard: (raw: unknown) => T | null): QueryDef<OptionalRead<T>> {
  return {
    key,
    fetch: async (signal) => {
      try {
        const raw = await apiGet<unknown>(path, signal);
        const value = guard(raw);
        if (value === null) {
          // Nothing is shown rather than guessed from an unknown shape.
          return { value: null, available: true, reason: 'Unrecognized response — update Ashlr.' };
        }
        return { value, available: true, reason: null };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw err;
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        return { value: null, available: false, reason: absence(what, err), code: err instanceof ApiError ? err.code : null };
      }
    },
  };
}

export const authorityQuery = optionalQuery(SURFACE_KEYS.authority, AUTHORITY_PATH, 'The authority service', narrow.authority);
export const authorityDraftQuery = optionalQuery(SURFACE_KEYS.authorityDraft, AUTHORITY_DRAFT_PATH, 'The grant draft', narrow.draft);
export const fleetLiveQuery = optionalQuery(SURFACE_KEYS.fleetLive, FLEET_LIVE_PATH, 'The live fleet view', narrow.fleetLive);
export const leaderQuery = optionalQuery(SURFACE_KEYS.leader, LEADER_PATH, 'The Leader', narrow.leader);
export const learningQuery = optionalQuery(SURFACE_KEYS.learning, LEARNING_PATH, 'Self-improvement', narrow.learning);
export const fleetHistoryQuery = optionalQuery(SURFACE_KEYS.fleetHistory, FLEET_HISTORY_PATH, 'Fleet history', narrow.fleetHistory);
export const reasoningDigestQuery = optionalQuery(SURFACE_KEYS.reasoningDigest, REASONING_DIGEST_PATH, 'The reasoning digest', narrow.reasoningDigest);
/** Optional like every surface read: a server without the route leaves the burn-downs on this page's own readings. */
export const seatHistoryQuery = optionalQuery(SURFACE_KEYS.seatHistory, SEAT_HISTORY_PATH, 'Seat history', narrow.seatHistory);

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

/**
 * One authority action. The server answers the new AuthorityStatusV1 for
 * every form; raising past the grant is its 409 `grant-required` (the page
 * opens the Touch ID sheet BEFORE ever sending that, but the server is the
 * authority — a stale page gets the refusal, not a raise).
 */
export async function postAuthority(action: AuthorityActionRequest): Promise<AuthorityStatusV1 | null> {
  const result = await post<unknown>(AUTHORITY_PATH, action);
  invalidate(SURFACE_KEYS.authority);
  invalidate(SURFACE_KEYS.fleetLive);
  void refreshActivity();
  if (action.action === 'grant' || action.action === 're-approve') invalidate(SURFACE_KEYS.authorityDraft);
  return narrow.authority(result);
}

export async function postFleetLive(action: FleetLiveActionRequest): Promise<unknown> {
  const result = await post<unknown>(FLEET_LIVE_PATH, action);
  invalidate(SURFACE_KEYS.fleetLive);
  void refreshActivity();
  return result;
}

export async function postLeader(action: LeaderActionRequest): Promise<unknown> {
  const result = await post<unknown>(LEADER_PATH, action);
  invalidate(SURFACE_KEYS.leader);
  void refreshActivity();
  return result;
}

/**
 * A Needs-you item's own action. `path` was validated by the producer
 * (isNeedsYouItem → isSafeApiRoute) and is re-checked here: the mutation
 * token must never be aimed anywhere but this origin's /api/.
 */
export async function postNeedsYouAction(path: string, body: Record<string, unknown>): Promise<unknown> {
  if (!/^\/api\/[^\s\\]*$/.test(path) || path.startsWith('//') || path.includes('..')) {
    throw new Error('That action points outside this app, so it was not sent.');
  }
  const result = await post<unknown>(path, body);
  void refreshActivity();
  invalidate(SURFACE_KEYS.fleetLive);
  invalidate(SURFACE_KEYS.leader);
  invalidate(SURFACE_KEYS.authority);
  return result;
}

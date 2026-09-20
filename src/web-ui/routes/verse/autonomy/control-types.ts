/**
 * routes/verse/autonomy/control-types.ts
 *
 * The V2 control-plane shapes, re-exported from the ONE declaration site:
 * `src/core/verse/control-types.ts` (owner B), by way of
 * `src/web-ui/data/api-types.ts`. This file used to hold a local
 * transcription of the contract prose because the backend module did not
 * exist yet; that block is gone and the cockpit is now typed by the same
 * declarations the routes serialize.
 *
 * Reconciliation notes — where the transcription had guessed wrong, and what
 * the real server sends:
 *   - `VerseControlSnapshot.enrollment` → `.scope: VerseScope` (`.scope.repos`)
 *   - `VerseControlSnapshot.todaySpendUsd` → `.spend: VerseSpend` (`.spend.todayUsd`)
 *   - `VerseControlSnapshot.engines` → `.quota: FrontierEngineUsage[]`, whose
 *     rows carry `callsToday`/`limit`/`limitWindow`, not `dispatchesRecent`
 *     plus a precomputed `quota` word. `engineQuotaStanding()` below derives
 *     that word on the client, so the UI copy is unchanged.
 *   - `VerseCapsUpdateResult.applied` is `VerseCapKey[]` (which caps changed),
 *     not the whole `VerseCaps`; the new caps come back on `.caps`.
 *   - `maxConcurrent` and each `concurrency.*` are `number | null` — null
 *     means "not configured", which is an honest state, not a zero.
 *
 * The local alias names the cockpit already used (`VerseCapsPatch`,
 * `VerseCapsApplyResult`, `VerseScopePatch`, `VerseAuditPage`) are kept as
 * aliases of the real types so call sites read the same.
 */
import type { FrontierEngineUsage } from '../../../../core/usage/frontier-usage.js';
import type { VerseFoundryLimit } from '../../../data/api-types.js';

export type {
  AuditEntry,
  VerseAuditResponse,
  VerseAuditResult,
  VerseCapKey,
  VerseCaps,
  VerseCapsConcurrency,
  VerseCapsUpdate,
  VerseCapsUpdateResult,
  VerseControlError,
  VerseControlErrorCode,
  VerseControlSnapshot,
  VerseDaemonAction,
  VerseDaemonActionResult,
  VerseDaemonStateProjection,
  VerseFleetEssentials,
  VerseFoundryLimit,
  VerseKillSwitch,
  VerseSafetyReport,
  VerseScope,
  VerseScopeAction,
  VerseScopeRepo,
  VerseScopeRequest,
  VerseScopeResult,
  VerseSpend,
} from '../../../data/api-types.js';
export type { PublicDaemonObservation } from '../../../data/api-types.js';
export type { DaemonDispatchTrace, DaemonTick } from '../../../../core/types.js';
export type { FrontierEngineUsage };

/**
 * Runtime constants from the same backend module. `control-types.ts` has only
 * type-only imports, so pulling these values into the bundle costs nothing and
 * removes the last place the client could disagree with the server about a
 * bound or the kill switch's wording.
 */
export {
  VERSE_AUDIT_MAX_LIMIT,
  VERSE_CAPS_BOUNDS,
  VERSE_DAEMON_PAUSE_NOTE,
  VERSE_KILL_SWITCH_NOTE,
} from '../../../../core/verse/control-types.js';

/**
 * The DAEMON-SCOPED pause (V2.1), taken straight from the backend contract
 * rather than through `data/api-types.ts`.
 *
 * Every other shape here routes through that barrel, and this one should join
 * it when the barrel is next edited. It is imported directly for now because
 * `api-types.ts` is being changed by another surface in the same build, and a
 * type-only re-export is the one place where the short path costs nothing:
 * it is the same declaration either way, and `VERSE_CAPS_BOUNDS` above already
 * reaches for the core module by this exact path.
 */
export type { VerseDaemonPause } from '../../../../core/verse/control-types.js';

import type {
  VerseAuditResponse,
  VerseAuditResult,
  VerseCapsUpdate,
  VerseCapsUpdateResult,
  VerseScopeRequest,
} from '../../../data/api-types.js';

/** Partial update body for `POST /api/verse/caps`. */
export type VerseCapsPatch = VerseCapsUpdate;
/** `{ok, applied, live: true, caps}` — the "takes effect live" receipt. */
export type VerseCapsApplyResult = VerseCapsUpdateResult;
/** `POST /api/verse/scope` body. */
export type VerseScopePatch = VerseScopeRequest;
/** `GET /api/verse/audit` — one page of the audit trail. */
export type VerseAuditPage = VerseAuditResponse;

/** Client-side filter state for `GET /api/verse/audit`. */
export interface VerseAuditFilters {
  limit?: number;
  action?: string;
  result?: VerseAuditResult;
}

/** How a quota row stands against its configured limit, as a single word. */
export type VerseQuotaStanding = 'ok' | 'warn' | 'over' | 'unlimited';

/**
 * Derive the standing word from a real `FrontierEngineUsage` row.
 *
 * The server does not precompute this (the transcription assumed it did), and
 * it is a pure function of two numbers, so it belongs on the client rather
 * than in a new response field. No limit configured is `unlimited` — which
 * the UI must render as "no limit configured", never as headroom.
 */
export function engineQuotaStanding(row: FrontierEngineUsage): VerseQuotaStanding {
  const limit = row.limit;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return 'unlimited';
  const used = typeof row.callsToday === 'number' && Number.isFinite(row.callsToday) ? row.callsToday : 0;
  if (used >= limit) return 'over';
  if (used >= limit * 0.8) return 'warn';
  return 'ok';
}

/** The configured foundry limit matching a quota row, when there is one. */
export function limitForEngine(
  engine: string,
  limits: readonly VerseFoundryLimit[] | undefined,
): VerseFoundryLimit | null {
  return limits?.find((l) => l.engine === engine) ?? null;
}

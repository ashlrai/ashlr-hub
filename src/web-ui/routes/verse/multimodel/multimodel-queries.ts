/**
 * routes/verse/multimodel/multimodel-queries.ts — the reads and writes behind
 * the multi-model composer (core/verse/multimodel-api.ts).
 *
 *   GET  /api/verse/multimodel/context?projectPath=   → MultimodelContext (learned, ROI, local-only, local badges)
 *   POST /api/verse/multimodel/label                  → PromptLabelResponse (once per send)
 *   POST /api/verse/multimodel/outcome                → {ok}
 *   POST /api/verse/multimodel/link                   → {ok}
 *   GET  /api/verse/multimodel/meter?sessionId=       → ChatMeter
 *   POST /api/verse/multimodel/local/warm             → LocalWarmResult
 *
 * Reads spend nothing. Writes pull the held mutation token and touch the hold.
 * Outcome and link writes are best-effort by design: a failed "thumbs up"
 * must never surface as an error over the answer it rated.
 */
import {
  VERSE_MULTIMODEL_CONTEXT_PATH,
  VERSE_MULTIMODEL_LABEL_PATH,
  VERSE_MULTIMODEL_LINK_PATH,
  VERSE_MULTIMODEL_METER_PATH,
  VERSE_MULTIMODEL_OUTCOME_PATH,
  VERSE_MULTIMODEL_WARM_PATH,
  type ChatMeter,
  type LocalWarmResult,
  type MultimodelContext,
  type PromptLabelRequest,
  type PromptLabelResponse,
  type SeatOutcomeRequest,
  type ThreadLinkRequest,
} from '../../../../core/verse/multimodel/types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const MULTIMODEL_CONTEXT_KEY_PREFIX = 'verse-multimodel-context:';
export const MULTIMODEL_METER_KEY_PREFIX = 'verse-multimodel-meter:';

/** A chat (every root it reaches is checked) or a folder about to become one. */
export function multimodelContextQuery(scope: { sessionId: string } | { projectPath: string | null }): QueryDef<MultimodelContext> {
  const qs = 'sessionId' in scope
    ? `?sessionId=${encodeURIComponent(scope.sessionId)}`
    : scope.projectPath ? `?projectPath=${encodeURIComponent(scope.projectPath)}` : '';
  return {
    key: `${MULTIMODEL_CONTEXT_KEY_PREFIX}${qs}`,
    fetch: (signal) => apiGet<MultimodelContext>(`${VERSE_MULTIMODEL_CONTEXT_PATH}${qs}`, signal),
  };
}

export function chatMeterQuery(sessionId: string): QueryDef<ChatMeter> {
  return {
    key: `${MULTIMODEL_METER_KEY_PREFIX}${sessionId}`,
    fetch: (signal) => apiGet<ChatMeter>(`${VERSE_MULTIMODEL_METER_PATH}?sessionId=${encodeURIComponent(sessionId)}`, signal),
  };
}

function token(): string {
  const t = getMutationToken();
  if (!t) throw new VerseMutationLockedError();
  return t;
}

export async function labelPromptRemote(req: PromptLabelRequest): Promise<PromptLabelResponse> {
  const res = await apiPost<PromptLabelResponse>(VERSE_MULTIMODEL_LABEL_PATH, req, token());
  touchMutationHold();
  return res;
}

/** Best-effort: never throws. */
export async function recordOutcome(req: SeatOutcomeRequest): Promise<boolean> {
  try {
    await apiPost<{ ok: true }>(VERSE_MULTIMODEL_OUTCOME_PATH, req, token());
    touchMutationHold();
    return true;
  } catch {
    return false;
  }
}

/** Best-effort: never throws. Invalidates the parent's meter. */
export async function linkThread(req: ThreadLinkRequest): Promise<boolean> {
  try {
    await apiPost<{ ok: true }>(VERSE_MULTIMODEL_LINK_PATH, req, token());
    touchMutationHold();
    invalidate(`${MULTIMODEL_METER_KEY_PREFIX}${req.parentSessionId}`);
    return true;
  } catch {
    return false;
  }
}

export async function warmLocalSeat(seatId: string): Promise<LocalWarmResult> {
  const res = await apiPost<LocalWarmResult>(VERSE_MULTIMODEL_WARM_PATH, { seatId }, token());
  touchMutationHold();
  return res;
}

export function invalidateChatMeter(sessionId: string): void {
  invalidate(`${MULTIMODEL_METER_KEY_PREFIX}${sessionId}`);
}

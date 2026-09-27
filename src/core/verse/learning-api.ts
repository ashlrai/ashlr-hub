/**
 * Learning API — V3.10 Track B (owner: unit U9). Mounted by C0 in
 * verse-api.ts under the `learning` workbench family.
 *
 *   GET  /api/verse/learning                    → LearningStateV1 (harness
 *        versions for the step chart, experiments for the ForestPlot, the
 *        canary, open hypotheses)
 *   POST /api/verse/learning/experiments        {hypothesis}            → {ok, experimentId}
 *   POST /api/verse/learning/experiments/cancel {experimentId, reason?} → {ok}
 *   POST /api/verse/learning/adopt              {versionId, experimentId} → {ok, before, after}
 *   POST /api/verse/learning/rollback           {toVersionId|null, reason?} → {ok, before, after}
 *
 *   3.15 Lessons (retros + suggested knowledge, learn/retro/**):
 *   GET  /api/verse/learning/lessons            → LessonsStateV1 (kicks a
 *        background sweep when the last one is older than 10 minutes)
 *   POST /api/verse/learning/lessons/sweep      {}                      → {ok, created, …}
 *   POST /api/verse/learning/lessons/knowledge  {id, decision, text?, scope?} → {ok, note}
 *   POST /api/verse/learning/lessons/agents-md  {id}                    → {ok, note, taskId}
 *
 * Every POST is Mason acting from Verse (actor `mason`). Adoption still has
 * to clear the same gate the Leader does — the endpoint adds no authority,
 * it only removes the veto window Mason would be waiting on himself.
 * Rollback and cancel only ever LOWER what is in force.
 *
 * Security posture matches every Verse route: GETs sit behind the read
 * session in server.ts; a POST is 404 unless the server allows dispatch, then
 * the constant-time mutation token + JSON Content-Type gate, then the shared
 * 64 KB body cap. Unknown query parameters and body keys are 400s. Every
 * response goes through sendJson() → sanitizePublicJson(). Refusals are 409
 * with the registry's reason (specific, never a stack).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { VERSE_LEARNING_PATH } from '../learn/harness-types.js';
import { adoptHarness, buildLearningState, rollbackHarness } from '../learn/harness-registry.js';
import { cancelExperiment, startExperiment } from '../learn/experiments.js';
import {
  VERSE_LESSONS_AGENTS_MD_PATH,
  VERSE_LESSONS_KNOWLEDGE_PATH,
  VERSE_LESSONS_PATH,
  VERSE_LESSONS_SWEEP_PATH,
} from '../learn/retro/types.js';

export const VERSE_LEARNING_EXPERIMENTS_PATH = `${VERSE_LEARNING_PATH}/experiments`;
export const VERSE_LEARNING_CANCEL_PATH = `${VERSE_LEARNING_PATH}/experiments/cancel`;
export const VERSE_LEARNING_ADOPT_PATH = `${VERSE_LEARNING_PATH}/adopt`;
export const VERSE_LEARNING_ROLLBACK_PATH = `${VERSE_LEARNING_PATH}/rollback`;

const POST_ROUTES: Readonly<Record<string, readonly string[]>> = {
  [VERSE_LEARNING_EXPERIMENTS_PATH]: ['hypothesis'],
  [VERSE_LEARNING_CANCEL_PATH]: ['experimentId', 'reason'],
  [VERSE_LEARNING_ADOPT_PATH]: ['versionId', 'experimentId'],
  [VERSE_LEARNING_ROLLBACK_PATH]: ['toVersionId', 'reason'],
  [VERSE_LESSONS_SWEEP_PATH]: [],
  [VERSE_LESSONS_KNOWLEDGE_PATH]: ['id', 'decision', 'text', 'scope'],
  [VERSE_LESSONS_AGENTS_MD_PATH]: ['id'],
};

/** A GET older than this starts a background sweep (the response never waits for it). */
export const LESSONS_STALE_MS = 10 * 60_000;

/**
 * Sweep in the background when the last sweep is stale. Fire-and-forget:
 * the GET answers from what is on disk; the next poll shows the new retros.
 */
async function kickStaleSweep(ctx: VerseApiContext, sweptAt: string | null, nowMs: number): Promise<void> {
  const last = sweptAt ? Date.parse(sweptAt) : Number.NaN;
  if (Number.isFinite(last) && nowMs - last < LESSONS_STALE_MS) return;
  try {
    const { loadDefaultRetroSweepDeps, sweepRetros } = await import('../learn/retro/sweep.js');
    await sweepRetros(await loadDefaultRetroSweepDeps(ctx.cfg));
  } catch {
    /* the next GET retries; the view shows the last sweep time */
  }
}

async function handleLessons(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  const { buildLessonsState, decideKnowledge, proposeAgentsMd } = await import('../learn/retro/knowledge.js');
  if (method === 'GET') {
    if (path !== VERSE_LESSONS_PATH) {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }
    if (!hasNoQuery(req, res)) return true;
    const state = await buildLessonsState(Date.now());
    void kickStaleSweep(ctx, state.sweptAt, Date.now());
    sendJson(res, 200, state);
    return true;
  }
  const allowed = POST_ROUTES[path];
  if (method !== 'POST' || !allowed) {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  const body = await readMutationBody(ctx, req, res, allowed);
  if (!body) return true;
  const nowIso = new Date().toISOString();

  if (path === VERSE_LESSONS_SWEEP_PATH) {
    const { loadDefaultRetroSweepDeps, sweepRetros } = await import('../learn/retro/sweep.js');
    const result = await sweepRetros(await loadDefaultRetroSweepDeps(ctx.cfg));
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (typeof body.id !== 'string' || !/^kn_[0-9a-f]{16}$/.test(body.id)) {
    sendInvalid(res, 'id must be a knowledge note id');
    return true;
  }

  if (path === VERSE_LESSONS_KNOWLEDGE_PATH) {
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      sendInvalid(res, 'decision must be approve or reject');
      return true;
    }
    if (body.text !== undefined && (typeof body.text !== 'string' || body.text.length > 2000)) {
      sendInvalid(res, 'text must be a string of at most 2000 characters');
      return true;
    }
    const decided = await decideKnowledge({
      id: body.id,
      decision: body.decision,
      ...(body.text !== undefined ? { text: body.text as string } : {}),
      ...(body.scope !== undefined ? { scope: body.scope as never } : {}),
    }, nowIso);
    if (decided.ok) sendJson(res, 200, decided);
    else if (decided.status === 400) sendInvalid(res, decided.reason);
    else sendJson(res, decided.status, { code: decided.status === 404 ? 'VERSE_NOT_FOUND' : 'VERSE_REFUSED', error: decided.reason });
    return true;
  }

  // VERSE_LESSONS_AGENTS_MD_PATH — a fleet task (a proposal through every gate), never a direct write.
  const proposed = await proposeAgentsMd(body.id, async (input) => {
    const { enqueueTask } = await import('../fleet/task-source.js');
    const queued = enqueueTask(input);
    return queued.ok ? { ok: true, taskId: queued.task.id } : { ok: false, reason: queued.reason };
  });
  if (proposed.ok) sendJson(res, 200, proposed);
  else sendJson(res, proposed.status, { code: proposed.status === 404 ? 'VERSE_NOT_FOUND' : 'VERSE_REFUSED', error: proposed.reason });
  return true;
}

function owns(path: string): boolean {
  return path === VERSE_LEARNING_PATH || path.startsWith(`${VERSE_LEARNING_PATH}/`);
}

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function sendRefused(res: ServerResponse, reason: string): void {
  sendJson(res, 409, { code: 'VERSE_REFUSED', error: reason });
}

function hasNoQuery(req: IncomingMessage, res: ServerResponse): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return false;
  }
  for (const key of params.keys()) {
    sendInvalid(res, `unknown query parameter: ${key}`);
    return false;
  }
  return true;
}

async function readMutationBody(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly string[],
): Promise<Record<string, unknown> | null> {
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
  for (const key of Object.keys(parsed)) {
    if (!allowed.includes(key)) {
      sendInvalid(res, `unknown key: ${key.slice(0, 64)}`);
      return null;
    }
  }
  return parsed as Record<string, unknown>;
}

const optionalReason = (value: unknown): string | null =>
  value === undefined ? 'requested from Verse' : typeof value === 'string' && value.length <= 500 ? value : null;

/**
 * The learning route family. Returns false for any path outside
 * /api/verse/learning so the next module (or the 404) runs.
 */
export const handleLearningApi: ApiModule = async (ctx, req, res, path, method) => {
  if (!owns(path)) return false;
  try {
    if (path === VERSE_LESSONS_PATH || path.startsWith(`${VERSE_LESSONS_PATH}/`)) {
      return await handleLessons(ctx, req, res, path, method);
    }
    if (method === 'GET') {
      if (path !== VERSE_LEARNING_PATH) {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      if (!hasNoQuery(req, res)) return true;
      sendJson(res, 200, buildLearningState());
      return true;
    }
    const allowed = POST_ROUTES[path];
    if (method !== 'POST' || !allowed) {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }
    const body = await readMutationBody(ctx, req, res, allowed);
    if (!body) return true;

    if (path === VERSE_LEARNING_EXPERIMENTS_PATH) {
      if (body.hypothesis === undefined) {
        sendInvalid(res, 'hypothesis is required');
        return true;
      }
      const started = startExperiment({ hypothesis: body.hypothesis as never, requestedBy: 'mason' });
      if (!started.ok) sendRefused(res, started.reason);
      else sendJson(res, 200, started);
      return true;
    }

    if (path === VERSE_LEARNING_CANCEL_PATH) {
      const reason = optionalReason(body.reason);
      if (typeof body.experimentId !== 'string' || reason === null) {
        sendInvalid(res, 'experimentId (string) is required; reason must be a string of at most 500 characters');
        return true;
      }
      const cancelled = cancelExperiment({ experimentId: body.experimentId, reason, actor: 'mason' });
      if (!cancelled.ok) sendRefused(res, cancelled.reason);
      else sendJson(res, 200, cancelled);
      return true;
    }

    if (path === VERSE_LEARNING_ADOPT_PATH) {
      if (typeof body.versionId !== 'string' || typeof body.experimentId !== 'string') {
        sendInvalid(res, 'versionId and experimentId (strings) are required');
        return true;
      }
      const adopted = adoptHarness({ versionId: body.versionId, experimentId: body.experimentId, actor: 'mason' });
      if (!adopted.ok) sendRefused(res, adopted.reason);
      else sendJson(res, 200, adopted);
      return true;
    }

    // VERSE_LEARNING_ROLLBACK_PATH
    const reason = optionalReason(body.reason);
    if (!('toVersionId' in body) || (body.toVersionId !== null && typeof body.toVersionId !== 'string') || reason === null) {
      sendInvalid(res, 'toVersionId (a version id, or null for the baseline) is required; reason must be a string of at most 500 characters');
      return true;
    }
    const rolled = rollbackHarness({ toVersionId: body.toVersionId as string | null, reason, actor: 'mason' });
    if (!rolled.ok) sendRefused(res, rolled.reason);
    else sendJson(res, 200, rolled);
    return true;
  } catch {
    sendJson(res, 500, { error: 'learning request failed' });
    return true;
  }
};

/**
 * routes/verse/growth/lessons-data.ts — the Lessons view's one read and its
 * writes (3.15; routes in core/verse/learning-api.ts).
 *
 *   GET  /api/verse/learning/lessons            LessonsStateV1
 *   POST /api/verse/learning/lessons/knowledge  {id, decision, text?, scope?}
 *   POST /api/verse/learning/lessons/agents-md  {id}
 *   POST /api/verse/learning/lessons/sweep      {}
 *
 * The read is OPTIONAL like every surface read (an older server answers 404:
 * the card says so). Writes pull the held mutation token and are routed
 * through useGuardedAction by the panel, which opens the token dialog first.
 */
import { apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { optionalQuery } from '../command/surface-data.js';
import {
  VERSE_LESSONS_AGENTS_MD_PATH,
  VERSE_LESSONS_KNOWLEDGE_PATH,
  VERSE_LESSONS_PATH,
  VERSE_LESSONS_SWEEP_PATH,
  type KnowledgeDecisionRequest,
  type LessonsStateV1,
} from '../../../../core/learn/retro/types.js';

export const LESSONS_KEY = 'verse-learning-lessons';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Just enough shape to never crash a render on a mismatched server. */
export function narrowLessons(raw: unknown): LessonsStateV1 | null {
  if (!isRecord(raw) || raw['v'] !== 1 || !Array.isArray(raw['retros']) || !Array.isArray(raw['causes'])) return null;
  const k = raw['knowledge'];
  if (!isRecord(k) || !Array.isArray(k['pending']) || !Array.isArray(k['approved']) || !Array.isArray(raw['playbook'])) return null;
  return raw as unknown as LessonsStateV1;
}

export const lessonsQuery = optionalQuery(LESSONS_KEY, VERSE_LESSONS_PATH, 'Lessons', narrowLessons);

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  invalidate(LESSONS_KEY);
  return result;
}

export function decideKnowledgeNote(req: KnowledgeDecisionRequest): Promise<unknown> {
  return post(VERSE_LESSONS_KNOWLEDGE_PATH, req);
}

export function proposeKnowledgeToAgentsMd(id: string): Promise<{ ok: true; taskId?: string }> {
  return post(VERSE_LESSONS_AGENTS_MD_PATH, { id });
}

export function sweepLessons(): Promise<{ ok: true; created: number; candidates: number }> {
  return post(VERSE_LESSONS_SWEEP_PATH, {});
}

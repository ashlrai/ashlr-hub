import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ReadProjectionReader } from '../web/read-projections.js';
import { sendJson } from '../web/api.js';
import type { VerseApiContext } from './verse-api.js';
import { EXECUTION_FEEDBACK_PATH, type ExecutionFeedbackRead } from './execution-feedback-api-types.js';
import type { ExecutionFeedbackView } from '../fleet/execution-feedback-types.js';

export const EXECUTION_FEEDBACK_REFRESH_MS = 30_000;
interface CachedRead {
  value: ExecutionFeedbackRead;
  at: number;
  pending: Promise<void> | null;
  failed: boolean;
}
let readings = new WeakMap<ReadProjectionReader, CachedRead>();

/** Generated hashes remain opaque, but do not resemble bearer credentials to
 * the shared public-response scrubber. Never exempt caller strings from it. */
function wireHash(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid generated feedback identity');
  return `h:${hash.match(/.{16}/g)!.join(':')}`;
}
function publicFeedback(feedback: ExecutionFeedbackView): ExecutionFeedbackView {
  return { ...feedback, digest: wireHash(feedback.digest),
    cases: feedback.cases.map((row) => ({ ...row, caseId: wireHash(row.caseId) })) };
}

/** A slow queued worker leaves GET responsive and the last reading explicit. */
function refresh(reader: ReadProjectionReader, entry: CachedRead): void {
  if (entry.pending) return;
  entry.pending = Promise.resolve().then(() => reader.read('execution-feedback')).then(publicFeedback).then((feedback) => {
    const now = Date.now();
    entry.value = { v: 1, state: 'current', refreshedAt: new Date(now).toISOString(), feedback };
    entry.at = now;
    entry.failed = false;
  }, () => {
    entry.failed = true;
    entry.at = Date.now();
  }).finally(() => { entry.pending = null; });
}

export function _resetExecutionFeedbackCacheForTest(): void {
  readings = new WeakMap();
}

/** The server's existing read-session gate applies before this handler. */
export async function handleExecutionFeedbackApi(
  ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, path: string, method: string,
): Promise<boolean> {
  if (path !== EXECUTION_FEEDBACK_PATH) return false;
  if (method !== 'GET') {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  let url: URL;
  try { url = new URL(req.url ?? path, 'http://localhost'); }
  catch { sendJson(res, 400, { error: 'invalid query string' }); return true; }
  if ([...url.searchParams].length) {
    sendJson(res, 400, { error: 'Execution feedback does not accept query parameters.' });
    return true;
  }
  const reader = ctx.readProjections;
  if (!reader) {
    sendJson(res, 200, { v: 1, state: 'unavailable', refreshedAt: null, feedback: null } satisfies ExecutionFeedbackRead);
    return true;
  }
  let entry = readings.get(reader);
  if (!entry) {
    entry = { value: { v: 1, state: 'warming', refreshedAt: null, feedback: null }, at: 0, pending: null, failed: false };
    readings.set(reader, entry);
  }
  const age = Date.now() - entry.at;
  const stale = age < 0 || age >= EXECUTION_FEEDBACK_REFRESH_MS;
  if (entry.at === 0 || stale) refresh(reader, entry);
  const state = entry.value.feedback === null ? entry.failed ? 'unavailable' : 'warming'
    : stale || entry.failed ? 'stale' : 'current';
  sendJson(res, 200, { ...entry.value, state } satisfies ExecutionFeedbackRead);
  return true;
}

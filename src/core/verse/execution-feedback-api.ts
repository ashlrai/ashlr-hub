import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ReadProjectionReader } from '../web/read-projections.js';
import { sendJson } from '../web/api.js';
import type { VerseApiContext } from './verse-api.js';
import { EXECUTION_FEEDBACK_PATH, EXECUTION_FEEDBACK_CASE_PATH, type ExecutionFeedbackRead, type ExecutionFeedbackCaseRead } from './execution-feedback-api-types.js';
import type { ExecutionFeedbackView } from '../fleet/execution-feedback-types.js';

export const EXECUTION_FEEDBACK_REFRESH_MS = 30_000;
interface CachedRead {
  value: ExecutionFeedbackRead;
  at: number;
  pending: Promise<void> | null;
  failed: boolean;
}
let readings = new WeakMap<ReadProjectionReader, CachedRead>();
interface CachedCaseRead { caseId: string; value: ExecutionFeedbackCaseRead; at: number; pending: Promise<void> | null; failed: boolean }
// Only the most recently selected case is retained per server, never an unbounded caller-ID cache.
let caseReadings = new WeakMap<ReadProjectionReader, CachedCaseRead>();

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
  caseReadings = new WeakMap();
}

/** The server's existing read-session gate applies before this handler. */
export async function handleExecutionFeedbackApi(
  ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, path: string, method: string,
): Promise<boolean> {
  const casePath = path.startsWith(EXECUTION_FEEDBACK_CASE_PATH);
  if (path !== EXECUTION_FEEDBACK_PATH && !casePath) return false;
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
  if (casePath) return handleCaseRead(ctx, res, path.slice(EXECUTION_FEEDBACK_CASE_PATH.length));
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

function refreshCase(reader: ReadProjectionReader, entry: CachedCaseRead): void {
  if (entry.pending) return;
  entry.pending = Promise.resolve().then(() => reader.read('execution-feedback-case', { caseId: entry.caseId })).then((detail) => {
    if (detail && detail.caseId !== entry.caseId) throw new Error('Mismatched generated case identity');
    entry.value = { v: 1, state: detail ? 'current' : 'unavailable', refreshedAt: new Date().toISOString(),
      detail: detail ? { ...detail, caseId: wireHash(detail.caseId), digest: wireHash(detail.digest) } : null };
    entry.at = Date.now(); entry.failed = false;
  }, () => { entry.failed = true; entry.at = Date.now(); }).catch(() => {
    entry.failed = true; entry.at = Date.now();
  }).finally(() => { entry.pending = null; });
}
function handleCaseRead(ctx: VerseApiContext, res: ServerResponse, component: string): true {
  let wire: string;
  try { wire = decodeURIComponent(component); } catch { wire = ''; }
  if (!/^h:[a-f0-9]{16}:[a-f0-9]{16}:[a-f0-9]{16}:[a-f0-9]{16}$/u.test(wire)) {
    sendJson(res, 400, { error: 'Invalid execution case identity.' }); return true;
  }
  const caseId = wire.slice(2).replaceAll(':', '');
  const reader = ctx.readProjections;
  if (!reader) { sendJson(res, 200, { v: 1, state: 'unavailable', refreshedAt: null, detail: null } satisfies ExecutionFeedbackCaseRead); return true; }
  let entry = caseReadings.get(reader);
  if (!entry || entry.caseId !== caseId) {
    entry = { caseId, value: { v: 1, state: 'warming', refreshedAt: null, detail: null }, at: 0, pending: null, failed: false };
    caseReadings.set(reader, entry);
  }
  const age = Date.now() - entry.at;
  const stale = age < 0 || age >= EXECUTION_FEEDBACK_REFRESH_MS;
  if (entry.at === 0 || stale) refreshCase(reader, entry);
  const state = entry.value.detail === null ? entry.failed || entry.at !== 0 ? 'unavailable' : 'warming'
    : stale || entry.failed ? 'stale' : 'current';
  sendJson(res, 200, { ...entry.value, state } satisfies ExecutionFeedbackCaseRead);
  return true;
}

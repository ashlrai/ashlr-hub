import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleExecutionFeedbackApi, _resetExecutionFeedbackCacheForTest, EXECUTION_FEEDBACK_REFRESH_MS } from '../src/core/verse/execution-feedback-api.js';
import { EXECUTION_FEEDBACK_PATH, EXECUTION_FEEDBACK_CASE_PATH } from '../src/core/verse/execution-feedback-api-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { ReadProjectionReader } from '../src/core/web/read-projections.js';
import { normalizeReadProjectionPayload } from '../src/core/web/read-projections.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { ExecutionFeedbackView } from '../src/core/fleet/execution-feedback-types.js';
import { startServer } from '../src/core/web/server.js';

const now = new Date('2026-10-01T08:00:00.000Z');
const feedback: ExecutionFeedbackView = {
  schemaVersion: 1, sourceState: 'missing', complete: false,
  window: { since: '2026-09-24T08:00:00.000Z', through: now.toISOString() }, observedThrough: null, counts: null,
  observedCounts: { 'producer-succeeded': 0, failed: 0, cancelled: 0, refused: 0, 'empty-diff': 0, disabled: 0, unknown: 0 },
  cases: [], coverage: { legacyRows: 0, invalidAttempts: 0, conflictingAttempts: 0, duplicateRows: 0, invalidTimestamps: 0, proposalSource: 'missing' }, digest: 'a'.repeat(64),
};
function context(reader?: ReadProjectionReader): VerseApiContext {
  return { cfg: {} as AshlrConfig, token: 'fixture', allowDispatch: false, ...(reader ? { readProjections: reader } : {}) };
}
async function request(ctx: VerseApiContext, method = 'GET', suffix = '') {
  let status = 0; let body = '';
  const response = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as unknown as ServerResponse;
  const handled = await handleExecutionFeedbackApi(ctx, { url: EXECUTION_FEEDBACK_PATH + suffix } as IncomingMessage, response, EXECUTION_FEEDBACK_PATH, method);
  return { handled, status, body: JSON.parse(body) as { state: string; feedback: ExecutionFeedbackView | null } };
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(() => { _resetExecutionFeedbackCacheForTest(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe('recorded execution feedback read', () => {
  it('answers cold reads before a slow worker resolves, coalesces and retains unknown history', async () => {
    let finish!: (value: ExecutionFeedbackView) => void;
    const read = vi.fn(() => new Promise<ExecutionFeedbackView>((resolve) => { finish = resolve; }));
    const reader = { read, invalidate: vi.fn(), close: vi.fn() } as unknown as ReadProjectionReader;
    const ctx = context(reader);
    expect((await request(ctx)).body).toMatchObject({ state: 'warming', feedback: null });
    expect((await request(ctx)).body.state).toBe('warming');
    expect(read).toHaveBeenCalledExactlyOnceWith('execution-feedback');
    finish(feedback); await settle();
    expect((await request(ctx)).body).toMatchObject({ state: 'current', feedback: { counts: null, sourceState: 'missing' } });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('keeps the exact last reading explicit while a refresh fails, without a retry storm', async () => {
    const read = vi.fn().mockResolvedValueOnce(feedback).mockRejectedValue(new Error('private error content'));
    const ctx = context({ read } as unknown as ReadProjectionReader);
    await request(ctx); await settle();
    const initial = (await request(ctx)).body.feedback;
    expect(initial?.digest).toBe(`h:${Array(4).fill('a'.repeat(16)).join(':')}`);
    vi.advanceTimersByTime(EXECUTION_FEEDBACK_REFRESH_MS);
    expect((await request(ctx)).body).toMatchObject({ state: 'stale', feedback: initial });
    await settle();
    const result = await request(ctx);
    expect(result.body).toMatchObject({ state: 'stale', feedback: initial });
    expect(JSON.stringify(result.body)).not.toContain('private error content');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not share another server reader’s cached result', async () => {
    const ctx = context({ read: vi.fn().mockResolvedValue(feedback) } as unknown as ReadProjectionReader);
    await request(ctx); await settle();
    const other = context({ read: vi.fn(() => new Promise(() => undefined)) } as unknown as ReadProjectionReader);
    expect((await request(other)).body).toMatchObject({ state: 'warming', feedback: null });
  });
  it('preserves generated case identities through actual public scrubbing and holds invalid identities', async () => {
    const hash = '0123456789abcdef'.repeat(4);
    const row = { caseId: hash, endedAt: now.toISOString(), outcome: 'failed' as const, failureKind: 'engine' as const, proposalRecorded: false };
    const ctx = context({ read: vi.fn().mockResolvedValue({ ...feedback, cases: [row], digest: hash }) } as unknown as ReadProjectionReader);
    await request(ctx); await settle();
    expect((await request(ctx)).body.feedback?.cases[0]?.caseId).toBe(`h:${Array(4).fill('0123456789abcdef').join(':')}`);
    const read = vi.fn().mockResolvedValue({ ...feedback, digest: 'not-a-generated-hash' });
    const invalid = context({ read } as unknown as ReadProjectionReader);
    await request(invalid); await settle();
    expect((await request(invalid)).body).toMatchObject({ state: 'unavailable', feedback: null });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('never falls back to synchronous ledger reads when the bounded worker is absent', async () => {
    expect((await request(context())).body).toEqual({ v: 1, state: 'unavailable', refreshedAt: null, feedback: null });
  });
  it('rejects mutations, caller-selected windows and payloads without scheduling a read', async () => {
    const read = vi.fn(); const ctx = context({ read } as unknown as ReadProjectionReader);
    expect((await request(ctx, 'POST')).status).toBe(404);
    expect((await request(ctx, 'GET', '?window=all')).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect(normalizeReadProjectionPayload('execution-feedback', undefined)).toBeUndefined();
    expect(() => normalizeReadProjectionPayload('execution-feedback', { file: '/private/history' })).toThrow();
  });
});

describe('execution feedback HTTP integration', () => {
  it('authenticates before worker access, responds while the worker is pending and rejects mutation', async () => {
    vi.useRealTimers();
    const cfg: AshlrConfig = { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {} };
    let finish!: (view: ExecutionFeedbackView) => void;
    const read = vi.fn(() => new Promise<ExecutionFeedbackView>((resolve) => { finish = resolve; }));
    const reader = { read, invalidate: vi.fn(async () => {}), close: vi.fn(async () => {}) } as unknown as ReadProjectionReader;
    const server = await startServer(cfg, { port: 0, open: false, allowDispatch: false }, { readProjections: reader });
    try {
      const url = server.url + EXECUTION_FEEDBACK_PATH;
      expect((await fetch(url, { signal: AbortSignal.timeout(2000) })).status).toBe(401);
      expect(read).not.toHaveBeenCalled();
      const headers = { 'x-ashlr-token': server.readToken };
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ v: 1, state: 'warming', feedback: null });
      expect(read).toHaveBeenCalledExactlyOnceWith('execution-feedback');
      finish(feedback); await settle();
      const current = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      expect(await current.json()).toMatchObject({ state: 'current', feedback: { sourceState: 'missing', counts: null } });
      expect(read).toHaveBeenCalledTimes(1);
      expect((await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(2000) })).status).toBe(404);
      expect(reader.invalidate).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});

const caseId = '0123456789abcdef'.repeat(4);
const wireCaseId = 'h:' + Array(4).fill('0123456789abcdef').join(':');
const caseDetail = { schemaVersion: 1 as const, caseId, endedAt: now.toISOString(), outcome: 'failed' as const,
  coverage: { dispatch: 'healthy' as const, proposals: 'missing' as const, ledger: 'missing' as const, invalidRecords: 0, conflictingRecords: 0 },
  timeline: [{ stage: 'produced' as const, at: now.toISOString(), result: 'recorded' as const, basis: 'dispatch-final' as const }],
  shipping: 'not-recorded' as const, digest: 'b'.repeat(64) };
async function caseRequest(ctx: VerseApiContext, id = wireCaseId, method = 'GET', query = '') {
  let status = 0; let body = '';
  const response = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as unknown as ServerResponse;
  const path = EXECUTION_FEEDBACK_CASE_PATH + encodeURIComponent(id);
  await handleExecutionFeedbackApi(ctx, { url: path + query } as IncomingMessage, response, path, method);
  return { status, body: JSON.parse(body) };
}
describe('lazy selected case boundary', () => {
  it('coalesces the selected case and keeps the actual generated hash through scrubbing', async () => {
    let finish!: (v: typeof caseDetail) => void;
    const read = vi.fn(() => new Promise<typeof caseDetail>((resolve) => { finish = resolve; }));
    const ctx = context({ read } as unknown as ReadProjectionReader);
    expect((await caseRequest(ctx)).body).toMatchObject({ state: 'warming', detail: null });
    await caseRequest(ctx); expect(read).toHaveBeenCalledExactlyOnceWith('execution-feedback-case', { caseId });
    finish(caseDetail); await settle();
    expect((await caseRequest(ctx)).body).toMatchObject({ state: 'current', detail: { caseId: wireCaseId, digest: 'h:' + Array(4).fill('b'.repeat(16)).join(':'), shipping: 'not-recorded' } });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('keeps last reading stale after failure but never shares a different selected case or server', async () => {
    const read = vi.fn().mockResolvedValueOnce(caseDetail).mockRejectedValue(new Error('secret account path'));
    const ctx = context({ read } as unknown as ReadProjectionReader);
    await caseRequest(ctx); await settle(); vi.advanceTimersByTime(EXECUTION_FEEDBACK_REFRESH_MS);
    expect((await caseRequest(ctx)).body.state).toBe('stale'); await settle();
    const stale = await caseRequest(ctx); expect(stale.body.state).toBe('stale'); expect(JSON.stringify(stale)).not.toContain('secret account');
    expect((await caseRequest(ctx, 'h:' + Array(4).fill('a'.repeat(16)).join(':'))).body).toMatchObject({ state: 'warming', detail: null });
    expect((await caseRequest(context())).body).toMatchObject({ state: 'unavailable', detail: null });
  });
  it('holds an unknown or mismatched worker case rather than fabricating evidence', async () => {
    const ctx = context({ read: vi.fn().mockResolvedValue(null) } as unknown as ReadProjectionReader);
    await caseRequest(ctx); await settle(); expect((await caseRequest(ctx)).body).toMatchObject({ state: 'unavailable', detail: null });
    const mismatch = context({ read: vi.fn().mockResolvedValue({ ...caseDetail, caseId: 'a'.repeat(64) }) } as unknown as ReadProjectionReader);
    await caseRequest(mismatch); await settle(); expect((await caseRequest(mismatch)).body).toMatchObject({ state: 'unavailable', detail: null });
  });
  it.each([caseId, '../secret', wireCaseId+'/other', wireCaseId.toUpperCase(), '%2F', 'h:'+ 'a'.repeat(64)])('refuses invalid browser case identity %s before read', async (id) => {
    const read = vi.fn(); expect((await caseRequest(context({ read } as unknown as ReadProjectionReader), id)).status).toBe(400); expect(read).not.toHaveBeenCalled();
  });
  it('rejects writes and caller-selected ranges without a worker', async () => {
    const read = vi.fn(); const ctx = context({ read } as unknown as ReadProjectionReader);
    expect((await caseRequest(ctx, wireCaseId, 'POST')).status).toBe(404);
    expect((await caseRequest(ctx, wireCaseId, 'GET', '?file=/private')).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
  it('uses real HTTP read auth before lookup, exact current response, and no invalidation or dispatch', async () => {
    vi.useRealTimers();
    const cfg: AshlrConfig = { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {} };
    let finish!: (v: typeof caseDetail) => void;
    const read = vi.fn(() => new Promise<typeof caseDetail>((resolve) => { finish = resolve; }));
    const reader = { read, invalidate: vi.fn(async () => {}), close: vi.fn(async () => {}) } as unknown as ReadProjectionReader;
    const server = await startServer(cfg, { port: 0, open: false, allowDispatch: false }, { readProjections: reader });
    try {
      const url = server.url + EXECUTION_FEEDBACK_CASE_PATH + encodeURIComponent(wireCaseId);
      expect((await fetch(url, { signal: AbortSignal.timeout(2000) })).status).toBe(401); expect(read).not.toHaveBeenCalled();
      const headers = { 'x-ashlr-token': server.readToken };
      const pending = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      expect(await pending.json()).toMatchObject({ state: 'warming', detail: null });
      expect(read).toHaveBeenCalledExactlyOnceWith('execution-feedback-case', { caseId });
      finish(caseDetail); await settle();
      expect(await (await fetch(url, { headers, signal: AbortSignal.timeout(2000) })).json()).toMatchObject({ state: 'current', detail: { caseId: wireCaseId, shipping: 'not-recorded' } });
      expect((await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(2000) })).status).toBe(404);
      expect(reader.invalidate).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});

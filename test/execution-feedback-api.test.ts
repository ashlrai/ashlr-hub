import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleExecutionFeedbackApi, _resetExecutionFeedbackCacheForTest, EXECUTION_FEEDBACK_REFRESH_MS } from '../src/core/verse/execution-feedback-api.js';
import { EXECUTION_FEEDBACK_PATH } from '../src/core/verse/execution-feedback-api-types.js';
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

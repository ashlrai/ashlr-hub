/**
 * 3.15 Lessons routes under /api/verse/learning/lessons (verse/learning-api.ts),
 * driven with in-memory requests (no socket). The sweep and the fleet task
 * queue are mocked so nothing outside the isolated HOME is read or written.
 */
import { rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sweep = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/core/learn/retro/sweep.js', () => ({
  loadDefaultRetroSweepDeps: async () => ({}),
  sweepRetros: async () => {
    sweep.calls += 1;
    return { created: 0, candidates: 0, modelRefined: 0, unavailable: [], sweptAt: '2026-09-27T12:00:00.000Z' };
  },
}));
const tasks = vi.hoisted(() => ({ inputs: [] as unknown[] }));
vi.mock('../src/core/fleet/task-source.js', () => ({
  enqueueTask: (input: unknown) => {
    tasks.inputs.push(input);
    return { ok: true, task: { id: 'task-42' }, deduped: false };
  },
}));

import { retroFromFleet } from '../src/core/learn/retro/extract.js';
import { enqueueCandidates } from '../src/core/learn/retro/knowledge.js';
import { readKnowledge, saveRetro, writeSweepState } from '../src/core/learn/retro/store.js';
import { VERSE_LESSONS_AGENTS_MD_PATH, VERSE_LESSONS_KNOWLEDGE_PATH, VERSE_LESSONS_PATH, VERSE_LESSONS_SWEEP_PATH } from '../src/core/learn/retro/types.js';
import { handleLearningApi } from '../src/core/verse/learning-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const ctx = { cfg: {}, token: 'tok', allowDispatch: true } as unknown as VerseApiContext;

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = Object.assign(Readable.from(payload), {
    method,
    url,
    headers: body === undefined ? headers : { 'content-type': 'application/json', 'x-ashlr-token': 'tok', ...headers },
  }) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { text = chunk ?? ''; return res; },
  } as unknown as ServerResponse;
  const handled = await handleLearningApi(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  expect(handled).toBe(true);
  return { status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

async function seed(): Promise<string> {
  const retro = retroFromFleet({
    proposalId: 'p-1', repo: 'ashlrai/widget', endKind: 'gate-refused', endedAt: '2026-09-26T10:00:00.000Z',
    title: 'Fix flaky parser test', summary: null, paths: ['src/parser/lex.ts'],
    gate: { gate: 'G2', code: 'lines-over-cap', reason: 'the diff changes 900 lines (cap 400)' },
  }, '2026-09-26T10:00:00.000Z');
  await saveRetro(retro);
  await enqueueCandidates(retro, '2026-09-26T10:00:00.000Z');
  return (await readKnowledge())[0]!.id;
}

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
  sweep.calls = 0;
  tasks.inputs = [];
});

describe('GET /api/verse/learning/lessons', () => {
  it('answers LessonsStateV1 and kicks a background sweep only when the last one is stale', async () => {
    await seed();
    const res = await call('GET', VERSE_LESSONS_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ v: 1, windowDays: 30, sweptAt: null });
    expect((res.body!['retros'] as unknown[])).toHaveLength(1);
    expect(((res.body!['knowledge'] as { pending: unknown[] }).pending)).toHaveLength(1);
    await vi.waitFor(() => expect(sweep.calls).toBe(1));

    await writeSweepState({ v: 1, sweptAt: new Date().toISOString(), lastCreated: 0, modelCalls: {} });
    await call('GET', VERSE_LESSONS_PATH);
    await new Promise((r) => setTimeout(r, 20));
    expect(sweep.calls).toBe(1);
  });

  it('rejects query parameters and unknown subpaths', async () => {
    expect((await call('GET', `${VERSE_LESSONS_PATH}?all=1`)).status).toBe(400);
    expect((await call('GET', `${VERSE_LESSONS_PATH}/nope`)).status).toBe(404);
  });
});

describe('POSTs', () => {
  it('are gated: token, dispatch, known keys, valid ids', async () => {
    const id = await seed();
    expect((await call('POST', VERSE_LESSONS_KNOWLEDGE_PATH, { id, decision: 'approve' }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect((await call('POST', VERSE_LESSONS_KNOWLEDGE_PATH, { id, decision: 'approve', extra: 1 })).status).toBe(400);
    expect((await call('POST', VERSE_LESSONS_KNOWLEDGE_PATH, { id: '../x', decision: 'approve' })).status).toBe(400);
    expect((await call('POST', VERSE_LESSONS_KNOWLEDGE_PATH, { id, decision: 'maybe' })).status).toBe(400);
    (ctx as { allowDispatch: boolean }).allowDispatch = false;
    try {
      expect((await call('POST', VERSE_LESSONS_KNOWLEDGE_PATH, { id, decision: 'approve' })).status).toBe(404);
    } finally {
      (ctx as { allowDispatch: boolean }).allowDispatch = true;
    }
    expect((await readKnowledge())[0]!.status).toBe('pending');
  });

  it('approve with an edit, then propose for AGENTS.md through a fleet task', async () => {
    const id = await seed();
    expect((await call('POST', VERSE_LESSONS_AGENTS_MD_PATH, { id })).status).toBe(409);
    const approved = await call('POST', VERSE_LESSONS_KNOWLEDGE_PATH, {
      id, decision: 'approve', text: 'Keep widget parser PRs under 400 changed lines.', scope: { repo: 'ashlrai/widget', pathGlobs: ['src/parser/**'], taskKinds: [] },
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ ok: true, note: { status: 'approved', edited: true } });
    const proposed = await call('POST', VERSE_LESSONS_AGENTS_MD_PATH, { id });
    expect(proposed.status).toBe(200);
    expect(proposed.body).toMatchObject({ ok: true, taskId: 'task-42' });
    expect(tasks.inputs).toEqual([expect.objectContaining({ repo: 'ashlrai/widget', source: 'manual', requestedBy: 'mason' })]);
    expect((tasks.inputs[0] as { detail: string }).detail).toContain('Keep widget parser PRs under 400 changed lines.');
  });

  it('reject, and 404 for an unknown note', async () => {
    const id = await seed();
    expect((await call('POST', VERSE_LESSONS_KNOWLEDGE_PATH, { id, decision: 'reject' })).body).toMatchObject({ ok: true, note: { status: 'rejected' } });
    expect((await call('POST', VERSE_LESSONS_KNOWLEDGE_PATH, { id: 'kn_ffffffffffffffff', decision: 'approve' })).status).toBe(404);
  });

  it('sweep runs on demand', async () => {
    const res = await call('POST', VERSE_LESSONS_SWEEP_PATH, {});
    expect(res).toMatchObject({ status: 200, body: { ok: true, created: 0 } });
    expect(sweep.calls).toBe(1);
  });
});

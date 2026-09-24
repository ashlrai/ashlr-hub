import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeReasoningDigest,
  handleReasoningApi,
  queryReasoningSteps,
  resetReasoningApiState,
  runReasoningMaintenance,
} from '../src/core/reasoning/reasoning-api.js';
import { appendFeatures, appendSteps, reasoningRoot } from '../src/core/reasoning/store.js';
import { extractTurnFeatures } from '../src/core/reasoning/extractors.js';
import type { ReasoningDigest, ReasoningStepV1, ReasoningStepsResponse } from '../src/core/reasoning/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let home: string;
const saved = { HOME: process.env['HOME'], CODEX_HOME: process.env['CODEX_HOME'] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reasoning-api-'));
  process.env['HOME'] = home;
  delete process.env['ASHLR_HOME'];
  delete process.env['CODEX_HOME'];
  resetReasoningApiState();
});

afterEach(() => {
  resetReasoningApiState();
  process.env['HOME'] = saved.HOME;
  if (saved.CODEX_HOME !== undefined) process.env['CODEX_HOME'] = saved.CODEX_HOME;
  rmSync(home, { recursive: true, force: true });
});

interface Captured {
  status: number;
  body: unknown;
}

async function call(path: string, method = 'GET'): Promise<{ handled: boolean; res: Captured | null }> {
  const captured: Captured = { status: 0, body: undefined };
  let wrote = false;
  const res = {
    headersSent: false,
    writeHead(status: number) {
      captured.status = status;
      this.headersSent = true;
      return this;
    },
    end(payload?: string) {
      wrote = true;
      captured.body = payload ? JSON.parse(payload) : undefined;
    },
  } as unknown as ServerResponse;
  const url = path;
  const req = { url, method, headers: {} } as unknown as IncomingMessage;
  const pathname = url.split('?')[0] ?? url;
  const ctx = { cfg: {}, token: 't', allowDispatch: false } as unknown as VerseApiContext;
  const handled = await handleReasoningApi(ctx, req, res, pathname, method);
  return { handled, res: wrote ? captured : null };
}

const DAY = 86_400_000;
function step(id: string, agoMs: number, overrides: Partial<ReasoningStepV1> = {}): ReasoningStepV1 {
  return {
    v: 1, id, source: 'verse', sessionId: 'sA', runId: null, repo: null, engine: 'claude', model: 'm',
    at: new Date(Date.now() - agoMs).toISOString(), turnId: 't1', kind: 'thinking', text: `reasoning ${id}`,
    tokens: null, toolAfter: null, outcome: null, ...overrides,
  };
}

describe('handleReasoningApi routing', () => {
  it('declines paths outside its family', async () => {
    expect((await call('/api/verse/sessions')).handled).toBe(false);
    expect((await call('/api/reasoningX')).handled).toBe(false);
  });

  it('404s unknown reasoning paths, 405s non-GET', async () => {
    expect((await call('/api/reasoning')).res?.status).toBe(404);
    expect((await call('/api/reasoning/nope')).res?.status).toBe(404);
    const post = await call('/api/reasoning/digest', 'POST');
    expect(post.res).toMatchObject({ status: 405, body: { code: 'METHOD_NOT_ALLOWED' } });
  });

  it('400s invalid parameters', async () => {
    for (const path of [
      '/api/reasoning/digest?days=0',
      '/api/reasoning/digest?days=181',
      '/api/reasoning/digest?days=abc',
      '/api/reasoning/steps?limit=0',
      '/api/reasoning/steps?limit=-1',
      `/api/reasoning/steps?q=${'x'.repeat(201)}`,
      '/api/reasoning/steps?sessionId=has%20space',
    ]) {
      const { res } = await call(path);
      expect(res?.status, path).toBe(400);
      expect((res?.body as { code: string }).code).toBe('REASONING_INVALID');
    }
  });
});

describe('GET /api/reasoning/digest', () => {
  it('returns the contract shape with insights and daily trends', async () => {
    appendSteps([step('a', DAY), step('b', 2 * DAY, { engine: 'grok', sessionId: 'sB' })]);
    const failing = (n: number) => extractTurnFeatures({
      id: `verse:s${n}:t`, source: 'verse', sessionId: `s${n}`, runId: null, repo: '~/src/app', engine: 'claude',
      model: null, turnId: 't', startedAt: new Date(Date.now() - n * DAY).toISOString(), endedAt: null, outcome: 'ok',
      actions: [1, 2].map((i) => ({ kind: 'tool' as const, ref: `session:s${n}#${i}`, at: new Date(Date.now() - n * DAY).toISOString(), name: 'Bash', input: { command: 'npm test' }, ok: false })),
    });
    appendFeatures([failing(1), failing(2), failing(3)]);
    const { res } = await call('/api/reasoning/digest?days=7');
    expect(res?.status).toBe(200);
    const digest = res?.body as ReasoningDigest;
    expect(Object.keys(digest).sort()).toEqual(['generatedAt', 'insights', 'totals', 'trends', 'window']);
    expect(digest.totals).toEqual({ steps: 2, sessions: 5, byEngine: { claude: 1, grok: 1 } });
    expect(digest.insights[0]).toMatchObject({ kind: 'struggle', severity: 'high', count: 6, title: '"npm test" failed 6× across 3 turns in app (claude)' });
    expect(digest.trends.length).toBeGreaterThanOrEqual(7);
    expect(digest.trends.reduce((sum, d) => sum + d.struggles, 0)).toBe(3);
  });

  it('serves a cached digest briefly, then recomputes once the store changed', async () => {
    appendSteps([step('a', DAY)]);
    const first = await computeReasoningDigest(7);
    expect(await computeReasoningDigest(7)).toBe(first);
    appendSteps([step('b', DAY)]);
    // within the minimum-fresh window the cached digest is still served
    expect(await computeReasoningDigest(7)).toBe(first);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11_000;
      const later = await computeReasoningDigest(7);
      expect(later).not.toBe(first);
      expect(later.totals.steps).toBe(2);
      // unchanged store → cached again
      expect(await computeReasoningDigest(7)).toBe(later);
    } finally {
      Date.now = realNow;
    }
  });

  it('runs maintenance on the first request: a Verse session log becomes insights (end-to-end)', async () => {
    const sessions = join(home, '.ashlr', 'verse', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'e2e.json'), JSON.stringify({ id: 'e2e', engine: 'grok', model: 'grok-4.6', projectPath: join(home, 'code', 'site') }));
    const at = (s: number) => new Date(Date.now() - 3_600_000 + s * 1_000).toISOString();
    const events = [
      { seq: 1, at: at(1), type: 'turn-started', turnId: 'x', pid: null },
      { seq: 2, at: at(2), type: 'thinking', turnId: 'x', text: 'Edit then test.' },
      { seq: 3, at: at(3), type: 'tool-use', turnId: 'x', toolUseId: 'a', name: 'search_replace', input: { file_path: 'index.ts' } },
      { seq: 4, at: at(4), type: 'tool-result', turnId: 'x', toolUseId: 'a', output: '', isError: false },
      { seq: 5, at: at(5), type: 'assistant-message', turnId: 'x', text: 'Done — tests pass.' },
      { seq: 6, at: at(6), type: 'turn-done', turnId: 'x', ok: true, nativeSessionId: null, durationMs: 5 },
    ];
    writeFileSync(join(sessions, 'e2e.events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const { res } = await call('/api/reasoning/digest');
    const digest = res?.body as ReasoningDigest;
    expect(digest.totals.steps).toBe(1);
    expect(digest.totals.byEngine).toEqual({ grok: 1 });
    const claim = digest.insights.find((i) => i.kind === 'verification-gap' && i.title.startsWith('Claimed success'));
    expect(claim).toMatchObject({ repo: '~/code/site', engine: 'grok', severity: 'warn' });
    expect(JSON.stringify(digest)).not.toContain(home);
  });
});

describe('GET /api/reasoning/steps', () => {
  it('searches newest-first with q / sessionId / limit and reports truncation', async () => {
    appendSteps([
      step('s1', 3 * DAY, { text: 'The Cache is stale' }),
      step('s2', 2 * DAY, { text: 'unrelated' }),
      step('s3', DAY, { text: 'cache again', sessionId: 'sB' }),
    ]);
    const all = (await call('/api/reasoning/steps')).res?.body as ReasoningStepsResponse;
    expect(all.steps.map((s) => s.id)).toEqual(['s3', 's2', 's1']);
    expect(all.truncated).toBe(false);
    const q = (await call('/api/reasoning/steps?q=CACHE')).res?.body as ReasoningStepsResponse;
    expect(q.steps.map((s) => s.id)).toEqual(['s3', 's1']);
    const session = (await call('/api/reasoning/steps?q=cache&sessionId=sA')).res?.body as ReasoningStepsResponse;
    expect(session.steps.map((s) => s.id)).toEqual(['s1']);
    const limited = (await call('/api/reasoning/steps?limit=2')).res?.body as ReasoningStepsResponse;
    expect(limited).toMatchObject({ truncated: true });
    expect(limited.steps).toHaveLength(2);
  });

  it('clamps limit to the contract maximum', async () => {
    appendSteps(Array.from({ length: 5 }, (_, i) => step(`c${i}`, DAY)));
    const res = await queryReasoningSteps({ limit: 10_000 });
    expect(res.steps).toHaveLength(5);
  });

  it('materialises the turn outcome from its feature row', async () => {
    appendSteps([step('o1', DAY, { sessionId: 'sX', turnId: 'tX' })]);
    appendFeatures([extractTurnFeatures({
      id: 'verse:sX:tX', source: 'verse', sessionId: 'sX', runId: null, repo: null, engine: 'claude', model: null,
      turnId: 'tX', startedAt: new Date(Date.now() - DAY - 60_000).toISOString(), endedAt: null, outcome: 'error', actions: [],
    })]);
    const res = (await call('/api/reasoning/steps?sessionId=sX')).res?.body as ReasoningStepsResponse;
    expect(res.steps[0]?.outcome).toBe('error');
  });

  it('sanitises output even for rows written around the store', async () => {
    const dir = join(reasoningRoot(), 'steps');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const raw = step('raw', DAY, { text: `path ${home}/secret/dir and key sk-${'q'.repeat(30)}` });
    writeFileSync(join(dir, `${raw.at.slice(0, 10)}.jsonl`), JSON.stringify(raw) + '\n', { mode: 0o600 });
    const { res } = await call('/api/reasoning/steps');
    const text = JSON.stringify(res?.body);
    expect(text).not.toContain(home);
    expect(text).toContain('~/secret/dir');
    expect(text).not.toContain('q'.repeat(30));
  });
});

describe('runReasoningMaintenance', () => {
  it('is single-flight and tolerates an empty machine', async () => {
    const a = runReasoningMaintenance({});
    const b = runReasoningMaintenance({});
    expect(a).toBe(b);
    const summary = await a;
    expect(summary.verse).toMatchObject({ sessionsScanned: 0 });
    expect(summary.fleet).toMatchObject({ filesSeen: 0 });
    expect(summary.codex).toMatchObject({ filesSeen: 0 });
    expect(summary.retention).toMatchObject({ removedFiles: 0 });
  });
});

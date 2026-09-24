/**
 * 3.10 server performance (unit A3) — /api/events push path.
 *
 *  - `verse-sessions` is pushed OUTSIDE the in-flight guard: a slow (or hung)
 *    dashboard projection can no longer hold the Verse sidebar back (12–14 s
 *    gaps were measured).
 *  - notifyVerseSessionsChanged() pushes immediately (coalesced per turn), and
 *    handleApi fires it after every mutating /api/verse request.
 *  - `?topics=` narrows a stream to the groups a client uses; a Verse-only
 *    stream triggers no runs/swarms/inbox/snapshot/daemon reads at all.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadProjectionReader } from '../src/core/web/read-projections.js';

const verse = vi.hoisted(() => ({ digest: 'a:idle:1', sessions: [{ id: 'a' }] as unknown[], posts: 0 }));

vi.mock('../src/core/verse/verse-api.js', () => ({
  isVerseApiPath: (path: string) => path.startsWith('/api/verse/'),
  handleVerseApi: vi.fn(async (_ctx: unknown, _req: unknown, res: ServerResponse) => {
    verse.posts += 1;
    verse.digest = `changed-${verse.posts}`;
    verse.sessions = [{ id: `s${verse.posts}` }];
    res.writeHead(200);
    res.end('{}');
    return true;
  }),
  verseSessionsDigest: () => verse.digest,
  verseSessionsSnapshot: () => verse.sessions,
  resetVerseEngine: vi.fn(),
  peekVerseEngine: () => null,
  expandHomePrefix: (p: string) => p,
}));

const reads = vi.hoisted(() => ({ runs: 0, swarms: 0, proposals: 0 }));
vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: vi.fn(() => { reads.runs += 1; return []; }),
  loadRun: vi.fn(() => null),
  runGoal: vi.fn(),
}));
vi.mock('../src/core/swarm/store.js', () => ({
  listSwarms: vi.fn(() => { reads.swarms += 1; return []; }),
  loadSwarm: vi.fn(() => null),
}));

const api = await import('../src/core/web/api.js');

function makeReq(url: string, method = 'GET'): IncomingMessage {
  return {
    url,
    method,
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    on() { return this; },
    once() { return this; },
  } as unknown as IncomingMessage;
}

function makeSseRes() {
  const chunks: string[] = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead() { (this as { headersSent: boolean }).headersSent = true; return this; },
    setHeader() {},
    write(chunk: string) { chunks.push(chunk); return true; },
    end(chunk?: string) { if (chunk) chunks.push(chunk); (this as { writableEnded: boolean }).writableEnded = true; },
    on() { return this; },
    once() { return this; },
  };
  return {
    res: res as unknown as ServerResponse,
    events: (): string[] => chunks.join('').split('\n').filter((l) => l.startsWith('event: ')).map((l) => l.slice(7)),
  };
}

const session = { id: 'a3-sse', expiresAt: Date.now() + 3_600_000 };
const cfg = { version: 1, roots: [], telemetry: {}, tools: {}, models: { providerChain: [] } } as never;

/** A read-projection worker that never answers — the worst-case slow snapshot. */
const hungProjections: ReadProjectionReader = {
  read: () => new Promise(() => {}),
  invalidate: async () => {},
  close: async () => {},
} as unknown as ReadProjectionReader;

const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  verse.digest = 'a:idle:1';
  verse.sessions = [{ id: 'a' }];
  verse.posts = 0;
  reads.runs = 0;
  reads.swarms = 0;
  reads.proposals = 0;
});

afterEach(() => {
  api.drainSseConnections();
});

describe('parseSseTopics', () => {
  it('defaults to every topic and ignores unknown names', () => {
    expect([...api.parseSseTopics(undefined)].sort()).toEqual([...api.SSE_TOPICS].sort());
    expect([...api.parseSseTopics('verse-sessions')]).toEqual(['verse-sessions']);
    expect([...api.parseSseTopics(' runs , bogus,swarms')].sort()).toEqual(['runs', 'swarms']);
    expect(api.parseSseTopics('bogus').size).toBe(api.SSE_TOPICS.length);
    expect(api.parseSseTopics('x'.repeat(300)).size).toBe(api.SSE_TOPICS.length);
  });
});

describe('verse-sessions push', () => {
  it('is sent immediately even while every other projection hangs', async () => {
    const { res, events } = makeSseRes();
    await api.handleApi(makeReq('/api/events'), res, cfg, {
      token: 't', allowDispatch: false, readSession: session, readProjections: hungProjections,
    });
    expect(events()).toEqual(['verse-sessions']);
    verse.digest = 'a:running:1';
    const started = performance.now();
    api.notifyVerseSessionsChanged();
    await turn();
    expect(events()).toEqual(['verse-sessions', 'verse-sessions']);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('pushes only when the digest changed, and coalesces bursts', async () => {
    const { res, events } = makeSseRes();
    await api.handleApi(makeReq('/api/events'), res, cfg, {
      token: 't', allowDispatch: false, readSession: session, readProjections: hungProjections,
    });
    api.notifyVerseSessionsChanged();
    await turn();
    expect(events()).toHaveLength(1);
    verse.digest = 'b';
    api.notifyVerseSessionsChanged();
    api.notifyVerseSessionsChanged();
    api.notifyVerseSessionsChanged();
    await turn();
    expect(events()).toHaveLength(2);
  });

  it('a mutating /api/verse request pushes the sidebar without waiting for a poll', async () => {
    const { res, events } = makeSseRes();
    await api.handleApi(makeReq('/api/events?topics=verse-sessions'), res, cfg, {
      token: 't', allowDispatch: false, readSession: session,
    });
    expect(events()).toEqual(['verse-sessions']);
    const post = makeSseRes();
    await api.handleApi(makeReq('/api/verse/sessions', 'POST'), post.res, cfg, {
      token: 't', allowDispatch: true, readSession: session,
    });
    await turn();
    expect(events()).toEqual(['verse-sessions', 'verse-sessions']);
    expect(verse.posts).toBe(1);
  });
});

describe('topics', () => {
  it('a Verse-only stream reads no runs, swarms, inbox, snapshot, or daemon state', async () => {
    const reader = { read: vi.fn(() => new Promise(() => {})), invalidate: async () => {}, close: async () => {} };
    const { res, events } = makeSseRes();
    await api.handleApi(makeReq('/api/events?topics=verse-sessions'), res, cfg, {
      token: 't', allowDispatch: false, readSession: session,
      readProjections: reader as unknown as ReadProjectionReader,
    });
    await turn();
    expect(events()).toEqual(['verse-sessions']);
    expect(reader.read).not.toHaveBeenCalled();
    expect(reads.runs + reads.swarms).toBe(0);
  });

  it('a stream without topics still asks for the full set', async () => {
    const reader = { read: vi.fn(() => new Promise(() => {})), invalidate: async () => {}, close: async () => {} };
    const { res } = makeSseRes();
    await api.handleApi(makeReq('/api/events'), res, cfg, {
      token: 't', allowDispatch: false, readSession: session,
      readProjections: reader as unknown as ReadProjectionReader,
    });
    await turn();
    expect(reader.read).toHaveBeenCalled();
  });
});

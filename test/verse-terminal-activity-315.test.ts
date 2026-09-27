/**
 * 3.15 — the terminal's side of /api/verse/activity (src/core/verse/
 * terminal-activity.ts, wired by activity-api.ts `resolveTrackBHooks`).
 *
 * Runs under a relocated HOME with a FAKE engine; no server is bound (the
 * route is driven with a minimal request/response pair) and no process is
 * spawned.
 *
 * What is pinned:
 *   - an agent tab waiting on the operator is a `chats` / `agent-waiting`
 *     Needs-you item that passes the R1 boundary check (Devin's engine
 *     included) and reaches the activity response through the merged lane;
 *   - the response carries `terminal` ({boot, seq, events}); null when the
 *     module is not wired or throws — never an error for the whole poll;
 *   - the real lazy import wires both (resolveTrackBHooks);
 *   - the validator accepts a `terminal` target and refuses a bad tabId.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { createActivityReader, type ActivityDeps, type ActivityEngine } from '../src/core/verse/activity.js';
import { handleActivityApi, resolveTrackBHooks, setActivityWiringForTest } from '../src/core/verse/activity-api.js';
import { createSessionMetaStore } from '../src/core/verse/session-meta.js';
import {
  needsYouItems,
  recordTerminalEvent,
  resetTerminalActivityForTest,
  setAgentWaiting,
  terminalActivitySnapshot,
} from '../src/core/verse/terminal-activity.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { isNeedsYouItem, NEEDS_YOU_KIND_CATEGORY, type NeedsYouItem, type VerseActivityResponse } from '../src/core/verse/workbench-types.js';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-activity-315-'));
  process.env['HOME'] = home;
  resetTerminalActivityForTest();
});

afterEach(() => {
  setActivityWiringForTest(null);
  resetTerminalActivityForTest();
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const T0 = '2026-09-27T10:00:00.000Z';

class EmptyEngine implements ActivityEngine {
  listSessions(): ReturnType<ActivityEngine['listSessions']> {
    return [];
  }
}

function waitOn(tabId: string, agent: 'claude-code' | 'devin', sessionId: string | null = 'vs_1'): void {
  setAgentWaiting(tabId, { sessionId, title: `repo ${tabId}`, agent, since: T0, message: 'Approve the edit to package.json?' });
}

function deps(over: Partial<ActivityDeps> = {}): ActivityDeps {
  return {
    engine: () => new EmptyEngine(),
    meta: createSessionMetaStore(),
    producers: () => ({ authority: null, fleet: null, leader: null }),
    approvals: () => ({ state: 'ok', items: [], total: 0 }),
    health: () => null,
    autonomy: () => null,
    latestMemoAt: null,
    ...over,
  };
}

/** Drive the GET route without binding a port: the handler only reads `url` on a GET. */
async function getActivity(): Promise<{ status: number; body: VerseActivityResponse }> {
  const ctx = { cfg: {} as VerseApiContext['cfg'], token: 'tok', allowDispatch: true } as VerseApiContext;
  let status = 0;
  let payload = '';
  const req = { url: '/api/verse/activity', method: 'GET', headers: {} } as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; return this; },
    setHeader() { return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const handled = await handleActivityApi(ctx, req, res, '/api/verse/activity', 'GET');
  expect(handled).toBe(true);
  return { status, body: JSON.parse(payload) as VerseActivityResponse };
}

describe('terminal Needs-you items', () => {
  it('file under chats / agent-waiting with a terminal target, and pass the boundary check', () => {
    waitOn('t-abc1', 'claude-code');
    waitOn('t-abc2', 'devin', null);
    const items = needsYouItems();
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(isNeedsYouItem(item), item.id).toBe(true);
      expect(item.source).toBe('chats');
      expect(NEEDS_YOU_KIND_CATEGORY[item.kind]).toBe('chats');
    }
    const devin = items.find((i) => i.id === 'chats:agent-waiting:t-abc2')!;
    expect(devin.subject.engine).toBe('devin');
    expect(devin.target).toEqual({ kind: 'terminal', sessionId: null, tabId: 't-abc2' });
  });

  it('reach the activity response through the merged lane, next to the terminal events', () => {
    waitOn('t-abc1', 'claude-code');
    recordTerminalEvent({
      kind: 'command-finished', tabId: 't-abc1', blockId: 'b-7', sessionId: 'vs_1', title: 'repo', agent: null, exitCode: 1, durationMs: 134_000,
    });
    const reader = createActivityReader(deps({ cloud: needsYouItems, terminal: terminalActivitySnapshot }));
    const { response, dropped } = reader.build(null);
    expect(dropped).toEqual({});
    expect(response.needsYou.map((i) => i.id)).toEqual(['chats:agent-waiting:t-abc1']);
    expect(response.counts.needsYou).toBe(1);
    expect(response.terminal?.seq).toBe(1);
    expect(response.terminal?.events).toEqual([
      expect.objectContaining({ seq: 1, kind: 'command-finished', tabId: 't-abc1', blockId: 'b-7', exitCode: 1, durationMs: 134_000 }),
    ]);
    expect(response.terminal?.boot).toMatch(/^[0-9a-f]{8}$/);

    // Cleared: gone from the drawer on the next poll.
    setAgentWaiting('t-abc1', null);
    expect(reader.build(null).response.needsYou).toEqual([]);
  });

  it('answers terminal: null when the module is not wired or throws, and the poll still succeeds', () => {
    expect(createActivityReader(deps()).build(null).response.terminal).toBeNull();
    const throwing = createActivityReader(deps({ terminal: () => { throw new Error('boom'); } })).build(null).response;
    expect(throwing.terminal).toBeNull();
    expect(throwing.sources.chats).toBe('ok');
  });
});

describe('GET /api/verse/activity', () => {
  it('serves the waiting agent and the terminal field through the route', async () => {
    waitOn('t-zz9', 'claude-code');
    recordTerminalEvent({
      kind: 'agent-needs-you', tabId: 't-zz9', blockId: null, sessionId: 'vs_1', title: 'repo', agent: 'claude-code', exitCode: null, durationMs: null,
    });
    setActivityWiringForTest({
      engine: () => new EmptyEngine(),
      hooks: {
        producers: { authority: () => [], fleet: () => [], leader: () => [] },
        autonomy: null,
        latestMemoAt: null,
        cloud: needsYouItems,
        terminal: terminalActivitySnapshot,
      },
      deps: { health: () => null },
    });
    const { status, body } = await getActivity();
    expect(status).toBe(200);
    expect(body.needsYou).toEqual([expect.objectContaining({ id: 'chats:agent-waiting:t-zz9', kind: 'agent-waiting', target: { kind: 'terminal', sessionId: 'vs_1', tabId: 't-zz9' } })]);
    expect(body.terminal).toEqual({ boot: expect.any(String), seq: 1, events: [expect.objectContaining({ kind: 'agent-needs-you', agent: 'claude-code' })] });
  });

  it('says terminal: null for hooks without the terminal module', async () => {
    setActivityWiringForTest({
      engine: () => new EmptyEngine(),
      hooks: { producers: { authority: () => [], fleet: () => [], leader: () => [] }, autonomy: null, latestMemoAt: null },
      deps: { health: () => null },
    });
    const { status, body } = await getActivity();
    expect(status).toBe(200);
    expect(body.terminal).toBeNull();
  });
});

describe('resolveTrackBHooks', () => {
  it('lazy-imports terminal-activity: its items join the merged lane and its snapshot is the terminal hook', async () => {
    waitOn('t-real1', 'claude-code');
    const hooks = await resolveTrackBHooks();
    expect(typeof hooks.terminal).toBe('function');
    expect(hooks.terminal!()).toEqual(terminalActivitySnapshot());
    expect(hooks.cloud).toBeTypeOf('function');
    expect(hooks.cloud!().map((i) => i.id)).toContain('chats:agent-waiting:t-real1');
  }, 60_000);
});

describe('isNeedsYouItem and the terminal target', () => {
  const base = (): NeedsYouItem => {
    waitOn('t-ok1', 'claude-code');
    const item = needsYouItems()[0]!;
    resetTerminalActivityForTest();
    return item;
  };

  it('accepts a terminal target with or without a chat', () => {
    const item = base();
    expect(isNeedsYouItem(item)).toBe(true);
    expect(isNeedsYouItem({ ...item, target: { kind: 'terminal', sessionId: null, tabId: 't-0' } })).toBe(true);
  });

  it('refuses a malformed tabId or sessionId', () => {
    const item = base();
    for (const tabId of ['', 't-', 'T-abc', 'tab-1', 't-ABC', 't-../x', `t-${'a'.repeat(33)}`, 't-a b', 42, null]) {
      expect(isNeedsYouItem({ ...item, target: { kind: 'terminal', sessionId: 'vs_1', tabId } }), String(tabId)).toBe(false);
    }
    expect(isNeedsYouItem({ ...item, target: { kind: 'terminal', sessionId: '', tabId: 't-ok1' } })).toBe(false);
    expect(isNeedsYouItem({ ...item, target: { kind: 'terminal', tabId: 't-ok1' } })).toBe(false);
  });
});

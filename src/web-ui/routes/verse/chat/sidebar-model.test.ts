/**
 * chat/sidebar-model.test.ts — the chat list's data rules, and the 11px
 * floor for the list's status marks (SPEC-310C §2 "Status markers are at
 * least 11px").
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VerseEvent } from '../../../data/api-types.js';
import { bootstrap, ev, session } from '../fixtures.test-support.js';
import { applyVerseEvent, getVerseSessionHead, resetVerseStore, seedVerseSession, turnSettlement } from '../verse-store.js';
import { buildSidebar, liveLine, needsYouSessionIds } from './sidebar-model.js';

const here = dirname(fileURLToPath(import.meta.url));

function build(over: Partial<Parameters<typeof buildSidebar>[0]> = {}) {
  return buildSidebar({
    sessions: [session({ id: 'a', status: 'error' }), session({ id: 'b', turnCount: 3 })],
    projects: bootstrap().projects, query: '', filter: 'all', activity: null, meta: null, localSeen: new Map(), selectedId: null, ...over,
  });
}

describe('buildSidebar', () => {
  it('without activity, a failed chat is the one "needs you"; without meta nothing is unread', () => {
    const model = build();
    expect(model.counts['needs-you']).toBe(1);
    expect(model.metaAvailable).toBe(false);
    const rows = model.groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.session.id === 'b')!.status.kind).toBe('time');
  });

  it('counts a chat never opened as unread once meta answers, and the open chat never', () => {
    const meta = { sessions: {} };
    let rows = build({ meta }).groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.session.id === 'b')!.status).toEqual({ kind: 'unread', newTurns: 3 });
    rows = build({ meta, selectedId: 'b' }).groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.session.id === 'b')!.status.kind).toBe('time');
    // This tab's own reading clears it before the server confirms.
    rows = build({ meta, localSeen: new Map([['b', 3]]) }).groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.session.id === 'b')!.status.kind).toBe('time');
  });

  it('matches Needs-you items by subject or target', () => {
    const ids = needsYouSessionIds([
      { subject: { sessionId: 'x' }, target: { kind: 'section', section: 'fleet', anchor: null } },
      { subject: { sessionId: null }, target: { kind: 'session', sessionId: 'y' } },
    ] as never);
    expect([...ids].sort()).toEqual(['x', 'y']);
  });

  it('turns activity\'s live state into one muted line — never a guess', () => {
    expect(liveLine(null)).toBeNull();
    expect(liveLine({ phase: 'tool', tool: 'npm test', elapsedMs: 1, thinkingTail: 'x' })).toBe('npm test');
    const tail = 'a'.repeat(200);
    expect(liveLine({ phase: 'thinking', tool: null, elapsedMs: 1, thinkingTail: tail })!.length).toBeLessThanOrEqual(72);
    expect(liveLine({ phase: 'waiting', tool: null, elapsedMs: 1, thinkingTail: null })).toBe('Waiting for the model');
    expect(liveLine({ phase: null, tool: null, elapsedMs: 1, thinkingTail: null })).toBeNull();
  });
});

describe('selected terminal evidence beats only stale activity', () => {
  const startAt = '2026-10-10T05:35:49.916Z';
  const terminalAt = '2026-10-10T05:37:33.145Z';
  const start = { ...ev(1, 'turn-started', { turnId: 't1', pid: 1 }), at: startAt };
  const done = { ...ev(2, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1 }), at: terminalAt };
  const activity = (startedAt = startAt, sessionId = 'b') => ({
    running: [{ sessionId, startedAt, live: { phase: 'waiting', tool: null, elapsedMs: 1, thinkingTail: null } }], needsYou: [],
  }) as never;
  function selectedTerminal(events: readonly VerseEvent[], sessionId = 'b') {
    const settlement = turnSettlement(events);
    return settlement ? { sessionId, terminal: settlement.terminal } : null;
  }
  const row = (model: ReturnType<typeof build>) => model.groups.flatMap(group => group.rows)[0]!;
  beforeEach(resetVerseStore);
  afterEach(resetVerseStore);

  it.each(['idle', 'error'] as const)('a matching terminal settles stale activity for a selected %s session', status => {
    const model = build({ sessions: [session({ id: 'b', status, updatedAt: 'not-a-date' })], selectedId: 'b',
      activity: activity(), selectedTerminal: selectedTerminal([start, done]) });
    expect(model.counts.running).toBe(0);
    expect(row(model).status.kind).toBe(status === 'error' ? 'failed' : 'time');
    expect(row(model).live).toBeNull();
  });

  it('derives completion from the real selected head and clears stale activity', () => {
    seedVerseSession('b', session({ id: 'b', status: 'running' }), []);
    applyVerseEvent('b', start);
    applyVerseEvent('b', done);
    const head = getVerseSessionHead('b');
    expect(head.session?.status).toBe('idle');
    const model = build({ sessions: [head.session!], selectedId: 'b', activity: activity(),
      selectedTerminal: selectedTerminal(head.events) });
    expect(model.counts.running).toBe(0);
    expect(row(model).status.kind).toBe('time');
    expect(row(model).live).toBeNull();
  });

  it('keeps activity after an old idle detail and a newer nonterminal context update', () => {
    const idle = session({ id: 'b', status: 'idle', updatedAt: '2026-10-10T05:35:00.000Z' });
    seedVerseSession('b', idle, []);
    applyVerseEvent('b', start);
    expect(getVerseSessionHead('b').session?.status).toBe('running');
    seedVerseSession('b', idle, []); // Delayed pre-turn detail must preserve the observed open turn.
    applyVerseEvent('b', { ...ev(2, 'context', { turnId: 't1', contextTokens: 12, contextWindow: 65_536, exact: true }), at: terminalAt });
    const head = getVerseSessionHead('b');
    expect(head.session?.status).toBe('running');
    expect(head.session?.updatedAt).toBe(terminalAt);
    expect(selectedTerminal(head.events)).toBeNull();
    const model = build({ sessions: [head.session!], selectedId: 'b', activity: activity(),
      selectedTerminal: selectedTerminal(head.events) });
    expect(model.counts.running).toBe(1);
    expect(row(model).status.kind).toBe('running');
    expect(row(model).live?.text).toBe('Waiting for the model');
  });

  it.each(['user-message', 'turn-started'] as const)('a newer %s without its own terminal invalidates old proof', type => {
    const next = type === 'user-message' ? ev(3, type, { turnId: 't2', text: 'again' })
      : ev(3, type, { turnId: 't2', pid: 2 });
    const model = build({ sessions: [session({ id: 'b', status: 'idle', updatedAt: terminalAt })], selectedId: 'b',
      activity: activity(), selectedTerminal: selectedTerminal([start, done, next]) });
    expect(model.counts.running).toBe(1);
  });

  it('an error alone and an unrelated terminal prove no completion of the latest turn', () => {
    const events = [start, ev(2, 'error', { turnId: 't1', message: 'fixture error' }),
      ev(3, 'cancelled', { turnId: 'unrelated' })];
    expect(selectedTerminal(events)).toBeNull();
    expect(build({ sessions: [session({ id: 'b', status: 'error', updatedAt: terminalAt })], selectedId: 'b',
      activity: activity(), selectedTerminal: selectedTerminal(events) }).counts.running).toBe(1);
  });

  it('accepts a matching cancel as terminal evidence', () => {
    const cancelled = { ...ev(2, 'cancelled', { turnId: 't1' }), at: terminalAt };
    expect(build({ sessions: [session({ id: 'b', status: 'idle' })], selectedId: 'b',
      activity: activity(), selectedTerminal: selectedTerminal([start, cancelled]) }).counts.running).toBe(0);
  });

  it.each([
    [terminalAt, terminalAt], // Equality cannot establish an older activity row.
    [terminalAt, '2026-10-10T05:38:00.000Z'],
    ['not-a-date', startAt],
    [terminalAt, 'not-a-date'],
  ])('keeps activity with unproven terminal/start ordering (%s, %s)', (at, startedAt) => {
    expect(build({ sessions: [session({ id: 'b', status: 'idle' })], selectedId: 'b',
      activity: activity(startedAt), selectedTerminal: selectedTerminal([start, { ...done, at }]) }).counts.running).toBe(1);
  });

  it.each(['running', 'different-selection', 'different-proof', 'no-selection'] as const)('keeps activity for %s', scenario => {
    const model = build({ sessions: [session({ id: 'b', status: scenario === 'running' ? 'running' : 'idle' })],
      selectedId: scenario === 'no-selection' ? null : scenario === 'different-selection' ? 'other' : 'b',
      activity: activity(), selectedTerminal: selectedTerminal([start, done], scenario === 'different-proof' ? 'other' : 'b') });
    expect(model.counts.running).toBe(1);
  });
});

describe('Sidebar status marks', () => {
  it('declares no font size under the 11px floor (no literal px sizes at all)', () => {
    const css = readFileSync(resolve(here, '../Sidebar.module.css'), 'utf8');
    const literal = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(literal.filter((px) => px < 11)).toEqual([]);
  });
});

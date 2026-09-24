/**
 * chat/sidebar-model.test.ts — the chat list's data rules, and the 11px
 * floor for the list's status marks (SPEC-310C §2 "Status markers are at
 * least 11px").
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bootstrap, session } from '../fixtures.test-support.js';
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

describe('Sidebar status marks', () => {
  it('declares no font size under the 11px floor (no literal px sizes at all)', () => {
    const css = readFileSync(resolve(here, '../Sidebar.module.css'), 'utf8');
    const literal = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(literal.filter((px) => px < 11)).toEqual([]);
  });
});

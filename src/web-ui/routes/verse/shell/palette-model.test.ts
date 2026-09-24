/**
 * palette-model — ranking, grouping and prefixes of the ⌘K palette (unit C1).
 */
import { describe, expect, it } from 'vitest';
import type { NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { CLAUDE_SEAT, GROK_SEAT, session } from '../fixtures.test-support.js';
import { argumentItems, buildPaletteItems, fuzzyScore, matchItem, paletteView, type PaletteInput } from './palette-model.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');

function needs(id: string, title: string): NeedsYouItem {
  return {
    id,
    source: 'approvals',
    kind: 'approval',
    severity: 'high',
    title,
    detail: null,
    since: new Date(NOW - 60_000).toISOString(),
    expiresAt: null,
    subject: { repo: 'binshield', pr: null, seatId: null, sessionId: null, engine: null },
    target: { kind: 'approval', proposalId: id },
    actions: [],
  };
}

function input(over: Partial<PaletteInput> = {}): PaletteInput {
  return {
    needsYou: [needs('n1', 'PR: fix flaky test'), needs('n2', 'PR: bump deps'), needs('n3', 'patch: docs'), needs('n4', 'PR: four')],
    running: [{ sessionId: 's-run', title: 'Refactor store', engine: 'claude', seatId: 'claude-a', startedAt: new Date(NOW - 62_000).toISOString(), live: null }],
    sessions: [
      session({ id: 's-old', title: 'Stop words tokenizer', updatedAt: new Date(NOW - 3_600_000).toISOString() }),
      session({ id: 's-run', title: 'Refactor store', status: 'running', updatedAt: new Date(NOW - 7_200_000).toISOString() }),
    ],
    seats: [CLAUDE_SEAT, GROK_SEAT],
    projects: [{ path: '/Users/m/repos/ashlr-hub', name: 'ashlr-hub', enrolled: true }],
    recentActions: [],
    platform: 'mac',
    now: NOW,
    ...over,
  };
}

describe('matching', () => {
  it('prefers contiguous, word-start matches and rejects non-matches', () => {
    expect(fuzzyScore('stop', 'Stop running chats…')!).toBeGreaterThan(fuzzyScore('stop', 'Stash the tokens please')!);
    expect(fuzzyScore('zz', 'Stop')).toBeNull();
    expect(matchItem({ title: 'Review changes', subtitle: null, keywords: ['diff', 'git'] }, 'diff')).not.toBeNull();
    expect(matchItem({ title: 'Review changes', subtitle: null, keywords: [] }, 'review nope')).toBeNull();
  });
});

describe('the palette view', () => {
  it('orders groups Needs you › Chats › Actions › Go to › Seats & Apps › Projects', () => {
    const view = paletteView(buildPaletteItems(input()), 's', [], 'mac');
    const order = view.groups.map((g) => g.id);
    const expected = ['needs-you', 'chats', 'actions', 'go-to', 'seats-apps', 'projects'].filter((g) => order.includes(g as never));
    expect(order).toEqual(expected);
  });

  it('"stop" puts Stop running chats… first among actions, and keeps running chats first', () => {
    const view = paletteView(buildPaletteItems(input()), 'stop', [], 'mac');
    const actions = view.groups.find((g) => g.id === 'actions')!;
    expect(actions.items[0]!.title).toBe('Stop running chats…');
    const chats = paletteView(buildPaletteItems(input()), '#', [], 'mac').groups[0]!;
    expect(chats.items.map((i) => i.title)).toEqual(['Refactor store', 'Stop words tokenizer']);
    expect(chats.items[0]!.subtitle).toContain('running 1m 02s');
  });

  it('> limits to actions and # to chats', () => {
    expect(paletteView(buildPaletteItems(input()), '>new', [], 'mac').groups.map((g) => g.id)).toEqual(['actions']);
    expect(paletteView(buildPaletteItems(input()), '#stop', [], 'mac').groups.map((g) => g.id)).toEqual(['chats']);
  });

  it('an empty query shows what needs you (3) and the last actions run', () => {
    const view = paletteView(buildPaletteItems(input()), '', ['dock.terminal', 'chat.new', 'not.a.command'], 'mac');
    expect(view.groups.map((g) => [g.id, g.items.length])).toEqual([
      ['needs-you', 3],
      ['recent', 2],
    ]);
    expect(view.groups[1]!.items.map((i) => i.title)).toEqual(['Terminal', 'New chat']);
    expect(view.groups[1]!.items[0]!.shortcut).toBe('⌃`');
    // No history yet: a starter set rather than an empty list.
    expect(paletteView(buildPaletteItems(input({ needsYou: [] })), '', [], 'mac').groups[0]!.items.map((i) => i.title)).toEqual([
      'New chat',
      'Open Needs you',
      'Keyboard shortcuts',
    ]);
  });

  it('marks argument commands and lists their candidates', () => {
    const view = paletteView(buildPaletteItems(input()), 'new chat on', [], 'mac');
    const on = view.flat.find((i) => i.title === 'New chat on…')!;
    expect(on.argument).toEqual({ kind: 'seat', prompt: 'Seat' });
    expect(argumentItems('seat', input()).map((i) => i.title)).toEqual([CLAUDE_SEAT.label, GROK_SEAT.label]);
    expect(argumentItems('seat', input())[0]!.monogram).toBe('C');
  });

  it('prints shortcuts for the platform', () => {
    const other = paletteView(buildPaletteItems(input({ platform: 'other' })), '>preview', [], 'other').flat[0]!;
    expect(other.shortcut).toBe('Ctrl+Shift+B');
    const mac = paletteView(buildPaletteItems(input()), '>preview', [], 'mac').flat[0]!;
    expect(mac.shortcut).toBe('⇧⌘B');
  });
});

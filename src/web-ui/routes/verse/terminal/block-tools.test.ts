import { describe, expect, it } from 'vitest';
import {
  blocksChatText,
  elapsedLabel,
  EMPTY_SELECTION,
  filterOutputLines,
  loadBookmarks,
  loadFixChipsEnabled,
  pruneSelection,
  saveFixChipsEnabled,
  selectBlock,
  terminalBlockLink,
  toggleBookmark,
  urlLabel,
} from './block-tools.js';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe('filterOutputLines', () => {
  const text = 'ok 1\n\x1b[31mFAIL\x1b[0m src/a.test.ts\nok 2\nError: boom';

  it('keeps matching lines (colour kept), case-insensitive by default', () => {
    const out = filterOutputLines(text, { pattern: 'fail', regex: false, invert: false, caseSensitive: false });
    expect(out).toEqual({ text: '\x1b[31mFAIL\x1b[0m src/a.test.ts', shown: 1, total: 4, error: null });
  });

  it('inverts, respects case, and reads regular expressions', () => {
    expect(filterOutputLines(text, { pattern: '^ok', regex: true, invert: true, caseSensitive: false }).text).toBe('\x1b[31mFAIL\x1b[0m src/a.test.ts\nError: boom');
    expect(filterOutputLines(text, { pattern: 'error', regex: false, invert: false, caseSensitive: true }).shown).toBe(0);
    // The colour codes are not matched against: "31m" is not text on screen.
    expect(filterOutputLines(text, { pattern: '31m', regex: false, invert: false, caseSensitive: false }).shown).toBe(0);
  });

  it('an invalid regex keeps every line and says why', () => {
    const out = filterOutputLines(text, { pattern: '(', regex: true, invert: false, caseSensitive: false });
    expect(out.text).toBe(text);
    expect(out.error).toBeTruthy();
    expect(filterOutputLines(text, { pattern: '', regex: true, invert: true, caseSensitive: false }).text).toBe(text);
  });
});

describe('selectBlock', () => {
  const order = ['b-1', 'b-2', 'b-3', 'b-4'];
  it('⌘-click toggles, ⇧-click selects the range from the anchor, a plain click is not a selection', () => {
    let sel = selectBlock(EMPTY_SELECTION, order, 'b-2', { range: false, toggle: true })!;
    expect([...sel.ids]).toEqual(['b-2']);
    sel = selectBlock(sel, order, 'b-4', { range: true, toggle: false })!;
    expect([...sel.ids].sort()).toEqual(['b-2', 'b-3', 'b-4']);
    sel = selectBlock(sel, order, 'b-3', { range: false, toggle: true })!;
    expect([...sel.ids].sort()).toEqual(['b-2', 'b-4']);
    expect(selectBlock(sel, order, 'b-1', { range: false, toggle: false })).toBeNull();
    // Backwards ranges too.
    expect([...selectBlock({ ids: new Set(), anchor: 'b-3' }, order, 'b-1', { range: true, toggle: false })!.ids].sort()).toEqual(['b-1', 'b-2', 'b-3']);
  });

  it('prunes blocks that left the tab', () => {
    const sel = { ids: new Set(['b-1', 'b-9']), anchor: 'b-9' };
    expect(pruneSelection(sel, ['b-1'])).toEqual({ ids: new Set(['b-1']), anchor: null });
    const same = { ids: new Set(['b-1']), anchor: 'b-1' };
    expect(pruneSelection(same, ['b-1'])).toBe(same);
  });
});

describe('blocksChatText', () => {
  const ok = { exitCode: 0, failed: false, cwd: '~/app', source: 'terminal' as const, running: false };
  const bad = { exitCode: 2, failed: true, cwd: null, source: 'terminal' as const, running: false };
  it('one block is the 3.15.0 message; several become one message, each fenced with its status', () => {
    expect(blocksChatText([{ block: bad, command: 'tsc', output: 'error' }], 'explain')).toMatch(/^I ran this in my terminal \(exit 2\)\. Explain/);
    const text = blocksChatText([
      { block: ok, command: 'npm ci', output: 'added 3 packages' },
      { block: bad, command: 'npm test', output: '```\nFAIL' },
    ], 'explain');
    expect(text).toMatch(/^I ran these 2 commands in my terminal and something failed\. Explain/);
    expect(text).toContain('In `~/app` (exit 0):');
    expect(text).toContain('Command (exit 2):');
    // A fence one longer than the output's own.
    expect(text).toContain('````console\n$ npm test\n```\nFAIL\n````');
    expect(blocksChatText([{ block: ok, command: 'a', output: '' }, { block: ok, command: 'b', output: '' }], 'send')).toMatch(/^I ran these 2 commands in my terminal:/);
  });
});

describe('links, labels, stores', () => {
  it('builds verse://terminal links only for real ids', () => {
    expect(terminalBlockLink('t-abc123', 'b-7')).toBe('verse://terminal/t-abc123/b-7');
    expect(terminalBlockLink('t-abc123')).toBe('verse://terminal/t-abc123');
    expect(terminalBlockLink('../x', 'b-1')).toBeNull();
    expect(terminalBlockLink('t-a', 'b-x')).toBeNull();
  });

  it('labels', () => {
    expect(elapsedLabel(9_400)).toBe('9s');
    expect(elapsedLabel(134_000)).toBe('2m 14s');
    expect(elapsedLabel(3_780_000)).toBe('1h 03m');
    expect(urlLabel('http://localhost:5173/')).toBe('localhost:5173');
  });

  it('bookmarks toggle per tab and survive a reload; garbage is ignored', () => {
    const storage = memoryStorage();
    expect(toggleBookmark(storage, 't-1', 'b-2')).toEqual({ 't-1': ['b-2'] });
    expect(toggleBookmark(storage, 't-1', 'b-5')).toEqual({ 't-1': ['b-2', 'b-5'] });
    expect(loadBookmarks(storage)).toEqual({ 't-1': ['b-2', 'b-5'] });
    expect(toggleBookmark(storage, 't-1', 'b-2')).toEqual({ 't-1': ['b-5'] });
    storage.map.set('ashlr.verse.terminal.bookmarks.v1', '{"../x":["b-1"],"t-2":["nope","b-1"]}');
    expect(loadBookmarks(storage)).toEqual({ 't-2': ['b-1'] });
    storage.map.set('ashlr.verse.terminal.bookmarks.v1', 'not json');
    expect(loadBookmarks(storage)).toEqual({});
    expect(loadBookmarks(null)).toEqual({});
  });

  it('fix chips are on unless turned off', () => {
    const storage = memoryStorage();
    expect(loadFixChipsEnabled(storage)).toBe(true);
    saveFixChipsEnabled(storage, false);
    expect(loadFixChipsEnabled(storage)).toBe(false);
    saveFixChipsEnabled(storage, true);
    expect(loadFixChipsEnabled(storage)).toBe(true);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    expect(loadFixChipsEnabled(throwing)).toBe(true);
    expect(() => saveFixChipsEnabled(throwing, false)).not.toThrow();
  });
});

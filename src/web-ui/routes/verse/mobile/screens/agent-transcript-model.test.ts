import { describe, expect, it } from 'vitest';
import type { VerseLiveState } from '../../verse-store.js';
import {
  clipLines,
  diffLineKind,
  diffLines,
  diffSummary,
  liveStatusText,
  safeHttpsUrl,
  shortElapsed,
  shortPath,
  splitFences,
  systemLine,
  toolSummary,
  windowItems,
} from './agent-transcript-model.js';

const LIVE: VerseLiveState = { turnId: 't1', startedAt: 1_000, progress: null, thinking: null, notice: null, settledTurnId: null };

describe('toolSummary', () => {
  it('names the tool and its most telling argument', () => {
    expect(toolSummary('Bash', { command: 'npm   test\n --watch=false' })).toBe('Bash npm test --watch=false');
    expect(toolSummary('Edit', { file_path: '/Users/me/dev/hub/src/a/b.ts', old_string: 'x' })).toBe('Edit …/src/a/b.ts');
    expect(toolSummary('Read', { path: 'src/a.ts' })).toBe('Read src/a.ts');
    expect(toolSummary('Grep', { pattern: 'TODO' })).toBe('Grep TODO');
    expect(toolSummary('Task', null)).toBe('Task');
    expect(toolSummary('', 'raw input')).toBe('Tool raw input');
  });

  it('never throws on input JSON cannot serialize, and stays one short line', () => {
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(() => toolSummary('Weird', loop)).not.toThrow();
    expect(toolSummary('Bash', { command: 'x'.repeat(500) }).length).toBeLessThanOrEqual(85);
  });

  it('shortens only long paths', () => {
    expect(shortPath('a/b.ts')).toBe('a/b.ts');
    expect(shortPath('/a/b/c/d/e.ts')).toBe('…/c/d/e.ts');
  });
});

describe('splitFences', () => {
  it('splits prose and fenced code, keeping the language', () => {
    expect(splitFences('Here:\n```ts\nconst a = 1;\n```\nDone.')).toEqual([
      { kind: 'text', text: 'Here:' },
      { kind: 'code', text: 'const a = 1;', lang: 'ts' },
      { kind: 'text', text: 'Done.' },
    ]);
  });

  it('treats an unclosed fence (still streaming) as code to the end', () => {
    expect(splitFences('```\nnpm test')).toEqual([{ kind: 'code', text: 'npm test', lang: null }]);
  });

  it('plain text is one segment', () => {
    expect(splitFences('just words\nover lines')).toEqual([{ kind: 'text', text: 'just words\nover lines' }]);
  });
});

describe('clipping and windows', () => {
  it('clips output to 40 lines and counts the rest', () => {
    const text = Array.from({ length: 45 }, (_, i) => String(i)).join('\n');
    const out = clipLines(text);
    expect(out.hidden).toBe(5);
    expect(out.text.split('\n')).toHaveLength(40);
    expect(clipLines('a\nb')).toEqual({ text: 'a\nb', hidden: 0 });
  });

  it('keeps the newest items', () => {
    expect(windowItems([1, 2, 3, 4], 2)).toEqual({ items: [3, 4], hidden: 2 });
    expect(windowItems([1], 2)).toEqual({ items: [1], hidden: 0 });
  });
});

describe('the live line', () => {
  it('says what the turn is doing and for how long', () => {
    expect(liveStatusText(LIVE, 13_000)).toBe('Working · 12s');
    expect(liveStatusText({ ...LIVE, progress: { phase: 'tool', tool: 'Edit', elapsedMs: 180_000, outTokens: null, tokPerSec: null, receivedAt: 200_000 } }, 200_000)).toBe('Using Edit · 3m');
    expect(liveStatusText({ ...LIVE, thinking: { turnId: 't1', text: '', startedAt: 1, estimatedTokens: null } }, 2_000)).toBe('Thinking · 1s');
    expect(liveStatusText({ ...LIVE, startedAt: null }, 5)).toBe('Working');
    expect(liveStatusText({ ...LIVE, notice: { kind: 'retry', message: 'Retrying the API (2/5)', at: '', receivedAt: 0 } }, 1_000)).toBe('Retrying the API (2/5) · 0s');
  });

  it('formats spans short, unknown as null', () => {
    expect(shortElapsed(59_000)).toBe('59s');
    expect(shortElapsed(3_900_000)).toBe('1h 5m');
    expect(shortElapsed(null)).toBeNull();
    expect(shortElapsed(-1)).toBeNull();
  });
});

describe('system lines', () => {
  it('words errors, stops, turn ends and compaction', () => {
    expect(systemLine({ kind: 'error', key: 'e', turnId: 't', at: '', message: 'rate limited', code: null })).toEqual({ text: 'Error: rate limited', tone: 'danger' });
    expect(systemLine({ kind: 'cancelled', key: 'c', turnId: 't', at: '' })?.text).toBe('Stopped');
    expect(systemLine({ kind: 'turn-done', key: 'd', turnId: 't', at: '', ok: false, durationMs: 4_000 })?.text).toBe('Turn failed after 4s');
    expect(systemLine({ kind: 'compaction', key: 'k', turnId: null, at: '', trigger: 'auto', preTokens: null, postTokens: null, durationMs: null })?.text).toMatch(/compacted/);
    expect(systemLine({ kind: 'user', key: 'u', turnId: 't', at: '', text: 'hi' })).toBeNull();
  });

  it('links only https URLs', () => {
    expect(safeHttpsUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1');
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('http://example.com')).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
  });
});

describe('diffs', () => {
  it('classifies unified-diff lines by their first characters', () => {
    expect(diffLineKind('@@ -1 +1 @@')).toBe('hunk');
    expect(diffLineKind('+++ b/a.ts')).toBe('meta');
    expect(diffLineKind('--- a/a.ts')).toBe('meta');
    expect(diffLineKind('\\ No newline at end of file')).toBe('meta');
    expect(diffLineKind('+added')).toBe('add');
    expect(diffLineKind('-removed')).toBe('del');
    expect(diffLineKind(' same')).toBe('context');
    expect(diffLines('+a\n-b\n')).toEqual([{ kind: 'add', text: '+a' }, { kind: 'del', text: '-b' }]);
  });

  it('summarizes files and lines', () => {
    expect(diffSummary({ files: 4, additions: 120, deletions: 8 })).toBe('4 files · +120 −8');
    expect(diffSummary({ files: 1, additions: 0, deletions: 0 })).toBe('1 file · +0 −0');
  });
});

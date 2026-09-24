/**
 * 3.10 server performance (unit A3) — incremental Claude usage reader.
 *
 * readClaudeUsage keeps each transcript's parsed records plus the byte offset
 * they cover; a refresh parses only appended bytes. These tests pin the
 * invariant that matters: the incremental answer ALWAYS equals a from-scratch
 * scan — across appends, partial trailing lines, in-place rewrites,
 * truncation, replacement, multi-byte text across chunk boundaries, and the
 * async prime path.
 */

import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  expireClaudeUsageResultCache,
  invalidateClaudeUsageCache,
  primeClaudeUsage,
  readClaudeUsage,
  type ClaudeUsageResult,
} from '../src/core/fabric/claude-usage.js';

let root: string;
let prevDir: string | undefined;

function line(offsetMs: number, input: number, extra = ''): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() + offsetMs).toISOString(),
    message: { model: 'claude-x', content: extra, usage: { input_tokens: input, output_tokens: 1 } },
  });
}

function file(name = 'proj/s.jsonl'): string {
  const p = join(root, name);
  mkdirSync(join(p, '..'), { recursive: true });
  return p;
}

/** The incremental read, bypassing only the 30 s result cache. */
function incremental(): ClaudeUsageResult {
  expireClaudeUsageResultCache();
  return readClaudeUsage();
}

/** A from-scratch read (drops per-file state). */
function scratch(): ClaudeUsageResult {
  invalidateClaudeUsageCache();
  return readClaudeUsage();
}

function sums(r: ClaudeUsageResult): number[] {
  return [r.tokens5h, r.tokens7d, r.messages5h, r.messages7d, r.filesScanned];
}

/** Assert the incremental answer, then prove it equals a cold scan. */
function expectConsistent(expected: { messages7d: number; tokens7d: number }): void {
  const inc = incremental();
  expect(inc.messages7d).toBe(expected.messages7d);
  expect(inc.tokens7d).toBe(expected.tokens7d);
  const cold = scratch();
  expect(sums(inc)).toEqual(sums(cold));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ashlr-a3-claude-'));
  prevDir = process.env['CLAUDE_PROJECTS_DIR'];
  process.env['CLAUDE_PROJECTS_DIR'] = root;
  invalidateClaudeUsageCache();
});

afterEach(() => {
  if (prevDir === undefined) delete process.env['CLAUDE_PROJECTS_DIR'];
  else process.env['CLAUDE_PROJECTS_DIR'] = prevDir;
  invalidateClaudeUsageCache();
  rmSync(root, { recursive: true, force: true });
});

describe('incremental Claude usage reader', () => {
  it('counts appended lines exactly once', () => {
    const p = file();
    writeFileSync(p, line(-60_000, 10) + '\n');
    expect(readClaudeUsage().messages7d).toBe(1);
    appendFileSync(p, line(-30_000, 20) + '\n' + line(-10_000, 30) + '\n');
    expectConsistent({ messages7d: 3, tokens7d: 11 + 21 + 31 });
  });

  it('a trailing line without a newline is counted, then not double-counted once completed', () => {
    const p = file();
    const full = line(-5_000, 40);
    writeFileSync(p, line(-60_000, 10) + '\n' + full);
    expect(readClaudeUsage().messages7d).toBe(2);
    appendFileSync(p, '\n' + line(-1_000, 50) + '\n');
    expectConsistent({ messages7d: 3, tokens7d: 11 + 41 + 51 });
  });

  it('a half-written trailing line is ignored until it is complete', () => {
    const p = file();
    const next = line(-1_000, 70);
    writeFileSync(p, line(-60_000, 10) + '\n' + next.slice(0, 20));
    expect(readClaudeUsage().messages7d).toBe(1);
    appendFileSync(p, next.slice(20) + '\n');
    expectConsistent({ messages7d: 2, tokens7d: 11 + 71 });
  });

  it('an in-place rewrite that grows the file re-reads from the start', () => {
    const p = file();
    writeFileSync(p, line(-60_000, 10) + '\n');
    readClaudeUsage();
    // Same inode, different bytes before the old offset, and longer.
    writeFileSync(p, line(-50_000, 100) + '\n' + line(-40_000, 200) + '\n');
    expectConsistent({ messages7d: 2, tokens7d: 101 + 201 });
  });

  it('truncation re-reads from the start', () => {
    const p = file();
    writeFileSync(p, line(-60_000, 10) + '\n' + line(-50_000, 20) + '\n');
    readClaudeUsage();
    truncateSync(p, 0);
    writeFileSync(p, line(-1_000, 5) + '\n');
    expectConsistent({ messages7d: 1, tokens7d: 6 });
  });

  it('a replaced file (new inode) is re-read, and a deleted one is forgotten', () => {
    const p = file();
    const other = file('proj/other.jsonl');
    writeFileSync(p, line(-60_000, 10) + '\n');
    writeFileSync(other, line(-60_000, 1) + '\n');
    readClaudeUsage();
    const tmp = file('proj/tmp.x');
    writeFileSync(tmp, line(-2_000, 300) + '\n');
    renameSync(tmp, p);
    rmSync(other);
    expectConsistent({ messages7d: 1, tokens7d: 301 });
  });

  it('keeps multi-byte text intact across a 64 KiB chunk boundary', () => {
    const p = file();
    // Pad so an emoji straddles byte 65536.
    const probe = line(-60_000, 10, '');
    const padLen = 65_536 - (probe.length + 1) - 40;
    const text = 'x'.repeat(Math.max(0, padLen)) + '🙂'.repeat(40);
    writeFileSync(p, line(-60_000, 10, text) + '\n' + line(-50_000, 20, '🙂é漢') + '\n');
    expectConsistent({ messages7d: 2, tokens7d: 11 + 21 });
  });

  it('matches a cold scan across a random append sequence', () => {
    const p = file();
    const q = file('b/sub/nested.jsonl');
    writeFileSync(p, '');
    writeFileSync(q, '');
    let expected = 0;
    let tokens = 0;
    let seed = 7;
    const rnd = (): number => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    for (let round = 0; round < 25; round++) {
      const target = rnd() < 0.5 ? p : q;
      const n = 1 + Math.floor(rnd() * 3);
      let chunk = '';
      for (let i = 0; i < n; i++) {
        const t = 1 + Math.floor(rnd() * 100);
        chunk += line(-Math.floor(rnd() * 3_600_000), t) + '\n';
        expected += 1;
        tokens += t + 1;
      }
      appendFileSync(target, chunk);
      if (rnd() < 0.3) appendFileSync(target, JSON.stringify({ type: 'user', timestamp: new Date().toISOString() }) + '\n');
      const inc = incremental();
      expect(inc.messages7d).toBe(expected);
      expect(inc.tokens7d).toBe(tokens);
    }
    expect(sums(incremental())).toEqual(sums(scratch()));
  });

  it('respects the 7-day and 5-hour windows on cached records', () => {
    const p = file();
    writeFileSync(p, line(-6 * 3_600_000, 1000) + '\n' + line(-60_000, 10) + '\n' + line(-8 * 86_400_000, 5) + '\n');
    const r = incremental();
    expect(r.messages7d).toBe(2);
    expect(r.messages5h).toBe(1);
    expect(r.tokens5h).toBe(11);
  });

  it('primeClaudeUsage builds the same state asynchronously', async () => {
    const p = file();
    const q = file('b/other.jsonl');
    writeFileSync(p, line(-60_000, 10) + '\n' + line(-30_000, 20) + '\n');
    writeFileSync(q, line(-10_000, 30));
    const cold = sums(scratch());
    invalidateClaudeUsageCache();
    await primeClaudeUsage();
    expect(sums(incremental())).toEqual(cold);
    appendFileSync(q, '\n' + line(-1_000, 40) + '\n');
    expect(incremental().messages7d).toBe(4);
    expect(sums(incremental())).toEqual(sums(scratch()));
  });
});

/**
 * M64: collectCodexEvents + readCodexRateLimits — unit tests.
 *
 * Fixture strategy: set process.env.HOME to a tmp dir BEFORE importing the
 * module under test so os.homedir() (called at call-time, not module load)
 * returns the tmp path. Real ~/.codex is NEVER touched.
 *
 * Mirror pattern from m5.usage-source.test.ts.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire, syncBuiltinESMExports } from 'node:module';

// ---------------------------------------------------------------------------
// HOME redirect — synchronous, at module evaluation time
// ---------------------------------------------------------------------------

const tmpHome  = fs.mkdtempSync(path.join(os.tmpdir(), 'm64-codex-'));
const origHome = process.env['HOME'] ?? '';
process.env['HOME'] = tmpHome;

afterAll(() => {
  process.env['HOME'] = origHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Module under test — imported AFTER HOME is redirected
// ---------------------------------------------------------------------------

import {
  CODEX_TRANSCRIPT_HEAD_BYTES,
  CODEX_TRANSCRIPT_DISCOVERY_MAX_FILES,
  CODEX_TRANSCRIPT_MAX_FILES,
  CODEX_TRANSCRIPT_MAX_TOTAL_BYTES,
  CODEX_TRANSCRIPT_TAIL_BYTES,
  collectCodexEvents,
  readCodexRateLimits,
} from '../src/core/observability/codex-source.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionsDir(): string {
  return path.join(tmpHome, '.codex', 'sessions', '2026', '06', '17');
}

function clearSessions(): void {
  try { fs.rmSync(path.join(tmpHome, '.codex'), { recursive: true, force: true }); } catch { /* ignore */ }
}

interface FixtureOpts {
  filename?: string;
  cwd?: string;
  sessionTs?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  rateLimits?: {
    primary?:   { used_percent: number; window_minutes: number; resets_at: number } | null;
    secondary?: { used_percent: number; window_minutes: number; resets_at: number } | null;
    plan_type?: string;
  };
  extraLines?: string[];
}

function writeSessionFixture(opts: FixtureOpts = {}): string {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });

  const filename = opts.filename ?? 'rollout-fixture.jsonl';
  const filePath = path.join(dir, filename);
  const sessionTs = opts.sessionTs ?? '2026-06-17T10:00:00.000Z';
  const totalIn  = opts.totalInputTokens  ?? 625450;
  const totalOut = opts.totalOutputTokens ?? 4402;

  const rl = opts.rateLimits ?? {
    primary:   { used_percent: 13, window_minutes: 300,   resets_at: 1780970829 },
    secondary: { used_percent: 9,  window_minutes: 10080, resets_at: 1781317298 },
    plan_type: 'prolite',
  };

  const lines = [
    JSON.stringify({
      timestamp: sessionTs,
      type: 'session_meta',
      payload: {
        id: 'test-id',
        cwd: opts.cwd ?? '/Users/test/projects/my-app',
        model_provider: 'openai',
        cli_version: '0.136.0',
        timestamp: sessionTs,
      },
    }),
    JSON.stringify({
      timestamp: sessionTs,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: totalIn,
            cached_input_tokens: 0,
            output_tokens: totalOut,
            reasoning_output_tokens: 0,
            total_tokens: totalIn + totalOut,
          },
          last_token_usage: { input_tokens: 88454, output_tokens: 744 },
          model_context_window: 258400,
        },
        rate_limits: {
          limit_id: 'codex',
          limit_name: null,
          primary:   rl.primary   ?? null,
          secondary: rl.secondary ?? null,
          credits: null,
          plan_type: rl.plan_type ?? 'prolite',
          rate_limit_reached_type: null,
        },
      },
    }),
    ...(opts.extraLines ?? []),
  ];

  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

function tokenCountLine(
  inputTokens: number,
  outputTokens: number,
  usedPercent: number,
  paddingBytes = 0,
): string {
  return JSON.stringify({
    timestamp: '2026-06-17T10:30:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
        padding: 'x'.repeat(paddingBytes),
      },
      rate_limits: {
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1780970829 },
        plan_type: 'pro',
      },
    },
  }) + '\n';
}

function withMeasuredReads<T>(fn: () => T): { value: T; bytesRead: number } {
  const cjsFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const originalReadSync = cjsFs.readSync;
  let bytesRead = 0;
  cjsFs.readSync = ((
    readFd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    const count = originalReadSync(readFd, buffer, offset, length, position);
    bytesRead += count;
    return count;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();

  try {
    return { value: fn(), bytesRead };
  } finally {
    cjsFs.readSync = originalReadSync;
    syncBuiltinESMExports();
  }
}

function withMeasuredTranscriptStats<T>(fn: () => T): { value: T; transcriptStats: number } {
  const cjsFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const originalStatSync = cjsFs.statSync;
  let transcriptStats = 0;
  cjsFs.statSync = ((target: fs.PathLike, options?: unknown) => {
    if (String(target).endsWith('.jsonl')) transcriptStats += 1;
    return originalStatSync(target, options as never);
  }) as typeof fs.statSync;
  syncBuiltinESMExports();

  try {
    return { value: fn(), transcriptStats };
  } finally {
    cjsFs.statSync = originalStatSync;
    syncBuiltinESMExports();
  }
}

function writeSparseSession(filename: string, inputTokens: number, mtimeMs: number): void {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const fileSize = 8 * 1024 * 1024;
  const fd = fs.openSync(filePath, 'w');

  try {
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { cwd: `/work/${filename}`, timestamp: '2026-06-17T10:00:00.000Z' },
    }) + '\n';
    fs.writeSync(fd, meta, 0, 'utf8');
    fs.ftruncateSync(fd, fileSize);
    const tailStart = fileSize - CODEX_TRANSCRIPT_TAIL_BYTES;
    fs.writeSync(fd, '\n', tailStart + 8, 'utf8');
    fs.writeSync(fd, tokenCountLine(inputTokens, 1, inputTokens), tailStart + 9, 'utf8');
  } finally {
    fs.closeSync(fd);
  }

  fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
}

// ---------------------------------------------------------------------------
// collectCodexEvents — token extraction
// ---------------------------------------------------------------------------

describe('M64 collectCodexEvents — token extraction', () => {
  it('returns correct tokensIn and tokensOut', () => {
    clearSessions();
    writeSessionFixture({ totalInputTokens: 625450, totalOutputTokens: 4402 });
    const events = collectCodexEvents(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.tokensIn).toBe(625450);
    expect(events[0]!.tokensOut).toBe(4402);
  });

  it('sets model to "codex"', () => {
    clearSessions();
    writeSessionFixture();
    expect(collectCodexEvents(0)[0]!.model).toBe('codex');
  });

  it('sets project to cwd basename', () => {
    clearSessions();
    writeSessionFixture({ cwd: '/Users/test/projects/my-app' });
    expect(collectCodexEvents(0)[0]!.project).toBe('my-app');
  });

  it('sets source to "run"', () => {
    clearSessions();
    writeSessionFixture();
    expect(collectCodexEvents(0)[0]!.source).toBe('run');
  });

  it('sets ts from session_meta timestamp', () => {
    clearSessions();
    writeSessionFixture({ sessionTs: '2026-06-17T10:00:00.000Z' });
    expect(collectCodexEvents(0)[0]!.ts).toBe('2026-06-17T10:00:00.000Z');
  });

  it('cacheRead and cacheWrite are 0', () => {
    clearSessions();
    writeSessionFixture();
    const ev = collectCodexEvents(0)[0]!;
    expect(ev.cacheRead).toBe(0);
    expect(ev.cacheWrite).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// collectCodexEvents — multiple sessions, no double-counting
// ---------------------------------------------------------------------------

describe('M64 collectCodexEvents — multiple sessions', () => {
  it('one event per session file', () => {
    clearSessions();
    writeSessionFixture({ filename: 'a.jsonl', totalInputTokens: 1000, totalOutputTokens: 100 });
    writeSessionFixture({ filename: 'b.jsonl', totalInputTokens: 2000, totalOutputTokens: 200 });
    const events = collectCodexEvents(0);
    expect(events).toHaveLength(2);
    expect(events.reduce((s, e) => s + e.tokensIn,  0)).toBe(3000);
    expect(events.reduce((s, e) => s + e.tokensOut, 0)).toBe(300);
  });

  it('uses total_token_usage not per-turn last_token_usage', () => {
    clearSessions();
    // last_token_usage in fixture is 88454/744; total is 500000/3000
    writeSessionFixture({ totalInputTokens: 500000, totalOutputTokens: 3000 });
    const ev = collectCodexEvents(0)[0]!;
    expect(ev.tokensIn).toBe(500000);
    expect(ev.tokensOut).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// collectCodexEvents — sinceMs filtering
// ---------------------------------------------------------------------------

describe('M64 collectCodexEvents — sinceMs filtering', () => {
  it('skips files with mtime older than sinceMs', () => {
    clearSessions();
    const fp = writeSessionFixture({ sessionTs: '2026-06-17T10:00:00.000Z' });
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(fp, new Date(twoDaysAgo), new Date(twoDaysAgo));
    expect(collectCodexEvents(Date.now() - 24 * 60 * 60 * 1000)).toHaveLength(0);
  });

  it('includes files within window', () => {
    clearSessions();
    writeSessionFixture({ sessionTs: new Date().toISOString() });
    expect(collectCodexEvents(Date.now() - 24 * 60 * 60 * 1000)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// collectCodexEvents — missing ~/.codex
// ---------------------------------------------------------------------------

describe('M64 collectCodexEvents — missing ~/.codex', () => {
  it('returns [] when directory does not exist', () => {
    clearSessions();
    expect(collectCodexEvents(0)).toHaveLength(0);
  });

  it('never throws', () => {
    clearSessions();
    expect(() => collectCodexEvents(0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// collectCodexEvents — malformed line tolerance
// ---------------------------------------------------------------------------

describe('M64 collectCodexEvents — malformed lines', () => {
  it('does not throw on malformed JSON', () => {
    clearSessions();
    writeSessionFixture({ extraLines: ['not valid json {{{{', '{"type":"garbage"}'] });
    expect(() => collectCodexEvents(0)).not.toThrow();
  });

  it('still returns the valid event when malformed lines are present', () => {
    clearSessions();
    writeSessionFixture({ totalInputTokens: 100, totalOutputTokens: 50, extraLines: ['bad json', '{"broken":true'] });
    const events = collectCodexEvents(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.tokensIn).toBe(100);
  });

  it('returns [] for session with no token_count lines', () => {
    clearSessions();
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'no-tokens.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/x', timestamp: '2026-06-17T10:00:00.000Z' } }) + '\n'
    );
    expect(collectCodexEvents(0)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bounded head/tail transcript reads
// ---------------------------------------------------------------------------

describe('M64 Codex transcript read bounds', () => {
  it('bounds byte work and selects the final token_count across read chunks', () => {
    clearSessions();
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'large-sparse.jsonl');
    const fileSize = 64 * 1024 * 1024;
    const tailStart = fileSize - CODEX_TRANSCRIPT_TAIL_BYTES;
    const fd = fs.openSync(filePath, 'w');

    try {
      const meta = JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/work/bounded-reader', timestamp: '2026-06-17T10:00:00.000Z' },
      }) + '\n';
      fs.writeSync(fd, meta, 0, 'utf8');
      fs.ftruncateSync(fd, fileSize);

      // Establish a complete row boundary inside the tail, then an older total.
      fs.writeSync(fd, '\n', tailStart + 8, 'utf8');
      const older = tokenCountLine(111, 11, 12);
      const olderStart = tailStart + 9;
      fs.writeSync(fd, older, olderStart, 'utf8');

      // The final token row starts just before a 64 KiB read boundary and is
      // itself larger than a chunk. A large non-token row follows it.
      const finalStart = tailStart + (4 * 64 * 1024) - 32;
      const gapLength = finalStart - (olderStart + Buffer.byteLength(older)) - 1;
      fs.writeSync(fd, `${'g'.repeat(gapLength)}\n`, olderStart + Buffer.byteLength(older), 'utf8');
      const final = tokenCountLine(987654, 4321, 73, 96 * 1024);
      fs.writeSync(fd, final, finalStart, 'utf8');
      const after = JSON.stringify({ type: 'response_item', payload: { data: 'z'.repeat(512 * 1024) } }) + '\n';
      fs.writeSync(fd, after, finalStart + Buffer.byteLength(final), 'utf8');
    } finally {
      fs.closeSync(fd);
    }

    const { value: events, bytesRead } = withMeasuredReads(() => collectCodexEvents(0));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      project: 'bounded-reader',
      ts: '2026-06-17T10:00:00.000Z',
      tokensIn: 987654,
      tokensOut: 4321,
    });
    expect(bytesRead).toBeLessThanOrEqual(CODEX_TRANSCRIPT_HEAD_BYTES + CODEX_TRANSCRIPT_TAIL_BYTES + 1);
    expect(bytesRead).toBeLessThan(fileSize / 16);
    expect(readCodexRateLimits()?.primary?.usedPercent).toBe(73);
  });

  it('keeps a complete token row that starts exactly at the tail boundary', () => {
    clearSessions();
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'tail-boundary.jsonl');
    const fileSize = CODEX_TRANSCRIPT_TAIL_BYTES + 1024;
    const tailStart = fileSize - CODEX_TRANSCRIPT_TAIL_BYTES;
    const fd = fs.openSync(filePath, 'w');

    try {
      const meta = JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/work/tail-boundary', timestamp: '2026-06-17T10:00:00.000Z' },
      }) + '\n';
      fs.writeSync(fd, meta, 0, 'utf8');
      fs.ftruncateSync(fd, fileSize);
      fs.writeSync(fd, '\n', tailStart - 1, 'utf8');
      fs.writeSync(fd, tokenCountLine(321, 12, 42), tailStart, 'utf8');
    } finally {
      fs.closeSync(fd);
    }

    expect(collectCodexEvents(0)[0]).toMatchObject({
      project: 'tail-boundary',
      tokensIn: 321,
      tokensOut: 12,
    });
    expect(readCodexRateLimits()?.primary?.usedPercent).toBe(42);
  });

  it('fails closed when token evidence is outside both bounded windows', () => {
    clearSessions();
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'outside-bounds.jsonl');
    const fd = fs.openSync(filePath, 'w');

    try {
      const meta = JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/work/outside', timestamp: '2026-06-17T10:00:00.000Z' },
      }) + '\n';
      fs.writeSync(fd, meta, 0, 'utf8');
      fs.writeSync(fd, tokenCountLine(999, 99, 50), CODEX_TRANSCRIPT_HEAD_BYTES + 1024, 'utf8');
      fs.ftruncateSync(fd, CODEX_TRANSCRIPT_HEAD_BYTES + CODEX_TRANSCRIPT_TAIL_BYTES + (4 * 1024 * 1024));
    } finally {
      fs.closeSync(fd);
    }

    expect(collectCodexEvents(0)).toEqual([]);
    expect(readCodexRateLimits()).toBeNull();
  });

  it('takes only the newest sessions when the corpus file cap is reached', () => {
    clearSessions();
    const baseMtime = Date.now() - 60_000;
    const totalFiles = CODEX_TRANSCRIPT_MAX_FILES + 2;

    for (let i = 0; i < totalFiles; i += 1) {
      const filePath = writeSessionFixture({
        filename: `session-${String(i).padStart(3, '0')}.jsonl`,
        totalInputTokens: 1000 + i,
        totalOutputTokens: 1,
      });
      fs.utimesSync(filePath, new Date(baseMtime + i), new Date(baseMtime + i));
    }

    const events = collectCodexEvents(0);
    expect(events).toHaveLength(CODEX_TRANSCRIPT_MAX_FILES);
    expect(events.map((event) => event.tokensIn)).toEqual(
      Array.from({ length: CODEX_TRANSCRIPT_MAX_FILES }, (_, i) => 1000 + totalFiles - 1 - i),
    );
  });

  it('bounds transcript metadata inspection before content sampling', () => {
    clearSessions();
    const totalFiles = CODEX_TRANSCRIPT_DISCOVERY_MAX_FILES + 12;
    for (let i = 0; i < totalFiles; i += 1) {
      const filePath = writeSessionFixture({ filename: `discovery-${String(i).padStart(3, '0')}.jsonl` });
      fs.utimesSync(filePath, new Date(0), new Date(0));
    }

    const { value: events, transcriptStats } = withMeasuredTranscriptStats(
      () => collectCodexEvents(Date.now() - 86_400_000),
    );
    expect(events).toEqual([]);
    expect(transcriptStats).toBeLessThanOrEqual(CODEX_TRANSCRIPT_DISCOVERY_MAX_FILES);
  });

  it('takes only the newest sessions that fit the aggregate byte budget', () => {
    clearSessions();
    const perFileCost = CODEX_TRANSCRIPT_HEAD_BYTES + CODEX_TRANSCRIPT_TAIL_BYTES;
    const filesWithinBudget = Math.floor(CODEX_TRANSCRIPT_MAX_TOTAL_BYTES / perFileCost);
    const totalFiles = filesWithinBudget + 2;
    const baseMtime = Date.now() - 60_000;

    for (let i = 0; i < totalFiles; i += 1) {
      writeSparseSession(`budget-${String(i).padStart(3, '0')}.jsonl`, 2000 + i, baseMtime + i);
    }

    const { value: events, bytesRead } = withMeasuredReads(() => collectCodexEvents(0));
    expect(events).toHaveLength(filesWithinBudget);
    expect(events.map((event) => event.tokensIn)).toEqual(
      Array.from({ length: filesWithinBudget }, (_, i) => 2000 + totalFiles - 1 - i),
    );
    expect(bytesRead).toBeLessThanOrEqual(CODEX_TRANSCRIPT_MAX_TOTAL_BYTES);
  });
});

// ---------------------------------------------------------------------------
// readCodexRateLimits — correctness
// ---------------------------------------------------------------------------

describe('M64 readCodexRateLimits — correctness', () => {
  it('returns primary usedPercent, windowMinutes, resetsAt', () => {
    clearSessions();
    writeSessionFixture({
      rateLimits: {
        primary:   { used_percent: 13, window_minutes: 300,   resets_at: 1780970829 },
        secondary: { used_percent: 9,  window_minutes: 10080, resets_at: 1781317298 },
        plan_type: 'prolite',
      },
    });
    const rl = readCodexRateLimits();
    expect(rl).not.toBeNull();
    expect(rl!.primary!.usedPercent).toBe(13);
    expect(rl!.primary!.windowMinutes).toBe(300);
    expect(rl!.primary!.resetsAt).toBe(1780970829);
  });

  it('returns secondary usedPercent, windowMinutes', () => {
    clearSessions();
    writeSessionFixture();
    const rl = readCodexRateLimits();
    expect(rl!.secondary!.usedPercent).toBe(9);
    expect(rl!.secondary!.windowMinutes).toBe(10080);
  });

  it('returns planType', () => {
    clearSessions();
    writeSessionFixture({ rateLimits: { primary: { used_percent: 5, window_minutes: 300, resets_at: 9999 }, plan_type: 'pro' } });
    expect(readCodexRateLimits()!.planType).toBe('pro');
  });

  it('picks most recently modified file', () => {
    clearSessions();
    const older = writeSessionFixture({
      filename: 'old.jsonl',
      rateLimits: { primary: { used_percent: 50, window_minutes: 300, resets_at: 111 }, plan_type: 'basic' },
    });
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fs.utimesSync(older, new Date(twoDaysAgo), new Date(twoDaysAgo));
    writeSessionFixture({
      filename: 'new.jsonl',
      rateLimits: { primary: { used_percent: 13, window_minutes: 300, resets_at: 1780970829 }, plan_type: 'prolite' },
    });
    const rl = readCodexRateLimits();
    expect(rl!.primary!.usedPercent).toBe(13);
    expect(rl!.planType).toBe('prolite');
  });
});

// ---------------------------------------------------------------------------
// readCodexRateLimits — missing / malformed
// ---------------------------------------------------------------------------

describe('M64 readCodexRateLimits — missing ~/.codex', () => {
  it('returns null when directory does not exist', () => {
    clearSessions();
    expect(readCodexRateLimits()).toBeNull();
  });

  it('never throws when directory missing', () => {
    clearSessions();
    expect(() => readCodexRateLimits()).not.toThrow();
  });

  it('returns null for session with no token_count lines', () => {
    clearSessions();
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'no-tokens.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/x', timestamp: '2026-06-17T10:00:00.000Z' } }) + '\n'
    );
    expect(readCodexRateLimits()).toBeNull();
  });

  it('tolerates malformed lines without throwing', () => {
    clearSessions();
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.jsonl'), 'not json\n{broken\n');
    expect(() => readCodexRateLimits()).not.toThrow();
    expect(readCodexRateLimits()).toBeNull();
  });
});

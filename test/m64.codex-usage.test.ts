/**
 * M64: collectCodexEvents + readCodexRateLimits — unit tests.
 *
 * Fixture strategy: set process.env.HOME to a tmp dir BEFORE importing the
 * module under test so os.homedir() (called at call-time, not module load)
 * returns the tmp path. Real ~/.codex is NEVER touched.
 *
 * Mirror pattern from m5.usage-source.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

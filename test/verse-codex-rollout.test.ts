/**
 * test/verse-codex-rollout.test.ts — the codex rollout reader
 * (src/core/verse/codex-rollout.ts): bounded reads, record classification,
 * locating a seat's thread file, and the per-turn accounting that makes the
 * codex meter exact and its usage per-turn.
 *
 * Every fixture lives in a private tmp dir; HOME is already relocated by
 * test/setup/home.ts and this module never consults it anyway (it only reads
 * paths derived from a launcher argv).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CODEX_ROLLOUT_LINE_HEAD_BYTES,
  CODEX_ROLLOUT_TAIL_BYTES,
  advanceCodexTurnTracker,
  codexNativeStatePath,
  codexOccupancy,
  codexTotals,
  codexTurnUsage,
  createCodexTurnTracker,
  isCodexThreadId,
  locateCodexRollout,
  readCodexRolloutFrom,
  readCodexRolloutTail,
  resetCodexRolloutCaches,
  summarizeCodexRollout,
  uuidV7Millis,
  type CodexTokenTotals,
} from '../src/core/verse/codex-rollout.js';

// ---------------------------------------------------------------------------
// Fixture builders — shapes copied from real codex 0.136–0.155 rollouts
// ---------------------------------------------------------------------------

const BASE = Date.parse('2026-09-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

interface Usage { input: number; cached?: number; output: number; reasoning?: number }

function usageBlock(u: Usage): Record<string, number> {
  return {
    input_tokens: u.input,
    cached_input_tokens: u.cached ?? 0,
    output_tokens: u.output,
    reasoning_output_tokens: u.reasoning ?? 0,
    total_tokens: u.input + u.output,
  };
}

function line(at: number, type: string, payload: unknown): string {
  return `${JSON.stringify({ timestamp: iso(at), type, payload })}\n`;
}

function tokenCount(at: number, total: Usage, last: Usage, window = 258_400): string {
  return line(at, 'event_msg', {
    type: 'token_count',
    info: { total_token_usage: usageBlock(total), last_token_usage: usageBlock(last), model_context_window: window },
    rate_limits: { primary: { used_percent: 12.5, window_minutes: 10080 } },
  });
}

function taskStarted(at: number, window = 258_400): string {
  return line(at, 'event_msg', { type: 'task_started', turn_id: 't', model_context_window: window });
}

function compacted(at: number, historyBytes = 200): string {
  // A real `compacted` line embeds the replacement history — megabytes of it.
  return line(at, 'compacted', { message: '', replacement_history: [{ type: 'message', text: 'h'.repeat(historyBytes) }], window_number: 2 });
}

function usageRecord(at: number, threadId: string, turn: Usage): string {
  return line(at, 'token_usage_record', { thread_id: threadId, turn_id: 'x', usage: usageBlock(turn), turn_token_usage: usageBlock(turn), thread_token_usage: usageBlock(turn) });
}

/** A UUIDv7 whose embedded instant is `ms` — how codex mints thread ids. */
function threadIdAt(ms: number, tail = '8def-0123456789ab'): string {
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-${tail}`;
}

function localDay(ms: number): string[] {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())];
}

let work: string;
let nativeState: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'verse-codex-rollout-'));
  nativeState = join(work, 'profile', 'native-state');
  mkdirSync(nativeState, { recursive: true, mode: 0o700 });
  resetCodexRolloutCaches();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  resetCodexRolloutCaches();
});

function rolloutPath(threadId: string, createdMs = uuidV7Millis(threadId) ?? BASE): string {
  const dir = join(nativeState, 'sessions', ...localDay(createdMs));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `rollout-2026-09-23T08-00-00-${threadId}.jsonl`);
}

// ---------------------------------------------------------------------------

describe('record parsing', () => {
  it('reads a codex usage block, counting input INCLUDING cache and falling back for total', () => {
    expect(codexTotals({ input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 3, total_tokens: 107 }))
      .toEqual({ inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 5, outputTokens: 7, reasoningOutputTokens: 3, totalTokens: 107 });
    // exec's turn.completed usage has no total_tokens.
    expect(codexTotals({ input_tokens: 10, output_tokens: 2 })?.totalTokens).toBe(12);
    expect(codexTotals({ foo: 1 })).toBeNull();
    expect(codexTotals(null)).toBeNull();
    expect(codexTotals({ input_tokens: -5, output_tokens: Number.NaN, total_tokens: 3 })).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 3 });
  });

  it('measures occupancy as the last call prompt + reply (what codex compacts against)', () => {
    expect(codexOccupancy(codexTotals({ input_tokens: 49_333, output_tokens: 233, total_tokens: 49_566 })!)).toBe(49_566);
    expect(codexOccupancy(codexTotals({ input_tokens: 10, output_tokens: 5 })!)).toBe(15);
  });

  it('classifies token_count, task_started, compacted and token_usage_record; drops everything else', () => {
    const tid = threadIdAt(BASE);
    const file = rolloutPath(tid);
    writeFileSync(file, [
      line(BASE, 'session_meta', { id: tid }),
      taskStarted(BASE + 1),
      line(BASE + 2, 'response_item', { type: 'message', role: 'user' }),
      // Rate-limit-only refresh: info null carries no reading.
      line(BASE + 3, 'event_msg', { type: 'token_count', info: null, rate_limits: {} }),
      tokenCount(BASE + 4, { input: 1000, output: 10 }, { input: 1000, output: 10 }),
      'not json at all\n',
      '{"timestamp":"garbage","type":"compacted","payload":{}}\n',
      usageRecord(BASE + 5, tid, { input: 1000, output: 10 }),
      '\n',
    ].join(''));
    const read = readCodexRolloutTail(file)!;
    expect(read.records.map((r) => r.kind)).toEqual(['task-started', 'token-count', 'compacted', 'token-usage-record']);
    expect(read.records[1]).toMatchObject({ kind: 'token-count', at: BASE + 4, modelContextWindow: 258_400, last: { totalTokens: 1010 } });
    // An unparsable timestamp is unknown, never "epoch 0".
    expect(read.records[2]).toMatchObject({ kind: 'compacted', at: null });
    expect(read.end).toBe(read.size);
  });
});

describe('bounded reads', () => {
  it('reads only the tail window and drops the line the window cuts', () => {
    const file = rolloutPath(threadIdAt(BASE));
    const filler = line(BASE, 'response_item', { type: 'function_call_output', output: 'y'.repeat(4096) });
    const early = tokenCount(BASE + 1, { input: 1, output: 1 }, { input: 1, output: 1 });
    let body = early;
    while (body.length < CODEX_ROLLOUT_TAIL_BYTES + 256 * 1024) body += filler;
    body += tokenCount(BASE + 2, { input: 500, output: 5 }, { input: 499, output: 4 });
    writeFileSync(file, body);
    const read = readCodexRolloutTail(file)!;
    expect(read.start).toBe(read.size - CODEX_ROLLOUT_TAIL_BYTES);
    // The early record is outside the window; the one at EOF is in it.
    expect(read.records).toHaveLength(1);
    expect(read.records[0]).toMatchObject({ kind: 'token-count', at: BASE + 2 });
  });

  it('classifies an oversized compacted line from its head without holding the line', () => {
    const file = rolloutPath(threadIdAt(BASE));
    const bigHistory = 3 * CODEX_ROLLOUT_LINE_HEAD_BYTES;
    writeFileSync(file, taskStarted(BASE) + compacted(BASE + 1, bigHistory) + tokenCount(BASE + 2, { input: 9, output: 1 }, { input: 9, output: 1 }));
    const read = readCodexRolloutFrom(file, 0)!;
    expect(read.records.map((r) => r.kind)).toEqual(['task-started', 'compacted', 'token-count']);
    expect(read.records[1]!.at).toBe(BASE + 1);
  });

  it('does not treat a nested "type":"compacted" inside a payload as a compaction', () => {
    const file = rolloutPath(threadIdAt(BASE));
    const decoy = line(BASE, 'response_item', { type: 'message', note: '"type":"compacted"', pad: 'z'.repeat(2 * CODEX_ROLLOUT_LINE_HEAD_BYTES) });
    writeFileSync(file, decoy);
    expect(readCodexRolloutFrom(file, 0)!.records).toEqual([]);
  });

  it('leaves a partial trailing line unconsumed until it is completed', () => {
    const file = rolloutPath(threadIdAt(BASE));
    const whole = tokenCount(BASE, { input: 100, output: 1 }, { input: 100, output: 1 });
    writeFileSync(file, whole + whole.slice(0, 40));
    const first = readCodexRolloutFrom(file, 0)!;
    expect(first.records).toHaveLength(1);
    expect(first.end).toBe(whole.length);
    appendFileSync(file, whole.slice(40));
    const second = readCodexRolloutFrom(file, first.end)!;
    expect(second.records).toHaveLength(1);
    expect(second.end).toBe(2 * whole.length);
  });

  it('returns null, never throws, for missing, pruned, symlinked or out-of-range files', () => {
    const file = rolloutPath(threadIdAt(BASE));
    expect(readCodexRolloutTail(file)).toBeNull();
    expect(summarizeCodexRollout(file)).toBeNull();
    writeFileSync(file, tokenCount(BASE, { input: 1, output: 1 }, { input: 1, output: 1 }));
    expect(readCodexRolloutFrom(file, 10_000_000)).toBeNull();
    expect(readCodexRolloutFrom(file, -1)).toBeNull();
    const link = join(work, 'link.jsonl');
    symlinkSync(file, link);
    expect(readCodexRolloutTail(link)).toBeNull();
    expect(readCodexRolloutTail(join(work))).toBeNull();
  });
});

describe('summarizeCodexRollout', () => {
  it('extracts the last token_count, the task_started window and compactions after an offset', () => {
    const file = rolloutPath(threadIdAt(BASE));
    const head = taskStarted(BASE, 828_400) + tokenCount(BASE + 1, { input: 100, output: 5 }, { input: 100, output: 5 }, 828_400) + compacted(BASE + 2);
    writeFileSync(file, head + compacted(BASE + 3) + tokenCount(BASE + 4, { input: 100, output: 5 }, { input: 40_000, output: 100 }, 828_400));
    const all = summarizeCodexRollout(file)!;
    expect(all.lastTokenCount).toMatchObject({ lastTotalTokens: 40_100, lastInputTokens: 40_000, modelContextWindow: 828_400 });
    expect(all.taskStartedWindow).toBe(828_400);
    expect(all.compactions).toBe(2);
    expect(summarizeCodexRollout(file, { afterOffset: head.length })!.compactions).toBe(1);
  });
});

describe('locating a thread rollout', () => {
  it('finds the file in the local day the UUIDv7 id was minted, without a tree scan', () => {
    const tid = threadIdAt(BASE);
    const file = rolloutPath(tid);
    writeFileSync(file, '');
    expect(locateCodexRollout(nativeState, tid, { fullScan: false })).toBe(file);
  });

  it('falls back to a bounded newest-first scan when the id date does not hold it', () => {
    const tid = threadIdAt(BASE);
    const elsewhere = join(nativeState, 'sessions', '2025', '01', '07');
    mkdirSync(elsewhere, { recursive: true });
    const file = join(elsewhere, `rollout-2025-01-07T00-00-00-${tid}.jsonl`);
    writeFileSync(file, '');
    expect(locateCodexRollout(nativeState, tid, { fullScan: false })).toBeNull();
    expect(locateCodexRollout(nativeState, tid)).toBe(file);
  });

  it('prefers the most recently written of duplicate matches and ignores symlinks', () => {
    const tid = threadIdAt(BASE);
    const older = rolloutPath(tid);
    const newer = join(older, '..', `rollout-2026-09-23T09-00-00-${tid}.jsonl`);
    writeFileSync(older, 'a');
    writeFileSync(newer, 'b');
    utimesSync(older, new Date(BASE), new Date(BASE));
    utimesSync(newer, new Date(BASE + 60_000), new Date(BASE + 60_000));
    symlinkSync(older, join(older, '..', `rollout-2026-09-23T10-00-00-${tid}.jsonl`));
    expect(locateCodexRollout(nativeState, tid)).toBe(join(nativeState, 'sessions', ...localDay(BASE), `rollout-2026-09-23T09-00-00-${tid}.jsonl`));
  });

  it('forgets a cached path once the file is pruned', () => {
    const tid = threadIdAt(BASE);
    const file = rolloutPath(tid);
    writeFileSync(file, '');
    expect(locateCodexRollout(nativeState, tid)).toBe(file);
    rmSync(file);
    expect(locateCodexRollout(nativeState, tid)).toBeNull();
  });

  it('refuses ids and roots that are not what codex writes', () => {
    expect(isCodexThreadId('../../etc/passwd')).toBe(false);
    expect(isCodexThreadId('thr_fake_1')).toBe(false);
    expect(locateCodexRollout(nativeState, '../x')).toBeNull();
    expect(locateCodexRollout('relative/native-state', threadIdAt(BASE))).toBeNull();
    expect(uuidV7Millis('01a0cc62-574f-7a32-833c-be53ec204a1d')).toBe(Date.parse('2026-09-23T03:49:52.079Z'));
    // A v4 id carries no instant.
    expect(uuidV7Millis('01a0cc62-574f-4a32-833c-be53ec204a1d')).toBeNull();
  });
});

describe('codexNativeStatePath', () => {
  it('reads the pinned CODEX_HOME from the launcher profile manifest', () => {
    const profile = join(work, 'codex-b');
    mkdirSync(profile, { mode: 0o700 });
    const pinned = join(work, 'elsewhere', 'native-state');
    writeFileSync(join(profile, 'profile.json'), JSON.stringify({ provider: 'codex', nativeStatePath: pinned }));
    expect(codexNativeStatePath([process.execPath, join(profile, 'launcher.mjs')])).toBe(pinned);
  });

  it('falls back to the launcher sibling, and refuses non-codex profiles and non-launchers', () => {
    const plain = join(work, 'codex-a');
    mkdirSync(plain, { mode: 0o700 });
    expect(codexNativeStatePath([process.execPath, join(plain, 'launcher.mjs')])).toBe(join(plain, 'native-state'));

    const claude = join(work, 'claude-a');
    mkdirSync(claude, { mode: 0o700 });
    writeFileSync(join(claude, 'profile.json'), JSON.stringify({ provider: 'claude', nativeStatePath: join(claude, 'native-state') }));
    expect(codexNativeStatePath([process.execPath, join(claude, 'launcher.mjs')])).toBeNull();

    expect(codexNativeStatePath(null)).toBeNull();
    expect(codexNativeStatePath(['codex'])).toBeNull();
    expect(codexNativeStatePath([process.execPath, join(work, 'launcher.cjs')])).toBeNull();
    expect(codexNativeStatePath([process.execPath, 'relative/launcher.mjs'])).toBeNull();
  });

  it('ignores a manifest path that is not a clean absolute path', () => {
    const profile = join(work, 'codex-c');
    mkdirSync(profile, { mode: 0o700 });
    writeFileSync(join(profile, 'profile.json'), JSON.stringify({ provider: 'codex', nativeStatePath: '/tmp/../etc' }));
    expect(codexNativeStatePath([process.execPath, join(profile, 'launcher.mjs')])).toBe(join(profile, 'native-state'));
  });
});

// ---------------------------------------------------------------------------
// Per-turn accounting
// ---------------------------------------------------------------------------

/** Two turns of one thread: turn 1 made two calls, turn 2 (starting at `turn2`) makes three. */
function twoTurnRollout(tid: string, turn2: number): { file: string; turn1Lines: string; turn2Lines: string } {
  const file = rolloutPath(tid);
  const turn1Lines = [
    line(BASE, 'session_meta', { id: tid }),
    taskStarted(BASE + 10),
    tokenCount(BASE + 20, { input: 10_000, cached: 0, output: 100 }, { input: 10_000, output: 100 }),
    tokenCount(BASE + 30, { input: 22_000, cached: 9_000, output: 250 }, { input: 12_000, cached: 9_000, output: 150 }),
  ].join('');
  const turn2Lines = [
    taskStarted(turn2 + 10),
    // Turn-start refresh repeating the previous totals: a reading, not a call.
    tokenCount(turn2 + 15, { input: 22_000, cached: 9_000, output: 250 }, { input: 12_000, cached: 9_000, output: 150 }),
    tokenCount(turn2 + 20, { input: 35_000, cached: 20_000, output: 300 }, { input: 13_000, cached: 11_000, output: 50 }),
    tokenCount(turn2 + 30, { input: 49_000, cached: 32_000, output: 380 }, { input: 14_000, cached: 12_000, output: 80 }),
    tokenCount(turn2 + 40, { input: 64_000, cached: 45_000, output: 400 }, { input: 15_000, cached: 13_000, output: 20 }),
  ].join('');
  writeFileSync(file, turn1Lines + turn2Lines);
  return { file, turn1Lines, turn2Lines };
}

describe('advanceCodexTurnTracker', () => {
  it('accounts a resumed turn exactly: only its own calls, baseline = the thread total before it', () => {
    const tid = threadIdAt(BASE);
    const turn2 = BASE + 60_000;
    const { file } = twoTurnRollout(tid, turn2);
    const tracker = createCodexTurnTracker();
    expect(advanceCodexTurnTracker(tracker, file, turn2, tid)).toBe(true);
    expect(tracker.regionFound).toBe(true);
    expect(tracker.gap).toBe(false);
    expect(tracker.baseline).toMatchObject({ inputTokens: 22_000, outputTokens: 250 });
    expect(tracker.calls).toBe(3);
    expect(tracker.callSum).toMatchObject({ inputTokens: 42_000, cachedInputTokens: 36_000, outputTokens: 150 });
    expect(tracker.reading).toMatchObject({ tokens: 15_020, window: 258_400, inTurn: true });
    expect(tracker.taskStartedWindow).toBe(258_400);
  });

  it('accounts the first turn of a thread from the file start with a zero baseline', () => {
    const tid = threadIdAt(BASE);
    const { file } = twoTurnRollout(tid, BASE + 60_000);
    const tracker = createCodexTurnTracker();
    advanceCodexTurnTracker(tracker, file, BASE - 1, tid);
    expect(tracker.baseline).toMatchObject({ inputTokens: 0, totalTokens: 0 });
    expect(tracker.calls).toBe(5);
    expect(tracker.callSum.inputTokens).toBe(64_000);
  });

  it('reads incrementally: appended calls are counted once, earlier ones never again', () => {
    const tid = threadIdAt(BASE);
    const turn2 = BASE + 60_000;
    const { file } = twoTurnRollout(tid, turn2);
    const tracker = createCodexTurnTracker();
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    const before = tracker.offset;
    appendFileSync(file, tokenCount(turn2 + 50, { input: 80_000, cached: 58_000, output: 450 }, { input: 16_000, cached: 13_000, output: 50 }));
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    expect(tracker.offset).toBeGreaterThan(before);
    expect(tracker.calls).toBe(4);
    expect(tracker.callSum.inputTokens).toBe(58_000);
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    expect(tracker.calls).toBe(4);
  });

  it('records compactions with the reading before and the post-compaction reading after', () => {
    const tid = threadIdAt(BASE);
    const turn2 = BASE + 60_000;
    const { file } = twoTurnRollout(tid, turn2);
    appendFileSync(file, compacted(turn2 + 60, 5_000));
    // codex re-emits the unchanged running total with the NEW (small) last usage.
    appendFileSync(file, tokenCount(turn2 + 61, { input: 64_000, cached: 45_000, output: 400 }, { input: 3_000, output: 500 }));
    const tracker = createCodexTurnTracker();
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    expect(tracker.compactions).toEqual([{ preTokens: 15_020, postTokens: 3_500 }]);
    expect(tracker.calls).toBe(3);
    expect(tracker.reading?.tokens).toBe(3_500);
  });

  it('keeps a compaction pending until a reading follows it', () => {
    const tid = threadIdAt(BASE);
    const turn2 = BASE + 60_000;
    const { file } = twoTurnRollout(tid, turn2);
    appendFileSync(file, compacted(turn2 + 60));
    const tracker = createCodexTurnTracker();
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    expect(tracker.compactions).toEqual([{ preTokens: 15_020, postTokens: null }]);
  });

  it('finds the turn start beyond the first tail window (an early multi-megabyte compaction)', () => {
    const tid = threadIdAt(BASE);
    const turn2 = BASE + 60_000;
    const { file } = twoTurnRollout(tid, turn2);
    appendFileSync(file, compacted(turn2 + 60, CODEX_ROLLOUT_TAIL_BYTES + 512 * 1024));
    appendFileSync(file, tokenCount(turn2 + 61, { input: 64_000, cached: 45_000, output: 400 }, { input: 3_000, output: 500 }));
    const tracker = createCodexTurnTracker();
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    expect(tracker.regionFound).toBe(true);
    expect(tracker.gap).toBe(false);
    expect(tracker.calls).toBe(3);
    expect(tracker.compactions).toHaveLength(1);
  });

  it('rediscovers from timestamps when the file is rewritten underneath it', () => {
    const tid = threadIdAt(BASE);
    const turn2 = BASE + 60_000;
    const { file, turn1Lines } = twoTurnRollout(tid, turn2);
    const tracker = createCodexTurnTracker();
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    expect(tracker.calls).toBe(3);
    // Rewritten shorter: only turn 1 plus one call of turn 2 survives.
    writeFileSync(file, turn1Lines + tokenCount(turn2 + 20, { input: 35_000, cached: 20_000, output: 300 }, { input: 13_000, output: 50 }));
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    expect(tracker.calls).toBe(1);
    expect(tracker.callSum.inputTokens).toBe(13_000);
  });

  it('prefers the CLI per-turn record for this thread and ignores another thread record', () => {
    const tid = threadIdAt(BASE);
    const turn2 = BASE + 60_000;
    const { file } = twoTurnRollout(tid, turn2);
    appendFileSync(file, usageRecord(turn2 + 70, threadIdAt(BASE, '8def-ffffffffffff'), { input: 1, output: 1 }));
    const tracker = createCodexTurnTracker();
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    expect(tracker.turnUsage).toBeNull();
    appendFileSync(file, usageRecord(turn2 + 71, tid, { input: 300_000, cached: 250_000, output: 4_000 }));
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    expect(tracker.turnUsage).toMatchObject({ inputTokens: 300_000, outputTokens: 4_000 });
  });

  it('reports false for a missing file and keeps what it had', () => {
    const tracker = createCodexTurnTracker();
    expect(advanceCodexTurnTracker(tracker, join(work, 'nope.jsonl'), BASE)).toBe(false);
    expect(tracker.initialized).toBe(false);
  });
});

describe('codexTurnUsage', () => {
  const t = (input: number, cached: number, output: number): CodexTokenTotals =>
    ({ inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output });

  it('REGRESSION: a resumed turn whose turn.completed is the thread running total is not re-counted', () => {
    const tid = threadIdAt(BASE);
    const turn2 = BASE + 60_000;
    const { file } = twoTurnRollout(tid, turn2);
    const tracker = createCodexTurnTracker();
    advanceCodexTurnTracker(tracker, file, turn2, tid);
    // `codex exec resume` printed the THREAD total (turns 1 + 2).
    const printed = t(64_000, 45_000, 400);
    expect(codexTurnUsage(tracker, printed, false)).toEqual({ totals: expect.objectContaining({ inputTokens: 42_000, cachedInputTokens: 36_000, outputTokens: 150 }), source: 'calls' });

    // Even with a gap in the per-call view, the printed running total becomes a delta.
    const gapped = { ...tracker, gap: true };
    expect(codexTurnUsage(gapped, printed, false)).toEqual({ totals: expect.objectContaining({ inputTokens: 42_000, outputTokens: 150 }), source: 'reported-delta' });
  });

  it('uses the CLI per-turn record first, and the printed figure for a first turn', () => {
    const tracker = createCodexTurnTracker();
    tracker.turnUsage = t(9, 1, 2);
    expect(codexTurnUsage(tracker, t(100, 0, 1), false)?.source).toBe('turn-record');
    expect(codexTurnUsage(null, t(100, 40, 1), true)).toEqual({ totals: t(100, 40, 1), source: 'reported' });
  });

  it('keeps a printed figure that is already per-turn, and falls back to partial sums', () => {
    const tracker = createCodexTurnTracker();
    tracker.initialized = true;
    tracker.lastTotals = t(500, 0, 5);
    tracker.calls = 1;
    tracker.callSum = t(200, 0, 2);
    tracker.gap = true;
    expect(codexTurnUsage(tracker, t(300, 0, 3), false)).toEqual({ totals: t(300, 0, 3), source: 'reported' });
    expect(codexTurnUsage(tracker, null, false)).toEqual({ totals: t(200, 0, 2), source: 'calls-partial' });
    expect(codexTurnUsage(null, null, false)).toBeNull();
  });

  it('bounds an unbaselined running total by the calls actually seen', () => {
    const tracker = createCodexTurnTracker();
    tracker.gap = true;
    tracker.baseline = null;
    tracker.calls = 2;
    tracker.firstCall = { total: t(1_100, 0, 11), last: t(100, 0, 1) };
    tracker.lastTotals = t(1_300, 0, 13);
    expect(codexTurnUsage(tracker, t(1_300, 0, 13), false)).toEqual({ totals: expect.objectContaining({ inputTokens: 300, outputTokens: 3 }), source: 'calls-partial' });
  });
});

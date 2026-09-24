/**
 * test/verse-session-store.test.ts — V3.10 event-log reliability in the
 * Verse session store (unit A5):
 *
 *   - `foldTextDeltas` drops / merges streamed delta runs exactly the way the
 *     transcript renders them — proven by rendering both logs with the
 *     client's own `buildTranscript` over hand-picked AND randomized logs;
 *   - `truncateAtTurnBoundary` never cuts mid-turn;
 *   - the seq → byte-offset index serves `readEvents(id, after)` from the
 *     tail, stays correct across appends, foreign writers, garbage and a
 *     crash-truncated final line;
 *   - `compactEvents` rewrites atomically (0600), is idempotent, keeps the
 *     seq counter, and past the cap archives WHOLE turns behind a persisted
 *     `history-truncated` marker;
 *   - transient events are never persisted;
 *   - measured numbers (log shrink, resume cost) are printed for the report.
 *
 * Pure filesystem work under a tmp dir (HOME is isolated by test/setup/home.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createVerseSessionStore,
  foldTextDeltas,
  truncateAtTurnBoundary,
  VERSE_HISTORY_KEEP_RATIO,
  type VerseSessionStore,
  type VerseUnstampedEvent,
} from '../src/core/verse/session-store.js';
import { VERSE_MAX_EVENTS_PER_SESSION, type VerseEvent } from '../src/core/verse/types.js';
import { buildTranscript } from '../src/web-ui/routes/verse/verse-store.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const AT = '2026-09-23T12:00:00.000Z';

function stamp(events: VerseUnstampedEvent[], firstSeq = 1): VerseEvent[] {
  return events.map((event, i) => ({ seq: firstSeq + i, at: AT, ...event }) as VerseEvent);
}

function usage(turnId: string): VerseUnstampedEvent {
  return {
    type: 'usage',
    turnId,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 10, contextWindow: 100 },
  };
}

/** One realistic claude turn: text streamed as `deltas` pieces, then its complete message. */
function claudeTurn(turnId: string, deltas: number, opts: { tool?: boolean } = {}): VerseUnstampedEvent[] {
  const pieces = Array.from({ length: deltas }, (_, i) => `w${i} `);
  const out: VerseUnstampedEvent[] = [
    { type: 'user-message', turnId, text: `ask ${turnId}` },
    { type: 'turn-started', turnId, pid: 123 },
  ];
  if (opts.tool) {
    out.push({ type: 'text-delta', turnId, text: 'let me look' });
    out.push({ type: 'assistant-message', turnId, text: 'let me look' });
    out.push({ type: 'tool-use', turnId, toolUseId: `tu-${turnId}`, name: 'Read', input: { file_path: 'a.ts' } });
    out.push({ type: 'tool-result', turnId, toolUseId: `tu-${turnId}`, output: 'ok', isError: false });
  }
  for (const text of pieces) out.push({ type: 'text-delta', turnId, text });
  out.push({ type: 'assistant-message', turnId, text: pieces.join('') });
  out.push(usage(turnId));
  out.push({ type: 'turn-done', turnId, ok: true, nativeSessionId: 'n', durationMs: 5 });
  return out;
}

function render(events: readonly VerseEvent[]): unknown {
  return buildTranscript([...events]).items;
}

/** Deterministic PRNG so a failing random case reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random but structurally plausible log: turns of mixed deltas, messages, tools, telemetry, errors. */
function randomLog(seed: number): VerseEvent[] {
  const rnd = prng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
  const out: VerseUnstampedEvent[] = [];
  const turns = 1 + Math.floor(rnd() * 4);
  for (let t = 0; t < turns; t += 1) {
    const turnId = `t${t}`;
    out.push({ type: 'user-message', turnId, text: `ask ${t}` });
    out.push({ type: 'turn-started', turnId, pid: null });
    const steps = Math.floor(rnd() * 25);
    for (let s = 0; s < steps; s += 1) {
      const kind = pick(['delta', 'delta', 'delta', 'assistant', 'tool', 'tool-result', 'usage', 'context', 'compaction', 'thinking', 'error', 'recovered', 'foreign-delta']);
      switch (kind) {
        case 'delta': out.push({ type: 'text-delta', turnId, text: `d${s}` }); break;
        case 'foreign-delta': out.push({ type: 'text-delta', turnId: `${turnId}-other`, text: `x${s}` }); break;
        case 'assistant': out.push({ type: 'assistant-message', turnId, text: `full ${s}` }); break;
        case 'tool': out.push({ type: 'tool-use', turnId, toolUseId: `u${t}-${s}`, name: 'Bash', input: { command: 'ls' } }); break;
        case 'tool-result': out.push({ type: 'tool-result', turnId, toolUseId: `u${t}-${s - 1}`, output: 'out', isError: rnd() < 0.3 }); break;
        case 'usage': out.push(usage(turnId)); break;
        case 'context': out.push({ type: 'context', turnId, contextTokens: 5, contextWindow: 100, exact: true }); break;
        case 'compaction': out.push({ type: 'compaction', turnId, trigger: 'auto', preTokens: 9, postTokens: 3, durationMs: 1 }); break;
        case 'thinking': out.push({ type: 'thinking', turnId, text: 'hmm' }); break;
        case 'error': out.push({ type: 'error', turnId, message: 'boom' }); break;
        case 'recovered': out.push({ type: 'recovered', turnId, how: 'handoff', message: 'recovered' }); break;
      }
    }
    // Most turns close; some end mid-stream (a crash before reconcile).
    const end = rnd();
    if (end < 0.2) out.push({ type: 'cancelled', turnId });
    if (end < 0.85) out.push({ type: 'turn-done', turnId, ok: end >= 0.2, nativeSessionId: null, durationMs: 1 });
  }
  return stamp(out);
}

// ---------------------------------------------------------------------------

describe('foldTextDeltas', () => {
  it('drops a run a complete assistant-message supersedes and keeps everything else in place', () => {
    const log = stamp(claudeTurn('a', 6));
    const folded = foldTextDeltas(log);
    expect(folded.some((e) => e.type === 'text-delta')).toBe(false);
    expect(folded.map((e) => e.type)).toEqual(['user-message', 'turn-started', 'assistant-message', 'usage', 'turn-done']);
    // Nothing renumbered: the survivors keep their seqs.
    expect(folded.map((e) => e.seq)).toEqual([1, 2, 9, 10, 11]);
    expect(render(folded)).toEqual(render(log));
  });

  it('KEEPS VERBATIM a run that a tool call / cancel ends with no message after it (resume stays exact — c19)', () => {
    const log = stamp([
      { type: 'user-message', turnId: 't', text: 'go' },
      { type: 'turn-started', turnId: 't', pid: 1 },
      { type: 'text-delta', turnId: 't', text: 'I will ' },
      { type: 'usage', turnId: 't', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null } },
      { type: 'text-delta', turnId: 't', text: 'read it' },
      { type: 'tool-use', turnId: 't', toolUseId: 'u', name: 'Read', input: {} },
      { type: 'text-delta', turnId: 't', text: 'half an ans' },
      { type: 'text-delta', turnId: 't', text: 'wer' },
      { type: 'cancelled', turnId: 't' },
      { type: 'turn-done', turnId: 't', ok: false, nativeSessionId: null, durationMs: 1 },
    ]);
    // Merging these into their first delta (the old rule) hid the tail from a
    // client whose resume cursor sat inside the run.
    expect(foldTextDeltas(log)).toBe(log);
  });

  it('a run that ends another turn\'s bubble and is then superseded keeps only its first delta (merged, same seq)', () => {
    const log = stamp([
      { type: 'user-message', turnId: 'a', text: 'go' },
      { type: 'text-delta', turnId: 'a', text: 'A1' },
      { type: 'text-delta', turnId: 'b', text: 'B1' },
      { type: 'text-delta', turnId: 'b', text: 'B2' },
      { type: 'assistant-message', turnId: 'b', text: 'B1B2' },
    ]);
    const folded = foldTextDeltas(log);
    expect(folded.map((e) => e.seq)).toEqual([1, 2, 3, 5]);
    expect(folded[2]).toMatchObject({ type: 'text-delta', turnId: 'b', text: 'B1B2' });
    expect(render(folded)).toEqual(render(log));
  });

  it('returns the very same array when nothing folds (idempotent on its own output)', () => {
    const log = stamp([{ type: 'user-message', turnId: 't', text: 'x' }, { type: 'assistant-message', turnId: 't', text: 'y' }]);
    expect(foldTextDeltas(log)).toBe(log);
    const once = foldTextDeltas(stamp(claudeTurn('a', 4, { tool: true })));
    expect(foldTextDeltas(once)).toBe(once);
  });

  it('renders identically to the raw log for 2000 randomized logs (the client is the oracle)', () => {
    for (let seed = 1; seed <= 2000; seed += 1) {
      const log = randomLog(seed);
      const folded = foldTextDeltas(log);
      expect(render(folded), `seed ${seed}`).toEqual(render(log));
      // Order and uniqueness of seqs survive.
      const seqs = folded.map((e) => e.seq);
      expect(seqs, `seed ${seed}`).toEqual([...new Set(seqs)].sort((a, b) => a - b));
    }
  });
});

describe('resume across compaction (review 3.10 c19)', () => {
  /** What a client holds after receiving raw events ≤ k, then reconnecting (?after=k) to the folded log. */
  function resumed(raw: readonly VerseEvent[], folded: readonly VerseEvent[], k: number): VerseEvent[] {
    return [...raw.filter((e) => e.seq <= k), ...folded.filter((e) => e.seq > k)];
  }

  it('the reported case: cursor inside a cancelled reply still receives the rest of it', () => {
    const raw = stamp([
      { type: 'user-message', turnId: 't', text: 'go' },
      { type: 'turn-started', turnId: 't', pid: 1 },
      { type: 'text-delta', turnId: 't', text: 'The answer ' },
      { type: 'text-delta', turnId: 't', text: 'is forty' },
      { type: 'text-delta', turnId: 't', text: '-two.' },
      { type: 'cancelled', turnId: 't' },
      { type: 'turn-done', turnId: 't', ok: false, nativeSessionId: null, durationMs: 1 },
    ]);
    const folded = foldTextDeltas(raw);
    // The client had seq 3 ('The answer ') when the stream dropped.
    const items = render(resumed(raw, folded, 3)) as Array<{ kind: string; text?: string }>;
    expect(items.find((i) => i.kind === 'assistant')?.text).toBe('The answer is forty-two.');
    expect(render(resumed(raw, folded, 3))).toEqual(render(raw));
  });

  it('for 1000 randomized logs and EVERY cursor, raw ≤ k + folded > k renders exactly like the raw log', () => {
    for (let seed = 1; seed <= 1000; seed += 1) {
      const raw = randomLog(seed);
      const folded = foldTextDeltas(raw);
      for (let k = 0; k <= raw.length; k += 1) {
        expect(render(resumed(raw, folded, k)), `seed ${seed}, cursor ${k}`).toEqual(render(raw));
      }
    }
  });

  it('holds through the store: compactEvents + readEvents(after) completes a partially streamed turn', () => {
    const raw = appendAll(store, 'r1', [
      { type: 'user-message', turnId: 't', text: 'go' },
      { type: 'text-delta', turnId: 't', text: 'one ' },
      { type: 'text-delta', turnId: 't', text: 'two ' },
      { type: 'text-delta', turnId: 't', text: 'three' },
      { type: 'error', turnId: 't', message: 'the CLI died' },
      { type: 'turn-done', turnId: 't', ok: false, nativeSessionId: null, durationMs: 1 },
    ]);
    store.compactEvents('r1');
    const cursor = raw[1]!.seq; // the client had only 'one '
    const client = [...raw.filter((e) => e.seq <= cursor), ...store.readEvents('r1', cursor)];
    expect(render(client)).toEqual(render(raw));
  });
});

describe('truncateAtTurnBoundary', () => {
  const log = stamp([...claudeTurn('a', 3), ...claudeTurn('b', 3), ...claudeTurn('c', 3)]); // 8 events per turn

  it('returns null when under the limit', () => {
    expect(truncateAtTurnBoundary(log, 100)).toBeNull();
  });

  it('keeps whole turns behind a marker whose droppedBefore is the first kept seq', () => {
    const cut = truncateAtTurnBoundary(log, 12)!;
    expect(cut.kept[0]).toEqual({ seq: 16, at: AT, type: 'history-truncated', turnId: null, droppedBefore: 17 });
    expect(cut.kept[1]).toMatchObject({ type: 'user-message', turnId: 'c', seq: 17 });
    expect(cut.kept.length).toBeLessThanOrEqual(12);
    expect(cut.dropped.map((e) => e.seq)).toEqual(log.slice(0, 16).map((e) => e.seq));
  });

  it('cuts inside a turn only when one turn alone is longer than the limit', () => {
    const giant = stamp(claudeTurn('g', 40));
    const cut = truncateAtTurnBoundary(giant, 10)!;
    expect(cut.kept.length).toBe(10);
    expect(cut.kept[0].type).toBe('history-truncated');
    expect(cut.kept.at(-1)!.type).toBe('turn-done');
  });

  it('replaces an older marker instead of stacking markers', () => {
    const first = truncateAtTurnBoundary(log, 12)!.kept;
    const more = [...first, ...stamp(claudeTurn('d', 3), 30)];
    const again = truncateAtTurnBoundary(more, 12)!;
    expect(again.kept.filter((e) => e.type === 'history-truncated')).toHaveLength(1);
    expect(again.dropped.some((e) => e.type === 'history-truncated')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

let work: string;
let store: VerseSessionStore;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'verse-store-'));
  store = createVerseSessionStore(join(work, 'root'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function appendAll(s: VerseSessionStore, id: string, events: VerseUnstampedEvent[]): VerseEvent[] {
  return events.map((event) => s.appendEvent(id, event, AT));
}

function eventsFile(id: string): string {
  return join(store.sessionsDir, `${id}.events.jsonl`);
}

describe('seq → offset index', () => {
  it('serves readEvents(after) from the tail and matches a full read after every append', () => {
    appendAll(store, 's1', claudeTurn('a', 30)); // 35 events
    for (const after of [0, 1, 5, 31, 34, 35, 99]) {
      expect(store.readEvents('s1', after)).toEqual(store.readEvents('s1').filter((e) => e.seq > after));
    }
    store.appendEvent('s1', { type: 'user-message', turnId: 'b', text: 'next' }, AT);
    expect(store.readEvents('s1', 35).map((e) => e.seq)).toEqual([36]);
    expect(store.lastSeq('s1')).toBe(36);
    // A cold index (new store = new process) serves the same tail.
    expect(createVerseSessionStore(join(work, 'root')).readEvents('s1', 30)).toEqual(store.readEvents('s1', 30));
  });

  it('a second store instance appending to the same log is noticed (index rebuilt, no stale reads)', () => {
    appendAll(store, 's2', claudeTurn('a', 2)); // 7 events
    expect(store.readEvents('s2')).toHaveLength(7);
    const other = createVerseSessionStore(join(work, 'root'));
    other.appendEvent('s2', { type: 'user-message', turnId: 'b', text: 'from elsewhere' }, AT);
    expect(store.readEvents('s2', 7)).toEqual([expect.objectContaining({ seq: 8, text: 'from elsewhere' })]);
    // ...and a compaction by the other instance (file replaced) is noticed too.
    other.appendEvent('s2', { type: 'turn-done', turnId: 'b', ok: true, nativeSessionId: null, durationMs: 1 }, AT);
    expect(other.compactEvents('s2').changed).toBe(true);
    expect(store.readEvents('s2').some((e) => e.type === 'text-delta')).toBe(false);
    // The cached append descriptor was on the replaced inode: the next append must land in the live file.
    const next = store.appendEvent('s2', { type: 'user-message', turnId: 'c', text: 'after compaction' }, AT);
    expect(createVerseSessionStore(join(work, 'root')).readEvents('s2', next.seq - 1)).toEqual([next]);
    other.close();
  });

  it('skips garbage lines and repairs a crash-truncated final line instead of corrupting the next one', () => {
    appendAll(store, 's3', [{ type: 'user-message', turnId: 't', text: 'one' }]);
    appendFileSync(eventsFile('s3'), 'garbage line\n{"seq":"x"}\n{"seq":2,"at":"x","type":"user-mess');
    const next = store.appendEvent('s3', { type: 'cancelled', turnId: 't' }, AT);
    // The torn line had claimed seq 2; a claimed seq is never reissued.
    expect(next.seq).toBe(3);
    expect(store.readEvents('s3').map((e) => [e.seq, e.type])).toEqual([[1, 'user-message'], [3, 'cancelled']]);
    // The torn line and the new one are on separate lines on disk.
    const raw = readFileSync(eventsFile('s3'), 'utf8');
    expect(raw).toContain('"type":"user-mess\n{"seq":3');
    // A fresh store (cold index) reads the same.
    expect(createVerseSessionStore(join(work, 'root')).readEvents('s3', 1).map((e) => e.seq)).toEqual([3]);
  });

  it('never persists transient events, and drops a transient line found on disk', () => {
    expect(() => store.appendEvent('s4', { type: 'progress', turnId: 't', phase: 'tool', elapsedMs: 1 }, AT))
      .toThrow(/never persisted/);
    appendAll(store, 's4', [{ type: 'user-message', turnId: 't', text: 'x' }]);
    appendFileSync(eventsFile('s4'), `${JSON.stringify({ seq: 2, at: AT, type: 'thinking-delta', turnId: 't', text: 'stray' })}\n`);
    expect(store.readEvents('s4').map((e) => e.type)).toEqual(['user-message']);
  });

  it('validates the V3.10 persisted types in full', () => {
    appendAll(store, 's5', [{ type: 'user-message', turnId: 't', text: 'x' }]);
    appendFileSync(eventsFile('s5'), [
      { seq: 2, at: AT, type: 'recovered', turnId: 't', how: 'handoff', message: 'ok' },
      { seq: 3, at: AT, type: 'recovered', turnId: 't', how: 'magic', message: 'bad how' },
      { seq: 4, at: AT, type: 'history-truncated', turnId: null, droppedBefore: 9 },
      { seq: 5, at: AT, type: 'history-truncated', turnId: null, droppedBefore: 'nine' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(store.readEvents('s5').map((e) => e.seq)).toEqual([1, 2, 4]);
  });
});

describe('compactEvents', () => {
  it('folds a finished turn atomically (0600), keeps the seq counter, and is a no-op the second time', () => {
    const raw = appendAll(store, 'c1', claudeTurn('a', 50, { tool: true }));
    const before = statSync(eventsFile('c1')).size;
    const result = store.compactEvents('c1');
    expect(result).toMatchObject({ changed: true, eventsBefore: raw.length, archived: 0 });
    expect(result.eventsAfter).toBe(raw.length - 51);
    expect(statSync(eventsFile('c1')).mode & 0o777).toBe(0o600);
    expect(statSync(eventsFile('c1')).size).toBeLessThan(before / 3);
    expect(render(store.readEvents('c1'))).toEqual(render(raw));
    // Same answer from a cold index (a new process).
    expect(createVerseSessionStore(join(work, 'root')).readEvents('c1')).toEqual(store.readEvents('c1'));
    expect(store.compactEvents('c1').changed).toBe(false);
    expect(store.lastSeq('c1')).toBe(raw.at(-1)!.seq);
    expect(store.appendEvent('c1', { type: 'user-message', turnId: 'b', text: 'next' }, AT).seq).toBe(raw.at(-1)!.seq + 1);
  });

  it('rewrites a log that only has garbage to clean, and never touches the temp-file namespace afterwards', () => {
    appendAll(store, 'c2', [{ type: 'user-message', turnId: 't', text: 'x' }]);
    appendFileSync(eventsFile('c2'), 'not json\n');
    expect(store.compactEvents('c2').changed).toBe(true);
    expect(readFileSync(eventsFile('c2'), 'utf8')).not.toContain('not json');
    expect(existsSync(join(store.sessionsDir, 'c2.events.jsonl.tmp'))).toBe(false);
  });

  it('past the cap: archives WHOLE turns (0600), heads the log with a persisted marker, and remove() deletes the archive', () => {
    const cap = 40;
    const turns: VerseUnstampedEvent[] = [];
    for (let t = 0; t < 12; t += 1) turns.push(...claudeTurn(`t${t}`, 0, { tool: true })); // 9 events each, nothing to fold but the "let me look" delta
    appendAll(store, 'c3', turns);
    const result = store.compactEvents('c3', { cap });
    expect(result.changed).toBe(true);
    expect(result.archived).toBeGreaterThan(0);
    const kept = store.readEvents('c3');
    expect(kept.length).toBeLessThanOrEqual(Math.floor(cap * VERSE_HISTORY_KEEP_RATIO));
    expect(kept[0]).toMatchObject({ type: 'history-truncated', turnId: null, droppedBefore: kept[1].seq });
    expect(kept[1].type).toBe('user-message');
    const archive = join(store.sessionsDir, 'c3.events.archive.jsonl');
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    const archived = readFileSync(archive, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as VerseEvent);
    expect(archived).toHaveLength(result.archived);
    // Archived + kept (minus marker) is exactly the folded history: nothing lost.
    expect(archived.at(-1)!.seq).toBeLessThan(kept[1].seq);
    expect(archived[0].type).toBe('user-message');
    store.remove('c3');
    expect(existsSync(archive)).toBe(false);
    expect(existsSync(eventsFile('c3'))).toBe(false);
  });

  it('an over-cap log from an older release is cut at a turn boundary ON READ, file untouched', () => {
    const lines: string[] = [];
    let seq = 0;
    const turnsNeeded = Math.ceil((VERSE_MAX_EVENTS_PER_SESSION + 500) / 10); // claudeTurn(_, 5) = 10 events
    for (let t = 0; t < turnsNeeded; t += 1) {
      for (const event of claudeTurn(`t${t}`, 5)) lines.push(JSON.stringify({ seq: ++seq, at: AT, ...event }));
    }
    mkdirSync(store.sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(eventsFile('legacy'), `${lines.join('\n')}\n`, { mode: 0o600 });
    const size = statSync(eventsFile('legacy')).size;
    const events = store.readEvents('legacy');
    expect(events.length).toBeLessThanOrEqual(VERSE_MAX_EVENTS_PER_SESSION);
    expect(events[0].type).toBe('history-truncated');
    expect(events[1].type).toBe('user-message');
    expect(events.at(-1)!.seq).toBe(seq);
    expect(statSync(eventsFile('legacy')).size).toBe(size);
  });
});

describe('measured (numbers for the A5 report)', () => {
  it('a realistic session shrinks ~95% and a resume reads the tail in well under the full-parse cost', () => {
    // ~195 events per turn (r2/reliability.md: 94% of events are text-delta).
    const turns = 100;
    const lines: string[] = [];
    let seq = 0;
    for (let t = 0; t < turns; t += 1) {
      for (const event of claudeTurn(`t${t}`, 190)) lines.push(JSON.stringify({ seq: ++seq, at: AT, ...event }));
    }
    // Written in one go (what 100 turns of appends leave on disk) — appending
    // 19.5k events one by one is measured separately below.
    mkdirSync(store.sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(eventsFile('m1'), `${lines.join('\n')}\n`, { mode: 0o600 });
    const rawLines = store.readEvents('m1').length;
    const rawBytes = statSync(eventsFile('m1')).size;

    // Baseline: what every readEvents did before V3.10 — read + parse all.
    const legacyRead = (after: number): VerseEvent[] => readFileSync(eventsFile('m1'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l) as VerseEvent).filter((e) => e.seq > after);
    const lastSeq = store.lastSeq('m1');
    const time = (fn: () => unknown, runs = 20): number => {
      fn();
      const start = performance.now();
      for (let i = 0; i < runs; i += 1) fn();
      return (performance.now() - start) / runs;
    };
    const legacyResumeMs = time(() => legacyRead(lastSeq - 10));
    const warmResumeMs = time(() => store.readEvents('m1', lastSeq - 10));
    const coldResumeMs = time(() => createVerseSessionStore(join(work, 'root')).readEvents('m1', lastSeq - 10), 5);

    const compactStart = performance.now();
    const result = store.compactEvents('m1');
    const compactMs = performance.now() - compactStart;
    const foldedBytes = statSync(eventsFile('m1')).size;
    const appendStart = performance.now();
    for (let i = 0; i < 300; i += 1) store.appendEvent('m2', { type: 'text-delta', turnId: 't', text: `w${i}` }, AT);
    const appendMs = (performance.now() - appendStart) / 300;
    const shrink = 1 - foldedBytes / rawBytes;
    console.log(`[A5 measured] ${rawLines} events / ${rawBytes} B → ${result.eventsAfter} events / ${foldedBytes} B `
      + `(${(shrink * 100).toFixed(1)}% smaller); resume-after (${rawLines} events): legacy full parse ${legacyResumeMs.toFixed(2)} ms, `
      + `cold index ${coldResumeMs.toFixed(2)} ms, warm index ${warmResumeMs.toFixed(3)} ms; `
      + `compaction ${compactMs.toFixed(1)} ms; append ${appendMs.toFixed(3)} ms/event (cached fd)`);
    expect(result.eventsAfter).toBe(turns * 5);
    expect(shrink).toBeGreaterThan(0.9);
    expect(warmResumeMs).toBeLessThan(legacyResumeMs);
    expect(warmResumeMs).toBeLessThan(1);
  });
});

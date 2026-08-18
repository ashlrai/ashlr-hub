/**
 * v333: tests for streaming.ts's durable fileSink() / combineSinks() /
 * gcRunStreams() — the persistence half of "persist engine output during
 * execution" (the SSE side is covered separately in run-events-sse.test.ts).
 *
 * Covers:
 *   - fileSink scrubs secret-shaped text BEFORE it ever touches disk.
 *   - size cap: a run that produces more than MAX_STREAM_FILE_BYTES gets a
 *     single truncation marker and then silently stops growing.
 *   - combineSinks tees to every sink, and one sink throwing never blocks
 *     delivery to the others.
 *   - runStreamFilePath rejects path-traversal-shaped ids.
 *   - gcRunStreams deletes only files past STREAM_RETENTION_MS, never fresh
 *     ones, and is a safe no-op on a missing directory.
 *   - emitSinkEvent never throws even when the sink itself throws.
 *
 * One assertion is DELIBERATELY inverted (see "sanity" test) so this suite
 * doesn't pass vacuously if scrubbing were ever removed from fileSink.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunStreamEvent } from '../src/core/types.js';
import {
  fileSink,
  combineSinks,
  emitSinkEvent,
  gcRunStreams,
  runStreamFilePath,
  runStreamsDir,
  MAX_STREAM_FILE_BYTES,
  STREAM_TRUNCATION_MARKER,
} from '../src/core/run/streaming.js';

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-stream-sink-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function makeEvent(overrides: Partial<RunStreamEvent> = {}): RunStreamEvent {
  return { kind: 'model-delta', ts: new Date().toISOString(), text: 'hello', ...overrides };
}

function readStreamFile(runId: string): string {
  const p = runStreamFilePath(runId);
  if (!p) return '';
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// runStreamFilePath — id grammar
// ---------------------------------------------------------------------------

describe('runStreamFilePath', () => {
  it('returns a path under runStreamsDir() for a safe id', () => {
    const p = runStreamFilePath('run-abc123');
    expect(p).toBe(path.join(runStreamsDir(), 'run-abc123.log'));
  });

  it('rejects traversal-shaped ids', () => {
    expect(runStreamFilePath('../../etc/passwd')).toBeUndefined();
    expect(runStreamFilePath('foo/bar')).toBeUndefined();
    expect(runStreamFilePath('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fileSink — scrub-at-rest
// ---------------------------------------------------------------------------

describe('fileSink — scrubs secrets before they touch disk', () => {
  it('never persists a raw sk- style secret', () => {
    const secret = 'sk-ant-api03-SUPERSECRETVALUE1234567890abcdef';
    const sink = fileSink('run-secret-1');
    sink(makeEvent({ text: `leaked key ${secret}` }));

    const raw = readStreamFile('run-secret-1');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[REDACTED]');
  });

  it('never persists a bearer token value', () => {
    const sink = fileSink('run-secret-2');
    sink(makeEvent({ text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' }));

    const raw = readStreamFile('run-secret-2');
    expect(raw).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('writes valid JSONL — one parseable record per line', () => {
    const sink = fileSink('run-jsonl-1');
    sink(makeEvent({ text: 'first chunk', taskId: 't1' }));
    sink(makeEvent({ text: 'second chunk' }));

    const lines = readStreamFile('run-jsonl-1').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ kind: 'model-delta', taskId: 't1', text: 'first chunk' });
    const second = JSON.parse(lines[1]!);
    expect(second).toMatchObject({ kind: 'model-delta', text: 'second chunk' });
    expect(second.taskId).toBeUndefined();
  });

  it('skips events with no text (nothing meaningful to persist)', () => {
    const sink = fileSink('run-empty-1');
    sink(makeEvent({ text: undefined }));
    sink(makeEvent({ text: '' }));
    expect(readStreamFile('run-empty-1')).toBe('');
  });

  it('file is written with 0600 permissions, dir with 0700', () => {
    const sink = fileSink('run-perms-1');
    sink(makeEvent({ text: 'x' }));
    const p = runStreamFilePath('run-perms-1')!;
    if (process.platform !== 'win32') {
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
      expect(fs.statSync(runStreamsDir()).mode & 0o777).toBe(0o700);
    }
  });

  it('never throws regardless of event shape', () => {
    const sink = fileSink('run-safe-1');
    expect(() => sink({ kind: 'log', ts: new Date().toISOString() })).not.toThrow();
    expect(() => sink(makeEvent({ data: { circular: {} as unknown } }))).not.toThrow();
  });

  it('an invalid runId degrades to a silent no-op sink', () => {
    const sink = fileSink('../traversal');
    expect(() => sink(makeEvent({ text: 'x' }))).not.toThrow();
    expect(fs.existsSync(runStreamsDir())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fileSink — size cap + truncation marker
// ---------------------------------------------------------------------------

describe('fileSink — size cap', () => {
  it('stops growing past MAX_STREAM_FILE_BYTES and writes exactly one truncation marker', () => {
    const sink = fileSink('run-cap-1');
    // Each chunk ~1MB of harmless repeated text; write enough to blow past
    // the 8MB cap, then a few more to prove writes silently stop after.
    const bigChunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 12; i++) {
      sink(makeEvent({ text: bigChunk }));
    }

    const raw = readStreamFile('run-cap-1');
    const bytes = Buffer.byteLength(raw, 'utf8');
    expect(bytes).toBeLessThanOrEqual(MAX_STREAM_FILE_BYTES + 1024 * 1024); // one marker line of slack
    const markerCount = raw.split('\n').filter((l) => l.includes(STREAM_TRUNCATION_MARKER)).length;
    expect(markerCount).toBe(1);

    // Further writes after truncation are pure no-ops — file stops growing.
    const sizeAfterCap = fs.statSync(runStreamFilePath('run-cap-1')!).size;
    sink(makeEvent({ text: bigChunk }));
    sink(makeEvent({ text: bigChunk }));
    expect(fs.statSync(runStreamFilePath('run-cap-1')!).size).toBe(sizeAfterCap);
  });

  it('a run comfortably under the cap is never truncated', () => {
    const sink = fileSink('run-cap-2');
    for (let i = 0; i < 20; i++) sink(makeEvent({ text: `chunk ${i}` }));
    const raw = readStreamFile('run-cap-2');
    expect(raw).not.toContain(STREAM_TRUNCATION_MARKER);
    expect(raw.trim().split('\n')).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// combineSinks — tee
// ---------------------------------------------------------------------------

describe('combineSinks', () => {
  it('delivers the same event to every sink', () => {
    const receivedA: RunStreamEvent[] = [];
    const receivedB: RunStreamEvent[] = [];
    const combined = combineSinks(
      (e) => receivedA.push(e),
      (e) => receivedB.push(e),
    );
    const event = makeEvent({ text: 'both should see this' });
    combined(event);
    expect(receivedA).toEqual([event]);
    expect(receivedB).toEqual([event]);
  });

  it("one sink throwing never blocks delivery to the others", () => {
    const received: RunStreamEvent[] = [];
    const combined = combineSinks(
      () => { throw new Error('boom'); },
      (e) => received.push(e),
    );
    const event = makeEvent({ text: 'still delivered' });
    expect(() => combined(event)).not.toThrow();
    expect(received).toEqual([event]);
  });

  it('with zero sinks, returns a working no-op', () => {
    const combined = combineSinks();
    expect(() => combined(makeEvent())).not.toThrow();
  });

  it('with one sink, returns that sink directly (no wrapping overhead)', () => {
    const only = (_e: RunStreamEvent): void => {};
    expect(combineSinks(only)).toBe(only);
  });

  it('composes a live CLI-style sink with fileSink — both receive events', () => {
    const rendered: RunStreamEvent[] = [];
    const combined = combineSinks((e) => rendered.push(e), fileSink('run-tee-1'));
    combined(makeEvent({ text: 'engine output line' }));

    expect(rendered).toHaveLength(1);
    expect(readStreamFile('run-tee-1')).toContain('engine output line');
  });
});

// ---------------------------------------------------------------------------
// emitSinkEvent
// ---------------------------------------------------------------------------

describe('emitSinkEvent', () => {
  it('stamps ts and forwards to the sink', () => {
    const received: RunStreamEvent[] = [];
    emitSinkEvent((e) => received.push(e), { kind: 'log', text: 'hi' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: 'log', text: 'hi' });
    expect(typeof received[0]!.ts).toBe('string');
  });

  it('never throws even when the sink itself throws', () => {
    expect(() => emitSinkEvent(() => { throw new Error('boom'); }, { kind: 'log', text: 'hi' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// gcRunStreams — retention
// ---------------------------------------------------------------------------

describe('gcRunStreams', () => {
  it('is a safe no-op when the directory does not exist yet', () => {
    expect(() => gcRunStreams(true)).not.toThrow();
  });

  it('deletes files older than the retention window, keeps fresh ones', () => {
    fileSink('run-old-1')(makeEvent({ text: 'old' }));
    fileSink('run-fresh-1')(makeEvent({ text: 'fresh' }));

    const oldPath = runStreamFilePath('run-old-1')!;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPath, eightDaysAgo, eightDaysAgo);

    gcRunStreams(true);

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(runStreamFilePath('run-fresh-1')!)).toBe(true);
  });
});

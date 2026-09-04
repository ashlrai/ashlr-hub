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
  flushStreamSink,
  endStreamSink,
  failStreamSink,
  gcRunStreams,
  runStreamFilePath,
  runStreamsDir,
  MAX_STREAM_FILE_BYTES,
  STREAM_REDACTION_WINDOW_CHARS,
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

function readStoredText(runId: string): string {
  const raw = readStreamFile(runId).trim();
  if (!raw) return '';
  return raw.split('\n').map((line) => (JSON.parse(line) as { text: string }).text).join('');
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
    endStreamSink(sink);

    const raw = readStreamFile('run-secret-1');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[REDACTED]');
  });

  it('never persists a bearer token value', () => {
    const sink = fileSink('run-secret-2');
    sink(makeEvent({ text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' }));
    endStreamSink(sink);

    const raw = readStreamFile('run-secret-2');
    expect(raw).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });

  it('writes valid JSONL — one parseable record per line', () => {
    const sink = fileSink('run-jsonl-1');
    sink(makeEvent({ text: 'first chunk', taskId: 't1' }));
    sink(makeEvent({ text: 'second chunk' }));
    endStreamSink(sink);

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
    endStreamSink(sink);
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

  it('redacts representative secrets split at every chunk boundary', () => {
    const secrets = [
      'sk-ant-api03-SUPERSECRETVALUE1234567890abcdef',
      'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      'Authorization Bearer abcdefghijklmnopqrstuvwxyz012345',
      'password=correct-horse-battery-staple',
      ['xox', 'b-1234567890-abcdefghijklmnop'].join(''),
      'AKIAIOSFODNN7EXAMPLE',
      ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'signaturevalue'].join('.'),
      ['gl', 'pat-abcdefghijklmnop123456'].join(''),
      ['AI', 'zaSyD1234567890abcdefghijklmnopqrstuv'].join(''),
      'https://operator:supersecretpassword@example.com/path',
      'https://:SENSITIVEVALUE_0123456789@example.com/path',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn0123456789+/',
      ['-----BE', 'GIN PRIVATE KEY-----\nprivatekeymaterial\n-----END PRIVATE KEY-----'].join(''),
    ];

    let sequence = 0;
    for (const secret of secrets) {
      for (let split = 0; split <= secret.length; split += 1) {
        const runId = `run-split-${sequence++}`;
        const sink = fileSink(runId);
        sink(makeEvent({ text: secret.slice(0, split) }));
        sink(makeEvent({ text: secret.slice(split) }));
        endStreamSink(sink);
        const stored = readStoredText(runId);
        expect(stored, `${secret.slice(0, 20)}… split at ${split}`).not.toContain(secret);
        expect(stored, `${secret.slice(0, 20)}… split at ${split}`).toContain('[REDACTED]');
      }
    }
  });

  it('keeps benign streaming responsive beyond the bounded look-behind', () => {
    const sink = fileSink('run-responsive-1');
    const text = 'ordinary output '.repeat(80);
    sink(makeEvent({ text }));
    const storedBeforeFlush = readStoredText('run-responsive-1');
    expect(storedBeforeFlush.length).toBe(text.length - STREAM_REDACTION_WINDOW_CHARS);
    expect(text.startsWith(storedBeforeFlush)).toBe(true);
    endStreamSink(sink);
    expect(readStoredText('run-responsive-1')).toBe(text);
  });

  it('never leaks the detached tail of a secret longer than the redaction window at any split', () => {
    const secret = `password=${'Ab9_'.repeat(STREAM_REDACTION_WINDOW_CHARS)}`;
    const properSuffix = secret.slice(-STREAM_REDACTION_WINDOW_CHARS);

    for (let split = 0; split <= secret.length; split += 1) {
      const runId = `run-long-split-${split}`;
      const sink = fileSink(runId);
      sink(makeEvent({ text: secret.slice(0, split) }));
      sink(makeEvent({ text: secret.slice(split) }));
      endStreamSink(sink);

      const stored = readStoredText(runId);
      expect(stored, `long key=value split at ${split}`).toContain('[REDACTED]');
      expect(stored, `long key=value split at ${split}`).not.toContain(secret);
      expect(stored, `detached tail split at ${split}`).not.toContain(properSuffix);
    }
  });

  it('fails closed when an unbounded introducer crosses every boundary before its delimiter', () => {
    const whitespace = ' '.repeat(STREAM_REDACTION_WINDOW_CHARS + 64);
    const pemBegin = ['-----BE', 'GIN'].join('');
    const pemEnd = ['-----E', 'ND PRIVATE KEY-----'].join('');
    const candidates = [
      {
        label: 'generic-key',
        text: `password${whitespace}=correct-horse-battery-staple`,
        forbidden: 'correct-horse-battery-staple',
      },
      {
        label: 'pem-header',
        text: `${pemBegin}${whitespace}PRIVATE KEY-----\nprivatekeymaterial\n${pemEnd}`,
        forbidden: 'privatekeymaterial',
      },
    ];

    let sequence = 0;
    for (const candidate of candidates) {
      for (let split = 0; split <= candidate.text.length; split += 1) {
        const runId = `run-unbounded-${sequence++}`;
        const sink = fileSink(runId);
        sink(makeEvent({ text: candidate.text.slice(0, split) }));
        sink(makeEvent({ text: candidate.text.slice(split) }));
        endStreamSink(sink);

        const stored = readStoredText(runId);
        expect(stored, `${candidate.label} split at ${split}`).toContain('[REDACTED]');
        expect(stored, `${candidate.label} split at ${split}`).not.toContain(candidate.forbidden);
        expect(stored, `${candidate.label} split at ${split}`).not.toContain(whitespace);
      }
    }
  });

  it('recognizes every generic sensitive key before unbounded delimiter whitespace', () => {
    const keys = [
      'api_key', 'api-token', 'secret_key', 'token', 'password', 'passwd', 'pwd',
      'auth', 'credential', 'client_secret', 'private_key', 'access_token',
      'refresh-token', 'session_token', 'connection_string', 'ASHLR_SERVICE_TOKEN',
    ];
    for (const [index, key] of keys.entries()) {
      const runId = `run-key-whitespace-${index}`;
      const sink = fileSink(runId);
      sink(makeEvent({ text: key }));
      sink(makeEvent({ text: ' '.repeat(STREAM_REDACTION_WINDOW_CHARS + 1) }));
      sink(makeEvent({ text: '=sensitivevalue' }));
      endStreamSink(sink);
      expect(readStoredText(runId)).toBe('[REDACTED]');
    }
  });

  it('flush preserves undecidable look-behind without closing, while end finalizes it', () => {
    const sink = fileSink('run-lifecycle-1');
    sink(makeEvent({ text: 'first safe fragment' }));
    expect(readStoredText('run-lifecycle-1')).toBe('');
    flushStreamSink(sink);
    expect(readStoredText('run-lifecycle-1')).toBe('');
    sink(makeEvent({ text: ' second safe fragment' }));
    endStreamSink(sink);
    expect(readStoredText('run-lifecycle-1')).toBe('first safe fragment second safe fragment');
    sink(makeEvent({ text: ' ignored after end' }));
    expect(readStoredText('run-lifecycle-1')).not.toContain('ignored after end');
  });

  it('retains redaction state across nonterminal flush and empty lifecycle events', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    const sink = fileSink('run-lifecycle-boundary-1');
    sink(makeEvent({ text: secret.slice(0, 3) }));
    flushStreamSink(sink);
    sink(makeEvent({ kind: 'log', text: undefined }));
    sink(makeEvent({ text: secret.slice(3) }));
    endStreamSink(sink);

    const stored = readStoredText('run-lifecycle-boundary-1');
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(secret.slice(3));
    expect(stored).toContain('[REDACTED]');
  });

  it('keeps generic-key redaction locked across flush, lifecycle, and benign continuation', () => {
    const sink = fileSink('run-generic-lifecycle-boundary-1');
    sink(makeEvent({ text: 'password' }));
    flushStreamSink(sink);
    sink(makeEvent({ kind: 'log', text: undefined }));
    sink(makeEvent({ text: ' '.repeat(STREAM_REDACTION_WINDOW_CHARS + 8) }));
    sink(makeEvent({ text: '=sensitivevalue' }));
    sink(makeEvent({ text: ' benign continuation must not be persisted' }));
    endStreamSink(sink);

    expect(readStoredText('run-generic-lifecycle-boundary-1')).toBe('[REDACTED]');
  });

  it('error drains a split secret safely and closes the sink', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    const sink = fileSink('run-lifecycle-error-1');
    sink(makeEvent({ text: secret.slice(0, 8) }));
    sink(makeEvent({ text: secret.slice(8) }));
    failStreamSink(sink, new Error('engine failed'));
    expect(readStoredText('run-lifecycle-error-1')).not.toContain(secret);
    expect(readStoredText('run-lifecycle-error-1')).toContain('[REDACTED]');
    sink(makeEvent({ text: ' ignored after error' }));
    expect(readStoredText('run-lifecycle-error-1')).not.toContain('ignored after error');
  });

  it('error closes a generic-key stream already locked before its delimiter', () => {
    const sink = fileSink('run-generic-error-1');
    sink(makeEvent({ text: 'client_secret' }));
    sink(makeEvent({ text: ' '.repeat(STREAM_REDACTION_WINDOW_CHARS + 8) }));
    sink(makeEvent({ text: ':sensitivevalue' }));
    failStreamSink(sink, new Error('engine failed'));
    sink(makeEvent({ text: ' ignored after error' }));
    expect(readStoredText('run-generic-error-1')).toBe('[REDACTED]');
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
    endStreamSink(sink);
    const raw = readStreamFile('run-cap-2');
    expect(raw).not.toContain(STREAM_TRUNCATION_MARKER);
    expect(raw.trim().split('\n')).toHaveLength(20);
  });

  it('redacts an unbounded generic secret introduced immediately below the cap', () => {
    const sink = fileSink('run-cap-secret-1');
    sink(makeEvent({ text: 'x'.repeat(MAX_STREAM_FILE_BYTES - 4_096) }));
    sink(makeEvent({ text: 'password' }));
    sink(makeEvent({ text: ' '.repeat(STREAM_REDACTION_WINDOW_CHARS + 8) }));
    sink(makeEvent({ text: '=sensitivevalue' }));
    endStreamSink(sink);

    const stored = readStoredText('run-cap-secret-1');
    expect(stored).toContain('[REDACTED]');
    expect(stored).not.toContain('sensitivevalue');
    expect(stored).not.toContain('password');
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
    endStreamSink(combined);

    expect(rendered).toHaveLength(1);
    expect(readStreamFile('run-tee-1')).toContain('engine output line');
  });

  it('keeps sibling sinks live after file persistence fails closed', () => {
    const rendered: RunStreamEvent[] = [];
    const combined = combineSinks((event) => rendered.push(event), fileSink('run-tee-redacted-1'));
    combined(makeEvent({ text: 'password' }));
    combined(makeEvent({ text: ' '.repeat(STREAM_REDACTION_WINDOW_CHARS + 8) }));
    combined(makeEvent({ text: '=sensitivevalue' }));
    combined(makeEvent({ text: ' live sibling continues' }));
    endStreamSink(combined);

    expect(rendered).toHaveLength(4);
    expect(rendered.map((event) => event.text ?? '').join('')).toContain('live sibling continues');
    expect(readStoredText('run-tee-redacted-1')).toBe('[REDACTED]');
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
    const oldSink = fileSink('run-old-1');
    oldSink(makeEvent({ text: 'old' }));
    endStreamSink(oldSink);
    const freshSink = fileSink('run-fresh-1');
    freshSink(makeEvent({ text: 'fresh' }));
    endStreamSink(freshSink);

    const oldPath = runStreamFilePath('run-old-1')!;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPath, eightDaysAgo, eightDaysAgo);

    gcRunStreams(true);

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(runStreamFilePath('run-fresh-1')!)).toBe(true);
  });
});

/**
 * M11 streaming tests — hermetic, no real network.
 *
 * Covers nullSink and makeCliSink:
 *   - nullSink returns a no-op function (never throws, never writes).
 *   - makeCliSink(json:false): emits human-readable lines to STDERR.
 *   - makeCliSink(json:true): emits lines to STDERR (not stdout) so stdout
 *     stays clean JSON.
 *   - Events are rendered (not silently dropped) for all RunStreamEvent kinds.
 *   - model-delta events render the text payload.
 *   - Secret values must never appear in emitted output.
 *   - Sink never throws regardless of event shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunStreamEvent } from '../src/core/types.js';
import { nullSink, makeCliSink } from '../src/core/run/streaming.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a RunStreamEvent. */
function makeEvent(
  kind: RunStreamEvent['kind'],
  overrides: Partial<RunStreamEvent> = {},
): RunStreamEvent {
  return {
    kind,
    ts: new Date().toISOString(),
    ...overrides,
  };
}

/** All event kinds defined in the contract. */
const ALL_KINDS: RunStreamEvent['kind'][] = [
  'task-start',
  'model-delta',
  'tool-call',
  'task-done',
  'retry',
  'verify',
  'log',
];

// ---------------------------------------------------------------------------
// nullSink
// ---------------------------------------------------------------------------

describe('nullSink', () => {
  it('returns a function', () => {
    const sink = nullSink();
    expect(typeof sink).toBe('function');
  });

  it('returned function does not throw for any event kind', () => {
    const sink = nullSink();
    for (const kind of ALL_KINDS) {
      expect(() => sink(makeEvent(kind, { text: 'hello', taskId: 'task-1' }))).not.toThrow();
    }
  });

  it('does not write to stdout or stderr', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sink = nullSink();
    sink(makeEvent('model-delta', { text: 'hello world' }));
    sink(makeEvent('task-start', { taskId: 'task-1' }));
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('calling nullSink() multiple times returns independent sinks', () => {
    const s1 = nullSink();
    const s2 = nullSink();
    expect(s1).not.toBe(s2);
    // Both are still no-ops
    expect(() => s1(makeEvent('log', { text: 'a' }))).not.toThrow();
    expect(() => s2(makeEvent('log', { text: 'b' }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// makeCliSink — json:true → stream to STDERR (stdout stays clean)
// ---------------------------------------------------------------------------

describe('makeCliSink — json:true routes stream to STDERR', () => {
  let stderrLines: string[];
  let stdoutLines: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrLines = [];
    stdoutLines = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('task-start event writes to stderr (not stdout)', () => {
    const sink = makeCliSink({ json: true });
    sink(makeEvent('task-start', { taskId: 'task-1', text: 'Starting task' }));
    expect(stdoutLines).toHaveLength(0);
    expect(stderrLines.length).toBeGreaterThan(0);
  });

  it('model-delta event writes to stderr', () => {
    const sink = makeCliSink({ json: true });
    sink(makeEvent('model-delta', { text: 'chunk of text' }));
    expect(stdoutLines).toHaveLength(0);
    expect(stderrLines.length).toBeGreaterThan(0);
  });

  it('task-done event writes to stderr', () => {
    const sink = makeCliSink({ json: true });
    sink(makeEvent('task-done', { taskId: 'task-1', text: 'Done.' }));
    expect(stdoutLines).toHaveLength(0);
    expect(stderrLines.length).toBeGreaterThan(0);
  });

  it('retry event writes to stderr', () => {
    const sink = makeCliSink({ json: true });
    sink(makeEvent('retry', { taskId: 'task-1', text: 'Retrying...', data: { attempt: 2 } }));
    expect(stdoutLines).toHaveLength(0);
    expect(stderrLines.length).toBeGreaterThan(0);
  });

  it('verify event writes to stderr', () => {
    const sink = makeCliSink({ json: true });
    sink(makeEvent('verify', { taskId: 'task-1', data: { ok: true, reason: 'looks good' } }));
    expect(stdoutLines).toHaveLength(0);
    expect(stderrLines.length).toBeGreaterThan(0);
  });

  it('log event writes to stderr', () => {
    const sink = makeCliSink({ json: true });
    sink(makeEvent('log', { text: 'informational message' }));
    expect(stdoutLines).toHaveLength(0);
    expect(stderrLines.length).toBeGreaterThan(0);
  });

  it('stdout is NEVER written for any event kind when json:true', () => {
    const sink = makeCliSink({ json: true });
    for (const kind of ALL_KINDS) {
      sink(makeEvent(kind, { text: 'test', taskId: 'task-x' }));
    }
    expect(stdoutLines).toHaveLength(0);
  });

  it('stderr receives output for every event kind when json:true', () => {
    const sink = makeCliSink({ json: true });
    for (const kind of ALL_KINDS) {
      stderrLines.length = 0; // reset between kinds
      sink(makeEvent(kind, { text: 'test' }));
      expect(stderrLines.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// makeCliSink — json:false → human output (may be stdout or stderr for TTY)
// ---------------------------------------------------------------------------

describe('makeCliSink — json:false emits readable output', () => {
  let allOutput: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    allOutput = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      allOutput.push(String(chunk));
      return true;
    });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      allOutput.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('emits output for task-start event', () => {
    const sink = makeCliSink({ json: false });
    sink(makeEvent('task-start', { taskId: 'task-1', text: 'Kicking off task' }));
    expect(allOutput.length).toBeGreaterThan(0);
  });

  it('emits output for model-delta event (incremental text)', () => {
    const sink = makeCliSink({ json: false });
    sink(makeEvent('model-delta', { text: 'Hello, ' }));
    sink(makeEvent('model-delta', { text: 'world!' }));
    expect(allOutput.length).toBeGreaterThan(0);
    const joined = allOutput.join('');
    // The text payload should appear somewhere in the output
    expect(joined).toContain('Hello, ');
  });

  it('emits output for task-done event', () => {
    const sink = makeCliSink({ json: false });
    sink(makeEvent('task-done', { taskId: 'task-1', text: 'Completed.' }));
    expect(allOutput.length).toBeGreaterThan(0);
  });

  it('emits output for retry event', () => {
    const sink = makeCliSink({ json: false });
    sink(makeEvent('retry', { taskId: 'task-1', data: { attempt: 2, delayMs: 100 } }));
    expect(allOutput.length).toBeGreaterThan(0);
  });

  it('emits output for verify event', () => {
    const sink = makeCliSink({ json: false });
    sink(makeEvent('verify', { data: { ok: false, reason: 'off-topic' } }));
    expect(allOutput.length).toBeGreaterThan(0);
  });

  it('emits output for log event', () => {
    const sink = makeCliSink({ json: false });
    sink(makeEvent('log', { text: 'Something informational happened' }));
    expect(allOutput.length).toBeGreaterThan(0);
  });

  it('emits output for tool-call event', () => {
    const sink = makeCliSink({ json: false });
    sink(makeEvent('tool-call', { taskId: 'task-1', text: 'list_files', data: { args: {} } }));
    expect(allOutput.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Sink never throws — robustness
// ---------------------------------------------------------------------------

describe('makeCliSink — never throws', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('does not throw for any event kind (json:true)', () => {
    const sink = makeCliSink({ json: true });
    for (const kind of ALL_KINDS) {
      expect(() =>
        sink(makeEvent(kind, { text: 'msg', taskId: 'task-x', data: { nested: true } })),
      ).not.toThrow();
    }
  });

  it('does not throw for any event kind (json:false)', () => {
    const sink = makeCliSink({ json: false });
    for (const kind of ALL_KINDS) {
      expect(() =>
        sink(makeEvent(kind, { text: 'msg', taskId: 'task-x', data: {} })),
      ).not.toThrow();
    }
  });

  it('handles event with no text or data without throwing', () => {
    const sink = makeCliSink({ json: true });
    expect(() => sink({ kind: 'log', ts: new Date().toISOString() })).not.toThrow();
    expect(() =>
      sink({ kind: 'task-start', taskId: 'task-1', ts: new Date().toISOString() }),
    ).not.toThrow();
  });

  it('handles event with undefined taskId without throwing', () => {
    const sink = makeCliSink({ json: false });
    expect(() =>
      sink({ kind: 'task-done', ts: new Date().toISOString(), text: 'done' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SECURITY: secret values must never appear in emitted output
// ---------------------------------------------------------------------------

describe('makeCliSink — security: no secret values in output', () => {
  it('does not echo secret-looking data values to any output stream', () => {
    const outputLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      outputLines.push(String(chunk));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      outputLines.push(String(chunk));
      return true;
    });

    const secretValue = 'sk-ant-api03-SUPERSECRET1234567890abcdef';
    const sink = makeCliSink({ json: true });

    // Even if a data payload carries a secret (defensive test), the sink
    // should not blindly print raw JSON of arbitrary data containing secrets.
    // The sink is responsible for what it renders.
    sink(
      makeEvent('log', {
        text: 'Task completed',
        // data intentionally carries a secret field to stress-test the sink
        data: { info: 'tool-result', secret: secretValue },
      }),
    );

    const joined = outputLines.join('');
    // The sink must NOT emit the raw secret value verbatim.
    // (It may emit the key name or a redacted placeholder, but not the value.)
    expect(joined).not.toContain(secretValue);

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// StreamSink type shape — verify the exported type contract
// ---------------------------------------------------------------------------

describe('makeCliSink — exported type', () => {
  it('makeCliSink returns a callable function (StreamSink)', () => {
    const sink = makeCliSink({ json: true });
    expect(typeof sink).toBe('function');
  });

  it('nullSink returns a callable function (StreamSink)', () => {
    const sink = nullSink();
    expect(typeof sink).toBe('function');
  });
});

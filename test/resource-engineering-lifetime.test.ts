import { describe, expect, it, vi } from 'vitest';
import { captureResourceEngineeringLifetime } from '../src/core/resources/engineering-lifetime.js';
import { performance } from 'node:perf_hooks';

describe('host engineering lifetime capture', () => {
  it('pins the original deadline and refuses wall-clock rollback extending its budget', () => {
    const now = Date.now(); const monotonic = performance.now();
    const wall = vi.spyOn(Date, 'now').mockReturnValue(now);
    const steady = vi.spyOn(performance, 'now').mockReturnValue(monotonic);
    try {
      const input = { deadlineAt: new Date(now + 1000).toISOString() };
      const captured = captureResourceEngineeringLifetime({ engineeringLifetime: input });
      expect(captured.isStopped()).toBe(false);
      input.deadlineAt = new Date(now + 100_000).toISOString();
      expect(captured.deadlineAt).toBe(new Date(now + 1000).toISOString());
      wall.mockReturnValue(now - 100_000); steady.mockReturnValue(monotonic + 1001);
      expect(captured.isStopped()).toBe(true);
    } finally { wall.mockRestore(); steady.mockRestore(); }
  });
  it.each([undefined, null, 123, 'tomorrow', '2026-09-13'])('rejects malformed explicit deadlines %#', deadlineAt => {
    expect(() => captureResourceEngineeringLifetime({ engineeringLifetime: { deadlineAt } })).toThrow('deadline');
  });
  it('keeps omission inert and captures child signal without mutating host state', () => {
    const host = new AbortController(); const child = new AbortController();
    expect(captureResourceEngineeringLifetime({ signal: host.signal }).isStopped()).toBe(false);
    const captured = captureResourceEngineeringLifetime({ signal: host.signal, engineeringLifetime: { signal: child.signal } });
    expect(captured.configured).toBe(true); expect(captured.isStopped()).toBe(false);
    child.abort(); expect(captured.isStopped()).toBe(true); expect(host.signal.aborted).toBe(false);
  });
  it('pins the callback reference while reading its current synchronous value', () => {
    let stop = false; const input = { isExecutionStopped: () => stop };
    const value = captureResourceEngineeringLifetime({ engineeringLifetime: input });
    input.isExecutionStopped = () => true; expect(value.isStopped()).toBe(false);
    stop = true; expect(value.isStopped()).toBe(true);
  });
  it.each([undefined, null, 1, [], { signal: {} }, { unexpected: true }, { isExecutionStopped: false }])('rejects malformed child control %#', value => {
    expect(() => captureResourceEngineeringLifetime({ engineeringLifetime: value })).toThrow();
  });
  it('never invokes lifetime or nested accessors', () => {
    const get = vi.fn(() => false);
    for (const input of [Object.defineProperty({}, 'engineeringLifetime', { get }),
      { engineeringLifetime: Object.defineProperty({}, 'signal', { get }) },
      { engineeringLifetime: Object.defineProperty({}, 'isExecutionStopped', { get }) },
      { engineeringLifetime: Object.defineProperty({}, 'deadlineAt', { get }) },
      Object.create({ engineeringLifetime: {} })]) expect(() => captureResourceEngineeringLifetime(input)).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it.each([() => true, () => { throw Error('private failure'); }, () => undefined, () => Promise.reject(Error('private failure'))])('withholds on a non-false or failing veto %#', async veto => {
    const value = captureResourceEngineeringLifetime({ engineeringLifetime: { isExecutionStopped: veto } });
    expect(value.isStopped()).toBe(true); await Promise.resolve();
  });
});

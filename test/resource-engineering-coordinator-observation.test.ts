import { describe, expect, it } from 'vitest';
import { readEngineeringCoordinatorObservation } from '../src/core/resources/engineering-coordinator-observation.js';
const base = { schemaVersion: 1, supervisionId: 'automatic', configDigest: 'a'.repeat(64),
  deadlineAt: '2099-01-01T00:00:00.000Z', sequence: 1, reportedAt: '2026-09-11T00:00:00.000Z', state: 'idle', reason: null };
describe('closed coordinator telemetry contract', () => {
  it.each([
    ['idle', null], ['running', null], ['closing', null], ['closed', null],
    ['held', 'execution-guard-refused'], ['held', 'signal-aborted'], ['timed-out', 'deadline-reached'],
    ['faulted', 'coordinator-loop-failed'], ['faulted', 'close-unresolved'], ['faulted', 'ownership-release-failed'],
  ])('accepts only known state/reason pair %s %s', (state, reason) => {
    const row = { ...base, state, reason }; expect(readEngineeringCoordinatorObservation(row, base)).toEqual(row);
    expect(readEngineeringCoordinatorObservation(row, base)).not.toBe(row);
  });
  it('rejects private, inherited, symbolic, accessor and unknown fields without reading a getter', () => {
    let reads = 0;
    const getter = { ...base }; Object.defineProperty(getter, 'state', { get() { reads++; return 'idle'; } });
    const inherited = Object.assign(Object.create({ secret: true }), base);
    for (const row of [getter, inherited, { ...base, [Symbol('secret')]: true }, { ...base, private: true },
      { ...base, state: '__proto__' }, { ...base, reason: 'exception text' }, { ...base, reportedAt: '2026-09-11' },
      { ...base, configDigest: 'no' }, { ...base, supervisionId: '../escape' }]) {
      expect(readEngineeringCoordinatorObservation(row)).toBeNull();
    }
    expect(reads).toBe(0);
  });
});

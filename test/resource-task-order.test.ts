import { describe, expect, it } from 'vitest';
import { compareResourceTaskRows, hasResourceTaskOccupancy } from '../src/web-ui/routes/resources/task-order.js';
import type { ResourceTaskOrderRow } from '../src/web-ui/routes/resources/task-order.js';

const early = '2026-09-07T11:00:00.000Z';
const late = '2026-09-07T12:00:00.000Z';
const receiptStates = ['reserved', 'uncertain', 'completed', 'failed', 'cancelled', 'timed-out'] as const;

describe('resource task occupancy', () => {
  it.each(['queued', 'dispatching', 'unresolved'])('keeps %s supervisor work active with any receipt sample', (state) => {
    for (const status of receiptStates) {
      expect(hasResourceTaskOccupancy({ job: { state, updatedAt: early }, receipt: { status, startedAt: late } })).toBe(true);
    }
    expect(hasResourceTaskOccupancy({ job: { state, updatedAt: early } })).toBe(true);
  });

  it.each(['settled', 'cancelled'])('retains independent receipt occupancy after %s supervisor work', (state) => {
    for (const status of receiptStates) {
      const row = { job: { state, outcome: 'completed', updatedAt: late }, receipt: { status, startedAt: early } };
      expect(hasResourceTaskOccupancy(row), status).toBe(status === 'reserved' || status === 'uncertain');
    }
    expect(hasResourceTaskOccupancy({ job: { state, updatedAt: late } })).toBe(false);
  });

  it.each(receiptStates)('uses %s receipt occupancy without a supervisor', (status) => {
    expect(hasResourceTaskOccupancy({ receipt: { status, startedAt: early } })).toBe(status === 'reserved' || status === 'uncertain');
  });

  it('does not invent occupancy without either observation', () => {
    expect(hasResourceTaskOccupancy({})).toBe(false);
  });

  it.each(['reserved', 'uncertain', 'unresolved'])('preserves active primary outcome %s compatibility', (outcome) => {
    expect(hasResourceTaskOccupancy({ job: { state: 'settled', outcome, updatedAt: early } })).toBe(true);
  });

  it('keeps null and missing settled outcomes inactive without an occupied receipt', () => {
    expect(hasResourceTaskOccupancy({ job: { state: 'settled', outcome: null, updatedAt: early } })).toBe(false);
    expect(hasResourceTaskOccupancy({ job: { state: 'settled', updatedAt: early } })).toBe(false);
  });
});

describe('resource task ordering', () => {
  const occupied = { job: { state: 'settled', outcome: 'completed', updatedAt: early }, receipt: { status: 'uncertain', startedAt: early } };
  const terminal = { receipt: { status: 'completed', startedAt: late } };

  it('orders occupied samples ahead of newer terminal history in both comparison directions', () => {
    expect(compareResourceTaskRows(occupied, terminal)).toBeLessThan(0);
    expect(compareResourceTaskRows(terminal, occupied)).toBeGreaterThan(0);
  });

  it('preserves supervisor timestamp precedence over a newer receipt', () => {
    const olderJob = { job: { state: 'settled', updatedAt: early }, receipt: { status: 'completed', startedAt: late } };
    expect(compareResourceTaskRows(olderJob, terminal)).toBeGreaterThan(0);
  });

  it('orders newest first within either occupancy bucket', () => {
    for (const status of ['completed', 'reserved']) {
      expect(compareResourceTaskRows({ receipt: { status, startedAt: late } }, { receipt: { status, startedAt: early } })).toBeLessThan(0);
    }
  });

  it('keeps equal timestamps stable and missing timestamps last without mutating frozen input', () => {
    const a = Object.freeze({ receipt: Object.freeze({ status: 'completed', startedAt: late }) });
    const b = Object.freeze({ receipt: Object.freeze({ status: 'failed', startedAt: late }) });
    const rows: readonly ResourceTaskOrderRow[] = Object.freeze([Object.freeze({}), a, b]);
    expect(compareResourceTaskRows(a, b)).toBe(0);
    expect(compareResourceTaskRows({}, {})).toBe(0);
    expect([...rows].sort(compareResourceTaskRows)).toEqual([a, b, {}]);
    expect(rows).toEqual([{}, a, b]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createPaymentBrokerState, reducePaymentBroker, type PaymentBrokerState, type PaymentBrokerPolicy,
  type PaymentBrokerRequest, type PaymentBrokerEntry } from '../src/core/universe/payment-broker.js';

const DAY = 86_400_000;
const policy = (): PaymentBrokerPolicy => ({ schemaVersion: 1, policyId: 'limited-simulation', currency: 'USD',
  allowedMerchantIds: ['merchant-a'], allowedScopeIds: ['hub-tests'], maxPerRequestMinor: 80, maxPerDayMinor: 100 });
const request = (requestId = 'request-a', amountMinor = 60): PaymentBrokerRequest => ({ requestId, amountMinor,
  merchantId: 'merchant-a', scopeId: 'hub-tests', currency: 'USD' });
function ask(state: PaymentBrokerState, value = request(), nowMs = state.highWaterMs, rules = policy()) {
  return reducePaymentBroker(state, rules, { schemaVersion: 1, kind: 'request', nowMs, request: value });
}
function reserve(state: PaymentBrokerState, requestId = 'request-a', nowMs = state.highWaterMs, rules = policy()) {
  return reducePaymentBroker(state, rules, { schemaVersion: 1, kind: 'reserve', nowMs, requestId,
    requestDigest: state.entries.find((entry) => entry.request.requestId === requestId)!.requestDigest });
}
function settle(state: PaymentBrokerState, outcome: 'succeeded' | 'failed' | 'unknown', nowMs = state.highWaterMs, rules = policy(), requestId = 'request-a') {
  const entry = state.entries.find((row) => row.request.requestId === requestId)!;
  return reducePaymentBroker(state, rules, { schemaVersion: 1, kind: 'settle', nowMs, requestId,
    requestDigest: entry.requestDigest, reservationDigest: entry.reservationDigest, outcome });
}
const initial = () => createPaymentBrokerState(policy(), 0);
const reserved = () => reserve(ask(initial()).state).state;
const copied = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('deterministic payment broker simulation', () => {
  it('records a request without reserving or transferring, then reserves under policy', () => {
    const start = initial(); const asked = ask(start);
    expect(asked.receipt).toMatchObject({ decision: 'requested', chargedMinor: 0, effect: 'none', simulation: true });
    const accepted = reserve(asked.state);
    expect(accepted.receipt).toMatchObject({ decision: 'reserved', chargedMinor: 60, remainingMinor: 40, effect: 'none' });
    expect(start.entries).toEqual([]); expect(asked.state.entries[0]!.status).toBe('requested');
    expect(accepted.receipt.reservationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(accepted.receipt.previousStateDigest).toBe(asked.receipt.nextStateDigest);
  });

  it('returns deterministic deeply frozen next state and receipts', () => {
    const left = ask(initial()); const right = ask(initial()); expect(left).toEqual(right);
    for (const object of [left, left.state, left.state.entries, left.state.entries[0], left.state.entries[0]!.request, left.receipt]) {
      expect(Object.isFrozen(object)).toBe(true);
    }
    expect(() => { left.state.entries[0]!.request.amountMinor = 1; }).toThrow();
    expect(() => left.state.entries.push({} as PaymentBrokerEntry)).toThrow();
  });

  it('prevents sequential double spending by concurrent-looking requests', () => {
    const a = ask(initial()); const b = ask(a.state, request('request-b'));
    const first = reserve(b.state); const second = reserve(first.state, 'request-b');
    expect(first.receipt.decision).toBe('reserved');
    expect(second.receipt).toMatchObject({ decision: 'denied', reason: 'day-cap', chargedMinor: 60 });
    expect(second.state.entries).toHaveLength(2);
  });

  it('replays request/reservation/settlement without double charging', () => {
    const state = reserved(); const replayRequest = ask(state);
    expect(replayRequest.state).toEqual(state); expect(replayRequest.receipt.replayed).toBe(true);
    const replayReserve = reserve(replayRequest.state);
    expect(replayReserve.state).toEqual(state); expect(replayReserve.receipt.chargedMinor).toBe(60);
    const paid = settle(state, 'succeeded'); const replayPaid = settle(paid.state, 'succeeded');
    expect(replayPaid.state).toEqual(paid.state); expect(replayPaid.receipt.replayed).toBe(true);
    expect(replayPaid.receipt).toMatchObject({ decision: 'settled', effect: 'none', chargedMinor: 60 });
  });

  it.each([{ amountMinor: 1 }, { merchantId: 'other' }, { scopeId: 'other' }, { currency: 'EUR' }])('refuses altered request identity: %j', (changes) => {
    const state = reserved(); const result = ask(state, { ...request(), ...changes });
    expect(result.receipt).toMatchObject({ decision: 'rejected', reason: 'request-conflict' });
    expect(result.state).toEqual(state);
  });

  it.each([
    [{ merchantId: 'other' }, 'merchant-not-allowed'], [{ scopeId: 'other' }, 'scope-not-allowed'],
    [{ currency: 'EUR' }, 'currency-not-allowed'], [{ amountMinor: 81 }, 'request-cap'],
  ] as const)('denies out-of-policy requests: %j', (changes, reason) => {
    const result = ask(initial(), { ...request(), ...changes });
    expect(result.receipt).toMatchObject({ decision: 'denied', reason, chargedMinor: 0 });
    expect(reserve(result.state).receipt).toMatchObject({ decision: 'denied', replayed: true, chargedMinor: 0 });
  });

  it('holds failures and unknown settlements indefinitely, including after rollover', () => {
    for (const outcome of ['failed', 'unknown'] as const) {
      const held = settle(reserved(), outcome);
      expect(held.receipt).toMatchObject({ decision: 'held', chargedMinor: 60 });
      const nextDay = ask(held.state, request('request-b', 50), DAY * 10);
      expect(reserve(nextDay.state, 'request-b').receipt).toMatchObject({ decision: 'denied', reason: 'day-cap', chargedMinor: 60 });
      expect(settle(held.state, 'succeeded').receipt.reason).toBe('settlement-conflict');
      expect(settle(held.state, outcome).receipt.replayed).toBe(true);
    }
  });

  it('carries outstanding reservations into a new day without charging them twice', () => {
    const next = ask(reserved(), request('request-b', 40), DAY);
    const result = reserve(next.state, 'request-b');
    expect(result.receipt).toMatchObject({ chargedMinor: 100, remainingMinor: 0 });
    expect(result.state.entries[0]!.reservedAtMs).toBe(0);
    expect(result.state.dayIndex).toBe(1);
    expect(reserve(result.state).receipt).toMatchObject({ chargedMinor: 100, replayed: true });
  });

  it('does not bank downtime and retains historical IDs after successful settlement', () => {
    const paid = settle(reserved(), 'succeeded');
    const next = ask(paid.state, request('request-b', 80), DAY * 100);
    const second = reserve(next.state, 'request-b');
    const third = ask(second.state, request('request-c', 30));
    expect(reserve(third.state, 'request-c').receipt).toMatchObject({ reason: 'day-cap', chargedMinor: 80 });
    expect(ask(second.state).receipt).toMatchObject({ decision: 'settled', replayed: true, chargedMinor: 80 });
    expect(ask(second.state).state.entries).toHaveLength(2);
  });

  it('cannot use deny as a refund or reopen a denied ID', () => {
    const asked = ask(initial()); const entry = asked.state.entries[0]!;
    const action = { schemaVersion: 1, kind: 'deny', nowMs: 0, requestId: 'request-a', requestDigest: entry.requestDigest };
    const denied = reducePaymentBroker(asked.state, policy(), action);
    expect(denied.receipt).toMatchObject({ decision: 'denied', reason: 'caller-denied', chargedMinor: 0 });
    expect(reserve(denied.state).receipt.decision).toBe('denied');
    expect(reducePaymentBroker(reserved(), policy(), action).receipt).toMatchObject({ decision: 'rejected', chargedMinor: 60 });
    expect(reducePaymentBroker(settle(reserved(), 'unknown').state, policy(), action).receipt.chargedMinor).toBe(60);
  });

  it('requires the exact request and reservation digest for settlement', () => {
    const state = reserved(); const entry = state.entries[0]!;
    for (const changed of [{ requestDigest: 'b'.repeat(64) }, { reservationDigest: 'b'.repeat(64) }]) {
      const result = reducePaymentBroker(state, policy(), { schemaVersion: 1, kind: 'settle', nowMs: 0, requestId: 'request-a',
        requestDigest: entry.requestDigest, reservationDigest: entry.reservationDigest, outcome: 'succeeded', ...changed });
      expect(result.receipt.decision).toBe('rejected'); expect(result.state).toEqual(state);
    }
  });

  it('does not settle an unreserved request', () => {
    const state = ask(initial()).state;
    expect(reducePaymentBroker(state, policy(), { schemaVersion: 1, kind: 'settle', nowMs: 0, requestId: 'request-a',
      requestDigest: state.entries[0]!.requestDigest, reservationDigest: 'b'.repeat(64), outcome: 'succeeded' }).receipt.decision).toBe('rejected');
  });

  it.each([-1, -0, NaN, Infinity, 0.5, '0', 253_402_300_800_000])('rejects malformed clock %s', (nowMs) => {
    expect(() => reducePaymentBroker(initial(), policy(), { schemaVersion: 1, kind: 'request', nowMs, request: request() })).toThrow('Invalid payment broker input');
  });

  it('rejects clock rollback without refreshing state or allowances', () => {
    const state = ask(initial(), request(), DAY).state;
    const result = reserve(state, 'request-a', 0);
    expect(result.state).toEqual(state); expect(result.receipt.reason).toBe('clock-reversal');
    expect(result.receipt.chargedMinor).toBe(0);
  });

  it('checks integer overflow and caps at MAX_SAFE_INTEGER', () => {
    const rules = { ...policy(), maxPerRequestMinor: Number.MAX_SAFE_INTEGER, maxPerDayMinor: Number.MAX_SAFE_INTEGER };
    const start = createPaymentBrokerState(rules, 0);
    const a = ask(start, request('request-a', Number.MAX_SAFE_INTEGER), 0, rules);
    const full = reserve(a.state, 'request-a', 0, rules);
    const b = ask(full.state, request('request-b', 1), 0, rules);
    expect(reserve(b.state, 'request-b', 0, rules).receipt).toMatchObject({ reason: 'day-cap', remainingMinor: 0 });
    const paid = settle(full.state, 'succeeded', 0, rules);
    const next = ask(paid.state, request('request-b', Number.MAX_SAFE_INTEGER), DAY, rules);
    expect(reserve(next.state, 'request-b', DAY, rules).receipt.chargedMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => ask(start, request('request-a', Number.MAX_SAFE_INTEGER + 1), 0, rules)).toThrow();
  });

  it.each([0, -1, 0.1, NaN, Infinity, '10'])('rejects invalid minor-unit amount %s', (amountMinor) => {
    expect(() => ask(initial(), { ...request(), amountMinor } as PaymentBrokerRequest)).toThrow();
  });

  it('refuses unknown fields, signatures, approval flags and void outcomes', () => {
    for (const extra of [{ approved: true }, { signature: 'not-authority' }, { [Symbol('hidden')]: true }]) {
      expect(() => reducePaymentBroker(initial(), policy(), { schemaVersion: 1, kind: 'request', nowMs: 0, request: request(), ...extra })).toThrow();
    }
    const entry = reserved().entries[0]!;
    for (const outcome of ['void', 'refund', 'approved', null, undefined]) {
      expect(() => reducePaymentBroker(reserved(), policy(), { schemaVersion: 1, kind: 'settle', nowMs: 0, requestId: 'request-a',
        requestDigest: entry.requestDigest, reservationDigest: entry.reservationDigest, outcome })).toThrow();
    }
  });

  it('never invokes accessors in policy, request, action or ledger arrays', () => {
    const getter = vi.fn(() => 1);
    const rules = policy(); Object.defineProperty(rules, 'maxPerDayMinor', { get: getter });
    expect(() => createPaymentBrokerState(rules, 0)).toThrow();
    const value = request(); Object.defineProperty(value, 'amountMinor', { get: getter });
    expect(() => ask(initial(), value)).toThrow();
    const action = { schemaVersion: 1, kind: 'request', nowMs: 0, request: request() };
    Object.defineProperty(action, 'kind', { get: getter });
    expect(() => reducePaymentBroker(initial(), policy(), action)).toThrow();
    const state = copied(reserved()); Object.defineProperty(state.entries, '0', { get: getter });
    expect(() => ask(state)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });

  it('refuses sparse arrays, duplicate IDs, corrupted reservation and day metadata', () => {
    const state = reserved();
    for (const malformed of [
      { ...state, entries: new Array(1) }, { ...state, entries: [...state.entries, ...state.entries] },
      { ...state, dayIndex: 1 }, { ...state, entries: [{ ...state.entries[0], reservationDigest: 'b'.repeat(64) }] },
      { ...state, entries: [{ ...state.entries[0], reservedAtMs: 1 }] },
      { ...state, entries: [{ ...state.entries[0], status: 'settled' }] },
    ]) expect(() => reducePaymentBroker(malformed, policy(), { schemaVersion: 1, kind: 'request', nowMs: 0, request: request() })).toThrow();
  });

  it('rejects policy drift but normalizes allowlist ordering', () => {
    expect(() => ask(reserved(), request(), 0, { ...policy(), maxPerDayMinor: 101 })).toThrow();
    const rules = { ...policy(), allowedMerchantIds: ['merchant-b', 'merchant-a'] };
    expect(createPaymentBrokerState(rules, 0)).toEqual(createPaymentBrokerState({ ...rules, allowedMerchantIds: ['merchant-a', 'merchant-b'] }, 0));
    expect(() => createPaymentBrokerState({ ...rules, allowedMerchantIds: ['merchant-a', 'merchant-a'] }, 0)).toThrow();
  });

  it('bounds the ledger without deleting idempotency history', () => {
    let state = initial();
    for (let index = 0; index < 512; index++) state = ask(state, request(`request-${index}`)).state;
    const result = ask(state, request('overflow'));
    expect(result.receipt).toMatchObject({ decision: 'rejected', reason: 'ledger-capacity' });
    expect(result.state.entries).toHaveLength(512);
    expect(ask(result.state, request('request-0')).receipt.replayed).toBe(true);
  });
});

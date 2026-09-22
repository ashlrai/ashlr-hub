import { createHash } from 'node:crypto';

export const PAYMENT_BROKER_MAX_ENTRIES = 512;
const DAY_MS = 86_400_000;
const MAX_CLOCK = 253_402_300_799_999;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

export interface PaymentBrokerPolicy {
  schemaVersion: 1; policyId: string; currency: string; allowedMerchantIds: string[]; allowedScopeIds: string[];
  maxPerRequestMinor: number; maxPerDayMinor: number;
}
export interface PaymentBrokerRequest { requestId: string; merchantId: string; scopeId: string; currency: string; amountMinor: number }
export type PaymentBrokerDenial = 'merchant-not-allowed' | 'scope-not-allowed' | 'currency-not-allowed' | 'request-cap' | 'day-cap' | 'caller-denied';
export interface PaymentBrokerEntry {
  request: PaymentBrokerRequest; requestDigest: string; status: 'requested' | 'denied' | 'reserved' | 'settled' | 'held';
  requestedAtMs: number; reservedAtMs: number | null; settledAtMs: number | null;
  reservationDigest: string | null; settlement: 'succeeded' | 'failed' | 'unknown' | null; denial: PaymentBrokerDenial | null;
}
export interface PaymentBrokerState {
  schemaVersion: 1; policyDigest: string; dayIndex: number; highWaterMs: number; entries: PaymentBrokerEntry[];
}
export type PaymentBrokerAction =
  { schemaVersion: 1; kind: 'request'; nowMs: number; request: PaymentBrokerRequest } |
  { schemaVersion: 1; kind: 'reserve' | 'deny'; nowMs: number; requestId: string; requestDigest: string } |
  { schemaVersion: 1; kind: 'settle'; nowMs: number; requestId: string; requestDigest: string;
    reservationDigest: string; outcome: 'succeeded' | 'failed' | 'unknown' };
export interface PaymentBrokerReceipt {
  schemaVersion: 1; simulation: true; effect: 'none'; policyDigest: string; requestId: string;
  requestDigest: string; reservationDigest: string | null; atMs: number;
  decision: PaymentBrokerEntry['status'] | 'rejected'; reason: string; replayed: boolean;
  chargedMinor: number; remainingMinor: number; previousStateDigest: string; nextStateDigest: string;
}

function invalid(): never { throw new Error('Invalid payment broker input'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !own.every((key) => typeof key === 'string' && keys.includes(key))) invalid();
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    copy.push(descriptor.value);
  }
  return copy;
}
function identifier(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) invalid(); return value; }
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) invalid(); return value; }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) invalid();
  return value;
}
function currency(value: unknown): string { if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) invalid(); return value; }
function checkedAdd(left: number, right: number): number {
  if (left > Number.MAX_SAFE_INTEGER - right) invalid();
  return left + right;
}
function digest(domain: string, value: unknown): string {
  // Only normalized records with a fixed field order reach this encoder.
  return createHash('sha256').update(JSON.stringify([domain, value])).digest('hex');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function policyInput(value: unknown): PaymentBrokerPolicy {
  const row = object(value, ['schemaVersion', 'policyId', 'currency', 'allowedMerchantIds', 'allowedScopeIds', 'maxPerRequestMinor', 'maxPerDayMinor']);
  if (row.schemaVersion !== 1) invalid();
  const list = (value: unknown): string[] => {
    const items = array(value, 128).map(identifier).sort();
    if (!items.length || new Set(items).size !== items.length) invalid();
    return items;
  };
  const policy: PaymentBrokerPolicy = { schemaVersion: 1, policyId: identifier(row.policyId), currency: currency(row.currency),
    allowedMerchantIds: list(row.allowedMerchantIds), allowedScopeIds: list(row.allowedScopeIds),
    maxPerRequestMinor: integer(row.maxPerRequestMinor, 1), maxPerDayMinor: integer(row.maxPerDayMinor, 1) };
  if (policy.maxPerRequestMinor > policy.maxPerDayMinor) invalid();
  return policy;
}
function requestInput(value: unknown): PaymentBrokerRequest {
  const row = object(value, ['requestId', 'merchantId', 'scopeId', 'currency', 'amountMinor']);
  return { requestId: identifier(row.requestId), merchantId: identifier(row.merchantId), scopeId: identifier(row.scopeId),
    currency: currency(row.currency), amountMinor: integer(row.amountMinor, 1) };
}
function requestDigest(policyDigest: string, request: PaymentBrokerRequest): string {
  return digest('payment-broker-request-v1', { policyDigest, request });
}
function reservationDigest(policyDigest: string, entry: PaymentBrokerEntry): string {
  return digest('payment-broker-reservation-v1', { policyDigest, requestDigest: entry.requestDigest, reservedAtMs: entry.reservedAtMs });
}
function denial(policy: PaymentBrokerPolicy, request: PaymentBrokerRequest): PaymentBrokerDenial | null {
  if (request.currency !== policy.currency) return 'currency-not-allowed';
  if (!policy.allowedMerchantIds.includes(request.merchantId)) return 'merchant-not-allowed';
  if (!policy.allowedScopeIds.includes(request.scopeId)) return 'scope-not-allowed';
  return request.amountMinor > policy.maxPerRequestMinor ? 'request-cap' : null;
}
/** Outstanding reservations carry into each observed day, in addition to that day's settled charges. */
function charged(entries: PaymentBrokerEntry[], day: number): number {
  return entries.reduce((sum, entry) => entry.reservedAtMs !== null &&
    (entry.status === 'reserved' || entry.status === 'held' || Math.floor(entry.reservedAtMs / DAY_MS) === day)
    ? checkedAdd(sum, entry.request.amountMinor) : sum, 0);
}
function stateInput(value: unknown, policy: PaymentBrokerPolicy, policyDigest: string): PaymentBrokerState {
  const row = object(value, ['schemaVersion', 'policyDigest', 'dayIndex', 'highWaterMs', 'entries']);
  if (row.schemaVersion !== 1 || row.policyDigest !== policyDigest) invalid();
  const highWaterMs = integer(row.highWaterMs, 0, MAX_CLOCK);
  const dayIndex = integer(row.dayIndex);
  if (dayIndex !== Math.floor(highWaterMs / DAY_MS)) invalid();
  const ids = new Set<string>(); const daily = new Map<number, number>();
  const entries = array(row.entries, PAYMENT_BROKER_MAX_ENTRIES).map((item): PaymentBrokerEntry => {
    const entry = object(item, ['request', 'requestDigest', 'status', 'requestedAtMs', 'reservedAtMs', 'settledAtMs', 'reservationDigest', 'settlement', 'denial']);
    const request = requestInput(entry.request);
    if (ids.has(request.requestId)) invalid(); ids.add(request.requestId);
    const requestedAtMs = integer(entry.requestedAtMs, 0, highWaterMs);
    const reservedAtMs = entry.reservedAtMs === null ? null : integer(entry.reservedAtMs, requestedAtMs, highWaterMs);
    const settledAtMs = entry.settledAtMs === null ? null : integer(entry.settledAtMs, reservedAtMs ?? requestedAtMs, highWaterMs);
    if (entry.requestDigest !== requestDigest(policyDigest, request) || typeof entry.status !== 'string' ||
        !['requested', 'denied', 'reserved', 'settled', 'held'].includes(entry.status)) invalid();
    const normalized: PaymentBrokerEntry = { request, requestDigest: hash(entry.requestDigest), status: entry.status as PaymentBrokerEntry['status'],
      requestedAtMs, reservedAtMs, settledAtMs, reservationDigest: entry.reservationDigest === null ? null : hash(entry.reservationDigest),
      settlement: entry.settlement as PaymentBrokerEntry['settlement'], denial: entry.denial as PaymentBrokerDenial | null };
    if (normalized.status === 'requested' || normalized.status === 'denied') {
      if (reservedAtMs !== null || settledAtMs !== null || normalized.reservationDigest !== null || normalized.settlement !== null) invalid();
      if (normalized.status === 'requested' && (normalized.denial !== null || denial(policy, request) !== null)) invalid();
      if (normalized.status === 'denied' && (typeof normalized.denial !== 'string' ||
          !['merchant-not-allowed', 'scope-not-allowed', 'currency-not-allowed', 'request-cap', 'day-cap', 'caller-denied'].includes(normalized.denial))) invalid();
      if (normalized.status === 'denied') {
        const expected = denial(policy, request);
        if (expected !== null ? normalized.denial !== expected : !['day-cap', 'caller-denied'].includes(normalized.denial!)) invalid();
      }
    } else {
      if (reservedAtMs === null || normalized.reservationDigest !== reservationDigest(policyDigest, normalized) ||
          normalized.denial !== null || denial(policy, request) !== null) invalid();
      if (normalized.status === 'reserved' && (normalized.settlement !== null || settledAtMs !== null)) invalid();
      if (normalized.status === 'settled' && (normalized.settlement !== 'succeeded' || settledAtMs === null)) invalid();
      if (normalized.status === 'held' && (!['failed', 'unknown'].includes(normalized.settlement ?? '') || settledAtMs === null)) invalid();
      const day = Math.floor(reservedAtMs / DAY_MS);
      const used = checkedAdd(daily.get(day) ?? 0, request.amountMinor);
      if (used > policy.maxPerDayMinor) invalid(); daily.set(day, used);
    }
    return normalized;
  });
  if (charged(entries, dayIndex) > policy.maxPerDayMinor) invalid();
  return { schemaVersion: 1, policyDigest, dayIndex, highWaterMs, entries };
}
function actionInput(value: unknown): PaymentBrokerAction {
  // Inspect the discriminator without ever invoking a getter.
  if (value === null || typeof value !== 'object') invalid();
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kind || !Object.hasOwn(kind, 'value') || !['request', 'reserve', 'settle', 'deny'].includes(kind.value)) invalid();
  const keys = kind.value === 'request' ? ['schemaVersion', 'kind', 'nowMs', 'request'] :
    ['schemaVersion', 'kind', 'nowMs', 'requestId', 'requestDigest', ...(kind.value === 'settle' ? ['reservationDigest', 'outcome'] : [])];
  const row = object(value, keys);
  if (row.schemaVersion !== 1) invalid();
  const nowMs = integer(row.nowMs, 0, MAX_CLOCK);
  if (row.kind === 'request') return { schemaVersion: 1, kind: 'request', nowMs, request: requestInput(row.request) };
  const requestId = identifier(row.requestId); const pinned = hash(row.requestDigest);
  if (row.kind === 'settle') {
    if (typeof row.outcome !== 'string' || !['succeeded', 'failed', 'unknown'].includes(row.outcome)) invalid();
    return { schemaVersion: 1, kind: 'settle', nowMs, requestId, requestDigest: pinned,
      reservationDigest: hash(row.reservationDigest), outcome: row.outcome as 'succeeded' | 'failed' | 'unknown' };
  }
  return { schemaVersion: 1, kind: row.kind as 'reserve' | 'deny', nowMs, requestId, requestDigest: pinned };
}

export function createPaymentBrokerState(policy: unknown, nowMs: number): PaymentBrokerState {
  const normalized = policyInput(policy); const at = integer(nowMs, 0, MAX_CLOCK);
  return freeze({ schemaVersion: 1, policyDigest: digest('payment-broker-policy-v1', normalized),
    dayIndex: Math.floor(at / DAY_MS), highWaterMs: at, entries: [] });
}

/**
 * Deterministic simulation only. No rail, signing keys, approval or payment effect.
 * The owner must authenticate facts and atomically persist/CAS the returned state;
 * a pure reducer cannot prevent rollback, parallel forks or fabricated settlements.
 * Every ID is retained: denial and settlement are terminal, and failed/unknown
 * outcomes remain charged indefinitely. There is intentionally NO void/refund
 * path. `deny` can reject an unreserved request only. A succeeded settlement is a
 * supplied simulation fact, never proof that funds moved. Days are UTC epoch days;
 * downtime skips intervals, never banks them. State/policy drift fails closed.
 */
export function reducePaymentBroker(state: unknown, policy: unknown, action: unknown): { state: PaymentBrokerState; receipt: PaymentBrokerReceipt } {
  const normalizedPolicy = policyInput(policy); const pinnedPolicy = digest('payment-broker-policy-v1', normalizedPolicy);
  const next = stateInput(state, normalizedPolicy, pinnedPolicy); const input = actionInput(action);
  const previousStateDigest = digest('payment-broker-state-v1', next);
  const requestId = input.kind === 'request' ? input.request.requestId : input.requestId;
  const pinnedRequest = input.kind === 'request' ? requestDigest(pinnedPolicy, input.request) : input.requestDigest;
  let entry = next.entries.find((item) => item.request.requestId === requestId);
  const finish = (decision: PaymentBrokerReceipt['decision'], reason: string, replayed = false) => {
    const used = charged(next.entries, next.dayIndex);
    return freeze({ state: next, receipt: { schemaVersion: 1 as const, simulation: true as const, effect: 'none' as const,
      policyDigest: pinnedPolicy, requestId, requestDigest: pinnedRequest, reservationDigest: entry?.reservationDigest ?? null,
      atMs: input.nowMs, decision, reason, replayed, chargedMinor: used, remainingMinor: normalizedPolicy.maxPerDayMinor - used,
      previousStateDigest, nextStateDigest: digest('payment-broker-state-v1', next) } });
  };
  if (input.nowMs < next.highWaterMs) return finish('rejected', 'clock-reversal');
  next.highWaterMs = input.nowMs; next.dayIndex = Math.floor(input.nowMs / DAY_MS);
  if (entry && entry.requestDigest !== pinnedRequest) return finish('rejected', 'request-conflict');
  if (input.kind === 'request') {
    if (entry) return finish(entry.status, entry.denial ?? 'request-replayed', true);
    if (next.entries.length >= PAYMENT_BROKER_MAX_ENTRIES) return finish('rejected', 'ledger-capacity');
    const denied = denial(normalizedPolicy, input.request);
    entry = { request: input.request, requestDigest: pinnedRequest, status: denied ? 'denied' : 'requested', requestedAtMs: input.nowMs,
      reservedAtMs: null, settledAtMs: null, reservationDigest: null, settlement: null, denial: denied };
    next.entries.push(entry);
    return finish(entry.status, denied ?? 'request-recorded-not-reserved');
  }
  if (!entry) return finish('rejected', 'request-missing');
  if (input.kind === 'reserve') {
    if (entry.status !== 'requested') return finish(entry.status, entry.denial ?? 'reservation-replayed', true);
    const used = charged(next.entries, next.dayIndex);
    // Subtraction checks capacity without overflowing a sum at MAX_SAFE_INTEGER.
    if (entry.request.amountMinor > normalizedPolicy.maxPerDayMinor - used) {
      entry.status = 'denied'; entry.denial = 'day-cap'; return finish('denied', 'day-cap');
    }
    entry.status = 'reserved'; entry.reservedAtMs = input.nowMs;
    entry.reservationDigest = reservationDigest(pinnedPolicy, entry);
    return finish('reserved', 'reservation-recorded-no-transfer');
  }
  if (input.kind === 'deny') {
    if (entry.status === 'denied') return finish('denied', entry.denial!, true);
    if (entry.status !== 'requested') return finish('rejected', 'reserved-funds-cannot-be-denied');
    entry.status = 'denied'; entry.denial = 'caller-denied'; return finish('denied', 'caller-denied');
  }
  if (input.kind !== 'settle') invalid();
  if (entry.reservationDigest === null || input.reservationDigest !== entry.reservationDigest) return finish('rejected', 'reservation-binding-mismatch');
  if (entry.status !== 'reserved') return entry.settlement === input.outcome
    ? finish(entry.status, 'settlement-replayed', true) : finish('rejected', 'settlement-conflict');
  entry.settlement = input.outcome; entry.settledAtMs = input.nowMs; entry.status = input.outcome === 'succeeded' ? 'settled' : 'held';
  return finish(entry.status, input.outcome === 'succeeded' ? 'simulated-settlement' : 'uncertain-reservation-held');
}

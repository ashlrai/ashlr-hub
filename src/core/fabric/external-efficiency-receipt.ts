/**
 * Observation-only bridge for privacy-preserving efficiency receipts emitted by
 * Ashlr Plugin or Core Efficiency. The bridge accepts exact caller-supplied
 * bytes only: it has no filesystem discovery, provider, or execution seam.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL =
  'ashlr-external-efficiency-receipt-v1' as const;
export const EXTERNAL_EFFICIENCY_RECEIPT_MAX_BYTES = 16 * 1024;
export const EXTERNAL_EFFICIENCY_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const EXTERNAL_EFFICIENCY_RECEIPT_MAX_FUTURE_SKEW_MS = 60_000;
export const EXTERNAL_EFFICIENCY_RECEIPT_DIGEST_DOMAIN =
  'ashlr:external-efficiency-receipt:v1\0';

const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VERSION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const UNSIGNED_KEYS = [
  'accountingMethod', 'calls', 'compactTokens', 'counterfactualSavedTokens',
  'estimatedSavedTokens', 'intervalEndedAt', 'intervalStartedAt',
  'measuredSavedTokens', 'observedAt', 'pricingVersion', 'protocol', 'rawTokens',
  'savedTokens', 'schemaVersion', 'sourceCommit', 'sourceProduct', 'sourceVersion',
] as const;
const RECEIPT_KEYS = [...UNSIGNED_KEYS, 'receiptDigest'] as const;

export type ExternalEfficiencySourceProduct =
  | 'ashlr-plugin'
  | '@ashlr/core-efficiency';

export type ExternalEfficiencyAccountingMethod =
  | 'provider-usage-v1'
  | 'chars-div-4-v1'
  | 'mixed-v1';

export interface ExternalEfficiencyReceiptUnsignedV1 {
  schemaVersion: 1;
  protocol: typeof EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL;
  sourceProduct: ExternalEfficiencySourceProduct;
  sourceVersion: string;
  sourceCommit: string;
  intervalStartedAt: string;
  intervalEndedAt: string;
  observedAt: string;
  calls: number;
  rawTokens: number;
  compactTokens: number;
  savedTokens: number;
  measuredSavedTokens: number;
  estimatedSavedTokens: number;
  counterfactualSavedTokens: number;
  accountingMethod: ExternalEfficiencyAccountingMethod;
  pricingVersion: string;
}

export interface ExternalEfficiencyReceiptV1 extends ExternalEfficiencyReceiptUnsignedV1 {
  receiptDigest: string;
}

export type ExternalEfficiencyReceiptReason =
  | 'efficiency-receipt-accepted'
  | 'invalid-input'
  | 'receipt-not-canonical'
  | 'receipt-schema-invalid'
  | 'source-version-unsupported'
  | 'receipt-arithmetic-invalid'
  | 'receipt-interval-invalid'
  | 'receipt-future'
  | 'receipt-stale'
  | 'receipt-digest-mismatch';

interface ObservationBoundary {
  schemaVersion: 1;
  mode: 'external-efficiency-receipt-observation';
  authority: 'observation-only';
  planningAuthority: false;
  executionAuthority: false;
  effectAuthority: false;
  promotionAuthority: false;
  planningEligible: false;
  executionEligible: false;
  effectEligible: false;
  promotionEligible: false;
}

export type ExternalEfficiencyReceiptObservation = ObservationBoundary & (
  | {
    state: 'accepted';
    reason: 'efficiency-receipt-accepted';
    assurance: 'self-reported-unverified';
    canonicalBytesVerified: true;
    digestVerified: true;
    freshnessVerified: true;
    receiptDigest: string;
    sourceProduct: ExternalEfficiencySourceProduct;
    sourceVersion: string;
    sourceCommit: string;
    intervalStartedAt: string;
    intervalEndedAt: string;
    observedAt: string;
    calls: number;
    rawTokens: number;
    compactTokens: number;
    savedTokens: number;
    measuredSavedTokens: number;
    estimatedSavedTokens: number;
    counterfactualSavedTokens: number;
    accountingMethod: ExternalEfficiencyAccountingMethod;
    pricingVersion: string;
  }
  | {
    state: 'withheld';
    reason: Exclude<ExternalEfficiencyReceiptReason, 'efficiency-receipt-accepted'>;
    assurance: 'unavailable';
    canonicalBytesVerified: false;
    digestVerified: false;
    freshnessVerified: false;
    receiptDigest: null;
    sourceProduct: null;
    sourceVersion: null;
    sourceCommit: null;
    intervalStartedAt: null;
    intervalEndedAt: null;
    observedAt: null;
    calls: null;
    rawTokens: null;
    compactTokens: null;
    savedTokens: null;
    measuredSavedTokens: null;
    estimatedSavedTokens: null;
    counterfactualSavedTokens: null;
    accountingMethod: null;
    pricingVersion: null;
  }
);

function exactPlainRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => !Object.hasOwn(descriptor, 'value'),
  )) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sourceProduct(value: unknown): value is ExternalEfficiencySourceProduct {
  return value === 'ashlr-plugin' || value === '@ashlr/core-efficiency';
}

function accountingMethod(value: unknown): value is ExternalEfficiencyAccountingMethod {
  return value === 'provider-usage-v1' || value === 'chars-div-4-v1' || value === 'mixed-v1';
}

function unsignedStructuralShape(value: unknown): value is ExternalEfficiencyReceiptUnsignedV1 {
  return exactPlainRecord(value, UNSIGNED_KEYS) &&
    value['schemaVersion'] === 1 && value['protocol'] === EXTERNAL_EFFICIENCY_RECEIPT_PROTOCOL &&
    sourceProduct(value['sourceProduct']) && typeof value['sourceVersion'] === 'string' &&
    SEMVER.test(value['sourceVersion']) && typeof value['sourceCommit'] === 'string' &&
    COMMIT.test(value['sourceCommit']) && canonicalIso(value['intervalStartedAt']) &&
    canonicalIso(value['intervalEndedAt']) && canonicalIso(value['observedAt']) &&
    safeCount(value['calls']) && safeCount(value['rawTokens']) && safeCount(value['compactTokens']) &&
    safeCount(value['savedTokens']) && safeCount(value['measuredSavedTokens']) &&
    safeCount(value['estimatedSavedTokens']) && safeCount(value['counterfactualSavedTokens']) &&
    accountingMethod(value['accountingMethod']) && typeof value['pricingVersion'] === 'string' &&
    VERSION_ID.test(value['pricingVersion']);
}

function receiptStructuralShape(value: unknown): value is ExternalEfficiencyReceiptV1 {
  if (!exactPlainRecord(value, RECEIPT_KEYS) || typeof value['receiptDigest'] !== 'string' ||
    !DIGEST.test(value['receiptDigest'])) return false;
  const { receiptDigest: _receiptDigest, ...unsigned } = value;
  return unsignedStructuralShape(unsigned);
}

function sourceVersionSupported(receipt: ExternalEfficiencyReceiptUnsignedV1): boolean {
  const match = SEMVER.exec(receipt.sourceVersion);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (receipt.sourceProduct === 'ashlr-plugin') return major === 1;
  return major === 0 && minor === 3;
}

function arithmeticValid(receipt: ExternalEfficiencyReceiptUnsignedV1): boolean {
  const classifiedSavings = receipt.measuredSavedTokens + receipt.estimatedSavedTokens +
    receipt.counterfactualSavedTokens;
  if (receipt.compactTokens > receipt.rawTokens ||
    receipt.savedTokens !== receipt.rawTokens - receipt.compactTokens ||
    !Number.isSafeInteger(classifiedSavings) || receipt.savedTokens !== classifiedSavings) return false;
  if (receipt.calls === 0 && (
    receipt.rawTokens !== 0 || receipt.compactTokens !== 0 || receipt.savedTokens !== 0
  )) return false;
  if (receipt.accountingMethod === 'provider-usage-v1') {
    return receipt.estimatedSavedTokens === 0 && receipt.counterfactualSavedTokens === 0;
  }
  if (receipt.accountingMethod === 'chars-div-4-v1') return receipt.measuredSavedTokens === 0;
  return true;
}

function intervalValid(receipt: ExternalEfficiencyReceiptUnsignedV1): boolean {
  const startedAt = Date.parse(receipt.intervalStartedAt);
  const endedAt = Date.parse(receipt.intervalEndedAt);
  const observedAt = Date.parse(receipt.observedAt);
  return startedAt < endedAt && endedAt <= observedAt;
}

function unsignedProjection(
  receipt: ExternalEfficiencyReceiptUnsignedV1,
): ExternalEfficiencyReceiptUnsignedV1 {
  return {
    schemaVersion: receipt.schemaVersion,
    protocol: receipt.protocol,
    sourceProduct: receipt.sourceProduct,
    sourceVersion: receipt.sourceVersion,
    sourceCommit: receipt.sourceCommit,
    intervalStartedAt: receipt.intervalStartedAt,
    intervalEndedAt: receipt.intervalEndedAt,
    observedAt: receipt.observedAt,
    calls: receipt.calls,
    rawTokens: receipt.rawTokens,
    compactTokens: receipt.compactTokens,
    savedTokens: receipt.savedTokens,
    measuredSavedTokens: receipt.measuredSavedTokens,
    estimatedSavedTokens: receipt.estimatedSavedTokens,
    counterfactualSavedTokens: receipt.counterfactualSavedTokens,
    accountingMethod: receipt.accountingMethod,
    pricingVersion: receipt.pricingVersion,
  };
}

function receiptProjection(receipt: ExternalEfficiencyReceiptV1): ExternalEfficiencyReceiptV1 {
  return { ...unsignedProjection(receipt), receiptDigest: receipt.receiptDigest };
}

function canonicalPayloadUnchecked(receipt: ExternalEfficiencyReceiptUnsignedV1): Buffer {
  return Buffer.from(JSON.stringify(unsignedProjection(receipt)), 'utf8');
}

/** Canonical bytes hashed by the producer. This helper never reads or writes files. */
export function canonicalExternalEfficiencyReceiptPayloadV1(value: unknown): Buffer | null {
  try {
    if (!unsignedStructuralShape(value) || !sourceVersionSupported(value) ||
      !arithmeticValid(value) || !intervalValid(value)) return null;
    return canonicalPayloadUnchecked(value);
  } catch { return null; }
}

/** Domain-separated identity for one exact, semantically valid receipt payload. */
export function digestExternalEfficiencyReceiptV1(value: unknown): string | null {
  const payload = canonicalExternalEfficiencyReceiptPayloadV1(value);
  return payload
    ? createHash('sha256').update(EXTERNAL_EFFICIENCY_RECEIPT_DIGEST_DOMAIN, 'utf8').update(payload).digest('hex')
    : null;
}

/** Exact full receipt bytes accepted by the compiler, excluding freshness checks. */
export function canonicalExternalEfficiencyReceiptBytesV1(value: unknown): Buffer | null {
  try {
    if (!receiptStructuralShape(value) || !sourceVersionSupported(value) ||
      !arithmeticValid(value) || !intervalValid(value)) return null;
    const { receiptDigest, ...unsigned } = value;
    const expected = digestExternalEfficiencyReceiptV1(unsigned);
    if (!expected || !sameDigest(expected, receiptDigest)) return null;
    return Buffer.from(JSON.stringify(receiptProjection(value)), 'utf8');
  } catch { return null; }
}

function sameDigest(left: string, right: string): boolean {
  if (!DIGEST.test(left) || !DIGEST.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function boundary(): ObservationBoundary {
  return {
    schemaVersion: 1,
    mode: 'external-efficiency-receipt-observation',
    authority: 'observation-only',
    planningAuthority: false,
    executionAuthority: false,
    effectAuthority: false,
    promotionAuthority: false,
    planningEligible: false,
    executionEligible: false,
    effectEligible: false,
    promotionEligible: false,
  };
}

function immutable<T extends object>(value: T): T {
  return Object.freeze(value);
}

function withheld(
  reason: Exclude<ExternalEfficiencyReceiptReason, 'efficiency-receipt-accepted'>,
): ExternalEfficiencyReceiptObservation {
  return immutable({
    ...boundary(),
    state: 'withheld',
    reason,
    assurance: 'unavailable',
    canonicalBytesVerified: false,
    digestVerified: false,
    freshnessVerified: false,
    receiptDigest: null,
    sourceProduct: null,
    sourceVersion: null,
    sourceCommit: null,
    intervalStartedAt: null,
    intervalEndedAt: null,
    observedAt: null,
    calls: null,
    rawTokens: null,
    compactTokens: null,
    savedTokens: null,
    measuredSavedTokens: null,
    estimatedSavedTokens: null,
    counterfactualSavedTokens: null,
    accountingMethod: null,
    pricingVersion: null,
  });
}

/**
 * Compile caller-supplied canonical receipt bytes into a non-authoritative Hub
 * observation. A valid digest proves byte integrity, not producer identity or
 * effectiveness, so accepted receipts remain explicitly self-reported.
 */
export function compileExternalEfficiencyReceipt(
  value: unknown,
): ExternalEfficiencyReceiptObservation {
  try {
    if (!(value instanceof Uint8Array) || value.byteLength === 0 ||
      value.byteLength > EXTERNAL_EFFICIENCY_RECEIPT_MAX_BYTES) return withheld('invalid-input');
    const bytes = Buffer.from(value);
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch { return withheld('receipt-not-canonical'); }
    if (!receiptStructuralShape(decoded)) return withheld('receipt-schema-invalid');

    const canonical = Buffer.from(JSON.stringify(receiptProjection(decoded)), 'utf8');
    if (canonical.byteLength !== bytes.byteLength || !timingSafeEqual(canonical, bytes)) {
      return withheld('receipt-not-canonical');
    }
    if (!sourceVersionSupported(decoded)) return withheld('source-version-unsupported');
    if (!arithmeticValid(decoded)) return withheld('receipt-arithmetic-invalid');
    if (!intervalValid(decoded)) return withheld('receipt-interval-invalid');

    const now = Date.now();
    const observedAt = Date.parse(decoded.observedAt);
    const endedAt = Date.parse(decoded.intervalEndedAt);
    if (observedAt > now + EXTERNAL_EFFICIENCY_RECEIPT_MAX_FUTURE_SKEW_MS) {
      return withheld('receipt-future');
    }
    if (now - observedAt > EXTERNAL_EFFICIENCY_RECEIPT_MAX_AGE_MS ||
      now - endedAt > EXTERNAL_EFFICIENCY_RECEIPT_MAX_AGE_MS) {
      return withheld('receipt-stale');
    }

    const { receiptDigest, ...unsigned } = decoded;
    const expectedDigest = digestExternalEfficiencyReceiptV1(unsigned);
    if (!expectedDigest || !sameDigest(expectedDigest, receiptDigest)) {
      return withheld('receipt-digest-mismatch');
    }

    return immutable({
      ...boundary(),
      state: 'accepted',
      reason: 'efficiency-receipt-accepted',
      assurance: 'self-reported-unverified',
      canonicalBytesVerified: true,
      digestVerified: true,
      freshnessVerified: true,
      receiptDigest,
      sourceProduct: decoded.sourceProduct,
      sourceVersion: decoded.sourceVersion,
      sourceCommit: decoded.sourceCommit,
      intervalStartedAt: decoded.intervalStartedAt,
      intervalEndedAt: decoded.intervalEndedAt,
      observedAt: decoded.observedAt,
      calls: decoded.calls,
      rawTokens: decoded.rawTokens,
      compactTokens: decoded.compactTokens,
      savedTokens: decoded.savedTokens,
      measuredSavedTokens: decoded.measuredSavedTokens,
      estimatedSavedTokens: decoded.estimatedSavedTokens,
      counterfactualSavedTokens: decoded.counterfactualSavedTokens,
      accountingMethod: decoded.accountingMethod,
      pricingVersion: decoded.pricingVersion,
    });
  } catch { return withheld('invalid-input'); }
}

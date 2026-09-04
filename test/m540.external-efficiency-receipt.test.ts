import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalExternalEfficiencyReceiptBytesV1,
  canonicalExternalEfficiencyReceiptPayloadV1,
  compileExternalEfficiencyReceipt,
  digestExternalEfficiencyReceiptV1,
  EXTERNAL_EFFICIENCY_RECEIPT_DIGEST_DOMAIN,
  EXTERNAL_EFFICIENCY_RECEIPT_MAX_BYTES,
  type ExternalEfficiencyReceiptUnsignedV1,
  type ExternalEfficiencyReceiptV1,
} from '../src/core/fabric/external-efficiency-receipt.js';

const NOW = '2026-09-03T12:30:00.000Z';

function unsigned(
  overrides: Partial<ExternalEfficiencyReceiptUnsignedV1> = {},
): ExternalEfficiencyReceiptUnsignedV1 {
  return {
    schemaVersion: 1,
    protocol: 'ashlr-external-efficiency-receipt-v1',
    sourceProduct: 'ashlr-plugin',
    sourceVersion: '1.36.2',
    sourceCommit: 'a'.repeat(40),
    intervalStartedAt: '2026-09-03T11:00:00.000Z',
    intervalEndedAt: '2026-09-03T11:59:00.000Z',
    observedAt: '2026-09-03T12:00:00.000Z',
    calls: 10,
    rawTokens: 10_000,
    compactTokens: 5_000,
    savedTokens: 5_000,
    measuredSavedTokens: 2_000,
    estimatedSavedTokens: 2_000,
    counterfactualSavedTokens: 1_000,
    accountingMethod: 'mixed-v1',
    pricingVersion: 'plugin-pricing-2026-04',
    ...overrides,
  };
}

function fixture(
  overrides: Partial<ExternalEfficiencyReceiptUnsignedV1> = {},
): { unsigned: ExternalEfficiencyReceiptUnsignedV1; receipt: ExternalEfficiencyReceiptV1; bytes: Buffer } {
  const value = unsigned(overrides);
  const receiptDigest = digestExternalEfficiencyReceiptV1(value);
  expect(receiptDigest).not.toBeNull();
  const receipt = { ...value, receiptDigest: receiptDigest! };
  const bytes = canonicalExternalEfficiencyReceiptBytesV1(receipt);
  expect(bytes).not.toBeNull();
  return { unsigned: value, receipt, bytes: bytes! };
}

function wireBytes(value: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: value['schemaVersion'],
    protocol: value['protocol'],
    sourceProduct: value['sourceProduct'],
    sourceVersion: value['sourceVersion'],
    sourceCommit: value['sourceCommit'],
    intervalStartedAt: value['intervalStartedAt'],
    intervalEndedAt: value['intervalEndedAt'],
    observedAt: value['observedAt'],
    calls: value['calls'],
    rawTokens: value['rawTokens'],
    compactTokens: value['compactTokens'],
    savedTokens: value['savedTokens'],
    measuredSavedTokens: value['measuredSavedTokens'],
    estimatedSavedTokens: value['estimatedSavedTokens'],
    counterfactualSavedTokens: value['counterfactualSavedTokens'],
    accountingMethod: value['accountingMethod'],
    pricingVersion: value['pricingVersion'],
    receiptDigest: value['receiptDigest'],
  }), 'utf8');
}

function invalidSemanticBytes(
  overrides: Record<string, unknown>,
): Buffer {
  return wireBytes({ ...unsigned(), receiptDigest: 'b'.repeat(64), ...overrides });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe('M540 external efficiency receipt bridge', () => {
  it('accepts exact fresh bytes as self-reported observation with no authority', () => {
    const value = fixture();
    const result = compileExternalEfficiencyReceipt(value.bytes);

    expect(result).toEqual({
      schemaVersion: 1,
      mode: 'external-efficiency-receipt-observation',
      state: 'accepted',
      reason: 'efficiency-receipt-accepted',
      assurance: 'self-reported-unverified',
      canonicalBytesVerified: true,
      digestVerified: true,
      freshnessVerified: true,
      receiptDigest: value.receipt.receiptDigest,
      sourceProduct: 'ashlr-plugin',
      sourceVersion: '1.36.2',
      sourceCommit: 'a'.repeat(40),
      intervalStartedAt: '2026-09-03T11:00:00.000Z',
      intervalEndedAt: '2026-09-03T11:59:00.000Z',
      observedAt: '2026-09-03T12:00:00.000Z',
      calls: 10,
      rawTokens: 10_000,
      compactTokens: 5_000,
      savedTokens: 5_000,
      measuredSavedTokens: 2_000,
      estimatedSavedTokens: 2_000,
      counterfactualSavedTokens: 1_000,
      accountingMethod: 'mixed-v1',
      pricingVersion: 'plugin-pricing-2026-04',
      authority: 'observation-only',
      planningAuthority: false,
      executionAuthority: false,
      effectAuthority: false,
      promotionAuthority: false,
      planningEligible: false,
      executionEligible: false,
      effectEligible: false,
      promotionEligible: false,
    });
  });

  it('returns an immutable digest-bound projection without freezing caller-owned values', () => {
    const value = fixture();
    const result = compileExternalEfficiencyReceipt(value.bytes);
    const receiptDigest = result.receiptDigest;

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(value.receipt)).toBe(false);
    expect(() => { (result as unknown as { calls: number }).calls = 99; }).toThrow(TypeError);
    expect(() => { (result as unknown as { receiptDigest: string }).receiptDigest = 'forged'; }).toThrow(TypeError);
    expect(result.calls).toBe(10);
    expect(result.receiptDigest).toBe(receiptDigest);
  });

  it('uses canonical payload bytes and a domain-separated SHA-256 identity', () => {
    const value = fixture();
    const payload = canonicalExternalEfficiencyReceiptPayloadV1(value.unsigned)!;
    const manual = createHash('sha256')
      .update(EXTERNAL_EFFICIENCY_RECEIPT_DIGEST_DOMAIN, 'utf8')
      .update(payload)
      .digest('hex');

    expect(value.receipt.receiptDigest).toBe(manual);
    expect(value.bytes).toEqual(Buffer.from(JSON.stringify(value.receipt), 'utf8'));
    expect(digestExternalEfficiencyReceiptV1({ ...value.unsigned, calls: 11 })).not.toBe(manual);
  });

  it.each([
    ['non-bytes', 'not bytes'],
    ['empty', Buffer.alloc(0)],
    ['oversized', Buffer.alloc(EXTERNAL_EFFICIENCY_RECEIPT_MAX_BYTES + 1)],
  ])('rejects %s input before parsing', (_label, input) => {
    expect(compileExternalEfficiencyReceipt(input)).toMatchObject({
      state: 'withheld',
      reason: 'invalid-input',
      authority: 'observation-only',
      effectAuthority: false,
    });
  });

  it.each([
    ['malformed JSON', Buffer.from('{')],
    ['malformed UTF-8', Buffer.from([0xff, 0xfe, 0xfd])],
  ])('rejects %s as non-canonical', (_label, bytes) => {
    expect(compileExternalEfficiencyReceipt(bytes).reason).toBe('receipt-not-canonical');
  });

  it('rejects reordered or whitespace-modified wire bytes', () => {
    const value = fixture();
    const parsed = JSON.parse(value.bytes.toString('utf8')) as Record<string, unknown>;
    const { receiptDigest, ...rest } = parsed;

    expect(compileExternalEfficiencyReceipt(
      Buffer.from(JSON.stringify({ receiptDigest, ...rest })),
    ).reason).toBe('receipt-not-canonical');
    expect(compileExternalEfficiencyReceipt(
      Buffer.from(JSON.stringify(parsed, null, 2)),
    ).reason).toBe('receipt-not-canonical');
  });

  it.each([
    'cwd', 'path', 'repo', 'sessionId', 'content', 'toolInput', 'toolOutput', 'meta',
  ])('rejects privacy-bearing or free-form key %s without reflecting its value', (key) => {
    const value = fixture();
    const parsed = JSON.parse(value.bytes.toString('utf8')) as Record<string, unknown>;
    const secret = `/Users/private/project/${key}-secret`;
    const result = compileExternalEfficiencyReceipt(Buffer.from(JSON.stringify({ ...parsed, [key]: secret })));

    expect(result).toMatchObject({
      state: 'withheld',
      reason: 'receipt-schema-invalid',
      sourceProduct: null,
      receiptDigest: null,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    ['compact exceeds raw', { compactTokens: 10_001 }],
    ['saved does not equal raw minus compact', { savedTokens: 4_999 }],
    ['split does not equal saved', { measuredSavedTokens: 1_999 }],
    ['classified split overflows safe integers', {
      rawTokens: Number.MAX_SAFE_INTEGER, compactTokens: 0,
      savedTokens: Number.MAX_SAFE_INTEGER, measuredSavedTokens: Number.MAX_SAFE_INTEGER,
      estimatedSavedTokens: 1, counterfactualSavedTokens: 0,
    }],
    ['zero calls carry work', { calls: 0 }],
    ['provider usage includes an estimate', {
      accountingMethod: 'provider-usage-v1', measuredSavedTokens: 4_000,
      estimatedSavedTokens: 1_000, counterfactualSavedTokens: 0,
    }],
    ['byte estimate claims measured savings', { accountingMethod: 'chars-div-4-v1' }],
  ])('withholds arithmetic inconsistency: %s', (_label, overrides) => {
    expect(compileExternalEfficiencyReceipt(invalidSemanticBytes(overrides)).reason)
      .toBe('receipt-arithmetic-invalid');
  });

  it.each([
    ['negative', { rawTokens: -1 }],
    ['unsafe integer', { rawTokens: Number.MAX_SAFE_INTEGER + 1 }],
    ['non-finite', { rawTokens: Number.POSITIVE_INFINITY }],
    ['invalid pricing id', { pricingVersion: '../prices.json' }],
    ['invalid commit', { sourceCommit: 'dirty' }],
    ['invalid semver', { sourceVersion: 'latest' }],
  ])('rejects structurally unsafe value: %s', (_label, overrides) => {
    expect(compileExternalEfficiencyReceipt(invalidSemanticBytes(overrides)).reason)
      .toBe('receipt-schema-invalid');
  });

  it.each([
    ['ashlr-plugin', '2.0.0'],
    ['@ashlr/core-efficiency', '0.4.0'],
    ['@ashlr/core-efficiency', '1.0.0'],
  ])('rejects unsupported %s version %s', (sourceProduct, sourceVersion) => {
    const bytes = invalidSemanticBytes({ sourceProduct, sourceVersion });
    expect(compileExternalEfficiencyReceipt(bytes).reason).toBe('source-version-unsupported');
  });

  it.each([
    ['zero interval', { intervalStartedAt: '2026-09-03T11:59:00.000Z' }],
    ['reversed interval', { intervalStartedAt: '2026-09-03T12:01:00.000Z' }],
    ['observed before interval ended', { observedAt: '2026-09-03T11:58:00.000Z' }],
  ])('rejects an invalid interval: %s', (_label, overrides) => {
    expect(compileExternalEfficiencyReceipt(invalidSemanticBytes(overrides)).reason)
      .toBe('receipt-interval-invalid');
  });

  it('rejects future and stale observations while checking the interval end independently', () => {
    const future = fixture({
      intervalStartedAt: '2026-09-03T12:29:00.000Z',
      intervalEndedAt: '2026-09-03T12:30:30.000Z',
      observedAt: '2026-09-03T12:31:01.000Z',
    });
    const stale = fixture({
      intervalStartedAt: '2026-09-01T11:00:00.000Z',
      intervalEndedAt: '2026-09-01T11:59:00.000Z',
      observedAt: '2026-09-02T12:00:00.000Z',
    });
    const freshlyWrappedOldInterval = fixture({
      intervalStartedAt: '2026-09-01T11:00:00.000Z',
      intervalEndedAt: '2026-09-01T11:59:00.000Z',
    });

    expect(compileExternalEfficiencyReceipt(future.bytes).reason).toBe('receipt-future');
    expect(compileExternalEfficiencyReceipt(stale.bytes).reason).toBe('receipt-stale');
    expect(compileExternalEfficiencyReceipt(freshlyWrappedOldInterval.bytes).reason)
      .toBe('receipt-stale');
  });

  it('rejects a forged digest and never upgrades digest integrity to producer authentication', () => {
    const value = fixture();
    const forged = wireBytes({ ...value.receipt, receiptDigest: 'f'.repeat(64) });

    expect(compileExternalEfficiencyReceipt(forged)).toMatchObject({
      state: 'withheld',
      reason: 'receipt-digest-mismatch',
      assurance: 'unavailable',
      digestVerified: false,
      planningAuthority: false,
      executionAuthority: false,
      effectAuthority: false,
      promotionAuthority: false,
    });
  });

  it('accepts the supported Core Efficiency contract without importing that package', () => {
    const value = fixture({
      sourceProduct: '@ashlr/core-efficiency',
      sourceVersion: '0.3.7',
      measuredSavedTokens: 5_000,
      estimatedSavedTokens: 0,
      counterfactualSavedTokens: 0,
      accountingMethod: 'provider-usage-v1',
      pricingVersion: 'core-rate-table-v3',
    });

    expect(compileExternalEfficiencyReceipt(value.bytes)).toMatchObject({
      state: 'accepted',
      sourceProduct: '@ashlr/core-efficiency',
      sourceVersion: '0.3.7',
      assurance: 'self-reported-unverified',
      effectEligible: false,
    });
  });
});

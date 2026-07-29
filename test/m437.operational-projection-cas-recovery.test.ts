import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildOperationalProjectionAnchorRequest,
  operationalProjectionAnchorReceiptDigest,
  operationalProjectionAnchorReceiptSigningBytes,
  operationalProjectionAnchorRequestDigest,
  type OperationalProjectionAnchorReceiptCoreV1,
  type OperationalProjectionAnchorReceiptV1,
} from '../src/core/inbox/operational-projection-monotonic-anchor.js';
import {
  observeOperationalProjectionCasRecovery,
  operationalProjectionCasRecoveryIdempotencyKey,
  operationalProjectionCasRecoveryReceiptDigest,
  operationalProjectionCasRecoverySigningBytes,
  type OperationalProjectionCasRecoveryDecision,
  type OperationalProjectionCasRecoveryExpectationV1,
  type OperationalProjectionCasRecoveryReceiptCoreV1,
  type OperationalProjectionCasRecoveryReceiptV1,
  type OperationalProjectionCasRecoveryReplayStateV1,
  type OperationalProjectionCasRecoveryTrustV1,
} from '../src/core/inbox/operational-projection-cas-recovery.js';

const NOW = new Date('2026-07-29T12:05:00.000Z');
const DIGEST = {
  transaction: '1'.repeat(64),
  transactionAttestation: 'a'.repeat(64),
  priorValue: '2'.repeat(64),
  priorReceipt: '3'.repeat(64),
  proposal: '5'.repeat(64),
  projection: '6'.repeat(64),
  replayReceipt: '9'.repeat(64),
};

const CAS_REQUEST = buildOperationalProjectionAnchorRequest({
  anchorId: 'ashlr-anchor-primary',
  namespace: 'ashlr/projections/operational',
  requestNonce: '7'.repeat(64),
  expected: {
    sequence: '7',
    valueDigest: DIGEST.priorValue,
    receiptDigest: DIGEST.priorReceipt,
  },
  source: {
    shadowSchemaVersion: 2,
    transactionId: DIGEST.transaction,
    transactionAttestation: DIGEST.transactionAttestation,
    transactionPhase: 'committed',
    localRollForwardRequired: false,
    proposalId: 'proposal-437',
    proposalDigest: DIGEST.proposal,
    projectionDigest: DIGEST.projection,
  },
});

function casReceiptCore(
  decision: 'accepted' | 'conflict' | 'unavailable',
): OperationalProjectionAnchorReceiptCoreV1 {
  return {
    schemaVersion: 1,
    protocol: 'ashlr.operational-projection-monotonic-anchor.v1',
    anchorId: CAS_REQUEST.anchorId,
    namespace: CAS_REQUEST.namespace,
    keyId: 'projection-recovery-key',
    keyEpoch: '3',
    decision,
    reason: decision === 'accepted'
      ? 'accepted'
      : decision === 'conflict'
        ? 'compare-mismatch'
        : 'temporarily-unavailable',
    requestDigest: operationalProjectionAnchorRequestDigest(CAS_REQUEST),
    observed: decision === 'accepted'
      ? CAS_REQUEST.expected
      : decision === 'conflict'
        ? {
            sequence: '8',
            valueDigest: 'b'.repeat(64),
            receiptDigest: 'c'.repeat(64),
          }
        : null,
    accepted: decision === 'accepted' ? CAS_REQUEST.proposed : null,
    historicalAuthority: false,
    rollbackProtected: false,
    operationalAuthority: false,
  };
}

function expectationFor(
  decision: 'accepted' | 'conflict' | 'unavailable' = 'accepted',
): OperationalProjectionCasRecoveryExpectationV1 {
  return {
    anchorId: CAS_REQUEST.anchorId,
    namespace: CAS_REQUEST.namespace,
    transactionId: DIGEST.transaction,
    priorGeneration: CAS_REQUEST.expected.sequence,
    priorValueDigest: DIGEST.priorValue,
    priorReceiptDigest: DIGEST.priorReceipt,
    proposedGeneration: CAS_REQUEST.proposed.sequence,
    proposedValueDigest: CAS_REQUEST.proposed.valueDigest,
    proposedProposalDigest: DIGEST.proposal,
    proposedProjectionDigest: DIGEST.projection,
    casRequestDigest: operationalProjectionAnchorRequestDigest(CAS_REQUEST),
    casReceiptDigest: operationalProjectionAnchorReceiptDigest(
      casReceiptCore(decision),
    ),
    sequence: '41',
    policyId: 'projection-recovery-policy',
    policyVersion: '2026-07-29.v1',
    rootId: 'projection-recovery-root',
    keyId: 'projection-recovery-key',
    keyEpoch: '3',
  };
}

const EXPECTATION = expectationFor();

function fixture(
  casDecision: 'accepted' | 'conflict' | 'unavailable' = 'accepted',
) {
  const keyPair = generateKeyPairSync('ed25519');
  const expectation = expectationFor(casDecision);
  const trust: OperationalProjectionCasRecoveryTrustV1 = {
    rootId: expectation.rootId,
    keyId: expectation.keyId,
    keyEpoch: expectation.keyEpoch,
    publicKey: keyPair.publicKey,
  };
  const casTrust = {
    anchorId: expectation.anchorId,
    keyId: expectation.keyId,
    keyEpoch: expectation.keyEpoch,
    publicKey: keyPair.publicKey,
  };
  const core = casReceiptCore(casDecision);
  const casReceiptDigest = operationalProjectionAnchorReceiptDigest(core);
  const casReceipt: OperationalProjectionAnchorReceiptV1 = {
    ...core,
    receiptDigest: casReceiptDigest,
    signature: sign(
      null,
      operationalProjectionAnchorReceiptSigningBytes(casReceiptDigest),
      keyPair.privateKey,
    ).toString('base64url'),
  };
  const replayState: OperationalProjectionCasRecoveryReplayStateV1 = {
    sequence: '40',
    receiptDigest: DIGEST.replayReceipt,
  };
  return {
    ...keyPair,
    expectation,
    trust,
    replayState,
    casRequest: CAS_REQUEST,
    casReceipt,
    casTrust,
  };
}

function signedReceipt(
  expectation: OperationalProjectionCasRecoveryExpectationV1,
  privateKey: KeyObject,
  decision: OperationalProjectionCasRecoveryDecision = 'roll-forward',
  overrides: Partial<OperationalProjectionCasRecoveryReceiptCoreV1> = {},
): OperationalProjectionCasRecoveryReceiptV1 {
  const core: OperationalProjectionCasRecoveryReceiptCoreV1 = {
    schemaVersion: 1,
    protocol: 'ashlr.operational-projection-cas-recovery.v1',
    ...expectation,
    idempotencyKey: operationalProjectionCasRecoveryIdempotencyKey(expectation),
    decision,
    issuedAt: '2026-07-29T12:00:00.000Z',
    expiresAt: '2026-07-29T12:10:00.000Z',
    historicalAuthority: false,
    operationalAuthority: false,
    rollbackAuthority: false,
    rollbackProtected: false,
    ...overrides,
  };
  const receiptDigest = operationalProjectionCasRecoveryReceiptDigest(core);
  return {
    ...core,
    receiptDigest,
    signature: sign(
      null,
      operationalProjectionCasRecoverySigningBytes(receiptDigest),
      privateKey,
    ).toString('base64url'),
  };
}

function observe(
  receipts: readonly unknown[] | null,
  overrides: Partial<Parameters<typeof observeOperationalProjectionCasRecovery>[0]> = {},
) {
  const fx = fixture();
  return observeOperationalProjectionCasRecovery({
    expectation: fx.expectation,
    trust: fx.trust,
    replayState: fx.replayState,
    now: NOW,
    casRequest: fx.casRequest,
    untrustedCasReceipt: fx.casReceipt,
    casTrust: fx.casTrust,
    untrustedReceipts: receipts ?? null,
    ...overrides,
  });
}

describe('M437 operational projection external-CAS recovery gate', () => {
  it('observes an exact signed roll-forward decision without granting authority', () => {
    const fx = fixture();
    const receipt = signedReceipt(EXPECTATION, fx.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt],
    })).toEqual({
      state: 'observed',
      reason: 'signed-external-cas-decision',
      receipt,
      receiptDigest: receipt.receiptDigest,
      decision: 'roll-forward',
      authenticated: true,
      observationOnly: true,
      localMutationPermitted: false,
      historicalAuthority: false,
      operationalAuthority: false,
      rollbackAuthority: false,
      rollbackProtected: false,
    });
  });

  it('observes rollback only when the external service signed rollback', () => {
    const fx = fixture('conflict');
    const receipt = signedReceipt(fx.expectation, fx.privateKey, 'rollback');
    const result = observeOperationalProjectionCasRecovery({
      expectation: fx.expectation,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt],
    });
    expect(result).toMatchObject({
      state: 'observed',
      decision: 'rollback',
      localMutationPermitted: false,
      rollbackAuthority: false,
    });
  });

  it.each([
    ['before the external CAS call', [], 'receipt-missing'],
    ['while the external CAS service is unavailable', null, 'receipt-unavailable'],
  ])('refuses recovery after a crash %s', (_boundary, receipts, reason) => {
    expect(observe(receipts)).toMatchObject({
      state: 'refused',
      reason,
      decision: null,
      localMutationPermitted: false,
    });
  });

  it('refuses after local intent but before the exact CAS receipt is available', () => {
    const fx = fixture();
    const receipt = signedReceipt(fx.expectation, fx.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: fx.expectation,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: null,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt],
    })).toMatchObject({
      state: 'refused',
      reason: 'receipt-unavailable',
      decision: null,
    });
  });

  it('refuses a signed unavailable CAS response and never invents a local decision', () => {
    const fx = fixture('unavailable');
    const receipt = signedReceipt(fx.expectation, fx.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: fx.expectation,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt],
    })).toMatchObject({
      state: 'refused',
      reason: 'receipt-unavailable',
      decision: null,
    });
  });

  it('refuses a recovery decision that contradicts the exact CAS decision', () => {
    const fx = fixture();
    const contradictory = signedReceipt(
      fx.expectation,
      fx.privateKey,
      'rollback',
    );
    expect(observeOperationalProjectionCasRecovery({
      expectation: fx.expectation,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [contradictory],
    })).toMatchObject({
      state: 'refused',
      reason: 'receipt-equivocal',
      decision: null,
    });
  });

  it('refuses invalid and mismatched #157 CAS evidence', () => {
    const fx = fixture();
    const receipt = signedReceipt(fx.expectation, fx.privateKey);
    const badCasSignature = {
      ...fx.casReceipt,
      signature: Buffer.alloc(64, 8).toString('base64url'),
    };
    expect(observeOperationalProjectionCasRecovery({
      expectation: fx.expectation,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: badCasSignature,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt],
    })).toMatchObject({
      state: 'refused',
      reason: 'invalid-cas-receipt',
    });

    expect(observeOperationalProjectionCasRecovery({
      expectation: {
        ...fx.expectation,
        casReceiptDigest: 'd'.repeat(64),
      },
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt],
    })).toMatchObject({
      state: 'refused',
      reason: 'receipt-mismatch',
    });
  });

  it('does not accept local transaction artifacts as a substitute for a receipt', () => {
    expect(observe([{
      transactionId: EXPECTATION.transactionId,
      phase: 'projection-installed',
      requiredAction: 'roll-forward',
      proposalDigest: EXPECTATION.proposedProposalDigest,
      projectionDigest: EXPECTATION.proposedProjectionDigest,
    }])).toMatchObject({
      state: 'refused',
      reason: 'invalid-receipt',
      decision: null,
    });
  });

  it('binds every recovery request field into the idempotency identity', () => {
    const original = operationalProjectionCasRecoveryIdempotencyKey(EXPECTATION);
    const variants: OperationalProjectionCasRecoveryExpectationV1[] = [
      { ...EXPECTATION, transactionId: 'a'.repeat(64) },
      { ...EXPECTATION, priorGeneration: '8', proposedGeneration: '9' },
      { ...EXPECTATION, priorValueDigest: 'a'.repeat(64) },
      { ...EXPECTATION, priorReceiptDigest: 'a'.repeat(64) },
      { ...EXPECTATION, proposedValueDigest: 'a'.repeat(64) },
      { ...EXPECTATION, proposedProposalDigest: 'a'.repeat(64) },
      { ...EXPECTATION, proposedProjectionDigest: 'a'.repeat(64) },
      { ...EXPECTATION, casRequestDigest: 'a'.repeat(64) },
      { ...EXPECTATION, casReceiptDigest: 'a'.repeat(64) },
      { ...EXPECTATION, sequence: '42' },
      { ...EXPECTATION, policyVersion: '2026-07-29.v2' },
      { ...EXPECTATION, rootId: 'projection-recovery-root-next' },
      { ...EXPECTATION, keyId: 'projection-recovery-key-next' },
      { ...EXPECTATION, keyEpoch: '4' },
    ];
    expect(new Set(variants.map(
      (variant) => operationalProjectionCasRecoveryIdempotencyKey(variant),
    )).size).toBe(variants.length);
    expect(variants.every(
      (variant) => operationalProjectionCasRecoveryIdempotencyKey(variant) !== original,
    )).toBe(true);
  });

  it('refuses a valid signed receipt for any different exact expectation', () => {
    const fx = fixture();
    const otherExpectation = {
      ...EXPECTATION,
      proposedProjectionDigest: 'a'.repeat(64),
    };
    const receipt = signedReceipt(otherExpectation, fx.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt],
    })).toMatchObject({ state: 'refused', reason: 'receipt-mismatch' });
  });

  it('refuses unknown roots, keys, and epochs without key discovery', () => {
    const fx = fixture();
    const foreign = fixture();
    const foreignExpectation = {
      ...EXPECTATION,
      rootId: 'foreign-root',
      keyId: 'foreign-key',
      keyEpoch: '9',
    };
    const receipt = signedReceipt(foreignExpectation, foreign.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt],
    })).toMatchObject({ state: 'refused', reason: 'unknown-key' });
  });

  it('refuses altered digests and signatures', () => {
    const fx = fixture();
    const receipt = signedReceipt(EXPECTATION, fx.privateKey);
    const badDigest = { ...receipt, receiptDigest: 'a'.repeat(64) };
    const badSignature = {
      ...receipt,
      signature: Buffer.alloc(64, 7).toString('base64url'),
    };
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [badDigest],
    })).toMatchObject({ state: 'refused', reason: 'receipt-digest-mismatch' });
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [badSignature],
    })).toMatchObject({ state: 'refused', reason: 'signature-invalid' });
  });

  it.each([
    [
      'expired',
      { issuedAt: '2026-07-29T11:40:00.000Z', expiresAt: '2026-07-29T11:55:00.000Z' },
      'receipt-expired',
    ],
    [
      'not yet valid',
      { issuedAt: '2026-07-29T12:06:00.001Z', expiresAt: '2026-07-29T12:10:00.000Z' },
      'receipt-not-yet-valid',
    ],
    [
      'overlong',
      { issuedAt: '2026-07-29T12:00:00.000Z', expiresAt: '2026-07-29T12:15:00.001Z' },
      'invalid-receipt',
    ],
  ])('refuses a %s receipt', (_name, timestamps, reason) => {
    const fx = fixture();
    const receipt = signedReceipt(EXPECTATION, fx.privateKey, 'roll-forward', timestamps);
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt],
    })).toMatchObject({ state: 'refused', reason });
  });

  it('refuses a receipt already consumed at the durable high-water mark', () => {
    const fx = fixture();
    const receipt = signedReceipt(EXPECTATION, fx.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: {
        sequence: receipt.sequence,
        receiptDigest: receipt.receiptDigest,
      },
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt],
    })).toMatchObject({ state: 'refused', reason: 'receipt-replayed' });
  });

  it('refuses stale receipts and sequence gaps', () => {
    const fx = fixture();
    const staleExpectation = { ...EXPECTATION, sequence: '40' };
    const stale = signedReceipt(staleExpectation, fx.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: staleExpectation,
      trust: fx.trust,
      replayState: { sequence: '41', receiptDigest: DIGEST.replayReceipt },
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [stale],
    })).toMatchObject({ state: 'refused', reason: 'receipt-stale' });

    const gapExpectation = { ...EXPECTATION, sequence: '42' };
    const gap = signedReceipt(gapExpectation, fx.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: gapExpectation,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [gap],
    })).toMatchObject({ state: 'refused', reason: 'sequence-gap' });
  });

  it('refuses duplicate delivery instead of selecting one idempotent response', () => {
    const fx = fixture();
    const receipt = signedReceipt(EXPECTATION, fx.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [receipt, receipt],
    })).toMatchObject({ state: 'refused', reason: 'receipt-replayed' });
  });

  it('refuses signed equivocation at one transaction, idempotency key, and sequence', () => {
    const fx = fixture();
    const rollForward = signedReceipt(EXPECTATION, fx.privateKey, 'roll-forward');
    const rollback = signedReceipt(EXPECTATION, fx.privateKey, 'rollback');
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [rollForward, rollback],
    })).toMatchObject({ state: 'refused', reason: 'receipt-equivocal' });
  });

  it('refuses a different signed identity rather than treating it as competing truth', () => {
    const fx = fixture();
    const first = signedReceipt(EXPECTATION, fx.privateKey);
    const otherExpectation = {
      ...EXPECTATION,
      transactionId: 'a'.repeat(64),
    };
    const other = signedReceipt(otherExpectation, fx.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [first, other],
    })).toMatchObject({ state: 'refused', reason: 'receipt-mismatch' });
  });

  it('rejects schema extension and any authority escalation', () => {
    const fx = fixture();
    const receipt = signedReceipt(EXPECTATION, fx.privateKey);
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [{ ...receipt, localState: 'projection-installed' }],
    })).toMatchObject({ state: 'refused', reason: 'invalid-receipt' });
    expect(observeOperationalProjectionCasRecovery({
      expectation: EXPECTATION,
      trust: fx.trust,
      replayState: fx.replayState,
      now: NOW,
      casRequest: fx.casRequest,
      untrustedCasReceipt: fx.casReceipt,
      casTrust: fx.casTrust,
      untrustedReceipts: [{ ...receipt, operationalAuthority: true }],
    })).toMatchObject({ state: 'refused', reason: 'invalid-receipt' });
  });
});

import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  buildOperationalProjectionAnchorRequest,
  operationalProjectionAnchorReceiptDigest,
  operationalProjectionAnchorReceiptSigningBytes,
  operationalProjectionAnchorRequestDigest,
  operationalProjectionAnchorValueDigest,
  serializeOperationalProjectionAnchorRequest,
  verifyOperationalProjectionAnchorReceipt,
  type OperationalProjectionAnchorCasRequestV1,
  type OperationalProjectionAnchorReceiptCoreV1,
  type OperationalProjectionAnchorReceiptV1,
  type OperationalProjectionAnchorSourceV1,
  type OperationalProjectionAnchorStateV1,
  type OperationalProjectionAnchorTrustV1,
  type OperationalProjectionMonotonicAnchor,
} from '../src/core/inbox/operational-projection-monotonic-anchor.js';

const DIGEST = {
  transaction: '1'.repeat(64),
  attestation: '2'.repeat(64),
  proposal: '3'.repeat(64),
  projection: '4'.repeat(64),
  priorValue: '5'.repeat(64),
  priorReceipt: '6'.repeat(64),
  nonce: '7'.repeat(64),
};

const SOURCE: OperationalProjectionAnchorSourceV1 = {
  shadowSchemaVersion: 2,
  transactionId: DIGEST.transaction,
  transactionAttestation: DIGEST.attestation,
  transactionPhase: 'committed',
  localRollForwardRequired: false,
  proposalId: 'proposal-436',
  proposalDigest: DIGEST.proposal,
  projectionDigest: DIGEST.projection,
};

const ZERO: OperationalProjectionAnchorStateV1 = {
  sequence: '0',
  valueDigest: null,
  receiptDigest: null,
};

const PRIOR: OperationalProjectionAnchorStateV1 = {
  sequence: '8',
  valueDigest: DIGEST.priorValue,
  receiptDigest: DIGEST.priorReceipt,
};

interface Fixture {
  privateKey: KeyObject;
  trust: OperationalProjectionAnchorTrustV1;
  request: OperationalProjectionAnchorCasRequestV1;
}

function fixture(expected: OperationalProjectionAnchorStateV1 = ZERO): Fixture {
  const keys = generateKeyPairSync('ed25519');
  return {
    privateKey: keys.privateKey,
    trust: {
      anchorId: 'ashlr-anchor-primary',
      keyId: 'anchor-key-primary',
      keyEpoch: '1',
      publicKey: keys.publicKey,
    },
    request: buildOperationalProjectionAnchorRequest({
      anchorId: 'ashlr-anchor-primary',
      namespace: 'ashlr/proposals/operational-projection',
      requestNonce: DIGEST.nonce,
      expected,
      source: SOURCE,
    }),
  };
}

function receiptCore(
  fx: Fixture,
  decision: 'accepted' | 'conflict' | 'unavailable' = 'accepted',
): OperationalProjectionAnchorReceiptCoreV1 {
  const conflict: OperationalProjectionAnchorStateV1 = {
    sequence: '9',
    valueDigest: '8'.repeat(64),
    receiptDigest: '9'.repeat(64),
  };
  return {
    schemaVersion: 1,
    protocol: 'ashlr.operational-projection-monotonic-anchor.v1',
    anchorId: fx.request.anchorId,
    namespace: fx.request.namespace,
    keyId: fx.trust.keyId,
    keyEpoch: fx.trust.keyEpoch,
    decision,
    reason: decision === 'accepted'
      ? 'accepted'
      : decision === 'conflict'
        ? 'compare-mismatch'
        : 'temporarily-unavailable',
    requestDigest: operationalProjectionAnchorRequestDigest(fx.request),
    observed: decision === 'accepted'
      ? fx.request.expected
      : decision === 'conflict'
        ? conflict
        : null,
    accepted: decision === 'accepted' ? fx.request.proposed : null,
    historicalAuthority: false,
    rollbackProtected: false,
    operationalAuthority: false,
  };
}

function signedReceipt(
  fx: Fixture,
  core: OperationalProjectionAnchorReceiptCoreV1 = receiptCore(fx),
  privateKey: KeyObject = fx.privateKey,
): OperationalProjectionAnchorReceiptV1 {
  const receiptDigest = operationalProjectionAnchorReceiptDigest(core);
  return {
    ...core,
    receiptDigest,
    signature: sign(
      null,
      operationalProjectionAnchorReceiptSigningBytes(receiptDigest),
      privateKey,
    ).toString('base64url'),
  };
}

function verify(
  fx: Fixture,
  receipt: unknown,
  trust: OperationalProjectionAnchorTrustV1 = fx.trust,
) {
  return verifyOperationalProjectionAnchorReceipt(fx.request, receipt, trust);
}

describe('M436 operational projection external monotonic anchor protocol', () => {
  it('builds deterministic bootstrap and chained CAS requests without number precision loss', () => {
    const bootstrap = fixture();
    expect(bootstrap.request).toMatchObject({
      schemaVersion: 1,
      expected: ZERO,
      proposed: { sequence: '1' },
      historicalAuthority: false,
      rollbackProtected: false,
      operationalAuthority: false,
    });
    expect(bootstrap.request.proposed.valueDigest).toBe(
      operationalProjectionAnchorValueDigest(SOURCE),
    );

    const chained = fixture(PRIOR);
    expect(chained.request.proposed.sequence).toBe('9');
    const nearLimit = fixture({
      sequence: '18446744073709551614',
      valueDigest: DIGEST.priorValue,
      receiptDigest: DIGEST.priorReceipt,
    });
    expect(nearLimit.request.proposed.sequence).toBe('18446744073709551615');
    expect(() => fixture({
      sequence: '18446744073709551615',
      valueDigest: DIGEST.priorValue,
      receiptDigest: DIGEST.priorReceipt,
    })).toThrow(/sequence exhausted/);
  });

  it('canonicalizes source and request fields independent of caller object insertion order', () => {
    const fx = fixture();
    const reorderedSource = {
      localRollForwardRequired: SOURCE.localRollForwardRequired,
      projectionDigest: SOURCE.projectionDigest,
      proposalDigest: SOURCE.proposalDigest,
      proposalId: SOURCE.proposalId,
      shadowSchemaVersion: SOURCE.shadowSchemaVersion,
      transactionAttestation: SOURCE.transactionAttestation,
      transactionId: SOURCE.transactionId,
      transactionPhase: SOURCE.transactionPhase,
    };
    const reordered = buildOperationalProjectionAnchorRequest({
      source: reorderedSource,
      expected: { receiptDigest: null, valueDigest: null, sequence: '0' },
      requestNonce: DIGEST.nonce,
      namespace: fx.request.namespace,
      anchorId: fx.request.anchorId,
    });
    expect(serializeOperationalProjectionAnchorRequest(reordered)).toBe(
      serializeOperationalProjectionAnchorRequest(fx.request),
    );
    expect(operationalProjectionAnchorRequestDigest(reordered)).toBe(
      operationalProjectionAnchorRequestDigest(fx.request),
    );
  });

  it('exposes a transport-only interface without implementing network or storage effects', async () => {
    const fx = fixture();
    const compareAndSwap = vi.fn(async () => signedReceipt(fx));
    const anchor: OperationalProjectionMonotonicAnchor = {
      anchorId: fx.request.anchorId,
      compareAndSwap,
    };
    expect(await anchor.compareAndSwap(fx.request)).toMatchObject({
      decision: 'accepted',
    });
    expect(compareAndSwap).toHaveBeenCalledOnce();
  });

  for (const decision of ['accepted', 'conflict', 'unavailable'] as const) {
    it(`authenticates an exact ${decision} receipt while retaining no authority`, () => {
      const fx = fixture(PRIOR);
      const result = verify(fx, signedReceipt(fx, receiptCore(fx, decision)));
      expect(result).toMatchObject({
        state: 'authenticated',
        decision,
        authenticated: true,
        casAccepted: decision === 'accepted',
        historicalAuthority: false,
        rollbackProtected: false,
        operationalAuthority: false,
      });
    });
  }

  it('rejects request substitution by nonce, namespace, anchor, source, and expected head', () => {
    const original = fixture(PRIOR);
    const receipt = signedReceipt(original);
    const variants = [
      { ...original.request, requestNonce: 'a'.repeat(64) },
      { ...original.request, namespace: 'ashlr/proposals/other' },
      { ...original.request, anchorId: 'ashlr-anchor-other' },
      {
        ...original.request,
        source: { ...original.request.source, projectionDigest: 'b'.repeat(64) },
        proposed: {
          ...original.request.proposed,
          valueDigest: operationalProjectionAnchorValueDigest({
            ...original.request.source,
            projectionDigest: 'b'.repeat(64),
          }),
        },
      },
      {
        ...original.request,
        expected: { ...original.request.expected, receiptDigest: 'c'.repeat(64) },
      },
    ];
    for (const request of variants) {
      expect(verifyOperationalProjectionAnchorReceipt(
        request,
        receipt,
        original.trust,
      )).toMatchObject({ state: 'invalid' });
    }
  });

  it('rejects anchor, signer, epoch, and public-key confusion', () => {
    const fx = fixture();
    const receipt = signedReceipt(fx);
    const other = generateKeyPairSync('ed25519');
    const trustVariants: OperationalProjectionAnchorTrustV1[] = [
      { ...fx.trust, anchorId: 'ashlr-anchor-other' },
      { ...fx.trust, keyId: 'anchor-key-other' },
      { ...fx.trust, keyEpoch: '2' },
      { ...fx.trust, publicKey: other.publicKey },
    ];
    for (const trust of trustVariants) {
      expect(verify(fx, receipt, trust)).toMatchObject({
        state: 'invalid',
        authenticated: false,
        casAccepted: false,
      });
    }
  });

  it('rejects payload, receipt-digest, and signature tampering', () => {
    const fx = fixture();
    const receipt = signedReceipt(fx);
    const replacement = receipt.signature.endsWith('A') ? 'B' : 'A';
    const variants = [
      { ...receipt, requestDigest: 'a'.repeat(64) },
      { ...receipt, receiptDigest: 'b'.repeat(64) },
      { ...receipt, signature: `${receipt.signature.slice(0, -1)}${replacement}` },
      {
        ...receipt,
        accepted: { ...receipt.accepted!, valueDigest: 'c'.repeat(64) },
      },
    ];
    for (const variant of variants) {
      expect(verify(fx, variant)).toMatchObject({
        state: 'invalid',
        authenticated: false,
        casAccepted: false,
      });
    }
  });

  it('rejects false accepted, conflict, and unavailable decision shapes even when signed', () => {
    const fx = fixture(PRIOR);
    const falseAccepted = signedReceipt(fx, {
      ...receiptCore(fx, 'accepted'),
      observed: {
        ...fx.request.expected,
        receiptDigest: 'a'.repeat(64),
      },
    });
    const falseConflict = signedReceipt(fx, {
      ...receiptCore(fx, 'conflict'),
      observed: fx.request.expected,
    });
    const falseUnavailable = signedReceipt(fx, {
      ...receiptCore(fx, 'unavailable'),
      accepted: fx.request.proposed,
    });
    for (const receipt of [falseAccepted, falseConflict, falseUnavailable]) {
      expect(verify(fx, receipt)).toMatchObject({
        state: 'invalid',
        reason: 'decision-inconsistent',
      });
    }
  });

  it('rejects replay and ABA against a different expected receipt head', () => {
    const first = fixture(PRIOR);
    const oldReceipt = signedReceipt(first);
    const nextHead: OperationalProjectionAnchorStateV1 = {
      sequence: first.request.proposed.sequence,
      valueDigest: first.request.proposed.valueDigest,
      receiptDigest: oldReceipt.receiptDigest,
    };
    const next = fixture(nextHead);
    expect(verifyOperationalProjectionAnchorReceipt(
      next.request,
      oldReceipt,
      next.trust,
    )).toMatchObject({ state: 'invalid', reason: 'request-mismatch' });

    const aba = fixture({
      sequence: PRIOR.sequence,
      valueDigest: PRIOR.valueDigest,
      receiptDigest: 'd'.repeat(64),
    });
    expect(verifyOperationalProjectionAnchorReceipt(
      aba.request,
      oldReceipt,
      aba.trust,
    )).toMatchObject({ state: 'invalid', reason: 'request-mismatch' });
  });

  it('rejects forked accepted receipts for the same request unless signed by the trusted key', () => {
    const fx = fixture();
    const attacker = generateKeyPairSync('ed25519');
    const forged = signedReceipt(fx, receiptCore(fx), attacker.privateKey);
    expect(verify(fx, forged)).toMatchObject({
      state: 'invalid',
      reason: 'signature-invalid',
    });
  });

  it('does not mistake a trusted signer for global equivocation protection', () => {
    const first = fixture(PRIOR);
    const secondSource: OperationalProjectionAnchorSourceV1 = {
      ...SOURCE,
      transactionId: 'a'.repeat(64),
      transactionAttestation: 'b'.repeat(64),
      projectionDigest: 'c'.repeat(64),
    };
    const secondRequest = buildOperationalProjectionAnchorRequest({
      anchorId: first.request.anchorId,
      namespace: first.request.namespace,
      requestNonce: 'd'.repeat(64),
      expected: PRIOR,
      source: secondSource,
    });
    const secondFixture = { ...first, request: secondRequest };

    expect(verify(first, signedReceipt(first))).toMatchObject({
      state: 'authenticated',
      casAccepted: true,
      rollbackProtected: false,
      historicalAuthority: false,
      operationalAuthority: false,
    });
    expect(verify(secondFixture, signedReceipt(secondFixture))).toMatchObject({
      state: 'authenticated',
      casAccepted: true,
      rollbackProtected: false,
      historicalAuthority: false,
      operationalAuthority: false,
    });
  });

  it('rejects unknown fields, malformed identities, noncanonical sequences, and authority upgrades', () => {
    const fx = fixture();
    const receipt = signedReceipt(fx);
    const variants: unknown[] = [
      { ...receipt, extra: true },
      { ...receipt, anchorId: '../anchor' },
      { ...receipt, keyEpoch: '01' },
      { ...receipt, keyEpoch: '18446744073709551616' },
      { ...receipt, signature: `${receipt.signature}=` },
      { ...receipt, historicalAuthority: true },
      { ...receipt, rollbackProtected: true },
      { ...receipt, operationalAuthority: true },
    ];
    for (const variant of variants) {
      expect(verify(fx, variant)).toMatchObject({
        state: 'invalid',
        authenticated: false,
        casAccepted: false,
        historicalAuthority: false,
        rollbackProtected: false,
        operationalAuthority: false,
      });
    }
  });

  it('rejects malformed bootstrap, gaps, source substitution, and unknown request fields', () => {
    const fx = fixture();
    const malformed = [
      { ...fx.request, expected: { sequence: '0', valueDigest: DIGEST.priorValue, receiptDigest: null } },
      { ...fx.request, proposed: { ...fx.request.proposed, sequence: '2' } },
      { ...fx.request, proposed: { ...fx.request.proposed, valueDigest: 'a'.repeat(64) } },
      {
        ...fx.request,
        source: { ...fx.request.source, transactionPhase: 'prepared' },
      },
      {
        ...fx.request,
        source: { ...fx.request.source, localRollForwardRequired: true },
      },
      { ...fx.request, extra: true },
      { ...fx.request, historicalAuthority: true },
    ] as unknown as OperationalProjectionAnchorCasRequestV1[];
    for (const request of malformed) {
      expect(verifyOperationalProjectionAnchorReceipt(
        request,
        signedReceipt(fx),
        fx.trust,
      )).toMatchObject({ state: 'invalid', reason: 'invalid-request' });
    }
  });

  it('fails closed for non-Ed25519 and private-key trust objects', () => {
    const fx = fixture();
    const receipt = signedReceipt(fx);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(verify(fx, receipt, { ...fx.trust, publicKey: rsa.publicKey })).toMatchObject({
      state: 'invalid',
      reason: 'invalid-trust',
    });
    expect(verify(fx, receipt, { ...fx.trust, publicKey: fx.privateKey })).toMatchObject({
      state: 'invalid',
      reason: 'invalid-trust',
    });
  });

  it('does not use timestamps as monotonic evidence or expose an authority upgrade field', () => {
    const fx = fixture();
    const receipt = signedReceipt(fx);
    expect(Object.keys(fx.request).some((key) => /time|date|authorityAt/i.test(key))).toBe(false);
    expect(Object.keys(receipt).some((key) => /time|date|authorityAt/i.test(key))).toBe(false);
    expect(verify(fx, receipt)).toMatchObject({
      historicalAuthority: false,
      rollbackProtected: false,
      operationalAuthority: false,
    });
  });
});

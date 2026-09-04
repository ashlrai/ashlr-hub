import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AGENT_OS_EPOCH_ATTEMPT_RAW_GENESIS_DIGEST_V2,
  AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  AGENT_OS_EPOCH_SOURCE_BUNDLE_DOMAIN_V2,
  AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2,
  AGENT_OS_EPOCH_SOURCE_SIGNATURE_DOMAIN_V2,
  agentOsEpochAttemptIdV1,
  canonicalAgentOsEpochAttemptReceiptBytesV2,
  canonicalAgentOsEpochSourceBundleBytesV2,
  createAgentOsEpochAttemptReceiptV2,
  createAgentOsEpochSourceBundleV2,
  isAgentOsPrefixedSha256DigestV1,
  isAgentOsRawSha256DigestV1,
  parseAgentOsEpochAttemptReceiptV2,
  parseAgentOsEpochSourceBundleV2,
  verifyAgentOsEpochAttemptReceiptV2,
  verifyAgentOsEpochAttemptTransitionV2,
  verifyAgentOsEpochSourceBundleV2,
  type AgentOsEpochAttemptClosureContextV2,
  type AgentOsEpochAttemptClosureContextVerifierV2,
  type AgentOsEpochAttemptSignerV2,
  type AgentOsEpochAttemptVerifierV2,
  type AgentOsEpochAttemptReceiptInputV2,
  type AgentOsEpochSourceBundleInputV2,
  type AgentOsEpochSourceClosureContextV1,
  type AgentOsEpochSourceClosureContextVerifierV1,
  type AgentOsEpochSourceSignatureVerifierV2,
} from '../src/core/vision/agent-os-epoch-records.js';
import { AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1 } from '../src/core/vision/agent-os-rollover-protocol.js';

const raw = (label: string): string => createHash('sha256').update(`m555-raw\0${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;

function sourceFixture(epoch = 2) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priorTip = epoch === 1 ? null : raw('prior-source-tip');
  const input: AgentOsEpochSourceBundleInputV2 = {
    epoch,
    previousEpochHeadDigest: prefixed(`head-${epoch - 1}`),
    previousEpochSourceTipDigest: priorTip,
    trustPolicyDigest: raw('policy'),
    policyGeneration: 7,
    sourceKeyId: raw('source-key'),
    sourcePrincipalDigest: prefixed('source-principal'),
    evidencePrincipalDigest: prefixed('evidence-principal'),
    outcomePrincipalDigests: [prefixed('outcome-b'), prefixed('outcome-a')],
    issuedAt: '2026-09-03T12:00:00.000Z',
    expiresAt: '2026-09-03T12:04:00.000Z',
    sourcePayloadBytes: Buffer.from('{"source":"independently-verified"}', 'utf8'),
  };
  const signer = {
    keyId: input.sourceKeyId,
    principalDigest: input.sourcePrincipalDigest,
    sign: (payload: Uint8Array) => Buffer.from(signEd25519(null, Buffer.from(payload), privateKey)),
  };
  const verifier: AgentOsEpochSourceSignatureVerifierV2 = {
    verify: (request) => verifyEd25519(
      null,
      Buffer.from(request.canonicalDomainSeparatedPayload),
      publicKey,
      Buffer.from(request.signature),
    ),
  };
  const context: AgentOsEpochSourceClosureContextV1 = {
    epoch,
    previousEpochHeadDigest: input.previousEpochHeadDigest,
    previousEpochSourceTipDigest: priorTip,
    trustPolicyDigest: input.trustPolicyDigest,
    policyGeneration: input.policyGeneration,
    expectedSourceKeyId: input.sourceKeyId,
    expectedSourcePrincipalDigest: input.sourcePrincipalDigest,
    observedAt: '2026-09-03T12:00:30.000Z',
  };
  const contextVerifier: AgentOsEpochSourceClosureContextVerifierV1 = {
    verify: (candidate) => candidate.epoch === context.epoch &&
      candidate.previousEpochHeadDigest === context.previousEpochHeadDigest &&
      candidate.previousEpochSourceTipDigest === context.previousEpochSourceTipDigest &&
      candidate.trustPolicyDigest === context.trustPolicyDigest &&
      candidate.policyGeneration === context.policyGeneration &&
      candidate.expectedSourceKeyId === context.expectedSourceKeyId &&
      candidate.expectedSourcePrincipalDigest === context.expectedSourcePrincipalDigest &&
      candidate.observedAt === context.observedAt,
  };
  const envelope = createAgentOsEpochSourceBundleV2(input, signer);
  if (!envelope) throw new Error('source fixture failed');
  return { input, signer, verifier, context, contextVerifier, envelope, privateKey, publicKey };
}

function attemptCrypto(): {
  signer: AgentOsEpochAttemptSignerV2;
  verifier: AgentOsEpochAttemptVerifierV2;
} {
  const key = Buffer.alloc(32, 0x55);
  const keyId = raw('attempt-key');
  const tag = (bytes: Uint8Array) => createHmac('sha256', key).update(bytes).digest('hex');
  return {
    signer: { keyId, authenticate: (bytes) => tag(bytes) },
    verifier: {
      keyId,
      verify: (request) => request.keyId === keyId && request.authenticator ===
        tag(request.canonicalDomainSeparatedReceipt),
    },
  };
}

function startInput(overrides: Partial<AgentOsEpochAttemptReceiptInputV2> = {}): AgentOsEpochAttemptReceiptInputV2 {
  return {
    epoch: 2,
    attemptNamespaceDigest: prefixed('attempt-namespace'),
    durableTickDigest: prefixed('durable-tick'),
    transitionOrdinal: 1,
    previousReceiptDigest: AGENT_OS_EPOCH_ATTEMPT_RAW_GENESIS_DIGEST_V2,
    outcome: null,
    sourceBundleDigest: raw('source-bundle'),
    trustPolicyDigest: raw('attempt-policy'),
    snapshotEnvelopeDigest: null,
    startedAt: '2026-09-03T12:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function attemptClosure(
  input: AgentOsEpochAttemptReceiptInputV2 = startInput(),
): {
  context: AgentOsEpochAttemptClosureContextV2;
  contextVerifier: AgentOsEpochAttemptClosureContextVerifierV2;
} {
  const context: AgentOsEpochAttemptClosureContextV2 = {
    epoch: input.epoch,
    attemptNamespaceDigest: input.attemptNamespaceDigest,
    sourceBundleDigest: input.sourceBundleDigest,
    trustPolicyDigest: input.trustPolicyDigest,
  };
  return {
    context,
    contextVerifier: {
      verify: (candidate) => candidate.epoch === context.epoch &&
        candidate.attemptNamespaceDigest === context.attemptNamespaceDigest &&
        candidate.sourceBundleDigest === context.sourceBundleDigest &&
        candidate.trustPolicyDigest === context.trustPolicyDigest,
    },
  };
}

describe('M555 epoch-aware Agent OS record contracts', () => {
  it('uses the exact M550 source genesis sentinel for epoch-one interoperability', () => {
    expect(AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2)
      .toBe(AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1);
    expect(AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2)
      .toBe('13ee8278e60df0d6017184f8f1f1da6a7129cd8679142f2e6949c8b506a434cd');
  });

  it('keeps raw V1-record digests distinct from prefixed control digests', () => {
    expect(isAgentOsRawSha256DigestV1(raw('one'))).toBe(true);
    expect(isAgentOsRawSha256DigestV1(prefixed('one'))).toBe(false);
    expect(isAgentOsPrefixedSha256DigestV1(prefixed('one'))).toBe(true);
    expect(isAgentOsPrefixedSha256DigestV1(raw('one'))).toBe(false);
    expect(isAgentOsRawSha256DigestV1(raw('one').toUpperCase())).toBe(false);
    expect(isAgentOsPrefixedSha256DigestV1(`SHA256:${raw('one')}`)).toBe(false);
  });

  it('creates and verifies a canonical, self-contained, signed successor source', () => {
    const fixture = sourceFixture();
    expect(fixture.envelope).toMatchObject({
      schemaVersion: 2,
      epoch: 2,
      epochSequence: 1,
      previousBundleDigest: fixture.input.previousEpochSourceTipDigest,
      outcomePrincipalDigests: [prefixed('outcome-b'), prefixed('outcome-a')].sort(),
      ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
    });
    const verified = verifyAgentOsEpochSourceBundleV2(
      fixture.envelope,
      fixture.context,
      fixture.verifier,
      fixture.contextVerifier,
    );
    expect(verified).toMatchObject({ ok: true, issues: [], ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1 });
    expect(verified.ok && Buffer.from(verified.sourcePayloadBytes).toString('utf8'))
      .toBe('{"source":"independently-verified"}');
    if (verified.ok) verified.sourcePayloadBytes.fill(0);
    const verifiedAgain = verifyAgentOsEpochSourceBundleV2(
      fixture.envelope,
      fixture.context,
      fixture.verifier,
      fixture.contextVerifier,
    );
    expect(verifiedAgain.ok && Buffer.from(verifiedAgain.sourcePayloadBytes).toString('utf8'))
      .toBe('{"source":"independently-verified"}');
    expect(Object.isFrozen(fixture.envelope)).toBe(true);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it('uses the epoch genesis only for epoch one and prior anchored source thereafter', () => {
    const genesis = sourceFixture(1);
    expect(genesis.envelope.previousBundleDigest).toBe(AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2);
    expect(verifyAgentOsEpochSourceBundleV2(
      genesis.envelope, genesis.context, genesis.verifier, genesis.contextVerifier,
    ).ok).toBe(true);
    expect(createAgentOsEpochSourceBundleV2({
      ...genesis.input,
      previousEpochSourceTipDigest: raw('illegal-before-epoch-one'),
    }, genesis.signer)).toBeNull();

    const successor = sourceFixture(2);
    expect(createAgentOsEpochSourceBundleV2({
      ...successor.input,
      previousEpochSourceTipDigest: null,
    }, successor.signer)).toBeNull();
    expect(createAgentOsEpochSourceBundleV2({
      ...successor.input,
      previousEpochSourceTipDigest: AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2,
    }, successor.signer)).toBeNull();
    expect(verifyAgentOsEpochSourceBundleV2(
      successor.envelope,
      {
        ...successor.context,
        previousEpochSourceTipDigest: AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2,
      },
      successor.verifier,
      { verify: () => true },
    )).toMatchObject({ ok: false, issues: ['invalid-input'] });
  });

  it.each([
    ['epoch', { epoch: 3 }],
    ['prior head', { previousEpochHeadDigest: prefixed('other-head') }],
    ['prior source', { previousEpochSourceTipDigest: raw('other-source') }],
    ['policy', { trustPolicyDigest: raw('other-policy') }],
    ['generation', { policyGeneration: 8 }],
    ['key', { expectedSourceKeyId: raw('other-key') }],
    ['principal', { expectedSourcePrincipalDigest: prefixed('other-principal') }],
  ] as const)('rejects %s substitution in the anchored closure context', (_label, replacement) => {
    const fixture = sourceFixture();
    expect(verifyAgentOsEpochSourceBundleV2(
      fixture.envelope,
      { ...fixture.context, ...replacement },
      fixture.verifier,
      fixture.contextVerifier,
    )).toMatchObject({ ok: false, issues: ['closure-context-unauthenticated'] });
  });

  it('requires an authenticated owned frozen closure context and fails closed on callback failure', () => {
    const fixture = sourceFixture();
    expect(verifyAgentOsEpochSourceBundleV2(
      fixture.envelope, fixture.context, fixture.verifier, { verify: () => false },
    )).toMatchObject({ ok: false, issues: ['closure-context-unauthenticated'] });
    expect(verifyAgentOsEpochSourceBundleV2(
      fixture.envelope,
      fixture.context,
      fixture.verifier,
      { verify: () => { throw new Error('anchor unavailable'); } },
    )).toMatchObject({ ok: false, issues: ['closure-context-unauthenticated'] });
    expect(verifyAgentOsEpochSourceBundleV2(
      fixture.envelope,
      fixture.context,
      fixture.verifier,
      {
        verify: (context) => {
          expect(Object.isFrozen(context)).toBe(true);
          (context as { epoch: number }).epoch = 99;
          return true;
        },
      },
    )).toMatchObject({ ok: false, issues: ['closure-context-unauthenticated'] });
    expect(fixture.context.epoch).toBe(2);
  });

  it('still rejects envelope linkage when a verifier authenticates a different closure', () => {
    const fixture = sourceFixture();
    expect(verifyAgentOsEpochSourceBundleV2(
      fixture.envelope,
      { ...fixture.context, previousEpochSourceTipDigest: raw('different-authenticated-tip') },
      fixture.verifier,
      { verify: () => true },
    )).toMatchObject({ ok: false, issues: ['closure-context-mismatch'] });
  });

  it('rejects expired, too-long, and far-future source validity windows', () => {
    const fixture = sourceFixture();
    expect(verifyAgentOsEpochSourceBundleV2(fixture.envelope, {
      ...fixture.context,
      observedAt: '2026-09-03T12:05:00.000Z',
    }, fixture.verifier, { verify: () => true })).toMatchObject({ ok: false, issues: ['source-not-current'] });

    for (const replacement of [
      { expiresAt: '2026-09-03T12:06:00.000Z' },
      { issuedAt: '2026-09-03T12:02:00.000Z', expiresAt: '2026-09-03T12:04:00.000Z' },
    ]) {
      const envelope = createAgentOsEpochSourceBundleV2({ ...fixture.input, ...replacement }, fixture.signer);
      expect(envelope).not.toBeNull();
      expect(verifyAgentOsEpochSourceBundleV2(
        envelope, fixture.context, fixture.verifier, fixture.contextVerifier,
      ))
        .toMatchObject({ ok: false, issues: ['source-not-current'] });
    }
  });

  it('rejects role collisions before signing and sorts unique outcome principals', () => {
    const fixture = sourceFixture();
    expect(createAgentOsEpochSourceBundleV2({
      ...fixture.input,
      evidencePrincipalDigest: fixture.input.sourcePrincipalDigest,
    }, fixture.signer)).toBeNull();
    expect(createAgentOsEpochSourceBundleV2({
      ...fixture.input,
      outcomePrincipalDigests: [prefixed('same'), prefixed('same')],
    }, fixture.signer)).toBeNull();
  });

  it('rejects a correctly signed but non-canonically ordered outcome-principal set', () => {
    const fixture = sourceFixture();
    const unsigned = { ...fixture.envelope } as Record<string, unknown>;
    delete unsigned['signature'];
    delete unsigned['bundleDigest'];
    unsigned['outcomePrincipalDigests'] = [...fixture.envelope.outcomePrincipalDigests].reverse();
    const unsignedBytes = Buffer.from(JSON.stringify(Object.fromEntries(
      Object.entries(unsigned).sort(([left], [right]) => left.localeCompare(right)),
    )), 'utf8');
    const signature = Buffer.from(signEd25519(null, Buffer.concat([
      Buffer.from(AGENT_OS_EPOCH_SOURCE_SIGNATURE_DOMAIN_V2, 'utf8'),
      unsignedBytes,
    ]), fixture.privateKey));
    const candidate = {
      ...unsigned,
      signature: signature.toString('base64url'),
      bundleDigest: createHash('sha256')
        .update(AGENT_OS_EPOCH_SOURCE_BUNDLE_DOMAIN_V2, 'utf8')
        .update(Buffer.concat([unsignedBytes, signature]))
        .digest('hex'),
    };
    expect(canonicalAgentOsEpochSourceBundleBytesV2(candidate)).toBeNull();
    expect(verifyAgentOsEpochSourceBundleV2(
      candidate, fixture.context, fixture.verifier, fixture.contextVerifier,
    )).toMatchObject({ ok: false, issues: ['invalid-input'] });
  });

  it('rejects signature, signed-linkage, payload, and digest substitution', () => {
    const fixture = sourceFixture();
    const cases = [
      { ...fixture.envelope, signature: Buffer.alloc(64, 9).toString('base64url') },
      { ...fixture.envelope, previousEpochHeadDigest: prefixed('tampered-head') },
      { ...fixture.envelope, sourcePayload: Buffer.from('{"source":"tampered"}').toString('base64url') },
      { ...fixture.envelope, bundleDigest: raw('forged-bundle') },
    ];
    for (const candidate of cases) {
      expect(canonicalAgentOsEpochSourceBundleBytesV2(candidate)).toBeNull();
      expect(verifyAgentOsEpochSourceBundleV2(
        candidate, fixture.context, fixture.verifier, fixture.contextVerifier,
      ).ok).toBe(false);
    }
  });

  it('uses a distinct domain and contains verifier mutation or exceptions', () => {
    const fixture = sourceFixture();
    const legacyVerifier: AgentOsEpochSourceSignatureVerifierV2 = {
      verify: (request) => verifyEd25519(
        null,
        Buffer.from(request.canonicalDomainSeparatedPayload).subarray(1),
        fixture.publicKey,
        Buffer.from(request.signature),
      ),
    };
    expect(verifyAgentOsEpochSourceBundleV2(
      fixture.envelope, fixture.context, legacyVerifier, fixture.contextVerifier,
    ))
      .toMatchObject({ ok: false, issues: ['signature-invalid'] });
    expect(verifyAgentOsEpochSourceBundleV2(fixture.envelope, fixture.context, {
      verify: (request) => {
        request.signature.fill(0);
        request.canonicalDomainSeparatedPayload.fill(0);
        return true;
      },
    }, fixture.contextVerifier)).toMatchObject({ ok: false, issues: ['signature-invalid'] });
    expect(createAgentOsEpochSourceBundleV2(fixture.input, {
      ...fixture.signer,
      sign: (payload) => {
        payload.fill(0);
        return Buffer.alloc(64, 1);
      },
    })).toBeNull();
    expect(verifyAgentOsEpochSourceBundleV2(fixture.envelope, fixture.context, {
      verify: () => { throw new Error('no verifier'); },
    }, fixture.contextVerifier)).toMatchObject({ ok: false, issues: ['signature-invalid'] });
    expect(verifyAgentOsEpochSourceBundleV2(
      fixture.envelope, fixture.context, fixture.verifier, fixture.contextVerifier,
    ).ok).toBe(true);
  });

  it('rejects noncanonical, duplicate-key, unknown-field, accessor, and cyclic source values', () => {
    const fixture = sourceFixture();
    const bytes = canonicalAgentOsEpochSourceBundleBytesV2(fixture.envelope)!;
    expect(parseAgentOsEpochSourceBundleV2(Buffer.concat([bytes, Buffer.from('\n')]))).toBeNull();
    expect(parseAgentOsEpochSourceBundleV2(Buffer.from(
      `{"schemaVersion":2,${bytes.toString('utf8').slice(1)}`,
      'utf8',
    ))).toBeNull();
    expect(canonicalAgentOsEpochSourceBundleBytesV2({ ...fixture.envelope, extra: false })).toBeNull();
    const accessor = { ...fixture.envelope } as Record<string, unknown>;
    Object.defineProperty(accessor, 'epoch', { enumerable: true, get: () => 2 });
    expect(canonicalAgentOsEpochSourceBundleBytesV2(accessor)).toBeNull();
    const cycle = { ...fixture.envelope } as Record<string, unknown>;
    cycle['outcomePrincipalDigests'] = [cycle];
    expect(canonicalAgentOsEpochSourceBundleBytesV2(cycle)).toBeNull();
  });

  it('derives attempt identity from epoch, namespace, and durable tick without UUID truncation', () => {
    const base = startInput();
    const attemptIdInput = {
      epoch: base.epoch,
      attemptNamespaceDigest: base.attemptNamespaceDigest,
      durableTickDigest: base.durableTickDigest,
    };
    const attemptId = agentOsEpochAttemptIdV1(attemptIdInput);
    expect(attemptId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(agentOsEpochAttemptIdV1({ ...attemptIdInput, epoch: 3 })).not.toBe(attemptId);
    expect(agentOsEpochAttemptIdV1({ ...attemptIdInput, attemptNamespaceDigest: prefixed('other-namespace') }))
      .not.toBe(attemptId);
    expect(agentOsEpochAttemptIdV1({ ...attemptIdInput, durableTickDigest: prefixed('other-tick') }))
      .not.toBe(attemptId);
    expect(agentOsEpochAttemptIdV1({
      ...attemptIdInput,
      durableTickDigest: raw('wrong-representation'),
    })).toBeNull();
  });

  it('creates, authenticates, and joins an exact epoch-bound start-to-terminal attempt', () => {
    const { signer, verifier } = attemptCrypto();
    const closure = attemptClosure();
    const start = createAgentOsEpochAttemptReceiptV2(startInput(), signer)!;
    const terminal = createAgentOsEpochAttemptReceiptV2({
      ...startInput(),
      transitionOrdinal: 2,
      previousReceiptDigest: start.receiptDigest,
      outcome: 'succeeded',
      snapshotEnvelopeDigest: raw('snapshot'),
      completedAt: '2026-09-03T12:00:10.000Z',
    }, signer)!;
    expect(start.attemptId).toBe(terminal.attemptId);
    expect(verifyAgentOsEpochAttemptReceiptV2(
      start, closure.context, verifier, closure.contextVerifier,
    )).toEqual(start);
    expect(verifyAgentOsEpochAttemptTransitionV2(
      start, terminal, closure.context, verifier, closure.contextVerifier,
    )).toEqual({ start, terminal });
    expect(start).toMatchObject(AGENT_OS_EPOCH_RECORD_AUTHORITY_V1);
    expect(terminal).toMatchObject(AGENT_OS_EPOCH_RECORD_AUTHORITY_V1);
    expect(Object.isFrozen(start)).toBe(true);
  });

  it('requires an authenticated active attempt closure and rejects every context substitution', () => {
    const { signer, verifier } = attemptCrypto();
    const closure = attemptClosure();
    const start = createAgentOsEpochAttemptReceiptV2(startInput(), signer)!;
    const permissiveContextVerifier: AgentOsEpochAttemptClosureContextVerifierV2 = {
      verify: () => true,
    };
    for (const replacement of [
      { epoch: 3 },
      { attemptNamespaceDigest: prefixed('other-namespace') },
      { sourceBundleDigest: raw('other-source') },
      { trustPolicyDigest: raw('other-policy') },
    ]) {
      expect(verifyAgentOsEpochAttemptReceiptV2(
        start,
        { ...closure.context, ...replacement },
        verifier,
        permissiveContextVerifier,
      )).toBeNull();
    }
    expect(verifyAgentOsEpochAttemptReceiptV2(
      start, closure.context, verifier, { verify: () => false },
    )).toBeNull();
    expect(verifyAgentOsEpochAttemptReceiptV2(start, closure.context, verifier, {
      verify: () => { throw new Error('anchor unavailable'); },
    })).toBeNull();
    let callbackSawFrozenContext = false;
    expect(verifyAgentOsEpochAttemptReceiptV2(start, closure.context, verifier, {
      verify: (candidate) => {
        callbackSawFrozenContext = Object.isFrozen(candidate);
        (candidate as { epoch: number }).epoch = 99;
        return true;
      },
    })).toBeNull();
    expect(callbackSawFrozenContext).toBe(true);
    expect(closure.context.epoch).toBe(2);
  });

  it('rejects cross-epoch, cross-namespace, cross-tick, source, and predecessor transition replay', () => {
    const { signer, verifier } = attemptCrypto();
    const closure = attemptClosure();
    const start = createAgentOsEpochAttemptReceiptV2(startInput(), signer)!;
    for (const replacement of [
      { epoch: 3 },
      { attemptNamespaceDigest: prefixed('other-namespace') },
      { durableTickDigest: prefixed('other-tick') },
      { sourceBundleDigest: raw('other-source') },
      { trustPolicyDigest: raw('other-policy') },
      { previousReceiptDigest: raw('other-start') },
    ]) {
      const terminal = createAgentOsEpochAttemptReceiptV2({
        ...startInput(),
        transitionOrdinal: 2,
        previousReceiptDigest: start.receiptDigest,
        outcome: 'failed',
        completedAt: '2026-09-03T12:00:10.000Z',
        ...replacement,
      }, signer);
      expect(terminal).not.toBeNull();
      expect(verifyAgentOsEpochAttemptTransitionV2(
        start, terminal, closure.context, verifier, closure.contextVerifier,
      )).toBeNull();
    }
  });

  it('enforces exact transition shape, time ordering, and successful snapshot binding', () => {
    const { signer } = attemptCrypto();
    expect(createAgentOsEpochAttemptReceiptV2({
      ...startInput(), outcome: 'failed',
    }, signer)).toBeNull();
    expect(createAgentOsEpochAttemptReceiptV2({
      ...startInput(), transitionOrdinal: 2, previousReceiptDigest: raw('start'),
      outcome: 'succeeded', completedAt: '2026-09-03T12:00:10.000Z',
    }, signer)).toBeNull();
    expect(createAgentOsEpochAttemptReceiptV2({
      ...startInput(), transitionOrdinal: 2, previousReceiptDigest: raw('start'),
      outcome: 'failed', completedAt: '2026-09-03T11:59:59.999Z',
    }, signer)).toBeNull();
    expect(createAgentOsEpochAttemptReceiptV2({
      ...startInput(), transitionOrdinal: 2, previousReceiptDigest: raw('start'),
      outcome: 'failed', snapshotEnvelopeDigest: raw('forbidden'),
      completedAt: '2026-09-03T12:00:10.000Z',
    }, signer)).toBeNull();
  });

  it('rejects attempt tampering, wrong authenticators, and mutation callbacks', () => {
    const { signer, verifier } = attemptCrypto();
    const closure = attemptClosure();
    const start = createAgentOsEpochAttemptReceiptV2(startInput(), signer)!;
    expect(verifyAgentOsEpochAttemptReceiptV2(
      { ...start, epoch: 3 }, closure.context, verifier, closure.contextVerifier,
    )).toBeNull();
    expect(verifyAgentOsEpochAttemptReceiptV2(
      start, closure.context, attemptCrypto().verifier, closure.contextVerifier,
    )).toEqual(start);
    const wrongKeyAuthenticator = { ...attemptCrypto().verifier, keyId: raw('wrong-key') };
    expect(verifyAgentOsEpochAttemptReceiptV2(
      start, closure.context, wrongKeyAuthenticator, closure.contextVerifier,
    )).toBeNull();
    expect(verifyAgentOsEpochAttemptReceiptV2(start, closure.context, {
      ...verifier,
      verify: (request) => {
        request.canonicalDomainSeparatedReceipt.fill(0);
        return true;
      },
    }, closure.contextVerifier)).toBeNull();
    expect(verifyAgentOsEpochAttemptReceiptV2(
      start, closure.context, verifier, closure.contextVerifier,
    )).toEqual(start);
    expect(createAgentOsEpochAttemptReceiptV2(startInput(), {
      ...signer,
      authenticate: (payload) => {
        payload.fill(0);
        return raw('syntactically-valid-mutated-request-tag');
      },
    })).toBeNull();
  });

  it('rejects noncanonical, duplicate-key, unknown-field, accessor, and cyclic attempt values', () => {
    const { signer } = attemptCrypto();
    const start = createAgentOsEpochAttemptReceiptV2(startInput(), signer)!;
    const bytes = canonicalAgentOsEpochAttemptReceiptBytesV2(start)!;
    expect(parseAgentOsEpochAttemptReceiptV2(Buffer.concat([bytes, Buffer.from(' ') ]))).toBeNull();
    expect(parseAgentOsEpochAttemptReceiptV2(Buffer.from(
      `{"schemaVersion":2,${bytes.toString('utf8').slice(1)}`,
      'utf8',
    ))).toBeNull();
    expect(canonicalAgentOsEpochAttemptReceiptBytesV2({ ...start, extra: false })).toBeNull();
    const accessor = { ...start } as Record<string, unknown>;
    Object.defineProperty(accessor, 'epoch', { enumerable: true, get: () => 2 });
    expect(canonicalAgentOsEpochAttemptReceiptBytesV2(accessor)).toBeNull();
    const cycle = { ...start } as Record<string, unknown>;
    cycle['attemptId'] = cycle;
    expect(canonicalAgentOsEpochAttemptReceiptBytesV2(cycle)).toBeNull();
  });

  it('fails closed rather than throwing on malformed API inputs', () => {
    const fixture = sourceFixture();
    expect(() => verifyAgentOsEpochSourceBundleV2(
      null,
      fixture.context,
      fixture.verifier,
      fixture.contextVerifier,
    )).not.toThrow();
    expect(verifyAgentOsEpochSourceBundleV2(
      null, fixture.context, fixture.verifier, fixture.contextVerifier,
    ).ok).toBe(false);
    expect(createAgentOsEpochAttemptReceiptV2(
      null as unknown as AgentOsEpochAttemptReceiptInputV2,
      attemptCrypto().signer,
    )).toBeNull();
    const closure = attemptClosure();
    expect(verifyAgentOsEpochAttemptReceiptV2(
      null, closure.context, attemptCrypto().verifier, closure.contextVerifier,
    )).toBeNull();
  });
});

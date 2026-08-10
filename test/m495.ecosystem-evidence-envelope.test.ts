import { describe, expect, it } from 'vitest';

import {
  assessLocusEvidenceForRealization,
  cortexMissionCandidateDigest,
  evaluateCurrentLocusReadiness,
  locusBoundEvidenceEnvelopeDigest,
  validateCortexMissionCandidate,
  validateLocusBoundEvidenceEnvelope,
  type CortexMissionCandidateV1,
  type LocusBoundEvidenceEnvelopeV1,
} from '../src/core/vision/ecosystem-evidence-envelope.js';

const NOW = '2026-08-10T02:00:00.000Z';
const ISSUED = '2026-08-10T01:55:00.000Z';
const EXPIRES = '2026-08-10T02:10:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function candidate(
  overrides: Partial<CortexMissionCandidateV1> = {},
): CortexMissionCandidateV1 {
  const value: CortexMissionCandidateV1 = {
    schemaVersion: 1,
    authority: 'planning-candidate-only',
    digestAlgorithm: 'sha256',
    candidateDigest: SHA_A,
    candidateId: 'candidate:cortex-001',
    revision: 3,
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    replayKey: 'replay:cortex-001-r3',
    source: {
      system: 'ashlr-cortex',
      organizationRef: 'org:opaque-001',
      space: 'business',
      workstream: 'commercial',
      sensitivity: 'restricted',
    },
    accountability: {
      accountableRef: 'person:opaque-001',
      dueAt: '2026-08-20T16:00:00.000Z',
    },
    intent: {
      title: 'Make the engineering loop legible',
      objective: 'Give the operator one bounded candidate for a governed mission.',
      desiredOutcome: 'Engineering intent reaches Hub without importing unrestricted company memory.',
      constraints: ['No external mutation', 'Repository mapping remains local'],
      successSignals: ['A candidate preview is understandable', 'No boundary data leaks'],
      guardrails: ['No dispatch authority', 'No silent approval'],
    },
    ...overrides,
  };
  value.candidateDigest = cortexMissionCandidateDigest(value);
  return value;
}

function evidence(
  overrides: Partial<LocusBoundEvidenceEnvelopeV1> = {},
): LocusBoundEvidenceEnvelopeV1 {
  const value: LocusBoundEvidenceEnvelopeV1 = {
    schemaVersion: 1,
    authority: 'identity-evidence-only',
    digestAlgorithm: 'sha256',
    envelopeDigest: SHA_A,
    envelopeId: 'evidence:locus-001',
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    idempotencyKey: 'effect:mission-node-001',
    mission: {
      graphDigest: SHA_A,
      nodeKey: 'external-observation',
      purpose: 'external-read',
    },
    identity: {
      bindingRef: 'binding:opaque-001',
      tenantRef: 'tenant:opaque-001',
      principalRef: 'principal:opaque-001',
      sessionRef: 'session:digest-001',
      sealVerifiedAt: '2026-08-10T01:54:00.000Z',
    },
    operation: {
      provider: 'github',
      tool: 'github.pull_request.read',
      selectorsDigest: SHA_A,
      argsDigest: SHA_B,
      effectClass: 'read',
    },
    result: {
      state: 'observed',
      receiptRef: null,
      responseDigest: SHA_B,
      observedAt: '2026-08-10T01:54:30.000Z',
    },
    attestation: {
      kind: 'signed-locus-v1',
      issuerRevision: 'locus:769abe6',
      signature: 'A'.repeat(64),
    },
    ...overrides,
  };
  value.envelopeDigest = locusBoundEvidenceEnvelopeDigest(value);
  return value;
}

function realizationContext(
  value: LocusBoundEvidenceEnvelopeV1,
  overrides: Partial<Parameters<typeof assessLocusEvidenceForRealization>[1]> = {},
): Parameters<typeof assessLocusEvidenceForRealization>[1] {
  return {
    now: NOW,
    graphDigest: value.mission.graphDigest,
    nodeKey: value.mission.nodeKey,
    purpose: value.mission.purpose,
    verifiedEnvelope: {
      envelopeDigest: value.envelopeDigest,
      identity: {
        bindingRef: value.identity.bindingRef,
        tenantRef: value.identity.tenantRef,
        principalRef: value.identity.principalRef,
        sessionRef: value.identity.sessionRef,
      },
      operation: { ...value.operation },
    },
    ...overrides,
  };
}

function readinessReport(): Record<string, unknown> {
  return {
    version: '0.2.0',
    ready: true,
    status: 'ready',
    exit_code: 0,
    status_oneline: 'acme:acme-corp',
    pin: {
      alias: 'acme',
      tenant: 'acme-corp',
      binding_id: 'binding:opaque-001',
      expires_at: EXPIRES,
      seal_ok: true,
      expired: false,
      frozen: false,
    },
    required_servers: ['locus', 'phantom'],
    mcp_command: 'locus-mcp',
    mcp_registered: { claude: false, cursor: false, codex: true },
    // Current reports contain additional detail. It is deliberately not copied
    // into the sanitized readiness projection.
    home: '/private/operator/path',
    doctor: { arbitrary: 'untrusted-detail' },
    commands: { enter: 'locus enter acme', whoami: 'locus whoami' },
  };
}

describe('M495 Cortex mission-candidate contract', () => {
  it('validates a bounded planning-only candidate and canonicalizes set-like list order', () => {
    const first = candidate();
    const second = candidate({
      intent: {
        ...first.intent,
        constraints: [...first.intent.constraints].reverse(),
        successSignals: [...first.intent.successSignals].reverse(),
        guardrails: [...first.intent.guardrails].reverse(),
      },
    });

    expect(second.candidateDigest).toBe(first.candidateDigest);
    expect(validateCortexMissionCandidate(first, { now: NOW })).toEqual({
      ok: true,
      value: first,
      issues: [],
    });
    const validated = validateCortexMissionCandidate(first, { now: NOW });
    expect(validated.ok && validated.value).not.toBe(first);
  });

  it('rejects unknown authority-bearing fields, cross-boundary scope, expiry, and tampering', () => {
    const withRepo = { ...candidate(), targetRepo: '/tmp/repo' };
    expect(validateCortexMissionCandidate(withRepo, { now: NOW })).toMatchObject({
      ok: false,
      issues: [{ code: 'invalid-schema' }],
    });

    const crossBoundary = candidate({
      source: {
        system: 'ashlr-cortex',
        organizationRef: 'org:opaque-001',
        space: 'personal',
        workstream: 'govcon',
        sensitivity: 'govcon_only',
      },
    });
    expect(validateCortexMissionCandidate(crossBoundary, { now: NOW })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-boundary' })]),
    });

    const expired = candidate({ expiresAt: NOW });
    expect(validateCortexMissionCandidate(expired, { now: NOW })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'expired' })]),
    });

    const tampered = { ...candidate(), revision: 4 };
    expect(validateCortexMissionCandidate(tampered, { now: NOW })).toMatchObject({
      ok: false,
      issues: [{ code: 'digest-mismatch' }],
    });
  });

  it('rejects non-canonical prose, duplicate or empty lists, and govcon sensitivity outside govcon', () => {
    const malformed = candidate();
    malformed.intent.title = ' trailing ';
    malformed.intent.constraints = ['same', 'same'];
    malformed.source.sensitivity = 'govcon_only';
    malformed.candidateDigest = cortexMissionCandidateDigest(malformed);
    const result = validateCortexMissionCandidate(malformed, { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        'intent.title', 'intent.constraints', 'source.sensitivity',
      ]));
    }
  });

  it('rejects symbols, non-enumerable fields, and accessors without invoking them', () => {
    let getterCalls = 0;
    const accessor = candidate();
    Object.defineProperty(accessor, 'candidateId', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('candidate getter must not execute');
      },
    });
    expect(validateCortexMissionCandidate(accessor, { now: NOW })).toMatchObject({
      ok: false, issues: [{ code: 'invalid-schema' }],
    });
    expect(getterCalls).toBe(0);

    const hidden = candidate();
    Object.defineProperty(hidden.intent, 'approval', { value: true, enumerable: false });
    expect(validateCortexMissionCandidate(hidden, { now: NOW })).toMatchObject({ ok: false });

    const symbolic = candidate() as CortexMissionCandidateV1 & { [key: symbol]: boolean };
    symbolic[Symbol('authority')] = true;
    expect(validateCortexMissionCandidate(symbolic, { now: NOW })).toMatchObject({
      ok: false, issues: [{ code: 'invalid-schema' }],
    });
  });
});

describe('M495 Locus-bound evidence contract', () => {
  it('validates a digest-bound signed envelope without treating the digest as signature verification', () => {
    const value = evidence();
    const validated = validateLocusBoundEvidenceEnvelope(value, { now: NOW });
    expect(validated).toEqual({
      ok: true,
      value,
      issues: [],
    });
    expect(validated.ok && validated.value).not.toBe(value);
    expect(assessLocusEvidenceForRealization(value, realizationContext(value, {
      verifiedEnvelope: {
        ...realizationContext(value).verifiedEnvelope,
        envelopeDigest: SHA_B,
      },
    }))).toEqual({ eligible: false, reason: 'signature-unverified' });
    expect(assessLocusEvidenceForRealization(value, realizationContext(value)))
      .toEqual({ eligible: true, reason: 'eligible' });
  });

  it('never accepts unverified-local evidence for realization, even with an exact verified binding context', () => {
    const value = evidence({
      attestation: {
        kind: 'unverified-local',
        issuerRevision: 'locus:769abe6',
        signature: null,
      },
    });
    expect(validateLocusBoundEvidenceEnvelope(value, { now: NOW }).ok).toBe(true);
    expect(assessLocusEvidenceForRealization(value, realizationContext(value)))
      .toEqual({ eligible: false, reason: 'unverified-local' });
  });

  it('fails closed on extra fields, secret-like refs, effect substitution, missing receipts, and transport uncertainty', () => {
    const extra = { ...evidence(), approval: true };
    expect(validateLocusBoundEvidenceEnvelope(extra, { now: NOW })).toMatchObject({
      ok: false,
      issues: [{ code: 'invalid-schema' }],
    });

    const secretRef = evidence();
    secretRef.identity.sessionRef = 'hmac-sha256:deadbeef';
    secretRef.envelopeDigest = locusBoundEvidenceEnvelopeDigest(secretRef);
    expect(validateLocusBoundEvidenceEnvelope(secretRef, { now: NOW })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: 'identity.sessionRef' })]),
    });

    const substituted = evidence({
      mission: { graphDigest: SHA_A, nodeKey: 'external-observation', purpose: 'proposal-only-write' },
    });
    expect(validateLocusBoundEvidenceEnvelope(substituted, { now: NOW })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-boundary' })]),
    });

    const proposal = evidence({
      mission: { graphDigest: SHA_A, nodeKey: 'proposal-receipt', purpose: 'proposal-only-write' },
      operation: {
        provider: 'cortex', tool: 'proposal.create', selectorsDigest: SHA_A,
        argsDigest: SHA_B, effectClass: 'proposal-only',
      },
      result: { state: 'observed', receiptRef: null, responseDigest: SHA_B, observedAt: ISSUED },
    });
    expect(validateLocusBoundEvidenceEnvelope(proposal, { now: NOW })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: 'result.receiptRef' })]),
    });

    const unknown = evidence({
      result: { state: 'transport-unknown', receiptRef: null, responseDigest: null, observedAt: ISSUED },
    });
    expect(assessLocusEvidenceForRealization(unknown, realizationContext(unknown)))
      .toEqual({ eligible: false, reason: 'not-observed' });
  });

  it('binds eligibility to the exact graph, node, purpose, time, and untampered digest', () => {
    const value = evidence();
    expect(assessLocusEvidenceForRealization(value, realizationContext(value, {
      graphDigest: SHA_B,
    }))).toEqual({ eligible: false, reason: 'mission-mismatch' });

    expect(validateLocusBoundEvidenceEnvelope(value, { now: EXPIRES })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'expired' })]),
    });

    const tampered = { ...value, idempotencyKey: 'effect:different' };
    expect(validateLocusBoundEvidenceEnvelope(tampered, { now: NOW })).toMatchObject({
      ok: false,
      issues: [{ code: 'digest-mismatch' }],
    });
  });

  it('binds realization to the exact tenant, principal session, provider, tool, selectors, and args', () => {
    const value = evidence();
    const expected = realizationContext(value);
    expect(assessLocusEvidenceForRealization(value, {
      ...expected,
      verifiedEnvelope: {
        ...expected.verifiedEnvelope,
        identity: { ...expected.verifiedEnvelope.identity, tenantRef: 'tenant:other' },
      },
    })).toEqual({ eligible: false, reason: 'identity-mismatch' });

    expect(assessLocusEvidenceForRealization(value, {
      ...expected,
      verifiedEnvelope: {
        ...expected.verifiedEnvelope,
        operation: { ...expected.verifiedEnvelope.operation, tool: 'github.issue.read' },
      },
    })).toEqual({ eligible: false, reason: 'operation-mismatch' });

    expect(assessLocusEvidenceForRealization(value, {
      ...expected,
      verifiedEnvelope: {
        ...expected.verifiedEnvelope,
        operation: { ...expected.verifiedEnvelope.operation, argsDigest: SHA_A },
      },
    })).toEqual({ eligible: false, reason: 'operation-mismatch' });
  });

  it('rejects accessor, hidden, and symbol envelope fields and returns a detached sanitized clone', () => {
    let getterCalls = 0;
    const accessor = evidence();
    Object.defineProperty(accessor.operation, 'tool', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('envelope getter must not execute');
      },
    });
    expect(validateLocusBoundEvidenceEnvelope(accessor, { now: NOW })).toMatchObject({ ok: false });
    expect(getterCalls).toBe(0);

    const hidden = evidence();
    Object.defineProperty(hidden.identity, 'credential', { value: 'secret', enumerable: false });
    expect(validateLocusBoundEvidenceEnvelope(hidden, { now: NOW })).toMatchObject({ ok: false });

    const symbolic = evidence() as LocusBoundEvidenceEnvelopeV1 & { [key: symbol]: boolean };
    symbolic[Symbol('verified')] = true;
    expect(validateLocusBoundEvidenceEnvelope(symbolic, { now: NOW })).toMatchObject({
      ok: false, issues: [{ code: 'invalid-schema' }],
    });

    const original = evidence();
    const validated = validateLocusBoundEvidenceEnvelope(original, { now: NOW });
    if (!validated.ok) throw new Error('expected valid evidence');
    expect(validated.value.identity).not.toBe(original.identity);
    original.identity.tenantRef = 'tenant:changed-after-validation';
    expect(validated.value.identity.tenantRef).toBe('tenant:opaque-001');
  });
});

describe('M495 current Locus readiness projection', () => {
  it('requires explicit positive pin facts and returns only a bounded sanitized projection', () => {
    const report = readinessReport();
    expect(evaluateCurrentLocusReadiness(report, { now: NOW })).toEqual({
      allow: true,
      blockers: [],
      readiness: {
        version: '0.2.0',
        status: 'ready',
        statusOneline: 'acme:acme-corp',
        bindingAlias: 'acme',
        tenant: 'acme-corp',
        bindingId: 'binding:opaque-001',
        expiresAt: EXPIRES,
      },
    });
    expect(JSON.stringify(evaluateCurrentLocusReadiness(report, { now: NOW }))).not.toContain('/private/operator/path');
  });

  it('blocks absent pin, missing frozen=false, false seal, expiry, identity mismatch, and malformed MCP contract', () => {
    const cases: Array<[Record<string, unknown>, string]> = [];
    const noPin = readinessReport();
    delete noPin.pin;
    cases.push([noPin, 'invalid-pin']);

    const noFrozen = readinessReport();
    delete (noFrozen.pin as Record<string, unknown>).frozen;
    cases.push([noFrozen, 'frozen-pin']);

    const badSeal = readinessReport();
    (badSeal.pin as Record<string, unknown>).seal_ok = false;
    cases.push([badSeal, 'invalid-seal']);

    const expired = readinessReport();
    (expired.pin as Record<string, unknown>).expires_at = NOW;
    cases.push([expired, 'expired-pin']);

    const mismatch = readinessReport();
    mismatch.status_oneline = 'other:tenant';
    cases.push([mismatch, 'identity-mismatch']);

    const ambientProvider = readinessReport();
    ambientProvider.required_servers = ['locus', 'phantom', 'github'];
    cases.push([ambientProvider, 'invalid-mcp-contract']);

    const unknownRoot = readinessReport();
    unknownRoot.resolvedCredential = 'must-not-be-tolerated';
    cases.push([unknownRoot, 'invalid-report']);

    for (const [report, expected] of cases) {
      const result = evaluateCurrentLocusReadiness(report, { now: NOW });
      expect(result.allow, expected).toBe(false);
      if (!result.allow) expect(result.blockers, expected).toContain(expected);
    }
  });

  it('bounds readiness traversal without invoking getters or toJSON and rejects hidden or symbol fields', () => {
    let getterCalls = 0;
    const accessor = readinessReport();
    Object.defineProperty(accessor.doctor as object, 'credential', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('readiness getter must not execute');
      },
    });
    expect(evaluateCurrentLocusReadiness(accessor, { now: NOW })).toEqual({
      allow: false, blockers: ['invalid-report'], readiness: null,
    });
    expect(getterCalls).toBe(0);

    let toJsonCalls = 0;
    const toJson = readinessReport();
    (toJson.doctor as Record<string, unknown>).toJSON = () => {
      toJsonCalls += 1;
      return { ready: true };
    };
    expect(evaluateCurrentLocusReadiness(toJson, { now: NOW })).toMatchObject({
      allow: false, blockers: ['invalid-report'],
    });
    expect(toJsonCalls).toBe(0);

    const hidden = readinessReport();
    Object.defineProperty(hidden.pin as object, 'credential', { value: 'secret', enumerable: false });
    expect(evaluateCurrentLocusReadiness(hidden, { now: NOW })).toMatchObject({
      allow: false, blockers: ['invalid-report'],
    });

    const symbolic = readinessReport() as Record<string | symbol, unknown>;
    symbolic[Symbol('ready')] = true;
    expect(evaluateCurrentLocusReadiness(symbolic, { now: NOW })).toMatchObject({
      allow: false, blockers: ['invalid-report'],
    });

    const tooDeep = readinessReport();
    let cursor = tooDeep.doctor as Record<string, unknown>;
    for (let depth = 0; depth < 40; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor['next'] = next;
      cursor = next;
    }
    expect(evaluateCurrentLocusReadiness(tooDeep, { now: NOW })).toMatchObject({
      allow: false, blockers: ['invalid-report'],
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptanceContractDigestV1, createValueHypothesisV1, digestResourceEnvelopeV1,
  type ResourceEnvelopeV1, type ValueHypothesisDraftV1 } from '../src/core/vision/value-portfolio.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createValueAllocationReceipt, verifyValueAllocationReceipt, type ValueAllocationInput } from '../src/core/universe/value-allocation.js';
import { verifyDecisionTraceV1 } from '../src/core/universe/decision-trace.js';

const hooks = vi.hoisted(() => ({ readKey: vi.fn(), createKey: vi.fn() }));
vi.mock('../src/core/foundry/provenance.js', () => ({ loadExistingProvenanceKeyReadOnly: hooks.readKey, loadOrCreateKey: hooks.createKey }));
const options = { testKey: Buffer.alloc(32, 7) };
const sha = (character: string) => character.repeat(64);
const visionSpec = { content: 'Fictional vision v1', expectedDigest: digest('Fictional vision v1') };
const missionGraph = { content: 'Fictional mission graph v1', expectedDigest: digest('Fictional mission graph v1') };
const asOf = '2026-09-03T12:00:00.000Z';
const contract = { baselineDigest: sha('6'), metric: 'accepted-useful-changes', unit: 'changes', direction: 'increase' as const,
  effectiveThreshold: 20, refutationThreshold: 5, windowStart: '2026-09-01T12:00:00.000Z',
  windowEnd: '2026-09-05T12:00:00.000Z', minimumCausalGrade: 'quasi-experimental' as const };
function draft(index: number): ValueHypothesisDraftV1 {
  return { schemaVersion: 1, provenanceDigest: sha('0'), specDigest: visionSpec.expectedDigest,
    missionDigest: missionGraph.expectedDigest, missionNodeKey: `bet-${index}`, producerDigest: sha('d'), claim: `Test product bet ${index}`,
    constraints: { dependenciesSatisfied: true, humanGateRequired: false, reversible: true,
      allowedProviders: ['codex', 'claude', 'local'], shardable: false, shardPlanDigest: null },
    frozenOutcome: { acceptanceContractDigest: acceptanceContractDigestV1(contract)!, ...contract },
    budget: { maxTokens: 100_000, maxMinutes: 240, maxAttempts: 4, maxInconclusiveWindows: 2, spentTokens: 0,
      spentMinutes: 0, attempts: 0, inconclusiveWindows: 0, deadline: '2026-09-10T12:00:00.000Z', minimumMarginalValue: 0.05 },
    factors: { productImpact: 0.9 - index * 0.01, informationGain: 0.8, strategicLeverage: 0.9, ipLeverage: 0.85,
      dependencyUnlock: 0.7, probability: 0.75, risk: 0.2, uncertainty: 0.3, estimatedTokens: 20_000,
      estimatedMinutes: 20, factorSourceDigest: sha('7') },
    outcomeSource: { complete: true, sourceDigest: sha('e'), evidence: null } };
}
function input(count = 4): ValueAllocationInput {
  const resourceEnvelope: ResourceEnvelopeV1 = { schemaVersion: 1, sourceComplete: true, sourceDigest: sha('c'), reserveFraction: 0.1,
    capacity: [{ executionIdentityDigest: sha('1'), provider: 'codex', state: 'open', trustedTokens: 100_000, trustedMinutes: 120,
      resetAt: '2026-09-03T14:00:00.000Z' }, { executionIdentityDigest: sha('2'), provider: 'local', state: 'open',
      trustedTokens: 100_000, trustedMinutes: 120, resetAt: null }] };
  const hypotheses = Array.from({ length: count }, (_, index) => createValueHypothesisV1(draft(index))!);
  return { schemaVersion: 1, asOf, constitutionVersion: 'v1', policyEpoch: 2, visionSpec: { ...visionSpec }, missionGraph: { ...missionGraph },
    resourceEnvelope, expectedResourceEnvelopeDigest: digestResourceEnvelopeV1(resourceEnvelope)!, hypotheses,
    expectedHypothesesDigest: digest(canonical(hypotheses)) };
}
function allocate(value: ValueAllocationInput = input()) {
  const result = createValueAllocationReceipt(value, options);
  if (!result.ok) throw new Error(result.reason);
  return result;
}
beforeEach(() => { hooks.readKey.mockReset().mockReturnValue(null); hooks.createKey.mockReset(); });

describe('evidence-pinned value allocation caller', () => {
  it('emits deterministic receipt and signed trace without granting effects or observing sources', () => {
    const source = input(); const before = canonical(source); const first = allocate(source); const second = allocate(source);
    expect(first).toEqual(second); expect(canonical(source)).toBe(before);
    expect(first.receipt.sourceEvidence).toEqual({ mode: 'caller-pinned', externallyObserved: false, semanticsVerified: false });
    expect(Object.values(first.receipt.authority)).toEqual([false, false, false, false]);
    expect(Object.values(first.receipt.portfolio.effects).every((value) => value === false)).toBe(true);
    expect(first.trace).toMatchObject({ action: 'value-allocation-recorded', verifier: { independent: false },
      spend: { unknown: true }, authority: { effectClass: 'observe', denied: true }, artifactDigest: first.receipt.receiptDigest });
    expect(verifyDecisionTraceV1(first.trace, options)).toBe(true);
    expect(verifyValueAllocationReceipt(first.receipt, first.trace, options)).toBe(true);
    source.hypotheses[0]!.claim = 'Changed after return'; expect(verifyValueAllocationReceipt(first.receipt, first.trace, options)).toBe(true);
    expect(hooks.readKey).not.toHaveBeenCalled(); expect(hooks.createKey).not.toHaveBeenCalled();
  });

  it('delegates candidate, active bet, reserve and concentration limits to the existing pure portfolio', () => {
    const result = allocate(input(12)); const portfolio = result.receipt.portfolio;
    expect(portfolio.bounds).toMatchObject({ maxCandidates: 12, maxActive: 3, minimumReserveFraction: 0.1, maximumBetFraction: 0.4 });
    const allocations = portfolio.decisions.filter((row) => row.allocation !== null);
    expect(allocations).toHaveLength(3); expect(portfolio.resources.reservedTokens).toBe(20_000);
    expect(allocations.every((row) => row.allocation!.tokens <= portfolio.resources.usableTokens * 0.4)).toBe(true);
    expect(createValueAllocationReceipt(input(13), options)).toMatchObject({ ok: false, reason: 'portfolio-invalid' });
    const tooLittleReserve = input(); tooLittleReserve.resourceEnvelope.reserveFraction = 0.09;
    expect(createValueAllocationReceipt(tooLittleReserve, options).ok).toBe(false);
  });

  it('preserves deterministic core output when caller inventory and hypothesis order changes', () => {
    const source = input(); const first = allocate(source); source.hypotheses.reverse(); source.resourceEnvelope.capacity.reverse();
    source.expectedHypothesesDigest = digest(canonical(source.hypotheses));
    const second = allocate(source); expect(first.receipt.portfolio).toEqual(second.receipt.portfolio);
    expect(first.receipt.basis.hypothesesDigest).not.toBe(second.receipt.basis.hypothesesDigest);
  });

  it.each(['visionSpec', 'missionGraph'] as const)('rejects changed %s bytes or pin before signing', (field) => {
    const source = input(); source[field].content += ' drift';
    expect(createValueAllocationReceipt(source)).toMatchObject({ ok: false, reason: 'source-digest-mismatch', receipt: null, trace: null });
    source[field].expectedDigest = digest(source[field].content);
    expect(createValueAllocationReceipt(source, options)).toMatchObject({ ok: false, reason: 'portfolio-invalid' });
    expect(hooks.readKey).not.toHaveBeenCalled();
  });

  it('rejects changed capacity, hypothesis content and forged digest pins', () => {
    const source = input(); source.resourceEnvelope.capacity[0]!.trustedTokens++;
    expect(createValueAllocationReceipt(source, options)).toMatchObject({ ok: false, reason: 'resource-envelope-digest-mismatch' });
    const changed = input(); changed.hypotheses[0]!.claim = 'forged';
    expect(createValueAllocationReceipt(changed, options)).toMatchObject({ ok: false, reason: 'hypotheses-digest-mismatch' });
    changed.expectedHypothesesDigest = digest(canonical(changed.hypotheses));
    expect(createValueAllocationReceipt(changed, options)).toMatchObject({ ok: false, reason: 'portfolio-invalid' });
    expect(createValueAllocationReceipt({ ...input(), expectedHypothesesDigest: sha('f') }, options)).toMatchObject({ ok: false, reason: 'hypotheses-digest-mismatch' });
  });

  it.each(['unknown', 'stale', 'reserved', 'exhausted'] as const)('does not allocate caller-recorded %s capacity', (state) => {
    const source = input(); for (const capacity of source.resourceEnvelope.capacity) capacity.state = state;
    source.expectedResourceEnvelopeDigest = digestResourceEnvelopeV1(source.resourceEnvelope)!;
    const result = allocate(source); expect(result.receipt.portfolio.decisions.every((row) => row.allocation === null)).toBe(true);
    expect(result.receipt.sourceEvidence.externallyObserved).toBe(false);
  });

  it('keeps source-incomplete evidence and expired capacity withheld rather than treating it as fresh', () => {
    const source = input(); source.resourceEnvelope.sourceComplete = false;
    source.expectedResourceEnvelopeDigest = digestResourceEnvelopeV1(source.resourceEnvelope)!;
    const result = allocate(source); expect(result.receipt.portfolio.resources.sourceComplete).toBe(false);
    expect(result.receipt.portfolio.decisions.every((row) => row.allocation === null)).toBe(true);
    const expired = input(); expired.resourceEnvelope.capacity = [expired.resourceEnvelope.capacity[0]!];
    expired.resourceEnvelope.capacity[0]!.resetAt = asOf;
    expired.expectedResourceEnvelopeDigest = digestResourceEnvelopeV1(expired.resourceEnvelope)!;
    expect(allocate(expired).receipt.portfolio.resources.usableTokens).toBe(0);
  });

  it('does not accept an outcome flag without a caller-owned authenticated verifier boundary', () => {
    const source = input(1); source.asOf = contract.windowEnd; const hypothesis = draft(0);
    hypothesis.outcomeSource.evidence = { format: 'outcome-evidence-v1', observerDigest: sha('8'), receiptDigest: sha('f'),
      artifactDigest: sha('9'), deploymentDigest: sha('a'), baselineDigest: contract.baselineDigest,
      acceptanceContractDigest: hypothesis.frozenOutcome.acceptanceContractDigest, metric: contract.metric, value: 30,
      observedAt: contract.windowEnd, windowStart: contract.windowStart, windowEnd: contract.windowEnd,
      causalGrade: 'experimental', guardrailBreached: false };
    const verifier = { verifyOutcomeEvidence: vi.fn(() => ({ authenticated: true, independentObserver: true })) };
    source.hypotheses = [createValueHypothesisV1(hypothesis, verifier)!]; source.expectedHypothesesDigest = digest(canonical(source.hypotheses));
    expect(createValueAllocationReceipt(source, options)).toMatchObject({ ok: false, reason: 'portfolio-invalid' });
    const result = createValueAllocationReceipt(source, { ...options, outcomeEvidenceVerifier: verifier });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.receipt.portfolio.decisions[0]!.reason).toBe('effective');
    expect(result.trace.verifier.independent).toBe(false); expect(result.receipt.sourceEvidence.externallyObserved).toBe(false);
    expect(verifier.verifyOutcomeEvidence).toHaveBeenCalled();
  });

  it('requires the existing host key and never initializes one or falls back to an unsigned receipt', () => {
    expect(createValueAllocationReceipt(input())).toMatchObject({ ok: false, reason: 'provenance-unavailable', receipt: null, trace: null });
    hooks.readKey.mockReturnValue(options.testKey); const result = createValueAllocationReceipt(input());
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(verifyValueAllocationReceipt(result.receipt, result.trace)).toBe(true);
    hooks.readKey.mockReturnValue(null); expect(verifyValueAllocationReceipt(result.receipt, result.trace)).toBe(false);
    hooks.readKey.mockImplementation(() => { throw new Error('private key location must not leak'); });
    expect(createValueAllocationReceipt(input())).toEqual({ ok: false, receipt: null, trace: null, reason: 'provenance-unavailable' });
    expect(hooks.createKey).not.toHaveBeenCalled();
  });

  it('rejects unknown receipt fields and getters before accepting signed evidence', () => {
    const { receipt, trace } = allocate(); const getter = vi.fn(() => receipt.portfolio);
    expect(verifyValueAllocationReceipt({ ...receipt, extra: true }, trace, options)).toBe(false);
    expect(verifyValueAllocationReceipt({ ...receipt, basis: { ...receipt.basis, observedLive: true } }, trace, options)).toBe(false);
    const unsafe = Object.defineProperty({ ...receipt }, 'portfolio', { get: getter });
    expect(verifyValueAllocationReceipt(unsafe, trace, options)).toBe(false); expect(getter).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'trace', 'policy', 'authority', 'source', 'portfolio', 'signature'] as const)('rejects %s tampering and cross-receipt trace transplantation', (field) => {
    const { receipt, trace } = allocate();
    if (field === 'receipt') receipt.receiptDigest = sha('0');
    if (field === 'trace') trace.inputsDigest = sha('0');
    if (field === 'policy') receipt.policyEpoch++;
    if (field === 'authority') (receipt.authority as { dispatch: boolean }).dispatch = true;
    if (field === 'source') (receipt.sourceEvidence as { externallyObserved: boolean }).externallyObserved = true;
    if (field === 'portfolio') receipt.portfolio.resources.usableTokens++;
    if (field === 'signature') trace.provenanceSig = sha('0');
    expect(verifyValueAllocationReceipt(receipt, trace, options)).toBe(false);
    const first = allocate(input(1)); const second = allocate(input(2));
    expect(verifyValueAllocationReceipt(first.receipt, second.trace, options)).toBe(false);
    expect(verifyValueAllocationReceipt(first.receipt, first.trace, { testKey: Buffer.alloc(32, 8) })).toBe(false);
  });

  it('rejects unknown fields, malformed clocks, oversized sources and getters without invoking caller code', () => {
    for (const patch of [{ unexpected: true }, { policyEpoch: -1 }, { asOf: 'tomorrow' },
      { visionSpec: { content: '\ud800', expectedDigest: digest('\ud800') } },
      { visionSpec: { content: 'x'.repeat(256 * 1024 + 1), expectedDigest: sha('a') } }, { hypotheses: Array(1) }]) {
      expect(createValueAllocationReceipt({ ...input(), ...patch }, options).ok).toBe(false);
    }
    const getter = vi.fn(() => 'hidden'); const source = input(); Object.defineProperty(source.visionSpec, 'content', { get: getter });
    expect(createValueAllocationReceipt(source, options).ok).toBe(false);
    const invalidOptions = Object.defineProperty({}, 'testKey', { get: getter });
    expect(createValueAllocationReceipt(input(), invalidOptions).ok).toBe(false); expect(getter).not.toHaveBeenCalled();
  });
});

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  STANDING_PERMIT_EVIDENCE_PROTOCOL,
  createStandingPermitContractV1,
  digestStandingPermitBudgetV1,
  digestStandingPermitEvidenceReceiptV1,
  digestStandingPermitWindowV1,
  evaluateStandingPermitCanariesV1,
  verifyStandingPermitContractV1,
  type StandingPermitBindingsV1,
  type StandingPermitContractInputV1,
  type StandingPermitContractV1,
  type StandingPermitCurrentEvidenceAnchorV1,
  type StandingPermitEvaluationDependenciesV1,
  type StandingPermitEvaluationInputV1,
  type StandingPermitEvidenceReceiptV1,
} from '../src/core/autonomy/standing-permit-shadow.js';

const NOW = '2026-09-03T16:00:00.000Z';
const WINDOW = {
  validFrom: '2026-09-03T15:00:00.000Z',
  expiresAt: '2026-09-04T15:00:00.000Z',
};
const BUDGET = { unit: 'tokens' as const, maximumUnits: 10_000 };

function d(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function bindings(overrides: Partial<StandingPermitBindingsV1> = {}): StandingPermitBindingsV1 {
  return {
    principalDigest: d('principal'),
    workloadDigest: d('workload'),
    repositoryDigest: d('repository'),
    missionDigest: d('mission'),
    specDigest: d('spec'),
    toolDigest: d('tool'),
    environmentDigest: d('environment'),
    budgetDigest: digestStandingPermitBudgetV1(BUDGET),
    timeWindowDigest: digestStandingPermitWindowV1(WINDOW),
    acceptanceDigest: d('acceptance'),
    rollbackDigest: d('rollback'),
    revocationPolicyDigest: d('revocation-policy'),
    ...overrides,
  };
}

function permitInput(overrides: Partial<StandingPermitContractInputV1> = {}): StandingPermitContractInputV1 {
  return {
    schemaVersion: 1,
    permitId: 'permit:workspace-edit:1',
    capability: 'workspace-edit',
    effectClass: 'workspace-write',
    blastRadius: 'repository',
    reversibility: 'proven',
    bindings: bindings(),
    window: WINDOW,
    budget: BUDGET,
    trustedSignerKeyId: d('trusted-signer'),
    requestedAt: '2026-09-03T14:59:00.000Z',
    ...overrides,
  };
}

function permit(overrides: Partial<StandingPermitContractInputV1> = {}): StandingPermitContractV1 {
  const result = createStandingPermitContractV1(permitInput(overrides));
  if (!result.ok) throw new Error(result.issues.join(','));
  return result.permit;
}

function receipt(
  contract: StandingPermitContractV1,
  sequence: number,
  previousReceiptDigest: string | null,
  overrides: Partial<Omit<StandingPermitEvidenceReceiptV1, 'receiptDigest'>> = {},
): StandingPermitEvidenceReceiptV1 {
  const unsigned: Omit<StandingPermitEvidenceReceiptV1, 'receiptDigest'> = {
    schemaVersion: 1,
    protocol: STANDING_PERMIT_EVIDENCE_PROTOCOL,
    sequence,
    previousReceiptDigest,
    permitDigest: contract.permitDigest,
    missionDigest: contract.bindings.missionDigest,
    specDigest: contract.bindings.specDigest,
    killEpochDigest: d('kill-epoch'),
    revocationEpochDigest: d('revocation-epoch'),
    budgetConsumedUnits: sequence === 1 ? 1_000 : 2_000,
    killSwitchOn: false,
    revoked: false,
    recordedAt: sequence === 1 ? '2026-09-03T15:57:00.000Z' : '2026-09-03T15:59:00.000Z',
    signerKeyId: contract.trustedSignerKeyId,
    authenticationClaim: 'ed25519-v1',
    appendOnly: true,
    sourceState: 'healthy',
    ...overrides,
  };
  return { ...unsigned, receiptDigest: digestStandingPermitEvidenceReceiptV1(unsigned) };
}

function evaluationInput(contract = permit()): StandingPermitEvaluationInputV1 {
  const first = receipt(contract, 1, null);
  const second = receipt(contract, 2, first.receiptDigest);
  return {
    schemaVersion: 1,
    evaluatedAt: NOW,
    permit: contract,
    currentBindings: contract.bindings,
    request: {
      capability: contract.capability,
      effectClass: contract.effectClass,
      requestedBudgetUnits: 3_000,
    },
    evidence: {
      sourceComplete: true,
      baseSequence: 1,
      basePreviousReceiptDigest: null,
      receipts: [first, second],
    },
    currentPosture: {
      killSwitchOn: false,
      revoked: false,
      killEpochDigest: second.killEpochDigest,
      revocationEpochDigest: second.revocationEpochDigest,
      observedAt: second.recordedAt,
      evidenceHeadDigest: second.receiptDigest,
    },
  };
}

const VERIFICATION = new WeakMap<StandingPermitEvaluationInputV1, StandingPermitEvaluationDependenciesV1>();

function trustCurrentEvidence(
  input: StandingPermitEvaluationInputV1,
  anchorOverrides: Partial<StandingPermitCurrentEvidenceAnchorV1> = {},
): StandingPermitEvaluationDependenciesV1 {
  const current = input.evidence.receipts.at(-1);
  if (!current) throw new Error('expected current evidence');
  const trustedReceiptDigests = new Set(input.evidence.receipts.map((item) => item.receiptDigest));
  const currentAnchor: StandingPermitCurrentEvidenceAnchorV1 = {
    schemaVersion: 1,
    permitDigest: input.permit.permitDigest,
    baseSequence: input.evidence.baseSequence,
    basePreviousReceiptDigest: input.evidence.basePreviousReceiptDigest,
    headReceiptDigest: current.receiptDigest,
    headSequence: current.sequence,
    minimumSequence: current.sequence,
    observedAt: NOW,
    ...anchorOverrides,
  };
  const trustedAnchor = JSON.stringify(currentAnchor);
  const dependencies: StandingPermitEvaluationDependenciesV1 = {
    verifier: {
      verifyReceipt: (candidate) => trustedReceiptDigests.has(candidate.receiptDigest),
      verifyCurrentAnchor: (candidate) => JSON.stringify(candidate) === trustedAnchor,
    },
    currentAnchor,
  };
  VERIFICATION.set(input, dependencies);
  return dependencies;
}

function verifiedEvaluationInput(contract = permit()): StandingPermitEvaluationInputV1 {
  const input = evaluationInput(contract);
  trustCurrentEvidence(input);
  return input;
}

function canary(input: StandingPermitEvaluationInputV1, name: string): boolean | undefined {
  return evaluateStandingPermitCanariesV1(input, VERIFICATION.get(input)).canaries
    .find((item) => item.name === name)?.passed;
}

describe('M532 standing-permit shadow contract', () => {
  it('builds a capability/effect-specific, fully bound, non-authoritative contract', () => {
    const contract = permit();
    expect(verifyStandingPermitContractV1(contract)).toBe(true);
    expect(contract).toMatchObject({
      mode: 'shadow',
      authority: 'observation-only',
      selfActivating: false,
      policyEligible: false,
      grantAuthority: false,
      executionAuthority: false,
    });

    const tampered = { ...contract, bindings: { ...contract.bindings, rollbackDigest: d('other-rollback') } };
    expect(verifyStandingPermitContractV1(tampered)).toBe(false);
  });

  it('produces stable digests for semantically identical nested records with different key insertion order', () => {
    const normal = permit();
    const reversedBindings = Object.fromEntries(Object.entries(bindings()).reverse()) as unknown as StandingPermitBindingsV1;
    const reordered = permit({ bindings: reversedBindings });
    expect(reordered.permitDigest).toBe(normal.permitDigest);
  });

  it('refuses mismatched capability/effect pairs and unbound window or budget values', () => {
    expect(createStandingPermitContractV1(permitInput({ effectClass: 'deploy' })).issues)
      .toContain('capability-effect-mismatch');
    expect(createStandingPermitContractV1(permitInput({
      bindings: bindings({ timeWindowDigest: d('wrong-window') }),
    })).issues).toContain('time-window-digest-mismatch');
    expect(createStandingPermitContractV1(permitInput({
      bindings: bindings({ budgetDigest: d('wrong-budget') }),
    })).issues).toContain('budget-digest-mismatch');
  });

  it('reports eligible criteria while keeping grant, execution, authority, and effects false', () => {
    const input = verifiedEvaluationInput();
    const result = evaluateStandingPermitCanariesV1(input, VERIFICATION.get(input));
    expect(result.eligibility).toMatchObject({ criteriaSatisfied: true, blockers: [] });
    expect(result.canaries.every((item) => item.passed)).toBe(true);
    expect(result.grant).toEqual({ requested: false, granted: false, grantDigest: null });
    expect(result.execution).toEqual({
      requested: false,
      authorized: false,
      performed: false,
      executionReceiptDigest: null,
    });
    expect(Object.values(result.authorityBits).every((value) => value === false)).toBe(true);
    expect(Object.values(result.effects).every((value) => value === false)).toBe(true);
  });

  it('does not treat marker strings or a same-bundle head and floor as authenticated', () => {
    const input = evaluationInput();
    const current = input.evidence.receipts.at(-1)!;
    const sameBundleAnchor: StandingPermitCurrentEvidenceAnchorV1 = {
      schemaVersion: 1,
      permitDigest: input.permit.permitDigest,
      baseSequence: input.evidence.baseSequence,
      basePreviousReceiptDigest: input.evidence.basePreviousReceiptDigest,
      headReceiptDigest: current.receiptDigest,
      headSequence: current.sequence,
      minimumSequence: current.sequence,
      observedAt: NOW,
    };
    const result = evaluateStandingPermitCanariesV1(input, {
      verifier: null,
      currentAnchor: sameBundleAnchor,
    });

    expect(result.canaries.find((item) => item.name === 'signer')?.passed).toBe(false);
    expect(result.canaries.find((item) => item.name === 'replay')?.passed).toBe(false);
    expect(result.canaries.find((item) => item.name === 'evidence-health')?.passed).toBe(false);
    expect(result.eligibility.criteriaSatisfied).toBe(false);
  });

  it('rejects a coherent fully forged bundle without an independent verifier capability', () => {
    const input = evaluationInput();
    const first = receipt(input.permit, 1, null, { signerKeyId: d('forged-signer') });
    const second = receipt(input.permit, 2, first.receiptDigest, { signerKeyId: d('forged-signer') });
    input.evidence.receipts = [first, second];
    input.currentPosture = {
      killSwitchOn: false,
      revoked: false,
      killEpochDigest: second.killEpochDigest,
      revocationEpochDigest: second.revocationEpochDigest,
      observedAt: second.recordedAt,
      evidenceHeadDigest: second.receiptDigest,
    };
    const forgedAnchor: StandingPermitCurrentEvidenceAnchorV1 = {
      schemaVersion: 1,
      permitDigest: input.permit.permitDigest,
      baseSequence: input.evidence.baseSequence,
      basePreviousReceiptDigest: input.evidence.basePreviousReceiptDigest,
      headReceiptDigest: second.receiptDigest,
      headSequence: second.sequence,
      minimumSequence: second.sequence,
      observedAt: NOW,
    };
    const result = evaluateStandingPermitCanariesV1(input, { verifier: null, currentAnchor: forgedAnchor });

    expect(result.canaries.filter((item) => ['signer', 'replay', 'evidence-health'].includes(item.name)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'signer', passed: false }),
        expect.objectContaining({ name: 'replay', passed: false }),
        expect.objectContaining({ name: 'evidence-health', passed: false }),
      ]));
    expect(result.eligibility.criteriaSatisfied).toBe(false);
    expect(result.grant.granted).toBe(false);
    expect(result.execution.authorized).toBe(false);
  });

  it('deterministically fails the expiry canary outside the signed time window', () => {
    const input = verifiedEvaluationInput();
    input.evaluatedAt = input.permit.window.expiresAt;
    expect(canary(input, 'expiry')).toBe(false);
    expect(evaluateStandingPermitCanariesV1(input, VERIFICATION.get(input)).eligibility.criteriaSatisfied).toBe(false);
  });

  it('detects replay when a valid historical chain is behind the required sequence floor', () => {
    const input = verifiedEvaluationInput();
    trustCurrentEvidence(input, {
      headReceiptDigest: d('independently-current-head'),
      headSequence: 3,
      minimumSequence: 3,
    });
    expect(canary(input, 'replay')).toBe(false);
  });

  it('accepts a bounded authenticated suffix after more than 128 lifetime receipts', () => {
    const input = evaluationInput();
    const basePredecessor = d('receipt-1000');
    const first = receipt(input.permit, 1_001, basePredecessor, {
      recordedAt: '2026-09-03T15:58:00.000Z',
      budgetConsumedUnits: 1_000,
    });
    const second = receipt(input.permit, 1_002, first.receiptDigest, {
      recordedAt: '2026-09-03T15:59:00.000Z',
      budgetConsumedUnits: 2_000,
    });
    input.evidence = {
      sourceComplete: true,
      baseSequence: 1_001,
      basePreviousReceiptDigest: basePredecessor,
      receipts: [first, second],
    };
    input.currentPosture = {
      killSwitchOn: false,
      revoked: false,
      killEpochDigest: second.killEpochDigest,
      revocationEpochDigest: second.revocationEpochDigest,
      observedAt: second.recordedAt,
      evidenceHeadDigest: second.receiptDigest,
    };
    trustCurrentEvidence(input);

    const result = evaluateStandingPermitCanariesV1(input, VERIFICATION.get(input));
    expect(result.eligibility.criteriaSatisfied).toBe(true);
    expect(result.canaries.find((item) => item.name === 'fork-rollback')?.passed).toBe(true);
    expect(input.evidence.receipts).toHaveLength(2);
  });

  it('detects an authenticated-looking fork or rollback in previous-receipt lineage', () => {
    const input = verifiedEvaluationInput();
    const fork = receipt(input.permit, 2, d('fork-anchor'));
    input.evidence.receipts[1] = fork;
    input.currentPosture = {
      ...input.currentPosture,
      observedAt: fork.recordedAt,
      evidenceHeadDigest: fork.receiptDigest,
      killEpochDigest: fork.killEpochDigest,
      revocationEpochDigest: fork.revocationEpochDigest,
    };
    expect(canary(input, 'fork-rollback')).toBe(false);
  });

  it('detects a consumption-counter rollback inside an otherwise valid receipt chain', () => {
    const input = verifiedEvaluationInput();
    const first = input.evidence.receipts[0]!;
    const rollback = receipt(input.permit, 2, first.receiptDigest, { budgetConsumedUnits: 999 });
    input.evidence.receipts[1] = rollback;
    input.currentPosture = {
      ...input.currentPosture,
      observedAt: rollback.recordedAt,
      evidenceHeadDigest: rollback.receiptDigest,
    };
    expect(canary(input, 'fork-rollback')).toBe(false);
  });

  it('fails closed when consumed plus requested budget exceeds the bound maximum', () => {
    const input = verifiedEvaluationInput();
    input.request.requestedBudgetUnits = 8_001;
    expect(canary(input, 'budget')).toBe(false);
  });

  it('detects changed mission or spec even when all other evidence is current', () => {
    const input = verifiedEvaluationInput();
    input.currentBindings = { ...input.currentBindings, missionDigest: d('changed-mission') };
    expect(canary(input, 'mission-spec')).toBe(false);
    expect(canary(input, 'bound-contract')).toBe(false);
  });

  it('fails on degraded/incomplete evidence and active kill or revocation posture', () => {
    const incomplete = verifiedEvaluationInput();
    incomplete.evidence.sourceComplete = false;
    expect(canary(incomplete, 'evidence-health')).toBe(false);

    for (const field of ['killSwitchOn', 'revoked'] as const) {
      const input = verifiedEvaluationInput();
      const first = input.evidence.receipts[0]!;
      const latest = receipt(input.permit, 2, first.receiptDigest, { [field]: true });
      input.evidence.receipts[1] = latest;
      input.currentPosture = {
        ...input.currentPosture,
        [field]: true,
        observedAt: latest.recordedAt,
        evidenceHeadDigest: latest.receiptDigest,
      };
      trustCurrentEvidence(input);
      expect(canary(input, 'evidence-health')).toBe(false);
    }
  });

  it('rejects non-reversible and ecosystem/external/production blast classes', () => {
    for (const contract of [
      permit({ reversibility: 'best-effort' }),
      permit({ reversibility: 'irreversible' }),
      permit({ blastRadius: 'ecosystem' }),
      permit({ blastRadius: 'external' }),
      permit({ blastRadius: 'production' }),
    ]) {
      expect(canary(verifiedEvaluationInput(contract), 'reversibility-blast-radius')).toBe(false);
    }
  });

  it('limits initial standing eligibility to workspace edits and model dispatches', () => {
    const modelPermit = permit({
      permitId: 'permit:model-dispatch:1',
      capability: 'model-dispatch',
      effectClass: 'provider-call',
    });
    const allowed = verifiedEvaluationInput(modelPermit);
    expect(evaluateStandingPermitCanariesV1(allowed, VERIFICATION.get(allowed)).eligibility.criteriaSatisfied).toBe(true);

    const disallowed = [
      ['source-commit', 'git-commit'],
      ['change-proposal', 'pull-request'],
      ['source-push', 'git-push'],
      ['host-merge', 'merge'],
      ['release-promotion', 'release'],
      ['production-deploy', 'deploy'],
      ['external-send', 'external-communication'],
      ['data-destruction', 'destructive'],
    ] as const;
    for (const [capability, effectClass] of disallowed) {
      const contract = permit({
        permitId: `permit:${capability}:1`,
        capability,
        effectClass,
        blastRadius: 'repository',
        reversibility: 'proven',
      });
      const candidate = verifiedEvaluationInput(contract);
      expect(canary(candidate, 'scope')).toBe(false);
      expect(evaluateStandingPermitCanariesV1(candidate, VERIFICATION.get(candidate)).eligibility.criteriaSatisfied)
        .toBe(false);
    }
  });

  it('detects signer mismatch despite a self-consistent receipt digest', () => {
    const input = verifiedEvaluationInput();
    const first = receipt(input.permit, 1, null, { signerKeyId: d('attacker') });
    const second = receipt(input.permit, 2, first.receiptDigest, { signerKeyId: d('attacker') });
    input.evidence.receipts = [first, second];
    input.currentPosture = {
      ...input.currentPosture,
      observedAt: second.recordedAt,
      evidenceHeadDigest: second.receiptDigest,
    };
    expect(canary(input, 'signer')).toBe(false);
  });

  it('rejects a forged receipt whose content no longer matches its digest', () => {
    const input = verifiedEvaluationInput();
    input.evidence.receipts[1] = { ...input.evidence.receipts[1]!, budgetConsumedUnits: 0 };
    expect(canary(input, 'evidence-health')).toBe(false);
    expect(canary(input, 'budget')).toBe(false);
  });
});

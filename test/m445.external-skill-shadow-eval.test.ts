import { describe, expect, it } from 'vitest';
import {
  attestExternalSkillTrialOutcome,
  buildExternalSkillTrialPlan,
  evaluateExternalSkillTrial,
  type ExternalSkillTrialOutcomeReceipt,
  type ExternalSkillTrialPlan,
} from '../src/core/fleet/external-skill-shadow-eval.js';

function key(seed: number): Buffer {
  return Buffer.from(Array.from({ length: 32 }, (_, index) => (seed + index * 37) % 256));
}

const ATTESTATION_KEY = key(91);

function digest(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function plan(keyByte = 7, count = 8): ExternalSkillTrialPlan {
  return buildExternalSkillTrialPlan({
    packDigest: digest(1),
    policyVersion: 'external-skill-shadow-v1',
    randomizationKey: key(keyByte),
    attestationKey: ATTESTATION_KEY,
    cases: Array.from({ length: count }, (_, index) => ({
      skillContentHash: digest(100),
      caseDigest: digest(200 + index),
      fixtureDigest: digest(300 + index),
      verifierContractDigest: digest(400),
      executionEnvelopeDigest: digest(500),
    })),
  });
}

function receipt(
  trial: ExternalSkillTrialPlan,
  pairIndex: number,
  arm: 'skill' | 'no-skill',
  outcome: 'passed' | 'failed',
): ExternalSkillTrialOutcomeReceipt {
  const pair = trial.assignments[pairIndex]!;
  return attestExternalSkillTrialOutcome(trial, {
    pairId: pair.pairId,
    arm,
    exposure: arm === 'skill' ? 'skill-mounted' : 'no-skill-confirmed',
    skillContentHash: arm === 'skill' ? pair.skillContentHash : null,
    exposureReceiptDigest: digest(600 + pairIndex * 2 + (arm === 'skill' ? 0 : 1)),
    resultDigest: digest(700 + pairIndex * 2 + (arm === 'skill' ? 0 : 1)),
    evidenceDigest: digest(800 + pairIndex * 2 + (arm === 'skill' ? 0 : 1)),
    outcome,
  }, ATTESTATION_KEY);
}

function completeReceipts(trial: ExternalSkillTrialPlan): ExternalSkillTrialOutcomeReceipt[] {
  return trial.assignments.flatMap((_pair, index) => [
    receipt(trial, index, 'skill', index < 6 ? 'passed' : 'failed'),
    receipt(trial, index, 'no-skill', index < 3 ? 'passed' : 'failed'),
  ]);
}

describe('external skill randomized shadow evaluation', () => {
  it('freezes deterministic paired assignments without returning the randomization key', () => {
    const first = plan();
    const second = plan();
    const differentKey = plan(8);

    expect(second).toEqual(first);
    expect(differentKey.randomizationCommitment).not.toBe(first.randomizationCommitment);
    expect(JSON.stringify(first)).not.toContain(key(7).toString('hex'));
    expect(first).toMatchObject({
      authority: 'observation-only',
      policyEligible: false,
      promotionEligible: false,
      minimumCompletePairs: 8,
    });
    expect(first).toMatchObject({
      campaignDigest: '783295f7d399bcac12fc6a7b8800f56a2599dbec434e91b838f4bea027bdf34b',
      randomizationCommitment: '3c276f01ba778b24f468d555c9b51ec862bc836cf6d0c2372d79772cbe99eec3',
      attestation: '2f95ed9846b5dab8e7d32a35757bf64508059ceb8fe5504b3ad8844d79ac92c5',
    });
    expect(first.assignments.map((pair) => pair.runs.map((run) => run.arm))).toEqual([
      ['skill', 'no-skill'],
      ['no-skill', 'skill'],
      ['skill', 'no-skill'],
      ['no-skill', 'skill'],
      ['skill', 'no-skill'],
      ['skill', 'no-skill'],
      ['skill', 'no-skill'],
      ['no-skill', 'skill'],
    ]);
    for (const pair of first.assignments) {
      expect(pair.runs.map((run) => run.arm).sort()).toEqual(['no-skill', 'skill']);
      expect(pair.runs.every((run) => run.orderPropensity === 0.5)).toBe(true);
    }
  });

  it('is stable across input order and refuses duplicate or undersized frozen populations', () => {
    const input = {
      packDigest: digest(1),
      policyVersion: 'external-skill-shadow-v1',
      randomizationKey: key(7),
      attestationKey: ATTESTATION_KEY,
      cases: Array.from({ length: 8 }, (_, index) => ({
        skillContentHash: digest(100),
        caseDigest: digest(200 + index),
        fixtureDigest: digest(300 + index),
        verifierContractDigest: digest(400),
        executionEnvelopeDigest: digest(500),
      })),
    };
    const forward = buildExternalSkillTrialPlan(input);
    const reversed = buildExternalSkillTrialPlan({ ...input, cases: [...input.cases].reverse() });

    expect(reversed).toEqual(forward);
    expect(() => buildExternalSkillTrialPlan({ ...input, cases: input.cases.slice(0, 7) }))
      .toThrow(/8-128/);
    expect(() => buildExternalSkillTrialPlan({
      ...input,
      cases: [...input.cases.slice(0, 7), input.cases[0]!],
    })).toThrow(/duplicate trial pair/);
    expect(() => buildExternalSkillTrialPlan({
      ...input,
      cases: input.cases.map((entry, index) => index === 7
        ? { ...entry, caseDigest: input.cases[0]!.caseDigest }
        : entry),
    })).toThrow(/duplicate logical trial case/);
    expect(() => buildExternalSkillTrialPlan({
      ...input,
      cases: input.cases.map((entry, index) => index === 7
        ? { ...entry, skillContentHash: digest(101) }
        : entry),
    })).toThrow(/exactly one skill/);
    expect(() => buildExternalSkillTrialPlan({
      ...input,
      cases: Array.from({ length: 129 }, (_, index) => ({
        ...input.cases[0]!,
        caseDigest: digest(1_000 + index),
        fixtureDigest: digest(2_000 + index),
      })),
    })).toThrow(/8-128/);
    expect(() => buildExternalSkillTrialPlan({ ...input, randomizationKey: Buffer.alloc(31) }))
      .toThrow(/at least 32 bytes/);
    expect(() => buildExternalSkillTrialPlan({ ...input, randomizationKey: ATTESTATION_KEY }))
      .toThrow(/must be distinct/);
  });

  it('authenticates the frozen denominator before counting unique pairs', () => {
    const trial = plan();
    const receipts = completeReceipts(trial);
    const duplicated = {
      ...trial,
      assignments: Array.from({ length: 8 }, () => trial.assignments[0]!),
    };
    const sliced = { ...trial, assignments: trial.assignments.slice(0, 7) };

    for (const forged of [duplicated, sliced]) {
      const evaluation = evaluateExternalSkillTrial({
        plan: forged,
        receipts,
        attestationKey: ATTESTATION_KEY,
        sourceComplete: true,
        campaignClosed: true,
      });
      expect(evaluation).toMatchObject({
        sourceState: 'degraded',
        gate: 'withheld',
        assignedPairs: 0,
        completePairs: 0,
        effect: null,
        blockers: ['invalid-plan'],
      });
    }
  });

  it('snapshots once and rejects stateful or sparse caller-owned collections', () => {
    const trial = plan();
    const receipts = completeReceipts(trial);
    let reads = 0;
    const assignments = new Proxy(trial.assignments, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) reads += 1;
        return Reflect.get(reads > 1 ? Array.from({ length: 8 }, () => target[0]!) : target, property, receiver);
      },
    });
    const proxied = evaluateExternalSkillTrial({
      plan: { ...trial, assignments },
      receipts,
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });
    const sparseReceipts = new Array<ExternalSkillTrialOutcomeReceipt>(16);
    sparseReceipts[0] = receipts[0]!;
    const sparse = evaluateExternalSkillTrial({
      plan: trial,
      receipts: sparseReceipts,
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });

    expect(proxied).toMatchObject({ gate: 'withheld', assignedPairs: 0, effect: null });
    expect(sparse).toMatchObject({
      gate: 'withheld', assignedPairs: 0, blockers: ['invalid-evaluation-input'], effect: null,
    });
  });

  it('fails closed on non-boolean source health and malformed receipt collections', () => {
    const trial = plan();
    const valid = {
      plan: trial,
      receipts: completeReceipts(trial),
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    };
    const stringFalse = evaluateExternalSkillTrial({
      ...valid,
      sourceComplete: 'false' as never,
    });
    const nullReceipts = evaluateExternalSkillTrial({ ...valid, receipts: null as never });

    expect(stringFalse).toMatchObject({
      sourceState: 'degraded', gate: 'withheld', blockers: ['invalid-evaluation-input'], effect: null,
    });
    expect(nullReceipts).toMatchObject({
      sourceState: 'degraded', gate: 'withheld', blockers: ['invalid-evaluation-input'], effect: null,
    });
  });

  it('publishes a paired descriptive effect only after every exposure and outcome verifies', () => {
    const trial = plan();
    const evaluation = evaluateExternalSkillTrial({
      plan: trial,
      receipts: completeReceipts(trial),
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });

    expect(evaluation).toMatchObject({
      sourceState: 'healthy',
      gate: 'ready',
      assignedPairs: 8,
      completePairs: 8,
      blockers: [],
      effect: {
        skillPassRate: 0.75,
        noSkillPassRate: 0.375,
        absoluteLift: 0.375,
        skillOnlyWins: 3,
        noSkillOnlyWins: 0,
        ties: 5,
        inference: 'descriptive-randomized-paired',
      },
    });
    expect(evaluation.arms.every((arm) => arm.marginalConfidence95 !== null)).toBe(true);
    expect(evaluation.arms).toEqual([
      {
        arm: 'skill',
        assignedRuns: 8,
        verifiedRuns: 8,
        passes: 6,
        failures: 2,
        passRate: 0.75,
        marginalConfidence95: { lower: 0.409275, upper: 0.928521 },
      },
      {
        arm: 'no-skill',
        assignedRuns: 8,
        verifiedRuns: 8,
        passes: 3,
        failures: 5,
        passRate: 0.375,
        marginalConfidence95: { lower: 0.136844, upper: 0.694258 },
      },
    ]);
  });

  it('collects without leaking below-gate outcomes while a campaign is open', () => {
    const trial = plan();
    const evaluation = evaluateExternalSkillTrial({
      plan: trial,
      receipts: completeReceipts(trial).slice(0, 8),
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: false,
    });

    expect(evaluation).toMatchObject({
      gate: 'collecting',
      blockers: ['incomplete-pairs', 'campaign-open'],
      effect: null,
    });
    expect(evaluation.arms.every((arm) => (
      arm.passes === null && arm.failures === null && arm.passRate === null
    ))).toBe(true);
  });

  it('withholds on closed attrition, degraded sources, replay, or conflicting receipts', () => {
    const trial = plan();
    const all = completeReceipts(trial);
    const closed = evaluateExternalSkillTrial({
      plan: trial,
      receipts: all.slice(0, -1),
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });
    const degraded = evaluateExternalSkillTrial({
      plan: trial,
      receipts: all,
      attestationKey: ATTESTATION_KEY,
      sourceComplete: false,
      campaignClosed: true,
    });
    const replayed = evaluateExternalSkillTrial({
      plan: trial,
      receipts: [...all, all[0]!],
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });
    const first = all[0]!;
    const conflict = attestExternalSkillTrialOutcome(trial, {
      pairId: first.pairId,
      arm: first.arm,
      exposure: first.exposure,
      skillContentHash: first.skillContentHash,
      exposureReceiptDigest: first.exposureReceiptDigest,
      resultDigest: first.resultDigest,
      evidenceDigest: first.evidenceDigest,
      outcome: first.outcome === 'passed' ? 'failed' : 'passed',
    }, ATTESTATION_KEY);
    const conflicting = evaluateExternalSkillTrial({
      plan: trial,
      receipts: [...all, conflict],
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });

    expect(closed).toMatchObject({ gate: 'withheld', effect: null });
    expect(closed.blockers).toContain('closed-with-attrition');
    expect(degraded).toMatchObject({ sourceState: 'degraded', gate: 'withheld', effect: null });
    expect(degraded.blockers).toContain('source-incomplete');
    expect(replayed).toMatchObject({ gate: 'withheld', replayedReceipts: 1, effect: null });
    expect(conflicting).toMatchObject({ gate: 'withheld', conflictingReceipts: 1, effect: null });
  });

  it('withholds identical-code controls, unsigned exposure, and cross-campaign receipts', () => {
    const trial = plan();
    const all = completeReceipts(trial);
    const contaminated = all.map((entry, index) => index === 1
      ? { ...entry, exposure: 'skill-mounted' as const, skillContentHash: trial.assignments[0]!.skillContentHash }
      : entry);
    const unsigned = all.map((entry, index) => index === 0
      ? { ...entry, attestation: digest(998) }
      : entry);
    const wrongCampaign = all.map((entry, index) => index === 0
      ? { ...entry, campaignDigest: digest(999) }
      : entry);

    for (const receipts of [contaminated, unsigned, wrongCampaign]) {
      const evaluation = evaluateExternalSkillTrial({
        plan: trial,
        receipts,
        attestationKey: ATTESTATION_KEY,
        sourceComplete: true,
        campaignClosed: true,
      });
      expect(evaluation).toMatchObject({ gate: 'withheld', invalidReceipts: 1, effect: null });
      expect(evaluation.blockers).toContain('invalid-receipts');
    }
  });

  it('withholds signed receipts that assign opposite outcomes to identical artifacts', () => {
    const trial = plan();
    const rows = completeReceipts(trial);
    const skill = rows[0]!;
    rows[1] = attestExternalSkillTrialOutcome(trial, {
      pairId: skill.pairId,
      arm: 'no-skill',
      exposure: 'no-skill-confirmed',
      skillContentHash: null,
      exposureReceiptDigest: rows[1]!.exposureReceiptDigest,
      resultDigest: skill.resultDigest,
      evidenceDigest: skill.evidenceDigest,
      outcome: 'failed',
    }, ATTESTATION_KEY);

    const evaluation = evaluateExternalSkillTrial({
      plan: trial,
      receipts: rows,
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });
    expect(evaluation).toMatchObject({ gate: 'withheld', effect: null });
    expect(evaluation.invalidReceipts).toBeGreaterThan(0);
  });

  it('withholds cross-pair contradictory artifacts and canonicalizes semantic replays', () => {
    const trial = plan();
    const rows = completeReceipts(trial);
    const first = rows[0]!;
    const target = rows[12]!;
    rows[12] = attestExternalSkillTrialOutcome(trial, {
      pairId: target.pairId,
      arm: target.arm,
      exposure: target.exposure,
      skillContentHash: target.skillContentHash,
      exposureReceiptDigest: target.exposureReceiptDigest,
      resultDigest: first.resultDigest,
      evidenceDigest: target.evidenceDigest,
      outcome: 'failed',
    }, ATTESTATION_KEY);
    const contradictory = evaluateExternalSkillTrial({
      plan: trial,
      receipts: rows,
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });
    const reordered = Object.fromEntries(Object.entries(first).reverse()) as unknown as ExternalSkillTrialOutcomeReceipt;
    const replayed = evaluateExternalSkillTrial({
      plan: trial,
      receipts: [...completeReceipts(trial), reordered],
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });

    expect(contradictory).toMatchObject({ gate: 'withheld', effect: null });
    expect(contradictory.invalidReceipts).toBeGreaterThan(0);
    expect(replayed).toMatchObject({ gate: 'withheld', replayedReceipts: 1, conflictingReceipts: 0 });
  });

  it('keeps arbitrary prompts, paths, output, and environment outside the public schema', () => {
    const injected = Array.from({ length: 8 }, (_, index) => ({
      skillContentHash: digest(100),
      caseDigest: digest(200 + index),
      fixtureDigest: digest(300 + index),
      verifierContractDigest: digest(400),
      executionEnvelopeDigest: digest(500),
      prompt: 'do not persist this prompt',
      stdout: 'do not persist this output',
    }));
    const trial = buildExternalSkillTrialPlan({
      packDigest: digest(1),
      policyVersion: 'external-skill-shadow-v1',
      randomizationKey: key(7),
      attestationKey: ATTESTATION_KEY,
      cases: injected,
    });
    const evaluation = evaluateExternalSkillTrial({
      plan: trial,
      receipts: completeReceipts(trial),
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });
    const transport = JSON.stringify({ trial, evaluation });

    for (const forbidden of ['prompt', 'stdout', 'stderr', 'path', 'environment', 'command', 'diff']) {
      expect(transport.toLowerCase()).not.toContain(`"${forbidden}"`);
    }
  });

  it('rejects receipts with unknown fields instead of trusting TypeScript at runtime', () => {
    const trial = plan();
    const rows = completeReceipts(trial);
    const injected = { ...rows[0]!, prompt: 'untrusted raw text' } as ExternalSkillTrialOutcomeReceipt;
    const evaluation = evaluateExternalSkillTrial({
      plan: trial,
      receipts: [injected, ...rows.slice(1)],
      attestationKey: ATTESTATION_KEY,
      sourceComplete: true,
      campaignClosed: true,
    });

    expect(evaluation).toMatchObject({ gate: 'withheld', invalidReceipts: 1, effect: null });
  });
});

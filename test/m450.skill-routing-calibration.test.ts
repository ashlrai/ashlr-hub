import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  evaluateSkillRoutingCalibration,
  type SkillRoutingCalibrationSnapshotV1,
  type SkillRoutingCaseV1,
  type SkillRoutingSkillV1,
  type SkillRoutingSparseTermV1,
} from '../src/core/fleet/skill-routing-calibration.js';

const SOURCE_KEY = Buffer.from('m450-test-source-key');
const AS_OF = '2026-07-22T12:00:00.000Z';
const SETTLED_AT = '2026-07-22T11:57:00.000Z';
const RECENT_AT = '2026-07-22T11:59:00.000Z';

function opaque(domain: string, value: string): string {
  return createHmac('sha256', SOURCE_KEY).update(`${domain}:${value}`).digest('hex');
}

const SKILL_A = opaque('skill', 'a');
const SKILL_B = opaque('skill', 'b');
const TERM_A = opaque('term', 'a');
const TERM_B = opaque('term', 'b');
const TERM_SHARED = opaque('term', 'shared');

function vector(...entries: Array<[string, number]>): SkillRoutingSparseTermV1[] {
  return entries.map(([termId, count]) => ({ termId, count }));
}

function skills(): SkillRoutingSkillV1[] {
  return [
    { skillId: SKILL_A, vector: vector([TERM_A, 1]) },
    { skillId: SKILL_B, vector: vector([TERM_B, 1]) },
  ];
}

function documentFrequencies(rows: readonly SkillRoutingSkillV1[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const skill of rows) {
    for (const term of skill.vector) frequencies.set(term.termId, (frequencies.get(term.termId) ?? 0) + 1);
  }
  return frequencies;
}

function cases(observedAt = SETTLED_AT): SkillRoutingCaseV1[] {
  const rows: SkillRoutingCaseV1[] = [];
  for (const [owner, excluded, term] of [
    [SKILL_A, SKILL_B, TERM_A],
    [SKILL_B, SKILL_A, TERM_B],
  ] as const) {
    for (let index = 0; index < 5; index += 1) {
      rows.push({
        caseId: opaque('case', `positive:${owner}:${index}`),
        kind: 'positive-owner',
        ownerSkillId: owner,
        excludedSkillId: null,
        observedAt,
        vector: vector([term, 1]),
      });
    }
    for (let index = 0; index < 3; index += 1) {
      rows.push({
        caseId: opaque('case', `negative:${owner}:${index}`),
        kind: 'negative-owner',
        ownerSkillId: owner,
        excludedSkillId: excluded,
        observedAt,
        vector: vector([term, 1]),
      });
    }
  }
  return rows;
}

function snapshot(overrides: Partial<SkillRoutingCalibrationSnapshotV1> = {}): SkillRoutingCalibrationSnapshotV1 {
  return {
    schemaVersion: 1,
    sourceRevision: 'revision-1',
    routerPolicyVersion: 'router-v1',
    sourceState: 'healthy',
    complete: true,
    invalidRows: 0,
    duplicateRows: 0,
    conflictingRows: 0,
    limitExceeded: false,
    skills: skills(),
    cases: cases(),
    ...overrides,
  };
}

function evaluate(first = snapshot(), second = structuredClone(first), asOf = AS_OF) {
  return evaluateSkillRoutingCalibration({ asOf, firstSnapshot: first, secondSnapshot: second });
}

describe('M450 SkillRoutingCalibrationV1', () => {
  it('reports ready only for settled, sample-complete calibration above every threshold', () => {
    const result = evaluate();

    expect(result).toMatchObject({
      schemaVersion: 1,
      protocol: 'skill-routing-calibration-v1',
      gate: 'ready',
      reason: 'calibration-ready',
      sourceState: 'healthy',
      settledThrough: '2026-07-22T11:58:00.000Z',
      excludedCases: 0,
      meetsCalibrationThresholds: true,
      authority: 'observation-only',
      routingAuthority: false,
      learningAuthority: false,
      policyAuthority: false,
      promotionAuthority: false,
      mergeAuthority: false,
    });
    expect(result.sample).toEqual({
      skills: 2,
      settledCases: 16,
      positiveCases: 10,
      negativeCases: 6,
      skillsMeetingSampleGate: 2,
      requiredPositivePerSkill: 5,
      requiredNegativePerSkill: 3,
    });
    expect(result.routing).toMatchObject({
      positiveRankOnePassed: 10,
      positiveRankOneAccuracy: 1,
      minimumPerSkillRankOneAccuracy: 1,
      negativeOwnerPassed: 6,
      negativeOwnerAccuracy: 1,
    });
    expect(result.collisions).toEqual({
      evaluatedPairs: 1,
      warningPairs: 0,
      errorPairs: 0,
      warningThreshold: 0.5,
      errorThreshold: 0.75,
    });
  });

  it('uses explicit asOf and produces deterministic results', () => {
    const first = snapshot();
    expect(evaluate(first)).toEqual(evaluate(structuredClone(first)));
    expect(evaluate(first, structuredClone(first), '2026-07-22T11:58:30.000Z')).toMatchObject({
      gate: 'collecting',
      reason: 'settlement-window',
    });
  });

  it('treats semantically reordered snapshots as stable', () => {
    const first = snapshot();
    const second = structuredClone(first);
    second.skills = [...second.skills].reverse();
    second.cases = [...second.cases].reverse().map((entry) => ({
      ...entry,
      vector: [...entry.vector].reverse(),
    }));
    expect(evaluate(first, second).gate).toBe('ready');
  });

  it('withholds when an independent snapshot mutates', () => {
    const first = snapshot();
    const second = structuredClone(first);
    second.cases[0]!.vector[0]!.count = 2;
    expect(evaluate(first, second)).toMatchObject({ gate: 'withheld', reason: 'snapshot-mutation', sourceState: 'degraded' });
  });

  it('withholds when source revision or router policy changes between reads', () => {
    const first = snapshot();
    expect(evaluate(first, snapshot({ sourceRevision: 'revision-2' })).reason).toBe('snapshot-mutation');
    expect(evaluate(first, snapshot({ routerPolicyVersion: 'router-v2' })).reason).toBe('snapshot-mutation');
  });

  it('returns collecting rather than a healthy zero for an empty source', () => {
    expect(evaluate(snapshot({ cases: [] }))).toMatchObject({
      gate: 'collecting',
      reason: 'no-settled-cases',
      sourceState: 'healthy',
      excludedCases: 0,
      sample: null,
      routing: null,
    });
  });

  it('returns collecting and excludes every all-recent case', () => {
    const recent = snapshot({ cases: cases(RECENT_AT) });
    expect(evaluate(recent)).toMatchObject({
      gate: 'collecting',
      reason: 'settlement-window',
      excludedCases: 16,
      sample: null,
    });
  });

  it('evaluates only settled cases and reports the excluded count', () => {
    const rows = cases();
    rows[0] = { ...rows[0]!, observedAt: RECENT_AT };
    const result = evaluate(snapshot({ cases: rows }));
    expect(result).toMatchObject({ gate: 'collecting', reason: 'insufficient-sample', excludedCases: 1 });
    expect(result.sample).toMatchObject({ settledCases: 15, positiveCases: 9 });
  });

  it('requires five positive and three negative cases for every skill', () => {
    const rows = cases().filter((entry) => !(entry.ownerSkillId === SKILL_A && entry.kind === 'negative-owner' &&
      entry.caseId === opaque('case', `negative:${SKILL_A}:2`)));
    const result = evaluate(snapshot({ cases: rows }));
    expect(result).toMatchObject({ gate: 'collecting', reason: 'insufficient-sample', meetsCalibrationThresholds: null });
    expect(result.sample?.skillsMeetingSampleGate).toBe(1);
  });

  it('fails a positive owner on a tied top score', () => {
    const rows = cases();
    for (const index of [0, 1]) rows[index] = { ...rows[index]!, vector: vector([TERM_A, 1], [TERM_B, 1]) };
    const result = evaluate(snapshot({ cases: rows }));
    expect(result).toMatchObject({ gate: 'withheld', reason: 'thresholds-not-met', meetsCalibrationThresholds: false });
    expect(result.routing).toMatchObject({ positiveRankOnePassed: 8, positiveRankOneAccuracy: 0.8, minimumPerSkillRankOneAccuracy: 0.6 });
  });

  it('does not let global accuracy hide a failing individual skill', () => {
    const rows = cases();
    for (const index of [0, 1]) rows[index] = { ...rows[index]!, vector: vector([TERM_B, 1]) };
    const result = evaluate(snapshot({ cases: rows }));
    expect(result.routing).toMatchObject({ positiveRankOneAccuracy: 0.8, minimumPerSkillRankOneAccuracy: 0.6 });
    expect(result.gate).toBe('withheld');
  });

  it('treats exact 80 percent global and per-skill rank-one accuracy as ready', () => {
    const rows = cases();
    rows[0] = { ...rows[0]!, vector: vector([TERM_B, 1]) };
    rows[8] = { ...rows[8]!, vector: vector([TERM_A, 1]) };
    const result = evaluate(snapshot({ cases: rows }));
    expect(result.routing).toMatchObject({ positiveRankOneAccuracy: 0.8, minimumPerSkillRankOneAccuracy: 0.8 });
    expect(result).toMatchObject({ gate: 'ready', reason: 'calibration-ready', meetsCalibrationThresholds: true });
  });

  it('requires a negative owner to strictly outrank the excluded skill', () => {
    const rows = cases();
    const index = rows.findIndex((entry) => entry.kind === 'negative-owner');
    rows[index] = { ...rows[index]!, vector: vector([TERM_A, 1], [TERM_B, 1]) };
    const result = evaluate(snapshot({ cases: rows }));
    expect(result.routing).toMatchObject({ negativeOwnerPassed: 5, negativeOwnerAccuracy: 5 / 6 });
    expect(result).toMatchObject({ gate: 'withheld', reason: 'thresholds-not-met' });
  });

  it('counts description collision errors and refuses readiness', () => {
    const duplicateDescriptions = snapshot({
      skills: [
        { skillId: SKILL_A, vector: vector([TERM_A, 1]) },
        { skillId: SKILL_B, vector: vector([TERM_A, 1]) },
      ],
    });
    const result = evaluate(duplicateDescriptions);
    expect(result.collisions).toMatchObject({ evaluatedPairs: 1, warningPairs: 0, errorPairs: 1 });
    expect(result.gate).toBe('withheld');
  });

  it('distinguishes warning collisions below the error threshold', () => {
    const warningSkills = [
      { skillId: SKILL_A, vector: vector([TERM_SHARED, 2], [TERM_A, 1]) },
      { skillId: SKILL_B, vector: vector([TERM_SHARED, 2], [TERM_B, 1]) },
    ];
    const result = evaluate(snapshot({ skills: warningSkills }));
    expect(result.collisions).toMatchObject({ warningPairs: 1, errorPairs: 0 });
  });

  it('counts similarity exactly at the inclusive 0.50 warning boundary', () => {
    const termAOnly = opaque('term', 'warning-a-only');
    const termBOnly = opaque('term', 'warning-b-only');
    const skillC = opaque('skill', 'warning-c');
    const skillD = opaque('skill', 'warning-d');
    // Every term occurs in exactly two skill vectors, so all IDF weights are equal.
    const boundarySkills = [
      { skillId: SKILL_A, vector: vector([TERM_SHARED, 1], [termAOnly, 1]) },
      { skillId: SKILL_B, vector: vector([TERM_SHARED, 1], [termBOnly, 1]) },
      { skillId: skillC, vector: vector([termAOnly, 1]) },
      { skillId: skillD, vector: vector([termBOnly, 1]) },
    ];
    expect([...documentFrequencies(boundarySkills).values()]).toEqual([2, 2, 2]);
    expect(1 / Math.sqrt(2 * 2)).toBe(0.5);
    const result = evaluate(snapshot({ skills: boundarySkills }));
    expect(result.collisions).toMatchObject({ evaluatedPairs: 6, warningPairs: 3, errorPairs: 0 });
  });

  it('counts similarity exactly at the inclusive 0.75 error boundary', () => {
    const supportTerms = Array.from({ length: 4 }, (_, index) => opaque('term', `error-support:${index}`));
    const supportCounts = [1, 1, 1, 2] as const;
    const supportSkills = supportTerms.map((termId, index) => ({
      skillId: opaque('skill', `error-support:${index}`),
      vector: vector([termId, 1]),
    }));
    // Each support term is repeated by one support skill, matching the shared term's df=2.
    const boundarySkills = [
      { skillId: SKILL_A, vector: vector([TERM_SHARED, 4]) },
      {
        skillId: SKILL_B,
        vector: vector(
          [TERM_SHARED, 3],
          ...supportTerms.map((termId, index) => [termId, supportCounts[index]!] as [string, number]),
        ),
      },
      ...supportSkills,
    ];
    expect([...documentFrequencies(boundarySkills).values()]).toEqual([2, 2, 2, 2, 2]);
    expect(12 / Math.sqrt(16 * 16)).toBe(0.75);
    const result = evaluate(snapshot({ skills: boundarySkills }));
    expect(result.collisions).toMatchObject({ evaluatedPairs: 15, warningPairs: 1, errorPairs: 1 });
  });

  it.each([
    ['source-degraded', { sourceState: 'degraded' as const }],
    ['source-incomplete', { complete: false }],
    ['source-invalid', { invalidRows: 1 }],
    ['duplicate-input', { duplicateRows: 1 }],
    ['conflicting-input', { conflictingRows: 1 }],
    ['input-limit-exceeded', { limitExceeded: true }],
  ])('fails closed for %s source quality', (reason, override) => {
    expect(evaluate(snapshot(override))).toMatchObject({ gate: 'withheld', reason, sourceState: 'degraded' });
  });

  it('rejects invalid or future timestamps', () => {
    expect(evaluate(snapshot(), snapshot(), 'not-a-time')).toMatchObject({ reason: 'invalid-as-of', settledThrough: null });
    const empty = snapshot({ cases: [] });
    expect(evaluate(empty, structuredClone(empty), '-271821-04-20T00:00:00.000Z')).toMatchObject({
      gate: 'withheld',
      reason: 'invalid-as-of',
      settledThrough: null,
    });
    const futureRows = cases('2026-07-22T12:00:01.000Z');
    expect(evaluate(snapshot({ cases: futureRows }))).toMatchObject({ gate: 'withheld', reason: 'source-invalid' });
  });

  it('rejects non-HMAC skill, case, and term identifiers', () => {
    const badSkill = snapshot({ skills: [{ skillId: 'skill-a', vector: vector([TERM_A, 1]) }] });
    expect(evaluate(badSkill).reason).toBe('invalid-input');

    const badCases = cases();
    badCases[0] = { ...badCases[0]!, caseId: 'case-a' };
    expect(evaluate(snapshot({ cases: badCases })).reason).toBe('invalid-input');

    const badTerm = skills();
    badTerm[0] = { ...badTerm[0]!, vector: vector(['term-a', 1]) };
    expect(evaluate(snapshot({ skills: badTerm })).reason).toBe('invalid-input');
  });

  it('rejects duplicate skill, case, and vector term identifiers', () => {
    expect(evaluate(snapshot({ skills: [skills()[0]!, skills()[0]!] })).reason).toBe('duplicate-input');
    const duplicateCases = cases();
    duplicateCases.push(structuredClone(duplicateCases[0]!));
    expect(evaluate(snapshot({ cases: duplicateCases })).reason).toBe('duplicate-input');
    const duplicateTermSkills = skills();
    duplicateTermSkills[0] = { skillId: SKILL_A, vector: vector([TERM_A, 1], [TERM_A, 2]) };
    expect(evaluate(snapshot({ skills: duplicateTermSkills })).reason).toBe('duplicate-input');
  });

  it('rejects missing owners and malformed negative-owner relationships', () => {
    const unknownOwner = cases();
    unknownOwner[0] = { ...unknownOwner[0]!, ownerSkillId: opaque('skill', 'missing') };
    expect(evaluate(snapshot({ cases: unknownOwner })).reason).toBe('invalid-input');

    const missingExcluded = cases();
    const negativeIndex = missingExcluded.findIndex((entry) => entry.kind === 'negative-owner');
    missingExcluded[negativeIndex] = { ...missingExcluded[negativeIndex]!, excludedSkillId: null };
    expect(evaluate(snapshot({ cases: missingExcluded })).reason).toBe('invalid-input');

    const selfExcluded = cases();
    selfExcluded[negativeIndex] = { ...selfExcluded[negativeIndex]!, excludedSkillId: selfExcluded[negativeIndex]!.ownerSkillId };
    expect(evaluate(snapshot({ cases: selfExcluded })).reason).toBe('invalid-input');

    const positiveExcluded = cases();
    positiveExcluded[0] = { ...positiveExcluded[0]!, excludedSkillId: SKILL_B };
    expect(evaluate(snapshot({ cases: positiveExcluded })).reason).toBe('invalid-input');
  });

  it('rejects empty, non-integer, and oversized sparse vectors', () => {
    const empty = skills();
    empty[0] = { skillId: SKILL_A, vector: [] };
    expect(evaluate(snapshot({ skills: empty })).reason).toBe('invalid-input');

    const fractional = skills();
    fractional[0] = { skillId: SKILL_A, vector: vector([TERM_A, 1.5]) };
    expect(evaluate(snapshot({ skills: fractional })).reason).toBe('invalid-input');

    const oversized = Array.from({ length: 257 }, (_, index) => ({ termId: opaque('term', `large:${index}`), count: 1 }));
    const tooWide = skills();
    tooWide[0] = { skillId: SKILL_A, vector: oversized };
    expect(evaluate(snapshot({ skills: tooWide })).reason).toBe('input-limit-exceeded');
  });

  it('rejects unknown fields so raw content cannot hitchhike through the evaluator', () => {
    const raw = snapshot() as SkillRoutingCalibrationSnapshotV1 & { prompt?: string };
    raw.prompt = 'sensitive';
    expect(evaluate(raw).reason).toBe('invalid-input');
  });

  it('returns aggregate metadata only', () => {
    const result = evaluate();
    const encoded = JSON.stringify(result);
    for (const privateValue of [SKILL_A, SKILL_B, TERM_A, TERM_B, 'revision-1', 'router-v1']) {
      expect(encoded).not.toContain(privateValue);
    }
    for (const forbiddenKey of [
      'skillId', 'caseId', 'termId', 'digest', 'prompt', 'description', 'path', 'prose',
      'diff', 'stdout', 'stderr', 'argv', 'env', 'sourceRevision', 'routerPolicyVersion',
    ]) {
      expect(Object.keys(result)).not.toContain(forbiddenKey);
      expect(encoded).not.toContain(`"${forbiddenKey}"`);
    }
  });

  it('never grants routing, learning, policy, promotion, or merge authority', () => {
    for (const result of [
      evaluate(),
      evaluate(snapshot({ cases: [] })),
      evaluate(snapshot({ sourceState: 'degraded' })),
    ]) {
      expect(result).toMatchObject({
        authority: 'observation-only',
        routingAuthority: false,
        learningAuthority: false,
        policyAuthority: false,
        promotionAuthority: false,
        mergeAuthority: false,
      });
    }
  });
});

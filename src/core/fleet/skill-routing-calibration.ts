const PROTOCOL = 'skill-routing-calibration-v1' as const;
const SETTLEMENT_WINDOW_MS = 2 * 60 * 1_000;
const MAX_SKILLS = 256;
const MAX_CASES = 10_000;
const MAX_VECTOR_TERMS = 256;
const MAX_TOTAL_VECTOR_TERMS = 250_000;
const MAX_TERM_COUNT = 1_000_000;
const REQUIRED_POSITIVE_PER_SKILL = 5;
const REQUIRED_NEGATIVE_PER_SKILL = 3;
const REQUIRED_RANK_ONE_ACCURACY = 0.8;
const REQUIRED_NEGATIVE_ACCURACY = 1;
const COLLISION_WARNING_THRESHOLD = 0.5;
const COLLISION_ERROR_THRESHOLD = 0.75;

const OPAQUE_HMAC_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface SkillRoutingSparseTermV1 {
  termId: string;
  count: number;
}

export interface SkillRoutingSkillV1 {
  skillId: string;
  vector: readonly SkillRoutingSparseTermV1[];
}

export interface SkillRoutingCaseV1 {
  caseId: string;
  kind: 'positive-owner' | 'negative-owner';
  ownerSkillId: string;
  excludedSkillId: string | null;
  observedAt: string;
  vector: readonly SkillRoutingSparseTermV1[];
}

export interface SkillRoutingCalibrationSnapshotV1 {
  schemaVersion: 1;
  sourceRevision: string;
  routerPolicyVersion: string;
  sourceState: 'healthy' | 'degraded';
  complete: boolean;
  invalidRows: number;
  duplicateRows: number;
  conflictingRows: number;
  limitExceeded: boolean;
  skills: readonly SkillRoutingSkillV1[];
  cases: readonly SkillRoutingCaseV1[];
}

export interface EvaluateSkillRoutingCalibrationInputV1 {
  asOf: string;
  firstSnapshot: SkillRoutingCalibrationSnapshotV1;
  secondSnapshot: SkillRoutingCalibrationSnapshotV1;
}

export type SkillRoutingCalibrationReasonV1 =
  | 'calibration-ready'
  | 'invalid-as-of'
  | 'invalid-input'
  | 'source-degraded'
  | 'source-incomplete'
  | 'source-invalid'
  | 'duplicate-input'
  | 'conflicting-input'
  | 'input-limit-exceeded'
  | 'snapshot-mutation'
  | 'no-settled-cases'
  | 'settlement-window'
  | 'insufficient-sample'
  | 'thresholds-not-met';

export interface SkillRoutingCalibrationSampleV1 {
  skills: number;
  settledCases: number;
  positiveCases: number;
  negativeCases: number;
  skillsMeetingSampleGate: number;
  requiredPositivePerSkill: 5;
  requiredNegativePerSkill: 3;
}

export interface SkillRoutingCalibrationRoutingV1 {
  positiveRankOnePassed: number;
  positiveRankOneAccuracy: number | null;
  minimumPerSkillRankOneAccuracy: number | null;
  negativeOwnerPassed: number;
  negativeOwnerAccuracy: number | null;
  requiredRankOneAccuracy: 0.8;
  requiredNegativeOwnerAccuracy: 1;
}

export interface SkillRoutingCalibrationCollisionsV1 {
  evaluatedPairs: number;
  warningPairs: number;
  errorPairs: number;
  warningThreshold: 0.5;
  errorThreshold: 0.75;
}

export interface SkillRoutingCalibrationV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  gate: 'ready' | 'collecting' | 'withheld';
  reason: SkillRoutingCalibrationReasonV1;
  sourceState: 'healthy' | 'degraded';
  settledThrough: string | null;
  excludedCases: number;
  sample: SkillRoutingCalibrationSampleV1 | null;
  routing: SkillRoutingCalibrationRoutingV1 | null;
  collisions: SkillRoutingCalibrationCollisionsV1 | null;
  meetsCalibrationThresholds: boolean | null;
  authority: 'observation-only';
  routingAuthority: false;
  learningAuthority: false;
  policyAuthority: false;
  promotionAuthority: false;
  mergeAuthority: false;
}

interface NormalizedTerm {
  termId: string;
  count: number;
}

interface NormalizedSkill {
  skillId: string;
  vector: NormalizedTerm[];
}

interface NormalizedCase {
  caseId: string;
  kind: SkillRoutingCaseV1['kind'];
  ownerSkillId: string;
  excludedSkillId: string | null;
  observedAt: string;
  vector: NormalizedTerm[];
}

interface NormalizedSnapshot {
  schemaVersion: 1;
  sourceRevision: string;
  routerPolicyVersion: string;
  sourceState: 'healthy' | 'degraded';
  complete: boolean;
  invalidRows: number;
  duplicateRows: number;
  conflictingRows: number;
  limitExceeded: boolean;
  skills: NormalizedSkill[];
  cases: NormalizedCase[];
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: SkillRoutingCalibrationReasonV1 };

const SNAPSHOT_KEYS = [
  'schemaVersion', 'sourceRevision', 'routerPolicyVersion', 'sourceState', 'complete',
  'invalidRows', 'duplicateRows', 'conflictingRows', 'limitExceeded', 'skills', 'cases',
] as const;
const SKILL_KEYS = ['skillId', 'vector'] as const;
const CASE_KEYS = ['caseId', 'kind', 'ownerSkillId', 'excludedSkillId', 'observedAt', 'vector'] as const;
const TERM_KEYS = ['termId', 'count'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validationFailure<T>(reason: SkillRoutingCalibrationReasonV1): ValidationResult<T> {
  return { ok: false, reason };
}

function compareOpaque(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeVector(value: unknown): ValidationResult<NormalizedTerm[]> {
  if (!Array.isArray(value)) return validationFailure('invalid-input');
  if (value.length === 0) return validationFailure('invalid-input');
  if (value.length > MAX_VECTOR_TERMS) return validationFailure('input-limit-exceeded');

  const terms: NormalizedTerm[] = [];
  const seen = new Set<string>();
  for (const rawTerm of value) {
    if (!isRecord(rawTerm) || !hasExactKeys(rawTerm, TERM_KEYS)) return validationFailure('invalid-input');
    const termId = rawTerm['termId'];
    const count = rawTerm['count'];
    if (typeof termId !== 'string' || !OPAQUE_HMAC_RE.test(termId) ||
      typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0 || count > MAX_TERM_COUNT) {
      return validationFailure('invalid-input');
    }
    if (seen.has(termId)) return validationFailure('duplicate-input');
    seen.add(termId);
    terms.push({ termId, count });
  }
  terms.sort((left, right) => compareOpaque(left.termId, right.termId));
  return { ok: true, value: terms };
}

function normalizeSnapshot(value: unknown): ValidationResult<NormalizedSnapshot> {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return validationFailure('invalid-input');
  if (value['schemaVersion'] !== 1 || typeof value['complete'] !== 'boolean' ||
    typeof value['limitExceeded'] !== 'boolean' || !Array.isArray(value['skills']) || !Array.isArray(value['cases']) ||
    typeof value['sourceRevision'] !== 'string' || !VERSION_RE.test(value['sourceRevision']) ||
    typeof value['routerPolicyVersion'] !== 'string' || !VERSION_RE.test(value['routerPolicyVersion']) ||
    (value['sourceState'] !== 'healthy' && value['sourceState'] !== 'degraded') ||
    !nonNegativeInteger(value['invalidRows']) || !nonNegativeInteger(value['duplicateRows']) ||
    !nonNegativeInteger(value['conflictingRows'])) {
    return validationFailure('invalid-input');
  }
  if (value['limitExceeded']) return validationFailure('input-limit-exceeded');
  if (value['conflictingRows'] > 0) return validationFailure('conflicting-input');
  if (value['duplicateRows'] > 0) return validationFailure('duplicate-input');
  if (value['invalidRows'] > 0) return validationFailure('source-invalid');
  if (value['sourceState'] === 'degraded') return validationFailure('source-degraded');
  if (!value['complete']) return validationFailure('source-incomplete');
  if (value['skills'].length === 0) return validationFailure('invalid-input');
  if (value['skills'].length > MAX_SKILLS || value['cases'].length > MAX_CASES) {
    return validationFailure('input-limit-exceeded');
  }

  let totalVectorTerms = 0;
  const skills: NormalizedSkill[] = [];
  const skillIds = new Set<string>();
  for (const rawSkill of value['skills']) {
    if (!isRecord(rawSkill) || !hasExactKeys(rawSkill, SKILL_KEYS)) return validationFailure('invalid-input');
    const skillId = rawSkill['skillId'];
    if (typeof skillId !== 'string' || !OPAQUE_HMAC_RE.test(skillId)) return validationFailure('invalid-input');
    if (skillIds.has(skillId)) return validationFailure('duplicate-input');
    const vector = normalizeVector(rawSkill['vector']);
    if (!vector.ok) return vector;
    skillIds.add(skillId);
    totalVectorTerms += vector.value.length;
    if (totalVectorTerms > MAX_TOTAL_VECTOR_TERMS) return validationFailure('input-limit-exceeded');
    skills.push({ skillId, vector: vector.value });
  }

  const cases: NormalizedCase[] = [];
  const caseIds = new Set<string>();
  for (const rawCase of value['cases']) {
    if (!isRecord(rawCase) || !hasExactKeys(rawCase, CASE_KEYS)) return validationFailure('invalid-input');
    const caseId = rawCase['caseId'];
    const ownerSkillId = rawCase['ownerSkillId'];
    const excludedSkillId = rawCase['excludedSkillId'];
    const kind = rawCase['kind'];
    const observedAt = canonicalTimestamp(rawCase['observedAt']);
    if (typeof caseId !== 'string' || !OPAQUE_HMAC_RE.test(caseId) || caseIds.has(caseId) ||
      typeof ownerSkillId !== 'string' || !OPAQUE_HMAC_RE.test(ownerSkillId) || !skillIds.has(ownerSkillId) ||
      (kind !== 'positive-owner' && kind !== 'negative-owner') || observedAt === null) {
      return caseIds.has(String(caseId)) ? validationFailure('duplicate-input') : validationFailure('invalid-input');
    }
    if ((kind === 'positive-owner' && excludedSkillId !== null) ||
      (kind === 'negative-owner' && (typeof excludedSkillId !== 'string' || !OPAQUE_HMAC_RE.test(excludedSkillId) ||
        !skillIds.has(excludedSkillId) || excludedSkillId === ownerSkillId))) {
      return validationFailure('invalid-input');
    }
    const vector = normalizeVector(rawCase['vector']);
    if (!vector.ok) return vector;
    caseIds.add(caseId);
    totalVectorTerms += vector.value.length;
    if (totalVectorTerms > MAX_TOTAL_VECTOR_TERMS) return validationFailure('input-limit-exceeded');
    cases.push({ caseId, kind, ownerSkillId, excludedSkillId: excludedSkillId as string | null, observedAt, vector: vector.value });
  }

  skills.sort((left, right) => compareOpaque(left.skillId, right.skillId));
  cases.sort((left, right) => compareOpaque(left.caseId, right.caseId));
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      sourceRevision: value['sourceRevision'],
      routerPolicyVersion: value['routerPolicyVersion'],
      sourceState: value['sourceState'],
      complete: value['complete'],
      invalidRows: value['invalidRows'],
      duplicateRows: value['duplicateRows'],
      conflictingRows: value['conflictingRows'],
      limitExceeded: value['limitExceeded'],
      skills,
      cases,
    },
  };
}

function baseResult(
  gate: SkillRoutingCalibrationV1['gate'],
  reason: SkillRoutingCalibrationReasonV1,
  sourceState: SkillRoutingCalibrationV1['sourceState'],
  settledThrough: string | null,
  excludedCases: number,
): SkillRoutingCalibrationV1 {
  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    gate,
    reason,
    sourceState,
    settledThrough,
    excludedCases,
    sample: null,
    routing: null,
    collisions: null,
    meetsCalibrationThresholds: null,
    authority: 'observation-only',
    routingAuthority: false,
    learningAuthority: false,
    policyAuthority: false,
    promotionAuthority: false,
    mergeAuthority: false,
  };
}

function rate(passed: number, total: number): number | null {
  return total === 0 ? null : passed / total;
}

function weightedVector(vector: readonly NormalizedTerm[], idf: ReadonlyMap<string, number>): Map<string, number> {
  const weighted = new Map<string, number>();
  for (const term of vector) weighted.set(term.termId, term.count * (idf.get(term.termId) ?? 1));
  return weighted;
}

function cosine(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  for (const [termId, value] of smaller) dot += value * (larger.get(termId) ?? 0);
  if (leftNorm === 0 || rightNorm === 0) return 0;
  const score = dot / Math.sqrt(leftNorm * rightNorm);
  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
}

export function evaluateSkillRoutingCalibration(
  input: EvaluateSkillRoutingCalibrationInputV1,
): SkillRoutingCalibrationV1 {
  try {
    if (!isRecord(input) || !hasExactKeys(input, ['asOf', 'firstSnapshot', 'secondSnapshot'])) {
      return baseResult('withheld', 'invalid-input', 'degraded', null, 0);
    }
    const asOf = canonicalTimestamp(input.asOf);
    if (asOf === null) return baseResult('withheld', 'invalid-as-of', 'degraded', null, 0);
    const first = normalizeSnapshot(input.firstSnapshot);
    if (!first.ok) return baseResult('withheld', first.reason, 'degraded', null, 0);
    const second = normalizeSnapshot(input.secondSnapshot);
    if (!second.ok) return baseResult('withheld', second.reason, 'degraded', null, 0);
    if (JSON.stringify(first.value) !== JSON.stringify(second.value)) {
      return baseResult('withheld', 'snapshot-mutation', 'degraded', null, 0);
    }

    const asOfMs = Date.parse(asOf);
    if (first.value.cases.some((entry) => Date.parse(entry.observedAt) > asOfMs)) {
      return baseResult('withheld', 'source-invalid', 'degraded', null, 0);
    }
    const settledThroughMs = asOfMs - SETTLEMENT_WINDOW_MS;
    if (!Number.isFinite(settledThroughMs) || settledThroughMs < -8_640_000_000_000_000) {
      return baseResult('withheld', 'invalid-as-of', 'degraded', null, 0);
    }
    const settledThrough = new Date(settledThroughMs).toISOString();
    const settledCases = first.value.cases.filter((entry) => Date.parse(entry.observedAt) <= settledThroughMs);
    const excludedCases = first.value.cases.length - settledCases.length;
    if (settledCases.length === 0) {
      return baseResult(
        'collecting',
        first.value.cases.length === 0 ? 'no-settled-cases' : 'settlement-window',
        'healthy',
        settledThrough,
        excludedCases,
      );
    }

    const documentFrequency = new Map<string, number>();
    for (const skill of first.value.skills) {
      for (const term of skill.vector) documentFrequency.set(term.termId, (documentFrequency.get(term.termId) ?? 0) + 1);
    }
    const idf = new Map<string, number>();
    for (const [termId, frequency] of documentFrequency) {
      idf.set(termId, Math.log((1 + first.value.skills.length) / (1 + frequency)) + 1);
    }
    for (const calibrationCase of settledCases) {
      for (const term of calibrationCase.vector) {
        if (!idf.has(term.termId)) idf.set(term.termId, Math.log(1 + first.value.skills.length) + 1);
      }
    }

    const weightedSkills = new Map<string, Map<string, number>>();
    for (const skill of first.value.skills) weightedSkills.set(skill.skillId, weightedVector(skill.vector, idf));

    const positiveBySkill = new Map<string, { total: number; passed: number }>();
    const negativeBySkill = new Map<string, { total: number; passed: number }>();
    for (const skill of first.value.skills) {
      positiveBySkill.set(skill.skillId, { total: 0, passed: 0 });
      negativeBySkill.set(skill.skillId, { total: 0, passed: 0 });
    }

    let positiveCases = 0;
    let positivePassed = 0;
    let negativeCases = 0;
    let negativePassed = 0;
    for (const calibrationCase of settledCases) {
      const weightedCase = weightedVector(calibrationCase.vector, idf);
      const scores = new Map<string, number>();
      for (const skill of first.value.skills) {
        scores.set(skill.skillId, cosine(weightedCase, weightedSkills.get(skill.skillId)!));
      }
      const ownerScore = scores.get(calibrationCase.ownerSkillId)!;
      if (calibrationCase.kind === 'positive-owner') {
        positiveCases += 1;
        const stats = positiveBySkill.get(calibrationCase.ownerSkillId)!;
        stats.total += 1;
        const passed = ownerScore > 0 && first.value.skills.every(
          (skill) => skill.skillId === calibrationCase.ownerSkillId || ownerScore > scores.get(skill.skillId)!,
        );
        if (passed) {
          positivePassed += 1;
          stats.passed += 1;
        }
      } else {
        negativeCases += 1;
        const stats = negativeBySkill.get(calibrationCase.ownerSkillId)!;
        stats.total += 1;
        const passed = ownerScore > scores.get(calibrationCase.excludedSkillId!)!;
        if (passed) {
          negativePassed += 1;
          stats.passed += 1;
        }
      }
    }

    let evaluatedPairs = 0;
    let warningPairs = 0;
    let errorPairs = 0;
    for (let left = 0; left < first.value.skills.length; left += 1) {
      for (let right = left + 1; right < first.value.skills.length; right += 1) {
        evaluatedPairs += 1;
        const similarity = cosine(
          weightedSkills.get(first.value.skills[left]!.skillId)!,
          weightedSkills.get(first.value.skills[right]!.skillId)!,
        );
        if (similarity >= COLLISION_ERROR_THRESHOLD) errorPairs += 1;
        else if (similarity >= COLLISION_WARNING_THRESHOLD) warningPairs += 1;
      }
    }

    let skillsMeetingSampleGate = 0;
    const perSkillRankOneAccuracy: number[] = [];
    for (const skill of first.value.skills) {
      const positive = positiveBySkill.get(skill.skillId)!;
      const negative = negativeBySkill.get(skill.skillId)!;
      if (positive.total >= REQUIRED_POSITIVE_PER_SKILL && negative.total >= REQUIRED_NEGATIVE_PER_SKILL) {
        skillsMeetingSampleGate += 1;
      }
      const accuracy = rate(positive.passed, positive.total);
      if (accuracy !== null) perSkillRankOneAccuracy.push(accuracy);
    }

    const sample: SkillRoutingCalibrationSampleV1 = {
      skills: first.value.skills.length,
      settledCases: settledCases.length,
      positiveCases,
      negativeCases,
      skillsMeetingSampleGate,
      requiredPositivePerSkill: REQUIRED_POSITIVE_PER_SKILL,
      requiredNegativePerSkill: REQUIRED_NEGATIVE_PER_SKILL,
    };
    const routing: SkillRoutingCalibrationRoutingV1 = {
      positiveRankOnePassed: positivePassed,
      positiveRankOneAccuracy: rate(positivePassed, positiveCases),
      minimumPerSkillRankOneAccuracy: perSkillRankOneAccuracy.length === first.value.skills.length
        ? Math.min(...perSkillRankOneAccuracy)
        : null,
      negativeOwnerPassed: negativePassed,
      negativeOwnerAccuracy: rate(negativePassed, negativeCases),
      requiredRankOneAccuracy: REQUIRED_RANK_ONE_ACCURACY,
      requiredNegativeOwnerAccuracy: REQUIRED_NEGATIVE_ACCURACY,
    };
    const collisions: SkillRoutingCalibrationCollisionsV1 = {
      evaluatedPairs,
      warningPairs,
      errorPairs,
      warningThreshold: COLLISION_WARNING_THRESHOLD,
      errorThreshold: COLLISION_ERROR_THRESHOLD,
    };

    const sampleComplete = skillsMeetingSampleGate === first.value.skills.length;
    const meetsThresholds = sampleComplete &&
      routing.positiveRankOneAccuracy !== null && routing.positiveRankOneAccuracy >= REQUIRED_RANK_ONE_ACCURACY &&
      routing.minimumPerSkillRankOneAccuracy !== null && routing.minimumPerSkillRankOneAccuracy >= REQUIRED_RANK_ONE_ACCURACY &&
      routing.negativeOwnerAccuracy === REQUIRED_NEGATIVE_ACCURACY && errorPairs === 0;
    const result = baseResult(
      sampleComplete ? (meetsThresholds ? 'ready' : 'withheld') : 'collecting',
      sampleComplete ? (meetsThresholds ? 'calibration-ready' : 'thresholds-not-met') : 'insufficient-sample',
      'healthy',
      settledThrough,
      excludedCases,
    );
    return {
      ...result,
      sample,
      routing,
      collisions,
      meetsCalibrationThresholds: sampleComplete ? meetsThresholds : null,
    };
  } catch {
    return baseResult('withheld', 'invalid-input', 'degraded', null, 0);
  }
}

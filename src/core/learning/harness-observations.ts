import { createHash } from 'node:crypto';

export const HARNESS_ACTION_CLASSES = ['read', 'write', 'exec', 'other'] as const;
export const HARNESS_OBSERVATION_OUTCOMES = [
  'returned',
  'committed',
  'refused',
  'failed',
  'uncertain',
  'unavailable',
] as const;

export type HarnessActionClassV1 = typeof HARNESS_ACTION_CLASSES[number];
export type HarnessObservationOutcomeV1 = typeof HARNESS_OBSERVATION_OUTCOMES[number];

export interface HarnessObservationDraftV1 {
  actionClass: HarnessActionClassV1;
  outcome: HarnessObservationOutcomeV1;
  observedAt: string;
}

export interface HarnessObservationV1 extends HarnessObservationDraftV1 {
  schemaVersion: 1;
  observationId: string;
  subjectRef: string;
  ordinal: number;
  producerVersion: 'harness-observation-v1';
}

export interface HarnessObservationSequenceProjectionV1 {
  state: 'available' | 'withheld';
  observations: HarnessObservationV1[];
}

export interface HarnessObservationAttemptV1 {
  runId: string;
  observations?: readonly HarnessObservationV1[];
  retainedCount?: number;
  truncated?: boolean;
  countIsLowerBound?: boolean;
}

export const MAX_HARNESS_OBSERVATIONS = 16;

export interface HarnessObservationCollectionV1 {
  observations: HarnessObservationV1[];
  retainedCount: number;
  truncated: boolean;
  countIsLowerBound: boolean;
}

export interface HarnessObservationAccumulatorV1 {
  drafts: HarnessObservationDraftV1[];
  seenCount: number;
  lastObservedAt?: string;
  malformed: boolean;
}

const OBSERVATION_ID_RE = /^aho-[a-f0-9]{64}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SUBJECT_RE = /^run:[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ACTION_CLASSES = new Set<string>(HARNESS_ACTION_CLASSES);
const OUTCOMES = new Set<string>(HARNESS_OBSERVATION_OUTCOMES);
const KEYS = [
  'actionClass',
  'observationId',
  'observedAt',
  'ordinal',
  'outcome',
  'producerVersion',
  'schemaVersion',
  'subjectRef',
];

type UnsignedHarnessObservationV1 = Omit<HarnessObservationV1, 'observationId'>;

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function payload(observation: UnsignedHarnessObservationV1): string {
  return JSON.stringify([
    'ashlr.harness-observation.v1',
    observation.schemaVersion,
    observation.subjectRef,
    observation.ordinal,
    observation.actionClass,
    observation.outcome,
    observation.producerVersion,
    observation.observedAt,
  ]);
}

export function harnessObservationSubjectRef(runId: string): string {
  if (!OPAQUE_ID_RE.test(runId)) throw new Error('harness observation run identity must be opaque');
  return `run:${runId}`;
}

export function harnessObservationId(observation: UnsignedHarnessObservationV1): string {
  return `aho-${createHash('sha256').update(payload(observation), 'utf8').digest('hex')}`;
}

export function defineHarnessObservations(
  subjectRef: string,
  drafts: readonly HarnessObservationDraftV1[],
): HarnessObservationV1[] {
  if (!SUBJECT_RE.test(subjectRef) || drafts.length < 1 || drafts.length > MAX_HARNESS_OBSERVATIONS) {
    throw new Error('invalid harness observation producer');
  }
  const observations = drafts.map((draft, index): HarnessObservationV1 => {
    const unsigned: UnsignedHarnessObservationV1 = {
      schemaVersion: 1,
      subjectRef,
      ordinal: index + 1,
      actionClass: draft.actionClass,
      outcome: draft.outcome,
      producerVersion: 'harness-observation-v1',
      observedAt: draft.observedAt,
    };
    return { ...unsigned, observationId: harnessObservationId(unsigned) };
  });
  const accepted = sanitizeHarnessObservations(observations, subjectRef);
  if (!accepted) throw new Error('invalid harness observation sequence');
  return accepted;
}

function sanitizeOne(value: unknown): HarnessObservationV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const observation = value as Record<string, unknown>;
  if (
    Object.keys(observation).sort().join(',') !== [...KEYS].sort().join(',') ||
    observation['schemaVersion'] !== 1 ||
    typeof observation['observationId'] !== 'string' ||
    !OBSERVATION_ID_RE.test(observation['observationId']) ||
    typeof observation['subjectRef'] !== 'string' ||
    !SUBJECT_RE.test(observation['subjectRef']) ||
    !Number.isSafeInteger(observation['ordinal']) ||
    Number(observation['ordinal']) < 1 ||
    Number(observation['ordinal']) > MAX_HARNESS_OBSERVATIONS ||
    typeof observation['actionClass'] !== 'string' ||
    !ACTION_CLASSES.has(observation['actionClass']) ||
    typeof observation['outcome'] !== 'string' ||
    !OUTCOMES.has(observation['outcome']) ||
    observation['producerVersion'] !== 'harness-observation-v1' ||
    !canonicalTimestamp(observation['observedAt'])
  ) return undefined;
  const typed = observation as unknown as HarnessObservationV1;
  const { observationId, ...unsigned } = typed;
  return harnessObservationId(unsigned) === observationId ? typed : undefined;
}

export function sanitizeHarnessObservations(
  value: unknown,
  expectedSubjectRef?: string,
): HarnessObservationV1[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_HARNESS_OBSERVATIONS) {
    return undefined;
  }
  const observations: HarnessObservationV1[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const observation = sanitizeOne(value[index]);
    const previous = observations[index - 1];
    if (
      !observation ||
      observation.ordinal !== index + 1 ||
      ids.has(observation.observationId) ||
      (expectedSubjectRef !== undefined && observation.subjectRef !== expectedSubjectRef) ||
      (previous && Date.parse(observation.observedAt) < Date.parse(previous.observedAt))
    ) return undefined;
    observations.push(observation);
    ids.add(observation.observationId);
  }
  return observations;
}

export function createHarnessObservationAccumulator(): HarnessObservationAccumulatorV1 {
  return { drafts: [], seenCount: 0, malformed: false };
}

export function recordHarnessObservation(
  accumulator: HarnessObservationAccumulatorV1,
  observation: Omit<HarnessObservationDraftV1, 'observedAt'>,
  observedAt?: string,
): void {
  if (accumulator.malformed) return;
  try {
    if (!ACTION_CLASSES.has(observation.actionClass) || !OUTCOMES.has(observation.outcome)) {
      throw new Error('invalid harness observation metadata');
    }
    const candidateObservedAt = observedAt ?? new Date().toISOString();
    if (!canonicalTimestamp(candidateObservedAt)) {
      throw new Error('invalid harness observation timestamp');
    }
    if (accumulator.seenCount >= Number.MAX_SAFE_INTEGER) {
      throw new Error('harness observation count exceeds safe integer range');
    }
    const previousMs = accumulator.lastObservedAt === undefined
      ? Number.NEGATIVE_INFINITY
      : Date.parse(accumulator.lastObservedAt);
    const clampedObservedAt = new Date(Math.max(previousMs, Date.parse(candidateObservedAt))).toISOString();
    const draft: HarnessObservationDraftV1 = { ...observation, observedAt: clampedObservedAt };
    accumulator.seenCount += 1;
    accumulator.lastObservedAt = clampedObservedAt;

    if (accumulator.drafts.length < MAX_HARNESS_OBSERVATIONS) {
      accumulator.drafts.push(draft);
      return;
    }
    const headCount = Math.floor(MAX_HARNESS_OBSERVATIONS / 2);
    if (accumulator.seenCount === MAX_HARNESS_OBSERVATIONS + 1) {
      const tail = accumulator.drafts.slice(-(MAX_HARNESS_OBSERVATIONS - headCount - 1));
      accumulator.drafts.splice(headCount, accumulator.drafts.length - headCount, ...tail, draft);
      return;
    }
    accumulator.drafts.splice(headCount, 1);
    accumulator.drafts.push(draft);
  } catch {
    accumulator.malformed = true;
    accumulator.drafts = [];
    delete accumulator.lastObservedAt;
  }
}

export function finalizeHarnessObservations(
  runId: string,
  accumulator: HarnessObservationAccumulatorV1,
): HarnessObservationCollectionV1 | undefined {
  if (
    accumulator.malformed ||
    accumulator.seenCount < 1 ||
    accumulator.drafts.length !== Math.min(accumulator.seenCount, MAX_HARNESS_OBSERVATIONS)
  ) {
    return undefined;
  }
  try {
    const observations = defineHarnessObservations(
      harnessObservationSubjectRef(runId),
      accumulator.drafts,
    );
    const truncated = accumulator.seenCount > observations.length;
    return {
      observations,
      retainedCount: observations.length,
      truncated,
      countIsLowerBound: truncated,
    };
  } catch {
    return undefined;
  }
}

export function aggregateHarnessObservations(
  finalRunId: string,
  attempts: readonly HarnessObservationAttemptV1[],
): HarnessObservationCollectionV1 | undefined {
  let finalSubjectRef: string;
  try {
    finalSubjectRef = harnessObservationSubjectRef(finalRunId);
  } catch {
    return undefined;
  }
  const ordered: HarnessObservationDraftV1[] = [];
  let sourceTruncated = false;
  let previousObservedAtMs = Number.NEGATIVE_INFINITY;
  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    const attempt = attempts[attemptIndex]!;
    if (Object.prototype.hasOwnProperty.call(attempt, 'totalCount')) return undefined;
    if (attempt.observations === undefined) {
      if (
        attempt.retainedCount === undefined &&
        attempt.truncated === undefined &&
        attempt.countIsLowerBound === undefined
      ) continue;
      return undefined;
    }
    let sourceSubjectRef: string;
    try {
      sourceSubjectRef = harnessObservationSubjectRef(attempt.runId);
    } catch {
      return undefined;
    }
    const accepted = sanitizeHarnessObservations(attempt.observations, sourceSubjectRef);
    if (!accepted) return undefined;
    const attemptRetainedCount = attempt.retainedCount ?? accepted.length;
    const attemptTruncated = attempt.truncated ?? accepted.length === MAX_HARNESS_OBSERVATIONS;
    const attemptCountIsLowerBound = attempt.countIsLowerBound ?? attemptTruncated;
    if (
      !Number.isSafeInteger(attemptRetainedCount) ||
      attemptRetainedCount !== accepted.length ||
      typeof attemptTruncated !== 'boolean' ||
      attemptCountIsLowerBound !== attemptTruncated ||
      (attemptTruncated && accepted.length !== MAX_HARNESS_OBSERVATIONS)
    ) return undefined;
    sourceTruncated ||= attemptTruncated;
    for (const observation of accepted) {
      previousObservedAtMs = Math.max(previousObservedAtMs, Date.parse(observation.observedAt));
      ordered.push({
        actionClass: observation.actionClass,
        outcome: observation.outcome,
        observedAt: new Date(previousObservedAtMs).toISOString(),
      });
    }
  }
  if (ordered.length === 0) return undefined;
  const selected = ordered.length <= MAX_HARNESS_OBSERVATIONS
    ? ordered
    : [
        ...ordered.slice(0, Math.floor(MAX_HARNESS_OBSERVATIONS / 2)),
        ...ordered.slice(-Math.ceil(MAX_HARNESS_OBSERVATIONS / 2)),
      ];
  try {
    const observations = defineHarnessObservations(finalSubjectRef, selected.map((observation) => ({
      actionClass: observation.actionClass,
      outcome: observation.outcome,
      observedAt: observation.observedAt,
    })));
    const truncated = sourceTruncated || ordered.length > observations.length;
    return {
      observations,
      retainedCount: observations.length,
      truncated,
      countIsLowerBound: truncated,
    };
  } catch {
    return undefined;
  }
}

export function projectHarnessObservationSequence(
  batches: readonly unknown[],
  expectedSubjectRef: string,
): HarnessObservationSequenceProjectionV1 {
  const byOrdinal = new Map<number, HarnessObservationV1>();
  for (const batch of batches) {
    const accepted = sanitizeHarnessObservations(batch, expectedSubjectRef);
    if (!accepted) return { state: 'withheld', observations: [] };
    for (const observation of accepted) {
      const previous = byOrdinal.get(observation.ordinal);
      if (previous && previous.observationId !== observation.observationId) {
        return { state: 'withheld', observations: [] };
      }
      byOrdinal.set(observation.ordinal, observation);
    }
  }
  const observations = [...byOrdinal.values()].sort((left, right) => left.ordinal - right.ordinal);
  if (observations.length === 0) return { state: 'available', observations: [] };
  const accepted = sanitizeHarnessObservations(observations, expectedSubjectRef);
  return accepted
    ? { state: 'available', observations: accepted }
    : { state: 'withheld', observations: [] };
}

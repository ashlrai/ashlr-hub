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
}

export const MAX_HARNESS_OBSERVATIONS = 16;

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

export function aggregateHarnessObservations(
  finalRunId: string,
  attempts: readonly HarnessObservationAttemptV1[],
): HarnessObservationV1[] | undefined {
  const finalSubjectRef = harnessObservationSubjectRef(finalRunId);
  const ordered: Array<HarnessObservationDraftV1 & { attemptIndex: number; sourceOrdinal: number }> = [];
  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    const attempt = attempts[attemptIndex]!;
    if (attempt.observations === undefined) continue;
    let sourceSubjectRef: string;
    try {
      sourceSubjectRef = harnessObservationSubjectRef(attempt.runId);
    } catch {
      return undefined;
    }
    const accepted = sanitizeHarnessObservations(attempt.observations, sourceSubjectRef);
    if (!accepted) return undefined;
    for (const observation of accepted) {
      ordered.push({
        actionClass: observation.actionClass,
        outcome: observation.outcome,
        observedAt: observation.observedAt,
        attemptIndex,
        sourceOrdinal: observation.ordinal,
      });
    }
  }
  if (ordered.length === 0) return undefined;
  ordered.sort((left, right) =>
    Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
    left.attemptIndex - right.attemptIndex ||
    left.sourceOrdinal - right.sourceOrdinal);
  const selected = ordered.length <= MAX_HARNESS_OBSERVATIONS
    ? ordered
    : [
        ...ordered.slice(0, Math.floor(MAX_HARNESS_OBSERVATIONS / 2)),
        ...ordered.slice(-Math.ceil(MAX_HARNESS_OBSERVATIONS / 2)),
      ];
  return defineHarnessObservations(finalSubjectRef, selected.map((observation) => ({
    actionClass: observation.actionClass,
    outcome: observation.outcome,
    observedAt: observation.observedAt,
  })));
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

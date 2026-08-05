import { createHash } from 'node:crypto';

import type { RunProposalOutcomeKind, RunState } from '../types.js';
import {
  harnessObservationSubjectRef,
  sanitizeHarnessObservations,
  type HarnessObservationV1,
} from './harness-observations.js';

export const AGENT_WORK_PHASES = [
  'orient',
  'inspect',
  'edit',
  'verify',
  'repair',
  'handoff',
  'complete',
] as const;

export const AGENT_WORK_TRANSITIONS = [
  'enter',
  'advance',
  'retry',
  'replan',
  'block',
  'handoff',
  'complete',
] as const;

export const AGENT_WORK_TRIGGERS = [
  'initial',
  'evidence-passed',
  'evidence-failed',
  'empty-diff',
  'capture-blocked',
  'dependency-unavailable',
  'resource-unavailable',
  'authority-blocked',
  'lease-lost',
  'peer-handoff',
  'unknown',
] as const;

export type AgentWorkPhaseV1 = typeof AGENT_WORK_PHASES[number];
export type AgentWorkTransitionCodeV1 = typeof AGENT_WORK_TRANSITIONS[number];
export type AgentWorkTriggerV1 = typeof AGENT_WORK_TRIGGERS[number];

export interface AgentWorkTransitionV1 {
  schemaVersion: 1;
  transitionId: string;
  subjectRef: string;
  ordinal: number;
  predecessorTransitionId?: string;
  phase: AgentWorkPhaseV1;
  transition: AgentWorkTransitionCodeV1;
  trigger: AgentWorkTriggerV1;
  parentSubjectRef?: string;
  producerVersion: 'agent-work-transition-v1';
  observedAt: string;
}

export interface AgentWorkTransitionDraftV1 {
  phase: AgentWorkPhaseV1;
  transition: AgentWorkTransitionCodeV1;
  trigger: AgentWorkTriggerV1;
  parentSubjectRef?: string;
  observedAt: string;
}

export interface AgentWorkTransitionSequenceProjectionV1 {
  state: 'available' | 'withheld';
  transitions: AgentWorkTransitionV1[];
}

const MAX_TRANSITIONS = 16;
const TRANSITION_ID_RE = /^awt-[a-f0-9]{64}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SUBJECT_RE = /^(?:run|trajectory):[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const PHASES = new Set<string>(AGENT_WORK_PHASES);
const TRANSITIONS = new Set<string>(AGENT_WORK_TRANSITIONS);
const TRIGGERS = new Set<string>(AGENT_WORK_TRIGGERS);
const REQUIRED_KEYS = [
  'observedAt',
  'ordinal',
  'phase',
  'producerVersion',
  'schemaVersion',
  'subjectRef',
  'transition',
  'transitionId',
  'trigger',
];
const OPTIONAL_KEYS = ['parentSubjectRef', 'predecessorTransitionId'];

type UnsignedAgentWorkTransitionV1 = Omit<AgentWorkTransitionV1, 'transitionId'>;

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>): boolean {
  const expected = [
    ...REQUIRED_KEYS,
    ...OPTIONAL_KEYS.filter((key) => value[key] !== undefined),
  ].sort();
  return Object.keys(value).sort().join(',') === expected.join(',');
}

function transitionPayload(transition: UnsignedAgentWorkTransitionV1): string {
  return JSON.stringify([
    'ashlr.agent-work-transition.v1',
    transition.schemaVersion,
    transition.subjectRef,
    transition.ordinal,
    transition.predecessorTransitionId ?? null,
    transition.phase,
    transition.transition,
    transition.trigger,
    transition.parentSubjectRef ?? null,
    transition.producerVersion,
    transition.observedAt,
  ]);
}

function validSubjectRef(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT_RE.test(value);
}

export function agentWorkTransitionSubjectRef(
  namespace: 'run' | 'trajectory',
  identity: string,
): string {
  if (!OPAQUE_ID_RE.test(identity)) {
    throw new Error('agent work transition subject identity must be opaque');
  }
  return `${namespace}:${identity}`;
}

export function agentWorkTransitionBoundSubjectRef(
  value: unknown,
  identities: { runId?: unknown; trajectoryId?: unknown },
): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value[0] || typeof value[0] !== 'object') {
    return undefined;
  }
  const subjectRef = (value[0] as Record<string, unknown>)['subjectRef'];
  if (!validSubjectRef(subjectRef)) return undefined;
  const allowed = new Set<string>();
  if (typeof identities.runId === 'string' && OPAQUE_ID_RE.test(identities.runId)) {
    allowed.add(`run:${identities.runId}`);
  }
  if (typeof identities.trajectoryId === 'string' && OPAQUE_ID_RE.test(identities.trajectoryId)) {
    allowed.add(`trajectory:${identities.trajectoryId}`);
  }
  return allowed.has(subjectRef) ? subjectRef : undefined;
}

export function agentWorkTransitionId(
  transition: UnsignedAgentWorkTransitionV1,
): string {
  return `awt-${createHash('sha256')
    .update(transitionPayload(transition), 'utf8')
    .digest('hex')}`;
}

export function defineAgentWorkTransitions(
  subjectRef: string,
  drafts: readonly AgentWorkTransitionDraftV1[],
): AgentWorkTransitionV1[] {
  if (!validSubjectRef(subjectRef) || drafts.length < 1 || drafts.length > MAX_TRANSITIONS) {
    throw new Error('invalid agent work transition producer');
  }
  const transitions: AgentWorkTransitionV1[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    const predecessor = transitions[index - 1];
    const unsigned: UnsignedAgentWorkTransitionV1 = {
      schemaVersion: 1,
      subjectRef,
      ordinal: index + 1,
      ...(predecessor ? { predecessorTransitionId: predecessor.transitionId } : {}),
      phase: draft.phase,
      transition: draft.transition,
      trigger: draft.trigger,
      ...(draft.parentSubjectRef ? { parentSubjectRef: draft.parentSubjectRef } : {}),
      producerVersion: 'agent-work-transition-v1',
      observedAt: draft.observedAt,
    };
    transitions.push({ ...unsigned, transitionId: agentWorkTransitionId(unsigned) });
  }
  const accepted = sanitizeAgentWorkTransitions(transitions, subjectRef);
  if (!accepted) throw new Error('invalid agent work transition sequence');
  return accepted;
}

function sanitizeOne(value: unknown): AgentWorkTransitionV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const transition = value as Record<string, unknown>;
  if (
    !exactKeys(transition) ||
    transition['schemaVersion'] !== 1 ||
    typeof transition['transitionId'] !== 'string' ||
    !TRANSITION_ID_RE.test(transition['transitionId']) ||
    !validSubjectRef(transition['subjectRef']) ||
    !Number.isSafeInteger(transition['ordinal']) ||
    Number(transition['ordinal']) < 1 ||
    Number(transition['ordinal']) > MAX_TRANSITIONS ||
    typeof transition['phase'] !== 'string' ||
    !PHASES.has(transition['phase']) ||
    typeof transition['transition'] !== 'string' ||
    !TRANSITIONS.has(transition['transition']) ||
    typeof transition['trigger'] !== 'string' ||
    !TRIGGERS.has(transition['trigger']) ||
    transition['producerVersion'] !== 'agent-work-transition-v1' ||
    !canonicalTimestamp(transition['observedAt']) ||
    (transition['predecessorTransitionId'] !== undefined && (
      typeof transition['predecessorTransitionId'] !== 'string' ||
      !TRANSITION_ID_RE.test(transition['predecessorTransitionId'])
    )) ||
    (transition['parentSubjectRef'] !== undefined && !validSubjectRef(transition['parentSubjectRef'])) ||
    ((transition['phase'] === 'complete') !== (transition['transition'] === 'complete')) ||
    ((transition['phase'] === 'handoff') !== (transition['transition'] === 'handoff'))
  ) {
    return undefined;
  }
  const typed = transition as unknown as AgentWorkTransitionV1;
  const { transitionId, ...unsigned } = typed;
  return agentWorkTransitionId(unsigned) === transitionId ? typed : undefined;
}

export function sanitizeAgentWorkTransitions(
  value: unknown,
  expectedSubjectRef?: string,
): AgentWorkTransitionV1[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TRANSITIONS) {
    return undefined;
  }
  const accepted: AgentWorkTransitionV1[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const transition = sanitizeOne(value[index]);
    const predecessor = accepted[index - 1];
    if (
      !transition ||
      transition.ordinal !== index + 1 ||
      ids.has(transition.transitionId) ||
      (expectedSubjectRef !== undefined && transition.subjectRef !== expectedSubjectRef) ||
      (index === 0 && transition.predecessorTransitionId !== undefined) ||
      (index > 0 && transition.predecessorTransitionId !== predecessor?.transitionId) ||
      (predecessor !== undefined && Date.parse(transition.observedAt) < Date.parse(predecessor.observedAt))
    ) {
      return undefined;
    }
    accepted.push(transition);
    ids.add(transition.transitionId);
  }
  return accepted;
}

export function projectAgentWorkTransitionSequence(
  batches: readonly unknown[],
  expectedSubjectRef: string,
): AgentWorkTransitionSequenceProjectionV1 {
  const byOrdinal = new Map<number, AgentWorkTransitionV1>();
  for (const batch of batches) {
    const accepted = sanitizeAgentWorkTransitions(batch, expectedSubjectRef);
    if (!accepted) return { state: 'withheld', transitions: [] };
    for (const transition of accepted) {
      const previous = byOrdinal.get(transition.ordinal);
      if (previous && previous.transitionId !== transition.transitionId) {
        return { state: 'withheld', transitions: [] };
      }
      byOrdinal.set(transition.ordinal, transition);
    }
  }
  const transitions = [...byOrdinal.values()].sort((left, right) => left.ordinal - right.ordinal);
  if (transitions.length === 0) return { state: 'available', transitions: [] };
  const accepted = sanitizeAgentWorkTransitions(transitions, expectedSubjectRef);
  return accepted
    ? { state: 'available', transitions: accepted }
    : { state: 'withheld', transitions: [] };
}

function terminalCheckpoint(input: {
  status: RunState['status'];
  outcomeKind?: RunProposalOutcomeKind;
  isPartial?: boolean;
  observedAt: string;
}): AgentWorkTransitionDraftV1 {
  switch (input.outcomeKind) {
    case 'empty-diff':
      return { phase: 'repair', transition: 'replan', trigger: 'empty-diff', observedAt: input.observedAt };
    case 'trivial-proposal':
    case 'completeness-gate':
    case 'partial-completeness-gate':
      return { phase: 'repair', transition: 'replan', trigger: 'evidence-failed', observedAt: input.observedAt };
    case 'proposal-capture-error':
      return { phase: 'repair', transition: 'replan', trigger: 'capture-blocked', observedAt: input.observedAt };
    case 'engine-command-missing':
    case 'engine-unsupported':
      return { phase: 'repair', transition: 'block', trigger: 'dependency-unavailable', observedAt: input.observedAt };
    case 'sandbox-unavailable':
      return { phase: 'repair', transition: 'block', trigger: 'resource-unavailable', observedAt: input.observedAt };
    case 'kill-switch':
      return { phase: 'repair', transition: 'block', trigger: 'authority-blocked', observedAt: input.observedAt };
    default:
      break;
  }
  if (input.isPartial === true) {
    return {
      phase: 'repair',
      transition: 'replan',
      trigger: 'evidence-failed',
      observedAt: input.observedAt,
    };
  }
  return input.status === 'done'
    ? { phase: 'complete', transition: 'complete', trigger: 'unknown', observedAt: input.observedAt }
    : { phase: 'repair', transition: 'block', trigger: 'unknown', observedAt: input.observedAt };
}

function observedTransitionDrafts(
  observations: readonly HarnessObservationV1[],
): AgentWorkTransitionDraftV1[] {
  const maxObservedTransitions = MAX_TRANSITIONS - 2;
  const selected = observations.length <= maxObservedTransitions
    ? observations
    : [
        ...observations.slice(0, Math.floor(maxObservedTransitions / 2)),
        ...observations.slice(-Math.ceil(maxObservedTransitions / 2)),
      ];
  let recovering = false;
  return selected.map((observation): AgentWorkTransitionDraftV1 => {
    if (observation.outcome === 'refused') {
      recovering = true;
      return {
        phase: 'repair',
        transition: 'block',
        trigger: 'authority-blocked',
        observedAt: observation.observedAt,
      };
    }
    if (observation.outcome === 'unavailable') {
      recovering = true;
      return {
        phase: 'repair',
        transition: 'block',
        trigger: 'dependency-unavailable',
        observedAt: observation.observedAt,
      };
    }
    if (observation.outcome === 'failed' || observation.outcome === 'uncertain') {
      recovering = true;
      return {
        phase: 'repair',
        transition: 'replan',
        trigger: 'evidence-failed',
        observedAt: observation.observedAt,
      };
    }
    const phase: AgentWorkPhaseV1 = observation.actionClass === 'read'
      ? 'inspect'
      : observation.actionClass === 'write'
        ? 'edit'
        : observation.actionClass === 'exec'
          ? 'verify'
          : 'inspect';
    const transition: AgentWorkTransitionCodeV1 = recovering ? 'retry' : 'advance';
    const trigger: AgentWorkTriggerV1 = recovering ? 'evidence-passed' : 'unknown';
    recovering = false;
    return { phase, transition, trigger, observedAt: observation.observedAt };
  });
}

export function agentWorkTransitionsMatchHarnessObservations(input: {
  runId: string;
  workTransitions: unknown;
  harnessObservations: unknown;
  terminal?: {
    status: RunState['status'];
    outcomeKind?: RunProposalOutcomeKind;
    isPartial?: boolean;
  };
}): boolean {
  let subjectRef: string;
  try {
    subjectRef = harnessObservationSubjectRef(input.runId);
  } catch {
    return false;
  }
  const observations = sanitizeHarnessObservations(input.harnessObservations, subjectRef);
  const transitions = sanitizeAgentWorkTransitions(input.workTransitions, subjectRef);
  if (!observations || !transitions || transitions.length < 2) return false;
  const startedAt = transitions[0]!.observedAt;
  const observedAt = transitions.at(-1)!.observedAt;
  if (input.terminal) {
    const expected = sandboxedRunAgentWorkTransitions({
      runId: input.runId,
      startedAt,
      observedAt,
      status: input.terminal.status,
      outcomeKind: input.terminal.outcomeKind,
      isPartial: input.terminal.isPartial,
      harnessObservations: observations,
    });
    return JSON.stringify(expected) === JSON.stringify(transitions);
  }
  const observed = observedTransitionDrafts(observations);
  if (transitions.length !== observed.length + 2) return false;
  const orient = transitions[0]!;
  if (orient.phase !== 'orient' || orient.transition !== 'enter' || orient.trigger !== 'initial') {
    return false;
  }
  return observed.every((draft, index) => {
    const transition = transitions[index + 1];
    return transition?.phase === draft.phase &&
      transition.transition === draft.transition &&
      transition.trigger === draft.trigger &&
      transition.observedAt === draft.observedAt;
  });
}

export function sandboxedRunAgentWorkTransitions(input: {
  runId: string;
  startedAt: string;
  observedAt: string;
  status: RunState['status'];
  outcomeKind?: RunProposalOutcomeKind;
  isPartial?: boolean;
  harnessObservations?: readonly HarnessObservationV1[];
}): AgentWorkTransitionV1[] {
  const subjectRef = harnessObservationSubjectRef(input.runId);
  const observations = input.harnessObservations === undefined
    ? []
    : sanitizeHarnessObservations(input.harnessObservations, subjectRef) ?? [];
  return defineAgentWorkTransitions(agentWorkTransitionSubjectRef('run', input.runId), [
    {
      phase: 'orient',
      transition: 'enter',
      trigger: 'initial',
      observedAt: input.startedAt,
    },
    ...observedTransitionDrafts(observations),
    terminalCheckpoint(input),
  ]);
}

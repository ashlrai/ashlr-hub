import { createHash, randomUUID } from 'node:crypto';

import type { AgentSemanticEventKind, AgentSemanticEventV1, RunState } from '../types.js';

const MAX_EVENTS = 16;
const EVENT_ID_RE = /^ase-[a-f0-9]{64}$/;
const MINTED_PROPOSAL_ID_RE = /^prop-[a-z0-9]{6,16}-[a-z0-9]{6}-[a-f0-9]{24}$/;
const OTHER_OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SUBJECT_RE = /^(?:proposal:prop-[a-z0-9]{6,16}-[a-z0-9]{6}-[a-f0-9]{24}|(?:run|trajectory):[A-Za-z0-9][A-Za-z0-9_.:-]{0,159})$/;
const SOURCE_REF_RE = /^occurrence:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PREDICATES = new Set([
  'agent.intent.execute',
  'agent.run.terminal',
  'agent.proposal.created',
  'manager.score.value',
  'manager.score.correctness',
  'manager.score.scope',
  'manager.score.alignment',
  'manager.outcome.positive',
  'manager.judge.completed',
  'manager.bounds.blocked',
  'manager.verdict.review',
  'manager.verdict.noise',
  'manager.verdict.harmful',
  'verifier.run',
  'verification.result',
]);
const OBJECTIVE_CODES = new Set(['proposal.evaluate', 'work.execute']);
const METRIC_CODES = new Set([
  'manager.value', 'manager.correctness', 'manager.scope', 'manager.alignment',
  'agent.proposal.created',
]);
const OUTCOME_CODES = new Set(['proposal.positive-outcome']);
const ACTION_CODES = new Set(['manager.judge', 'verification.execute', 'agent.run']);
const EVIDENCE_CODES = new Set(['verification.merge-profile']);
const CHALLENGE_CODES = new Set(['merge.bounds-exceeded', 'verdict.review', 'verdict.noise', 'verdict.harmful']);
const PRODUCER_ROLES = new Set(['manager', 'agent', 'verifier', 'observer', 'system']);
const MODEL_FAMILIES = new Set(['claude', 'openai', 'local', 'unknown']);
const PRODUCER_VERSIONS = new Set([
  'manager-semantic-v1', 'agent-semantic-v1', 'verifier-semantic-v1',
  'system-semantic-v1', 'test-semantic-v1',
]);

const COMMON_KEYS = [
  'eventId', 'kind', 'predicate', 'producerModelFamily', 'producerRole',
  'producerVersion', 'schemaVersion', 'sequence', 'sourceRef', 'subjectRef',
];
const KIND_KEYS: Record<AgentSemanticEventKind, string[]> = {
  intent: [...COMMON_KEYS, 'objectiveCode'],
  observation: [...COMMON_KEYS, 'metricCode', 'unit', 'value'],
  prediction: [...COMMON_KEYS, 'horizon', 'outcomeCode', 'probability'],
  action: [...COMMON_KEYS, 'actionCode', 'status'],
  evidence: [...COMMON_KEYS, 'evidenceCode', 'result'],
  challenge: [...COMMON_KEYS, 'challengeCode', 'severity', 'targetEventId'],
};

type UnsignedAgentSemanticEvent = AgentSemanticEventV1 extends infer Event
  ? Event extends unknown ? Omit<Event, 'eventId'> : never
  : never;
export type AgentSemanticEventDraft = UnsignedAgentSemanticEvent extends infer Event
  ? Event extends unknown
    ? Omit<Event,
      'schemaVersion' | 'sequence' | 'subjectRef' | 'producerRole' |
      'producerModelFamily' | 'producerVersion' | 'sourceRef'>
    : never
  : never;

export interface AgentSemanticProducerV1 {
  subjectRef: string;
  producerRole: AgentSemanticEventV1['producerRole'];
  producerModelFamily: AgentSemanticEventV1['producerModelFamily'];
  producerVersion: AgentSemanticEventV1['producerVersion'];
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = expected.filter((key) => key !== 'targetEventId' || value[key] !== undefined);
  return Object.keys(value).sort().join(',') === keys.sort().join(',');
}

function finiteMember(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value);
}

function eventPayload(event: UnsignedAgentSemanticEvent): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(event).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

export function agentSemanticSubjectRef(
  namespace: 'proposal' | 'run' | 'trajectory',
  identity: string,
): string {
  const valid = namespace === 'proposal'
    ? MINTED_PROPOSAL_ID_RE.test(identity)
    : OTHER_OPAQUE_ID_RE.test(identity);
  if (!valid) throw new Error('semantic subject identity must be minted and opaque');
  return `${namespace}:${identity}`;
}

export function agentSemanticProposalSubjectRef(value: unknown): string | undefined {
  return typeof value === 'string' && MINTED_PROPOSAL_ID_RE.test(value) ? `proposal:${value}` : undefined;
}

export function agentSemanticBoundSubjectRef(
  value: unknown,
  identities: { proposalId?: unknown; runId?: unknown; trajectoryId?: unknown },
): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value[0] || typeof value[0] !== 'object') {
    return undefined;
  }
  const subjectRef = (value[0] as Record<string, unknown>)['subjectRef'];
  if (typeof subjectRef !== 'string') return undefined;
  const allowed = new Set<string>();
  const proposalRef = agentSemanticProposalSubjectRef(identities.proposalId);
  if (proposalRef) allowed.add(proposalRef);
  if (typeof identities.runId === 'string' && OTHER_OPAQUE_ID_RE.test(identities.runId)) {
    allowed.add(`run:${identities.runId}`);
  }
  if (typeof identities.trajectoryId === 'string' && OTHER_OPAQUE_ID_RE.test(identities.trajectoryId)) {
    allowed.add(`trajectory:${identities.trajectoryId}`);
  }
  return allowed.has(subjectRef) ? subjectRef : undefined;
}

export function agentSemanticModelFamily(value: unknown): AgentSemanticEventV1['producerModelFamily'] {
  if (typeof value !== 'string') return 'unknown';
  const model = value.toLowerCase();
  const hasToken = (token: string): boolean => new RegExp(`(^|[/:._-])${token}([/:._-]|$)`).test(model);
  if (['claude', 'anthropic'].some(hasToken)) return 'claude';
  if (['gpt', 'codex', 'openai'].some(hasToken)) return 'openai';
  if ([
    'local', 'ollama', 'qwen', 'llama', 'deepseek', 'kimi', 'nim',
    'builtin', 'ashlrcode', 'aw', 'hermes', 'grok', 'xai', 'gemini',
    'mistral', 'moonshot',
  ].some(hasToken)) {
    return 'local';
  }
  return 'unknown';
}

export function agentSemanticEventId(event: UnsignedAgentSemanticEvent): string {
  return `ase-${createHash('sha256')
    .update('ashlr.agent-semantic.event.v1\0', 'utf8')
    .update(eventPayload(event), 'utf8')
    .digest('hex')}`;
}

export function defineAgentSemanticEvents(
  producer: AgentSemanticProducerV1,
  drafts: AgentSemanticEventDraft[],
): AgentSemanticEventV1[] {
  if (!SUBJECT_RE.test(producer.subjectRef) || drafts.length < 1 || drafts.length > MAX_EVENTS ||
    !PRODUCER_ROLES.has(producer.producerRole) ||
    !MODEL_FAMILIES.has(producer.producerModelFamily) ||
    !PRODUCER_VERSIONS.has(producer.producerVersion)) throw new Error('invalid semantic producer');
  const sourceRef = `occurrence:${randomUUID()}`;
  if (!SOURCE_REF_RE.test(sourceRef)) throw new Error('invalid semantic occurrence');
  const events = drafts.map((draft, index) => {
    const unsigned = {
      ...draft,
      schemaVersion: 1 as const,
      sequence: index + 1,
      subjectRef: producer.subjectRef,
      producerRole: producer.producerRole,
      producerModelFamily: producer.producerModelFamily,
      producerVersion: producer.producerVersion,
      sourceRef,
    } as UnsignedAgentSemanticEvent;
    return { ...unsigned, eventId: agentSemanticEventId(unsigned) } as AgentSemanticEventV1;
  });
  const validated = sanitizeAgentSemanticEvents(
    events,
    producer.subjectRef,
    producer.producerModelFamily,
  );
  if (!validated) throw new Error('invalid semantic event batch');
  return validated;
}

export function agentRunSemanticEvents(input: {
  runId: string;
  model?: unknown;
  status: RunState['status'];
  proposalCreated?: boolean;
}): AgentSemanticEventV1[] {
  const drafts: AgentSemanticEventDraft[] = [
    { kind: 'intent', predicate: 'agent.intent.execute', objectiveCode: 'work.execute' },
    {
      kind: 'action',
      predicate: 'agent.run.terminal',
      actionCode: 'agent.run',
      status: input.status === 'aborted' ? 'blocked' : 'completed',
    },
  ];
  if (input.proposalCreated !== undefined) {
    drafts.push({
      kind: 'observation',
      predicate: 'agent.proposal.created',
      metricCode: 'agent.proposal.created',
      value: input.proposalCreated ? 1 : 0,
      unit: 'boolean',
    });
  }
  return defineAgentSemanticEvents({
    subjectRef: agentSemanticSubjectRef('run', input.runId),
    producerRole: 'agent',
    producerModelFamily: agentSemanticModelFamily(input.model),
    producerVersion: 'agent-semantic-v1',
  }, drafts);
}

function validNumberDomain(event: Record<string, unknown>): boolean {
  if (event['kind'] === 'prediction') {
    return typeof event['probability'] === 'number' && Number.isFinite(event['probability']) &&
      event['probability'] >= 0 && event['probability'] <= 1 &&
      Math.round(event['probability'] * 10_000) === event['probability'] * 10_000;
  }
  if (event['kind'] !== 'observation' || typeof event['value'] !== 'number' ||
    !Number.isFinite(event['value'])) return event['kind'] !== 'observation';
  switch (event['unit']) {
    case 'score-1-5': return Number.isInteger(event['value']) && event['value'] >= 1 && event['value'] <= 5;
    case 'boolean': return event['value'] === 0 || event['value'] === 1;
    case 'count': return Number.isSafeInteger(event['value']) && event['value'] >= 0;
    case 'ratio': return event['value'] >= 0 && event['value'] <= 1 &&
      Math.round(event['value'] * 10_000) === event['value'] * 10_000;
    default: return false;
  }
}

function sanitizeOne(value: unknown): AgentSemanticEventV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  const kind = event['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(KIND_KEYS, kind) ||
    !exactKeys(event, KIND_KEYS[kind as AgentSemanticEventKind]) ||
    event['schemaVersion'] !== 1 || !Number.isSafeInteger(event['sequence']) ||
    Number(event['sequence']) < 1 || Number(event['sequence']) > MAX_EVENTS ||
    typeof event['eventId'] !== 'string' || !EVENT_ID_RE.test(event['eventId']) ||
    typeof event['subjectRef'] !== 'string' || !SUBJECT_RE.test(event['subjectRef']) ||
    !finiteMember(event['predicate'], PREDICATES) ||
    !finiteMember(event['producerRole'], PRODUCER_ROLES) ||
    !finiteMember(event['producerModelFamily'], MODEL_FAMILIES) ||
    !finiteMember(event['producerVersion'], PRODUCER_VERSIONS) ||
    typeof event['sourceRef'] !== 'string' || !SOURCE_REF_RE.test(event['sourceRef']) ||
    !validNumberDomain(event)) return undefined;
  switch (kind) {
    case 'intent': if (!finiteMember(event['objectiveCode'], OBJECTIVE_CODES)) return undefined; break;
    case 'observation': if (!finiteMember(event['metricCode'], METRIC_CODES)) return undefined; break;
    case 'prediction':
      if (!finiteMember(event['outcomeCode'], OUTCOME_CODES) ||
        !['decision', 'verification', 'post-merge'].includes(String(event['horizon']))) return undefined;
      break;
    case 'action':
      if (!finiteMember(event['actionCode'], ACTION_CODES) ||
        !['planned', 'started', 'completed', 'blocked'].includes(String(event['status']))) return undefined;
      break;
    case 'evidence':
      if (!finiteMember(event['evidenceCode'], EVIDENCE_CODES) ||
        !['supports', 'contradicts', 'inconclusive'].includes(String(event['result']))) return undefined;
      break;
    case 'challenge':
      if (!finiteMember(event['challengeCode'], CHALLENGE_CODES) ||
        !['low', 'medium', 'high', 'critical'].includes(String(event['severity'])) ||
        (event['targetEventId'] !== undefined &&
          (typeof event['targetEventId'] !== 'string' || !EVENT_ID_RE.test(event['targetEventId'])))) return undefined;
      break;
  }
  if ((event['predicate'] === 'agent.run.terminal' || event['actionCode'] === 'agent.run') && (
    event['predicate'] !== 'agent.run.terminal' || event['actionCode'] !== 'agent.run' ||
    !['completed', 'blocked'].includes(String(event['status']))
  )) return undefined;
  if ((event['predicate'] === 'agent.proposal.created' || event['metricCode'] === 'agent.proposal.created') && (
    event['predicate'] !== 'agent.proposal.created' ||
    event['metricCode'] !== 'agent.proposal.created' || event['unit'] !== 'boolean'
  )) return undefined;
  const typed = event as unknown as AgentSemanticEventV1;
  const { eventId: _eventId, ...unsigned } = typed;
  return agentSemanticEventId(unsigned) === typed.eventId ? typed : undefined;
}

export function sanitizeAgentSemanticEvents(
  value: unknown,
  expectedSubjectRef?: string,
  expectedModelFamily?: AgentSemanticEventV1['producerModelFamily'],
  expectedProducer?: Pick<AgentSemanticEventV1, 'producerRole' | 'producerVersion'>,
): AgentSemanticEventV1[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVENTS) return undefined;
  const accepted: AgentSemanticEventV1[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const event = sanitizeOne(value[index]);
    if (!event || event.sequence !== index + 1 || ids.has(event.eventId) ||
      (expectedSubjectRef !== undefined && event.subjectRef !== expectedSubjectRef) ||
      (expectedModelFamily !== undefined && event.producerModelFamily !== expectedModelFamily) ||
      (expectedProducer !== undefined && (
        event.producerRole !== expectedProducer.producerRole ||
        event.producerVersion !== expectedProducer.producerVersion
      )) ||
      (event.kind === 'challenge' && event.targetEventId !== undefined && !ids.has(event.targetEventId))) {
      return undefined;
    }
    accepted.push(event);
    ids.add(event.eventId);
  }
  return accepted;
}

export function remintAgentSemanticEvents(
  value: unknown,
  expectedSubjectRef?: string,
  expectedModelFamily?: AgentSemanticEventV1['producerModelFamily'],
  expectedProducer?: Pick<AgentSemanticEventV1, 'producerRole' | 'producerVersion'>,
): AgentSemanticEventV1[] | undefined {
  const accepted = sanitizeAgentSemanticEvents(
    value,
    expectedSubjectRef,
    expectedModelFamily,
    expectedProducer,
  );
  if (!accepted) return undefined;
  const sourceRef = `occurrence:${randomUUID()}`;
  const remintedIds = new Map<string, string>();
  const reminted = accepted.map((event) => {
    const { eventId: previousEventId, ...previousUnsigned } = event;
    const unsigned = {
      ...previousUnsigned,
      sourceRef,
      ...(event.kind === 'challenge' && event.targetEventId
        ? { targetEventId: remintedIds.get(event.targetEventId) }
        : {}),
    } as UnsignedAgentSemanticEvent;
    const eventId = agentSemanticEventId(unsigned);
    remintedIds.set(previousEventId, eventId);
    return { ...unsigned, eventId } as AgentSemanticEventV1;
  });
  return sanitizeAgentSemanticEvents(
    reminted,
    expectedSubjectRef,
    expectedModelFamily,
    expectedProducer,
  );
}

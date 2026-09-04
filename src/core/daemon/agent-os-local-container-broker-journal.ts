import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { isProxy } from 'node:util/types';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

import {
  acquireLocalStoreLockWithOutcome,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';
import {
  initializeImmutablePrivateRecordStoreLayout,
  readImmutablePrivateRecords,
  removeImmutablePrivateRecords,
  recoverImmutablePrivateRecordStore,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

export const AGENT_OS_LOCAL_CONTAINER_BROKER_JOURNAL_V1 =
  'ashlr-agent-os-local-container-broker-journal-v1' as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_RECORDS = 4_096;
const MIN_RECORDS = 16;
const MAX_RECORDS_PER_LIFECYCLE = 8;
const MAX_RECORD_BYTES = 16 * 1024;
// One-record overage is reserved for publishing a durable summary before the
// old terminal chain is pruned.
const MAX_TOTAL_BYTES = (MAX_RECORDS + 1) * MAX_RECORD_BYTES;
const MAX_LOCK_WAIT_MS = 2_000;
const RAW_DIGEST_RE = /^[a-f0-9]{64}$/u;
const PREFIXED_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const CONTAINER_NAME_RE = /^ashlr-agent-os-[a-f0-9]{32}$/u;

export type AgentOsLocalContainerBrokerJournalStageV1 =
  | 'lease-held'
  | 'create-ambiguous'
  | 'created'
  | 'prepared'
  | 'started'
  | 'stopped'
  | 'removed'
  | 'finalized'
  | 'settled'
  | 'abandoned'
  | 'cleanup-pending'
  | 'capacity-pending'
  | 'manual-hold'
  | 'summary';

export type AgentOsLocalContainerBrokerJournalOutcomeV1 =
  | 'succeeded'
  | 'request-withheld'
  | 'container-create-failed'
  | 'container-policy-mismatch'
  | 'producer-failed'
  | 'deadline-exceeded'
  | 'output-limit-exceeded'
  | 'cleanup-failed'
  | 'capacity-release-failed'
  | 'recovered-after-crash';

export interface AgentOsLocalContainerBrokerJournalStateV1 {
  runId: string;
  requestNonceDigest: string;
  requestDigest: string;
  permitDigest: string;
  brokerDigest: string;
  engineDigest: string;
  imageDigest: string;
  producerDigest: string;
  seccompDigest: string;
  createConfigDigest: string;
  executionIdentityDigest: string;
  capacityEvidenceDigest: string;
  allocationDigest: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
  containerName: string;
  containerId: string | null;
  engineCreateRequestDigest: string | null;
  prestartInspectionDigest: string | null;
  finalInspectionDigest: string | null;
  prepareAttestationDigest: string | null;
  finalAttestationDigest: string | null;
  removalEvidenceDigest: string | null;
  outcome: AgentOsLocalContainerBrokerJournalOutcomeV1 | null;
}

export interface AgentOsLocalContainerBrokerJournalRecordV1
  extends AgentOsLocalContainerBrokerJournalStateV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_LOCAL_CONTAINER_BROKER_JOURNAL_V1;
  sequence: number;
  stage: AgentOsLocalContainerBrokerJournalStageV1;
  recordedAt: string;
  previousRecordDigest: string | null;
  recordDigest: string;
}

export interface AgentOsLocalContainerBrokerJournalInspectionV1 {
  enabled: boolean;
  sourceState: 'disabled' | 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  activeRuns: ReadonlyArray<Readonly<{
    runId: string;
    stage: AgentOsLocalContainerBrokerJournalStageV1;
    sequence: number;
    recordDigest: string;
  }>>;
  terminalRunCount: number;
  recordCount: number;
  stopReasons: string[];
  sameUserTamperResistant: false;
  commissioningAuthority: false;
  activationAuthority: false;
}

export interface AgentOsLocalContainerBrokerJournalDependenciesV1 {
  anchorPath: string;
  rootPath: string;
  enabled?: boolean;
  clock?: () => Date;
  lockWaitMs?: number;
  /** Optional smaller bound for embedded stores and adversarial tests. */
  maxRecords?: number;
}

export type AgentOsLocalContainerBrokerJournalMutationV1 =
  | { ok: true; record: Readonly<AgentOsLocalContainerBrokerJournalRecordV1> }
  | { ok: false; reason: string; record: null };

const STATE_KEYS = [
  'allocationDigest', 'brokerDigest', 'capacityEvidenceDigest', 'containerId', 'containerName',
  'createConfigDigest', 'engineCreateRequestDigest', 'engineDigest', 'executionIdentityDigest',
  'finalAttestationDigest', 'finalInspectionDigest', 'imageDigest', 'leaseEpoch', 'leaseExpiresAt', 'outcome',
  'permitDigest', 'prepareAttestationDigest', 'producerDigest', 'removalEvidenceDigest',
  'prestartInspectionDigest', 'requestDigest', 'requestNonceDigest', 'runId', 'seccompDigest',
] as const;
const RECORD_KEYS = [
  ...STATE_KEYS, 'previousRecordDigest', 'protocol', 'recordDigest', 'recordedAt', 'schemaVersion',
  'sequence', 'stage',
] as const;
const STAGES: readonly AgentOsLocalContainerBrokerJournalStageV1[] = [
  'lease-held', 'create-ambiguous', 'created', 'prepared', 'started', 'stopped', 'removed', 'finalized',
  'settled', 'abandoned', 'cleanup-pending', 'capacity-pending', 'manual-hold', 'summary',
];
const OUTCOMES: readonly AgentOsLocalContainerBrokerJournalOutcomeV1[] = [
  'succeeded', 'request-withheld', 'container-create-failed', 'container-policy-mismatch',
  'producer-failed', 'deadline-exceeded', 'output-limit-exceeded', 'cleanup-failed',
  'capacity-release-failed', 'recovered-after-crash',
];
const TERMINAL = new Set<AgentOsLocalContainerBrokerJournalStageV1>([
  'settled', 'abandoned', 'manual-hold', 'summary',
]);
const TRANSITIONS: Readonly<Record<AgentOsLocalContainerBrokerJournalStageV1,
readonly AgentOsLocalContainerBrokerJournalStageV1[]>> = Object.freeze({
  'lease-held': ['create-ambiguous', 'created', 'settled', 'abandoned', 'cleanup-pending',
    'capacity-pending', 'manual-hold'],
  'create-ambiguous': ['created', 'abandoned', 'cleanup-pending', 'capacity-pending', 'manual-hold'],
  created: ['prepared', 'removed', 'cleanup-pending', 'manual-hold'],
  prepared: ['started', 'removed', 'cleanup-pending', 'manual-hold'],
  started: ['stopped', 'removed', 'cleanup-pending', 'manual-hold'],
  stopped: ['removed', 'cleanup-pending', 'manual-hold'],
  'cleanup-pending': ['removed', 'manual-hold'],
  'capacity-pending': ['abandoned'],
  removed: ['finalized', 'settled', 'abandoned'],
  finalized: ['settled'],
  settled: [],
  abandoned: [],
  'manual-hold': [],
  summary: [],
});

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try {
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.keys(descriptors).sort().join('\0') === [...keys].sort().join('\0') &&
      Object.values(descriptors).every((descriptor) => Object.hasOwn(descriptor, 'value'));
  } catch {
    return false;
  }
}

function plainDataGraph(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value !== 'object' || isProxy(value) || Array.isArray(value) || depth > 4 ||
    seen.has(value)) return false;
  seen.add(value);
  const row = record(value);
  if (!row) return false;
  try {
    return Object.values(Object.getOwnPropertyDescriptors(row)).every((descriptor) =>
      Object.hasOwn(descriptor, 'value') && plainDataGraph(descriptor.value, seen, depth + 1));
  } catch {
    return false;
  }
}

function ownedSnapshot(value: unknown): Record<string, unknown> | null {
  try {
    if (!plainDataGraph(value)) return null;
    const snapshot = structuredClone(value);
    return plainDataGraph(snapshot) ? record(snapshot) : null;
  } catch {
    return null;
  }
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function recordDigest(value: Omit<AgentOsLocalContainerBrokerJournalRecordV1, 'recordDigest'>): string {
  return createHash('sha256').update('ashlr.agent-os.local-container-broker-journal.record.v1\0', 'utf8')
    .update(canonicalJson(value), 'utf8').digest('hex');
}

function validState(value: Record<string, unknown>): boolean {
  return RAW_DIGEST_RE.test(String(value['runId'])) && RAW_DIGEST_RE.test(String(value['requestNonceDigest'])) &&
    ['requestDigest', 'permitDigest', 'brokerDigest', 'engineDigest', 'imageDigest', 'producerDigest',
      'seccompDigest', 'createConfigDigest'].every((key) => RAW_DIGEST_RE.test(String(value[key]))) &&
    PREFIXED_DIGEST_RE.test(String(value['executionIdentityDigest'])) &&
    PREFIXED_DIGEST_RE.test(String(value['capacityEvidenceDigest'])) &&
    PREFIXED_DIGEST_RE.test(String(value['allocationDigest'])) &&
    Number.isSafeInteger(value['leaseEpoch']) && Number(value['leaseEpoch']) >= 1 &&
    timestamp(value['leaseExpiresAt']) &&
    CONTAINER_NAME_RE.test(String(value['containerName'])) &&
    (value['containerId'] === null || CONTAINER_ID_RE.test(String(value['containerId']))) &&
    ['engineCreateRequestDigest', 'prestartInspectionDigest', 'finalInspectionDigest',
      'prepareAttestationDigest', 'finalAttestationDigest',
      'removalEvidenceDigest'].every((key) => value[key] === null || RAW_DIGEST_RE.test(String(value[key]))) &&
    (value['outcome'] === null || OUTCOMES.includes(value['outcome'] as AgentOsLocalContainerBrokerJournalOutcomeV1));
}

function stageStateValid(value: AgentOsLocalContainerBrokerJournalRecordV1): boolean {
  const created = value.containerId !== null && value.engineCreateRequestDigest !== null;
  const prepared = created && value.prestartInspectionDigest !== null &&
    value.prepareAttestationDigest !== null;
  const stopped = created && value.finalInspectionDigest !== null;
  const removed = created && value.removalEvidenceDigest !== null;
  const finalized = removed && stopped && value.finalAttestationDigest !== null;
  switch (value.stage) {
    case 'lease-held': return !created && value.outcome === null;
    case 'create-ambiguous': return !created && value.outcome === null;
    case 'created': return created;
    case 'prepared': return prepared;
    case 'started': return prepared;
    case 'stopped': return stopped;
    case 'removed': return removed;
    case 'finalized': return finalized;
    case 'settled': return value.outcome !== null;
    case 'abandoned': return value.outcome !== null && (!created || removed);
    case 'cleanup-pending': return created && value.outcome === null;
    case 'capacity-pending': return (!created || removed) && value.outcome === null;
    case 'manual-hold': return value.outcome === 'cleanup-failed' ||
      value.outcome === 'container-policy-mismatch';
    case 'summary': return value.outcome !== null && value.previousRecordDigest !== null;
  }
}

function parseJournalRecord(value: unknown): AgentOsLocalContainerBrokerJournalRecordV1 | null {
  const row = record(value);
  if (!row || !exactKeys(row, RECORD_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== AGENT_OS_LOCAL_CONTAINER_BROKER_JOURNAL_V1 ||
    !Number.isSafeInteger(row['sequence']) || Number(row['sequence']) < 1 ||
    !STAGES.includes(row['stage'] as AgentOsLocalContainerBrokerJournalStageV1) ||
    !timestamp(row['recordedAt']) ||
    !(row['previousRecordDigest'] === null || RAW_DIGEST_RE.test(String(row['previousRecordDigest']))) ||
    !RAW_DIGEST_RE.test(String(row['recordDigest'])) || !validState(row)) return null;
  const { recordDigest: claimed, ...unsigned } = row;
  if (recordDigest(unsigned as Omit<AgentOsLocalContainerBrokerJournalRecordV1, 'recordDigest'>) !== claimed) {
    return null;
  }
  const parsed = row as unknown as AgentOsLocalContainerBrokerJournalRecordV1;
  return stageStateValid(parsed) ? parsed : null;
}

function codec(): ImmutablePrivateRecordCodec<AgentOsLocalContainerBrokerJournalRecordV1> {
  return {
    parse: parseJournalRecord,
    serialize: (value) => `${canonicalJson(value)}\n`,
    recordId: (value) => value.stage === 'summary'
      ? `${value.runId}.summary`
      : `${value.runId}.${String(value.sequence).padStart(4, '0')}`,
    recordFileName: (value) => value.stage === 'summary'
      ? `${value.runId}.summary.json`
      : `${value.runId}.${String(value.sequence).padStart(4, '0')}.json`,
    isRecordFileName: (value) => /^[a-f0-9]{64}\.(?:[0-9]{4}|summary)\.json$/u.test(value),
    stageToken: (value) => value.recordDigest,
    equivalent: (left, right) => left.recordDigest === right.recordDigest,
    compare: (left, right) => left.runId.localeCompare(right.runId) ||
      (left.stage === 'summary' ? 1 : right.stage === 'summary' ? -1 : left.sequence - right.sequence),
  };
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) immutable(nested);
    Object.freeze(value);
  }
  return value;
}

function sameBinding(left: AgentOsLocalContainerBrokerJournalRecordV1,
  right: AgentOsLocalContainerBrokerJournalRecordV1): boolean {
  return ['runId', 'requestNonceDigest', 'requestDigest', 'permitDigest', 'brokerDigest', 'engineDigest',
    'imageDigest', 'producerDigest', 'seccompDigest', 'createConfigDigest', 'executionIdentityDigest',
      'capacityEvidenceDigest', 'allocationDigest', 'containerName', 'leaseExpiresAt'].every((key) =>
    left[key as keyof AgentOsLocalContainerBrokerJournalRecordV1] ===
      right[key as keyof AgentOsLocalContainerBrokerJournalRecordV1]);
}

function monotonicState(left: AgentOsLocalContainerBrokerJournalRecordV1,
  right: AgentOsLocalContainerBrokerJournalRecordV1): boolean {
  const fields: Array<keyof Pick<AgentOsLocalContainerBrokerJournalRecordV1,
  'containerId' | 'engineCreateRequestDigest' | 'prestartInspectionDigest' | 'finalInspectionDigest' |
  'prepareAttestationDigest' |
  'finalAttestationDigest' | 'removalEvidenceDigest'>> = [
    'containerId', 'engineCreateRequestDigest', 'prestartInspectionDigest', 'finalInspectionDigest',
    'prepareAttestationDigest',
    'finalAttestationDigest', 'removalEvidenceDigest',
  ];
  return fields.every((field) => left[field] === null || left[field] === right[field]) &&
    (right.leaseEpoch === left.leaseEpoch || right.leaseEpoch === left.leaseEpoch + 1);
}

function validateChains(records: AgentOsLocalContainerBrokerJournalRecordV1[]): {
  ok: boolean;
  latest: AgentOsLocalContainerBrokerJournalRecordV1[];
} {
  const latest = new Map<string, AgentOsLocalContainerBrokerJournalRecordV1>();
  const grouped = new Map<string, AgentOsLocalContainerBrokerJournalRecordV1[]>();
  for (const item of records) grouped.set(item.runId, [...(grouped.get(item.runId) ?? []), item]);
  for (const [runId, group] of grouped) {
    const summaries = group.filter((item) => item.stage === 'summary');
    if (summaries.length > 1) return { ok: false, latest: [] };
    if (summaries.length === 1) {
      const summary = summaries[0]!;
      if (summary.sequence !== 1 || summary.previousRecordDigest === null || summary.outcome === null) {
        return { ok: false, latest: [] };
      }
      const originalTerminal = group.filter((item) => item.stage !== 'summary').at(-1);
      if (originalTerminal && TERMINAL.has(originalTerminal.stage) &&
        originalTerminal.recordDigest !== summary.previousRecordDigest) return { ok: false, latest: [] };
      latest.set(runId, summary);
      continue;
    }
    let previous: AgentOsLocalContainerBrokerJournalRecordV1 | undefined;
    for (const item of group) {
      if (!previous) {
        if (item.sequence !== 1 || item.stage !== 'lease-held' || item.previousRecordDigest !== null) {
          return { ok: false, latest: [] };
        }
      } else if (item.sequence !== previous.sequence + 1 ||
        item.previousRecordDigest !== previous.recordDigest ||
        !TRANSITIONS[previous.stage].includes(item.stage) || !sameBinding(previous, item) ||
        Date.parse(item.recordedAt) < Date.parse(previous.recordedAt) ||
        !monotonicState(previous, item)) {
        return { ok: false, latest: [] };
      }
      if (TERMINAL.has(item.stage) !== (item.outcome !== null)) return { ok: false, latest: [] };
      previous = item;
    }
    if (previous) latest.set(runId, previous);
  }
  return { ok: true, latest: [...latest.values()].sort((a, b) => a.runId.localeCompare(b.runId)) };
}

function nestedWithin(anchor: string, target: string): boolean {
  return target.startsWith(`${anchor}${sep}`);
}

export class AgentOsLocalContainerBrokerJournalV1 {
  readonly #enabled: boolean;
  readonly #anchorPath: string;
  readonly #rootPath: string;
  readonly #lifecycleLockPath: string;
  readonly #clock: () => Date;
  readonly #lockWaitMs: number;
  readonly #maxRecords: number;
  readonly #config: ImmutablePrivateRecordStoreConfig<AgentOsLocalContainerBrokerJournalRecordV1>;

  constructor(dependencies: AgentOsLocalContainerBrokerJournalDependenciesV1) {
    this.#enabled = dependencies.enabled === true;
    this.#anchorPath = resolve(dependencies.anchorPath);
    this.#rootPath = resolve(dependencies.rootPath);
    this.#lifecycleLockPath = join(this.#anchorPath, `.${basename(this.#rootPath)}-lifecycle.lock`);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#lockWaitMs = Number.isFinite(dependencies.lockWaitMs)
      ? Math.max(0, Math.min(MAX_LOCK_WAIT_MS, Math.floor(dependencies.lockWaitMs!)))
      : 250;
    this.#maxRecords = Number.isSafeInteger(dependencies.maxRecords)
      ? Math.max(MIN_RECORDS, Math.min(MAX_RECORDS, dependencies.maxRecords!))
      : MAX_RECORDS;
    this.#config = {
      label: 'Agent OS local-container broker journal',
      anchorPath: this.#anchorPath,
      rootPath: this.#rootPath,
      lockFileName: '.journal.lock',
      maxRecordBytes: MAX_RECORD_BYTES,
      defaultMaxFiles: this.#maxRecords + 1,
      hardMaxFiles: this.#maxRecords + 1,
      defaultMaxBytes: MAX_TOTAL_BYTES,
      hardMaxBytes: MAX_TOTAL_BYTES,
      codecForWrite: codec,
      codecForRead: codec,
    };
  }

  #pathsValid(): boolean {
    return isAbsolute(this.#anchorPath) && isAbsolute(this.#rootPath) &&
      this.#anchorPath !== parse(this.#anchorPath).root && nestedWithin(this.#anchorPath, this.#rootPath);
  }

  #ensureRoot(): boolean {
    if (!this.#enabled || !this.#pathsValid()) return false;
    try {
      let created = false;
      if (!existsSync(this.#rootPath)) {
        mkdirSync(this.#rootPath, { mode: PRIVATE_DIRECTORY_MODE });
        chmodSync(this.#rootPath, PRIVATE_DIRECTORY_MODE);
        created = true;
      }
      const stat = lstatSync(this.#rootPath, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1n ||
        (process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o700n)) return false;
      const assurance = assurePrivateStoragePath(this.#rootPath, 'directory',
        created ? 'secure-created' : 'inspect-existing', { anchorPath: this.#anchorPath });
      if (!assurance.ok) return false;
      if (created) fsyncDirectory(dirname(this.#rootPath));
      return true;
    } catch {
      return false;
    }
  }

  acquireLifecycleLock(): { state: 'acquired'; lock: LocalStoreLock } |
  { state: 'disabled' | 'unavailable' | 'contended'; lock: null } {
    if (!this.#enabled) return { state: 'disabled', lock: null };
    if (!this.#ensureRoot()) return { state: 'unavailable', lock: null };
    const acquired = acquireLocalStoreLockWithOutcome(this.#lifecycleLockPath, this.#lockWaitMs, {
      anchorPath: this.#anchorPath,
      exactPrivateStorage: true,
    });
    if (acquired.state !== 'acquired') return acquired;
    const layout = initializeImmutablePrivateRecordStoreLayout(this.#config, {
      lockWaitMs: this.#lockWaitMs,
      guard: () => this.#owns(acquired.lock),
    });
    if (!['ready', 'initialized'].includes(layout)) {
      releaseLocalStoreLock(acquired.lock);
      return { state: 'unavailable', lock: null };
    }
    return acquired;
  }

  releaseLifecycleLock(lock: LocalStoreLock): boolean {
    return this.#owns(lock) && releaseLocalStoreLock(lock);
  }

  #owns(lock: LocalStoreLock): boolean {
    return resolve(lock.path) === this.#lifecycleLockPath && ownsLocalStoreLock(lock);
  }

  #readComplete(): { ok: boolean; latest: AgentOsLocalContainerBrokerJournalRecordV1[];
    records: AgentOsLocalContainerBrokerJournalRecordV1[];
    sourceState: 'missing' | 'healthy' | 'degraded'; recordCount: number; stopReasons: string[] } {
    const read = readImmutablePrivateRecords(this.#config, {
      maxFiles: this.#maxRecords + 1,
      maxBytes: MAX_TOTAL_BYTES,
      requireComplete: true,
    });
    if (!read.complete) return {
      ok: false, latest: [], records: [], sourceState: read.sourceState, recordCount: read.filesRead,
      stopReasons: [...read.stopReasons],
    };
    const chains = validateChains(read.records);
    return {
      ok: chains.ok,
      latest: chains.latest,
      records: read.records,
      sourceState: read.sourceState,
      recordCount: read.records.length,
      stopReasons: chains.ok ? [] : ['journal-chain-invalid'],
    };
  }

  #compact(requiredFree: number, lock: LocalStoreLock): boolean {
    for (;;) {
      const read = this.#readComplete();
      if (!read.ok) return false;
      const summarizedRemainder = read.latest.find((item) => item.stage === 'summary' &&
        read.records.some((record) => record.runId === item.runId && record.stage !== 'summary'));
      if (summarizedRemainder) {
        const removed = removeImmutablePrivateRecords(this.#config, read.records.filter((record) =>
          record.runId === summarizedRemainder.runId && record.stage !== 'summary'), {
          lockWaitMs: this.#lockWaitMs,
          guard: () => this.#owns(lock),
        });
        if (!['removed', 'replayed'].includes(removed)) return false;
        continue;
      }
      if (this.#maxRecords - read.recordCount >= requiredFree) return true;
      const candidate = read.latest.find((item) => TERMINAL.has(item.stage) && item.stage !== 'summary' &&
        read.records.filter((record) => record.runId === item.runId).length > 1);
      if (!candidate) return false;
      const chain = read.records.filter((record) => record.runId === candidate.runId &&
        record.stage !== 'summary');
      const finalState = Object.fromEntries(STATE_KEYS.map((key) => [key, candidate[key]])) as unknown as
        AgentOsLocalContainerBrokerJournalStateV1;
      const summarized = this.#write({ ...finalState, sequence: 1, stage: 'summary',
        previousRecordDigest: candidate.recordDigest }, lock);
      if (!summarized.ok) return false;
      const removed = removeImmutablePrivateRecords(this.#config, chain, {
        lockWaitMs: this.#lockWaitMs,
        guard: () => this.#owns(lock),
      });
      if (!['removed', 'replayed'].includes(removed)) return false;
    }
  }

  begin(
    state: AgentOsLocalContainerBrokerJournalStateV1,
    lock: LocalStoreLock,
  ): AgentOsLocalContainerBrokerJournalMutationV1 {
    if (!this.#owns(lock)) return { ok: false, reason: 'lifecycle-lock-invalid', record: null };
    const snapshot = ownedSnapshot(state);
    if (!snapshot || !exactKeys(snapshot, STATE_KEYS) || !validState(snapshot) || snapshot['outcome'] !== null ||
      snapshot['containerId'] !== null || snapshot['engineCreateRequestDigest'] !== null ||
      snapshot['prestartInspectionDigest'] !== null || snapshot['finalInspectionDigest'] !== null ||
      snapshot['prepareAttestationDigest'] !== null ||
      snapshot['finalAttestationDigest'] !== null || snapshot['removalEvidenceDigest'] !== null) {
      return { ok: false, reason: 'invalid-state', record: null };
    }
    let read = this.#readComplete();
    const outstanding = read.ok ? read.latest.filter((item) => !TERMINAL.has(item.stage))
      .reduce((total, item) => total + Math.max(0, MAX_RECORDS_PER_LIFECYCLE - item.sequence), 0) : 0;
    if (read.ok && !read.latest.some((item) => item.runId === state.runId) &&
      !this.#compact(outstanding + MAX_RECORDS_PER_LIFECYCLE, lock)) {
      return { ok: false, reason: 'journal-unavailable', record: null };
    }
    read = this.#readComplete();
    if (!read.ok || read.latest.some((item) => item.runId === state.runId) ||
      read.recordCount + outstanding + MAX_RECORDS_PER_LIFECYCLE > this.#maxRecords) {
      return { ok: false, reason: read.ok ? 'run-conflict' : 'journal-unavailable', record: null };
    }
    return this.#write({ ...(snapshot as unknown as AgentOsLocalContainerBrokerJournalStateV1),
      sequence: 1, stage: 'lease-held', previousRecordDigest: null }, lock);
  }

  advance(
    runId: string,
    expectedPreviousRecordDigest: string,
    stage: Exclude<AgentOsLocalContainerBrokerJournalStageV1, 'lease-held'>,
    updates: Partial<Pick<AgentOsLocalContainerBrokerJournalStateV1,
    'leaseEpoch' | 'containerId' | 'engineCreateRequestDigest' | 'prestartInspectionDigest' |
    'finalInspectionDigest' |
    'prepareAttestationDigest' | 'finalAttestationDigest' | 'removalEvidenceDigest' | 'outcome'>>,
    lock: LocalStoreLock,
  ): AgentOsLocalContainerBrokerJournalMutationV1 {
    if (!this.#owns(lock) || !RAW_DIGEST_RE.test(runId) || !RAW_DIGEST_RE.test(expectedPreviousRecordDigest) ||
      !STAGES.includes(stage)) {
      return { ok: false, reason: 'invalid-input', record: null };
    }
    const update = ownedSnapshot(updates);
    const allowed = [
      'containerId', 'engineCreateRequestDigest', 'finalAttestationDigest', 'finalInspectionDigest',
      'leaseEpoch', 'outcome', 'prepareAttestationDigest', 'removalEvidenceDigest',
      'prestartInspectionDigest',
    ];
    if (!update || Object.keys(update).some((key) => !allowed.includes(key))) {
      return { ok: false, reason: 'invalid-input', record: null };
    }
    const read = this.#readComplete();
    const previous = read.latest.find((item) => item.runId === runId);
    if (!read.ok || !previous || previous.recordDigest !== expectedPreviousRecordDigest ||
      !TRANSITIONS[previous.stage].includes(stage) || read.recordCount >= this.#maxRecords) {
      return { ok: false, reason: read.ok ? 'stage-conflict' : 'journal-unavailable', record: null };
    }
    const state = Object.fromEntries(STATE_KEYS.map((key) => [key, previous[key]])) as unknown as
      AgentOsLocalContainerBrokerJournalStateV1;
    Object.assign(state, update);
    const provisional = { ...state, schemaVersion: 1 as const,
      protocol: AGENT_OS_LOCAL_CONTAINER_BROKER_JOURNAL_V1, sequence: previous.sequence + 1,
      stage, recordedAt: previous.recordedAt, previousRecordDigest: previous.recordDigest,
      recordDigest: previous.recordDigest };
    if (!validState(state as unknown as Record<string, unknown>) ||
      (TERMINAL.has(stage) !== (state.outcome !== null)) || !stageStateValid(provisional)) {
      return { ok: false, reason: 'invalid-state', record: null };
    }
    return this.#write({ ...state, sequence: previous.sequence + 1, stage,
      previousRecordDigest: previous.recordDigest }, lock);
  }

  #write(
    value: AgentOsLocalContainerBrokerJournalStateV1 & {
      sequence: number;
      stage: AgentOsLocalContainerBrokerJournalStageV1;
      previousRecordDigest: string | null;
    },
    lock: LocalStoreLock,
  ): AgentOsLocalContainerBrokerJournalMutationV1 {
    const now = this.#clock();
    if (!this.#owns(lock) || !Number.isFinite(now.getTime())) {
      return { ok: false, reason: 'clock-unavailable', record: null };
    }
    const unsigned = {
      schemaVersion: 1 as const,
      protocol: AGENT_OS_LOCAL_CONTAINER_BROKER_JOURNAL_V1,
      ...value,
      recordedAt: now.toISOString(),
    };
    const persisted: AgentOsLocalContainerBrokerJournalRecordV1 = {
      ...unsigned,
      recordDigest: recordDigest(unsigned),
    };
    const written = writeImmutablePrivateRecord(this.#config, persisted, {
      lockWaitMs: this.#lockWaitMs,
      prepublish: () => this.#owns(lock),
    });
    if (!['recorded', 'replayed'].includes(written)) {
      return { ok: false, reason: `journal-${written}`, record: null };
    }
    return { ok: true, record: immutable(structuredClone(persisted)) };
  }

  readActive(lock: LocalStoreLock): AgentOsLocalContainerBrokerJournalRecordV1[] | null {
    if (!this.#owns(lock)) return null;
    const read = this.#readComplete();
    return read.ok
      ? read.latest.filter((item) => !TERMINAL.has(item.stage)).map((item) => structuredClone(item))
      : null;
  }

  recoverStore(lock: LocalStoreLock): boolean {
    if (!this.#owns(lock)) return false;
    const recovered = ['clean', 'recovered'].includes(recoverImmutablePrivateRecordStore(this.#config, {
      lockWaitMs: this.#lockWaitMs,
    }));
    return recovered && this.#compact(0, lock);
  }

  inspect(): AgentOsLocalContainerBrokerJournalInspectionV1 {
    if (!this.#enabled) return {
      enabled: false, sourceState: 'disabled', complete: true, activeRuns: [], terminalRunCount: 0,
      recordCount: 0, stopReasons: ['disabled'], sameUserTamperResistant: false,
      commissioningAuthority: false, activationAuthority: false,
    };
    if (!this.#pathsValid() || !existsSync(this.#rootPath)) return {
      enabled: true, sourceState: 'missing', complete: true, activeRuns: [], terminalRunCount: 0,
      recordCount: 0, stopReasons: ['missing'], sameUserTamperResistant: false,
      commissioningAuthority: false, activationAuthority: false,
    };
    const read = this.#readComplete();
    return {
      enabled: true,
      sourceState: read.ok ? read.sourceState : 'degraded',
      complete: read.ok,
      activeRuns: read.ok ? read.latest.filter((item) => !TERMINAL.has(item.stage)).map((item) => Object.freeze({
        runId: item.runId, stage: item.stage, sequence: item.sequence, recordDigest: item.recordDigest,
      })) : [],
      terminalRunCount: read.ok ? read.latest.filter((item) => TERMINAL.has(item.stage)).length : 0,
      recordCount: read.recordCount,
      stopReasons: read.stopReasons,
      sameUserTamperResistant: false,
      commissioningAuthority: false,
      activationAuthority: false,
    };
  }
}

export function agentOsLocalContainerBrokerRunIdV1(requestNonce: string): string | null {
  if (typeof requestNonce !== 'string' || requestNonce.length < 22 || requestNonce.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(requestNonce)) return null;
  return createHash('sha256').update('ashlr.agent-os.local-container-broker.run.v1\0', 'utf8')
    .update(requestNonce, 'utf8').digest('hex');
}

export function agentOsLocalContainerBrokerRequestNonceDigestV1(requestNonce: string): string | null {
  if (typeof requestNonce !== 'string' || requestNonce.length < 22 || requestNonce.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(requestNonce)) return null;
  return createHash('sha256').update('ashlr.agent-os.local-container-broker.request-nonce.v1\0', 'utf8')
    .update(requestNonce, 'utf8').digest('hex');
}

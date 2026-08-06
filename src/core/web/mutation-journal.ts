import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  readImmutablePrivateRecordPoint,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import {
  loadExistingProvenanceKeyReadOnly,
  loadOrCreateKey,
} from '../foundry/provenance.js';

const SCHEMA_VERSION = 1 as const;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
export const WEB_MUTATION_RECOVERY_REQUIRED_AFTER_MS = 15 * 60 * 1_000;

interface MutationReservationRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  recordType: 'web-mutation-reservation';
  reservationId: string;
  principalHash: string;
  idempotencyKeyHash: string;
  capability: string;
  method: string;
  pathHash: string;
  bodyTargetDigest: string;
  requestDigest: string;
  createdAtMs: number;
  attestation: string;
}

interface MutationCompletionRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  recordType: 'web-mutation-completion';
  reservationId: string;
  requestDigest: string;
  outcome: 'succeeded' | 'refused' | 'failed' | 'uncertain';
  status: number;
  resultDigest: string;
  attestation: string;
}

export interface WebMutationReservation {
  reservationId: string;
  idempotencyKeyHash: string;
  pathHash: string;
  requestDigest: string;
}

export interface WebMutationReplayState {
  state: 'completed' | 'in-progress' | 'recovery-required';
  outcome?: MutationCompletionRecord['outcome'];
  status?: number;
}

export type ReserveWebMutationResult =
  | { ok: true; reservation: WebMutationReservation }
  | { ok: false; reason: 'replayed'; replay: WebMutationReplayState }
  | { ok: false; reason: 'invalid-key' | 'conflicted' | 'unavailable' };

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function attest(domain: string, value: unknown, key: Buffer): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, value])).digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

function strictKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function parseReservation(value: unknown, key: Buffer): MutationReservationRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = [
    'schemaVersion', 'recordType', 'reservationId', 'principalHash',
    'idempotencyKeyHash', 'capability', 'method', 'pathHash',
    'bodyTargetDigest', 'requestDigest', 'createdAtMs', 'attestation',
  ] as const;
  if (!strictKeys(row, keys) || row['schemaVersion'] !== SCHEMA_VERSION ||
    row['recordType'] !== 'web-mutation-reservation' ||
    typeof row['capability'] !== 'string' || row['capability'].length > 80 ||
    typeof row['method'] !== 'string' || !/^[A-Z]{3,12}$/.test(row['method']) ||
    !Number.isSafeInteger(row['createdAtMs']) || Number(row['createdAtMs']) < 0 ||
    !['reservationId', 'principalHash', 'idempotencyKeyHash', 'pathHash', 'bodyTargetDigest', 'requestDigest', 'attestation']
      .every((key) => typeof row[key] === 'string' && SHA256_RE.test(row[key] as string))) return null;
  const { attestation, ...unsigned } = row as unknown as MutationReservationRecord;
  return equalDigest(attestation, attest('ashlr:web-mutation-reservation:v1', unsigned, key))
    ? row as unknown as MutationReservationRecord
    : null;
}

function parseCompletion(value: unknown, key: Buffer): MutationCompletionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = [
    'schemaVersion', 'recordType', 'reservationId', 'requestDigest',
    'outcome', 'status', 'resultDigest', 'attestation',
  ] as const;
  if (!strictKeys(row, keys) || row['schemaVersion'] !== SCHEMA_VERSION ||
    row['recordType'] !== 'web-mutation-completion' ||
    !['reservationId', 'requestDigest', 'resultDigest', 'attestation']
      .every((key) => typeof row[key] === 'string' && SHA256_RE.test(row[key] as string)) ||
    (row['outcome'] !== 'succeeded' && row['outcome'] !== 'refused' &&
      row['outcome'] !== 'failed' && row['outcome'] !== 'uncertain') ||
    !Number.isInteger(row['status']) || Number(row['status']) < 100 || Number(row['status']) > 599) return null;
  const { attestation, ...unsigned } = row as unknown as MutationCompletionRecord;
  return equalDigest(attestation, attest('ashlr:web-mutation-completion:v1', unsigned, key))
    ? row as unknown as MutationCompletionRecord
    : null;
}

function codec<RecordType extends MutationReservationRecord | MutationCompletionRecord>(
  parse: (value: unknown, key: Buffer) => RecordType | null,
  prefix: string,
  key: Buffer,
): ImmutablePrivateRecordCodec<RecordType> {
  return {
    parse: (value) => parse(value, key),
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => record.reservationId,
    recordFileName: (record) => `${prefix}-${record.reservationId}.json`,
    isRecordFileName: (name) => new RegExp(`^${prefix}-[a-f0-9]{64}\\.json$`).test(name),
    stageToken: (record) => hash([prefix, record]),
    equivalent: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  };
}

function stateRoot(): string {
  return join(homedir(), '.ashlr');
}

function assureStateRoot(): boolean {
  try {
    const root = stateRoot();
    if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
    const before = lstatSync(root);
    if (!before.isDirectory() || before.isSymbolicLink() ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())) return false;
    if (process.platform !== 'win32') chmodSync(root, 0o700);
    const stat = lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      stat.dev === before.dev && stat.ino === before.ino &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
      (process.platform === 'win32' || (stat.mode & 0o777) === 0o700);
  } catch {
    return false;
  }
}

function storeConfig<RecordType>(
  name: string,
  codecForWrite: () => ImmutablePrivateRecordCodec<RecordType> | null,
  codecForRead: () => ImmutablePrivateRecordCodec<RecordType> | null,
): ImmutablePrivateRecordStoreConfig<RecordType> {
  const root = stateRoot();
  return {
    label: `web mutation ${name}`,
    anchorPath: root,
    rootPath: join(root, `web-mutation-${name}`),
    lockFileName: '.store.lock',
    maxRecordBytes: 2_048,
    defaultMaxFiles: 50_000,
    hardMaxFiles: 100_000,
    defaultMaxBytes: 64 * 1024 * 1024,
    hardMaxBytes: 128 * 1024 * 1024,
    codecForWrite,
    codecForRead,
  };
}

const reservationStore = () => storeConfig(
  'reservations',
  () => codec(parseReservation, 'reservation-v1', loadOrCreateKey()),
  () => {
    const key = loadExistingProvenanceKeyReadOnly();
    return key ? codec(parseReservation, 'reservation-v1', key) : null;
  },
);
const completionStore = () => storeConfig(
  'completions',
  () => codec(parseCompletion, 'completion-v1', loadOrCreateKey()),
  () => {
    const key = loadExistingProvenanceKeyReadOnly();
    return key ? codec(parseCompletion, 'completion-v1', key) : null;
  },
);

export function canonicalMutationDigest(value: unknown): string | null {
  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth > 24) throw new Error('body too deep');
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (Array.isArray(candidate)) return candidate.map((item) => visit(item, depth + 1));
    if (!candidate || typeof candidate !== 'object' || Object.getPrototypeOf(candidate) !== Object.prototype) {
      throw new Error('unsupported body');
    }
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
      out[key] = visit((candidate as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  };
  try {
    const encoded = JSON.stringify(visit(value, 0));
    return Buffer.byteLength(encoded, 'utf8') <= 65_536 ? hash(['body-target', encoded]) : null;
  } catch {
    return null;
  }
}

export function reserveWebMutation(input: {
  idempotencyKey: string;
  actorId: string;
  capability: string;
  method: string;
  path: string;
  bodyTargetDigest: string;
  nowMs?: number;
  maxFiles?: number;
  maxBytes?: number;
}): ReserveWebMutationResult {
  const nowMs = input.nowMs ?? Date.now();
  if (!KEY_RE.test(input.idempotencyKey) || !SHA256_RE.test(input.bodyTargetDigest) ||
    !Number.isSafeInteger(nowMs) || nowMs < 0 || !assureStateRoot()) {
    return { ok: false, reason: KEY_RE.test(input.idempotencyKey) ? 'unavailable' : 'invalid-key' };
  }
  const principalHash = hash(['principal', input.actorId]);
  const idempotencyKeyHash = hash(['idempotency-key', input.idempotencyKey]);
  const reservationId = hash(['reservation', principalHash, idempotencyKeyHash]);
  const pathHash = hash(['path', input.path]);
  const requestDigest = hash([
    'web-mutation-request-v1', principalHash, idempotencyKeyHash,
    input.capability, input.method, pathHash, input.bodyTargetDigest,
  ]);
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    recordType: 'web-mutation-reservation' as const,
    reservationId,
    principalHash,
    idempotencyKeyHash,
    capability: input.capability,
    method: input.method,
    pathHash,
    bodyTargetDigest: input.bodyTargetDigest,
    requestDigest,
    createdAtMs: nowMs,
  };
  let record: MutationReservationRecord;
  try {
    record = {
      ...unsigned,
      attestation: attest('ashlr:web-mutation-reservation:v1', unsigned, loadOrCreateKey()),
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const disposition = writeImmutablePrivateRecord(reservationStore(), record, {
    ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  });
  if (disposition === 'recorded') {
    return { ok: true, reservation: { reservationId, idempotencyKeyHash, pathHash, requestDigest } };
  }
  if (disposition === 'replayed' || disposition === 'conflicted') {
    const existing = readImmutablePrivateRecordPoint(
      reservationStore(),
      reservationId,
      `reservation-v1-${reservationId}.json`,
    );
    if (!existing.exactReadComplete || existing.record === null) {
      return { ok: false, reason: 'unavailable' };
    }
    if (existing.record.requestDigest !== requestDigest) return { ok: false, reason: 'conflicted' };
    const completionRead = readImmutablePrivateRecordPoint(
      completionStore(),
      reservationId,
      `completion-v1-${reservationId}.json`,
    );
    if (completionRead.sourceState === 'degraded' ||
      (completionRead.sourceState === 'healthy' && !completionRead.exactReadComplete)) {
      return { ok: false, reason: 'unavailable' };
    }
    const completion = completionRead.record;
    if (completion !== null) {
      if (completion.requestDigest !== requestDigest) return { ok: false, reason: 'unavailable' };
      return {
        ok: false,
        reason: 'replayed',
        replay: {
          state: 'completed',
          outcome: completion.outcome,
          status: completion.status,
        },
      };
    }
    return {
      ok: false,
      reason: 'replayed',
      replay: {
        state: nowMs - existing.record.createdAtMs >= WEB_MUTATION_RECOVERY_REQUIRED_AFTER_MS
          ? 'recovery-required'
          : 'in-progress',
      },
    };
  }
  return { ok: false, reason: 'unavailable' };
}

export function completeWebMutation(input: {
  reservation: WebMutationReservation;
  outcome: MutationCompletionRecord['outcome'];
  status: number;
  result: unknown;
  maxFiles?: number;
  maxBytes?: number;
}): boolean {
  if (!assureStateRoot()) return false;
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    recordType: 'web-mutation-completion' as const,
    reservationId: input.reservation.reservationId,
    requestDigest: input.reservation.requestDigest,
    outcome: input.outcome,
    status: input.status,
    resultDigest: hash(['result', input.result]),
  };
  let record: MutationCompletionRecord;
  try {
    record = {
      ...unsigned,
      attestation: attest('ashlr:web-mutation-completion:v1', unsigned, loadOrCreateKey()),
    };
  } catch {
    return false;
  }
  const disposition = writeImmutablePrivateRecord(completionStore(), record, {
    ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  });
  return disposition === 'recorded' || disposition === 'replayed';
}

export function readWebMutationCompletion(
  reservationId: string,
): MutationCompletionRecord | null {
  if (!SHA256_RE.test(reservationId)) return null;
  const result = readImmutablePrivateRecordPoint(
    completionStore(),
    reservationId,
    `completion-v1-${reservationId}.json`,
  );
  return result.exactReadComplete ? result.record : null;
}

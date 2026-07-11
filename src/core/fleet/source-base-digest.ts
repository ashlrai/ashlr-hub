import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';

import type {
  SourceBaseConsistency,
  SourceBaseDigestV1,
  SourceBaseDirtyState,
  SourceBaseKind,
} from '../types.js';
import { loadExistingProvenanceKey } from '../foundry/provenance.js';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const SOURCE_KINDS = new Set<SourceBaseKind>([
  'git-tree',
  'filesystem-snapshot',
  'local-store',
  'remote-snapshot',
]);
const CONSISTENCY_MODES = new Set<SourceBaseConsistency>([
  'immutable',
  'locked',
  'stable-double-read',
]);
const DIRTY_STATES = new Set<SourceBaseDirtyState>([
  'clean',
  'tracked',
  'untracked',
  'mixed',
  'not-applicable',
]);

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | {
  [key: string]: CanonicalValue;
};

export interface BuildSourceBaseDigestInput {
  repo: string;
  scannerId: string;
  scannerRevision: number;
  sourceKind: SourceBaseKind;
  consistency: SourceBaseConsistency;
  dirty: SourceBaseDirtyState;
  sourceSnapshot: unknown;
  requirementSnapshot: unknown;
  scannerConfig: unknown;
}

function canonicalize(value: unknown, ancestors: Set<object>): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? value.normalize('NFC') : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical numbers must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('source-base inputs must contain only JSON values');
  }
  if (ancestors.has(value)) throw new TypeError('source-base inputs must not be cyclic');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalize(entry, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('source-base objects must be plain records');
    }

    const normalizedEntries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key.normalize('NFC'), entry] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const output: Record<string, CanonicalValue> = Object.create(null) as Record<string, CanonicalValue>;
    let previousKey: string | undefined;
    for (const [key, entry] of normalizedEntries) {
      if (key === previousKey) {
        throw new TypeError('source-base object keys must remain unique after NFC normalization');
      }
      output[key] = canonicalize(entry, ancestors);
      previousKey = key;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

function hmac(key: Buffer, payload: unknown): string {
  return createHmac('sha256', key).update(canonicalJson(payload), 'utf8').digest('hex');
}

function validNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.normalize('NFC').trim().length > 0;
}

function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** Build a source-base identity using only already-existing protected key material. */
export function buildSourceBaseDigest(input: BuildSourceBaseDigestInput): SourceBaseDigestV1 | null {
  try {
    if (
      !validNonEmptyString(input.repo)
      || !validNonEmptyString(input.scannerId)
      || !Number.isSafeInteger(input.scannerRevision)
      || input.scannerRevision < 1
      || !SOURCE_KINDS.has(input.sourceKind)
      || !CONSISTENCY_MODES.has(input.consistency)
      || !DIRTY_STATES.has(input.dirty)
    ) return null;

    const key = loadExistingProvenanceKey();
    if (!key) return null;

    const scannerId = input.scannerId.normalize('NFC');
    const sourceDigest = hmac(key, [
      'ashlr:scanner-source:v1',
      input.sourceKind,
      canonicalize(input.sourceSnapshot, new Set<object>()),
    ]);
    const requirementDigest = hmac(key, [
      'ashlr:scanner-requirement:v1',
      scannerId,
      input.scannerRevision,
      canonicalize(input.requirementSnapshot, new Set<object>()),
    ]);
    const configDigest = hmac(key, [
      'ashlr:scanner-config:v1',
      scannerId,
      input.scannerRevision,
      canonicalize(input.scannerConfig, new Set<object>()),
    ]);
    const baseDigest = hmac(key, [
      'ashlr:scanner-source-base:v1',
      resolve(input.repo).normalize('NFC'),
      scannerId,
      input.scannerRevision,
      input.sourceKind,
      input.consistency,
      input.dirty,
      sourceDigest,
      requirementDigest,
      configDigest,
    ]);

    return {
      schemaVersion: 1,
      algorithm: 'hmac-sha256',
      sourceKind: input.sourceKind,
      sourceDigest,
      requirementDigest,
      configDigest,
      baseDigest,
      scannerRevision: input.scannerRevision,
      consistency: input.consistency,
      dirty: input.dirty,
    };
  } catch {
    return null;
  }
}

/** Reconstruct the exact persistence schema, discarding all unknown/raw fields. */
export function sanitizeSourceBaseDigest(value: unknown): SourceBaseDigestV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate['schemaVersion'] !== 1
    || candidate['algorithm'] !== 'hmac-sha256'
    || !SOURCE_KINDS.has(candidate['sourceKind'] as SourceBaseKind)
    || !SHA256_HEX_RE.test(typeof candidate['sourceDigest'] === 'string' ? candidate['sourceDigest'] : '')
    || !SHA256_HEX_RE.test(typeof candidate['requirementDigest'] === 'string' ? candidate['requirementDigest'] : '')
    || !SHA256_HEX_RE.test(typeof candidate['configDigest'] === 'string' ? candidate['configDigest'] : '')
    || !SHA256_HEX_RE.test(typeof candidate['baseDigest'] === 'string' ? candidate['baseDigest'] : '')
    || !Number.isSafeInteger(candidate['scannerRevision'])
    || (candidate['scannerRevision'] as number) < 1
    || !CONSISTENCY_MODES.has(candidate['consistency'] as SourceBaseConsistency)
    || !DIRTY_STATES.has(candidate['dirty'] as SourceBaseDirtyState)
  ) return null;

  return {
    schemaVersion: 1,
    algorithm: 'hmac-sha256',
    sourceKind: candidate['sourceKind'] as SourceBaseKind,
    sourceDigest: candidate['sourceDigest'] as string,
    requirementDigest: candidate['requirementDigest'] as string,
    configDigest: candidate['configDigest'] as string,
    baseDigest: candidate['baseDigest'] as string,
    scannerRevision: candidate['scannerRevision'] as number,
    consistency: candidate['consistency'] as SourceBaseConsistency,
    dirty: candidate['dirty'] as SourceBaseDirtyState,
  };
}

/** Authenticate the envelope's tuple and component digests with the host provenance key. */
export function verifySourceBaseDigest(
  repo: string,
  scannerId: string,
  value: unknown,
): SourceBaseDigestV1 | null {
  const sourceBase = sanitizeSourceBaseDigest(value);
  const key = loadExistingProvenanceKey();
  if (!sourceBase || !key || !validNonEmptyString(repo) || !validNonEmptyString(scannerId)) return null;
  const expected = hmac(key, [
    'ashlr:scanner-source-base:v1',
    resolve(repo).normalize('NFC'),
    scannerId.normalize('NFC'),
    sourceBase.scannerRevision,
    sourceBase.sourceKind,
    sourceBase.consistency,
    sourceBase.dirty,
    sourceBase.sourceDigest,
    sourceBase.requirementDigest,
    sourceBase.configDigest,
  ]);
  return equalDigest(expected, sourceBase.baseDigest) ? sourceBase : null;
}

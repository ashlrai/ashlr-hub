import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadExistingProvenanceKey } from '../foundry/provenance.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_KINDS = new Set<AuthenticatedCutoffSnapshotKind>([
  'enrollment', 'proposals', 'post-merge-observations', 'post-merge-stability',
]);

export type AuthenticatedCutoffSnapshotKind =
  | 'enrollment'
  | 'proposals'
  | 'post-merge-observations'
  | 'post-merge-stability';

export interface AuthenticatedCutoffEnvelopeV2 {
  snapshotSchemaVersion: 1;
  snapshotKind: AuthenticatedCutoffSnapshotKind;
  authorityScope: 'observation-only';
  cutoffAuthority: false;
  cutoffBasis: 'bracketed-observation';
  consistency: 'stable-double-read';
  capturedAt: string;
  authorityId: string;
  sourceRoot: string;
  projectionRoot: string;
  snapshotDigest: string;
}

export interface AuthenticatedCutoffSnapshotInput {
  kind: AuthenticatedCutoffSnapshotKind;
  capturedAt: string;
  sourcePayload: unknown[];
  projectionPayload: unknown[];
}

type KeyProvider = () => Buffer | null;
type CanonicalValue = null | boolean | number | string | CanonicalValue[] | {
  [key: string]: CanonicalValue;
};

function canonicalize(value: unknown, ancestors: Set<object>): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('snapshot numbers must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('snapshot payload must be acyclic JSON');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('snapshot arrays must not be sparse');
        return canonicalize(entry, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('snapshot objects must be plain records');
    }
    const output: Record<string, CanonicalValue> = Object.create(null) as Record<string, CanonicalValue>;
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    let previous: string | undefined;
    for (const [key, entry] of entries) {
      if (key === previous) throw new TypeError('snapshot keys must be unique');
      output[key] = canonicalize(entry, ancestors);
      previous = key;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function hmac(key: Buffer, tuple: unknown[]): string {
  return createHmac('sha256', key).update(canonicalJson(tuple), 'utf8').digest('hex');
}

function existingKey(): Buffer | null {
  try { return loadExistingProvenanceKey(); } catch { return null; }
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createAuthenticatedCutoffEnvelopeV2(
  input: AuthenticatedCutoffSnapshotInput,
  keyProvider: KeyProvider = existingKey,
): AuthenticatedCutoffEnvelopeV2 | null {
  try {
    if (!SNAPSHOT_KINDS.has(input.kind) || !canonicalTimestamp(input.capturedAt) ||
      !Array.isArray(input.sourcePayload) ||
      !Array.isArray(input.projectionPayload)) return null;
    const key = keyProvider();
    if (!key || key.length !== 32) return null;
    const authorityId = hmac(key, ['ashlr:cutoff-snapshot-authority:v1']);
    const sourceRoot = hmac(key, [
      'ashlr:cutoff-snapshot-source:v1', input.kind, input.capturedAt, input.sourcePayload,
    ]);
    const projectionRoot = hmac(key, [
      'ashlr:cutoff-snapshot-projection:v1', input.kind, input.capturedAt,
      sourceRoot, input.projectionPayload,
    ]);
    const snapshotDigest = hmac(key, [
      'ashlr:cutoff-snapshot-envelope:v1', 1, input.kind, 'observation-only', false,
      'bracketed-observation',
      'stable-double-read', input.capturedAt, authorityId, sourceRoot, projectionRoot,
    ]);
    return {
      snapshotSchemaVersion: 1,
      snapshotKind: input.kind,
      authorityScope: 'observation-only',
      cutoffAuthority: false,
      cutoffBasis: 'bracketed-observation',
      consistency: 'stable-double-read',
      capturedAt: input.capturedAt,
      authorityId,
      sourceRoot,
      projectionRoot,
      snapshotDigest,
    };
  } catch {
    return null;
  }
}

export function verifyAuthenticatedCutoffEnvelopeV2(
  envelope: AuthenticatedCutoffEnvelopeV2,
  input: AuthenticatedCutoffSnapshotInput,
  keyProvider: KeyProvider = existingKey,
): boolean {
  try {
    if (envelope.snapshotSchemaVersion !== 1 || envelope.snapshotKind !== input.kind ||
      envelope.authorityScope !== 'observation-only' || envelope.cutoffAuthority !== false ||
      envelope.cutoffBasis !== 'bracketed-observation' ||
      envelope.consistency !== 'stable-double-read' ||
      envelope.capturedAt !== input.capturedAt) return false;
    const expected = createAuthenticatedCutoffEnvelopeV2(input, keyProvider);
    return Boolean(expected && equalDigest(expected.authorityId, envelope.authorityId) &&
      equalDigest(expected.sourceRoot, envelope.sourceRoot) &&
      equalDigest(expected.projectionRoot, envelope.projectionRoot) &&
      equalDigest(expected.snapshotDigest, envelope.snapshotDigest));
  } catch {
    return false;
  }
}

/** Domain-separated MAC for durable cutoff-observation checkpoint metadata. */
export function createCutoffCheckpointDigestV1(
  payload: unknown[],
  keyProvider: KeyProvider = existingKey,
): string | null {
  try {
    if (!Array.isArray(payload)) return null;
    const key = keyProvider();
    if (!key || key.length !== 32) return null;
    return hmac(key, ['ashlr:cutoff-observation-checkpoint:v1', payload]);
  } catch {
    return null;
  }
}

export function verifyCutoffCheckpointDigestV1(
  payload: unknown[],
  digest: string,
  keyProvider: KeyProvider = existingKey,
): boolean {
  const expected = createCutoffCheckpointDigestV1(payload, keyProvider);
  return expected !== null && equalDigest(expected, digest);
}

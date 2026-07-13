import { createHash } from 'node:crypto';

const PERSISTENCE_MARKER = '_ashlrPersistence' as const;
const PERSISTENCE_SCHEMA_VERSION = 1 as const;

interface PersistenceMarker {
  schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  revision: number;
}

interface PersistenceSnapshot {
  digest: string;
  revision: number;
}

const snapshots = new WeakMap<object, PersistenceSnapshot>();

// Write authority is intentionally bound to the exact loaded object. Callers
// that clone persistence state must transfer authority explicitly; silently
// inheriting it through arbitrary aliases would let stale clones overwrite.

export function persistenceDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function markerRevision(value: unknown): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 0;
  const marker = value as Record<string, unknown>;
  return marker['schemaVersion'] === PERSISTENCE_SCHEMA_VERSION &&
    Number.isSafeInteger(marker['revision']) && Number(marker['revision']) >= 1
    ? Number(marker['revision'])
    : 0;
}

export function stripPersistenceMarker(record: Record<string, unknown>): {
  record: Record<string, unknown>;
  revision: number;
} {
  const { [PERSISTENCE_MARKER]: marker, ...semantic } = record;
  return { record: semantic, revision: markerRevision(marker) };
}

export function addPersistenceMarker<T extends Record<string, unknown>>(
  record: T,
  revision: number,
): T & { [PERSISTENCE_MARKER]: PersistenceMarker } {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Invalid persistence revision');
  }
  return {
    ...record,
    [PERSISTENCE_MARKER]: {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      revision,
    },
  };
}

export function bindPersistenceSnapshot(
  value: object,
  raw: string,
  revision: number,
): void {
  snapshots.set(value, { digest: persistenceDigest(raw), revision });
}

export function persistenceSnapshot(value: object): Readonly<PersistenceSnapshot> | undefined {
  return snapshots.get(value);
}

export function inheritPersistenceSnapshot(source: object, target: object): void {
  const snapshot = snapshots.get(source);
  if (snapshot) snapshots.set(target, snapshot);
}

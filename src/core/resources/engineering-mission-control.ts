/** Durable operator intent, separate from mission admission and delivery evidence. */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, inspectPrivateDirectory } from '../universe/artifacts.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { missionData, missionExact, missionHash, validateResourceEngineeringMissionConfig, type ResourceEngineeringMissionConfig } from './engineering-mission-store.js';

export interface EngineeringMissionControl { revision: number; enabled: boolean; digest: string | null }
interface ControlRecord { id: string; revision: number; configDigest: string; previousDigest: string | null; enabled: boolean }
const MAX_RECORDS = 4096;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (): never => { throw new Error('Mission control history unavailable or changed'); };
function store(root: string): ImmutablePrivateRecordStoreConfig<ControlRecord> {
  const codec = {
    parse(input: unknown): ControlRecord | null {
      try {
        const row = missionData<ControlRecord>(input);
        return missionExact(row, ['id', 'revision', 'configDigest', 'previousDigest', 'enabled']) &&
          Number.isSafeInteger(row.revision) && row.revision > 0 && row.revision <= MAX_RECORDS &&
          row.id === String(row.revision).padStart(4, '0') && hash(row.configDigest) &&
          (row.previousDigest === null || hash(row.previousDigest)) && typeof row.enabled === 'boolean' ? row : null;
      } catch { return null; }
    },
    serialize: (row: ControlRecord) => canonical(row) + '\n', recordId: (row: ControlRecord) => row.id,
    recordFileName: (row: ControlRecord) => row.id + '.json', isRecordFileName: (name: string) => /^\d{4}\.json$/.test(name),
    stageToken: missionHash, equivalent: (a: ControlRecord, b: ControlRecord) => canonical(a) === canonical(b),
  };
  return { label: 'Mission controls', anchorPath: root, rootPath: join(root, 'mission-controls'), lockFileName: '.records.lock',
    maxRecordBytes: 2048, defaultMaxFiles: MAX_RECORDS, hardMaxFiles: MAX_RECORDS,
    defaultMaxBytes: MAX_RECORDS * 2048, hardMaxBytes: MAX_RECORDS * 2048, codecForRead: () => codec, codecForWrite: () => codec };
}
export function pinEngineeringMissionControlRoot(root: string): () => void {
  inspectPrivateDirectory(root); const before = lstatSync(root, { bigint: true });
  return () => { inspectPrivateDirectory(root); const after = lstatSync(root, { bigint: true });
    if (['dev', 'ino', 'uid', 'mode'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) fail(); };
}
export function readEngineeringMissionControl(input: ResourceEngineeringMissionConfig): EngineeringMissionControl {
  const config = validateResourceEngineeringMissionConfig(input), pinned = pinEngineeringMissionControlRoot(config.root);
  const records = readImmutablePrivateRecords(store(config.root), { requireComplete: true }); pinned();
  if (records.sourceState === 'missing') return { revision: 0, enabled: false, digest: null };
  if (records.sourceState !== 'healthy' || !records.complete) return fail();
  const configDigest = missionHash(config);
  let current: EngineeringMissionControl = { revision: 0, enabled: false, digest: null };
  for (const row of records.records.sort((a, b) => a.revision - b.revision)) {
    if (row.configDigest !== configDigest || row.revision !== current.revision + 1 || row.previousDigest !== current.digest) return fail();
    current = { revision: row.revision, enabled: row.enabled, digest: missionHash(row) };
  }
  // An empty existing directory is not proof that a previous stop never existed.
  if (!current.revision) return fail();
  return current;
}
export function setEngineeringMissionControl(input: ResourceEngineeringMissionConfig, enabled: boolean, expectedRevision: number): EngineeringMissionControl {
  const config = validateResourceEngineeringMissionConfig(input), pinned = pinEngineeringMissionControlRoot(config.root);
  if (typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= MAX_RECORDS) return fail();
  const acquired = acquireLocalStoreLockWithOutcome(join(config.root, '.mission-control.lock'), 0, { anchorPath: config.root, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') return fail();
  try {
    pinned(); const previous = readEngineeringMissionControl(config);
    if (previous.revision !== expectedRevision) return fail();
    const revision = previous.revision + 1;
    const row: ControlRecord = { id: String(revision).padStart(4, '0'), revision, configDigest: missionHash(config), previousDigest: previous.digest, enabled };
    const result = writeImmutablePrivateRecord(store(config.root), row, { lockWaitMs: 0, prepublish: () => {
      pinned(); return ownsLocalStoreLock(acquired.lock);
    } });
    if (result !== 'recorded') return fail();
    pinned(); return readEngineeringMissionControl(config);
  } finally { if (!releaseLocalStoreLock(acquired.lock)) fail(); }
}

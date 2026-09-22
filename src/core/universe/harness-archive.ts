/** Private hypothesis memory. Supplied outcomes never authorize promotion or execution. */
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { canonical, digest, inspectPrivateDirectory, readArtifactSnapshot } from './artifacts.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 256;
const MAX_RECORDS = 257;
export type HarnessCandidateOutcome = 'effective' | 'refuted' | 'inconclusive' | 'superseded';
export interface HarnessArchivedFile { path: string; size: number; digest: string; executable: boolean; contentBase64: string }
export interface HarnessArchivedSnapshot { digest: string; files: HarnessArchivedFile[] }
export interface HarnessArchiveRegistration {
  id: 'registration'; kind: 'registration'; schemaVersion: 1; archiveId: string;
  mutableFiles: string[]; baseline: HarnessArchivedSnapshot; evaluator: HarnessArchivedSnapshot; registrationDigest: string;
}
export interface HarnessVerifierLinkage { evaluatorDigest: string; artifactDigest: string; verifierId: string; receiptDigest: string }
export interface HarnessArchivedCandidate {
  id: string; kind: 'candidate'; schemaVersion: 1; archiveId: string; candidateId: string;
  registrationDigest: string; content: HarnessArchivedSnapshot; changedFiles: string[];
  hypothesis: string; reason: string; outcome: HarnessCandidateOutcome;
  evidence: HarnessVerifierLinkage | null; supersededBy: string | null;
  evidenceScope: 'supplied-verifier-linkage'; independentlyVerified: false; candidateDigest: string;
}
type ArchiveRecord = HarnessArchiveRegistration | HarnessArchivedCandidate;
export interface HarnessArchiveQuery {
  sourceState: 'healthy' | 'missing' | 'degraded'; registration: HarnessArchiveRegistration | null;
  candidates: HarnessArchivedCandidate[]; reasons: string[];
}
export interface RegisterHarnessArchiveOptions {
  root: string; archiveId: string; mutableFiles: string[];
  baselinePath: string; baselineDigest: string; evaluatorPath: string; evaluatorDigest: string;
}
export interface StoreHarnessCandidateOptions {
  root: string; archiveId: string; candidateId: string; candidatePath: string; contentDigest: string;
  hypothesis: string; reason: string; outcome: HarnessCandidateOutcome;
  evidence: HarnessVerifierLinkage | null; supersededBy: string | null;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key) &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function array(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, index)).every((item) => item && 'value' in item);
}
function id(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
function controls(value: string, allowWhitespace = false): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 || code >= 127 && code <= 159) && !(allowWhitespace && [9, 10, 13].includes(code));
  });
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 2_000 && !controls(value, true);
}
function filePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9_./-]+$/.test(value) && !isAbsolute(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !['.git', '.ashlr'].includes(part.toLowerCase()));
}
/** Governance, evaluator fixtures and safety checks are never a search dimension. */
function protectedPath(path: string): boolean {
  const lower = path.toLowerCase(); const parts = lower.split('/'); const name = parts.at(-1)!;
  return lower.includes('constitution') || lower.includes('doctrine') || lower.includes('verify-safety') ||
    lower.includes('safety') || /(?:eval|evaluation)[-_]?fixtures?/.test(lower) ||
    parts.includes('fixtures') && parts.some((part) => part.includes('eval')) ||
    name === 'merge.ts' || name === 'fixed-evaluator.ts' || /^(?:h\d+)[.-].*\.test\.[cm]?[jt]sx?$/.test(name);
}
function absolute(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 4_096 && isAbsolute(value) && resolve(value) === value &&
    parse(value).root !== value && !controls(value);
}
function overlaps(left: string, right: string): boolean {
  const nested = relative(left, right);
  return nested === '' || nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}
function allowlist(value: unknown): value is string[] {
  return array(value, MAX_FILES) && value.length > 0 && value.every((item) => filePath(item) && !protectedPath(item)) &&
    new Set(value.map((item) => (item as string).toLowerCase())).size === value.length;
}
function snapshotValid(value: unknown): value is HarnessArchivedSnapshot {
  if (!exact(value, ['digest', 'files']) || !hash(value.digest) || !array(value.files, MAX_FILES)) return false;
  let bytes = 0; const paths = new Set<string>();
  for (const file of value.files) {
    if (!exact(file, ['path', 'size', 'digest', 'executable', 'contentBase64']) || !filePath(file.path) || !hash(file.digest) ||
      typeof file.executable !== 'boolean' || typeof file.contentBase64 !== 'string' || file.contentBase64.length > MAX_BYTES * 2 ||
      !Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > MAX_BYTES) return false;
    const content = Buffer.from(file.contentBase64, 'base64');
    if (content.toString('base64') !== file.contentBase64 || content.length !== file.size || digest(content) !== file.digest) return false;
    bytes += content.length; if (bytes > MAX_BYTES || paths.has(file.path.toLowerCase())) return false;
    paths.add(file.path.toLowerCase());
  }
  if ([...paths].some((path) => path.split('/').slice(0, -1).some((_, index) => paths.has(path.split('/').slice(0, index + 1).join('/'))))) return false;
  const files = value.files as unknown as HarnessArchivedFile[];
  if (files.some((file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0)) return false;
  return digest(canonical(files.map(({ path, size, digest: contentDigest, executable }) => ({ path, size, digest: contentDigest, executable })))) === value.digest;
}
function capture(path: string, expected: string, root: string): HarnessArchivedSnapshot {
  if (!absolute(path) || !hash(expected) || overlaps(root, path) || overlaps(path, root) || realpathSync(path) !== path) throw new Error('Harness artifact path or digest invalid');
  const before = lstatSync(path); const source = readArtifactSnapshot(path); const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || realpathSync(path) !== path || source.digest !== expected) throw new Error('Harness artifact changed or digest mismatch');
  const result = { digest: source.digest, files: source.entries.map((entry) => ({ path: entry.path, size: entry.data.length,
    digest: digest(entry.data), executable: entry.executable, contentBase64: entry.data.toString('base64') })) };
  if (!snapshotValid(result)) throw new Error('Harness artifact exceeds bounded archive format');
  return result;
}
function linkage(value: unknown): value is HarnessVerifierLinkage {
  return exact(value, ['evaluatorDigest', 'artifactDigest', 'verifierId', 'receiptDigest']) &&
    hash(value.evaluatorDigest) && hash(value.artifactDigest) && id(value.verifierId) && hash(value.receiptDigest);
}
function parseRecord(value: unknown): ArchiveRecord | null {
  if (!value || typeof value !== 'object') return null;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  if (kind === 'registration') {
    if (!exact(value, ['id', 'kind', 'schemaVersion', 'archiveId', 'mutableFiles', 'baseline', 'evaluator', 'registrationDigest']) ||
      value.id !== 'registration' || value.schemaVersion !== 1 || !id(value.archiveId) || !allowlist(value.mutableFiles) ||
      !snapshotValid(value.baseline) || !snapshotValid(value.evaluator) || value.evaluator.files.length === 0 ||
      [...value.baseline.files, ...value.evaluator.files].reduce((sum, file) => sum + file.size, 0) > MAX_BYTES || !hash(value.registrationDigest)) return null;
    const { registrationDigest, ...payload } = value;
    return digest(canonical(payload)) === registrationDigest ? value as unknown as HarnessArchiveRegistration : null;
  }
  if (!exact(value, ['id', 'kind', 'schemaVersion', 'archiveId', 'candidateId', 'registrationDigest', 'content', 'changedFiles',
    'hypothesis', 'reason', 'outcome', 'evidence', 'supersededBy', 'evidenceScope', 'independentlyVerified', 'candidateDigest']) ||
    value.kind !== 'candidate' || value.schemaVersion !== 1 || !id(value.archiveId) || !id(value.candidateId) ||
    value.id !== `candidate.${value.candidateId}` || !hash(value.registrationDigest) || !snapshotValid(value.content) ||
    !array(value.changedFiles, MAX_FILES * 2) || !value.changedFiles.every((path) => filePath(path) && !protectedPath(path)) ||
    new Set(value.changedFiles).size !== value.changedFiles.length || !text(value.hypothesis) || !text(value.reason) ||
    typeof value.outcome !== 'string' || !['effective', 'refuted', 'inconclusive', 'superseded'].includes(value.outcome) ||
    value.evidence !== null && !linkage(value.evidence) || value.outcome === 'effective' && value.evidence === null ||
    value.supersededBy !== null && !id(value.supersededBy) || value.supersededBy === value.candidateId ||
    (value.outcome === 'superseded') !== (value.supersededBy !== null) ||
    value.evidenceScope !== 'supplied-verifier-linkage' || value.independentlyVerified !== false || !hash(value.candidateDigest)) return null;
  const { candidateDigest, ...payload } = value;
  return digest(canonical(payload)) === candidateDigest ? value as unknown as HarnessArchivedCandidate : null;
}
const codec: ImmutablePrivateRecordCodec<ArchiveRecord> = {
  parse: parseRecord, serialize: (record) => `${canonical(record)}\n`, recordId: (record) => record.id,
  recordFileName: (record) => `${record.id}.json`, isRecordFileName: (name) => /^(?:registration|candidate\.[a-z0-9][a-z0-9_-]{0,63})\.json$/.test(name),
  stageToken: (record) => digest(canonical(record)), equivalent: (left, right) => canonical(left) === canonical(right),
};
function config(root: string, archiveId: string): ImmutablePrivateRecordStoreConfig<ArchiveRecord> {
  return { label: 'Harness hypothesis archive', anchorPath: root, rootPath: join(root, `harness-${archiveId}`), lockFileName: '.records.lock',
    maxRecordBytes: 1024 * 1024, defaultMaxFiles: MAX_RECORDS, hardMaxFiles: MAX_RECORDS,
    defaultMaxBytes: 64 * 1024 * 1024, hardMaxBytes: 64 * 1024 * 1024, codecForRead: () => codec, codecForWrite: () => codec };
}
function changes(baseline: HarnessArchivedSnapshot, candidate: HarnessArchivedSnapshot): string[] {
  const before = new Map(baseline.files.map((file) => [file.path, file])); const after = new Map(candidate.files.map((file) => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => {
    const left = before.get(path); const right = after.get(path);
    return !left || !right || left.digest !== right.digest || left.executable !== right.executable;
  }).sort();
}
function candidateMatches(candidate: HarnessArchivedCandidate, registration: HarnessArchiveRegistration): boolean {
  const changed = changes(registration.baseline, candidate.content);
  return candidate.archiveId === registration.archiveId && candidate.registrationDigest === registration.registrationDigest &&
    canonical(changed) === canonical(candidate.changedFiles) && changed.every((path) => registration.mutableFiles.includes(path) &&
      !protectedPath(path) && !registration.evaluator.files.some((file) => file.path.toLowerCase() === path.toLowerCase())) &&
    (candidate.outcome !== 'effective' || changed.length > 0) && (candidate.evidence === null ||
      candidate.evidence.evaluatorDigest === registration.evaluator.digest && candidate.evidence.artifactDigest === candidate.content.digest);
}

/** Never creates storage or authenticates supplied verifier receipts; incomplete archives return no partial success. */
export function readHarnessArchive(options: { root: string; archiveId: string }): HarnessArchiveQuery {
  const empty = (sourceState: HarnessArchiveQuery['sourceState'], reason: string): HarnessArchiveQuery => ({ sourceState, registration: null, candidates: [], reasons: [reason] });
  try {
    if (!exact(options, ['root', 'archiveId']) || !absolute(options.root) || !id(options.archiveId)) return empty('degraded', 'archive-scope-invalid');
    try { inspectPrivateDirectory(options.root); }
    catch (error) { return empty((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded', 'archive-root-unavailable'); }
    try {
      const store = lstatSync(join(options.root, `harness-${options.archiveId}`));
      if (!store.isDirectory() || store.isSymbolicLink()) return empty('degraded', 'archive-storage-invalid');
    } catch (error) {
      return empty((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded', 'archive-storage-unavailable');
    }
    const records = readImmutablePrivateRecords(config(options.root, options.archiveId), { requireComplete: true });
    if (records.sourceState !== 'healthy' || !records.complete) return empty(records.sourceState, 'archive-records-unavailable');
    const registrations = records.records.filter((row): row is HarnessArchiveRegistration => row.kind === 'registration');
    const candidates = records.records.filter((row): row is HarnessArchivedCandidate => row.kind === 'candidate');
    const registration = registrations[0];
    if (registrations.length !== 1 || !registration || registration.archiveId !== options.archiveId ||
      candidates.some((row) => !candidateMatches(row, registration) || row.supersededBy !== null && !candidates.some((other) => other.candidateId === row.supersededBy))) {
      return empty('degraded', 'archive-linkage-invalid');
    }
    return { sourceState: 'healthy', registration, candidates: candidates.sort((a, b) => a.candidateId.localeCompare(b.candidateId)), reasons: [] };
  } catch { return empty('degraded', 'archive-unavailable'); }
}
/** Serialize admission and publication across all cooperative archive writers. */
function transaction<T>(root: string, archiveId: string, action: (owned: () => boolean) => T): T {
  inspectPrivateDirectory(root);
  const acquired = acquireLocalStoreLockWithOutcome(join(root, `.harness-${archiveId}.lock`), 0, { anchorPath: root, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') throw new Error('Harness archive ownership unavailable');
  const owned = (): boolean => ownsLocalStoreLock(acquired.lock);
  try { return action(owned); } finally { releaseLocalStoreLock(acquired.lock); }
}
function publish(root: string, archiveId: string, record: ArchiveRecord, owned: () => boolean): 'recorded' | 'replayed' {
  if (!owned()) throw new Error('Harness archive ownership lost');
  const current = readHarnessArchive({ root, archiveId });
  if (current.sourceState === 'degraded') throw new Error('Harness archive unavailable');
  const records: ArchiveRecord[] = current.registration ? [current.registration, ...current.candidates] : [];
  const prior = records.find((item) => item.id === record.id);
  if (prior) {
    if (canonical(prior) !== canonical(record)) throw new Error('Harness archive write conflicted');
    if (!owned()) throw new Error('Harness archive ownership lost');
    return 'replayed';
  }
  // The immutable store enforces individual record bounds, not aggregate write
  // admission. Count canonical on-disk bytes (including each trailing newline)
  // before publication while this archive's owner lock excludes other API writers.
  const limits = config(root, archiveId);
  const bytes = Buffer.byteLength(codec.serialize(record), 'utf8');
  const used = records.reduce((sum, item) => sum + Buffer.byteLength(codec.serialize(item), 'utf8'), 0);
  if (records.length >= limits.hardMaxFiles || bytes > limits.maxRecordBytes || used + bytes > limits.hardMaxBytes) {
    throw new Error('Harness archive capacity reached');
  }
  const disposition = writeImmutablePrivateRecord(limits, record, { lockWaitMs: 0, prepublish: owned });
  if (disposition !== 'recorded' && disposition !== 'replayed') throw new Error(`Harness archive write ${disposition}`);
  if (!owned()) throw new Error('Harness archive ownership lost');
  if (readHarnessArchive({ root, archiveId }).sourceState !== 'healthy') throw new Error('Harness archive unavailable after publication');
  return disposition;
}

/** Freeze baseline, evaluator bytes and the exact mutable-file set once, without executing or editing them. */
export function registerHarnessArchive(options: RegisterHarnessArchiveOptions): { disposition: 'recorded' | 'replayed'; registration: HarnessArchiveRegistration } {
  if (!exact(options, ['root', 'archiveId', 'mutableFiles', 'baselinePath', 'baselineDigest', 'evaluatorPath', 'evaluatorDigest']) ||
    !absolute(options.root) || !id(options.archiveId) || !allowlist(options.mutableFiles)) throw new Error('Invalid harness archive registration');
  return transaction(options.root, options.archiveId, (owned) => {
    const baseline = capture(options.baselinePath, options.baselineDigest, options.root);
    const evaluator = capture(options.evaluatorPath, options.evaluatorDigest, options.root);
    const payload = { id: 'registration' as const, kind: 'registration' as const, schemaVersion: 1 as const, archiveId: options.archiveId,
      mutableFiles: [...options.mutableFiles].sort(), baseline, evaluator };
    const registration = { ...payload, registrationDigest: digest(canonical(payload)) };
    if (!parseRecord(registration)) throw new Error('Invalid or oversized frozen harness archive');
    const existing = readHarnessArchive({ root: options.root, archiveId: options.archiveId });
    if (existing.sourceState === 'degraded') throw new Error('Harness archive unavailable');
    return { disposition: publish(options.root, options.archiveId, registration, owned), registration };
  });
}

/** Archive an unchanged-evaluator hypothesis and supplied outcome. No apply, promotion, evaluation or provider calls. */
export function storeHarnessCandidate(options: StoreHarnessCandidateOptions): { disposition: 'recorded' | 'replayed'; candidate: HarnessArchivedCandidate } {
  if (!exact(options, ['root', 'archiveId', 'candidateId', 'candidatePath', 'contentDigest', 'hypothesis', 'reason', 'outcome', 'evidence', 'supersededBy']) ||
    !absolute(options.root) || !id(options.archiveId) || !id(options.candidateId) || !text(options.hypothesis) || !text(options.reason) ||
    typeof options.outcome !== 'string' || !['effective', 'refuted', 'inconclusive', 'superseded'].includes(options.outcome) ||
    options.supersededBy !== null && !id(options.supersededBy)) throw new Error('Invalid harness candidate');
  return transaction(options.root, options.archiveId, (owned) => {
    const existing = readHarnessArchive({ root: options.root, archiveId: options.archiveId });
    const registration = existing.registration;
    if (existing.sourceState !== 'healthy' || !registration) throw new Error('Harness archive unavailable');
    const content = capture(options.candidatePath, options.contentDigest, options.root);
    const payload = { id: `candidate.${options.candidateId}`, kind: 'candidate' as const, schemaVersion: 1 as const,
      archiveId: options.archiveId, candidateId: options.candidateId, registrationDigest: registration.registrationDigest,
      content, changedFiles: changes(registration.baseline, content), hypothesis: options.hypothesis, reason: options.reason,
      outcome: options.outcome, evidence: options.evidence, supersededBy: options.supersededBy,
      evidenceScope: 'supplied-verifier-linkage' as const, independentlyVerified: false as const };
    // Validate nested caller evidence before canonical serialization could invoke accessors.
    if (options.evidence !== null && !linkage(options.evidence)) throw new Error('Invalid verifier linkage');
    const candidate = { ...payload, candidateDigest: digest(canonical(payload)) };
    if (!parseRecord(candidate) || !candidateMatches(candidate, registration) ||
      candidate.supersededBy !== null && !existing.candidates.some((row) => row.candidateId === candidate.supersededBy)) {
      throw new Error('Harness candidate violates frozen scope or verifier linkage');
    }
    if (existing.candidates.length >= MAX_RECORDS - 1 && !existing.candidates.some((row) => row.candidateId === candidate.candidateId)) throw new Error('Harness archive capacity reached');
    return { disposition: publish(options.root, options.archiveId, candidate, owned), candidate };
  });
}

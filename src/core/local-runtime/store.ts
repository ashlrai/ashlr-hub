import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeSync, type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import {
  buildUnsignedRuntimeReleaseManifest, parseUnsignedRuntimeReleaseManifest,
  verifyUnsignedRuntimeReleaseManifest,
} from '../daemon/runtime-release-manifest.js';
import { requireBeforeRuntimeReleaseObservationDeadline, type RuntimeReleaseObservationDeadline } from '../daemon/runtime-release-observation-deadline.js';
import { extractPinnedRuntimeArchive, readPinnedRuntimeArchive } from './archive.js';
import type { InstallLocalRuntimeOptions, LocalRuntimeInstallation, LocalRuntimeStatus } from './types.js';
export type { InstallLocalRuntimeOptions, LocalRuntimeInstallation, LocalRuntimeResolution, LocalRuntimeStatus } from './types.js';

const SHA = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const MAX_STATE_BYTES = 4 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const READ_MS = 30_000;
const INSTALL_MS = 120_000;
const SMOKE_MS = 10_000;
const RECEIPT_KEYS = ['schemaVersion', 'id', 'sha256', 'integrity', 'size', 'revision', 'version',
  'installedAt', 'manifestDigest', 'nodePath', 'nodeVersion', 'nodeSha256'];

type Receipt = Omit<LocalRuntimeInstallation, 'packageRoot' | 'binPath'> & { schemaVersion: 1 };
interface Selection { schemaVersion: 1; current: string; previous: string | null }
interface Snapshot { selection: Selection; bytes: Buffer }

function fail(reason: string): never { throw new Error(`Local runtime ${reason}`); }
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0');
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function observation(duration: number): RuntimeReleaseObservationDeadline {
  return { deadline: performance.now() + duration, now: () => performance.now() };
}
function check(deadline: RuntimeReleaseObservationDeadline): void {
  requireBeforeRuntimeReleaseObservationDeadline(deadline, 'local runtime');
}
function storePath(value: string): string {
  if (!boundedText(value, 4096) || !isAbsolute(value) || resolve(value) === parse(value).root) fail('store must be an explicit absolute non-root path');
  return resolve(value);
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
function safeFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) && (stat.mode & 0o022n) === 0n;
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function readBounded(path: string, limit: number): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (!safeFile(before) || before.size < 1n || before.size > BigInt(limit)) fail('record is unsafe or exceeds its byte limit');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(before, fstatSync(fd, { bigint: true }))) fail('record changed while opening');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail('record changed while reading');
      offset += count;
    }
    if (!same(before, fstatSync(fd, { bigint: true })) || !same(before, lstatSync(path, { bigint: true }))) fail('record changed while reading');
    return bytes;
  } finally { closeSync(fd); }
}
function json(bytes: Buffer): unknown {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('record is not UTF-8');
  try { return JSON.parse(text); } catch { return fail('record is not valid JSON'); }
}
function inspectDirectory(path: string, anchorPath: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path ||
    (stat.mode & 0o777) !== 0o700 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('directory is not private and physical');
  if (!assurePrivateStoragePath(path, 'directory', 'inspect-existing', { anchorPath }).ok) fail('directory custody is unavailable');
}
function createDirectory(path: string, anchorPath: string): void {
  if (!exists(path)) { mkdirSync(path, { mode: 0o700 }); fsyncDirectory(dirname(path)); }
  inspectDirectory(path, anchorPath);
}
function inspectStore(store: string): void {
  inspectDirectory(store, dirname(store));
  inspectDirectory(join(store, 'releases'), store);
  inspectDirectory(join(store, 'staging'), store);
}
function initializeStore(store: string): void {
  // Caller must supply an existing parent; never create an implicit home tree.
  if (realpathSync(dirname(store)) !== dirname(store)) fail('store parent must be physical');
  createDirectory(store, dirname(store));
  createDirectory(join(store, 'releases'), store);
  createDirectory(join(store, 'staging'), store);
}
function readSelection(store: string): Snapshot | null {
  const path = join(store, 'current.json');
  if (!exists(path)) return null;
  const bytes = readBounded(path, MAX_STATE_BYTES);
  const value = json(bytes);
  if (!plain(value) || !exact(value, ['schemaVersion', 'current', 'previous']) || value.schemaVersion !== 1 ||
    typeof value.current !== 'string' || !SHA.test(value.current) ||
    !(value.previous === null || (typeof value.previous === 'string' && SHA.test(value.previous))) || value.previous === value.current) fail('selection record is invalid');
  return { selection: value as unknown as Selection, bytes };
}
function receiptId(receipt: Pick<Receipt, 'sha256' | 'manifestDigest'>): string {
  return hash(JSON.stringify({ sha256: receipt.sha256, manifestDigest: receipt.manifestDigest }));
}
function readReceipt(store: string, id: string): Receipt {
  const directory = join(store, 'releases', id);
  inspectDirectory(directory, store);
  const value = json(readBounded(join(directory, 'receipt.json'), MAX_RECEIPT_BYTES));
  if (!plain(value) || !exact(value, RECEIPT_KEYS) || value.schemaVersion !== 1 || value.id !== id ||
    !['id', 'sha256', 'manifestDigest', 'nodeSha256'].every((key) => typeof value[key] === 'string' && SHA.test(value[key])) ||
    typeof value.revision !== 'string' || !REVISION.test(value.revision) || !boundedText(value.version, 128) ||
    !boundedText(value.nodePath, 4096) || !isAbsolute(value.nodePath) || !boundedText(value.nodeVersion, 128) ||
    !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.nodeVersion) ||
    typeof value.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity) ||
    !Number.isSafeInteger(value.size) || (value.size as number) < 1 || (value.size as number) > 64 * 1024 * 1024 ||
    typeof value.installedAt !== 'string' || !Number.isFinite(Date.parse(value.installedAt)) ||
    new Date(value.installedAt).toISOString() !== value.installedAt) fail('installation receipt is invalid');
  const receipt = value as unknown as Receipt;
  if (receiptId(receipt) !== id) fail('installation receipt identity does not match');
  return receipt;
}
function verifyBuildIdentity(packageRoot: string, revision: string, version: string): void {
  const value = json(readBounded(join(packageRoot, 'dist', 'build-identity.json'), 4096));
  if (!plain(value) || !exact(value, ['schemaVersion', 'packageVersion', 'revision', 'dirty', 'provenance']) ||
    value.schemaVersion !== 1 || value.packageVersion !== version || value.revision !== revision ||
    value.dirty !== false || value.provenance !== 'git') fail('package build identity is not the pinned clean source');
}
function manifestOptions(packageRoot: string, receipt: Pick<Receipt, 'nodePath' | 'nodeVersion' | 'revision'>,
  rollback: string | null = null) {
  return { packageRoot, dependencyRoot: join(packageRoot, 'node_modules'), declaredInterpreterPath: receipt.nodePath,
    declaredInterpreterVersion: receipt.nodeVersion, expectedRevision: receipt.revision, expectedPackageName: '@ashlr/hub',
    declaredRollbackTargetDigest: rollback };
}
function inspectInstallation(store: string, id: string, deadline: RuntimeReleaseObservationDeadline): LocalRuntimeInstallation {
  check(deadline);
  const receipt = readReceipt(store, id);
  const packageRoot = join(store, 'releases', id, 'package');
  inspectDirectory(packageRoot, store);
  const bytes = readBounded(join(store, 'releases', id, 'manifest.json'), MAX_MANIFEST_BYTES);
  const parsed = parseUnsignedRuntimeReleaseManifest(bytes);
  if (!parsed.ok) fail('stored runtime manifest is invalid');
  const manifest = parsed.manifest;
  if (manifest.manifestDigest !== receipt.manifestDigest || manifest.package.version !== receipt.version ||
    manifest.expectedRevision !== receipt.revision || manifest.interpreterDeclaration.observedResolvedPath !== receipt.nodePath ||
    manifest.interpreterDeclaration.observedArtifactSha256 !== receipt.nodeSha256 ||
    manifest.interpreterDeclaration.claimedVersion !== receipt.nodeVersion) fail('receipt and runtime manifest disagree');
  verifyBuildIdentity(packageRoot, receipt.revision, receipt.version);
  const verified = verifyUnsignedRuntimeReleaseManifest({
    ...manifestOptions(packageRoot, receipt, manifest.rollbackDeclaration.targetManifestDigest), manifest: bytes,
    expectedManifestDigest: receipt.manifestDigest,
  }, deadline);
  if (!verified.ok) fail('installed runtime bytes or interpreter no longer verify');
  check(deadline);
  return { id: receipt.id, sha256: receipt.sha256, integrity: receipt.integrity, size: receipt.size,
    revision: receipt.revision, version: receipt.version, installedAt: receipt.installedAt,
    manifestDigest: receipt.manifestDigest, nodePath: receipt.nodePath, nodeVersion: receipt.nodeVersion,
    nodeSha256: receipt.nodeSha256, packageRoot, binPath: join(packageRoot, 'bin', 'ashlr') };
}
function status(store: string, deadline: RuntimeReleaseObservationDeadline): LocalRuntimeStatus {
  const result: LocalRuntimeStatus = { schemaVersion: 1, authority: 'local-candidate', store,
    sourceState: 'missing', current: null, previous: null, reasons: [] };
  if (!exists(store)) return result;
  try {
    inspectStore(store);
    if (exists(join(store, 'selection-pending.json'))) fail('selection recovery is required');
    const before = readSelection(store);
    if (!before) return result;
    try { result.current = inspectInstallation(store, before.selection.current, deadline); }
    catch { result.reasons.push('Selected local runtime installation did not verify'); }
    if (before.selection.previous) {
      try { result.previous = inspectInstallation(store, before.selection.previous, deadline); }
      catch { result.reasons.push('Previous local runtime installation did not verify'); }
    }
    const after = readSelection(store);
    if (!after || !after.bytes.equals(before.bytes)) fail('selection changed while sampling');
    result.sourceState = result.reasons.length ? 'degraded' : 'healthy';
  } catch {
    result.sourceState = 'degraded';
    result.current = null;
    result.previous = null;
    result.reasons = ['Local runtime installation or selection evidence did not verify'];
  }
  return result;
}

/** Read-only; absent stores and read failures never initialize or repair state. */
export function readLocalRuntimeStatus(store: string): LocalRuntimeStatus {
  return status(storePath(store), observation(READ_MS));
}
/** Resolve once; a later pointer switch does not change this process's package. */
export function resolveLocalRuntime(store: string): LocalRuntimeInstallation {
  const result = readLocalRuntimeStatus(store);
  if (!result.current) fail('selected installation is unavailable');
  return { ...result.current };
}
function writeNew(path: string, bytes: Buffer | string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    let offset = 0;
    while (offset < value.length) {
      const count = writeSync(fd, value, offset, value.length - offset, offset);
      if (count < 1) fail('private record write made no progress');
      offset += count;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncDirectory(dirname(path));
}
function writeSelection(store: string, before: Snapshot | null, next: Selection): void {
  // A pending marker makes a failed restoration visible instead of publishing
  // ambiguous success. Only this operation owns its exclusive marker.
  const pending = join(store, 'selection-pending.json');
  const pendingBytes = `${JSON.stringify({ schemaVersion: 1, before: before?.selection ?? null, next })}\n`;
  writeNew(pending, pendingBytes);
  const current = join(store, 'current.json');
  const publish = (bytes: Buffer | string): void => writePrivateFileAtomically(
    join(store, `.current-${randomUUID()}.tmp`), current, bytes, { anchorPath: store, label: 'local runtime selection' });
  let attempted = false;
  try {
    const recheck = readSelection(store);
    if (before ? !recheck || !recheck.bytes.equals(before.bytes) : recheck !== null) fail('selection changed before publication');
    attempted = true;
    publish(`${JSON.stringify(next)}\n`);
    unlinkSync(pending);
    fsyncDirectory(store);
  } catch (error) {
    try {
      if (attempted && before) publish(before.bytes);
      else if (attempted && exists(current)) {
        const observed = readSelection(store);
        if (!observed || JSON.stringify(observed.selection) !== JSON.stringify(next)) fail('new selection could not be restored');
        unlinkSync(current);
        fsyncDirectory(store);
      }
      if (exists(pending)) unlinkSync(pending);
      fsyncDirectory(store);
    } catch {
      // Finalization may have removed the marker before a later fsync failed.
      // Restore an explicit degraded state if restoring the old pointer fails.
      try { if (!exists(pending)) writeNew(pending, pendingBytes); } catch { /* the original failure remains authoritative */ }
      fail('selection restoration failed; retained packages require inspection');
    }
    throw error;
  }
}
function withStoreLock<T>(store: string, operation: (assertOwned: () => void) => T): T {
  const acquired = acquireLocalStoreLockWithOutcome(join(store, '.install.lock'), 0, { anchorPath: store, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') fail('store already has an owner or ownership is unavailable');
  const assertOwned = (): void => {
    if (!ownsLocalStoreLock(acquired.lock)) fail('store ownership was lost');
    inspectStore(store);
  };
  try { assertOwned(); return operation(assertOwned); } finally { releaseLocalStoreLock(acquired.lock); }
}
function smoke(packageRoot: string, scratch: string, nodePath: string, deadline: RuntimeReleaseObservationDeadline): void {
  const env = { PATH: '/usr/bin:/bin', TMPDIR: scratch, LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' };
  const run = (args: string[]): string => {
    check(deadline);
    const timeout = Math.max(1, Math.min(SMOKE_MS, Math.floor(deadline.deadline - deadline.now())));
    const result = spawnSync(nodePath, args, { cwd: packageRoot, env, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, shell: false });
    check(deadline);
    if (result.error || result.status !== 0 || result.signal || result.stderr) fail('installed entry point smoke failed');
    return result.stdout;
  };
  if (!run([join(packageRoot, 'bin', 'ashlr'), 'universe', 'help']).trim()) fail('installed help smoke returned no output');
  const script = "const sdk = await import('@ashlr/hub/universe'); for (const key of " +
    "['runUniverse','readUniverseOverview','runUniverseCampaign','runUniversePortfolio','buildUniverseFileOperationsContext']) " +
    "{ if (typeof sdk[key] !== 'function') throw new Error('missing SDK function'); } process.stdout.write('local-runtime-sdk-ok');";
  if (run(['--input-type=module', '-e', script]) !== 'local-runtime-sdk-ok') fail('installed SDK smoke returned invalid evidence');
}

/** Install only the caller-pinned local artifact; no registry, npm, or service effects. */
export async function installLocalRuntime(options: InstallLocalRuntimeOptions): Promise<LocalRuntimeStatus> {
  const store = storePath(options.store);
  const deadline = observation(INSTALL_MS);
  // The archive is fully validated before even creating an installation store.
  const archive = await readPinnedRuntimeArchive({ artifactPath: options.artifactPath, sha256: options.sha256,
    revision: options.revision, version: options.version });
  check(deadline);
  initializeStore(store);
  return withStoreLock(store, (assertOwned) => {
    const prior = status(store, deadline);
    if (prior.sourceState === 'degraded') fail('existing selection is degraded');
    if (prior.current?.sha256 === archive.pins.sha256) return prior;
    const before = readSelection(store);
    const stage = join(store, 'staging', randomUUID());
    createDirectory(stage, store);
    const packageRoot = join(stage, 'package');
    createDirectory(packageRoot, store);
    extractPinnedRuntimeArchive(archive, packageRoot);
    // Empty dependency inventories still need a real dependency root to scan.
    if (!exists(join(packageRoot, 'node_modules'))) createDirectory(join(packageRoot, 'node_modules'), store);
    verifyBuildIdentity(packageRoot, archive.pins.revision, archive.pins.version);
    const runtime = { nodePath: realpathSync(process.execPath), nodeVersion: process.version, revision: archive.pins.revision };
    const built = buildUnsignedRuntimeReleaseManifest(manifestOptions(packageRoot, runtime,
      prior.current?.manifestDigest ?? null), deadline);
    if (!built.ok || built.manifest.package.version !== archive.pins.version) fail('staged runtime manifest did not verify');
    const scratch = join(stage, 'smoke');
    createDirectory(scratch, store);
    smoke(packageRoot, scratch, runtime.nodePath, deadline);
    const verified = verifyUnsignedRuntimeReleaseManifest({ ...manifestOptions(packageRoot, runtime,
      prior.current?.manifestDigest ?? null), manifest: built.canonicalJson,
      expectedManifestDigest: built.manifest.manifestDigest }, deadline);
    if (!verified.ok) fail('staged runtime changed during smoke');
    verifyBuildIdentity(packageRoot, archive.pins.revision, archive.pins.version);
    const receipt: Receipt = {
      schemaVersion: 1, id: '', ...archive.pins, installedAt: new Date().toISOString(),
      manifestDigest: built.manifest.manifestDigest, nodePath: runtime.nodePath, nodeVersion: runtime.nodeVersion,
      nodeSha256: built.manifest.interpreterDeclaration.observedArtifactSha256,
    };
    receipt.id = receiptId(receipt);
    writeNew(join(stage, 'manifest.json'), built.canonicalJson);
    writeNew(join(stage, 'receipt.json'), `${JSON.stringify(receipt)}\n`);
    const destination = join(store, 'releases', receipt.id);
    assertOwned();
    if (exists(destination)) {
      const retained = inspectInstallation(store, receipt.id, deadline);
      if (retained.sha256 !== receipt.sha256) fail('retained installation identity conflicts');
    } else {
      renameSync(stage, destination);
      fsyncDirectory(join(store, 'staging'));
      fsyncDirectory(join(store, 'releases'));
    }
    const current = inspectInstallation(store, receipt.id, deadline);
    const previous = prior.current ? inspectInstallation(store, prior.current.id, deadline) : null;
    check(deadline);
    assertOwned();
    writeSelection(store, before, { schemaVersion: 1, current: receipt.id, previous: prior.current?.id ?? null });
    return { schemaVersion: 1, authority: 'local-candidate', store, sourceState: 'healthy',
      current, previous, reasons: [] };
  });
}

/** Rollback is an explicit verified pointer change, never a service restart. */
export function rollbackLocalRuntime(input: string): LocalRuntimeStatus {
  const store = storePath(input);
  if (!exists(store)) fail('store is missing');
  inspectStore(store);
  return withStoreLock(store, (assertOwned) => {
    const deadline = observation(READ_MS);
    const prior = status(store, deadline);
    if (!prior.previous) fail('verified previous installation is unavailable');
    const before = readSelection(store);
    if (!before) fail('selection disappeared');
    check(deadline);
    assertOwned();
    writeSelection(store, before, { schemaVersion: 1, current: prior.previous.id, previous: prior.current?.id ?? null });
    return { ...prior, sourceState: 'healthy', current: prior.previous, previous: prior.current, reasons: [] };
  });
}

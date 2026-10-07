/** Installed, signed paired-update consumer. Metadata never substitutes for fresh host admission. */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { Header } from 'tar';
import { evaluateStandingAuthority } from '../authority/effective-config.js';
import { runningPackageRoot, verifyAuthoritySurfaceAt } from '../authority/surface.js';
import { censusExecutionLeases } from '../sandbox/execution-leases.js';
import { readPinnedRuntimeArchive, extractPinnedRuntimeArchive } from '../local-runtime/archive.js';
import { parseBuildIdentity } from '../build-identity.js';
import { fsyncDirectory } from '../util/durability.js';
import { verifyUpdateManifest, verifyMinisign, verifyUpdateBundleRecord, type UpdateTrust, type UpdateManifest, type UpdateArtifact } from './update-manifest.js';

export type DesktopUpdateState = 'waiting-native-exit' | 'ready' | 'blocked' | 'applied' | 'rollback-held' | 'rolled-back';
export interface DesktopUpdateResult {
  schema: 'phantom-desktop-update-result/v1'; state: DesktopUpdateState;
  version: string | null; reason: string | null; requiresReapproval: boolean;
}
export interface UpdateAdmission {
  grantId: string | null; envelopeDigest: string | null; surfaceDigest: string | null;
  active: boolean; stop: boolean; leaseCount: number; unknownLeases: number;
}
export interface NativeUpdateParent { pid: number; ppid: number; started: string; executable: string }
export interface DesktopUpdateDependencies {
  home: string; platform: NodeJS.Platform; architecture: string; packageRoot: string | null; trust: UpdateTrust | null;
  admission(): UpdateAdmission;
  currentPackageRoot(): string | null;
  captureParent(): NativeUpdateParent | null;
  verifyParent(parent: NativeUpdateParent, manifest: UpdateManifest): Promise<boolean>;
  parentState(parent: NativeUpdateParent): 'same' | 'gone' | 'changed' | 'unknown';
  now(): number; sleep(ms: number): Promise<void>;
  download(url: string, maximum: number): Promise<Buffer>;
  /** Internal test seam; the CLI never accepts an alternate implementation. */
  transaction?(): Promise<TransactionModule>;
}
const ID = /^[a-f0-9]{32}$/;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
class Held extends Error { constructor(readonly reason: string) { super(reason); } }
function hold(reason: string): never { throw new Held(reason); }
const result = (state: DesktopUpdateState, version: string | null, reason: string | null, requiresReapproval = false): DesktopUpdateResult =>
  ({schema: 'phantom-desktop-update-result/v1', state, version, reason, requiresReapproval});

/** Opaque IDs only; caller paths and HOME environment variables are never admitted. */
export function desktopUpdateStagePath(home: string, stageId: string): string {
  if (!ID.test(stageId) || resolve(home) !== home) hold('invalid-stage');
  return join(home, '.ashlr', 'updates', 'staged', stageId);
}
function directory(path: string, privateMode = true): fs.Stats {
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 || privateMode && (stat.mode & 0o077) !== 0) hold('unsafe-stage');
  return stat;
}
function safeAncestors(home: string, path: string): void {
  if (!path.startsWith(home + '/')) hold('unsafe-stage');
  directory(home, false);
  let at = home;
  for (const part of path.slice(home.length + 1).split('/')) { at = join(at, part); directory(at); }
}
function same(a: fs.Stats, b: fs.Stats): boolean {
  return ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key as keyof fs.Stats] === b[key as keyof fs.Stats]);
}
function readOwnedBytes(path: string, maximum: number, allowEmpty: boolean, privateMode: boolean): Buffer {
  const named = fs.lstatSync(path);
  if (!named.isFile() || named.nlink !== 1 || named.uid !== process.getuid?.() ||
      named.size < (allowEmpty ? 0 : 1) || named.size > maximum || (named.mode & (privateMode ? 0o077 : 0o022)) !== 0) hold(privateMode ? 'unsafe-stage' : 'installed-current-unverified');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(named, fs.fstatSync(fd))) hold(privateMode ? 'stage-changed' : 'installed-current-unverified');
    const data = fs.readFileSync(fd);
    if (data.length !== named.size || !same(named, fs.fstatSync(fd)) || !same(named, fs.lstatSync(path))) hold(privateMode ? 'stage-changed' : 'installed-current-unverified');
    return data;
  } finally { fs.closeSync(fd); }
}
// Stage bytes remain private0600. Existing installed npm files can be0644 or
// executable0755, while ownership, no-follow, nonwritable and stability checks stay strict.
const bytes = (path: string, maximum: number, allowEmpty = false) => readOwnedBytes(path, maximum, allowEmpty, true);
const installedBytes = (path: string, maximum: number, allowEmpty = false) => readOwnedBytes(path, maximum, allowEmpty, false);
function validateArtifact(data: Buffer, artifact: UpdateArtifact, trust: UpdateTrust): void {
  if (data.length !== artifact.bytes || sha(data) !== artifact.sha256) hold('artifact-mismatch');
  verifyMinisign(data, artifact.signature, trust.publicKey);
}
function readStage(stageId: string, deps: DesktopUpdateDependencies): {stage: string; manifest: UpdateManifest; digest: string; app: Buffer; entries: readonly AppEntry[]; identity: fs.Stats} {
  if (!deps.trust) hold('trust-not-commissioned');
  if (deps.platform !== 'darwin' || deps.architecture !== 'arm64' || !deps.packageRoot) hold('unsupported-installed-runtime');
  const stage = desktopUpdateStagePath(deps.home, stageId);
  safeAncestors(deps.home, stage); const identity = directory(stage);
  const encoded = bytes(join(stage, 'manifest.json'), 64 * 1024);
  const text = encoded.toString('utf8'); if (!Buffer.from(text).equals(encoded)) hold('verification-failed');
  const signature = bytes(join(stage, 'manifest.sig'), 8192).toString('utf8');
  const verified = verifyUpdateManifest({manifestText: text, signature}, deps.trust);
  const app = bytes(join(stage, 'app.tar.gz'), verified.manifest.app.bytes);
  validateArtifact(app, verified.manifest.app, deps.trust);
  const entries = inspectSignedAppArchive(app);
  const record = entries.find(entry => entry.path === 'Phantom.app/Contents/Resources/phantom-release.json' && !entry.directory);
  if (!record || record.data.length > 8192) hold('app-source-unverified');
  try {verifyUpdateBundleRecord(record.data.toString('utf8'), verified.manifest);} catch {hold('app-source-unverified');}
  safeAncestors(deps.home, stage);
  if (!same(identity, directory(stage))) hold('stage-changed');
  return {stage, manifest: verified.manifest, digest: verified.digest, app, entries, identity};
}
/** The installed consumer rejects stale stages independently of native discovery. */
function requireNewerVersion(deps: DesktopUpdateDependencies, candidate: string): void {
  const root = deps.packageRoot;
  if (!root || deps.currentPackageRoot() !== root) hold('running-current-mismatch');
  const identity = parseBuildIdentity(installedBytes(join(root, 'dist', 'build-identity.json'), 64 * 1024).toString('utf8'));
  if (!identity || identity.dirty || identity.provenance !== 'git' || !identity.packageVersion || !/^\d+\.\d+\.\d+$/.test(identity.packageVersion)) hold('current-version-unverified');
  const old = identity.packageVersion.split('.').map(BigInt), next = candidate.split('.').map(BigInt);
  const first = next.findIndex((part, i) => part !== old[i]);
  if (first < 0 || next[first]! < old[first]!) hold('candidate-not-newer');
}
function admissionReason(a: UpdateAdmission, surface: string): string | null {
  if (!a.active || !a.grantId || !a.envelopeDigest || !a.surfaceDigest) return 'grant-unavailable';
  if (a.surfaceDigest !== surface) return 'authority-reapproval-required';
  if (!a.stop) return 'stop-required';
  if (a.unknownLeases !== 0 || a.leaseCount !== 0) return 'work-active-or-unknown';
  return null;
}
function freshAdmission(deps: DesktopUpdateDependencies, expected: UpdateAdmission, surface: string): void {
  const now = deps.admission(); const reason = admissionReason(now, surface);
  if (reason) hold(reason);
  if (now.grantId !== expected.grantId || now.envelopeDigest !== expected.envelopeDigest || now.surfaceDigest !== expected.surfaceDigest) hold('authority-changed');
}

export function inspectQualifiedDesktopUpdate(stageId: string, deps: DesktopUpdateDependencies): DesktopUpdateResult {
  let version: string | null = null;
  try {
    const staged = readStage(stageId, deps); version = staged.manifest.version;
    try {bytes(join(staged.stage, 'consumer-attempt.json'), 8192); return result('blocked', version, 'update-attempt-already-recorded');}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    requireNewerVersion(deps, version);
    const reason = admissionReason(deps.admission(), staged.manifest.authoritySurfaceDigest);
    return result(reason ? 'blocked' : 'ready', version, reason, reason === 'authority-reapproval-required' || reason === 'grant-unavailable');
  } catch (error) { return result('blocked', version, error instanceof Held ? error.reason : 'verification-failed'); }
}

/** Wait only for the exact normally closing native parent; reuse/unknown is a hold, never a kill. */
export async function waitForNativeUpdateParent(parent: NativeUpdateParent, deps: DesktopUpdateDependencies): Promise<void> {
  const deadline = deps.now() + 30_000;
  while (true) {
    const state = deps.parentState(parent);
    if (state === 'gone') return;
    if (state !== 'same') hold('native-parent-changed-or-unknown');
    if (deps.now() >= deadline) hold('native-parent-still-running');
    await deps.sleep(250);
  }
}

interface AppEntry { path: string; mode: number; directory: boolean; data: Buffer }
/** Strict USTAR and file/directory-only interpretation. No PAX, links, devices or system tar. */
export function inspectSignedAppArchive(compressed: Buffer): readonly AppEntry[] {
  const expanded = gunzipSync(compressed, {maxOutputLength: 512 * 1024 * 1024});
  if (expanded.length % 512) hold('unsafe-app-archive');
  const entries: AppEntry[] = []; const names = new Map<string, boolean>(); const spellings = new Map<string, string>(); let at = 0;
  while (at + 512 <= expanded.length) {
    const block = expanded.subarray(at, at + 512); at += 512;
    if (block.every(n => n === 0)) {
      if (expanded.length - at < 512 || !expanded.subarray(at).every(n => n === 0) || !entries.length) hold('unsafe-app-archive');
      for (const required of ['Phantom.app/Contents/Info.plist', 'Phantom.app/Contents/MacOS/ashlr-desktop', 'Phantom.app/Contents/MacOS/ashlr']) if (!names.has(required.toLowerCase()) || names.get(required.toLowerCase())) hold('incomplete-app-archive');
      return entries;
    }
    const h = new Header(block); const name = h.path?.replace(/\/$/, '');
    const isDirectory = h.type === 'Directory';
    if (!h.cksumValid || block.subarray(257, 265).toString('ascii') !== 'ustar\u000000' || h.linkpath ||
        !['File', 'Directory'].includes(h.type ?? '') || !name || name.length > 1024 ||
        !/^Phantom\.app(?:\/[A-Za-z0-9_@+ .-]+)*$/.test(name) || name.split('/').some(p => ['.', '..'].includes(p) || /[. ]$/.test(p)) ||
        !Number.isSafeInteger(h.mode) || (h.mode! & ~0o777) !== 0 || (h.mode! & 0o022) !== 0 ||
        !Number.isSafeInteger(h.size) || h.size! < 0 || h.size! > 256 * 1024 * 1024 || isDirectory && h.size !== 0) hold('unsafe-app-archive');
    const segments = name.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/'), folded = prefix.toLowerCase();
      if (spellings.has(folded) && spellings.get(folded) !== prefix) hold('unsafe-app-archive');
      spellings.set(folded, prefix);
    }
    const key = name.toLowerCase();
    if (names.has(key)) hold('unsafe-app-archive');
    for (const [prior, directory] of names) if (key.startsWith(prior + '/') && !directory || prior.startsWith(key + '/') && !isDirectory) hold('unsafe-app-archive');
    names.set(key, isDirectory);
    const end = at + Math.ceil(h.size! / 512) * 512;
    if (end > expanded.length || !expanded.subarray(at + h.size!, end).every(n => n === 0)) hold('unsafe-app-archive');
    entries.push({path: name, mode: h.mode!, directory: isDirectory, data: expanded.subarray(at, at + h.size!)}); at = end;
    if (entries.length > 20_000) hold('unsafe-app-archive');
  }
  hold('unsafe-app-archive');
}
function writeExclusive(path: string, data: Buffer, mode = 0o600): void {
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, data); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
}
function extractApp(entries: readonly AppEntry[], dest: string): string {
  const dirs = new Set([dest]);
  for (const entry of entries) {
    const file = join(dest, entry.path); const parts = entry.path.split('/'); let parent = dest;
    for (const part of parts.slice(0, entry.directory ? undefined : -1)) {
      parent = join(parent, part);
      if (!dirs.has(parent)) { fs.mkdirSync(parent, {mode: 0o700}); dirs.add(parent); }
      directory(parent);
    }
    if (!entry.directory) writeExclusive(file, entry.data, entry.mode);
  }
  // Restore signed inventory modes only after the private tree is complete.
  for (const entry of [...entries].reverse()) if (entry.directory) fs.chmodSync(join(dest, entry.path), entry.mode);
  for (const path of [...dirs].reverse()) fsyncDirectory(path);
  return join(dest, 'Phantom.app');
}

export async function downloadQualifiedUpdateArtifact(url: string, maximum: number): Promise<Buffer> {
  let next = new URL(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (next.protocol !== 'https:' || next.username || next.password || !['github.com', 'release-assets.githubusercontent.com'].includes(next.hostname)) hold('download-origin-refused');
    const response = await fetch(next, {redirect: 'manual', signal: AbortSignal.timeout(120_000), credentials: 'omit'});
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) hold('download-failed'); next = new URL(location, next); continue;
    }
    if (!response.ok || !response.body) hold('download-failed');
    const declared = Number(response.headers.get('content-length'));
    if (declared > maximum) {await response.body.cancel(); hold('artifact-size-refused');}
    const chunks: Buffer[] = []; let size = 0; const reader = response.body.getReader();
    try { while (true) { const {value,done} = await reader.read(); if (done) break;
      size += value.length; if (size > maximum) hold('artifact-size-refused'); chunks.push(Buffer.from(value));
    } } finally {await reader.cancel();}
    return Buffer.concat(chunks);
  }
  hold('download-failed');
}

interface Pointer {target: string; [key: string]: unknown}
interface AppProof {path: string; inventory: string; dev: number; ino: number; signer: string}
interface TransactionIo {
  home: string; clock(): number; sleep(ms: number): Promise<void>; fetchStatus(url: string): Promise<number | null>;
  readCurrentPointer(path: string): Pointer | null; switchCurrentPointer(path: string, before: Pointer | null, target: string): Pointer;
  restoreCurrentPointer(path: string, before: Pointer | null, expected: Pointer): void;
  writeInstallJournal(owner: string, value: {phase: string}): void;
  readBoundedFile(path: string, maximum: number): string;
  [key: string]: unknown;
}
interface TransactionModule {
  createLocalAppTransactionIo(options: {packageRoot: string; home: string}): TransactionIo;
  inspectLocalApp(path: string, signer: string, io: TransactionIo): AppProof;
  selectLocalApp(signer: string, io: TransactionIo): AppProof | null;
  installLocalApp(input: Record<string, unknown>, io: TransactionIo): Promise<unknown>;
  inspectLocalAliases(io: TransactionIo): unknown[]; createLocalAliases(aliases: unknown[], io: TransactionIo): unknown[];
  removeCreatedAliases(aliases: unknown[], io: TransactionIo): void;
  launchedAppIsOwned(io: TransactionIo): boolean;
}
/** Load only this installed Node package's disk helper; a SEA has no package root. */
export async function loadInstalledDesktopTransaction(root: string): Promise<TransactionModule> {
  if (!root || root !== runningPackageRoot()) hold('unsupported-installed-runtime');
  return await import(pathToFileURL(join(root, 'scripts', 'local-app-transaction.mjs')).href) as TransactionModule;
}
function privateParents(home: string, path: string): void {
  if (!path.startsWith(home + '/')) hold('unsafe-installation-path');
  directory(home, false); let at = home;
  for (const part of path.slice(home.length + 1).split('/')) {
    at = join(at, part);
    try { directory(at, false); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(at, {mode: 0o700}); directory(at); fsyncDirectory(dirname(at));
    }
  }
}
function verifyAppReleaseRecord(appRoot: string, manifest: UpdateManifest, read?: (path: string, maximum: number) => string): void {
  const recordPath = join(appRoot, 'Contents', 'Resources', 'phantom-release.json');
  let text: string;
  if (read) text = read(recordPath, 8192);
  else {
    const stat = fs.lstatSync(recordPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) hold('app-source-unverified');
    text = fs.readFileSync(recordPath, 'utf8');
  }
  if (Buffer.byteLength(text) > 8192) hold('app-source-unverified');
  try {verifyUpdateBundleRecord(text, manifest);} catch {hold('app-source-unverified');}
}
async function installPairedUpdate(stageId: string, staged: ReturnType<typeof readStage>, deps: DesktopUpdateDependencies, expected: UpdateAdmission): Promise<DesktopUpdateState> {
  const root = deps.packageRoot!;
  // Only the already-running compiled package supplies the transaction implementation.
  const helper = deps.transaction ? await deps.transaction() : await loadInstalledDesktopTransaction(root);
  const io = helper.createLocalAppTransactionIo({packageRoot: root, home: deps.home});
  io.log = () => {}; // native receives only bounded typed progress/results, never private paths
  const current = join(deps.home, '.local', 'share', 'ashlr', 'current');
  const previous = io.readCurrentPointer(current);
  if (!previous || fs.realpathSync(previous.target) !== fs.realpathSync(root)) hold('running-current-mismatch');
  const selected = helper.selectLocalApp(staged.manifest.app.signer, io);
  if (!selected) hold('installed-app-unavailable');
  const aliases = helper.inspectLocalAliases(io);
  const data = await deps.download(staged.manifest.cli.url, staged.manifest.cli.bytes);
  validateArtifact(data, staged.manifest.cli, deps.trust!);
  const original = join(staged.stage, 'package.tgz'); writeExclusive(original, data); fsyncDirectory(staged.stage);
  const archive = await readPinnedRuntimeArchive({artifactPath: original, sha256: staged.manifest.cli.sha256,
    revision: staged.manifest.source.revision, version: staged.manifest.version}).catch(() => hold('package-archive-refused'));
  if (archive.pins.size !== staged.manifest.cli.bytes) hold('artifact-mismatch');
  const entries = staged.entries;
  const releases = join(deps.home, '.local', 'share', 'ashlr', 'releases'); privateParents(deps.home, releases);
  const destination = join(releases, staged.manifest.source.revision);
  fs.mkdirSync(destination, {mode: 0o700}); // never overwrite an existing release
  fsyncDirectory(releases); extractPinnedRuntimeArchive(archive, destination);
  const surface = verifyAuthoritySurfaceAt(destination, 'installed', {fresh: true});
  if (!surface.ok || surface.digest !== staged.manifest.authoritySurfaceDigest) hold('candidate-surface-unverified');
  const appStage = fs.mkdtempSync(join(staged.stage, 'verified-app-')); fs.chmodSync(appStage, 0o700);
  const appRoot = extractApp(entries, appStage); verifyAppReleaseRecord(appRoot, staged.manifest);
  const app = helper.inspectLocalApp(appRoot, staged.manifest.app.signer, io);
  if (app.inventory !== staged.manifest.app.inventorySha256) hold('app-inventory-mismatch');
  if (readStage(stageId, deps).digest !== staged.digest) hold('stage-changed');
  freshAdmission(deps, expected, staged.manifest.authoritySurfaceDigest);
  const attempted = join(staged.stage, 'consumer-attempt.json');
  writeExclusive(attempted, Buffer.from(JSON.stringify({schemaVersion: 1, manifestDigest: staged.digest, state: 'installation-attempted'}) + '\n'));
  fsyncDirectory(staged.stage);
  let phase: string | null = null;
  const writeJournal = io.writeInstallJournal.bind(io);
  io.writeInstallJournal = (owner, value) => {writeJournal(owner, value); phase = value.phase;};
  // Slow bundle preparation cannot leave candidate package bytes trusted from
  // an earlier observation. Recheck both immutable original membership and the
  // signed authority closure at each publication boundary, then authority last.
  const candidateReady = async () => {
    await verifyInstalledPackage(destination, staged, deps);
    const observed = verifyAuthoritySurfaceAt(destination, 'installed', {fresh: true});
    if (!observed.ok || observed.digest !== staged.manifest.authoritySurfaceDigest) hold('candidate-surface-unverified');
    requireNewerVersion(deps, staged.manifest.version);
    if (JSON.stringify(io.readCurrentPointer(current)) !== JSON.stringify(previous) || readStage(stageId, deps).digest !== staged.digest) hold('current-or-stage-changed');
    freshAdmission(deps, expected, staged.manifest.authoritySurfaceDigest);
  };
  let switched: Pointer | null = null; let created: unknown[] = [];
  try {
    await helper.installLocalApp({selected, source: appRoot, sourceProof: app, signer: staged.manifest.app.signer,
      version: staged.manifest.version, native: true, preserveSigned: true, previousCurrent: previous.target,
      beforeSwitch: candidateReady,
      commitPointer: async () => {
        await candidateReady();
        switched = io.switchCurrentPointer(current, previous, destination);
        created = helper.createLocalAliases(aliases, io);
      },
      rollbackPointer: async () => {
        helper.removeCreatedAliases(created, io);
        if (!switched) {
          if (JSON.stringify(io.readCurrentPointer(current)) !== JSON.stringify(previous)) hold('pointer-recovery-unknown');
          return; // the fresh guard refused before any current-pointer mutation
        }
        io.restoreCurrentPointer(current, previous, switched);
      },
      health: async () => {
        const deadline = io.clock() + 30_000;
        while (io.clock() < deadline) {
          if (helper.launchedAppIsOwned(io) && await io.fetchStatus('http://127.0.0.1:7777/verse/') === 200) return true;
          await io.sleep(1000);
        }
        return false;
      },
    }, io);
    return 'applied';
  } catch {
    return phase === 'rolled-back' ? 'rolled-back' : 'rollback-held';
  }
}

async function verifyInstalledPackage(root: string, staged: ReturnType<typeof readStage>, deps: DesktopUpdateDependencies): Promise<void> {
  const original = join(staged.stage, 'package.tgz');
  validateArtifact(bytes(original, staged.manifest.cli.bytes), staged.manifest.cli, deps.trust!);
  const archive = await readPinnedRuntimeArchive({artifactPath: original, sha256: staged.manifest.cli.sha256,
    revision: staged.manifest.source.revision, version: staged.manifest.version}).catch(() => hold('package-archive-refused'));
  const expected = new Set<string>();
  const parents = new Set<string>(['']);
  for (const entry of archive.entries) {
    expected.add(entry.path); const path = join(root, entry.path);
    if (fs.realpathSync(path) !== path || !installedBytes(path, 16 * 1024 * 1024, true).equals(entry.bytes) || Boolean(fs.lstatSync(path).mode & 0o111) !== entry.executable) hold('installed-current-unverified');
    const parts = entry.path.split('/'); for (let i=1;i<parts.length;i++) parents.add(parts.slice(0,i).join('/'));
  }
  const scan = (relative: string) => {
    const at=join(root,relative); const stat=fs.lstatSync(at);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (!parents.has(relative)) hold('installed-current-unverified');
      for (const name of fs.readdirSync(at)) scan(relative ? `${relative}/${name}` : name);
    } else if (!stat.isFile() || stat.isSymbolicLink() || !expected.has(relative)) hold('installed-current-unverified');
  };
  scan('');
}

/** A prior result is historical data until the actual current CLI/app bytes agree again. */
export async function readQualifiedDesktopUpdateResult(stageId: string, deps: DesktopUpdateDependencies): Promise<DesktopUpdateResult> {
  let version: string | null = null;
  try {
    const staged = readStage(stageId, deps); const manifest = staged.manifest; version = manifest.version;
    const attempt = JSON.parse(bytes(join(staged.stage, 'consumer-attempt.json'), 8192).toString('utf8')) as Record<string, unknown>;
    if (attempt.schemaVersion !== 1 || attempt.manifestDigest !== staged.digest || attempt.state !== 'installation-attempted' || Object.keys(attempt).length !== 3) hold('update-result-unverified');
    const saved = JSON.parse(bytes(join(staged.stage, 'consumer-result.json'), 8192).toString('utf8')) as Record<string, unknown>;
    if (Object.keys(saved).sort().join() !== ['schema','state','version','reason','requiresReapproval'].sort().join() || saved.schema !== 'phantom-desktop-update-result/v1' || saved.version !== version || saved.requiresReapproval !== false) hold('update-result-unverified');
    if (saved.state === 'rollback-held' || saved.state === 'rolled-back') return result(saved.state, version, 'installation-recovery-required');
    if (saved.state !== 'applied' || saved.reason !== 'operator-restart-required') hold('update-result-unverified');
    const root = deps.packageRoot;
    if (!root || deps.currentPackageRoot() !== root) hold('installed-current-unverified');
    await verifyInstalledPackage(root, staged, deps);
    const identity = parseBuildIdentity(installedBytes(join(root, 'dist', 'build-identity.json'), 64 * 1024).toString('utf8'));
    const surface = verifyAuthoritySurfaceAt(root, 'installed', {fresh: true});
    if (!identity || identity.dirty || identity.provenance !== 'git' || identity.revision !== manifest.source.revision || identity.packageVersion !== version || !surface.ok || surface.digest !== manifest.authoritySurfaceDigest) hold('installed-current-unverified');
    const helper = deps.transaction ? await deps.transaction() : await loadInstalledDesktopTransaction(root);
    const io = helper.createLocalAppTransactionIo({packageRoot: root, home: deps.home});
    const app = helper.selectLocalApp(manifest.app.signer, io);
    if (!app || app.path !== '/Applications/Phantom.app' || app.inventory !== manifest.app.inventorySha256) hold('installed-app-unverified');
    verifyAppReleaseRecord(app.path, manifest, io.readBoundedFile.bind(io));
    const recheck = helper.inspectLocalApp(app.path, manifest.app.signer, io);
    if (recheck.inventory !== app.inventory || recheck.dev !== app.dev || recheck.ino !== app.ino || deps.currentPackageRoot() !== root) hold('installed-app-unverified');
    return result('applied', version, 'operator-restart-required');
  } catch (error) {return result('blocked', version, error instanceof Held ? error.reason : 'update-result-unverified');}
}

function saveConsumerResult(stage: string, value: DesktopUpdateResult, deps: DesktopUpdateDependencies): void {
  safeAncestors(deps.home, stage);
  const temporary = join(stage, `result-${randomBytes(16).toString('hex')}.tmp`);
  writeExclusive(temporary, Buffer.from(JSON.stringify(value) + '\n'));
  try {safeAncestors(deps.home, stage); fs.renameSync(temporary, join(stage, 'consumer-result.json')); fsyncDirectory(stage);}
  catch (error) {try {fs.unlinkSync(temporary);} catch { /* retain uncertain temporary ownership */ } throw error;}
}

export async function applyQualifiedDesktopUpdate(stageId: string, deps: DesktopUpdateDependencies,
  install: typeof installPairedUpdate = installPairedUpdate,
  progress: (value: DesktopUpdateResult) => void | Promise<void> = () => {}): Promise<DesktopUpdateResult> {
  let version: string | null = null; let lock: string | null = null;
  try {
    const staged = readStage(stageId, deps); version = staged.manifest.version;
    const expected = deps.admission(); const reason = admissionReason(expected, staged.manifest.authoritySurfaceDigest);
    if (reason) return result('blocked', version, reason, reason === 'authority-reapproval-required' || reason === 'grant-unavailable');
    requireNewerVersion(deps, version);
    const parent = deps.captureParent(); if (!parent) hold('native-parent-unverified');
    const ackDeadline = deps.now() + 9000;
    if (!await deps.verifyParent(parent, staged.manifest)) hold('native-parent-unverified');
    if (deps.now() >= ackDeadline) hold('native-parent-proof-timeout');
    freshAdmission(deps, expected, staged.manifest.authoritySurfaceDigest);
    await progress(result('waiting-native-exit', version, null));
    await waitForNativeUpdateParent(parent, deps);
    freshAdmission(deps, expected, staged.manifest.authoritySurfaceDigest);
    // Exclusive claim; uncertain/crashed attempt files remain a durable no-replay fence.
    const claim = join(staged.stage, 'consumer-lock'); fs.mkdirSync(claim, {mode: 0o700}); lock = claim; fsyncDirectory(staged.stage);
    try { fs.lstatSync(join(staged.stage, 'consumer-attempt.json')); hold('update-attempt-already-recorded'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const phase = await install(stageId, staged, deps, expected);
    const observed = result(phase, version, phase === 'applied' ? 'operator-restart-required' : 'installation-recovery-required');
    try {saveConsumerResult(staged.stage, observed, deps);} catch {return result('rollback-held', version, 'result-persistence-unknown');}
    return observed;
  } catch (error) { return result('blocked', version, error instanceof Held ? error.reason : 'update-unavailable'); }
  finally { if (lock) { try {fs.rmdirSync(lock); fsyncDirectory(dirname(lock));} catch { /* uncertain claims are preserved */ } } }
}

function parentObservation(pid: number): NativeUpdateParent | null {
  const output = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,args='],
    {encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'}});
  if (output.error || output.status !== 0) return null;
  const match = /^\s*(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(\/Applications\/(?:Phantom|Ashlr)\.app\/Contents\/MacOS\/ashlr-desktop)\s*$/.exec(output.stdout);
  return match ? {pid: Number(match[1]), ppid: Number(match[2]), started: match[3]!, executable: match[4]!} : null;
}
export function createDesktopUpdateDependencies(trust: UpdateTrust | null): DesktopUpdateDependencies {
  const root = runningPackageRoot();
  return {
    home: userInfo().homedir, platform: process.platform, architecture: process.arch, packageRoot: root, trust,
    admission: () => {
      const evaluated = evaluateStandingAuthority({mode: 'fresh', surface: 'running'}); const leases = censusExecutionLeases();
      return {grantId: evaluated.grant?.grantId ?? null, envelopeDigest: evaluated.envelopeDigest,
        surfaceDigest: evaluated.surface.ok ? evaluated.surface.digest : null,
        active: evaluated.grantState === 'active' && evaluated.ledger.chain === 'ok', stop: evaluated.kill,
        leaseCount: leases.leases.length, unknownLeases: leases.unknown};
    },
    currentPackageRoot: () => {try {return fs.realpathSync(join(userInfo().homedir, '.local', 'share', 'ashlr', 'current'));} catch {return null;}},
    captureParent: () => parentObservation(process.ppid),
    verifyParent: async (parent, manifest) => {
      if (!root) return false;
      // The actual executable is inspected separately from argv, then its sole
      // installed bundle is verified by the already-running trusted helper.
      const executable = spawnSync('/bin/ps', ['-p', String(parent.pid), '-o', 'comm='],
        {encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024, env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'}});
      if (executable.error || executable.status !== 0 || executable.stdout.trim() !== parent.executable) return false;
      const helper = await loadInstalledDesktopTransaction(root);
      const io = helper.createLocalAppTransactionIo({packageRoot: root, home: userInfo().homedir});
      const deadline = Date.now() + 6500;
      io.exec = (command: string, argv: string[]) => {
        const remaining = deadline - Date.now();
        if (!['/usr/bin/plutil', '/usr/bin/codesign'].includes(command) || remaining < 1) hold('native-parent-proof-timeout');
        const observed = spawnSync(command, argv, {cwd: root, encoding: 'utf8', timeout: remaining, maxBuffer: 64 * 1024,
          env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'}});
        return {status: observed.error ? 1 : observed.status ?? 1, stdout: observed.stdout ?? '', stderr: ''};
      };
      const app = helper.selectLocalApp(manifest.app.signer, io);
      return Boolean(app && join(app.path, 'Contents', 'MacOS', 'ashlr-desktop') === parent.executable &&
        JSON.stringify(parentObservation(parent.pid)) === JSON.stringify(parent));
    },
    parentState: (expected) => {
      const observed = parentObservation(expected.pid);
      if (observed) return JSON.stringify(observed) === JSON.stringify(expected) ? 'same' : 'changed';
      try {process.kill(expected.pid, 0); return 'unknown';}
      catch (error) {return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown';}
    },
    now: Date.now, sleep: delay, download: downloadQualifiedUpdateArtifact,
  };
}

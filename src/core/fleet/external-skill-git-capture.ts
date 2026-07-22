/**
 * Content-addressed quarantine capture for one exact external-skill Git tree.
 *
 * The capture reads raw commit/tree/blob objects only. It never checks out,
 * extracts, executes, activates, or projects external content.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  linkSync,
  type BigIntStats,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { performance } from 'node:perf_hooks';

import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
} from './local-store-lock.js';

const MAX_COMMIT_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 2_048;
const MAX_DEPTH = 12;
const MAX_PATH_BYTES = 4_096;
const MAX_GIT_INVOCATIONS = MAX_ENTRIES + 64;
const MAX_SOURCE_STORE_ENTRIES = 8_192;
const MAX_CAPTURE_MS = 30_000;
const MAX_BUNDLE_BYTES = 24 * 1024 * 1024;
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FIXED_BLOCKERS = [
  'capture-custody-authentication-required',
  'sandbox-runner-required',
  'exposure-verifier-required',
  'outcome-attestation-required',
] as const;

export type ExternalSkillGitCaptureReason =
  | 'captured'
  | 'replayed'
  | 'invalid-input'
  | 'platform-unsupported'
  | 'source-unavailable'
  | 'source-not-bare'
  | 'source-unsafe'
  | 'unsupported-object-format'
  | 'source-object-corrupt'
  | 'invalid-commit-object'
  | 'invalid-tree-object'
  | 'unsupported-tree-entry'
  | 'portable-path-collision'
  | 'capture-limit'
  | 'unsafe-symlink'
  | 'lfs-pointer'
  | 'audit-digest-mismatch'
  | 'store-unavailable'
  | 'store-conflict'
  | 'publication-failed';

type ExternalSkillGitCaptureFailureReason = Exclude<
  ExternalSkillGitCaptureReason,
  'captured' | 'replayed'
>;

export interface ExternalSkillGitCaptureInput {
  repoPath: string;
  commitOid: string;
  packSubdir: string;
  expectedPortablePackDigest: string;
}

interface ExternalSkillGitCaptureResultBase {
  schemaVersion: 1;
  mode: 'git-object-quarantine';
  authority: 'observation-only';
  executionEligible: false;
  policyEligible: false;
  promotionEligible: false;
  blockers: typeof FIXED_BLOCKERS;
}

export type ExternalSkillGitCaptureResult = ExternalSkillGitCaptureResultBase & (
  | {
    state: 'captured' | 'replayed';
    reason: 'captured' | 'replayed';
    captureDigest: string;
    portablePackDigest: string;
    sourceIdentity: string;
    fileCount: number;
    symlinkCount: number;
    totalBytes: number;
    custody: { localIntegrity: 'verified'; authenticated: false };
  }
  | {
    state: 'withheld';
    reason: ExternalSkillGitCaptureFailureReason;
    captureDigest: null;
    portablePackDigest: null;
    sourceIdentity: null;
    fileCount: 0;
    symlinkCount: 0;
    totalBytes: 0;
    custody: { localIntegrity: 'unavailable'; authenticated: false };
  }
);

interface ExternalSkillGitInvocation {
  executable: string;
  repoPath: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

type ExternalSkillGitRunner = (
  invocation: ExternalSkillGitInvocation,
) => { ok: true; stdout: Buffer } | { ok: false };

export interface ExternalSkillGitCaptureOptions {
  storageRoot?: string;
  storageAnchor?: string;
}

type ObjectFormat = 'sha1' | 'sha256';
type CaptureNodeKind = 'directory' | 'file' | 'symlink';

interface CaptureNode {
  name: string;
  rawName: Buffer;
  path: string;
  kind: CaptureNodeKind;
  mode: '040000' | '100644' | '100755' | '120000';
  gitOid: string;
  bytes?: Buffer;
  children?: CaptureNode[];
  resolvedTarget?: string;
  portableDigest?: string;
}

interface CaptureCounters {
  files: number;
  symlinks: number;
  bytes: number;
}

interface CaptureBundleEntry {
  path: string;
  kind: CaptureNodeKind;
  mode: CaptureNode['mode'];
  gitOid: string;
  byteLength: number;
  contentDigest: string | null;
  contentBase64: string | null;
}

interface CaptureBundle {
  schemaVersion: 1;
  objectFormat: ObjectFormat;
  commitOid: string;
  commitTreeOid: string;
  packTreeOid: string;
  packSubdirHash: string;
  portablePackDigest: string;
  entries: CaptureBundleEntry[];
}

interface CaptureMarker {
  schemaVersion: 1;
  captureDigest: string;
  bundleDigest: string;
  portablePackDigest: string;
  sourceIdentity: string;
  fileCount: number;
  symlinkCount: number;
  totalBytes: number;
  custodyAuthenticated: false;
  executionEligible: false;
  policyEligible: false;
  promotionEligible: false;
}

class CaptureFailure extends Error {
  constructor(readonly reason: ExternalSkillGitCaptureFailureReason) {
    super(reason);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function asciiBytesCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function withheld(
  reason: ExternalSkillGitCaptureFailureReason,
): ExternalSkillGitCaptureResult {
  return {
    schemaVersion: 1,
    mode: 'git-object-quarantine',
    state: 'withheld',
    reason,
    captureDigest: null,
    portablePackDigest: null,
    sourceIdentity: null,
    fileCount: 0,
    symlinkCount: 0,
    totalBytes: 0,
    authority: 'observation-only',
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
    custody: { localIntegrity: 'unavailable', authenticated: false },
    blockers: FIXED_BLOCKERS,
  };
}

function completed(
  state: 'captured' | 'replayed',
  marker: CaptureMarker,
): ExternalSkillGitCaptureResult {
  return {
    schemaVersion: 1,
    mode: 'git-object-quarantine',
    state,
    reason: state,
    captureDigest: marker.captureDigest,
    portablePackDigest: marker.portablePackDigest,
    sourceIdentity: marker.sourceIdentity,
    fileCount: marker.fileCount,
    symlinkCount: marker.symlinkCount,
    totalBytes: marker.totalBytes,
    authority: 'observation-only',
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
    custody: { localIntegrity: 'verified', authenticated: false },
    blockers: FIXED_BLOCKERS,
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseInput(value: unknown): ExternalSkillGitCaptureInput | null {
  let snapshot: unknown;
  try { snapshot = structuredClone(value); } catch { return null; }
  if (!plainRecord(snapshot)) return null;
  if (Object.keys(snapshot).sort().join(',') !==
    'commitOid,expectedPortablePackDigest,packSubdir,repoPath') return null;
  const { repoPath, commitOid, packSubdir, expectedPortablePackDigest } = snapshot;
  if (
    typeof repoPath !== 'string' || !isAbsolute(repoPath) || resolve(repoPath) !== repoPath ||
    repoPath.length > 4_096 || repoPath.includes('\0') ||
    typeof commitOid !== 'string' || !FULL_OID.test(commitOid) || /^0+$/.test(commitOid) ||
    typeof expectedPortablePackDigest !== 'string' || !DIGEST.test(expectedPortablePackDigest) ||
    typeof packSubdir !== 'string' || normalizePackSubdir(packSubdir) === null
  ) return null;
  return { repoPath, commitOid, packSubdir, expectedPortablePackDigest };
}

function normalizePackSubdir(value: string): string | null {
  if (value === '' || value === '.') return '.';
  if (value.length > MAX_PATH_BYTES || value.includes('\0') || value.includes('\\') || value.startsWith('/')) return null;
  const segments = value.split('/');
  if (segments.some((segment) => !portableSegment(segment))) return null;
  return segments.join('/');
}

function portableSegment(value: string): boolean {
  if (!value || value === '.' || value === '..' || value !== value.normalize('NFC')) return false;
  if (Buffer.byteLength(value, 'utf8') > 255 || /[\\/:*?"<>|]/.test(value) || /[. ]$/.test(value)) return false;
  if (WINDOWS_DEVICE.test(value) || value.toLowerCase() === '.git') return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function resolveGitExecutable(): string | null {
  const candidates: string[] = [];
  for (const part of (process.env.PATH ?? '').split(delimiter)) {
    if (!part || !isAbsolute(part)) continue;
    candidates.push(join(part, 'git'));
  }
  for (const candidate of candidates) {
    try {
      if (!isAbsolute(candidate)) continue;
      accessSync(candidate, fsConstants.X_OK);
      const canonical = realpathSync(candidate);
      const stat = statSync(canonical);
      if (stat.isFile() && securePosixHierarchy(canonical, 'file', false)) return canonical;
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return {
    ...env,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

function defaultGitRunner(invocation: ExternalSkillGitInvocation): ReturnType<ExternalSkillGitRunner> {
  try {
    const stdout = execFileSync(invocation.executable, [
      '--no-replace-objects', '--git-dir', invocation.repoPath, ...invocation.args,
    ], {
      encoding: 'buffer',
      env: gitEnvironment(),
      maxBuffer: invocation.maxOutputBytes,
      timeout: invocation.timeoutMs,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout.length <= invocation.maxOutputBytes ? { ok: true, stdout } : { ok: false };
  } catch { return { ok: false }; }
}

function objectHash(format: ObjectFormat, type: 'commit' | 'tree' | 'blob', bytes: Buffer): string {
  return createHash(format).update(`${type} ${bytes.length}\0`, 'utf8').update(bytes).digest('hex');
}

function strictUtf8(value: Buffer): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { return null; }
}

function parseCommitTree(bytes: Buffer, oidLength: number): string | null {
  const decoded = strictUtf8(bytes);
  if (decoded === null) return null;
  const headerEnd = decoded.indexOf('\n\n');
  if (headerEnd < 0) return null;
  const trees = decoded.slice(0, headerEnd).split('\n').filter((line) => line.startsWith('tree '));
  if (trees.length !== 1) return null;
  const treeOid = trees[0]!.slice(5);
  return FULL_OID.test(treeOid) && treeOid.length === oidLength && !/^0+$/.test(treeOid)
    ? treeOid
    : null;
}

interface RawTreeEntry {
  mode: CaptureNode['mode'] | '160000';
  rawName: Buffer;
  name: string;
  oid: string;
}

function parseTree(bytes: Buffer, oidBytes: number): RawTreeEntry[] | null {
  const entries: RawTreeEntry[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : bytes.indexOf(0, space + 1);
    if (space <= offset || nul <= space + 1 || nul + 1 + oidBytes > bytes.length) return null;
    const modeText = bytes.subarray(offset, space).toString('ascii');
    const mode = modeText === '40000' ? '040000' : modeText as RawTreeEntry['mode'];
    if (!['040000', '100644', '100755', '120000', '160000'].includes(mode)) return null;
    const rawName = Buffer.from(bytes.subarray(space + 1, nul));
    const name = strictUtf8(rawName);
    if (name === null || !portableSegment(name)) return null;
    const oid = bytes.subarray(nul + 1, nul + 1 + oidBytes).toString('hex');
    entries.push({ mode, rawName, name, oid });
    offset = nul + 1 + oidBytes;
  }
  return entries;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function owned(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function securePosixHierarchy(
  path: string,
  leafKind: 'file' | 'directory',
  requireCurrentLeaf: boolean,
): boolean {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return false;
  try {
    const absolute = resolve(path);
    if (!isAbsolute(absolute) || realpathSync(absolute) !== absolute) return false;
    const root = parse(absolute).root;
    const segments = relative(root, absolute).split(sep).filter(Boolean);
    let cursor = root;
    for (let index = -1; index < segments.length; index += 1) {
      if (index >= 0) cursor = join(cursor, segments[index]!);
      const stat = lstatSync(cursor);
      const leaf = index === segments.length - 1;
      if (stat.isSymbolicLink() || (leaf
        ? leafKind === 'file' ? !stat.isFile() : !stat.isDirectory()
        : !stat.isDirectory())) return false;
      if (stat.uid !== 0 && stat.uid !== process.getuid()) return false;
      if (leaf && requireCurrentLeaf && stat.uid !== process.getuid()) return false;
      if ((stat.mode & 0o022) !== 0 &&
        !(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0)) return false;
    }
    return true;
  } catch { return false; }
}

function sameExecutableIdentity(expected: BigIntStats, observed: BigIntStats): boolean {
  return observed.isFile() && !observed.isSymbolicLink() && observed.nlink === expected.nlink &&
    observed.dev === expected.dev && observed.ino === expected.ino && observed.uid === expected.uid &&
    observed.mode === expected.mode && observed.size === expected.size &&
    observed.mtimeNs === expected.mtimeNs && observed.ctimeNs === expected.ctimeNs;
}

interface DirectoryPin {
  path: string;
  dev: bigint;
  ino: bigint;
}

interface PublicationPins {
  targetDirectory: DirectoryPin;
  stagingDirectory: DirectoryPin;
}

function pinDirectory(path: string): DirectoryPin | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? { path, dev: stat.dev, ino: stat.ino }
      : null;
  } catch { return null; }
}

function directoryPinMatches(pin: DirectoryPin): boolean {
  try {
    const stat = lstatSync(pin.path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      stat.dev === pin.dev && stat.ino === pin.ino;
  } catch { return false; }
}

function fsyncPinnedDirectory(pin: DirectoryPin): void {
  try {
    fsyncDirectory(pin.path, { expectedIdentity: { dev: pin.dev, ino: pin.ino } });
  } catch { throw new CaptureFailure('publication-failed'); }
  if (!directoryPinMatches(pin)) throw new CaptureFailure('publication-failed');
}

function secureSourceRoot(path: string): Stats | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
      !securePosixHierarchy(path, 'directory', true)) return null;
    for (const relative of [
      'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts', 'shallow',
    ]) {
      if (existsSync(join(path, relative))) return null;
    }
    if (existsSync(join(path, 'refs', 'replace'))) return null;
    return stat;
  } catch { return null; }
}

function secureSourceObjectStore(path: string, checkDeadline: () => void): boolean {
  let observed = 0;
  const visit = (directory: string, depth: number): boolean => {
    if (depth > 4) return false;
    let handle: ReturnType<typeof opendirSync>;
    try { handle = opendirSync(directory, { encoding: 'utf8' }); } catch { return false; }
    try {
      for (;;) {
        checkDeadline();
        const entry = handle.readSync();
        if (!entry) return true;
        observed += 1;
        if (observed > MAX_SOURCE_STORE_ENTRIES) return false;
        const name = entry.name;
        if (!name || name === '.' || name === '..' || name.includes('\0') ||
          name.endsWith('.promisor')) return false;
        const child = join(directory, name);
        let stat: Stats;
        try { stat = lstatSync(child); } catch { return false; }
        if (stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o022) !== 0) return false;
        if (stat.isDirectory()) {
          if (!visit(child, depth + 1)) return false;
        } else if (!stat.isFile()) return false;
      }
    } finally {
      try { handle.closeSync(); } catch { /* best effort */ }
    }
  };
  return visit(path, 0);
}

function secureDirectory(path: string, anchor: string): boolean {
  try {
    const absolutePath = resolve(path);
    const absoluteAnchor = resolve(anchor);
    const nested = absolutePath === absoluteAnchor || absolutePath.startsWith(`${absoluteAnchor}${sep}`);
    if (!nested || !securePosixHierarchy(absoluteAnchor, 'directory', true)) return false;
    const relative = absolutePath.slice(absoluteAnchor.length).split(sep).filter(Boolean);
    let cursor = absoluteAnchor;
    for (const segment of ['', ...relative]) {
      if (segment) {
        cursor = join(cursor, segment);
        if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
      }
      const ancestor = lstatSync(cursor);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || !owned(ancestor) ||
        (process.platform !== 'win32' && (ancestor.mode & 0o022) !== 0)) return false;
    }
    if (process.platform !== 'win32') chmodSync(absolutePath, 0o700);
    const stat = lstatSync(absolutePath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) return false;
    return assurePrivateStoragePath(path, 'directory', 'secure-created', { anchorPath: anchor }).ok;
  } catch { return false; }
}

function configuredAshlrHome(): string | null {
  const configured = process.env.ASHLR_HOME;
  if (configured === undefined) return join(homedir(), '.ashlr');
  if (!configured || !isAbsolute(configured) || resolve(configured) !== configured || configured.includes('\0')) {
    return null;
  }
  return configured;
}

function readStablePrivateFile(
  path: string,
  maxBytes: number,
  anchor: string,
  requiredLinks = 1n,
): Buffer | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== requiredLinks ||
      before.size < 1n || before.size > BigInt(maxBytes) ||
      (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) ||
      (process.platform !== 'win32' && (before.mode & 0o077n) !== 0n)) return null;
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      path,
      'file',
      'inspect-owned',
      { anchorPath: anchor },
    ).ok) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const value = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < value.length) {
      const read = readSync(fd, value, offset, value.length - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
      named.dev !== opened.dev || named.ino !== opened.ino || named.nlink !== requiredLinks) return null;
    return value;
  } catch { return null; } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function sameNamedFile(path: string, other: string, links: bigint): boolean {
  try {
    const left = lstatSync(path, { bigint: true });
    const right = lstatSync(other, { bigint: true });
    return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink() &&
      left.nlink === links && right.nlink === links && left.dev === right.dev && left.ino === right.ino;
  } catch { return false; }
}

function publishNoClobber(
  value: Buffer,
  target: string,
  staging: string,
  anchor: string,
  label: string,
  pins: PublicationPins,
): 'published' | 'replayed' | 'conflict' {
  if (!directoryPinMatches(pins.targetDirectory) || !directoryPinMatches(pins.stagingDirectory) ||
    dirname(target) !== pins.targetDirectory.path || staging !== pins.stagingDirectory.path) {
    throw new CaptureFailure('publication-failed');
  }
  const candidate = join(staging, `${basename(target)}.candidate`);
  const targetExists = existsSync(target);
  const candidateExists = existsSync(candidate);
  if (targetExists) {
    const oneLink = readStablePrivateFile(target, value.length + 1, anchor);
    if (oneLink) {
      if (candidateExists || !oneLink.equals(value)) return 'conflict';
      fsyncPinnedDirectory(pins.targetDirectory);
      fsyncPinnedDirectory(pins.stagingDirectory);
      return readStablePrivateFile(target, value.length + 1, anchor)?.equals(value)
        ? 'replayed'
        : 'conflict';
    }
    if (!candidateExists || !sameNamedFile(target, candidate, 2n)) return 'conflict';
    const targetBytes = readStablePrivateFile(target, value.length + 1, anchor, 2n);
    const candidateBytes = readStablePrivateFile(candidate, value.length + 1, anchor, 2n);
    if (!targetBytes?.equals(value) || !candidateBytes?.equals(value)) return 'conflict';
    fsyncPinnedDirectory(pins.targetDirectory);
    try { unlinkSync(candidate); } catch { throw new CaptureFailure('publication-failed'); }
    fsyncPinnedDirectory(pins.stagingDirectory);
    return readStablePrivateFile(target, value.length + 1, anchor)?.equals(value)
      ? 'replayed'
      : 'conflict';
  }
  if (candidateExists) {
    const staged = readStablePrivateFile(candidate, value.length + 1, anchor);
    if (!staged?.equals(value)) return 'conflict';
  } else {
    const temporary = join(staging, `${basename(target)}.${randomUUID()}.tmp`);
    try {
      writePrivateFileAtomically(temporary, candidate, value, { anchorPath: anchor, label });
    } catch { throw new CaptureFailure('publication-failed'); }
    const staged = readStablePrivateFile(candidate, value.length + 1, anchor);
    if (!staged?.equals(value)) throw new CaptureFailure('publication-failed');
  }
  fsyncPinnedDirectory(pins.stagingDirectory);
  try { linkSync(candidate, target); } catch { throw new CaptureFailure('publication-failed'); }
  fsyncPinnedDirectory(pins.targetDirectory);
  try { unlinkSync(candidate); } catch { throw new CaptureFailure('publication-failed'); }
  fsyncPinnedDirectory(pins.stagingDirectory);
  const installed = readStablePrivateFile(target, value.length + 1, anchor);
  return installed?.equals(value) ? 'published' : 'conflict';
}

function canonicalBundleBytes(bundle: CaptureBundle): Buffer {
  return Buffer.from(JSON.stringify(bundle), 'utf8');
}

function canonicalMarkerBytes(marker: CaptureMarker): Buffer {
  return Buffer.from(JSON.stringify(marker), 'utf8');
}

/**
 * Capture one exact, already-fetched bare-repository tree into private CAS.
 * Successful capture is still ineligible for execution or policy use.
 */
export function captureExternalSkillGitObject(
  value: ExternalSkillGitCaptureInput,
  options: ExternalSkillGitCaptureOptions = {},
): ExternalSkillGitCaptureResult {
  const input = parseInput(value);
  if (!input) return withheld('invalid-input');
  if (process.platform === 'win32') return withheld('platform-unsupported');
  const packSubdir = normalizePackSubdir(input.packSubdir)!;
  const gitExecutable = resolveGitExecutable();
  if (!gitExecutable) return withheld('source-unavailable');
  if (!securePosixHierarchy(gitExecutable, 'file', false)) return withheld('source-unsafe');
  let executableIdentity: BigIntStats;
  try {
    executableIdentity = lstatSync(gitExecutable, { bigint: true });
    if (!sameExecutableIdentity(executableIdentity, executableIdentity)) {
      return withheld('source-unsafe');
    }
  } catch { return withheld('source-unavailable'); }
  const now = () => performance.now();
  const deadline = now() + MAX_CAPTURE_MS;
  const requireDeadline = (): void => {
    if (now() > deadline) throw new CaptureFailure('capture-limit');
  };
  let requestedSourceStat: Stats;
  try {
    requestedSourceStat = lstatSync(input.repoPath);
    if (!requestedSourceStat.isDirectory() || requestedSourceStat.isSymbolicLink() ||
      !owned(requestedSourceStat)) return withheld('source-unsafe');
  } catch { return withheld('source-unavailable'); }
  let sourceRepoPath: string;
  try {
    sourceRepoPath = realpathSync(input.repoPath);
  } catch { return withheld('source-unavailable'); }
  const canonicalSourceBefore = secureSourceRoot(sourceRepoPath);
  if (!canonicalSourceBefore || !sameFileIdentity(requestedSourceStat, canonicalSourceBefore)) {
    return withheld('source-unsafe');
  }
  try {
    const head = lstatSync(join(sourceRepoPath, 'HEAD'));
    const objects = lstatSync(join(sourceRepoPath, 'objects'));
    if (!head.isFile() || head.isSymbolicLink() || !objects.isDirectory() || objects.isSymbolicLink()) {
      return withheld('source-not-bare');
    }
  } catch { return withheld('source-not-bare'); }
  try {
    if (!secureSourceObjectStore(join(sourceRepoPath, 'objects'), requireDeadline)) {
      return withheld('source-unsafe');
    }
  } catch (error) {
    return withheld(error instanceof CaptureFailure ? error.reason : 'source-unsafe');
  }
  let invocations = 0;
  const invoke = (args: readonly string[], maxOutputBytes: number): Buffer => {
    requireDeadline();
    const remaining = Math.floor(deadline - now());
    if (remaining < 1 || invocations >= MAX_GIT_INVOCATIONS) throw new CaptureFailure('capture-limit');
    invocations += 1;
    const executableBefore = lstatSync(gitExecutable, { bigint: true });
    if (!sameExecutableIdentity(executableIdentity, executableBefore)) {
      throw new CaptureFailure('source-unsafe');
    }
    const result = defaultGitRunner({
      executable: gitExecutable,
      repoPath: sourceRepoPath,
      args,
      timeoutMs: Math.max(1, Math.min(5_000, remaining)),
      maxOutputBytes,
    });
    const executableAfter = lstatSync(gitExecutable, { bigint: true });
    if (!sameExecutableIdentity(executableIdentity, executableAfter) ||
      !result.ok) throw new CaptureFailure('source-unavailable');
    return result.stdout;
  };

  try {
    const bare = strictUtf8(invoke(['rev-parse', '--is-bare-repository'], 64))?.trim();
    if (bare !== 'true') throw new CaptureFailure('source-not-bare');
    const formatText = strictUtf8(invoke(['rev-parse', '--show-object-format'], 64))?.trim();
    const format: ObjectFormat = formatText === 'sha1' || formatText === 'sha256'
      ? formatText
      : (() => { throw new CaptureFailure('unsupported-object-format'); })();
    if ((format === 'sha1' ? 40 : 64) !== input.commitOid.length) {
      throw new CaptureFailure('unsupported-object-format');
    }
    const oidBytes = input.commitOid.length / 2;
    const readObject = (type: 'commit' | 'tree' | 'blob', oid: string, max: number): Buffer => {
      const bytes = invoke(['cat-file', type, oid], max);
      if (objectHash(format, type, bytes) !== oid) throw new CaptureFailure('source-object-corrupt');
      return bytes;
    };
    const commitBytes = readObject('commit', input.commitOid, MAX_COMMIT_BYTES);
    const commitTreeOid = parseCommitTree(commitBytes, input.commitOid.length);
    if (!commitTreeOid) throw new CaptureFailure('invalid-commit-object');

    const treeCache = new Map<string, RawTreeEntry[]>();
    let parsedTreeEntries = 0;
    const rawTree = (oid: string): RawTreeEntry[] => {
      requireDeadline();
      const cached = treeCache.get(oid);
      if (cached) return cached;
      const parsed = parseTree(readObject('tree', oid, MAX_TREE_BYTES), oidBytes);
      if (!parsed) throw new CaptureFailure('invalid-tree-object');
      parsedTreeEntries += parsed.length;
      if (parsedTreeEntries > MAX_ENTRIES) throw new CaptureFailure('capture-limit');
      const foldedNames = new Set<string>();
      for (const entry of parsed) {
        const portableKey = entry.name.normalize('NFC').toLowerCase();
        if (foldedNames.has(portableKey)) throw new CaptureFailure('portable-path-collision');
        foldedNames.add(portableKey);
      }
      treeCache.set(oid, parsed);
      return parsed;
    };

    let packTreeOid = commitTreeOid;
    if (packSubdir !== '.') {
      for (const segment of packSubdir.split('/')) {
        requireDeadline();
        const entries = rawTree(packTreeOid);
        const match = entries.find((entry) => entry.name === segment);
        if (!match || match.mode !== '040000') throw new CaptureFailure('invalid-tree-object');
        packTreeOid = match.oid;
      }
    }

    const counters: CaptureCounters = { files: 0, symlinks: 0, bytes: 0 };
    let expandedEntries = 0;
    const allNodes = new Map<string, CaptureNode>();
    const readNodeTree = (oid: string, path: string, depth: number): CaptureNode => {
      if (depth > MAX_DEPTH) throw new CaptureFailure('capture-limit');
      const entries = rawTree(oid);
      const children: CaptureNode[] = [];
      for (const entry of entries) {
        requireDeadline();
        expandedEntries += 1;
        if (expandedEntries > MAX_ENTRIES) throw new CaptureFailure('capture-limit');
        if (depth + 1 > MAX_DEPTH) throw new CaptureFailure('capture-limit');
        if (entry.mode === '160000') throw new CaptureFailure('unsupported-tree-entry');
        const childPath = path ? `${path}/${entry.name}` : entry.name;
        if (Buffer.byteLength(childPath, 'utf8') > MAX_PATH_BYTES) throw new CaptureFailure('capture-limit');
        if (entry.mode === '040000') {
          const child = readNodeTree(entry.oid, childPath, depth + 1);
          child.name = entry.name;
          child.rawName = entry.rawName;
          children.push(child);
          allNodes.set(childPath, child);
          continue;
        }
        const bytes = readObject('blob', entry.oid, MAX_FILE_BYTES + 1);
        if (bytes.length > MAX_FILE_BYTES || counters.bytes + bytes.length > MAX_TOTAL_BYTES) {
          throw new CaptureFailure('capture-limit');
        }
        counters.bytes += bytes.length;
        if (bytes.subarray(0, 64).toString('ascii').startsWith(
          'version https://git-lfs.github.com/spec/v1',
        )) {
          throw new CaptureFailure('lfs-pointer');
        }
        const kind: CaptureNodeKind = entry.mode === '120000' ? 'symlink' : 'file';
        if (kind === 'symlink') counters.symlinks += 1;
        else counters.files += 1;
        const child: CaptureNode = {
          name: entry.name,
          rawName: entry.rawName,
          path: childPath,
          kind,
          mode: entry.mode,
          gitOid: entry.oid,
          bytes,
        };
        children.push(child);
        allNodes.set(childPath, child);
      }
      const node: CaptureNode = {
        name: basename(path),
        rawName: Buffer.from(basename(path), 'utf8'),
        path,
        kind: 'directory',
        mode: '040000',
        gitOid: oid,
        children,
      };
      if (path) allNodes.set(path, node);
      return node;
    };
    const root = readNodeTree(packTreeOid, '', 0);
    allNodes.set('', root);

    function resolveCapturedPath(requested: string, seen: Set<string>): string {
      requireDeadline();
      const segments = requested.split('/');
      for (let index = 0; index < segments.length; index += 1) {
        const candidate = segments.slice(0, index + 1).join('/');
        const candidateNode = allNodes.get(candidate);
        if (!candidateNode) throw new CaptureFailure('unsafe-symlink');
        if (candidateNode.kind === 'symlink') {
          const linked = resolveLink(candidateNode, seen);
          const remainder = segments.slice(index + 1).join('/');
          return resolveCapturedPath(remainder ? posix.join(linked, remainder) : linked, seen);
        }
        if (index < segments.length - 1 && candidateNode.kind !== 'directory') {
          throw new CaptureFailure('unsafe-symlink');
        }
      }
      return requested;
    }

    function resolveLink(node: CaptureNode, seen: Set<string>): string {
      requireDeadline();
      if (node.kind !== 'symlink' || !node.bytes) throw new CaptureFailure('unsafe-symlink');
      if (node.resolvedTarget !== undefined) return node.resolvedTarget;
      if (seen.has(node.path)) throw new CaptureFailure('unsafe-symlink');
      seen.add(node.path);
      try {
        const target = strictUtf8(node.bytes);
        if (target === null || target.length === 0 || target.length > MAX_PATH_BYTES ||
          target.includes('\\') || posix.isAbsolute(target) || target.includes('\0')) {
          throw new CaptureFailure('unsafe-symlink');
        }
        const normalizedTarget = posix.normalize(posix.join(posix.dirname(node.path), target));
        const resolved = normalizedTarget === '.'
          ? ''
          : normalizedTarget.endsWith('/') ? normalizedTarget.slice(0, -1) : normalizedTarget;
        if (resolved === '..' || resolved.startsWith('../') ||
          resolved.split('/').some((part) => part.toLowerCase() === '.git')) {
          throw new CaptureFailure('unsafe-symlink');
        }
        const finalTarget = resolveCapturedPath(resolved, seen);
        node.resolvedTarget = finalTarget;
        return finalTarget;
      } finally {
        seen.delete(node.path);
      }
    }
    for (const node of allNodes.values()) {
      requireDeadline();
      if (node.kind === 'symlink') resolveLink(node, new Set());
    }

    const digestNode = (node: CaptureNode): string => {
      requireDeadline();
      if (node.kind === 'file') {
        const bytes = node.bytes!;
        const mode = '644';
        node.portableDigest = sha256(Buffer.concat([
          Buffer.from(`file\0${mode}\0${bytes.length}\0`, 'utf8'), bytes,
        ]));
        return node.portableDigest;
      }
      if (node.kind === 'symlink') {
        const bytes = node.bytes!;
        const resolved = Buffer.from(node.resolvedTarget!, 'utf8');
        node.portableDigest = sha256(Buffer.concat([
          Buffer.from(`symlink\0${bytes.length}\0`, 'utf8'), bytes,
          Buffer.from(`\0${resolved.length}\0`, 'utf8'), resolved,
        ]));
        return node.portableDigest;
      }
      const children = [...(node.children ?? [])].sort((left, right) => Buffer.compare(left.rawName, right.rawName));
      const hasher = createHash('sha256').update(`directory\0${'755'}\0${children.length}\0`);
      for (const child of children) {
        const digest = digestNode(child);
        hasher.update(`${child.rawName.length}\0`);
        hasher.update(child.rawName);
        hasher.update(`\0${digest}`);
      }
      node.portableDigest = hasher.digest('hex');
      return node.portableDigest;
    };
    const portablePackDigest = digestNode(root);
    if (portablePackDigest !== input.expectedPortablePackDigest) {
      throw new CaptureFailure('audit-digest-mismatch');
    }

    const entries: CaptureBundleEntry[] = [...allNodes.values()]
      .filter((node) => node.path !== '')
      .sort((left, right) => asciiBytesCompare(left.path, right.path))
      .map((node) => {
        requireDeadline();
        return {
          path: node.path,
          kind: node.kind,
          mode: node.mode,
          gitOid: node.gitOid,
          byteLength: node.bytes?.length ?? 0,
          contentDigest: node.bytes ? sha256(node.bytes) : null,
          contentBase64: node.bytes ? node.bytes.toString('base64') : null,
        };
      });
    const bundle: CaptureBundle = {
      schemaVersion: 1,
      objectFormat: format,
      commitOid: input.commitOid,
      commitTreeOid,
      packTreeOid,
      packSubdirHash: sha256(packSubdir),
      portablePackDigest,
      entries,
    };
    const bundleBytes = canonicalBundleBytes(bundle);
    if (bundleBytes.length > MAX_BUNDLE_BYTES) throw new CaptureFailure('capture-limit');
    const bundleDigest = sha256(bundleBytes);
    const captureDigest = sha256(`ashlr-external-skill-git-capture-v1\0${bundleDigest}`);
    const sourceIdentity = sha256([
      'ashlr-external-skill-source-v1', format, input.commitOid, commitTreeOid,
      packTreeOid, bundle.packSubdirHash,
    ].join('\0'));
    const marker: CaptureMarker = {
      schemaVersion: 1,
      captureDigest,
      bundleDigest,
      portablePackDigest,
      sourceIdentity,
      fileCount: counters.files,
      symlinkCount: counters.symlinks,
      totalBytes: counters.bytes,
      custodyAuthenticated: false,
      executionEligible: false,
      policyEligible: false,
      promotionEligible: false,
    };

    requireDeadline();
    const sourceAfter = lstatSync(sourceRepoPath);
    const sourceStillSafe = secureSourceRoot(sourceRepoPath);
    if (!sameFileIdentity(canonicalSourceBefore, sourceAfter) || !sourceStillSafe ||
      !sameFileIdentity(canonicalSourceBefore, sourceStillSafe) ||
      !secureSourceObjectStore(join(sourceRepoPath, 'objects'), requireDeadline)) {
      throw new CaptureFailure('source-unsafe');
    }

    const ashlrHome = configuredAshlrHome();
    if (!options.storageRoot && !ashlrHome) throw new CaptureFailure('store-unavailable');
    const requestedStorageRoot = options.storageRoot ?? join(
      ashlrHome!, 'fleet', 'external-skill-quarantine', 'v1',
    );
    const requestedStorageAnchor = options.storageAnchor ?? (
      options.storageRoot ? dirname(requestedStorageRoot) : homedir()
    );
    if (!isAbsolute(requestedStorageRoot) || resolve(requestedStorageRoot) !== requestedStorageRoot ||
      requestedStorageRoot.includes('\0') || !isAbsolute(requestedStorageAnchor) ||
      resolve(requestedStorageAnchor) !== requestedStorageAnchor || requestedStorageAnchor.includes('\0')) {
      throw new CaptureFailure('store-unavailable');
    }
    const storageAnchor = realpathSync(requestedStorageAnchor);
    const relativeStorageRoot = relative(requestedStorageAnchor, requestedStorageRoot);
    if (relativeStorageRoot === '..' || relativeStorageRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativeStorageRoot)) throw new CaptureFailure('store-unavailable');
    const storageRoot = resolve(storageAnchor, relativeStorageRoot);
    const sourceContainsStore = storageRoot === sourceRepoPath ||
      storageRoot.startsWith(`${sourceRepoPath}${sep}`);
    const storeContainsSource = sourceRepoPath.startsWith(`${storageRoot}${sep}`);
    if (sourceContainsStore || storeContainsSource) throw new CaptureFailure('store-unavailable');
    if (existsSync(requestedStorageRoot) && realpathSync(requestedStorageRoot) !== storageRoot) {
      throw new CaptureFailure('store-unavailable');
    }
    const storagePaths = [
      storageRoot,
      join(storageRoot, 'objects'),
      join(storageRoot, 'receipts'),
      join(storageRoot, 'staging'),
      join(storageRoot, 'locks'),
    ];
    if (!storagePaths.every((path) => secureDirectory(path, storageAnchor))) {
      throw new CaptureFailure('store-unavailable');
    }
    const directoryPins = storagePaths.map(pinDirectory);
    if (directoryPins.some((pin) => pin === null)) throw new CaptureFailure('store-unavailable');
    const [, objectsPin, receiptsPin, stagingPin] = directoryPins as DirectoryPin[];
    const storageStillPinned = (): boolean =>
      securePosixHierarchy(storageAnchor, 'directory', true) &&
      (directoryPins as DirectoryPin[]).every(directoryPinMatches);
    requireDeadline();
    const lock = acquireLocalStoreLock(join(storageRoot, 'locks', 'capture.lock'), 2_000, {
      anchorPath: storageRoot,
      exactPrivateStorage: true,
    });
    if (!lock) throw new CaptureFailure('store-unavailable');
    let operationResult: ExternalSkillGitCaptureResult | undefined;
    let operationError: unknown;
    try {
      requireDeadline();
      if (!ownsLocalStoreLock(lock) || !storageStillPinned()) {
        throw new CaptureFailure('store-unavailable');
      }
      const bundleTarget = join(storageRoot, 'objects', `${captureDigest}.bundle`);
      const markerTarget = join(storageRoot, 'receipts', `${captureDigest}.json`);
      if (existsSync(markerTarget) && !existsSync(bundleTarget)) {
        throw new CaptureFailure('store-conflict');
      }
      const bundleState = publishNoClobber(
        bundleBytes, bundleTarget, join(storageRoot, 'staging'), storageRoot, 'skill capture bundle',
        { targetDirectory: objectsPin!, stagingDirectory: stagingPin! },
      );
      requireDeadline();
      if (bundleState === 'conflict') throw new CaptureFailure('store-conflict');
      if (!ownsLocalStoreLock(lock) || !storageStillPinned()) {
        throw new CaptureFailure('store-unavailable');
      }
      const markerBytes = canonicalMarkerBytes(marker);
      const markerState = publishNoClobber(
        markerBytes, markerTarget, join(storageRoot, 'staging'), storageRoot, 'skill capture receipt',
        { targetDirectory: receiptsPin!, stagingDirectory: stagingPin! },
      );
      if (markerState === 'conflict') throw new CaptureFailure('store-conflict');
      if (!storageStillPinned()) throw new CaptureFailure('store-unavailable');
      const installedBundle = readStablePrivateFile(bundleTarget, MAX_BUNDLE_BYTES, storageRoot);
      const installedMarker = readStablePrivateFile(markerTarget, 16 * 1024, storageRoot);
      if (!installedBundle?.equals(bundleBytes) || !installedMarker?.equals(markerBytes)) {
        throw new CaptureFailure('store-conflict');
      }
      operationResult = completed(
        bundleState === 'replayed' && markerState === 'replayed' ? 'replayed' : 'captured',
        marker,
      );
    } catch (error) {
      operationError = error;
    }
    if (!releaseLocalStoreLock(lock)) throw new CaptureFailure('publication-failed');
    if (operationError !== undefined) throw operationError;
    if (!operationResult) throw new CaptureFailure('publication-failed');
    return operationResult;
  } catch (error) {
    return withheld(error instanceof CaptureFailure ? error.reason : 'source-unavailable');
  }
}

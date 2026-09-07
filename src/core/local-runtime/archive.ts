import { createHash } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, writeSync, type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Header } from 'tar';
import { parseBuildIdentity } from '../build-identity.js';
import { fsyncDirectory } from '../util/durability.js';

const MAX_COMPRESSED = 64 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PinnedRuntimeArchiveOptions {
  artifactPath: string;
  sha256: string;
  revision: string;
  version: string;
}

export interface RuntimeArchivePins {
  sha256: string;
  integrity: string;
  size: number;
  revision: string;
  version: string;
}

export interface RuntimeArchiveEntry {
  readonly path: string;
  readonly bytes: Buffer;
  readonly executable: boolean;
}

export interface VerifiedRuntimeArchive {
  readonly pins: Readonly<RuntimeArchivePins>;
  readonly entries: readonly RuntimeArchiveEntry[];
}

// Buffers cannot be frozen. Remember each admitted digest so the extraction
// boundary also rejects accidental mutation of an otherwise frozen observation.
const admitted = new WeakMap<VerifiedRuntimeArchive, readonly string[]>();
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function fail(message: string): never { throw new Error(`local runtime archive: ${message}`); }

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.isFile() && b.nlink === 1n;
}

function readArtifact(path: string): Buffer {
  if (!isAbsolute(path)) fail('artifact path must be absolute');
  const named = lstatSync(path, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n ||
      named.size < 1n || named.size > BigInt(MAX_COMPRESSED)) fail('invalid artifact file or size');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFile(named, opened)) fail('artifact changed while opening');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail('artifact was truncated');
      offset += count;
    }
    if (!sameFile(opened, fstatSync(fd, { bigint: true })) ||
        !sameFile(opened, lstatSync(path, { bigint: true }))) fail('artifact changed while reading');
    return bytes;
  } finally { closeSync(fd); }
}

function canonicalPath(path: string | undefined): string {
  if (!path?.startsWith('package/')) fail('every entry must be below package/');
  const relative = path.slice(8);
  const parts = relative.split('/');
  if (relative.length > 1024 || parts.length > 32 || parts.some((part) =>
    !part || part === '.' || part === '..' || part.toLowerCase() === '.git' ||
    /[^\x20-\x7e]|[<>:"\\|?*]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('entry path is not portable and canonical');
  }
  return relative;
}

function parseEntries(bytes: Buffer): RuntimeArchiveEntry[] {
  let expanded: Buffer;
  try { expanded = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }); }
  catch { return fail('invalid gzip archive or expanded byte limit exceeded'); }
  if (expanded.length % 512 !== 0) fail('tar archive is truncated');
  const entries: RuntimeArchiveEntry[] = [];
  const paths = new Map<string, { path: string; file: boolean }>();
  let offset = 0;
  while (offset + 512 <= expanded.length) {
    const block = expanded.subarray(offset, offset + 512);
    if (block.every((value) => value === 0)) {
      if (expanded.length - offset < 1024 ||
          !expanded.subarray(offset).every((value) => value === 0)) fail('invalid tar terminator');
      if (entries.length === 0) fail('empty archive');
      return entries;
    }
    // npm's portable package archives use USTAR regular files. Interpret headers
    // with maintained node-tar, but reject links, sparse files and metadata
    // extensions instead of supporting multiple archive interpretations.
    const header = new Header(block);
    if (!header.cksumValid || block.subarray(257, 265).toString('ascii') !== 'ustar\u000000' ||
        header.type !== 'File' || header.linkpath || (header.mode ?? 0) & 0o7000) {
      fail('unsupported tar header, file type or mode');
    }
    const size = header.size;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) {
      fail('entry size exceeds limit');
    }
    const path = canonicalPath(header.path);
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const prefix = parts.slice(0, index + 1).join('/');
      const key = prefix.toLowerCase();
      const file = index === parts.length - 1;
      const prior = paths.get(key);
      if (prior && (prior.path !== prefix || prior.file || file)) fail('duplicate or aliased entry path');
      paths.set(key, { path: prefix, file });
    }
    const body = offset + 512;
    const next = body + Math.ceil(size / 512) * 512;
    if (next > expanded.length) fail('entry body is truncated');
    if (!expanded.subarray(body + size, next).every((value) => value === 0)) fail('nonzero entry padding');
    entries.push(Object.freeze({ path, bytes: expanded.subarray(body, body + size),
      executable: Boolean((header.mode ?? 0) & 0o111) }));
    if (entries.length > MAX_ENTRIES) fail('entry count exceeds limit');
    offset = next;
  }
  return fail('tar terminator is missing');
}

function verifyPackage(entries: readonly RuntimeArchiveEntry[], pins: PinnedRuntimeArchiveOptions): void {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const required = ['package.json', 'dist/build-identity.json', 'bin/ashlr',
    'dist/cli/index.js', 'dist/core/universe/index.js'];
  for (const path of required) if (!byPath.has(path)) fail(`required entry missing: ${path}`);
  const packageBytes = byPath.get('package.json')!.bytes;
  const identityBytes = byPath.get('dist/build-identity.json')!.bytes;
  if (packageBytes.length > 1024 * 1024 || identityBytes.length > 64 * 1024) fail('identity file too large');
  let pkg: { name?: unknown; version?: unknown; type?: unknown; bin?: { ashlr?: unknown } };
  try { pkg = JSON.parse(packageBytes.toString('utf8')) as typeof pkg; }
  catch { return fail('invalid package.json'); }
  if (!pkg || pkg.name !== '@ashlr/hub' || pkg.version !== pins.version ||
      pkg.type !== 'module' || pkg.bin?.ashlr !== 'bin/ashlr' || !byPath.get('bin/ashlr')!.executable) {
    fail('package name, version, module type or launcher does not match');
  }
  const identity = parseBuildIdentity(identityBytes.toString('utf8'));
  if (!identity || identity.provenance !== 'git' || identity.dirty !== false ||
      identity.revision !== pins.revision || identity.packageVersion !== pins.version) {
    fail('clean Git build identity does not match pins');
  }
}

/** Admit an explicitly trusted, hash-pinned package without executing its code. */
export async function readPinnedRuntimeArchive(options: PinnedRuntimeArchiveOptions): Promise<VerifiedRuntimeArchive> {
  if (!SHA256.test(options.sha256) || !REVISION.test(options.revision) ||
      options.version.length > 128 || !VERSION.test(options.version)) fail('invalid artifact pins');
  const bytes = readArtifact(options.artifactPath);
  if (digest(bytes) !== options.sha256) fail('artifact SHA256 does not match pin');
  const entries = parseEntries(bytes);
  verifyPackage(entries, options);
  const archive: VerifiedRuntimeArchive = Object.freeze({
    pins: Object.freeze({ sha256: options.sha256, revision: options.revision, version: options.version,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, size: bytes.length }),
    entries: Object.freeze(entries),
  });
  admitted.set(archive, entries.map((entry) => digest(entry.bytes)));
  return archive;
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) fail('extraction directory must be private');
}

/** Extract only admitted bytes into a fresh, caller-owned private directory. */
export function extractPinnedRuntimeArchive(archive: VerifiedRuntimeArchive, packageRoot: string): void {
  const digests = admitted.get(archive);
  if (!digests) fail('archive was not admitted by this process');
  if (!isAbsolute(packageRoot) || realpathSync(packageRoot) !== resolve(packageRoot)) fail('extraction path is not canonical');
  privateDirectory(packageRoot);
  if (readdirSync(packageRoot).length !== 0) fail('extraction directory is not empty');
  for (let index = 0; index < archive.entries.length; index += 1) {
    if (digest(archive.entries[index]!.bytes) !== digests[index]) fail('admitted bytes changed before extraction');
  }
  const directories = new Set([packageRoot]);
  for (const entry of archive.entries) {
    const parts = entry.path.split('/');
    let parent = packageRoot;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      if (!directories.has(parent)) { mkdirSync(parent, { mode: 0o700 }); directories.add(parent); }
      privateDirectory(parent);
    }
    const path = join(packageRoot, entry.path);
    const mode = entry.executable ? 0o700 : 0o600;
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
    try {
      let offset = 0;
      while (offset < entry.bytes.length) {
        const count = writeSync(fd, entry.bytes, offset, entry.bytes.length - offset, offset);
        if (count <= 0) fail('extraction write made no progress');
        offset += count;
      }
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  for (const directory of [...directories].reverse()) fsyncDirectory(directory);
  fsyncDirectory(dirname(packageRoot));
}

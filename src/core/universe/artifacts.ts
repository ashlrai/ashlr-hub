import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync,
  openSync, readdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES = 8_192;

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

export function defaultUniverseRoot(): string { return join(homedir(), '.ashlr', 'universe'); }

/** Create only private, real directories; never follow a caller's symlink. */
export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    const parent = dirname(absolute);
    if (parent === absolute) throw new Error('Cannot create filesystem root');
    if (!existsSync(parent)) privateDirectory(parent);
    if (realpathSync(parent) !== parent) throw new Error('Universe storage path contains a symlink');
    mkdirSync(absolute, { mode: 0o700 });
  }
  return inspectPrivateDirectory(absolute);
}

/** Observation never creates a path, including when a directory vanishes mid-read. */
export function inspectPrivateDirectory(path: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) {
    throw new Error('Universe storage must be an owned private directory without symlinks');
  }
  return absolute;
}

export function ensureUniverseRoot(root?: string): string {
  const path = privateDirectory(root ?? defaultUniverseRoot());
  privateDirectory(join(path, 'demo-seeds'));
  return path;
}

export interface UniverseArtifactEntry { path: string; data: Buffer; executable: boolean }
type Entry = UniverseArtifactEntry;

/** Read bounded regular files while checking descriptor and path stability. */
function treeEntries(root: string): Entry[] {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Invalid artifact root');
  const entries: Entry[] = [];
  let bytes = 0;
  let count = 0;
  function visit(directory: string): void {
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Artifact directory changed');
    const names = readdirSync(directory).sort();
    for (const name of names) {
      if (++count > MAX_ARTIFACT_ENTRIES) throw new Error('Artifact entry limit exceeded');
      if (name === '.git' || name === '.ashlr') throw new Error('Artifact contains runtime or Git metadata');
      const path = join(directory, name);
      const named = lstatSync(path);
      if (named.isDirectory() && !named.isSymbolicLink()) { visit(path); continue; }
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
        throw new Error('Artifacts may contain only directories and regular single-link files');
      }
      if (named.size > MAX_ARTIFACT_BYTES - bytes) throw new Error('Artifact byte limit exceeded');
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== named.dev || opened.ino !== named.ino || !opened.isFile() || opened.nlink !== 1) {
          throw new Error('Artifact file changed before reading');
        }
        const data = readFileSync(fd);
        const after = fstatSync(fd);
        const installed = lstatSync(path);
        if (after.dev !== named.dev || after.ino !== named.ino || installed.dev !== named.dev ||
            installed.ino !== named.ino || installed.isSymbolicLink() || data.length !== named.size ||
            after.size !== named.size || after.mtimeMs !== named.mtimeMs || after.ctimeMs !== named.ctimeMs) {
          throw new Error('Artifact changed while reading');
        }
        bytes += data.length;
        if (bytes > MAX_ARTIFACT_BYTES) throw new Error('Artifact byte limit exceeded');
        entries.push({ path: relative(root, path).split(sep).join('/'), data, executable: (named.mode & 0o111) !== 0 });
      } finally { closeSync(fd); }
    }
    const after = lstatSync(directory);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs ||
        readdirSync(directory).sort().join('\0') !== names.join('\0')) throw new Error('Artifact tree changed');
  }
  visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function entriesDigest(entries: Entry[]): string {
  return digest(canonical(entries.map((entry) => ({
    path: entry.path, executable: entry.executable, size: entry.data.length, digest: digest(entry.data),
  }))));
}

export function artifactDigest(root: string): string { return entriesDigest(treeEntries(root)); }

/** One bounded, descriptor-checked snapshot binds the bytes subsequently delivered. */
export function readArtifactSnapshot(root: string): { entries: UniverseArtifactEntry[]; digest: string } {
  const entries = treeEntries(root);
  return { entries, digest: entriesDigest(entries) };
}

export function copyArtifact(source: string, destination: string): string {
  const entries = treeEntries(source);
  if (existsSync(destination)) throw new Error('Artifact destination already exists');
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of entries) {
    const target = join(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, entry.data, { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 });
  }
  return entriesDigest(entries);
}

export function freezeArtifact(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) freezeArtifact(path);
    else if (stat.isFile() && !stat.isSymbolicLink()) chmodSync(path, (stat.mode & 0o111) ? 0o500 : 0o400);
    else throw new Error('Cannot freeze non-regular artifact');
  }
  chmodSync(root, 0o500);
}

function git(repo: string, args: string[], maxBuffer = 4 * 1024 * 1024): Buffer {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
    timeout: 30_000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function pinSeed(repo: string, revision: string): { repo: string; revision: string } {
  if (!isAbsolute(repo)) throw new Error('Seed repository must be an absolute path');
  const physical = realpathSync(repo);
  const root = git(physical, ['rev-parse', '--show-toplevel']).toString().trim();
  if (realpathSync(root) !== physical) throw new Error('Seed path must be the Git repository root');
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(revision)) throw new Error('Seed revision must be a full immutable Git commit');
  const resolved = git(physical, ['rev-parse', '--verify', `${revision}^{commit}`]).toString().trim();
  if (resolved !== revision) throw new Error('Seed revision did not resolve to the exact commit');
  return { repo: physical, revision: resolved };
}

/** Materialize committed blobs only: no checkout hooks, working-tree changes, or Git metadata. */
export function materializeSeed(seed: { repo: string; revision: string }, destination: string): string {
  const list = git(seed.repo, ['ls-tree', '-rz', '--full-tree', seed.revision]).toString().split('\0').filter(Boolean);
  if (list.length > MAX_ARTIFACT_ENTRIES) throw new Error('Seed entry limit exceeded');
  const parsed = list.map((line) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(line);
    if (!match || match[3]!.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git' || part === '.ashlr')) {
      throw new Error('Seed may contain only regular files, without submodules or symbolic links');
    }
    return { mode: match[1], oid: match[2]!, path: match[3]! };
  });
  mkdirSync(destination, { mode: 0o700 });
  let bytes = 0;
  for (const entry of parsed) {
    const data = git(seed.repo, ['cat-file', 'blob', entry.oid], MAX_ARTIFACT_BYTES + 1);
    bytes += data.length;
    if (bytes > MAX_ARTIFACT_BYTES) throw new Error('Seed byte limit exceeded');
    const target = join(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, data, { flag: 'wx', mode: entry.mode === '100755' ? 0o700 : 0o600 });
  }
  return artifactDigest(destination);
}

export function executable(command: string[], cwd: string): string[] {
  const first = command[0]!;
  const candidates = first.includes('/')
    ? [resolve(cwd, first)]
    : (process.env.PATH ?? '/usr/bin:/bin').split(sep === '\\' ? ';' : ':').map((base) => join(base, first));
  for (const candidate of candidates) {
    try {
      const physical = realpathSync(candidate);
      const stat = lstatSync(physical);
      if (stat.isFile() && (stat.mode & 0o111)) return [physical, ...command.slice(1)];
    } catch { /* Try the next explicitly configured PATH location. */ }
  }
  throw new Error(`Executable unavailable: ${first}`);
}

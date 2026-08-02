import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SandboxLauncher } from '../sandbox/confine.js';
import { runVerifySubprocessAsync } from './verify-commands.js';

const SNAPSHOT_PREFIX = 'ashlr-verify-snapshot-';
const GIT_TIMEOUT_MS = 15_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 50_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const OBJECT_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface DeltaVerificationAuthority {
  root: string;
  baselinePath: string;
  candidatePath: string;
  launcher: SandboxLauncher;
  baseEnv: NodeJS.ProcessEnv;
  isolatedHomeParent: string;
  candidateDigest: string;
  confirmCandidateIdentity: () => boolean;
  cleanup: () => void;
}

export type DeltaVerificationAuthorityResult =
  | { available: true; authority: DeltaVerificationAuthority }
  | {
      available: false;
      cancelled?: boolean;
      reason:
        | 'cancelled'
        | 'trusted-git-unavailable'
        | 'git-authority-unavailable'
        | 'confinement-unavailable'
        | 'base-revision-unavailable'
        | 'base-archive-unavailable'
        | 'candidate-identity-unavailable'
        | 'baseline-materialization-failed'
        | 'candidate-materialization-failed'
        | 'candidate-snapshot-mismatch'
        | 'candidate-changed-during-snapshot'
        | 'snapshot-failed';
    };

interface AuthenticatedGitAuthority {
  markerPath: string;
  gitDir: string;
  indexPath: string;
}

function trustedOwnedExecutable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      const physical = realpathSync(candidate);
      const stat = statSync(physical);
      if (!stat.isFile()) continue;
      if (process.platform !== 'win32' && stat.uid !== 0) continue;
      return physical;
    } catch {
      // Try the next fixed system path.
    }
  }
  return null;
}

export function trustedGitPath(): string | null {
  if (process.platform === 'win32') return null;
  return trustedOwnedExecutable(['/usr/bin/git', '/bin/git']);
}

export function sanitizedToolEnv(root: string): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temp, { recursive: true, mode: 0o700 });
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ATTR_NOSYSTEM: '1',
  };
}

function strictMacLauncher(root: string): SandboxLauncher | null {
  const executable = trustedOwnedExecutable(['/usr/bin/sandbox-exec']);
  if (!executable) return null;
  const escaped = realpathSync(root).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${escaped}"))`,
    '(deny network*)',
  ].join('\n');
  return { bin: executable, prefixArgs: ['-p', profile] };
}

function strictLinuxLauncher(root: string): SandboxLauncher | null {
  const executable = trustedOwnedExecutable(['/usr/bin/bwrap', '/bin/bwrap']);
  if (!executable) return null;
  return {
    bin: executable,
    prefixArgs: [
      '--ro-bind', '/', '/',
      '--bind', root, root,
      '--tmpfs', '/tmp',
      '--proc', '/proc',
      '--dev', '/dev',
      '--die-with-parent',
      '--unshare-net',
      '--',
    ],
  };
}

function strictVerificationLauncher(root: string): SandboxLauncher | null {
  if (process.platform === 'darwin') return strictMacLauncher(root);
  if (process.platform === 'linux') return strictLinuxLauncher(root);
  return null;
}

function hashFile(path: string, hash: ReturnType<typeof createHash>): number {
  const stat = lstatSync(path);
  if (stat.size > MAX_FILE_BYTES) throw new Error('snapshot file limit exceeded');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  try {
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return total;
}

function authenticatedGitAuthority(worktreePath: string): AuthenticatedGitAuthority | null {
  const marker = join(worktreePath, '.git');
  try {
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const raw = readFileSync(marker, 'utf8').trim();
    if (!/^gitdir: [^\r\n]+$/.test(raw)) return null;
    const gitDir = realpathSync(resolve(worktreePath, raw.slice('gitdir: '.length)));
    const gitDirStat = lstatSync(gitDir);
    if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) return null;
    const relativeGitDir = relative(worktreePath, gitDir);
    if (!relativeGitDir.startsWith('..') || isAbsolute(relativeGitDir)) return null;

    // Linked worktrees contain a reciprocal pointer in the external gitdir.
    // The agent can edit the in-worktree marker, but cannot forge this file
    // outside its write jail; require both directions to agree exactly.
    const backpointer = join(gitDir, 'gitdir');
    const backpointerStat = lstatSync(backpointer);
    if (!backpointerStat.isFile() || backpointerStat.isSymbolicLink() || backpointerStat.size > 4096) {
      return null;
    }
    const backpointerRaw = readFileSync(backpointer, 'utf8').trim();
    if (!backpointerRaw || /[\r\n]/.test(backpointerRaw)) return null;
    const reciprocalMarker = resolve(gitDir, backpointerRaw);
    if (reciprocalMarker !== resolve(marker)) return null;
    return { markerPath: marker, gitDir, indexPath: join(gitDir, 'index') };
  } catch {
    return null;
  }
}

function candidateTreeIdentity(worktreePath: string): string {
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;

  const visit = (dir: string, relDir: string): void => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      if (relDir === '' && name === '.git') continue;
      const rel = relDir ? `${relDir}/${name}` : name;
      const path = join(dir, name);
      const stat = lstatSync(path);
      files += 1;
      if (files > MAX_FILES) throw new Error('snapshot file count limit exceeded');
      hash.update(`${rel}\0${stat.mode & 0o7777}\0`);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        hash.update('directory\0');
        visit(path, rel);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        hash.update(`file\0${stat.size}\0`);
        bytes += hashFile(path, hash);
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        hash.update(`symlink\0${target}\0`);
      } else {
        throw new Error('unsupported candidate filesystem entry');
      }
      if (bytes > MAX_TOTAL_BYTES) throw new Error('snapshot byte limit exceeded');
    }
  };

  visit(worktreePath, '');
  return hash.digest('hex');
}

function candidateIdentity(
  worktreePath: string,
  git: AuthenticatedGitAuthority,
  treeDigest = candidateTreeIdentity(worktreePath),
): string {
  const hash = createHash('sha256');
  let bytes = 0;
  hash.update(`tree\0${treeDigest}\0`);
  hash.update('git-marker\0');
  bytes += hashFile(git.markerPath, hash);
  hash.update('index\0');
  if (existsSync(git.indexPath)) bytes += hashFile(git.indexPath, hash);
  else hash.update('missing\0');
  if (bytes > MAX_TOTAL_BYTES) throw new Error('snapshot byte limit exceeded');
  return hash.digest('hex');
}

function copyCandidateTree(source: string, destination: string): void {
  let files = 0;
  let bytes = 0;
  const copy = (sourceDir: string, destinationDir: string, relDir: string): void => {
    mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(sourceDir).sort()) {
      if (relDir === '' && name === '.git') continue;
      const rel = relDir ? `${relDir}/${name}` : name;
      const from = join(sourceDir, name);
      const to = join(destinationDir, name);
      const stat = lstatSync(from);
      files += 1;
      if (files > MAX_FILES) throw new Error('snapshot file count limit exceeded');
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        copy(from, to, rel);
        chmodSync(to, stat.mode & 0o777);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        if (stat.size > MAX_FILE_BYTES) throw new Error('snapshot file limit exceeded');
        bytes += stat.size;
        if (bytes > MAX_TOTAL_BYTES) throw new Error('snapshot byte limit exceeded');
        copyFileSync(from, to);
        chmodSync(to, stat.mode & 0o777);
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(from);
        symlinkSync(target, to);
      } else {
        throw new Error('unsupported candidate filesystem entry');
      }
    }
  };
  copy(source, destination, '');
}

function tarString(header: Buffer, start: number, length: number): string {
  const end = header.indexOf(0, start);
  const stop = end >= start && end < start + length ? end : start + length;
  return header.subarray(start, stop).toString('utf8');
}

function tarOctal(header: Buffer, start: number, length: number): number {
  const raw = tarString(header, start, length).trim().replace(/\0/g, '');
  if (!/^[0-7]*$/.test(raw)) throw new Error('invalid tar numeric field');
  return raw ? Number.parseInt(raw, 8) : 0;
}

function safeArchivePath(root: string, value: string): string {
  if (!value || value.includes('\0') || isAbsolute(value)) throw new Error('unsafe archive path');
  const destination = resolve(root, value);
  const rel = relative(root, destination);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('archive path escaped snapshot');
  return destination;
}

function extractGitArchive(archivePath: string, destination: string): void {
  const archive = readFileSync(archivePath);
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('baseline archive limit exceeded');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const pendingLinks: Array<{ path: string; target: string }> = [];
  const symlinkPaths = new Set<string>();
  let files = 0;
  let bytes = 0;
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expectedChecksum = tarOctal(header, 148, 8);
    let checksum = 0;
    for (let i = 0; i < 512; i += 1) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (checksum !== expectedChecksum) throw new Error('baseline archive checksum mismatch');
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const pathName = prefix ? `${prefix}/${name}` : name;
    const mode = tarOctal(header, 100, 8) & 0o777;
    const size = tarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length || size > MAX_FILE_BYTES) throw new Error('invalid archive entry size');
    if (type === 'g') {
      const globalHeader = archive.subarray(dataStart, dataEnd).toString('utf8');
      const match = /^(\d+) comment=((?:[a-f0-9]{40}|[a-f0-9]{64}))\n$/.exec(globalHeader);
      if (
        pathName !== 'pax_global_header' ||
        size > 128 ||
        !match ||
        Number.parseInt(match[1]!, 10) !== Buffer.byteLength(globalHeader) ||
        !OBJECT_ID_RE.test(match[2]!)
      ) throw new Error('invalid global archive metadata');
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    const normalized = pathName.replace(/\/$/, '');
    const destinationPath = safeArchivePath(destination, normalized);
    const rel = relative(destination, destinationPath).split(sep).join('/');
    if ([...symlinkPaths].some((link) => rel === link || rel.startsWith(`${link}/`))) {
      throw new Error('archive entry traversed a symlink');
    }
    files += 1;
    if (files > MAX_FILES) throw new Error('baseline archive file count exceeded');
    if (type === '5') {
      mkdirSync(destinationPath, { recursive: true, mode: mode || 0o755 });
    } else if (type === '0' || type === '\0') {
      bytes += size;
      if (bytes > MAX_TOTAL_BYTES) throw new Error('baseline archive byte limit exceeded');
      mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
      const data = archive.subarray(dataStart, dataEnd);
      const token = randomBytes(8).toString('hex');
      const tempPath = `${destinationPath}.${token}.tmp`;
      writeFileSync(tempPath, data, { mode: mode || 0o600 });
      renameSync(tempPath, destinationPath);
      chmodSync(destinationPath, mode || 0o600);
    } else if (type === '2') {
      const target = tarString(header, 157, 100);
      if (!target || target.includes('\0')) throw new Error('invalid archive symlink');
      symlinkPaths.add(rel);
      pendingLinks.push({ path: destinationPath, target });
    } else {
      throw new Error('unsupported baseline archive entry');
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  for (const link of pendingLinks) {
    mkdirSync(dirname(link.path), { recursive: true, mode: 0o700 });
    symlinkSync(link.target, link.path);
  }
}

async function runTrustedGit(
  git: string,
  authority: AuthenticatedGitAuthority,
  worktreePath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  return runVerifySubprocessAsync([
    git,
    `--git-dir=${authority.gitDir}`,
    `--work-tree=${worktreePath}`,
    '--no-pager',
    ...args,
  ], {
    cwd: worktreePath,
    env,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
}

export async function prepareDeltaVerificationAuthority(
  worktreePath: string,
  signal?: AbortSignal,
): Promise<DeltaVerificationAuthorityResult> {
  if (signal?.aborted) return { available: false, cancelled: true, reason: 'cancelled' };
  const git = trustedGitPath();
  if (!git) return { available: false, reason: 'trusted-git-unavailable' };
  const gitAuthority = authenticatedGitAuthority(worktreePath);
  if (!gitAuthority) return { available: false, reason: 'git-authority-unavailable' };
  const root = mkdtempSync(join(tmpdir(), SNAPSHOT_PREFIX));
  const cleanup = (): void => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* bounded temp cleanup */ }
  };
  let failureReason: Extract<DeltaVerificationAuthorityResult, { available: false }>['reason'] =
    'snapshot-failed';
  try {
    const launcher = strictVerificationLauncher(root);
    if (!launcher) {
      cleanup();
      return { available: false, reason: 'confinement-unavailable' };
    }
    const env = sanitizedToolEnv(root);
    const headResult = await runTrustedGit(
      git,
      gitAuthority,
      worktreePath,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      env,
      signal,
    );
    if (headResult.cancelled || signal?.aborted) {
      cleanup();
      return { available: false, cancelled: true, reason: 'cancelled' };
    }
    const baseHead = headResult.stdout.trim().toLowerCase();
    if (headResult.error || headResult.timedOut || headResult.exitCode !== 0 || !OBJECT_ID_RE.test(baseHead)) {
      cleanup();
      return { available: false, reason: 'base-revision-unavailable' };
    }
    const archivePath = join(root, 'baseline.tar');
    const archiveResult = await runTrustedGit(
      git,
      gitAuthority,
      worktreePath,
      ['archive', '--format=tar', `--output=${archivePath}`, baseHead],
      env,
      signal,
    );
    if (archiveResult.cancelled || signal?.aborted) {
      cleanup();
      return { available: false, cancelled: true, reason: 'cancelled' };
    }
    if (archiveResult.error || archiveResult.timedOut || archiveResult.exitCode !== 0) {
      cleanup();
      return { available: false, reason: 'base-archive-unavailable' };
    }
    const baselinePath = join(root, 'baseline');
    const candidatePath = join(root, 'candidate');
    failureReason = 'candidate-identity-unavailable';
    const beforeTree = candidateTreeIdentity(worktreePath);
    const before = candidateIdentity(worktreePath, gitAuthority, beforeTree);
    failureReason = 'baseline-materialization-failed';
    extractGitArchive(archivePath, baselinePath);
    const sourceModules = join(worktreePath, 'node_modules');
    const baselineModules = join(baselinePath, 'node_modules');
    if (!existsSync(baselineModules)) {
      try {
        const modulesStat = lstatSync(sourceModules);
        if (modulesStat.isDirectory() || modulesStat.isSymbolicLink()) {
          symlinkSync(realpathSync(sourceModules), baselineModules);
        }
      } catch {
        // Repositories without installed dependencies remain valid.
      }
    }
    failureReason = 'candidate-materialization-failed';
    copyCandidateTree(worktreePath, candidatePath);
    failureReason = 'candidate-snapshot-mismatch';
    if (candidateTreeIdentity(candidatePath) !== beforeTree) {
      cleanup();
      return { available: false, reason: 'candidate-snapshot-mismatch' };
    }
    failureReason = 'candidate-identity-unavailable';
    const afterTree = candidateTreeIdentity(worktreePath);
    const afterCopy = candidateIdentity(worktreePath, gitAuthority, afterTree);
    if (before !== afterCopy) {
      cleanup();
      return { available: false, reason: 'candidate-changed-during-snapshot' };
    }
    rmSync(archivePath, { force: true });
    return {
      available: true,
      authority: {
        root,
        baselinePath,
        candidatePath,
        launcher,
        baseEnv: env,
        isolatedHomeParent: root,
        candidateDigest: before,
        confirmCandidateIdentity: () => {
          try { return candidateIdentity(worktreePath, gitAuthority) === before; } catch { return false; }
        },
        cleanup,
      },
    };
  } catch {
    cleanup();
    return signal?.aborted
      ? { available: false, cancelled: true, reason: 'cancelled' }
      : { available: false, reason: failureReason };
  }
}

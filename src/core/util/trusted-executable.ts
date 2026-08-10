import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { userInfo } from 'node:os';
import {
  delimiter,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';

import { assurePrivateStoragePath } from './private-storage.js';

const MAX_ACL_OUTPUT_BYTES = 64 * 1024;
const MACOS_MUTATING_ACL_RIGHTS = new Set([
  'add_file',
  'add_subdirectory',
  'append',
  'chown',
  'delete',
  'delete_child',
  'directory_inherit',
  'file_inherit',
  'write',
  'writeattr',
  'writeextattr',
  'writesecurity',
]);

export interface PathCustodyProof {
  canonicalPath: string;
  digest: string;
}

export interface TrustedExecutablePin extends PathCustodyProof {
  executable: string;
}

interface PosixHierarchyOptions {
  leafKind: 'file' | 'directory';
  requireCurrentUserLeaf: boolean;
  allowTrustedInstallGroupWrite?: boolean;
  allowedRoots?: readonly string[];
  untrustedRoots?: readonly string[];
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalIfPresent(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function macosAclSafe(path: string): boolean {
  if (process.platform !== 'darwin') return true;
  const result = spawnSync('/bin/ls', ['-led', path], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', NO_COLOR: '1' },
    maxBuffer: MAX_ACL_OUTPUT_BYTES,
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string' ||
      Buffer.byteLength(result.stdout, 'utf8') > MAX_ACL_OUTPUT_BYTES) return false;
  const lines = result.stdout.split(/\r?\n/);
  const username = userInfo().username;
  for (const line of lines.slice(1).filter((value) => value.trim().length > 0)) {
    const match = line.match(/^\s*\d+:\s+(.+?)\s+(allow|deny)\s+(.+)$/);
    if (!match) return false;
    const principal = match[1]!;
    if (match[2] === 'deny' || principal === `user:${username}` || principal === 'user:root') continue;
    const rights = match[3]!.split(/[\s,]+/).filter(Boolean);
    if (rights.some((right) => MACOS_MUTATING_ACL_RIGHTS.has(right))) return false;
  }
  return true;
}

function macosInstallGroupSafe(gid: bigint): boolean {
  if (process.platform !== 'darwin') return false;
  const runDscl = (args: string[]): string | null => {
    const result = spawnSync('/usr/bin/dscl', ['.', ...args], {
      encoding: 'utf8',
      env: { LC_ALL: 'C', NO_COLOR: '1' },
      maxBuffer: MAX_ACL_OUTPUT_BYTES,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      windowsHide: true,
    });
    return !result.error && result.status === 0 && typeof result.stdout === 'string' &&
      Buffer.byteLength(result.stdout, 'utf8') <= MAX_ACL_OUTPUT_BYTES
      ? result.stdout
      : null;
  };
  const groupSearch = runDscl(['-search', '/Groups', 'PrimaryGroupID', gid.toString()]);
  const groupName = groupSearch?.match(/^([^\s]+)\s+PrimaryGroupID/m)?.[1];
  if (!groupName || !/^[A-Za-z0-9_.-]+$/.test(groupName)) return false;
  const username = userInfo().username;
  const groupRecord = runDscl(['-read', `/Groups/${groupName}`]);
  const primaryUsers = runDscl(['-search', '/Users', 'PrimaryGroupID', gid.toString()]);
  if (groupRecord === null || primaryUsers === null) return false;
  const members = groupRecord.match(/^GroupMembership:\s*(.*)$/m)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const primaryNames = primaryUsers.split(/\r?\n/)
    .map((line) => line.match(/^([^\s]+)\s+PrimaryGroupID/)?.[1])
    .filter((value): value is string => value !== undefined);
  const nestedValues = groupRecord.match(/^NestedGroups:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const safe = [...members, ...primaryNames].every((member) => member === username || member === 'root') &&
    nestedValues.length === 0;
  return safe;
}

function snapshotStat(path: string, stat: BigIntStats): string[] {
  return [
    path,
    stat.dev.toString(),
    stat.ino.toString(),
    stat.mode.toString(),
    stat.uid.toString(),
    stat.gid.toString(),
    stat.nlink.toString(),
    stat.size.toString(),
    stat.mtimeNs.toString(),
    stat.ctimeNs.toString(),
  ];
}

function inspectPosixHierarchy(path: string, options: PosixHierarchyOptions): PathCustodyProof | null {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
  try {
    const absolute = resolve(path);
    if (!isAbsolute(absolute) || realpathSync(absolute) !== absolute) return null;
    const canonicalAllowedRoots = (options.allowedRoots ?? []).map(canonicalIfPresent);
    if (canonicalAllowedRoots.length > 0 && !canonicalAllowedRoots.some((root) => contained(root, absolute))) {
      return null;
    }
    const canonicalUntrustedRoots = (options.untrustedRoots ?? []).map(canonicalIfPresent);
    if (canonicalUntrustedRoots.some((root) => contained(root, absolute))) return null;

    const root = parse(absolute).root;
    const segments = relative(root, absolute).split(sep).filter(Boolean);
    const snapshot: string[][] = [];
    let cursor = root;
    for (let index = -1; index < segments.length; index += 1) {
      if (index >= 0) cursor = join(cursor, segments[index]!);
      const stat = lstatSync(cursor, { bigint: true });
      const leaf = index === segments.length - 1;
      if (stat.isSymbolicLink() || (leaf
        ? options.leafKind === 'file' ? !stat.isFile() : !stat.isDirectory()
        : !stat.isDirectory())) return null;
      if (stat.uid !== 0n && stat.uid !== BigInt(process.getuid())) return null;
      if (leaf && options.requireCurrentUserLeaf && stat.uid !== BigInt(process.getuid())) return null;
      const otherWritable = (stat.mode & 0o002n) !== 0n;
      const groupWritable = (stat.mode & 0o020n) !== 0n;
      const rootStickyDirectory = stat.isDirectory() && stat.uid === 0n && (stat.mode & 0o1000n) !== 0n;
      const trustedInstallGroup = options.allowTrustedInstallGroupWrite === true &&
        stat.uid === BigInt(process.getuid()) && macosInstallGroupSafe(stat.gid);
      if ((otherWritable && !rootStickyDirectory) || (groupWritable && !trustedInstallGroup)) return null;
      if (!macosAclSafe(cursor)) return null;
      snapshot.push(snapshotStat(cursor, stat));
    }
    return {
      canonicalPath: absolute,
      digest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    };
  } catch {
    return null;
  }
}

export function inspectOwnedAuthorityPath(path: string, anchorPath: string): PathCustodyProof | null {
  const absolute = resolve(path);
  const anchor = resolve(anchorPath);
  if (!contained(anchor, absolute)) return null;
  if (process.platform === 'win32') {
    const assurance = assurePrivateStoragePath(absolute, 'file', 'inspect-owned', { anchorPath: anchor });
    if (!assurance.ok) return null;
    try {
      const canonicalPath = realpathSync(absolute);
      const stat = lstatSync(canonicalPath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      return {
        canonicalPath,
        digest: createHash('sha256').update(JSON.stringify(snapshotStat(canonicalPath, stat))).digest('hex'),
      };
    } catch {
      return null;
    }
  }
  try {
    const canonicalAnchor = realpathSync(anchor);
    const canonicalPath = realpathSync(absolute);
    if (canonicalAnchor !== anchor || canonicalPath !== absolute ||
        relative(anchor, absolute) !== relative(canonicalAnchor, canonicalPath)) return null;
    return inspectPosixHierarchy(canonicalPath, {
      leafKind: 'file',
      requireCurrentUserLeaf: true,
      allowedRoots: [canonicalAnchor],
    });
  } catch {
    return null;
  }
}

function trustedGithubRoots(): string[] {
  if (process.platform === 'darwin') return ['/usr', '/opt/homebrew'];
  if (process.platform === 'linux') return ['/usr', '/opt/homebrew', '/home/linuxbrew/.linuxbrew'];
  return [];
}

function inspectTrustedGithubExecutable(
  executable: string,
  untrustedRoots: readonly string[],
): TrustedExecutablePin | null {
  if (process.platform === 'win32') return null;
  try {
    const canonical = realpathSync(executable);
    accessSync(canonical, fsConstants.X_OK);
    const proof = inspectPosixHierarchy(canonical, {
      leafKind: 'file',
      requireCurrentUserLeaf: false,
      allowTrustedInstallGroupWrite: true,
      allowedRoots: trustedGithubRoots(),
      untrustedRoots,
    });
    if (!proof) return null;
    const leaf = lstatSync(canonical, { bigint: true });
    if (leaf.nlink !== 1n || (leaf.mode & 0o111n) === 0n) return null;
    return { ...proof, executable: canonical };
  } catch {
    return null;
  }
}

export function resolveTrustedGithubCli(untrustedRoots: readonly string[] = []): TrustedExecutablePin | null {
  for (const part of (process.env.PATH ?? '').split(delimiter)) {
    if (!part || !isAbsolute(part)) continue;
    const pin = inspectTrustedGithubExecutable(join(part, process.platform === 'win32' ? 'gh.exe' : 'gh'), untrustedRoots);
    if (pin) return pin;
  }
  return null;
}

export function verifyTrustedGithubCli(
  pin: TrustedExecutablePin,
  untrustedRoots: readonly string[] = [],
): boolean {
  if (!pin || typeof pin !== 'object' || typeof pin.executable !== 'string' ||
      typeof pin.canonicalPath !== 'string' || typeof pin.digest !== 'string' ||
      pin.executable !== pin.canonicalPath || !isAbsolute(pin.executable) ||
      !/^[0-9a-f]{64}$/.test(pin.digest)) return false;
  const observed = inspectTrustedGithubExecutable(pin.executable, untrustedRoots);
  return observed !== null && observed.executable === pin.executable && observed.digest === pin.digest;
}

export function trustedGithubEnvironment(): NodeJS.ProcessEnv {
  const account = userInfo();
  const env: NodeJS.ProcessEnv = {
    HOME: account.homedir,
    USER: account.username,
  };
  for (const key of ['SystemRoot', 'WINDIR', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    GH_HOST: 'github.com',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PAGER: 'cat',
    GH_PROMPT_DISABLED: '1',
    LC_ALL: 'C',
    NO_COLOR: '1',
  };
}

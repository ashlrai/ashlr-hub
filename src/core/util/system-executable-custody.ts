import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

const MAX_ACL_BYTES = 64 * 1024;
const MACOS_MUTATING_ACL_RIGHTS = new Set([
  'add_file', 'add_subdirectory', 'append', 'chown', 'delete', 'delete_child',
  'directory_inherit', 'file_inherit', 'write', 'writeattr', 'writeextattr',
  'writesecurity',
]);

export interface SystemExecutablePin {
  executable: string;
  canonicalPath: string;
  digest: string;
}

function macosAclSafe(path: string): boolean {
  if (process.platform !== 'darwin') return true;
  const result = spawnSync('/bin/ls', ['-led', path], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', NO_COLOR: '1' },
    maxBuffer: MAX_ACL_BYTES,
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string' ||
      Buffer.byteLength(result.stdout, 'utf8') > MAX_ACL_BYTES) return false;
  const username = userInfo().username;
  for (const line of result.stdout.split(/\r?\n/).slice(1).filter((entry) => entry.trim())) {
    const match = line.match(/^\s*\d+:\s+(.+?)\s+(allow|deny)\s+(.+)$/);
    if (!match) return false;
    const principal = match[1]!;
    if (match[2] === 'deny' || principal === 'user:root') {
      continue;
    }
    const mutating = match[3]!.split(/[\s,]+/).some((right) => MACOS_MUTATING_ACL_RIGHTS.has(right));
    if (mutating && (principal === `user:${username}` || principal !== 'user:root')) {
      return false;
    }
  }
  return true;
}

function contained(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested));
}

function inspectRootOwnedExecutable(
  executable: string,
  options: { allowed?: readonly string[]; untrustedRoots?: readonly string[] } = {},
): SystemExecutablePin | null {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' ||
      !isAbsolute(executable) || resolve(executable) !== executable) return null;
  try {
    const canonical = realpathSync(executable);
    if (canonical !== executable) return null;
    if (options.allowed && !options.allowed.includes(canonical)) return null;
    const untrusted = (options.untrustedRoots ?? []).map((root) => {
      try { return realpathSync(resolve(root)); } catch { return resolve(root); }
    });
    if (untrusted.some((root) => contained(root, canonical))) return null;

    const filesystemRoot = parse(canonical).root;
    const segments = relative(filesystemRoot, canonical).split(sep).filter(Boolean);
    const snapshot: string[][] = [];
    let cursor = filesystemRoot;
    for (let index = -1; index < segments.length; index += 1) {
      if (index >= 0) cursor = `${cursor}${cursor.endsWith(sep) ? '' : sep}${segments[index]!}`;
      const stat = lstatSync(cursor, { bigint: true });
      const leaf = index === segments.length - 1;
      if (stat.isSymbolicLink() || stat.uid !== 0n ||
          (leaf ? !stat.isFile() : !stat.isDirectory()) ||
          (stat.mode & 0o022n) !== 0n || !macosAclSafe(cursor)) return null;
      if (leaf && (stat.nlink < 1n || (stat.mode & 0o111n) === 0n)) return null;
      snapshot.push([
        cursor, stat.dev.toString(), stat.ino.toString(), stat.mode.toString(),
        stat.uid.toString(), stat.gid.toString(), stat.nlink.toString(),
        stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(),
      ]);
    }
    accessSync(canonical, fsConstants.X_OK);
    return {
      executable: canonical,
      canonicalPath: canonical,
      digest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    };
  } catch {
    return null;
  }
}

export function resolveTrustedSystemGit(
  untrustedRoots: readonly string[] = [],
): SystemExecutablePin | null {
  const allowed = process.platform === 'darwin' || process.platform === 'linux'
    ? ['/usr/bin/git']
    : [];
  for (const executable of allowed) {
    const pin = inspectRootOwnedExecutable(executable, { allowed, untrustedRoots });
    if (pin) return pin;
  }
  return null;
}

export function resolveTrustedConfiguredExecutable(
  executable: string,
  untrustedRoots: readonly string[] = [],
): SystemExecutablePin | null {
  return inspectRootOwnedExecutable(executable, { untrustedRoots });
}

export function verifySystemExecutablePin(
  pin: SystemExecutablePin,
  options: { git?: boolean; untrustedRoots?: readonly string[] } = {},
): boolean {
  if (!pin || pin.executable !== pin.canonicalPath || !/^[0-9a-f]{64}$/.test(pin.digest)) return false;
  const observed = options.git
    ? resolveTrustedSystemGit(options.untrustedRoots)
    : inspectRootOwnedExecutable(pin.executable, { untrustedRoots: options.untrustedRoots });
  return observed !== null && observed.executable === pin.executable && observed.digest === pin.digest;
}

export function trustedGitEnvironment(pin: SystemExecutablePin): NodeJS.ProcessEnv {
  const account = userInfo();
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return {
    HOME: account.homedir,
    USER: account.username,
    PATH: [dirname(pin.executable), '/usr/bin', '/bin'].filter((value, index, values) =>
      values.indexOf(value) === index).join(delimiter),
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
    NO_COLOR: '1',
    PAGER: 'cat',
  };
}

/** Prepare fresh owner-scoped native state without reading credentials or starting a native process. */
import { accessSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';

export type ResourceNativeProfileProvider = 'codex' | 'claude' | 'grok';
export interface ResourceNativeProfileOptions { provider: ResourceNativeProfileProvider; directory: string; executable: string }
export interface ResourceNativeProfile {
  schemaVersion: 1;
  scope: 'native-profile-preparation';
  status: 'prepared';
  authentication: 'not-checked';
  provider: ResourceNativeProfileProvider;
  directory: string;
  executable: string;
  nodeExecutable: string;
  commandPath: string;
  launcherPath: string;
  nativeStatePath: string;
  anthropicStatePath: string | null;
  manifestPath: string;
  command: string[];
  loginCommand: string[];
}

function path(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 4096 && isAbsolute(value) && resolve(value) === value &&
    parse(value).root !== value && [...value].every((character) => { const code = character.charCodeAt(0); return code >= 32 && (code < 127 || code > 159); });
}
function executable(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.mode & 0o022) throw new Error();
  accessSync(path, constants.X_OK);
}
function same(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino; }

/** Standalone source deliberately has no dependency on an installed Hub path. */
function launcherSource(profile: ResourceNativeProfile, directories: Array<{ path: string; dev: string; ino: string }>): string {
  return `// Generated private native profile. Owner-editable configuration, not an authentication attestation.
import {accessSync,constants,lstatSync,realpathSync} from 'node:fs';
const profile=${JSON.stringify({ provider: profile.provider, executable: profile.executable, nativeStatePath: profile.nativeStatePath,
    anthropicStatePath: profile.anthropicStatePath, launcherPath: profile.launcherPath })};
const directories=${JSON.stringify(directories)};
const fail=()=>{process.stderr.write('Native profile launcher unavailable or conflicting authentication override\\n');process.exit(126);};
try {
  if(typeof process.execve!=='function')fail();
  for(const row of directories){const stat=lstatSync(row.path,{bigint:true});
    if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(row.path)!==row.path||stat.dev.toString()!==row.dev||stat.ino.toString()!==row.ino||
      (stat.mode&511n)!==448n||typeof process.getuid==='function'&&stat.uid!==BigInt(process.getuid()))fail();}
  const source=lstatSync(profile.launcherPath);if(!source.isFile()||source.isSymbolicLink()||source.nlink!==1||(source.mode&511)!==384||
    realpathSync(profile.launcherPath)!==profile.launcherPath||typeof process.getuid==='function'&&source.uid!==process.getuid())fail();
  const native=lstatSync(profile.executable);if(!native.isFile()||native.isSymbolicLink()||native.mode&18||realpathSync(profile.executable)!==profile.executable)fail();
  accessSync(profile.executable,constants.X_OK);
  const args=process.argv.slice(2);const env={};
  for(const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL'])if(process.env[key]!==undefined)env[key]=process.env[key];
  let fixed=[];
  if(profile.provider==='codex'){
    // Only simple unquoted bare/dotted configuration keys are supported. This
    // keeps Hub's analytics.enabled=false usable without a partial TOML parser.
    for(let index=0;index<args.length;index++){
      const arg=args[index];let assignment;
      if(arg==='-c'||arg==='--config')assignment=args[++index];
      else if(arg.startsWith('--config='))assignment=arg.slice(9);
      else if(arg.startsWith('-c='))assignment=arg.slice(3);
      else if(arg.startsWith('-c')&&arg.length>2)assignment=arg.slice(2);
      if(assignment!==undefined){
        const match=/^\\s*([A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*)\\s*=/.exec(assignment);
        if(!match||match[1]==='cli_auth_credentials_store'||match[1]==='forced_login_method')fail();
      }
    }
    env.CODEX_HOME=profile.nativeStatePath;
    fixed=['-c','cli_auth_credentials_store="file"','-c','forced_login_method="chatgpt"'];
  }else if(profile.provider==='grok'){
    // The caller supplies --no-auto-update for login/metadata; do not duplicate it.
    env.GROK_HOME=profile.nativeStatePath;
  }else{
    env.CLAUDE_CONFIG_DIR=profile.nativeStatePath;env.ANTHROPIC_CONFIG_DIR=profile.anthropicStatePath;env.DISABLE_UPDATES='1';
  }
  // POSIX exec keeps the caller's PID, process group and standard descriptors.
  // Node 22/24 can abort on an OS-level execve failure; the owner observes that
  // native process outcome. Preflight does not eliminate filesystem races.
  process.execve(profile.executable,[profile.executable,...fixed,...args],env);
}catch{fail();}
`;
}

/**
 * Exclusive private leaf only. Existing paths are never reused, removed, repaired
 * or overwritten. A failed write may leave a partial directory for inspection.
 * Native login remains a separate operation through the generated command.
 */
export function prepareResourceNativeProfile(options: ResourceNativeProfileOptions): ResourceNativeProfile {
  let parent: string; let parentStat: BigIntStats; let nodeExecutable: string;
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Reflect.ownKeys(options).length !== 3 ||
      !['provider', 'directory', 'executable'].every((key) => Object.hasOwn(options, key) &&
        'value' in Object.getOwnPropertyDescriptor(options, key)!) || !['codex', 'claude', 'grok'].includes(options.provider) ||
      !path(options.directory) || !path(options.executable) || typeof process.execve !== 'function' ||
      process.platform === 'win32' || process.platform === 'aix') throw new Error();
    parent = dirname(options.directory); inspectPrivateDirectory(parent); parentStat = lstatSync(parent, { bigint: true });
    executable(options.executable); nodeExecutable = realpathSync(process.execPath); executable(nodeExecutable);
  } catch { throw new Error('Invalid native profile configuration, executable, runtime or private parent'); }
  const profile: ResourceNativeProfile = { schemaVersion: 1, scope: 'native-profile-preparation', status: 'prepared', authentication: 'not-checked',
    provider: options.provider, directory: options.directory, executable: options.executable, nodeExecutable,
    commandPath: join(options.directory, 'command.json'), launcherPath: join(options.directory, 'launcher.mjs'),
    nativeStatePath: join(options.directory, 'native-state'), anthropicStatePath: options.provider === 'claude' ? join(options.directory, 'anthropic-state') : null,
    manifestPath: join(options.directory, 'profile.json'), command: [], loginCommand: [] };
  profile.command = [nodeExecutable, profile.launcherPath];
  profile.loginCommand = [...profile.command, ...(profile.provider === 'codex' ? ['login']
    : profile.provider === 'grok' ? ['--no-auto-update', 'login', '--oauth'] : ['auth', 'login', '--claudeai'])];
  try {
    inspectPrivateDirectory(parent);
    if (!same(parentStat, lstatSync(parent, { bigint: true }))) throw new Error();
    mkdirSync(profile.directory, { mode: 0o700 });
  } catch { throw new Error('Native profile directory must be new and its private parent unchanged'); }
  const owned: Array<{ path: string; stat: BigIntStats }> = [];
  try {
    inspectPrivateDirectory(profile.directory); owned.push({ path: profile.directory, stat: lstatSync(profile.directory, { bigint: true }) });
    const assertOwned = (): void => {
      inspectPrivateDirectory(parent); if (!same(parentStat, lstatSync(parent, { bigint: true }))) throw new Error();
      for (const row of owned) { inspectPrivateDirectory(row.path); if (!same(row.stat, lstatSync(row.path, { bigint: true }))) throw new Error(); }
    };
    for (const directory of [profile.nativeStatePath, ...(profile.anthropicStatePath ? [profile.anthropicStatePath] : [])]) {
      assertOwned(); mkdirSync(directory, { mode: 0o700 }); inspectPrivateDirectory(directory);
      owned.push({ path: directory, stat: lstatSync(directory, { bigint: true }) });
    }
    const write = (file: string, text: string): void => {
      assertOwned(); let fd: number | undefined;
      try {
        fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const before = fstatSync(fd, { bigint: true }); const named = lstatSync(file, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size !== 0n || !same(before, named) || named.isSymbolicLink() ||
          (before.mode & 0o777n) !== 0o600n || typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) throw new Error();
        assertOwned(); const bytes = Buffer.from(text); let offset = 0;
        while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); if (written < 1) throw new Error(); offset += written; }
        fsyncSync(fd); const after = fstatSync(fd, { bigint: true }); const installed = lstatSync(file, { bigint: true });
        if (!same(before, after) || !same(before, installed) || installed.isSymbolicLink() || after.nlink !== 1n ||
          after.size !== BigInt(bytes.length) || (after.mode & 0o777n) !== 0o600n) throw new Error();
        assertOwned();
      } finally { if (fd !== undefined) closeSync(fd); }
    };
    write(profile.launcherPath, launcherSource(profile, owned.map((row) => ({ path: row.path, dev: row.stat.dev.toString(), ino: row.stat.ino.toString() }))));
    write(profile.commandPath, JSON.stringify(profile.command, null, 2) + '\n');
    // Publish the descriptive manifest last; it contains locators, never credentials.
    write(profile.manifestPath, JSON.stringify(profile, null, 2) + '\n');
    for (const row of owned) fsyncDirectory(row.path, { expectedIdentity: row.stat });
    fsyncDirectory(parent, { expectedIdentity: parentStat }); assertOwned();
    return profile;
  } catch { throw new Error('Native profile preparation failed; the partial directory remains for inspection'); }
}

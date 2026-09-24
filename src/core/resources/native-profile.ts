/**
 * Prepare fresh owner-scoped native state without reading credentials or starting a native process,
 * and re-pin an existing prepared profile to a different native executable.
 */
import { randomBytes } from 'node:crypto';
import {
  accessSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
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

// The generated launcher's fixed landmarks. `repinResourceNativeProfile` edits
// exactly the one `const profile=` line and refuses a launcher that does not
// carry these byte-for-byte, so prepare and repin share one definition.
const LAUNCHER_HEADER = '// Generated private native profile. Owner-editable configuration, not an authentication attestation.';
const LAUNCHER_PROFILE_PREFIX = 'const profile=';
const LAUNCHER_DIRECTORIES_PREFIX = 'const directories=';
/** Key order of the embedded launcher profile, exactly as `launcherSource` serializes it. */
const LAUNCHER_PROFILE_KEYS = ['provider', 'executable', 'nativeStatePath', 'anthropicStatePath', 'launcherPath'] as const;
/**
 * Key order of profile.json, exactly as `prepareResourceNativeProfile` builds it.
 * Exported so a test can pin prepare's output to it: repin refuses any other
 * shape, so the two must never drift apart silently.
 */
export const RESOURCE_NATIVE_PROFILE_MANIFEST_KEYS = ['schemaVersion', 'scope', 'status', 'authentication', 'provider', 'directory', 'executable',
  'nodeExecutable', 'commandPath', 'launcherPath', 'nativeStatePath', 'anthropicStatePath', 'manifestPath', 'command', 'loginCommand'] as const;

/** Standalone source deliberately has no dependency on an installed Hub path. */
function launcherSource(profile: ResourceNativeProfile, directories: Array<{ path: string; dev: string; ino: string }>): string {
  return `${LAUNCHER_HEADER}
import {accessSync,constants,lstatSync,realpathSync} from 'node:fs';
${LAUNCHER_PROFILE_PREFIX}${JSON.stringify({ provider: profile.provider, executable: profile.executable, nativeStatePath: profile.nativeStatePath,
    anthropicStatePath: profile.anthropicStatePath, launcherPath: profile.launcherPath })};
${LAUNCHER_DIRECTORIES_PREFIX}${JSON.stringify(directories)};
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

// ---------------------------------------------------------------------------
// Repin: point an existing prepared profile at a different native executable
// ---------------------------------------------------------------------------
//
// Why this exists: a profile's launcher execs ONE exact binary, so a seat never
// updates itself (the launcher also sets DISABLE_UPDATES for Claude). When a
// model needs a newer CLI — Opus 5.5 needs Claude Code ≥ 2.1.280 while claude-a
// was prepared against 2.1.257 — the only honest fix is to move the pin, and
// before this the only way to do that was hand-editing two private files that
// must agree with each other.
//
// What it changes: exactly the `executable` locator, in launcher.mjs (the one
// `const profile=` line) and profile.json. Every other byte of both files is
// preserved — an older launcher template stays an older template; repin is not
// an upgrade path. command.json is `[node, launcher.mjs]` and carries no native
// executable, so its bytes never change; it is still validated against
// profile.json and backed up so the three `*.prev` files are one coherent
// rollback set.
//
// Hardening matches prepare: the parent and the profile directory must be
// owned 0700 non-symlink canonical directories whose identity does not change
// during the operation; every file read is an owned 0600 single-link regular
// file opened O_NOFOLLOW and bounded; every write goes to a fresh O_EXCL |
// O_NOFOLLOW 0600 temp file in the same directory, is fsynced and identity-
// checked, and is renamed over its target only after re-checking that the
// target is still the inode and bytes that were validated. The new executable
// passes the same `executable()` check prepare applies. Nothing is executed.
//
// Crash consistency: the three `*.prev` backups land first (profile unchanged),
// then launcher.mjs (the operative file — what actually runs), then profile.json
// (descriptive, published last exactly as prepare publishes it last). The only
// torn state is "launcher moved, profile.json not yet": rerunning the SAME
// repin recognises it — launcher already names the target, profile.json and the
// backups still describe the previous state byte-for-byte — and finishes it.

export interface ResourceNativeProfileRepinOptions {
  directory: string;
  executable: string;
  /** Validate everything and report what would change; write nothing. */
  dryRun?: boolean;
}
export interface ResourceNativeProfileRepin {
  schemaVersion: 1;
  scope: 'native-profile-repin';
  /**
   * `repinned`    — launcher.mjs and profile.json now name `executable`.
   * `unchanged`   — both already named `executable`; nothing was written.
   * `would-repin` — dry run: every check passed; nothing was written.
   */
  status: 'repinned' | 'unchanged' | 'would-repin';
  authentication: 'not-checked';
  provider: ResourceNativeProfileProvider;
  directory: string;
  previousExecutable: string;
  executable: string;
  launcherPath: string;
  manifestPath: string;
  commandPath: string;
  /** The `*.prev` copies of the three files as they stood before this repin; null when nothing was repinned. */
  backups: { launcherPath: string; manifestPath: string; commandPath: string } | null;
  /** True when this call finished (or, dry, would finish) a repin interrupted between its launcher and profile.json publishes. */
  resumed: boolean;
}

/**
 * - `invalid`          — options, executable, runtime, private directories or file modes failed validation. Nothing written.
 * - `inconsistent`     — the files are not an unmodified prepared profile, or disagree with each other. Nothing written.
 * - `failed-unchanged` — a write failed before launcher.mjs changed; the profile still runs its previous executable.
 * - `failed-partial`   — launcher.mjs changed but the rest did not complete; rerun the same repin, or restore `*.prev`.
 */
export type ResourceNativeProfileRepinFailure = 'invalid' | 'inconsistent' | 'failed-unchanged' | 'failed-partial';
// Fixed text: a failure message must never carry a private path or an OS error string.
const REPIN_FAILURE_MESSAGES: Record<ResourceNativeProfileRepinFailure, string> = {
  invalid: 'Invalid native profile repin: options, executable, runtime, private directories or file modes failed validation; nothing was written',
  inconsistent: 'Native profile files are not an unmodified prepared profile or disagree with each other; nothing was written',
  'failed-unchanged': 'Native profile repin failed before the launcher changed; the profile still runs its previous executable',
  'failed-partial': 'Native profile repin was interrupted after the launcher changed; rerun the same repin to finish it, or restore the .prev files',
};
export class ResourceNativeProfileRepinError extends Error {
  readonly failure: ResourceNativeProfileRepinFailure;
  constructor(failure: ResourceNativeProfileRepinFailure) {
    super(REPIN_FAILURE_MESSAGES[failure]); this.name = 'ResourceNativeProfileRepinError'; this.failure = failure;
  }
}

/** Generated files are a few KB; anything larger is not a file prepare wrote. */
const PROFILE_FILE_MAX_BYTES = 64 * 1024;
const REPIN_BACKUP_SUFFIX = '.prev';

interface OwnedFile { text: string; stat: BigIntStats }
interface RepinInspection {
  provider: ResourceNativeProfileProvider;
  parent: string;
  parentStat: BigIntStats;
  directoryStat: BigIntStats;
  paths: { launcher: string; manifest: string; command: string };
  files: { launcher: OwnedFile; manifest: OwnedFile; command: OwnedFile };
  manifest: Record<string, unknown>;
  launcherLines: string[];
  profileLineIndex: number;
  launcherProfile: Record<string, unknown>;
  launcherExecutable: string;
  manifestExecutable: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value); return own.length === keys.length && own.every((key, index) => key === keys[index]);
}
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }

/**
 * Parse JSON that must re-serialize to exactly the same text. prepare writes
 * every file with JSON.stringify, so a byte-exact round trip proves the text is
 * still prepare's output; anything else (hand-reformatted, commented, extra
 * whitespace) is refused rather than rewritten into a different shape.
 */
function exactJson(text: string, indent: 0 | 2): unknown {
  const value: unknown = JSON.parse(text);
  if ((indent === 2 ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value)) !== text) throw new Error();
  return value;
}

/** One bounded read of an owner-private 0600 single-link regular file; links, growth mid-read and non-UTF-8 are refused. */
function readOwnedFile(file: string): OwnedFile {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true }); const named = lstatSync(file, { bigint: true });
    if (!opened.isFile() || named.isSymbolicLink() || !same(opened, named) || opened.nlink !== 1n || (opened.mode & 0o777n) !== 0o600n ||
      typeof process.getuid === 'function' && opened.uid !== BigInt(process.getuid()) || opened.size > BigInt(PROFILE_FILE_MAX_BYTES)) throw new Error();
    // One spare byte so a file that grew after fstat is detected, not truncated.
    const bytes = Buffer.alloc(Number(opened.size) + 1); let length = 0;
    while (length < bytes.length) { const read = readSync(fd, bytes, length, bytes.length - length, null); if (read === 0) break; length += read; }
    if (length !== Number(opened.size)) throw new Error();
    const content = bytes.subarray(0, length); const text = content.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(content)) throw new Error();
    return { text, stat: opened };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Absent, or an owned single-link regular file that a rename may replace. Anything else is refused. */
function assertReplaceable(file: string): void {
  let stat: BigIntStats;
  try { stat = lstatSync(file, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) {
    throw new Error();
  }
}

/** The launcher text with only its `const profile=` line re-rendered for `executable`. */
function launcherWithExecutable(state: RepinInspection, executable: string): string {
  const lines = [...state.launcherLines];
  lines[state.profileLineIndex] = `${LAUNCHER_PROFILE_PREFIX}${JSON.stringify({ ...state.launcherProfile, executable })};`;
  return lines.join('\n');
}

/**
 * Read and cross-check the three generated files of one prepared profile.
 * Read-only. Throws `invalid` for directory/file-mode problems and
 * `inconsistent` for content that is not prepare's own output.
 */
function inspectRepinTarget(directory: string): RepinInspection {
  let parent: string; let parentStat: BigIntStats; let directoryStat: BigIntStats;
  let paths: RepinInspection['paths']; let files: RepinInspection['files'];
  try {
    parent = dirname(directory); inspectPrivateDirectory(parent); parentStat = lstatSync(parent, { bigint: true });
    inspectPrivateDirectory(directory); directoryStat = lstatSync(directory, { bigint: true });
    paths = { launcher: join(directory, 'launcher.mjs'), manifest: join(directory, 'profile.json'), command: join(directory, 'command.json') };
    files = { launcher: readOwnedFile(paths.launcher), manifest: readOwnedFile(paths.manifest), command: readOwnedFile(paths.command) };
  } catch { throw new ResourceNativeProfileRepinError('invalid'); }
  try {
    const manifest = exactJson(files.manifest.text, 2);
    if (!isRecord(manifest) || !hasExactKeys(manifest, RESOURCE_NATIVE_PROFILE_MANIFEST_KEYS)) throw new Error();
    const provider = manifest['provider'];
    if (provider !== 'codex' && provider !== 'claude' && provider !== 'grok') throw new Error();
    // Every locator is derived from the directory, exactly as prepare derives it:
    // a profile.json copied or moved from elsewhere names another tree and is refused.
    const expected: Record<string, string | null> = {
      directory, commandPath: paths.command, launcherPath: paths.launcher, nativeStatePath: join(directory, 'native-state'),
      anthropicStatePath: provider === 'claude' ? join(directory, 'anthropic-state') : null, manifestPath: paths.manifest,
    };
    const command = manifest['command']; const loginCommand = manifest['loginCommand'];
    if (manifest['schemaVersion'] !== 1 || manifest['scope'] !== 'native-profile-preparation' || manifest['status'] !== 'prepared' ||
      manifest['authentication'] !== 'not-checked' || Object.entries(expected).some(([key, value]) => manifest[key] !== value) ||
      !path(manifest['executable']) || !path(manifest['nodeExecutable']) || !isStringArray(command) || command.length !== 2 ||
      command[0] !== manifest['nodeExecutable'] || command[1] !== paths.launcher || !isStringArray(loginCommand) ||
      loginCommand[0] !== command[0] || loginCommand[1] !== command[1]) throw new Error();
    if (JSON.stringify(exactJson(files.command.text, 2)) !== JSON.stringify(command)) throw new Error();

    const launcherLines = files.launcher.text.split('\n');
    const indexesOf = (prefix: string): number[] => launcherLines.flatMap((line, index) => line.startsWith(prefix) ? [index] : []);
    const profileIndexes = indexesOf(LAUNCHER_PROFILE_PREFIX); const directoryIndexes = indexesOf(LAUNCHER_DIRECTORIES_PREFIX);
    if (launcherLines[0] !== LAUNCHER_HEADER || profileIndexes.length !== 1 || directoryIndexes.length !== 1) throw new Error();
    const embedded = (index: number, prefix: string): unknown => {
      const line = launcherLines[index]!; if (!line.endsWith(';')) throw new Error();
      return exactJson(line.slice(prefix.length, -1), 0);
    };
    const launcherProfile = embedded(profileIndexes[0]!, LAUNCHER_PROFILE_PREFIX);
    if (!isRecord(launcherProfile) || !hasExactKeys(launcherProfile, LAUNCHER_PROFILE_KEYS) || launcherProfile['provider'] !== provider ||
      launcherProfile['nativeStatePath'] !== expected['nativeStatePath'] || launcherProfile['anthropicStatePath'] !== expected['anthropicStatePath'] ||
      launcherProfile['launcherPath'] !== paths.launcher || !path(launcherProfile['executable'])) throw new Error();
    // The launcher refuses to run unless these directories still have the
    // identities recorded at preparation. Check the same thing here: a repin
    // must never produce a launcher that is already dead on arrival.
    const directories = embedded(directoryIndexes[0]!, LAUNCHER_DIRECTORIES_PREFIX);
    const expectedDirectories = [directory, join(directory, 'native-state'), ...(provider === 'claude' ? [join(directory, 'anthropic-state')] : [])];
    if (!Array.isArray(directories) || directories.length !== expectedDirectories.length) throw new Error();
    directories.forEach((row: unknown, index) => {
      if (!isRecord(row) || !hasExactKeys(row, ['path', 'dev', 'ino']) || row['path'] !== expectedDirectories[index]) throw new Error();
      inspectPrivateDirectory(expectedDirectories[index]!); const live = lstatSync(expectedDirectories[index]!, { bigint: true });
      if (live.dev.toString() !== row['dev'] || live.ino.toString() !== row['ino']) throw new Error();
    });
    return { provider, parent, parentStat, directoryStat, paths, files, manifest, launcherLines, profileLineIndex: profileIndexes[0]!,
      launcherProfile, launcherExecutable: launcherProfile['executable'] as string, manifestExecutable: manifest['executable'] as string };
  } catch { throw new ResourceNativeProfileRepinError('inconsistent'); }
}

/**
 * Re-pin one existing prepared profile to a different native executable.
 * Rewrites only the executable locator (see the section comment above);
 * idempotent when already pinned; resumes its own interrupted run; never
 * executes anything and never reads native state or credentials.
 */
export function repinResourceNativeProfile(options: ResourceNativeProfileRepinOptions): ResourceNativeProfileRepin {
  let directory: string; let target: string; let dryRun: boolean;
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new Error();
    const keys = Reflect.ownKeys(options);
    if (!keys.every((key) => (key === 'directory' || key === 'executable' || key === 'dryRun') &&
      'value' in Object.getOwnPropertyDescriptor(options, key)!) || !Object.hasOwn(options, 'directory') || !Object.hasOwn(options, 'executable')) {
      throw new Error();
    }
    directory = options.directory; target = options.executable; dryRun = options.dryRun ?? false;
    if (!path(directory) || !path(target) || typeof dryRun !== 'boolean' || typeof process.execve !== 'function' ||
      process.platform === 'win32' || process.platform === 'aix') throw new Error();
    executable(target);
  } catch { throw new ResourceNativeProfileRepinError('invalid'); }

  const state = inspectRepinTarget(directory);
  const previous = state.manifestExecutable;
  const mode: 'unchanged' | 'repin' | 'resume' = state.launcherExecutable === previous ? (previous === target ? 'unchanged' : 'repin')
    : state.launcherExecutable === target ? 'resume' : (() => { throw new ResourceNativeProfileRepinError('inconsistent'); })();
  const backups = { launcherPath: `${state.paths.launcher}${REPIN_BACKUP_SUFFIX}`, manifestPath: `${state.paths.manifest}${REPIN_BACKUP_SUFFIX}`,
    commandPath: `${state.paths.command}${REPIN_BACKUP_SUFFIX}` };
  // The launcher as it stood pinned to `previous` (identical to what was read in
  // `repin` mode; reconstructed in `resume` mode to check the backup against).
  const previousLauncher = launcherWithExecutable(state, previous);
  const nextLauncher = launcherWithExecutable(state, target);
  const nextManifest = `${JSON.stringify({ ...state.manifest, executable: target }, null, 2)}\n`;

  if (mode === 'resume') {
    // Only finish a torn run whose backups prove it: they must hold exactly the
    // pre-repin triple, and profile.json must still be that pre-repin text.
    try {
      if (readOwnedFile(backups.launcherPath).text !== previousLauncher || readOwnedFile(backups.manifestPath).text !== state.files.manifest.text ||
        readOwnedFile(backups.commandPath).text !== state.files.command.text) throw new Error();
    } catch { throw new ResourceNativeProfileRepinError('inconsistent'); }
  } else if (mode === 'repin') {
    try { for (const file of Object.values(backups)) assertReplaceable(file); } catch { throw new ResourceNativeProfileRepinError('invalid'); }
  }
  const report = (status: ResourceNativeProfileRepin['status'], written: ResourceNativeProfileRepin['backups']): ResourceNativeProfileRepin => ({
    schemaVersion: 1, scope: 'native-profile-repin', status, authentication: 'not-checked', provider: state.provider, directory,
    previousExecutable: previous, executable: target, launcherPath: state.paths.launcher, manifestPath: state.paths.manifest,
    commandPath: state.paths.command, backups: written, resumed: mode === 'resume',
  });
  if (mode === 'unchanged') return report('unchanged', null);
  if (dryRun) return report('would-repin', null);

  const assertOwned = (): void => {
    inspectPrivateDirectory(state.parent); if (!same(state.parentStat, lstatSync(state.parent, { bigint: true }))) throw new Error();
    inspectPrivateDirectory(directory); if (!same(state.directoryStat, lstatSync(directory, { bigint: true }))) throw new Error();
  };
  /** The target is still exactly the inode and bytes that inspection validated. */
  const unchangedSinceInspection = (file: string, read: OwnedFile): void => {
    const now = readOwnedFile(file); if (!same(now.stat, read.stat) || now.text !== read.text) throw new Error();
  };
  // Write a fresh exclusive temp file beside `file`, then rename it into place.
  // The precondition runs immediately before the rename; the remaining window
  // is a same-owner race inside a directory only this uid can write.
  const publish = (file: string, text: string, precondition: () => void, onInstalled?: () => void): void => {
    assertOwned();
    const temp = join(directory, `.${basename(file)}.${randomBytes(8).toString('hex')}.repin-tmp`);
    let fd: number | undefined; let created = false; let installed = false;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
      const before = fstatSync(fd, { bigint: true }); const named = lstatSync(temp, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size !== 0n || !same(before, named) || named.isSymbolicLink() ||
        (before.mode & 0o777n) !== 0o600n || typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) throw new Error();
      const bytes = Buffer.from(text); let offset = 0;
      while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); if (written < 1) throw new Error(); offset += written; }
      fsyncSync(fd); const after = fstatSync(fd, { bigint: true });
      if (!same(before, after) || after.nlink !== 1n || after.size !== BigInt(bytes.length) || (after.mode & 0o777n) !== 0o600n) throw new Error();
      closeSync(fd); fd = undefined;
      assertOwned(); precondition();
      renameSync(temp, file); installed = true; onInstalled?.();
      const placed = lstatSync(file, { bigint: true });
      if (!same(before, placed) || !placed.isFile() || placed.isSymbolicLink() || placed.nlink !== 1n || (placed.mode & 0o777n) !== 0o600n) throw new Error();
    } finally {
      if (fd !== undefined) closeSync(fd);
      // Our own O_EXCL temp file only; best effort, and it never names a live file.
      if (created && !installed) { try { unlinkSync(temp); } catch { /* left beside the profile for inspection */ } }
    }
  };
  const syncDirectory = (): void => fsyncDirectory(directory, { expectedIdentity: state.directoryStat });

  let launcherChanged = mode === 'resume';
  try {
    if (mode === 'repin') {
      // Copies, never hard links: the launcher refuses to run when its own
      // file has more than one link, so a linked backup would disable the profile.
      publish(backups.commandPath, state.files.command.text, () => assertReplaceable(backups.commandPath));
      publish(backups.manifestPath, state.files.manifest.text, () => assertReplaceable(backups.manifestPath));
      publish(backups.launcherPath, state.files.launcher.text, () => assertReplaceable(backups.launcherPath));
      syncDirectory();
      publish(state.paths.launcher, nextLauncher, () => unchangedSinceInspection(state.paths.launcher, state.files.launcher),
        () => { launcherChanged = true; });
      syncDirectory();
    }
    publish(state.paths.manifest, nextManifest, () => unchangedSinceInspection(state.paths.manifest, state.files.manifest));
    syncDirectory();
    // Postcondition from disk, not from memory: the profile re-validates as a
    // prepared profile pinned to the target, and the backups hold the prior triple.
    const settled = inspectRepinTarget(directory);
    if (settled.launcherExecutable !== target || settled.manifestExecutable !== target || settled.files.launcher.text !== nextLauncher ||
      settled.files.manifest.text !== nextManifest || settled.files.command.text !== state.files.command.text ||
      readOwnedFile(backups.launcherPath).text !== previousLauncher || readOwnedFile(backups.manifestPath).text !== state.files.manifest.text ||
      readOwnedFile(backups.commandPath).text !== state.files.command.text) throw new Error();
    assertOwned();
  } catch { throw new ResourceNativeProfileRepinError(launcherChanged ? 'failed-partial' : 'failed-unchanged'); }
  return report('repinned', backups);
}

// ---------------------------------------------------------------------------
// V3.10: resolve a SEAT's launcher for headless fleet use (read-only)
// ---------------------------------------------------------------------------
//
// Why this exists: the fleet's grok-cli engine (SPEC-310B §3) must run on the
// grok-a SEAT — the same account, pinned binary and GROK_HOME that Verse and
// the SeatRouter call `grok` — never the ambient `~/.grok` login. The seat's
// identity is its row in `<accountsRoot>/connections.json` (id → launcher
// command); the launcher is this module's generated `launcher.mjs`, which
// execs exactly one pinned binary with a scrubbed env plus GROK_HOME.
//
// What it checks, and why each check fails closed:
//  - the roster lives in an owned 0700 directory and is an owned 0600
//    single-link file (the roster decides which launcher the daemon execs);
//  - exactly one row matches (provider, and seat id when given) — two grok
//    rows and no configured seat is ambiguous, not "pick the first";
//  - the row's command is exactly `[node, <dir>/launcher.mjs]`, and that
//    directory re-validates as an UNMODIFIED prepared profile of the same
//    provider (inspectRepinTarget: every file owned 0600, every directory
//    0700 with its recorded identity, launcher and manifest agreeing byte for
//    byte), whose manifest command is the row's command;
//  - the launcher and manifest name the same executable, so a repin torn
//    between its two publishes is refused until it is finished.
// Nothing is executed, no credential is read (native-state is never opened),
// and a failure message never carries a private path.

export type NativeSeatLaunchFailure =
  | 'roster-unreadable'
  | 'no-seat'
  | 'ambiguous-seat'
  | 'not-a-profile-launcher'
  | 'profile-invalid';

export interface NativeSeatLaunch {
  /** The account id in connections.json — the SeatRouter's seat id. */
  seatId: string;
  provider: ResourceNativeProfileProvider;
  /** `[nodeExecutable, launcherPath]` — PRIVATE locators; never put them in a payload or log. */
  command: [string, string];
  /** What the launcher sets as GROK_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR. PRIVATE. */
  nativeStatePath: string;
  /** The one pinned native binary the launcher execs. PRIVATE. */
  executable: string;
}

export type NativeSeatLaunchResult =
  | { ok: true; launch: NativeSeatLaunch }
  | { ok: false; reason: NativeSeatLaunchFailure; detail: string };

// Fixed text: never a path, never an OS error string.
const SEAT_LAUNCH_DETAIL: Record<NativeSeatLaunchFailure, string> = {
  'roster-unreadable': 'the account roster (connections.json) is missing, not owner-private, or malformed',
  'no-seat': 'no account in the roster matches this provider/seat',
  'ambiguous-seat': 'more than one account matches this provider; configure the seat id explicitly',
  'not-a-profile-launcher': 'the seat command is not a native-profile launcher ([node, <profile>/launcher.mjs])',
  'profile-invalid': 'the seat profile is not an unmodified prepared profile of this provider (or a repin is unfinished)',
};

const ROSTER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function seatFailure(reason: NativeSeatLaunchFailure): NativeSeatLaunchResult {
  return { ok: false, reason, detail: SEAT_LAUNCH_DETAIL[reason] };
}

/**
 * Resolve one seat's launcher. Pure read; see the section comment for every
 * check. `seatId` null/absent means "the only account of this provider".
 */
export function resolveNativeSeatLaunch(options: {
  accountsRoot: string;
  provider: ResourceNativeProfileProvider;
  seatId?: string | null;
}): NativeSeatLaunchResult {
  const { accountsRoot, provider } = options;
  const seatId = options.seatId ?? null;
  let rows: Array<{ id: string; command: unknown }>;
  try {
    if (!path(accountsRoot)) throw new Error();
    inspectPrivateDirectory(accountsRoot);
    const roster: unknown = JSON.parse(readOwnedFile(join(accountsRoot, 'connections.json')).text);
    if (!isRecord(roster) || roster['schemaVersion'] !== 1 || !Array.isArray(roster['accounts'])) throw new Error();
    rows = roster['accounts'].flatMap((row: unknown) => {
      if (!isRecord(row) || typeof row['id'] !== 'string' || !ROSTER_ID.test(row['id']) || row['provider'] !== provider) return [];
      return [{ id: row['id'], command: row['command'] }];
    });
  } catch { return seatFailure('roster-unreadable'); }
  const matches = seatId === null ? rows : rows.filter((row) => row.id === seatId);
  if (matches.length === 0) return seatFailure('no-seat');
  if (matches.length > 1) return seatFailure('ambiguous-seat');
  const row = matches[0]!;
  const command = row.command;
  if (!isStringArray(command) || command.length !== 2 || !path(command[0]) || !path(command[1]) ||
    basename(command[1]!) !== 'launcher.mjs') return seatFailure('not-a-profile-launcher');
  let state: RepinInspection;
  try { state = inspectRepinTarget(dirname(command[1]!)); } catch { return seatFailure('profile-invalid'); }
  const manifestCommand = state.manifest['command'];
  if (state.provider !== provider || state.launcherExecutable !== state.manifestExecutable ||
    !isStringArray(manifestCommand) || manifestCommand.length !== 2 ||
    manifestCommand[0] !== command[0] || manifestCommand[1] !== command[1]) return seatFailure('profile-invalid');
  const nativeStatePath = state.manifest['nativeStatePath'];
  if (typeof nativeStatePath !== 'string') return seatFailure('profile-invalid');
  // The launcher is CODE the unattended daemon executes. inspectRepinTarget
  // checks its landmark lines only (repin must accept older templates); a seat
  // launch demands the WHOLE file be exactly what this template generates for
  // this manifest and these recorded directories, so an appended or edited
  // line is refused. A profile prepared by an older template fails here and
  // must be re-prepared — the honest outcome for code this path cannot vouch for.
  try {
    const directoriesLine = state.launcherLines.find((line) => line.startsWith(LAUNCHER_DIRECTORIES_PREFIX))!;
    const directories = exactJson(directoriesLine.slice(LAUNCHER_DIRECTORIES_PREFIX.length, -1), 0) as Array<{ path: string; dev: string; ino: string }>;
    if (launcherSource(state.manifest as unknown as ResourceNativeProfile, directories) !== state.files.launcher.text) throw new Error();
  } catch { return seatFailure('profile-invalid'); }
  return {
    ok: true,
    launch: { seatId: row.id, provider, command: [command[0]!, command[1]!], nativeStatePath, executable: state.manifestExecutable },
  };
}

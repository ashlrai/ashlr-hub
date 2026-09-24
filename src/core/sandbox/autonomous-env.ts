/**
 * Autonomous run environment — V3.10 Track B (owner: unit U2).
 *
 * While a standing policy is live, every autonomous agent run gets ephemeral
 * homes under its own TMPDIR (HOME, CLAUDE_CONFIG_DIR, XDG_*, package caches)
 * so a hook or fsmonitor setting planted in a real vendor home can never run
 * unconfined later; real vendor homes are never writable; the custody
 * directory and ~/.ashlr/{authority,activation,foundry} are unreadable.
 *
 * The exported names and signatures of the day-0 stub (AutonomousEnvInput,
 * AutonomousEnvOverlay, buildAutonomousEnvOverlay) are a FROZEN cross-unit
 * contract (the sandboxed engine U6 and the engine registry / judges U7);
 * everything else here is additive and optional.
 *
 * GROK / CODEX STATE — a per-run SNAPSHOT, not the real home. The seat's
 * pinned vendor home (e.g. ~/.ashlr/native-profiles/grok-a/native-state) is
 * denied to the agent outright; the run gets a private copy of the few files
 * the CLI needs (auth.json, config.toml, …) as its GROK_HOME / CODEX_HOME.
 * WHY: (1) nothing an agent writes — hooks, rules, trusted folders, config —
 * can ever reach the home Mason's own sessions use; (2) concurrent runs cannot
 * interfere; (3) the CLI still refreshes its OAuth token normally, and
 * commitAutonomousVendorState() writes a refreshed auth.json back only after
 * proving it belongs to the SAME account (so an injected agent cannot swap in
 * credentials for an account it controls and harvest Mason's later sessions)
 * and only if the real file did not change meanwhile. Consequence for U7:
 * autonomous grok-cli runs exec the profile's pinned executable directly with
 * this env; the native-profile launcher hard-codes the real GROK_HOME.
 *
 * Secrets rule: `set` never contains a secret. Engine credentials are added
 * by the caller AFTER applying the overlay (claude-cli judges:
 * CLAUDE_CODE_OAUTH_TOKEN from custody-client claudeToken()); the overlay
 * removes every other credential variable it knows of.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CUSTODY_DATA_DIR_RELATIVE, CUSTODY_HELPER_PATH } from '../authority/custody-client.js';

export interface AutonomousEnvInput {
  /** Engine id as the registry knows it (e.g. `claude`, `grok-cli`, `local-coder`). */
  engine: string;
  /** The run's private temp dir (0700); ephemeral homes are created under it. */
  runTmpDir: string;
  /** The real HOME (to compute the read-only vendor-home paths). */
  home: string;
  /** Seat the run uses (e.g. `grok-a`); null when the engine has none. */
  seatId: string | null;
  /**
   * ADDITIVE. The seat's pinned vendor home (its profile.json
   * `nativeStatePath`). Absent → read from
   * `<home>/.ashlr/native-profiles/<seatId>/profile.json`. Used only by
   * engines that keep state there (grok-cli: GROK_HOME, codex: CODEX_HOME).
   */
  nativeStatePath?: string | null;
  /** ADDITIVE. Executables this run starts from under HOME (e.g. the pinned grok or claude binary) — made readable, never writable. */
  executables?: readonly string[];
  /** ADDITIVE. The PATH to sanitize; defaults to process.env.PATH. */
  path?: string;
}

/** A per-run copy of a seat's vendor home (grok-cli / codex). */
export interface AutonomousVendorState {
  engineClass: 'grok-cli' | 'codex';
  envVar: 'GROK_HOME' | 'CODEX_HOME';
  /** The seat's real vendor home — denied to the agent; written only by commitAutonomousVendorState. */
  realHome: string;
  /** The run's private copy, the agent's GROK_HOME / CODEX_HOME. */
  ephemeralHome: string;
  /** Files copied in → sha256 of the real file at snapshot time. */
  snapshot: Readonly<Record<string, string>>;
  /** Files the daemon may write back after the run, once validated. */
  writeBack: readonly string[];
}

export interface AutonomousEnvOverlay {
  /** Variables to set in the child env (override). Never contains a secret. */
  set: Readonly<Record<string, string>>;
  /** Variables to remove from the child env. */
  unset: readonly string[];
  /** Absolute paths the confined child may write beyond its worktree (ephemeral homes, Grok session / log paths). */
  writablePaths: readonly string[];
  /** Absolute paths the child may read but never write (real vendor homes). */
  readOnlyPaths: readonly string[];
  /** Absolute paths the child may not read at all (custody dir, ~/.ashlr/{authority,activation,foundry}). */
  deniedReadPaths: readonly string[];
  /** ADDITIVE. How the run is confined (drives network egress in sandbox/confine.ts). */
  engineClass?: AutonomousEngineClass;
  /** ADDITIVE. Vendor-home snapshots to reconcile after the run (commitAutonomousVendorState). */
  vendorState?: readonly AutonomousVendorState[];
}

/**
 * Confinement classes, named after StandingGrantV1 engines. Anything the
 * mapping does not recognise is `local` — the class with no network egress —
 * so an unknown engine fails closed rather than open.
 */
export type AutonomousEngineClass = 'local' | 'grok-cli' | 'claude-cli' | 'codex';

export function autonomousEngineClass(engine: string): AutonomousEngineClass {
  switch (engine) {
    case 'grok-cli':
      return 'grok-cli';
    case 'claude':
    case 'claude-cli':
      return 'claude-cli';
    case 'codex':
      return 'codex';
    default:
      return 'local';
  }
}

// ---------------------------------------------------------------------------
// What is denied, made read-only, or remapped
// ---------------------------------------------------------------------------

/**
 * HOME-relative paths no autonomous process may read. The HOME read-jail in
 * sandbox/confine.ts already covers them; they are listed again so they stay
 * denied even if a later rule re-allows a parent (the profile emits these
 * denials last, and the first five are tripwires that kill the reader).
 */
export const AUTONOMOUS_DENIED_HOME_PATHS: readonly string[] = Object.freeze([
  CUSTODY_DATA_DIR_RELATIVE,
  'Library/Keychains',
  '.ashlr/authority',
  '.ashlr/activation',
  '.ashlr/foundry',
  '.ashlr/native-profiles',
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gh',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.docker',
  '.kube',
]);

/**
 * Toolchains installed under HOME that fleet repos build with (rustup/cargo
 * for Rust repos, bun for Bun repos). Readable only — never writable — and
 * only when present. Their caches are remapped into the run (below), so a
 * build can never plant something another run or Mason would load later.
 */
export const AUTONOMOUS_TOOLCHAIN_HOME_PATHS: readonly string[] = Object.freeze(['.cargo/bin', '.rustup', '.bun/bin']);

/** Credential and config-pointer variables removed from every autonomous child. */
export const AUTONOMOUS_UNSET_ENV: readonly string[] = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GROK_HOME',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_userconfig',
  'NPM_CONFIG_GLOBALCONFIG',
  'npm_config_globalconfig',
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_EXEC_PATH',
  'GIT_CONFIG',
  'GIT_CONFIG_SYSTEM',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
]);

/** Files copied into a vendor-home snapshot (when present) and the ones written back. */
const VENDOR_SNAPSHOT: Readonly<Record<'grok-cli' | 'codex', { envVar: 'GROK_HOME' | 'CODEX_HOME'; provider: string; copy: readonly string[]; writeBack: readonly string[] }>> = {
  'grok-cli': { envVar: 'GROK_HOME', provider: 'grok', copy: ['auth.json', 'config.toml', 'agent_id', 'models_cache.json'], writeBack: ['auth.json'] },
  codex: { envVar: 'CODEX_HOME', provider: 'codex', copy: ['auth.json', 'config.toml', 'installation_id', 'models_cache.json'], writeBack: ['auth.json'] },
};

const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
const MAX_AUTH_FILE_BYTES = 64 * 1024;
const ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SEAT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class AutonomousEnvError extends Error {
  constructor(message: string) {
    super(`autonomous env: ${message}`);
    this.name = 'AutonomousEnvError';
  }
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A directory we own, not a symlink, with no group/other access. */
function assertPrivateDir(path: string, what: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new AutonomousEnvError(`${what} ${path} does not exist`);
  }
  const uid = currentUid();
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AutonomousEnvError(`${what} ${path} is not a plain directory`);
  if (uid !== null && stat.uid !== uid) throw new AutonomousEnvError(`${what} ${path} is not owned by this user`);
  if ((stat.mode & 0o077) !== 0) throw new AutonomousEnvError(`${what} ${path} must be mode 0700`);
}

/** Create `path` 0700 (or accept an existing private dir) — never follows a planted symlink. */
function ensurePrivateDir(path: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new AutonomousEnvError(`cannot create ${path}`);
  }
  assertPrivateDir(path, 'ephemeral directory');
  return path;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A regular, user-owned file no larger than `max`, or null when absent. Throws on anything odd. */
function regularFile(path: string, max: number): { size: number } | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  const uid = currentUid();
  if (stat.isSymbolicLink() || !stat.isFile()) throw new AutonomousEnvError(`${path} is not a regular file`);
  if (uid !== null && stat.uid !== uid) throw new AutonomousEnvError(`${path} is not owned by this user`);
  if (stat.size > max) throw new AutonomousEnvError(`${path} is larger than ${max} bytes`);
  return { size: stat.size };
}

/** The seat's vendor home from its native profile manifest (provider must match). */
function resolveNativeStatePath(home: string, seatId: string | null, provider: string): string | null {
  if (seatId === null || !SEAT_ID.test(seatId)) return null;
  const manifest = join(home, '.ashlr', 'native-profiles', seatId, 'profile.json');
  try {
    if (regularFile(manifest, 64 * 1024) === null) return null;
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record['provider'] !== provider) return null;
    const path = record['nativeStatePath'];
    return typeof path === 'string' && isAbsolute(path) ? path : null;
  } catch {
    return null;
  }
}

/** PATH without entries under HOME, except the read-only toolchain bins that exist. */
function sanitizePath(rawPath: string, home: string, toolchains: readonly string[]): string {
  const keep: string[] = [];
  const toolchainBins = new Set(toolchains.filter((p) => p.endsWith(`${sep}bin`)));
  for (const entry of rawPath.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const normalized = resolve(entry);
    if (isInside(normalized, home) && !toolchainBins.has(normalized)) continue;
    if (!keep.includes(normalized)) keep.push(normalized);
  }
  for (const bin of toolchainBins) if (!keep.includes(bin)) keep.push(bin);
  for (const system of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) if (!keep.includes(system)) keep.push(system);
  return keep.join(delimiter);
}

// ---------------------------------------------------------------------------
// Frozen contract
// ---------------------------------------------------------------------------

/** Build (and create, 0700) the per-run ephemeral environment for an autonomous run. */
export function buildAutonomousEnvOverlay(input: AutonomousEnvInput): AutonomousEnvOverlay {
  if (typeof input?.engine !== 'string' || !ENGINE_ID.test(input.engine)) throw new AutonomousEnvError('engine id is invalid');
  if (input.seatId !== null && (typeof input.seatId !== 'string' || !SEAT_ID.test(input.seatId))) {
    throw new AutonomousEnvError('seat id is invalid');
  }
  if (typeof input.home !== 'string' || !isAbsolute(input.home)) throw new AutonomousEnvError('home must be an absolute path');
  if (typeof input.runTmpDir !== 'string' || !isAbsolute(input.runTmpDir)) throw new AutonomousEnvError('runTmpDir must be an absolute path');

  let home: string;
  let run: string;
  try {
    home = realpathSync(input.home);
    run = realpathSync(input.runTmpDir);
  } catch {
    throw new AutonomousEnvError('home and runTmpDir must exist');
  }
  if (run !== resolve(input.runTmpDir)) {
    // A symlinked runTmpDir would let the sandbox allow-list point somewhere else.
    throw new AutonomousEnvError('runTmpDir must be a canonical path (no symlinks)');
  }
  assertPrivateDir(run, 'runTmpDir');
  if (isInside(home, run)) throw new AutonomousEnvError('runTmpDir must not contain the home directory');

  const deniedReadPaths = AUTONOMOUS_DENIED_HOME_PATHS.map((rel) => join(home, rel));
  deniedReadPaths.push(CUSTODY_HELPER_PATH);
  for (const denied of deniedReadPaths) {
    if (isInside(run, denied)) throw new AutonomousEnvError('runTmpDir must not live inside a protected directory');
  }

  const engineClass = autonomousEngineClass(input.engine);
  const dirs = {
    home: ensurePrivateDir(join(run, 'home')),
    tmp: ensurePrivateDir(join(run, 'tmp')),
    xdg: ensurePrivateDir(join(run, 'xdg')),
    cache: ensurePrivateDir(join(run, 'cache')),
  };
  const xdg = {
    config: ensurePrivateDir(join(dirs.xdg, 'config')),
    data: ensurePrivateDir(join(dirs.xdg, 'data')),
    cache: ensurePrivateDir(join(dirs.xdg, 'cache')),
    state: ensurePrivateDir(join(dirs.xdg, 'state')),
  };
  const cache = (name: string): string => ensurePrivateDir(join(dirs.cache, name));

  const toolchains = AUTONOMOUS_TOOLCHAIN_HOME_PATHS.map((rel) => join(home, rel)).filter((p) => existsSync(p));
  const set: Record<string, string> = {
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    XDG_CONFIG_HOME: xdg.config,
    XDG_DATA_HOME: xdg.data,
    XDG_CACHE_HOME: xdg.cache,
    XDG_STATE_HOME: xdg.state,
    npm_config_cache: cache('npm'),
    npm_config_store_dir: cache('pnpm'),
    npm_config_update_notifier: 'false',
    YARN_CACHE_FOLDER: cache('yarn'),
    BUN_INSTALL_CACHE_DIR: cache('bun'),
    PIP_CACHE_DIR: cache('pip'),
    GOCACHE: cache('go-build'),
    GOMODCACHE: cache('go-mod'),
    GOPATH: join(dirs.home, 'go'),
    CARGO_HOME: cache('cargo'),
    // Agent-side git never reads Mason's global/system config (hooks, helpers, includes).
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    PATH: sanitizePath(input.path ?? process.env['PATH'] ?? '', home, toolchains),
  };
  const rustup = join(home, '.rustup');
  if (toolchains.includes(rustup)) set['RUSTUP_HOME'] = rustup;

  if (engineClass === 'claude-cli') {
    Object.assign(set, {
      CLAUDE_CONFIG_DIR: ensurePrivateDir(join(run, 'claude')),
      // Claude's internal temp dir defaults to /tmp on macOS, which the profile denies.
      CLAUDE_CODE_TMPDIR: dirs.tmp,
      // 3.10: autonomous Claude runs are judge / Leader calls only — no tools.
      CLAUDE_CODE_RESTRICTED: '1',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_UPDATES: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    });
  }

  const vendorState: AutonomousVendorState[] = [];
  if (engineClass === 'grok-cli' || engineClass === 'codex') {
    const spec = VENDOR_SNAPSHOT[engineClass];
    const realHome = input.nativeStatePath ?? resolveNativeStatePath(home, input.seatId, spec.provider);
    if (!realHome || !isAbsolute(realHome)) {
      throw new AutonomousEnvError(`no pinned ${spec.envVar} for seat ${input.seatId ?? '(none)'} — pass nativeStatePath or prepare the seat's native profile`);
    }
    let canonicalReal: string;
    try {
      canonicalReal = realpathSync(realHome);
    } catch {
      throw new AutonomousEnvError(`${spec.envVar} ${realHome} does not exist`);
    }
    assertPrivateDir(canonicalReal, spec.envVar);
    if (isInside(canonicalReal, run) || isInside(run, canonicalReal)) {
      throw new AutonomousEnvError(`${spec.envVar} must not overlap runTmpDir`);
    }
    const ephemeralHome = ensurePrivateDir(join(run, 'vendor-home'));
    const snapshot: Record<string, string> = {};
    for (const name of spec.copy) {
      const source = join(canonicalReal, name);
      if (regularFile(source, MAX_SNAPSHOT_FILE_BYTES) === null) continue;
      const target = join(ephemeralHome, name);
      copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
      chmodSync(target, 0o600);
      snapshot[name] = sha256File(source);
    }
    if (!snapshot['auth.json']) {
      throw new AutonomousEnvError(`seat ${input.seatId ?? '(none)'} has no auth.json in its ${spec.envVar} — sign the seat in first`);
    }
    set[spec.envVar] = ephemeralHome;
    deniedReadPaths.push(canonicalReal);
    vendorState.push({
      engineClass,
      envVar: spec.envVar,
      realHome: canonicalReal,
      ephemeralHome,
      snapshot: Object.freeze({ ...snapshot }),
      writeBack: spec.writeBack,
    });
  }

  const readOnlyPaths: string[] = [...toolchains];
  for (const executable of input.executables ?? []) {
    if (typeof executable !== 'string' || !isAbsolute(executable)) throw new AutonomousEnvError('executables must be absolute paths');
    let real: string;
    try {
      real = realpathSync(executable);
    } catch {
      throw new AutonomousEnvError(`executable ${executable} does not exist`);
    }
    for (const denied of deniedReadPaths) {
      if (isInside(real, denied)) throw new AutonomousEnvError(`executable ${executable} lives in a protected directory`);
    }
    if (!readOnlyPaths.includes(real)) readOnlyPaths.push(real);
  }

  const unset = AUTONOMOUS_UNSET_ENV.filter((key) => !(key in set));
  return Object.freeze({
    set: Object.freeze(set),
    unset: Object.freeze(unset),
    writablePaths: Object.freeze([run]),
    readOnlyPaths: Object.freeze(readOnlyPaths),
    deniedReadPaths: Object.freeze(deniedReadPaths),
    engineClass,
    vendorState: Object.freeze(vendorState),
  });
}

/**
 * The child env with the overlay applied: `unset` removed, `set` applied, and
 * every DYLD_* / LD_* loader-injection variable dropped. Returns a new object.
 */
export function applyAutonomousEnvOverlay(env: NodeJS.ProcessEnv, overlay: AutonomousEnvOverlay): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    if (/^(?:DYLD_|LD_)/.test(key)) delete out[key];
  }
  for (const key of overlay.unset) delete out[key];
  for (const [key, value] of Object.entries(overlay.set)) out[key] = value;
  return out;
}

// ---------------------------------------------------------------------------
// After the run: reconcile a refreshed vendor credential
// ---------------------------------------------------------------------------

export interface VendorCommitResult {
  /** Real files updated (absolute paths). */
  committed: string[];
  /** Files left untouched, with why (`unchanged` is the normal case). */
  skipped: { file: string; reason: string }[];
}

function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > 16_384) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sameStrings(a: Record<string, unknown> | null, b: Record<string, unknown> | null, keys: readonly string[]): boolean {
  if (!a || !b) return false;
  return keys.every((key) => typeof a[key] === 'string' && a[key] === b[key]);
}

/**
 * Is `next` the same account as `previous`? Grok: the same provider entries,
 * and for each the same user/principal/team and an access JWT whose sub,
 * principal and team still match. Codex: the same account_id and id-token
 * subject. Anything else — including a well-formed credential for ANOTHER
 * account — is refused.
 */
function sameVendorAccount(engineClass: 'grok-cli' | 'codex', previous: unknown, next: unknown): string | null {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isRecord(previous) || !isRecord(next)) return 'not a JSON object';
  if (engineClass === 'grok-cli') {
    const before = Object.keys(previous).sort();
    const after = Object.keys(next).sort();
    if (before.length === 0 || before.join('\n') !== after.join('\n')) return 'the set of signed-in providers changed';
    for (const key of before) {
      const a = previous[key];
      const b = next[key];
      if (!isRecord(a) || !isRecord(b)) return 'a provider entry is malformed';
      if (!sameStrings(a, b, ['user_id', 'principal_id', 'team_id'])) return 'the account identity changed';
      if (typeof b['refresh_token'] !== 'string' || typeof b['key'] !== 'string') return 'the refreshed credential is incomplete';
      if (!sameStrings(jwtClaims(a['key']), jwtClaims(b['key']), ['sub', 'principal_id', 'team_id'])) {
        return 'the access token belongs to a different account';
      }
    }
    return null;
  }
  const a = previous['tokens'];
  const b = next['tokens'];
  if (!isRecord(a) || !isRecord(b)) return 'tokens are missing';
  if (!sameStrings(a, b, ['account_id'])) return 'the account changed';
  if (typeof b['refresh_token'] !== 'string' || typeof b['access_token'] !== 'string') return 'the refreshed credential is incomplete';
  if (!sameStrings(jwtClaims(a['id_token']), jwtClaims(b['id_token']), ['sub'])) return 'the id token belongs to a different account';
  return null;
}

/** O_EXCL temp file (0600, no symlink following) + fsync + rename over `target`. */
function writePrivateAtomic(target: string, data: Buffer): void {
  const tmp = join(dirname(target), `.${Date.now().toString(36)}-${process.pid}.ashlr-writeback`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

/**
 * After an autonomous run: copy a refreshed credential back to the seat's real
 * vendor home, but only when (1) the run changed it, (2) the real file is
 * still exactly what was snapshotted (Mason's own session or another run did
 * not refresh it meanwhile), and (3) it is provably the same account. Call it
 * once the child has exited, before deleting runTmpDir. Never throws for a
 * refusal — it reports one; the real file is left as it was.
 */
export function commitAutonomousVendorState(overlay: AutonomousEnvOverlay): VendorCommitResult {
  const result: VendorCommitResult = { committed: [], skipped: [] };
  for (const state of overlay.vendorState ?? []) {
    for (const name of state.writeBack) {
      const before = state.snapshot[name];
      const real = join(state.realHome, name);
      const copy = join(state.ephemeralHome, name);
      try {
        if (before === undefined) {
          result.skipped.push({ file: real, reason: 'not part of the snapshot' });
          continue;
        }
        if (regularFile(copy, MAX_AUTH_FILE_BYTES) === null) {
          result.skipped.push({ file: real, reason: 'the run removed it' });
          continue;
        }
        const nextBytes = readFileSync(copy);
        if (createHash('sha256').update(nextBytes).digest('hex') === before) {
          result.skipped.push({ file: real, reason: 'unchanged' });
          continue;
        }
        if (regularFile(real, MAX_AUTH_FILE_BYTES) === null || sha256File(real) !== before) {
          result.skipped.push({ file: real, reason: 'changed-elsewhere' });
          continue;
        }
        const refusal = sameVendorAccount(state.engineClass, JSON.parse(readFileSync(real, 'utf8')), JSON.parse(nextBytes.toString('utf8')));
        if (refusal) {
          result.skipped.push({ file: real, reason: `refused: ${refusal}` });
          continue;
        }
        writePrivateAtomic(real, nextBytes);
        result.committed.push(real);
      } catch (error) {
        result.skipped.push({ file: real, reason: error instanceof SyntaxError ? 'refused: not valid JSON' : 'refused: unreadable' });
      }
    }
  }
  return result;
}

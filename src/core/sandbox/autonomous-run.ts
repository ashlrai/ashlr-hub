/**
 * autonomous-run — V3.10 integration (INT4): the ONE way a process that works
 * on agent-authored code is started while a standing policy is live.
 *
 * B-U2 built the pieces (autonomous-env overlay, the hardened SBPL profile,
 * the vendor-state write-back, the violation scanners) and asked the producer
 * (U6), the judges (U7) and G3 verification (U3) to assemble them in exactly
 * this order:
 *
 *   1. a private 0700 run dir (canonical path, under the real temp dir);
 *   2. buildAutonomousEnvOverlay(...) → applyAutonomousEnvOverlay(env) —
 *      ephemeral HOME / XDG / caches, credentials removed, per-run copy of a
 *      seat's vendor home (GROK_HOME / CODEX_HOME);
 *   3. the engine credential, added by the CALLER after the overlay;
 *   4. buildSandboxLauncher(profile, {worktree, home, env, overlay});
 *   5. run;
 *   6. commitAutonomousVendorState(overlay) (a refreshed OAuth token goes
 *      back only when it is provably the same account), violation scan,
 *      then the run dir is deleted.
 *
 * Doing it in one module means the three callers cannot drift (e.g. one of
 * them forgetting the write-back and signing grok-a out every ~6 h, or
 * forgetting to delete a run dir that holds a copy of auth.json).
 *
 * EXECUTABLES UNDER HOME. The autonomous profile read-jails all of HOME, and
 * the overlay's PATH drops every HOME entry, so a binary installed under HOME
 * (claude in ~/.local/share, grok in ~/.grok/downloads, node in ~/.hermes)
 * would fail to exec. resolveConfinedExecutable() resolves the binary through
 * the ORIGINAL PATH to its real file and returns exactly what must become
 * readable (never writable): the file, the package root of a node_modules
 * script, and the node install prefix for a `#!/usr/bin/env node` script.
 * The node prefix also goes back on PATH so agents and test suites can run
 * node/npm; its bin dir is read-only, so nothing planted there survives.
 */
import { accessSync, closeSync, constants as fsConstants, existsSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

import {
  applyAutonomousEnvOverlay,
  buildAutonomousEnvOverlay,
  commitAutonomousVendorState,
  type AutonomousEnvOverlay,
  type VendorCommitResult,
} from './autonomous-env.js';
import {
  autonomousConfinementProfile,
  autonomousVerificationProfile,
  buildSandboxLauncher,
  ConfinementUnsupportedError,
  isSandboxTripwireKill,
  sandboxViolationsInOutput,
  type ConfinementProfile,
  type SandboxLauncher,
} from './confine.js';

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Is `p` inside an area the autonomous profile read-jails (HOME, /Users,
 * /Volumes, the shared temp dirs)? Only such paths need an explicit grant.
 */
function isJailed(p: string, home: string): boolean {
  const roots = [home, '/Users', '/Volumes', '/private/tmp', '/private/var/tmp'];
  try { roots.push(realpathSync(tmpdir())); } catch { /* ignore */ }
  return roots.some((root) => isInside(p, root));
}

function realHome(home?: string): string {
  const raw = home ?? process.env['HOME'] ?? homedir();
  if (!raw || !isAbsolute(raw)) throw new ConfinementUnsupportedError('autonomous runs need an absolute HOME');
  try {
    return realpathSync(raw);
  } catch {
    throw new ConfinementUnsupportedError('autonomous runs need an existing HOME');
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First `name` on `pathEnv` that is an executable file, or null. */
export function lookupOnPath(name: string, pathEnv: string): string | null {
  if (name.includes('/')) return isAbsolute(name) && isExecutableFile(name) ? name : null;
  for (const entry of pathEnv.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** The `#!` line of `file` (first 256 bytes), or null. */
function shebangOf(file: string): string[] | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    if (!text.startsWith('#!')) return null;
    const line = text.slice(2).split('\n')[0]!.trim();
    return line.length > 0 ? line.split(/\s+/) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** `<…>/node_modules/<pkg>` or `<…>/node_modules/@scope/<pkg>` containing `file`, or null. */
function nodePackageRoot(file: string): string | null {
  const parts = file.split(sep);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length - 1) return null;
  const take = parts[at + 1]!.startsWith('@') ? at + 3 : at + 2;
  if (take > parts.length - 1) return null;
  return parts.slice(0, take).join(sep) || null;
}

export interface NodeToolchain {
  /** Real node binary. */
  node: string;
  /** Install prefix (`<prefix>/bin/node`) — made readable when it lives under HOME. */
  prefix: string;
  /** `<prefix>/bin`, put back on the confined PATH. */
  binDir: string;
}

/**
 * The node install the daemon itself would use (`node` on the original PATH),
 * when it lives in a read-jailed area (normally under HOME) — the only case
 * where the confined child needs it made readable and put back on PATH. Null
 * when node is outside the jail (already readable, on the sanitized PATH) or
 * absent.
 */
export function homeNodeToolchain(pathEnv: string, home: string): NodeToolchain | null {
  const found = lookupOnPath('node', pathEnv);
  if (!found) return null;
  let node: string;
  try { node = realpathSync(found); } catch { return null; }
  if (!isJailed(node, home)) return null;
  const binDir = dirname(node);
  const prefix = dirname(binDir);
  // Only a real node install prefix, and never HOME (or an ancestor of it) or
  // a directory directly under it: a prefix of `~/.local` would re-open
  // ~/.local/share (other apps' data) — exactly what the jail exists to hide.
  if (isInside(home, prefix) || isInside(home, dirname(prefix))) return null;
  if (!existsSync(join(prefix, 'lib', 'node_modules')) && !existsSync(join(prefix, 'include', 'node'))) return null;
  return { node, prefix, binDir };
}

export interface ConfinedExecutable {
  /** Absolute path to exec: the real file when found under HOME, else the PATH entry as found. */
  bin: string;
  /** Paths that must be readable (read-only) for the exec to work. */
  readOnly: string[];
  /** Directories to put back on the confined PATH (front). */
  pathPrepend: string[];
}

/**
 * Resolve `bin` (bare name or absolute) through `pathEnv` for a confined exec.
 * Throws ConfinementUnsupportedError when it cannot be found.
 */
export function resolveConfinedExecutable(bin: string, pathEnv: string, home: string): ConfinedExecutable {
  const found = lookupOnPath(bin, pathEnv);
  if (!found) throw new ConfinementUnsupportedError(`engine executable ${JSON.stringify(bin.slice(0, 80))} not found on PATH`);
  let real: string;
  try { real = realpathSync(found); } catch { throw new ConfinementUnsupportedError('engine executable cannot be resolved'); }
  const readOnly: string[] = [];
  const pathPrepend: string[] = [];
  const add = (p: string | null): void => { if (p && !readOnly.includes(p)) readOnly.push(p); };
  // Always granted (read-only): a no-op outside the jail, required inside it
  // (HOME, /Users, the temp dirs). A node_modules script needs its package.
  add(nodePackageRoot(real) ?? real);
  const shebang = shebangOf(real);
  if (shebang) {
    const interpreter = shebang[0] === '/usr/bin/env' ? shebang.find((w, i) => i > 0 && !w.startsWith('-')) ?? null : shebang[0]!;
    if (interpreter && isAbsolute(interpreter)) {
      try {
        const interp = realpathSync(interpreter);
        if (isJailed(interp, home)) add(interp);
      } catch { /* the exec will fail loudly */ }
    }
    if (interpreter && /(^|\/)node$/.test(interpreter)) {
      const toolchain = homeNodeToolchain(pathEnv, home);
      if (toolchain) {
        add(toolchain.prefix);
        pathPrepend.push(toolchain.binDir);
      }
    }
  }
  // Exec the REAL file only when the PATH entry itself is read-jailed (under
  // HOME or a temp dir the jail cannot even readlink in). Otherwise keep the name as found:
  // it resolves inside the sandbox, and its basename is what the local-only
  // spawn gate and engines.ts's per-CLI parsers key on (`codex`, not
  // `codex.js`).
  return { bin: isJailed(found, home) ? real : found, readOnly, pathPrepend };
}

export interface AutonomousSpawnInput {
  /** Registry engine id (drives the confinement class: local / grok-cli / claude-cli / codex). */
  engine: string;
  /** The directory the child works in (sandbox worktree, verify worktree, judge scratch dir). Must exist. */
  worktree: string;
  /** The env the caller would otherwise have used; the overlay strips credentials from it. */
  baseEnv: NodeJS.ProcessEnv;
  /** The command's executable (bare or absolute), resolved through baseEnv.PATH. */
  bin: string;
  home?: string;
  seatId?: string | null;
  /** grok-cli / codex: the seat's pinned vendor home (native profile `nativeStatePath`). */
  nativeStatePath?: string | null;
  /** More read-only paths (e.g. the pre-push hooks dir, a mirror's node_modules). */
  extraReadOnly?: readonly string[];
  /** Default: autonomousConfinementProfile(engine). */
  profile?: ConfinementProfile;
  /** Give the child the daemon's node on PATH (verification, agents that run tests). Default true. */
  nodeToolchain?: boolean;
  /** Parent of the run dir; default the real temp dir. */
  runParent?: string;
}

export interface AutonomousSpawn {
  /** Absolute real executable to spawn (after the launcher prefix). */
  bin: string;
  /** The child env: overlay applied; add the engine credential (if any) AFTER this. */
  env: NodeJS.ProcessEnv;
  launcher: SandboxLauncher;
  overlay: AutonomousEnvOverlay;
  profile: ConfinementProfile;
  /** The run's private dir (holds ephemeral homes and vendor-state copies). */
  runDir: string;
  /** The real HOME (for violation paths). */
  home: string;
}

/**
 * Steps 1–4 above. Throws (ConfinementUnsupportedError or the overlay's
 * error) when the run cannot be confined exactly as specified — the caller
 * must then NOT run the engine ("no confinement means no ticks"). On a throw
 * the run dir is already removed.
 */
export function prepareAutonomousSpawn(input: AutonomousSpawnInput): AutonomousSpawn {
  const home = realHome(input.home);
  const originalPath = input.baseEnv['PATH'] ?? process.env['PATH'] ?? '';
  const exe = resolveConfinedExecutable(input.bin, originalPath, home);
  const toolchain = input.nodeToolchain === false ? null : homeNodeToolchain(originalPath, home);
  const parent = realpathSync(input.runParent ?? tmpdir());
  const runDir = realpathSync(mkdtempSync(join(parent, 'ashlr-run-')));
  try {
    const readOnly = [...exe.readOnly];
    if (toolchain && !readOnly.includes(toolchain.prefix)) readOnly.push(toolchain.prefix);
    for (const p of input.extraReadOnly ?? []) {
      try { readOnly.push(realpathSync(p)); } catch { /* absent extras are simply not granted */ }
    }
    const overlay = buildAutonomousEnvOverlay({
      engine: input.engine,
      runTmpDir: runDir,
      home,
      seatId: input.seatId ?? null,
      ...(input.nativeStatePath !== undefined ? { nativeStatePath: input.nativeStatePath } : {}),
      executables: readOnly,
      path: originalPath,
    });
    const env = applyAutonomousEnvOverlay(input.baseEnv, overlay);
    const prepend = [...exe.pathPrepend];
    if (toolchain && !prepend.includes(toolchain.binDir)) prepend.push(toolchain.binDir);
    if (prepend.length > 0) env['PATH'] = [...prepend, ...(env['PATH'] ?? '').split(delimiter).filter((p) => p && !prepend.includes(p))].join(delimiter);
    const profile = input.profile ?? autonomousConfinementProfile(input.engine);
    const launcher = buildSandboxLauncher(profile, { worktree: input.worktree, home, env, overlay });
    if (!launcher) throw new ConfinementUnsupportedError('no sandbox launcher for an autonomous run');
    return { bin: exe.bin, env, launcher, overlay, profile, runDir, home };
  } catch (error) {
    try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export interface AutonomousSpawnOutcome {
  /** stdout + stderr (or the engine's output and error) to scan. */
  output: string;
  /** The engine died of SIGKILL that the daemon did not send (a tripwire). */
  tripwireKill?: boolean;
}

export interface AutonomousSpawnFinish {
  /** `access ~/.ashlr/authority`-style operations for sandbox:violation rows (deduplicated). */
  violations: string[];
  vendor: VendorCommitResult;
}

/**
 * Step 6: write a refreshed vendor credential back (validated), scan for
 * violations, delete the run dir. Never throws. Call once, after the child
 * has exited.
 */
export function finishAutonomousSpawn(spawn: AutonomousSpawn, outcome: AutonomousSpawnOutcome): AutonomousSpawnFinish {
  let vendor: VendorCommitResult = { committed: [], skipped: [] };
  try {
    vendor = commitAutonomousVendorState(spawn.overlay);
  } catch { /* commit never throws by contract; defensive */ }
  const violations = new Set<string>();
  try {
    for (const v of sandboxViolationsInOutput(outcome.output, spawn.home)) violations.add(v);
  } catch { /* best effort */ }
  if (outcome.tripwireKill) violations.add('signal SIGKILL (a protected-path tripwire killed the engine)');
  disposeAutonomousSpawn(spawn);
  return { violations: [...violations].sort(), vendor };
}

/** Delete the run dir (idempotent). */
export function disposeAutonomousSpawn(spawn: Pick<AutonomousSpawn, 'runDir'>): void {
  try { rmSync(spawn.runDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * One `sandbox:violation` ledger row per distinct operation an autonomous
 * process was caught attempting (tripwire kill, or a denial naming a
 * protected path / escape tool in its output), plus an audit line. Any one
 * row regresses the rollout (authority/rollout.ts) — that is the point.
 * Best-effort and never throws: the denial itself already held, and a ledger
 * that cannot be written is the rollout's own fail-closed signal.
 */
export async function recordAutonomousViolations(input: {
  engine: string;
  /** Local repo path (mapped to owner/name for the row), or null (judges). */
  sourceRepo: string | null;
  runId: string | null;
  operations: readonly string[];
}): Promise<void> {
  if (input.operations.length === 0) return;
  let repo: string | null = null;
  try {
    const [{ appendLedger }, { currentStandingPolicy }, { repoIdentityOfPath }] = await Promise.all([
      import('../authority/ledger.js'),
      import('../authority/effective-config.js'),
      import('../fleet/repo-identity.js'),
    ]);
    let grantId: string | null = null;
    try { grantId = currentStandingPolicy()?.grantId ?? null; } catch { grantId = null; }
    try { repo = input.sourceRepo ? repoIdentityOfPath(input.sourceRepo) : null; } catch { repo = null; }
    const at = new Date().toISOString();
    for (const operation of input.operations.slice(0, 32)) {
      appendLedger({
        kind: 'sandbox:violation',
        data: { v: 1, engine: input.engine, repo, runId: input.runId, operation: operation.slice(0, 300), at },
        actor: 'daemon',
        grantId,
        repo,
      });
    }
  } catch { /* see above */ }
  try {
    const { audit } = await import('./audit.js');
    audit({
      action: 'confinement.violation',
      repo: input.sourceRepo ?? repo ?? '(none)',
      sandboxId: null,
      summary: `engine=${input.engine} run=${input.runId ?? '-'} violations=${input.operations.length}: ${input.operations.slice(0, 5).join('; ').slice(0, 400)}`,
      result: 'refused',
    });
  } catch { /* audit is best-effort */ }
}

/** Did a spawnEngine result die of a SIGKILL the daemon did not send? */
export function engineResultTripwireKill(res: { error?: string; terminationReason?: string }): boolean {
  return isSandboxTripwireKill({
    signal: /killed by signal SIGKILL\b/.test(res.error ?? '') ? 'SIGKILL' : null,
    killedByDaemon: res.terminationReason !== undefined,
  });
}

// ---------------------------------------------------------------------------
// G3 — confined verification (B-U3 → U2 request)
// ---------------------------------------------------------------------------

export interface ConfinedVerification {
  /** Prefix for the verify command's argv: [sandbox-exec, -p, <profile>]. */
  prefix: string[];
  /** The command env with the overlay applied (no credentials, ephemeral HOME/caches, node on PATH). */
  env: NodeJS.ProcessEnv;
  runDir: string;
  dispose(): void;
}

/**
 * Confine one repo's verification (G3) on agent-authored code: the same
 * hardening as an agent run with an overlay for engine `local` (no vendor
 * state, no network egress), except that the suite may serve and connect on
 * loopback (autonomousVerificationProfile). `readOnly` names what the suite
 * needs to read beyond its worktree — typically the mirror's node_modules,
 * which verify worktrees symlink to. The verify command itself is exec'd
 * through the prefix unchanged (its argv came from the BASE tree, H1a).
 */
export function prepareConfinedVerification(input: {
  worktree: string;
  baseEnv: NodeJS.ProcessEnv;
  readOnly?: readonly string[];
  home?: string;
  runParent?: string;
}): ConfinedVerification {
  const spawn = prepareAutonomousSpawn({
    engine: 'local',
    worktree: input.worktree,
    baseEnv: input.baseEnv,
    // /bin/sh is always outside HOME; the verify argv is appended after the
    // launcher prefix by the caller.
    bin: '/bin/sh',
    ...(input.home ? { home: input.home } : {}),
    ...(input.readOnly ? { extraReadOnly: input.readOnly } : {}),
    profile: autonomousVerificationProfile(),
    ...(input.runParent ? { runParent: input.runParent } : {}),
  });
  return {
    prefix: [spawn.launcher.bin, ...spawn.launcher.prefixArgs],
    env: spawn.env,
    runDir: spawn.runDir,
    dispose: () => disposeAutonomousSpawn(spawn),
  };
}

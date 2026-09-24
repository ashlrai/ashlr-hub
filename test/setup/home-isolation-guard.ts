/**
 * Global test setup: FAIL any test that writes under the developer's REAL
 * `~/.ashlr` — and block the write before it lands.
 *
 * WHY THIS EXISTS (and why test/setup/home.ts is not enough):
 *   home.ts relocates HOME/USERPROFILE/ASHLR_HOME to a per-worker tmp dir and
 *   makes `os.homedir()` throw when HOME is cleared or points at the real home.
 *   That closes the env-var vectors, but not:
 *     - code that resolves the account home from the passwd entry on purpose
 *       (`os.userInfo().homedir` — runtime-activation-transaction.ts,
 *       runtime-activation-launch-handoff.ts) or from a path captured at
 *       module scope before a test relocated HOME;
 *     - absolute fixture paths built from a stale/cached home;
 *     - writers that swallow errors ("never throws" ledgers), so a leak is
 *       silent even when something upstream noticed.
 *   The 2026-08-05 incident (fixture UUIDs in the real ~/.ashlr/daemon.json,
 *   doctor bricked for 11 days) and the Sep 17–19 burst of 83 `kill:on` rows in
 *   the real audit log are exactly this class. This guard enforces the
 *   invariant at the ONLY chokepoint every writer shares: the `node:fs`
 *   mutation API.
 *
 * HOW:
 *   - Every mutating `node:fs` entry point (sync, callback, and `fs.promises`,
 *     plus `createWriteStream` and write-mode `open`) is wrapped on the
 *     builtin module object, then `syncBuiltinESMExports()` propagates the
 *     wrappers to ESM named imports (`import { writeFileSync } from 'node:fs'`,
 *     `node:fs/promises`). Installed once per worker process; test-file
 *     isolation re-runs this file but never double-wraps.
 *   - A write whose target resolves (lexically AND through symlinks of the
 *     deepest existing ancestor) inside a protected root is refused with an
 *     EACCES-shaped error and recorded. Removing/renaming an ANCESTOR of a
 *     protected root (e.g. `rmSync(realHome, { recursive: true })`) is refused too.
 *   - `afterEach` / `afterAll` fail the test if any violation was recorded —
 *     even when the code under test caught and swallowed the error.
 *
 * PROTECTED ROOTS: `<real home>/.ashlr` for the home home.ts captured from the
 * ambient environment (ASHLR_VITEST_REAL_HOME) and for the passwd account home
 * (read from the NATIVE os module, so a test's `vi.mock('node:os')` cannot hide
 * it). A root that contains the worker's own tmp HOME is never protected.
 *
 * LIMITS: child processes (git, spawned node scripts) run outside this hook;
 * they inherit the isolated HOME from home.ts. Reads are never blocked.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect } from 'vitest';

type FsModule = typeof import('node:fs');
type OsModule = typeof import('node:os');

// The NATIVE builtins, never a vitest mock: patching the real module object is
// what reaches every importer, and reading the passwd home through a test's
// `vi.mock('node:os')` could hide the very root we must protect.
const nativeRequire = createRequire(import.meta.url);
const fs = nativeRequire('node:fs') as FsModule;
const os = nativeRequire('node:os') as OsModule;

export interface HomeGuardViolation {
  readonly op: string;
  readonly path: string;
  readonly root: string;
  readonly test: string;
}

/** How a path argument is checked. */
type PathMode =
  /** Create/modify the file the path names; follows a final symlink. */
  | 'write'
  /** Remove/rename/relink the entry itself; never follows the final component,
   *  and also refuses when the entry is an ANCESTOR of a protected root. */
  | 'remove';

interface OpSpec {
  readonly name: string;
  readonly paths: ReadonlyArray<readonly [index: number, mode: PathMode]>;
  /** Index of the open(2) flags argument; the op is guarded only in write modes. */
  readonly flagsIndex?: number;
}

const OPS: readonly OpSpec[] = [
  { name: 'writeFile', paths: [[0, 'write']] },
  { name: 'appendFile', paths: [[0, 'write']] },
  { name: 'mkdir', paths: [[0, 'write']] },
  { name: 'mkdtemp', paths: [[0, 'write']] },
  { name: 'truncate', paths: [[0, 'write']] },
  { name: 'chmod', paths: [[0, 'write']] },
  { name: 'chown', paths: [[0, 'write']] },
  { name: 'utimes', paths: [[0, 'write']] },
  { name: 'lchown', paths: [[0, 'remove']] },
  { name: 'lutimes', paths: [[0, 'remove']] },
  { name: 'copyFile', paths: [[1, 'write']] },
  { name: 'cp', paths: [[1, 'write']] },
  { name: 'symlink', paths: [[1, 'remove']] },
  { name: 'link', paths: [[1, 'remove']] },
  { name: 'rename', paths: [[0, 'remove'], [1, 'remove']] },
  { name: 'rm', paths: [[0, 'remove']] },
  { name: 'rmdir', paths: [[0, 'remove']] },
  { name: 'unlink', paths: [[0, 'remove']] },
  { name: 'open', paths: [[0, 'write']], flagsIndex: 1 },
];

const WRITE_OPEN_BITS =
  fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;

/** open(2) flags that can create or modify a file. `undefined` means 'r'. */
export function isWriteOpenFlag(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') return (flags & WRITE_OPEN_BITS) !== 0;
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return true; // unknown shape: fail closed
}

/** A path-like argument as a string; `null` for fds / FileHandles / non-file URLs. */
function pathArg(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : null;
  return null;
}

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function fold(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

function within(target: string, root: string): boolean {
  const t = fold(target);
  const r = fold(root);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

const realpathNative = fs.realpathSync.native;

/**
 * The canonical location of `abs`: realpath of its deepest EXISTING ancestor
 * joined with the not-yet-existing remainder. With `followFinal=false` the
 * final component is kept literal (unlink/rename act on the link, not its target).
 */
function canonicalize(abs: string, followFinal: boolean): string | null {
  const head = followFinal ? abs : dirname(abs);
  const tail = followFinal ? [] : [basename(abs)];
  let cursor = head;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathNative(cursor), ...rest.reverse(), ...tail);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      rest.push(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * The protected root `target` would write into, or null. Checked lexically
 * first (cheap, and catches not-yet-created trees) and then canonically, so a
 * tmp-dir symlink into the real `~/.ashlr` cannot launder a write.
 */
export function protectedRootFor(
  target: string,
  mode: PathMode,
  roots: readonly string[],
): string | null {
  if (roots.length === 0) return null;
  const abs = resolve(target);
  const candidates = [abs];
  const canonical = canonicalize(abs, mode === 'write');
  if (canonical && canonical !== abs) candidates.push(canonical);
  for (const root of roots) {
    for (const c of candidates) {
      if (within(c, root)) return root;
      // Deleting or moving an ancestor (the home itself, `/Users`) takes the
      // protected tree with it.
      if (mode === 'remove' && within(root, c)) return root;
    }
  }
  return null;
}

/**
 * `<home>/.ashlr` for every REAL home this worker can name. The worker's own
 * tmp HOME is never protected, even if the ambient HOME was already a tmp dir.
 */
export function resolveProtectedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const homes = new Set<string>();
  const captured = env['ASHLR_VITEST_REAL_HOME'];
  if (captured) homes.add(resolve(captured));
  try {
    const account = os.userInfo().homedir;
    if (account) homes.add(resolve(account));
  } catch {
    // No passwd entry (some containers): the captured env home still applies.
  }
  const workerHome = env['ASHLR_VITEST_WORKER_HOME'];
  const roots: string[] = [];
  for (const home of homes) {
    if (home === sep || home.length <= 1) continue;
    const root = join(home, '.ashlr');
    const expanded = [root];
    try {
      const real = realpathNative(root);
      if (real !== root) expanded.push(real);
    } catch {
      // Not created yet: the lexical root is still the boundary.
    }
    for (const r of expanded) {
      if (workerHome && within(resolve(workerHome), r)) continue;
      if (!roots.includes(r)) roots.push(r);
    }
  }
  return roots;
}

function guardError(op: string, target: string, root: string): NodeJS.ErrnoException {
  const err = new Error(
    `EACCES: HOME isolation guard blocked fs.${op}('${target}') — it resolves under the REAL ` +
      `${root}. Tests must only write inside the isolated worker HOME (test/setup/home.ts). ` +
      'Resolve paths from homedir()/ASHLR_HOME at call time, not at module scope, and never ' +
      'from os.userInfo().homedir in a test path.',
  ) as NodeJS.ErrnoException;
  err.code = 'EACCES';
  err.errno = -13;
  err.syscall = op;
  err.path = target;
  return err;
}

type AnyFn = (...args: unknown[]) => unknown;
type Variant = 'sync' | 'callback' | 'promise';

interface GuardHandle {
  readonly uninstall: () => void;
}

/**
 * Wrap every mutating fs entry point. `roots()` is consulted per call so a
 * test harness can point a second guard at a fake home; `onViolation` records.
 * Returns a handle that restores the exact originals (LIFO-safe).
 */
export function installFsWriteGuard(
  roots: () => readonly string[],
  onViolation: (v: HomeGuardViolation) => void,
): GuardHandle {
  const restores: Array<() => void> = [];

  function check(spec: OpSpec, args: unknown[]): NodeJS.ErrnoException | null {
    if (spec.flagsIndex !== undefined) {
      const flags = typeof args[spec.flagsIndex] === 'function' ? undefined : args[spec.flagsIndex];
      if (!isWriteOpenFlag(flags)) return null;
    }
    const protectedRoots = roots();
    for (const [index, mode] of spec.paths) {
      const target = pathArg(args[index]);
      if (target === null) continue;
      const root = protectedRootFor(target, mode, protectedRoots);
      if (root) {
        onViolation({ op: spec.name, path: resolve(target), root, test: currentTestLabel() });
        return guardError(spec.name, target, root);
      }
    }
    return null;
  }

  function wrap(target: Record<string, unknown>, key: string, spec: OpSpec, variant: Variant): void {
    const original = target[key];
    if (typeof original !== 'function') return;
    const fn = original as AnyFn;
    const wrapped = function guarded(this: unknown, ...args: unknown[]): unknown {
      const err = check(spec, args);
      if (err) {
        if (variant === 'promise') return Promise.reject(err);
        if (variant === 'callback') {
          const cb = args[args.length - 1];
          if (typeof cb === 'function') {
            process.nextTick(() => (cb as (e: Error) => void)(err));
            return undefined;
          }
        }
        throw err;
      }
      return fn.apply(this, args);
    };
    // Preserve util.promisify.custom etc. (fs.exists-style) and the name.
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(fn));
    target[key] = wrapped;
    restores.push(() => {
      if (target[key] === wrapped) target[key] = original;
    });
  }

  const fsObj = fs as unknown as Record<string, unknown>;
  const promisesObj = fs.promises as unknown as Record<string, unknown>;
  for (const spec of OPS) {
    wrap(fsObj, `${spec.name}Sync`, spec, 'sync');
    wrap(fsObj, spec.name, spec, 'callback');
    wrap(promisesObj, spec.name, spec, 'promise');
  }
  wrap(fsObj, 'createWriteStream', { name: 'createWriteStream', paths: [[0, 'write']] }, 'sync');
  syncBuiltinESMExports();

  return {
    uninstall: () => {
      while (restores.length > 0) restores.pop()!();
      syncBuiltinESMExports();
    },
  };
}

function currentTestLabel(): string {
  try {
    const state = expect.getState();
    const file = state.testPath ? basename(state.testPath) : '(unknown file)';
    return state.currentTestName
      ? `${file} > ${state.currentTestName}`
      : `${file} (module load / hook outside a test)`;
  } catch {
    return '(outside vitest)';
  }
}

export function formatViolations(violations: readonly HomeGuardViolation[]): string {
  const lines = violations.map((v) => `  - fs.${v.op}('${v.path}') under ${v.root}  [${v.test}]`);
  return (
    `HOME isolation guard: ${violations.length} write(s) targeted the REAL ~/.ashlr and were blocked ` +
    `(test/setup/home-isolation-guard.ts):\n${lines.join('\n')}`
  );
}

// ---------------------------------------------------------------------------
// Process-wide install (setup files re-run per test file; the fs patch must not)
// ---------------------------------------------------------------------------

interface GuardState {
  roots: string[];
  violations: HomeGuardViolation[];
  handle: GuardHandle;
}

const STATE_KEY = Symbol.for('ashlr.vitest.homeIsolationGuard');
const globalRef = globalThis as typeof globalThis & { [STATE_KEY]?: GuardState };

function ensureInstalled(): GuardState {
  const existing = globalRef[STATE_KEY];
  if (existing) return existing;
  const state = {
    roots: resolveProtectedRoots(),
    violations: [] as HomeGuardViolation[],
  } as GuardState;
  state.handle = installFsWriteGuard(() => state.roots, (v) => state.violations.push(v));
  globalRef[STATE_KEY] = state;
  return state;
}

/** The process-wide guard state (protected roots, pending violations). */
export function homeIsolationGuardState(): Readonly<Pick<GuardState, 'roots' | 'violations'>> {
  return ensureInstalled();
}

/** Drain pending violations and throw if there were any. */
export function assertNoRealHomeWrites(): void {
  const state = ensureInstalled();
  if (state.violations.length === 0) return;
  const drained = state.violations.splice(0, state.violations.length);
  throw new Error(formatViolations(drained));
}

ensureInstalled();
afterEach(() => {
  assertNoRealHomeWrites();
});
afterAll(() => {
  assertNoRealHomeWrites();
});

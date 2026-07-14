/**
 * src/cli/demo-sandbox.ts — H8 shared isolation module for `ashlr demo`.
 *
 * MILESTONE H8 "Harden & Prove" (FINAL). This module factors the
 * DISPOSABLE-repo + ISOLATED-tmp-`~/.ashlr` setup/teardown out of `demo.ts`
 * (and away from `test/`) so the demo applies the EXACT same isolation discipline
 * the H1 testkit encodes (`test/helpers/h1-fixture.ts:makeFixture`) — but as a
 * shippable CLI helper rather than a test-only one. See
 * docs/contracts/CONTRACT-H8.md (BUILD ITEM 1).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ABSOLUTE SAFETY RULES (paramount — encoded directly in these helpers):
 *   - HOME is relocated to a FRESH os.tmpdir() dir so every state read/write
 *     resolves to an ISOLATED ~/.ashlr — NEVER the real one. The real portfolio
 *     (~/.ashlr/enrollment.json = { repos: [] }) is NEVER touched. The prior
 *     HOME + re-entrancy env (ASHLR_IN_DAEMON / ASHLR_IN_SWARM) are snapshotted
 *     and RESTORED on dispose().
 *   - A sanity guard asserts homedir() resolves to the tmp HOME before the demo
 *     proceeds; if relocation did not take effect it RESTORES + ABORTS rather
 *     than risk mutating the real ~/.ashlr (mirrors makeFixture's guard).
 *   - The throwaway repo is a real git repo under os.tmpdir(), seeded with a
 *     `// TODO:` marker so the backlog scan finds work. dispose() unenrolls it,
 *     sweeps its sandboxes, rm -rf's the repo + the tmp HOME, and restores env.
 *   - dispose() is IDEMPOTENT and NEVER throws (best-effort teardown), so the
 *     demo's try/finally + signal handler can always clean up safely.
 *
 * IMPLEMENTATION NOTE: this module encodes the SAME disposable-repo + TODO-seed
 * isolation discipline the H1 testkit (`test/helpers/h1-fixture.ts`) uses, but
 * SELF-CONTAINED in `src/` — a shipped CLI module cannot import from `test/`
 * (the build's `rootDir` is `src/`). The handful of git/seed primitives are tiny
 * and use node builtins + git only, so duplicating them here (rather than
 * importing a test helper) is the correct seam per docs/contracts/CONTRACT-H8.md ("factors them
 * out of `test/` into a shippable module"). No new runtime dep is added.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { unenroll } from '../core/sandbox/policy.js';
import { sweepRepoSandboxes } from '../core/sandbox/worktree.js';

export interface DemoDisposeResult {
  /** True only when policy removal completed while outward mutations were quiesced. */
  readonly unenrolled: boolean;
  readonly reason: string;
}

/**
 * A live, ISOLATED demo context: a fresh tmp HOME (so `~/.ashlr` is isolated)
 * plus a single DISPOSABLE git repo seeded with a TODO so the backlog finds
 * work. Obtain via {@link makeDemoContext}; always tear down via
 * {@link DemoContext.dispose} (idempotent, never throws).
 */
export interface DemoContext {
  /** Absolute path of the isolated tmp HOME (process.env.HOME for the demo). */
  readonly home: string;
  /** Absolute path of the isolated ~/.ashlr under the tmp HOME. */
  readonly ashlrDir: string;
  /** Absolute path of the DISPOSABLE git repo (under os.tmpdir()). */
  readonly repoDir: string;
  /**
   * Tear down: unenroll the tmp repo, sweep its sandboxes, restore HOME + the
   * re-entrancy env, and (unless {@link MakeDemoContextOptions.keep}) rm -rf the
   * tmp repo + tmp HOME. Idempotent; never throws. When `keep` is set, the tmp
   * dir is preserved (still under os.tmpdir()) for inspection.
   */
  dispose(): DemoDisposeResult;
}

/** Options for {@link makeDemoContext}. */
export interface MakeDemoContextOptions {
  /**
   * When true (`ashlr demo --no-cleanup`), dispose() still unenrolls + restores
   * env but does NOT rm -rf the tmp dir — it is kept (still under os.tmpdir())
   * for inspection. Default false (auto-clean).
   */
  keep?: boolean;
}

/**
 * Create an ISOLATED demo context: snapshot + relocate `process.env.HOME` to a
 * fresh os.tmpdir() dir, clear the re-entrancy env, ASSERT homedir() now
 * resolves to the tmp HOME (else restore + throw), then create a DISPOSABLE git
 * repo seeded with a `// TODO:` marker.
 *
 * The returned context's `dispose()` performs the guaranteed auto-cleanup. The
 * caller MUST invoke it in a `try/finally` (and from a SIGINT/SIGTERM handler)
 * so the tmp state is always reclaimed.
 *
 * @throws if HOME relocation does not take effect (isolation broken) — fails
 *   loudly rather than risk touching the real ~/.ashlr.
 */
export function makeDemoContext(opts?: MakeDemoContextOptions): DemoContext {
  const keep = opts?.keep === true;

  // 1. Snapshot the prior HOME + re-entrancy env so dispose() can restore them
  //    EXACTLY as found (an undefined var must be re-deleted, not set to '').
  const prevHome = process.env.HOME;
  const prevInDaemon = process.env.ASHLR_IN_DAEMON;
  const prevInSwarm = process.env.ASHLR_IN_SWARM;

  // 2. Relocate HOME to a fresh tmp dir; clear the re-entrancy guard so a
  //    daemon tick is not refused by the recursion check.
  // PID in the prefix so concurrent processes (e.g. vitest's parallel forks)
  // never collide in the shared os.tmpdir() and a prefix-scoped sweep can target
  // only its own process's dirs. Real-world hygiene + race-free test cleanup.
  const home = mkdtempSync(join(tmpdir(), `ashlr-h8-demo-home-${process.pid}-`));
  process.env.HOME = home;
  delete process.env.ASHLR_IN_DAEMON;
  delete process.env.ASHLR_IN_SWARM;

  // Restore env to EXACTLY the snapshotted state. Shared by the abort guard and
  // dispose() so isolation is symmetric and never leaks a cleared var.
  const restoreEnv = (): void => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevInDaemon === undefined) delete process.env.ASHLR_IN_DAEMON;
    else process.env.ASHLR_IN_DAEMON = prevInDaemon;
    if (prevInSwarm === undefined) delete process.env.ASHLR_IN_SWARM;
    else process.env.ASHLR_IN_SWARM = prevInSwarm;
  };

  // 3. SANITY GUARD: homedir() must now resolve to the tmp HOME, otherwise
  //    isolation is broken on this platform and we MUST NOT proceed (it would
  //    risk the real ~/.ashlr). Restore env + rm the tmp dir + fail loudly —
  //    exactly as the H1 fixture's guard does.
  if (resolve(homedir()) !== resolve(home)) {
    restoreEnv();
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* idempotent — never throw from the abort path */
    }
    throw new Error(
      'ashlr demo: HOME relocation did not take effect (homedir() != tmp HOME); ' +
        'refusing to run to avoid touching the real ~/.ashlr',
    );
  }

  // 4. Create a DISPOSABLE git repo seeded with a `// TODO:` marker so the
  //    backlog scan finds REAL work (same discipline as the H1 testkit's
  //    makeDisposableRepo/todoSeedFiles, self-contained here).
  let repoDir: string;
  try {
    repoDir = seedDisposableRepo();
  } catch (err) {
    // Repo creation failed (e.g. git missing) — tear the tmp HOME back down and
    // restore env before re-throwing so we never strand isolated state.
    restoreEnv();
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* idempotent */
    }
    throw err;
  }

  // Once dispose() restores the REAL HOME, a second dispose() must be a TRUE
  // no-op — a repeat unenroll()/sweep would write into the REAL ~/.ashlr (policy
  // emits audit() on every enroll/unenroll since H6). This flag enforces genuine
  // idempotence so a double-dispose never leaks state to the real home.
  let disposed = false;
  let disposeResult: DemoDisposeResult | null = null;

  const dispose = (): DemoDisposeResult => {
    if (disposed) return disposeResult ?? { unenrolled: false, reason: 'cleanup outcome unavailable' };
    disposed = true;

    // a. Unenroll the tmp repo + sweep its sandboxes (the rollback) — STILL
    //    under the isolated HOME, so this writes only into the tmp ~/.ashlr.
    try {
      const result = unenroll(repoDir);
      disposeResult = {
        unenrolled: result === undefined || (result.ok && result.quiesced),
        reason: result?.reason ?? 'legacy cleanup completed',
      };
    } catch (err) {
      disposeResult = {
        unenrolled: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      sweepRepoSandboxes(repoDir);
    } catch {
      /* best-effort */
    }

    // b. rm -rf the tmp repo + tmp HOME (unless --no-cleanup keeps them).
    if (!keep) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch {
        /* idempotent */
      }
      try {
        if (existsSync(home)) rmSync(home, { recursive: true, force: true });
      } catch {
        /* idempotent */
      }
    }

    // c. Restore HOME + re-entrancy env LAST, so (a)/(b) ran isolated.
    restoreEnv();
    return disposeResult;
  };

  return {
    home,
    ashlrDir: join(home, '.ashlr'),
    repoDir,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// seedDisposableRepo — a real git repo under os.tmpdir(), seeded with a
// `// TODO:` marker + an initial commit so HEAD resolves and the backlog scan
// finds work. Self-contained (node builtins + git only) — the same discipline
// the H1 testkit's makeDisposableRepo/todoSeedFiles encode, inlined so a shipped
// src/ module never imports from test/.
// ---------------------------------------------------------------------------

const GIT_TIMEOUT = 30_000;

// HERMETIC git env: pin global/system config to /dev/null so the disposable
// repo never inherits the ambient (or the relocated tmp) HOME's `.gitconfig`,
// and never reads /etc git config. Without this the demo's HOME relocation
// (process.env.HOME → fresh tmp dir) makes git resolve config against a dir that
// can differ between back-to-back demo runs in one process, which intermittently
// breaks repo detection mid-sequence ("fatal: not in a git directory"). Pinning
// both config sources + an explicit cwd makes seeding fully deterministic and
// independent of any leaked/relocated git state. Mirrors the H1 testkit.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], {
    cwd: dir,
    env: GIT_ENV,
    timeout: GIT_TIMEOUT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function seedDisposableRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), `ashlr-h8-demo-repo-${process.pid}-`));

  // Self-contained git identity so commits never depend on global config, and
  // gpgsign off so CI signing config can't interfere (mirrors the H1 testkit).
  // `--local` pins every write to this repo's own config regardless of ambient
  // state (the GIT_ENV above already neutralises global/system config).
  git(dir, ['init', '--initial-branch=main', '.']);
  git(dir, ['config', '--local', 'user.email', 'demo@ashlr.local']);
  git(dir, ['config', '--local', 'user.name', 'Ashlr Demo']);
  git(dir, ['config', '--local', 'commit.gpgsign', 'false']);

  // A README so HEAD/docs are well-formed + one source file carrying a single
  // `// TODO:` so `scanTodos` (buildBacklog) discovers exactly one work item.
  const files: Record<string, string> = {
    'README.md': '# disposable demo repo\n',
    'src/todo-0.ts':
      'export function f0(): number {\n' +
      '  // TODO: implement f0 (deterministic discovery signal)\n' +
      '  return 0;\n}\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }

  git(dir, ['add', '-A']);
  git(dir, ['commit', '--no-verify', '-m', 'init']);

  return dir;
}

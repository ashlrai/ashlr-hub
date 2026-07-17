/**
 * test/helpers/h1-fixture.ts — H1 reusable test fixture (the TESTKIT).
 *
 * MILESTONE H1 "Harden & Prove" — the KEYSTONE. This fixture exists so the H1
 * end-to-end suites can drive the REAL autonomous chain
 *
 *   enroll -> backlog -> daemon tick -> sandboxed swarm -> PENDING proposal
 *           -> approve -> applyProposal
 *
 * on DISPOSABLE git repos inside an ISOLATED tmp HOME, while proving the safety
 * guarantees. It ships NO outward capability and NO production behavior change —
 * it is test-only helpers (production-safe, strictly typed, no runtime deps).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ABSOLUTE SAFETY RULES (paramount — encoded directly in these helpers):
 *   - HOME and USERPROFILE are relocated to a FRESH os.tmpdir() dir per fixture
 *     so every state read/write resolves to an ISOLATED ~/.ashlr — NEVER the
 *     real one. The real portfolio (~/.ashlr/enrollment.json = { repos: [] }) is
 *     NEVER touched.
 *   - Every repo is a DISPOSABLE git repo created under os.tmpdir(). Enrollment
 *     targets ONLY these tmp repos. cleanup() unenrolls + rm -rf everything and
 *     restores the prior HOME / env.
 *   - DETERMINISTIC: no live-LLM dependency. The fixture never spawns a model.
 *     The apply half is exercised with a known unified diff (or a real sandbox
 *     diff) so it runs the REAL code (createSandbox / createProposal /
 *     applyProposal) without nondeterminism.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HOME-ISOLATION TIMING (critical, read before using):
 *   The core chain — sandbox/policy, sandbox/worktree, sandbox/audit,
 *   inbox/store, inbox/apply, daemon/loop, daemon/state, portfolio/backlog —
 *   resolves paths via os.homedir() AT CALL TIME, so relocating process.env.HOME
 *   before invoking them is sufficient to isolate their state. USERPROFILE is
 *   relocated alongside HOME because os.homedir() uses it on Windows.
 *
 *   src/core/config.ts is the ONE exception: it captures CONFIG_DIR /
 *   CONFIG_PATH from homedir() at MODULE-LOAD time. The H1 chain does not depend
 *   on those frozen constants (the daemon tick reads/writes via the call-time
 *   helpers above and only consumes a plain AshlrConfig object), so a fixture
 *   that constructs its config via makeCfg() — rather than loadConfig() — stays
 *   fully isolated regardless of when config.ts first loaded. If a future suite
 *   needs loadConfig()/CONFIG_DIR under the tmp HOME, it must relocate HOME in a
 *   setup file that runs BEFORE config.ts is imported (vitest `setupFiles`), and
 *   that requirement is documented in CONTRACT-H1.md.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import type { AshlrConfig } from '../../src/core/types.js';
import {
  enroll,
  unenroll,
  isEnrolled,
  setKill,
} from '../../src/core/sandbox/policy.js';

// ===========================================================================
// Types
// ===========================================================================

/** Files to seed into a disposable repo: repo-relative path -> file content. */
export type SeedFiles = Record<string, string>;

/** Options for {@link makeDisposableRepo}. */
export interface MakeRepoOptions {
  /**
   * Files to seed + commit as the initial commit. Defaults to a single
   * `README.md` so HEAD always resolves. Paths are repo-relative; nested dirs
   * are created automatically.
   */
  files?: SeedFiles;
  /** Initial branch name. Default 'main'. */
  branch?: string;
  /** Commit message for the initial commit. Default 'init'. */
  message?: string;
  /** Prefix for the mkdtemp dir name. Default 'ashlr-h1-repo-'. */
  prefix?: string;
}

/** A disposable git repo handle returned by {@link makeDisposableRepo}. */
export interface DisposableRepo {
  /** Absolute path to the repo working directory (under os.tmpdir()). */
  readonly dir: string;
  /** The initial branch name. */
  readonly branch: string;
  /** Enroll THIS repo for autonomous work (idempotent). */
  enroll(): void;
  /** Unenroll THIS repo (idempotent). */
  unenroll(): void;
  /** True when THIS repo is currently enrolled. */
  isEnrolled(): boolean;
  /** Current branch name (`git rev-parse --abbrev-ref HEAD`). */
  currentBranch(): string;
  /** All local branch short-names. */
  branches(): string[];
  /** Working-tree content hash (excludes .git) — see {@link shasumTree}. */
  shasumTree(): string;
  /** `git status --porcelain` output (empty string == clean tree). */
  gitStatus(): string;
  /** Write/overwrite a file (repo-relative). Does NOT commit. */
  writeFile(rel: string, content: string): void;
  /** Read a file (repo-relative). Throws if absent. */
  readFile(rel: string): string;
  /** Remove just this repo's directory (called by the harness cleanup). */
  destroy(): void;
}

/** The active fixture handle returned by {@link makeFixture}. */
export interface H1Fixture {
  /** Absolute path of the isolated tmp home (HOME and USERPROFILE). */
  readonly home: string;
  /** Absolute path of the isolated ~/.ashlr under the tmp HOME. */
  readonly ashlrDir: string;
  /** Create a disposable git repo under os.tmpdir(), tracked for cleanup. */
  makeRepo(opts?: MakeRepoOptions): DisposableRepo;
  /** Turn the global kill switch on/off (writes ~/.ashlr/KILL in the tmp HOME). */
  setKill(on: boolean): void;
  /**
   * Restore HOME + env and rm -rf the tmp HOME and every tracked repo. Always
   * unenrolls tracked repos first. Idempotent; never throws.
   */
  cleanup(): void;
}

// ===========================================================================
// Internal git helpers — execFile arg arrays, no shell (matches core style)
// ===========================================================================

const GIT_TIMEOUT = 30_000;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    timeout: GIT_TIMEOUT,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

// ===========================================================================
// TODO-discovery fixtures — drive the REAL scanTodos provenance deterministically
// ===========================================================================

/**
 * True iff a TODO-comment scanner (`rg`, else `grep`) is available on PATH.
 *
 * `scanTodos` (src/core/portfolio/scanners.ts) discovers `source:'todo'` work
 * items by running `rg` (preferred) or GNU/BSD `grep` over a repo's working
 * tree. Both are local, no-network, no-model tools. When NEITHER exists,
 * `scanTodos` returns [] and discovery falls back to the filesystem-only
 * `scanDocs` heuristics. Suites that assert TODO provenance must guard on this
 * so they stay deterministic in a CI image with no grep/rg (the H1 determinism
 * rule), while still exercising the REAL scanner wherever one IS present.
 */
export function todoScannerAvailable(): boolean {
  for (const tool of ['rg', 'grep']) {
    try {
      execFileSync(tool, ['--version'], { stdio: 'ignore', timeout: 5_000 });
      return true;
    } catch {
      /* try the next tool */
    }
  }
  return false;
}

/**
 * Build a `SeedFiles` map of `count` distinct source files, each carrying a
 * single `// TODO:` marker, plus a README so HEAD/docs are well-formed.
 *
 * `scanTodos` emits ONE WorkItem (source:'todo') PER FILE containing a marker,
 * so this yields exactly `count` deterministic TODO items when a TODO scanner is
 * available — letting a suite drive the REAL discovery path the daemon tick uses
 * (`buildBacklog` -> SCANNERS -> scanTodos) with a known, provenance-checkable
 * item count, no model and no network. Each file lives under `src/` with a
 * unique name so the per-file clustering in `scanTodos` produces distinct items.
 */
export function todoSeedFiles(count: number): SeedFiles {
  const files: SeedFiles = {
    'README.md': '# disposable test repo\n',
  };
  for (let i = 0; i < count; i++) {
    files[`src/todo-${i}.ts`] =
      `export function f${i}(): number {\n` +
      `  // TODO: implement f${i} (deterministic discovery signal)\n` +
      `  return ${i};\n}\n`;
  }
  return files;
}

// ===========================================================================
// shasumTree — deterministic content hash of a working tree (excludes .git)
// ===========================================================================

/**
 * Deterministic content hash of the working tree at `dir`, EXCLUDING `.git`.
 *
 * Walks the tree in sorted-path order and folds each repo-relative path plus its
 * raw bytes into a single SHA-256. Two trees hash equal iff they contain exactly
 * the same set of files with byte-identical contents. This is the primitive
 * behind the REAL-TREE-UNCHANGED invariant: snapshot before the chain, snapshot
 * after, assert the hashes match.
 */
export function shasumTree(dir: string): string {
  const root = resolve(dir);
  const entries: Array<{ rel: string; bytes: Buffer }> = [];

  function walk(d: string): void {
    const items = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const item of items) {
      if (item.name === '.git') continue; // never hash git internals
      const full = join(d, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (item.isFile()) {
        entries.push({ rel: relative(root, full), bytes: readFileSync(full) });
      }
      // symlinks / sockets / fifos are intentionally ignored — disposable repos
      // never contain them, and excluding them keeps the hash deterministic.
    }
  }

  walk(root);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const h = createHash('sha256');
  for (const e of entries) {
    h.update(e.rel, 'utf8');
    h.update('\0');
    h.update(e.bytes);
    h.update('\0');
  }
  return h.digest('hex');
}

// ===========================================================================
// makeDisposableRepo — a real git repo with an initial commit, under tmpdir
// ===========================================================================

/**
 * Create a DISPOSABLE git repo under os.tmpdir() with seeded files + an initial
 * commit so HEAD always resolves. The repo is fully self-contained: a local
 * user.name/user.email is configured so commits never depend on global git
 * config, and commit.gpgsign is disabled so CI signing config can't interfere.
 *
 * The returned handle is NOT auto-tracked for cleanup — prefer {@link makeFixture}'s
 * `makeRepo`, which tracks + tears down. This standalone form is exported for
 * suites that manage their own lifecycle.
 */
export function makeDisposableRepo(opts?: MakeRepoOptions): DisposableRepo {
  const prefix = opts?.prefix ?? 'ashlr-h1-repo-';
  const branch = opts?.branch ?? 'main';
  const message = opts?.message ?? 'init';
  const files: SeedFiles = opts?.files ?? { 'README.md': '# disposable test repo\n' };

  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));

  git(dir, ['init', `--initial-branch=${branch}`, '.']);
  git(dir, ['config', 'user.email', 'h1@ashlr.test']);
  git(dir, ['config', 'user.name', 'Ashlr H1 Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // Pin line endings to LF so seeded/applied content round-trips byte-for-byte
  // on every platform. Without this, git on Windows honors a global
  // core.autocrlf=true and rewrites LF->CRLF on apply/checkout, breaking the
  // exact-content assertions (e.g. 'a\nb\nc\n' would read back as 'a\r\nb\r\nc\r\n').
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'core.eol', 'lf']);

  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--no-verify', '-m', message]);

  const handle: DisposableRepo = {
    dir,
    branch,
    enroll: () => enroll(dir),
    unenroll: () => unenroll(dir),
    isEnrolled: () => isEnrolled(dir),
    currentBranch: () => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    branches: () =>
      git(dir, ['branch', '--format=%(refname:short)'])
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean),
    shasumTree: () => shasumTree(dir),
    gitStatus: () => git(dir, ['status', '--porcelain']),
    writeFile: (rel, content) => {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    },
    readFile: (rel) => readFileSync(join(dir, rel), 'utf8'),
    destroy: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* idempotent cleanup — never throw */
      }
    },
  };

  return handle;
}

// ===========================================================================
// Deterministic unified-diff builder (the swarm's propose path, sans model)
// ===========================================================================

/**
 * Build a deterministic `git apply`-compatible unified diff that ADDS a new
 * file. This stands in for the unified diff a sandboxed swarm would capture +
 * propose — letting the apply half of the chain run the REAL createProposal /
 * applyProposal path with ZERO model dependency.
 *
 * The `index` line uses a fixed zero-blob -> short-hash form that `git apply`
 * accepts for a new file (the destination blob hash is not verified on apply).
 *
 * EMPTY CONTENT: a zero-line hunk (`@@ -0,0 +1,0 @@`) is rejected by `git apply`
 * as an invalid empty new-file hunk, so this builder REFUSES empty content with
 * a clear error rather than ever returning a patch git apply would reject. A new
 * empty file is not a meaningful proposal payload for the H1 chain; suites that
 * genuinely need one should create it directly, not via this diff builder.
 */
export function makeAddFileDiff(relPath: string, content: string): string {
  const shortBlob = createHash('sha1')
    .update(content)
    .digest('hex')
    .slice(0, 7);
  const bodyLines = content.split('\n');
  // A trailing '' from a content ending in '\n' must not become a spurious
  // '+' line; drop a single trailing empty segment so line counts are correct.
  if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop();
  }
  if (bodyLines.length === 0) {
    // Guard the degenerate empty-file case: `@@ -0,0 +1,0 @@` with no added
    // lines is an invalid hunk that `git apply` rejects. Fail loudly so a future
    // suite never silently seeds an unappliable patch.
    throw new Error(
      'makeAddFileDiff: empty content is not supported (a zero-line new-file ' +
        'hunk is rejected by `git apply`); pass at least one line of content.',
    );
  }
  const added = bodyLines.map((l) => `+${l}`);
  return [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    `index 0000000..${shortBlob}`,
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added,
    '',
  ].join('\n');
}

// ===========================================================================
// Backlog seeding (deterministic — bypasses live scanners)
// ===========================================================================

/**
 * Write a deterministic backlog.json into the fixture's isolated
 * ~/.ashlr/backlog.json in the exact shape {@link loadBacklog} parses.
 *
 * IMPORTANT — what this DOES and does NOT control:
 *   - It ONLY affects the persisted, inspectable `~/.ashlr/backlog.json` and
 *     therefore what `loadBacklog()` returns. Use it to test the persisted
 *     backlog shape / `loadBacklog()` path.
 *   - It is NOT read by the daemon `tick`. A live tick calls
 *     `buildBacklog({ repos: enrolled })` (loop.ts), which ALWAYS re-runs the
 *     SCANNERS over the enrolled repos and OVERWRITES backlog.json — so the
 *     items the tick considers come from scanner discovery on the repo's
 *     working tree (e.g. `scanTodos` over `// TODO` markers, `scanDocs`
 *     filesystem heuristics), NEVER from the items seeded here.
 *
 * To control what a tick discovers, seed the REPO's working tree (e.g. files
 * with `// TODO:` lines that `scanTodos` picks up) via `makeRepo({ files })` —
 * not this helper.
 *
 * `home` is the fixture's tmp HOME; `repo` is a disposable repo's dir.
 */
export function seedBacklog(
  home: string,
  repo: string,
  items: Array<{ title: string; detail?: string; value?: number; effort?: number }>,
): void {
  const now = new Date().toISOString();
  const backlogPath = join(home, '.ashlr', 'backlog.json');
  mkdirSync(dirname(backlogPath), { recursive: true });
  const backlog = {
    generatedAt: now,
    repos: [repo],
    items: items.map((it, i) => {
      const value = it.value ?? 3;
      const effort = it.effort ?? 2;
      return {
        id: `h1-item-${i}`,
        repo,
        source: 'todo' as const,
        title: it.title,
        detail: it.detail ?? '',
        value,
        effort,
        score: value / effort,
        tags: [] as string[],
        ts: now,
      };
    }),
  };
  writeFileSync(backlogPath, JSON.stringify(backlog, null, 2) + '\n', 'utf8');
}

// ===========================================================================
// makeCfg — a minimal, deterministic AshlrConfig for the daemon tick
// ===========================================================================

/**
 * Build a minimal AshlrConfig with conservative daemon caps. Constructed in
 * memory (NOT via loadConfig) so it never depends on config.ts's module-load
 * CONFIG_DIR — keeping the fixture isolated regardless of import order.
 */
export function makeCfg(overrides?: Partial<AshlrConfig>): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 1.0,
      perTickItems: 3,
      parallel: 2,
      intervalMs: 100,
    },
    ...overrides,
  } as AshlrConfig;
}

// ===========================================================================
// makeFixture — the lifecycle harness (relocate HOME, track repos, tear down)
// ===========================================================================

/**
 * Create an isolated H1 fixture:
 *   1. Snapshot + relocate HOME, USERPROFILE, and ASHLR_HOME to a FRESH os.tmpdir() dir so
 *      every ~/.ashlr read/write is isolated on POSIX and Windows.
 *   2. Snapshot the re-entrancy env (ASHLR_IN_DAEMON / ASHLR_IN_SWARM) and clear
 *      it so a tick/daemon run is not refused by the recursion guard.
 *   3. Hand back a handle whose makeRepo() builds disposable repos (auto-tracked)
 *      and whose cleanup() unenrolls everything, clears the kill switch, restores
 *      HOME + env, and rm -rf's the tmp HOME + every tracked repo.
 *
 * Typical use is `withTmpHome(fn)` (below); call this directly only when a suite
 * needs explicit control over the lifecycle inside beforeEach/afterEach.
 */
export function makeFixture(): H1Fixture {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevAshlrHome = process.env.ASHLR_HOME;
  const prevInDaemon = process.env.ASHLR_IN_DAEMON;
  const prevInSwarm = process.env.ASHLR_IN_SWARM;

  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-h1-home-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  delete process.env.ASHLR_IN_DAEMON;
  delete process.env.ASHLR_IN_SWARM;

  const tracked: DisposableRepo[] = [];
  // Once cleanup() restores the REAL HOME, a second cleanup() must be a TRUE
  // no-op — it must NOT re-run unenroll()/setKill(), which (post-H6, now that
  // policy.ts emits audit() on every enroll/unenroll/setKill) would WRITE audit
  // records into the REAL ~/.ashlr. This flag enforces genuine idempotence so a
  // double-cleanup never leaks state to the real home.
  let cleaned = false;

  // Sanity: homedir() must now resolve to the tmp HOME, otherwise isolation is
  // broken on this platform and the fixture MUST NOT proceed (it would risk the
  // real ~/.ashlr). On macOS/Linux homedir() follows $HOME; this guard fails
  // loudly rather than silently mutating real state.
  if (resolve(homedir()) !== resolve(home)) {
    // Restore + abort. Restore HOME *and* the re-entrancy env (ASHLR_IN_DAEMON /
    // ASHLR_IN_SWARM) symmetrically with cleanup(): the setup above cleared both
    // before this guard, so the abort path must put them back exactly as it found
    // them — otherwise a caller running inside a daemon/swarm would have those
    // vars permanently cleared for the rest of the process (an env-cleanup leak).
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = prevAshlrHome;
    if (prevInDaemon === undefined) delete process.env.ASHLR_IN_DAEMON;
    else process.env.ASHLR_IN_DAEMON = prevInDaemon;
    if (prevInSwarm === undefined) delete process.env.ASHLR_IN_SWARM;
    else process.env.ASHLR_IN_SWARM = prevInSwarm;
    rmSync(home, { recursive: true, force: true });
    throw new Error(
      'H1 fixture: HOME relocation did not take effect (homedir() != tmp HOME); ' +
        'refusing to run to avoid touching the real ~/.ashlr',
    );
  }

  const fixture: H1Fixture = {
    home,
    ashlrDir: join(home, '.ashlr'),
    makeRepo: (opts) => {
      const repo = makeDisposableRepo(opts);
      tracked.push(repo);
      return repo;
    },
    setKill: (on) => setKill(on),
    cleanup: () => {
      // TRUE-IDEMPOTENT guard: after the first cleanup restores the real HOME,
      // a second call returns immediately WITHOUT touching policy state (a repeat
      // unenroll()/setKill() would write audit records into the REAL ~/.ashlr).
      if (cleaned) return;
      cleaned = true;
      // 1. Unenroll + destroy every tracked repo (best-effort, never throws).
      for (const repo of tracked) {
        try {
          repo.unenroll();
        } catch {
          /* ignore */
        }
        repo.destroy();
      }
      // 2. Clear the kill switch in the isolated HOME (idempotent).
      try {
        setKill(false);
      } catch {
        /* ignore */
      }
      // 3. rm -rf the isolated HOME (and thus the isolated ~/.ashlr).
      try {
        if (existsSync(home)) rmSync(home, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      // 4. Restore HOME, USERPROFILE, and re-entrancy env.
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = prevAshlrHome;
      if (prevInDaemon === undefined) delete process.env.ASHLR_IN_DAEMON;
      else process.env.ASHLR_IN_DAEMON = prevInDaemon;
      if (prevInSwarm === undefined) delete process.env.ASHLR_IN_SWARM;
      else process.env.ASHLR_IN_SWARM = prevInSwarm;
    },
  };

  return fixture;
}

/**
 * Run `fn` with a fresh isolated H1 fixture, guaranteeing cleanup() runs even if
 * `fn` throws/rejects. The single entry point most H1 tests should use.
 */
export async function withTmpHome<T>(
  fn: (fx: H1Fixture) => T | Promise<T>,
): Promise<T> {
  const fx = makeFixture();
  try {
    return await fn(fx);
  } finally {
    fx.cleanup();
  }
}

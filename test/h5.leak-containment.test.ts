/**
 * test/h5.leak-containment.test.ts — H5 END-TO-END LEAK / CONTAINMENT PROOF.
 *
 * The integration-level proof for MILESTONE H5 "Harden & Prove" (CONTRACT-H5.md):
 * sandboxes are BOUNDED and SELF-HEALING and leave ZERO residue, while every
 * removeSandbox containment guard still holds. This file ties CHANGE 1 (orphan
 * sweep) + the inherited removeSandbox guards together on REAL disposable repos
 * under an ISOLATED tmp HOME, and proves four things end-to-end:
 *
 *   (a) NO-LEAK LIFECYCLE — after a normal createSandbox -> removeSandbox cycle
 *       NOTHING leaks: listSandboxes() is empty, no worktree dir survives under
 *       ~/.ashlr/sandboxes/<id>/, the source repo registers NO `ashlr/sandbox/*`
 *       worktree, and NO `ashlr/sandbox/*` scratch branch is left behind. The
 *       source repo's working tree + user branches are byte-identical.
 *
 *   (b) CRASH + SWEEP RECLAIM — a simulated crash leaves an ORPHAN worktree on
 *       disk (in-memory handle dropped). The orphan-sweep (the primitive wired
 *       into daemon start in CHANGE 1) reclaims it; afterwards the source repo's
 *       working tree AND its full branch set are byte-identical to before the
 *       orphan ever existed. A LIVE (fresh) sandbox younger than staleMs is NEVER
 *       force-removed by the same staleMs-guarded sweep.
 *
 *   (c) CONTAINMENT STILL HOLDS — a TAMPERED sandbox (branch shoved out of the
 *       ashlr/sandbox/ namespace, or worktreePath pointed OUTSIDE sandboxesDir())
 *       makes removeSandbox REFUSE the git ops (audited result:'refused') and do
 *       LOCAL dir cleanup only: git ops only ever target the RE-DERIVED safe path
 *       / branch, so the source repo's tree + branches are untouched and the
 *       GENUINE scratch ref survives (proving no `branch -D` ran on the tampered
 *       value).
 *
 *   (d) REPEATED CYCLES -> ZERO RESIDUE — many create/remove cycles leave the
 *       sandboxes root empty (disk bounded): no worktree dir, no scratch branch,
 *       no metadata accretes across iterations.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SAFETY (paramount — inherited verbatim from H1/H2/H4):
 *   - ISOLATED HOME: makeFixture() relocates process.env.HOME to a FRESH
 *     os.tmpdir() dir so every ~/.ashlr read/write is isolated; the real
 *     portfolio ({ repos: [] }) is NEVER touched.
 *   - DISPOSABLE REPOS: every git op runs on fx.makeRepo() disposable repos.
 *   - DETERMINISTIC: no live model, no network. A "crash" is the H2 dropped-
 *     handle orphan; every byte goes through the REAL stores. Every it() carries
 *     a real expect() + expect.hasAssertions().
 *   - ASHLR_TEST_ALLOW_ANY_REPO=1 is set inside the isolated HOME so the H2
 *     makeOrphanSandbox / createSandbox(allowAnyRepo) calls stay effective after
 *     the CHANGE 3 env-gate lands. This is a TEST-ONLY toggle in a tmp HOME — it
 *     relaxes NO production guard (the kill switch still always wins).
 */

import { describe, it, expect, afterEach } from 'vitest';

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import {
  createSandbox,
  removeSandbox,
  listSandboxes,
  sweepOrphanSandboxes,
  sandboxesDir,
  ORPHAN_STALE_MS,
} from '../src/core/sandbox/worktree.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import type { Sandbox } from '../src/core/types.js';
import {
  makeFixture,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import {
  makeOrphanSandbox,
  listOrphanSandboxes,
  sandboxHomeExists,
} from './helpers/h2-faults.js';

const BRANCH_PREFIX = 'ashlr/sandbox/';
const STALE_MS = ORPHAN_STALE_MS; // SHARED, exported — never drifts from prod

const ENV_KEY = 'ASHLR_TEST_ALLOW_ANY_REPO';

let fx: H1Fixture;
let repo: DisposableRepo;
let prevEnv: string | undefined;

/**
 * Fresh isolated HOME + a disposable repo for each test, with the env hatch set
 * so createSandbox(allowAnyRepo) is effective on a tmp (un-enrolled) repo after
 * the CHANGE 3 env-gate. Snapshot/restore is handled in afterEach.
 */
function setup(): void {
  fx = makeFixture();
  prevEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = '1';
  repo = fx.makeRepo();
}

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevEnv;
  prevEnv = undefined;
  fx?.cleanup();
});

// ---------------------------------------------------------------------------
// Local leak probes — every one inspects REAL on-disk / git state, not a mock
// ---------------------------------------------------------------------------

/**
 * The `ashlr/sandbox/*` worktree paths the SOURCE repo currently registers.
 *
 * `git worktree list --porcelain` emits a `worktree <abs-path>` line per
 * registered worktree (including the main one). We keep only the ashlr sandbox
 * checkouts: a path that lives under a `.../sandboxes/<id>/worktree` layout.
 * NOTE: git reports the REALPATH (symlinks resolved, e.g. macOS `/var` ->
 * `/private/var`), whereas sandboxesDir() derives from $HOME and may be the
 * un-resolved form — so we match on the stable `sandboxes/.../worktree` SHAPE
 * rather than an absolute-prefix equality that a symlink would defeat.
 */
function sandboxWorktreeRegistrations(dir: string): string[] {
  const out = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], {
    timeout: 30_000,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const sandboxMarker = `${sep}sandboxes${sep}`;
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((p) => p.includes(sandboxMarker) && p.endsWith(`${sep}worktree`));
}

/** Short-names of any `ashlr/sandbox/*` scratch branches left in the repo. */
function sandboxBranches(r: DisposableRepo): string[] {
  return r.branches().filter((b) => b.startsWith(BRANCH_PREFIX));
}

/** The scratch branch short-name a sandbox id maps to. */
function scratchBranch(id: string): string {
  return `${BRANCH_PREFIX}${id}`;
}

/** The newest `sandbox:remove` audit record for `id` with result 'refused'. */
function refusedRemoveAudit(id: string) {
  return readAudit().find(
    (e) =>
      e.action === 'sandbox:remove' &&
      e.sandboxId === id &&
      e.result === 'refused',
  );
}

// ===========================================================================
// (a) NO-LEAK LIFECYCLE — a normal create -> remove leaves zero residue
// ===========================================================================

describe('H5 · leak-containment · (a) normal lifecycle leaves NO residue', () => {
  it('after createSandbox -> removeSandbox: no sandbox, no worktree, no scratch branch', () => {
    expect.hasAssertions();
    setup();

    const treeBefore = repo.shasumTree();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith(BRANCH_PREFIX));

    const sb = createSandbox(repo.dir, { allowAnyRepo: true });

    // While live: the sandbox is present and the source repo registers exactly
    // one ashlr/sandbox/* worktree + scratch branch (proves the cycle is real).
    expect(listSandboxes().some((s) => s.id === sb.id)).toBe(true);
    expect(existsSync(join(sandboxesDir(), sb.id, 'worktree'))).toBe(true);
    expect(repo.branches()).toContain(scratchBranch(sb.id));
    // The source repo registers a worktree for THIS sandbox (matched by id,
    // since git reports the symlink-resolved realpath).
    expect(
      sandboxWorktreeRegistrations(repo.dir).some((p) => p.includes(sb.id)),
    ).toBe(true);

    removeSandbox(sb);

    // ZERO residue: store empty, on-disk home gone, no worktree registration,
    // no scratch branch.
    expect(listSandboxes()).toEqual([]);
    expect(sandboxHomeExists(sb.id)).toBe(false);
    expect(existsSync(join(sandboxesDir(), sb.id))).toBe(false);
    expect(sandboxWorktreeRegistrations(repo.dir)).toEqual([]);
    expect(sandboxBranches(repo)).toEqual([]);

    // Source repo byte-identical: working tree, clean status, user branches.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(repo.branches().filter((b) => !b.startsWith(BRANCH_PREFIX))).toEqual(
      userBranchesBefore,
    );
  });
});

// ===========================================================================
// (b) CRASH + SWEEP RECLAIM — orphan reclaimed; source tree/branches identical
// ===========================================================================

describe('H5 · leak-containment · (b) crash orphan reclaimed by the start-time sweep', () => {
  it('a dropped-handle orphan is swept; source tree + branches are byte-identical', () => {
    expect.hasAssertions();
    setup();

    // Snapshot the pristine source state BEFORE the orphan ever exists.
    const treeBefore = repo.shasumTree();
    const branchesBefore = repo.branches().slice().sort();

    // Simulate a crash: a real on-disk worktree whose in-memory handle is
    // dropped (the H2 orphan), then back-date it past staleMs so the
    // staleMs-guarded sweep (CHANGE 1 wiring) treats it as a genuine leftover.
    const orphan = makeOrphanSandbox(repo.dir);
    backdateCreatedAt(orphan.id, STALE_MS * 2);

    // The orphan is genuinely on disk + registered as a worktree before sweep.
    expect(sandboxHomeExists(orphan.id)).toBe(true);
    expect(repo.branches()).toContain(scratchBranch(orphan.id));

    const swept = sweepOrphanSandboxes({ staleMs: STALE_MS });

    // The crash leftover is reclaimed.
    expect(swept).toContain(orphan.id);
    expect(sandboxHomeExists(orphan.id)).toBe(false);
    expect(listSandboxes()).toEqual([]);
    expect(sandboxWorktreeRegistrations(repo.dir)).toEqual([]);
    expect(sandboxBranches(repo)).toEqual([]);

    // The source repo is byte-identical to its pre-orphan state — tree AND the
    // full branch set (the scratch ref is gone; user branches untouched).
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(repo.branches().slice().sort()).toEqual(branchesBefore);
  });

  it('a LIVE (fresh) sandbox younger than staleMs is NEVER force-removed by the sweep', () => {
    expect.hasAssertions();
    setup();

    const stale = makeOrphanSandbox(repo.dir);
    const live = makeOrphanSandbox(repo.dir);
    backdateCreatedAt(stale.id, STALE_MS * 2); // crash leftover
    // `live` keeps its just-now createdAt -> younger than staleMs.

    const swept = sweepOrphanSandboxes({ staleMs: STALE_MS });

    // Only the stale one is reclaimed; the live one survives intact on disk.
    expect(swept).toEqual([stale.id]);
    expect(sandboxHomeExists(stale.id)).toBe(false);
    expect(sandboxHomeExists(live.id)).toBe(true);
    expect(listOrphanSandboxes().map((s) => s.id)).toEqual([live.id]);
    expect(repo.branches()).toContain(scratchBranch(live.id));
    expect(repo.branches()).not.toContain(scratchBranch(stale.id));

    // Clean up the surviving live sandbox so the test leaves no residue.
    const liveSb = listSandboxes().find((s) => s.id === live.id);
    expect(liveSb).toBeDefined();
    removeSandbox(liveSb as Sandbox);
    expect(listSandboxes()).toEqual([]);
  });
});

// ===========================================================================
// (c) CONTAINMENT STILL HOLDS — a tampered sandbox can never escape namespace
// ===========================================================================

describe('H5 · leak-containment · (c) removeSandbox containment refuses a tampered sandbox', () => {
  it('branch shoved OUT of namespace: git ops refused, source branches + tree intact, genuine ref survives', () => {
    expect.hasAssertions();
    setup();

    const treeBefore = repo.shasumTree();
    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    const genuineRef = scratchBranch(sb.id);
    expect(repo.branches()).toContain(genuineRef);

    // Tamper the branch out of the ashlr/sandbox/ namespace. removeSandbox
    // re-derives the safe branch from the id and refuses the git ops because the
    // stored branch != safeBranch (and is not in-namespace); only LOCAL dir
    // cleanup runs. It must NEVER `branch -D 'main'`.
    const tampered: Sandbox = { ...sb, branch: 'main' };
    removeSandbox(tampered);

    // Audited as refused with the containment-guard summary.
    const refused = refusedRemoveAudit(sb.id);
    expect(refused).toBeDefined();
    expect(refused?.summary).toContain('containment guard');

    // The user's `main` branch is untouched and the GENUINE scratch ref SURVIVES
    // (proof no `branch -D` ran against the tampered value).
    expect(repo.branches()).toContain('main');
    expect(repo.branches()).toContain(genuineRef);
    // Source working tree byte-identical.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');

    // Local dir cleanup still happened despite the refusal.
    expect(existsSync(join(sandboxesDir(), sb.id))).toBe(false);

    // Reclaim the genuine scratch ref via an HONEST remove so the test leaves no
    // residue (the honest meta passes every guard).
    removeSandbox(sb);
    expect(repo.branches()).not.toContain(genuineRef);
    expect(sandboxBranches(repo)).toEqual([]);
  });

  it('worktreePath pointed OUTSIDE sandboxesDir(): git ops refused; that path is never touched', () => {
    expect.hasAssertions();
    setup();

    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    const genuineRef = scratchBranch(sb.id);

    // A decoy path OUTSIDE the isolated sandboxesDir() that we plant a sentinel
    // file under — if removeSandbox ever ran `git worktree remove`/rmSync on the
    // raw metadata path, the sentinel would be gone. The containment guard
    // (resolve(worktreePath) must start with sandboxesDir()) forbids it.
    const outsideDir = fx.makeRepo().dir; // a separate disposable repo dir
    const sentinel = join(outsideDir, 'KEEP-ME.txt');
    writeFileSync(sentinel, 'do-not-touch', 'utf8');

    const tampered: Sandbox = { ...sb, worktreePath: outsideDir };
    removeSandbox(tampered);

    // Refused (path not contained under sandboxesDir()).
    const refused = refusedRemoveAudit(sb.id);
    expect(refused).toBeDefined();
    expect(refused?.summary).toContain('containment guard');

    // The out-of-namespace path is completely untouched.
    expect(existsSync(outsideDir)).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('do-not-touch');

    // The genuine scratch ref SURVIVES (no `worktree remove` against safeWorktree
    // ran either — the whole git-op block is gated behind guardsPass).
    expect(repo.branches()).toContain(genuineRef);

    // Honest cleanup leaves zero residue.
    removeSandbox(sb);
    expect(sandboxBranches(repo)).toEqual([]);
    expect(listSandboxes()).toEqual([]);
  });
});

// ===========================================================================
// (d) REPEATED CYCLES -> ZERO RESIDUE — disk is bounded across many iterations
// ===========================================================================

describe('H5 · leak-containment · (d) repeated create/remove cycles leave zero residue', () => {
  it('many create -> remove cycles accrete NO sandbox, worktree, or scratch branch', () => {
    expect.hasAssertions();
    setup();

    const treeBefore = repo.shasumTree();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith(BRANCH_PREFIX))
      .slice()
      .sort();

    const CYCLES = 24; // well over MAX_SANDBOXES (16) — proves nothing accretes
    for (let i = 0; i < CYCLES; i++) {
      const sb = createSandbox(repo.dir, { allowAnyRepo: true });
      // Exactly one live sandbox at a time (each removed before the next).
      expect(listSandboxes().map((s) => s.id)).toEqual([sb.id]);
      removeSandbox(sb);
      // Residue-free after every single cycle: store empty, no scratch branch,
      // no source worktree registration. (If anything leaked, accumulation would
      // eventually trip the MAX_SANDBOXES cap and createSandbox would throw — so
      // a clean run to CYCLES > cap is itself proof the disk stays bounded.)
      expect(listSandboxes()).toEqual([]);
      expect(sandboxBranches(repo)).toEqual([]);
      expect(sandboxWorktreeRegistrations(repo.dir)).toEqual([]);
    }

    // After all cycles: the sandboxes store is empty and the source repo is
    // byte-identical to its pristine pre-loop state.
    expect(listSandboxes()).toEqual([]);
    expect(sandboxBranches(repo)).toEqual([]);
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(repo.branches().filter((b) => !b.startsWith(BRANCH_PREFIX)).slice().sort()).toEqual(
      userBranchesBefore,
    );
  });
});

// ---------------------------------------------------------------------------
// helper (declared after use is fine — function declaration, hoisted)
// ---------------------------------------------------------------------------

/** Back-date a sandbox's persisted createdAt so the staleMs guard treats it as stale. */
function backdateCreatedAt(id: string, ageMs: number): void {
  const metaFile = join(sandboxesDir(), id, 'sandbox.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { createdAt: string };
  meta.createdAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

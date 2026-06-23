/**
 * test/h4.sandbox-containment.test.ts — H4 INVARIANT 7: SANDBOX-CONTAINMENT.
 *
 * Asserts EVERY guard (CONTRACT-H4.md §Invariant 7, guards 7.1–7.9):
 * removeSandbox re-derives the safe branch + worktree path from the sandbox id
 * (NEVER trusting raw on-disk metadata), and REFUSES git ops on any
 * namespace/containment mismatch; resolve() defeats a symlink escape;
 * listSandboxes skips malformed metadata without crashing the sweep.
 *
 * PRIORITY (previously UNTESTED): 7.4–7.6 (each containment guard fails ALONE —
 * branch-not-in-namespace / branch≠safeBranch / worktree-not-contained),
 * 7.7 (non-namespaced branch never branch -D'd), 7.8 (malformed meta skipped in
 * listSandboxes), 7.9 (symlink worktreePath defeated by resolve()).
 *
 * SAFETY (paramount — see CONTRACT-H4.md): isolated tmp HOME per test, disposable
 * repos only, real ~/.ashlr never touched. A genuine sandbox is made via
 * createSandbox(repo,{allowAnyRepo:true}); its Sandbox meta is tampered IN MEMORY
 * (one field at a time) to trip each guard in isolation. The user repo's REAL
 * branches are asserted UNCHANGED on every refusal, and the GENUINE
 * ashlr/sandbox/<id> scratch ref is asserted to SURVIVE a tampered remove (proof
 * that no `branch -D` ever ran against the tampered value). DETERMINISTIC, no
 * model. Every it() has real expect(); beforeEach calls expect.hasAssertions().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createSandbox,
  removeSandbox,
  listSandboxes,
  sandboxesDir,
} from '../src/core/sandbox/worktree.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import type { Sandbox } from '../src/core/types.js';
import {
  makeFixture,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import { canSymlink } from './helpers/platform.js';

const BRANCH_PREFIX = 'ashlr/sandbox/';

/** Short-name of the namespaced scratch branch a sandbox id maps to. */
function scratchBranch(id: string): string {
  return `${BRANCH_PREFIX}${id}`;
}

/**
 * The newest `sandbox:remove` audit record for a given sandbox id. removeSandbox
 * emits exactly one final 'sandbox:remove' record per call (plus, on a refusal,
 * a preceding 'refused' record); readAudit() returns newest-first.
 */
function lastRemoveAudit(id: string) {
  return readAudit().find(
    (e) => e.action === 'sandbox:remove' && e.sandboxId === id,
  );
}

/** The 'refused' sandbox:remove record for `id`, if removeSandbox refused. */
function refusedRemoveAudit(id: string) {
  return readAudit().find(
    (e) =>
      e.action === 'sandbox:remove' &&
      e.sandboxId === id &&
      e.result === 'refused',
  );
}

/**
 * `git branch <name>` off HEAD — creates a ref WITHOUT checking it out, so the
 * working tree + HEAD stay untouched. makeDisposableRepo exposes no branch()
 * mutator, so this is test-local (execFile arg array, no shell — matches style).
 */
function gitBranch(dir: string, name: string): void {
  execFileSync('git', ['-C', dir, 'branch', name], {
    timeout: 30_000,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

/** `git branch -D <name>` — test cleanup of a DECOY ref (never a user ref). */
function gitBranchDelete(dir: string, name: string): void {
  execFileSync('git', ['-C', dir, 'branch', '-D', name], {
    timeout: 30_000,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

/** The real worktree.ts source, read as text for the [STATIC] grep-guards. */
function worktreeSource(): string {
  return readFileSync(
    new URL('../src/core/sandbox/worktree.ts', import.meta.url),
    'utf8',
  );
}

let fx: H1Fixture;
let repo: DisposableRepo;

// H5 CHANGE 3 migration: allowAnyRepo is now effective ONLY when
// ASHLR_TEST_ALLOW_ANY_REPO==='1'. This containment suite sandboxes unenrolled
// tmp repos via allowAnyRepo:true to exercise removeSandbox's guards, so set the
// env hatch for the whole file (restored after). The kill-switch / unenrolled
// refusal cases below do NOT pass the hatch, so they still refuse regardless.
const origAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;

beforeEach(() => {
  // H4 false-green guard: every it() MUST run at least one assertion, so a
  // future empty-stub (TODO body, zero expect) FAILS loudly instead of passing
  // vacuously — exactly the regression this milestone exists to forbid.
  expect.hasAssertions();
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  fx = makeFixture();
  repo = fx.makeRepo();
});

afterEach(() => {
  fx.cleanup();
  if (origAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = origAllowAnyRepo;
});

// ===========================================================================
// 7.1–7.3 — removeSandbox re-derives safe values; pass-path runs git ops;
//           refusal path still does LOCAL cleanup + audits 'refused'.
// ===========================================================================

describe('H4 · CONTAINMENT · removeSandbox re-derives safe values', () => {
  it('7.1 removeSandbox re-derives safeBranch/safeWorktree from id, not raw metadata', () => {
    // Genuine sandbox (allowAnyRepo lets a tmp repo be sandboxed without
    // enrolling it; the kill switch is NOT bypassed — the gate still ran).
    const sb = createSandbox(repo.dir, { allowAnyRepo: true });

    // The honest metadata already equals the values re-derived from the id —
    // pins the derivation: safeBranch = BRANCH_PREFIX+id,
    // safeWorktree = sandboxesDir()/<id>/worktree.
    expect(sb.branch).toBe(scratchBranch(sb.id));
    expect(resolve(sb.worktreePath)).toBe(
      resolve(join(sandboxesDir(), sb.id, 'worktree')),
    );
    expect(resolve(sb.worktreePath).startsWith(sandboxesDir() + sep)).toBe(true);

    // The genuine scratch ref exists before removal (so 7.4–7.7 below have a
    // real ref whose SURVIVAL proves a refusal skipped `branch -D`).
    expect(repo.branches()).toContain(scratchBranch(sb.id));

    // Clean removal: honest meta passes all guards, git ops run against the
    // re-derived safe values, scratch ref is deleted, home is gone.
    removeSandbox(sb);
    expect(repo.branches()).not.toContain(scratchBranch(sb.id));
    expect(existsSync(join(sandboxesDir(), sb.id))).toBe(false);
  });

  it('7.2 guardsPass = namespace ∧ branchMatch ∧ contained; git ops run only when all pass', () => {
    const treeBefore = repo.shasumTree();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith(BRANCH_PREFIX));

    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    expect(repo.branches()).toContain(scratchBranch(sb.id));

    // All three conjuncts hold for honest metadata → git ops run.
    removeSandbox(sb);

    expect(repo.branches()).not.toContain(scratchBranch(sb.id));
    // Source repo byte-identical: working tree, checked-out branch, user refs.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(repo.branches().filter((b) => !b.startsWith(BRANCH_PREFIX))).toEqual(
      userBranchesBefore,
    );

    const rec = lastRemoveAudit(sb.id);
    expect(rec?.result).toBe('ok');
    expect(rec?.summary).toContain(`removed worktree + branch ${sb.branch}`);
  });

  it('7.3 a refusal still does LOCAL dir cleanup (rmSync home) and audits "refused"', () => {
    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    const home = join(sandboxesDir(), sb.id);
    expect(existsSync(home)).toBe(true);

    // Trip a guard (non-namespaced branch). removeSandbox must STILL rmSync the
    // home (local cleanup is unconditional) while refusing the git ops.
    const tampered: Sandbox = { ...sb, branch: 'feature/not-ours' };
    removeSandbox(tampered);

    // Local home cleaned up despite the refusal.
    expect(existsSync(home)).toBe(false);

    // Audited as refused with the containment-guard summary. (removeSandbox
    // emits one 'refused' record then a final 'ok' for the local cleanup; the
    // refusal record is the load-bearing one.)
    const refused = refusedRemoveAudit(sb.id);
    expect(refused).toBeDefined();
    expect(refused?.summary).toMatch(/branch-prefix\/containment guard/);

    // The genuine scratch ref was NEVER deleted (guardsPass was false → no git
    // ops at all), so it still exists in the source repo.
    expect(repo.branches()).toContain(scratchBranch(sb.id));

    // Reclaim it via an honest remove for hygiene.
    removeSandbox(sb);
    expect(repo.branches()).not.toContain(scratchBranch(sb.id));
  });
});

// ===========================================================================
// 7.4–7.7 — each containment guard fails IN ISOLATION → git ops refused; the
//           genuine scratch ref SURVIVES; user branches untouched.
// ===========================================================================

describe('H4 · CONTAINMENT · each guard fails in isolation', () => {
  it('7.4 [UNTESTED] branch NOT in ashlr/sandbox namespace ⇒ refuse git ops, user branches unchanged', () => {
    // Seed a USER branch so we can prove it is NEVER `branch -D`'d.
    const userBranch = 'feature/x';
    gitBranch(repo.dir, userBranch);
    expect(repo.branches()).toContain(userBranch);

    const treeBefore = repo.shasumTree();

    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    const genuineScratch = scratchBranch(sb.id);
    expect(repo.branches()).toContain(genuineScratch);

    // Guard A FAILS: branch outside the namespace (worktreePath stays honest, so
    // ONLY the branch-namespace property makes this not a happy path).
    const tampered: Sandbox = { ...sb, branch: userBranch };
    removeSandbox(tampered);

    // REFUSED: no git op ran. The user branch SURVIVES (never `branch -D`'d) and
    // — proof the git ops were skipped entirely — the GENUINE namespaced scratch
    // ref ALSO survives (a happy path deletes the re-derived safeBranch; a
    // refusal deletes neither).
    expect(repo.branches()).toContain(userBranch);
    expect(repo.branches()).toContain(genuineScratch);
    expect(repo.shasumTree()).toBe(treeBefore);

    const refused = refusedRemoveAudit(sb.id);
    expect(refused?.summary).toMatch(/branch-prefix\/containment guard/);

    // Local home still cleaned up.
    expect(existsSync(join(sandboxesDir(), sb.id))).toBe(false);

    // Reclaim the genuine scratch ref the refusal deliberately left behind.
    removeSandbox(sb);
    expect(repo.branches()).not.toContain(genuineScratch);
    expect(repo.branches()).toContain(userBranch); // user branch still safe
  });

  it('7.5 [UNTESTED] branch ≠ safeBranch (wrong id, same namespace) ⇒ refuse', () => {
    const treeBefore = repo.shasumTree();

    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    const genuineScratch = scratchBranch(sb.id);
    expect(repo.branches()).toContain(genuineScratch);

    // A DECOY namespaced branch for a DIFFERENT id. In-namespace (guard A passes)
    // but ≠ safeBranch (guard B FAILS ALONE). Seed it as a real ref so we can
    // prove it is NEVER force-deleted via the tampered path.
    const decoy = scratchBranch('deadbeefdead');
    gitBranch(repo.dir, decoy);
    expect(repo.branches()).toContain(decoy);

    const tampered: Sandbox = { ...sb, branch: decoy };
    removeSandbox(tampered);

    // REFUSED: the decoy ref survives (no `branch -D` against the tampered name)
    // AND the genuine scratch ref survives (re-derived safeBranch never deleted
    // because guardsPass was false).
    expect(repo.branches()).toContain(decoy);
    expect(repo.branches()).toContain(genuineScratch);
    expect(repo.shasumTree()).toBe(treeBefore);

    const refused = refusedRemoveAudit(sb.id);
    expect(refused?.summary).toMatch(/branch-prefix\/containment guard/);
    expect(existsSync(join(sandboxesDir(), sb.id))).toBe(false);

    // Reclaim the genuine ref + the decoy for hygiene.
    removeSandbox(sb);
    expect(repo.branches()).not.toContain(genuineScratch);
    gitBranchDelete(repo.dir, decoy);
  });

  it('7.6 [UNTESTED] worktreePath NOT contained under sandboxesDir() ⇒ refuse', () => {
    const treeBefore = repo.shasumTree();

    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    const genuineScratch = scratchBranch(sb.id);
    expect(repo.branches()).toContain(genuineScratch);

    // Guard C FAILS ALONE: branch stays honest (guards A+B pass), only the
    // worktreePath moves OUTSIDE sandboxesDir(). worktreeContained → false →
    // guardsPass false → git ops refused.
    const outside = join(tmpdir(), `h4-escape-${sb.id}`);
    expect(resolve(outside).startsWith(sandboxesDir() + sep)).toBe(false);

    const tampered: Sandbox = { ...sb, worktreePath: outside };
    removeSandbox(tampered);

    // REFUSED: the genuine scratch ref survives (re-derived safeBranch never
    // `branch -D`'d because the containment conjunct failed).
    expect(repo.branches()).toContain(genuineScratch);
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(existsSync(outside)).toBe(false); // never created/removed by us

    const refused = refusedRemoveAudit(sb.id);
    expect(refused?.summary).toMatch(/branch-prefix\/containment guard/);
    expect(existsSync(join(sandboxesDir(), sb.id))).toBe(false);

    removeSandbox(sb);
    expect(repo.branches()).not.toContain(genuineScratch);
  });

  it("7.7 [UNTESTED] a non-namespaced branch is NEVER branch -D'd (BRANCH_PREFIX guard)", () => {
    // The load-bearing safety property: removeSandbox can never delete a branch
    // outside ashlr/sandbox/*. Seed a user branch, tamper the handle to claim it,
    // and prove it survives. A companion [STATIC] check pins the same guard in
    // createSandbox's failure-cleanup path.
    const userBranch = 'main-feature';
    gitBranch(repo.dir, userBranch);
    expect(repo.branches()).toContain(userBranch);

    const sb = createSandbox(repo.dir, { allowAnyRepo: true });

    // Tamper BOTH branch + worktreePath to fully impersonate "delete this user
    // branch + remove this arbitrary worktree" — the worst-case forged handle.
    const tampered: Sandbox = {
      ...sb,
      branch: userBranch,
      worktreePath: join(tmpdir(), `h4-forge-${sb.id}`),
    };
    removeSandbox(tampered);

    // The user branch is untouched — proven by its survival.
    expect(repo.branches()).toContain(userBranch);

    // [STATIC] createSandbox's failure-cleanup path guards `branch -D` behind a
    // BRANCH_PREFIX check — pin that token so a refactor that drops it fails this
    // regression (a non-namespaced branch could otherwise reach -D).
    const src = worktreeSource();
    expect(src).toContain('branch.startsWith(BRANCH_PREFIX)');
    // [STATIC] no `branch -D` invocation passes raw `sb.branch` — they target the
    // RE-DERIVED safeBranch / the prefix-guarded local `branch` only.
    expect(src).not.toMatch(/'branch',\s*'-D',\s*sb\.branch/);
    expect(src).toContain("'branch', '-D', safeBranch");

    removeSandbox(sb); // reclaim the genuine scratch ref
    expect(repo.branches()).toContain(userBranch);
  });
});

// ===========================================================================
// 7.8 — listSandboxes skips malformed metadata; never crashes the sweep.
// 7.9 — symlink worktreePath escape is blocked by containment.
// ===========================================================================

describe('H4 · CONTAINMENT · robustness', () => {
  it('7.8 [UNTESTED] listSandboxes SKIPS malformed sandbox.json, never crashes the sweep', () => {
    // One GENUINE sandbox (valid metadata) — must be surfaced.
    const good = createSandbox(repo.dir, { allowAnyRepo: true });
    expect(listSandboxes().map((s) => s.id)).toContain(good.id);

    const root = sandboxesDir();

    // (a) A dir with INVALID JSON.
    const badJsonId = 'bad-json-entry';
    mkdirSync(join(root, badJsonId), { recursive: true });
    writeFileSync(join(root, badJsonId, 'sandbox.json'), '{ not json at all', 'utf8');

    // (b) A dir with VALID JSON but MISSING required fields.
    const missingFieldsId = 'missing-fields-entry';
    mkdirSync(join(root, missingFieldsId), { recursive: true });
    writeFileSync(
      join(root, missingFieldsId, 'sandbox.json'),
      JSON.stringify({ id: missingFieldsId, branch: 'x' }) + '\n',
      'utf8',
    );

    // (c) A dir with NO metadata file at all.
    const noMetaId = 'no-meta-entry';
    mkdirSync(join(root, noMetaId), { recursive: true });

    // The sweep must NOT throw and must return ONLY the valid entry.
    let entries: Sandbox[] = [];
    expect(() => {
      entries = listSandboxes();
    }).not.toThrow();

    const ids = entries.map((s) => s.id);
    expect(ids).toContain(good.id);
    expect(ids).not.toContain(badJsonId);
    expect(ids).not.toContain(missingFieldsId);
    expect(ids).not.toContain(noMetaId);

    // Every surfaced entry is fully-formed (the malformed ones were dropped).
    for (const e of entries) {
      expect(typeof e.id).toBe('string');
      expect(typeof e.sourceRepo).toBe('string');
      expect(typeof e.worktreePath).toBe('string');
      expect(typeof e.branch).toBe('string');
      expect(typeof e.baseHead).toBe('string');
      expect(typeof e.createdAt).toBe('string');
    }

    removeSandbox(good);
  });

  // skipIf(!canSymlink): this test builds a REAL symlink to simulate the escape;
  // Windows without symlink privilege throws EPERM at symlinkSync. The
  // containment guard it exercises is platform-agnostic and covered by 7.6.
  it.skipIf(!canSymlink())('7.9 [UNTESTED] symlink worktreePath escape is blocked (containment defeats symlink)', () => {
    const treeBefore = repo.shasumTree();

    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    const genuineScratch = scratchBranch(sb.id);
    expect(repo.branches()).toContain(genuineScratch);

    // Build a REAL symlink ESCAPE: a sibling tmp dir simulating a sensitive
    // target OUTSIDE the sandbox root, and a symlink (path string also outside
    // sandboxesDir()) pointing at it. A forged handle that set worktreePath to
    // this symlink would, if git ops ran, `git worktree remove` the symlink and
    // reach the target. The containment guard must block it.
    const escapeTarget = join(tmpdir(), `h4-symlink-target-${sb.id}`);
    mkdirSync(escapeTarget, { recursive: true });
    writeFileSync(join(escapeTarget, 'sentinel.txt'), 'do-not-touch\n', 'utf8');

    const link = join(tmpdir(), `h4-symlink-${sb.id}`);
    symlinkSync(escapeTarget, link);

    const tampered: Sandbox = { ...sb, worktreePath: link };

    // The guard rejects this: resolve(link) is OUTSIDE sandboxesDir() (the link
    // path string itself is a sibling of the sandbox root) AND ≠
    // resolve(safeWorktree). Git ops are refused.
    expect(resolve(link).startsWith(sandboxesDir() + sep)).toBe(false);

    removeSandbox(tampered);

    // ESCAPE BLOCKED: the symlink target dir + its sentinel are untouched (git
    // `worktree remove` never ran against the symlink), the genuine scratch ref
    // survives, and the source tree is byte-identical.
    expect(existsSync(escapeTarget)).toBe(true);
    expect(existsSync(join(escapeTarget, 'sentinel.txt'))).toBe(true);
    expect(readFileSync(join(escapeTarget, 'sentinel.txt'), 'utf8')).toBe(
      'do-not-touch\n',
    );
    expect(repo.branches()).toContain(genuineScratch);
    expect(repo.shasumTree()).toBe(treeBefore);

    const refused = refusedRemoveAudit(sb.id);
    expect(refused?.summary).toMatch(/branch-prefix\/containment guard/);

    // FINDING (surfaced, not silently fixed): the containment guard uses
    // path.resolve(), which is PURELY LEXICAL — it normalizes `.`/`..` but does
    // NOT follow symlinks (realpathSync would). The escape above is caught
    // because the tampered worktreePath STRING is itself outside sandboxesDir().
    // But a symlink placed AT the honest in-namespace path (e.g.
    // <sandboxesDir>/<id>/worktree → /etc) would have a CONTAINED lexical path
    // and resolve() would NOT catch it. The remaining (and sufficient) defense
    // in that case is that git ops target the RE-DERIVED safeWorktree path and
    // `git worktree remove` only removes a path it tracks as a registered
    // worktree. We pin BOTH facts:
    //   (i)  resolve() is lexical-only (≠ realpath), and
    //   (ii) git ops never use the raw tampered worktreePath — only safeWorktree.
    expect(resolve(link)).not.toBe(resolve(escapeTarget)); // resolve() ≠ realpath
    const src = worktreeSource();
    expect(src).toContain("'remove', '--force', safeWorktree");
    expect(src).not.toMatch(/'remove',\s*'--force',\s*sb\.worktreePath/);

    removeSandbox(sb); // reclaim the genuine scratch ref
    expect(repo.branches()).not.toContain(genuineScratch);

    // Tidy: drop the escape scaffolding (NOT under the tmp HOME; explicit rm).
    rmSync(link, { force: true });
    rmSync(escapeTarget, { recursive: true, force: true });
  });
});

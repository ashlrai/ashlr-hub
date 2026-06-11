/**
 * test/h4.sandbox-enrollment-kill.test.ts — H4 INVARIANTS 2, 3, 4 (combined).
 *
 * One ALWAYS-ON regression file that pins three load-bearing safety invariants
 * (CONTRACT-H4.md §§ Invariant 2/3/4) so any future change that weakens them
 * FAILS CI:
 *
 *   INVARIANT 2 — SANDBOX-REQUIRED (guards 2.1–2.6):
 *     requireSandbox + abortNoSandbox aborts to ZERO tasks when a sandbox can't
 *     be created — including the previously-UNTESTED "worktree module
 *     unavailable" path (2.3) and the non-git (2.4) / unresolvable-HEAD (2.5)
 *     refusals — rather than ever touch the real working tree; and createSandbox
 *     REFUSES an unenrolled repo without allowAnyRepo (2.6, previously UNTESTED).
 *
 *   INVARIANT 3 — ENROLLMENT (guards 3.1–3.7):
 *     The registry DEFAULTS EMPTY; assertMayMutate enforces enrollment at every
 *     documented call site (direct, createSandbox, applyProposal, daemon tick).
 *
 *   INVARIANT 4 — KILL-SWITCH (guards 4.1–4.6):
 *     killSwitchOn() is checked BEFORE work in assertMayMutate / createSandbox /
 *     tick / applyProposal; and — the previously-UNTESTED negative — allowAnyRepo
 *     can NEVER override the kill switch (4.6): kill ON + allowAnyRepo:true STILL
 *     throws, because the kill check precedes the enrollment/allowAnyRepo check.
 *
 * SAFETY (paramount — inherited verbatim from H1/H2/H3, see CONTRACT-H4.md):
 *   - ISOLATED HOME per test via the H1 fixture (makeFixture) — every ~/.ashlr
 *     read/write (enrollment, KILL, sandboxes, inbox, daemon state) resolves to a
 *     FRESH os.tmpdir() home, NEVER the real one; the fixture asserts
 *     homedir()===tmpHome and refuses to run otherwise.
 *   - REAL PORTFOLIO UNTOUCHED — only DISPOSABLE git repos under os.tmpdir() are
 *     ever sandboxed/enrolled; the real ~/.ashlr/enrollment.json ({repos:[]}) is
 *     never read or written.
 *   - DETERMINISTIC — no live model, no network, no real model subprocess. The
 *     real runSwarm is driven ONLY down its abort paths (which return before any
 *     task executes); the daemon tick is exercised with empty enrollment / kill
 *     set so it returns before any swarm runs.
 *   - REAL-TREE-UNCHANGED — shasumTree(repo) is asserted byte-identical across
 *     every abort/refusal.
 *   - EXPLICIT ASSERTIONS — every it() has real expect(); beforeEach calls
 *     expect.hasAssertions() so a vacuous/false-green stub fails structurally.
 *
 * REUSE: H1 testkit (makeFixture/makeRepo/shasumTree/makeCfg) + H2 testkit
 * (seedPendingProposal). No new fixture/fault surface is added by this file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { seedPendingProposal } from './helpers/h2-faults.js';

import {
  assertMayMutate,
  isEnrolled,
  listEnrolled,
  enroll,
  unenroll,
  setKill,
  killSwitchOn,
  enrollmentPath,
} from '../src/core/sandbox/policy.js';
import { createSandbox, sandboxesDir } from '../src/core/sandbox/worktree.js';
import { runSwarm } from '../src/core/swarm/runner.js';
import { tick } from '../src/core/daemon/loop.js';
import { applyProposal } from '../src/core/inbox/apply.js';
import { setStatus } from '../src/core/inbox/store.js';
import type { StreamSink } from '../src/core/run/streaming.js';
import type { AuditEntry } from '../src/core/types.js';

// A no-op sink — the abort paths log to it but we assert on the returned run.
const sink: StreamSink = () => {};

/**
 * Read every audit record written under the (isolated) ~/.ashlr/audit/ tree.
 * Used to assert refusals are audited result:'refused'. Returns [] when no
 * audit file exists yet. NEVER touches the real HOME (fixture isolates it).
 */
function readAuditRecords(home: string): AuditEntry[] {
  const auditDir = join(home, '.ashlr', 'audit');
  if (!existsSync(auditDir)) return [];
  const out: AuditEntry[] = [];
  for (const f of readdirSync(auditDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const raw = readFileSync(join(auditDir, f), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as AuditEntry);
      } catch {
        /* tolerate a partial trailing line */
      }
    }
  }
  return out;
}

// ===========================================================================
// INVARIANT 2 — SANDBOX-REQUIRED
// ===========================================================================

describe('H4 · SANDBOX-REQUIRED · mandatory-sandbox abort (ZERO tasks, tree untouched)', () => {
  let fx: H1Fixture;

  beforeEach(() => {
    expect.hasAssertions();
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('2.1 requireSandbox abort returns status:"failed", ZERO tasks, real tree unchanged', async () => {
    // A NON-git tmp dir as the "project": createSandbox throws (not a git repo),
    // and because requireSandbox is set the swarm MUST abort, not fall back.
    const fx2 = makeFixture();
    try {
      // A dedicated NON-git subdir as the "project" with a seed file. It is NOT
      // the HOME root (so the abort's audit write into ~/.ashlr does not pollute
      // the measured project tree) and NOT a git repo (so createSandbox throws
      // and, with requireSandbox, the swarm aborts rather than falling back).
      const nonGitProject = join(fx2.home, 'plain-non-git-project');
      mkdirSync(nonGitProject, { recursive: true });
      writeFileSync(join(nonGitProject, 'keep.txt'), 'untouched\n', 'utf8');
      const before = listTree(nonGitProject);

      const run = await runSwarm(
        { goal: 'should never execute a task' },
        makeCfg(),
        { sandbox: true, requireSandbox: true, project: nonGitProject, allowCloud: false },
        sink,
      );

      expect(run.status).toBe('failed');
      expect(run.tasks).toEqual([]); // ZERO tasks
      expect(run.plan.tasks).toEqual([]);
      expect(run.result ?? '').toMatch(/mandatory sandbox could not be created/i);
      expect(run.result ?? '').toMatch(/working tree was NOT touched/i);
      // No sandbox worktree was ever created under sandboxesDir().
      const sbRoot = sandboxesDir();
      const created = existsSync(sbRoot) ? readdirSync(sbRoot) : [];
      expect(created).toEqual([]);
      // The (non-git) project dir is byte-identical — never touched.
      const after = listTree(nonGitProject);
      expect(after).toBe(before);
    } finally {
      fx2.cleanup();
    }
  });

  it('2.2 aborts (ZERO tasks) when project===null under requireSandbox', async () => {
    const run = await runSwarm(
      { goal: 'no project — must abort' },
      makeCfg(),
      { sandbox: true, requireSandbox: true, allowCloud: false }, // no project
      sink,
    );
    expect(run.status).toBe('failed');
    expect(run.tasks).toEqual([]);
    expect(run.result ?? '').toMatch(/no project specified for a mandatory sandbox/i);
    expect(run.result ?? '').toMatch(/working tree was NOT touched/i);
  });

  it('2.3 [UNTESTED] aborts with "sandbox worktree module unavailable" when the module is absent', async () => {
    // Force the lazy worktree binding to stay null by making the dynamic import
    // of ../sandbox/worktree.js THROW for a freshly-imported runner instance.
    // _m21Loaded is module-scoped, so a vi.resetModules() + fresh import resets
    // the loader; the doMock makes loadM21's import fail → _createSandbox null.
    // This matches how H2 exercises the lazy seams (binding forced absent).
    const repo = fx.makeRepo(); // a REAL git repo so the abort is specifically
    // "module unavailable" (NOT non-git/HEAD): project IS a git repo, but the
    // worktree MODULE can't load.
    const before = repo.shasumTree();

    vi.resetModules();
    vi.doMock('../src/core/sandbox/worktree.js', () => {
      throw new Error('simulated: worktree module unavailable');
    });
    try {
      const mod = await import('../src/core/swarm/runner.js');
      const run = await mod.runSwarm(
        { goal: 'module unavailable — must abort' },
        makeCfg(),
        { sandbox: true, requireSandbox: true, project: repo.dir, allowCloud: false },
        sink,
      );
      expect(run.status).toBe('failed');
      expect(run.tasks).toEqual([]);
      expect(run.result ?? '').toMatch(/sandbox worktree module unavailable/i);
      expect(run.result ?? '').toMatch(/working tree was NOT touched/i);
      // The real git repo tree is byte-identical — never touched.
      expect(repo.shasumTree()).toBe(before);
      expect(repo.gitStatus()).toBe(''); // clean working tree
    } finally {
      vi.doUnmock('../src/core/sandbox/worktree.js');
      vi.resetModules();
    }
  });
});

describe('H4 · SANDBOX-REQUIRED · createSandbox refusals', () => {
  let fx: H1Fixture;

  beforeEach(() => {
    expect.hasAssertions();
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('2.4 createSandbox REFUSES a non-git repo (isRepo false), audits error, creates no worktree', () => {
    // The isolated HOME dir is a real, non-git directory. Enroll it so the
    // enrollment gate passes and the refusal is specifically the not-a-git-repo
    // guard, not the enrollment gate.
    const nonGit = fx.home;
    enroll(nonGit);
    expect(() => createSandbox(nonGit)).toThrow(/not a git repository/i);
    // No sandbox home created.
    const sbRoot = sandboxesDir();
    const created = existsSync(sbRoot) ? readdirSync(sbRoot) : [];
    expect(created).toEqual([]);
    // Audited as an error (not silent).
    const audits = readAuditRecords(fx.home);
    const refusal = audits.find(
      (a) => a.action === 'sandbox:create' && a.summary.includes('not a git repository'),
    );
    expect(refusal).toBeDefined();
    expect(refusal?.result).toBe('error');
    unenroll(nonGit);
  });

  it('2.5 createSandbox REFUSES when HEAD is unresolvable (git repo with no commits)', () => {
    // A git repo with NO commits has an unborn HEAD → rev-parse HEAD fails.
    const repo = fx.makeRepo(); // has an initial commit
    // Make an empty repo by re-initializing a fresh dir without committing.
    const empty = fx.makeRepo();
    // Roll the empty repo back to zero commits by deleting refs is fragile;
    // instead create a brand-new uninitialized-HEAD repo via git init in a sub.
    const emptyDir = join(empty.dir, 'sub-empty');
    // Build a fresh repo with NO commit so HEAD is unborn.
    initEmptyRepo(emptyDir);
    enroll(emptyDir);
    expect(() => createSandbox(emptyDir)).toThrow(/could not resolve HEAD/i);
    const audits = readAuditRecords(fx.home);
    const refusal = audits.find(
      (a) => a.action === 'sandbox:create' && a.summary.includes('could not resolve source HEAD'),
    );
    expect(refusal).toBeDefined();
    expect(refusal?.result).toBe('error');
    unenroll(emptyDir);
    // The pre-existing committed repo is untouched the whole time.
    expect(repo.gitStatus()).toBe('');
  });

  it('2.6 [UNTESTED] createSandbox REFUSES an unenrolled repo without allowAnyRepo (audits refused; allowAnyRepo is the only hatch)', () => {
    const repo = fx.makeRepo();
    expect(repo.isEnrolled()).toBe(false); // NOT enrolled
    const before = repo.shasumTree();

    // Refusal: no allowAnyRepo, repo not enrolled → throws the enrollment error.
    expect(() => createSandbox(repo.dir)).toThrow(/repo not enrolled for autonomous work/i);

    // No worktree was created under sandboxesDir().
    const sbRoot = sandboxesDir();
    const createdAfterRefusal = existsSync(sbRoot) ? readdirSync(sbRoot) : [];
    expect(createdAfterRefusal).toEqual([]);

    // Audited as result:'refused' (policy gate).
    const audits = readAuditRecords(fx.home);
    const refusal = audits.find(
      (a) => a.action === 'sandbox:create' && a.result === 'refused',
    );
    expect(refusal).toBeDefined();
    expect(refusal?.summary).toMatch(/refused by policy gate/i);

    // The repo tree is untouched by the refusal.
    expect(repo.shasumTree()).toBe(before);

    // The documented hatch — allowAnyRepo:true — succeeds, proving the refusal
    // above was SPECIFICALLY the enrollment gate (still without enrolling).
    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    expect(sb.id).toBeTruthy();
    expect(sb.branch.startsWith('ashlr/sandbox/')).toBe(true);
    expect(existsSync(sb.worktreePath)).toBe(true);
    expect(repo.isEnrolled()).toBe(false); // never enrolled by the hatch
  });
});

// ===========================================================================
// INVARIANT 3 — ENROLLMENT
// ===========================================================================

describe('H4 · ENROLLMENT · default-empty registry', () => {
  let fx: H1Fixture;

  beforeEach(() => {
    expect.hasAssertions();
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('3.1 listEnrolled() === [] on a fresh isolated HOME (DEFAULT EMPTY)', () => {
    // No enrollment.json exists in the fresh isolated HOME.
    expect(existsSync(enrollmentPath())).toBe(false);
    expect(listEnrolled()).toEqual([]);
    // And isEnrolled is false for any disposable repo.
    const repo = fx.makeRepo();
    expect(isEnrolled(repo.dir)).toBe(false);
  });

  it('3.2 absent/malformed enrollment.json yields { repos: [] } and never throws', () => {
    // Absent → [].
    expect(listEnrolled()).toEqual([]);
    // Now write a MALFORMED registry and assert it degrades to [] (never throws).
    const p = enrollmentPath();
    // Ensure ~/.ashlr exists by enrolling+unenrolling a throwaway dir first.
    const repo = fx.makeRepo();
    enroll(repo.dir);
    unenroll(repo.dir);
    writeFileSync(p, '{ this is not valid json', 'utf8');
    expect(() => listEnrolled()).not.toThrow();
    expect(listEnrolled()).toEqual([]);
    // A structurally-wrong (non-{repos:[]}) JSON also degrades to [].
    writeFileSync(p, JSON.stringify({ notRepos: 1 }), 'utf8');
    expect(listEnrolled()).toEqual([]);
    // An array (not an object) also degrades to [].
    writeFileSync(p, JSON.stringify(['/some/repo']), 'utf8');
    expect(listEnrolled()).toEqual([]);
  });
});

describe('H4 · ENROLLMENT · normalization + assert gate', () => {
  let fx: H1Fixture;

  beforeEach(() => {
    expect.hasAssertions();
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('3.3 enroll/unenroll normalize to absolute via resolve(); idempotent', () => {
    const repo = fx.makeRepo();
    // Enroll twice — idempotent (no duplicate entry).
    enroll(repo.dir);
    enroll(repo.dir);
    const enrolled = listEnrolled();
    expect(enrolled.filter((r) => r === repo.dir)).toHaveLength(1);
    // A trailing-slash / non-normalized form resolves to the SAME absolute path.
    expect(isEnrolled(repo.dir + '/')).toBe(true);
    // Unenroll twice — idempotent.
    unenroll(repo.dir);
    unenroll(repo.dir);
    expect(isEnrolled(repo.dir)).toBe(false);
    expect(listEnrolled()).not.toContain(repo.dir);
  });

  it('3.4 assertMayMutate THROWS for an unenrolled repo (no allowAnyRepo)', () => {
    const repo = fx.makeRepo();
    expect(repo.isEnrolled()).toBe(false);
    expect(() => assertMayMutate(repo.dir)).toThrow(/repo not enrolled for autonomous work/i);
    // Once enrolled, it no longer throws (the gate is specifically enrollment).
    enroll(repo.dir);
    expect(() => assertMayMutate(repo.dir)).not.toThrow();
    unenroll(repo.dir);
  });
});

describe('H4 · ENROLLMENT · enforced at every documented call site', () => {
  let fx: H1Fixture;

  beforeEach(() => {
    expect.hasAssertions();
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('3.5 daemon tick does NOTHING with empty enrollment (reason:"no-enrolled-repos", zero proposals)', async () => {
    expect(listEnrolled()).toEqual([]); // DEFAULT EMPTY
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('no-enrolled-repos');
    expect(result.proposalsCreated).toBe(0);
    expect(result.itemsConsidered).toBe(0);
    expect(result.spentUsd).toBe(0);
  });

  it('3.6 createSandbox routes through assertMayMutate (enrollment gate at call site)', () => {
    const repo = fx.makeRepo();
    expect(repo.isEnrolled()).toBe(false);
    // Unenrolled → refused by the enrollment gate (call-site routing proven).
    expect(() => createSandbox(repo.dir)).toThrow(/repo not enrolled/i);
    // Enroll → the same call now passes the gate and creates a sandbox.
    enroll(repo.dir);
    const sb = createSandbox(repo.dir);
    expect(sb.branch.startsWith('ashlr/sandbox/')).toBe(true);
    expect(existsSync(sb.worktreePath)).toBe(true);
    unenroll(repo.dir);
  });

  it('3.7 applyProposal routes mutating kinds through assertMayMutate (enrollment gate at call site)', async () => {
    const repo = fx.makeRepo();
    expect(repo.isEnrolled()).toBe(false);
    // Seed an APPROVED patch proposal on the UNENROLLED repo.
    const p = seedPendingProposal(repo.dir, 'h4-enroll-gate');
    setStatus(p.id, 'approved');
    const before = repo.shasumTree();

    // Apply with confirmed:true but repo NOT enrolled → refused by the gate.
    const res = await applyProposal(p.id, { confirmed: true });
    expect(res.ok).toBe(false);
    // Refusal (not failure): status stays 'approved' so it can be retried.
    expect(res.status).toBe('approved');
    expect(res.detail).toMatch(/repo not enrolled for autonomous work/i);
    // Real tree untouched.
    expect(repo.shasumTree()).toBe(before);
    // Audited refused.
    const audits = readAuditRecords(fx.home);
    const refusal = audits.find(
      (a) => a.action === 'inbox:apply' && a.result === 'refused' && a.sandboxId === p.id,
    );
    expect(refusal).toBeDefined();
    expect(refusal?.summary).toMatch(/refused by policy gate/i);
  });
});

// ===========================================================================
// INVARIANT 4 — KILL-SWITCH
// ===========================================================================

describe('H4 · KILL-SWITCH · checked before work everywhere', () => {
  let fx: H1Fixture;

  beforeEach(() => {
    expect.hasAssertions();
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('4.1 assertMayMutate THROWS when kill is on, regardless of enrollment', () => {
    const repo = fx.makeRepo();
    enroll(repo.dir); // ENROLLED — kill must STILL win.
    expect(isEnrolled(repo.dir)).toBe(true);
    setKill(true);
    expect(killSwitchOn()).toBe(true);
    expect(() => assertMayMutate(repo.dir)).toThrow(/autonomy kill switch is ON/i);
    // Clearing the kill switch lets the enrolled repo through (proves it was the
    // kill check, not enrollment, that refused).
    setKill(false);
    expect(() => assertMayMutate(repo.dir)).not.toThrow();
    unenroll(repo.dir);
  });

  it('4.2 daemon tick first-checks kill (reason:"kill-switch"), does zero work', async () => {
    // Even with an ENROLLED repo, kill-on means the tick returns before any work.
    const repo = fx.makeRepo();
    enroll(repo.dir);
    setKill(true);
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result.reason).toBe('kill-switch');
    expect(result.proposalsCreated).toBe(0);
    expect(result.itemsConsidered).toBe(0);
    expect(result.spentUsd).toBe(0);
    // No sandbox was created (kill check precedes any swarm/sandbox work).
    const sbRoot = sandboxesDir();
    const created = existsSync(sbRoot) ? readdirSync(sbRoot) : [];
    expect(created).toEqual([]);
    setKill(false);
    unenroll(repo.dir);
  });

  it('4.5 createSandbox refuses (via assertMayMutate) when kill is on, even for an enrolled repo', () => {
    const repo = fx.makeRepo();
    enroll(repo.dir);
    const before = repo.shasumTree();
    setKill(true);
    expect(() => createSandbox(repo.dir)).toThrow(/autonomy kill switch is ON/i);
    // No worktree created; tree untouched; refusal audited.
    const sbRoot = sandboxesDir();
    expect(existsSync(sbRoot) ? readdirSync(sbRoot) : []).toEqual([]);
    expect(repo.shasumTree()).toBe(before);
    const audits = readAuditRecords(fx.home);
    expect(
      audits.some((a) => a.action === 'sandbox:create' && a.result === 'refused'),
    ).toBe(true);
    setKill(false);
    unenroll(repo.dir);
  });

  it('4.x applyProposal refuses a mutating kind when kill is on (kill checked before dispatch)', async () => {
    const repo = fx.makeRepo();
    enroll(repo.dir); // ENROLLED so the refusal is specifically the kill switch.
    const p = seedPendingProposal(repo.dir, 'h4-kill-apply');
    setStatus(p.id, 'approved');
    const before = repo.shasumTree();
    setKill(true);
    const res = await applyProposal(p.id, { confirmed: true });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('approved'); // refusal, retryable
    expect(res.detail).toMatch(/autonomy kill switch is ON/i);
    expect(repo.shasumTree()).toBe(before);
    setKill(false);
    unenroll(repo.dir);
  });
});

describe('H4 · KILL-SWITCH · overrides everything (allowAnyRepo can NEVER bypass kill)', () => {
  let fx: H1Fixture;

  beforeEach(() => {
    expect.hasAssertions();
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('4.6 [UNTESTED] allowAnyRepo:true STILL throws when kill is on (assertMayMutate)', () => {
    const repo = fx.makeRepo();
    expect(repo.isEnrolled()).toBe(false); // unenrolled — allowAnyRepo would normally pass
    setKill(true);
    // The kill check (policy.ts:175) precedes the enrollment/allowAnyRepo check
    // (policy.ts:180), so the test hatch can NEVER reach mutation while kill is set.
    expect(() => assertMayMutate(repo.dir, { allowAnyRepo: true })).toThrow(
      /autonomy kill switch is ON/i,
    );
    // Sanity: with kill OFF, allowAnyRepo:true DOES pass for the same unenrolled
    // repo — proving the throw above was the kill check, not enrollment.
    setKill(false);
    expect(() => assertMayMutate(repo.dir, { allowAnyRepo: true })).not.toThrow();
  });

  it('4.6 [UNTESTED] createSandbox(repo,{allowAnyRepo:true}) STILL refuses when kill is on (audits refused, tree untouched)', () => {
    const repo = fx.makeRepo();
    expect(repo.isEnrolled()).toBe(false);
    const before = repo.shasumTree();
    setKill(true);
    expect(() => createSandbox(repo.dir, { allowAnyRepo: true })).toThrow(
      /autonomy kill switch is ON/i,
    );
    // No worktree created; tree untouched.
    const sbRoot = sandboxesDir();
    expect(existsSync(sbRoot) ? readdirSync(sbRoot) : []).toEqual([]);
    expect(repo.shasumTree()).toBe(before);
    // Refusal audited.
    const audits = readAuditRecords(fx.home);
    expect(
      audits.some((a) => a.action === 'sandbox:create' && a.result === 'refused'),
    ).toBe(true);
    setKill(false);
    // With kill cleared, the allowAnyRepo hatch now succeeds (proves kill was the
    // refusal cause) — still never enrolling the repo.
    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    expect(sb.branch.startsWith('ashlr/sandbox/')).toBe(true);
    expect(repo.isEnrolled()).toBe(false);
  });
});

// ===========================================================================
// Local helpers (test-only; pure filesystem/git, no production code)
// ===========================================================================

/** A stable content hash of a directory tree (excluding .git), for "unchanged" asserts. */
function listTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string, rel: string): void => {
    const entries = readdirSync(d).sort();
    for (const name of entries) {
      if (name === '.git') continue;
      const full = join(d, name);
      const st = statSync(full);
      const relPath = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        h.update(`D:${relPath}\n`);
        walk(full, relPath);
      } else {
        h.update(`F:${relPath}:`);
        h.update(readFileSync(full));
        h.update('\n');
      }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

/** git init a fresh repo at `dir` with NO commit (unborn HEAD). */
function initEmptyRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', '.'], {
    cwd: dir,
    stdio: 'pipe',
  });
}

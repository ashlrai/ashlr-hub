/**
 * M47 — tiered-trust merge-to-main gate tests.
 *
 * SAFETY / HERMETICITY:
 *  - HOME is overridden to a tmp dir so real ~/.ashlr/{inbox,enrollment,...} is
 *    NEVER touched.
 *  - All git repos are real tmp repos under os.tmpdir(); no network, no push.
 *  - ASHLR_TEST_ALLOW_ANY_REPO=1 is set, but autoMergeProposal calls
 *    assertMayMutate(repo) WITHOUT the allowAnyRepo opt, so the happy-path tests
 *    still enroll() the tmp repo explicitly (env var alone does not bypass).
 *  - No `gh` is ever invoked: every happy path is LOCAL (no github remote +
 *    pushToRemote unset), so createPr / gh pr merge are never reached.
 *
 * Covers: classifyRisk, evaluateMergeAuthority, defaultBranch, verifyProposal,
 * autoMergeProposal refusals + the local happy path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  classifyRisk,
  evaluateMergeAuthority,
  defaultBranch,
  verifyProposal,
  autoMergeProposal,
} from '../src/core/inbox/merge.js';
import { createProposal, setStatus, loadProposal } from '../src/core/inbox/store.js';
import { enroll, unenroll, setKill } from '../src/core/sandbox/policy.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAllowAny = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
let tmpHome: string;
let tmpRepo: string;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** Init a real git repo with an initial commit on `branch`. */
function initRepo(dir: string, branch = 'main'): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', `--initial-branch=${branch}`, dir], { stdio: 'pipe' });
  git(dir, ['config', 'user.email', 'test@ashlr.test']);
  git(dir, ['config', 'user.name', 'Ashlr Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
}

function listBranches(dir: string): string[] {
  return git(dir, ['branch', '--format=%(refname:short)'])
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);
}

/** Minimal unified diff that adds a new file. */
function addFileDiff(filename: string, content: string): string {
  return [
    `diff --git a/${filename} b/${filename}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${filename}`,
    '@@ -0,0 +1 @@',
    `+${content}`,
    '',
  ].join('\n');
}

/** Build a Proposal object directly (not persisted) for the PURE-fn tests. */
function makeProposal(over: Partial<Proposal>): Proposal {
  return {
    id: 'prop-test',
    repo: tmpRepo,
    origin: 'agent',
    kind: 'patch',
    title: 'test',
    summary: 'test',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** A config with auto-merge enabled + a frontier authority for codex:gpt-5.5. */
function cfgWith(over?: Partial<NonNullable<AshlrConfig['foundry']>>): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      autoMerge: { enabled: true, maxRisk: 'low', allowWithoutVerification: true },
      ...over,
    },
  } as unknown as AshlrConfig;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m47-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m47-repo-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  setKill(false);
});

afterEach(() => {
  try { unenroll(tmpRepo); } catch { /* ignore */ }
  try { setKill(false); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAllowAny === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = origAllowAny;
});

// ===========================================================================
// classifyRisk
// ===========================================================================

describe('M47 classifyRisk', () => {
  it('docs-only diff → low', () => {
    const p = makeProposal({ diff: addFileDiff('docs/guide.md', 'hello docs') });
    expect(classifyRisk(p)).toBe('low');
  });

  // H2: lockfiles were previously classified LOW; they are now HIGH because a
  // lockfile change can pull in a compromised transitive dependency.
  it('package-lock-only diff → high (H2)', () => {
    const p = makeProposal({ diff: addFileDiff('package-lock.json', '{}') });
    expect(classifyRisk(p)).toBe('high');
  });

  it('pnpm-lock / yarn.lock / bun.lockb diffs → high (H2)', () => {
    for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']) {
      const p = makeProposal({ diff: addFileDiff(lock, 'x') });
      expect(classifyRisk(p)).toBe('high');
    }
  });

  it('package.json diff → high (H2)', () => {
    const p = makeProposal({ diff: addFileDiff('package.json', '{ "name": "x" }') });
    expect(classifyRisk(p)).toBe('high');
  });

  it('.github/ workflow diff → high (H2)', () => {
    const p = makeProposal({ diff: addFileDiff('.github/workflows/ci.yml', 'on: push') });
    expect(classifyRisk(p)).toBe('high');
  });

  it('Dockerfile / *.Dockerfile / CI configs → high (H2)', () => {
    for (const f of ['Dockerfile', 'prod.Dockerfile', '.gitlab-ci.yml', '.circleci/config.yml', '.npmrc', 'Makefile']) {
      const p = makeProposal({ diff: addFileDiff(f, 'x') });
      expect(classifyRisk(p)).toBe('high');
    }
  });

  it('shell script (*.sh) diff → high (H2)', () => {
    const p = makeProposal({ diff: addFileDiff('scripts/deploy.sh', 'echo hi') });
    expect(classifyRisk(p)).toBe('high');
  });

  it('test-only diff → low', () => {
    const p = makeProposal({ diff: addFileDiff('test/foo.test.ts', 'expect(1).toBe(1)') });
    expect(classifyRisk(p)).toBe('low');
  });

  it('source *.ts change → high (multiple files)', () => {
    const diff =
      addFileDiff('src/a.ts', 'export const a = 1') +
      addFileDiff('src/b.ts', 'export const b = 2');
    const p = makeProposal({ diff });
    expect(classifyRisk(p)).toBe('high');
  });

  it('single small *.ts change → medium', () => {
    const p = makeProposal({ diff: addFileDiff('src/util.ts', 'export const x = 1') });
    expect(classifyRisk(p)).toBe('medium');
  });

  it('config *.json change → medium', () => {
    const p = makeProposal({ diff: addFileDiff('tsconfig.app.json', '{ "x": 1 }') });
    expect(classifyRisk(p)).toBe('medium');
  });

  it('auth/security source path → high', () => {
    const p = makeProposal({ diff: addFileDiff('src/core/auth.ts', 'export const ok = true') });
    expect(classifyRisk(p)).toBe('high');
  });

  it('empty/unparsable diff → high (fail-safe)', () => {
    const p = makeProposal({ diff: 'not a diff at all' });
    expect(classifyRisk(p)).toBe('high');
  });
});

// ===========================================================================
// evaluateMergeAuthority
// ===========================================================================

describe('M47 evaluateMergeAuthority', () => {
  it('frontier + matching mergeAuthority entry → authorized', () => {
    const p = makeProposal({ engineTier: 'frontier', engineModel: 'codex:gpt-5.5' });
    const v = evaluateMergeAuthority(p, cfgWith());
    expect(v.authorized).toBe(true);
  });

  it('engineTier local → rejected', () => {
    const p = makeProposal({ engineTier: 'local', engineModel: 'codex:gpt-5.5' });
    const v = evaluateMergeAuthority(p, cfgWith());
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/frontier/i);
  });

  it("engineModel ':default' → rejected", () => {
    const p = makeProposal({ engineTier: 'frontier', engineModel: 'codex:default' });
    const v = evaluateMergeAuthority(p, cfgWith());
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/default|concrete/i);
  });

  it('no mergeAuthority config → rejected', () => {
    const p = makeProposal({ engineTier: 'frontier', engineModel: 'codex:gpt-5.5' });
    const cfg = { foundry: { autoMerge: { enabled: true } } } as unknown as AshlrConfig;
    const v = evaluateMergeAuthority(p, cfg);
    expect(v.authorized).toBe(false);
  });

  it('frontier but model not in authority list → rejected', () => {
    const p = makeProposal({ engineTier: 'frontier', engineModel: 'codex:gpt-9' });
    const v = evaluateMergeAuthority(p, cfgWith());
    expect(v.authorized).toBe(false);
  });
});

// ===========================================================================
// defaultBranch
// ===========================================================================

describe('M47 defaultBranch', () => {
  it("returns the repo's current branch on a tmp repo (no remote)", () => {
    initRepo(tmpRepo, 'main');
    expect(defaultBranch(tmpRepo)).toBe('main');
  });

  it('respects a non-main initial branch', () => {
    initRepo(tmpRepo, 'trunk');
    expect(defaultBranch(tmpRepo)).toBe('trunk');
  });

  it('falls back to main on a non-repo path (never throws)', () => {
    expect(defaultBranch(path.join(os.tmpdir(), 'definitely-not-a-repo-xyz'))).toBe('main');
  });
});

// ===========================================================================
// verifyProposal
// ===========================================================================

describe('M47 verifyProposal', () => {
  function writePackageJson(dir: string, testScript: string): void {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fix', version: '1.0.0', scripts: { test: testScript } }, null, 2),
      'utf8',
    );
    git(dir, ['add', 'package.json']);
    git(dir, ['commit', '-m', 'add package.json']);
  }

  it('passing test script + a diff → ok', async () => {
    initRepo(tmpRepo);
    writePackageJson(tmpRepo, 'exit 0');
    const p = makeProposal({ diff: addFileDiff('docs/x.md', 'doc') });
    const res = await verifyProposal(p, cfgWith());
    expect(res.ok).toBe(true);
    expect(res.ran.some((c) => c.kind === 'test')).toBe(true);
  });

  it('failing test script → not ok', async () => {
    initRepo(tmpRepo);
    writePackageJson(tmpRepo, 'exit 1');
    const p = makeProposal({ diff: addFileDiff('docs/y.md', 'doc') });
    const res = await verifyProposal(p, cfgWith());
    expect(res.ok).toBe(false);
  });

  it('no verify commands + allowWithoutVerification false → ok:false (fail-closed)', async () => {
    initRepo(tmpRepo);
    const p = makeProposal({ diff: addFileDiff('docs/z.md', 'doc') });
    const cfg = cfgWith({ autoMerge: { enabled: true, allowWithoutVerification: false } });
    const res = await verifyProposal(p, cfg);
    expect(res.ok).toBe(false);
  });

  it('no verify commands + allowWithoutVerification true → ok:true', async () => {
    initRepo(tmpRepo);
    const p = makeProposal({ diff: addFileDiff('docs/z.md', 'doc') });
    const cfg = cfgWith({ autoMerge: { enabled: true, allowWithoutVerification: true } });
    const res = await verifyProposal(p, cfg);
    expect(res.ok).toBe(true);
  });

  it('leaves no leftover worktree / verify branch', async () => {
    initRepo(tmpRepo);
    const p = makeProposal({ diff: addFileDiff('docs/w.md', 'doc') });
    await verifyProposal(p, cfgWith());
    expect(listBranches(tmpRepo).some((b) => b.startsWith('ashlr/verify/'))).toBe(false);
  });

  // ── H1b: manifest / build / CI guard ────────────────────────────────────────
  it('H1b: diff touching package.json is REFUSED even with allowWithoutVerification:true', async () => {
    initRepo(tmpRepo);
    // allowWithoutVerification:true would otherwise pass a no-command repo.
    const cfg = cfgWith({ autoMerge: { enabled: true, allowWithoutVerification: true } });
    const p = makeProposal({ diff: addFileDiff('package.json', '{ "name": "x" }') });
    const res = await verifyProposal(p, cfg);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/build\/CI\/manifest|manual review/i);
  });

  it('H1b: diff touching a lockfile / .github/ is refused', async () => {
    initRepo(tmpRepo);
    const cfg = cfgWith({ autoMerge: { enabled: true, allowWithoutVerification: true } });
    for (const f of ['package-lock.json', '.github/workflows/ci.yml', 'Dockerfile']) {
      const p = makeProposal({ diff: addFileDiff(f, 'x') });
      const res = await verifyProposal(p, cfg);
      expect(res.ok).toBe(false);
      expect(res.detail).toMatch(/build\/CI\/manifest|manual review/i);
    }
  });

  // ── H1a: base-tree command detection (no self-certification) ─────────────────
  it('H1a: a diff that rewrites the test script to "true" cannot trivially pass', async () => {
    initRepo(tmpRepo);
    // BASE has a FAILING test script. A malicious diff tries to rewrite
    // package.json scripts.test to "true" to self-certify. Because the diff
    // touches package.json it is refused by the manifest guard — and even
    // without that, commands are detected from the BASE tree (exit 1), so the
    // rewritten "true" script can never be the one that runs.
    writePackageJson(tmpRepo, 'exit 1');
    const malicious = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1,5 +1,5 @@',
      ' {',
      '   "name": "fix",',
      '   "version": "1.0.0",',
      '-  "scripts": { "test": "exit 1" }',
      '+  "scripts": { "test": "true" }',
      ' }',
      '',
    ].join('\n');
    const cfg = cfgWith({ autoMerge: { enabled: true, allowWithoutVerification: true } });
    const p = makeProposal({ diff: malicious });
    const res = await verifyProposal(p, cfg);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/build\/CI\/manifest|manual review/i);
  });
});

// ===========================================================================
// autoMergeProposal — refusals (mutate nothing)
// ===========================================================================

describe('M47 autoMergeProposal — refusals', () => {
  function persistedFrontierPatch(diff: string): Proposal {
    // M47.1: a legitimate frontier proposal carries a signed provenance binding
    // {engineModel, engineTier, diffHash} — sign it so it passes Gate 4.5.
    const diffHash = hashDiff(diff);
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'frontier patch',
      summary: 'auto-merge candidate',
      diff,
      diffHash,
      provenanceSig,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(p.id, 'approved');
    return loadProposal(p.id)!;
  }

  it('disabled cfg → refuse, no branch, status unchanged', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);
    const p = persistedFrontierPatch(addFileDiff('docs/a.md', 'doc'));
    const before = listBranches(tmpRepo);

    const cfg = cfgWith({ autoMerge: { enabled: false } });
    const r = await autoMergeProposal(p.id, cfg);

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
    expect(listBranches(tmpRepo)).toEqual(before);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('non-frontier proposal → refuse, no branch', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'local patch',
      summary: 'not frontier',
      diff: addFileDiff('docs/b.md', 'doc'),
      engineModel: 'builtin:llama',
      engineTier: 'local',
    });
    setStatus(p.id, 'approved');
    const before = listBranches(tmpRepo);

    const r = await autoMergeProposal(p.id, cfgWith());
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/authority|frontier/i);
    expect(listBranches(tmpRepo)).toEqual(before);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('risk above maxRisk → refuse, no branch', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);
    // A multi-source diff → high risk, but maxRisk is low.
    const p = persistedFrontierPatch(
      addFileDiff('src/a.ts', 'export const a = 1') + addFileDiff('src/b.ts', 'export const b = 2'),
    );
    const before = listBranches(tmpRepo);

    const r = await autoMergeProposal(p.id, cfgWith());
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/risk/i);
    expect(listBranches(tmpRepo)).toEqual(before);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('kill switch on → refuse', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);
    setKill(true);
    const p = persistedFrontierPatch(addFileDiff('docs/c.md', 'doc'));

    const r = await autoMergeProposal(p.id, cfgWith());
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/kill/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('not enrolled → refuse without burning state', async () => {
    initRepo(tmpRepo);
    // deliberately NOT enrolled
    const p = persistedFrontierPatch(addFileDiff('docs/d.md', 'doc'));

    const r = await autoMergeProposal(p.id, cfgWith());
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/enroll/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('missing proposal → refuse, never throws', async () => {
    await expect(autoMergeProposal('does-not-exist', cfgWith())).resolves.toMatchObject({
      ok: false,
      merged: false,
    });
  });
});

// ===========================================================================
// autoMergeProposal — happy path (LOCAL, no remote)
// ===========================================================================

describe('M47 autoMergeProposal — local happy path', () => {
  /**
   * Wire up an `origin` remote whose HEAD points at `branch`, so defaultBranch()
   * resolves to `branch` via `refs/remotes/origin/HEAD` INDEPENDENT of which
   * branch is checked out locally. Without a remote, defaultBranch falls back to
   * the checked-out branch (its documented fallback), which would make the
   * "operate from another branch" scenario impossible to express.
   */
  function attachOriginWithHead(repo: string, branch: string): void {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m47-origin-')) + '.git';
    execFileSync('git', ['init', '--bare', `--initial-branch=${branch}`, bare], { stdio: 'pipe' });
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-u', 'origin', branch]);
    // Make origin/HEAD explicit so symbolic-ref resolves deterministically.
    git(repo, ['remote', 'set-head', 'origin', branch]);
  }

  it('merges a low-risk docs diff into the default branch locally', async () => {
    // Default branch is 'main' (via origin/HEAD); we operate from a DIFFERENT
    // checked-out branch so the local-merge checked-out-branch guard allows it.
    initRepo(tmpRepo, 'main');
    attachOriginWithHead(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']); // user sits on 'work', not 'main'
    enroll(tmpRepo);

    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    const newDiff = addFileDiff('docs/new.md', 'fresh doc');
    const newHash = hashDiff(newDiff);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'docs update',
      summary: 'add a doc',
      diff: newDiff,
      diffHash: newHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', newHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, cfgWith());

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);

    // The default branch (main) must have advanced.
    const mainAfter = git(tmpRepo, ['rev-parse', 'main']);
    expect(mainAfter).not.toBe(mainBefore);

    // Proposal advanced to applied.
    expect(loadProposal(p.id)!.status).toBe('applied');

    // The merged file is reachable from main.
    const tree = git(tmpRepo, ['ls-tree', '-r', '--name-only', 'main']);
    expect(tree).toContain('docs/new.md');
  });

  it('REFUSES local merge when the default branch is checked out (documented guard)', async () => {
    // User sits ON 'main' (the default branch) — local merge must refuse.
    initRepo(tmpRepo, 'main');
    enroll(tmpRepo);

    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    const guardedDiff = addFileDiff('docs/guarded.md', 'doc');
    const guardedHash = hashDiff(guardedDiff);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'docs update',
      summary: 'add a doc',
      diff: guardedDiff,
      diffHash: guardedHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', guardedHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, cfgWith());

    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/checked out|manual merge/i);
    // main is untouched; the staging branch remains for a manual merge.
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(listBranches(tmpRepo).some((b) => b.startsWith('ashlr/merge/'))).toBe(true);
    // Status NOT advanced (left approvable / hand-mergeable).
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('H6: REFUSES local merge when in detached HEAD on the default-branch commit', async () => {
    // Default branch is 'main' (via origin/HEAD), but the working tree is in a
    // DETACHED HEAD sitting on main's commit — merging into main would advance a
    // ref the user is standing on, so the local merge must refuse.
    initRepo(tmpRepo, 'main');
    attachOriginWithHead(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '--detach', 'main']); // detached HEAD == main commit
    enroll(tmpRepo);

    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    const detachedDiff = addFileDiff('docs/detached.md', 'doc');
    const detachedHash = hashDiff(detachedDiff);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'docs update',
      summary: 'add a doc',
      diff: detachedDiff,
      diffHash: detachedHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', detachedHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, cfgWith());

    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/detached|manual merge/i);
    // main is untouched; the staging branch remains for a manual merge.
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });
});

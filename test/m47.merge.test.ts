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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  classifyRisk,
  evaluateMergeAuthority,
  evaluateEvidenceAutoMergePreflight,
  defaultBranch,
  verifyProposal,
  autoMergeProposal,
} from '../src/core/inbox/merge.js';
import { createProposal, setStatus, loadProposal } from '../src/core/inbox/store.js';
import { enroll, unenroll, setKill } from '../src/core/sandbox/policy.js';
import { hashDiff, signJudgeAttestation, signProvenance } from '../src/core/foundry/provenance.js';
import { recordDecision } from '../src/core/fleet/decisions-ledger.js';
import { evidencePath } from '../src/core/autonomy/evidence-pack.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

const mockIsWebApp = vi.hoisted(() => vi.fn<[string], boolean>(() => false));
const mockVerifyInBrowser = vi.hoisted(() => vi.fn());

vi.mock('../src/core/run/browser-verify.js', () => ({
  isWebApp: mockIsWebApp,
  verifyInBrowser: mockVerifyInBrowser,
}));

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
  mockIsWebApp.mockReset();
  mockIsWebApp.mockReturnValue(false);
  mockVerifyInBrowser.mockReset();
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

  it('source *.ts change → medium (multiple ordinary source files)', () => {
    // M295: ordinary multi-file source changes are MEDIUM (not HIGH). Genuinely
    // dangerous changes (security/build/shell surfaces, or LARGE diffs) still
    // classify HIGH above this point; the merge gate's real protection is
    // judge-ship + verify + attestation, not a file-count heuristic.
    const diff =
      addFileDiff('src/a.ts', 'export const a = 1') +
      addFileDiff('src/b.ts', 'export const b = 2');
    const p = makeProposal({ diff });
    expect(classifyRisk(p)).toBe('medium');
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
    const baseHead = git(tmpRepo, ['rev-parse', 'main']);
    const p = makeProposal({ diff: addFileDiff('docs/x.md', 'doc') });
    const res = await verifyProposal(p, cfgWith());
    expect(res.ok).toBe(true);
    expect(res.ran.some((c) => c.kind === 'test')).toBe(true);
    expect(res.baseBranch).toBe('main');
    expect(res.baseHead).toBe(baseHead);
  });

  it('browserVerify=true attaches browser and visual evidence from the patched worktree', async () => {
    initRepo(tmpRepo);
    writePackageJson(tmpRepo, 'exit 0');
    mockIsWebApp.mockReturnValue(true);
    mockVerifyInBrowser.mockResolvedValue({
      ok: true,
      renderOk: true,
      consoleErrors: [],
      screenshotPath: '/tmp/shot.png',
      detail: 'renders clean, 0 console errors',
      visualGrounding: {
        status: 'ok',
        provider: 'generic-openai-vision',
        boxCount: 1,
        boxes: [{ x1: 10, y1: 20, x2: 300, y2: 400, scale: 'normalized-1000' }],
        image: { bytes: 8, sha256: 'b'.repeat(64) },
        detail: 'visual grounding found 1 box',
      },
    });

    const p = makeProposal({ diff: addFileDiff('docs/browser.md', 'doc') });
    const res = await verifyProposal(p, cfgWith({ browserVerify: true }));

    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/browser verify passed/);
    expect(res.browser).toEqual(expect.objectContaining({
      ok: true,
      renderOk: true,
      consoleErrorCount: 0,
      screenshotCaptured: true,
    }));
    expect(res.browser?.visualGrounding).toEqual(expect.objectContaining({
      status: 'ok',
      boxCount: 1,
      image: { bytes: 8, sha256: 'b'.repeat(64) },
    }));
    expect(mockVerifyInBrowser).toHaveBeenCalledOnce();
    const worktree = mockVerifyInBrowser.mock.calls[0]?.[0];
    expect(worktree).toContain(path.join('.ashlr', 'tmp', 'vwt-'));
    expect(worktree).not.toBe(tmpRepo);
  });

  it('browserVerify=true fails closed on a non-skipped browser render failure', async () => {
    initRepo(tmpRepo);
    writePackageJson(tmpRepo, 'exit 0');
    mockIsWebApp.mockReturnValue(true);
    mockVerifyInBrowser.mockResolvedValue({
      ok: false,
      renderOk: false,
      consoleErrors: [],
      detail: 'blank/error page',
    });

    const p = makeProposal({ diff: addFileDiff('docs/browser-fail.md', 'doc') });
    const res = await verifyProposal(p, cfgWith({ browserVerify: true }));

    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/browser verify failed: blank\/error page/);
    expect(res.browser).toEqual(expect.objectContaining({
      ok: false,
      renderOk: false,
      consoleErrorCount: 0,
      screenshotCaptured: false,
    }));
  });

  it('fails closed when an opaque pre-existing test failure cannot prove non-regression', async () => {
    initRepo(tmpRepo);
    writePackageJson(tmpRepo, 'exit 1');
    const p = makeProposal({ diff: addFileDiff('docs/y.md', 'doc') });
    const res = await verifyProposal(p, cfgWith());
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/non-regression could not be proven/i);
  });

  it('regression detected: baseline passes, after fails → ok:false (M281 regression protection intact)', async () => {
    // M281: baseline passes (exit 0 committed), then we write a package.json
    // with exit 1 as a committed change to the worktree before the diff is applied.
    // We simulate this by: commit exit 0, then in the worktree (after baseline),
    // the diff itself rewrites the test script. But H1b blocks package.json diffs,
    // so we use a two-phase approach: commit a different test-runner file.
    //
    // Simpler approach: use a test script that reads a sentinel file —
    // commit the sentinel as present (exit 0), diff deletes it (exit 1).
    // Since H1b doesn't block non-manifest files, this is valid.
    initRepo(tmpRepo);
    // Write a sentinel and a test script that checks it
    const sentinelPath = path.join(tmpRepo, 'sentinel.txt');
    const helperPath = path.join(tmpRepo, 'check-sentinel.sh');
    fs.writeFileSync(sentinelPath, 'ok', 'utf8');
    fs.writeFileSync(helperPath, '#!/bin/sh\ntest -f sentinel.txt', 'utf8');
    fs.chmodSync(helperPath, 0o755);
    git(tmpRepo, ['add', 'sentinel.txt', 'check-sentinel.sh']);
    git(tmpRepo, ['commit', '-m', 'add sentinel']);
    writePackageJson(tmpRepo, './check-sentinel.sh');

    // Compute a real diff by staging sentinel removal and using git diff
    git(tmpRepo, ['rm', 'sentinel.txt']);
    const removeSentinelDiff = git(tmpRepo, ['diff', '--cached']);
    // Unstage so the worktree remains clean for verifyProposal to create its own worktree
    git(tmpRepo, ['reset', 'HEAD', 'sentinel.txt']);
    git(tmpRepo, ['checkout', '--', 'sentinel.txt']);

    const p = makeProposal({ diff: removeSentinelDiff });
    const res = await verifyProposal(p, cfgWith());
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/regression detected|test.*failed/i);
  });

  it('keeps monorepo baselines distinct when commands share argv', async () => {
    initRepo(tmpRepo);
    for (const name of ['a', 'b']) {
      const dir = path.join(tmpRepo, 'packages', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, scripts: { test: 'node check.js' } }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(dir, 'check.js'),
        "process.exit(require('fs').existsSync('sentinel') ? 0 : 1);\n",
        'utf8',
      );
    }
    fs.writeFileSync(path.join(tmpRepo, 'packages', 'a', 'sentinel'), 'ok\n', 'utf8');
    git(tmpRepo, ['add', 'packages']);
    git(tmpRepo, ['commit', '-m', 'add package checks']);

    git(tmpRepo, ['rm', 'packages/a/sentinel']);
    const diff = git(tmpRepo, ['diff', '--cached']);
    git(tmpRepo, ['reset', 'HEAD', 'packages/a/sentinel']);
    git(tmpRepo, ['checkout', '--', 'packages/a/sentinel']);

    const result = await verifyProposal(makeProposal({ diff }), cfgWith());

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/regression detected/i);
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

  it('uses only merge-profile commands for merge evidence', async () => {
    initRepo(tmpRepo);
    fs.writeFileSync(
      path.join(tmpRepo, 'ashlr.verify.json'),
      JSON.stringify({
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          {
            id: 'merge-advisory-fails',
            kind: 'typecheck',
            cmd: ['node', '-e', 'process.exit(1)'],
            required: false,
            profiles: ['merge'],
          },
          {
            id: 'quick-fails',
            kind: 'test',
            cmd: ['node', '-e', 'process.exit(1)'],
            required: true,
            profiles: ['quick'],
          },
          {
            id: 'merge-passes',
            kind: 'test',
            cmd: ['node', '-e', 'process.exit(0)'],
            required: true,
            profiles: ['merge'],
          },
        ],
      }),
      'utf8',
    );
    git(tmpRepo, ['add', 'ashlr.verify.json']);
    git(tmpRepo, ['commit', '-m', 'add verifier contract']);

    const proposal = makeProposal({ diff: addFileDiff('docs/profiled.md', 'doc') });
    const result = await verifyProposal(proposal, cfgWith());

    expect(result.ok).toBe(true);
  });

  it('refuses advisory-only merge evidence', async () => {
    initRepo(tmpRepo);
    fs.writeFileSync(
      path.join(tmpRepo, 'ashlr.verify.json'),
      JSON.stringify({
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          {
            id: 'advisory',
            kind: 'test',
            cmd: ['node', '-e', 'process.exit(0)'],
            required: false,
            profiles: ['merge'],
          },
        ],
      }),
      'utf8',
    );
    git(tmpRepo, ['add', 'ashlr.verify.json']);
    git(tmpRepo, ['commit', '-m', 'add advisory verifier']);

    const result = await verifyProposal(
      makeProposal({ diff: addFileDiff('docs/advisory.md', 'doc') }),
      cfgWith(),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/only advisory commands|required verification/i);
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

  it('H1b: diff touching a lockfile / .github/ / verifier contract is refused', async () => {
    initRepo(tmpRepo);
    const cfg = cfgWith({ autoMerge: { enabled: true, allowWithoutVerification: true } });
    for (const f of ['package-lock.json', '.github/workflows/ci.yml', 'Dockerfile', 'ashlr.verify.json']) {
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

    // M301: a successful autonomous merge leaves a durable evidence pack behind
    // so future learning/operator UX can inspect why the merge was allowed.
    const evidenceRaw = fs.readFileSync(evidencePath(p.id), 'utf8');
    expect(evidenceRaw).toContain('"tier": "T4"');
    expect(evidenceRaw).toContain('"action": "merge-main"');
    expect(evidenceRaw).not.toContain('diff --git');
    expect(evidenceRaw).not.toContain('+fresh doc');

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

  it('refuses when the default branch moved after the verified base was recorded', async () => {
    initRepo(tmpRepo, 'main');
    attachOriginWithHead(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const verifiedBaseHead = git(tmpRepo, ['rev-parse', 'main']);
    const staleDiff = addFileDiff('docs/stale-base.md', 'doc');
    const staleHash = hashDiff(staleDiff);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'docs update',
      summary: 'add a doc',
      diff: staleDiff,
      diffHash: staleHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', staleHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
      verifyResult: {
        passed: true,
        detail: 'verified before base advanced',
        baseBranch: 'main',
        baseHead: verifiedBaseHead,
        diffHash: staleHash,
      },
    });
    setStatus(p.id, 'pending');
    recordDecision({
      ts: new Date().toISOString(),
      proposalId: p.id,
      action: 'judged',
      engine: 'claude-opus-4-5',
      model: 'claude-opus-4-5',
      verdict: 'ship',
      detail: 'would-merge',
      judgeAttestation: signJudgeAttestation({
        proposalId: p.id,
        judgeEngine: 'claude-opus-4-5',
        verdict: 'ship',
        diffHash: staleHash,
      }),
    });

    git(tmpRepo, ['checkout', '-b', 'advance-main', 'main']);
    fs.writeFileSync(path.join(tmpRepo, 'base.txt'), 'new base\n', 'utf8');
    git(tmpRepo, ['add', 'base.txt']);
    git(tmpRepo, ['commit', '-m', 'advance main']);
    const movedMain = git(tmpRepo, ['rev-parse', 'advance-main']);
    git(tmpRepo, ['checkout', 'work']);
    git(tmpRepo, ['branch', '-f', 'main', movedMain]);

    const r = await autoMergeProposal(
      p.id,
      cfgWith({
        autoMerge: {
          enabled: true,
          trustBasis: 'verification',
          maxRisk: 'low',
          allowWithoutVerification: true,
        },
        mergeAuthority: [],
      }),
    );

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/moved since verification|reverify/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(movedMain);
    expect(listBranches(tmpRepo).some((b) => b.startsWith('ashlr/merge/'))).toBe(false);
    expect(loadProposal(p.id)).toMatchObject({
      status: 'pending',
      verifyResult: {
        passed: true,
        baseBranch: 'main',
        baseHead: verifiedBaseHead,
        diffHash: staleHash,
      },
    });
  });
});

describe('M47 remote merge safety', () => {
  it('does not delegate deferred merge or privileged bypass authority to GitHub', () => {
    const source = fs.readFileSync(path.resolve('src/core/inbox/merge.ts'), 'utf8');
    expect(source).not.toContain('--admin');
    expect(source).not.toContain("'--auto'");
    expect(source).toContain('host auto-merge is disabled until durable revocation is available');
  });

  it('evidence mode refuses local main-merge fallback before mutation', () => {
    const diff = addFileDiff('docs/evidence-local.md', 'doc');
    const diffHash = hashDiff(diff);
    const p = makeProposal({
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
      verifyResult: {
        passed: true,
        detail: 'command-bound verification',
        ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
        baseBranch: 'main',
        baseHead: '0123456789abcdef0123456789abcdef01234567',
        diffHash,
      },
    });

    const r = evaluateEvidenceAutoMergePreflight(
      p,
      cfgWith({
        mergeAuthority: [],
        autoMerge: {
          enabled: true,
          trustBasis: 'evidence',
          maxRisk: 'low',
          allowWithoutVerification: false,
          pushToRemote: false,
          protectedRemote: {
            branchProtection: true,
            requiredChecks: ['ci/test'],
          },
        },
      }),
      { remoteAvailable: true },
    );

    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/pushToRemote=true is required|local merge fallback/);
  });
});

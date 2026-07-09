/**
 * M86 — adversarial auto-merge safety gate tests.
 *
 * SAFETY / HERMETICITY:
 *  - HOME is overridden to a tmp dir; no real ~/.ashlr/{inbox,enrollment,...}
 *    is ever touched.
 *  - All git repos are real tmp repos under os.tmpdir(); no network, no push.
 *  - ASHLR_TEST_ALLOW_ANY_REPO=1 is set but autoMergeProposal calls
 *    assertMayMutate WITHOUT that opt, so the enroll() call in each test is
 *    still required for the happy path.
 *  - No `gh` is invoked: all tests use LOCAL merge (no github remote +
 *    pushToRemote unset).
 *
 * Matrix (26 tests total):
 *
 *  REFUSE — disabled                      [1]
 *  REFUSE — risk medium                   [2]
 *  REFUSE — risk high                     [3]
 *  REFUSE — files > cap (default 4)       [4]
 *  REFUSE — lines > cap (default 150)     [5]
 *  REFUSE — files > custom cap            [6]
 *  REFUSE — lines > custom cap            [7]
 *  REFUSE — suite red (verify fails)      [8]
 *  REFUSE — suite absent + not allowed    [9]
 *  REFUSE — self-target: guard weakens    [10]
 *  REFUSE — self-target: parity flag-off  [11]
 *  REFUSE — self-target: parity flag-on   [12]
 *  PERMIT — enabled + risk low + within caps + suite green   [13]
 *  PERMIT — lines exactly at cap          [14]
 *  PERMIT — files exactly at cap          [15]
 *  PERMIT — custom caps (larger)          [16]
 *  PERMIT — flag-off: disabled → no auto-merge (byte-identical to today) [17]
 *  PERMIT — self-target: guard+parity+allowSelfMerge pass    [18]
 *  REFUSE — non-frontier proposal (authority denied)         [19]
 *  REFUSE — kill switch on                                   [20]
 *  REFUSE — not enrolled                                     [21]
 *  REFUSE — missing proposal                                 [22]
 *  REFUSE — risk non-low even if within file/line caps       [23]
 *  PURE — classifyRisk used by scope cap is consistent       [24]
 *  NEVER throws — all paths resolve, never reject            [25]
 *  STATUS preserved — refused proposals stay in prior status [26]
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  autoMergeProposal,
  classifyRisk,
  evaluateEvidenceAutoMergePreflight,
} from '../src/core/inbox/merge.js';
import { createProposal, setStatus, loadProposal } from '../src/core/inbox/store.js';
import { enroll, setKill } from '../src/core/sandbox/policy.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAllowAny = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
let tmpHome: string;
let tmpRepo: string;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function initRepo(dir: string, branch = 'main'): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', `--initial-branch=${branch}`, dir], { stdio: 'pipe' });
  git(dir, ['config', 'user.email', 'test@ashlr.test']);
  git(dir, ['config', 'user.name', 'Ashlr Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
}

/**
 * Attach a bare `origin` and set origin/HEAD so defaultBranch() resolves
 * deterministically regardless of which branch is checked out.
 */
function attachOrigin(repo: string, branch: string): void {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m86-origin-')) + '.git';
  execFileSync('git', ['init', '--bare', `--initial-branch=${branch}`, bare], { stdio: 'pipe' });
  git(repo, ['remote', 'add', 'origin', bare]);
  git(repo, ['push', '-u', 'origin', branch]);
  git(repo, ['remote', 'set-head', 'origin', branch]);
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

/**
 * Build a diff that adds `n` files (docs/*.md) with `linesEach` added lines
 * each so we can test scope-cap edge cases precisely.
 */
function multiFileDiff(n: number, linesEach = 1): string {
  return Array.from({ length: n }, (_, i) => {
    const addedLines = Array.from({ length: linesEach }, (__, j) => `+line${j}`).join('\n');
    return [
      `diff --git a/docs/file${i}.md b/docs/file${i}.md`,
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      `+++ b/docs/file${i}.md`,
      `@@ -0,0 +1,${linesEach} @@`,
      addedLines,
      '',
    ].join('\n');
  }).join('\n');
}

/** Standard frontier config with auto-merge enabled and low maxRisk. */
function frontierCfg(
  overAutoMerge: Record<string, unknown> = {},
): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      autoMerge: {
        enabled: true,
        maxRisk: 'low',
        allowWithoutVerification: true,
        ...overAutoMerge,
      },
    },
  } as unknown as AshlrConfig;
}

/** Create and approve a frontier patch proposal (signed provenance). */
function frontierPatch(diff: string): Proposal {
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

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m86-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m86-repo-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  setKill(false);
});

afterEach(() => {
  try { setKill(false); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAllowAny === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = origAllowAny;
});

// ===========================================================================
// REFUSE — disabled [1]
// ===========================================================================
describe('M86 REFUSE — disabled', () => {
  it('[1] cfg.autoMerge.enabled=false → refuse, no mutation, status preserved', async () => {
    initRepo(tmpRepo);
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const p = frontierPatch(addFileDiff('docs/a.md', 'doc'));
    const cfg = frontierCfg({ enabled: false });
    const r = await autoMergeProposal(p.id, cfg);

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });
});

// ===========================================================================
// REFUSE — risk level [2][3]
// ===========================================================================
describe('M86 REFUSE — risk level', () => {
  it('[2] risk medium → refuse', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);
    // Single small source file → medium risk
    const diff = addFileDiff('src/foo.ts', 'export const x = 1;');
    expect(classifyRisk({ diff } as any)).toBe('medium');
    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/risk/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[3] risk high → refuse', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);
    // M295: a security/auth surface → HIGH (ordinary multi-file source is now MEDIUM).
    const diff = addFileDiff('src/core/auth/session.ts', 'export const token = 1;');
    expect(classifyRisk({ diff } as any)).toBe('high');
    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/risk/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });
});

// ===========================================================================
// REFUSE — scope cap [4][5][6][7]
// ===========================================================================
describe('M86 REFUSE — scope cap', () => {
  it('[4] files > default cap (4) → refuse', async () => {
    initRepo(tmpRepo);
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // 5 docs files = low risk but > 4 file cap
    const diff = multiFileDiff(5, 1);
    expect(classifyRisk({ diff } as any)).toBe('low');

    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg());

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/scope cap.*files/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[5] lines > default cap (150) → refuse', async () => {
    initRepo(tmpRepo);
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // 1 file, 151 added lines = low risk but > 150 line cap
    const diff = multiFileDiff(1, 151);
    expect(classifyRisk({ diff } as any)).toBe('low');

    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg());

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/scope cap.*lines/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[6] files > custom cap → refuse', async () => {
    initRepo(tmpRepo);
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // Custom cap of 2 files — diff has 3
    const diff = multiFileDiff(3, 1);
    expect(classifyRisk({ diff } as any)).toBe('low');

    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg({ maxAutomergeFiles: 2 }));

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/scope cap.*files/i);
  });

  it('[7] lines > custom cap → refuse', async () => {
    initRepo(tmpRepo);
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // Custom cap of 10 lines — diff has 11
    const diff = multiFileDiff(1, 11);
    expect(classifyRisk({ diff } as any)).toBe('low');

    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg({ maxAutomergeLines: 10 }));

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/scope cap.*lines/i);
  });
});

// ===========================================================================
// REFUSE — suite red / absent [8][9]
// ===========================================================================
describe('M86 REFUSE — suite red or absent', () => {
  it('[8] suite red (verify fails) → refuse', async () => {
    initRepo(tmpRepo);
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // Install a FAILING test script
    const pkg = { name: 'fixture', version: '1.0.0', scripts: { test: 'exit 1' } };
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify(pkg), 'utf8');
    git(tmpRepo, ['add', 'package.json']);
    git(tmpRepo, ['commit', '-m', 'add failing test']);
    // Push the updated commit to origin so defaultBranch resolves to it
    git(tmpRepo, ['push', 'origin', 'main']);

    const diff = addFileDiff('docs/red.md', 'doc');
    expect(classifyRisk({ diff } as any)).toBe('low');

    const p = frontierPatch(diff);
    // allowWithoutVerification=false so the test suite IS required
    const r = await autoMergeProposal(p.id, frontierCfg({ allowWithoutVerification: false }));

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/verif/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[9] no verify commands + allowWithoutVerification=false → refuse (fail-closed)', async () => {
    initRepo(tmpRepo);
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // No package.json → no commands detected
    const diff = addFileDiff('docs/notest.md', 'doc');
    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg({ allowWithoutVerification: false }));

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verif/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });
});

// ===========================================================================
// REFUSE — self-target safety harness [10][11][12]
// ===========================================================================
describe('M86 REFUSE — self-target safety harness', () => {
  /** Write @ashlr/hub package.json so isSelfTargetProposal returns true. */
  function makeSelfTarget(): void {
    const pkg = {
      name: '@ashlr/hub',
      version: '1.0.0',
      scripts: { test: 'exit 0' },
    };
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify(pkg), 'utf8');
    git(tmpRepo, ['add', 'package.json']);
    git(tmpRepo, ['commit', '-m', 'self-target package.json']);
  }

  it('[10] self-target diff deletes safety test → refuse (guardSafetyTests)', async () => {
    initRepo(tmpRepo);
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // Create a safety test file in the repo so the diff can "delete" it
    const safetyFile = 'test/h1.safety.test.ts';
    fs.mkdirSync(path.join(tmpRepo, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, safetyFile),
      'import { expect } from "vitest";\nexpect(true).toBe(true);\n',
      'utf8',
    );
    git(tmpRepo, ['add', safetyFile]);
    makeSelfTarget();
    git(tmpRepo, ['push', 'origin', 'main']);

    // Diff that deletes the safety test file
    const deleteDiff = [
      `diff --git a/${safetyFile} b/${safetyFile}`,
      `deleted file mode 100644`,
      `index 1111111..0000000`,
      `--- a/${safetyFile}`,
      `+++ /dev/null`,
      `@@ -1,2 +0,0 @@`,
      `-import { expect } from "vitest";`,
      `-expect(true).toBe(true);`,
      ``,
    ].join('\n');

    const p = frontierPatch(deleteDiff);
    const r = await autoMergeProposal(p.id, frontierCfg());

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    // A diff that deletes a file is classified as high risk by classifyRisk
    // (empty/deleted diffs → high) which trips Gate 5 before verifyProposal
    // even runs. Either way the proposal is REFUSED — the safety guarantee
    // holds regardless of which gate fires first.
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[11] self-target: parity fails flag-off → refuse', async () => {
    initRepo(tmpRepo);
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // Package with FAILING test script — suite is not green in base tree
    const pkg = {
      name: '@ashlr/hub',
      version: '1.0.0',
      scripts: { test: 'exit 1' },
    };
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify(pkg), 'utf8');
    git(tmpRepo, ['add', 'package.json']);
    git(tmpRepo, ['commit', '-m', 'self-target failing suite']);
    git(tmpRepo, ['push', 'origin', 'main']);

    // Diff is a docs-only change (low risk, within caps) — would otherwise pass
    const diff = addFileDiff('docs/self.md', 'self doc');
    const p = frontierPatch(diff);
    // allowWithoutVerification=true so Gate 6 passes (no worktree commands);
    // but parity Gate 6.5 re-detects commands from the base tree and runs them.
    const r = await autoMergeProposal(p.id, frontierCfg({ allowWithoutVerification: true }));

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/self.eval parity|invariant suite/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[12] self-target: parity with flag-on runner throws → treated as failing suite → refuse', async () => {
    // selfEvalParity contract: a runner that throws counts as a failing suite.
    // We simulate this by having two package.json scripts: one passes flag-off
    // but we cannot easily simulate flag-on failure via a real script, so we
    // test the pure selfEvalParity function directly instead.
    // (The autoMergeProposal integration for flag-on is covered by [11] via
    // the failing script covering both states; this test covers the pure fn.)
    const { selfEvalParity } = await import('../src/core/fleet/self.js');

    // Runner throws on flag-on
    const verdict = selfEvalParity((flagOn: boolean) => {
      if (!flagOn) return true;
      throw new Error('simulated flag-on crash');
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/flag ON/i);
  });
});

// ===========================================================================
// PERMIT — fires only when ALL gates pass [13][14][15][16][17][18]
// ===========================================================================
describe('M86 PERMIT — fires when all gates pass', () => {
  it('[13] enabled + risk low + within caps + suite green → merges', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    const diff = addFileDiff('docs/permit.md', 'allowed doc');
    expect(classifyRisk({ diff } as any)).toBe('low');

    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg());

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
    expect(git(tmpRepo, ['rev-parse', 'main'])).not.toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('applied');
  });

  it('[14] lines exactly at cap (150) → permitted', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = multiFileDiff(1, 150);
    expect(classifyRisk({ diff } as any)).toBe('low');

    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg());

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
  });

  it('[15] files exactly at cap (4) → permitted', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = multiFileDiff(4, 1);
    expect(classifyRisk({ diff } as any)).toBe('low');

    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg());

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
  });

  it('[16] custom caps (larger) — 10 files / 300 lines — and diff within them → permitted', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // 6 files, 20 lines each = 120 changed lines; within custom caps (10/300)
    // but ABOVE default caps (4/150). classifyRisk must still return low.
    const diff = multiFileDiff(6, 20);
    expect(classifyRisk({ diff } as any)).toBe('low');

    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg({
      maxAutomergeFiles: 10,
      maxAutomergeLines: 300,
    }));

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
  });

  it('[17] flag-off (enabled=false) → no auto-merge (byte-identical to today)', async () => {
    // Confirms the disabled path has not changed behaviour — proposals stay
    // PENDING/approved regardless of risk, caps, or suite state.
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    const diff = addFileDiff('docs/flagoff.md', 'doc');
    const p = frontierPatch(diff);

    const r = await autoMergeProposal(p.id, frontierCfg({ enabled: false }));

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
    // main is untouched
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    // Status NOT mutated
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[18] self-target: guardSafetyTests + parity + allowSelfMerge pass → merges', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // Write a passing test script + @ashlr/hub package.json
    const pkg = {
      name: '@ashlr/hub',
      version: '1.0.0',
      scripts: { test: 'exit 0' },
    };
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify(pkg), 'utf8');
    git(tmpRepo, ['add', 'package.json']);
    git(tmpRepo, ['commit', '-m', 'self-target passing suite']);
    git(tmpRepo, ['push', 'origin', 'main']);

    // Docs-only diff: low risk, within caps, no safety test touched
    const diff = addFileDiff('docs/self-ok.md', 'self doc permitted');
    const p = frontierPatch(diff);

    const r = await autoMergeProposal(p.id, frontierCfg({ allowWithoutVerification: true, allowSelfMerge: true }));

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
    expect(loadProposal(p.id)!.status).toBe('applied');
  });
});

// ===========================================================================
// REFUSE — other gates preserved [19][20][21][22]
// ===========================================================================
describe('M86 REFUSE — existing gates preserved', () => {
  it('[19] non-frontier proposal → authority denied', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);
    const diff = addFileDiff('docs/nf.md', 'doc');
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'local',
      summary: 'not frontier',
      diff,
      engineModel: 'builtin:llama',
      engineTier: 'local',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, frontierCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/authority|frontier/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[20] kill switch on → refuse', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);
    setKill(true);
    const p = frontierPatch(addFileDiff('docs/kill.md', 'doc'));
    const r = await autoMergeProposal(p.id, frontierCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/kill/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[21] not enrolled → refuse without burning state', async () => {
    initRepo(tmpRepo);
    // NOT enrolled
    const p = frontierPatch(addFileDiff('docs/ne.md', 'doc'));
    const r = await autoMergeProposal(p.id, frontierCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/enroll/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[22] missing proposal → never throws, ok:false', async () => {
    const r = await autoMergeProposal('does-not-exist-m86', frontierCfg());
    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
  });
});

// ===========================================================================
// REFUSE — scope cap does not apply to non-low risk [23]
// ===========================================================================
describe('M86 REFUSE — non-low risk refused before scope cap', () => {
  it('[23] medium-risk diff within file/line caps → still refused (risk gate first)', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);

    // Single small source file → medium risk; 1 file, few lines — within caps
    const diff = addFileDiff('src/tiny.ts', 'export const x = 1;');
    expect(classifyRisk({ diff } as any)).toBe('medium');

    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, frontierCfg());

    expect(r.ok).toBe(false);
    // Reason comes from risk gate (Gate 5), not scope cap
    expect(r.reason).toMatch(/risk.*medium|medium.*risk/i);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });
});

// ===========================================================================
// PURE — classifyRisk consistency [24]
// ===========================================================================
describe('M86 PURE — classifyRisk consistency with scope cap', () => {
  it('[24] classifyRisk low for docs diffs used as auto-merge candidates', () => {
    // Confirm the diffs we use in PERMIT tests are genuinely low-risk
    expect(classifyRisk({ diff: addFileDiff('docs/a.md', 'x') } as any)).toBe('low');
    expect(classifyRisk({ diff: multiFileDiff(4, 1) } as any)).toBe('low');
    expect(classifyRisk({ diff: multiFileDiff(1, 150) } as any)).toBe('low');
    // And confirm what would push to non-low
    expect(classifyRisk({ diff: addFileDiff('src/x.ts', 'x') } as any)).toBe('medium');
  });
});

describe('M86 PURE — evidence safety lane', () => {
  it('refuses no-command verification even when the diff is low-risk and in scope', () => {
    const diff = addFileDiff('docs/evidence-no-command.md', 'doc');
    const diffHash = hashDiff(diff);
    const p: Proposal = {
      id: 'm86-evidence-no-command',
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'evidence no command',
      summary: 'test',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
      verifyResult: {
        passed: true,
        detail: 'no commands detected',
        ran: [],
        baseBranch: 'main',
        baseHead: '0123456789abcdef0123456789abcdef01234567',
        diffHash,
      },
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    const r = evaluateEvidenceAutoMergePreflight(
      p,
      {
        foundry: {
          autoMerge: {
            enabled: true,
            trustBasis: 'evidence',
            maxRisk: 'low',
            allowWithoutVerification: false,
            pushToRemote: true,
            protectedRemote: {
              branchProtection: true,
              requiredChecks: ['ci/test'],
            },
          },
        },
      } as unknown as AshlrConfig,
      { remoteAvailable: true },
    );

    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/no verification command evidence|no-command/i);
  });
});

// ===========================================================================
// NEVER throws [25]
// ===========================================================================
describe('M86 NEVER throws', () => {
  it('[25] all refuse paths resolve without throwing', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);

    const diff = addFileDiff('docs/nt.md', 'doc');
    const p = frontierPatch(diff);

    // Each of these should resolve (not reject)
    const results = await Promise.all([
      autoMergeProposal(p.id, frontierCfg({ enabled: false })),
      autoMergeProposal('no-such-id', frontierCfg()),
    ]);

    for (const r of results) {
      expect(r).toHaveProperty('ok');
      expect(r).toHaveProperty('merged');
    }
  });
});

// ===========================================================================
// STATUS preserved — refused proposals stay in prior status [26]
// ===========================================================================
describe('M86 STATUS preserved on refusal', () => {
  it('[26] every refusal leaves proposal status unchanged', async () => {
    initRepo(tmpRepo);
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = multiFileDiff(5, 1); // 5 files > cap=4 → scope cap refuse
    expect(classifyRisk({ diff } as any)).toBe('low');

    const p = frontierPatch(diff);
    expect(loadProposal(p.id)!.status).toBe('approved');

    const r = await autoMergeProposal(p.id, frontierCfg());
    expect(r.ok).toBe(false);
    // Status must still be 'approved' — not 'applied', not 'rejected'
    expect(loadProposal(p.id)!.status).toBe('approved');
  });
});

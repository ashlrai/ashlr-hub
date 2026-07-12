/**
 * m189.regression-sentinel.test.ts — autonomous regression sentinel (rollback reflex).
 *
 * WHAT IS TESTED
 *  - detectRegression fires ONLY on a SUSTAINED anomaly (≥ minConsecutive RED),
 *    not on a single flake; clears + records a green marker on GREEN; honors an
 *    explicit pluggable fail-signal source; never throws.
 *  - bisectAndRevert identifies the culprit among `ashlr: auto-merge` commits
 *    (oldest RED auto-merge = first bad), produces a SIGNED revert PROPOSAL via
 *    createProposal (kind 'patch') WITHOUT applying/merging it, restores HEAD,
 *    and reports a reason (no proposal) when there is no culprit.
 *  - Flag OFF → no-op for both entry points.
 *  - Never throws on git/suite failures.
 *
 * SAFETY / HERMETICITY
 *  - HOME overridden to a tmp dir — no real ~/.ashlr state touched.
 *  - verify-commands MOCKED (defaultRunSuite path); inbox/store.createProposal
 *    MOCKED so NO real proposal is written and we can assert proposal-only.
 *  - git + runSuite are INJECTED via opts — no real git, no real processes, no
 *    real repo mutated. provenance.ts runs for real but writes its key under the
 *    tmp HOME (HMAC is deterministic for the test's assertions).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation — set before any module resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports (vi.mock hoisting)
// ---------------------------------------------------------------------------

const mockDetectVerifyCommands = vi.fn();
const mockRunVerifyCommand = vi.fn();
vi.mock('../src/core/run/verify-commands.js', () => ({
  detectVerifyCommands: (...args: unknown[]) => mockDetectVerifyCommands(...args),
  runVerifyCommand: (...args: unknown[]) => mockRunVerifyCommand(...args),
  runVerifyCommandAsync: async (...args: unknown[]) => mockRunVerifyCommand(...args),
}));

// createProposal is mocked so NO real inbox proposal is persisted and we can
// assert the sentinel only PROPOSES (never applies). The mock echoes a
// pending proposal mirroring the real store contract.
const mockCreateProposal = vi.fn(
  (p: Record<string, unknown>): Proposal =>
    ({
      ...p,
      id: 'prop-test-001',
      status: 'pending',
      createdAt: new Date().toISOString(),
    }) as unknown as Proposal,
);
vi.mock('../src/core/inbox/store.js', () => ({
  createProposal: (...args: unknown[]) => mockCreateProposal(...(args as [Record<string, unknown>])),
}));

// ---------------------------------------------------------------------------
// Lazy imports (after mocks)
// ---------------------------------------------------------------------------

const { detectRegression, bisectAndRevert } = await import(
  '../src/core/fleet/regression-sentinel.js'
);
const { verifyProvenance } = await import('../src/core/foundry/provenance.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = '/tmp/sentinel-repo';

function onCfg(overrides?: Record<string, unknown>): Pick<AshlrConfig, 'foundry'> {
  return { foundry: { regressionSentinel: { ...overrides } } as unknown as AshlrConfig['foundry'] };
}
const OFF_CFG: Pick<AshlrConfig, 'foundry'> = { foundry: {} as AshlrConfig['foundry'] };

const RED: { red: true; detail: string } = { red: true, detail: 'FAIL src/x.test.ts: expected 1 to equal 2' };
const GREEN: { red: false } = { red: false };
const PROOF_MANIFEST = 'a'.repeat(64);
const PROVEN_RED: SuiteRun = {
  ...RED,
  conclusive: true,
  manifestDigest: PROOF_MANIFEST,
  requiredCommandCount: 1,
};
const PROVEN_GREEN: SuiteRun = {
  ...GREEN,
  conclusive: true,
  manifestDigest: PROOF_MANIFEST,
  requiredCommandCount: 1,
};

/** A fake git runner driven by a routing table on the joined args string. */
function fakeGit(routes: (args: string[]) => string | null) {
  return vi.fn(routes);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'm189-'));
  process.env.HOME = tmpHome;
  vi.clearAllMocks();
});

afterEach(() => {
  process.env.HOME = origHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ===========================================================================
// detectRegression
// ===========================================================================

describe('detectRegression', () => {
  it('flag OFF → no-op (not regressed), never runs the suite', async () => {
    const runSuite = vi.fn(() => RED);
    const r = await detectRegression(OFF_CFG, REPO, { runSuite, git: fakeGit(() => 'HEADSHA') });
    expect(r.regressed).toBe(false);
    expect(runSuite).not.toHaveBeenCalled();
  });

  it('single RED is treated as a flake — does NOT fire (default minConsecutive=2)', async () => {
    const git = fakeGit(() => 'HEAD_A');
    const r = await detectRegression(onCfg(), REPO, { runSuite: () => RED, git });
    expect(r.regressed).toBe(false);
  });

  it('SUSTAINED RED (2 consecutive on same HEAD) fires regression', async () => {
    const git = fakeGit(() => 'HEAD_A');
    const first = await detectRegression(onCfg(), REPO, { runSuite: () => RED, git });
    expect(first.regressed).toBe(false); // streak=1
    const second = await detectRegression(onCfg(), REPO, { runSuite: () => RED, git });
    expect(second.regressed).toBe(true); // streak=2 → fires
    expect(second.signal).toMatch(/consecutive/i);
    expect(second.signal).toMatch(/expected 1 to equal 2/);
  });

  it('GREEN resets the streak AND records a known-green marker', async () => {
    const git = fakeGit(() => 'HEAD_A');
    await detectRegression(onCfg(), REPO, { runSuite: () => RED, git });       // streak=1
    const green = await detectRegression(onCfg(), REPO, { runSuite: () => GREEN, git });
    expect(green.regressed).toBe(false);
    // After a reset, a single RED must NOT immediately re-fire.
    const afterReset = await detectRegression(onCfg(), REPO, { runSuite: () => RED, git });
    expect(afterReset.regressed).toBe(false); // streak back to 1

    // Green marker file was written under HOME.
    const dir = path.join(tmpHome, '.ashlr', 'foundry');
    const markers = fs.readdirSync(dir).filter((f) => f.startsWith('green-marker-'));
    expect(markers.length).toBe(1);
    const sha = JSON.parse(fs.readFileSync(path.join(dir, markers[0]!), 'utf8')).sha;
    expect(sha).toBe('HEAD_A');
  });

  it('a streak does NOT carry across a HEAD change (new HEAD restarts the count)', async () => {
    let head = 'HEAD_A';
    const git = fakeGit(() => head);
    await detectRegression(onCfg(), REPO, { runSuite: () => RED, git }); // A:1
    head = 'HEAD_B';
    const r = await detectRegression(onCfg(), REPO, { runSuite: () => RED, git });
    expect(r.regressed).toBe(false); // B:1, not 2
  });

  it('respects minConsecutive override (=1 → fires on first RED)', async () => {
    const git = fakeGit(() => 'HEAD_A');
    const r = await detectRegression(onCfg({ minConsecutive: 1 }), REPO, { runSuite: () => RED, git });
    expect(r.regressed).toBe(true);
  });

  it('normalizes fractional and oversized sentinel limits to bounded integers', async () => {
    const runSuite = vi.fn(async () => RED);
    const git = vi.fn((args: string[]) => {
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      return '';
    });

    const first = await detectRegression(onCfg({ minConsecutive: 1.9 }), REPO, { runSuite, git });
    const second = await detectRegression(onCfg({ minConsecutive: 1.9 }), REPO, { runSuite, git });
    expect(first.regressed).toBe(false);
    expect(second.regressed).toBe(true);

    const candidateGit = vi.fn((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'b'.repeat(40);
      if (args[0] === 'status') return '';
      if (args[0] === 'log') {
        expect(args).toContain('-n');
        expect(args[args.indexOf('-n') + 1]).toBe('20');
        return '';
      }
      return '';
    });
    await bisectAndRevert(onCfg({ maxCandidates: 1_000.75 }), REPO, { git: candidateGit });
  });

  it('pluggable explicit fail-signal fires immediately (sustained by the external monitor)', async () => {
    const r = await detectRegression(onCfg(), REPO, {
      runSuite: () => GREEN,
      git: fakeGit(() => 'HEAD_A'),
      failSignal: () => 'pager: error rate > 5% for 10m',
    });
    expect(r.regressed).toBe(true);
    expect(r.signal).toMatch(/external-signal/);
    expect(r.signal).toMatch(/error rate/);
  });

  it('uses the default verify-commands signal when no runSuite is injected', async () => {
    mockDetectVerifyCommands.mockReturnValue([{ kind: 'test', cmd: ['npx', 'vitest', 'run'] }]);
    mockRunVerifyCommand.mockReturnValue({
      ok: false,
      output: 'Error: boom',
      exitCode: 1,
      timedOut: false,
      command: 'x',
      failureCategory: 'code',
    });
    const git = fakeGit(() => 'HEAD_A');
    // minConsecutive=1 so one default-signal RED suffices to fire.
    const r = await detectRegression(onCfg({ minConsecutive: 1 }), REPO, { git });
    expect(r.regressed).toBe(true);
    expect(mockDetectVerifyCommands).toHaveBeenCalledWith(REPO, 'merge');
    expect(mockRunVerifyCommand).toHaveBeenCalled();
  });

  it('ignores advisory failures in the default merge-profile signal', async () => {
    mockDetectVerifyCommands.mockReturnValue([
      { kind: 'lint', cmd: ['npm', 'run', 'lint'], required: false },
      { kind: 'test', cmd: ['npm', 'test'], required: true },
    ]);
    mockRunVerifyCommand
      .mockReturnValueOnce({ ok: false, output: 'advisory', exitCode: 1, timedOut: false, command: 'lint' })
      .mockReturnValueOnce({ ok: true, output: '', exitCode: 0, timedOut: false, command: 'test' });

    const result = await detectRegression(onCfg({ minConsecutive: 1 }), REPO, {
      git: fakeGit(() => 'HEAD_A'),
    });

    expect(result.regressed).toBe(false);
    expect(mockRunVerifyCommand).toHaveBeenCalledTimes(2);
  });

  it('treats verifier infrastructure failure as inconclusive instead of RED', async () => {
    mockDetectVerifyCommands.mockReturnValue([{ kind: 'test', cmd: ['npm', 'test'], required: true }]);
    mockRunVerifyCommand.mockReturnValue({
      ok: false,
      output: 'spawn failed',
      exitCode: -1,
      timedOut: false,
      command: 'npm test',
      failureCategory: 'infra',
    });

    const result = await detectRegression(onCfg({ minConsecutive: 1 }), REPO, {
      git: fakeGit(() => 'HEAD_A'),
    });

    expect(result.regressed).toBe(false);
  });

  it('never throws when the suite runner throws', async () => {
    const git = fakeGit(() => 'HEAD_A');
    await expect(
      detectRegression(onCfg(), REPO, { runSuite: () => { throw new Error('spawn fail'); }, git }),
    ).resolves.toEqual({ regressed: false });
  });
});

// ===========================================================================
// bisectAndRevert
// ===========================================================================

describe('bisectAndRevert', () => {
  /**
   * Build a fake git for a 3-commit auto-merge history (newest→oldest: C2, C1, C0)
   * where C1 introduced the regression. Green marker = C0. The tree at C1 and C2
   * is RED; the tree at C0 is GREEN.
   */
  function bisectGit() {
    let head = 'HEAD_BAD';
    return fakeGit((args: string[]) => {
      const a = args.join(' ');
      if (a.startsWith('rev-parse HEAD')) return head;
      if (a === 'rev-parse C1^') return 'C0';
      if (a.startsWith('log') && a.includes('--grep=')) {
        // newest-first list of auto-merge commit shas
        return ['C2', 'C1', 'C0'].join('\n');
      }
      if (a.startsWith('log -1')) {
        // commit message for proposalId parsing
        const sha = args[args.length - 1];
        return `ashlr: auto-merge proposal prop-${sha}`;
      }
      if (a.startsWith('checkout')) {
        head = args[args.length - 1]!;
        return '';
      }
      if (a.startsWith('revert --no-commit')) return '';
      if (a.startsWith('diff --cached')) return '--- a/x.ts\n+++ b/x.ts\n@@\n-bad\n+good\n';
      if (a.startsWith('revert --abort')) return '';
      if (a.startsWith('reset --hard')) return '';
      return '';
    });
  }

  /** runSuite keyed off the git's current checkout: C0 green, C1/C2 red. */
  function bisectRunSuite(git: ReturnType<typeof fakeGit>) {
    return (_repo: string) => {
      const head = git(['rev-parse', 'HEAD']) ?? '';
      return head === 'C0' ? PROVEN_GREEN : PROVEN_RED;
    };
  }

  function withGreenMarker(sha: string) {
    const dir = path.join(tmpHome, '.ashlr', 'foundry');
    fs.mkdirSync(dir, { recursive: true });
    const crypto = require('node:crypto');
    const slug = crypto.createHash('sha1').update(REPO).digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(dir, `green-marker-${slug}.json`), JSON.stringify({ sha }));
  }

  it('flag OFF → no-op, returns a reason, never proposes', async () => {
    const r = await bisectAndRevert(OFF_CFG, REPO, { git: bisectGit(), runSuite: () => RED });
    expect(r.culprit).toBeUndefined();
    expect(r.revertProposal).toBeUndefined();
    expect(r.reason).toMatch(/disabled/i);
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('identifies the OLDEST RED auto-merge as the culprit (first bad)', async () => {
    withGreenMarker('C0');
    const git = bisectGit();
    const r = await bisectAndRevert(onCfg(), REPO, { git, runSuite: bisectRunSuite(git) });
    expect(r.culprit).toBe('C1'); // C0 green, C1 first RED
    expect(r.revertProposal?.culprit).toBe('C1');
    expect(r.revertProposal?.culpritProposalId).toBe('prop-C1');
    expect(r).toMatchObject({
      repo: REPO,
      observedHead: 'HEAD_BAD',
      baselineHead: 'C0',
      parentHead: 'C0',
      parentGreen: true,
      culpritRed: true,
      attributionConfidence: 'deterministic',
      candidateCount: 2,
      basis: 'bisect-first-bad',
    });
  });

  it('refuses proposal generation when restoring the original HEAD cannot be verified', async () => {
    withGreenMarker('C0');
    const base = bisectGit();
    let restoreAttempts = 0;
    const git: GitRunner = (args) => {
      if (args.join(' ') === 'checkout --quiet HEAD_BAD') {
        restoreAttempts++;
        return null;
      }
      return base(args);
    };

    const result = await bisectAndRevert(onCfg(), REPO, { git, runSuite: bisectRunSuite(base) });

    expect(result).toEqual({ reason: 'failed to restore original HEAD after regression proof' });
    expect(restoreAttempts).toBeGreaterThanOrEqual(2);
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('keeps attribution heuristic when the culprit direct parent is also RED', async () => {
    withGreenMarker('C0');
    const git = bisectGit();
    const r = await bisectAndRevert(onCfg(), REPO, { git, runSuite: () => PROVEN_RED });

    expect(r).toMatchObject({
      culprit: 'C1',
      parentHead: 'C0',
      parentGreen: false,
      culpritRed: true,
      attributionConfidence: 'heuristic',
    });
  });

  it('keeps attribution heuristic when the culprit direct parent cannot be resolved', async () => {
    withGreenMarker('C0');
    const git = bisectGit();
    const withoutParent: GitRunner = (args) => args.join(' ') === 'rev-parse C1^' ? null : git(args);
    const r = await bisectAndRevert(onCfg(), REPO, {
      git: withoutParent,
      runSuite: bisectRunSuite(git),
    });

    expect(r).toMatchObject({
      culprit: 'C1',
      parentGreen: false,
      culpritRed: true,
      attributionConfidence: 'heuristic',
    });
    expect(r.parentHead).toBeUndefined();
  });

  it('keeps attribution heuristic when suite results lack a conclusive verification manifest', async () => {
    withGreenMarker('C0');
    const git = bisectGit();
    const r = await bisectAndRevert(onCfg(), REPO, { git, runSuite: bisectRunSuite(git) });
    expect(r.attributionConfidence).toBe('deterministic');

    const inconclusiveGit = bisectGit();
    const inconclusive = await bisectAndRevert(onCfg(), REPO, {
      git: inconclusiveGit,
      runSuite: (repo) => {
        const head = inconclusiveGit(['rev-parse', 'HEAD']);
        return head === 'C0' ? GREEN : RED;
      },
    });
    expect(inconclusive).toMatchObject({
      culprit: 'C1',
      parentGreen: false,
      culpritRed: true,
      attributionConfidence: 'heuristic',
    });
  });

  it('keeps attribution heuristic when parent and culprit verification manifests differ', async () => {
    withGreenMarker('C0');
    const git = bisectGit();
    const r = await bisectAndRevert(onCfg(), REPO, {
      git,
      runSuite: () => {
        const head = git(['rev-parse', 'HEAD']);
        return head === 'C0'
          ? { ...PROVEN_GREEN, manifestDigest: 'b'.repeat(64) }
          : PROVEN_RED;
      },
    });

    expect(r).toMatchObject({
      culprit: 'C1',
      parentGreen: true,
      culpritRed: true,
      attributionConfidence: 'heuristic',
    });
  });

  it('refuses to checkout or reset a dirty worktree', async () => {
    const git = fakeGit((args) => {
      const command = args.join(' ');
      if (command === 'rev-parse HEAD') return 'HEAD_BAD';
      if (command === 'status --porcelain') return ' M src/user-work.ts';
      if (command.startsWith('checkout') || command.startsWith('reset')) {
        throw new Error('destructive command must not run');
      }
      return '';
    });

    const result = await bisectAndRevert(onCfg(), REPO, { git, runSuite: () => RED });

    expect(result).toEqual({ reason: 'worktree is dirty; refusing autonomous bisect checkout' });
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('produces a SIGNED revert proposal (proposal-only, NOT applied)', async () => {
    withGreenMarker('C0');
    const git = bisectGit();
    const r = await bisectAndRevert(onCfg(), REPO, { git, runSuite: bisectRunSuite(git) });

    // createProposal was called exactly once with a patch-kind revert.
    expect(mockCreateProposal).toHaveBeenCalledTimes(1);
    const arg = mockCreateProposal.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg['kind']).toBe('patch');
    expect(arg['repo']).toBe(REPO);
    expect(String(arg['title'])).toMatch(/Revert/i);
    expect(String(arg['diff'])).toMatch(/\+good/);

    // The proposal is pending — never applied/merged by the sentinel.
    expect(r.revertProposal?.proposal.status).toBe('pending');

    // It is SIGNED — provenance verifies against the captured diff.
    const verdict = verifyProvenance({
      engineModel: arg['engineModel'] as string,
      engineTier: arg['engineTier'] as string,
      diff: arg['diff'] as string,
      diffHash: arg['diffHash'] as string,
      provenanceSig: arg['provenanceSig'] as string,
    });
    expect(verdict.ok).toBe(true);
  });

  it('restores HEAD after bisecting (working tree left as found)', async () => {
    withGreenMarker('C0');
    const git = bisectGit();
    await bisectAndRevert(onCfg(), REPO, { git, runSuite: bisectRunSuite(git) });
    // After the run, a final rev-parse must report the original HEAD.
    expect(git(['rev-parse', 'HEAD'])).toBe('HEAD_BAD');
  });

  it('no auto-merge commits → reason, no proposal', async () => {
    const git = fakeGit((args) => {
      const a = args.join(' ');
      if (a.startsWith('rev-parse HEAD')) return 'HEAD_BAD';
      if (a.startsWith('log') && a.includes('--grep=')) return ''; // none
      return '';
    });
    const r = await bisectAndRevert(onCfg(), REPO, { git, runSuite: () => RED });
    expect(r.culprit).toBeUndefined();
    expect(r.revertProposal).toBeUndefined();
    expect(r.reason).toMatch(/no recent auto-merge/i);
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('all auto-merge commits green → no culprit, no proposal', async () => {
    withGreenMarker('C0');
    const git = bisectGit();
    const r = await bisectAndRevert(onCfg(), REPO, { git, runSuite: () => GREEN });
    expect(r.culprit).toBeUndefined();
    expect(r.reason).toMatch(/no RED auto-merge/i);
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('never throws when git cannot resolve HEAD', async () => {
    const git = fakeGit(() => null);
    await expect(bisectAndRevert(onCfg(), REPO, { git, runSuite: () => RED })).resolves.toMatchObject({
      reason: expect.stringMatching(/HEAD/),
    });
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it('never throws when the suite runner throws mid-bisect', async () => {
    withGreenMarker('C0');
    const git = bisectGit();
    await expect(
      bisectAndRevert(onCfg(), REPO, { git, runSuite: () => { throw new Error('boom'); } }),
    ).resolves.toBeDefined();
  });
});

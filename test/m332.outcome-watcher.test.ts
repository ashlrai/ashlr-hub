/**
 * m332.outcome-watcher.test.ts — M332 (completes M141): real-world outcome
 * detection + judge-signal enrichment.
 *
 * outcome-watcher (REAL git fixtures):
 *  - a `git revert` of the auto-merge commit → linkOutcome('reverted');
 *  - a near-term fix commit touching the same file → linkOutcome('followed-up');
 *  - unrelated later commits → no link;
 *  - throttle: second scan within 6h is a no-op; force bypasses.
 *
 * Consumers:
 *  - outcomeToIntent maps 'followed-up' → 'review' in BOTH calibration paths;
 *  - buildProducerScores pass 3: a reverted outcome drags the producer's
 *    learned ship-rate down.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let traces: Record<string, unknown>[] = [];
const linked: Array<[string, string]> = [];
let proposalRepo = '';

vi.mock('../src/core/fleet/judge-trace.js', () => ({
  readJudgeTraces: vi.fn(() => traces),
  linkOutcome: vi.fn((id: string, outcome: string) => {
    linked.push([id, outcome]);
  }),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  loadProposal: vi.fn(() => (proposalRepo ? { repo: proposalRepo } : null)),
}));

let ledger: Record<string, unknown>[] = [];
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn(() => ledger),
  recordDecision: vi.fn(() => {}),
}));

import { scanRealWorldOutcomes } from '../src/core/fleet/outcome-watcher.js';
import { outcomeToIntent } from '../src/core/fleet/judge-calibration.js';
import { buildProducerScores } from '../src/core/run/learned-router.js';
import { readJudgeTraces } from '../src/core/fleet/judge-trace.js';

// ---------------------------------------------------------------------------
// Git fixture helpers
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'm332',
  GIT_AUTHOR_EMAIL: 'm332@test',
  GIT_COMMITTER_NAME: 'm332',
  GIT_COMMITTER_EMAIL: 'm332@test',
};

function g(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: GIT_ENV,
  });
}

const dirs: string[] = [];

/** Repo with an initial commit + an auto-merge commit for `pid` touching file.ts. */
function repoWithMerge(pid: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-m332-'));
  dirs.push(dir);
  execFileSync('git', ['init', '--quiet', dir], { stdio: 'pipe' });
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', 'init']);
  writeFileSync(join(dir, 'file.ts'), 'merged change\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '--quiet', '-m', `ashlr: auto-merge proposal ${pid}`]);
  return dir;
}

function mergedTrace(pid: string): Record<string, unknown> {
  return {
    proposalId: pid,
    judgeEngine: 'claude-fable-5',
    verdict: 'ship',
    scores: { value: 4, correctness: 4, scope: 4, alignment: 4 },
    fullReasoning: '',
    promptContext: '',
    ts: new Date().toISOString(),
    outcome: 'merged',
  };
}

const cfg = { version: 1, foundry: {} } as unknown as AshlrConfig;
let stateFile = '';

beforeEach(() => {
  traces = [];
  ledger = [];
  linked.length = 0;
  proposalRepo = '';
  const stateDir = mkdtempSync(join(tmpdir(), 'ashlr-m332-state-'));
  dirs.push(stateDir);
  stateFile = join(stateDir, 'watch.json');
});

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  dirs.length = 0;
});

// ---------------------------------------------------------------------------
// outcome-watcher
// ---------------------------------------------------------------------------

describe('M332 scanRealWorldOutcomes', () => {
  it('detects a git revert of the auto-merge commit', async () => {
    proposalRepo = repoWithMerge('p-rev');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['revert', '--no-edit', mergeSha]);
    traces = [mergedTrace('p-rev')];

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.reverts).toBe(1);
    expect(linked).toContainEqual(['p-rev', 'reverted']);
  }, 30_000);

  it('detects a near-term fix commit touching the same file', async () => {
    proposalRepo = repoWithMerge('p-fix');
    writeFileSync(join(proposalRepo, 'file.ts'), 'fixed change\n');
    g(proposalRepo, ['add', '-A']);
    g(proposalRepo, ['commit', '--quiet', '-m', 'fix: repair the merged change']);
    traces = [mergedTrace('p-fix')];

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.followUps).toBe(1);
    expect(linked).toContainEqual(['p-fix', 'followed-up']);
  }, 30_000);

  it('unrelated later commits produce NO link (no false positives)', async () => {
    proposalRepo = repoWithMerge('p-clean');
    writeFileSync(join(proposalRepo, 'other.txt'), 'unrelated\n');
    g(proposalRepo, ['add', '-A']);
    g(proposalRepo, ['commit', '--quiet', '-m', 'fix: something in another file']);
    writeFileSync(join(proposalRepo, 'file.ts'), 'feature work\n');
    g(proposalRepo, ['add', '-A']);
    g(proposalRepo, ['commit', '--quiet', '-m', 'feat: unrelated feature on same file']);
    traces = [mergedTrace('p-clean')];

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.reverts).toBe(0);
    expect(scan.followUps).toBe(0);
    expect(linked.length).toBe(0);
  }, 30_000);

  it('throttles a second scan; force bypasses', async () => {
    proposalRepo = repoWithMerge('p-thr');
    traces = [mergedTrace('p-thr')];

    const first = await scanRealWorldOutcomes(cfg, { stateFile });
    expect(first.throttled).toBe(false);
    const second = await scanRealWorldOutcomes(cfg, { stateFile });
    expect(second.throttled).toBe(true);
    expect(second.scanned).toBe(0);
    const forced = await scanRealWorldOutcomes(cfg, { stateFile, force: true });
    expect(forced.throttled).toBe(false);
    expect(forced.scanned).toBe(1);
  }, 30_000);

  it('missing repo → skipped, never throws', async () => {
    proposalRepo = '';
    traces = [mergedTrace('p-ghost')];
    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.skipped).toBe(1);
    expect(linked.length).toBe(0);
  });

  it('M337: already-linked proposals are skipped — no duplicate patch records', async () => {
    proposalRepo = repoWithMerge('p-dup');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['revert', '--no-edit', mergeSha]);
    // The trace stream contains BOTH the stale 'merged' original (a prior-day
    // file linkOutcome could not rewrite) AND the appended 'reverted' patch
    // record — the scan must treat the proposal as already linked.
    traces = [mergedTrace('p-dup'), { ...mergedTrace('p-dup'), outcome: 'reverted' }];
    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.scanned).toBe(0);
    expect(linked.length).toBe(0);
  }, 30_000);

  it('M338: a followed-up proposal is UPGRADED to reverted when a real revert lands', async () => {
    proposalRepo = repoWithMerge('p-upg');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['revert', '--no-edit', mergeSha]);
    // Stream already carries a followed-up patch record — the revert must
    // still be detected and linked (followed-up is NOT terminal).
    traces = [mergedTrace('p-upg'), { ...mergedTrace('p-upg'), outcome: 'followed-up' }];
    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.reverts).toBe(1);
    expect(linked).toContainEqual(['p-upg', 'reverted']);
  }, 30_000);

  it('M339: same-day in-place rewrite — a SINGLE followed-up record (no surviving merged) still upgrades to reverted', async () => {
    proposalRepo = repoWithMerge('p-day');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['revert', '--no-edit', mergeSha]);
    // Same-UTC-day linkOutcome('followed-up') rewrote the trace IN PLACE —
    // there is NO surviving 'merged' record, only the followed-up line.
    traces = [{ ...mergedTrace('p-day'), outcome: 'followed-up' }];
    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.reverts).toBe(1);
    expect(linked).toContainEqual(['p-day', 'reverted']);
  }, 30_000);

  it('M339: single followed-up record with NO revert — scanned once, nothing linked', async () => {
    proposalRepo = repoWithMerge('p-day2');
    traces = [{ ...mergedTrace('p-day2'), outcome: 'followed-up' }];
    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.scanned).toBe(1);
    expect(scan.followUps).toBe(0);
    expect(linked.length).toBe(0);
  }, 30_000);

  it('M338: an already-followed-up proposal with NO revert is not re-linked', async () => {
    proposalRepo = repoWithMerge('p-nore');
    writeFileSync(join(proposalRepo, 'file.ts'), 'fixed change\n');
    g(proposalRepo, ['add', '-A']);
    g(proposalRepo, ['commit', '--quiet', '-m', 'fix: repair the merged change']);
    traces = [mergedTrace('p-nore'), { ...mergedTrace('p-nore'), outcome: 'followed-up' }];
    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.followUps).toBe(0);
    expect(linked.length).toBe(0);
    expect(scan.scanned).toBe(1); // scanned for the revert upgrade, found none
  }, 30_000);

  it('M337: a follow-up fix is found even with 55 newer commits after it', async () => {
    proposalRepo = repoWithMerge('p-busy');
    writeFileSync(join(proposalRepo, 'file.ts'), 'fixed change\n');
    g(proposalRepo, ['add', '-A']);
    g(proposalRepo, ['commit', '--quiet', '-m', 'fix: repair the merged change']);
    // Bury the fix under 55 unrelated commits — the pre-M337 newest-first
    // slice(0, 50) dropped exactly the window commits.
    for (let i = 0; i < 55; i++) {
      g(proposalRepo, ['commit', '--quiet', '--allow-empty', '-m', `chore: filler ${i}`]);
    }
    traces = [mergedTrace('p-busy')];
    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.followUps).toBe(1);
    expect(linked).toContainEqual(['p-busy', 'followed-up']);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Consumers
// ---------------------------------------------------------------------------

describe('M332 outcome consumers', () => {
  it("outcomeToIntent maps 'followed-up' → 'review'", () => {
    expect(outcomeToIntent('followed-up')).toBe('review');
    expect(outcomeToIntent('merged')).toBe('merge');
    expect(outcomeToIntent('reverted')).toBe('review');
    expect(outcomeToIntent('rejected')).toBe('reject');
  });

  it('buildProducerScores pass 3: a reverted outcome drags the ship-rate down', () => {
    const NOW = Date.now();
    const ts = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
    // 6 shipped proposals for sonnet-5 → ship-rate 1.0 without outcomes.
    ledger = [];
    traces = [];
    for (let i = 0; i < 6; i++) {
      const pid = `s5-${i}`;
      ledger.push({
        ts: ts(2 + i), proposalId: pid, action: 'proposed',
        engine: 'claude', model: 'claude:claude-sonnet-5', workSource: 'issue',
      });
      ledger.push({
        ts: ts(1 + i), proposalId: pid, action: 'judged',
        engine: 'claude-fable-5', model: 'claude-fable-5', verdict: 'ship',
      });
    }
    const before = buildProducerScores('issue', NOW).get('claude:sonnet-5')!;
    expect(before.score).toBeCloseTo(1.0, 3);

    // Now three of those merges were REVERTED in the real world.
    vi.mocked(readJudgeTraces).mockReturnValue(
      ['s5-0', 's5-1', 's5-2'].map((pid) => ({
        ...mergedTrace(pid),
        outcome: 'reverted',
        outcomeAt: ts(0.5),
      })) as never,
    );
    const after = buildProducerScores('issue', NOW).get('claude:sonnet-5')!;
    expect(after.score).toBeLessThan(before.score);
    expect(after.score).toBeLessThan(0.75);
  });
});

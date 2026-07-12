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

import type { AshlrConfig, SkillCard } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let traces: Record<string, unknown>[] = [];
const linked: Array<[string, string]> = [];
let proposalRepo = '';
let appliedProposals: Record<string, unknown>[] = [];
let proposalSourceState: 'healthy' | 'missing' | 'degraded' = 'healthy';
const recordedObservations: Record<string, unknown>[] = [];
let skillCards: SkillCard[] = [];
const recordedSkillCards: SkillCard[] = [];

vi.mock('../src/core/fleet/judge-trace.js', () => ({
  readJudgeTraces: vi.fn(() => traces),
  linkOutcome: vi.fn((id: string, outcome: string) => {
    linked.push([id, outcome]);
  }),
  linkOutcomeResult: vi.fn((id: string, outcome: string) => {
    linked.push([id, outcome]);
    return { status: 'linked' };
  }),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  loadProposal: vi.fn((id: string) => appliedProposals.find((proposal) => proposal['id'] === id)
    ?? (proposalRepo ? { repo: proposalRepo } : null)),
  listProposals: vi.fn(() => appliedProposals),
  listProposalsDetailed: vi.fn(() => ({
    proposals: proposalSourceState === 'healthy' ? appliedProposals : [],
    sourceState: proposalSourceState,
    sourcePresent: proposalSourceState !== 'missing',
    complete: proposalSourceState !== 'degraded',
    stopReasons: proposalSourceState === 'degraded' ? ['invalid-file'] : [],
    filesDiscovered: appliedProposals.length,
    filesRead: appliedProposals.length,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
  })),
}));

vi.mock('../src/core/fleet/post-merge-observations.js', () => ({
  recordPostMergeObservation: vi.fn((input: Record<string, unknown>) => {
    recordedObservations.push(input);
    return { recorded: 1, upgraded: 0, replayed: 0 };
  }),
}));

vi.mock('../src/core/fleet/skill-records.js', () => ({
  readSkillCards: vi.fn(() => skillCards),
  sanitizeSkillCard: vi.fn((card: SkillCard) => {
    const sanitized = { ...card };
    if (!sanitized.contentHash) delete sanitized.contentHash;
    if (!sanitized.attestation) delete sanitized.attestation;
    return sanitized;
  }),
  recordSkillCard: vi.fn((input: SkillCard | SkillCard[]) => {
    const cards = Array.isArray(input) ? input : [input];
    recordedSkillCards.push(...cards);
    skillCards = [...cards].reverse().concat(skillCards);
  }),
}));

vi.mock('../src/core/fleet/skill-attestation.js', () => ({
  verifyAttestedSkillCard: vi.fn((card: SkillCard) => card.attestation !== 'invalid'),
  attestSkillCard: vi.fn((card: SkillCard) => ({
    ...card,
    contentHash: 'c'.repeat(64),
    attestation: 'a'.repeat(64),
  })),
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
import { recordPostMergeObservation } from '../src/core/fleet/post-merge-observations.js';
import { loadMonitoringCursor } from '../src/core/fleet/monitoring-cursor.js';
import { attestSkillCard } from '../src/core/fleet/skill-attestation.js';
import { sanitizeSkillCard } from '../src/core/fleet/skill-records.js';

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

function verifiedCard(pid: string, overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    schemaVersion: 1,
    skillId: `skill.proposal.${pid}`,
    revision: 1,
    ts: '2026-07-10T12:00:00.000Z',
    name: 'Verified workflow',
    summary: 'Metadata-only verified workflow.',
    status: 'verified',
    source: 'verified-proposal',
    tags: ['verification'],
    commandKinds: ['test'],
    verification: {
      passed: true,
      diffHash: 'd'.repeat(64),
      evidenceCount: 2,
    },
    proposalId: pid,
    learningSource: 'verified-proposal',
    labelBasis: 'evidence-policy',
    ...overrides,
  };
}

const cfg = { version: 1, foundry: {} } as unknown as AshlrConfig;
let stateFile = '';
let previousAshlrHome: string | undefined;

beforeEach(() => {
  traces = [];
  ledger = [];
  linked.length = 0;
  proposalRepo = '';
  appliedProposals = [];
  proposalSourceState = 'healthy';
  recordedObservations.length = 0;
  skillCards = [];
  recordedSkillCards.length = 0;
  const stateDir = mkdtempSync(join(tmpdir(), 'ashlr-m332-state-'));
  dirs.push(stateDir);
  stateFile = join(stateDir, 'watch.json');
  previousAshlrHome = process.env.ASHLR_HOME;
  process.env.ASHLR_HOME = join(stateDir, '.ashlr');
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
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
    skillCards = [{
      ...verifiedCard('p-rev'),
      contentHash: 'e'.repeat(64),
      attestation: 'f'.repeat(64),
    }];

    const nowMs = Date.parse('2026-07-10T14:00:00.000Z');
    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile, nowMs });
    expect(scan.reverts).toBe(1);
    expect(recordedObservations).toEqual([expect.objectContaining({
      proposalId: 'p-rev',
      outcome: 'reverted',
      basis: 'git-revert-reference',
    })]);
    expect(linked).toEqual([]);
    expect(recordedSkillCards).toEqual([]);
    expect(sanitizeSkillCard).not.toHaveBeenCalled();
    expect(attestSkillCard).not.toHaveBeenCalled();
  }, 30_000);

  it('detects a near-term fix commit touching the same file', async () => {
    proposalRepo = repoWithMerge('p-fix');
    writeFileSync(join(proposalRepo, 'file.ts'), 'fixed change\n');
    g(proposalRepo, ['add', '-A']);
    g(proposalRepo, ['commit', '--quiet', '-m', 'fix: repair the merged change']);
    traces = [mergedTrace('p-fix')];
    skillCards = [verifiedCard('p-fix')];

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    expect(scan.followUps).toBe(1);
    expect(recordedObservations).toEqual([expect.objectContaining({
      proposalId: 'p-fix',
      outcome: 'followed-up',
      basis: 'overlapping-fix',
    })]);
    expect(linked).toEqual([]);
    expect(recordedSkillCards).toEqual([]);
  }, 30_000);

  it('does not mutate trace or skill state when signed observation persistence fails', async () => {
    proposalRepo = repoWithMerge('p-write-fail');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['revert', '--no-edit', mergeSha]);
    traces = [mergedTrace('p-write-fail')];
    skillCards = [verifiedCard('p-write-fail')];
    vi.mocked(recordPostMergeObservation).mockReturnValueOnce({
      attempted: 1, recorded: 0, upgraded: 0, replayed: 0, obsolete: 0,
      conflicted: 0, invalid: 0, failed: 1,
    });

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });

    expect(scan.reverts).toBe(0);
    expect(scan.skipped).toBe(1);
    expect(linked).toEqual([]);
    expect(recordedSkillCards).toEqual([]);
  }, 30_000);

  it('does not throttle retry after an incomplete observation pass', async () => {
    proposalRepo = repoWithMerge('p-retry');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['revert', '--no-edit', mergeSha]);
    traces = [mergedTrace('p-retry')];
    vi.mocked(recordPostMergeObservation).mockReturnValueOnce({
      attempted: 1, recorded: 0, upgraded: 0, replayed: 0, obsolete: 0,
      conflicted: 0, invalid: 0, failed: 1,
    });

    const incomplete = await scanRealWorldOutcomes(cfg, { stateFile });
    const retry = await scanRealWorldOutcomes(cfg, { stateFile });

    expect(incomplete).toMatchObject({ reverts: 0, skipped: 1, sourceComplete: false, throttled: false });
    expect(retry).toMatchObject({ reverts: 1, skipped: 0, sourceComplete: true, throttled: false });
  }, 30_000);

  it('refuses a stored merge SHA that is not an ancestor of the observed head', async () => {
    proposalRepo = repoWithMerge('p-ancestor');
    const mainBranch = g(proposalRepo, ['branch', '--show-current']).trim();
    g(proposalRepo, ['checkout', '--quiet', '-b', 'divergent']);
    writeFileSync(join(proposalRepo, 'divergent.txt'), 'divergent\n');
    g(proposalRepo, ['add', '-A']);
    g(proposalRepo, ['commit', '--quiet', '-m', 'divergent merge object']);
    const divergentSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['checkout', '--quiet', mainBranch]);
    appliedProposals = [{
      id: 'p-ancestor', status: 'applied', createdAt: new Date().toISOString(),
      repo: proposalRepo, remoteHandoff: { mergeCommitOid: divergentSha },
    }];

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });

    expect(scan.skipped).toBe(1);
    expect(recordedObservations).toEqual([]);
  }, 30_000);

  it('does not bind a proposal id to a longer commit-subject prefix', async () => {
    proposalRepo = repoWithMerge('prefix-longer');
    traces = [mergedTrace('prefix')];

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });

    expect(scan.skipped).toBe(1);
    expect(recordedObservations).toEqual([]);
  }, 30_000);

  it('records a judge-free applied merge from its remote merge SHA', async () => {
    proposalRepo = repoWithMerge('p-evidence');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(proposalRepo, 'file.ts'), 'evidence fix\n');
    g(proposalRepo, ['add', '-A']);
    g(proposalRepo, ['commit', '--quiet', '-m', 'fix: repair evidence merge']);
    appliedProposals = [{
      id: 'p-evidence',
      status: 'applied',
      createdAt: new Date().toISOString(),
      repo: proposalRepo,
      runId: 'run-evidence',
      trajectoryId: 'trajectory-evidence',
      workItemId: 'work-evidence',
      remoteHandoff: { mergeCommitOid: mergeSha },
      verifyResult: { ran: [{ kind: 'test' }, { kind: 'typecheck' }] },
    }];

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });

    expect(scan.followUps).toBe(1);
    expect(linked).toEqual([]);
    expect(recordedObservations).toEqual([
      expect.objectContaining({
        proposalId: 'p-evidence',
        runId: 'run-evidence',
        trajectoryId: 'trajectory-evidence',
        workItemId: 'work-evidence',
        mergeCommit: mergeSha,
        outcome: 'followed-up',
        basis: 'overlapping-fix',
        commandKinds: ['test', 'typecheck'],
      }),
    ]);
  }, 30_000);

  it('never mutates policy ledgers across repeated forced scans', async () => {
    proposalRepo = repoWithMerge('p-repeat');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['revert', '--no-edit', mergeSha]);
    traces = [mergedTrace('p-repeat')];
    skillCards = [verifiedCard('p-repeat')];

    await scanRealWorldOutcomes(cfg, { force: true, stateFile });
    await scanRealWorldOutcomes(cfg, { force: true, stateFile });

    expect(recordedObservations).toHaveLength(2);
    expect(linked).toEqual([]);
    expect(recordedSkillCards).toEqual([]);
  }, 30_000);

  it('does not create a card when the detected proposal has no verified skill', async () => {
    proposalRepo = repoWithMerge('p-absent');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['revert', '--no-edit', mergeSha]);
    traces = [mergedTrace('p-absent')];
    skillCards = [
      verifiedCard('another-proposal'),
      verifiedCard('p-absent', { attestation: 'invalid' }),
    ];

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });

    expect(scan.reverts).toBe(1);
    expect(recordedSkillCards).toEqual([]);
  }, 30_000);

  it('does not append an unsigned lifecycle row when attestation fails', async () => {
    proposalRepo = repoWithMerge('p-attestation-fails');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['revert', '--no-edit', mergeSha]);
    traces = [mergedTrace('p-attestation-fails')];
    skillCards = [verifiedCard('p-attestation-fails')];
    vi.mocked(attestSkillCard).mockReturnValueOnce(null);

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });

    expect(scan.reverts).toBe(1);
    expect(recordedSkillCards).toEqual([]);
  }, 30_000);

  it('never downgrades an already-revoked skill after a follow-up fix', async () => {
    proposalRepo = repoWithMerge('p-terminal');
    writeFileSync(join(proposalRepo, 'file.ts'), 'fixed after revocation\n');
    g(proposalRepo, ['add', '-A']);
    g(proposalRepo, ['commit', '--quiet', '-m', 'fix: follow up on revoked workflow']);
    traces = [mergedTrace('p-terminal')];
    skillCards = [
      verifiedCard('p-terminal', { revision: 2, status: 'revoked' }),
      verifiedCard('p-terminal'),
    ];

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });

    expect(scan.followUps).toBe(1);
    expect(recordedSkillCards).toEqual([]);
  }, 30_000);

  it('records a later revert without mutating a deprecated skill', async () => {
    proposalRepo = repoWithMerge('p-lifecycle-upgrade');
    const mergeSha = g(proposalRepo, ['rev-parse', 'HEAD']).trim();
    g(proposalRepo, ['revert', '--no-edit', mergeSha]);
    traces = [{ ...mergedTrace('p-lifecycle-upgrade'), outcome: 'followed-up' }];
    skillCards = [
      verifiedCard('p-lifecycle-upgrade', { revision: 2, status: 'deprecated' }),
      verifiedCard('p-lifecycle-upgrade'),
    ];

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });

    expect(scan.reverts).toBe(1);
    expect(recordedObservations).toEqual([expect.objectContaining({
      proposalId: 'p-lifecycle-upgrade',
      outcome: 'reverted',
    })]);
    expect(recordedSkillCards).toEqual([]);
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

  it('production enrollment scope excludes an existing but unenrolled proposal repo', async () => {
    proposalRepo = repoWithMerge('p-unenrolled');
    traces = [mergedTrace('p-unenrolled')];
    appliedProposals = [{
      id: 'p-unenrolled', status: 'applied', createdAt: new Date().toISOString(),
      repo: proposalRepo, remoteHandoff: { mergeCommitOid: g(proposalRepo, ['rev-parse', 'HEAD']).trim() },
    }];

    const scan = await scanRealWorldOutcomes(cfg, {
      force: true,
      stateFile,
      enrolledRepos: [join(proposalRepo, 'different-repo')],
    });

    expect(scan.scanned).toBe(1);
    expect(scan.skipped).toBe(1);
    expect(recordedObservations).toEqual([]);
  }, 30_000);

  it('production observation aborts when strict proposal provenance is incomplete', async () => {
    proposalRepo = repoWithMerge('p-degraded-source');
    appliedProposals = [{
      id: 'p-degraded-source', status: 'applied', createdAt: new Date().toISOString(),
      repo: proposalRepo,
      remoteHandoff: { mergeCommitOid: g(proposalRepo, ['rev-parse', 'HEAD']).trim() },
    }];
    traces = [mergedTrace('p-degraded-source')];
    proposalSourceState = 'degraded';

    const scan = await scanRealWorldOutcomes(cfg, {
      force: true, stateFile, enrolledRepos: [proposalRepo],
    });

    expect(scan).toMatchObject({ scanned: 0, skipped: 1, sourceComplete: false, throttled: false });
    expect(recordedObservations).toEqual([]);
  }, 30_000);

  it('production observation does not throttle when strict proposal provenance is missing', async () => {
    traces = [mergedTrace('p-missing-source')];
    proposalSourceState = 'missing';

    const first = await scanRealWorldOutcomes(cfg, { stateFile, enrolledRepos: [proposalRepo] });
    const retry = await scanRealWorldOutcomes(cfg, { stateFile, enrolledRepos: [proposalRepo] });

    expect(first).toMatchObject({ scanned: 0, skipped: 1, sourceComplete: false, throttled: false });
    expect(retry.throttled).toBe(false);
  });

  it('persists outcome paging so the next production scan advances beyond the first page', async () => {
    const monitoredRepo = repoWithMerge('p-page-base');
    const mergeCommitOid = g(monitoredRepo, ['rev-parse', 'HEAD']).trim();
    appliedProposals = Array.from({ length: 30 }, (_, index) => ({
      id: `p-page-${String(index).padStart(2, '0')}`,
      status: 'applied',
      createdAt: new Date().toISOString(),
      repo: monitoredRepo,
      remoteHandoff: { mergeCommitOid },
    }));

    const first = await scanRealWorldOutcomes(cfg, {
      stateFile, enrolledRepos: [monitoredRepo],
    });
    expect(loadMonitoringCursor([monitoredRepo]).cursor?.outcome).toMatchObject({
      candidateAfter: { proposalId: 'p-page-24', mergeCommitOid },
      sweepComplete: false,
    });
    const second = await scanRealWorldOutcomes(cfg, {
      stateFile, enrolledRepos: [monitoredRepo],
    });

    expect(first.scanned).toBe(25);
    expect(first.sourceComplete).toBe(true);
    expect(first.throttled).toBe(false);
    expect(second.scanned).toBe(5);
    expect(second.throttled).toBe(false);
  }, 30_000);

  it('completes a partial sweep when its unvisited tail disappears', async () => {
    const monitoredRepo = repoWithMerge('p-tail-base');
    const mergeCommitOid = g(monitoredRepo, ['rev-parse', 'HEAD']).trim();
    appliedProposals = Array.from({ length: 30 }, (_, index) => ({
      id: `p-tail-${String(index).padStart(2, '0')}`,
      status: 'applied',
      createdAt: new Date().toISOString(),
      repo: monitoredRepo,
      remoteHandoff: { mergeCommitOid },
    }));

    const first = await scanRealWorldOutcomes(cfg, { stateFile, enrolledRepos: [monitoredRepo] });
    appliedProposals = appliedProposals.slice(0, 24);
    const completed = await scanRealWorldOutcomes(cfg, { stateFile, enrolledRepos: [monitoredRepo] });
    const throttled = await scanRealWorldOutcomes(cfg, { stateFile, enrolledRepos: [monitoredRepo] });

    expect(first.scanned).toBe(25);
    expect(completed).toMatchObject({ scanned: 0, sourceComplete: true, throttled: false });
    expect(loadMonitoringCursor([monitoredRepo]).cursor?.outcome.sweepComplete).toBe(true);
    expect(throttled.throttled).toBe(true);
  }, 30_000);

  it('hard-caps the complete trace-backed candidate population', async () => {
    traces = Array.from({ length: 250 }, (_, index) => mergedTrace(`p-cap-${index}`));

    const scan = await scanRealWorldOutcomes(cfg, { force: true, stateFile });

    expect(scan.scanned).toBe(200);
    expect(scan.skipped).toBe(200);
    expect(scan).toMatchObject({ sourceComplete: false, candidateLimitReached: true });
    expect(recordedObservations).toEqual([]);
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
    expect(recordedObservations).toEqual([expect.objectContaining({
      proposalId: 'p-upg',
      outcome: 'reverted',
    })]);
    expect(linked).toEqual([]);
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
    expect(recordedObservations).toEqual([expect.objectContaining({
      proposalId: 'p-day',
      outcome: 'reverted',
    })]);
    expect(linked).toEqual([]);
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
    expect(recordedObservations).toEqual([expect.objectContaining({
      proposalId: 'p-busy',
      outcome: 'followed-up',
    })]);
    expect(linked).toEqual([]);
  }, 60_000);

  it('finds a qualifying fix after more than 50 in-window commits without truncating history', async () => {
    proposalRepo = repoWithMerge('p-late-fix');
    for (let i = 0; i < 55; i++) {
      g(proposalRepo, ['commit', '--quiet', '--allow-empty', '-m', `chore: pre-fix filler ${i}`]);
    }
    writeFileSync(join(proposalRepo, 'file.ts'), 'late fixed change\n');
    g(proposalRepo, ['add', '-A']);
    g(proposalRepo, ['commit', '--quiet', '-m', 'fix: repair after a busy window']);
    traces = [mergedTrace('p-late-fix')];

    const scan = await scanRealWorldOutcomes(cfg, { stateFile });

    expect(scan).toMatchObject({
      followUps: 1,
      sourceComplete: true,
      candidateLimitReached: false,
      throttled: false,
    });
    expect(recordedObservations).toEqual([expect.objectContaining({ proposalId: 'p-late-fix' })]);
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

  it('legacy post-merge trace outcomes do not influence learned routing', () => {
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
    expect(after).toEqual(before);
  });
});

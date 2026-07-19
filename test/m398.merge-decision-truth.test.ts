/**
 * M398: manager authorization is not a terminal merge outcome.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  judgeProposal: vi.fn(),
  getActiveClient: vi.fn(),
  persistEvidencePack: vi.fn(),
  persistedEvidencePack: null as unknown,
  resolveFrontierJudgeClient: vi.fn(),
}));

vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mocks.judgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mocks.resolveFrontierJudgeClient(...args),
  wrapClient: (raw: { complete?: unknown; model?: unknown }) =>
    typeof raw.complete === 'function'
      ? { complete: raw.complete, model: typeof raw.model === 'string' ? raw.model : 'unknown' }
      : null,
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (...args: unknown[]) => mocks.getActiveClient(...args),
}));

vi.mock('../src/core/autonomy/evidence-pack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/autonomy/evidence-pack.js')>();
  return {
    ...actual,
    persistAutonomyEvidencePack: (...args: unknown[]) => {
      const persisted = mocks.persistEvidencePack(...args);
      if (persisted) mocks.persistedEvidencePack = args[0];
      return persisted;
    },
    readAutonomyEvidencePack: (proposalId: string) => {
      const pack = mocks.persistedEvidencePack as { proposal?: { id?: string } } | null;
      return pack?.proposal?.id === proposalId ? pack : null;
    },
  };
});

import { listOutcomeRecords } from '../src/core/autonomy/outcome-records.js';
import {
  listTrajectoryRecords,
  summarizeTrajectoryLearning,
} from '../src/core/autonomy/trajectory-records.js';
import { readDecisions } from '../src/core/fleet/decisions-ledger.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';
import { judgeTracesDir, readJudgeTraces, recordJudgeTrace } from '../src/core/fleet/judge-trace.js';
import { hashDiff, signLocalMergeIntent, signProvenance } from '../src/core/foundry/provenance.js';
import {
  addMilestone,
  createGoal,
  listGoalsDetailed,
  loadGoal,
  updateMilestoneStatus,
} from '../src/core/goals/store.js';
import { autoMergeProposal } from '../src/core/inbox/merge.js';
import {
  canonicalRealizedMergeIdentity,
  hasRealizedMergeEvidence,
  realizedMergeOf,
  sanitizeRealizedMergeEvidence,
} from '../src/core/inbox/realized-merge.js';
import {
  createProposal,
  loadProposal,
  recordRealizedMerge,
  replayRealizedMergeFanout,
  setStatus,
  updateProposalField,
} from '../src/core/inbox/store.js';
import { enroll, setKill } from '../src/core/sandbox/policy.js';
import type { AshlrConfig, DecisionEntry, Proposal } from '../src/core/types.js';

const originalHome = process.env.HOME;
const originalAshlrHome = process.env.ASHLR_HOME;
const originalAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;

let tmpHome: string;
let tmpRepo: string;

const PRODUCER_MODEL = 'codex:gpt-5.5';
const REVIEWER_MODEL = 'claude-opus-4-5';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function initRepo(): void {
  fs.mkdirSync(tmpRepo, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', tmpRepo], { stdio: 'pipe' });
  git(tmpRepo, ['config', 'user.email', 'test@ashlr.test']);
  git(tmpRepo, ['config', 'user.name', 'Ashlr Test']);
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# fixture\n', 'utf8');
  git(tmpRepo, ['add', 'README.md']);
  git(tmpRepo, ['commit', '-m', 'init']);

  const origin = path.join(tmpHome, 'origin.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
  git(tmpRepo, ['remote', 'add', 'origin', origin]);
  git(tmpRepo, ['push', '-u', 'origin', 'main']);
  git(tmpRepo, ['remote', 'set-head', 'origin', 'main']);
  git(tmpRepo, ['checkout', '-b', 'work']);
}

function config(): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      managerJudgeEngine: 'claude',
      managerJudgeModel: REVIEWER_MODEL,
      autoMerge: {
        enabled: true,
        maxRisk: 'low',
        allowWithoutVerification: true,
        managerGate: true,
      },
    },
  } as unknown as AshlrConfig;
}

function createFrontierProposal(trajectoryId: string): Proposal {
  const diff = [
    'diff --git a/docs/m398.md b/docs/m398.md',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/docs/m398.md',
    '@@ -0,0 +1 @@',
    '+truthful merge decisions',
    '',
  ].join('\n');
  const diffHash = hashDiff(diff);
  return createProposal({
    repo: tmpRepo,
    origin: 'agent',
    kind: 'patch',
    title: 'M398 decision truth',
    summary: 'Separate manager authorization from terminal merge truth',
    diff,
    diffHash,
    provenanceSig: signProvenance(PRODUCER_MODEL, 'frontier', diffHash),
    engineModel: PRODUCER_MODEL,
    engineTier: 'frontier',
    workItemId: `${tmpRepo}:issue:m398`,
    workSource: 'issue',
    runId: `run-${trajectoryId}`,
    trajectoryId,
  });
}

function trajectoriesFor(proposal: Proposal, decisions: DecisionEntry[]) {
  const dispatch: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: proposal.createdAt,
    itemId: proposal.workItemId!,
    source: 'issue',
    repo: tmpRepo,
    title: proposal.title,
    backend: 'codex',
    tier: 'frontier',
    model: 'gpt-5.5',
    assignedBy: 'm398-test',
    routeReason: 'focused decision-truth fixture',
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId: proposal.id,
    runId: proposal.runId,
    trajectoryId: proposal.trajectoryId,
    learningSource: 'dispatch-production',
    labelBasis: 'run-proposal-outcome',
    spentUsd: 0,
    basis: 'run-proposal-outcome',
  };
  const outcomes = listOutcomeRecords({
    deps: {
      listProposals: () => [proposal],
      readDecisions: () => decisions,
      readJudgeTraces: () => [],
      loadWorkedLedger: () => ({ events: [] }),
      listAutonomyEvidencePacks: () => [],
    },
  });
  return listTrajectoryRecords({
    windowHours: 1,
    deps: {
      readDispatchProductionEvents: () => [dispatch],
      readAgentActions: () => [],
      readSkillUseEvents: () => [],
      listOutcomeRecords: () => outcomes,
    },
  });
}

beforeEach(() => {
  mocks.persistedEvidencePack = null;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m398-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m398-repo-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  setKill(false);
  initRepo();
  enroll(tmpRepo);

  mocks.getActiveClient.mockResolvedValue({
    id: 'anthropic',
    model: 'claude-opus-4-5',
    complete: async () => '{}',
  });
  mocks.resolveFrontierJudgeClient.mockImplementation((_cfg, options) => {
    if (options?.producerModel !== PRODUCER_MODEL || options?.requireIndependent !== true) return null;
    return {
      model: REVIEWER_MODEL,
      complete: async () => '{}',
    };
  });
  mocks.judgeProposal.mockImplementation(async (proposal: Proposal) => ({
    proposalId: proposal.id,
    verdict: 'ship',
    value: 4,
    correctness: 4,
    scope: 1,
    alignment: 4,
    rationale: 'small verified docs change',
    wouldMerge: true,
  }));
});

afterEach(() => {
  try { setKill(false); } catch { /* best effort */ }
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = originalHome;
  if (originalAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = originalAshlrHome;
  if (originalAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = originalAllowAnyRepo;
  vi.clearAllMocks();
});

describe('M398 merge decision truth', () => {
  it('sanitizes OIDs and rejects unbounded or non-exact evidence', () => {
    const evidence = {
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid: 'A'.repeat(40),
      proposalHeadOid: 'B'.repeat(40),
      mergeCommitOid: 'C'.repeat(40),
      observedAt: '2026-07-14T04:00:00.000Z',
      proposalId: 'proposal-m398',
      diffHash: 'D'.repeat(64),
      intentAttestation: 'E'.repeat(64),
      attestation: 'F'.repeat(64),
    } as const;

    expect(sanitizeRealizedMergeEvidence(evidence)).toMatchObject({
      baseBeforeOid: 'a'.repeat(40),
      proposalHeadOid: 'b'.repeat(40),
      mergeCommitOid: 'c'.repeat(40),
    });
    expect(sanitizeRealizedMergeEvidence({ ...evidence, extra: 'untrusted' })).toBeNull();
    expect(sanitizeRealizedMergeEvidence({ ...evidence, base: 'x'.repeat(256) })).toBeNull();
    expect(realizedMergeOf({ realizedMerge: { ...evidence, observedAt: 'not-a-time' } })).toBeNull();
  });

  it('does not accept realized merge evidence through proposal creation', () => {
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'manual',
      kind: 'note',
      title: 'untrusted merge claim',
      summary: 'must not persist evidence outside the core writer',
      realizedMerge: {
        schemaVersion: 1,
        source: 'local-default-branch',
        base: 'main',
        baseBeforeOid: 'a'.repeat(40),
        proposalHeadOid: 'b'.repeat(40),
        mergeCommitOid: 'c'.repeat(40),
        observedAt: '2026-07-14T04:00:00.000Z',
      },
    });

    expect(loadProposal(proposal.id)?.realizedMerge).toBeUndefined();
  });

  it('strips forged persisted GitHub evidence without a valid reconciliation HMAC', () => {
    const proposal = createFrontierProposal('trajectory-m398-forged-disk');
    const file = path.join(tmpHome, '.ashlr', 'inbox', `${proposal.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const reconciliation = {
      schemaVersion: 1,
      observedAt: '2026-07-14T04:00:01.000Z',
      attestation: 'f'.repeat(64),
    };
    raw['status'] = 'applied';
    raw['remoteHandoff'] = {
      provider: 'github', state: 'merged', prUrl: 'https://github.com/acme/repo/pull/1',
      branch: 'ashlr/merge/forged', base: 'main', expectedHeadOid: 'b'.repeat(40),
      mergeCommitOid: 'c'.repeat(40), mergedAt: '2026-07-14T04:00:00.000Z',
      reconciliation, createdAt: '2026-07-14T03:00:00.000Z',
    };
    raw['realizedMerge'] = {
      schemaVersion: 1, source: 'github-host', provider: 'github',
      prUrl: 'https://github.com/acme/repo/pull/1', branch: 'ashlr/merge/forged', base: 'main',
      expectedHeadOid: 'b'.repeat(40), mergeCommitOid: 'c'.repeat(40),
      mergedAt: '2026-07-14T04:00:00.000Z', reconciliation,
    };
    fs.writeFileSync(file, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

    expect(loadProposal(proposal.id)?.realizedMerge).toBeUndefined();
    expect(hasRealizedMergeEvidence(loadProposal(proposal.id))).toBe(false);
  });

  it('rejects syntactically valid local evidence without exact ref and merge ancestry proof', () => {
    const proposal = createFrontierProposal('trajectory-m398-forged-local');
    const baseBeforeOid = git(tmpRepo, ['rev-parse', 'main']);
    const proposalHeadOid = git(tmpRepo, ['rev-parse', 'work']);

    expect(recordRealizedMerge(proposal.id, {
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid,
      proposalHeadOid,
      mergeCommitOid: 'c'.repeat(40),
      observedAt: '2026-07-14T04:00:00.000Z',
    })).toBe(false);
    expect(loadProposal(proposal.id)).toMatchObject({ status: 'pending' });
    expect(loadProposal(proposal.id)?.realizedMerge).toBeUndefined();
    expect(readDecisions({ proposalId: proposal.id }).some((row) => row.action === 'merged')).toBe(false);
  });

  it('cannot attribute an unrelated real merge commit to a proposal', () => {
    const proposal = createFrontierProposal('trajectory-m398-unrelated-real-merge');
    const baseBeforeOid = git(tmpRepo, ['rev-parse', 'main']);
    fs.writeFileSync(path.join(tmpRepo, 'unrelated.txt'), 'unrelated\n', 'utf8');
    git(tmpRepo, ['add', 'unrelated.txt']);
    git(tmpRepo, ['commit', '-m', 'unrelated work']);
    const proposalHeadOid = git(tmpRepo, ['rev-parse', 'work']);
    git(tmpRepo, ['checkout', 'main']);
    git(tmpRepo, ['merge', '--no-ff', '--no-edit', 'work']);
    const mergeCommitOid = git(tmpRepo, ['rev-parse', 'main']);

    expect(recordRealizedMerge(proposal.id, {
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid,
      proposalHeadOid,
      mergeCommitOid,
      observedAt: new Date().toISOString(),
    })).toBe(false);
    expect(loadProposal(proposal.id)).toMatchObject({ status: 'pending' });
    expect(loadProposal(proposal.id)?.realizedMerge).toBeUndefined();
  });

  it('refuses an otherwise exact local merge observation dated beyond clock skew', () => {
    const proposal = createFrontierProposal('trajectory-m398-future-observation');
    const baseBeforeOid = git(tmpRepo, ['rev-parse', 'main']);
    fs.mkdirSync(path.join(tmpRepo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'docs', 'm398.md'), 'truthful merge decisions\n', 'utf8');
    git(tmpRepo, ['add', 'docs/m398.md']);
    git(tmpRepo, ['commit', '-m', 'proposal head']);
    const proposalHeadOid = git(tmpRepo, ['rev-parse', 'work']);
    const unsignedIntent = {
      schemaVersion: 1 as const,
      branch: `ashlr/merge/${proposal.id}`,
      base: 'main',
      baseBeforeOid,
      proposalHeadOid,
      diffHash: proposal.diffHash!,
      evidencePackDigest: 'e'.repeat(64),
      authorizationId: '1'.repeat(32),
      authorizedAt: new Date().toISOString(),
    };
    expect(updateProposalField(proposal.id, {
      localMergeIntent: {
        ...unsignedIntent,
        attestation: signLocalMergeIntent(proposal.id, tmpRepo, unsignedIntent),
      },
    })).toBe(true);
    git(tmpRepo, ['checkout', 'main']);
    git(tmpRepo, ['merge', '--no-ff', '--no-edit', 'work']);
    const mergeCommitOid = git(tmpRepo, ['rev-parse', 'main']);

    expect(recordRealizedMerge(proposal.id, {
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid,
      proposalHeadOid,
      mergeCommitOid,
      observedAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    })).toBe(false);
    expect(loadProposal(proposal.id)).toMatchObject({ status: 'pending' });
    expect(loadProposal(proposal.id)?.realizedMerge).toBeUndefined();
  });

  it('keeps generic applied lifecycle-compatible without merge fanout', () => {
    const proposal = createFrontierProposal('trajectory-m398-generic-applied');

    expect(setStatus(proposal.id, 'applied', 'branch application completed')).toBe(true);

    const applied = loadProposal(proposal.id)!;
    expect(applied.status).toBe('applied');
    expect(hasRealizedMergeEvidence(applied)).toBe(false);
    expect(realizedMergeOf(applied)).toBeNull();
    const decisions = readDecisions({ proposalId: proposal.id, requireComplete: true });
    expect(decisions.filter((decision) => decision.action === 'merged')).toHaveLength(0);
  });

  it.each(['rejected', 'applied', 'awaiting-host-merge'] as const)(
    'refuses auto-merge when lifecycle state is terminal: %s',
    async (status) => {
      const proposal = createFrontierProposal(`trajectory-m398-terminal-${status}`);
      expect(setStatus(proposal.id, status, 'terminal fixture')).toBe(true);
      const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

      const result = await autoMergeProposal(proposal.id, config());

      expect(result).toMatchObject({ ok: false, merged: false });
      expect(result.reason).toMatch(/no active merge authority/i);
      expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
      expect(loadProposal(proposal.id)?.status).toBe(status);
    },
  );

  it('keeps Gate 7 authorization nonterminal when Gate 8 later refuses', async () => {
    mocks.persistEvidencePack.mockReturnValue(false);
    const proposal = createFrontierProposal('trajectory-m398-refused');
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    const result = await autoMergeProposal(proposal.id, config());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/evidence pack could not be persisted/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(proposal.id)?.status).toBe('pending');

    const decisions = readDecisions({ proposalId: proposal.id, requireComplete: true });
    expect(decisions.filter((decision) => decision.action === 'merge-authorized')).toHaveLength(1);
    expect(decisions.filter((decision) => decision.action === 'merged')).toHaveLength(0);

    const trajectories = trajectoriesFor(loadProposal(proposal.id)!, decisions);
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0]?.terminalOutcome).toBe('pending');
    expect(summarizeTrajectoryLearning(trajectories).terminalOutcomes.merged).toBe(0);
  });

  it('retains the authoritative merged outcome after an applied transition', async () => {
    mocks.persistEvidencePack.mockReturnValue(true);
    const proposal = createFrontierProposal('trajectory-m398-applied');
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    const result = await autoMergeProposal(proposal.id, config());

    expect(result).toMatchObject({ ok: true, merged: true });
    expect(git(tmpRepo, ['rev-parse', 'main'])).not.toBe(mainBefore);
    const applied = loadProposal(proposal.id)!;
    expect(applied.status).toBe('applied');
    expect(hasRealizedMergeEvidence(applied)).toBe(true);
    expect(realizedMergeOf(applied)).toEqual(expect.objectContaining({
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid: mainBefore,
      proposalHeadOid: git(tmpRepo, ['rev-parse', `ashlr/merge/${proposal.id}`]),
      mergeCommitOid: git(tmpRepo, ['rev-parse', 'main']),
      observedAt: expect.any(String),
      proposalId: proposal.id,
      diffHash: proposal.diffHash,
      intentAttestation: expect.stringMatching(/^[a-f0-9]{64}$/),
      attestation: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(canonicalRealizedMergeIdentity(applied)).toEqual({
      source: 'local-default-branch',
      repo: fs.realpathSync.native(tmpRepo),
      base: 'main',
      mergeCommitOid: git(tmpRepo, ['rev-parse', 'main']),
      key: JSON.stringify([
        'local-default-branch',
        fs.realpathSync.native(tmpRepo),
        'main',
        git(tmpRepo, ['rev-parse', 'main']),
      ]),
    });
    expect(canonicalRealizedMergeIdentity({ ...applied, isPartial: true })).toBeNull();
    expect(canonicalRealizedMergeIdentity({ ...applied, id: 'different-proposal-id' })).toBeNull();
    const secondProposal = createFrontierProposal('trajectory-m398-replay-other-proposal');
    git(tmpRepo, ['branch', `ashlr/merge/${secondProposal.id}`, applied.realizedMerge!.source === 'local-default-branch'
      ? applied.realizedMerge!.proposalHeadOid
      : 'HEAD']);
    const duplicateIntent = {
      schemaVersion: 1 as const,
      branch: `ashlr/merge/${secondProposal.id}`,
      base: 'main',
      baseBeforeOid: mainBefore,
      proposalHeadOid: applied.realizedMerge!.source === 'local-default-branch'
        ? applied.realizedMerge!.proposalHeadOid
        : '',
      diffHash: secondProposal.diffHash!,
      evidencePackDigest: 'e'.repeat(64),
      authorizationId: '2'.repeat(32),
      authorizedAt: new Date().toISOString(),
    };
    expect(updateProposalField(secondProposal.id, {
      localMergeIntent: {
        ...duplicateIntent,
        attestation: signLocalMergeIntent(secondProposal.id, tmpRepo, duplicateIntent),
      },
    })).toBe(true);
    expect(recordRealizedMerge(secondProposal.id, {
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid: mainBefore,
      proposalHeadOid: duplicateIntent.proposalHeadOid,
      mergeCommitOid: applied.realizedMerge!.mergeCommitOid,
      observedAt: new Date().toISOString(),
    })).toBe(false);
    expect(recordRealizedMerge(secondProposal.id, applied.realizedMerge!)).toBe(false);
    expect(loadProposal(secondProposal.id)?.realizedMerge).toBeUndefined();

    const file = path.join(tmpHome, '.ashlr', 'inbox', `${proposal.id}.json`);
    const interrupted = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete interrupted['realizedMergeFanoutVersion'];
    fs.writeFileSync(file, `${JSON.stringify(interrupted)}\n`, { mode: 0o600 });
    let authorityChecks = 0;
    expect(replayRealizedMergeFanout(
      proposal.id,
      undefined,
      () => ++authorityChecks <= 4,
    )).toBe(true);
    expect(authorityChecks).toBeGreaterThan(4);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBeUndefined();
    expect(replayRealizedMergeFanout(proposal.id)).toBe(false);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBeUndefined();
    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(3);
    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);

    const decisions = readDecisions({ proposalId: proposal.id, requireComplete: true });
    expect(decisions.filter((decision) => decision.action === 'merge-authorized')).toHaveLength(1);
    expect(decisions.filter((decision) => decision.action === 'merged')).toEqual([
      expect.objectContaining({
        verdict: 'merged',
        labelBasis: 'realized-merge-v1',
      }),
    ]);

    const trajectories = trajectoriesFor(applied, decisions);
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0]?.terminalOutcome).toBe('merged');
    expect(summarizeTrajectoryLearning(trajectories).terminalOutcomes.merged).toBe(1);
  });

  it('leaves decision projection unacknowledged on degraded reads and repairs it once authoritative', async () => {
    mocks.persistEvidencePack.mockReturnValue(true);
    const proposal = createFrontierProposal('trajectory-m398-degraded-decision-retry');
    const result = await autoMergeProposal(proposal.id, config());
    expect(result).toMatchObject({ ok: true, merged: true });

    const applied = loadProposal(proposal.id)!;
    expect(applied.realizedMergeFanoutVersion).toBe(3);
    const proposalFile = path.join(tmpHome, '.ashlr', 'inbox', `${proposal.id}.json`);
    const interrupted = JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as Record<string, unknown>;
    delete interrupted['realizedMergeFanoutVersion'];
    fs.writeFileSync(proposalFile, `${JSON.stringify(interrupted)}\n`, { mode: 0o600 });

    const decisionsDirectory = path.join(tmpHome, '.ashlr', 'decisions');
    const decisionsBackup = `${decisionsDirectory}.backup`;
    fs.renameSync(decisionsDirectory, decisionsBackup);
    fs.writeFileSync(decisionsDirectory, 'not a directory\n', { mode: 0o600 });

    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBeUndefined();

    fs.unlinkSync(decisionsDirectory);
    fs.renameSync(decisionsBackup, decisionsDirectory);
    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(3);
    expect(readDecisions({ proposalId: proposal.id, requireComplete: true })
      .filter((decision) => decision.action === 'merged')).toHaveLength(1);
  });

  it('repairs historical markers with absent or disabled auto-merge without progressing new merges', async () => {
    mocks.persistEvidencePack.mockReturnValue(true);
    const appliedProposal = createFrontierProposal('trajectory-m398-disabled-fanout');
    expect(await autoMergeProposal(appliedProposal.id, config())).toMatchObject({ ok: true, merged: true });
    const mainAfterMerge = git(tmpRepo, ['rev-parse', 'main']);

    const proposalFile = path.join(tmpHome, '.ashlr', 'inbox', `${appliedProposal.id}.json`);
    const interrupted = JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as Record<string, unknown>;
    interrupted['realizedMergeFanoutVersion'] = 2;
    fs.writeFileSync(proposalFile, `${JSON.stringify(interrupted)}\n`, { mode: 0o600 });
    const pendingProposal = createFrontierProposal('trajectory-m398-disabled-pending');
    mocks.judgeProposal.mockClear();

    const absentResult = await runAutoMergePass({} as AshlrConfig);
    expect(absentResult).toMatchObject({ attempted: 0, merged: 0, judged: 0 });
    expect(loadProposal(appliedProposal.id)?.realizedMergeFanoutVersion).toBe(3);

    const historicalV1 = JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as Record<string, unknown>;
    historicalV1['realizedMergeFanoutVersion'] = 1;
    fs.writeFileSync(proposalFile, `${JSON.stringify(historicalV1)}\n`, { mode: 0o600 });
    const disabled = config();
    disabled.foundry!.autoMerge!.enabled = false;
    const result = await runAutoMergePass(disabled);

    expect(result).toMatchObject({ attempted: 0, merged: 0, judged: 0 });
    expect(loadProposal(appliedProposal.id)?.realizedMergeFanoutVersion).toBe(3);
    expect(loadProposal(pendingProposal.id)?.status).toBe('pending');
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainAfterMerge);
    expect(mocks.judgeProposal).not.toHaveBeenCalled();
  });

  it('keeps factual fanout independent of degraded judge traces without projecting a merged outcome', async () => {
    mocks.persistEvidencePack.mockReturnValue(true);
    const proposal = createFrontierProposal('trajectory-m398-degraded-outcome-retry');
    recordJudgeTrace({
      traceId: 'm398-degraded-outcome',
      proposalId: proposal.id,
      judgeEngine: REVIEWER_MODEL,
      verdict: 'ship',
      scores: { value: 4, correctness: 4, scope: 1, alignment: 4 },
      fullReasoning: 'qualified merge fixture',
      promptContext: 'm398 outcome projection',
    });
    expect(await autoMergeProposal(proposal.id, config())).toMatchObject({ ok: true, merged: true });

    const proposalFile = path.join(tmpHome, '.ashlr', 'inbox', `${proposal.id}.json`);
    const interrupted = JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as Record<string, unknown>;
    delete interrupted['realizedMergeFanoutVersion'];
    fs.writeFileSync(proposalFile, `${JSON.stringify(interrupted)}\n`, { mode: 0o600 });

    const traceFile = path.join(judgeTracesDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const healthyTraceSource = fs.readFileSync(traceFile, 'utf8');
    const initialTraces = readJudgeTraces({ proposalId: proposal.id });
    expect(initialTraces).toHaveLength(1);
    expect(initialTraces[0]).toMatchObject({
      traceId: 'm398-degraded-outcome',
      judgeEngine: REVIEWER_MODEL,
    });
    expect(initialTraces[0]?.outcome).toBeUndefined();
    expect(initialTraces[0]?.outcomeBasis).toBeUndefined();
    fs.appendFileSync(traceFile, '{"torn":', 'utf8');

    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(3);

    fs.writeFileSync(traceFile, healthyTraceSource, 'utf8');
    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(3);
    const replayedTrace = readJudgeTraces({ proposalId: proposal.id })[0];
    expect(replayedTrace?.outcome).toBeUndefined();
    expect(replayedTrace?.outcomeBasis).toBeUndefined();
  });

  it('leaves milestone projection unacknowledged until its linked goal write is durable', async () => {
    mocks.persistEvidencePack.mockReturnValue(true);
    const proposal = createFrontierProposal('trajectory-m398-milestone-write-retry');
    expect(updateProposalField(proposal.id, {
      verifyResult: {
        passed: true,
        diffHash: proposal.diffHash,
        verifiedAt: new Date().toISOString(),
        source: 'm398-test',
      },
    })).toBe(true);
    const goal = createGoal('M398 durable milestone projection', { project: tmpRepo });
    const milestone = addMilestone(goal.id, { title: 'Land proposal', detail: 'Exercise fanout durability.' })!
      .milestones[0]!;
    expect(updateMilestoneStatus(goal.id, milestone.id, 'proposed', { proposalId: proposal.id })).not.toBeNull();
    expect(await autoMergeProposal(proposal.id, config())).toMatchObject({ ok: true, merged: true });
    expect(loadGoal(goal.id)?.milestones[0]?.status).toBe('done');

    const proposalFile = path.join(tmpHome, '.ashlr', 'inbox', `${proposal.id}.json`);
    const interrupted = JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as Record<string, unknown>;
    interrupted['realizedMergeFanoutVersion'] = 2;
    fs.writeFileSync(proposalFile, `${JSON.stringify(interrupted)}\n`, { mode: 0o600 });
    expect(updateMilestoneStatus(goal.id, milestone.id, 'proposed')).not.toBeNull();

    const blockedTemp = path.join(tmpHome, '.ashlr', 'goals', `${goal.id}.json.tmp`);
    fs.mkdirSync(blockedTemp);
    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(2);
    expect(loadGoal(goal.id)?.milestones[0]?.status).toBe('proposed');

    fs.rmdirSync(blockedTemp);
    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(3);
    expect(loadGoal(goal.id)?.milestones[0]?.status).toBe('done');
  });

  it('does not write a milestone or version 3 marker when authority revokes at goal persistence', async () => {
    mocks.persistEvidencePack.mockReturnValue(true);
    const proposal = createFrontierProposal('trajectory-m398-milestone-authority-retry');
    expect(updateProposalField(proposal.id, {
      verifyResult: {
        passed: true,
        diffHash: proposal.diffHash,
        verifiedAt: new Date().toISOString(),
        source: 'm398-test',
      },
    })).toBe(true);
    const goal = createGoal('M398 milestone authority boundary', { project: tmpRepo });
    const milestone = addMilestone(goal.id, {
      title: 'Fence projected completion',
      detail: 'Revoke authority at the goal persistence boundary.',
    })!.milestones[0]!;
    expect(updateMilestoneStatus(goal.id, milestone.id, 'proposed', {
      proposalId: proposal.id,
    })).not.toBeNull();
    expect(await autoMergeProposal(proposal.id, config())).toMatchObject({ ok: true, merged: true });

    const proposalFile = path.join(tmpHome, '.ashlr', 'inbox', `${proposal.id}.json`);
    const interrupted = JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as Record<string, unknown>;
    interrupted['realizedMergeFanoutVersion'] = 2;
    fs.writeFileSync(proposalFile, `${JSON.stringify(interrupted)}\n`, { mode: 0o600 });
    expect(updateMilestoneStatus(goal.id, milestone.id, 'proposed')).not.toBeNull();

    const goalFile = path.join(tmpHome, '.ashlr', 'goals', `${goal.id}.json`);
    const goalBeforeReplay = fs.readFileSync(goalFile, 'utf8');
    let revokedAtPersistenceBoundary = false;
    const stillAuthorized = vi.fn(() => {
      if (new Error().stack?.includes('saveGoal')) {
        revokedAtPersistenceBoundary = true;
        return false;
      }
      return true;
    });

    expect(replayRealizedMergeFanout(proposal.id, undefined, stillAuthorized)).toBe(true);
    expect(revokedAtPersistenceBoundary).toBe(true);
    expect(fs.readFileSync(goalFile, 'utf8')).toBe(goalBeforeReplay);
    expect(loadGoal(goal.id)?.milestones[0]?.status).toBe('proposed');
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(2);

    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);
    expect(loadGoal(goal.id)?.milestones[0]?.status).toBe('done');
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(3);
  });

  it('revalidates a durable version 3 marker and repairs later milestone projection loss', async () => {
    mocks.persistEvidencePack.mockReturnValue(true);
    const proposal = createFrontierProposal('trajectory-m398-current-marker-repair');
    expect(updateProposalField(proposal.id, {
      verifyResult: {
        passed: true,
        diffHash: proposal.diffHash,
        verifiedAt: new Date().toISOString(),
        source: 'm398-test',
      },
    })).toBe(true);
    const goal = createGoal('M398 current marker validation', { project: tmpRepo });
    const milestone = addMilestone(goal.id, {
      title: 'Repair projected completion',
      detail: 'Exercise bounded validation after projection loss.',
    })!.milestones[0]!;
    expect(updateMilestoneStatus(goal.id, milestone.id, 'proposed', { proposalId: proposal.id })).not.toBeNull();
    expect(await autoMergeProposal(proposal.id, config())).toMatchObject({ ok: true, merged: true });
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(3);
    expect(loadGoal(goal.id)?.milestones[0]?.status).toBe('done');

    expect(updateMilestoneStatus(goal.id, milestone.id, 'proposed')).not.toBeNull();
    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);

    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(3);
    expect(loadGoal(goal.id)?.milestones[0]?.status).toBe('done');
  });

  it('does not acknowledge multiple milestone links until every projection is durable', async () => {
    mocks.persistEvidencePack.mockReturnValue(true);
    const proposal = createFrontierProposal('trajectory-m398-multiple-milestones');
    expect(updateProposalField(proposal.id, {
      verifyResult: {
        passed: true,
        diffHash: proposal.diffHash,
        verifiedAt: new Date().toISOString(),
        source: 'm398-test',
      },
    })).toBe(true);

    for (const title of ['M398 linked goal one', 'M398 linked goal two']) {
      const goal = createGoal(title, { project: tmpRepo });
      const milestone = addMilestone(goal.id, {
        title: `Land ${title}`,
        detail: 'Every linked milestone must be durably projected.',
      })!.milestones[0]!;
      expect(updateMilestoneStatus(goal.id, milestone.id, 'proposed', {
        proposalId: proposal.id,
      })).not.toBeNull();
    }

    const linkedGoals = listGoalsDetailed().goals.filter((goal) =>
      goal.milestones.some((milestone) => milestone.proposalId === proposal.id));
    expect(linkedGoals).toHaveLength(2);
    const first = linkedGoals[0]!;
    const blocked = linkedGoals[1]!;
    const blockedTemp = path.join(tmpHome, '.ashlr', 'goals', `${blocked.id}.json.tmp`);
    fs.mkdirSync(blockedTemp);

    expect(await autoMergeProposal(proposal.id, config())).toMatchObject({ ok: true, merged: true });
    expect(loadGoal(first.id)?.milestones[0]?.status).toBe('done');
    expect(loadGoal(blocked.id)?.milestones[0]?.status).toBe('proposed');
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBeUndefined();

    fs.rmdirSync(blockedTemp);
    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(3);
    expect(loadGoal(first.id)?.milestones[0]?.status).toBe('done');
    expect(loadGoal(blocked.id)?.milestones[0]?.status).toBe('done');
  });

  it('leaves milestone projection unacknowledged while its linked goal is corrupt and recovers', async () => {
    mocks.persistEvidencePack.mockReturnValue(true);
    const proposal = createFrontierProposal('trajectory-m398-corrupt-goal-retry');
    expect(updateProposalField(proposal.id, {
      verifyResult: {
        passed: true,
        diffHash: proposal.diffHash,
        verifiedAt: new Date().toISOString(),
        source: 'm398-test',
      },
    })).toBe(true);
    const goal = createGoal('M398 corrupt goal projection recovery', { project: tmpRepo });
    const milestone = addMilestone(goal.id, {
      title: 'Recover linked goal',
      detail: 'Keep fanout unacknowledged until the goal source is healthy.',
    })!.milestones[0]!;
    expect(updateMilestoneStatus(goal.id, milestone.id, 'proposed', { proposalId: proposal.id })).not.toBeNull();

    const goalFile = path.join(tmpHome, '.ashlr', 'goals', `${goal.id}.json`);
    const healthyGoalSource = fs.readFileSync(goalFile, 'utf8');
    fs.writeFileSync(goalFile, '{"corrupt":', { mode: 0o600 });
    expect(listGoalsDetailed()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      unreadableFiles: 1,
    });

    expect(await autoMergeProposal(proposal.id, config())).toMatchObject({ ok: true, merged: true });
    expect(loadProposal(proposal.id)?.status).toBe('applied');
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBeUndefined();
    expect(loadGoal(goal.id)).toBeNull();

    fs.writeFileSync(goalFile, healthyGoalSource, { mode: 0o600 });
    expect(listGoalsDetailed()).toMatchObject({ sourceState: 'healthy', complete: true });
    expect(replayRealizedMergeFanout(proposal.id, undefined, () => true)).toBe(true);
    expect(loadProposal(proposal.id)?.realizedMergeFanoutVersion).toBe(3);
    expect(loadGoal(goal.id)?.milestones[0]?.status).toBe('done');
  });
});

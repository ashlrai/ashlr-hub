import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hashDiff,
  signProvenance,
  verifyPendingProposalAuthorityV1,
  verifyProducerProvenanceV2,
  verifyProvenance,
} from '../src/core/foundry/provenance.js';
import {
  createProposal,
  inboxDir,
  isDiffDedupResult,
  listProposals,
  loadProposal,
} from '../src/core/inbox/store.js';
import { isAuthoritativeDurablePendingProposal } from '../src/core/inbox/pending-authority.js';
import { selectInboxStore } from '../src/core/seams/inbox.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

const DIFF_A = 'diff --git a/src/a.ts b/src/a.ts\n+export const value = 1;\n';
const DIFF_B = 'diff --git a/src/b.ts b/src/b.ts\n+export const value = 2;\n';
const GENERATION_A = 'a'.repeat(64);
const GENERATION_B = 'b'.repeat(64);

let priorHome: string | undefined;
let priorAllowAnyRepo: string | undefined;
let priorPulseUrl: string | undefined;
let home: string;
let repoA: string;
let repoB: string;

beforeEach(() => {
  priorHome = process.env.HOME;
  priorAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  priorPulseUrl = process.env.PULSE_URL;
  home = mkdtempSync(join(tmpdir(), 'ashlr-proposal-dedup-authority-'));
  repoA = join(home, 'repo-a');
  repoB = join(home, 'repo-b');
  mkdirSync(repoA);
  mkdirSync(repoB);
  process.env.HOME = home;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  delete process.env.PULSE_URL;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = priorAllowAnyRepo;
  if (priorPulseUrl === undefined) delete process.env.PULSE_URL;
  else process.env.PULSE_URL = priorPulseUrl;
  rmSync(home, { recursive: true, force: true });
});

function proposalInput(
  repo: string,
  overrides: Partial<Omit<Proposal, 'id' | 'status' | 'createdAt'>> = {},
): Omit<Proposal, 'id' | 'status' | 'createdAt'> {
  const diff = overrides.diff ?? DIFF_A;
  const diffHash = overrides.diffHash ?? hashDiff(diff);
  const engineModel = overrides.engineModel ?? 'local-coder:mock-model';
  const engineTier = overrides.engineTier ?? 'mid';
  const runId = overrides.runId ?? 'run-proposal-dedup-authority';
  return {
    repo,
    origin: 'agent',
    kind: 'patch',
    title: 'same work retry',
    summary: 'same canonical change',
    diff,
    diffHash,
    engineModel,
    engineTier,
    provenanceSig: overrides.provenanceSig ?? signProvenance(engineModel, engineTier, diffHash),
    workItemId: 'issue:authority-fix',
    workItemGenerationId: GENERATION_A,
    runId,
    trajectoryId: `run:${runId}`,
    runEventSummary: {
      runId,
      status: 'done',
      outcome: 'filed',
      proposalCreated: true,
    },
    ...overrides,
  };
}

function rewriteProposal(id: string, mutate: (proposal: Proposal) => void): void {
  const path = join(inboxDir(), `${id}.json`);
  const proposal = JSON.parse(readFileSync(path, 'utf8')) as Proposal;
  mutate(proposal);
  writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function durableProposalFiles(): string[] {
  return readdirSync(inboxDir()).filter((file) => file.endsWith('.json')).sort();
}

describe('proposal dedup authority', () => {
  it('signs every current authority field and rejects field-by-field tampering', () => {
    const proposal = createProposal(proposalInput(repoA, {
      sandboxId: 'sandbox-authority',
      workSource: 'issue',
      runEventSummary: {
        runId: 'run-proposal-dedup-authority',
        status: 'done',
        outcome: 'filed',
        proposalCreated: true,
        actionCounts: {
          proposalCreated: 1,
          proposalBlocked: 0,
          proposalDisabled: 0,
          modelSteps: 1,
          toolSteps: 0,
          totalSteps: 1,
        },
      },
    }));

    expect(proposal).toMatchObject({
      producerStatus: 'done',
      pendingAuthorityVersion: 1,
      pendingAuthoritySig: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(verifyPendingProposalAuthorityV1(proposal).ok).toBe(true);

    const mutations: Array<[string, (candidate: Proposal) => void]> = [
      ['id', (candidate) => { candidate.id = 'prop-replaced'; }],
      ['repo', (candidate) => { candidate.repo = repoB; }],
      ['origin', (candidate) => { candidate.origin = 'manual'; }],
      ['kind', (candidate) => { candidate.kind = 'pr'; }],
      ['sandbox', (candidate) => { candidate.sandboxId = 'sandbox-replaced'; }],
      ['work item', (candidate) => { candidate.workItemId = 'issue:replaced'; }],
      ['generation', (candidate) => { candidate.workItemGenerationId = GENERATION_B; }],
      ['work source', (candidate) => { candidate.workSource = 'goal'; }],
      ['run', (candidate) => { candidate.runId = 'run-replaced'; }],
      ['trajectory', (candidate) => { candidate.trajectoryId = 'run:run-replaced'; }],
      ['summary', (candidate) => { candidate.runEventSummary = { ...candidate.runEventSummary, costUsd: 99 }; }],
      ['producer status', (candidate) => { candidate.producerStatus = 'failed'; }],
      ['partial status', (candidate) => { candidate.isPartial = true; }],
      ['diff bytes', (candidate) => { candidate.diff = DIFF_B; }],
      ['diff hash', (candidate) => { candidate.diffHash = hashDiff(DIFF_B); }],
      ['model', (candidate) => { candidate.engineModel = 'local-coder:replaced'; }],
      ['tier', (candidate) => { candidate.engineTier = 'frontier'; }],
      ['legacy signature', (candidate) => { candidate.provenanceSig = '0'.repeat(64); }],
      ['producer version', (candidate) => { candidate.producerProvenanceVersion = undefined; }],
      ['producer signature', (candidate) => { candidate.producerProvenanceSig = '0'.repeat(64); }],
      ['created at', (candidate) => { candidate.createdAt = new Date(Date.now() - 1_000).toISOString(); }],
      ['status', (candidate) => { candidate.status = 'rejected'; }],
      ['authority version', (candidate) => { candidate.pendingAuthorityVersion = undefined; }],
      ['authority signature', (candidate) => { candidate.pendingAuthoritySig = '0'.repeat(64); }],
    ];
    for (const [field, mutate] of mutations) {
      const candidate = structuredClone(proposal);
      mutate(candidate);
      expect(verifyPendingProposalAuthorityV1(candidate).ok, field).toBe(false);
    }
  });

  it('keeps legacy and producer-v2-only rows observational', () => {
    const proposal = createProposal(proposalInput(repoA, { workSource: 'issue' }));
    expect(verifyProvenance(proposal).ok).toBe(true);
    expect(verifyProducerProvenanceV2(proposal).ok).toBe(true);

    const legacy = structuredClone(proposal);
    delete legacy.pendingAuthorityVersion;
    delete legacy.pendingAuthoritySig;

    expect(verifyProvenance(legacy).ok).toBe(true);
    expect(verifyProducerProvenanceV2(legacy).ok).toBe(true);
    expect(isAuthoritativeDurablePendingProposal(legacy, {
      id: legacy.id,
      repo: repoA,
      origin: 'agent',
      kind: 'patch',
      diff: legacy.diff,
      diffHash: legacy.diffHash,
      runId: legacy.runId,
      trajectoryId: legacy.trajectoryId,
      workItemId: legacy.workItemId,
      workItemGenerationId: legacy.workItemGenerationId,
      isPartial: false,
    })).toBe(false);
  });

  it('does not let a legacy producer-v2 row suppress a current canonical attempt', () => {
    const legacy = createProposal(proposalInput(repoA, { workSource: 'issue' }));
    rewriteProposal(legacy.id, (proposal) => {
      delete proposal.pendingAuthorityVersion;
      delete proposal.pendingAuthoritySig;
    });

    const current = createProposal(proposalInput(repoA, { workSource: 'issue' }));

    expect(current.status).toBe('pending');
    expect(current.id).not.toBe(legacy.id);
    expect(current.pendingAuthorityVersion).toBe(1);
    expect(listProposals({ status: 'pending' })).toHaveLength(2);
  });

  it.each([
    ['created scalar versus count', { proposalCreated: 0, proposalBlocked: 1, proposalDisabled: 0, totalSteps: 0 }],
    ['mutually exclusive outcomes', { proposalCreated: 1, proposalBlocked: 1, proposalDisabled: 0, totalSteps: 0 }],
    ['disabled contradiction', { proposalCreated: 1, proposalBlocked: 0, proposalDisabled: 1, totalSteps: 0 }],
    ['impossible step components', { proposalCreated: 1, proposalBlocked: 0, proposalDisabled: 0, modelSteps: 5, toolSteps: 5, totalSteps: 1 }],
    ['non-reconciling step total', { proposalCreated: 1, proposalBlocked: 0, proposalDisabled: 0, modelSteps: 1, toolSteps: 1, totalSteps: 3 }],
    ['missing total steps', { proposalCreated: 1, proposalBlocked: 0, proposalDisabled: 0, modelSteps: 1 }],
    ['retries beyond spawns', { proposalCreated: 1, proposalBlocked: 0, proposalDisabled: 0, transientRetries: 2, spawnAttempts: 1, totalSteps: 0 }],
    ['unbounded component', { proposalCreated: 1, proposalBlocked: 0, proposalDisabled: 0, modelSteps: 1_000_000_001, totalSteps: 1_000_000_001 }],
  ])('withholds current authority for contradictory action counts: %s', (_case, actionCounts) => {
    const proposal = createProposal(proposalInput(repoA, {
      runId: `run-contradiction-${_case.replace(/\s+/g, '-')}`,
      trajectoryId: `run:run-contradiction-${_case.replace(/\s+/g, '-')}`,
      runEventSummary: {
        runId: `run-contradiction-${_case.replace(/\s+/g, '-')}`,
        status: 'done',
        outcome: 'filed',
        proposalCreated: true,
        actionCounts,
      },
    }));

    expect(proposal.status).toBe('pending');
    expect(proposal.pendingAuthorityVersion).toBeUndefined();
    expect(isAuthoritativeDurablePendingProposal(proposal, {
      id: proposal.id,
      repo: repoA,
      origin: 'agent',
      kind: 'patch',
      diff: proposal.diff,
      diffHash: proposal.diffHash,
      runId: proposal.runId,
      trajectoryId: proposal.trajectoryId,
      workItemId: proposal.workItemId,
      workItemGenerationId: proposal.workItemGenerationId,
      isPartial: false,
    })).toBe(false);
  });

  it.each([
    ['failed full producer', false, 'failed', 'filed', true],
    ['blocked full producer', false, 'done', 'gate-blocked', true],
    ['non-created full producer', false, 'done', 'filed', false],
    ['done partial producer', true, 'done', 'gate-blocked', false],
    ['filed partial producer', true, 'failed', 'filed', false],
  ] as const)(
    'withholds current authority for contradictory producer outcome: %s',
    (_case, isPartial, status, outcome, proposalCreated) => {
      const runId = `run-outcome-${_case.replace(/\s+/g, '-')}`;
      const proposal = createProposal(proposalInput(repoA, {
        runId,
        trajectoryId: `run:${runId}`,
        isPartial,
        producerStatus: status,
        runEventSummary: { runId, status, outcome, proposalCreated },
      }));

      expect(proposal.pendingAuthorityVersion).toBeUndefined();
      expect(verifyPendingProposalAuthorityV1(proposal).ok).toBe(false);
    },
  );

  it('signs an exact failed-producer partial without granting creation truth', () => {
    const runId = 'run-partial-authority';
    const proposal = createProposal(proposalInput(repoA, {
      runId,
      trajectoryId: `run:${runId}`,
      isPartial: true,
      producerStatus: 'failed',
      runEventSummary: {
        runId,
        status: 'failed',
        outcome: 'gate-blocked',
        proposalCreated: false,
        actionCounts: {
          proposalCreated: 0,
          proposalBlocked: 1,
          proposalDisabled: 0,
          modelSteps: 1,
          totalSteps: 1,
        },
      },
    }));

    expect(proposal).toMatchObject({
      isPartial: true,
      producerStatus: 'failed',
      pendingAuthorityVersion: 1,
      runEventSummary: {
        status: 'failed',
        outcome: 'gate-blocked',
        proposalCreated: false,
      },
    });
    expect(proposal.runEventSummary?.proposalId).toBeUndefined();
    expect(isAuthoritativeDurablePendingProposal(proposal, {
      id: proposal.id,
      repo: repoA,
      origin: 'agent',
      kind: 'patch',
      diff: proposal.diff,
      diffHash: proposal.diffHash,
      runId,
      trajectoryId: `run:${runId}`,
      workItemId: proposal.workItemId,
      workItemGenerationId: proposal.workItemGenerationId,
      isPartial: true,
    })).toBe(true);
  });

  it('requires canonical bytes, provenance, freshness, and exact causal filing identity', () => {
    const input = proposalInput(repoA);
    const proposal = createProposal(input);
    const expected = {
      id: proposal.id,
      repo: repoA,
      origin: 'agent' as const,
      kind: 'patch' as const,
      diff: input.diff,
      diffHash: input.diffHash,
      runId: input.runId,
      trajectoryId: input.trajectoryId,
      workItemId: input.workItemId,
      workItemGenerationId: input.workItemGenerationId,
      isPartial: false,
    };
    const velocityCfg = {
      foundry: {
        productionVelocity: {
          enabled: true,
          profile: 'resource-control',
          stalePendingTtlHours: 24,
        },
      },
    } as AshlrConfig;

    expect(isAuthoritativeDurablePendingProposal(proposal, expected, velocityCfg)).toBe(true);
    expect(isAuthoritativeDurablePendingProposal({
      ...proposal,
      diff: `${proposal.diff}\n# replaced bytes`,
    }, expected, velocityCfg)).toBe(false);
    expect(isAuthoritativeDurablePendingProposal({
      ...proposal,
      provenanceSig: '0'.repeat(64),
    }, expected, velocityCfg)).toBe(false);
    expect(isAuthoritativeDurablePendingProposal({
      ...proposal,
      runEventSummary: { ...proposal.runEventSummary, proposalId: 'replaced-row' },
    }, expected, velocityCfg)).toBe(false);
    expect(isAuthoritativeDurablePendingProposal({
      ...proposal,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    }, expected, velocityCfg)).toBe(false);
  });

  it('files identical canonical diffs independently across repositories', () => {
    const first = createProposal(proposalInput(repoA));
    const second = createProposal(proposalInput(repoB));

    expect(first.status).toBe('pending');
    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
    expect(listProposals({ status: 'pending' })).toHaveLength(2);
  });

  it.each([
    ['a different work item', { workItemId: 'issue:other-work' }],
    ['a different generation', { workItemGenerationId: GENERATION_B }],
    ['a missing generation', { workItemGenerationId: undefined }],
  ])('files identical diffs for %s instead of inheriting prior work authority', (_case, authority) => {
    const first = createProposal(proposalInput(repoA));
    const second = createProposal(proposalInput(repoA, authority));

    expect(first.status).toBe('pending');
    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
    expect(listProposals({ status: 'pending' })).toHaveLength(2);
  });

  it('threads production-velocity freshness through the inbox seam without rejecting stale work', () => {
    const first = createProposal(proposalInput(repoA));
    rewriteProposal(first.id, (proposal) => {
      proposal.createdAt = new Date(Date.now() - (48 * 60 * 60 * 1000)).toISOString();
    });
    const cfg = {
      version: 1,
      foundry: {
        productionVelocity: {
          enabled: true,
          profile: 'resource-control',
          stalePendingTtlHours: 24,
        },
      },
    } as AshlrConfig;

    const second = selectInboxStore(cfg).create(proposalInput(repoA));

    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
    expect(listProposals({ status: 'pending' })).toHaveLength(2);
    expect(listProposals().find((proposal) => proposal.id === first.id)?.status).toBe('pending');
  });

  it('does not let a forged stored hash suppress different canonical diff bytes', () => {
    const first = createProposal(proposalInput(repoA));
    rewriteProposal(first.id, (proposal) => {
      proposal.diffHash = hashDiff(DIFF_B);
    });

    const second = createProposal(proposalInput(repoA, {
      diff: DIFF_B,
      diffHash: hashDiff(DIFF_B),
    }));

    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
    expect(listProposals({ status: 'pending' })).toHaveLength(2);
  });

  it('fails closed instead of returning a synthetic dedup rejection for a manual proposal on a degraded source', () => {
    const first = createProposal(proposalInput(repoA));
    writeFileSync(join(inboxDir(), 'invalid.json'), '{not-json\n', { encoding: 'utf8', mode: 0o600 });
    const manual = createProposal(proposalInput(repoA, { origin: 'manual' }));

    expect(first.status).toBe('pending');
    expect(manual.status).toBe('failed');
    expect(manual.creationFailureCode).toBe('admission-source-incomplete');
    expect(manual.id).not.toBe(first.id);
    expect(isDiffDedupResult(manual)).toBe(false);
    expect(loadProposal(manual.id)).toBeNull();
  });

  it.runIf(process.platform !== 'win32')(
    'atomically admits one durable proposal for concurrent same-work duplicates',
    async () => {
      const storeUrl = pathToFileURL(resolve('src/core/inbox/store.ts')).href;
      const input = proposalInput(join(repoA, 'missing', '..'));
      const script = [
        `import { createProposal } from ${JSON.stringify(storeUrl)};`,
        `const result = createProposal(${JSON.stringify(input)});`,
        "process.stdout.write(JSON.stringify({ id: result.id, status: result.status, reason: result.decisionReason }));",
      ].join('\n');
      const tsx = resolve('node_modules/.bin/tsx');
      const runChild = (): Promise<{ id: string; status: string; reason?: string }> =>
        new Promise((resolveChild, rejectChild) => {
          const child = spawn(tsx, ['-e', script], {
            env: {
              ...process.env,
              HOME: home,
              ASHLR_TEST_ALLOW_ANY_REPO: '1',
              PULSE_URL: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
          child.once('error', rejectChild);
          child.once('close', (code) => {
            if (code !== 0) {
              rejectChild(new Error(`proposal child exited ${code}: ${stderr}`));
              return;
            }
            resolveChild(JSON.parse(stdout) as { id: string; status: string; reason?: string });
          });
        });

      const results = await Promise.all([runChild(), runChild()]);

      expect(results.map((result) => result.status).sort()).toEqual(['pending', 'rejected']);
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.find((result) => result.status === 'rejected')?.reason).toContain('diffHash dedup');
      expect(durableProposalFiles()).toHaveLength(1);
      expect(listProposals({ status: 'pending' })).toHaveLength(1);
    },
    15_000,
  );
});

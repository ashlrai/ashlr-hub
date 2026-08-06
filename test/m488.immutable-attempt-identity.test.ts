import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSignedAutonomyEvidencePackV3,
  persistAutonomyEvidencePack,
  verifyAutonomyEvidencePackV3,
} from '../src/core/autonomy/evidence-pack.js';
import { listOutcomeRecords } from '../src/core/autonomy/outcome-records.js';
import { listTrajectoryRecords } from '../src/core/autonomy/trajectory-records.js';
import {
  coherentOuterAttemptIdentity,
  createOuterAttemptIdentity,
  deriveCandidateAttemptIdentity,
} from '../src/core/fleet/attempt-identity.js';
import {
  materializeDispatchProductionAttemptEnvelope,
  sanitizeDispatchProductionEvent,
} from '../src/core/fleet/dispatch-production-ledger.js';
import { sanitizeDispatchManifestEvent } from '../src/core/fleet/dispatch-manifest.js';
import {
  buildPostMergeObservation,
  recordPostMergeObservation,
  verifyPostMergeObservation,
} from '../src/core/fleet/post-merge-observations.js';
import { createProposal } from '../src/core/inbox/store.js';
import { loadRun, saveRun } from '../src/core/run/orchestrator.js';
import type { RunState } from '../src/core/types.js';

let home: string;
let repo: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m488-attempt-'));
  repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

function runState(
  id: string,
  now: string,
  attemptId?: string,
  attemptCandidateIndex?: number,
): RunState {
  return {
    id,
    ...(attemptId ? { attemptId } : {}),
    ...(attemptCandidateIndex !== undefined ? { attemptCandidateIndex } : {}),
    goal: 'metadata-only identity test',
    engine: 'codex',
    provider: 'external',
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 100, maxSteps: 1, allowCloud: true },
    usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0.01 },
    tasks: [],
    steps: [],
    status: 'done',
  };
}

describe('M488 immutable metadata-only attempt identity', () => {
  it('carries one writer-issued identity across the route-to-outcome record graph', () => {
    const now = new Date().toISOString();
    const attemptId = createOuterAttemptIdentity();
    const trajectoryId = `run:${attemptId}`;
    const itemId = 'test:immutable-attempt';

    const manifest = sanitizeDispatchManifestEvent({
      schemaVersion: 1,
      manifestId: 'dm-20260806120000-m488test',
      ts: now,
      mode: 'concurrent',
      dryRun: false,
      claimedItemIds: [itemId],
      assignments: [{
        itemId,
        attemptId,
        source: 'test',
        repo,
        title: 'attempt identity fixture',
        backend: 'codex',
      }],
      unassigned: [],
      slots: { codex: 1 },
      backendCounts: { codex: 1 },
      counts: { claimed: 1, assigned: 1, unassigned: 0 },
    });
    expect(manifest.assignments[0]?.attemptId).toBe(attemptId);

    saveRun(runState(attemptId, now));
    expect(loadRun(attemptId)).toMatchObject({
      id: attemptId,
      attemptId,
      trajectoryId,
    });

    const proposal = createProposal({
      repo,
      origin: 'agent',
      kind: 'note',
      title: 'Immutable attempt identity',
      summary: 'Bounded metadata-only proposal record.',
      workItemId: itemId,
      workSource: 'test',
      runId: attemptId,
      trajectoryId,
      runEventSummary: {
        runId: attemptId,
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
      },
    });
    expect(proposal).toMatchObject({ attemptId, runId: attemptId, trajectoryId });

    const dispatch = sanitizeDispatchProductionEvent(materializeDispatchProductionAttemptEnvelope({
      schemaVersion: 1,
      ts: now,
      itemId,
      source: 'test',
      repo,
      title: 'attempt identity fixture',
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.5',
      assignedBy: 'test-router',
      routeReason: 'focused identity fixture',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: proposal.id,
      attemptId,
      runId: attemptId,
      trajectoryId,
      spentUsd: 0.01,
      basis: 'run-proposal-outcome',
    }));
    expect(dispatch).toMatchObject({ attemptId, runId: attemptId, trajectoryId });

    const evidence = buildSignedAutonomyEvidencePackV3({
      proposal,
      target: 'proposal',
      trustBasis: 'tier',
      remotePreferred: false,
      riskClass: 'low',
      authority: { ok: true, detail: 'proposal-only observation' },
      provenance: { ok: false, detail: 'not merge authority' },
      verification: { passed: false, detail: 'not evaluated', commandKinds: [] },
      risk: { ok: true, detail: 'metadata-only test' },
      scope: { ok: true, detail: 'no repository mutation' },
    });
    expect(evidence).toMatchObject({ trajectoryId });
    expect(evidence).not.toHaveProperty('attemptId');
    expect(verifyAutonomyEvidencePackV3(evidence)).toMatchObject({ ok: true });
    expect(verifyAutonomyEvidencePackV3({
      ...evidence!,
      attemptId: createOuterAttemptIdentity(),
    })).toMatchObject({ ok: false });
    expect(persistAutonomyEvidencePack(evidence!)).toBe(true);

    const observation = buildPostMergeObservation({
      observedAt: now,
      outcome: 'followed-up',
      basis: 'overlapping-fix',
      confidence: 'heuristic',
      repo,
      proposalId: proposal.id,
      runId: attemptId,
      trajectoryId,
      workItemId: itemId,
      mergeCommit: 'a'.repeat(40),
      observedHead: 'b'.repeat(40),
    });
    expect(observation).toMatchObject({ runId: attemptId, trajectoryId });
    expect(observation).not.toHaveProperty('attemptId');
    expect(verifyPostMergeObservation(observation)).toBe(true);
    expect(recordPostMergeObservation(observation!)).toMatchObject({ recorded: 1 });

    const outcomes = listOutcomeRecords({ limit: 10 });
    const outcome = outcomes.find((candidate) => candidate.proposal.id === proposal.id);
    expect(outcome?.proposal.attemptId).toBe(attemptId);
    expect(outcome?.evidencePacks[0]).not.toHaveProperty('attemptId');
    expect(outcome?.postMergeObservations?.[0]).not.toHaveProperty('attemptId');

    const trajectory = listTrajectoryRecords({
      windowHours: 1,
      limit: 10,
      deps: {
        readDispatchProductionEvents: () => [dispatch],
        listOutcomeRecords: () => outcome ? [outcome] : [],
        readAgentActions: () => [],
        readSkillUseEvents: () => [],
        loadProposal: () => proposal,
      },
    }).find((candidate) => candidate.attemptId === attemptId);
    expect(trajectory).toMatchObject({
      attemptId,
      runId: attemptId,
      trajectoryId,
      coverage: { dispatch: true, proposal: true, evidence: true },
    });
    expect(new Set(trajectory?.timeline.flatMap((event) =>
      event.attemptId ? [event.attemptId] : []))).toEqual(new Set([attemptId]));
  });

  it('keeps outer and Best-of-N child identities distinct and rejects mismatched ordinals', () => {
    const now = new Date().toISOString();
    const attemptId = createOuterAttemptIdentity();
    const childRunId = deriveCandidateAttemptIdentity(attemptId, 2);
    const trajectoryId = `run:${childRunId}`;

    expect(coherentOuterAttemptIdentity({
      attemptId,
      runId: childRunId,
      trajectoryId,
      attemptCandidateIndex: 2,
    })).toBe(attemptId);
    expect(coherentOuterAttemptIdentity({
      attemptId,
      runId: childRunId,
      trajectoryId,
      attemptCandidateIndex: 1,
    })).toBeUndefined();

    saveRun(runState(childRunId, now, attemptId, 2));
    expect(loadRun(childRunId)).toMatchObject({
      id: childRunId,
      attemptId,
      attemptCandidateIndex: 2,
      trajectoryId,
    });

    const proposal = createProposal({
      repo,
      origin: 'agent',
      kind: 'note',
      title: 'Best-of-N child identity',
      summary: 'Outer attempt and child run remain separate metadata.',
      runId: childRunId,
      attemptId,
      attemptCandidateIndex: 2,
      trajectoryId,
      runEventSummary: {
        runId: childRunId,
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
      },
    });
    expect(proposal).toMatchObject({ attemptId, attemptCandidateIndex: 2, runId: childRunId });

    const mismatched = createProposal({
      repo,
      origin: 'agent',
      kind: 'note',
      title: 'Mismatched child identity',
      summary: 'Invalid ordinal must be scrubbed.',
      runId: childRunId,
      attemptId,
      attemptCandidateIndex: 1,
      trajectoryId,
    });
    expect(mismatched).not.toHaveProperty('attemptId');
    expect(mismatched).not.toHaveProperty('attemptCandidateIndex');
  });

  it('keeps Evidence V3 and Post-Merge V1 wire shapes readable across mixed versions', () => {
    const now = new Date().toISOString();
    const attemptId = createOuterAttemptIdentity();
    const proposal = createProposal({
      repo,
      origin: 'agent',
      kind: 'note',
      title: 'Rollback-compatible identity metadata',
      summary: 'Signed formats remain unchanged while the proposal carries the join key.',
      runId: attemptId,
      attemptId,
      trajectoryId: `run:${attemptId}`,
      runEventSummary: { runId: attemptId, status: 'done', outcome: 'filed' },
    });
    const evidence = buildSignedAutonomyEvidencePackV3({
      proposal,
      target: 'proposal',
      trustBasis: 'tier',
      remotePreferred: false,
      riskClass: 'low',
      authority: { ok: true, detail: 'proposal-only observation' },
      provenance: { ok: false, detail: 'not merge authority' },
      verification: { passed: false, detail: 'not evaluated', commandKinds: [] },
      risk: { ok: true, detail: 'metadata-only test' },
      scope: { ok: true, detail: 'no repository mutation' },
    });
    const observation = buildPostMergeObservation({
      observedAt: now,
      outcome: 'followed-up',
      basis: 'overlapping-fix',
      confidence: 'heuristic',
      repo,
      proposalId: proposal.id,
      runId: attemptId,
      trajectoryId: `run:${attemptId}`,
      mergeCommit: 'e'.repeat(40),
      observedHead: 'f'.repeat(40),
    });

    expect(evidence).not.toHaveProperty('attemptId');
    expect(observation).not.toHaveProperty('attemptId');
    expect(verifyAutonomyEvidencePackV3(evidence)).toMatchObject({ ok: true });
    expect(verifyPostMergeObservation(observation)).toBe(true);
    expect(verifyAutonomyEvidencePackV3({ ...evidence!, attemptId })).toMatchObject({ ok: false });
    expect(verifyPostMergeObservation({ ...observation!, attemptId })).toBe(false);
  });

  it('drops malformed or conflicting aliases and keeps legacy records readable', () => {
    const now = new Date().toISOString();
    const attemptId = createOuterAttemptIdentity();
    const hostile = '../RAW_PROMPT RAW_DIFF RAW_STDOUT RAW_STDERR SECRET_TOKEN';
    expect(coherentOuterAttemptIdentity({ attemptId: hostile })).toBeUndefined();
    expect(coherentOuterAttemptIdentity({
      attemptId,
      runId: 'different-run',
      trajectoryId: `run:${attemptId}`,
    })).toBeUndefined();

    saveRun(runState('legacy-run', now, hostile));
    expect(loadRun('legacy-run')).not.toHaveProperty('attemptId');

    const legacyProposal = createProposal({
      repo,
      origin: 'manual',
      kind: 'note',
      title: 'Legacy proposal',
      summary: 'No outer attempt identity.',
      runId: 'legacy-run',
      attemptId,
      trajectoryId: 'run:legacy-run',
    });
    expect(legacyProposal).not.toHaveProperty('attemptId');

    const legacyObservation = buildPostMergeObservation({
      observedAt: now,
      outcome: 'reverted',
      basis: 'git-revert-reference',
      confidence: 'deterministic',
      repo,
      proposalId: legacyProposal.id,
      runId: 'legacy-run',
      trajectoryId: 'run:legacy-run',
      mergeCommit: 'c'.repeat(40),
      observedHead: 'd'.repeat(40),
    });
    expect(legacyObservation).not.toHaveProperty('attemptId');
    expect(verifyPostMergeObservation(legacyObservation)).toBe(true);

    const serialized = JSON.stringify({
      attemptId: legacyProposal.attemptId,
      observation: legacyObservation,
    });
    expect(serialized).not.toContain('RAW_PROMPT');
    expect(serialized).not.toContain('RAW_DIFF');
    expect(serialized).not.toContain('RAW_STDOUT');
    expect(serialized).not.toContain('RAW_STDERR');
    expect(serialized).not.toContain('SECRET_TOKEN');
  });
});

/**
 * M504 — real-store authority proof for supervised goal --direct correlation.
 *
 * This does not run an engine. It proves that the exact metadata shape emitted
 * by direct mode can be signed, durably reloaded, and validated without a work
 * generation, and that field substitution or duplicate run identity fails the
 * resolver's prerequisites.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import { isAuthoritativeDurablePendingProposal } from '../src/core/inbox/pending-authority.js';
import { createProposal, listProposalsDetailed, loadProposal } from '../src/core/inbox/store.js';
import type { Proposal } from '../src/core/types.js';

const DIFF_A = 'diff --git a/docs/a.md b/docs/a.md\n+direct authority a\n';
const DIFF_B = 'diff --git a/docs/b.md b/docs/b.md\n+direct authority b\n';

let priorHome: string | undefined;
let priorAllowAnyRepo: string | undefined;
let priorPulseUrl: string | undefined;
let home: string;
let repo: string;

beforeEach(() => {
  priorHome = process.env.HOME;
  priorAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  priorPulseUrl = process.env.PULSE_URL;
  home = mkdtempSync(join(tmpdir(), 'ashlr-goal-direct-authority-'));
  repo = join(home, 'repo');
  mkdirSync(repo);
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

function directProposalInput(diff: string, runId: string, workItemId: string) {
  const diffHash = hashDiff(diff);
  const engineModel = 'codex:test-direct-authority';
  const engineTier = 'frontier' as const;
  return {
    repo,
    origin: 'agent' as const,
    kind: 'patch' as const,
    title: 'direct authority fixture',
    summary: 'prove exact direct proposal authority',
    diff,
    diffHash,
    engineModel,
    engineTier,
    provenanceSig: signProvenance(engineModel, engineTier, diffHash),
    workSource: 'goal',
    workItemId,
    runId,
    trajectoryId: `run:${runId}`,
    producerStatus: 'done' as const,
    runEventSummary: {
      runId,
      status: 'done',
      outcome: 'filed',
      proposalCreated: true,
    },
  };
}

function expectedAuthority(proposal: Proposal, workItemId: string) {
  return {
    id: proposal.id,
    repo,
    origin: 'agent' as const,
    kind: 'patch' as const,
    diff: proposal.diff,
    diffHash: proposal.diffHash,
    runId: proposal.runId!,
    trajectoryId: proposal.trajectoryId!,
    workItemId,
    workItemGenerationId: undefined,
    isPartial: false,
  };
}

describe('goal --direct real pending authority', () => {
  it('signs, reloads, and validates one exact direct run without a generation', () => {
    const runId = `run-${randomUUID()}`;
    const workItemId = `direct-${randomUUID()}`;
    const created = createProposal(directProposalInput(DIFF_A, runId, workItemId));
    const read = listProposalsDetailed({ requireComplete: true });
    const durable = loadProposal(created.id);

    expect(read).toMatchObject({
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      invalidFiles: 0,
      unreadableFiles: 0,
    });
    expect(read.proposals.map((proposal) => proposal.id)).toEqual([created.id]);
    expect(durable).not.toBeNull();
    expect(durable?.workItemGenerationId).toBeUndefined();
    expect(durable?.pendingAuthorityVersion).toBe(1);
    expect(isAuthoritativeDurablePendingProposal(durable, expectedAuthority(created, workItemId))).toBe(true);

    for (const mutate of [
      (candidate: Proposal) => { candidate.workItemId = 'direct-substituted'; },
      (candidate: Proposal) => { candidate.runId = 'run-substituted'; },
      (candidate: Proposal) => { candidate.trajectoryId = 'run:substituted'; },
      (candidate: Proposal) => { candidate.diffHash = '0'.repeat(64); },
    ]) {
      const tampered = structuredClone(durable!);
      mutate(tampered);
      expect(isAuthoritativeDurablePendingProposal(tampered, expectedAuthority(created, workItemId))).toBe(false);
    }
  });

  it('exposes duplicate durable rows carrying one run identity to fail-closed cardinality checks', () => {
    const runId = `run-${randomUUID()}`;
    createProposal(directProposalInput(DIFF_A, runId, `direct-${randomUUID()}`));
    createProposal(directProposalInput(DIFF_B, runId, `direct-${randomUUID()}`));

    const read = listProposalsDetailed({ requireComplete: true });
    const sameRun = read.proposals.filter((proposal) => proposal.runId === runId);

    expect(read).toMatchObject({ sourceState: 'healthy', complete: true });
    expect(sameRun).toHaveLength(2);
    expect(sameRun.every((proposal) => proposal.pendingAuthorityVersion === 1)).toBe(true);
  });
});

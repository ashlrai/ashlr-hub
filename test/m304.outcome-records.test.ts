/**
 * m304.outcome-records.test.ts — first read-only OutcomeRecord primitive.
 *
 * Verifies that existing proposal, decision, judge, worked, racing, and
 * autonomy evidence stores are joined into bounded newest-first records without
 * adding writes or failing on missing/corrupt optional inputs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  sealAutonomyEvidencePackV3,
  type AutonomyEvidencePack,
  type AutonomyEvidencePackLegacy,
  type SignedAutonomyEvidencePackV3,
} from '../src/core/autonomy/evidence-pack.js';
import type { OutcomeRecordReadDeps } from '../src/core/autonomy/outcome-records.js';
import { listOutcomeRecords, listReadyEvidenceOutcomeRecords } from '../src/core/autonomy/outcome-records.js';
import { hashDiff } from '../src/core/foundry/provenance.js';
import {
  agentSemanticSubjectRef,
  defineAgentSemanticEvents,
} from '../src/core/learning/agent-semantic-events.js';
import type { JudgeTrace } from '../src/core/fleet/judge-trace.js';
import type { WorkedEvent } from '../src/core/fleet/worked-ledger.js';
import type { PostMergeObservationReadResult } from '../src/core/fleet/post-merge-observations.js';
import type { DecisionEntry, Proposal } from '../src/core/types.js';

const TEST_DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
const TEST_DIFF_HASH = hashDiff(TEST_DIFF);
const BASE_TREE_OID = 'c'.repeat(40);
const CANDIDATE_TREE_OID = 'd'.repeat(40);
const AUTHORITY_SNAPSHOT_DIGEST = 'e'.repeat(64);
const SEMANTIC_PROPOSAL_ID = 'prop-m304abc1-000001-bbbbbbbbbbbbbbbbbbbbbbbb';
const DEGRADED_PROPOSAL_ID = 'prop-m304abc1-000002-cccccccccccccccccccccccc';
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let tmpHome: string;

function restoreEnvironment(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m304-home-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  restoreEnvironment('HOME', originalHome);
  restoreEnvironment('USERPROFILE', originalUserProfile);
});

function proposal(overrides: Partial<Proposal> & Pick<Proposal, 'id' | 'createdAt'>): Proposal {
  return {
    repo: '/repos/alpha',
    origin: 'agent',
    kind: 'patch',
    title: `proposal ${overrides.id}`,
    summary: 'outcome record test',
    status: 'pending',
    ...overrides,
  } as Proposal;
}

function decision(proposalId: string, ts: string, overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    proposalId,
    ts,
    action: 'judged',
    verdict: 'ship',
    ...overrides,
  };
}

function trace(proposalId: string, ts: string, overrides: Partial<JudgeTrace> = {}): JudgeTrace {
  return {
    proposalId,
    ts,
    judgeEngine: 'claude-test',
    verdict: 'ship',
    scores: { value: 4, correctness: 5, scope: 2, alignment: 4 },
    fullReasoning: 'not surfaced in outcome records',
    promptContext: 'not surfaced in outcome records',
    ...overrides,
  };
}

function legacyEvidence(proposalId: string, generatedAt: string): AutonomyEvidencePackLegacy {
  return {
    version: 1,
    generatedAt,
    proposal: {
      id: proposalId,
      repo: '/repos/alpha',
      kind: 'patch',
      status: 'pending',
      origin: 'agent',
      title: 'evidence proposal',
      createdAt: '2026-07-01T00:00:00.000Z',
    },
    producer: { engineModel: 'codex:gpt-5.5', engineTier: 'frontier' },
    diff: { files: ['src/a.ts'], changedLines: 4, hash: TEST_DIFF_HASH },
    target: 'main',
    trustBasis: 'tier',
    remotePreferred: false,
    riskClass: 'low',
    gates: {
      authority: { ok: true, detail: 'authority ok' },
      provenance: { ok: true, detail: 'provenance ok' },
      verification: { ok: true, detail: 'verification ok' },
      risk: { ok: true, detail: 'risk ok' },
      scope: { ok: true, detail: 'scope ok' },
    },
    verification: {
      passed: true,
      detail: 'tests passed',
      commandKinds: ['test'],
      baseBranch: 'main',
      baseHead: 'a'.repeat(40),
      diffHash: TEST_DIFF_HASH,
      verifiedAt: generatedAt,
      source: 'auto-merge',
    },
    policy: {
      tier: 'T4',
      action: 'merge-main',
      allowed: true,
      reason: 'full evidence',
    },
  };
}

function evidence(proposalId: string, generatedAt: string): SignedAutonomyEvidencePackV3 {
  const draft = legacyEvidence(proposalId, generatedAt);
  draft.proposal.createdAt = '2026-07-02T23:59:00.000Z';
  draft.trustBasis = 'evidence';
  draft.remotePreferred = true;
  Object.assign(draft.verification, {
    verifierAuthoritySnapshotVersion: 1 as const,
    verifierAuthorityObjectFormat: 'sha1' as const,
    baseTreeOid: BASE_TREE_OID,
    candidateTreeOid: CANDIDATE_TREE_OID,
    authoritySnapshotDigest: AUTHORITY_SNAPSHOT_DIGEST,
  });
  draft.gates.remoteProtection = {
    ok: true,
    detail: 'safe protected remote policy',
    live: true,
    nameWithOwner: 'ashlrai/alpha',
    repositoryId: 'R_alpha',
    branch: 'main',
    baseHead: 'a'.repeat(40),
    observedAt: generatedAt,
    requirements: ['pull-request-reviews', 'required-status-checks'],
    requiredChecks: ['CI'],
    requiredCheckBindings: [{ context: 'CI', appId: '15368' }],
    policySources: ['classic'],
    policyHash: 'b'.repeat(64),
  };
  const sealed = sealAutonomyEvidencePackV3(draft);
  if (!sealed) throw new Error('failed to seal M304 evidence fixture');
  return sealed;
}

function deps(overrides: Partial<OutcomeRecordReadDeps> = {}): OutcomeRecordReadDeps {
  return {
    listProposals: () => [],
    readDecisions: () => [],
    readJudgeTraces: () => [],
    loadWorkedLedger: () => ({ events: [] }),
    listAutonomyEvidencePacks: () => [],
    racingStats: () => ({ races: 0, frontierWinRate: 0, avgScoreDelta: 0, localWins: 0 }),
    readPostMergeObservations: () => ({
      observations: [],
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      stopReasons: [],
      filesRead: 1,
      bytesRead: 0,
      physicalRows: 0,
      invalidRows: 0,
      conflictingEvents: 0,
      duplicateRows: 0,
      supersededRows: 0,
      limitExceeded: false,
    }),
    ...overrides,
  };
}

describe('m302 listOutcomeRecords', () => {
  it('joins proposal outcomes across existing read-only stores', () => {
    const worked: WorkedEvent = {
      itemId: 'prop-new',
      outcome: 'diff',
      ts: '2026-07-03T02:00:00.000Z',
    };

    const records = listOutcomeRecords({
      deps: deps({
        listProposals: () => [
          proposal({
            id: 'prop-new',
            createdAt: '2026-07-03T00:00:00.000Z',
            status: 'approved',
            decidedAt: '2026-07-03T01:00:00.000Z',
            engineModel: 'codex:gpt-5.5',
            engineTier: 'frontier',
            riskClass: 'low',
            verifyResult: { passed: true },
            diffHash: 'sha256:test',
          }),
        ],
        readDecisions: () => [
          decision('prop-new', '2026-07-03T01:30:00.000Z', {
            action: 'merged',
            engine: 'codex',
            model: 'codex:gpt-5.5',
            workItemId: 'repo:todo:prop-new',
            workSource: 'todo',
            runId: 'run-prop-new',
          }),
        ],
        readJudgeTraces: () => [
          trace('prop-new', '2026-07-03T00:30:00.000Z', {
            outcome: 'merged',
            outcomeAt: '2026-07-03T01:45:00.000Z',
          }),
        ],
        loadWorkedLedger: () => ({ events: [worked] }),
        listAutonomyEvidencePacks: () => [legacyEvidence('prop-new', '2026-07-03T01:40:00.000Z')],
        racingStats: () => ({ races: 3, frontierWinRate: 2 / 3, avgScoreDelta: 4, localWins: 1 }),
      }),
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.proposal).toMatchObject({
      id: 'prop-new',
      status: 'approved',
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
      riskClass: 'low',
      diffHash: 'sha256:test',
    });
    expect(records[0]?.decisions).toEqual([
      expect.objectContaining({
        action: 'merged',
        model: 'codex:gpt-5.5',
        workItemId: 'repo:todo:prop-new',
        workSource: 'todo',
        runId: 'run-prop-new',
      }),
    ]);
    expect(records[0]?.judgeTraces).toEqual([
      expect.objectContaining({ verdict: 'ship', outcome: 'merged' }),
    ]);
    expect(records[0]?.evidencePacks).toEqual([
      expect.objectContaining({ target: 'main', trustBasis: 'tier' }),
    ]);
    expect(records[0]?.workedEvents).toEqual([
      expect.objectContaining({ itemId: 'prop-new', outcome: 'diff' }),
    ]);
    expect(records[0]?.racing?.races).toBe(3);
    expect(records[0]?.lastActivityAt).toBe('2026-07-03T02:00:00.000Z');
  });

  it('sorts newest-first by joined activity and applies the limit after sorting', () => {
    const records = listOutcomeRecords({
      limit: 2,
      deps: deps({
        listProposals: () => [
          proposal({ id: 'prop-old', createdAt: '2026-07-01T00:00:00.000Z' }),
          proposal({ id: 'prop-mid', createdAt: '2026-07-02T00:00:00.000Z' }),
          proposal({ id: 'prop-new', createdAt: '2026-07-01T00:00:00.000Z' }),
        ],
        readDecisions: () => [
          decision('prop-new', '2026-07-03T00:00:00.000Z'),
        ],
      }),
    });

    expect(records.map((r) => r.proposal.id)).toEqual(['prop-new', 'prop-mid']);
  });

  it('joins healthy post-merge observations and withholds degraded rows', () => {
    const observation = {
      schemaVersion: 1 as const,
      eventId: 'a'.repeat(64),
      observedAt: '2026-07-03T04:00:00.000Z',
      authority: 'observation-only' as const,
      outcome: 'regressed' as const,
      basis: 'bisect-first-bad' as const,
      confidence: 'deterministic' as const,
      repo: '/repos/alpha',
      proposalId: 'prop-observed',
      runId: 'run-observed',
      trajectoryId: 'trajectory-observed',
      mergeCommit: 'a'.repeat(40),
      observedHead: 'b'.repeat(40),
      labelBasis: 'post-merge-regression' as const,
      attestation: 'c'.repeat(64),
    };
    const healthy = deps({
      listProposals: () => [proposal({
        id: 'prop-observed',
        createdAt: '2026-07-03T00:00:00.000Z',
        runId: 'run-observed',
        trajectoryId: 'trajectory-observed',
      })],
      readPostMergeObservations: () => ({
        ...(deps().readPostMergeObservations!() as PostMergeObservationReadResult),
        observations: [observation],
        bytesRead: 512,
        physicalRows: 1,
      }),
    });

    const [record] = listOutcomeRecords({ deps: healthy });
    expect(record?.lastActivityAt).toBe(observation.observedAt);
    expect(record?.postMergeObservations).toEqual([observation]);
    expect(record?.postMergeObservationSourceQuality).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      physicalRows: 1,
    });

    const [degraded] = listOutcomeRecords({
      deps: {
        ...healthy,
        readPostMergeObservations: () => ({
          ...(healthy.readPostMergeObservations!() as PostMergeObservationReadResult),
          sourceState: 'degraded',
          complete: false,
          stopReasons: ['invalid-row'],
          invalidRows: 1,
        }),
      },
    });
    expect(degraded?.postMergeObservations).toBeUndefined();
    expect(degraded?.postMergeObservationSourceQuality).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidRows: 1,
    });
  });

  it('tolerates missing or throwing optional stores', () => {
    const records = listOutcomeRecords({
      deps: deps({
        listProposals: () => [
          proposal({ id: 'prop-safe', createdAt: '2026-07-01T00:00:00.000Z' }),
        ],
        readDecisions: () => {
          throw new Error('corrupt decisions ledger');
        },
        readJudgeTraces: () => {
          throw new Error('corrupt judge traces');
        },
        loadWorkedLedger: () => {
          throw new Error('corrupt worked ledger');
        },
        listAutonomyEvidencePacks: () => {
          throw new Error('corrupt evidence packs');
        },
        racingStats: () => {
          throw new Error('racing unavailable');
        },
      }),
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.proposal.id).toBe('prop-safe');
    expect(records[0]?.decisions).toEqual([]);
    expect(records[0]?.judgeTraces).toEqual([]);
    expect(records[0]?.evidencePacks).toEqual([]);
    expect(records[0]?.workedEvents).toEqual([]);
    expect(records[0]?.racing).toBeUndefined();
  });

  it('reads bounded ready evidence records without heavy outcome joins', () => {
    const requestedLimits: Array<number | undefined> = [];
    const loadedProposalIds: string[] = [];
    const records = listReadyEvidenceOutcomeRecords({
      limit: 2,
      now: new Date('2026-07-03T03:30:00.000Z'),
      deps: {
        listAutonomyEvidencePacks: (limit) => {
          requestedLimits.push(limit);
          return [
            evidence('prop-ready', '2026-07-03T03:00:00.000Z'),
            evidence('prop-missing', '2026-07-03T02:00:00.000Z'),
            evidence('prop-applied', '2026-07-03T01:00:00.000Z'),
            evidence('prop-ready', '2026-07-03T00:00:00.000Z'),
          ];
        },
        loadProposal: (id) => {
          loadedProposalIds.push(id);
          if (id === 'prop-ready') {
            return proposal({
              id,
              createdAt: '2026-07-02T23:59:00.000Z',
              status: 'pending',
              diff: TEST_DIFF,
              diffHash: TEST_DIFF_HASH,
              engineModel: 'codex:gpt-5.5',
              engineTier: 'frontier',
              verifyResult: {
                passed: true,
                baseBranch: 'main',
                baseHead: 'a'.repeat(40),
                verifierAuthoritySnapshotVersion: 1,
                verifierAuthorityObjectFormat: 'sha1',
                baseTreeOid: BASE_TREE_OID,
                candidateTreeOid: CANDIDATE_TREE_OID,
                authoritySnapshotDigest: AUTHORITY_SNAPSHOT_DIGEST,
                diffHash: TEST_DIFF_HASH,
                verifiedAt: '2026-07-03T03:00:00.000Z',
                source: 'auto-merge',
              },
            });
          }
          if (id === 'prop-applied') {
            return proposal({ id, createdAt: '2026-07-03T00:20:00.000Z', status: 'applied' });
          }
          return null;
        },
      },
    });

    expect(requestedLimits).toEqual([24]);
    expect(loadedProposalIds).toEqual(['prop-ready', 'prop-missing', 'prop-applied']);
    expect(records).toHaveLength(1);
    expect(records[0]?.proposal).toMatchObject({ id: 'prop-ready', status: 'pending' });
    expect(records[0]?.lastActivityAt).toBe('2026-07-03T03:00:00.000Z');
    expect(records[0]?.evidencePacks[0]?.generatedAt).toBe('2026-07-03T03:00:00.000Z');
    expect(records[0]?.decisions).toEqual([]);
    expect(records[0]?.judgeTraces).toEqual([]);
    expect(records[0]?.workedEvents).toEqual([]);
    expect(records[0]?.racing).toBeUndefined();
  });

  it('rejects replayed bindings and degraded evidence sources', () => {
    const pack = evidence('prop-ready', '2026-07-03T03:00:00.000Z');
    const degraded = [pack] as AutonomyEvidencePack[] & { sourceQuality?: Record<string, unknown> };
    Object.defineProperty(degraded, 'sourceQuality', {
      value: { sourceState: 'degraded', sourcePresent: true, complete: false },
    });
    const live = proposal({
      id: 'prop-ready',
      createdAt: '2026-07-02T23:59:00.000Z',
      status: 'pending',
      diff: TEST_DIFF,
      diffHash: TEST_DIFF_HASH,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
      verifyResult: {
        passed: true,
        baseBranch: 'main',
        baseHead: 'a'.repeat(40),
        verifierAuthoritySnapshotVersion: 1,
        verifierAuthorityObjectFormat: 'sha1',
        baseTreeOid: BASE_TREE_OID,
        candidateTreeOid: CANDIDATE_TREE_OID,
        authoritySnapshotDigest: AUTHORITY_SNAPSHOT_DIGEST,
        diffHash: TEST_DIFF_HASH,
        verifiedAt: '2026-07-03T03:00:00.000Z',
        source: 'auto-merge',
      },
    });

    expect(listReadyEvidenceOutcomeRecords({
      now: new Date('2026-07-03T03:30:00.000Z'),
      deps: { listAutonomyEvidencePacks: () => degraded as AutonomyEvidencePack[], loadProposal: () => live },
    })).toEqual([]);

    const replayed = { ...pack, verification: { ...pack.verification, baseHead: 'b'.repeat(40) } };
    expect(listReadyEvidenceOutcomeRecords({
      now: new Date('2026-07-03T03:30:00.000Z'),
      deps: { listAutonomyEvidencePacks: () => [replayed], loadProposal: () => live },
    })).toEqual([]);
  });

  it('never promotes unsigned legacy evidence into daemon readiness', () => {
    const legacy = legacyEvidence('prop-ready', '2026-07-03T03:00:00.000Z');
    const live = proposal({
      id: 'prop-ready',
      createdAt: '2026-07-03T00:10:00.000Z',
      status: 'pending',
      diff: TEST_DIFF,
      diffHash: TEST_DIFF_HASH,
      verifyResult: {
        passed: true,
        baseBranch: 'main',
        baseHead: 'a'.repeat(40),
        diffHash: TEST_DIFF_HASH,
        verifiedAt: '2026-07-03T03:00:00.000Z',
        source: 'auto-merge',
      },
    });

    expect(listReadyEvidenceOutcomeRecords({
      now: new Date('2026-07-03T03:30:00.000Z'),
      deps: { listAutonomyEvidencePacks: () => [legacy], loadProposal: () => live },
    })).toEqual([]);
  });

  it('preserves bounded semantic decision events without judge reasoning text', () => {
    const semanticEvent = defineAgentSemanticEvents({
      subjectRef: agentSemanticSubjectRef('proposal', SEMANTIC_PROPOSAL_ID),
      producerRole: 'manager', producerModelFamily: 'openai', producerVersion: 'manager-semantic-v1',
    }, [{
      kind: 'prediction', predicate: 'manager.outcome.positive',
      outcomeCode: 'proposal.positive-outcome', probability: 0.8, horizon: 'post-merge',
    }])[0]!;
    const [record] = listOutcomeRecords({
      deps: deps({
        listProposals: () => [proposal({
          id: SEMANTIC_PROPOSAL_ID, createdAt: '2026-07-16T20:00:00.000Z',
        })],
        readDecisions: () => [decision(
          SEMANTIC_PROPOSAL_ID,
          '2026-07-16T20:01:00.000Z',
          { semanticEvents: [semanticEvent], reason: 'private rationale is not an event field', model: 'gpt-5.5' },
        )],
      }),
    });
    expect(record?.decisions[0]?.semanticEvents).toEqual([semanticEvent]);
    expect(JSON.stringify(record?.decisions[0]?.semanticEvents)).not.toContain('private rationale');
  });

  it('withholds semantic projections and exposes degraded decision source quality', () => {
    const semanticEvent = defineAgentSemanticEvents({
      subjectRef: agentSemanticSubjectRef('proposal', DEGRADED_PROPOSAL_ID),
      producerRole: 'manager', producerModelFamily: 'openai', producerVersion: 'manager-semantic-v1',
    }, [{
      kind: 'action', predicate: 'manager.judge.completed',
      actionCode: 'manager.judge', status: 'completed',
    }])[0]!;
    const degraded = [decision(
      DEGRADED_PROPOSAL_ID, '2026-07-16T20:01:00.000Z',
      { semanticEvents: [semanticEvent], model: 'gpt-5.5' },
    )] as DecisionEntry[] & { sourceQuality?: Record<string, unknown> };
    Object.defineProperty(degraded, 'sourceQuality', {
      value: {
        sourceState: 'degraded', sourcePresent: true, complete: false,
        stopReasons: ['io-error'], filesRead: 1, bytesRead: 100,
        rowsScanned: 2, invalidRows: 1, unreadableFiles: 0,
      },
    });
    const [record] = listOutcomeRecords({ deps: deps({
      listProposals: () => [proposal({
        id: DEGRADED_PROPOSAL_ID, createdAt: '2026-07-16T20:00:00.000Z',
      })],
      readDecisions: () => degraded,
    }) });
    expect(record?.decisionSourceQuality).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(record?.decisions[0]?.semanticEvents).toBeUndefined();
  });
});

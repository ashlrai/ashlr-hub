import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import type { ProposalsReadResult } from '../src/core/inbox/store.js';
import type { AshlrConfig, Proposal, RealizedMergeEvidence } from '../src/core/types.js';
import {
  detachedPostMergeDenominatorPointerPath,
  detachedPostMergeWorkTicketStorePath,
  projectDetachedPostMergeDenominator,
  readCurrentDetachedPostMergeDenominator,
  readDetachedPostMergeWorkTickets,
  runDetachedPostMergeOrchestrator,
} from '../src/core/fleet/detached-post-merge-orchestrator.js';
import {
  recordDetachedPostMergeVerificationCohort,
  readDetachedPostMergeVerificationCohorts,
  type DetachedPostMergeVerificationReadResult,
} from '../src/core/fleet/detached-post-merge-verification.js';
import {
  buildAutoMergeCanaryPromotionReadiness,
  buildFleetStatus,
  type FleetStatus,
} from '../src/core/fleet/status.js';
import type { AutoMergeCanaryReadResult } from '../src/core/fleet/automerge-canary.js';

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

beforeEach(() => {
  expect.hasAssertions();
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m472-data-scheduler-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  expect(loadOrCreateKey()).toHaveLength(32);
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

function proposal(id: string, repo: string): Proposal {
  return {
    id,
    repo,
    origin: 'manual',
    kind: 'pr',
    title: 'post-merge candidate',
    summary: 'bounded data-only fixture',
    status: 'applied',
    createdAt: '2026-08-01T12:00:00.000Z',
    runId: `run-${id}`,
    trajectoryId: `trajectory-${id}`,
    workItemId: `work-${id}`,
  };
}

function realized(
  candidateHead: string,
  mergeCommit: string,
  mergedAt: string,
): Extract<RealizedMergeEvidence, { source: 'github-host' }> {
  return {
    schemaVersion: 1,
    source: 'github-host',
    provider: 'github',
    prUrl: 'https://github.com/ashlrai/ashlr-hub/pull/472',
    branch: 'codex/candidate',
    base: 'main',
    expectedHeadOid: candidateHead,
    mergeCommitOid: mergeCommit,
    mergedAt,
    reconciliation: {
      schemaVersion: 1,
      observedAt: mergedAt,
      attestation: 'a'.repeat(64),
    },
  };
}

function proposalRead(proposals: Proposal[], degraded = false): ProposalsReadResult {
  return {
    proposals: degraded ? [] : proposals,
    sourceState: degraded ? 'degraded' : 'healthy',
    sourcePresent: true,
    complete: !degraded,
    stopReasons: degraded ? ['io-error'] : [],
    filesDiscovered: proposals.length,
    filesRead: degraded ? 0 : proposals.length,
    bytesRead: proposals.length * 100,
    invalidFiles: 0,
    unreadableFiles: degraded ? 1 : 0,
  };
}

function emptyObservations(
  overrides: Partial<DetachedPostMergeVerificationReadResult> = {},
): DetachedPostMergeVerificationReadResult {
  return {
    cohorts: [],
    summary: {
      cohorts: 0,
      denominatorCompleteCohorts: 0,
      conclusiveCompleteCohorts: 0,
      expectedMembers: 0,
      observedMembers: 0,
      pass: 0,
      fail: 0,
      unknown: 0,
    },
    sourceState: 'missing',
    sourcePresent: false,
    complete: true,
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    limitExceeded: false,
    ...overrides,
  };
}

function dependencies(
  proposals: Proposal[],
  merges: Map<string, RealizedMergeEvidence>,
  overrides: Record<string, unknown> = {},
) {
  return {
    readProposals: () => proposalRead(proposals),
    readEnrollment: () => ({
      state: 'ready' as const,
      repos: proposals.map((row) => row.repo!),
      reason: 'healthy',
    }),
    authenticateMerge: (row: Proposal) => merges.get(row.id) ?? null,
    readObservations: () => emptyObservations(),
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    ...overrides,
  };
}

function readCurrentFor(
  proposals: Proposal[],
  merges: Map<string, RealizedMergeEvidence>,
  now = new Date('2026-08-02T12:00:00.000Z'),
) {
  return readCurrentDetachedPostMergeDenominator({
    _dependencies: dependencies(proposals, merges, { now: () => now }),
  });
}

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function ticketRecordPath(): string {
  const records = join(detachedPostMergeWorkTicketStorePath(), 'records');
  const names = readdirSync(records).filter((name) => name.endsWith('.json'));
  expect(names).toHaveLength(1);
  return join(records, names[0]!);
}

describe('M472 data-only detached post-merge scheduler', () => {
  it('emits one private immutable hard-false ticket for the earliest stable candidate', async () => {
    const first = proposal('proposal-first', join(home, 'first'));
    const second = proposal('proposal-second', join(home, 'second'));
    const merges = new Map<string, RealizedMergeEvidence>([
      [first.id, realized('b'.repeat(40), 'c'.repeat(40), '2026-08-01T13:00:00.000Z')],
      [second.id, realized('d'.repeat(40), 'e'.repeat(40), '2026-08-01T14:00:00.000Z')],
    ]);

    const outcome = await runDetachedPostMergeOrchestrator({
      _dependencies: dependencies([second, first], merges),
    });
    const tickets = readDetachedPostMergeWorkTickets({ requireComplete: true });

    expect(outcome).toMatchObject({
      authority: 'observation-only',
      policyEligible: false,
      mergePermitted: false,
      rollbackPermitted: false,
      deployPermitted: false,
      disposition: 'queued',
      reason: 'ticket-recorded',
      eligibleCandidateCount: 2,
      observedCandidateCount: 0,
      ticketDisposition: 'recorded',
    });
    expect(tickets).toMatchObject({ sourceState: 'healthy', complete: true });
    expect(tickets.tickets).toHaveLength(1);
    expect(tickets.tickets[0]).toMatchObject({
      authority: 'observation-only',
      policyEligible: false,
      executionPermitted: false,
      mergePermitted: false,
      rollbackPermitted: false,
      deployPermitted: false,
      candidateId: outcome.selectedCandidateId,
    });
    const bytes = readFileSync(ticketRecordPath(), 'utf8');
    expect(statSync(ticketRecordPath()).mode & 0o777).toBe(0o600);
    expect(statSync(detachedPostMergeWorkTicketStorePath()).mode & 0o777).toBe(0o700);
    expect(bytes).not.toContain(first.repo!);
    expect(bytes).not.toContain(first.id);
    expect(bytes).not.toContain(second.repo!);
  });

  it('cannot call injected verification or topology execution dependencies', async () => {
    const row = proposal('proposal-no-execution', join(home, 'no-execution'));
    const merge = realized('b'.repeat(40), 'c'.repeat(40), '2026-08-01T13:00:00.000Z');
    const runVerification = vi.fn(() => { throw new Error('must never execute'); });
    const inspectTopology = vi.fn(() => { throw new Error('must never inspect'); });
    const deps = dependencies([row], new Map([[row.id, merge]]), {
      runVerification,
      inspectTopology,
    });

    const outcome = await runDetachedPostMergeOrchestrator({ _dependencies: deps });

    expect(outcome.disposition).toBe('queued');
    expect(runVerification).not.toHaveBeenCalled();
    expect(inspectTopology).not.toHaveBeenCalled();
  });

  it('refuses degraded proposal, enrollment, and observation sources without a ticket', async () => {
    const row = proposal('proposal-degraded', join(home, 'degraded'));
    const merge = realized('b'.repeat(40), 'c'.repeat(40), '2026-08-01T13:00:00.000Z');
    const merges = new Map([[row.id, merge]]);

    const proposalFailure = await runDetachedPostMergeOrchestrator({
      _dependencies: dependencies([row], merges, {
        readProposals: () => proposalRead([row], true),
      }),
    });
    const enrollmentFailure = await runDetachedPostMergeOrchestrator({
      _dependencies: dependencies([row], merges, {
        readEnrollment: () => ({ state: 'degraded' as const, reason: 'malformed-registry' }),
      }),
    });
    const observationFailure = await runDetachedPostMergeOrchestrator({
      _dependencies: dependencies([row], merges, {
        readObservations: () => emptyObservations({
          sourceState: 'degraded', sourcePresent: true, complete: false,
          stopReasons: ['invalid-file'], invalidFiles: 1,
        }),
      }),
    });

    expect(proposalFailure.reason).toBe('proposal-source-unavailable');
    expect(enrollmentFailure.reason).toBe('enrollment-source-unavailable');
    expect(observationFailure.reason).toBe('observation-source-unavailable');
    expect(readDetachedPostMergeWorkTickets({ requireComplete: true }).tickets).toHaveLength(0);
  });

  it('refuses a source race during the final pre-ticket revalidation', async () => {
    const first = proposal('proposal-race-first', join(home, 'race'));
    const replacement = proposal('proposal-race-replacement', first.repo!);
    const merges = new Map<string, RealizedMergeEvidence>([
      [first.id, realized('b'.repeat(40), 'c'.repeat(40), '2026-08-01T13:00:00.000Z')],
      [replacement.id, realized('d'.repeat(40), 'e'.repeat(40), '2026-08-01T14:00:00.000Z')],
    ]);
    let changed = false;

    const outcome = await runDetachedPostMergeOrchestrator({
      _dependencies: dependencies([first], merges, {
        readProposals: () => proposalRead(changed ? [replacement] : [first]),
        onPhase: (phase: string) => { if (phase === 'before-ticket') changed = true; },
      }),
    });

    expect(outcome).toMatchObject({
      disposition: 'refused',
      reason: 'source-changed',
      ticketDisposition: 'not-recorded',
    });
    expect(outcome.denominatorDisposition).toBe('recorded');
    expect(readDetachedPostMergeWorkTickets({ requireComplete: true }).tickets).toHaveLength(0);
  });

  it('deduplicates the same ticket through immutable record replay', async () => {
    const row = proposal('proposal-dedup', join(home, 'dedup'));
    const merge = realized('b'.repeat(40), 'c'.repeat(40), '2026-08-01T13:00:00.000Z');
    const deps = dependencies([row], new Map([[row.id, merge]]));

    const first = await runDetachedPostMergeOrchestrator({ _dependencies: deps });
    const second = await runDetachedPostMergeOrchestrator({ _dependencies: deps });
    const tickets = readDetachedPostMergeWorkTickets({ requireComplete: true });

    expect(first).toMatchObject({ reason: 'ticket-recorded', ticketDisposition: 'recorded' });
    expect(second).toMatchObject({ reason: 'ticket-replayed', ticketDisposition: 'replayed' });
    expect(second.ticketId).toBe(first.ticketId);
    expect(second.selectedCandidateId).toBe(first.selectedCandidateId);
    expect(tickets.tickets).toHaveLength(1);
  });

  it('degrades and refuses replay when the immutable ticket is tampered', async () => {
    const row = proposal('proposal-tamper', join(home, 'tamper'));
    const merge = realized('b'.repeat(40), 'c'.repeat(40), '2026-08-01T13:00:00.000Z');
    const deps = dependencies([row], new Map([[row.id, merge]]));
    const first = await runDetachedPostMergeOrchestrator({ _dependencies: deps });
    const path = ticketRecordPath();
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    record['queuedAt'] = '2026-08-02T13:00:00.000Z';
    writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    const read = readDetachedPostMergeWorkTickets({ requireComplete: true });
    const replay = await runDetachedPostMergeOrchestrator({ _dependencies: deps });

    expect(first.reason).toBe('ticket-recorded');
    expect(read).toMatchObject({ sourceState: 'degraded', complete: false, invalidFiles: 1 });
    expect(replay).toMatchObject({
      disposition: 'refused',
      reason: 'ticket-record-failed',
    });
    expect(['conflicted', 'failed']).toContain(replay.ticketDisposition);
  });

  it('does not let a queued ticket suppress the selected candidate', async () => {
    const first = proposal('proposal-queued-first', join(home, 'queued-first'));
    const second = proposal('proposal-queued-second', join(home, 'queued-second'));
    const merges = new Map<string, RealizedMergeEvidence>([
      [first.id, realized('b'.repeat(40), 'c'.repeat(40), '2026-08-01T13:00:00.000Z')],
      [second.id, realized('d'.repeat(40), 'e'.repeat(40), '2026-08-01T14:00:00.000Z')],
    ]);
    const deps = dependencies([second, first], merges);

    const firstTick = await runDetachedPostMergeOrchestrator({ _dependencies: deps });
    const secondTick = await runDetachedPostMergeOrchestrator({ _dependencies: deps });
    const denominator = readCurrentFor([second, first], merges);
    const tickets = readDetachedPostMergeWorkTickets({ requireComplete: true });
    const projection = projectDetachedPostMergeDenominator(
      denominator,
      emptyObservations(),
      tickets,
    );

    expect(secondTick.selectedCandidateId).toBe(firstTick.selectedCandidateId);
    expect(secondTick.reason).toBe('ticket-replayed');
    expect(projection).toMatchObject({
      eligibleCandidates: 2,
      queuedCandidates: 1,
      observedCandidates: 0,
      conclusiveCandidates: 0,
      unobservedCandidates: 2,
    });
  });

  it('does not let queued work satisfy post-merge readiness', () => {
    const status = {
      queue: {},
      detachedPostMergeVerificationSource: {
        sourceState: 'healthy', sourcePresent: true, complete: true,
        stopReasons: [], filesRead: 0, bytesRead: 0, rowsScanned: 0,
        invalidRows: 0, unreadableFiles: 0,
      },
      detachedPostMergeDenominatorSource: {
        sourceState: 'healthy', sourcePresent: true, complete: true,
        stopReasons: [], filesRead: 1, bytesRead: 1, rowsScanned: 1,
        invalidRows: 0, unreadableFiles: 0,
      },
      detachedPostMergeVerificationReadiness: {
        version: 1,
        authority: 'observation-only',
        policyEligible: false,
        mergePermitted: false,
        rollbackPermitted: false,
        deployPermitted: false,
        state: 'awaiting-observations',
        latestObservedAt: null,
        passRate: null,
        denominator: {
          candidateSetDigest: 'a'.repeat(64),
          eligibleCandidates: 1,
          observedCandidates: 0,
          conclusiveCandidates: 0,
          unobservedCandidates: 1,
          pass: 0,
          fail: 0,
          unknown: 0,
          queuedCandidates: 1,
        },
        summary: emptyObservations().summary,
      },
    } as unknown as FleetStatus;
    const read = {
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
      status: 'inactive',
      active: false,
      state: null,
    } as unknown as AutoMergeCanaryReadResult;

    const readiness = buildAutoMergeCanaryPromotionReadiness(
      status,
      baseConfig(),
      read,
      Date.parse('2026-08-02T12:00:00.000Z'),
    );

    expect(readiness.blockers.map((blocker) => blocker.code)).toContain(
      'post-merge-cohort-insufficient',
    );
  });

  it('lets only conclusive observations suppress candidates, not unknown or queued state', async () => {
    const row = proposal('proposal-observation', join(home, 'observation'));
    const merge = realized('b'.repeat(40), 'c'.repeat(40), '2026-08-01T13:00:00.000Z');
    const merges = new Map([[row.id, merge]]);
    expect(recordDetachedPostMergeVerificationCohort({
      cohortId: 'prior-unknown',
      observedAt: '2026-08-01T13:05:00.000Z',
      expectedMemberCount: 1,
      members: [{
        repo: row.repo!,
        proposalId: row.id,
        baseBranch: 'main',
        baseHead: 'a'.repeat(40),
        candidateHead: merge.expectedHeadOid,
        mergeCommit: merge.mergeCommitOid,
        verifierManifest: { digest: 'f'.repeat(64), commandCount: 1 },
        sourceState: 'degraded',
        failureCategory: 'infra',
      }],
    })).toBe('recorded');
    const deps = dependencies([row], merges, {
      readObservations: () => readDetachedPostMergeVerificationCohorts({ requireComplete: true }),
    });

    const queued = await runDetachedPostMergeOrchestrator({ _dependencies: deps });
    expect(queued.disposition).toBe('queued');

    expect(recordDetachedPostMergeVerificationCohort({
      cohortId: 'conclusive-pass',
      observedAt: '2026-08-01T13:10:00.000Z',
      expectedMemberCount: 1,
      members: [{
        repo: row.repo!,
        proposalId: row.id,
        baseBranch: 'main',
        baseHead: 'a'.repeat(40),
        candidateHead: merge.expectedHeadOid,
        mergeCommit: merge.mergeCommitOid,
        verifierManifest: { digest: 'e'.repeat(64), commandCount: 1 },
        sourceState: 'healthy',
        terminal: 'pass',
        verifiedHead: merge.mergeCommitOid,
        verifiedAt: '2026-08-01T13:09:00.000Z',
        workspaceClean: true,
        isolation: 'detached-worktree',
      }],
    })).toBe('recorded');
    const observed = await runDetachedPostMergeOrchestrator({ _dependencies: deps });

    expect(observed).toMatchObject({
      disposition: 'idle',
      reason: 'all-candidates-observed',
      observedCandidateCount: 1,
      ticketDisposition: 'not-recorded',
    });
  });

  it('keeps stale or source-injected denominators degraded in Fleet Status', async () => {
    const row = proposal('proposal-status', join(home, 'status'));
    const merge = realized('b'.repeat(40), 'c'.repeat(40), '2026-08-01T13:00:00.000Z');
    const capturedAt = new Date(Date.now() - 60 * 60 * 1_000);
    await runDetachedPostMergeOrchestrator({
      _dependencies: dependencies([row], new Map([[row.id, merge]]), {
        now: () => capturedAt,
      }),
    });

    const status = await buildFleetStatus(baseConfig());

    expect(existsSync(detachedPostMergeDenominatorPointerPath())).toBe(true);
    expect(status.detachedPostMergeDenominatorSource).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['stale-denominator'],
    });
    expect(status.detachedPostMergeVerificationReadiness).toMatchObject({
      state: 'degraded',
      denominator: { eligibleCandidates: 0, queuedCandidates: 0 },
    });
    expect(status.autoMergeCanaryPromotionReadiness?.blockers.map((blocker) => blocker.code))
      .toContain('post-merge-source-unhealthy');
  });
});

/**
 * Read-only autonomous direction report.
 *
 * Uses injected readers only: no real daemon state, worked ledger, resource
 * monitor, ecosystem scan, or merge pass is touched.
 */

import { describe, expect, it } from 'vitest';
import type { GuardHealthDiagnosis } from '../src/core/daemon/guard-health.js';
import type { EcosystemDoctorReport } from '../src/core/ecosystem/doctor.js';
import type { ResourceSnapshot } from '../src/core/fabric/resource-monitor.js';
import type { FleetStatus } from '../src/core/fleet/status.js';
import type { OutcomeRecord } from '../src/core/autonomy/outcome-records.js';
import type { ResourceStrategyReadDeps } from '../src/core/autonomy/resource-strategy.js';
import {
  buildResourceStrategyReport,
  resourceStrategyToDaemonPlan,
} from '../src/core/autonomy/resource-strategy.js';
import type { AshlrConfig } from '../src/core/types.js';

function cfg(overrides: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/repo'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
    ...overrides,
  } as AshlrConfig;
}

function proposals(
  overrides: Partial<Pick<FleetStatus['proposals'], 'pending' | 'frontierPending' | 'applied'>> = {},
): FleetStatus['proposals'] {
  return {
    pending: 0,
    frontierPending: 0,
    applied: 0,
    sourceQuality: {
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      stopReasons: [],
      filesDiscovered: 0,
      filesRead: 0,
      invalidFiles: 0,
      unreadableFiles: 0,
    },
    authority: { gate: 'ready', detail: 'complete proposal source (0/0 files read)' },
    ...overrides,
  };
}

function fleet(overrides: Partial<FleetStatus> = {}): FleetStatus {
  return {
    generatedAt: '2026-07-01T00:00:00.000Z',
    daemon: { running: true, lastTickAt: '2026-07-01T00:00:00.000Z', todaySpentUsd: 1 },
    backends: [
      { backend: 'claude', dispatchesRecent: 2, quota: 'ok' },
      { backend: 'builtin', dispatchesRecent: 1, quota: 'unlimited' },
    ],
    queue: { backlogItems: 3 },
    proposals: proposals(),
    merges: { recent: 0 },
    autonomy: {
      evidencePacks: 0,
      latestAt: null,
      allowed: 0,
      denied: 0,
      byTier: {},
      recent: [],
    },
    killed: false,
    ...overrides,
  };
}

function resources(backends: ResourceSnapshot['backends']): ResourceSnapshot {
  return {
    generatedAt: '2026-07-01T00:00:00.000Z',
    backends,
  };
}

function backend(
  id: ResourceSnapshot['backends'][number]['backend'],
  availability: ResourceSnapshot['backends'][number]['availability'],
): ResourceSnapshot['backends'][number] {
  return {
    backend: id,
    availability,
    usedPct: null,
    cap: null,
    capUnit: null,
    capWindow: null,
    resetsAt: null,
    costPerMTokenOut: 0,
    p50LatencyMs: null,
    snapshotAt: '2026-07-01T00:00:00.000Z',
    reason: availability,
    backoffUntilMs: null,
  };
}

function guard(blocked = false): GuardHealthDiagnosis {
  return {
    generatedAt: '2026-07-01T00:00:00.000Z',
    blocked,
    blocks: blocked
      ? [{
          id: 'kill-switch',
          detail: 'global kill switch is engaged',
          path: '/tmp/KILL',
          repairCommands: ['ashlr fleet resume'],
        }]
      : [],
  };
}

function doctor(fail = 0, warn = 0, totalChecks = 1): EcosystemDoctorReport {
  const checks = Array.from({ length: totalChecks }, (_, idx) => ({
    id: `check-${idx}`,
    label: `Check ${idx}`,
    status: idx < fail ? 'fail' as const : idx < fail + warn ? 'warn' as const : 'pass' as const,
    detail: `detail ${idx}`,
    repo: idx % 2 === 0 ? 'repo' : undefined,
  }));
  return {
    generatedAt: '2026-07-01T00:00:00.000Z',
    root: '/repos',
    summary: {
      pass: checks.filter((check) => check.status === 'pass').length,
      warn,
      fail,
      total: checks.length,
      repos: 1,
    },
    checks,
    repos: [],
  };
}

function outcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  const diffHash = 'a'.repeat(64);
  const verifiedAt = '2026-07-01T00:08:00.000Z';
  return {
    version: 1,
    proposal: {
      id: 'prop-1',
      repo: '/repo',
      origin: 'agent',
      kind: 'patch',
      status: 'pending',
      title: 'Ready proposal',
      createdAt: '2026-07-01T00:00:00.000Z',
      riskClass: 'low',
      diffHash,
      verifyResult: {
        passed: true,
        baseBranch: 'main',
        baseHead: 'b'.repeat(40),
        diffHash,
        verifiedAt,
        source: 'auto-merge',
      },
    },
    lastActivityAt: '2026-07-01T00:10:00.000Z',
    decisions: [],
    judgeTraces: [],
    evidencePacks: [{
      version: 3,
      generatedAt: '2026-07-01T00:09:00.000Z',
      proposalId: 'prop-1',
      diffHash,
      target: 'main',
      trustBasis: 'tier',
      remotePreferred: false,
      riskClass: 'low',
      policy: { tier: 'T4', action: 'merge-main', allowed: true, reason: 'ok' },
      gates: {
        authority: { ok: true, detail: 'ok' },
        provenance: { ok: true, detail: 'ok' },
        verification: { ok: true, detail: 'ok' },
        risk: { ok: true, detail: 'ok' },
        scope: { ok: true, detail: 'ok' },
      },
      verification: {
        passed: true,
        detail: 'ok',
        commandKinds: ['test'],
        baseBranch: 'main',
        baseHead: 'b'.repeat(40),
        diffHash,
        verifiedAt,
        source: 'auto-merge',
      },
    }],
    workedEvents: [],
    evidenceSourceQuality: {
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      filesRead: 1,
      bytesRead: 1,
      invalidFiles: 0,
      unreadableFiles: 0,
      limitExceeded: false,
    },
    ...overrides,
  } as OutcomeRecord;
}

function deps(overrides: Partial<ResourceStrategyReadDeps> = {}): ResourceStrategyReadDeps {
  const listOutcomeRecords = overrides.listOutcomeRecords ?? (() => []);
  const listReadyEvidenceOutcomeRecords =
    overrides.listReadyEvidenceOutcomeRecords ?? listOutcomeRecords;
  return {
    buildFleetStatus: async () => fleet(),
    getResourceSnapshot: async () => resources([backend('claude', 'open'), backend('builtin', 'open')]),
    listOutcomeRecords,
    listReadyEvidenceOutcomeRecords,
    runEcosystemDoctor: async () => doctor(),
    diagnoseGuardHealth: () => guard(false),
    ...overrides,
  };
}

describe('buildResourceStrategyReport', () => {
  it('recommends pause when guard health is blocked', async () => {
    const report = await buildResourceStrategyReport(cfg(), {
      deps: deps({ diagnoseGuardHealth: () => guard(true) }),
    });

    expect(report.mode).toBe('pause');
    expect(report.guardHealth.blocked).toBe(true);
    expect(report.reasons.join(' ')).toContain('guard health');
  });

  it('recommends local-only when cloud resources are held and local capacity is open', async () => {
    const report = await buildResourceStrategyReport(cfg(), {
      deps: deps({
        getResourceSnapshot: async () => resources([
          backend('claude', 'exhausted'),
          backend('codex', 'throttled'),
          backend('nim', 'unreachable'),
          backend('builtin', 'open'),
        ]),
      }),
    });

    expect(report.mode).toBe('local-only');
    expect(report.resources.posture).toBe('constrained');
    expect(report.resources.depleted).toBe(3);
  });

  it('recommends auto-merge-ready only as an advisory mode from existing evidence', async () => {
    const report = await buildResourceStrategyReport(
      cfg({ foundry: { autoMerge: { enabled: true } } as NonNullable<AshlrConfig['foundry']> }),
      {
        now: new Date('2026-07-01T00:30:00.000Z'),
        deps: deps({ listOutcomeRecords: () => [outcome()] }),
      },
    );

    expect(report.mode).toBe('auto-merge-ready');
    expect(report.outcomes.readyEvidence).toBe(1);
    expect(report.recommendedActions.join(' ')).toContain('existing merge gates');
  });

  it('does not derive readiness from general outcome snapshots', async () => {
    const report = await buildResourceStrategyReport(
      cfg({ foundry: { autoMerge: { enabled: true } } as NonNullable<AshlrConfig['foundry']> }),
      {
        now: new Date('2026-07-01T00:30:00.000Z'),
        deps: deps({
          listOutcomeRecords: () => [outcome()],
          listReadyEvidenceOutcomeRecords: () => [],
        }),
      },
    );

    expect(report.outcomes.readyEvidence).toBe(0);
    expect(report.mode).not.toBe('auto-merge-ready');
  });

  it('does not truncate dedicated ready records behind the general outcome window', async () => {
    const general = [
      outcome({ proposal: { ...outcome().proposal, id: 'general-1' } }),
      outcome({ proposal: { ...outcome().proposal, id: 'general-2' } }),
    ];
    const ready = outcome({ proposal: { ...outcome().proposal, id: 'ready-outside-window' } });
    ready.evidencePacks[0]!.proposalId = ready.proposal.id;

    const report = await buildResourceStrategyReport(
      cfg({ foundry: { autoMerge: { enabled: true } } as NonNullable<AshlrConfig['foundry']> }),
      {
        maxOutcomes: 2,
        now: new Date('2026-07-01T00:30:00.000Z'),
        deps: deps({
          listOutcomeRecords: () => general,
          listReadyEvidenceOutcomeRecords: () => [ready],
        }),
      },
    );

    expect(report.outcomes.records).toBe(2);
    expect(report.outcomes.readyEvidence).toBe(1);
    expect(report.mode).toBe('auto-merge-ready');
  });

  it.each([
    ['degraded', ['invalid-file']],
    ['partial', ['file-limit']],
  ] as const)('withholds proposal authority for a %s proposal source', async (_label, stopReasons) => {
    const degradedFleet = fleet({
      proposals: {
        pending: 3,
        frontierPending: 2,
        applied: 4,
        sourceQuality: {
          sourceState: 'degraded',
          sourcePresent: true,
          complete: false,
          stopReasons: [...stopReasons],
          filesDiscovered: 4,
          filesRead: 3,
          invalidFiles: stopReasons.includes('invalid-file') ? 1 : 0,
          unreadableFiles: 0,
        },
        authority: {
          gate: 'unavailable',
          detail: `auto-merge authority requires a complete healthy proposal source: ${stopReasons[0]}`,
        },
      },
    });
    const report = await buildResourceStrategyReport(
      cfg({ foundry: { autoMerge: { enabled: true } } as NonNullable<AshlrConfig['foundry']> }),
      {
        now: new Date('2026-07-01T00:30:00.000Z'),
        deps: deps({
          buildFleetStatus: async () => degradedFleet,
          listOutcomeRecords: () => [outcome()],
        }),
      },
    );

    expect(report.mode).not.toBe('auto-merge-ready');
    expect(report.fleet).toMatchObject({
      pendingProposals: null,
      frontierPending: null,
      appliedProposals: null,
      proposalSource: { gate: 'unavailable', sourceState: 'degraded', complete: false },
    });
    expect(resourceStrategyToDaemonPlan(report)).toMatchObject({
      runAutoMergeMaintenance: false,
      reason: expect.stringContaining('complete healthy proposal source'),
    });
  });

  it.each([
    ['stale generated timestamp', (record: OutcomeRecord) => {
      record.evidencePacks[0]!.generatedAt = '2026-06-30T20:00:00.000Z';
    }],
    ['future verification timestamp', (record: OutcomeRecord) => {
      record.evidencePacks[0]!.verification.verifiedAt = '2026-07-01T01:00:01.000Z';
      record.proposal.verifyResult!.verifiedAt = '2026-07-01T01:00:01.000Z';
    }],
    ['changed live diff hash', (record: OutcomeRecord) => {
      record.proposal.diffHash = 'c'.repeat(64);
    }],
    ['changed verification base', (record: OutcomeRecord) => {
      record.proposal.verifyResult!.baseHead = 'c'.repeat(40);
    }],
    ['degraded evidence source', (record: OutcomeRecord) => {
      record.evidenceSourceQuality!.sourceState = 'degraded';
      record.evidenceSourceQuality!.complete = false;
    }],
  ])('does not schedule auto-merge-ready for %s', async (_label, mutate) => {
    const record = outcome();
    mutate(record);
    const report = await buildResourceStrategyReport(
      cfg({ foundry: { autoMerge: { enabled: true } } as NonNullable<AshlrConfig['foundry']> }),
      {
        now: new Date('2026-07-01T00:30:00.000Z'),
        deps: deps({ listOutcomeRecords: () => [record] }),
      },
    );

    expect(report.outcomes.readyEvidence).toBe(0);
    expect(report.mode).not.toBe('auto-merge-ready');
  });

  it('requires the evidence trust basis to match current policy', async () => {
    const report = await buildResourceStrategyReport(
      cfg({
        foundry: {
          autoMerge: { enabled: true, trustBasis: 'verification' },
        } as NonNullable<AshlrConfig['foundry']>,
      }),
      {
        now: new Date('2026-07-01T00:30:00.000Z'),
        deps: deps({ listOutcomeRecords: () => [outcome()] }),
      },
    );

    expect(report.outcomes.readyEvidence).toBe(0);
    expect(report.mode).not.toBe('auto-merge-ready');
  });

  it('does not treat branch-only or already-applied evidence as auto-merge-ready', async () => {
    const base = outcome();
    const branchOnly = outcome({
      proposal: { ...base.proposal, id: 'prop-branch', status: 'pending' },
      evidencePacks: [{
        ...base.evidencePacks[0]!,
        target: 'branch',
        policy: { tier: 'T4', action: 'open-ready-pr', allowed: true, reason: 'branch only' },
      }],
    });
    const alreadyApplied = outcome({
      proposal: { ...base.proposal, id: 'prop-applied', status: 'applied' },
      evidencePacks: [{
        ...base.evidencePacks[0]!,
        policy: { tier: 'T4', action: 'merge-main', allowed: true, reason: 'stale applied evidence' },
      }],
    });

    const report = await buildResourceStrategyReport(
      cfg({ foundry: { autoMerge: { enabled: true } } as NonNullable<AshlrConfig['foundry']> }),
      {
        now: new Date('2026-07-01T00:30:00.000Z'),
        deps: deps({ listOutcomeRecords: () => [branchOnly, alreadyApplied] }),
      },
    );

    expect(report.mode).not.toBe('auto-merge-ready');
    expect(report.outcomes.readyEvidence).toBe(0);
  });

  it.each([1, 2] as const)(
    'does not treat a readable legacy v%s static-protection pack as auto-merge-ready',
    async (version) => {
    const legacy = outcome();
    legacy.evidencePacks[0] = {
      ...legacy.evidencePacks[0]!,
      version,
      trustBasis: 'evidence',
      remotePreferred: true,
      gates: {
        ...legacy.evidencePacks[0]!.gates,
        remoteProtection: { ok: true, detail: 'historical static protection claim' } as never,
      },
    };

    const report = await buildResourceStrategyReport(
      cfg({
        foundry: {
          autoMerge: { enabled: true, trustBasis: 'evidence' },
        } as NonNullable<AshlrConfig['foundry']>,
      }),
      {
        now: new Date('2026-07-01T00:30:00.000Z'),
        deps: deps({ listOutcomeRecords: () => [legacy] }),
      },
    );

    expect(report.outcomes.readyEvidence).toBe(0);
    expect(report.mode).not.toBe('auto-merge-ready');
    },
  );

  it('recommends verify-only for pending proposals and verification failures', async () => {
    const failed = outcome({
      proposal: {
        ...outcome().proposal,
        id: 'prop-failed',
        title: 'Failed proposal',
        verifyResult: { passed: false },
      },
      evidencePacks: [],
    });
    const report = await buildResourceStrategyReport(cfg(), {
      deps: deps({
        buildFleetStatus: async () => fleet({ proposals: proposals({ pending: 2, frontierPending: 1 }) }),
        listOutcomeRecords: () => [failed],
      }),
    });

    expect(report.mode).toBe('verify-only');
    expect(report.outcomes.verificationFailures).toBe(1);
    expect(report.reasons.join(' ')).toContain('pending proposal');
  });

  it('does not let stale pending proposals force verify-only under production velocity', async () => {
    const staleA = outcome({
      proposal: {
        ...outcome().proposal,
        id: 'prop-stale-a',
        title: 'Stale proposal A',
      },
      lastActivityAt: '2026-06-30T00:00:00.000Z',
    });
    const staleB = outcome({
      proposal: {
        ...outcome().proposal,
        id: 'prop-stale-b',
        title: 'Stale proposal B',
      },
      lastActivityAt: '2026-06-30T01:00:00.000Z',
    });

    const report = await buildResourceStrategyReport(
      cfg({
        foundry: {
          productionVelocity: { enabled: true, profile: 'resource-control', stalePendingTtlHours: 24 },
        } as NonNullable<AshlrConfig['foundry']>,
      }),
      {
        now: new Date('2026-07-02T12:00:00.000Z'),
        deps: deps({
          buildFleetStatus: async () => fleet({
            queue: { backlogItems: 4 },
            proposals: proposals({ pending: 2 }),
          }),
          listOutcomeRecords: () => [staleA, staleB],
        }),
      },
    );

    expect(report.mode).toBe('backlog-build');
    expect(report.outcomes.stalePending).toBe(2);
    expect(report.reasons.join(' ')).toContain('will not starve new dispatch');
  });

  it('keeps fresh pending proposals in verify-only under production velocity', async () => {
    const fresh = outcome({
      proposal: {
        ...outcome().proposal,
        id: 'prop-fresh',
        title: 'Fresh proposal',
      },
      lastActivityAt: '2026-07-02T11:30:00.000Z',
    });

    const report = await buildResourceStrategyReport(
      cfg({
        foundry: {
          productionVelocity: { enabled: true, profile: 'resource-control', stalePendingTtlHours: 24 },
        } as NonNullable<AshlrConfig['foundry']>,
      }),
      {
        now: new Date('2026-07-02T12:00:00.000Z'),
        deps: deps({
          buildFleetStatus: async () => fleet({
            queue: { backlogItems: 4 },
            proposals: proposals({ pending: 1 }),
          }),
          listOutcomeRecords: () => [fresh],
        }),
      },
    );

    expect(report.mode).toBe('verify-only');
    expect(report.outcomes.stalePending).toBe(0);
    expect(report.reasons.join(' ')).toContain('pending proposal');
  });

  it('ignores verification failures after proposals are no longer pending', async () => {
    const rejected = outcome({
      proposal: {
        ...outcome().proposal,
        id: 'prop-rejected-failed',
        status: 'rejected',
        title: 'Rejected failed proposal',
        verifyResult: { passed: false },
      },
      evidencePacks: [],
    });

    const report = await buildResourceStrategyReport(cfg(), {
      deps: deps({ listOutcomeRecords: () => [rejected] }),
    });

    expect(report.outcomes.verificationFailures).toBe(0);
    expect(report.mode).toBe('backlog-build');
  });

  it('bounds outcomes, checks, and backend summaries', async () => {
    const manyOutcomes = Array.from({ length: 12 }, (_, idx) =>
      outcome({
        proposal: { ...outcome().proposal, id: `prop-${idx}`, title: `Proposal ${idx}` },
      }),
    );
    const manyBackends = Array.from({ length: 20 }, (_, idx) =>
      backend((idx === 0 ? 'claude' : `custom-${idx}`) as ResourceSnapshot['backends'][number]['backend'], 'open'),
    );

    const report = await buildResourceStrategyReport(cfg(), {
      maxOutcomes: 3,
      maxChecks: 4,
      deps: deps({
        buildFleetStatus: async () => fleet({
          backends: manyBackends.map((state) => ({
            backend: state.backend,
            dispatchesRecent: 0,
            quota: 'unlimited',
          })),
        }),
        getResourceSnapshot: async () => resources(manyBackends),
        listOutcomeRecords: () => manyOutcomes,
        runEcosystemDoctor: async () => doctor(2, 4, 10),
      }),
    });

    expect(report.outcomes.recent).toHaveLength(3);
    expect(report.ecosystem.topChecks).toHaveLength(4);
    expect(report.resources.backends).toHaveLength(12);
  });
});

describe('resourceStrategyToDaemonPlan', () => {
  it('turns pause into a no-dispatch daemon plan', async () => {
    const report = await buildResourceStrategyReport(cfg(), {
      deps: deps({ diagnoseGuardHealth: () => guard(true) }),
    });

    const plan = resourceStrategyToDaemonPlan(report);

    expect(plan).toMatchObject({
      mode: 'pause',
      allowDispatch: false,
      forceLocalOnly: false,
      runAutoMergeMaintenance: false,
    });
  });

  it('turns verify-only into merge maintenance without new dispatch', async () => {
    const report = await buildResourceStrategyReport(cfg(), {
      deps: deps({
        buildFleetStatus: async () => fleet({ proposals: proposals({ pending: 1, frontierPending: 1 }) }),
      }),
    });

    const plan = resourceStrategyToDaemonPlan(report);

    expect(plan).toMatchObject({
      mode: 'verify-only',
      allowDispatch: false,
      forceLocalOnly: false,
      runAutoMergeMaintenance: true,
    });
  });

  it('turns local-only into constrained dispatch with merge maintenance left on', async () => {
    const report = await buildResourceStrategyReport(cfg(), {
      deps: deps({
        getResourceSnapshot: async () => resources([
          backend('claude', 'exhausted'),
          backend('codex', 'throttled'),
          backend('builtin', 'open'),
        ]),
      }),
    });

    const plan = resourceStrategyToDaemonPlan(report);

    expect(plan).toMatchObject({
      mode: 'local-only',
      allowDispatch: true,
      forceLocalOnly: true,
      runAutoMergeMaintenance: true,
    });
  });
});

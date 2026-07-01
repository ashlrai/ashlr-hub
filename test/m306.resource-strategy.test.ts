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
import { buildResourceStrategyReport } from '../src/core/autonomy/resource-strategy.js';
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

function fleet(overrides: Partial<FleetStatus> = {}): FleetStatus {
  return {
    generatedAt: '2026-07-01T00:00:00.000Z',
    daemon: { running: true, lastTickAt: '2026-07-01T00:00:00.000Z', todaySpentUsd: 1 },
    backends: [
      { backend: 'claude', dispatchesRecent: 2, quota: 'ok' },
      { backend: 'builtin', dispatchesRecent: 1, quota: 'unlimited' },
    ],
    queue: { backlogItems: 3 },
    proposals: { pending: 0, frontierPending: 0, applied: 0 },
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
      verifyResult: { passed: true },
    },
    lastActivityAt: '2026-07-01T00:10:00.000Z',
    decisions: [],
    judgeTraces: [],
    evidencePacks: [{
      generatedAt: '2026-07-01T00:09:00.000Z',
      target: 'main',
      trustBasis: 'tier',
      riskClass: 'low',
      policy: { tier: 'T4', action: 'merge-main', allowed: true, reason: 'ok' },
      gates: {
        authority: { ok: true, detail: 'ok' },
        provenance: { ok: true, detail: 'ok' },
        verification: { ok: true, detail: 'ok' },
        risk: { ok: true, detail: 'ok' },
        scope: { ok: true, detail: 'ok' },
      },
      verification: { passed: true, detail: 'ok', commandKinds: ['test'] },
    }],
    workedEvents: [],
    ...overrides,
  } as OutcomeRecord;
}

function deps(overrides: Partial<ResourceStrategyReadDeps> = {}): ResourceStrategyReadDeps {
  return {
    buildFleetStatus: async () => fleet(),
    getResourceSnapshot: async () => resources([backend('claude', 'open'), backend('builtin', 'open')]),
    listOutcomeRecords: () => [],
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
        deps: deps({ listOutcomeRecords: () => [outcome()] }),
      },
    );

    expect(report.mode).toBe('auto-merge-ready');
    expect(report.outcomes.readyEvidence).toBe(1);
    expect(report.recommendedActions.join(' ')).toContain('existing merge gates');
  });

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
        buildFleetStatus: async () => fleet({ proposals: { pending: 2, frontierPending: 1, applied: 0 } }),
        listOutcomeRecords: () => [failed],
      }),
    });

    expect(report.mode).toBe('verify-only');
    expect(report.outcomes.verificationFailures).toBe(1);
    expect(report.reasons.join(' ')).toContain('pending proposal');
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


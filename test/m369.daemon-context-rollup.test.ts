import { describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, DaemonConfig, DaemonTick } from '../src/core/types.js';
import type { AgentActionEvent, AgentWorkspaceStatus } from '../src/core/fleet/agent-action-ledger.js';
import { buildContextEfficiencyStatus } from '../src/core/fleet/context-efficiency.js';
import { recordContextRollupAfterTick } from '../src/core/daemon/loop.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');

function cfg(contextRollup?: DaemonConfig['contextRollup']): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'vscode',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    memoryMode: 'off',
    daemon: { contextRollup },
  } as AshlrConfig;
}

function tick(reason: DaemonTick['reason'] = 'ok'): DaemonTick {
  return {
    ts: '2026-07-11T11:59:00.000Z', reason, reposScanned: 1, backlogItems: 1,
    itemsConsidered: 1, proposalsCreated: 0, spentUsd: 0, todaySpentUsd: 0,
  };
}

function terminal(index: number, overrides: Partial<AgentActionEvent> = {}): AgentActionEvent {
  const runId = `attempt-${index}`;
  return {
    schemaVersion: 1,
    ts: new Date(NOW.getTime() - index * 1_000).toISOString(),
    actor: 'daemon',
    kind: 'dispatch',
    outcome: 'no-proposal',
    action: 'daemon:dispatch',
    summary: 'seed',
    runId,
    trajectoryId: `run:${runId}`,
    learningSource: 'daemon-dispatch',
    runEventSummary: {
      runId,
      status: 'done',
      outcome: 'no-proposal',
      proposalCreated: false,
    },
    learningLabel: {
      schemaVersion: 1,
      classifierVersion: 'attempt-shape-v1',
      authoritative: true,
      learningKind: 'diagnostic-no-proposal',
      policySuppressed: false,
      diagnosticNoProposal: true,
      diagnosticAttempt: true,
      attemptShape: {
        backendNoDiff: 1,
        captureOrGateBlocked: 0,
        repairAttempts: 0,
        policyDisabled: 0,
      },
    },
    ...overrides,
  };
}

describe('M369 daemon metadata rollup integration', () => {
  it('persists one fixed rollup derived from unique terminal trajectories', () => {
    const record = vi.fn(() => true);
    const events = Array.from({ length: 50 }, (_, index) => terminal(index, {
      repo: `/private/repo-${index}`,
      itemId: `secret-item-${index}`,
      summary: `raw prompt secret-${index}`,
      ...(index < 5 ? { outcome: 'proposal-created' as const } : {}),
    }));

    const result = recordContextRollupAfterTick(tick(), { dryRun: false }, cfg(), {
      now: () => NOW, read: () => events, record,
    });

    expect(result).toMatchObject({ disposition: 'emit' });
    const persisted = record.mock.calls[0]?.[0] as AgentActionEvent;
    expect(persisted).toMatchObject({
      kind: 'context-rollup',
      action: 'daemon:context-rollup',
      counts: {
        eligibleEvents: 50,
        uniqueTrajectories: 50,
        proposalCreated: 5,
        diagnosticNoProposal: 45,
      },
    });
    expect(JSON.stringify(persisted)).not.toMatch(/private|secret-item|raw prompt/);
  });

  it('deduplicates trajectories and requires new evidence after persisted cadence', () => {
    const previous = terminal(3_600, {
      kind: 'context-rollup',
      action: 'daemon:context-rollup',
      outcome: 'ok',
      trajectoryId: undefined,
      contextRollupId: `cr-${'b'.repeat(64)}`,
      contextRollupPolicyVersion: 'context-rollup-v1',
      contextRollupSourceMaxTs: '2026-07-11T10:00:00.000Z',
    });
    const events = [previous, ...Array.from({ length: 50 }, (_, index) => terminal(index + 1))];
    events.push(terminal(2, {
      runId: 'attempt-1',
      trajectoryId: 'run:attempt-1',
      runEventSummary: {
        runId: 'attempt-1',
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
      },
      outcome: 'proposal-created',
    }));
    const record = vi.fn(() => true);

    expect(recordContextRollupAfterTick(tick(), { dryRun: false }, cfg({ cadenceHours: 1 }), {
      now: () => NOW, read: () => events, record,
    })).toMatchObject({ disposition: 'emit', counts: { uniqueTrajectories: 50 } });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('uses runtime defaults for invalid non-positive config values', () => {
    const previous = terminal(7_200, {
      kind: 'context-rollup',
      action: 'daemon:context-rollup',
      outcome: 'ok',
      runId: undefined,
      trajectoryId: undefined,
      contextRollupId: `cr-${'c'.repeat(64)}`,
      contextRollupPolicyVersion: 'context-rollup-v1',
      contextRollupSourceMaxTs: '2026-07-11T09:00:00.000Z',
    });
    const events = [previous, ...Array.from({ length: 50 }, (_, index) => terminal(index + 1))];

    expect(recordContextRollupAfterTick(tick(), { dryRun: false }, cfg({
      cadenceHours: 0,
      minTerminalTrajectories: -1,
    }), {
      now: () => NOW,
      read: () => events,
      record: () => true,
    })).toEqual({ disposition: 'noop', reason: 'cadence-active' });
  });

  it('refuses disabled, dry-run, every non-ok tick, low-signal, truncation, and write failure', () => {
    const record = vi.fn(() => true);
    const lowSignal = Array.from({ length: 49 }, (_, index) => terminal(index));
    const truncated = Array.from({ length: 5_001 }, (_, index) => terminal(index));
    const cases = [
      recordContextRollupAfterTick(tick(), { dryRun: false }, cfg({ enabled: false }), { record }),
      recordContextRollupAfterTick(tick(), { dryRun: true }, cfg(), { record }),
      recordContextRollupAfterTick(tick('no-backlog'), { dryRun: false }, cfg(), { record }),
      recordContextRollupAfterTick(tick('state-persistence-failed'), { dryRun: false }, cfg(), { record }),
      recordContextRollupAfterTick(tick(), { dryRun: false }, cfg(), { now: () => NOW, read: () => lowSignal, record }),
      recordContextRollupAfterTick(tick(), { dryRun: false }, cfg(), { now: () => NOW, read: () => truncated, record }),
      recordContextRollupAfterTick(tick(), { dryRun: false }, cfg(), {
        now: () => NOW,
        read: () => Array.from({ length: 50 }, (_, index) => terminal(index)),
        record: () => false,
      }),
    ];
    expect(cases.map((result) => result.reason)).toEqual([
      'disabled', 'dry-run', 'tick-not-ok', 'tick-not-ok',
      'below-trajectory-threshold', 'truncated', 'unavailable',
    ]);
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps observational rollups separate from real reflection and proposal-yield risk', () => {
    const workspace = {
      eventCount: 100,
      activeMachines: [],
      repoDistinctCount: 2,
      repoEventCount: 100,
      topRepoCount: 50,
      byRepo: [],
      entropy: { action: 1, outcome: 1, repo: 1 },
      byAction: [{ key: 'context-rollup', count: 1 }],
    } as AgentWorkspaceStatus;
    const status = buildContextEfficiencyStatus({
      workspace,
      proposalProduction: { proposalsCreated: 1, diagnosticNoProposalDispatches: 9, suppressedDispatches: 0 },
    }, undefined, NOW.toISOString(), 24 * 60 * 60 * 1_000);

    expect(status.signals).toMatchObject({ contextRollupEvents: 1, reflectionEvents: 0 });
    expect(status.risks.map((risk) => risk.id)).toEqual(expect.arrayContaining([
      'reflection-missing', 'proposal-yield-low',
    ]));
  });
});

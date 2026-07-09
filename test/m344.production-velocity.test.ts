/**
 * Production velocity/resource-control profile helpers.
 *
 * Pure coverage for the opt-in production lane: config materialization, queue
 * selection sized to resource slots, and explicit local/NIM/Kimi caps.
 */

import { describe, expect, it } from 'vitest';
import type { AshlrConfig, EngineId, Proposal } from '../src/core/types.js';
import type { BackendAvailability, BackendResourceState, ResourceSnapshot } from '../src/core/fabric/resource-monitor.js';
import {
  applyProductionVelocityProfile,
  availableSlotsForResourceSnapshot,
  daemonQueueSelectionLimit,
  resolveProductionVelocityProfile,
} from '../src/core/fabric/production-velocity.js';
import { getBackendResourceState } from '../src/core/fabric/resource-monitor.js';
import { blockingPendingProposalsForBacklog } from '../src/core/fleet/proposal-matching.js';

function cfg(overrides: Partial<AshlrConfig> = {}): AshlrConfig {
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
    ...overrides,
  } as AshlrConfig;
}

function snapshot(backends: Array<{
  backend: EngineId;
  availability: BackendAvailability;
  cap?: number | null;
  capUnit?: BackendResourceState['capUnit'];
  usedPct?: number | null;
}>): ResourceSnapshot {
  return {
    generatedAt: '2026-07-02T00:00:00.000Z',
    backends: backends.map((backend) => ({
      backend: backend.backend,
      availability: backend.availability,
      usedPct: backend.usedPct ?? null,
      cap: backend.cap ?? null,
      capUnit: backend.capUnit ?? null,
      capWindow: null,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: '2026-07-02T00:00:00.000Z',
      reason: backend.availability,
      backoffUntilMs: null,
    })),
  };
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-test',
    origin: 'agent',
    kind: 'patch',
    title: 'Pending proposal',
    summary: 'metadata only',
    status: 'pending',
    repo: '/tmp/repo',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as Proposal;
}

describe('production velocity profile', () => {
  it('materializes gateway/resource-aware/concurrent/workhorse routing and explicit caps', () => {
    const input = cfg({
      foundry: {
        allowedBackends: ['builtin', 'local-coder', 'codex', 'nim', 'kimi'],
        productionVelocity: { enabled: true, profile: 'resource-control' },
      },
    });

    const profile = resolveProductionVelocityProfile(input);
    const effective = applyProductionVelocityProfile(input);

    expect(profile).toMatchObject({
      enabled: true,
      profile: 'resource-control',
      fillQueueToSlots: true,
      stalePendingTtlHours: 24,
      maxSlotsPerBackend: 3,
      caps: {
        localMaxConcurrent: 1,
        nimMaxConcurrent: 2,
        kimiMaxConcurrent: 2,
      },
      flags: {
        gateway: true,
        resourceAware: true,
        concurrentDispatch: true,
        workhorseDispatch: true,
      },
    });
    expect(effective.foundry?.fabric).toMatchObject({
      gateway: true,
      resourceAware: true,
      concurrentDispatch: true,
      workhorseDispatch: true,
      maxSlotsPerBackend: 3,
    });
    expect(effective.foundry?.local?.maxConcurrent).toBe(1);
    expect(effective.foundry?.nim?.maxConcurrent).toBe(2);
    expect(effective.foundry?.kimi?.maxConcurrent).toBe(2);
  });

  it('fills daemon queue selection to available resource slots when enabled', () => {
    expect(daemonQueueSelectionLimit({
      perTickItems: 3,
      remainingBudgetUsd: 1,
      backlogItems: 20,
      fillQueueToSlots: true,
      availableSlots: 8,
    })).toBe(8);

    expect(daemonQueueSelectionLimit({
      perTickItems: 3,
      remainingBudgetUsd: 1,
      backlogItems: 20,
      fillQueueToSlots: false,
      availableSlots: 8,
    })).toBe(3);
  });

  it('still respects budget and backlog bounds while filling slots', () => {
    expect(daemonQueueSelectionLimit({
      perTickItems: 3,
      remainingBudgetUsd: 0.05,
      backlogItems: 20,
      fillQueueToSlots: true,
      availableSlots: 8,
    })).toBe(5);

    expect(daemonQueueSelectionLimit({
      perTickItems: 3,
      remainingBudgetUsd: 1,
      backlogItems: 4,
      fillQueueToSlots: true,
      availableSlots: 8,
    })).toBe(4);
  });

  it('computes slot capacity from cap-aware local/NIM/Kimi resource states', () => {
    const snap = snapshot([
      { backend: 'local-coder', availability: 'open', cap: 1, capUnit: 'concurrent' },
      { backend: 'nim', availability: 'open', cap: 2, capUnit: 'concurrent' },
      { backend: 'kimi', availability: 'open', cap: 2, capUnit: 'concurrent' },
      { backend: 'codex', availability: 'near' },
      { backend: 'claude', availability: 'exhausted' },
      { backend: 'builtin', availability: 'open' },
    ]);

    expect(availableSlotsForResourceSnapshot(snap, 3)).toBe(10);
  });

  it('reports configured NIM and Kimi caps through the resource monitor', async () => {
    const effective = applyProductionVelocityProfile(cfg({
      foundry: {
        productionVelocity: {
          enabled: true,
          profile: 'resource-control',
          nimMaxConcurrent: 4,
          kimiMaxConcurrent: 3,
        },
      },
    }));

    await expect(getBackendResourceState('nim', effective)).resolves.toMatchObject({
      backend: 'nim',
      availability: 'open',
      cap: 4,
      capUnit: 'concurrent',
    });
    await expect(getBackendResourceState('kimi', effective)).resolves.toMatchObject({
      backend: 'kimi',
      availability: 'open',
      cap: 3,
      capUnit: 'concurrent',
    });
  });

  it('lets stale pending proposals stop blocking backlog only when production velocity is enabled', () => {
    const stale = proposal({
      id: 'prop-stale',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const fresh = proposal({
      id: 'prop-fresh',
      createdAt: '2026-07-02T11:30:00.000Z',
    });
    const now = new Date('2026-07-02T12:00:00.000Z');
    const enabled = cfg({
      foundry: {
        productionVelocity: { enabled: true, profile: 'resource-control', stalePendingTtlHours: 24 },
      },
    });

    expect(blockingPendingProposalsForBacklog([stale, fresh], enabled, { now }).map((p) => p.id))
      .toEqual(['prop-fresh']);
    expect(blockingPendingProposalsForBacklog([stale], cfg(), { now }).map((p) => p.id))
      .toEqual(['prop-stale']);
  });
});

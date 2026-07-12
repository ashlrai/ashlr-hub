import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  generatedRepairLifecyclePath,
  generatedRepairDispatchLineage,
  generatedRepairRetryPolicy,
  readGeneratedRepairQueueSnapshot,
  acknowledgeGeneratedRepairTreatmentOutcome,
  readGeneratedRepairLifecycle,
  readPendingGeneratedRepairTreatmentOutcomes,
  recordGeneratedRepairLifecycle,
  readGeneratedRepairTerminalOutcome,
} from '../src/core/fleet/generated-repair-lifecycle.js';
import { repairTreatmentForUnitId } from '../src/core/fleet/generated-repair-identity.js';
import { recordUse } from '../src/core/fleet/quota.js';
import type { WorkItem } from '../src/core/types.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { inspectGeneratedRepairRouteFeasibility, routeBackend } from '../src/core/fleet/router.js';
import {
  readRepairHandoffs,
  recordRepairHandoffs,
  repairHandoffFromDispatchEvent,
} from '../src/core/fleet/repair-handoff-journal.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

vi.mock('../src/core/run/engines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/engines.js')>();
  return { ...actual, engineInstalled: () => true };
});

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

function repairItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'repo:proposal-repair:abcdef123456',
    repo: '/tmp/repo',
    source: 'self',
    title: 'Proposal repair: complete the stalled scheduler fix',
    detail:
      'Proposal repair: produce a corrected proposal.\n' +
      'Proposal: prop-stalled\n' +
      'Original work item: repo:goal:stalled\n' +
      'Produce a fresh complete fix and verify it.',
    value: 4,
    effort: 1,
    score: 4,
    tags: ['self-heal', 'proposal-repair', 'verify'],
    ts: '2026-07-10T12:00:00.000Z',
    ...overrides,
  };
}

function captureRepairItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return repairItem({
    id: 'repo:proposal-repair-capture:abcdef123456',
    title: 'Dispatch capture repair: preserve a verified scheduler fix',
    detail:
      'Dispatch capture repair: recover a failed proposal capture.\n' +
      'Original work item: repo:goal:capture-stalled\n' +
      'Dispatch outcome: proposal-capture-error\n' +
      'Diff metadata: files=1\n' +
      'Failure: src/app.ts:12 expected a complete proposal\n' +
      'Produce a fresh complete fix and verify it.',
    tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate', 'verify'],
    ...overrides,
  });
}

function diagnosticRepairItem(
  parentBackend: 'local-coder' | 'codex' = 'local-coder',
  parentTier: 'mid' | 'frontier' = 'mid',
  schemaVersion: 1 | 2 = 2,
): WorkItem {
  const nonce = fx.home.replace(/[^a-zA-Z0-9]/g, '').slice(-16);
  const parent: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: '2026-07-10T12:00:00.000Z',
    itemId: `repo:goal:diagnostic-retry:${nonce}`,
    source: 'goal',
    repo: fx.home,
    title: 'Repair a stalled objective',
    backend: parentBackend,
    tier: parentTier,
    assignedBy: 'router',
    routeReason: 'test parent route',
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: ATTEMPT_ONE,
    objectiveHash: 'a'.repeat(64),
    spentUsd: 0,
    basis: 'run-proposal-outcome',
  };
  expect(repairHandoffFromDispatchEvent(parent)).not.toBeNull();
  if (schemaVersion === 2) {
    recordRepairHandoffs(parent, {
      schemaVersion: 2,
      activation: { id: '11111111-1111-4111-8111-111111111111', activatedAt: '2020-01-01T00:00:00.000Z' },
    });
  } else {
    recordRepairHandoffs(parent, { schemaVersion: 1 });
  }
  const handoff = readRepairHandoffs().observations.find((observation) =>
    observation.schemaVersion === schemaVersion && observation.parentItemId === parent.itemId)!;
  return {
    id: handoff.childItemId,
    repo: parent.repo,
    source: 'self',
    title: `Reslice no-diff dispatch for repo item ${parent.itemId}`,
    detail:
      'Diagnostic reslice: a dispatch completed without file changes.\n' +
      `Original work item: ${parent.itemId}\n` +
      'Dispatch outcome: empty-diff\n' +
      'Action: reslice the work into a smaller concrete edit.',
    value: 5,
    effort: 1,
    score: 5,
    tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
    ts: parent.ts,
    repairHandoffId: handoff.eventId,
    repairGenerationId: handoff.generationId,
    repairTreatmentUnitId: handoff.repairTreatmentUnitId,
    repairTreatment: handoff.repairTreatment,
    repairParentItemId: parent.itemId,
    repairParentSource: parent.source,
    repairParentBackend: parent.backend,
    repairParentTier: parent.tier,
    repairParentObjectiveHash: parent.objectiveHash,
  };
}

const ATTEMPT_ONE = 'attempt-12345678-1234-4123-8123-123456789abc';
const ATTEMPT_TWO = 'attempt-22345678-1234-4123-8123-123456789abc';
const ATTEMPT_THREE = 'attempt-32345678-1234-4123-8123-123456789abc';

describe('generated repair lifecycle store', () => {
  it('propagates deterministic treatment through lifecycle and dispatch lineage metadata', () => {
    const item = diagnosticRepairItem();
    const expected = repairTreatmentForUnitId(item.repairTreatmentUnitId!)!;

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({ available: true });
    expect(generatedRepairDispatchLineage(item, 'local-coder')).toMatchObject({
      repairGenerationId: item.repairGenerationId,
      repairTreatmentUnitId: item.repairTreatmentUnitId,
      repairTreatment: expected,
      repairAttemptOrdinal: 1,
    });
  });

  it('routes the first repair normally and a proven empty retry through a different same-tier backend', () => {
    const item = diagnosticRepairItem();
    const cfg = {
      version: 1,
      roots: ['/tmp'],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as import('../src/core/types.js').AshlrConfig;

    expect(routeBackend(item, cfg)).toMatchObject({ backend: 'local-coder', tier: 'mid' });
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_TWO,
      backend: 'local-coder',
      tier: 'mid',
    });
    expect(routeBackend(item, cfg)).toMatchObject({
      backend: 'kimi',
      tier: 'mid',
      reason: expect.stringContaining('repair-alternative-selected'),
    });
  });

  it('requires a same-tier alternate for proposal and capture repair retries', () => {
    const cfg = {
      version: 1,
      roots: ['/tmp'],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as import('../src/core/types.js').AshlrConfig;
    for (const item of [repairItem(), captureRepairItem()]) {
      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
      })).toMatchObject({ available: true, disposition: 'active', authoritativeEmptyRuns: 1 });
      expect(generatedRepairRetryPolicy(item)).toMatchObject({
        applies: true,
        available: true,
        requireAlternative: true,
        excludedBackend: 'local-coder',
        requiredTier: 'mid',
      });
      expect(routeBackend(item, cfg)).toMatchObject({ backend: 'kimi', tier: 'mid' });
      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'local-coder', tier: 'mid',
      })).toMatchObject({ available: false, disposition: 'active', recorded: false });
    }
  });

  it('inspects retry route feasibility from one read-only lifecycle snapshot', () => {
    const item = repairItem();
    const cfg = {
      version: 1,
      roots: ['/tmp'],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as import('../src/core/types.js').AshlrConfig;
    const fleetDir = dirname(generatedRepairLifecyclePath());
    expect(existsSync(fleetDir)).toBe(false);

    const initial = readGeneratedRepairQueueSnapshot();
    const initialPolicy = initial.retryPolicy(item);
    expect(initialPolicy).toMatchObject({ available: true, requireAlternative: false });
    expect(inspectGeneratedRepairRouteFeasibility(item, cfg, initialPolicy)).toMatchObject({
      feasible: true,
      reason: 'feasible',
    });
    expect(existsSync(fleetDir)).toBe(false);

    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    });
    expect(initial.retryPolicy(item)).toMatchObject({ requireAlternative: false });
    const retry = readGeneratedRepairQueueSnapshot().retryPolicy(item);
    expect(retry).toMatchObject({
      available: true,
      requireAlternative: true,
      excludedBackend: 'local-coder',
      requiredTier: 'mid',
    });
    expect(inspectGeneratedRepairRouteFeasibility(item, cfg, retry)).toMatchObject({
      feasible: true,
      backend: 'kimi',
      reason: 'feasible',
    });
    expect(inspectGeneratedRepairRouteFeasibility(item, {
      ...cfg,
      foundry: { allowedBackends: ['local-coder'] },
    }, retry)).toMatchObject({
      feasible: false,
      reason: 'same-tier-alternative-unavailable',
    });

    const repairOnlyCfg = { ...cfg, foundry: { allowedBackends: ['aw'] } } as import('../src/core/types.js').AshlrConfig;
    const fresh = repairItem({ id: 'repo:proposal-repair:777777777777' });
    const freshPolicy = readGeneratedRepairQueueSnapshot().retryPolicy(fresh);
    expect(inspectGeneratedRepairRouteFeasibility(fresh, repairOnlyCfg, freshPolicy)).toMatchObject({
      feasible: false,
      reason: 'editing-backend-unavailable',
    });
    expect(routeBackend(fresh, repairOnlyCfg)).toMatchObject({ backend: 'builtin' });

    recordUse('local-coder');
    const cappedCfg = {
      ...cfg,
      foundry: {
        allowedBackends: ['local-coder'],
        limits: { 'local-coder': { window: '1h', max: 1 } },
      },
    } as import('../src/core/types.js').AshlrConfig;
    expect(inspectGeneratedRepairRouteFeasibility(fresh, cappedCfg, freshPolicy)).toMatchObject({
      feasible: false,
      reason: 'route-capacity-unavailable',
    });

    const frontierItem = repairItem({
      id: 'repo:proposal-repair:888888888888',
      effort: 5,
      score: 10,
    });
    const frontierCfg = {
      ...cfg,
      foundry: { allowedBackends: ['claude', 'codex'] },
    } as import('../src/core/types.js').AshlrConfig;
    const selected = routeBackend(frontierItem, frontierCfg).backend;
    expect(['claude', 'codex']).toContain(selected);
    recordUse(selected);
    const selectedCappedCfg = {
      ...frontierCfg,
      foundry: {
        allowedBackends: ['claude', 'codex'],
        limits: { [selected]: { window: '1h', max: 1 } },
      },
    } as import('../src/core/types.js').AshlrConfig;
    const frontierPolicy = readGeneratedRepairQueueSnapshot().retryPolicy(frontierItem);
    expect(routeBackend(frontierItem, selectedCappedCfg).backend).toBe(selected);
    expect(inspectGeneratedRepairRouteFeasibility(
      frontierItem,
      selectedCappedCfg,
      frontierPolicy,
    )).toMatchObject({ feasible: false, reason: 'route-capacity-unavailable' });
  });

  it('rejects first parent-bound evidence that conflicts with durable routing tier', () => {
    const item = diagnosticRepairItem('local-coder', 'mid');

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'codex', tier: 'frontier',
    })).toMatchObject({ available: false, disposition: 'active', recorded: false });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      authoritativeEmptyRuns: 0,
    });
  });

  it('never accepts builtin fallback as authoritative repair evidence', () => {
    for (const item of [repairItem(), captureRepairItem(), diagnosticRepairItem()]) {
      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'builtin', tier: 'local',
      })).toMatchObject({ available: false, disposition: 'active', recorded: false });
      expect(readGeneratedRepairLifecycle(item)).toMatchObject({ authoritativeEmptyRuns: 0 });
    }
  });

  it('fails only the affected generation closed on persisted legacy builtin evidence', () => {
    const affected = repairItem({ id: 'repo:proposal-repair:555555555555' });
    const healthy = repairItem({ id: 'repo:proposal-repair:666666666666' });
    recordGeneratedRepairLifecycle(affected, {
      kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
    });
    recordGeneratedRepairLifecycle(healthy, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid',
    });
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ generationId: string; emptyAttemptBackends?: string[] }>;
    };
    const affectedGeneration = parsed.records.find((record) =>
      record.generationId !== parsed.records.find((candidate) => candidate.emptyAttemptBackends?.[0] === 'kimi')?.generationId
    )!;
    affectedGeneration.emptyAttemptBackends = ['builtin'];
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(affected)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(readGeneratedRepairLifecycle(healthy)).toMatchObject({
      available: true,
      authoritativeEmptyRuns: 1,
      lastAuthoritativeEmptyBackend: 'kimi',
    });
  });

  it('terminalizes a different same-tier retry for proposal and capture repairs', () => {
    const items = [
      repairItem({ id: 'repo:proposal-repair:111111111111' }),
      captureRepairItem({ id: 'repo:proposal-repair-capture:222222222222' }),
    ];
    for (const item of items) {
      recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
      });
      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid',
      })).toMatchObject({
        available: true,
        disposition: 'exhausted',
        authoritativeEmptyRuns: 2,
        authoritativeEmptyBackends: ['local-coder', 'kimi'],
        authoritativeEmptyTiers: ['mid', 'mid'],
        recorded: true,
      });
    }
  });

  it('rejects cross-tier retries for proposal and capture repairs', () => {
    const items = [
      repairItem({ id: 'repo:proposal-repair:333333333333' }),
      captureRepairItem({ id: 'repo:proposal-repair-capture:444444444444' }),
    ];
    for (const item of items) {
      recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid',
      });
      expect(recordGeneratedRepairLifecycle(item, {
        kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'codex', tier: 'frontier',
      })).toMatchObject({ available: false, disposition: 'active', recorded: false });
      expect(readGeneratedRepairLifecycle(item)).toMatchObject({
        available: true,
        disposition: 'active',
        authoritativeEmptyRuns: 1,
        authoritativeEmptyTiers: ['mid'],
      });
    }
  });

  it('uses a config-promoted backend as an exact-tier retry alternative', () => {
    const item = diagnosticRepairItem('codex', 'frontier');
    const cfg = {
      version: 1,
      roots: ['/tmp'],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
      foundry: {
        allowedBackends: ['codex', 'kimi'],
        kimi: { tier: 'frontier' },
      },
    } as import('../src/core/types.js').AshlrConfig;
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_TWO,
      backend: 'codex',
      tier: 'frontier',
    });

    expect(routeBackend(item, cfg)).toMatchObject({
      backend: 'kimi',
      tier: 'frontier',
      reason: expect.stringContaining('repair-alternative-selected'),
    });
  });

  it('retires only from a typed proposal-created transition', () => {
    const item = repairItem();
    const transition = recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: 'prop-generated-repair',
    });

    expect(transition).toMatchObject({
      available: true,
      disposition: 'retired',
      recorded: true,
      treatmentOutcomeWitness: {
        outcome: 'converted',
        disposition: 'retired',
        generationId: expect.stringMatching(/^[a-f0-9]{64}$/),
        attemptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: true,
      disposition: 'retired',
      authoritativeEmptyRuns: 0,
    });
    expect(readGeneratedRepairTerminalOutcome(transition.treatmentOutcomeWitness!.generationId))
      .toEqual(transition.treatmentOutcomeWitness);
  });

  it('keeps a terminal treatment witness in the lifecycle outbox until acknowledged', () => {
    const item = diagnosticRepairItem();
    const candidate: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: item.ts,
      itemId: item.id,
      source: item.source,
      repo: item.repo,
      title: item.title,
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'router',
      routeReason: 'test treatment',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'prop-treatment-outbox',
      runId: ATTEMPT_ONE,
      spentUsd: 0,
      basis: 'repair-lifecycle-candidate',
      repairHandoffId: item.repairHandoffId,
      repairGenerationId: item.repairGenerationId,
      repairTreatmentUnitId: item.repairTreatmentUnitId,
      repairTreatment: item.repairTreatment,
      repairAttemptOrdinal: 1,
    };
    const transition = recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: 'prop-treatment-outbox',
      treatmentCandidate: candidate,
    });
    writeFileSync(`${generatedRepairLifecyclePath()}.lock`, JSON.stringify({
      token: 'dead-outbox-owner',
      pid: 2_147_483_647,
      startRef: 'b'.repeat(64),
      startRefVerified: true,
    }), { encoding: 'utf8', mode: 0o600 });

    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([expect.objectContaining({
      generationId: item.repairGenerationId,
      attemptHash: transition.treatmentOutcomeWitness!.attemptHash,
      outcome: 'converted',
      candidate: expect.objectContaining({ itemId: item.id }),
    })]);
    expect(acknowledgeGeneratedRepairTreatmentOutcome(
      item.repairGenerationId!,
      transition.treatmentOutcomeWitness!.attemptHash,
    )).toBe(true);
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
  });

  it('exhausts after two distinct empty-diff attempts and deduplicates replay', () => {
    const item = repairItem();
    const first = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid' });
    const replay = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid' });
    const second = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid' });

    expect(first).toMatchObject({ disposition: 'active', authoritativeEmptyRuns: 1, recorded: true });
    expect(replay).toMatchObject({ disposition: 'active', authoritativeEmptyRuns: 1, recorded: false });
    expect(second).toMatchObject({
      disposition: 'exhausted',
      authoritativeEmptyRuns: 2,
      recorded: true,
      treatmentOutcomeWitness: {
        outcome: 'not-converted',
        disposition: 'exhausted',
        generationId: expect.stringMatching(/^[a-f0-9]{64}$/),
        attemptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(replay).not.toHaveProperty('treatmentOutcomeWitness');
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('exhausted');
    expect(readGeneratedRepairTerminalOutcome(second.treatmentOutcomeWitness!.generationId))
      .toEqual(second.treatmentOutcomeWitness);
  });

  it('quarantines one objective only with three unique same-tier attempts across two backends', () => {
    const item = diagnosticRepairItem('local-coder', 'mid');
    const first = recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'local-coder', tier: 'mid',
    });
    const second = recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_THREE, backend: 'kimi', tier: 'mid',
    });

    expect(first).toMatchObject({ disposition: 'active', authoritativeEmptyRuns: 1 });
    expect(second).toMatchObject({
      disposition: 'quarantined',
      authoritativeEmptyRuns: 2,
      authoritativeEmptyBackends: ['local-coder', 'kimi'],
      authoritativeEmptyTiers: ['mid', 'mid'],
      treatmentOutcomeWitness: { outcome: 'not-converted', disposition: 'quarantined' },
    });
    expect(readGeneratedRepairTerminalOutcome(second.treatmentOutcomeWitness!.generationId))
      .toEqual(second.treatmentOutcomeWitness);
  });

  it('quarantines complete objective-bound V1 handoffs on the default writer path', () => {
    const item = diagnosticRepairItem('local-coder', 'mid', 1);
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'local-coder', tier: 'mid',
    });
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_THREE, backend: 'kimi', tier: 'mid',
    })).toMatchObject({ disposition: 'quarantined' });
  });

  it('rejects cross-tier second-attempt evidence before it can become terminal', () => {
    const item = diagnosticRepairItem('local-coder', 'mid');
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'local-coder', tier: 'mid',
    });
    const second = recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_THREE, backend: 'codex', tier: 'frontier',
    });

    expect(second).toMatchObject({ available: false, disposition: 'active', recorded: false });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
      authoritativeEmptyBackends: ['local-coder'],
      authoritativeEmptyTiers: ['mid'],
    });
  });

  it.each([
    { field: 'emptyAttemptTiers', value: ['mid', 'frontier'] },
    { field: 'emptyAttemptBackends', value: ['local-coder', 'builtin'] },
  ])('rejects persisted quarantine with impossible $field evidence', ({ field, value }) => {
    const item = diagnosticRepairItem('local-coder', 'mid');
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'local-coder', tier: 'mid',
    });
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_THREE, backend: 'kimi', tier: 'mid',
    });
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { records: Array<Record<string, unknown>> };
    parsed.records[0]![field] = value;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('rejects a replay that changes the authoritative backend for one attempt', () => {
    const item = repairItem();
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'kimi',
      tier: 'mid',
    })).toMatchObject({ available: false, recorded: false, authoritativeEmptyRuns: 1 });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      lastAuthoritativeEmptyBackend: 'local-coder',
    });
  });

  it('keeps pre-backend lifecycle rows readable but refuses to infer retry authority', () => {
    const item = diagnosticRepairItem();
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_TWO,
      backend: 'local-coder',
      tier: 'mid',
    });
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ emptyAttemptBackends?: string[]; emptyAttemptTiers?: string[] }>;
    };
    delete parsed.records[0]!.emptyAttemptBackends;
    delete parsed.records[0]!.emptyAttemptTiers;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
      authoritativeEmptyRuns: 1,
      lastAuthoritativeEmptyBackend: null,
    });
    expect(generatedRepairRetryPolicy(item)).toMatchObject({
      applies: true,
      available: false,
      requireAlternative: false,
      excludedBackend: null,
    });
  });

  it('hydrates pre-tier active evidence only from the durable objective handoff tier', () => {
    const item = diagnosticRepairItem();
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'local-coder', tier: 'mid',
    });
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ emptyAttemptTiers?: string[] }>;
    };
    delete parsed.records[0]!.emptyAttemptTiers;
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
      lastAuthoritativeEmptyBackend: 'local-coder',
      authoritativeEmptyTiers: ['mid'],
    });
    expect(generatedRepairRetryPolicy(item)).toMatchObject({
      applies: true,
      available: true,
      requireAlternative: true,
      excludedBackend: 'local-coder',
    });
  });

  it('keeps non-terminal failures retryable without creating control state', () => {
    const item = repairItem();
    const transition = recordGeneratedRepairLifecycle(item, {
      kind: 'non-terminal',
      attemptId: ATTEMPT_ONE,
    });

    expect(transition).toEqual({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('active');
  });

  it('keeps terminal states absorbing against late outcomes', () => {
    const item = repairItem();
    recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: 'prop-generated-repair',
    });
    const late = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi', tier: 'mid' });

    expect(late).toMatchObject({ disposition: 'retired', recorded: false });
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('retired');
  });

  it('preserves terminal tombstones when active-record retention reaches its count cap', () => {
    const terminalItem = repairItem({ id: 'repo:proposal-repair:111111111111' });
    expect(recordGeneratedRepairLifecycle(terminalItem, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: 'prop-terminal-cap',
    })).toMatchObject({ disposition: 'retired', recorded: true });
    const path = generatedRepairLifecyclePath();
    const terminal = (JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<Record<string, unknown>>;
    }).records[0]!;
    const updatedAt = '2026-07-10T12:00:00.000Z';
    const active = Array.from({ length: 99_999 }, (_, index) => ({
      generationId: index.toString(16).padStart(64, '0'),
      disposition: 'active',
      emptyAttemptHashes: [],
      updatedAt,
    }));
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, records: [terminal, ...active] }), 'utf8');

    const appended = recordGeneratedRepairLifecycle(
      repairItem({ id: 'repo:proposal-repair:222222222222' }),
      { kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'local-coder', tier: 'mid' },
    );
    const persisted = (JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<Record<string, unknown>>;
    }).records;

    expect(appended).toMatchObject({ disposition: 'active', recorded: true });
    expect(persisted).toHaveLength(100_000);
    expect(persisted).toContainEqual(expect.objectContaining({
      generationId: terminal['generationId'],
      disposition: 'retired',
    }));
    expect(readGeneratedRepairLifecycle(terminalItem)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
  }, 30_000);

  it('fails closed instead of dropping a new active transition at the terminal count cap', () => {
    const updatedAt = '2026-07-10T12:00:00.000Z';
    const terminal = Array.from({ length: 100_000 }, (_, index) => ({
      generationId: index.toString(16).padStart(64, '0'),
      disposition: 'retired',
      emptyAttemptHashes: [],
      updatedAt,
    }));
    const path = generatedRepairLifecyclePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, records: terminal }), 'utf8');

    const appended = recordGeneratedRepairLifecycle(
      repairItem({ id: 'repo:proposal-repair:333333333333' }),
      { kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'local-coder', tier: 'mid' },
    );
    const persisted = (JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<Record<string, unknown>>;
    }).records;

    expect(appended).toMatchObject({ available: false, recorded: false });
    expect(persisted).toHaveLength(100_000);
    expect(persisted.every((record) => record['disposition'] === 'retired')).toBe(true);
  }, 30_000);

  it('does not suppress a newer immutable generation with the same deterministic item id', () => {
    const firstGeneration = repairItem();
    recordGeneratedRepairLifecycle(firstGeneration, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: 'prop-generated-repair',
    });
    const nextGeneration = repairItem({ ts: '2026-07-10T13:00:00.000Z' });

    expect(readGeneratedRepairLifecycle(firstGeneration).disposition).toBe('retired');
    expect(readGeneratedRepairLifecycle(nextGeneration)).toEqual({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('scopes generations by canonical repo and ignores presentation-only changes', () => {
    const item = repairItem();
    recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: 'prop-generated-repair',
    });
    const presentationChange = repairItem({
      title: 'Proposal repair: reworded generated repair title',
      detail:
        'Proposal repair: wording changed.\n' +
        'Proposal: prop-stalled\n' +
        'Original work item: repo:goal:stalled\n' +
        'Produce a fresh complete fix with clearer wording.',
    });
    const otherRepo = repairItem({ repo: '/tmp/other-repo' });

    expect(readGeneratedRepairLifecycle(presentationChange).disposition).toBe('retired');
    expect(readGeneratedRepairLifecycle(otherRepo).disposition).toBe('active');
  });

  it.each([
    repairItem({ source: 'backlog' }),
    repairItem({ id: 'repo:manual-repair' }),
    repairItem({ ts: 'invalid' }),
  ])('fails open for untrusted or invalid repair generation %#', (item) => {
    const transition = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid' });
    expect(transition.available).toBe(false);
    expect(transition.recorded).toBe(false);
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('active');
  });

  it('rejects unsafe attempt and proposal identities', () => {
    const item = repairItem();
    const badAttempt = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: 'work:spoofed', backend: 'local-coder', tier: 'mid' });
    const badProposal = recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: '../proposal',
    });

    expect(badAttempt.recorded).toBe(false);
    expect(badProposal.recorded).toBe(false);
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('active');
  });

  it('rejects caller-shaped handoff generation fields that are not cryptographically bound', () => {
    const forged = repairItem({
      repairHandoffId: 'a'.repeat(64),
      repairGenerationId: 'b'.repeat(64),
    });
    const transition = recordGeneratedRepairLifecycle(forged, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    });

    expect(transition).toMatchObject({ available: false, recorded: false });
    expect(readGeneratedRepairLifecycle(forged).available).toBe(false);
  });

  it('reports corrupt state unavailable without inventing terminal evidence', () => {
    const path = generatedRepairLifecyclePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{corrupt', 'utf8');

    expect(readGeneratedRepairLifecycle(repairItem())).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(recordGeneratedRepairLifecycle(repairItem(), {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    }).recorded).toBe(false);
  });

  it('reports live writer contention unavailable without poisoning later reads', () => {
    const item = repairItem();
    const lockPath = `${generatedRepairLifecyclePath()}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ token: 'other-owner', pid: process.pid }), { encoding: 'utf8', mode: 0o600 });

    expect(readGeneratedRepairLifecycle(item).available).toBe(false);
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    }).recorded).toBe(false);

    rmSync(lockPath);
    expect(() => readFileSync(`${generatedRepairLifecyclePath()}.failed`)).toThrow();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toMatchObject({ recorded: true, authoritativeEmptyRuns: 1 });
  });

  it('recovers a lifecycle lock left by a dead owner', () => {
    const item = repairItem();
    const lockPath = `${generatedRepairLifecyclePath()}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      token: 'dead-owner',
      pid: 2_147_483_647,
      startRef: 'a'.repeat(64),
      startRefVerified: true,
    }), { encoding: 'utf8', mode: 0o600 });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toMatchObject({ available: true, recorded: true, authoritativeEmptyRuns: 1 });
    expect(readGeneratedRepairLifecycle(item).available).toBe(true);
  });

  it('rejects a symlink ledger without mutating its target and recovers after repair', () => {
    const item = repairItem();
    const path = generatedRepairLifecyclePath();
    mkdirSync(dirname(path), { recursive: true });
    const target = `${path}.target`;
    writeFileSync(target, 'do-not-mutate\n', { mode: 0o600 });
    symlinkSync(target, path);

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    });
    expect(readGeneratedRepairLifecycle(item).available).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('do-not-mutate\n');

    rmSync(path);
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
      tier: 'mid',
    })).toMatchObject({ available: true, recorded: true, authoritativeEmptyRuns: 1 });
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({ available: true, authoritativeEmptyRuns: 1 });
  });

  it('rejects duplicate generation records instead of weakening terminal state', () => {
    const item = repairItem();
    recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: 'prop-generated-repair',
    });
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: 1; records: unknown[] };
    parsed.records.push(parsed.records[0]);
    writeFileSync(path, JSON.stringify(parsed), 'utf8');

    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('persists only hashed identities with owner-only permissions', () => {
    const item = repairItem();
    recordGeneratedRepairLifecycle(item, {
      kind: 'proposal-created',
      attemptId: ATTEMPT_ONE,
      proposalId: 'prop-generated-repair',
    });
    const path = generatedRepairLifecyclePath();
    const raw = readFileSync(path, 'utf8');

    expect(raw).not.toContain(item.repo);
    expect(raw).not.toContain(item.id);
    expect(raw).not.toContain(item.title);
    expect(raw).not.toContain(item.detail);
    expect(raw).not.toContain(ATTEMPT_ONE);
    expect(raw).not.toContain('prop-generated-repair');
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('reports unavailable when the exact lifecycle directory is not writable', () => {
    const item = repairItem();
    recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder', tier: 'mid' });
    const dir = dirname(generatedRepairLifecyclePath());
    chmodSync(dir, 0o500);

    try {
      expect(readGeneratedRepairLifecycle(item)).toMatchObject({ available: false });
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

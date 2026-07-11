import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  generatedRepairLifecyclePath,
  generatedRepairRetryPolicy,
  readGeneratedRepairLifecycle,
  recordGeneratedRepairLifecycle,
} from '../src/core/fleet/generated-repair-lifecycle.js';
import type { WorkItem } from '../src/core/types.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { routeBackend } from '../src/core/fleet/router.js';
import {
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

function diagnosticRepairItem(
  parentBackend: 'local-coder' | 'codex' = 'local-coder',
  parentTier: 'mid' | 'frontier' = 'mid',
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
  const handoff = repairHandoffFromDispatchEvent(parent)!;
  recordRepairHandoffs(parent);
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
    repairParentItemId: parent.itemId,
    repairParentSource: parent.source,
    repairParentBackend: parent.backend,
    repairParentTier: parent.tier,
    repairParentObjectiveHash: parent.objectiveHash,
  };
}

const ATTEMPT_ONE = 'attempt-12345678-1234-4123-8123-123456789abc';
const ATTEMPT_TWO = 'attempt-22345678-1234-4123-8123-123456789abc';

describe('generated repair lifecycle store', () => {
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
    });
    expect(routeBackend(item, cfg)).toMatchObject({
      backend: 'kimi',
      tier: 'mid',
      reason: expect.stringContaining('repair-alternative-selected'),
    });
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

    expect(transition).toMatchObject({ available: true, disposition: 'retired', recorded: true });
    expect(readGeneratedRepairLifecycle(item)).toEqual({
      available: true,
      disposition: 'retired',
      authoritativeEmptyRuns: 0,
    });
  });

  it('exhausts after two distinct empty-diff attempts and deduplicates replay', () => {
    const item = repairItem();
    const first = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder' });
    const replay = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder' });
    const second = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi' });

    expect(first).toMatchObject({ disposition: 'active', authoritativeEmptyRuns: 1, recorded: true });
    expect(replay).toMatchObject({ disposition: 'active', authoritativeEmptyRuns: 1, recorded: false });
    expect(second).toMatchObject({ disposition: 'exhausted', authoritativeEmptyRuns: 2, recorded: true });
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('exhausted');
  });

  it('rejects a replay that changes the authoritative backend for one attempt', () => {
    const item = repairItem();
    recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
    });

    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'kimi',
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
    });
    const path = generatedRepairLifecyclePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      records: Array<{ emptyAttemptBackends?: string[] }>;
    };
    delete parsed.records[0]!.emptyAttemptBackends;
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
    const late = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_TWO, backend: 'kimi' });

    expect(late).toMatchObject({ disposition: 'retired', recorded: false });
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('retired');
  });

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
    const transition = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder' });
    expect(transition.available).toBe(false);
    expect(transition.recorded).toBe(false);
    expect(readGeneratedRepairLifecycle(item).disposition).toBe('active');
  });

  it('rejects unsafe attempt and proposal identities', () => {
    const item = repairItem();
    const badAttempt = recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: 'work:spoofed', backend: 'local-coder' });
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
    }).recorded).toBe(false);

    rmSync(lockPath);
    expect(() => readFileSync(`${generatedRepairLifecyclePath()}.failed`)).toThrow();
    expect(recordGeneratedRepairLifecycle(item, {
      kind: 'empty-diff',
      attemptId: ATTEMPT_ONE,
      backend: 'local-coder',
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
    recordGeneratedRepairLifecycle(item, { kind: 'empty-diff', attemptId: ATTEMPT_ONE, backend: 'local-coder' });
    const dir = dirname(generatedRepairLifecyclePath());
    chmodSync(dir, 0o500);

    try {
      expect(readGeneratedRepairLifecycle(item)).toMatchObject({ available: false });
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { buildBacklog } from '../src/core/portfolio/backlog.js';
import { scanQueuedAutonomyWork } from '../src/core/portfolio/scanners.js';
import { queueProposalRepairWorkForPendingProposals } from '../src/core/fleet/proposal-repair-work.js';
import type { Proposal, WorkItem } from '../src/core/types.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

function item(repo: string, id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    repo,
    source: 'invent',
    title: `Implement queued autonomy item ${id}`,
    detail: 'Implement a focused code change that improves autonomous engineering reliability.',
    value: 5,
    effort: 2,
    score: 2.5,
    tags: ['generative', 'bold'],
    ts: new Date().toISOString(),
    ...overrides,
  };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(fx.ashlrDir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function partialProposal(repo: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-partial-repair',
    repo,
    origin: 'swarm',
    kind: 'patch',
    title: 'Partial proposal with useful work',
    summary: 'A sandbox produced partial work that needs repair.',
    status: 'pending',
    createdAt: new Date().toISOString(),
    diff: 'diff --git a/src/secret.ts b/src/secret.ts\n+const leaked = "DO_NOT_COPY_DIFF";\n',
    workItemId: 'repo:goal:original',
    isPartial: true,
    verifyResult: {
      passed: false,
      detail: 'capture gate blocked proposal after test failure in src/app.ts:12: expected ready state',
      source: 'capture-gate',
    },
    ...overrides,
  };
}

function captureFailure(repo: string, overrides: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  return {
    schemaVersion: 1,
    ts: '2026-07-09T12:00:00.000Z',
    machineId: 'm310',
    itemId: 'repo:self:original-capture',
    source: 'self',
    repo,
    title: 'Self improvement capture failure with useful work',
    backend: 'local-coder',
    tier: 'local',
    model: 'qwen',
    assignedBy: 'daemon',
    routeReason: 'self-improvement local route',
    outcome: 'gate-blocked',
    proposalCreated: false,
    spentUsd: 0,
    reason: 'gate-blocked: completeness gate blocked proposal after test failure',
    basis: 'run-proposal-outcome',
    ...overrides,
  };
}

describe('queued autonomy work scanner', () => {
  it('rehydrates self-heal and invent items for the scanned enrolled repo only', async () => {
    const repo = fx.makeRepo();
    const otherRepo = fx.makeRepo();
    repo.enroll();
    otherRepo.enroll();

    const heal = item(repo.dir, 'heal-1', {
      source: 'self',
      title: 'Fix broken build in repo: src/index.ts(12,5): error TS2345',
      detail: "Self-heal: build is RED.\nFirst failure: src/index.ts(12,5): error TS2345: Argument of type 'string' is not assignable.",
      tags: ['self-heal', 'verify', 'build'],
    });
    const invent = item(repo.dir, 'invent-1');
    const wrongRepo = item(otherRepo.dir, 'invent-other');
    const lowSignal = item(repo.dir, 'todo-1', { source: 'todo', tags: ['todo'] });

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [heal, wrongRepo]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), {
      generatedAt: '2026-07-02T00:00:00.000Z',
      repos: [repo.dir, otherRepo.dir],
      items: [invent, lowSignal],
    });

    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(found.map((x) => x.id)).toEqual(['heal-1', 'invent-1']);
  });

  it('preserves queued autonomy items through a full backlog refresh', async () => {
    const repo = fx.makeRepo();
    repo.enroll();

    const heal = item(repo.dir, 'heal-build-1', {
      source: 'self',
      title: 'Repair failing autonomous daemon verification: src/daemon.ts(4,1): error TS2304',
      detail: 'Self-heal: build is RED.\nFirst failure: src/daemon.ts(4,1): error TS2304: Cannot find name daemon.',
      tags: ['self-heal', 'daemon'],
    });
    const invent = item(repo.dir, 'invent-build-1', {
      title: 'Add autonomous work selection telemetry',
      tags: ['generative', 'selection'],
    });

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [heal]);
    writeJson(join(fx.ashlrDir, 'backlog.json'), {
      generatedAt: '2026-07-02T00:00:00.000Z',
      repos: [repo.dir],
      items: [invent],
    });

    const backlog = await buildBacklog({
      repos: [repo.dir],
      minItemValue: 2,
      cfg: { foundry: { feedbackEnabled: false } },
      listPendingProposals: () => [],
    });

    expect(backlog.items.some((x) => x.id === 'heal-build-1')).toBe(true);
    expect(backlog.items.some((x) => x.id === 'invent-build-1')).toBe(true);
  });

  it('drops queued self-heal items that only contain toolchain or lifecycle noise', async () => {
    const repo = fx.makeRepo();
    repo.enroll();

    const actionable = item(repo.dir, 'heal-actionable', {
      source: 'self',
      title: 'Fix broken build in repo: src/__tests__/capability-registry.test.ts(256,39): error TS2769',
      detail: 'Self-heal: build is RED.\nFirst failure: src/__tests__/capability-registry.test.ts(256,39): error TS2769: No overload matches this call.',
      tags: ['self-heal', 'build'],
    });
    const banner = item(repo.dir, 'heal-banner', {
      source: 'self',
      title: 'Fix broken build in 10:4: > clipbridge-relay@0.1.0 check',
      detail: 'Self-heal: build is RED.\nFirst failure: > clipbridge-relay@0.1.0 check',
      tags: ['self-heal', 'build'],
    });
    const rustup = item(repo.dir, 'heal-rustup', {
      source: 'self',
      title: "Fix broken build in ashlr-pulse: error: rustup could not choose a version of cargo to run, because one wasn't specified explicitly, and no default is configured.",
      detail: "Self-heal: build is RED.\nFirst failure: error: rustup could not choose a version of cargo to run, because one wasn't specified explicitly, and no default is configured.",
      tags: ['self-heal', 'build'],
    });
    const cargoProgress = item(repo.dir, 'heal-cargo-progress', {
      source: 'self',
      title: 'Fix broken build in phantom-secrets: Downloaded thiserror v2.0.18',
      detail: 'Self-heal: build is RED.\nFirst failure: Downloaded thiserror v2.0.18',
      tags: ['self-heal', 'build'],
    });
    const missingTool = item(repo.dir, 'heal-missing-tool', {
      source: 'self',
      title: `Fix broken build in binshield: Error: Cannot find module '${repo.dir}/node_modules/typescript/bin/tsc'`,
      detail: `Self-heal: build is RED.\nFirst failure: Error: Cannot find module '${repo.dir}/node_modules/typescript/bin/tsc'`,
      tags: ['self-heal', 'build'],
    });

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [
      actionable,
      banner,
      rustup,
      cargoProgress,
      missingTool,
    ]);

    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(found.map((x) => x.id)).toEqual(['heal-actionable']);
  });

  it('queues metadata-only repair work for partial or failed-verify proposals idempotently', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const proposal = partialProposal(repo.dir, {
      verifyResult: {
        passed: false,
        detail: 'capture gate blocked proposal after test failure in src/app.ts:12: expected github_pat_1234567890abcdefghijklmnop to be absent',
        source: 'capture-gate',
      },
    });

    const first = queueProposalRepairWorkForPendingProposals([proposal]);
    const second = queueProposalRepairWorkForPendingProposals([proposal]);
    const rawQueue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(first).toMatchObject({ scanned: 1, eligible: 1, queued: 1, failed: 0 });
    expect(second).toMatchObject({ scanned: 1, eligible: 1, queued: 1, failed: 0 });
    expect(rawQueue).toHaveLength(1);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      repo: repo.dir,
      source: 'self',
      tags: expect.arrayContaining(['self-heal', 'proposal-repair', 'partial', 'verify']),
    });
    expect(found[0]!.detail).toContain(proposal.id);
    expect(found[0]!.detail).toContain(proposal.workItemId);
    expect(found[0]!.detail).not.toContain('DO_NOT_COPY_DIFF');
    expect(found[0]!.detail).not.toContain('github_pat_1234567890abcdefghijklmnop');
    expect(found[0]!.detail).toContain('[REDACTED]');
  });

  it('queues metadata-only repair work for self capture-gate failures idempotently', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const older = new Date(now.getTime() - 120_000).toISOString();
    const event = captureFailure(repo.dir, {
      ts: recent,
      runId: 'run-capture-new',
      reason: 'proposal-capture-error: failed after stdout=DO_NOT_COPY_STDOUT; src/app.ts:12 expected ready state token=github_pat_1234567890abcdefghijklmnop',
      outcome: 'proposal-capture-error',
      diffFiles: 3,
      diffLines: 44,
    });
    const duplicateOlderEvent = captureFailure(repo.dir, {
      ts: older,
      runId: 'run-capture-old',
      reason: 'proposal-capture-error: src/old.ts:5 expected stale state',
      outcome: 'proposal-capture-error',
      diffFiles: 1,
      diffLines: 9,
    });
    const gateEvent = captureFailure(repo.dir, {
      ts: recent,
      itemId: 'repo:self:gate-capture',
      runId: 'run-gate-capture',
      outcome: 'gate-blocked',
      reason: 'completeness gate blocked proposal: src/gate.ts:9 expected ready state',
      runEventSummary: {
        actionCounts: {
          completenessGateRuns: 1,
          proposalBlocked: 1,
          diffFiles: 1,
          diffLines: 6,
        },
      },
    });

    const first = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [duplicateOlderEvent, event, gateEvent],
    });
    const second = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [duplicateOlderEvent, event, gateEvent],
    });
    const rawQueue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    const found = await scanQueuedAutonomyWork(repo.dir);
    const captureRepair = found.find((item) => item.detail.includes(event.itemId));
    const gateRepair = found.find((item) => item.detail.includes(gateEvent.itemId));

    expect(first).toMatchObject({
      scanned: 3,
      eligible: 2,
      queued: 2,
      failed: 0,
      dispatchCaptureScanned: 3,
      dispatchCaptureEligible: 2,
      dispatchCaptureQueued: 2,
      dispatchCaptureFailed: 0,
    });
    expect(second).toMatchObject({ scanned: 3, eligible: 2, queued: 2, failed: 0 });
    expect(rawQueue).toHaveLength(2);
    expect(found).toHaveLength(2);
    expect(captureRepair).toMatchObject({
      repo: repo.dir,
      source: 'self',
      tags: expect.arrayContaining(['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate', 'verify', 'high-priority']),
    });
    expect(captureRepair!.id).toContain(':proposal-repair-capture:');
    expect(captureRepair!.id).not.toContain(event.reason!);
    expect(captureRepair!.detail).toContain(event.itemId);
    expect(captureRepair!.detail).toContain('run-capture-new');
    expect(captureRepair!.detail).not.toContain('run-capture-old');
    expect(captureRepair!.detail).toContain('proposal-capture-error');
    expect(captureRepair!.detail).not.toContain('DO_NOT_COPY_STDOUT');
    expect(captureRepair!.detail).not.toContain('github_pat_1234567890abcdefghijklmnop');
    expect(captureRepair!.detail).toContain('stdout=[omitted]');
    expect(gateRepair).toBeDefined();
    expect(gateRepair!.detail).toContain('gate-blocked');
  });

  it('queues metadata-only diagnostic reslice work for no-diff dispatches idempotently', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const older = new Date(now.getTime() - 120_000).toISOString();
    const event = captureFailure(repo.dir, {
      ts: recent,
      itemId: 'repo:goal:no-diff',
      source: 'goal',
      runId: 'run-nodiff-new',
      outcome: 'empty-diff',
      reason: 'empty-diff: engine completed without file changes; stdout=DO_NOT_COPY_STDOUT; prompt=DO_NOT_COPY_PROMPT; token=github_pat_1234567890abcdefghijklmnop',
      routeReason: 'local-coder route with env=DO_NOT_COPY_ENV',
    });
    const duplicateOlderEvent = captureFailure(repo.dir, {
      ts: older,
      itemId: 'repo:goal:no-diff',
      source: 'goal',
      runId: 'run-nodiff-old',
      outcome: 'empty-diff',
      reason: 'empty-diff: older no diff reason',
    });

    const first = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [duplicateOlderEvent, event],
    });
    const second = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: [duplicateOlderEvent, event],
    });
    const rawQueue = JSON.parse(readFileSync(join(fx.ashlrDir, 'self-heal-queue.json'), 'utf8')) as WorkItem[];
    const found = await scanQueuedAutonomyWork(repo.dir);
    const reslice = found.find((item) => item.tags.includes('dispatch-no-diff-reslice'));

    expect(first).toMatchObject({
      scanned: 2,
      eligible: 1,
      queued: 1,
      failed: 0,
      dispatchCaptureScanned: 2,
      dispatchCaptureEligible: 0,
      dispatchCaptureQueued: 0,
      dispatchCaptureFailed: 0,
      dispatchNoDiffScanned: 2,
      dispatchNoDiffEligible: 1,
      dispatchNoDiffQueued: 1,
      dispatchNoDiffFailed: 0,
    });
    expect(second).toMatchObject({ scanned: 2, eligible: 1, queued: 1, failed: 0 });
    expect(rawQueue).toHaveLength(1);
    expect(found).toHaveLength(1);
    expect(reslice).toMatchObject({
      repo: repo.dir,
      source: 'self',
      tags: expect.arrayContaining(['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice', 'no-diff', 'verify', 'high-priority']),
    });
    expect(reslice!.id).toContain(':proposal-repair-nodiff:');
    expect(reslice!.id).not.toContain(event.reason!);
    expect(reslice!.detail).toContain(event.itemId);
    expect(reslice!.detail).toContain('run-nodiff-new');
    expect(reslice!.detail).not.toContain('run-nodiff-old');
    expect(reslice!.detail).toContain('Dispatch outcome: empty-diff');
    expect(reslice!.detail).toContain('Action: reslice');
    expect(reslice!.detail).toContain('stdout=[omitted]');
    expect(reslice!.detail).toContain('prompt=[omitted]');
    expect(reslice!.detail).toContain('env=[omitted]');
    expect(reslice!.detail).not.toContain('DO_NOT_COPY');
    expect(reslice!.detail).not.toContain('github_pat_1234567890abcdefghijklmnop');
  });

  it('does not rehydrate hand-written diagnostic reslice lookalikes', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const lookalike = item(repo.dir, 'manual-diagnostic-reslice', {
      source: 'self',
      title: 'Manual diagnostic reslice',
      detail:
        'Diagnostic reslice: copied shape.\n' +
        'Original work item: repo:goal:no-diff\n' +
        'Dispatch outcome: empty-diff\n' +
        'Action: reslice the work into a smaller edit.',
      tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
    });

    writeJson(join(fx.ashlrDir, 'self-heal-queue.json'), [lookalike]);

    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(found).toEqual([]);
  });

  it('does not queue capture-gate repair for non-self, disabled, or successful dispatches', async () => {
    const repo = fx.makeRepo();
    const otherRepo = fx.makeRepo();
    repo.enroll();
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const events: DispatchProductionEvent[] = [
      captureFailure(repo.dir, { ts: recent, itemId: 'todo-gate', source: 'todo' }),
      captureFailure(repo.dir, { ts: recent, itemId: 'self-disabled', outcome: 'proposal-disabled' }),
      captureFailure(repo.dir, {
        ts: recent,
        itemId: 'self-success',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-created',
      }),
      captureFailure(repo.dir, {
        ts: recent,
        itemId: 'self-generic-capture',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: capture failed without source failure evidence',
      }),
      captureFailure(repo.dir, {
        ts: recent,
        itemId: 'self-generic-gate',
        outcome: 'gate-blocked',
        routeReason: 'local route',
        reason: 'tests still failing after 2 attempt(s)',
      }),
      captureFailure(repo.dir, {
        ts: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
        itemId: 'self-old-capture',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: src/old.ts:5 expected old state',
      }),
      captureFailure(repo.dir, {
        ts: new Date(now.getTime() + 60_000).toISOString(),
        itemId: 'self-future-capture',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: src/future.ts:5 expected future state',
      }),
      captureFailure(repo.dir, {
        ts: recent,
        itemId: 'repo:proposal-repair:existing',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: src/repair.ts:5 expected repair state',
      }),
      captureFailure(otherRepo.dir, {
        ts: recent,
        itemId: 'other-unenrolled',
        outcome: 'proposal-capture-error',
        reason: 'proposal-capture-error: src/other.ts:5 expected other state',
      }),
    ];

    const result = queueProposalRepairWorkForPendingProposals(undefined, now, {
      dispatchEvents: events,
    });
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(result).toMatchObject({ scanned: events.length, eligible: 0, queued: 0, failed: 0 });
    expect(found).toEqual([]);
  });

  it('does not queue repair work for clean pending proposals', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const proposal = partialProposal(repo.dir, {
      isPartial: false,
      verifyResult: { passed: true, detail: 'verified', source: 'manual' },
    });

    const result = queueProposalRepairWorkForPendingProposals([proposal]);
    const found = await scanQueuedAutonomyWork(repo.dir);

    expect(result).toMatchObject({ scanned: 1, eligible: 0, queued: 0, failed: 0 });
    expect(found).toEqual([]);
  });

  it('keeps proposal repair work eligible even when the original item is pending-covered', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const proposal = partialProposal(repo.dir);
    queueProposalRepairWorkForPendingProposals([proposal]);

    const backlog = await buildBacklog({
      repos: [repo.dir],
      minItemValue: 2,
      cfg: { foundry: { feedbackEnabled: false } },
      listPendingProposals: () => [proposal],
    });

    expect(backlog.items.some((x) => x.tags.includes('proposal-repair'))).toBe(true);
    expect(backlog.items.find((x) => x.tags.includes('proposal-repair'))?.id).not.toBe(proposal.workItemId);
  });
});

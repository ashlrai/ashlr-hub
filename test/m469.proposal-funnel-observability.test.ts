import { describe, expect, it } from 'vitest';

import type {
  DispatchProductionEvent,
  DispatchProductionSourceQuality,
} from '../src/core/fleet/dispatch-production-ledger.js';
import { sanitizeDispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import {
  buildProposalFunnelObservability,
  withholdProposalFunnelForUnstableSnapshot,
} from '../src/core/fleet/proposal-funnel-observability.js';

const healthySource: DispatchProductionSourceQuality = {
  sourceState: 'healthy',
  sourcePresent: true,
  complete: true,
  stopReasons: [],
  filesRead: 1,
  datedFilesRead: 1,
  looseFilesRead: 0,
  bytesRead: 1_000,
  rowsScanned: 10,
  invalidRows: 0,
  unreadableFiles: 0,
};

function attemptIdFor(itemId: string): string {
  const suffix = [...itemId].reduce((value, char) => value + char.charCodeAt(0), 0)
    .toString(16)
    .padStart(12, '0')
    .slice(-12);
  return `attempt-00000000-0000-4000-8000-${suffix}`;
}

function event(
  itemId: string,
  outcome: DispatchProductionEvent['outcome'],
  overrides: Partial<DispatchProductionEvent> = {},
): DispatchProductionEvent {
  const attemptId = attemptIdFor(itemId);
  return {
    schemaVersion: 1,
    ts: `2026-07-31T00:00:${itemId.padStart(2, '0')}.000Z`,
    itemId,
    source: 'goal',
    repo: '/private/repo',
    title: 'SECRET_PROMPT_TEXT',
    backend: 'local-coder',
    tier: 'mid',
    assignedBy: 'daemon',
    routeReason: 'PRIVATE_ROUTE_REASON',
    outcome,
    proposalCreated: outcome === 'proposal-created',
    attemptId,
    runId: `run-${itemId}`,
    trajectoryId: `run:${attemptId}`,
    spentUsd: 0,
    reason: 'STDOUT_SECRET_TOKEN',
    basis: 'run-proposal-outcome',
    ...overrides,
  };
}

describe('buildProposalFunnelObservability', () => {
  it('projects bounded proposal-funnel counters without copying raw event prose', () => {
    const result = buildProposalFunnelObservability({
      events: [
        event('1', 'proposal-created', { proposalId: 'proposal-1' }),
        event('2', 'gate-blocked', { proposalId: 'partial-2', diffFiles: 2 }),
        event('3', 'proposal-capture-error', { diffFiles: 3 }),
        event('4', 'proposal-disabled'),
        event('5', 'empty-diff'),
        event('6', 'engine-failed'),
        event('7', 'cancelled'),
        event('8', 'empty-diff', { basis: 'repair-lifecycle-candidate' }),
      ],
      sourceQuality: healthySource,
      windowMs: 24 * 60 * 60 * 1000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      schemaVersion: 3,
      state: 'available',
      sample: {
        requestedWindowHours: 24,
        observedEvents: 8,
        includedAttempts: 6,
        excludedLifecycleEvents: 1,
        cancelledEvents: 1,
        duplicateEvents: 0,
        invalidAttemptIdentities: 0,
        conflictingAttemptIdentities: 0,
      },
      metrics: {
        attempts: 6,
        reportedProposalCreatedOutcomes: { count: 1, rate: 1 / 6 },
        observedProposalReferences: { count: 2, rate: 2 / 6 },
        captureErrors: { count: 1, rate: 1 / 6 },
        policySuppressions: { count: 1, rate: 1 / 6 },
        gateBlocked: { count: 1, rate: 1 / 6 },
        emptyAttempts: { count: 1, rate: 1 / 6 },
        otherAttempts: { count: 1, rate: 1 / 6 },
      },
      primaryBlocker: 'capture-errors',
      primaryAction: 'repair-proposal-capture',
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET_PROMPT_TEXT');
    expect(serialized).not.toContain('STDOUT_SECRET_TOKEN');
    expect(serialized).not.toContain('PRIVATE_ROUTE_REASON');
    expect(serialized).not.toContain('/private/repo');
    expect(serialized).not.toContain('proposal-1');
    expect(serialized).not.toContain('partial-2');
  });

  it('withholds rates for degraded input while retaining sample and source truth', () => {
    const result = buildProposalFunnelObservability({
      events: [event('1', 'empty-diff'), event('2', 'proposal-created', { proposalId: 'proposal-2' })],
      sourceQuality: {
        ...healthySource,
        sourceState: 'degraded',
        complete: false,
        stopReasons: ['row-limit'],
        invalidRows: 4,
      },
      windowMs: 60 * 60 * 1000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      state: 'withheld',
      withheldReason: 'source-degraded',
      source: { sourceState: 'degraded', complete: false, stopReasons: ['row-limit'] },
      sample: { requestedWindowHours: 1, observedEvents: 2, includedAttempts: 2 },
      primaryBlocker: 'source-unavailable',
      primaryAction: 'repair-telemetry-source',
    });
    expect(result.metrics).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('proposal-2');
  });

  it('withholds an otherwise healthy projection when the local sample bound is exceeded', () => {
    const result = buildProposalFunnelObservability({
      events: [event('1', 'empty-diff'), event('2', 'proposal-created')],
      sourceQuality: healthySource,
      windowMs: 24 * 60 * 60 * 1000,
      eventLimit: 1,
    });

    expect(result).toMatchObject({
      state: 'withheld',
      withheldReason: 'sample-limit-exceeded',
      sample: { eventLimit: 1, observedEvents: 1, includedAttempts: 1 },
      primaryBlocker: 'sample-incomplete',
      primaryAction: 'increase-or-narrow-sample-window',
    });
    expect(result.metrics).toBeUndefined();
  });

  it('reports a healthy empty window as insufficient sample rather than starvation', () => {
    const result = buildProposalFunnelObservability({
      events: [],
      sourceQuality: healthySource,
      windowMs: 24 * 60 * 60 * 1000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      state: 'withheld',
      withheldReason: 'insufficient-sample',
      sample: { includedAttempts: 0, duplicateEvents: 0, conflictingAttemptIdentities: 0 },
      primaryBlocker: 'insufficient-sample',
      primaryAction: 'collect-attempts',
    });
    expect(result.metrics).toBeUndefined();
  });

  it('deduplicates exact identities after canonical semantic cancellation accounting', () => {
    const filed = event('1', 'proposal-created', {
      runId: 'run-filed',
      proposalId: 'proposal-filed',
    });
    const cancelled = event('2', 'cancelled', {
      runId: 'run-cancelled',
      reason: 'cancelled by owner',
    });
    const legacyCancelled = event('2', 'engine-failed', {
      runId: 'run-cancelled',
      reason: 'selection cancelled after daemon ownership changed',
      runEventSummary: { status: 'aborted', outcome: 'engine-failed', proposalCreated: false },
    });

    const result = buildProposalFunnelObservability({
      events: [filed, { ...filed }, cancelled, legacyCancelled],
      sourceQuality: healthySource,
      windowMs: 24 * 60 * 60 * 1000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      state: 'available',
      sample: {
        observedEvents: 4,
        includedAttempts: 1,
        cancelledEvents: 1,
        duplicateEvents: 2,
        conflictingAttemptIdentities: 0,
      },
      metrics: {
        attempts: 1,
        reportedProposalCreatedOutcomes: { count: 1, rate: 1 },
        observedProposalReferences: { count: 1, rate: 1 },
      },
    });
  });

  it('withholds all rates when rows sharing an attempt identity conflict', () => {
    const attemptId = attemptIdFor('conflict');
    const result = buildProposalFunnelObservability({
      events: [
        event('1', 'empty-diff', {
          attemptId,
          runId: 'run-conflict',
          trajectoryId: `run:${attemptId}`,
        }),
        event('2', 'proposal-created', {
          attemptId,
          runId: 'run-conflict',
          trajectoryId: `run:${attemptId}`,
          proposalId: 'proposal-conflict',
        }),
      ],
      sourceQuality: healthySource,
      windowMs: 24 * 60 * 60 * 1000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      state: 'withheld',
      withheldReason: 'attempt-identity-conflict',
      sample: { conflictingAttemptIdentities: 1 },
      primaryBlocker: 'identity-conflict',
      primaryAction: 'inspect-attempt-identity-conflicts',
    });
    expect(result.metrics).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('run-conflict');
    expect(JSON.stringify(result)).not.toContain('proposal-conflict');
  });

  it('deduplicates one execution when mutable machine ownership changes', () => {
    const first = event('1', 'empty-diff', { machineId: 'machine-a' });
    const result = buildProposalFunnelObservability({
      events: [first, { ...first, machineId: 'machine-b' }],
      sourceQuality: healthySource,
      windowMs: 60_000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      state: 'available',
      sample: { includedAttempts: 1, duplicateEvents: 1, invalidAttemptIdentities: 0 },
    });
  });

  it.each([
    ['removed run id', { runId: undefined }],
    ['removed attempt id', { attemptId: undefined }],
    ['changed trajectory id', { trajectoryId: 'run:attempt-00000000-0000-4000-8000-000000000099' }],
    ['unsafe attempt id', { attemptId: 'attempt-not-a-generated-uuid' }],
  ] as const)('withholds ambiguous causal identity: %s', (_name, overrides) => {
    const result = buildProposalFunnelObservability({
      events: [event('1', 'empty-diff', overrides)],
      sourceQuality: healthySource,
      windowMs: 60_000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      state: 'withheld',
      withheldReason: 'attempt-identity-unavailable',
      sample: { invalidAttemptIdentities: 1 },
      primaryBlocker: 'identity-unavailable',
    });
    expect(result.metrics).toBeUndefined();
  });

  it('withholds when distinct run ids claim one shared trajectory', () => {
    const firstAttemptId = attemptIdFor('1');
    const result = buildProposalFunnelObservability({
      events: [
        event('1', 'empty-diff', { runId: 'run-a' }),
        event('2', 'empty-diff', { runId: 'run-b', trajectoryId: `run:${firstAttemptId}` }),
      ],
      sourceQuality: healthySource,
      windowMs: 60_000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      state: 'withheld',
      withheldReason: 'attempt-identity-unavailable',
      sample: { invalidAttemptIdentities: 1 },
    });
  });

  it('treats coherent run and nested-summary rewrites as one conflicting execution', () => {
    const original = event('1', 'empty-diff', {
      runId: 'run-original',
      runEventSummary: {
        runId: 'run-original',
        status: 'done',
        outcome: 'empty-diff',
        proposalCreated: false,
      },
    });
    const rewritten = {
      ...original,
      runId: 'run-rewritten',
      runEventSummary: { ...original.runEventSummary, runId: 'run-rewritten' },
    };

    const result = buildProposalFunnelObservability({
      events: [original, rewritten],
      sourceQuality: healthySource,
      windowMs: 60_000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      state: 'withheld',
      withheldReason: 'attempt-identity-conflict',
      sample: { includedAttempts: 1, conflictingAttemptIdentities: 1 },
    });
  });

  it.each([
    ['nested run id', {
      runEventSummary: { runId: 'other-run', outcome: 'empty-diff', proposalCreated: false },
    }],
    ['nested proposal id', {
      proposalId: 'proposal-top',
      runEventSummary: {
        runId: 'run-1',
        proposalId: 'proposal-nested',
        outcome: 'proposal-created',
        proposalCreated: true,
      },
    }],
  ] as const)('withholds a top-level and %s identity mismatch', (_name, overrides) => {
    const result = buildProposalFunnelObservability({
      events: [event('1', 'proposal-created', overrides)],
      sourceQuality: healthySource,
      windowMs: 60_000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      state: 'withheld',
      withheldReason: 'attempt-identity-unavailable',
      sample: { invalidAttemptIdentities: 1 },
    });
  });

  it('includes nested causal metadata in the duplicate conflict signature', () => {
    const original = event('1', 'empty-diff', {
      runEventSummary: {
        runId: 'run-1',
        status: 'done',
        outcome: 'empty-diff',
        proposalCreated: false,
      },
    });
    const result = buildProposalFunnelObservability({
      events: [
        original,
        { ...original, runEventSummary: { ...original.runEventSummary, status: 'failed' } },
      ],
      sourceQuality: healthySource,
      windowMs: 60_000,
      eventLimit: 100,
    });

    expect(result).toMatchObject({
      state: 'withheld',
      withheldReason: 'attempt-identity-conflict',
      sample: { conflictingAttemptIdentities: 1 },
    });
  });

  it('rejects redaction-colliding and unsafe raw ids before causal sanitization', () => {
    const events = [
      event('1', 'empty-diff', { runId: 'token=ghp_1234567890abcdefABCDEF' }),
      event('2', 'empty-diff', { runId: 'token=ghp_abcdef1234567890ABCDEF' }),
      event('3', 'empty-diff', { runId: '[REDACTED]' }),
      event('4', 'empty-diff', { runId: 'unsafe/run-id' }),
    ].map((row) => sanitizeDispatchProductionEvent(row));

    expect(events.every((row) => row.attemptId === undefined && row.runId === undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('[REDACTED]');
    const result = buildProposalFunnelObservability({
      events,
      sourceQuality: healthySource,
      windowMs: 60_000,
      eventLimit: 100,
    });
    expect(result).toMatchObject({
      state: 'withheld',
      withheldReason: 'attempt-identity-unavailable',
      sample: { invalidAttemptIdentities: 4, includedAttempts: 0 },
    });
  });

  it('reports a producer outcome without claiming a durable filed proposal', () => {
    const result = buildProposalFunnelObservability({
      events: [event('1', 'proposal-created')],
      sourceQuality: healthySource,
      windowMs: 60_000,
      eventLimit: 100,
    });

    expect(result.metrics).toMatchObject({
      reportedProposalCreatedOutcomes: { count: 1, rate: 1 },
      observedProposalReferences: { count: 0, rate: 0 },
    });
    expect(JSON.stringify(result)).not.toContain('completeFiled');
  });

  it('withholds rates when a later source read invalidates the snapshot', () => {
    const available = buildProposalFunnelObservability({
      events: [event('1', 'proposal-created', { proposalId: 'proposal-1' })],
      sourceQuality: healthySource,
      windowMs: 60_000,
      eventLimit: 100,
    });
    const withheld = withholdProposalFunnelForUnstableSnapshot(available);

    expect(withheld).toMatchObject({
      state: 'withheld',
      withheldReason: 'snapshot-unstable',
      source: { sourceState: 'degraded', complete: false },
      sample: { includedAttempts: 1 },
    });
    expect(withheld.metrics).toBeUndefined();
  });
});

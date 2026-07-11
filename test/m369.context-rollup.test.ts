import { describe, expect, it } from 'vitest';

import type { AgentActionEvent } from '../src/core/fleet/agent-action-ledger.js';
import {
  CONTEXT_ROLLUP_ACTION,
  CONTEXT_ROLLUP_COUNT_KEYS,
  CONTEXT_ROLLUP_SUMMARY,
  decideContextRollup,
  type ContextRollupOptions,
} from '../src/core/fleet/context-rollup.js';

const NOW = '2026-07-11T16:00:00.000Z';
const HOUR_MS = 60 * 60 * 1_000;
const options: ContextRollupOptions = {
  defaultContract: { cadenceMs: 6 * HOUR_MS, minimumTerminalTrajectories: 10 },
};

function rollup(ts: string, overrides: Partial<AgentActionEvent> = {}): AgentActionEvent {
  return {
    schemaVersion: 1,
    ts,
    actor: 'daemon',
    kind: 'context-rollup',
    outcome: 'ok',
    action: CONTEXT_ROLLUP_ACTION,
    summary: CONTEXT_ROLLUP_SUMMARY,
    contextRollupId: `cr-${'a'.repeat(64)}`,
    contextRollupPolicyVersion: 'context-rollup-v1',
    contextRollupSourceMaxTs: ts,
    ...overrides,
  };
}

describe('M369 metadata-only autonomous context rollup', () => {
  it('emits a fixed count-only event after enough new terminal evidence', () => {
    const result = decideContextRollup({
      observedAt: NOW,
      eligibleEventCount: 12,
      latestSourceAt: '2026-07-11T15:59:00.000Z',
      persistedRollupEvents: [],
      counts: { uniqueTrajectories: 12, proposalCreated: 2, blocked: 1 },
    }, options);

    expect(result).toMatchObject({
      disposition: 'emit',
      latestRollupAt: null,
      counts: {
        eligibleEvents: 12,
        uniqueTrajectories: 12,
        proposalCreated: 2,
        blocked: 1,
      },
      event: {
        actor: 'daemon',
        kind: 'context-rollup',
        outcome: 'ok',
        action: CONTEXT_ROLLUP_ACTION,
        summary: CONTEXT_ROLLUP_SUMMARY,
        reason: 'cadence-and-new-evidence',
        tags: ['context-rollup', 'autonomous', 'metadata-only'],
        contextRollupPolicyVersion: 'context-rollup-v1',
        contextRollupSourceMaxTs: '2026-07-11T15:59:00.000Z',
      },
    });
    expect(JSON.stringify(result)).not.toContain('repo');
    if (result.disposition === 'emit') {
      expect(result.event.contextRollupId).toMatch(/^cr-[0-9a-f]{64}$/);
      expect(decideContextRollup({
        observedAt: NOW,
        eligibleEventCount: 12,
        latestSourceAt: '2026-07-11T15:59:00.000Z',
        persistedRollupEvents: [],
        counts: { uniqueTrajectories: 12, proposalCreated: 2, blocked: 1 },
      }, options)).toMatchObject({ event: { contextRollupId: result.event.contextRollupId } });
    }
  });

  it('requires cadence expiry and evidence newer than the previous rollup', () => {
    const base = {
      observedAt: NOW,
      eligibleEventCount: 20,
      latestSourceAt: '2026-07-11T15:00:00.000Z',
      persistedRollupEvents: [rollup('2026-07-11T12:00:00.000Z')],
    };
    expect(decideContextRollup(base, options)).toEqual({
      disposition: 'noop',
      reason: 'cadence-active',
    });
    expect(decideContextRollup({
      ...base,
      latestSourceAt: '2026-07-11T09:00:00.000Z',
      persistedRollupEvents: [rollup('2026-07-11T10:00:00.000Z')],
    }, options)).toEqual({ disposition: 'noop', reason: 'no-new-evidence' });
    expect(decideContextRollup({
      ...base,
      persistedRollupEvents: [rollup('2026-07-11T10:00:00.000Z')],
    }, options)).toMatchObject({ disposition: 'emit' });
  });

  it('does not let manual, malformed, or foreign reflection rows control cadence', () => {
    const foreignRows = [
      rollup('2026-07-11T12:00:00.000Z', { actor: 'agent' }),
      rollup('2026-07-11T12:00:00.000Z', { kind: 'reflection', action: 'reflect:playbooks' }),
      rollup('2026-07-11T12:00:00.000Z', { outcome: 'failed' }),
    ];
    for (const row of foreignRows) {
      expect(decideContextRollup({
        observedAt: NOW,
        eligibleEventCount: 10,
        latestSourceAt: '2026-07-11T15:00:00.000Z',
        persistedRollupEvents: [row],
      }, options)).toEqual({ disposition: 'noop', reason: 'malformed-input' });
    }
  });

  it('requires the configured minimum evidence threshold', () => {
    expect(decideContextRollup({
      observedAt: NOW,
      eligibleEventCount: 9,
      latestSourceAt: '2026-07-11T15:00:00.000Z',
      persistedRollupEvents: [],
    }, options)).toEqual({ disposition: 'noop', reason: 'below-trajectory-threshold' });
  });

  it('accepts only non-negative integer counts from the fixed allowlist', () => {
    for (const counts of [
      { secrets: 1 }, { proposalCreated: '2' }, { blocked: -1 },
      { failed: 1.5 }, { eligibleEvents: 11 },
    ]) {
      expect(decideContextRollup({
        observedAt: NOW,
        eligibleEventCount: 10,
        latestSourceAt: '2026-07-11T15:00:00.000Z',
        persistedRollupEvents: [],
        counts,
      }, options)).toEqual({ disposition: 'noop', reason: 'malformed-input' });
    }
    expect(CONTEXT_ROLLUP_COUNT_KEYS).toEqual([
      'eligibleEvents', 'uniqueTrajectories', 'proposalCreated',
      'diagnosticNoProposal', 'policySuppressed', 'blocked', 'failed',
    ]);
  });

  it('fails closed on malformed timestamps, inputs, and contracts', () => {
    const malformedInputs = [
      null,
      {},
      { observedAt: 'bad', eligibleEventCount: 10, latestSourceAt: NOW, persistedRollupEvents: [] },
      { observedAt: NOW, eligibleEventCount: Number.NaN, latestSourceAt: NOW, persistedRollupEvents: [] },
      { observedAt: NOW, eligibleEventCount: 10, latestSourceAt: '2026-07-11T17:00:00.000Z', persistedRollupEvents: [] },
      { observedAt: NOW, eligibleEventCount: 10, latestSourceAt: NOW, persistedRollupEvents: {} },
    ];
    for (const input of malformedInputs) {
      expect(decideContextRollup(input as never, options)).toEqual({
        disposition: 'noop', reason: 'malformed-input',
      });
    }
  });
});

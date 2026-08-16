import { describe, expect, it } from 'vitest';
import { deriveNotifications, sortNotifications } from './deriveNotifications.js';
import type { ControlSnapshot, FleetStatus, RunState } from '../../data/api-types.js';

function fakeControl(overrides: Record<string, unknown> = {}): ControlSnapshot {
  return {
    ts: new Date().toISOString(),
    security: { available: false, findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0 } },
    limits: [],
    daemon: { sourceQuality: { sourceState: 'healthy', complete: true } },
    ...overrides,
  } as unknown as ControlSnapshot;
}

describe('deriveNotifications', () => {
  it('returns nothing when everything is healthy and clear', () => {
    const out = deriveNotifications({ control: fakeControl() });
    expect(out).toEqual([]);
  });

  it('surfaces fleet.nextActions at their own priority, unmodified', () => {
    const fleet = {
      nextActions: [{ id: 'inspect-x', priority: 'critical', label: 'Inspect X', detail: 'Something needs eyes.' }],
    } as unknown as FleetStatus;
    const out = deriveNotifications({ fleet });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'next-action-inspect-x', severity: 'critical', title: 'Inspect X' });
  });

  it('flags a blocked autonomous readiness verdict using the blocker severity', () => {
    const fleet = {
      autonomousShipReadiness: {
        verdict: 'blocked',
        topBlocker: { id: 'evidence-stale', label: 'x', detail: 'Evidence is stale.', severity: 'high' },
        freshness: { generatedAt: new Date().toISOString() },
      },
    } as unknown as FleetStatus;
    const out = deriveNotifications({ fleet });
    expect(out.some((n) => n.id === 'readiness-blocked-evidence-stale' && n.severity === 'high')).toBe(true);
  });

  it('escalates security findings by severity, critical over high', () => {
    const control = fakeControl({
      security: {
        available: true,
        findings: [{ repo: 'a', title: 'sql injection', severity: 'critical', source: 'security' }],
        counts: { critical: 1, high: 0, medium: 0, low: 0 },
      },
    });
    const out = deriveNotifications({ control });
    expect(out).toEqual([expect.objectContaining({ id: 'security-critical', severity: 'critical' })]);
  });

  it('flags a budget limit that is over, at high severity, and warn at medium', () => {
    const control = fakeControl({
      limits: [
        { backend: 'anthropic', window: '7d', max: 100, used: 120, standing: 'over' },
        { backend: 'openai', window: '7d', max: 100, used: 90, standing: 'warn' },
      ],
    });
    const out = deriveNotifications({ control });
    expect(out.find((n) => n.id.startsWith('budget-over'))?.severity).toBe('high');
    expect(out.find((n) => n.id.startsWith('budget-warn'))?.severity).toBe('medium');
  });

  it('surfaces degraded daemon source quality as its own notification, not silence', () => {
    const control = fakeControl({ daemon: { sourceQuality: { sourceState: 'degraded', complete: false, reason: 'missing' } } });
    const out = deriveNotifications({ control });
    expect(out).toEqual([
      expect.objectContaining({ id: 'daemon-health-degraded', severity: 'high', sourceQuality: { sourceState: 'degraded', complete: false, reason: 'missing' } }),
    ]);
  });

  it('aggregates the pending-proposal backlog into one notification, not one per proposal', () => {
    const inbox = {
      pending: 3,
      proposals: [
        { id: 'p1', title: 'a', kind: 'patch', repo: 'r', origin: 'agent', createdAt: new Date().toISOString() },
        { id: 'p2', title: 'b', kind: 'patch', repo: 'r', origin: 'agent', createdAt: new Date().toISOString() },
        { id: 'p3', title: 'c', kind: 'patch', repo: 'r', origin: 'agent', createdAt: new Date().toISOString() },
      ],
    };
    const out = deriveNotifications({ inbox });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'proposal-backlog', title: '3 proposals awaiting review' });
  });

  it('flags failed runs and silently-stalled running runs, but not healthy running runs', () => {
    const runs = [
      { id: 'r1', goal: 'a', status: 'failed', updatedAt: new Date().toISOString() },
      { id: 'r2', goal: 'b', status: 'running', updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
      { id: 'r3', goal: 'c', status: 'running', updatedAt: new Date().toISOString() },
    ] as unknown as RunState[];
    const out = deriveNotifications({ runs });
    expect(out.map((n) => n.id).sort()).toEqual(['run-failed-r1', 'run-stalled-r2']);
  });

  it('sorts worst-first', () => {
    const items = [
      { id: 'a', category: 'run', severity: 'low', title: '', detail: '', ts: new Date().toISOString() },
      { id: 'b', category: 'run', severity: 'critical', title: '', detail: '', ts: new Date().toISOString() },
    ] as const;
    const sorted = sortNotifications([...items]);
    expect(sorted[0]!.id).toBe('b');
  });
});

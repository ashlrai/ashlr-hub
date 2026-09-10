import { getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import { superviseUniverseCampaigns } from '../src/core/universe/campaign-supervisor.js';

const hooks = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.read }));
vi.mock('../src/core/universe/campaign.js', () => ({ runUniverseCampaign: hooks.run }));

const ids = ['first', 'second', 'third'];
function report(campaignId: string): UniverseCampaignReadiness {
  return { schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId,
    universeId: `universe-${campaignId}`, observedState: 'ready', sourceState: 'healthy',
    disposition: 'startable', reasonCode: 'never-started', automaticAction: 'run',
    resourceRuntimeRequired: false, recordsDigest: 'e'.repeat(64),
    expectedIdentity: { universeId: `universe-${campaignId}`, definitionDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), summaryDigest: 'd'.repeat(64) },
    sampledAt: '2026-09-09T10:00:00.000Z' };
}
const options = (signal: AbortSignal) => ({ root: '/private/inert-enrollment-fixture',
  maxDurationMs: 5_000, pollIntervalMs: 50, signal });

function watchCleanup() {
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const cleared = vi.spyOn(globalThis, 'clearTimeout');
  return (signal: AbortSignal) => {
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(timers).toHaveBeenCalled();
    for (const timer of timers.mock.results) {
      if (timer.type === 'return') expect(cleared).toHaveBeenCalledWith(timer.value);
    }
  };
}

beforeEach(() => {
  hooks.read.mockReset().mockImplementation((id: string) => report(id));
  hooks.run.mockReset().mockRejectedValue(new Error('Unexpected fixture runner call'));
});
afterEach(() => { vi.restoreAllMocks(); });

// In-memory readiness fixtures and real event-loop yielding only. No campaign
// stores, worker processes, provider requests or durable state are created.
describe('supervisor cancellation during initial enrollment', () => {
  it('does not read source evidence for an already-aborted invocation', async () => {
    const controller = new AbortController(); controller.abort();
    const assertCleanup = watchCleanup();
    const result = await superviseUniverseCampaigns(ids, options(controller.signal));
    expect(hooks.read).not.toHaveBeenCalled();
    expect(hooks.run).not.toHaveBeenCalled();
    expect(result.status).toBe('cancelled');
    expect(result.outcomes).toEqual(ids.map((campaignId) => ({ campaignId, status: 'cancelled',
      attempted: false, reasonCode: 'caller-cancelled', observedState: null })));
    assertCleanup(controller.signal);
  });

  it.each(['cancelled', 'timed-out'] as const)('stops later enrollment reads after the first read becomes %s', async (status) => {
    const controller = new AbortController(); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    hooks.read.mockImplementation((id: string) => {
      if (status === 'cancelled') controller.abort();
      else now = 5_001;
      return report(id);
    });
    const assertCleanup = watchCleanup();
    const observer = vi.fn();
    const result = await superviseUniverseCampaigns(ids, { ...options(controller.signal), onTransition: observer });
    expect(hooks.read.mock.calls.map(([id]) => id)).toEqual(['first']);
    expect(hooks.run).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(result.status).toBe(status);
    expect(result.outcomes).toMatchObject(ids.map((campaignId) => ({ campaignId, status: 'cancelled', attempted: false,
      reasonCode: status === 'cancelled' ? 'caller-cancelled' : 'invocation-duration-exhausted' })));
    expect(result.outcomes.slice(1).every((outcome) => outcome.observedState === null)).toBe(true);
    assertCleanup(controller.signal);
  });

  it('processes a queued cancellation between synchronous readiness reads', async () => {
    const controller = new AbortController(); let cancellationDelivered = false;
    hooks.read.mockImplementation((id: string) => {
      if (id === 'first') setImmediate(() => { cancellationDelivered = true; controller.abort(); });
      return report(id);
    });
    const assertCleanup = watchCleanup();
    const result = await superviseUniverseCampaigns(ids, options(controller.signal));
    // Drain the fixture callback even when testing the old non-yielding source.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancellationDelivered).toBe(true);
    expect(hooks.read.mock.calls.map(([id]) => id)).toEqual(['first']);
    expect(hooks.run).not.toHaveBeenCalled();
    expect(result.status).toBe('cancelled');
    expect(result.outcomes.every((outcome) => outcome.status === 'cancelled' && !outcome.attempted)).toBe(true);
    assertCleanup(controller.signal);
  });

  it('still captures every initial pin before any transition callback', async () => {
    const controller = new AbortController(); const readIds: string[] = [];
    const reports = new Map(ids.map((id) => [id, { ...report(id), observedState: 'completed' as const,
      disposition: 'terminal' as const, reasonCode: 'campaign-completed' as const, automaticAction: 'none' as const }]));
    hooks.read.mockImplementation((id: string) => { readIds.push(id); return structuredClone(reports.get(id)!); });
    const assertCleanup = watchCleanup();
    const observer = vi.fn(() => {
      expect(readIds).toEqual(ids);
      // Observer mutations cannot replace another campaign's captured report.
      reports.get('second')!.sourceState = 'degraded';
    });
    const result = await superviseUniverseCampaigns(ids, { ...options(controller.signal), onTransition: observer });
    expect(hooks.run).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('completed');
    expect(result.outcomes.every((outcome) => outcome.status === 'completed' && !outcome.attempted)).toBe(true);
    assertCleanup(controller.signal);
  });
});

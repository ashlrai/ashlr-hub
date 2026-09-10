import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';
import { superviseUniverseCampaigns, type UniverseCampaignSupervisorOptions } from '../src/core/universe/campaign-supervisor.js';

const hooks = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn(), runtime: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.read }));
vi.mock('../src/core/universe/campaign.js', () => ({ runUniverseCampaign: hooks.run }));
vi.mock('../src/core/universe/resource-runtime-check.js', () => ({ checkResourceGenerationRuntime: hooks.runtime }));

const options = (): UniverseCampaignSupervisorOptions => ({ root: '/private/fixture-store', maxDurationMs: 5_000, pollIntervalMs: 50 });
function report(id: string): UniverseCampaignReadiness {
  return { schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: id, universeId: `universe-${id}`,
    observedState: 'ready', sourceState: 'healthy', disposition: 'startable', reasonCode: 'never-started', automaticAction: 'run',
    resourceRuntimeRequired: false, expectedIdentity: { universeId: `universe-${id}`, definitionDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), summaryDigest: 'd'.repeat(64) },
    recordsDigest: 'e'.repeat(64), sampledAt: new Date().toISOString() };
}
function fixture(ids = ['a', 'b']) {
  const reports = new Map(ids.map((id) => [id, report(id)]));
  hooks.read.mockImplementation((id: string) => structuredClone(reports.get(id)!));
  const finish = (id: string, state: 'completed' | 'failed' | 'paused' = 'completed') => {
    const summary = { fixtureId: id, state } as unknown as UniverseCampaignSummary;
    const current = reports.get(id)!;
    reports.set(id, { ...current, observedState: state, disposition: state === 'paused' ? 'resource-withheld' : 'terminal',
      automaticAction: 'none', reasonCode: state === 'completed' ? 'campaign-completed' : state === 'failed' ? 'campaign-failed' : 'resource-withheld',
      recordsDigest: 'f'.repeat(64), expectedIdentity: { ...current.expectedIdentity!, summaryDigest: digest(canonical(summary)) } });
    return summary;
  };
  hooks.run.mockImplementation(async (id: string) => finish(id));
  return { reports, finish };
}
beforeEach(() => { hooks.read.mockReset(); hooks.run.mockReset(); hooks.runtime.mockReset().mockReturnValue({ status: 'valid' }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('foreground campaign supervisor input envelope', () => {
  it.each([
    { ids: [] }, { ids: ['a', 'a'] }, { ids: ['../a'] }, { ids: Array.from({ length: 33 }, (_, i) => `a${i}`) },
    { ids: Array(1) }, { root: '/' }, { root: 'relative' }, { root: '/private/../other' }, { root: '/private/store/' },
    { root: '/private/\u0000store' }, { root: `/${'é'.repeat(2048)}` }, { maxDurationMs: 0 }, { maxDurationMs: 86_400_001 },
    { maxDurationMs: NaN }, { maxConcurrent: 0 }, { maxConcurrent: 5 }, { pollIntervalMs: 49 }, { pollIntervalMs: 60_001 },
    { resourceRuntime: '../runtime' }, { signal: {} }, { onTransition: 'callback' }, { unknown: true },
  ])('rejects invalid options before store observation %#', async ({ ids = ['a'], ...invalid }) => {
    await expect(superviseUniverseCampaigns(ids, { ...options(), ...invalid } as UniverseCampaignSupervisorOptions)).rejects.toThrow('Invalid Universe supervisor options');
    expect(hooks.read).not.toHaveBeenCalled(); expect(hooks.run).not.toHaveBeenCalled();
  });

  it('rejects accessors without invoking them', async () => {
    const getter = vi.fn(() => '/private/fixture-store');
    const input = Object.defineProperty(options(), 'root', { get: getter });
    await expect(superviseUniverseCampaigns(['a'], input)).rejects.toThrow();
    const ids = ['a']; Object.defineProperty(ids, '0', { get: getter });
    await expect(superviseUniverseCampaigns(ids, options())).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(hooks.read).not.toHaveBeenCalled();
  });

  it('detaches caller options and IDs before observations and sends no runtime to readiness', async () => {
    const f = fixture(); const ids = ['a', 'b']; const config = { ...options(), resourceRuntime: '/private/runtime.json' };
    hooks.read.mockImplementationOnce((id: string) => {
      ids.splice(0); config.root = '/changed'; config.resourceRuntime = '/changed/runtime.json'; config.maxDurationMs = 1;
      return structuredClone(f.reports.get(id)!);
    });
    const result = await superviseUniverseCampaigns(ids, config);
    expect(result.status).toBe('completed');
    expect(result.outcomes.map((value) => value.campaignId)).toEqual(['a', 'b']);
    expect(hooks.read.mock.calls.every(([, value]) => canonical(value) === canonical({ root: '/private/fixture-store' }))).toBe(true);
    expect(hooks.run.mock.calls.every(([, value]) => value.root === '/private/fixture-store' && value.resourceRuntime === '/private/runtime.json')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private|runtime\.json|resourceRuntime/);
  });
});

describe('bounded explicit enrollment', () => {
  it('captures all initial pins before dispatching once per ID and verifies recorded completion', async () => {
    fixture();
    const result = await superviseUniverseCampaigns(['a', 'b'], options());
    expect(result.status).toBe('completed'); expect(hooks.run).toHaveBeenCalledTimes(2);
    expect(hooks.read.mock.invocationCallOrder[1]).toBeLessThan(hooks.run.mock.invocationCallOrder[0]!);
    for (const [, config] of hooks.run.mock.calls) {
      expect(config.expectedIdentity.summaryDigest).toBe('d'.repeat(64));
      expect(config.expectedIdentity.recordsDigest).toBe('e'.repeat(64));
      expect(config).not.toHaveProperty('resourceRuntime');
      expect(config).not.toHaveProperty('maxDurationMs');
    }
    expect(result.outcomes.every((value) => value.status === 'completed' && value.attempted)).toBe(true);
    expect(result.transitions.map((event) => event.sequence)).toEqual(result.transitions.map((_, index) => index + 1));
    expect(result.transitions.length).toBeLessThanOrEqual(8);
  });

  it.each([
    ['resource-withheld', 'paused', 'resource-withheld'], ['owner-held', 'paused', 'owner-paused'],
    ['owner-held', 'stop-requested', 'stop-requested'], ['recovery-required', 'interrupted', 'resource-outcome-ambiguous'],
    ['recovery-required', 'interrupted', 'owner-abandoned'], ['attention-required', 'paused', 'resource-attention-required'],
    ['budget-exhausted', 'paused', 'request-budget-exhausted'], ['owned', 'running', 'owner-active'],
    ['terminal', 'stopped', 'campaign-stopped'], ['terminal', 'failed', 'campaign-failed'],
    ['unavailable', null, 'evidence-degraded'],
  ] as const)('never starts held %s / %s', async (disposition, observedState, reasonCode) => {
    const f = fixture(['a']); Object.assign(f.reports.get('a')!, { disposition, observedState, reasonCode,
      ...(disposition === 'unavailable' ? { sourceState: 'degraded', expectedIdentity: null } : {}) });
    const result = await superviseUniverseCampaigns(['a'], options());
    expect(result.status).toBe('incomplete'); expect(hooks.run).not.toHaveBeenCalled();
    expect(result.outcomes[0]!.reasonCode).toBe(reasonCode);
  });

  it('recognizes previously completed campaigns without running them', async () => {
    const f = fixture(['a']); f.finish('a');
    const result = await superviseUniverseCampaigns(['a'], options());
    expect(result.status).toBe('completed'); expect(result.outcomes[0]!.attempted).toBe(false);
    expect(hooks.run).not.toHaveBeenCalled();
  });

  it.each(['runner', 'evidence', 'observer'] as const)('reconciles a final synchronous %s overrun without losing completed evidence', async (phase) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const f = fixture(['a']); const controller = new AbortController(); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    hooks.run.mockImplementation(async (id: string) => {
      if (phase === 'runner') now = 5_001;
      return f.finish(id);
    });
    hooks.read.mockImplementation((id: string) => {
      const report = structuredClone(f.reports.get(id)!);
      if (phase === 'evidence' && report.observedState === 'completed') now = 5_001;
      return report;
    });
    const result = await superviseUniverseCampaigns(['a'], { ...options(), signal: controller.signal,
      onTransition(event) { if (phase === 'observer' && event.status === 'completed') now = 5_001; } });
    expect(result.status).toBe('timed-out');
    expect(result.outcomes).toEqual([{ campaignId: 'a', status: 'completed', attempted: true,
      reasonCode: 'campaign-completed', observedState: 'completed' }]);
    expect(result.transitions.at(-1)).toMatchObject({ status: 'completed', reasonCode: 'campaign-completed' });
    expect(hooks.run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['cancelled', 'failed', 'timed-out'] as const)('preserves %s precedence over a final synchronous overrun', async (status) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const f = fixture(['a']); const controller = new AbortController(); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    hooks.run.mockImplementation(async (id: string) => f.finish(id));
    const result = await superviseUniverseCampaigns(['a'], { ...options(), signal: controller.signal,
      onTransition(event) {
        if (event.status !== 'completed') return;
        now = 5_001;
        if (status === 'cancelled') controller.abort();
        else if (status === 'timed-out') { vi.advanceTimersByTime(5_000); controller.abort(); }
        else throw new Error('Fixture observer failure');
      } });
    expect(result.status).toBe(status);
    expect(result.outcomes[0]).toMatchObject({ status: 'completed', attempted: true, observedState: 'completed' });
    expect(hooks.run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('requires a runtime before dispatching a resource campaign', async () => {
    const f = fixture(['a']); f.reports.get('a')!.resourceRuntimeRequired = true;
    const result = await superviseUniverseCampaigns(['a'], options());
    expect(result.outcomes[0]).toMatchObject({ status: 'held', reasonCode: 'resource-runtime-required', attempted: false });
    expect(hooks.run).not.toHaveBeenCalled();
    expect(hooks.runtime).not.toHaveBeenCalled();
  });

  it('withholds invalid resource configuration once while independent non-resource work completes', async () => {
    const f = fixture(['a', 'b', 'c']);
    f.reports.get('a')!.resourceRuntimeRequired = true; f.reports.get('c')!.resourceRuntimeRequired = true;
    hooks.runtime.mockReturnValue({ status: 'invalid', checks: [{ code: 'workspace', status: 'failed' }] });
    const result = await superviseUniverseCampaigns(['a', 'b', 'c'], { ...options(), resourceRuntime: '/private/runtime.json' });
    expect(result.status).toBe('incomplete');
    expect(result.outcomes[0]).toMatchObject({ status: 'held', attempted: false, reasonCode: 'resource-runtime-invalid:workspace' });
    expect(result.outcomes[1]).toMatchObject({ status: 'completed', attempted: true });
    expect(result.outcomes[2]).toMatchObject({ status: 'held', attempted: false, reasonCode: 'resource-runtime-invalid:workspace' });
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['b']);
    expect(hooks.runtime).toHaveBeenCalledOnce();
    expect(f.reports.get('a')!.observedState).toBe('ready');
    expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('leaves temporary capacity and warnings to actual resource admission after valid preflight', async () => {
    const f = fixture(['a', 'b']);
    for (const value of f.reports.values()) value.resourceRuntimeRequired = true;
    hooks.runtime.mockReturnValue({ status: 'valid', counts: { eligibleWorkers: 0 }, warnings: ['quota-refresh-not-configured'] });
    const result = await superviseUniverseCampaigns(['a', 'b'], { ...options(), resourceRuntime: '/private/runtime.json' });
    expect(result.status).toBe('completed'); expect(hooks.run).toHaveBeenCalledTimes(2);
    expect(hooks.runtime).toHaveBeenCalledOnce();
  });

  it.each(['cancelled', 'queued-cancel', 'timed-out'] as const)('does not dispatch after synchronous runtime preflight becomes %s', async (status) => {
    const f = fixture(['a']); f.reports.get('a')!.resourceRuntimeRequired = true;
    const controller = new AbortController(); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    hooks.runtime.mockImplementation(() => {
      if (status === 'cancelled') controller.abort();
      else if (status === 'queued-cancel') setImmediate(() => controller.abort());
      else now = 5_001;
      return { status: 'valid' };
    });
    const result = await superviseUniverseCampaigns(['a'], { ...options(), resourceRuntime: '/private/runtime.json', signal: controller.signal });
    expect(result.status).toBe(status === 'queued-cancel' ? 'cancelled' : status); expect(hooks.run).not.toHaveBeenCalled();
    expect(result.outcomes[0]).toMatchObject({ status: 'cancelled', attempted: false });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['completed', 'non-resource', 'cancelled'] as const)('bypasses configured runtime inspection for %s work', async (state) => {
    const f = fixture(['a']); const controller = new AbortController();
    f.reports.get('a')!.resourceRuntimeRequired = state !== 'non-resource';
    if (state === 'completed') f.finish('a');
    if (state === 'cancelled') controller.abort();
    await superviseUniverseCampaigns(['a'], { ...options(), resourceRuntime: '/private/runtime.json', signal: controller.signal });
    expect(hooks.runtime).not.toHaveBeenCalled();
  });

  it('does not preflight while a pristine campaign is still owned elsewhere', async () => {
    const f = fixture(['a']); const controller = new AbortController();
    Object.assign(f.reports.get('a')!, { resourceRuntimeRequired: true, disposition: 'owned', reasonCode: 'owner-active' });
    const result = await superviseUniverseCampaigns(['a'], { ...options(), resourceRuntime: '/private/runtime.json', signal: controller.signal,
      onTransition(event) { if (event.status === 'waiting') controller.abort(); } });
    expect(result.status).toBe('cancelled'); expect(hooks.runtime).not.toHaveBeenCalled();
  });

  it.each(['recordsDigest', 'summaryDigest'] as const)('never adopts changed queued %s pins', async (field) => {
    const f = fixture();
    hooks.run.mockImplementation(async (id: string) => {
      if (id === 'a') {
        if (field === 'recordsDigest') f.reports.get('b')!.recordsDigest = 'f'.repeat(64);
        else f.reports.get('b')!.expectedIdentity!.summaryDigest = 'f'.repeat(64);
      }
      return f.finish(id);
    });
    const result = await superviseUniverseCampaigns(['a', 'b'], options());
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(result.outcomes[1]).toMatchObject({ status: 'held', reasonCode: 'evidence-changed', attempted: false });
  });

  it('waits only for a never-started owned Universe and retains initial pins', async () => {
    const f = fixture(['a']); const initial = f.reports.get('a')!; initial.disposition = 'owned'; initial.reasonCode = 'owner-active';
    setTimeout(() => { initial.disposition = 'startable'; initial.reasonCode = 'never-started'; }, 10);
    const result = await superviseUniverseCampaigns(['a'], options());
    expect(result.status).toBe('completed'); expect(hooks.run).toHaveBeenCalledOnce();
    expect(result.transitions.map((value) => value.status)).toEqual(['waiting', 'running', 'completed']);
    expect(hooks.run.mock.calls[0]![1].expectedIdentity.recordsDigest).toBe('e'.repeat(64));
  });

  it('holds a waiting owner pause without dispatch', async () => {
    const f = fixture(['a']); const current = f.reports.get('a')!; current.disposition = 'owned';
    setTimeout(() => { current.disposition = 'owner-held'; current.observedState = 'paused'; current.recordsDigest = 'f'.repeat(64); }, 10);
    const result = await superviseUniverseCampaigns(['a'], options());
    expect(result.outcomes[0]).toMatchObject({ status: 'held', reasonCode: 'evidence-changed' });
    expect(hooks.run).not.toHaveBeenCalled();
  });

  it.each(['paused', 'failed'] as const)('does not retry a fulfilled runner ending %s', async (state) => {
    const f = fixture(['a']); hooks.run.mockImplementation(async (id: string) => f.finish(id, state));
    const result = await superviseUniverseCampaigns(['a'], options());
    expect(result.status).toBe('incomplete'); expect(hooks.run).toHaveBeenCalledOnce();
    expect(result.outcomes[0]!.status).toBe(state === 'failed' ? 'failed' : 'held');
  });

  it('never converts a rejected call into success from another owner or retries', async () => {
    const f = fixture(['a']); hooks.run.mockImplementation(async (id: string) => { f.finish(id); throw new Error('/private/raw/provider-error'); });
    const result = await superviseUniverseCampaigns(['a'], options());
    expect(result.outcomes[0]).toMatchObject({ status: 'failed', reasonCode: 'runner-failed', attempted: true });
    expect(hooks.run).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('requires fulfilled runner results to match durable summaries', async () => {
    fixture(['a']); hooks.run.mockResolvedValue({ state: 'completed', privatePath: '/private/raw' });
    const result = await superviseUniverseCampaigns(['a'], options());
    expect(result.outcomes[0]).toMatchObject({ status: 'unavailable', reasonCode: 'evidence-changed' });
    expect(JSON.stringify(result)).not.toContain('/private');
  });
});

describe('concurrency, cancellation and observer failures', () => {
  it('limits independent concurrency and serializes enrolled campaigns in the same Universe', async () => {
    const f = fixture(['a', 'b', 'c']);
    Object.assign(f.reports.get('b')!, { universeId: 'universe-a', expectedIdentity: { ...f.reports.get('b')!.expectedIdentity!, universeId: 'universe-a' } });
    let concurrent = 0; let maximum = 0; const running = new Set<string>();
    hooks.run.mockImplementation(async (id: string) => {
      expect(!(id === 'a' && running.has('b') || id === 'b' && running.has('a'))).toBe(true);
      running.add(id); concurrent++; maximum = Math.max(maximum, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running.delete(id); concurrent--; return f.finish(id);
    });
    const result = await superviseUniverseCampaigns(['a', 'b', 'c'], { ...options(), maxConcurrent: 2 });
    expect(result.status).toBe('completed'); expect(maximum).toBe(2); expect(concurrent).toBe(0);
  });

  it('does not dispatch an already-cancelled invocation', async () => {
    fixture(); const controller = new AbortController(); controller.abort();
    const result = await superviseUniverseCampaigns(['a', 'b'], { ...options(), signal: controller.signal });
    expect(result.status).toBe('cancelled'); expect(hooks.run).not.toHaveBeenCalled();
    expect(result.outcomes.every((value) => value.status === 'cancelled' && !value.attempted)).toBe(true);
  });

  it.each(['cancel', 'deadline'] as const)('cancels and drains owned work on %s without dispatching pending work', async (mode) => {
    const f = fixture(['a', 'b']); const controller = new AbortController(); let cleaned = false;
    hooks.run.mockImplementation(async (id: string, config: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        config.signal.addEventListener('abort', () => { setTimeout(() => { cleaned = true; resolve(); }, 10); }, { once: true });
        if (mode === 'cancel') setTimeout(() => controller.abort(), 5);
      });
      return f.finish(id, 'paused');
    });
    const promise = superviseUniverseCampaigns(['a', 'b'], { ...options(), signal: controller.signal,
      maxDurationMs: mode === 'deadline' ? 20 : 5000 });
    const result = await promise;
    expect(cleaned).toBe(true); expect(hooks.run).toHaveBeenCalledOnce();
    expect(result.status).toBe(mode === 'deadline' ? 'timed-out' : 'cancelled');
    expect(result.outcomes[1]!.attempted).toBe(false);
  });

  it('cancels and drains an active runner when another transition observer throws', async () => {
    const f = fixture(); let cleaned = false;
    hooks.run.mockImplementation(async (id: string, config: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => config.signal.addEventListener('abort', () => {
        setTimeout(() => { cleaned = true; resolve(); }, 10);
      }, { once: true }));
      return f.finish(id, 'paused');
    });
    const result = await superviseUniverseCampaigns(['a', 'b'], { ...options(), maxConcurrent: 2,
      onTransition: (event) => { if (event.campaignId === 'b' && event.status === 'running') throw new Error('/private/callback'); } });
    expect(result.status).toBe('failed'); expect(cleaned).toBe(true); expect(hooks.run).toHaveBeenCalledOnce();
    expect(result.outcomes[1]).toMatchObject({ attempted: false, status: 'cancelled', reasonCode: 'transition-callback-failed' });
  });

  it('drains an active runner and cancels queued work when a completed transition observer throws', async () => {
    const f = fixture(['a', 'b', 'c']); let cleaned = false;
    hooks.run.mockImplementation(async (id: string, config: { signal: AbortSignal }) => {
      if (id === 'a') {
        await new Promise<void>((resolve) => config.signal.addEventListener('abort', () => {
          setTimeout(() => { cleaned = true; resolve(); }, 10);
        }, { once: true }));
        return f.finish(id, 'paused');
      }
      return f.finish(id);
    });
    const result = await superviseUniverseCampaigns(['a', 'b', 'c'], { ...options(), maxConcurrent: 2,
      onTransition: (event) => { if (event.campaignId === 'b' && event.status === 'completed') throw new Error('/private/completed-callback'); } });
    expect(result.status).toBe('failed'); expect(cleaned).toBe(true);
    expect(hooks.run.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    expect(result.outcomes[2]).toMatchObject({ attempted: false, status: 'cancelled', reasonCode: 'transition-callback-failed' });
    expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('awaits other owned calls after a runner rejection and reports the rejected call as failed', async () => {
    const f = fixture(); let settled = false;
    hooks.run.mockImplementation(async (id: string) => {
      if (id === 'a') throw new Error('/private/rejected-runner');
      await new Promise((resolve) => setTimeout(resolve, 10)); settled = true; return f.finish(id);
    });
    const result = await superviseUniverseCampaigns(['a', 'b'], { ...options(), maxConcurrent: 2 });
    expect(settled).toBe(true); expect(result.status).toBe('incomplete');
    expect(result.outcomes.map((value) => value.status)).toEqual(['failed', 'completed']);
    expect(hooks.run).toHaveBeenCalledTimes(2); expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('observer failure before dispatch is fixed, bounded and never invokes a runner', async () => {
    fixture();
    const result = await superviseUniverseCampaigns(['a', 'b'], { ...options(), onTransition: () => { throw new Error('/private/callback'); } });
    expect(result.status).toBe('failed'); expect(hooks.run).not.toHaveBeenCalled();
    expect(result.outcomes.every((value) => value.reasonCode === 'transition-callback-failed')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('handles rejected async observers without an unhandled rejection', async () => {
    fixture(['a']);
    const result = await superviseUniverseCampaigns(['a'], { ...options(), onTransition: async () => { throw new Error('/private/callback'); } });
    expect(result.status).toBe('failed'); expect(hooks.run).not.toHaveBeenCalled();
  });

  it('does not let transition observers mutate recorded transition evidence', async () => {
    fixture(['a']); const events: unknown[] = [];
    const result = await superviseUniverseCampaigns(['a'], { ...options(), onTransition: (event) => { events.push(event); expect(Object.isFrozen(event)).toBe(true); } });
    expect(result.status).toBe('completed'); expect(events).toHaveLength(3);
    expect(result.transitions[0]).not.toBe(events[0]);
  });
});

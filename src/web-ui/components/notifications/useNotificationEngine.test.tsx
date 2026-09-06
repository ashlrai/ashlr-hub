import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../data/cache.js';
import { markCheckComplete } from '../../data/auth-store.js';
import { __resetNotificationStoreForTests, getNotificationSnapshot } from './notification-store.js';
import { useNotificationEngine } from './useNotificationEngine.js';

class EventSourceStub extends EventTarget {
  static latest: EventSourceStub;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { super(); EventSourceStub.latest = this; }
  close(): void { /* EventTarget owns no transport or timers. */ }
}

function Harness() {
  useNotificationEngine();
  return null;
}

function healthyControl() {
  return {
    ts: '2026-09-06T12:00:00.000Z',
    security: { available: true, findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0 } },
    limits: [], daemon: { sourceQuality: { sourceState: 'healthy', complete: true } },
  };
}

describe('notification refresh channel', () => {
  beforeEach(() => {
    markCheckComplete(false);
    evictAll();
    __resetNotificationStoreForTests();
    vi.stubGlobal('EventSource', EventSourceStub);
    markCheckComplete(true);
  });
  afterEach(() => {
    markCheckComplete(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches each source initially without creating a separate polling timer', async () => {
    const sources: Record<string, unknown> = {
      '/api/control': healthyControl(), '/api/fleet': { nextActions: [] },
      '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] },
    };
    const fetch = vi.fn(async (path: string) => new Response(JSON.stringify(sources[path]), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const intervals = vi.spyOn(globalThis, 'setInterval');
    await act(async () => { render(<Harness />); });

    expect(fetch.mock.calls.map(([path]) => path).sort()).toEqual(Object.keys(sources).sort());
    expect(intervals).not.toHaveBeenCalled();
    expect(getNotificationSnapshot().items).toHaveLength(0);
  });

  it('reconciles all refreshed sources from real SSE cache invalidations, deduplicating paired observations', async () => {
    const sources: Record<string, unknown> = {
      '/api/control': healthyControl(), '/api/fleet': { nextActions: [] },
      '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] },
    };
    const fetch = vi.fn(async (path: string) => new Response(JSON.stringify(sources[path]), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await act(async () => { render(<Harness />); });
    expect(getNotificationSnapshot().items).toHaveLength(0);

    sources['/api/control'] = {
      ...healthyControl(),
      security: { available: true, findings: [{ repo: 'sample', title: 'Dependency requires attention', severity: 'critical' }], counts: { critical: 1, high: 0, medium: 0, low: 0 } },
    };
    sources['/api/fleet'] = { nextActions: [{ id: 'check-output', priority: 'high', label: 'Check output', detail: 'A result needs attention.' }] };
    sources['/api/runs'] = [{ id: 'failed-run', goal: 'Try a candidate', status: 'failed', updatedAt: '2026-09-06T12:00:00.000Z' }];
    sources['/api/inbox'] = { pending: 2, proposals: [] };
    await act(async () => {
      for (const event of ['daemon', 'daemon-observation', 'fleet-activity-ping', 'fleet-activity-observation', 'runs', 'inbox']) {
        EventSourceStub.latest.dispatchEvent(new MessageEvent(event, { data: '{}' }));
      }
    });

    expect(getNotificationSnapshot().items.map((item) => item.id).sort()).toEqual([
      'next-action-check-output', 'proposal-backlog', 'run-failed-failed-run', 'security-critical',
    ]);
    for (const path of Object.keys(sources)) {
      expect(fetch.mock.calls.filter(([called]) => called === path)).toHaveLength(2);
    }
  });
});

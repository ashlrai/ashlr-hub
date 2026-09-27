/**
 * routes/verse/mobile/mobile.test-support.tsx — rendering a phone screen in a
 * test: a MobileContext with the device's permissions and the activity the
 * test chooses, activity fixtures, and a routed fetch stub.
 *
 *   stubFetch({ 'GET /api/verse/control': controlSnapshot(), 'POST /api/verse/daemon': (body) => json({...}) });
 *   renderMobile(<FleetScreen />, { permissions: permissionsFor('unlocked') });
 */
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { NeedsYouItem, VerseActivityResponse, VerseActivityRunning } from '../../../../core/verse/workbench-types.js';
import type { ActivityState } from '../shell/useActivity.js';
import type { ActPermission, DevicePermissions } from './device-permissions.js';
import { BOOT_CONTEXT, MobileContext, type MobileContextValue } from './mobile-context.js';

export const TOKEN = 'a'.repeat(64);

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

export function permissionsFor(act: ActPermission): DevicePermissions {
  return {
    read: true,
    act,
    actReason: act === 'unlocked' ? null : act === 'locked' ? 'Actions ask for the mutation token.' : 'Your Mac started Verse without dispatch.',
    source: 'session',
    deviceLabel: null,
  };
}

export function activityResponse(partial: Partial<VerseActivityResponse> = {}): VerseActivityResponse {
  const needsYou = partial.needsYou ?? [];
  const running = partial.running ?? [];
  return {
    cursor: 'c1',
    generatedAt: '2026-09-27T12:00:00Z',
    running,
    needsYou,
    completions: [],
    counts: { running: running.length, needsYou: needsYou.length, unread: 0 },
    sources: { approvals: 'ok', authority: 'ok', fleet: 'ok', leader: 'ok', chats: 'ok', accounts: 'ok' },
    autonomy: null,
    capacity: null,
    mind: null,
    ...partial,
  };
}

export function activityState(data: VerseActivityResponse | null, status: ActivityState['status'] = data ? 'ready' : 'loading', error: string | null = null): ActivityState {
  return { status, data, updatedAt: data ? Date.parse('2026-09-27T12:00:00Z') : null, error };
}

export function runningRow(partial: Partial<VerseActivityRunning> = {}): VerseActivityRunning {
  return {
    sessionId: 's1',
    title: 'Fix the flaky snapshot test',
    engine: 'claude',
    seatId: 'claude',
    startedAt: '2026-09-27T11:55:00Z',
    live: { phase: null, tool: 'Edit', elapsedMs: 300_000, thinkingTail: null },
    ...partial,
  };
}

export function needsItem(partial: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: 'approvals:approval:p1',
    source: 'approvals',
    kind: 'approval',
    severity: 'warn',
    title: 'PR: fix the flaky snapshot test',
    detail: 'Review before applying.',
    since: '2026-09-27T11:00:00Z',
    expiresAt: null,
    subject: { repo: 'ashlrai/ashlr-hub', pr: null, seatId: null, sessionId: null, engine: 'claude' },
    target: { kind: 'approval', proposalId: 'p1' },
    actions: [
      { kind: 'approve', label: 'Approve', request: { method: 'POST', path: '/api/inbox/p1/approve', body: {} }, confirm: null, destructive: false },
      { kind: 'reject', label: 'Reject', request: { method: 'POST', path: '/api/inbox/p1/reject', body: {} }, confirm: null, destructive: true },
    ],
    ...partial,
  };
}

export function mobileContext(overrides: Partial<MobileContextValue> = {}): MobileContextValue {
  const activity = overrides.activity ?? activityState(activityResponse());
  return {
    ...BOOT_CONTEXT,
    ready: true,
    permissions: permissionsFor('unlocked'),
    reachability: 'live',
    activity,
    navigate: vi.fn(),
    needsCount: activity.data ? activity.data.needsYou.length : null,
    workingCount: activity.data ? activity.data.counts.running : null,
    refreshActivity: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function renderMobile(node: ReactNode, overrides: Partial<MobileContextValue> = {}): RenderResult & { context: MobileContextValue } {
  const context = mobileContext(overrides);
  const result = render(<MobileContext.Provider value={context}>{node}</MobileContext.Provider>);
  return Object.assign(result, { context });
}

export interface FetchCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

type Route = unknown | ((body: Record<string, unknown> | null, call: FetchCall) => Response | unknown);

/**
 * Stub `fetch` by `"<METHOD> <path>"` (the path without its query string).
 * A value answers 200 JSON; a function may return a Response or a value.
 * Unknown routes answer 404 (codeless — what a server without that route says).
 */
export function stubFetch(routes: Record<string, Route>): { calls: FetchCall[]; posts: () => FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: Record<string, unknown> | null = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      const call = { method, url, body, headers };
      calls.push(call);
      const key = `${method} ${url.split('?')[0]}`;
      if (!(key in routes)) return json({ error: 'not found' }, 404);
      const route = routes[key];
      const out = typeof route === 'function' ? (route as (b: typeof body, c: FetchCall) => unknown)(body, call) : route;
      return out instanceof Response ? out : json(out);
    }),
  );
  return { calls, posts: () => calls.filter((c) => c.method !== 'GET') };
}

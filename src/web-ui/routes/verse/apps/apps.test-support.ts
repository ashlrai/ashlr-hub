/**
 * apps.test-support.ts — the recording fetch stub the Apps & Accounts tests
 * drive the page with; the fixtures themselves are apps-fixtures.test-support.ts.
 */
import { vi } from 'vitest';
import type { VerseMcpSnapshot } from '../../../../core/verse/mcp-seat-view.js';
import type { VerseAppsResponse } from '../../../../core/verse/workbench-types.js';
import { APPS, BOOTSTRAP, BUDGET, HEALTH, MCP } from './apps-fixtures.test-support.js';

export * from './apps-fixtures.test-support.js';

export interface Recorded {
  method: string;
  url: string;
  body: unknown;
  token: string | null;
}

export interface StubOptions {
  apps?: VerseAppsResponse | 404;
  mcp?: VerseMcpSnapshot | 404;
  terminal?: { available: boolean; reason: string | null } | 404;
  /** Override a POST's answer by path. */
  post?: Record<string, { status: number; body: unknown }>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch that answers every route the page reads, and records every call. */
export function stubAppsFetch(opts: StubOptions = {}): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, url, body, token: headers.get('x-ashlr-token') });
    if (method === 'POST') {
      const override = opts.post?.[url];
      if (override) return json(override.body, override.status);
      if (url.endsWith('/toggle')) return json({ ok: true, opened: 'terminal-app', command: ['ollama', 'launch', 'claude-desktop'] }, 202);
      if (url.endsWith('/launch')) return json({ ok: true, opened: 'terminal-app', command: ['codex'] }, 202);
      if (url === '/api/verse/apps/refresh') return json(opts.apps === 404 ? {} : (opts.apps ?? APPS));
      if (url === '/api/verse/health/refresh') return json(HEALTH);
      if (url === '/api/verse/health/reconnect') return json({ ok: true, seatId: (body as { seatId: string }).seatId }, 202);
      return json({ error: 'nope' }, 404);
    }
    switch (url) {
      case '/api/verse/apps':
        return opts.apps === 404 ? json({ error: 'not found' }, 404) : json(opts.apps ?? APPS);
      case '/api/verse/terminal':
        return opts.terminal === 404 || opts.terminal === undefined ? json({ error: 'not found' }, 404) : json({ ...opts.terminal, tabs: [] });
      case '/api/verse/mcp':
        return opts.mcp === 404 ? json({ error: 'not found' }, 404) : json(opts.mcp ?? MCP);
      case '/api/verse/mcp/cli-health':
        return json({ sampledAt: 'x', accounts: [], driftDetected: false, notes: [] });
      case '/api/verse/bootstrap':
        return json(BOOTSTRAP);
      case '/api/verse/seats':
        return json({ sampledAt: 'x', seats: BOOTSTRAP.seats, localRuntime: BOOTSTRAP.localRuntime });
      case '/api/verse/health':
        return json(HEALTH);
      case '/api/verse/budget':
        return json(BUDGET);
      default:
        if (url.startsWith('/api/verse/budget/preview')) return json({ seatId: 'grok', candidates: [], exclusions: [], why: 'Room left.', mode: 'balanced' });
        return json({ error: 'not found' }, 404);
    }
  }));
  return calls;
}

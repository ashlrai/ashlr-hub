/**
 * shell-fixtures.test-support — activity responses and Needs-you items for
 * the shell's tests (unit C1). Shapes are the REAL wire contract
 * (workbench-types.ts), and every item passes `isNeedsYouItem`, so a fixture
 * cannot drift into something the server would never send.
 */
import { vi, type Mock } from 'vitest';
import {
  isNeedsYouItem,
  type NeedsYouItem,
  type VerseActivityResponse,
} from '../../../../core/verse/workbench-types.js';
import { verseFetch, type VerseFetchState } from '../fixtures.test-support.js';

export const T0 = Date.parse('2026-09-24T12:00:00.000Z');

export function approvalNeed(id = 'p-1', over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  const item: NeedsYouItem = {
    id: `approvals:approval:${id}`,
    source: 'approvals',
    kind: 'approval',
    severity: 'high',
    title: 'PR: fix the flaky snapshot test',
    detail: 'Two assertions raced the clock.',
    since: new Date(T0 - 20 * 60_000).toISOString(),
    expiresAt: null,
    subject: { repo: 'binshield', pr: null, seatId: null, sessionId: null, engine: null },
    target: { kind: 'approval', proposalId: id },
    actions: [
      {
        kind: 'approve',
        label: 'Approve',
        request: { method: 'POST', path: `/api/inbox/${id}/approve`, body: {} },
        confirm: { title: 'Approve this pr against binshield?', body: "Pushes a branch to binshield's remote and opens a real pull request.", confirmLabel: 'Approve and open the pull request' },
        destructive: true,
      },
      {
        kind: 'reject',
        label: 'Reject',
        request: { method: 'POST', path: `/api/inbox/${id}/reject`, body: {} },
        confirm: { title: 'Reject this proposal?', body: 'Discards it.', confirmLabel: 'Reject' },
        destructive: false,
      },
    ],
    ...over,
  };
  if (!isNeedsYouItem(item)) throw new Error('a shell fixture is not a valid NeedsYouItem');
  return item;
}

export function vetoNeed(over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  const item: NeedsYouItem = {
    id: 'leader:veto-window:m-7',
    source: 'leader',
    kind: 'veto-window',
    severity: 'warn',
    title: 'Prune 17 stale goals',
    detail: 'The backlog has 17 goals untouched for 30 days.',
    since: new Date(T0 - 5 * 60_000).toISOString(),
    expiresAt: new Date(T0 + 24 * 60_000).toISOString(),
    subject: { repo: null, pr: null, seatId: null, sessionId: null, engine: null },
    target: { kind: 'section', section: 'mind', anchor: 'memo:m-7' },
    actions: [{ kind: 'veto', label: 'Veto', request: { method: 'POST', path: '/api/verse/leader/veto', body: { actionId: 'm-7' } }, confirm: null, destructive: true }],
    ...over,
  };
  if (!isNeedsYouItem(item)) throw new Error('a shell fixture is not a valid NeedsYouItem');
  return item;
}

export function chatFailedNeed(sessionId = 's-9'): NeedsYouItem {
  const item: NeedsYouItem = {
    id: `chats:chat-failed:${sessionId}@3`,
    source: 'chats',
    kind: 'chat-failed',
    severity: 'warn',
    title: 'Failed: Migrate the store',
    detail: 'CLI exited 1',
    since: new Date(T0 - 60_000).toISOString(),
    expiresAt: null,
    subject: { repo: 'ashlr-hub', pr: null, seatId: 'claude-a', sessionId, engine: 'claude' },
    target: { kind: 'session', sessionId },
    actions: [{ kind: 'done', label: 'Mark read', request: { method: 'POST', path: '/api/verse/activity/seen', body: { sessionId, turnCount: 3 } }, confirm: null, destructive: false }],
  };
  if (!isNeedsYouItem(item)) throw new Error('a shell fixture is not a valid NeedsYouItem');
  return item;
}

export function activity(over: Partial<VerseActivityResponse> = {}): VerseActivityResponse {
  const needsYou = over.needsYou ?? [];
  return {
    cursor: 'v1.aaaaaaaa.t.1',
    generatedAt: new Date(T0).toISOString(),
    running: [],
    needsYou,
    completions: [],
    counts: { running: over.running?.length ?? 0, needsYou: needsYou.length, unread: 0 },
    sources: { approvals: 'ok', authority: 'ok', fleet: 'ok', leader: 'ok', chats: 'ok', accounts: 'ok' },
    autonomy: { mode: 'propose', paused: false, stopped: false, label: 'Propose · 2 building' },
    capacity: { seatId: 'claude-a', engine: 'claude', label: 'Claude', usedPercent: 62, window: '5h', resetsAt: null },
    mind: { latestMemoAt: null, unseen: false },
    ...over,
  };
}

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ShellFetch {
  fetch: Mock<FetchFn>;
  state: VerseFetchState;
  /** Replace what GET /api/verse/activity answers (a function sees the ?since= cursor). */
  setActivity: (next: VerseActivityResponse | ((since: string | null) => VerseActivityResponse) | 404) => void;
  posts: () => Array<{ path: string; body: unknown; token: string | undefined }>;
}

/** verseFetch plus the activity route and a recorder for every POST outside the chat routes. */
export function shellFetch(initialActivity: VerseActivityResponse | 404 = activity(), init: Partial<VerseFetchState> = {}): ShellFetch {
  const base = verseFetch(init);
  let current: VerseActivityResponse | ((since: string | null) => VerseActivityResponse) | 404 = initialActivity;
  const posted: Array<{ path: string; body: unknown; token: string | undefined }> = [];
  const fetchMock = vi.fn<FetchFn>(async (input: RequestInfo | URL, request?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString();
    const method = request?.method ?? 'GET';
    if (method === 'POST') {
      const headers = (request?.headers ?? {}) as Record<string, string>;
      posted.push({ path, body: typeof request?.body === 'string' ? JSON.parse(request.body) : undefined, token: headers['x-ashlr-token'] });
    }
    if (path.startsWith('/api/verse/activity') && method === 'GET') {
      if (current === 404) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      const since = new URL(path, 'http://x').searchParams.get('since');
      const body = typeof current === 'function' ? current(since) : current;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'POST' && (path.startsWith('/api/inbox/') || path.startsWith('/api/verse/leader') || path === '/api/verse/activity/seen' || path === '/api/verse/authority' || path === '/api/verse/daemon')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return (base.fetch as unknown as (i: RequestInfo | URL, r?: RequestInit) => Promise<Response>)(input, request);
  });
  return {
    fetch: fetchMock,
    state: base.state,
    setActivity: (next) => { current = next; },
    posts: () => posted,
  };
}

export const TOKEN = 'a'.repeat(64);

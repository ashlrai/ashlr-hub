/**
 * Shared fixtures for the Verse DOM tests: a bootstrap payload shaped by
 * src/core/verse/types.ts, a MockEventSource (jsdom ships none), and a
 * fetch stub that answers the /api/verse/* surface in memory.
 */
import { vi } from 'vitest';
import type { VerseBootstrap, VerseEvent, VerseSeat, VerseSession, VerseSessionDetail } from '../../data/api-types.js';

export const CLAUDE_SEAT: VerseSeat = {
  id: 'claude-main',
  engine: 'claude',
  label: 'Claude Max',
  accountId: 'claude-main',
  models: [
    { id: 'claude-opus-5', label: 'Opus 5', contextWindow: 200_000 },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', contextWindow: 200_000 },
  ],
  contextWindow: 200_000,
  health: { state: 'ready', summary: '5h window 12% used', windows: [{ id: '5h', usedPercent: 12, resetsAt: null }], observedAt: null },
};

export const CODEX_SEAT: VerseSeat = {
  id: 'codex-personal',
  engine: 'codex',
  label: 'Personal Codex',
  accountId: 'codex-personal',
  models: [{ id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000 }],
  contextWindow: 272_000,
  health: { state: 'unavailable', summary: 'quota exhausted until 14:00', windows: [], observedAt: null },
};

export const LOCAL_SEAT: VerseSeat = {
  id: 'local:qwen3-coder',
  engine: 'local',
  label: 'Qwen3 Coder (local)',
  accountId: 'local',
  models: [{ id: 'qwen3-coder', label: 'qwen3-coder', contextWindow: 65_536 }],
  contextWindow: 65_536,
  health: { state: 'unknown', summary: null, windows: [], observedAt: null },
};

export function session(over: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'vs_1',
    title: 'Fix the login bug',
    projectPath: '/Users/mason/dev/hub',
    engine: 'claude',
    accountId: 'claude-main',
    seatId: 'claude-main',
    model: 'claude-opus-5',
    nativeSessionId: 'uuid-1',
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:05:00.000Z',
    status: 'idle',
    turnCount: 1,
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 24_000, contextWindow: 200_000 },
    lastError: null,
    ...over,
  };
}

export function bootstrap(over: Partial<VerseBootstrap> = {}): VerseBootstrap {
  return {
    seats: [CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT],
    projects: [
      { path: '/Users/mason/dev/hub', name: 'hub', enrolled: true },
      { path: '/Users/mason/dev/site', name: 'site', enrolled: false },
    ],
    sessions: [session(), session({ id: 'vs_2', title: 'Write the docs', projectPath: '/Users/mason/dev/site', updatedAt: '2026-09-19T09:00:00.000Z', seatId: 'local:qwen3-coder', engine: 'local', model: 'qwen3-coder' })],
    dispatchEnabled: true,
    localRuntime: { ollama: { reachable: true, baseUrl: 'http://127.0.0.1:11434', models: ['qwen3-coder'] } },
    ...over,
  };
}

export function detail(events: VerseEvent[] = [], over: Partial<VerseSession> = {}): VerseSessionDetail {
  return { session: session(over), events };
}

// ---------------------------------------------------------------------------
// EventSource mock
// ---------------------------------------------------------------------------

type Listener = (evt: { data: string }) => void;

export class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emit(event: VerseEvent): void {
    const payload = { data: JSON.stringify(event) };
    for (const cb of this.listeners.get(event.type) ?? []) cb(payload);
  }

  emitNamed(type: string, data: unknown): void {
    const payload = { data: JSON.stringify(data) };
    for (const cb of this.listeners.get(type) ?? []) cb(payload);
  }

  static forSession(sessionId: string): MockEventSource {
    const found = [...MockEventSource.instances].reverse().find((i) => i.url.includes(`/api/verse/sessions/${encodeURIComponent(sessionId)}/events`) && !i.closed);
    if (!found) throw new Error(`no open MockEventSource for session ${sessionId}; urls: ${MockEventSource.instances.map((i) => i.url).join(', ')}`);
    return found;
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

export interface VerseFetchState {
  bootstrap: VerseBootstrap;
  sessions: VerseSession[];
  details: Record<string, VerseSessionDetail>;
  calls: Array<{ path: string; method: string; body: unknown; headers: Record<string, string> }>;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function verseFetch(initial: Partial<VerseFetchState> = {}): { fetch: ReturnType<typeof vi.fn>; state: VerseFetchState } {
  const boot = initial.bootstrap ?? bootstrap();
  const state: VerseFetchState = {
    bootstrap: boot,
    sessions: initial.sessions ?? boot.sessions,
    details: initial.details ?? Object.fromEntries(boot.sessions.map((s) => [s.id, { session: s, events: [] }])),
    calls: [],
  };
  let counter = 100;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    state.calls.push({ path, method, body, headers });
    if (path === '/api/session') return new Response(null, { status: 204 });
    if (path === '/api/verse/bootstrap') return json({ ...state.bootstrap, sessions: state.sessions });
    if (path === '/api/verse/sessions' && method === 'GET') return json(state.sessions);
    if (path === '/api/verse/sessions' && method === 'POST') {
      const req = body as { projectPath: string; seatId: string; model?: string; title?: string };
      const seat = state.bootstrap.seats.find((s) => s.id === req.seatId);
      if (!seat) return json({ error: 'seat not found', code: 'VERSE_INVALID' }, 400);
      const created = session({
        id: `vs_${counter++}`,
        title: req.title ?? 'New chat',
        projectPath: req.projectPath,
        seatId: seat.id,
        engine: seat.engine,
        accountId: seat.accountId,
        model: req.model ?? seat.models[0]!.id,
        turnCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: seat.contextWindow },
        updatedAt: new Date().toISOString(),
      });
      state.sessions = [created, ...state.sessions];
      state.details[created.id] = { session: created, events: [] };
      return json(created, 201);
    }
    const m = /^\/api\/verse\/sessions\/([^/?]+)(?:\/([a-z]+))?/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const action = m[2];
      const current = state.details[id];
      if (!current) return json({ error: 'not found', code: 'VERSE_SESSION_NOT_FOUND' }, 404);
      if (!action && method === 'GET') return json(current);
      if (action === 'turns' && method === 'POST') {
        if (current.session.status === 'running') return json({ error: 'busy', code: 'VERSE_SESSION_BUSY' }, 409);
        const running = { ...current.session, status: 'running' as const, updatedAt: new Date().toISOString() };
        state.details[id] = { ...current, session: running };
        state.sessions = state.sessions.map((s) => (s.id === id ? running : s));
        return json({ turnId: `turn_${counter++}`, session: running }, 202);
      }
      if (action === 'cancel' && method === 'POST') return json({ ok: true });
      if (action === 'delete' && method === 'POST') {
        delete state.details[id];
        state.sessions = state.sessions.filter((s) => s.id !== id);
        return json({ ok: true });
      }
      if (action === 'rename' && method === 'POST') {
        const renamed = { ...current.session, title: (body as { title: string }).title };
        state.details[id] = { ...current, session: renamed };
        state.sessions = state.sessions.map((s) => (s.id === id ? renamed : s));
        return json(renamed);
      }
    }
    return new Response('not found', { status: 404 });
  });
  return { fetch: fetchMock, state };
}

export function ev<T extends VerseEvent['type']>(seq: number, type: T, rest: Omit<Extract<VerseEvent, { type: T }>, 'seq' | 'at' | 'type'>): VerseEvent {
  return { seq, at: `2026-09-19T10:0${seq % 10}:00.000Z`, type, ...rest } as VerseEvent;
}

/**
 * A fake Devin v3 API for tests (3.15) — an injected `fetch`, never the
 * network. Implements exactly the routes the client uses, with the shapes of
 * https://docs.devin.ai/v3-openapi.yaml (SessionResponse, PaginatedResponse,
 * ServiceUserSelf / PatUserSelf, ProblemDetail), and records every request so
 * tests can assert headers and bodies.
 */
import type { DevinFetch } from '../../src/core/devin/client.js';

export interface FakeSession {
  session_id: string;
  url: string;
  status: string;
  status_detail?: string | null;
  acus_consumed?: number;
  pull_requests?: Array<{ pr_url: string; pr_state: string | null }>;
  tags?: string[];
  title?: string | null;
  structured_output?: Record<string, unknown> | null;
  org_id?: string;
  created_at?: number;
  updated_at?: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** SessionMessage (3.15 chat seat): GET …/messages returns these, cursor = index. */
export interface FakeMessage {
  event_id: string;
  source: 'devin' | 'user';
  message: string;
  created_at: number;
}

export interface FakeDevin {
  fetch: DevinFetch;
  requests: RecordedRequest[];
  sessions: Map<string, FakeSession>;
  /** 3.15: each session's message stream (chronological). */
  messages: Map<string, FakeMessage[]>;
  /** 3.15: append a Devin message to a session (a test's "Devin said …"). */
  say(sessionId: string, text: string): void;
  /** The key the server accepts. */
  key: string;
  orgId: string;
  self: Record<string, unknown>;
  /** Queue of forced responses: consumed first (status, body, headers). */
  forced: Array<{ status: number; body?: unknown; headers?: Record<string, string>; throws?: boolean }>;
  /** Called before a create is answered (e.g. to throw after "sending"). */
  onCreate: ((body: Record<string, unknown>) => void) | null;
}

export const FAKE_ORG = 'org-fake123';
export const FAKE_KEY = 'cog_fakeTestKey_0123456789abcdefghij';

let counter = 0;

export function fakeDevin(opts: { key?: string; orgId?: string; self?: Record<string, unknown> } = {}): FakeDevin {
  const f: FakeDevin = {
    fetch: null as unknown as DevinFetch,
    requests: [],
    sessions: new Map(),
    messages: new Map(),
    say: () => undefined,
    key: opts.key ?? FAKE_KEY,
    orgId: opts.orgId ?? FAKE_ORG,
    self: opts.self ?? { principal_type: 'service_user', service_user_id: 'su-1', service_user_name: 'Ashlr Verse', org_id: null },
    forced: [],
    onCreate: null,
  };
  let eventCounter = 0;
  const push = (sessionId: string, source: 'devin' | 'user', message: string): void => {
    eventCounter += 1;
    const list = f.messages.get(sessionId) ?? [];
    list.push({ event_id: `ev-${eventCounter}`, source, message, created_at: eventCounter });
    f.messages.set(sessionId, list);
  };
  f.say = (sessionId, text) => push(sessionId, 'devin', text);
  const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  });
  f.fetch = async (url, init) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = v;
    let body: unknown;
    try {
      body = init.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init.body;
    }
    f.requests.push({ method: init.method, url, path: parsed.pathname + parsed.search, headers, body });
    const forced = f.forced.shift();
    if (forced) {
      if (forced.throws) throw new Error(`socket hang up (Authorization: ${headers['authorization'] ?? ''})`);
      return respond(forced.status, forced.body, forced.headers);
    }
    if (headers['authorization'] !== `Bearer ${f.key}`) {
      return respond(401, { title: 'Unauthorized', status: 401, detail: `Invalid key ${headers['authorization']?.slice(7) ?? ''}` });
    }
    const path = parsed.pathname;
    if (init.method === 'GET' && path === '/v3/self') return respond(200, f.self);
    const orgMatch = /^\/v3\/organizations\/([^/]+)\/sessions(?:\/([^/]+))?(\/messages)?$/.exec(path);
    if (!orgMatch) return respond(404, { title: 'Not Found', status: 404, detail: 'no route' });
    if (decodeURIComponent(orgMatch[1]!) !== f.orgId) return respond(403, { title: 'Forbidden', status: 403, detail: 'not your org' });
    const sessionId = orgMatch[2] ? decodeURIComponent(orgMatch[2]) : null;
    if (!sessionId && init.method === 'POST') {
      const request = body as Record<string, unknown>;
      f.onCreate?.(request);
      counter += 1;
      const id = `devin-fake${counter.toString(36)}`;
      const session: FakeSession = {
        session_id: id, url: `https://app.devin.ai/sessions/${id}`, status: 'new', status_detail: null, acus_consumed: 0,
        pull_requests: [], tags: (request['tags'] as string[] | undefined) ?? [], title: (request['title'] as string | undefined) ?? null,
        org_id: f.orgId, created_at: 1, updated_at: 1,
      };
      f.sessions.set(id, session);
      push(id, 'user', String(request['prompt'] ?? ''));
      // The docs' own example create response carries only these three fields.
      return respond(200, { session_id: id, url: session.url, status: 'new' });
    }
    if (!sessionId && init.method === 'GET') {
      return respond(200, { items: [...f.sessions.values()], end_cursor: null, has_next_page: false, total: f.sessions.size });
    }
    const session = sessionId ? f.sessions.get(sessionId) : undefined;
    if (!session) return respond(404, { title: 'Not Found', status: 404, detail: 'no such session' });
    if (orgMatch[3] && init.method === 'POST') {
      if (session.status === 'exit') return respond(409, { title: 'Conflict', status: 409, detail: 'session has ended' });
      if (session.status === 'suspended') session.status = 'running';
      push(session.session_id, 'user', String((body as Record<string, unknown>)['message'] ?? ''));
      return respond(200, session);
    }
    if (orgMatch[3] && init.method === 'GET') {
      // PaginatedResponse[SessionMessage]: `after` is the previous end_cursor (an index here).
      const list = f.messages.get(session.session_id) ?? [];
      const after = parsed.searchParams.get('after');
      const first = Number(parsed.searchParams.get('first') ?? '100');
      const start = after === null ? 0 : Number(after);
      const items = list.slice(start, start + first);
      const end = start + items.length;
      return respond(200, { items, end_cursor: String(end), has_next_page: end < list.length });
    }
    if (init.method === 'DELETE') {
      session.status = 'exit';
      session.status_detail = null;
      return respond(200, session);
    }
    if (init.method === 'GET') return respond(200, session);
    return respond(404, { title: 'Not Found', status: 404 });
  };
  return f;
}

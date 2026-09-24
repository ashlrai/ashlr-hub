/**
 * core/verse/activity-api.ts — the activity + session-meta route family
 * (V3.10, unit C1). Mounted by verse-api.ts's WORKBENCH table (C0) under the
 * prefixes `/api/verse/activity` and `/api/verse/session-meta`.
 *
 *   GET  /api/verse/activity[?since=<cursor>]  → VerseActivityResponse
 *   POST /api/verse/activity/seen  {sessionId, turnCount} → VerseSessionMeta
 *                                  {surface:'mind'}        → { ok: true, mindSeenAt }
 *   GET  /api/verse/session-meta               → VerseSessionMetaResponse
 *   GET  /api/verse/session-meta/:id           → VerseSessionMeta
 *   POST /api/verse/session-meta/:id {pinned?, archived?} → VerseSessionMeta
 *
 * Posture (same as every Verse route): GETs sit behind the read session; the
 * mount runs every POST through the dispatch + mutation gate BEFORE this
 * module loads, and the handler checks again (a module can be mounted or
 * called by something other than that table). Bodies and queries are STRICT:
 * an unknown key is a 400, never ignored. Responses go through sendJson →
 * sanitizePublicJson. Agents and MCP cannot reach any of it.
 *
 * `{surface:'mind'}` is an additive form of the seen route: B-U8's memos are
 * "unseen" until the operator opens Mind, and that fact belongs with the rest
 * of the read state rather than in a second route family. (C0 request:
 * add `VerseActivitySeenSurfaceRequest` to workbench-types §3.)
 *
 * BUDGET: GET /activity answers from memory (activity.ts). The first request
 * of a process pays the engine's store scan and resolves the Track B
 * producer modules once; the inbox scan never runs on a request's stack.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { getVerseHealthService } from './account-health.js';
import {
  ApprovalsScanner,
  createActivityReader,
  parseActivityCursor,
  type ActivityDeps,
  type ActivityEngine,
  type ActivityReader,
  type NeedsYouProducers,
  type NeedsYouProducerStates,
  type NeedsYouSourceState,
} from './activity.js';
import type { ApiModule } from './api-modules.js';
import { createSessionMetaStore, type SessionMetaStore } from './session-meta.js';
import type { VerseApiContext } from './verse-api.js';
import { getVerseEngine, peekVerseEngine } from './verse-api.js';
import {
  VERSE_ACTIVITY_PATH,
  VERSE_ACTIVITY_SEEN_PATH,
  VERSE_SESSION_META_PATH,
  type NeedsYouItem,
  type VerseAutonomyBadge,
} from './workbench-types.js';

const BODY_MAX_BYTES = 4 * 1024;
const SESSION_ID_RE = /^[\w.-]{1,200}$/;

/** Additive seen form (see header). */
export interface VerseActivitySeenSurfaceRequest {
  surface: 'mind';
}

// ===========================================================================
// Wiring (module singletons, with test seams)
// ===========================================================================

interface TrackBHooks {
  producers: NeedsYouProducers;
  /** Each producer's `needsYouSourceState` (optional: older hooks / test fakes lack it). */
  states?: NeedsYouProducerStates;
  autonomy: (() => VerseAutonomyBadge | null) | null;
  latestMemoAt: (() => string | null) | null;
}

const NO_HOOKS: TrackBHooks = { producers: { authority: null, fleet: null, leader: null }, states: {}, autonomy: null, latestMemoAt: null };

type ModuleExports = Record<string, unknown>;

/**
 * Track B's producer modules (workbench-types NEEDS_YOU_PROVIDERS), imported
 * lazily so activity has no load-time edge into core/{authority,fleet,vision}.
 * Literal specifiers inside try + `as string`: the same recipe verse-api.ts's
 * mount uses so `tsc` and `bun build --compile` both accept a module that has
 * not landed yet (it is then simply "unavailable").
 */
async function importAuthority(): Promise<ModuleExports | null> {
  try { return (await import('./authority-api.js' as string)) as ModuleExports; } catch { return null; }
}
async function importFleetLive(): Promise<ModuleExports | null> {
  try { return (await import('./fleet-live-api.js' as string)) as ModuleExports; } catch { return null; }
}
async function importLeader(): Promise<ModuleExports | null> {
  try { return (await import('./leader-api.js' as string)) as ModuleExports; } catch { return null; }
}

function fn<T>(mod: ModuleExports | null, name: string): T | null {
  const value = mod?.[name];
  return typeof value === 'function' ? (value as T) : null;
}

export async function resolveTrackBHooks(): Promise<TrackBHooks> {
  const [authority, fleet, leader] = await Promise.all([importAuthority(), importFleetLive(), importLeader()]);
  return {
    producers: {
      authority: fn<() => NeedsYouItem[]>(authority, 'needsYouItems'),
      fleet: fn<() => NeedsYouItem[]>(fleet, 'needsYouItems'),
      leader: fn<() => NeedsYouItem[]>(leader, 'needsYouItems'),
    },
    // R3c: without these, a producer still warming answered [] (read as an
    // all-clear) or threw (read as an error) on every cold start.
    states: {
      authority: fn<() => NeedsYouSourceState>(authority, 'needsYouSourceState'),
      fleet: fn<() => NeedsYouSourceState>(fleet, 'needsYouSourceState'),
      leader: fn<() => NeedsYouSourceState>(leader, 'needsYouSourceState'),
    },
    autonomy: fn<() => VerseAutonomyBadge | null>(authority, 'autonomyBadge'),
    latestMemoAt: fn<() => string | null>(leader, 'latestMemoAt'),
  };
}

/** Re-resolve a missing producer this often, so a module that lands under a dev server is picked up. */
const HOOK_RETRY_MS = 60_000;

interface Wiring {
  home: string | undefined;
  meta: SessionMetaStore;
  approvals: ApprovalsScanner;
  reader: ActivityReader;
  hooks: TrackBHooks;
  hooksAt: number;
  hooksPending: Promise<void> | null;
}

let wiring: Wiring | null = null;
let engineOverride: (() => ActivityEngine | null) | null = null;
let depsOverride: Partial<ActivityDeps> | null = null;
let hooksOverride: TrackBHooks | null = null;

function currentWiring(): Wiring {
  // Keyed by HOME so a relocated HOME (tests, `ashlr verse --home`) never
  // reads or writes the previous one's meta file.
  const home = process.env['HOME'];
  if (wiring && wiring.home === home) return wiring;
  const meta = createSessionMetaStore();
  const approvals = new ApprovalsScanner();
  const w: Wiring = {
    home,
    meta,
    approvals,
    hooks: hooksOverride ?? NO_HOOKS,
    hooksAt: 0,
    hooksPending: null,
    reader: null as unknown as ActivityReader,
  };
  w.reader = createActivityReader({
    engine: () => (engineOverride ? engineOverride() : (peekVerseEngine() as ActivityEngine | null)),
    meta,
    producers: () => w.hooks.producers,
    producerStates: () => w.hooks.states ?? {},
    approvals: () => approvals.snapshot(),
    health: () => {
      const current = getVerseHealthService()?.current();
      return current ? { seats: current.seats, reports: current.reports } : null;
    },
    autonomy: () => (w.hooks.autonomy ? w.hooks.autonomy() : null),
    latestMemoAt: () => (w.hooks.latestMemoAt ? w.hooks.latestMemoAt() : null),
    ...depsOverride,
  });
  // Mind is only a badge once the Leader module exists; until then the
  // response says null (unknown), not "no memo".
  wiring = w;
  return w;
}

async function ensureReady(w: Wiring): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (!engineOverride && !peekVerseEngine()) tasks.push(getVerseEngine().catch(() => null));
  if (!hooksOverride) {
    const missing = !w.hooks.producers.authority || !w.hooks.producers.fleet || !w.hooks.producers.leader;
    const due = w.hooksAt === 0 || (missing && Date.now() - w.hooksAt > HOOK_RETRY_MS);
    if (due && !w.hooksPending) {
      w.hooksAt = Date.now();
      w.hooksPending = resolveTrackBHooks()
        .then((hooks) => { w.hooks = hooks; })
        .catch(() => undefined)
        .finally(() => { w.hooksPending = null; });
    }
    // Only the FIRST resolution is awaited; later retries run behind the
    // answer so no poll ever waits on a module import again.
    if (w.hooksPending && w.hooks === NO_HOOKS) tasks.push(w.hooksPending);
  }
  // Same for the inbox: the first poll waits for the first scan (async I/O,
  // never blocking the loop) so it does not report approvals "unavailable"
  // for no reason; every later poll reads the last result.
  if (w.approvals.snapshot().state === 'unavailable') tasks.push(w.approvals.refresh());
  if (tasks.length > 0) await Promise.all(tasks);
}

/** Test seam: inject the engine, the Track B hooks and/or any activity dependency; null restores. */
export function setActivityWiringForTest(next: {
  engine?: () => ActivityEngine | null;
  hooks?: TrackBHooks;
  deps?: Partial<ActivityDeps>;
} | null): void {
  engineOverride = next?.engine ?? null;
  hooksOverride = next?.hooks ?? null;
  depsOverride = next?.deps ?? null;
  wiring = null;
}

/** The session-meta store the routes use (for the Sidebar owner's tests and diagnostics). */
export function activityMetaStore(): SessionMetaStore {
  return currentWiring().meta;
}

// ===========================================================================
// Helpers
// ===========================================================================

function bad(res: ServerResponse, error: string): true {
  sendJson(res, 400, { error, code: 'VERSE_INVALID' });
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readBody(req, BODY_MAX_BYTES);
  } catch {
    sendJson(res, 413, { error: 'request body too large', code: 'VERSE_TOO_LARGE' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    bad(res, 'body must be JSON');
    return null;
  }
  if (!isObject(parsed)) {
    bad(res, 'body must be a JSON object');
    return null;
  }
  return parsed;
}

function unknownKeys(body: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(body).filter((k) => !allowed.includes(k));
}

function queryParams(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function sessionsOf(engine: ActivityEngine | null) {
  return engine ? engine.listSessions() : [];
}

function currentEngine(): ActivityEngine | null {
  return engineOverride ? engineOverride() : (peekVerseEngine() as ActivityEngine | null);
}

async function requireEngine(): Promise<ActivityEngine | null> {
  const engine = currentEngine();
  if (engine || engineOverride) return engine;
  try { return (await getVerseEngine()) as ActivityEngine; } catch { return null; }
}

/** Fix the unread baseline into existing chats (session-meta.ts SEEDING). Never fails a request. */
function seed(w: Wiring, sessions: ReturnType<typeof sessionsOf>): void {
  try { w.meta.seedBaseline(sessions); } catch { /* reads fall back to the implied baseline */ }
}

// ===========================================================================
// Handler
// ===========================================================================

const META_ID_RE = /^\/api\/verse\/session-meta\/([^/]+)$/;

export const handleActivityApi: ApiModule = async (ctx: VerseApiContext, req, res, path, method) => {
  const isActivity = path === VERSE_ACTIVITY_PATH || path === VERSE_ACTIVITY_SEEN_PATH;
  const isMeta = path === VERSE_SESSION_META_PATH || META_ID_RE.test(path);
  if (!isActivity && !isMeta) return false;

  if (method !== 'GET') {
    if (method !== 'POST') return false;
    if (path === VERSE_ACTIVITY_PATH || path === VERSE_SESSION_META_PATH) return false;
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }
    if (!passesMutationGate(req, res, ctx.token)) return true;
  }

  const w = currentWiring();

  // ── GET /api/verse/activity ─────────────────────────────────────────────
  if (path === VERSE_ACTIVITY_PATH) {
    if (method !== 'GET') return false;
    const params = queryParams(req);
    const extra = [...params.keys()].filter((k) => k !== 'since');
    if (extra.length > 0) return bad(res, `unknown query parameter: ${extra[0]}`);
    const raw = params.get('since');
    const since = raw === null || raw === '' ? null : parseActivityCursor(raw);
    if (raw !== null && raw !== '' && !since) return bad(res, 'since must be a cursor this route returned');
    await ensureReady(w);
    sendJson(res, 200, w.reader.build(since).response);
    return true;
  }

  // ── POST /api/verse/activity/seen ───────────────────────────────────────
  if (path === VERSE_ACTIVITY_SEEN_PATH) {
    if (method !== 'POST') return false;
    const body = await readJson(req, res);
    if (!body) return true;
    if ('surface' in body) {
      const extra = unknownKeys(body, ['surface']);
      if (extra.length > 0) return bad(res, `unknown key: ${extra[0]}`);
      if (body['surface'] !== 'mind') return bad(res, "surface must be 'mind'");
      const at = new Date().toISOString();
      w.meta.markMindSeen(at);
      sendJson(res, 200, { ok: true, mindSeenAt: w.meta.mindSeenAt() });
      return true;
    }
    const extra = unknownKeys(body, ['sessionId', 'turnCount']);
    if (extra.length > 0) return bad(res, `unknown key: ${extra[0]}`);
    const { sessionId, turnCount } = body;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return bad(res, 'sessionId is required');
    if (typeof turnCount !== 'number' || !Number.isInteger(turnCount) || turnCount < 0) {
      return bad(res, 'turnCount must be a non-negative integer');
    }
    const engine = await requireEngine();
    const sessions = sessionsOf(engine);
    seed(w, sessions);
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found', code: 'VERSE_SESSION_NOT_FOUND' });
      return true;
    }
    // Never past what the chat really has: a client cannot pre-mark a turn
    // that has not happened yet (and so hide it when it does).
    const clamped = Math.min(turnCount, session.turnCount);
    const meta = w.meta.markSeen(session, clamped, new Set(sessions.map((s) => s.id)));
    sendJson(res, 200, meta);
    return true;
  }

  // ── /api/verse/session-meta[/:id] ───────────────────────────────────────
  if ([...queryParams(req).keys()].length > 0) return bad(res, 'session-meta takes no query parameters');
  const engine = await requireEngine();
  const sessions = sessionsOf(engine);
  // The Sidebar's unread dots come from here, possibly before the first
  // activity poll: seed first, or an old chat reads unread on first launch.
  seed(w, sessions);

  if (path === VERSE_SESSION_META_PATH) {
    if (method !== 'GET') return false;
    sendJson(res, 200, { sessions: w.meta.list(sessions) });
    return true;
  }

  let id: string;
  try {
    id = decodeURIComponent(META_ID_RE.exec(path)![1]!);
  } catch {
    return bad(res, 'malformed session id');
  }
  if (!SESSION_ID_RE.test(id)) return bad(res, 'malformed session id');
  const session = sessions.find((s) => s.id === id);
  if (!session) {
    sendJson(res, 404, { error: 'session not found', code: 'VERSE_SESSION_NOT_FOUND' });
    return true;
  }
  if (method === 'GET') {
    sendJson(res, 200, w.meta.get(session));
    return true;
  }
  const body = await readJson(req, res);
  if (!body) return true;
  const extra = unknownKeys(body, ['pinned', 'archived']);
  if (extra.length > 0) return bad(res, `unknown key: ${extra[0]}`);
  if (!('pinned' in body) && !('archived' in body)) return bad(res, 'send pinned and/or archived');
  for (const key of ['pinned', 'archived'] as const) {
    if (key in body && typeof body[key] !== 'boolean') return bad(res, `${key} must be true or false`);
  }
  const meta = w.meta.update(
    session,
    {
      ...(typeof body['pinned'] === 'boolean' ? { pinned: body['pinned'] } : {}),
      ...(typeof body['archived'] === 'boolean' ? { archived: body['archived'] } : {}),
    },
    new Set(sessions.map((s) => s.id)),
  );
  sendJson(res, 200, meta);
  return true;
};

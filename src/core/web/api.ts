/**
 * core/web/api.ts — M14 JSON API handler.
 *
 * Handles all /api/* routes for the local web dashboard. Returns true if it
 * handled the request (so server.ts does NOT fall through to static serving),
 * false otherwise.
 *
 * Read-only routes (always available, no auth):
 *   GET /api/snapshot          -> buildSnapshot(cfg)
 *   GET /api/runs              -> listRuns()
 *   GET /api/run/:id           -> loadRun(id) | 404
 *   GET /api/swarms            -> listSwarms()
 *   GET /api/swarm/:id         -> loadSwarm(id) | 404
 *   GET /api/pulse?window=7d   -> buildRollup(window, cfg)
 *   GET /api/genome[?q=...]    -> recall(q, cfg) | loadGenome(cfg)
 *   GET /api/inbox             -> listProposals({status:'pending'}) (read-only; M23)
 *   GET /api/daemon            -> loadDaemonState() (read-only; M24; no control endpoint)
 *   GET /api/events            -> Server-Sent Events stream
 *
 * Mutating route (ONLY when ctx.allowDispatch === true + token header):
 *   POST /api/run              -> runGoal (budget-capped, local-first)
 *
 * SECURITY:
 *  - Never throws (500 on internal error).
 *  - Metadata only — no secret values ever serialised.
 *  - No outward/SSRF calls.
 *  - POST /api/run: 404 when !allowDispatch; constant-time token compare;
 *    requires Content-Type: application/json (415 otherwise); budget clamped,
 *    allowCloud:false always.
 *  - SSE: bounded poll, capped concurrent connections, timers cleared on
 *    client disconnect AND on server close() via the returned cleanup registry
 *    (tracked by server.ts).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';

import type { AshlrConfig } from '../types.js';
import { buildSnapshot } from '../dashboard.js';
import { listRuns, loadRun, runGoal } from '../run/orchestrator.js';
import { listSwarms, loadSwarm } from '../swarm/store.js';
import { buildRollup } from '../observability/rollup.js';
import { loadGenome } from '../genome/store.js';
import { recall } from '../genome/recall.js';
import { listProposals } from '../inbox/store.js';
// M24: read-only daemon state endpoint — no control surface; start/stop stays CLI-only.
import { loadDaemonState } from '../daemon/state.js';

// ---------------------------------------------------------------------------
// SSE registry — shared across all open SSE connections so server.ts can
// drain them on close(). Module-level so the close() callback in server.ts
// can import and call drainSseConnections().
// ---------------------------------------------------------------------------

/** Active SSE cleanup functions, keyed by a random connection id. */
const _sseCleanups = new Map<string, () => void>();

/**
 * Register a cleanup callback for an SSE connection.
 * Returns the id so it can be deregistered on close.
 */
function registerSse(cleanup: () => void): string {
  const id = randomBytes(8).toString('hex');
  _sseCleanups.set(id, cleanup);
  return id;
}

/** Remove a registered SSE cleanup. */
function deregisterSse(id: string): void {
  _sseCleanups.delete(id);
}

/**
 * Drain all open SSE connections (called by server.ts close()).
 * Each cleanup clears the interval and ends the response.
 */
export function drainSseConnections(): void {
  for (const cleanup of _sseCleanups.values()) {
    try {
      cleanup();
    } catch {
      // Best-effort.
    }
  }
  _sseCleanups.clear();
}

// ---------------------------------------------------------------------------
// SSE poll interval — bounded, not configurable by callers.
// ---------------------------------------------------------------------------

const SSE_POLL_MS = 1500;

/**
 * Maximum concurrent SSE connections. Each connection holds a socket + a
 * bounded poll timer; cap the total so a scripted local client (or non-browser
 * process on the loopback interface) cannot open an unbounded number of
 * EventSource connections for a local resource-exhaustion DoS. Browsers
 * self-limit to ~6 per origin, but the server must not rely on that.
 */
const SSE_MAX_CONNECTIONS = 64;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a JSON response. Never throws. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(payload);
  } catch {
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end('{"error":"internal error"}');
    } catch {
      // Socket already closed — swallow.
    }
  }
}

/** Write a 500 JSON error. Never throws. */
function send500(res: ServerResponse, msg = 'internal error'): void {
  sendJson(res, 500, { error: msg });
}

/**
 * Constant-time string comparison to defend against timing attacks.
 * Returns true iff a === b (both strings, same bytes).
 */
function safeEqual(a: string, b: string): boolean {
  try {
    // Both must be the same byte length for timingSafeEqual.
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Parse and validate the `window` query param for /api/pulse.
 * Allowed: '1d' | '7d' | '30d'; default '7d'.
 */
function parseWindow(raw: string | undefined): '1d' | '7d' | '30d' {
  if (raw === '1d' || raw === '7d' || raw === '30d') return raw;
  return '7d';
}

/**
 * Safely read the full request body as a string (bounded to 64 KB).
 * Rejects on oversized or errored requests.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const MAX_BYTES = 65_536;
    let buf = '';
    let total = 0;

    req.on('data', (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      total += Buffer.byteLength(s, 'utf8');
      if (total > MAX_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      buf += s;
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

/**
 * Extract the value of a query parameter from a URL (or URL path string).
 * Returns undefined if not present.
 */
function getQueryParam(url: string, name: string): string | undefined {
  try {
    // URL may be just a path+query — prepend a dummy base so URL() can parse.
    const parsed = new URL(url, 'http://localhost');
    const v = parsed.searchParams.get(name);
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
}

/**
 * Extract the path from the request URL, without query string.
 * Never throws; falls back to '/'.
 */
function reqPath(req: IncomingMessage): string {
  try {
    const raw = req.url ?? '/';
    const parsed = new URL(raw, 'http://localhost');
    return parsed.pathname;
  } catch {
    return '/';
  }
}

// ---------------------------------------------------------------------------
// SSE handler
// ---------------------------------------------------------------------------

/** Build the current runs slice payload for SSE. */
function sseRunsPayload(): unknown {
  return listRuns().slice(0, 20).map((r) => ({
    id: r.id,
    goal: r.goal,
    status: r.status,
    tokens: (r.usage?.tokensIn ?? 0) + (r.usage?.tokensOut ?? 0),
    updatedAt: r.updatedAt,
  }));
}

/** Build the current swarms slice payload for SSE. */
function sseSwarmsPayload(): unknown {
  return listSwarms().slice(0, 20).map((s) => ({
    id: s.id,
    goal: s.goal,
    status: s.status,
    tasksDone: s.tasks.filter(
      (t) => t.status === 'done' || t.status === 'skipped',
    ).length,
    tasksTotal: s.tasks.length,
    updatedAt: s.updatedAt,
  }));
}

/**
 * Handle GET /api/events: stream run/swarm updates as Server-Sent Events.
 *
 * On each poll tick, re-reads listRuns() + listSwarms() and emits NAMED SSE
 * events — `event: runs` and `event: swarms` — each carrying its own JSON
 * payload. The named events match the client's EventSource listeners
 * (es.addEventListener('runs'|'swarms', ...)) so live burndown patches the
 * views without a full reload. (An unnamed `data:` frame would dispatch only
 * to es.onmessage, which the client does not register.)
 *
 * The poll timer is bounded (SSE_POLL_MS) and cleared on:
 *   (a) client disconnect (req 'close' event)
 *   (b) server shutdown (drainSseConnections())
 *
 * Concurrent connections are capped (SSE_MAX_CONNECTIONS) to bound timer/
 * socket growth; excess connections get a 503.
 */
function handleSseEvents(req: IncomingMessage, res: ServerResponse): void {
  // Cap concurrent SSE connections to bound timer/socket growth.
  if (_sseCleanups.size >= SSE_MAX_CONNECTIONS) {
    sendJson(res, 503, { error: 'too many live connections' });
    return;
  }

  // SSE headers — no buffering, keep-alive.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  // Write an initial comment to flush headers to client.
  try {
    res.write(': connected\n\n');
  } catch {
    return; // Socket already gone.
  }

  // Helper: send one NAMED SSE event so the client's per-name listeners fire.
  function sendNamed(event: string, payload: unknown): void {
    try {
      const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      res.write(line);
    } catch {
      // Socket closed; cleanup will be triggered by 'close' event.
    }
  }

  // Emit one full update (both runs and swarms slices).
  function emitUpdate(): void {
    sendNamed('runs', sseRunsPayload());
    sendNamed('swarms', sseSwarmsPayload());
  }

  // Send an initial snapshot immediately.
  try {
    emitUpdate();
  } catch {
    // If the initial read fails, the client gets no data until the next tick.
  }

  // Poll on a bounded interval.
  const intervalId = setInterval(() => {
    try {
      emitUpdate();
    } catch {
      // Socket may be gone; 'close' event will clean up.
    }
  }, SSE_POLL_MS);

  // Cleanup: clear the interval and end the response.
  const cleanup = (): void => {
    clearInterval(intervalId);
    deregisterSse(sseId);
    try {
      res.end();
    } catch {
      // Already ended.
    }
  };

  const sseId = registerSse(cleanup);

  // Clear on client disconnect.
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ---------------------------------------------------------------------------
// Dispatch route (token-guarded, ONLY when allowDispatch === true)
// ---------------------------------------------------------------------------

/**
 * Handle POST /api/run — launch `runGoal` with budget-capped, local-first opts.
 *
 * Security:
 *  - Route does not exist (404) when ctx.allowDispatch is false.
 *  - Requires `x-ashlr-token` header equal to ctx.token (constant-time compare).
 *    Missing/wrong token -> 401.
 *  - Requires `Content-Type: application/json` -> 415 otherwise (defence in
 *    depth against simple-request form-POST CSRF; the token check is the
 *    actual control).
 *  - Body is JSON { goal, budget?, maxSteps?, parallel? }.
 *  - allowCloud is always false; maxTokens and maxSteps are clamped to sane
 *    local-first ceilings (never higher than the CLI defaults).
 */
async function handleDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AshlrConfig,
  ctx: { token: string },
): Promise<void> {
  // Token check (constant-time).
  const providedToken = Array.isArray(req.headers['x-ashlr-token'])
    ? (req.headers['x-ashlr-token'][0] ?? '')
    : (req.headers['x-ashlr-token'] ?? '');

  if (!safeEqual(providedToken, ctx.token)) {
    sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
    return;
  }

  // Content-Type check — require JSON. Blocks simple-request form-POST CSRF
  // attempts before body parsing (defence in depth; token is the real gate).
  const contentType = Array.isArray(req.headers['content-type'])
    ? (req.headers['content-type'][0] ?? '')
    : (req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().trim().startsWith('application/json')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    return;
  }

  // Parse body.
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: 'body must be a JSON object' });
    return;
  }

  const obj = body as Record<string, unknown>;
  const goal = typeof obj['goal'] === 'string' ? obj['goal'].trim() : '';
  if (!goal) {
    sendJson(res, 400, { error: '"goal" (string) is required' });
    return;
  }

  // Local-first budget ceilings — never elevated by caller input.
  const MAX_TOKENS_CEILING = 200_000;
  const MAX_STEPS_CEILING = 40;
  const MAX_PARALLEL_CEILING = 4;

  const rawMaxTokens =
    typeof obj['maxTokens'] === 'number' ? obj['maxTokens'] : MAX_TOKENS_CEILING;
  const rawMaxSteps =
    typeof obj['maxSteps'] === 'number' ? obj['maxSteps'] : MAX_STEPS_CEILING;
  const rawParallel =
    typeof obj['parallel'] === 'number' ? obj['parallel'] : 2;

  const maxTokens = Math.min(Math.max(1, Math.floor(rawMaxTokens)), MAX_TOKENS_CEILING);
  const maxSteps = Math.min(Math.max(1, Math.floor(rawMaxSteps)), MAX_STEPS_CEILING);
  const parallel = Math.min(Math.max(1, Math.floor(rawParallel)), MAX_PARALLEL_CEILING);

  // Run goal (local-first, never cloud).
  try {
    const runState = await runGoal(goal, cfg, {
      budget: {
        maxTokens,
        maxSteps,
        allowCloud: false, // NEVER allow cloud via the dispatch endpoint
      },
      parallel,
      allowCloud: false,
      json: true,
    });

    sendJson(res, 200, {
      id: runState.id,
      status: runState.status,
      goal: runState.goal,
      usage: runState.usage,
      result: runState.result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send500(res, `run failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Main handleApi export
// ---------------------------------------------------------------------------

/**
 * Handle a single request if its URL matches an /api/* route.
 *
 * @returns true if the request was an /api/* route and a response was written;
 *          false otherwise (server.ts falls through to static serving).
 *
 * Never throws — all errors are caught and returned as JSON 500 responses.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AshlrConfig,
  ctx: { token: string; allowDispatch: boolean },
): Promise<boolean> {
  const path = reqPath(req);

  // Only handle /api/* paths.
  if (!path.startsWith('/api/') && path !== '/api') {
    return false;
  }

  const method = (req.method ?? 'GET').toUpperCase();

  try {
    // ── GET /api/snapshot ───────────────────────────────────────────────────
    if (path === '/api/snapshot' && method === 'GET') {
      const snapshot = await buildSnapshot(cfg);
      sendJson(res, 200, snapshot);
      return true;
    }

    // ── GET /api/runs ────────────────────────────────────────────────────────
    if (path === '/api/runs' && method === 'GET') {
      const runs = listRuns();
      sendJson(res, 200, runs);
      return true;
    }

    // ── GET /api/run/:id ─────────────────────────────────────────────────────
    if (path.startsWith('/api/run/') && method === 'GET') {
      const id = path.slice('/api/run/'.length);
      if (!id) {
        sendJson(res, 400, { error: 'run id required' });
        return true;
      }
      const run = loadRun(id);
      if (!run) {
        sendJson(res, 404, { error: `run not found: ${id}` });
        return true;
      }
      sendJson(res, 200, run);
      return true;
    }

    // ── GET /api/swarms ──────────────────────────────────────────────────────
    if (path === '/api/swarms' && method === 'GET') {
      const swarms = listSwarms();
      sendJson(res, 200, swarms);
      return true;
    }

    // ── GET /api/swarm/:id ───────────────────────────────────────────────────
    if (path.startsWith('/api/swarm/') && method === 'GET') {
      const id = path.slice('/api/swarm/'.length);
      if (!id) {
        sendJson(res, 400, { error: 'swarm id required' });
        return true;
      }
      const swarm = loadSwarm(id);
      if (!swarm) {
        sendJson(res, 404, { error: `swarm not found: ${id}` });
        return true;
      }
      sendJson(res, 200, swarm);
      return true;
    }

    // ── GET /api/pulse ───────────────────────────────────────────────────────
    if (path === '/api/pulse' && method === 'GET') {
      const rawWindow = getQueryParam(req.url ?? '', 'window');
      const window = parseWindow(rawWindow);
      const rollup = buildRollup(window, cfg);
      sendJson(res, 200, rollup);
      return true;
    }

    // ── GET /api/genome ──────────────────────────────────────────────────────
    if (path === '/api/genome' && method === 'GET') {
      const q = getQueryParam(req.url ?? '', 'q');
      if (q && q.trim()) {
        // Query mode: use recall.
        const hits = await recall(q, cfg);
        sendJson(res, 200, hits);
      } else {
        // List mode: load all genome entries.
        const entries = loadGenome(cfg);
        sendJson(res, 200, entries);
      }
      return true;
    }

    // ── GET /api/inbox ───────────────────────────────────────────────────────
    // M23: read-only pending-proposals view. No mutation endpoint — approve
    // stays CLI-only via `ashlr inbox approve`. listProposals never throws.
    if (path === '/api/inbox' && method === 'GET') {
      const proposals = listProposals({ status: 'pending' });
      sendJson(res, 200, {
        pending: proposals.length,
        proposals,
      });
      return true;
    }

    // ── GET /api/daemon ─────────────────────────────────────────────────────
    // M24: read-only daemon state. No control endpoint — start/stop is CLI-only.
    // loadDaemonState() never throws; returns zeroed state when not yet
    // initialised (daemon/state.ts absent at runtime => caught below and 500'd,
    // but the import is soft-guarded in state.ts itself).
    if (path === '/api/daemon' && method === 'GET') {
      const ds = loadDaemonState();
      sendJson(res, 200, ds);
      return true;
    }

    // ── GET /api/events (SSE) ────────────────────────────────────────────────
    if (path === '/api/events' && method === 'GET') {
      handleSseEvents(req, res);
      return true;
    }

    // ── POST /api/run ────────────────────────────────────────────────────────
    if (path === '/api/run' && method === 'POST') {
      if (!ctx.allowDispatch) {
        // Route does not exist when dispatch is disabled.
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      await handleDispatch(req, res, cfg, ctx);
      return true;
    }

    // ── Method not allowed on known /api/ routes ─────────────────────────────
    // If path starts with /api/ but matched none of the above, it's either
    // a wrong method or an unknown sub-path. Return 404.
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch (err) {
    // Catch-all: never let an unhandled error escape.
    const msg = err instanceof Error ? err.message : String(err);
    send500(res, msg);
    return true;
  }
}

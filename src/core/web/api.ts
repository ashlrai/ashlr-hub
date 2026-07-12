/**
 * core/web/api.ts — M14 JSON API handler.
 *
 * Handles all /api/* routes for the local web dashboard. Returns true if it
 * handled the request (so server.ts does NOT fall through to static serving),
 * false otherwise.
 *
 * Read-only routes (always available, no auth):
 *   GET /api/snapshot          -> buildSnapshot(cfg)
 *   GET /api/config/effective  -> effective autonomy/daemon/foundry/backend config
 *   GET /api/portfolio         -> buildSnapshot(cfg).portfolio | null (read-only; M29)
 *   GET /api/runs              -> listRuns()
 *   GET /api/run/:id           -> loadRun(id) | 404
 *   GET /api/swarms            -> listSwarms()
 *   GET /api/swarm/:id         -> loadSwarm(id) | 404
 *   GET /api/pulse?window=7d   -> buildRollup(window, cfg)
 *   GET /api/genome[?q=...]    -> recall(q, cfg) | loadGenome(cfg)
 *   GET /api/inbox             -> listProposals({status:'pending'}) (read-only; M23)
 *   GET /api/autonomy/evidence -> list autonomy evidence packs (metadata only)
 *   GET /api/daemon            -> loadDaemonState() (read-only; M24; no control endpoint)
 *   GET /api/events            -> Server-Sent Events stream
 *
 * Mutating routes (ONLY when ctx.allowDispatch === true + token header):
 *   POST /api/run              -> runGoal (budget-capped, local-first)
 *   POST /api/open             -> openInEditor/openInFinder for an enrolled repo path (M100)
 *   POST /api/fleet/pause      -> engage the fleet kill switch
 *   POST /api/fleet/resume     -> clear the fleet kill switch
 *   POST /api/daemon/service/repair -> reinstall/reload daemon OS service
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
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * M341c (win32): canonicalize a path for COMPARISON only. Windows paths can
 * differ by 8.3 short names (RUNNER~1 vs runneradmin) and case while naming
 * the same directory — exact string equality 403'd every /api/open there.
 * POSIX is untouched (identity) so existing behavior stays byte-identical.
 */
function canonForCompare(p: string): string {
  if (process.platform !== 'win32') return p;
  let out = p;
  try {
    out = realpathSync.native(p);
  } catch {
    // nonexistent path — compare the resolved spelling
  }
  return out.toLowerCase();
}

import type { AshlrConfig, DashboardSnapshot } from '../types.js';
import { buildSnapshot } from '../dashboard.js';
import { loadEffectiveConfigSnapshot } from '../effective-config.js';
import { listRuns, loadRun, runGoal } from '../run/orchestrator.js';
import { listSwarms, loadSwarm } from '../swarm/store.js';
import { buildRollup } from '../observability/rollup.js';
import { loadGenome } from '../genome/store.js';
import { recall } from '../genome/recall.js';
import { listProposals, loadProposal, setStatus } from '../inbox/store.js';
// M24: read-only daemon state endpoint.
import { loadDaemonState } from '../daemon/state.js';
import { ensureRunning as ensureDaemonServiceRunning, install as installDaemonService, serviceStatus } from '../daemon/service.js';
import { daemonServiceInstallOptions } from '../daemon/service-config.js';
import { buildFleetStatus } from '../fleet/status.js';
// M61: Mission Control aggregator.
import { buildControlSnapshot } from './control.js';
// M90: Fleet-Activity panel.
import { buildFleetActivity } from './control.js';
// M100: desktop-open actions — reuse CLI launchers (read-only import; no mutation).
import { openInEditor, openInFinder } from '../../cli/open.js';
import { listEnrolled, setKill } from '../sandbox/policy.js';
import { listGoals } from '../goals/store.js';
import { progressOf } from '../goals/advance.js';
import { sanitizePublicJson } from '../util/public-json.js';

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

const SNAPSHOT_CACHE_MS = 5_000;

interface SnapshotCacheEntry {
  value: DashboardSnapshot | null;
  expiresAt: number;
  inFlight: Promise<DashboardSnapshot> | null;
}

const snapshotCache = new WeakMap<AshlrConfig, SnapshotCacheEntry>();

function buildCachedSnapshot(cfg: AshlrConfig): Promise<DashboardSnapshot> {
  const now = Date.now();
  let entry = snapshotCache.get(cfg);
  if (!entry) {
    entry = { value: null, expiresAt: 0, inFlight: null };
    snapshotCache.set(cfg, entry);
  }
  if (entry.value && now < entry.expiresAt) return Promise.resolve(entry.value);
  if (entry.inFlight) return entry.inFlight;

  entry.inFlight = buildSnapshot(cfg).then((value) => {
    entry!.value = value;
    entry!.expiresAt = Date.now() + SNAPSHOT_CACHE_MS;
    return value;
  }).finally(() => {
    entry!.inFlight = null;
  });
  return entry.inFlight;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a JSON response. Never throws. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    const payload = JSON.stringify(sanitizePublicJson(body) ?? null);
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
 * Read a single request header value (collapsing the string[] form Node uses
 * for repeated headers down to its first entry). Returns '' when absent.
 */
function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/**
 * The shared gate for the two mutating routes (POST /api/run and the web inbox
 * approve/reject). Enforces, in order:
 *   1. constant-time x-ashlr-token match  -> 401 on mismatch
 *   2. Content-Type: application/json     -> 415 otherwise (CSRF defence in
 *      depth; the token is the real control)
 * Writes the failure response itself and returns false when the request should
 * NOT proceed; returns true when both checks pass.
 */
function passesMutationGate(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  if (!safeEqual(headerValue(req, 'x-ashlr-token'), token)) {
    sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
    return false;
  }
  const contentType = headerValue(req, 'content-type');
  if (!contentType.toLowerCase().trim().startsWith('application/json')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    return false;
  }
  return true;
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
 * Handle GET /api/events: stream run/swarm/snapshot updates as Server-Sent Events (M213).
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
function handleSseEvents(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AshlrConfig,
  allowDispatch: boolean,
): void {
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
      const line = `event: ${event}\ndata: ${JSON.stringify(sanitizePublicJson(payload))}\n\n`;
      res.write(line);
    } catch {
      // Socket closed; cleanup will be triggered by 'close' event.
    }
  }

  // A slow snapshot must not let the interval accumulate concurrent full
  // fleet reads. One connection gets at most one in-flight update.
  let updateInFlight = false;

  // Emit one full update (runs, swarms, inbox, daemon slices).
  async function emitUpdate(): Promise<void> {
    if (updateInFlight) return;
    updateInFlight = true;
    try {
      sendNamed('runs', sseRunsPayload());
      sendNamed('swarms', sseSwarmsPayload());
      // M32: live inbox + daemon state for the web command center. Metadata
      // only — the inbox event carries id/title/kind, never diffs.
      try {
        const pending = listProposals({ status: 'pending' });
        sendNamed('inbox', {
          pending: pending.length,
          proposals: pending.slice(0, 20).map((p) => ({
            id: p.id,
            title: p.title,
            kind: p.kind,
            repo: p.repo,
            origin: p.origin,
            createdAt: p.createdAt,
          })),
        });
      } catch { /* inbox slice is best-effort */ }
      try {
        sendNamed('daemon', loadDaemonState());
      } catch { /* daemon slice is best-effort */ }
      // M90: fleet-activity liveness pulse — carry daemon tick count so the
      // Fleet Activity tab can update its "last tick" indicator in real-time
      // without a full /api/fleet-activity poll.
      try {
        const ds = loadDaemonState();
        const ticks = Array.isArray(ds.ticks) ? ds.ticks : [];
        sendNamed('fleet-activity-ping', {
          running: ds.running,
          lastTickAt: ds.lastTickAt,
          tickCount: ticks.length,
        });
      } catch { /* fleet-activity ping is best-effort */ }
      // M213: dashboard snapshot push — lets fleet-dashboard update without polling.
      try {
        const snap = await buildCachedSnapshot(cfg);
        sendNamed('snapshot', { ...snap, dispatchEnabled: allowDispatch });
      } catch { /* snapshot is best-effort */ }
    } finally {
      updateInFlight = false;
    }
  }

  // Send an initial snapshot immediately.
  try {
    void emitUpdate();
  } catch {
    // If the initial read fails, the client gets no data until the next tick.
  }

  // Poll on a bounded interval.
  const intervalId = setInterval(() => {
    try {
      void emitUpdate();
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
  // Token (constant-time) + JSON Content-Type gate — blocks simple-request
  // form-POST CSRF before body parsing (the token is the real control).
  if (!passesMutationGate(req, res, ctx.token)) {
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
      const snapshot = await buildCachedSnapshot(cfg);
      // M32: additive field so the frontend can show (not guess) whether the
      // dispatch/approve surfaces exist on this server instance.
      sendJson(res, 200, { ...snapshot, dispatchEnabled: ctx.allowDispatch });
      return true;
    }

    // ── GET /api/config/effective ───────────────────────────────────────────
    // Read-only operator config visibility. Re-reads raw config metadata so
    // source labels can distinguish configured values from defaults.
    if (path === '/api/config/effective' && method === 'GET') {
      sendJson(res, 200, loadEffectiveConfigSnapshot());
      return true;
    }

    // ── GET /api/portfolio ────────────────────────────────────────────────────
    // M29: read-only org-level portfolio projection. Reuses buildSnapshot (the
    // same enrollment/index-scoped read as /api/snapshot) and surfaces ONLY the
    // optional `.portfolio` section, or null when it was not populated (older
    // producer / empty enrollment). NO mutation endpoint — there is no apply/
    // approve/dispatch here; aggregation only. Never throws (caught below).
    if (path === '/api/portfolio' && method === 'GET') {
      const snapshot = await buildCachedSnapshot(cfg);
      sendJson(res, 200, snapshot.portfolio ?? null);
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

    // ── GET /api/models ──────────────────────────────────────────
    // M335: joined per-model economics — ROI (M322) + real-world outcomes
    // (M332) + best-of-N win rates (M333). Read-only. ?window=7d|30d|all
    // (default 30d).
    if (path === '/api/models' && method === 'GET') {
      const rawW = getQueryParam(req.url ?? '', 'window');
      const statsWindow = rawW === '7d' ? '7d' : rawW === 'all' ? 'all' : '30d';
      const { computeModelStatsDetailed } = await import('../fleet/model-stats.js');
      const stats = computeModelStatsDetailed(statsWindow);
      sendJson(res, 200, { window: statsWindow, ...stats });
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

    // ── GET /api/autonomy/evidence[/:id] ────────────────────────────────────
    // Read-only, metadata-only autonomy evidence. Evidence packs intentionally
    // do not contain raw diffs or command output; this endpoint mirrors that.
    if (path === '/api/autonomy/evidence' && method === 'GET') {
      const rawLimit = Number(getQueryParam(req.url ?? '', 'limit') ?? '20');
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 20;
      const { listAutonomyEvidencePacks } = await import('../autonomy/evidence-pack.js');
      const packs = listAutonomyEvidencePacks(limit);
      sendJson(res, 200, {
        total: packs.length,
        evidence: packs,
      });
      return true;
    }

    if (path.startsWith('/api/autonomy/evidence/') && method === 'GET') {
      const id = path.slice('/api/autonomy/evidence/'.length);
      if (!id || id.includes('/') || !/^[\w.-]+$/.test(id)) {
        sendJson(res, 400, { error: 'valid evidence proposal id required' });
        return true;
      }
      const { readAutonomyEvidencePack } = await import('../autonomy/evidence-pack.js');
      const pack = readAutonomyEvidencePack(id);
      if (!pack) {
        sendJson(res, 404, { error: `evidence pack not found: ${id}` });
        return true;
      }
      sendJson(res, 200, pack);
      return true;
    }

    // ── GET /api/inbox ───────────────────────────────────────────────────────
    // M23: read-only pending-proposals view. listProposals never throws.
    if (path === '/api/inbox' && method === 'GET') {
      const proposals = listProposals({ status: 'pending' });
      sendJson(res, 200, {
        pending: proposals.length,
        proposals,
      });
      return true;
    }

    // ── GET /api/inbox/:id — full proposal detail incl. diff (read-only; M32).
    if (path.startsWith('/api/inbox/') && method === 'GET') {
      const id = path.slice('/api/inbox/'.length);
      if (!id || id.includes('/')) {
        sendJson(res, 400, { error: 'proposal id required' });
        return true;
      }
      const proposal = loadProposal(id);
      if (!proposal) {
        sendJson(res, 404, { error: `proposal not found: ${id}` });
        return true;
      }
      sendJson(res, 200, proposal);
      return true;
    }

    // ── POST /api/inbox/:id/approve|reject (M32) ─────────────────────────
    // The web approval surface. Gated IDENTICALLY to POST /api/run — the
    // routes do not exist (404) unless `ashlr serve --allow-dispatch`, and
    // every request needs the constant-time-compared x-ashlr-token + JSON
    // Content-Type. Approve mirrors the CLI flow (src/cli/inbox.ts):
    // setStatus('approved') → applyProposal(id, {confirmed:true}); apply
    // failure is reported in the ApplyResult (apply.ts owns failed-state).
    if (path.startsWith('/api/inbox/') && method === 'POST') {
      if (!ctx.allowDispatch) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      const sub = path.slice('/api/inbox/'.length); // "<id>/approve" | "<id>/reject"
      const parts = sub.split('/');
      const id = parts[0] ?? '';
      const action = parts[1] ?? '';
      if (!id || (action !== 'approve' && action !== 'reject') || parts.length > 2) {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }

      // Same token + Content-Type gate as handleDispatch.
      if (!passesMutationGate(req, res, ctx.token)) {
        return true;
      }

      const proposal = loadProposal(id);
      if (!proposal) {
        sendJson(res, 404, { error: `proposal not found: ${id}` });
        return true;
      }
      if (proposal.status !== 'pending') {
        sendJson(res, 409, { error: `proposal is ${proposal.status}, not pending` });
        return true;
      }

      if (action === 'reject') {
        if (!setStatus(id, 'rejected')) {
          sendJson(res, 503, { error: 'proposal rejection unavailable; queued recovery could not be revoked' });
          return true;
        }
        sendJson(res, 200, { ok: true, id, status: 'rejected' });
        return true;
      }

      // approve → apply (the ONLY outward path; applyProposal owns its gates:
      // enrollment, kill switch, confirm — all still enforced inside).
      setStatus(id, 'approved');
      const { applyProposal } = await import('../inbox/apply.js');
      const result = await applyProposal(id, { confirmed: true });
      sendJson(res, result.ok ? 200 : 500, result);
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

    // ── GET /api/daemon/service ────────────────────────────────────────────
    // Read-only OS service health: installed/running/platform/path. This does
    // not start, stop, install, or mutate anything.
    if (path === '/api/daemon/service' && method === 'GET') {
      const service = serviceStatus(daemonServiceInstallOptions(cfg));
      sendJson(res, 200, service);
      return true;
    }

    // ── POST /api/daemon/service/repair ────────────────────────────────────
    // Operator recovery: reinstall/reload the OS service using the same config-
    // derived service definition as `ashlr daemon install`, then return current
    // service health. Hidden unless --allow-dispatch and token-gated.
    if (path === '/api/daemon/service/repair' && method === 'POST') {
      if (!ctx.allowDispatch) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      if (!passesMutationGate(req, res, ctx.token)) {
        return true;
      }

      try {
        const opts = daemonServiceInstallOptions(cfg, { autostart: true });
        await installDaemonService(opts);
        const service = await ensureDaemonServiceRunning(opts);
        sendJson(res, 200, { ok: true, action: 'repair', service });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const service = serviceStatus(daemonServiceInstallOptions(cfg, { autostart: true }));
        sendJson(res, 500, { ok: false, action: 'repair', error: msg, service });
      }
      return true;
    }

    // ── POST /api/fleet/pause|resume ─────────────────────────────────────────
    // Local operator controls: hidden unless the server was explicitly started
    // with --allow-dispatch, then guarded by the same token + JSON gate as the
    // other mutation routes.
    if ((path === '/api/fleet/pause' || path === '/api/fleet/resume') && method === 'POST') {
      if (!ctx.allowDispatch) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      if (!passesMutationGate(req, res, ctx.token)) {
        return true;
      }

      const paused = path.endsWith('/pause');
      setKill(paused);
      let service: ReturnType<typeof serviceStatus> | undefined;
      if (!paused) {
        try {
          service = await ensureDaemonServiceRunning(daemonServiceInstallOptions(cfg, { autostart: true }));
        } catch {
          service = undefined;
        }
      }
      const fleet = await buildFleetStatus(cfg);
      sendJson(res, 200, {
        ok: true,
        action: paused ? 'pause' : 'resume',
        ...(service ? { service } : {}),
        fleet,
      });
      return true;
    }

    // ── GET /api/fleet ───────────────────────────────────────────────────────
    // M49: fleet snapshot (daemon + per-backend dispatches/quota + queue +
    // proposals + merges + paused state). buildFleetStatus never throws; same
    // no-auth read class as /api/daemon and /api/pulse.
    if (path === '/api/fleet' && method === 'GET') {
      const fleet = await buildFleetStatus(cfg);
      sendJson(res, 200, fleet);
      return true;
    }

    // ── GET /api/estimate ───────────────────────────────────────────────────
    // M32: read-only pre-flight cost estimate (pure local computation over
    // persisted history — no token needed; same class as /api/pulse).
    if (path === '/api/estimate' && method === 'GET') {
      const kind = getQueryParam(req.url ?? '', 'kind') ?? 'run';
      const goal = getQueryParam(req.url ?? '', 'goal') ?? '';
      const rawMax = getQueryParam(req.url ?? '', 'maxTokens');
      const maxTokens = rawMax !== undefined && /^\d+$/.test(rawMax) ? Number(rawMax) : undefined;
      if (!goal.trim()) {
        sendJson(res, 400, { error: 'goal query parameter required' });
        return true;
      }
      const { estimateRun, estimateSwarm } = await import('../observability/estimate.js');
      const est = kind === 'swarm'
        ? await estimateSwarm(goal, { maxTokens }, cfg)
        : await estimateRun(goal, { maxTokens }, cfg);
      sendJson(res, 200, est);
      return true;
    }

    // ── GET /api/orient ─────────────────────────────────────────────────────
    // M31: read-only composite session-start context (genome + health +
    // backlog + inbox + attention). Same no-auth read class as /api/snapshot.
    if (path === '/api/orient' && method === 'GET') {
      const { buildOrientation } = await import('../orient.js');
      const repo = getQueryParam(req.url ?? '', 'repo');
      const result = await buildOrientation(cfg, repo);
      sendJson(res, 200, result);
      return true;
    }

    // ── GET /api/health ─────────────────────────────────────────────────────
    // M31: read-only — the latest PERSISTED health report (never re-scans).
    if (path === '/api/health' && method === 'GET') {
      const { loadPreviousReport } = await import('../quality/store.js');
      const report = loadPreviousReport();
      sendJson(res, 200, report ?? null);
      return true;
    }

    // ── GET /api/backlog ────────────────────────────────────────────────────
    // M31: read-only — the persisted backlog (never triggers a scan).
    if (path === '/api/backlog' && method === 'GET') {
      const { loadBacklog } = await import('../portfolio/backlog.js');
      const backlog = loadBacklog();
      sendJson(res, 200, backlog ?? null);
      return true;
    }

    // ── GET /api/impact ─────────────────────────────────────────────────────
    // M31: read-only knowledge-graph impact for ?target=<file|symbol>.
    if (path === '/api/impact' && method === 'GET') {
      const target = getQueryParam(req.url ?? '', 'target');
      if (!target || !target.trim()) {
        sendJson(res, 400, { error: 'target query parameter required' });
        return true;
      }
      const { impact } = await import('../knowledge/graph.js');
      sendJson(res, 200, impact(target));
      return true;
    }

    // ── GET /api/events (SSE) ────────────────────────────────────────────────
    if (path === '/api/events' && method === 'GET') {
      handleSseEvents(req, res, cfg, ctx.allowDispatch);
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

    // ── GET /api/control ────────────────────────────────────────────────────
    // M61: unified Mission Control snapshot. No auth — same read class as
    // /api/fleet and /api/daemon. Never throws; each section degrades independently.
    if (path === '/api/control' && method === 'GET') {
      const snapshot = await buildControlSnapshot(cfg);
      sendJson(res, 200, snapshot);
      return true;
    }

    // ── GET /api/fleet-activity ──────────────────────────────────────────────
    // M90: Fleet Activity panel — per-repo digest, recent merges, engine
    // readiness (throttled 10s), subscription burn-down, cooldown count, recent
    // ticks. No auth — same read class as /api/control.
    if (path === '/api/fleet-activity' && method === 'GET') {
      const activity = await buildFleetActivity(cfg);
      sendJson(res, 200, activity);
      return true;
    }

    // ── GET /api/models ──────────────────────────────────────────────────────
    // M61: live local-model provider probe (Ollama/LM Studio). Returns the
    // `models` section of the control snapshot only.
    if (path === '/api/models' && method === 'GET') {
      const snapshot = await buildControlSnapshot(cfg);
      sendJson(res, 200, snapshot.models);
      return true;
    }

    // ── GET /api/logs ────────────────────────────────────────────────────────
    // M61: most-recent-first daemon tick/merge log. ?tail=N (default 50, cap 200).
    if (path === '/api/logs' && method === 'GET') {
      const rawTail = getQueryParam(req.url ?? '', 'tail');
      const tail = rawTail !== undefined && /^\d+$/.test(rawTail)
        ? Math.min(Number(rawTail), 200)
        : 50;
      const snapshot = await buildControlSnapshot(cfg);
      sendJson(res, 200, snapshot.logs.slice(0, tail));
      return true;
    }

    // ── POST /api/open ────────────────────────────────────────────────────────
    // M100: open a repo or file on the local desktop (editor / Finder).
    //
    // Security model:
    //  - Route does not exist (404) unless allowDispatch is true.
    //  - Requires x-ashlr-token + Content-Type: application/json (same gate as
    //    approve/reject inbox routes).
    //  - Body: { repo: string, file?: string, action: 'editor' | 'finder' }
    //  - `repo` MUST exactly match one of listEnrolled() (absolute, resolved).
    //    Unknown or non-enrolled paths → 403 (not arbitrary open).
    //  - If `file` is provided, resolve(repo, file) must be WITHIN the repo
    //    (path-traversal check). Opens the file; otherwise opens the repo dir.
    //  - Only 'editor' and 'finder' actions are accepted — no shell exec.
    //  - Never opens paths from untrusted input outside enrolled repos.
    if (path === '/api/open' && method === 'POST') {
      if (!ctx.allowDispatch) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }

      if (!passesMutationGate(req, res, ctx.token)) {
        return true;
      }

      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return true;
      }

      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        sendJson(res, 400, { error: 'body must be a JSON object' });
        return true;
      }

      const obj = body as Record<string, unknown>;
      const rawRepo = typeof obj['repo'] === 'string' ? obj['repo'].trim() : '';
      const rawFile = typeof obj['file'] === 'string' ? obj['file'].trim() : '';
      const action = typeof obj['action'] === 'string' ? obj['action'] : 'editor';

      if (!rawRepo) {
        sendJson(res, 400, { error: '"repo" (string) is required' });
        return true;
      }

      if (action !== 'editor' && action !== 'finder') {
        sendJson(res, 400, { error: '"action" must be "editor" or "finder"' });
        return true;
      }

      // Resolve the requested repo path and verify it is enrolled.
      const resolvedRepo = resolvePath(rawRepo);
      const enrolled = listEnrolled();
      const repoCanon = canonForCompare(resolvedRepo);
      if (!enrolled.some((e) => canonForCompare(e) === repoCanon)) {
        sendJson(res, 403, { error: 'path not in an enrolled repo' });
        return true;
      }

      // If a file path was provided, ensure it resolves WITHIN the repo root.
      let targetPath = resolvedRepo;
      if (rawFile) {
        const resolvedFile = resolvePath(resolvedRepo, rawFile);
        // Path-traversal guard: the resolved file must be under the repo root.
        // M341c: native separator (a hardcoded '/' rejected every win32 file)
        // + canonical comparison for 8.3/case variance.
        const fileCanon = canonForCompare(resolvedFile);
        const repoWithSep = repoCanon.endsWith(pathSep) ? repoCanon : repoCanon + pathSep;
        if (fileCanon !== repoCanon && !fileCanon.startsWith(repoWithSep)) {
          sendJson(res, 403, { error: 'file path escapes the repo root' });
          return true;
        }
        targetPath = resolvedFile;
      }

      try {
        if (action === 'finder') {
          openInFinder(targetPath);
        } else {
          openInEditor(targetPath, cfg);
        }
        sendJson(res, 200, { ok: true, action, path: targetPath });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send500(res, `open failed: ${msg}`);
      }
      return true;
    }

    // ── GET /api/goals ────────────────────────────────────────────────────────
    // M104: read-only goal list with progress roll-up. listGoals + progressOf
    // are both read-only and never throw — wrapped defensively anyway so a
    // corrupt goal file cannot bring down the whole endpoint.
    if (path === '/api/goals' && method === 'GET') {
      try {
        const goals = listGoals();
        const result = goals.map((g) => {
          try {
            const progress = progressOf(g);
            return {
              id: g.id,
              objective: g.objective,
              status: g.status,
              milestones: g.milestones.map((m) => ({ title: m.title, status: m.status, order: m.order })),
              progress: {
                fractionDone: progress.fractionDone,
                counts: progress.byStatus,
                nextActionableId: progress.nextActionableId,
              },
            };
          } catch {
            return {
              id: g.id,
              objective: g.objective,
              status: g.status,
              milestones: [],
              progress: { fractionDone: 0, counts: {}, nextActionableId: null },
            };
          }
        });
        sendJson(res, 200, result);
      } catch {
        sendJson(res, 200, []);
      }
      return true;
    }

    // ── GET /api/usage ───────────────────────────────────────────────────────
    // M194: per-engine frontier usage (calls/tokens/cost/window-state).
    // Read-only; same no-auth class as /api/daemon and /api/fleet.
    // Never throws; degrades to empty engines array on any source failure.
    if (path === '/api/usage' && method === 'GET') {
      const { getFrontierUsage } = await import('../usage/frontier-usage.js') as {
        getFrontierUsage: (cfg: AshlrConfig) => Promise<unknown>;
      };
      const usage = await getFrontierUsage(cfg);
      sendJson(res, 200, usage);
      return true;
    }

    // ── GET /api/fleet-state ────────────────────────────────────────────────
    // M129: agent-readable combined fleet surface — daemon status + quality
    // scorecard + full oversight snapshot + recent routing decisions.
    // Read-only; same no-auth class as /api/daemon and /api/fleet.
    // Never throws; each section degrades independently.
    if (path === '/api/fleet-state' && method === 'GET') {
      const { loadDaemonState } = await import('../daemon/state.js');
      const { buildFleetDigest } = await import('../fleet/digest.js');
      const { computeQualityMetrics } = await import('../fleet/quality-metrics.js');
      const { buildOversightSnapshot } = await import('../fleet/oversight-export.js');

      // daemon + digest (parallel)
      let daemonSection: unknown = null;
      try {
        const ds = loadDaemonState();
        const digest = await buildFleetDigest('7d');
        daemonSection = {
          running: ds.running,
          pid: ds.pid,
          startedAt: ds.startedAt,
          lastTickAt: ds.lastTickAt,
          todaySpentUsd: ds.todaySpentUsd,
          itemsProcessed: ds.itemsProcessed,
          recentTicks: Array.isArray(ds.ticks) ? ds.ticks.slice(-20) : [],
          pendingProposals: digest.totalPending,
          digest: {
            totalProposed: digest.totalProposed,
            totalAutoMerged: digest.totalAutoMerged,
            totalDeclined: digest.totalDeclined,
            repos: digest.repos.slice(0, 10),
          },
        };
      } catch { /* degrade gracefully */ }

      let scorecardSection: unknown = null;
      try {
        scorecardSection = computeQualityMetrics('7d');
      } catch { /* degrade gracefully */ }

      let oversightSection: unknown = null;
      try {
        oversightSection = buildOversightSnapshot(cfg as { pulse?: { enabled?: boolean; endpoint?: string } });
      } catch { /* degrade gracefully */ }

      let routingSection: { recent: unknown[]; modelSplit: Record<string, number> } = { recent: [], modelSplit: {} };
      try {
        const { deriveRoutingData } = await import('../mcp-native.js');
        routingSection = deriveRoutingData(50);
      } catch { /* degrade gracefully */ }

      let workspaceSection: unknown = null;
      try {
        const { readAgentWorkspace } = await import('../fleet/agent-action-ledger.js');
        workspaceSection = readAgentWorkspace({ limit: 500, recentLimit: 20 });
      } catch { /* degrade gracefully */ }

      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        daemon: daemonSection,
        scorecard: scorecardSection,
        oversight: oversightSection,
        routing: routingSection,
        workspace: workspaceSection,
      });
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

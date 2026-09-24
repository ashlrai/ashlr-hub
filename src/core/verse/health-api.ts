/**
 * core/verse/health-api.ts — `/api/verse/health*` (V3.10, unit A2), mounted
 * by verse-api.ts (unit A10) through the api-modules.ts contract.
 *
 *   GET  /api/verse/health            → VerseHealthResponse
 *   POST /api/verse/health/refresh    → VerseHealthResponse (runs a sweep now)
 *   POST /api/verse/health/reconnect  { seatId } → 202 { ok, seatId }
 *
 * The module also OWNS the health service: the background sweep
 * (account-health.ts) plus a cached seat discovery. `startVerseHealth(cfg)`
 * should be called once at server start (the sweep must run while nobody is
 * looking — that is its reason to exist); every request here also ensures it
 * is running, so a server that forgot still starts it on first contact.
 *
 * ZERO SPEND: nothing here starts a model call. `refresh` runs status
 * commands; `reconnect` opens the seat's OWN login in Terminal and returns —
 * Verse never types, reads or stores a credential. That step is operator-run
 * by design (research r2/accounts.md, "must stay operator-run").
 *
 * PERFORMANCE: GET never spawns and never awaits a probe. It fuses the cached
 * sweep with live collector telemetry (sync file reads) and, when Ollama's
 * last check is older than 30 s, re-checks it in the BACKGROUND for the next
 * read. Only the very first GET of a process awaits seat discovery.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AshlrConfig } from '../types.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import {
  buildSeatHealthReports,
  createSeatHealthSweep,
  getVerseHealthService,
  openSeatLogin,
  readNativeAccounts,
  setVerseHealthService,
  type ReconnectOpener,
  type SeatHealthProbes,
  type SeatHealthSweep,
  type VerseHealthCurrent,
  type VerseHealthService,
} from './account-health.js';
import { VERSE_HEALTH_PATH, type VerseHealthResponse } from './health-types.js';
import {
  discoverSeats,
  refreshSeatTelemetry,
  resolveAccountsRoot,
  resolveOllamaBaseUrl,
  type VerseSeatDiscovery,
} from './seats.js';

export const VERSE_HEALTH_REFRESH_PATH = `${VERSE_HEALTH_PATH}/refresh`;
export const VERSE_HEALTH_RECONNECT_PATH = `${VERSE_HEALTH_PATH}/reconnect`;

/** Seat identity (accounts, Ollama tags) is re-discovered at most this often. */
const DISCOVERY_MAX_AGE_MS = 60_000;
/** Ollama is re-checked on read at most this often. */
const OLLAMA_RECHECK_MS = 30_000;
/** One Terminal window per seat per this long, however often the button is pressed. */
export const RECONNECT_COOLDOWN_MS = 10_000;
/** A refresh this soon after a completed sweep returns the fresh result instead. */
const REFRESH_MIN_GAP_MS = 10_000;
/** After Reconnect, look again once the operator has had time to sign in. */
const POST_RECONNECT_SWEEP_MS = 90_000;

export interface VerseHealthStartOptions {
  accountsRoot?: string;
  ollamaBaseUrl?: string;
  probes?: SeatHealthProbes;
  intervalMs?: number;
  initialDelayMs?: number;
  /** Seat discovery override (tests). Defaults to `discoverSeats(cfg)`. */
  discover?: () => Promise<VerseSeatDiscovery>;
  /** Terminal opener override (tests). */
  openLogin?: ReconnectOpener;
  platform?: NodeJS.Platform;
  /** Where reconnect scripts go (tests). */
  reconnectDir?: string;
  claudeVersionsRoot?: string;
  grokDownloadsRoot?: string;
  codexCandidates?: () => string[];
  log?: (message: string) => void;
}

interface HealthRuntime {
  cfg: AshlrConfig;
  accountsRoot: string;
  options: VerseHealthStartOptions;
  sweep: SeatHealthSweep;
  service: VerseHealthService;
  discovery: VerseSeatDiscovery | null;
  discoveredAt: number;
  discovering: Promise<VerseSeatDiscovery | null> | null;
  lastReconnect: Map<string, number>;
  followUp: ReturnType<typeof setTimeout> | null;
}

let runtime: HealthRuntime | null = null;

function refreshDiscovery(rt: HealthRuntime): Promise<VerseSeatDiscovery | null> {
  if (rt.discovering) return rt.discovering;
  const discover = rt.options.discover
    ?? (() => discoverSeats(rt.cfg, { accountsRoot: rt.accountsRoot }));
  rt.discovering = discover()
    .then((value) => {
      rt.discovery = value;
      rt.discoveredAt = Date.now();
      return value;
    })
    .catch(() => rt.discovery)
    .finally(() => { rt.discovering = null; });
  return rt.discovering;
}

function currentOf(rt: HealthRuntime): VerseHealthCurrent {
  const now = Date.now();
  const seats = rt.discovery === null
    ? []
    // Live telemetry on every read: identity is cached, capacity is not.
    : refreshSeatTelemetry(rt.cfg, rt.discovery, { accountsRoot: rt.accountsRoot }).seats;
  const reports = buildSeatHealthReports({ seats, snapshot: rt.sweep.snapshot(), now });
  return { seats, reports, checkedAt: new Date(now).toISOString() };
}

/**
 * Start (once per process) the background sweep and register the service the
 * engine's readiness gate reads. Idempotent: later calls return the running
 * service, whatever config they pass.
 */
export function startVerseHealth(cfg: AshlrConfig, options: VerseHealthStartOptions = {}): VerseHealthService {
  if (runtime !== null) return runtime.service;
  const accountsRoot = resolveAccountsRoot(cfg, options.accountsRoot);
  // The sweep's observer needs the runtime, and the runtime holds the sweep.
  let created: HealthRuntime | null = null;
  const sweep = createSeatHealthSweep({
    accountsRoot,
    ollamaBaseUrl: resolveOllamaBaseUrl(cfg, options.ollamaBaseUrl),
    ...(options.probes ? { probes: options.probes } : {}),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.initialDelayMs !== undefined ? { initialDelayMs: options.initialDelayMs } : {}),
    ...(options.claudeVersionsRoot ? { claudeVersionsRoot: options.claudeVersionsRoot } : {}),
    ...(options.grokDownloadsRoot ? { grokDownloadsRoot: options.grokDownloadsRoot } : {}),
    ...(options.codexCandidates ? { codexCandidates: options.codexCandidates } : {}),
    ...(options.log ? { log: options.log } : {}),
    // Accounts or Ollama tags may have changed since the last sweep.
    onSweep: () => { if (created !== null) void refreshDiscovery(created); },
  });
  const rt: HealthRuntime = {
    cfg,
    accountsRoot,
    options,
    sweep,
    service: {
      sweep,
      current: () => currentOf(rt),
      close: () => {
        sweep.stop();
        if (rt.followUp !== null) { clearTimeout(rt.followUp); rt.followUp = null; }
      },
    },
    discovery: null,
    discoveredAt: 0,
    discovering: null,
    lastReconnect: new Map<string, number>(),
    followUp: null,
  };
  created = rt;
  runtime = rt;
  setVerseHealthService(rt.service);
  rt.sweep.start();
  void refreshDiscovery(rt);
  return rt.service;
}

/** Stop the sweep and forget the service (server shutdown, tests). */
export function stopVerseHealth(): void {
  if (runtime === null) return;
  runtime.service.close();
  if (getVerseHealthService() === runtime.service) setVerseHealthService(null);
  runtime = null;
}

async function healthBody(rt: HealthRuntime): Promise<VerseHealthResponse> {
  if (rt.discovery === null) await refreshDiscovery(rt);
  else if (Date.now() - rt.discoveredAt > DISCOVERY_MAX_AGE_MS) void refreshDiscovery(rt);
  const ollama = rt.sweep.snapshot().ollama;
  const checked = ollama.checkedAt === null ? Number.NaN : Date.parse(ollama.checkedAt);
  if (!(Date.now() - checked < OLLAMA_RECHECK_MS)) void rt.sweep.checkOllama();
  const current = currentOf(rt);
  return { checkedAt: current.checkedAt, seats: current.reports };
}

async function readStrictBody(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly string[],
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid JSON body' });
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'body must be a JSON object' });
    return null;
  }
  const unknown = Object.keys(parsed).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown field: ${unknown[0]!.slice(0, 64)}` });
    return null;
  }
  return parsed as Record<string, unknown>;
}

async function handleReconnect(rt: HealthRuntime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readStrictBody(req, res, ['seatId']);
  if (!body) return;
  const seatId = body['seatId'];
  if (typeof seatId !== 'string' || seatId.length === 0 || seatId.length > 128) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'seatId must be a non-empty string' });
    return;
  }
  const account = readNativeAccounts(rt.accountsRoot).find((row) => row.id === seatId);
  if (!account) {
    // Local seats have nothing to sign in to; unknown ids are simply absent.
    sendJson(res, 404, { code: 'VERSE_SEAT_NOT_FOUND', error: 'no account seat with that id' });
    return;
  }
  const last = rt.lastReconnect.get(seatId) ?? 0;
  if (Date.now() - last < RECONNECT_COOLDOWN_MS) {
    sendJson(res, 429, { code: 'VERSE_RECONNECT_COOLDOWN', error: 'a sign-in window for this seat was just opened' });
    return;
  }
  rt.lastReconnect.set(seatId, Date.now());
  try {
    await openSeatLogin({
      account,
      ...(rt.options.reconnectDir ? { dir: rt.options.reconnectDir } : {}),
      ...(rt.options.openLogin ? { open: rt.options.openLogin } : {}),
      ...(rt.options.platform ? { platform: rt.options.platform } : {}),
    });
  } catch (error) {
    const unsupported = (rt.options.platform ?? process.platform) !== 'darwin';
    sendJson(res, unsupported ? 501 : 502, {
      code: 'VERSE_RECONNECT_FAILED',
      // openSeatLogin's messages are fixed, path-free sentences.
      error: error instanceof Error ? error.message : 'the sign-in window could not be opened',
    });
    return;
  }
  // Look again once the operator has had time to finish the provider's flow.
  if (rt.followUp !== null) clearTimeout(rt.followUp);
  rt.followUp = setTimeout(() => { rt.followUp = null; void rt.sweep.sweep(); }, POST_RECONNECT_SWEEP_MS);
  rt.followUp.unref?.();
  sendJson(res, 202, { ok: true, seatId });
}

async function handleRefresh(rt: HealthRuntime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readStrictBody(req, res, []);
  if (!body) return;
  const swept = rt.sweep.snapshot().sweptAt;
  if (swept === null || Date.now() - Date.parse(swept) >= REFRESH_MIN_GAP_MS) {
    await rt.sweep.sweep();
    await refreshDiscovery(rt);
  }
  sendJson(res, 200, await healthBody(rt));
}

/**
 * The route module. True for `/api/verse/health*` (including its error
 * responses), false for everything else so the next module runs.
 */
export const handleHealthApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path !== VERSE_HEALTH_PATH && !path.startsWith(`${VERSE_HEALTH_PATH}/`)) return false;
  startVerseHealth(ctx.cfg);
  const rt = runtime!;

  if (path === VERSE_HEALTH_PATH) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    sendJson(res, 200, await healthBody(rt));
    return true;
  }

  const isAction = path === VERSE_HEALTH_REFRESH_PATH || path === VERSE_HEALTH_RECONNECT_PATH;
  if (!isAction) {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
    return true;
  }
  // verse-api.ts gates every non-GET before any module runs; gating again is
  // idempotent and keeps this module safe if it is ever mounted elsewhere.
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  if (!passesMutationGate(req, res, ctx.token)) return true;

  if (path === VERSE_HEALTH_RECONNECT_PATH) await handleReconnect(rt, req, res);
  else await handleRefresh(rt, req, res);
  return true;
};

/**
 * `/api/verse/budget` — budget modes, per-seat reserves and live headroom
 * (V3.10 unit A9). An `ApiModule` (core/verse/api-modules.ts); unit A10 mounts
 * it in verse-api.ts.
 *
 *   GET  /api/verse/budget                → BudgetView (BudgetResponse + seat info)
 *   POST /api/verse/budget                → BudgetView, after ONE update:
 *                                            {mode} | {seatId, policy}
 *   GET  /api/verse/budget/preview        → SeatDecision for a hypothetical
 *        ?task=&difficulty=&autonomous=[&contextTokens=]
 *   GET  /api/verse/budget/decisions      → { decisions: ShadowDecisionRecord[] }
 *        [?limit=]
 *
 * NOTHING HERE SPENDS. Headroom is computed from the account collector's
 * existing readings (no probe is started), the preview runs the pure router,
 * and a policy change is a private file write. The preview is NOT logged as a
 * shadow decision: the log is for decisions the fleet would actually have
 * made, and an operator poking at the panel is not one.
 *
 * Security posture matches every Verse route: GETs sit behind the read-session
 * boundary in server.ts; the POST is 404 unless the server allows dispatch,
 * then the constant-time mutation token + JSON Content-Type gate, then the
 * shared 64 KB body cap. Every response goes through sendJson() →
 * sanitizePublicJson(). Unknown query parameters and body keys are 400s.
 *
 * A READ THAT FAILS SAYS SO. When the policy file, the decision log or the
 * seat capacity cannot be read, the route answers 503 `{ code, error }` —
 * `error` a plain sentence naming WHAT could not be read and why, never a
 * path, errno text or stack — rather than defaults or an empty list the
 * panel would render as the operator's real policy or "no decisions yet".
 * The web client lifts `error` into ApiError.detail for the panel to show.
 *
 * SIDE EFFECT BY DESIGN: every read that computes headroom also refreshes the
 * capacity snapshot (~/.ashlr/routing/capacity.json, throttled) that
 * `subscriptionAllows` reads in processes without a collector — so as long as
 * the Verse server runs `startBudgetCapacityPublisher`, the daemon sees Claude
 * readings no older than one publish interval.
 *
 * When NO Verse server runs, the standing daemon publishes instead
 * (daemon/capacity-publisher.ts → `publishCapacitySnapshotFrom`): it samples
 * through its own short-lived account collector under the exclusive native
 * metadata lease and writes only while no fresher snapshot from another
 * publisher exists, so there is one writer at a time (review finding c8).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiModule } from '../verse/api-modules.js';
import type { VerseApiContext } from '../verse/verse-api.js';
import type { AshlrConfig } from '../types.js';
import type { VerseSeat } from '../verse/types.js';
import type { VerseAccountCollector } from '../verse/accounts.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import {
  BudgetPolicyUnreadableError,
  loadBudgetPolicy,
  readBudgetPolicyFileState,
  readShadowDecisionsChecked,
  recordShadowDecision,
  updateBudgetPolicy,
  writeCapacitySnapshotAsync,
} from './budget-store.js';
import { assessSeat, capacityFromSeat, HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from './headroom.js';
import {
  BudgetPolicyError,
  defaultBudgetPolicy,
  effectiveSeatPolicy,
  parseBudgetUpdate,
  type BudgetEngine,
  type BudgetSeatInfo,
  type BudgetView,
} from './policy.js';
import { routeSeat } from './router.js';
import {
  VERSE_BUDGET_PATH,
  type BudgetPolicy,
  type RoutingDifficulty,
  type RoutingRequest,
  type RoutingTask,
  type SeatBudgetPolicy,
  type SeatDecision,
} from './types.js';

export const VERSE_BUDGET_PREVIEW_PATH = `${VERSE_BUDGET_PATH}/preview`;
export const VERSE_BUDGET_DECISIONS_PATH = `${VERSE_BUDGET_PATH}/decisions`;

/** Seat IDENTITY (which accounts and Ollama tags exist) changes rarely and costs HTTP round trips to learn. */
const SEAT_IDENTITY_TTL_MS = 60_000;
/** The capacity snapshot is rewritten at most this often by request traffic. */
const SNAPSHOT_MIN_INTERVAL_MS = 15_000;
/** Publisher cadence bounds: never faster than the collector itself polls. */
export const BUDGET_PUBLISH_DEFAULT_MS = 60_000;
const BUDGET_PUBLISH_MIN_MS = 30_000;

const ROUTING_TASKS: readonly RoutingTask[] = ['code', 'review', 'plan', 'bulk', 'leader'];
const ROUTING_DIFFICULTIES: readonly RoutingDifficulty[] = ['low', 'medium', 'high'];
const BUDGET_BODY_KEYS: ReadonlySet<string> = new Set(['mode', 'seatId', 'policy']);

// ---------------------------------------------------------------------------
// Capacity source (injectable for tests)
// ---------------------------------------------------------------------------

export interface CapacityReading {
  seats: SeatCapacity[];
  sampledAt: string;
}

/**
 * `collector` (daemon publisher only): read telemetry from THIS collector
 * rather than the process-global Verse registration — the daemon has no
 * Verse collector registered and must not register one (the registry is the
 * Verse server's).
 */
export type CapacitySource = (cfg: AshlrConfig, opts?: { collector?: VerseAccountCollector | null }) => Promise<CapacityReading>;

let identityCache: { cfg: AshlrConfig; expiresAt: number; seats: VerseSeat[] } | null = null;
let identityInFlight: Promise<VerseSeat[]> | null = null;

/**
 * The production capacity source: seat identity from `discoverSeats` (cached
 * 60 s — it walks Ollama), live telemetry from the account collector on EVERY
 * call (cheap: in-memory readings plus small file reads), exactly the split
 * verse-api's `liveSeats` uses.
 */
async function defaultCapacitySource(cfg: AshlrConfig, opts: { collector?: VerseAccountCollector | null } = {}): Promise<CapacityReading> {
  const seatsMod = await import('../verse/seats.js');
  const now = Date.now();
  let seats: VerseSeat[];
  if (identityCache && identityCache.cfg === cfg && now < identityCache.expiresAt) {
    seats = identityCache.seats;
  } else {
    if (!identityInFlight) {
      identityInFlight = seatsMod.discoverSeats(cfg, {
        // Budgeting reads windows only. The Claude token scan behind the seat
        // summary walks ~/.claude/projects and would add nothing here.
        claudeUsage: () => ({ tokens5h: 0, tokens7d: 0, messages5h: 0, messages7d: 0, readAt: Date.now(), filesScanned: 0 }),
      })
        .then((discovery) => {
          identityCache = { cfg, expiresAt: Date.now() + SEAT_IDENTITY_TTL_MS, seats: discovery.seats };
          return discovery.seats;
        })
        .finally(() => { identityInFlight = null; });
    }
    seats = await identityInFlight;
  }
  const telemetry = seatsMod.buildSeatTelemetry(
    seatsMod.resolveAccountsRoot(cfg),
    opts.collector !== undefined ? { collector: opts.collector } : {},
  );
  return {
    sampledAt: new Date().toISOString(),
    seats: seats.map((seat) => capacityFromSeat(
      seat,
      seat.engine === 'local' ? undefined : telemetry.get(seat.accountId)?.capacity ?? null,
    )),
  };
}

let capacitySource: CapacitySource = defaultCapacitySource;
let lastSnapshotAt = 0;

/** Test hook: replace (or with no argument, restore) the capacity source; also resets caches. */
export function setBudgetCapacitySourceForTest(source?: CapacitySource): void {
  capacitySource = source ?? defaultCapacitySource;
  identityCache = null;
  identityInFlight = null;
  lastSnapshotAt = 0;
}

// ---------------------------------------------------------------------------
// Read failures the panel is told about
// ---------------------------------------------------------------------------

/**
 * A source the route needed could not be read. `message` is the operator-
 * facing sentence and is sent as-is, so it must never carry a path or the
 * underlying error's text (which can). 503: the request was fine, the store
 * or collector behind it is what is unusable right now.
 */
export class BudgetReadError extends Error {
  readonly status = 503 as const;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BudgetReadError';
  }
}

/**
 * The policy as the PANEL must see it. `loadBudgetPolicy` is total (defaults
 * for any bad file), which is right for the daemon but made the panel show
 * "Balanced, every seat default" while the operator's real policy sat in a
 * file nobody could read — and the next click was then refused (review d7)
 * with no visible reason. Only a MISSING file is the defaults here.
 */
function loadPolicyForPanel(): BudgetPolicy {
  const found = readBudgetPolicyFileState();
  if (found.state === 'ok') return found.policy;
  if (found.state === 'missing') return defaultBudgetPolicy();
  throw new BudgetReadError(
    'VERSE_STORE_UNREADABLE',
    `The budget policy file ${found.reason}. Fix or remove it to use the defaults.`,
  );
}

/** Read capacity and (throttled) persist it for collector-less readers. Never throws on the write. */
async function readCapacity(cfg: AshlrConfig, force = false): Promise<CapacityReading> {
  let reading: CapacityReading;
  try {
    reading = await capacitySource(cfg);
  } catch {
    // The cause (a collector or Ollama error) can name paths and hosts; the
    // panel only needs to know WHICH read failed.
    throw new BudgetReadError('VERSE_BUDGET_CAPACITY_UNREADABLE', 'Seat capacity could not be read.');
  }
  const now = Date.now();
  if (force || now - lastSnapshotAt >= SNAPSHOT_MIN_INTERVAL_MS) {
    lastSnapshotAt = now;
    try {
      await writeCapacitySnapshotAsync(reading.seats, new Date(now));
    } catch {
      // A storage failure must not break the panel; readers of a missing or
      // stale snapshot fail CLOSED, which is the safe direction.
    }
  }
  return reading;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function buildBudgetView(policy: BudgetPolicy, reading: CapacityReading, nowMs: number): BudgetView {
  const seatInfo: BudgetSeatInfo[] = reading.seats.map((seat) => ({
    seatId: seat.seatId,
    label: seat.label,
    engine: seat.engine,
    free: seat.free,
  }));
  const effective: Record<string, SeatBudgetPolicy> = {};
  const headroom = reading.seats.map((seat) => {
    const seatPolicy = effectiveSeatPolicy(policy, seat.seatId, seat.engine);
    effective[seat.seatId] = seatPolicy;
    return assessSeat(seat, seatPolicy, { nowMs }).headroom;
  });
  return {
    mode: policy.mode,
    seats: policy.seats,
    updatedAt: policy.updatedAt,
    headroom,
    seatInfo,
    effective,
    readingMaxAgeMs: HEADROOM_READING_MAX_AGE_MS,
    sampledAt: reading.sampledAt,
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function readQuery(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): URLSearchParams | null {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return null;
  }
  for (const key of new Set(params.keys())) {
    if (!allowed.includes(key)) {
      sendInvalid(res, `unknown query parameter: ${key}`);
      return null;
    }
    if (params.getAll(key).length > 1) {
      sendInvalid(res, `query parameter ${key} may appear only once`);
      return null;
    }
  }
  return params;
}

async function readMutationBody(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
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
    sendInvalid(res, 'invalid JSON body');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parsePreview(params: URLSearchParams): RoutingRequest | string {
  const task = params.get('task') ?? 'code';
  const difficulty = params.get('difficulty') ?? 'medium';
  const autonomous = params.get('autonomous') ?? 'true';
  if (!(ROUTING_TASKS as readonly string[]).includes(task)) return `task must be one of: ${ROUTING_TASKS.join(', ')}`;
  if (!(ROUTING_DIFFICULTIES as readonly string[]).includes(difficulty)) {
    return `difficulty must be one of: ${ROUTING_DIFFICULTIES.join(', ')}`;
  }
  if (autonomous !== 'true' && autonomous !== 'false') return 'autonomous must be true or false';
  const out: RoutingRequest = {
    task: task as RoutingTask,
    difficulty: difficulty as RoutingDifficulty,
    autonomous: autonomous === 'true',
  };
  const context = params.get('contextTokens');
  if (context !== null) {
    if (!/^\d{1,9}$/.test(context)) return 'contextTokens must be a whole number of tokens';
    out.contextTokens = Number(context);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * The budget route family. Returns false for any path outside it so the next
 * module (or handleApi's own 404) runs.
 */
export const handleBudgetApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path !== VERSE_BUDGET_PATH && path !== VERSE_BUDGET_PREVIEW_PATH && path !== VERSE_BUDGET_DECISIONS_PATH) {
    return false;
  }
  try {
    if (path === VERSE_BUDGET_PATH) {
      if (method === 'GET') {
        if (!readQuery(req, res, [])) return true;
        const policy = loadPolicyForPanel();
        const reading = await readCapacity(ctx.cfg);
        sendJson(res, 200, buildBudgetView(policy, reading, Date.now()));
        return true;
      }
      if (method === 'POST') {
        const body = await readMutationBody(ctx, req, res);
        if (!body) return true;
        for (const key of Object.keys(body)) {
          if (!BUDGET_BODY_KEYS.has(key)) {
            sendInvalid(res, `unknown key: ${key}`);
            return true;
          }
        }
        // Validate BEFORE any read: a malformed body touches nothing.
        const parsed = parseBudgetUpdate(body);
        const reading = await readCapacity(ctx.cfg, true);
        const engines = new Map<string, BudgetEngine>(reading.seats.map((s) => [s.seatId, s.engine]));
        // A seat that is not discovered right now (a local tag while Ollama is
        // down) may still be configured; its engine is then inferred from the id.
        const policy = updateBudgetPolicy(parsed, { engineOf: (seatId) => engines.get(seatId) });
        sendJson(res, 200, buildBudgetView(policy, reading, Date.now()));
        return true;
      }
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    if (method !== 'GET') {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }

    if (path === VERSE_BUDGET_PREVIEW_PATH) {
      const params = readQuery(req, res, ['task', 'difficulty', 'autonomous', 'contextTokens']);
      if (!params) return true;
      const request = parsePreview(params);
      if (typeof request === 'string') {
        sendInvalid(res, request);
        return true;
      }
      const policy = loadPolicyForPanel();
      const reading = await readCapacity(ctx.cfg);
      sendJson(res, 200, routeSeat(request, reading.seats, policy, { nowMs: Date.now() }));
      return true;
    }

    // VERSE_BUDGET_DECISIONS_PATH
    const params = readQuery(req, res, ['limit']);
    if (!params) return true;
    const limitRaw = params.get('limit');
    if (limitRaw !== null && !/^\d{1,3}$/.test(limitRaw)) {
      sendInvalid(res, 'limit must be a whole number from 1 to 500');
      return true;
    }
    const limit = limitRaw === null ? 50 : Math.max(1, Math.min(500, Number(limitRaw)));
    const log = readShadowDecisionsChecked(limit);
    if (log.state === 'unreadable') {
      throw new BudgetReadError('VERSE_BUDGET_DECISIONS_UNREADABLE', `The routing decision log ${log.reason}.`);
    }
    sendJson(res, 200, { decisions: log.decisions });
    return true;
  } catch (err) {
    if (err instanceof BudgetPolicyError || err instanceof BudgetReadError) {
      sendJson(res, err.status, { code: err.code, error: err.message });
      return true;
    }
    if (err instanceof BudgetPolicyUnreadableError) {
      // Its own message names the absolute file and the archive copy; the
      // panel gets the same fact without either.
      sendJson(res, err.status, {
        code: err.code,
        error: `The budget policy file ${err.reason}. Nothing was saved. Fix or remove it to use the defaults.`,
      });
      return true;
    }
    sendJson(res, 500, { code: 'VERSE_BUDGET_FAILED', error: 'Budget request failed.' });
    return true;
  }
};

// ---------------------------------------------------------------------------
// Background publisher + shadow helper
// ---------------------------------------------------------------------------

/**
 * Keep the capacity snapshot fresh while the Verse server runs, so the fleet
 * daemon (a separate process with no collector) can see Claude's windows.
 * One unref'd timer; never faster than 30 s. Returns a stop function.
 *
 * Unit A10 starts this once at server boot (CROSS-UNIT REQUEST).
 */
export function startBudgetCapacityPublisher(cfg: AshlrConfig, opts: { intervalMs?: number } = {}): () => void {
  const interval = Math.max(BUDGET_PUBLISH_MIN_MS, opts.intervalMs ?? BUDGET_PUBLISH_DEFAULT_MS);
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void readCapacity(cfg, true)
      .catch(() => { /* the next tick retries; readers fail closed meanwhile */ })
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, interval);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}

/**
 * Daemon-side publish (review finding c8): read capacity through `collector`
 * — a collector the caller started and OWNS (it holds the native metadata
 * lease) — and write the snapshot. Returns the snapshot's `publishedAt`, which
 * the caller remembers so it can tell its own write from another publisher's.
 * Throws on a failed read or write: the caller then stays cold, and readers
 * of a stale snapshot fail CLOSED.
 */
export async function publishCapacitySnapshotFrom(cfg: AshlrConfig, collector: VerseAccountCollector): Promise<string> {
  const reading = await capacitySource(cfg, { collector });
  const snapshot = await writeCapacitySnapshotAsync(reading.seats, new Date());
  lastSnapshotAt = Date.now();
  return snapshot.publishedAt;
}

/**
 * Route `request` against the live capacity and log it as a SHADOW decision
 * (Track B's fleet calls this next to its real dispatch). Returns the
 * decision; never throws and never blocks the caller on the log write.
 */
export async function routeSeatShadow(
  cfg: AshlrConfig,
  request: RoutingRequest,
  source: Parameters<typeof recordShadowDecision>[0]['source'],
  actual?: { engine: string; seatId: string | null } | null,
): Promise<SeatDecision | null> {
  try {
    const reading = await readCapacity(cfg);
    const decision = routeSeat(request, reading.seats, loadBudgetPolicy(), { nowMs: Date.now() });
    recordShadowDecision({ source, request, decision, actual: actual ?? null });
    return decision;
  } catch {
    return null;
  }
}

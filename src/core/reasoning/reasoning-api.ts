/**
 * Reasoning API module (V3.10, unit A7) — mounted by verse-api.ts (unit A10)
 * under the api-modules.ts contract.
 *
 *   GET /api/reasoning/digest[?days=1..180]           → ReasoningDigest
 *   GET /api/reasoning/steps?q=&sessionId=&limit=     → ReasoningStepsResponse
 *
 * Read-only for callers. Responses go through sendJson() → sanitizePublicJson
 * (secrets + home paths scrubbed again on the way out). The store is local
 * and never feeds a prompt; this API is its only reader outside the process.
 *
 * MAINTENANCE (ingest fleet logs / codex rollouts / Verse backfill, then
 * retention) runs single-flight in the background: kicked by the first
 * request and whenever the last run is older than MAINTENANCE_INTERVAL_MS,
 * or on a timer via `scheduleReasoningMaintenance()` (A10 may call it at
 * server start). A request waits for the FIRST run at most
 * FIRST_RUN_WAIT_MS so a cold server answers with data rather than zeros,
 * and never waits after that.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import type { VerseApiContext } from '../verse/verse-api.js';
import type { ApiModule } from '../verse/api-modules.js';
import { DigestBuilder } from './insights.js';
import { codexInteractiveOptIn, ingestCodexRollouts } from './ingest-codex.js';
import { ingestFleetAgentLogs } from './ingest-fleet.js';
import { ingestVerseSessionLogs } from './ingest-verse.js';
import { applyReasoningRetention } from './retention.js';
import { DAY_MS, reasoningRoot, scanFeatures, scanSteps, storeGeneration } from './store.js';
import {
  REASONING_API_PREFIX,
  REASONING_DIGEST_PATH,
  REASONING_FEATURE_RETENTION_DAYS,
  REASONING_STEPS_DEFAULT_LIMIT,
  REASONING_STEPS_MAX_LIMIT,
  REASONING_STEPS_PATH,
  type ReasoningDigest,
  type ReasoningOutcome,
  type ReasoningStepV1,
  type ReasoningStepsResponse,
} from './types.js';

export const DEFAULT_DIGEST_DAYS = 14;
export const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1_000;
const FIRST_RUN_WAIT_MS = 2_000;
const DIGEST_CACHE_TTL_MS = 60_000;
const DIGEST_MIN_FRESH_MS = 10_000;
const MAX_QUERY_CHARS = 200;
const MAX_SESSION_ID_CHARS = 256;

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export interface MaintenanceSummary {
  at: string;
  verse: Awaited<ReturnType<typeof ingestVerseSessionLogs>> | null;
  fleet: Awaited<ReturnType<typeof ingestFleetAgentLogs>> | null;
  codex: Awaited<ReturnType<typeof ingestCodexRollouts>> | null;
  retention: Awaited<ReturnType<typeof applyReasoningRetention>> | null;
}

let maintenance: Promise<MaintenanceSummary> | null = null;
let lastMaintenanceMs = 0;
let firstRunDone = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Run every ingest + retention once (single-flight: concurrent callers share
 * the in-flight run). Each stage is isolated: one failing never skips the rest.
 */
export function runReasoningMaintenance(cfg?: unknown): Promise<MaintenanceSummary> {
  if (maintenance) return maintenance;
  const root = reasoningRoot();
  maintenance = (async (): Promise<MaintenanceSummary> => {
    const summary: MaintenanceSummary = { at: new Date().toISOString(), verse: null, fleet: null, codex: null, retention: null };
    summary.verse = await ingestVerseSessionLogs({ root }).catch(() => null);
    summary.fleet = await ingestFleetAgentLogs({ root }).catch(() => null);
    summary.codex = await ingestCodexRollouts({ root, includeInteractive: codexInteractiveOptIn(cfg) }).catch(() => null);
    summary.retention = await applyReasoningRetention({ root }).catch(() => null);
    return summary;
  })().finally(() => {
    lastMaintenanceMs = Date.now();
    firstRunDone = true;
    maintenance = null;
  });
  return maintenance;
}

function kickMaintenance(cfg: unknown): Promise<MaintenanceSummary> | null {
  if (maintenance) return maintenance;
  if (Date.now() - lastMaintenanceMs < MAINTENANCE_INTERVAL_MS) return null;
  return runReasoningMaintenance(cfg);
}

/**
 * Start the background maintenance timer (idempotent, unref'd so it never
 * holds the process open). Runs once immediately.
 */
export function scheduleReasoningMaintenance(cfg?: unknown): void {
  if (timer) return;
  void kickMaintenance(cfg);
  timer = setInterval(() => { void kickMaintenance(cfg); }, MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
}

/** Stop the timer and reset module state (tests / shutdown). */
export function resetReasoningApiState(): void {
  if (timer) clearInterval(timer);
  timer = null;
  maintenance = null;
  lastMaintenanceMs = 0;
  firstRunDone = false;
  digestCache.clear();
}

async function awaitFirstRun(cfg: unknown): Promise<void> {
  const running = kickMaintenance(cfg);
  if (firstRunDone || !running) return;
  await Promise.race([
    running.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, FIRST_RUN_WAIT_MS).unref?.()),
  ]);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const digestCache = new Map<string, { generation: number; atMs: number; digest: ReasoningDigest }>();

/** Build the digest for the last `days` days (cached per generation for DIGEST_CACHE_TTL_MS). */
export async function computeReasoningDigest(
  days = DEFAULT_DIGEST_DAYS,
  options: { root?: string; nowMs?: number } = {},
): Promise<ReasoningDigest> {
  const nowMs = options.nowMs ?? Date.now();
  const key = `${options.root ?? reasoningRoot()}|${days}`;
  const cached = digestCache.get(key);
  // Fresh for DIGEST_MIN_FRESH_MS no matter what (a live chat bumps the store
  // generation every flush; recomputing a 0.5 s digest per poll is waste),
  // then valid until the store changes or DIGEST_CACHE_TTL_MS passes.
  if (options.nowMs === undefined && cached && (
    nowMs - cached.atMs < DIGEST_MIN_FRESH_MS ||
    (cached.generation === storeGeneration() && nowMs - cached.atMs < DIGEST_CACHE_TTL_MS)
  )) {
    return cached.digest;
  }
  const generation = storeGeneration();
  const window = { fromMs: nowMs - days * DAY_MS, toMs: nowMs };
  const builder = new DigestBuilder(window);
  const scanOptions = options.root ? { root: options.root } : {};
  await scanSteps(window, (step) => { builder.addStep(step); }, scanOptions);
  await scanFeatures(window, (feature) => { builder.addFeature(feature); }, scanOptions);
  const digest = builder.build(nowMs);
  if (options.nowMs === undefined) digestCache.set(key, { generation, atMs: nowMs, digest });
  return digest;
}

function outcomeKey(source: string, conversation: string | null, turnId: string | null): string {
  return `${source}\u0000${conversation ?? ''}\u0000${turnId ?? ''}`;
}

/**
 * Newest-first step search. `outcome` is materialised from the turn's
 * feature row (steps are appended before their turn ends, so the stored
 * value is null until then — the join makes it honest after the fact).
 */
export async function queryReasoningSteps(
  query: { q?: string; sessionId?: string; limit?: number },
  options: { root?: string; nowMs?: number } = {},
): Promise<ReasoningStepsResponse> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(REASONING_STEPS_MAX_LIMIT, Math.floor(query.limit ?? REASONING_STEPS_DEFAULT_LIMIT)));
  const needle = query.q ? query.q.toLowerCase() : null;
  const window = { fromMs: nowMs - REASONING_FEATURE_RETENTION_DAYS * DAY_MS, toMs: nowMs + DAY_MS };
  const scanOptions = { newestFirst: true, ...(options.root ? { root: options.root } : {}) };
  const steps: ReasoningStepV1[] = [];
  let truncated = false;
  await scanSteps(window, (step) => {
    if (query.sessionId && step.sessionId !== query.sessionId && step.runId !== query.sessionId) return;
    if (needle && !step.text.toLowerCase().includes(needle)) return;
    if (steps.length >= limit) {
      truncated = true;
      return false;
    }
    steps.push(step);
  }, scanOptions);

  const missing = steps.filter((step) => step.outcome === null && step.turnId !== null);
  if (missing.length > 0) {
    const wanted = new Set(missing.map((step) => outcomeKey(step.source, step.sessionId ?? step.runId, step.turnId)));
    const times = missing.map((step) => Date.parse(step.at));
    const outcomes = new Map<string, ReasoningOutcome | null>();
    // A turn's feature row is dated by its START, which precedes its steps.
    await scanFeatures(
      { fromMs: Math.min(...times) - 2 * DAY_MS, toMs: Math.max(...times) + DAY_MS },
      (feature) => {
        const key = outcomeKey(feature.source, feature.sessionId ?? feature.runId, feature.turnId);
        if (wanted.has(key)) outcomes.set(key, feature.outcome);
      },
      options.root ? { root: options.root } : {},
    );
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (!step || step.outcome !== null) continue;
      const outcome = outcomes.get(outcomeKey(step.source, step.sessionId ?? step.runId, step.turnId));
      if (outcome) steps[i] = { ...step, outcome };
    }
  }
  return { steps, truncated };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function queryParams(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function intParam(value: string | null): number | null {
  if (value === null || value.trim() === '' || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** ApiModule for `/api/reasoning/*`. Returns false for any other path. */
export const handleReasoningApi: ApiModule = async (
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> => {
  if (path !== REASONING_API_PREFIX && !path.startsWith(`${REASONING_API_PREFIX}/`)) return false;
  if (path !== REASONING_DIGEST_PATH && path !== REASONING_STEPS_PATH) {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  if (method !== 'GET') {
    sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: `${method} not allowed on ${path}` });
    return true;
  }
  const params = queryParams(req);
  await awaitFirstRun(ctx?.cfg);

  if (path === REASONING_DIGEST_PATH) {
    const rawDays = params.get('days');
    const days = rawDays === null ? DEFAULT_DIGEST_DAYS : intParam(rawDays);
    if (days === null || days < 1 || days > REASONING_FEATURE_RETENTION_DAYS) {
      sendJson(res, 400, { code: 'REASONING_INVALID', error: `days must be an integer 1-${REASONING_FEATURE_RETENTION_DAYS}` });
      return true;
    }
    sendJson(res, 200, await computeReasoningDigest(days));
    return true;
  }

  const q = params.get('q') ?? '';
  const sessionId = params.get('sessionId') ?? '';
  const rawLimit = params.get('limit');
  const limit = rawLimit === null || rawLimit === '' ? REASONING_STEPS_DEFAULT_LIMIT : intParam(rawLimit);
  if (q.length > MAX_QUERY_CHARS) {
    sendJson(res, 400, { code: 'REASONING_INVALID', error: `q must be at most ${MAX_QUERY_CHARS} characters` });
    return true;
  }
  // Ids are printable ASCII without spaces (store.ts cleanId); anything else can never match.
  if (sessionId.length > MAX_SESSION_ID_CHARS || (sessionId !== '' && !/^[\x21-\x7e]+$/.test(sessionId))) {
    sendJson(res, 400, { code: 'REASONING_INVALID', error: 'invalid sessionId' });
    return true;
  }
  if (limit === null || limit < 1) {
    sendJson(res, 400, { code: 'REASONING_INVALID', error: `limit must be an integer 1-${REASONING_STEPS_MAX_LIMIT}` });
    return true;
  }
  sendJson(res, 200, await queryReasoningSteps({
    ...(q.trim() !== '' ? { q: q.trim() } : {}),
    ...(sessionId !== '' ? { sessionId } : {}),
    limit,
  }));
  return true;
};

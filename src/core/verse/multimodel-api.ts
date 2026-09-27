/**
 * Multi-model chat API (3.16) — mounted by verse-api.ts as the `multimodel`
 * workbench family. See core/verse/multimodel/types.ts for the model.
 *
 *   GET  /api/verse/multimodel/context?sessionId=|projectPath=  → MultimodelContext (every root of a chat is checked)
 *   POST /api/verse/multimodel/label  {text, sessionId?|projectPath?, contextTokens?} → PromptLabelResponse
 *   POST /api/verse/multimodel/outcome {seatId, kind, signal, sessionId?, model?} → {ok}
 *   POST /api/verse/multimodel/link   {parentSessionId, childSessionId, relation} → {ok}
 *   GET  /api/verse/multimodel/meter?sessionId=<id>        → ChatMeter
 *   POST /api/verse/multimodel/local/warm {seatId}         → LocalWarmResult
 *
 * NOTHING HERE STARTS A CHAT TURN. Compare fan-out, reviews, escalations and
 * Auto re-routes are made by the client through the ordinary session routes,
 * so they pass the same spend chokepoint, readiness gate, local-only gate and
 * mutation token as a hand-typed message. This module only answers the
 * questions those flows ask (what did Mason teach us, must this repo stay
 * local, what has this chat used) and records what happened.
 *
 * `label` may call the decision layer (a paid remote API) — once per sent
 * message, never for a local-only repo, cached by input hash
 * (multimodel/label.ts). `local/warm` talks only to loopback runtimes.
 *
 * Security posture matches every Verse route: GETs sit behind the read
 * session; a POST is 404 unless dispatch is allowed, then the constant-time
 * mutation token + JSON gate, then a 64 KB body cap. Unknown query parameters
 * and body keys are 400s. All IO is async (scripts/check-verse-sync-io.mjs).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import type { AshlrConfig } from '../types.js';
import { canonicalModelTag, KNOWN_MODELS } from '../run/model-catalog.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { capacityFromSeat, assessSeat } from '../routing/headroom.js';
import { effectiveSeatPolicy, engineOfSeatId, type BudgetEngine } from '../routing/policy.js';
import type { BudgetPolicy } from '../routing/types.js';
import type { ApiModule } from './api-modules.js';
import type { VerseSeatLaunch } from './session-engine.js';
import type { VerseSeatDiscovery } from './seats.js';
import { verseSessionRoots, type VerseEvent, type VerseSeat, type VerseSession } from './types.js';
import { getVerseEngine, type VerseApiContext } from './verse-api.js';
import { aggregateOutcomes } from './multimodel/learning.js';
import { labelPrompt, type LabelResult } from './multimodel/label.js';
import { lastThroughput, recordThroughput, warmLocalModel, isLoopbackUrl, type WarmTarget } from './multimodel/local-warm.js';
import { buildChatMeter } from './multimodel/meter.js';
import type { ListPrice } from './multimodel/escalation.js';
import { createMultimodelStore, type MultimodelStore } from './multimodel/store.js';
import {
  OUTCOME_SIGNALS,
  PROMPT_KINDS,
  THREAD_RELATIONS,
  VERSE_MULTIMODEL_PATH,
  type ChatMeterSeat,
  type EngineRoi,
  type LocalModelBadge,
  type LocalWarmResult,
  type MultimodelContext,
  type OutcomeSignal,
  type PromptKind,
  type ThreadRelation,
} from './multimodel/types.js';

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SEAT_ID_MAX = 256;
/** Fleet ROI is a heavy ledger read: computed off the request path, reused this long. */
const ROI_TTL_MS = 10 * 60_000;
const DISCOVERY_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface MultimodelDiscovery {
  seats: VerseSeat[];
  launches: ReadonlyMap<string, VerseSeatLaunch>;
}

export interface MultimodelApiDeps {
  store(): MultimodelStore;
  listSessions(): Promise<VerseSession[]>;
  getEvents(sessionId: string): Promise<VerseEvent[]>;
  /** Seat identity + live telemetry (capacity windows). */
  discovery(cfg: AshlrConfig): Promise<MultimodelDiscovery>;
  /** Fleet model ROI folded per engine (M322/M335). May answer {} while it computes. */
  roi(): Record<string, EngineRoi>;
  /** Why this repo must stay on this Mac, or null. Never throws toward "allowed": a failed read answers with a reason. */
  localOnlyReason(cfg: AshlrConfig, projectPath: string | null): Promise<string | null>;
  budgetPolicy(): Promise<BudgetPolicy>;
  priceOf(engine: string, model: string): ListPrice | null;
  warm(target: WarmTarget): Promise<LocalWarmResult>;
  label(text: string, opts: { contextTokens?: number | null; localOnlyReason?: string | null }): Promise<LabelResult>;
  now(): number;
}

let discoveryCache: { cfg: AshlrConfig; at: number; value: VerseSeatDiscovery } | null = null;

async function defaultDiscovery(cfg: AshlrConfig): Promise<MultimodelDiscovery> {
  const seats = await import('./seats.js');
  if (!discoveryCache || discoveryCache.cfg !== cfg || Date.now() - discoveryCache.at >= DISCOVERY_TTL_MS) {
    discoveryCache = { cfg, at: Date.now(), value: await seats.discoverSeats(cfg) };
  }
  // Identity (which accounts and tags exist) is cached — discovering it walks
  // Ollama. Telemetry (windows) is re-read on every call: cheap, and it moves.
  const live = seats.refreshSeatTelemetry(cfg, discoveryCache.value);
  return { seats: live.seats, launches: live.launches };
}

let roiCache: { at: number; value: Record<string, EngineRoi> } | null = null;
let roiRunning = false;

/** Fold per-model ROI into per-engine rows (dispatch-weighted ship rate and latency). */
export function foldRoiByEngine(rows: ReadonlyArray<{ engine: string; dispatches: number; judged: number; shipVerdicts: number; avgLatencyMs: number | null }>): Record<string, EngineRoi> {
  const acc = new Map<string, { dispatches: number; judged: number; ship: number; latSum: number; latN: number }>();
  for (const r of rows) {
    // Fleet lanes name engines differently (grok-cli, claude-cli, local-coder).
    const engine = r.engine.startsWith('claude') ? 'claude' : r.engine.startsWith('grok') ? 'grok' : r.engine.startsWith('codex') ? 'codex'
      : r.engine.startsWith('local') || r.engine.startsWith('llama') || r.engine === 'ollama' ? 'local' : r.engine;
    const a = acc.get(engine) ?? { dispatches: 0, judged: 0, ship: 0, latSum: 0, latN: 0 };
    a.dispatches += r.dispatches;
    a.judged += r.judged;
    a.ship += r.shipVerdicts;
    if (typeof r.avgLatencyMs === 'number' && Number.isFinite(r.avgLatencyMs) && r.dispatches > 0) {
      a.latSum += r.avgLatencyMs * r.dispatches;
      a.latN += r.dispatches;
    }
    acc.set(engine, a);
  }
  const out: Record<string, EngineRoi> = {};
  for (const [engine, a] of acc) {
    out[engine] = {
      dispatches: a.dispatches,
      shipRate: a.judged > 0 ? Math.round((a.ship / a.judged) * 1000) / 1000 : null,
      avgLatencyMs: a.latN > 0 ? Math.round(a.latSum / a.latN) : null,
    };
  }
  return out;
}

function defaultRoi(): Record<string, EngineRoi> {
  const now = Date.now();
  if ((!roiCache || now - roiCache.at > ROI_TTL_MS) && !roiRunning) {
    roiRunning = true;
    // A synchronous ledger read: deferred so it never runs inside a request.
    setTimeout(() => {
      void import('../fleet/model-stats.js')
        .then((mod) => { roiCache = { at: Date.now(), value: foldRoiByEngine(mod.computeModelStats('30d')) }; })
        .catch(() => { roiCache = { at: Date.now(), value: {} }; })
        .finally(() => { roiRunning = false; });
    }, 0).unref?.();
  }
  return roiCache?.value ?? {};
}

async function defaultLocalOnlyReason(cfg: AshlrConfig, projectPath: string | null): Promise<string | null> {
  try {
    const { repoLocalOnlyReason } = await import('../knowledge/wiki/model.js');
    if (projectPath === null) {
      // No repo named: only the global switch can apply.
      const { localOnlyEnabled } = await import('../policy/local-only.js');
      return localOnlyEnabled(cfg) ? 'Local-only mode is on.' : null;
    }
    const { readWikiSteering } = await import('../knowledge/wiki/steering.js');
    let steering = false;
    try { steering = (await readWikiSteering(projectPath)).localOnly; } catch { steering = false; }
    return repoLocalOnlyReason(cfg, projectPath, steering);
  } catch {
    // Fail toward privacy: an unreadable policy keeps the chat on this Mac.
    return 'The local-only setting could not be read, so remote models are held back.';
  }
}

/**
 * API list price for a chat seat's model, from the fleet's own catalog
 * (run/model-catalog.ts `KNOWN_MODELS`) — one price table, not two. Null for
 * local (free), Grok (a seat-routed subscription with no per-token price in
 * the catalog) and anything the catalog does not price.
 */
export function listPriceOf(engine: string, model: string): ListPrice | null {
  if (engine !== 'claude' && engine !== 'codex') return null;
  const tag = canonicalModelTag(engine, model);
  const m = model.toLowerCase();
  const family = engine === 'codex' ? 'codex:gpt-5.5'
    : m.includes('opus') ? 'claude:opus' : m.includes('haiku') ? 'claude:haiku' : m.includes('fable') ? 'claude:fable-5' : 'claude:sonnet';
  const entry = KNOWN_MODELS.find((k) => k.id === `${engine}:${tag}`) ?? KNOWN_MODELS.find((k) => k.id === family);
  if (!entry || (entry.costPerMTokIn <= 0 && entry.costPerMTokOut <= 0)) return null;
  return { inPerM: entry.costPerMTokIn, outPerM: entry.costPerMTokOut };
}

async function defaultBudgetPolicy(): Promise<BudgetPolicy> {
  const { loadBudgetPolicy } = await import('../routing/budget-store.js');
  return loadBudgetPolicy();
}

export const DEFAULT_MULTIMODEL_API_DEPS: MultimodelApiDeps = {
  store: (() => {
    let store: MultimodelStore | null = null;
    return () => (store ??= createMultimodelStore());
  })(),
  listSessions: async () => (await getVerseEngine()).listSessions(),
  getEvents: async (id) => (await getVerseEngine()).getEvents(id),
  discovery: defaultDiscovery,
  roi: defaultRoi,
  localOnlyReason: defaultLocalOnlyReason,
  budgetPolicy: defaultBudgetPolicy,
  priceOf: listPriceOf,
  warm: (target) => warmLocalModel(target),
  label: (text, opts) => labelPrompt(text, opts),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// HTTP plumbing
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
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      sendInvalid(res, `unknown query parameter: ${key.slice(0, 64)}`);
      return null;
    }
    if (seen.has(key)) {
      sendInvalid(res, `repeated query parameter: ${key}`);
      return null;
    }
    seen.add(key);
  }
  return params;
}

async function readMutationBody(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
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
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      sendInvalid(res, `unknown key: ${key.slice(0, 64)}`);
      return null;
    }
  }
  return body;
}

function absPath(raw: string | null): string | null | undefined {
  if (raw === null) return null;
  if (raw.length === 0 || raw.length > 4096 || !path.isAbsolute(raw) || raw.includes('\0')) return undefined;
  return path.resolve(raw);
}

type PrivacyScope = { projectPath: string | null; sessionId: string | null };

/** Parse the one-of `projectPath` / `sessionId` scope; answers 400 itself. */
function privacyScope(res: ServerResponse, rawPath: string | null, rawSession: string | null): PrivacyScope | null {
  if (rawPath !== null && rawSession !== null) {
    sendInvalid(res, 'send projectPath or sessionId, not both');
    return null;
  }
  const projectPath = absPath(rawPath);
  if (projectPath === undefined) {
    sendInvalid(res, 'projectPath must be an absolute path');
    return null;
  }
  if (rawSession !== null && !SESSION_ID_RE.test(rawSession)) {
    sendInvalid(res, 'invalid sessionId');
    return null;
  }
  return { projectPath, sessionId: rawSession };
}

/**
 * Must this chat stay on this Mac? A chat reaches ALL its pinned roots, so
 * every one is checked and the first reason wins. An unknown chat id is
 * checked against the global switch only (there is nothing else to check).
 */
async function privacyReason(deps: MultimodelApiDeps, cfg: AshlrConfig, scope: PrivacyScope): Promise<string | null> {
  const roots: string[] = [];
  if (scope.projectPath) roots.push(scope.projectPath);
  if (scope.sessionId) {
    const session = (await deps.listSessions().catch(() => [] as VerseSession[])).find((s) => s.id === scope.sessionId);
    if (session) for (const root of verseSessionRoots(session)) if (!roots.includes(root)) roots.push(root);
  }
  if (roots.length === 0) return deps.localOnlyReason(cfg, null);
  for (const root of roots.slice(0, 16)) {
    const reason = await deps.localOnlyReason(cfg, root);
    if (reason) return reason;
  }
  return null;
}

function seatIdOk(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= SEAT_ID_MAX && !/[\0\n\r]/.test(v);
}

function engineOf(discovery: MultimodelDiscovery | null, seatId: string): string {
  return discovery?.seats.find((s) => s.id === seatId)?.engine ?? engineOfSeatId(seatId);
}

// ---------------------------------------------------------------------------
// Local badges
// ---------------------------------------------------------------------------

/** How many of a model's newest local chats are searched for a finished turn. */
const THROUGHPUT_SCAN_SESSIONS = 3;

async function turnThroughput(sessions: readonly VerseSession[], events: (id: string) => Promise<VerseEvent[]>, model: string): Promise<number | null> {
  // The newest local chats on this model: output tokens over the last clean turn (end to end — a floor).
  const newest = sessions
    .filter((s) => s.engine === 'local' && s.model === model && s.turnCount > 0)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, THROUGHPUT_SCAN_SESSIONS);
  for (const session of newest) {
    const tps = await sessionThroughput(session.id, events);
    if (tps !== null) return tps;
  }
  return null;
}

function sessionThroughput(sessionId: string, events: (id: string) => Promise<VerseEvent[]>): Promise<number | null> {
  return events(sessionId).then((list) => {
    const out = new Map<string, number>();
    for (const e of list) if (e.type === 'usage' && typeof e.usage?.outputTokens === 'number') out.set(e.turnId, e.usage.outputTokens);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const e = list[i]!;
      if (e.type !== 'turn-done' || !e.ok) continue;
      const tokens = out.get(e.turnId);
      if (!tokens || !(e.durationMs > 0)) continue;
      return Math.round((tokens / (e.durationMs / 1000)) * 10) / 10;
    }
    return null;
  }, () => null);
}

export async function localBadges(deps: MultimodelApiDeps, discovery: MultimodelDiscovery): Promise<LocalModelBadge[]> {
  const sessions = await deps.listSessions().catch(() => [] as VerseSession[]);
  const local = discovery.seats.filter((s) => s.engine === 'local').slice(0, 16);
  return Promise.all(local.map(async (seat): Promise<LocalModelBadge> => {
    const model = seat.models[0]?.id ?? seat.id.replace(/^local:/, '');
    const launch = discovery.launches.get(seat.id);
    const endpoint = launch?.anthropicBaseUrl ?? launch?.ollamaBaseUrl ?? '';
    let reading = lastThroughput(model);
    if (!reading) {
      const tps = await turnThroughput(sessions, deps.getEvents, model);
      if (tps !== null) {
        reading = { tokPerSec: tps, source: 'turn', at: new Date(deps.now()).toISOString() };
        recordThroughput(model, reading);
      }
    }
    return {
      seatId: seat.id,
      model,
      state: 'unknown',
      contextWindow: seat.contextWindow ?? seat.models[0]?.contextWindow ?? null,
      tokPerSec: reading?.tokPerSec ?? null,
      tokPerSecSource: reading?.source ?? null,
      private: endpoint !== '' && isLoopbackUrl(endpoint),
      supportsTools: null,
    };
  }));
}

// ---------------------------------------------------------------------------
// Meter seats
// ---------------------------------------------------------------------------

function meterSeats(discovery: MultimodelDiscovery, policy: BudgetPolicy, nowMs: number): ChatMeterSeat[] {
  return discovery.seats.map((seat) => {
    if (seat.engine === 'local') return { seatId: seat.id, label: seat.label, engine: seat.engine, window: null, fleetShare: null };
    const capacity = capacityFromSeat(seat);
    const engine = seat.engine as BudgetEngine;
    // Interactive: the whole window is Mason's, so the reading is taken with no reserve.
    const assessed = assessSeat(capacity, { seatId: seat.id, enabled: true, reservePercent: 0 }, { nowMs });
    const binding = assessed.headroom.bindingWindow;
    const used = binding === 'session' ? assessed.headroom.sessionUsedPercent : binding === 'weekly' ? assessed.headroom.weeklyUsedPercent : null;
    const window = assessed.exhausted ? 'usage spent' : used === null ? null : `${binding === 'session' ? '5-hour' : 'weekly'} ${Math.round(used)}% used`;
    const fleet = effectiveSeatPolicy(policy, seat.id, engine);
    const fleetShare = !fleet.enabled
      ? 'The fleet never uses this seat — it is all yours.'
      : `The fleet may use ${100 - Math.round(fleet.reservePercent)}%; ${Math.round(fleet.reservePercent)}% is kept for your chats.`;
    return { seatId: seat.id, label: seat.label, engine: seat.engine, window, fleetShare };
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createMultimodelApi(deps: MultimodelApiDeps = DEFAULT_MULTIMODEL_API_DEPS): ApiModule {
  return async (ctx, req, res, pathname, method) => {
    if (pathname !== VERSE_MULTIMODEL_PATH && !pathname.startsWith(`${VERSE_MULTIMODEL_PATH}/`)) return false;
    const route = pathname.slice(VERSE_MULTIMODEL_PATH.length);
    try {
      // ── GET /context ──────────────────────────────────────────────────
      if (route === '/context' && method === 'GET') {
        const params = readQuery(req, res, ['projectPath', 'sessionId']);
        if (!params) return true;
        const scope = privacyScope(res, params.get('projectPath'), params.get('sessionId'));
        if (!scope) return true;
        const [outcomes, discovery, reason] = await Promise.all([
          deps.store().readOutcomes().catch(() => []),
          deps.discovery(ctx.cfg).catch(() => null),
          privacyReason(deps, ctx.cfg, scope),
        ]);
        const body: MultimodelContext = {
          learned: aggregateOutcomes(outcomes, deps.now()),
          roi: deps.roi(),
          localOnly: { on: reason !== null, reason },
          local: discovery ? await localBadges(deps, discovery) : [],
          sampledAt: new Date(deps.now()).toISOString(),
        };
        sendJson(res, 200, body);
        return true;
      }

      // ── POST /label ───────────────────────────────────────────────────
      if (route === '/label' && method === 'POST') {
        const body = await readMutationBody(ctx, req, res, ['text', 'projectPath', 'sessionId', 'contextTokens']);
        if (!body) return true;
        const text = body['text'];
        if (typeof text !== 'string' || text.length === 0 || text.length > 64 * 1024) {
          sendInvalid(res, 'text must be a non-empty string');
          return true;
        }
        const rawPath = body['projectPath'];
        const rawSession = body['sessionId'];
        if ((rawPath !== undefined && typeof rawPath !== 'string') || (rawSession !== undefined && typeof rawSession !== 'string')) {
          sendInvalid(res, 'projectPath and sessionId must be strings');
          return true;
        }
        const scope = privacyScope(res, rawPath ?? null, rawSession ?? null);
        if (!scope) return true;
        const ctxTokens = body['contextTokens'];
        if (ctxTokens !== undefined && (typeof ctxTokens !== 'number' || !Number.isFinite(ctxTokens) || ctxTokens < 0)) {
          sendInvalid(res, 'contextTokens must be a non-negative number');
          return true;
        }
        const reason = await privacyReason(deps, ctx.cfg, scope);
        const result = await deps.label(text, { contextTokens: (ctxTokens as number | undefined) ?? null, localOnlyReason: reason });
        sendJson(res, 200, { classification: result.classification, fallbackReason: result.fallbackReason });
        return true;
      }

      // ── POST /outcome ─────────────────────────────────────────────────
      if (route === '/outcome' && method === 'POST') {
        const body = await readMutationBody(ctx, req, res, ['seatId', 'kind', 'signal', 'sessionId', 'model']);
        if (!body) return true;
        const { seatId, kind, signal, sessionId, model } = body;
        if (!seatIdOk(seatId)) return sendInvalid(res, 'seatId is required'), true;
        if (!(PROMPT_KINDS as readonly unknown[]).includes(kind)) return sendInvalid(res, `kind must be one of ${PROMPT_KINDS.join(', ')}`), true;
        if (!(OUTCOME_SIGNALS as readonly unknown[]).includes(signal)) return sendInvalid(res, `signal must be one of ${OUTCOME_SIGNALS.join(', ')}`), true;
        if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))) return sendInvalid(res, 'invalid sessionId'), true;
        if (model !== undefined && (typeof model !== 'string' || model.length > 256)) return sendInvalid(res, 'invalid model'), true;
        const discovery = await deps.discovery(ctx.cfg).catch(() => null);
        await deps.store().appendOutcome({
          at: new Date(deps.now()).toISOString(),
          seatId,
          engine: engineOf(discovery, seatId),
          kind: kind as PromptKind,
          signal: signal as OutcomeSignal,
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          ...(typeof model === 'string' ? { model } : {}),
        });
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ── POST /link ────────────────────────────────────────────────────
      if (route === '/link' && method === 'POST') {
        const body = await readMutationBody(ctx, req, res, ['parentSessionId', 'childSessionId', 'relation']);
        if (!body) return true;
        const { parentSessionId, childSessionId, relation } = body;
        if (typeof parentSessionId !== 'string' || !SESSION_ID_RE.test(parentSessionId)) return sendInvalid(res, 'invalid parentSessionId'), true;
        if (typeof childSessionId !== 'string' || !SESSION_ID_RE.test(childSessionId)) return sendInvalid(res, 'invalid childSessionId'), true;
        if (parentSessionId === childSessionId) return sendInvalid(res, 'a chat cannot link to itself'), true;
        if (!(THREAD_RELATIONS as readonly unknown[]).includes(relation)) return sendInvalid(res, `relation must be one of ${THREAD_RELATIONS.join(', ')}`), true;
        const sessions = await deps.listSessions();
        const ids = new Set(sessions.map((s) => s.id));
        if (!ids.has(parentSessionId) || !ids.has(childSessionId)) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: 'session not found' });
          return true;
        }
        await deps.store().addLink({ parentSessionId, childSessionId, relation: relation as ThreadRelation, at: new Date(deps.now()).toISOString() });
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ── GET /meter ────────────────────────────────────────────────────
      if (route === '/meter' && method === 'GET') {
        const params = readQuery(req, res, ['sessionId']);
        if (!params) return true;
        const sessionId = params.get('sessionId');
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) return sendInvalid(res, 'sessionId is required'), true;
        const [sessions, links, discovery] = await Promise.all([
          deps.listSessions(),
          deps.store().readLinks().catch(() => []),
          deps.discovery(ctx.cfg).catch(() => null),
        ]);
        if (!sessions.some((s) => s.id === sessionId)) {
          sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${sessionId}` });
          return true;
        }
        const policy = await deps.budgetPolicy();
        const meter = buildChatMeter({
          sessionId,
          sessions,
          links,
          priceOf: deps.priceOf,
          seats: discovery ? meterSeats(discovery, policy, deps.now()) : [],
          budgetMode: policy.mode,
        });
        sendJson(res, 200, meter);
        return true;
      }

      // ── POST /local/warm ──────────────────────────────────────────────
      if (route === '/local/warm' && method === 'POST') {
        const body = await readMutationBody(ctx, req, res, ['seatId']);
        if (!body) return true;
        const seatId = body['seatId'];
        if (!seatIdOk(seatId)) return sendInvalid(res, 'seatId is required'), true;
        const discovery = await deps.discovery(ctx.cfg);
        const seat = discovery.seats.find((s) => s.id === seatId);
        const launch = discovery.launches.get(seatId);
        if (!seat || seat.engine !== 'local' || !launch) {
          sendJson(res, 404, { code: 'VERSE_SEAT_NOT_FOUND', error: 'not a local seat on this machine' });
          return true;
        }
        const model = seat.models[0]?.id ?? seatId.replace(/^local:/, '');
        const result = await deps.warm({ seatId, model, ollamaBaseUrl: launch.ollamaBaseUrl, anthropicBaseUrl: launch.anthropicBaseUrl ?? null });
        sendJson(res, 200, result);
        return true;
      }

      sendJson(res, 404, { error: `not found: ${method} ${pathname}` });
      return true;
    } catch {
      if (!res.headersSent) sendJson(res, 500, { code: 'VERSE_MULTIMODEL_FAILED', error: 'Multi-model request failed.' });
      return true;
    }
  };
}

/** The workbench family's frozen handler export. */
export const handleMultimodelApi: ApiModule = createMultimodelApi();

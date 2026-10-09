/**
 * routes/verse/resources/resources-model.ts — what the Resources drawer says,
 * projected from reads other units already own (unit 3.11 C6). Pure: no
 * React, no I/O.
 *
 * Nothing about a seat is worded here. Every account line comes from C6's
 * capacity projection (usage/capacity-strip-model.ts: `accountStatus`,
 * `orderAccountRows`), so the drawer, Apps & Accounts and the rail ring can
 * never describe one seat two ways. What IS new here:
 *
 *   - the edge handle's one-dot summary across the paid accounts;
 *   - the cloud lane's overview (GET /api/verse/cloud), narrowed field by
 *     field — the route is landing in parallel, so a missing or drifted body
 *     reads as "not available yet", never as a crash or a zero;
 *   - short sentences for the serving runtime and each local model's context.
 */
import { CLOUD_BALANCE_URL, type CloudOverviewResponse } from '../../../../core/cloud/types.js';
import { formatMetric, formatMetricUsd } from '../../../components/charts/format-metric.js';
import { costBasisOf, seatTier, tierRank, type CostBasis, type ResourceTier } from '../../../../core/routing/tiers.js';
import type { ServingRuntimeSnapshot, VerseSeat } from '../../../data/api-types.js';
import { accountStatus, accountStatusRank, hasCurrentUsage, type AccountStatusKind, type CapacityRow } from '../usage/capacity-strip-model.js';
import { modelNameInText, type LocalModelRow } from '../usage/local-model.js';
import { formatContextWindow } from '../verse-model.js';

/** Original local observation time, never cache refresh time or inferred freshness. */
export function localObservationAge(at: string | null | undefined, now: number): string {
  const elapsed = now - Date.parse(at ?? '');
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'age unavailable';
  return elapsed < 60_000 ? 'just measured' : elapsed < 3_600_000 ? `${formatMetric(elapsed / 60_000)} min ago`
    : elapsed < 86_400_000 ? `${formatMetric(elapsed / 3_600_000)} h ago` : `${formatMetric(elapsed / 86_400_000)} d ago`;
}

// ---------------------------------------------------------------------------
// The handle's dot
// ---------------------------------------------------------------------------

/**
 *   ok       every account read is usable, none tight
 *   tight    something is running low (or usable only on credits)
 *   alert    something is spent, signed out or unavailable
 *   unknown  nothing has been read yet — no dot at all (never "all good")
 */
export type ResourcesTone = 'ok' | 'tight' | 'alert' | 'unknown';

export interface ResourcesSummary {
  tone: ResourcesTone;
  /** Appended to the handle's accessible name and tooltip: "2 usable · 1 spent". */
  spoken: string;
}

const ALERT_KINDS: ReadonlySet<AccountStatusKind> = new Set(['spent', 'signed-out', 'unavailable']);

const COUNT_WORDS: ReadonlyArray<[AccountStatusKind, string]> = [
  ['low', 'running low'],
  ['spent', 'spent'],
  ['signed-out', 'signed out'],
  ['unavailable', 'unavailable'],
];

/** The paid accounts, reduced to one tone and one sentence. Local seats have no quota to run out of. */
export function summarizeResources(rows: readonly CapacityRow[], opts: { healthRead: boolean; now?: number }): ResourcesSummary {
  const paid = rows.filter((r) => r.kind === 'subscription');
  const current = paid.filter(hasCurrentUsage).length;
  const kinds = paid.map((r) => accountStatus(r, { healthRead: opts.healthRead, ...(opts.now !== undefined ? { now: opts.now } : {}) }).kind);
  const counts = new Map<AccountStatusKind, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const parts = paid.length === 0 ? ['no accounts connected'] : [`${current} with current usage`];
  if (current < paid.length) parts.push(`${paid.length - current} usage unconfirmed`);
  parts.push(...COUNT_WORDS.filter(([k]) => counts.has(k)).map(([k, word]) => `${counts.get(k)} ${word}`));
  const spoken = parts.join(' · ');
  let tone: ResourcesTone = 'unknown';
  if (kinds.some((k) => ALERT_KINDS.has(k))) tone = 'alert';
  else if (kinds.includes('low')) tone = 'tight';
  else if (kinds.includes('usable')) tone = 'ok';
  return { tone, spoken };
}

export const TONE_WORD: Readonly<Record<ResourcesTone, string>> = {
  ok: 'all usable',
  tight: 'running low',
  alert: 'needs attention',
  unknown: 'not read yet',
};

// ---------------------------------------------------------------------------
// Cloud credits
// ---------------------------------------------------------------------------

export interface CloudCreditsView {
  totalUsd: number;
  spentUsd: number;
  remainingUsd: number;
  /** 0–100, remaining of total. */
  remainingPercent: number;
  running: number;
  sessionsToday: number;
  maxSessionsPerDay: number | null;
  seatReady: boolean;
  seatReason: string | null;
  canLaunch: boolean;
  canLaunchReason: string | null;
  estimateNote: string;
  /** Always https://claude.ai/… — anything else falls back to the frozen constant. */
  balanceUrl: string;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

const DEFAULT_ESTIMATE_NOTE = 'An estimate from the sessions Phantom launched — the real balance is on claude.ai.';

/** Narrow a GET /api/verse/cloud body; null when it is not one. */
export function projectCloudCredits(raw: unknown): CloudCreditsView | null {
  const root = rec(raw) as Partial<Record<keyof CloudOverviewResponse, unknown>> | null;
  const budget = rec(root?.budget);
  if (!root || !budget) return null;
  const total = num(budget['creditsTotalUsd']);
  const spent = num(budget['estimatedSpentUsd']);
  const remainingRaw = num(budget['estimatedRemainingUsd']);
  if (total === null || (spent === null && remainingRaw === null)) return null;
  const remaining = Math.max(0, remainingRaw ?? total - (spent ?? 0));
  const seat = rec(root.seat);
  const gate = rec(budget['canLaunch']);
  const url = text(budget['balanceUrl']);
  const policy = rec(budget['budget']);
  return {
    totalUsd: total,
    spentUsd: spent ?? Math.max(0, total - remaining),
    remainingUsd: remaining,
    remainingPercent: total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0,
    running: Math.max(0, num(budget['running']) ?? 0),
    sessionsToday: Math.max(0, num(budget['sessionsToday']) ?? 0),
    maxSessionsPerDay: num(policy?.['maxSessionsPerDay']),
    seatReady: seat?.['ready'] !== false,
    seatReason: text(seat?.['reason']),
    canLaunch: gate?.['ok'] !== false,
    canLaunchReason: text(gate?.['reason']),
    estimateNote: text(budget['estimateNote']) ?? DEFAULT_ESTIMATE_NOTE,
    balanceUrl: url !== null && url.startsWith('https://claude.ai/') ? url : CLOUD_BALANCE_URL,
  };
}

/** Two significant figures; only display values are rounded. */
export function formatUsd(value: number): string {
  return formatMetricUsd(Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------

const RUNTIME_NAME: Readonly<Record<ServingRuntimeSnapshot['kind'], string>> = {
  'llama-server': 'llama-server',
  ollama: 'Ollama',
  vllm: 'vLLM',
  unknown: 'Serving runtime',
};

const STATE_WORD: Readonly<Record<ServingRuntimeSnapshot['state'], string>> = {
  running: 'Running',
  starting: 'Starting…',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  unknown: 'State not reported',
};

export interface RuntimeView {
  name: string;
  state: ServingRuntimeSnapshot['state'];
  word: string;
  tone: 'success' | 'warning' | 'neutral';
  /** "Qwen3-32B · 16k context per agent · 1 of 4 slots busy" — only the parts that were reported. */
  detail: string | null;
  canStart: boolean;
  canStop: boolean;
  /** Set when Verse cannot start or stop it (launchd, the operator's own terminal). */
  managedElsewhere: boolean;
}

export function runtimeView(runtime: ServingRuntimeSnapshot | null): RuntimeView | null {
  if (!runtime) return null;
  const parts: string[] = [];
  if (runtime.model) parts.push(modelNameInText(runtime.model));
  // Per-slot context, the number one agent actually gets (fleet-types.ts).
  if (runtime.contextTokens !== null) parts.push(`${formatContextWindow(runtime.contextTokens)} context per agent`);
  if (runtime.slotsTotal !== null && runtime.slotsTotal > 0) {
    parts.push(runtime.slotsBusy !== null ? `${runtime.slotsBusy} of ${runtime.slotsTotal} slots busy` : `${runtime.slotsTotal} slots`);
  }
  const state = runtime.state;
  return {
    name: RUNTIME_NAME[runtime.kind] ?? RUNTIME_NAME.unknown,
    state,
    word: STATE_WORD[state] ?? STATE_WORD.unknown,
    tone: state === 'running' ? 'success' : state === 'starting' || state === 'stopping' ? 'warning' : 'neutral',
    detail: parts.length > 0 ? parts.join(' · ') : null,
    canStart: runtime.supervised && state === 'stopped',
    canStop: runtime.supervised && state === 'running',
    managedElsewhere: !runtime.supervised,
  };
}

/**
 * The context a local model runs with. The configured window is the one a
 * turn actually gets; when it is below the model's native window both are
 * said, so "256k model" is never read as "256k here".
 */
export function modelContextText(row: Pick<LocalModelRow, 'nativeContext' | 'configuredContext' | 'contextTruncated'>): string | null {
  const configured = row.configuredContext;
  const native = row.nativeContext;
  if (configured !== null && row.contextTruncated && native !== null) return `${formatContextWindow(configured)} of ${formatContextWindow(native)} context`;
  if (configured !== null) return `${formatContextWindow(configured)} context`;
  if (native !== null) return `${formatContextWindow(native)} context`;
  return null;
}

/** How many models the drawer lists before pointing at Usage for the rest. */
export const LOCAL_MODELS_SHOWN = 6;

// ---------------------------------------------------------------------------
// Local runtimes (3.14): Ollama, LM Studio and llama-server as ONE resource
// ---------------------------------------------------------------------------

export interface LocalRuntimeLine {
  id: 'ollama' | 'lmstudio' | 'llama-server';
  name: string;
  /** Status-line tone: answering with something loaded = success. */
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  /** "Answering", "Not answering", "Loading…". */
  word: string;
  /** "4 installed · 1 loaded" / "listening on :8080 but not answering — restart it". */
  detail: string;
}

function portOf(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string') return '';
  try {
    const url = new URL(baseUrl);
    return url.port ? `:${url.port}` : url.host;
  } catch {
    return '';
  }
}

function modelCounts(report: Record<string, unknown>): { installed: number; loaded: number } {
  const models = Array.isArray(report['models']) ? report['models'] : [];
  let loaded = 0;
  // `state: 'loaded'` is the current wire; `loaded: true` the pre-3.10 one.
  for (const m of models) {
    const row = rec(m);
    if (row?.['state'] === 'loaded' || row?.['loaded'] === true) loaded += 1;
  }
  return { installed: models.length, loaded };
}

function catalogLine(id: 'ollama' | 'lmstudio', name: string, raw: unknown): LocalRuntimeLine | null {
  const report = rec(raw);
  if (!report) return null;
  const port = portOf(report['baseUrl']);
  if (report['reachable'] !== true) {
    return { id, name, tone: 'neutral', word: 'Not running', detail: port ? `nothing answering on ${port}` : 'nothing answering' };
  }
  const { installed, loaded } = modelCounts(report);
  const stale = report['stale'] === true ? ' · last known' : '';
  return {
    id,
    name,
    tone: loaded > 0 ? 'success' : 'neutral',
    word: 'Answering',
    detail: `${installed} installed · ${loaded > 0 ? `${loaded} loaded` : 'none loaded'}${stale}`,
  };
}

function llamaLine(raw: unknown): LocalRuntimeLine | null {
  const report = rec(raw);
  if (!report) return null;
  const port = portOf(report['baseUrl']);
  const status = report['status'];
  const reason = report['reason'];
  const name = 'llama-server';
  if (status === 'ok') {
    const count = typeof report['modelCount'] === 'number' ? report['modelCount'] : null;
    const slots = typeof report['slots'] === 'number' ? report['slots'] : null;
    const parts = [count !== null ? `${count} model${count === 1 ? '' : 's'} served` : 'serving', slots !== null ? `${slots} slots` : null]
      .filter((p): p is string => p !== null);
    return { id: 'llama-server', name, tone: 'success', word: 'Answering', detail: parts.join(' · ') };
  }
  if (status === 'loading') return { id: 'llama-server', name, tone: 'warning', word: 'Loading…', detail: `mapping weights on ${port}` };
  if (status === 'error') return { id: 'llama-server', name, tone: 'danger', word: 'Error', detail: `answering on ${port} with an error` };
  // `down`: refused = not running; timed out = a process holds the port but
  // never answers — wedged, which needs a restart, not a start.
  if (reason === 'llama-server-timeout') {
    return { id: 'llama-server', name, tone: 'danger', word: 'Not answering', detail: `listening on ${port} but not answering — restart it` };
  }
  return { id: 'llama-server', name, tone: 'neutral', word: 'Not running', detail: port ? `nothing answering on ${port}` : 'nothing answering' };
}

/**
 * One line per local runtime from GET /api/verse/local-models. A runtime the
 * server did not report (an older build has no `llamaServer`) is simply
 * absent — never shown as down.
 */
export function localRuntimeLines(raw: unknown): LocalRuntimeLine[] {
  const root = rec(raw);
  if (!root) return [];
  return [
    catalogLine('ollama', 'Ollama', root['ollama']),
    catalogLine('lmstudio', 'LM Studio', root['lmStudio']),
    llamaLine(root['llamaServer']),
  ].filter((line): line is LocalRuntimeLine => line !== null);
}

// ---------------------------------------------------------------------------
// One card anatomy, one tier model (3.15, "equal partners")
// ---------------------------------------------------------------------------

/**
 * The facts line every card carries, whatever the provider: its TIER
 * (routing/tiers.ts), what one more turn costs, the models it offers and —
 * when there is one — the reserve kept for Mason. Status, usage and the
 * Chat / Fleet readiness lines are the card's other rows.
 */
export interface ResourceFactsView {
  tier: ResourceTier;
  basis: CostBasis;
  /** Runnable model labels, default first; empty when the card lists its own models. */
  models: string[];
  /** "10 ACUs kept for you", when the reserve is not already on a meter; null otherwise. */
  reserve: string | null;
}

/** Shown before "+N more". */
export const FACTS_MODELS_SHOWN = 3;

/** "Opus 5.5, Sonnet 5, Haiku +2 more" — never empty-looking, never a bare "…". */
export function modelsLine(labels: readonly string[], max = FACTS_MODELS_SHOWN): string | null {
  const unique = [...new Set(labels.filter((l) => l.trim().length > 0))];
  if (unique.length === 0) return null;
  const shown = unique.slice(0, max).join(', ');
  return unique.length > max ? `${shown} +${unique.length - max} more` : shown;
}

function runnable(seat: Pick<VerseSeat, 'models'>) {
  const models = seat.models.filter((m) => !m.unavailableReason);
  return models.length > 0 ? models : seat.models.slice(0, 1);
}

/** The facts for one seat (its default model decides the tier). */
export function seatFacts(seat: Pick<VerseSeat, 'engine' | 'models' | 'costBasis'>): ResourceFactsView {
  const models = runnable(seat);
  const first = models[0]?.id ?? null;
  return {
    tier: seatTier(seat.engine, first),
    basis: seat.costBasis ?? costBasisOf(seat.engine, { modelId: first }),
    models: models.map((m) => m.label),
    reserve: null,
  };
}

/**
 * The facts for a PROVIDER card that covers several seats (Devin cloud + CLI,
 * the local runtime): the best tier any of them offers, and every cost basis
 * worded once ("credits · subscription").
 */
export function mergedFacts(seats: ReadonlyArray<Pick<VerseSeat, 'engine' | 'models' | 'costBasis'>>): ResourceFactsView | null {
  if (seats.length === 0) return null;
  const all = seats.map(seatFacts);
  const tier = all.reduce<ResourceTier>((best, f) => (tierRank(f.tier) < tierRank(best) ? f.tier : best), all[0]!.tier);
  return { tier, basis: all[0]!.basis, models: all.flatMap((f) => f.models), reserve: null };
}

/** Every cost basis a provider card spans, in first-seen order. */
export function costBases(seats: ReadonlyArray<Pick<VerseSeat, 'engine' | 'models' | 'costBasis'>>): CostBasis[] {
  return [...new Set(seats.map((s) => seatFacts(s).basis))];
}

/** One card in a tier section, ranked by status the same way for every provider. */
export interface TierEntry<K extends string = string> {
  key: K;
  tier: ResourceTier;
  /** `accountStatusRank` of the card's status; lower = more usable. */
  statusRank: number;
  /** 0 subscription / free, 1 credits / per-token — the router's marginal-cost rule. */
  marginal: number;
  index: number;
}

/**
 * Cards per tier, best tier first; inside a tier usable before not, a
 * subscription before a metered balance, then the caller's order. Empty tiers
 * are dropped. No provider is named anywhere in this ordering.
 */
export function groupByTier<E extends TierEntry>(entries: readonly E[]): Array<{ tier: ResourceTier; entries: E[] }> {
  const tiers: ResourceTier[] = ['elite', 'fast', 'free'];
  return tiers
    .map((tier) => ({
      tier,
      entries: entries
        .filter((e) => e.tier === tier)
        .sort((a, b) => a.statusRank - b.statusRank || a.marginal - b.marginal || a.index - b.index),
    }))
    .filter((g) => g.entries.length > 0);
}

/** A status rank for a card that has no capacity row (cloud credits, Devin): from its Chat verdict. */
export function readinessStatusRank(chatReady: boolean | null): number {
  if (chatReady === null) return accountStatusRank('not-checked');
  return accountStatusRank(chatReady ? 'usable' : 'unavailable');
}

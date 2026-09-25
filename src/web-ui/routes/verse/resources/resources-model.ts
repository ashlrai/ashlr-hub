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
import type { ServingRuntimeSnapshot } from '../../../data/api-types.js';
import { accountStatus, type AccountStatusKind, type CapacityRow } from '../usage/capacity-strip-model.js';
import { formatContext, type LocalModelRow } from '../usage/local-model.js';

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
  ['usable', 'usable'],
  ['low', 'running low'],
  ['spent', 'spent'],
  ['signed-out', 'signed out'],
  ['unavailable', 'unavailable'],
];

/** The paid accounts, reduced to one tone and one sentence. Local seats have no quota to run out of. */
export function summarizeResources(rows: readonly CapacityRow[], opts: { healthRead: boolean; now?: number }): ResourcesSummary {
  const kinds = rows
    .filter((r) => r.kind === 'subscription')
    .map((r) => accountStatus(r, { healthRead: opts.healthRead, ...(opts.now !== undefined ? { now: opts.now } : {}) }).kind);
  const counts = new Map<AccountStatusKind, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const spoken = COUNT_WORDS.filter(([k]) => counts.has(k))
    .map(([k, word]) => `${counts.get(k)} ${word}`)
    .join(' · ');
  let tone: ResourcesTone = 'unknown';
  if (kinds.some((k) => ALERT_KINDS.has(k))) tone = 'alert';
  else if (kinds.includes('low')) tone = 'tight';
  else if (kinds.includes('usable')) tone = 'ok';
  return { tone, spoken: spoken || (kinds.length === 0 ? 'no accounts connected' : 'not read yet') };
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

const DEFAULT_ESTIMATE_NOTE = 'An estimate from the sessions Verse launched — the real balance is on claude.ai.';

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

/** "$212" / "$3.50" — whole dollars once the cents stop mattering. */
export function formatUsd(value: number): string {
  const v = Math.max(0, value);
  return v >= 100 || Number.isInteger(v) ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
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
  if (runtime.model) parts.push(runtime.model);
  // Per-slot context, the number one agent actually gets (fleet-types.ts).
  if (runtime.contextTokens !== null) parts.push(`${formatContext(runtime.contextTokens)} context per agent`);
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
  if (configured !== null && row.contextTruncated && native !== null) return `${formatContext(configured)} of ${formatContext(native)} context`;
  if (configured !== null) return `${formatContext(configured)} context`;
  if (native !== null) return `${formatContext(native)} context`;
  return null;
}

/** How many models the drawer lists before pointing at Usage for the rest. */
export const LOCAL_MODELS_SHOWN = 6;

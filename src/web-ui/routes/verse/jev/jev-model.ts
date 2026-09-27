/**
 * routes/verse/jev/jev-model.ts — pure helpers behind the Jev card
 * (Resources ⌘.) and the Jev panel (Usage). Server: core/decide/jev-api.ts.
 *
 * Narrowing is strict on the fields the views read: an unknown shape renders
 * "Unrecognized response" rather than a guessed number. Dollar figures are an
 * ESTIMATE (placeholder per-token rates until TypeSafe publishes pricing) and
 * every view says so.
 */
import type { JevResponse } from '../../../../core/decide/jev-types.js';
import type { JevKindStats, JevStatus } from '../../../../core/decide/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || num(v);

function isKindStats(v: unknown): v is JevKindStats {
  return isRecord(v) && typeof v['kind'] === 'string' && num(v['decisions']) && num(v['jev']) && num(v['fallback'])
    && num(v['calls']) && numOrNull(v['avgConfidence']) && num(v['fallbackRate']) && num(v['estCostUsd'])
    && numOrNull(v['avgLatencyMs']) && Array.isArray(v['topFallbackReasons']);
}

function isStatus(v: unknown): v is JevStatus {
  return isRecord(v) && typeof v['enabled'] === 'boolean' && typeof v['keyed'] === 'boolean' && typeof v['day'] === 'string'
    && num(v['decisionsToday']) && num(v['callsToday']) && num(v['dailyCallBudget']) && num(v['estCostUsdToday'])
    && num(v['fallbackRateToday']) && numOrNull(v['avgConfidenceToday']) && numOrNull(v['avgLatencyMsToday'])
    && Array.isArray(v['byKind']) && v['byKind'].every(isKindStats);
}

export function narrowJevResponse(raw: unknown): JevResponse | null {
  if (!isRecord(raw) || typeof raw['generatedAt'] !== 'string' || !isStatus(raw['status']) || !Array.isArray(raw['kinds'])) return null;
  return raw as unknown as JevResponse;
}

export type JevTone = 'success' | 'warning' | 'neutral';

export function jevHeadline(status: JevStatus): { word: string; tone: JevTone; detail: string } {
  if (!status.enabled) return { word: 'Off', tone: 'neutral', detail: `Switched off (${status.disabledBy ?? 'kill switch'}). Every decision uses its deterministic rule.` };
  if (!status.keyed) {
    return {
      word: 'Not set up',
      tone: 'neutral',
      detail: 'No TypeSafe key. Every decision uses its deterministic rule. Add TYPESAFE_API_KEY to ~/.ashlr/secrets/typesafe.env (mode 0600) in a terminal.',
    };
  }
  if (status.callsToday >= status.dailyCallBudget) return { word: 'Budget spent', tone: 'warning', detail: 'Today\'s call budget is used up; decisions fall back until tomorrow.' };
  return { word: 'On', tone: 'success', detail: 'Typed decisions with calibrated confidence; below each gate the deterministic rule decides.' };
}

export function formatPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return '—';
  return `${Math.round(fraction * 100)}%`;
}

export function formatConfidence(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(2);
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "12 decisions · 5 calls · 42% fell back" */
export function jevTodayLine(status: JevStatus): string {
  const d = status.decisionsToday;
  if (d === 0) return 'No decisions yet today.';
  return `${d} decision${d === 1 ? '' : 's'} · ${status.callsToday} call${status.callsToday === 1 ? '' : 's'} · ${formatPercent(status.fallbackRateToday)} fell back`;
}

export const JEV_ESTIMATE_NOTE = 'Cost is an estimate from token counts at placeholder rates (set real rates in ~/.ashlr/jev/config.json).';

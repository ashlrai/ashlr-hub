/**
 * routes/verse/jev/jev-model.ts — pure helpers behind the Jev card
 * (Resources ⌘.) and the Jev panel (Usage). Server: core/decide/jev-api.ts.
 *
 * Narrowing is strict on the fields the views read: an unknown shape renders
 * "Unrecognized response" rather than a guessed number. Dollar figures are
 * estimates from recorded usage and pricing; missing coverage stays unknown.
 */
import { formatMetric, formatMetricUsd } from '../../../components/charts/format-metric.js';
import type { JevResponse } from '../../../../core/decide/jev-types.js';
import type { JevKindStats, JevStatus } from '../../../../core/decide/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || num(v);
const count = (v: unknown): v is number => num(v) && Number.isSafeInteger(v) && v >= 0;
const countOrNull = (v: unknown): v is number | null => v === null || count(v);
const costOrNull = (v: unknown): v is number | null => v === null || num(v) && v >= 0;
const fraction = (v: unknown): v is number => num(v) && v >= 0 && v <= 1;
function optionalCoverage(v: unknown, first: string, source = false): boolean {
  return v === undefined || isRecord(v) && count(v[first]) && count(v['unknownCalls'])
    && (!source || v['source'] === 'recorded-estimates');
}

function isKindStats(v: unknown): v is JevKindStats {
  return isRecord(v) && typeof v['kind'] === 'string' && count(v['decisions']) && count(v['jev']) && count(v['fallback'])
    && count(v['calls']) && count(v['cached']) && numOrNull(v['avgConfidence']) && fraction(v['fallbackRate']) && costOrNull(v['estCostUsd'])
    && numOrNull(v['avgLatencyMs']) && Array.isArray(v['topFallbackReasons']);
}

function isStatus(v: unknown): v is JevStatus {
  return isRecord(v) && typeof v['enabled'] === 'boolean' && typeof v['keyed'] === 'boolean' && typeof v['day'] === 'string'
    && count(v['decisionsToday']) && count(v['callsToday']) && countOrNull(v['dailyCallBudget']) && costOrNull(v['estCostUsdToday'])
    && fraction(v['fallbackRateToday']) && numOrNull(v['avgConfidenceToday']) && numOrNull(v['avgLatencyMsToday'])
    && (v['inputTokensToday'] === undefined || countOrNull(v['inputTokensToday']))
    && (v['outputTokensToday'] === undefined || countOrNull(v['outputTokensToday']))
    && optionalCoverage(v['costCoverage'], 'pricedCalls', true) && optionalCoverage(v['usageCoverage'], 'reportedCalls')
    && (v['lastSuccessfulCallAt'] === undefined || v['lastSuccessfulCallAt'] === null || typeof v['lastSuccessfulCallAt'] === 'string'
      && v['lastSuccessfulCallAt'].length <= 64 && Number.isFinite(Date.parse(v['lastSuccessfulCallAt'])))
    && Array.isArray(v['byKind']) && v['byKind'].length <= 128 && v['byKind'].every(isKindStats);
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
  if (status.dailyCallBudget !== null && status.callsToday >= status.dailyCallBudget) return { word: 'Budget spent', tone: 'warning', detail: 'Today\'s call budget is used up; decisions fall back until tomorrow.' };
  return { word: 'Configured', tone: 'neutral', detail: 'Typed decisions when available; the deterministic rule remains the fallback. Configuration is not a live connection check.' };
}

export function formatPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return '—';
  return `${formatMetric(fraction * 100)}%`;
}

export function formatConfidence(value: number | null): string {
  return formatMetric(value);
}

export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return 'unknown';
  return formatMetricUsd(value);
}

export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${formatMetric(ms)} ms` : `${formatMetric(ms / 1000)} s`;
}

/** "12 decisions · 5 calls · 42% fell back" */
export function jevTodayLine(status: JevStatus): string {
  const d = status.decisionsToday;
  if (d === 0) return 'No decisions yet today.';
  return `${formatMetric(d)} decision${d === 1 ? '' : 's'} · ${formatMetric(status.callsToday)} call${status.callsToday === 1 ? '' : 's'} · ${formatPercent(status.fallbackRateToday)} fell back`;
}

/** New evidence is optional on older servers. Do not manufacture successful calls or price coverage. */
export function jevEvidenceLines(status: JevStatus): string[] {
  const raw = status as unknown as Record<string, unknown>;
  const lines = [`${formatMetric(status.byKind.reduce((n, k) => n + k.cached, 0))} cached decisions · ${formatMetric(status.byKind.reduce((n, k) => n + k.fallback, 0))} deterministic fallbacks today.`];
  const success = raw['lastSuccessfulCallAt'];
  lines.push(success === null ? 'No successful Jev call recorded in available history.'
    : typeof success === 'string' && Number.isFinite(Date.parse(success)) ? `Last successful call: ${new Date(success).toLocaleString()}. Historical evidence, not a live connection check.`
      : 'Successful-call history unavailable on this server.');
  const coverage = raw['costCoverage'];
  if (isRecord(coverage) && count(coverage['pricedCalls']) && count(coverage['unknownCalls'])) {
    lines.push(`Estimated cost ${formatUsd(status.estCostUsdToday)} · ${formatMetric(coverage['pricedCalls'])} recorded cost estimates · ${formatMetric(coverage['unknownCalls'])} calls with unknown cost.`);
  } else lines.push(`Estimated cost ${formatUsd(status.estCostUsdToday)} · price coverage unavailable on this server.`);
  const usage = raw['usageCoverage'];
  if (isRecord(usage) && count(usage['reportedCalls']) && count(usage['unknownCalls'])) {
    const input = raw['inputTokensToday'], output = raw['outputTokensToday'];
    lines.push(`Reported input/output tokens: ${count(input) ? formatMetric(input) : 'unknown'} / ${count(output) ? formatMetric(output) : 'unknown'} · ${formatMetric(usage['reportedCalls'])} calls with usage · ${formatMetric(usage['unknownCalls'])} calls with unknown usage.`);
  }
  return lines;
}

export const JEV_ESTIMATE_NOTE = 'Recorded cost estimates; new calls use published concrete-model or configured operator rates. Historical rates may be unverified. Missing usage or pricing stays unknown.';

export function jevSnapshotLine(generatedAt: string): string {
  const time = Date.parse(generatedAt);
  return Number.isFinite(time) ? `Snapshot read ${new Date(time).toLocaleString()}.` : 'Snapshot reading time unavailable.';
}

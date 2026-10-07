import type { LocalModelBadge, LocalWarmResult } from '../../../../core/verse/multimodel/types.js';
import { formatMetric } from '../../../components/charts/format-metric.js';

/** Historical measurements have an age, never an implied live readiness state. */
function localSpeedParts(badge: LocalModelBadge, sampledAt: string): { rate: string; scope: string; when: string } | null {
  if (badge.tokPerSec === null || !Number.isFinite(badge.tokPerSec) || badge.tokPerSec <= 0) return null;
  const scope = badge.tokPerSecScope === 'warm-decode' ? 'warm-up decode' : badge.tokPerSecScope === 'warm-end-to-end'
    ? 'warm-up, end to end' : badge.tokPerSecScope === 'turn-end-to-end' ? 'last turn, end to end'
      : badge.tokPerSecSource === 'warm' ? 'warm-up' : 'end to end';
  const age = Date.parse(sampledAt) - Date.parse(badge.tokPerSecObservedAt ?? '');
  let when = 'age unavailable';
  if (Number.isFinite(age) && age >= 0) {
    when = age < 60_000 ? 'just measured' : age < 3_600_000 ? `${formatMetric(age / 60_000)} min ago`
      : age < 86_400_000 ? `${formatMetric(age / 3_600_000)} h ago` : `${formatMetric(age / 86_400_000)} d ago`;
  }
  return { rate: `${formatMetric(badge.tokPerSec)} tok/s`, scope, when };
}
export function localSpeedReadout(badge: LocalModelBadge, sampledAt: string): string {
  const parts = localSpeedParts(badge, sampledAt);
  return parts ? `${parts.rate} · ${parts.scope} · ${parts.when}` : 'speed not measured yet';
}
export function localSpeedCompactReadout(badge: LocalModelBadge, sampledAt: string): string {
  const parts = localSpeedParts(badge, sampledAt);
  return parts ? `${parts.rate} · ${parts.when}` : 'speed not measured yet';
}
export function localWarmReadout(result: LocalWarmResult): string {
  return `Warm${result.tokPerSec !== null && Number.isFinite(result.tokPerSec) && result.tokPerSec > 0 ? ` — ${formatMetric(result.tokPerSec)} tok/s${result.tokPerSecScope === 'warm-end-to-end' ? ' (end to end)' : result.tokPerSecScope === 'warm-decode' ? ' (decode)' : ''}` : ''}${result.loadMs !== null && Number.isFinite(result.loadMs) && result.loadMs >= 0 ? `, loaded in ${formatMetric(result.loadMs / 1000)} s` : ''}.`;
}

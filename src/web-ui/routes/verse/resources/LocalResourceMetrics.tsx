import type { LocalModelBadge } from '../../../../core/verse/multimodel/types.js';
import { formatMetric } from '../../../components/charts/format-metric.js';
import { formatContextWindow } from '../verse-model.js';
import { localSpeedReadout } from '../multimodel/local-speed-readout.js';
import { formatBytes, localStaleness, type LocalModelsView } from '../usage/local-model.js';
import type { LocalModelsSnapshot } from '../usage/usage-contract.js';
import styles from './ResourcesDrawer.module.css';

function age(at: string | null | undefined, now: number): string {
  const elapsed = now - Date.parse(at ?? '');
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'age unavailable';
  return elapsed < 60_000 ? 'just measured' : elapsed < 3_600_000 ? `${formatMetric(elapsed / 60_000)} min ago`
    : elapsed < 86_400_000 ? `${formatMetric(elapsed / 3_600_000)} h ago` : `${formatMetric(elapsed / 86_400_000)} d ago`;
}

/** Do not join speed to installed-model labels: only the backend knows its endpoint binding. */
export function speedEvidence(raw: unknown): LocalModelBadge[] {
  if (!Array.isArray(raw)) return [];
  const rows = raw.filter((value): value is LocalModelBadge => value !== null && typeof value === 'object' &&
    typeof value.seatId === 'string' && value.seatId.length > 0 && typeof value.model === 'string' && value.model.length > 0 &&
    (value.contextWindow === null || Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0));
  // A conflicting identity is not evidence to pick one of its readings arbitrarily.
  return rows.filter(row => rows.filter(other => other.seatId === row.seatId).length === 1);
}

export function LocalResourceMetrics({ snapshot, view, local, speedAvailable, now }: {
  snapshot: LocalModelsSnapshot | null; view: LocalModelsView | null; local: unknown; speedAvailable: boolean; now: number;
}) {
  const stale = localStaleness(view?.runtimes ?? []);
  const speeds = speedEvidence(local);
  return <div aria-label="Local resource metrics">
    <p className={styles.subtle}>Host RAM · {formatBytes(snapshot?.memoryBudgetBytes ?? null)} total · {formatBytes(snapshot?.freeMemoryBytes ?? null)} OS free · {age(snapshot?.sampledAt, now)}</p>
    <p className={styles.subtle}>Host CPU · {snapshot?.cpu
      ? `${formatMetric(snapshot.cpu.usedPercent)}% across all cores · ${formatMetric(snapshot.cpu.intervalMs / 1000)} s interval`
      : 'not measured yet'} · {age(snapshot?.sampledAt, now)}</p>
    <p className={styles.subtle}>Model residency · {view === null || !view.reachable || view.residentBytes === null
      ? 'unknown' : `${formatBytes(view.residentBytes)} reported by Ollama / LM Studio`}
      {stale.stale ? ` · retained reading (${stale.staleForMs === null ? 'age unavailable' : `${formatMetric(stale.staleForMs / 1000)} s old`})` : ''}</p>
    <p className={styles.subtle}>llama-server resident memory is not reported. OS free RAM and model residency are separate readings.</p>
    <details><summary>Measured local speed</summary>
      <p className={styles.subtle}>Historical evidence by resource, model and context. Decode speed and end-to-end turns measure different work.</p>
      {!speedAvailable ? <p className={styles.subtle}>Speed evidence unavailable.</p> : speeds.length === 0 ? <p className={styles.subtle}>No bound local speed readings.</p> : <ul aria-label="Local speed evidence">
        {speeds.map(badge => <li key={badge.seatId}>
          <span>{badge.model} · {badge.seatId} · {formatContextWindow(badge.contextWindow)} context</span>
          <p className={styles.subtle}>{badge.contextWindow !== null && ['warm-decode', 'warm-end-to-end', 'turn-end-to-end'].includes(badge.tokPerSecScope ?? '')
            ? localSpeedReadout(badge, new Date(now).toISOString()) : 'speed not measured yet (binding or measurement scope unavailable)'}</p>
        </li>)}
      </ul>}
    </details>
  </div>;
}

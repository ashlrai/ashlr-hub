import type { LocalCompletedTurnMetrics, LocalModelBadge } from '../../../../core/verse/multimodel/types.js';
import { formatMetric } from '../../../components/charts/format-metric.js';
import { formatContextWindow } from '../verse-model.js';
import { localSpeedReadout } from '../multimodel/local-speed-readout.js';
import { formatBytes, localStaleness, type LocalModelsView } from '../usage/local-model.js';
import type { LocalModelsSnapshot } from '../usage/usage-contract.js';
import { localObservationAge } from './resources-model.js';
import styles from './ResourcesDrawer.module.css';

/** Do not join speed to installed-model labels: only the backend knows its endpoint binding. */
export function speedEvidence(raw: unknown): LocalModelBadge[] {
  if (!Array.isArray(raw)) return [];
  const rows = raw.filter((value): value is LocalModelBadge => value !== null && typeof value === 'object' &&
    typeof value.seatId === 'string' && value.seatId.length > 0 && typeof value.model === 'string' && value.model.length > 0 &&
    (value.contextWindow === null || Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0));
  // A conflicting identity is not evidence to pick one of its readings arbitrarily.
  return rows.filter(row => rows.filter(other => other.seatId === row.seatId).length === 1);
}

/** The read DTO is additive; old, malformed or differently bound facts stay unknown. */
function completedTurn(badge: LocalModelBadge, now: number): LocalCompletedTurnMetrics | null {
  const value = badge.completedTurn;
  if (!value || value.scope !== 'turn-end-to-end' || value.contextWindow !== badge.contextWindow ||
      !Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0 ||
      !Number.isFinite(value.durationMs) || value.durationMs <= 0 || typeof value.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > now ||
      !Number.isSafeInteger(value.outputTokens) || value.outputTokens <= 0) return null;
  for (const count of [value.inputTokens, value.cacheReadTokens, value.cacheCreationTokens]) {
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) return null;
  }
  return value;
}

export function LocalResourceMetrics({ snapshot, view, local, speedAvailable, now }: {
  snapshot: LocalModelsSnapshot | null; view: LocalModelsView | null; local: unknown; speedAvailable: boolean; now: number;
}) {
  const stale = localStaleness(view?.runtimes ?? []);
  const speeds = speedEvidence(local);
  return <div aria-label="Local resource metrics">
    <p className={styles.subtle}>Host RAM · {formatBytes(snapshot?.memoryBudgetBytes ?? null)} total · {formatBytes(snapshot?.freeMemoryBytes ?? null)} OS free · {localObservationAge(snapshot?.sampledAt, now)}</p>
    <p className={styles.subtle}>Host CPU · {snapshot?.cpu
      ? `${formatMetric(snapshot.cpu.usedPercent)}% across all cores · ${formatMetric(snapshot.cpu.intervalMs / 1000)} s interval`
      : 'not measured yet'} · {localObservationAge(snapshot?.sampledAt, now)}</p>
    <p className={styles.subtle}>Model residency · {view === null || !view.reachable || view.residentBytes === null
      ? 'unknown' : `${formatBytes(view.residentBytes)} reported by Ollama / LM Studio`}
      {stale.stale ? ` · retained reading (${stale.staleForMs === null ? 'age unavailable' : `${formatMetric(stale.staleForMs / 1000)} s old`})` : ''}</p>
    <p className={styles.subtle}>llama-server resident memory is not reported. OS free RAM and model residency are separate readings.</p>
    <details><summary>Measured local speed</summary>
      <p className={styles.subtle}>Historical evidence by resource, model and context. Decode speed and end-to-end turns measure different work. Recorded turn duration includes tools; missing token counts stay unknown.</p>
      {!speedAvailable ? <p className={styles.subtle}>Speed evidence unavailable.</p> : speeds.length === 0 ? <p className={styles.subtle}>No bound local speed readings.</p> : <ul aria-label="Local speed evidence">
        {speeds.map(badge => {
          const turn = completedTurn(badge, now);
          return <li key={badge.seatId}>
            <span>{badge.model} · {badge.seatId} · {formatContextWindow(badge.contextWindow)} context</span>
            <p className={styles.subtle}>{badge.contextWindow !== null && ['warm-decode', 'warm-end-to-end', 'turn-end-to-end'].includes(badge.tokPerSecScope ?? '')
              ? localSpeedReadout(badge, new Date(now).toISOString()) : 'speed not measured yet (binding or measurement scope unavailable)'}</p>
            {turn ? <>
              <p className={styles.subtle}>Recorded turn · {formatMetric(turn.durationMs / 1000)} s · {localObservationAge(turn.observedAt, now)}</p>
              <p className={styles.subtle}>Tokens · {formatMetric(turn.inputTokens)} input · {formatMetric(turn.outputTokens)} output · {formatMetric(turn.cacheReadTokens)} cache read · {formatMetric(turn.cacheCreationTokens)} cache write</p>
            </> : <p className={styles.subtle}>Completed-turn details unavailable.</p>}
          </li>;
        })}
      </ul>}
    </details>
  </div>;
}

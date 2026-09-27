/**
 * routes/verse/jev/JevPanel.tsx — "Jev decisions" in Usage (3.15; mounted by
 * sections/UsageSection.tsx). Today's typed decisions by kind: how many, how
 * many Jev won vs the deterministic fallback, average confidence, estimated
 * cost and latency — so a paid classifier shows up in usage the way engine
 * dispatches do (docs/JEV-INTEGRATION.md rule 5).
 *
 * Renders nothing while the first read is out and nothing on a server
 * without the route (404).
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import usage from '../usage/usage.module.css';
import {
  formatConfidence,
  formatLatency,
  formatPercent,
  formatUsd,
  JEV_ESTIMATE_NOTE,
  jevHeadline,
  jevTodayLine,
} from './jev-model.js';
import { JEV_POLL_MS, jevQuery } from './jev-queries.js';
import styles from './jev.module.css';

export function JevPanel() {
  const read = useQuery(jevQuery);
  const refetch = useRefetch(jevQuery);
  usePollWhileVisible(refetch, JEV_POLL_MS);
  if (!read.data || !read.data.available) return null;
  const body = read.data.value;
  const head = body ? jevHeadline(body.status) : null;
  return (
    <section className={usage.panel} aria-labelledby="verse-usage-jev" data-usage-panel="jev">
      <div className={usage.panelHead}>
        <h3 id="verse-usage-jev" className={usage.panelTitle}>Jev decisions</h3>
        <p className={usage.panelNote}>
          Typed decisions made by TypeSafe&apos;s Jev today, and how often each fell back to its deterministic rule.
        </p>
      </div>
      {!body || !head ? (
        <p className={styles.muted}>{read.data.reason ?? 'Jev did not answer.'}</p>
      ) : (
        <>
          <p className={styles.muted}>
            <strong>{head.word}</strong> — {jevTodayLine(body.status)} · about {formatUsd(body.status.estCostUsdToday)} (estimate)
          </p>
          {body.status.byKind.length > 0 ? (
            <div className={styles.scroll}>
              <table className={styles.kinds} aria-label="Jev decisions today by kind">
                <thead>
                  <tr>
                    <th scope="col">Decision</th>
                    <th scope="col">Count</th>
                    <th scope="col">Jev</th>
                    <th scope="col">Fell back</th>
                    <th scope="col">Avg conf.</th>
                    <th scope="col">Latency</th>
                    <th scope="col">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {body.status.byKind.map((k) => (
                    <tr key={k.kind} data-jev-kind={k.kind}>
                      <td title={k.topFallbackReasons.map((r) => `${r.reason} ×${r.count}`).join(', ') || undefined}>{k.kind}</td>
                      <td>{k.decisions}</td>
                      <td>{k.jev}</td>
                      <td>{formatPercent(k.fallbackRate)}</td>
                      <td>{formatConfidence(k.avgConfidence)}</td>
                      <td>{formatLatency(k.avgLatencyMs)}</td>
                      <td>{formatUsd(k.estCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className={styles.muted}>{JEV_ESTIMATE_NOTE}</p>
        </>
      )}
    </section>
  );
}

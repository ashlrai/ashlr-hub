/**
 * routes/verse/resources/JevResource.tsx — Jev (TypeSafe AI's System One
 * decision model) in the Resources drawer (⌘.) (3.15).
 *
 * Shows whether the decision layer is on, today's decisions / API attempts /
 * fallback rate, average confidence, estimated cost and latency. A server
 * without the route (404) renders nothing. Setting up happens in a terminal
 * (the key lives in ~/.ashlr/secrets/typesafe.env): the page never takes one.
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { MonogramTile } from '../apps/MonogramTile.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { formatConfidence, formatLatency, JEV_ESTIMATE_NOTE, jevEvidenceLines, jevHeadline, jevSnapshotLine, jevTodayLine } from '../jev/jev-model.js';
import { JEV_POLL_MS, jevQuery } from '../jev/jev-queries.js';
import styles from './ResourcesDrawer.module.css';

export function JevResource() {
  const read = useQuery(jevQuery);
  const refetch = useRefetch(jevQuery);
  usePollWhileVisible(refetch, JEV_POLL_MS);
  if (read.data === undefined && read.status !== 'error') {
    return (
      <li className={styles.card} data-resource="jev" data-jev="loading">
        <p className={styles.subtle} aria-busy="true">Reading Jev…</p>
      </li>
    );
  }
  if (!read.data?.available) return null;
  const body = read.data.value;
  if (!body) {
    return (
      <li className={styles.card} data-resource="jev" data-jev="unrecognised">
        <p className={styles.subtle}>{read.data.reason ?? 'Unrecognized response — update Ashlr.'}</p>
      </li>
    );
  }
  const { status } = body;
  const head = jevHeadline(status);
  const active = status.enabled && status.keyed;
  const top = status.byKind.slice(0, 4);
  return (
    <li className={styles.card} data-resource="jev" data-jev={active ? 'on' : 'off'}>
      <div className={styles.cardHead}>
        <MonogramTile monogram="Jv" engine={null} size="sm" />
        <h4 className={styles.cardName}>
          <span>Jev</span>
          <span className={styles.plan}>TypeSafe AI</span>
        </h4>
      </div>
      <p className={styles.status} data-tone={head.tone} title={head.detail}>
        <span className={styles.statusDot} aria-hidden="true" />
        <span className={styles.statusLabel}>{head.word}</span>
      </p>
      <p className={styles.subtle}>{head.detail}</p>
      <p className={styles.stamp}>{read.status === 'error' ? 'Refresh unavailable · showing the last snapshot.' : jevSnapshotLine(body.generatedAt)}</p>
      {active || status.decisionsToday > 0 ? (
        <>
          <p className={styles.subtle} data-jev-today>{jevTodayLine(status)}</p>
          <p className={styles.subtle}>
            avg confidence {formatConfidence(status.avgConfidenceToday)} · {formatLatency(status.avgLatencyMsToday)}
            <span className={styles.pill} data-tone="neutral" title={JEV_ESTIMATE_NOTE}>estimate</span>
          </p>
          <details className={styles.usageDetails}>
            <summary>Decision evidence</summary>
            <div className={styles.usageDetailBody}>
              {jevEvidenceLines(status).map((line) => <p key={line}>{line}</p>)}
            </div>
          </details>
          {top.length > 0 ? (
            <ul className={styles.subtle} aria-label="Jev decisions today by kind">
              {top.map((k) => (
                <li key={k.kind} data-jev-kind={k.kind}>
                  {k.kind}: {k.decisions} · {k.jev} by Jev · conf {formatConfidence(k.avgConfidence)}
                </li>
              ))}
            </ul>
          ) : null}
          <p className={styles.fine}>{status.dailyCallBudget === null
            ? `${status.callsToday} API call attempts today · no call-count preference`
            : `${status.callsToday} of ${status.dailyCallBudget} API call attempts today`}. <code>ashlr jev status</code> for the full table.</p>
        </>
      ) : null}
    </li>
  );
}

/**
 * routes/verse/usage/LimitsPanel.tsx — dispatch-ledger usage against each
 * configured foundry limit.
 *
 * This is where the ledger-derived numbers belong, and they are labeled as
 * what they are: calls counted against a cap the operator configured, NOT
 * subscription utilization. A limit that owner B's /api/verse/control reports
 * as configured but for which /api/control has no reading renders as
 * "configured · no reading" with no bar — the same rule the window meters
 * follow.
 */
import type { ReactNode } from 'react';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { chartFormat } from '../../../components/charts/index.js';
import type { UsageLimitRow } from './usage-model.js';
import styles from './usage.module.css';

function standingTone(standing: UsageLimitRow['standing']): Tone {
  switch (standing) {
    case 'ok':
      return 'success';
    case 'warn':
      return 'warning';
    case 'over':
      return 'danger';
    case 'unlimited':
      return 'neutral';
    default:
      return 'unknown';
  }
}

export function LimitsPanel({
  rows,
  capsNote,
}: {
  rows: readonly UsageLimitRow[];
  capsNote: string | null;
}): ReactNode {
  return (
    <section className={styles.panel} aria-labelledby="verse-usage-limits">
      <div className={styles.panelHead}>
        <h3 id="verse-usage-limits" className={styles.panelTitle}>
          Dispatch limits
        </h3>
        <p className={styles.panelNote}>
          Calls recorded in the dispatch ledger against each configured foundry cap. This is not
          subscription utilization.
        </p>
      </div>

      {capsNote ? <p className={styles.muted}>{capsNote}</p> : null}

      {rows.length === 0 ? (
        <p className={styles.muted}>
          No foundry limits are configured, so dispatches are uncapped on this machine. Nothing here is
          being throttled.
        </p>
      ) : (
        <div className={styles.limitList}>
          {rows.map((row) => (
            <div key={row.id} className={styles.limitRow}>
              <span className={styles.limitName}>
                {row.backend}
                <span className={styles.limitWindow}>per {row.window}</span>
                <StatusBadge status={row.standing} tone={standingTone(row.standing)}>
                  {row.standing === 'unknown' ? 'no reading' : row.standing}
                </StatusBadge>
              </span>
              {row.usedPct === null ? (
                <hr className={styles.unknownRule} aria-hidden="true" />
              ) : (
                <div
                  className={styles.track}
                  data-tone={row.usedPct >= 100 ? 'danger' : row.usedPct >= 80 ? 'warn' : 'ok'}
                  role="meter"
                  aria-label={`${row.backend} dispatches against its ${row.window} cap`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(row.usedPct)}
                >
                  <div className={styles.fill} style={{ width: `${Math.round(row.usedPct)}%` }} />
                </div>
              )}
              <span className={styles.limitValue}>
                {row.used === null
                  ? `configured ${chartFormat.formatCompact(row.max)}`
                  : `${chartFormat.formatCompact(row.used)} / ${chartFormat.formatCompact(row.max)}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

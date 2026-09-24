/**
 * routes/verse/usage/WindowMeter.tsx — one quota window, rendered so that a
 * glancing reader cannot misread it.
 *
 * Four visually distinct outcomes, and no two of them look alike:
 *
 *   measured        → a real bar, a real percentage, and the provider's own
 *                     reset text VERBATIM (Claude's reset is prose, not a
 *                     timestamp, and is never turned into a countdown).
 *   limit reached   → a full bar in the danger tone labelled "limit reached".
 *                     The upstream writes a SENTINEL 100 for this, so no
 *                     percentage is printed and no numeric value is announced
 *                     to assistive tech — it is a flag, not a measurement.
 *   unknown         → the shared <Epistemic/> unknown treatment plus a dashed
 *                     rule (absence), and a one-line reason. NEVER a bar:
 *                     an empty bar reads "plenty left" and a full one reads
 *                     "exhausted", and both are lies when there is no signal.
 *   not applicable  → a plain sentence.
 *
 * `prominent` is the binding constraint — the window with the highest used
 * percent, which is the one that actually blocks work.
 */
import type { ReactNode } from 'react';
import { Epistemic } from '../../../components/primitives/Epistemic.js';
import type { WindowView } from './accounts-model.js';
import { percentText } from './capacity-strip-model.js';
import { unknownQuality } from './usage-model.js';
import styles from './usage.module.css';

export function WindowMeter({
  view,
  ariaPrefix,
  prominent = false,
}: {
  view: WindowView;
  /** Account label, so every meter has a unique accessible name. */
  ariaPrefix: string;
  prominent?: boolean;
}): ReactNode {
  const name = `${ariaPrefix} ${view.label}`;

  if (view.limitReached) {
    return (
      <div className={prominent ? styles.windowBlockLead : styles.windowBlock}>
        <div className={styles.windowHead}>
          <span>{view.label}</span>
          <span className={styles.windowFlag}>limit reached</span>
        </div>
        <div
          className={styles.track}
          data-tone="danger"
          role="img"
          aria-label={`${name}: the provider flagged this window as rate-limited, so no percentage is shown`}
        >
          <div className={styles.fill} style={{ width: '100%' }} />
        </div>
        {view.resetText ? <p className={styles.windowReset}>{view.resetText}</p> : null}
      </div>
    );
  }

  if (view.usedPct === null) {
    return (
      <div className={prominent ? styles.windowBlockLead : styles.windowBlock}>
        <div className={styles.windowHead}>
          <span>{view.label}</span>
          <Epistemic quality={unknownQuality('No percentage was reported for this window.')} label={name}>
            {null}
          </Epistemic>
        </div>
        <hr className={styles.unknownRule} aria-hidden="true" />
      </div>
    );
  }

  const pct = Math.round(view.usedPct);
  return (
    <div className={prominent ? styles.windowBlockLead : styles.windowBlock}>
      <div className={styles.windowHead}>
        <span>{view.label}</span>
        <span className={styles.windowPct}>{percentText(view.usedPct)}</span>
      </div>
      <div
        className={styles.track}
        data-tone={view.tone}
        role="meter"
        aria-label={`${name} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${percentText(view.usedPct)} used${view.resetText ? `, ${view.resetText}` : ''}`}
      >
        <div className={styles.fill} style={{ width: `${pct}%` }} />
      </div>
      {view.resetText ? <p className={styles.windowReset}>{view.resetText}</p> : null}
    </div>
  );
}

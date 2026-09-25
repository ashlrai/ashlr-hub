/**
 * routes/verse/SeatCapacity.tsx — the shared rendering of a seat's
 * subscription capacity, so the resources panel, the new-chat dialog and the
 * chat header cannot describe the same seat three different ways.
 *
 * Three pieces, each one a rule from docs/VERSE-DESIGN-V2.md §6 and
 * docs/VERSE-TELEMETRY-V2.md made concrete:
 *
 *   <CapacityChip>      the four-word verdict. Always the WORD, never colour
 *                       alone; the dot is decoration on top of the word.
 *   <SeatWindowMeter>   one quota window. A measured window gets a real
 *                       <Meter>; a flagged limit gets a full danger meter
 *                       labelled "limit reached" and NO percentage, because
 *                       the sentinel 100 upstream is a flag rather than a
 *                       reading; an unread window gets a dashed rule and a
 *                       sentence, never a bar — an empty bar reads "plenty
 *                       left" and a full one reads "exhausted", and both are
 *                       lies when nothing was measured.
 *   <SeatCapacityNote>  plan · verdict · binding meter · reset · credits, for
 *                       the surfaces that show one seat at a time.
 *
 * Reset text is rendered VERBATIM. Claude publishes a sentence
 * ("resets Sep 25 at 7pm (America/New_York)") and `resetsAt` is structurally
 * null for it, so nothing here parses a reset or turns one into a countdown.
 */
import type { ReactNode } from 'react';
import type { VerseSeat } from '../../data/api-types.js';
import { Meter } from '../../components/primitives/Meter.js';
import { percentText } from './autonomy/format.js';
import {
  seatSubscription,
  type SeatCapacityClass,
  type SeatSubscriptionView,
  type SeatWindowView,
} from './seat-subscription.js';
import styles from './SeatCapacity.module.css';

/**
 * A glyph per class so the state survives greyscale, a colour-blind reader
 * and a screenshot: check (usable), half (tight), bar (blocked), query
 * (no reading). Paired with the word, never standing in for it.
 */
const CLASS_GLYPH: Record<SeatCapacityClass, string> = {
  ready: '✓',
  tight: '◑',
  blocked: '▮',
  unread: '?',
};

export function CapacityChip({
  view,
  title,
}: {
  view: SeatSubscriptionView;
  title?: string;
}): ReactNode {
  return (
    <span className={styles.chip} data-capacity={view.cls} title={title ?? view.summary}>
      <span className={styles.chipGlyph} aria-hidden="true">{CLASS_GLYPH[view.cls]}</span>
      {view.word}
    </span>
  );
}

export function SeatWindowMeter({
  windowView,
  ariaPrefix,
  prominent = false,
}: {
  windowView: SeatWindowView;
  /** Seat label, so every meter on the page has a unique accessible name. */
  ariaPrefix: string;
  /** The binding window — the one that actually constrains work. */
  prominent?: boolean;
}): ReactNode {
  const name = `${ariaPrefix} ${windowView.label}`;

  if (windowView.limitReached) {
    return (
      <div className={prominent ? styles.windowLead : styles.window}>
        <Meter
          value={100}
          max={100}
          tone="danger"
          label={<span className={styles.windowLabel}>{windowView.label}</span>}
          valueText={<span className={styles.flag}>limit reached</span>}
          aria-label={`${name}: the provider flagged this window as rate-limited, so no percentage was measured`}
        />
        {windowView.resetText === null ? null : <p className={styles.reset}>{windowView.resetText}</p>}
      </div>
    );
  }

  if (windowView.usedPercent === null) {
    return (
      <div className={prominent ? styles.windowLead : styles.window}>
        <div className={styles.unknownHead}>
          <span className={styles.windowLabel}>{windowView.label}</span>
          <span className={styles.unknownValue}>no reading</span>
        </div>
        {/* Absence, drawn as absence. Never a 0% bar. */}
        <hr className={styles.unknownRule} aria-hidden="true" />
        {windowView.resetText === null ? null : <p className={styles.reset}>{windowView.resetText}</p>}
      </div>
    );
  }

  return (
    <div className={prominent ? styles.windowLead : styles.window}>
      <Meter
        value={Math.max(0, Math.min(100, windowView.usedPercent))}
        max={100}
        label={<span className={styles.windowLabel}>{windowView.label}</span>}
        valueText={<span className={styles.pct}>{percentText(windowView.usedPercent)}</span>}
        aria-label={`${name} used`}
      />
      {windowView.resetText === null ? null : <p className={styles.reset}>{windowView.resetText}</p>}
    </div>
  );
}

/**
 * One seat's capacity in a few lines, for the surfaces that show a single
 * seat: the new-chat dialog under the picker, and anywhere else a choice is
 * about to be made. Local seats say so instead of being given meters.
 */
export function SeatCapacityNote({ seat, className }: { seat: VerseSeat; className?: string }): ReactNode {
  const view = seatSubscription(seat);
  return (
    <div className={`${styles.note} ${className ?? ''}`} data-capacity={view.cls}>
      <div className={styles.noteHead}>
        <CapacityChip view={view} />
        {view.plan === null ? null : <span className={styles.plan}>{view.plan}</span>}
        <span className={styles.noteSummary}>{view.summary}</span>
      </div>
      {view.binding === null ? null : (
        <SeatWindowMeter windowView={view.binding} ariaPrefix={seat.label} prominent />
      )}
      {view.credits === null ? null : (
        <p className={styles.credits} title={view.creditsTitle ?? undefined}>
          {view.credits} — credits are independent of the window
        </p>
      )}
    </div>
  );
}

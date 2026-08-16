/**
 * routes/journal/JournalTimeline.tsx — the "scrubable" part of the brief: a
 * density strip over the visible window, one bar per hour. Clicking or
 * keyboard-activating a bar jumps the list to the newest entry in that
 * hour. Pure CSS bars, not a canvas/SVG dependency — density is all the
 * signal this needs to carry.
 */
import { bucketByHour, type JournalEntry } from './journal-model.js';
import styles from './JournalTimeline.module.css';

export interface JournalTimelineProps {
  entries: JournalEntry[];
  hours: number;
  onScrubTo: (bucketStartMs: number) => void;
}

export function JournalTimeline({ entries, hours, onScrubTo }: JournalTimelineProps) {
  const buckets = bucketByHour(entries, hours);
  const max = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className={styles.strip} role="group" aria-label={`Activity density over the last ${hours} hours`}>
      {buckets.map((b) => {
        const pct = Math.round((b.count / max) * 100);
        const label = new Date(b.bucketStartMs).toLocaleTimeString(undefined, { hour: 'numeric' });
        return (
          <button
            key={b.bucketStartMs}
            type="button"
            className={styles.bar}
            onClick={() => onScrubTo(b.bucketStartMs)}
            disabled={b.count === 0}
            title={`${label}: ${b.count} entr${b.count === 1 ? 'y' : 'ies'}`}
            aria-label={`${label}: ${b.count} entries`}
          >
            <span className={styles.fill} style={{ height: `${Math.max(pct, b.count > 0 ? 8 : 0)}%` }} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * routes/verse/command/CountdownRing.tsx — a class-B action's veto window as
 * a shrinking ring (r5/visual.md §2 Motion: "Class-B veto: countdown ring
 * drawn as a conic stroke that shrinks once per second").
 *
 * It ticks once a second even under reduced motion — a countdown is
 * information, not decoration (use-ticker.ts) — but it never animates
 * between ticks. The minutes are always written beside it, so the ring is
 * never the only carrier.
 */
import { useNow } from '../autonomy/use-ticker.js';
import { countdownText, vetoWindowFraction } from '../mind/leader-model.js';
import type { LeaderAction } from '../../../../core/vision/leader-types.js';
import styles from './command.module.css';

const R = 8;
const C = 2 * Math.PI * R;

export function CountdownRing({ action }: { action: Pick<LeaderAction, 'status' | 'createdAt' | 'applyAfter' | 'summary'> }) {
  const now = useNow(1000);
  const fraction = vetoWindowFraction(action, now);
  if (fraction === null) return null;
  const text = countdownText(action.applyAfter, now);
  return (
    <span className={styles.ring} role="timer" aria-label={`Applies in ${text} unless vetoed`}>
      <svg width={20} height={20} viewBox="0 0 20 20" aria-hidden="true">
        <circle cx={10} cy={10} r={R} className={styles.ringTrack} />
        <circle
          data-role="remaining"
          cx={10}
          cy={10}
          r={R}
          className={styles.ringFill}
          strokeDasharray={`${(C * fraction).toFixed(2)} ${C.toFixed(2)}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
      <span className={styles.ringText}>{text}</span>
    </span>
  );
}

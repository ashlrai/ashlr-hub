/**
 * routes/verse/command/SeatBurnDowns.tsx — one burn-down per seat (span 3
 * each at 1440; a snap-scrolling strip at 375): remaining capacity in the
 * binding window, the reserve kept for Mason, the projection and the reset
 * (SPEC-310B §6 "BurnDown per seat: reserve band, ceiling, projected
 * exhaustion, reset time").
 *
 * The readings are the ones this viewer has seen since Verse opened (the
 * budget route serves one reading per seat — see command-model.ts), and the
 * card says so. A local seat has no window: it gets a quiet "free" tile, not
 * an empty chart.
 */
import { BurnDown } from '../../../components/charts/BurnDown.js';
import { EngineMarker } from '../../../components/primitives/Tag.js';
import type { SeatBurn } from './command-model.js';
import { CardNote } from './Surface.js';
import styles from './command.module.css';

const WINDOW_WORD = { session: '5-hour', weekly: 'weekly' } as const;

function formatWhen(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function SeatBurnCard({ burn, now, width }: { burn: SeatBurn; now: number; width?: number }) {
  if (burn.free) {
    return (
      <section className={styles.freeSeat} aria-label={`${burn.label}: free local seat`}>
        <span className={styles.freeHead}>
          <EngineMarker engine={burn.engine} />
          <span className={styles.freeTitle}>{burn.label}</span>
        </span>
        <span className={styles.freeValue}>∞</span>
        <span className={styles.freeBody}>Local — free, no provider window. {burn.eligible ? 'Takes autonomous work.' : burn.reason ?? ''}</span>
      </section>
    );
  }
  const title = `${burn.label}${burn.window ? ` · ${WINDOW_WORD[burn.window]}` : ''}`;
  if (burn.window === null || burn.resetAt === null || burn.start === null) {
    return (
      <section className={styles.freeSeat} aria-label={title}>
        <span className={styles.freeHead}>
          <EngineMarker engine={burn.engine} />
          <span className={styles.freeTitle}>{burn.label}</span>
        </span>
        <CardNote tone="unknown">No window reading — unknown usage is never treated as headroom.</CardNote>
      </section>
    );
  }
  return (
    <BurnDown
      title={title}
      description={burn.enabled ? (burn.eligible ? 'Autonomy may use it now' : burn.reason ?? 'Held back from autonomy') : 'Not used by autonomy'}
      caveat={burn.points.length < 2 ? 'Readings since Verse opened — the line fills in as it watches this seat.' : undefined}
      status={burn.points.length === 0 ? { kind: 'empty', message: 'No reading yet in this window.' } : undefined}
      points={burn.points}
      capacity={100}
      start={burn.start}
      resetAt={burn.resetAt}
      now={now}
      reserve={burn.reservePercent > 0 ? { value: burn.reservePercent, label: 'Reserved for you' } : undefined}
      height={160}
      width={width}
      formatValue={(v) => `${Math.round(v)}%`}
      formatTime={formatWhen}
    />
  );
}

export function SeatBurnDowns({ burns, now, compact }: { burns: SeatBurn[]; now: number; compact: boolean }) {
  if (burns.length === 0) {
    return <CardNote tone="unknown">Seat capacity is not available — the budget route did not answer.</CardNote>;
  }
  return (
    <div className={compact ? styles.burnStrip : styles.burnGrid} role="group" aria-label="Capacity per seat">
      {burns.map((b) => (
        <div key={b.seatId} className={styles.burnItem}>
          <SeatBurnCard burn={b} now={now} width={compact ? 300 : undefined} />
        </div>
      ))}
    </div>
  );
}

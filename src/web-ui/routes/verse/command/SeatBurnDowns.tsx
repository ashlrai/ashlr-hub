/**
 * routes/verse/command/SeatBurnDowns.tsx — one burn-down per seat (span 3
 * each at 1440; a snap-scrolling strip at 375): remaining capacity in the
 * binding window, the line autonomy stops at in THAT window (the weekly
 * reserve, or the 5-hour ceiling), the projection and the reset
 * (SPEC-310B §6 "BurnDown per seat: reserve band, ceiling, projected
 * exhaustion, reset time").
 *
 * The readings are the ones this viewer has seen since Verse opened (the
 * budget route serves one reading per seat — see command-model.ts), and the
 * card says so. A local seat has no window: it gets a quiet "free" tile, not
 * an empty chart.
 */
import { AreaTrend } from '../../../components/charts/AreaTrend.js';
import { BurnDown } from '../../../components/charts/BurnDown.js';
import { EngineMarker } from '../../../components/primitives/Tag.js';
import { burnTimeFormat, resetWords, type SeatBurn } from './command-model.js';
import { CardNote } from './Surface.js';
import styles from './command.module.css';

const WINDOW_WORD = { session: '5-hour', weekly: 'weekly' } as const;

/**
 * '∞' as SVG, not text (review 3.10 c18): U+221E is outside the Ashlr Sans
 * Latin subset, so the text glyph made Command fetch the 230 KB full face.
 * Decorative — the sentence beside it says "free".
 */
function InfinityMark() {
  return (
    <svg width="1.6em" height="0.8em" viewBox="0 0 24 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" focusable="false" aria-hidden="true">
      <path d="M6 2.5a3.5 3.5 0 1 0 0 7c2.5 0 3.5-2 6-3.5s3.5-3.5 6-3.5a3.5 3.5 0 1 1 0 7c-2.5 0-3.5-2-6-3.5S8.5 2.5 6 2.5Z" />
    </svg>
  );
}

export function SeatBurnCard({ burn, now, width }: { burn: SeatBurn; now: number; width?: number }) {
  if (burn.free) {
    return (
      <section className={styles.freeSeat} aria-label={`${burn.label}: free local seat`}>
        <span className={styles.freeHead}>
          <EngineMarker engine={burn.engine} />
          <span className={styles.freeTitle}>{burn.label}</span>
        </span>
        <span className={styles.freeValue}>
          <InfinityMark />
        </span>
        <span className={styles.freeBody}>Local — free, no provider window. {burn.eligible ? 'Takes autonomous work.' : burn.reason ?? ''}</span>
      </section>
    );
  }
  const title = `${burn.label}${burn.window ? ` · ${WINDOW_WORD[burn.window]}` : ''}`;
  const eligibility = burn.enabled ? (burn.eligible ? 'Autonomy may use it now' : burn.reason ?? 'Held back from autonomy') : 'Not used by autonomy';
  const pct = (v: number) => `${Math.round(v)}%`;
  const latest = [...burn.points].reverse().find((p) => p.remaining !== null)?.remaining ?? null;
  const noReading = (
    <section className={styles.freeSeat} aria-label={title}>
      <span className={styles.freeHead}>
        <EngineMarker engine={burn.engine} />
        <span className={styles.freeTitle}>{burn.label}</span>
      </span>
      <CardNote tone="unknown">No window reading — unknown usage is never treated as headroom.</CardNote>
    </section>
  );
  if (burn.window === null) return noReading;
  if (burn.resetAt === null || burn.start === null) {
    if (latest === null) return noReading;
    // A window WITH readings but no machine reset time — Claude's normal case
    // (it publishes only a sentence). This used to fall into "No window
    // reading", hiding real readings on the seat that matters most. Draw the
    // readings, write the provider's own reset words, and draw NO reset point
    // or projection: a burn-down to an instant nobody published would be a
    // guess (core/verse/types.ts: never synthesize a countdown from words).
    const reset = burn.resetText ? resetWords(burn.resetText) : 'reset time not reported';
    return (
      <AreaTrend
        title={title}
        description={`${pct(latest)} left · ${reset} · ${eligibility}`}
        caveat={`${burn.resetText ? 'The provider reports this reset only in words' : 'No reset time was reported for this window'}, so nothing is projected to a reset.${burn.points.length < 2 ? ' Readings since Verse opened — the line fills in as it watches this seat.' : ''}`}
        series={[{ id: 'remaining', label: 'Remaining', points: burn.points.map((p) => ({ x: p.t, y: p.remaining })) }]}
        threshold={burn.line ?? undefined}
        height={160}
        width={width}
        formatX={burnTimeFormat(burn.window)}
        formatY={pct}
        ariaLabel={`${title}: ${pct(latest)} left, ${reset}. ${eligibility}.`}
      />
    );
  }
  return (
    <BurnDown
      title={title}
      description={eligibility}
      caveat={burn.points.length < 2 ? 'Readings since Verse opened — the line fills in as it watches this seat.' : undefined}
      status={burn.points.length === 0 ? { kind: 'empty', message: 'No reading yet in this window.' } : undefined}
      points={burn.points}
      capacity={100}
      start={burn.start}
      resetAt={burn.resetAt}
      now={now}
      // The binding window's own stop line (command-model.ts bindingLine), so
      // the verdict under the chart agrees with the server's eligibility.
      reserve={burn.line ?? undefined}
      height={160}
      width={width}
      formatValue={(v) => `${Math.round(v)}%`}
      formatTime={burnTimeFormat(burn.window)}
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

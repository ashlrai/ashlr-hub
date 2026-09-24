/**
 * routes/verse/command/SeatBurnDowns.tsx — one burn-down per seat (span 3
 * each at 1440; a snap-scrolling strip at 375): remaining capacity in the
 * binding window, the line autonomy stops at in THAT window (the weekly
 * reserve, or the 5-hour ceiling), the projection and the reset
 * (SPEC-310B §6 "BurnDown per seat: reserve band, ceiling, projected
 * exhaustion, reset time").
 *
 * Every paid card draws the same frame — 0–100% up the side, the window
 * along the bottom — so the cards compare at a glance:
 *   - reset known (a machine instant, or Claude's words read on their own
 *     clock — command-model `bindingReset`): the whole window, reset − length
 *     → reset, with the even-pace line, the projection and the reset marker;
 *   - reset unknown: the window's length ending NOW, readings and stop line
 *     only — nothing points at an instant nobody published. Never the span of
 *     the handful of readings (a one-minute axis read as a crisis).
 *
 * The line is the server's recorded seat history (GET /api/verse/budget/
 * history) merged with the readings this viewer has seen since Verse opened
 * (command-model `mergeSeatHistory`). When it still starts late in the window
 * the card says why: nothing was recorded earlier, or — with no recorded
 * history — the page has only been watching since it opened. A local seat
 * has no window: it gets a quiet "free" tile, not an empty chart.
 */
import { useRef } from 'react';
import { BurnDown } from '../../../components/charts/BurnDown.js';
import { ChartFrame } from '../../../components/charts/ChartFrame.js';
import { TableView, type TableColumn } from '../../../components/charts/TableView.js';
import { CHART_SEQUENTIAL } from '../../../components/charts/colors.js';
import { areaPath, linePath, linearScale, niceTicks, splitRuns, type BurnPoint } from '../../../components/charts/chart-math.js';
import { useChartWidth } from '../../../components/charts/useChartWidth.js';
import plot from '../../../components/charts/plot.module.css';
import { EngineMarker } from '../../../components/primitives/Tag.js';
import { asClause } from '../autonomy/format.js';
import { asSentence } from '../fleet/why-seat-model.js';
import { WINDOW_MS, burnTimeFormat, resetWords, type SeatBurn } from './command-model.js';
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

const PAD_T = 16;
const PAD_B = 26;
const PAD_R = 14;
const CHART_HEIGHT = 160;
const pct = (v: number) => `${Math.round(v)}%`;
/** The percent axis every seat card shares, so the cards compare at a glance. */
const PERCENT_TICKS = niceTicks(0, 100, 4);
/** A line that starts this far into the window did not see the window's start. */
const PARTIAL_WINDOW_FRACTION = 0.05;
const SINCE_OPENED = 'Readings since Verse opened — the line fills in as it watches this seat.';

/** Why a line starts late in its window — only asked when it does. */
function lateStartNote(burn: SeatBurn, firstSeen: number | null, formatTime: (ms: number) => string): string {
  // Recorded history reached this window: the gap is real — nothing was read then.
  if (burn.recorded && firstSeen !== null) return `No reading was recorded in this window before ${formatTime(firstSeen)}.`;
  return SINCE_OPENED;
}

/**
 * A window whose reset nobody placed: the window's length ending now, the
 * readings and the stop line on the shared 0–100% axis. No even-pace line,
 * projection or reset marker — each would point at an instant nobody
 * published. WHY not a kit chart: BurnDown needs a reset, and AreaTrend sizes
 * both axes to the data — which is what drew Claude's one-minute, 0–40% card.
 */
function TrailingWindow({
  title,
  description,
  caveat,
  points,
  from,
  to,
  line,
  width: fixedWidth,
  formatTime,
  ariaLabel,
}: {
  title: string;
  description: string;
  caveat: string;
  points: BurnPoint[];
  from: number;
  to: number;
  line: SeatBurn['line'];
  width?: number;
  formatTime: (ms: number) => string;
  ariaLabel: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useChartWidth(wrapRef, fixedWidth);
  const inWindow = points.filter((p) => p.t >= from && p.t <= to).sort((a, b) => a.t - b.t);
  const padL = Math.min(56, Math.max(28, Math.max(...PERCENT_TICKS.map((t) => pct(t).length)) * 7 + 10));
  const plotW = Math.max(40, width - padL - PAD_R);
  const plotH = CHART_HEIGHT - PAD_T - PAD_B;
  const xs = linearScale(from, to, padL, padL + plotW);
  const ys = linearScale(0, 100, PAD_T + plotH, PAD_T);
  const y = (v: number) => ys(Math.min(100, Math.max(0, v)));
  const runs = splitRuns(inWindow.map((p) => ({ x: p.t, y: p.remaining }))).map((run) => run.map((p) => ({ x: xs(p.x), y: y(p.y) })));
  const latest = [...inWindow].reverse().find((p) => p.remaining !== null) ?? null;
  const columns: TableColumn<BurnPoint>[] = [
    { key: 't', label: 'When', render: (p) => formatTime(p.t) },
    { key: 'r', label: 'Remaining', numeric: true, render: (p) => (p.remaining === null ? '—' : pct(p.remaining)) },
  ];
  return (
    <ChartFrame
      title={title}
      description={description}
      caveat={caveat}
      status={latest ? { kind: 'ready' } : { kind: 'empty', message: 'No reading inside this window.' }}
      table={<TableView caption={title} columns={columns} rows={inWindow} rowKey={(p) => String(p.t)} />}
    >
      <div ref={wrapRef} className={plot.plotWrap}>
        <svg className={plot.svg} width={width} height={CHART_HEIGHT} viewBox={`0 0 ${width} ${CHART_HEIGHT}`} role="img" aria-label={ariaLabel}>
          {PERCENT_TICKS.map((t) => (
            <g key={t}>
              <line className={plot.grid} x1={padL} x2={padL + plotW} y1={ys(t)} y2={ys(t)} />
              <text className={plot.tick} x={padL - 6} y={ys(t)} dy="0.32em" textAnchor="end">{pct(t)}</text>
            </g>
          ))}
          <line className={plot.axis} x1={padL} x2={padL + plotW} y1={ys(0)} y2={ys(0)} />
          {/* Two labels only, one per end: the window's start and "Now". */}
          <text className={plot.tick} x={padL} y={CHART_HEIGHT - 8} textAnchor="start">{formatTime(from)}</text>
          <text className={plot.tick} x={padL + plotW} y={CHART_HEIGHT - 8} textAnchor="end">Now</text>
          {line ? (
            <g data-role="reserve">
              <line className={plot.reference} x1={padL} x2={padL + plotW} y1={ys(line.value)} y2={ys(line.value)} />
              <text data-role="reserve-label" className={`${plot.tick} ${plot.halo}`} x={padL + 4} y={ys(line.value) - 5} textAnchor="start">
                {line.label} · {pct(line.value)}
              </text>
            </g>
          ) : null}
          {runs.map((run, i) => (
            <g key={i} data-role="remaining">
              <path className={plot.wash} fill={CHART_SEQUENTIAL} d={areaPath(run, run.map((p) => ({ x: p.x, y: ys(0) })))} />
              <path className={plot.line} stroke={CHART_SEQUENTIAL} d={linePath(run)} />
            </g>
          ))}
          {latest && latest.remaining !== null ? (
            <circle className={plot.marker} cx={xs(latest.t)} cy={y(latest.remaining)} r={4} fill={CHART_SEQUENTIAL} />
          ) : null}
        </svg>
      </div>
    </ChartFrame>
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
  // A clause in the header's " · " list (the reason's own full stop dropped);
  // `asSentence` closes it again, once, where a sentence follows.
  const eligibility = asClause(burn.enabled ? (burn.eligible ? 'Autonomy may use it now' : burn.reason ?? 'Held back from autonomy') : 'Not used by autonomy');
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
  const windowMs = WINDOW_MS[burn.window];
  const formatTime = burnTimeFormat(burn.window);
  const words = burn.resetText ? resetWords(burn.resetText) : null;
  const known = burn.points.filter((p) => p.remaining !== null);
  const firstSeen = known.length ? Math.min(...known.map((p) => p.t)) : null;
  // The line starts at the first reading anyone kept (recorded history, else
  // this viewer's own); say so when that was well into the window, or the
  // empty left of the chart reads as "idle".
  const partial = (from: number) => known.length < 2 || firstSeen === null || firstSeen - from > PARTIAL_WINDOW_FRACTION * windowMs;

  if (burn.resetAt === null || burn.start === null) {
    if (latest === null) return noReading;
    // Readings, but no reset anyone placed: no machine instant, and either no
    // provider words or words that don't name a clock time inside this window.
    const newest = Math.max(...known.map((p) => p.t));
    const to = Math.max(now, newest);
    const from = to - windowMs;
    const reset = words ?? 'reset time not reported';
    const why = words ? "The provider's reset words could not be placed on a clock" : 'No reset time was reported for this window';
    return (
      <TrailingWindow
        title={title}
        description={`${pct(latest)} left · ${reset} · ${eligibility}`}
        caveat={`${why}, so nothing is projected to a reset.${partial(from) ? ` ${lateStartNote(burn, firstSeen, formatTime)}` : ''}`}
        points={burn.points}
        from={from}
        to={to}
        line={burn.line}
        width={width}
        formatTime={formatTime}
        ariaLabel={`${title}: ${pct(latest)} left, ${reset}. ${asSentence(eligibility)}`}
      />
    );
  }
  // Claude's reset comes from its own words: keep them in the header, verbatim,
  // so the placed reset can always be checked against what the provider said.
  const placedByWords = burn.resetFrom === 'words' && words !== null;
  const description = placedByWords ? `${latest !== null ? `${pct(latest)} left · ` : ''}${words} · ${eligibility}` : eligibility;
  return (
    <BurnDown
      title={title}
      description={description}
      caveat={partial(burn.start) ? lateStartNote(burn, firstSeen, formatTime) : undefined}
      status={burn.points.length === 0 ? { kind: 'empty', message: 'No reading yet in this window.' } : undefined}
      points={burn.points}
      capacity={100}
      // The reset is the chart's right edge and its marker; no separate end
      // label is passed (the kit writes "Resets …" there once).
      start={burn.start}
      resetAt={burn.resetAt}
      now={now}
      // The binding window's own stop line (command-model.ts bindingLine), so
      // the verdict under the chart agrees with the server's eligibility.
      reserve={burn.line ?? undefined}
      height={CHART_HEIGHT}
      width={width}
      formatValue={pct}
      formatTime={formatTime}
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

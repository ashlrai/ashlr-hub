/**
 * routes/verse/usage/CapacityStrip.tsx — the first thing on the Usage screen,
 * and the only thing that has to be readable in under two seconds.
 *
 * It answers "what can I run right now" three ways, in descending order of
 * how fast they can be read:
 *
 *   1. one sentence — how many seats are usable, and what local adds;
 *   2. one chip per seat — engine marker, state word, and the binding
 *      percent when (and only when) that percent is a real measurement;
 *   3. two facts underneath — when the nearest window resets, and how much
 *      local memory is free.
 *
 * Honesty rules that shape the markup rather than the copy:
 *
 *   - a seat with NO reading gets the word "no reading", never a 0% chip and
 *     never a bar. An empty meter reads "plenty left", which is a lie;
 *   - a flagged limit gets "limit reached" and NO percentage, because the
 *     upstream sentinel 100 is a denial, not a measurement;
 *   - a countdown is only ever computed from a machine-readable `resetsAt`.
 *     Claude's reset is provider prose, so it is printed verbatim under its
 *     own heading and never turned into a clock.
 */
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { CapacityClass, CapacityOverview, SeatCapacity } from './capacity-model.js';
import { formatUntil, nextResetAt } from './capacity-model.js';
import { formatBytes } from './local-model.js';
import styles from './usage.module.css';

/** Word, never color alone (DESIGN-V2 §6). Short enough to scan in a chip. */
const CLASS_WORD: Record<CapacityClass, string> = {
  ready: 'usable',
  tight: 'tight',
  blocked: 'blocked',
  unread: 'no reading',
};

/**
 * A countdown that does not tick is worse than no countdown: it is a stale
 * number wearing a clock's clothes. 30s is invisible work and keeps a
 * minutes-resolution figure honest.
 *
 * It returns the clock rather than just forcing a re-render, because forcing a
 * re-render is only half the job: `CapacityOverview` is memoized on the account
 * data, so every duration baked into it at build time is re-rendered unchanged.
 * The duration has to be derived HERE, from `atMs` against this value.
 */
function useNow(active: boolean, intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

function SeatChip({
  seat,
  selected,
  onSelect,
}: {
  seat: SeatCapacity;
  selected: boolean;
  onSelect: ((id: string) => void) | null;
}): ReactNode {
  const engineStyle = { '--engine-color': seat.color } as CSSProperties;
  const body = (
    <>
      <span className={styles.chipLabel}>{seat.label}</span>
      <span className={styles.chipState}>{CLASS_WORD[seat.cls]}</span>
      {seat.usedPct === null ? null : (
        <span className={styles.chipPct}>{Math.round(seat.usedPct)}%</span>
      )}
    </>
  );

  // The chip is only a control when there is something for it to open. A
  // button that does nothing is worse than a span.
  if (onSelect === null) {
    return (
      <span className={styles.chip} style={engineStyle} data-capacity={seat.cls}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.chip}
      style={engineStyle}
      data-capacity={seat.cls}
      aria-pressed={selected}
      onClick={() => onSelect(seat.id)}
    >
      {body}
    </button>
  );
}

export function CapacityStrip({
  overview,
  selectedId,
  onSelectSeat,
}: {
  overview: CapacityOverview;
  selectedId: string | null;
  /** Null disables selection entirely (e.g. the fallback roster has no detail). */
  onSelectSeat: ((id: string) => void) | null;
}): ReactNode {
  // Re-select against the live clock, not against the `overdue` flag frozen
  // into the model: the soonest reset changes as time passes, and the account
  // payload that would rebuild the model may be byte-identical for hours.
  const nowMs = useNow(overview.resets.length > 0);
  const reset = useMemo(() => nextResetAt(overview.resets, nowMs), [overview.resets, nowMs]);
  const untilMs = reset === null ? 0 : reset.atMs - nowMs;
  const overdue = untilMs <= 0;

  const local = overview.local;

  return (
    <section className={styles.capacity} aria-labelledby="verse-capacity-heading">
      <h3 id="verse-capacity-heading" className={styles.visuallyHidden}>
        Capacity right now
      </h3>

      <p className={styles.capacityHeadline} data-empty={overview.noCapacity ? 'true' : undefined}>
        {overview.headline}
      </p>

      {overview.seats.length > 0 ? (
        <div className={styles.chips} role="list" aria-label="Seat capacity">
          {overview.seats.map((seat) => (
            <span role="listitem" key={seat.id}>
              <SeatChip
                seat={seat}
                selected={selectedId === seat.id}
                onSelect={seat.kind === 'account' ? onSelectSeat : null}
              />
            </span>
          ))}
        </div>
      ) : null}

      <dl className={styles.capacityFacts}>
        <div className={styles.capacityFact}>
          <dt className={styles.figureLabel}>Nearest reset</dt>
          <dd>
            {reset === null ? (
              <span className={styles.capacityMuted}>
                No seat reported a dated reset. That is an absent timestamp, not "never".
              </span>
            ) : overdue ? (
              <span className={styles.capacityMuted}>
                <span className={styles.num}>{reset.seatLabel}</span> · {reset.windowLabel} was due to
                reset at {new Date(reset.atMs).toLocaleString()} — this reading predates the rollover.
              </span>
            ) : (
              <>
                <span className={styles.num}>{formatUntil(untilMs)}</span>{' '}
                <span className={styles.capacityMuted}>
                  · {reset.seatLabel} {reset.windowLabel}, at{' '}
                  {new Date(reset.atMs).toLocaleString()}
                </span>
              </>
            )}
          </dd>
        </div>

        <div className={styles.capacityFact}>
          <dt className={styles.figureLabel}>Local headroom</dt>
          <dd>
            {local === null ? (
              <span className={styles.capacityMuted}>No local source answered.</span>
            ) : !local.reachable ? (
              <span className={styles.capacityMuted}>
                The local runtime did not answer this probe, so headroom is unknown — not zero, and
                not full.
              </span>
            ) : local.headroomBytes === null ? (
              <span className={styles.capacityMuted}>
                Either the resident total or the machine budget was not reported, so headroom cannot
                be computed.
              </span>
            ) : (
              <>
                <span className={styles.num}>{formatBytes(local.headroomBytes)}</span>{' '}
                <span className={styles.capacityMuted}>
                  free of {formatBytes(local.memoryBudgetBytes)} · {local.residentCount} resident,{' '}
                  {local.installedCount} installed
                </span>
              </>
            )}
          </dd>
        </div>

        <div className={styles.capacityFact}>
          <dt className={styles.figureLabel}>Agentic locally</dt>
          <dd>
            {local === null || !local.reachable ? (
              <span className={styles.capacityMuted}>unknown</span>
            ) : (
              <>
                <span className={styles.num}>{local.agenticCount}</span>{' '}
                <span className={styles.capacityMuted}>
                  of {local.installedCount} installed models can drive a session
                  {local.unknownToolCount > 0
                    ? `; ${local.unknownToolCount} did not report a capability list`
                    : ''}
                </span>
              </>
            )}
          </dd>
        </div>
      </dl>

      {overview.proseResets.length > 0 ? (
        <div className={styles.proseResets}>
          <span className={styles.figureLabel}>Resets reported as text</span>
          <ul className={styles.noteList}>
            {overview.proseResets.map((r) => (
              <li key={`${r.seatLabel}-${r.windowLabel}-${r.text}`} className={styles.capacityMuted}>
                {r.seatLabel} · {r.windowLabel} — {r.text}
              </li>
            ))}
          </ul>
          <p className={styles.capacityMuted}>
            These providers publish a sentence rather than a timestamp, so it is shown exactly as
            given and never turned into a countdown.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * routes/verse/usage/CapacityFacts.tsx — the Usage screen's machine-wide
 * facts under the shared capacity strip: when the nearest window resets, how
 * much local memory is free, and how many local models can drive a session.
 *
 * Split out of the pre-3.10 CapacityStrip when the per-seat half became the
 * ONE shared `CapacityStrip` (SPEC-310C §4). These three facts need the
 * Usage-only reads (`/api/verse/accounts`, `/api/verse/local-models`), so
 * they stay here rather than weighing down every surface that mounts the strip.
 *
 * Honesty rules, unchanged:
 *   - a countdown is only ever computed from a machine-readable `resetsAt`,
 *     against a LIVE clock (the model is memoized on the account data, so a
 *     duration baked into it would freeze);
 *   - a reset in the past is "predates the rollover", never a negative count;
 *   - Claude's reset is provider prose, printed verbatim under its own heading;
 *   - local headroom is unknown unless both the resident total and the budget
 *     are known.
 */
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { CapacityOverview } from './capacity-model.js';
import { formatUntil, nextResetAt } from './capacity-model.js';
import { formatBytes } from './local-model.js';
import styles from './usage.module.css';

function useNow(active: boolean, intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

export function CapacityFacts({ overview }: { overview: CapacityOverview }): ReactNode {
  // Re-select against the live clock, not against the `overdue` flag frozen
  // into the model: the soonest reset changes as time passes, and the account
  // payload that would rebuild the model may be byte-identical for hours.
  const nowMs = useNow(overview.resets.length > 0);
  const reset = useMemo(() => nextResetAt(overview.resets, nowMs), [overview.resets, nowMs]);
  const untilMs = reset === null ? 0 : reset.atMs - nowMs;
  const overdue = untilMs <= 0;

  const local = overview.local;

  return (
    <section className={styles.capacity} aria-label="Resets and local headroom">
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

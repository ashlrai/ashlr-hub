/**
 * routes/verse/chat/LiveTimer.tsx — "12s", counting, for anything running
 * (unit C2): a pending tool row, an activity group, a running chat in the
 * sidebar, a task in the Tasks pane.
 *
 * ONE shared one-second clock for every timer on the page. A long session
 * can show dozens of running rows at once (a group of parallel tool calls,
 * the sidebar's running chats, the tasks list); a `setInterval` each would
 * be dozens of timers re-rendering out of phase. Subscribers join a single
 * interval that exists only while at least one of them is mounted, and all
 * of them tick on the same beat.
 *
 * It is a clock, never a request (SPEC-310A §0: no polling faster than 2 s —
 * this polls nothing).
 */
import { useSyncExternalStore } from 'react';
import { formatLiveElapsed } from './LiveStatus.js';

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of [...listeners]) l();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function snapshot(): number {
  return now;
}

const idle = () => () => {};
// A constant: useSyncExternalStore requires a stable snapshot between
// renders, and `Date.now` as a snapshot would loop.
const idleSnapshot = () => 0;

/**
 * The shared clock (ms). While `active` is false the component does not
 * subscribe at all — a settled row costs nothing — and reads the wall clock
 * once per render instead.
 */
export function useSecondClock(active = true): number {
  const tick = useSyncExternalStore(active ? subscribe : idle, active ? snapshot : idleSnapshot, active ? snapshot : idleSnapshot);
  // A freshly mounted subscriber must not show the clock as it stood when the
  // previous beat fired (up to a second stale): take the later of the two.
  return Math.max(tick, Date.now());
}

/** Parse an ISO stamp or client-clock ms into ms; null when unusable. */
export function startMs(since: string | number | null | undefined): number | null {
  if (typeof since === 'number') return Number.isFinite(since) ? since : null;
  if (typeof since !== 'string') return null;
  const ms = Date.parse(since);
  return Number.isFinite(ms) ? ms : null;
}

export interface LiveTimerProps {
  /** ISO start stamp or client-clock ms. Unparseable → renders nothing (an unknown start is not "0s"). */
  since: string | number | null | undefined;
  className?: string;
  /** Spoken label prefix, e.g. "running for". Omit to hide the timer from assistive tech (it ticks every second). */
  label?: string;
}

export function LiveTimer({ since, className, label }: LiveTimerProps) {
  const start = startMs(since);
  const clock = useSecondClock(start !== null);
  if (start === null) return null;
  const text = formatLiveElapsed(Math.max(0, clock - start));
  return (
    <span className={className} data-live-timer="" aria-hidden={label ? undefined : true}
      aria-label={label ? `${label} ${text}` : undefined} role={label ? 'timer' : undefined}>
      {text}
    </span>
  );
}

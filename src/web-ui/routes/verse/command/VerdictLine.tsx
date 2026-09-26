/**
 * routes/verse/command/VerdictLine.tsx — the one sentence under the top bar
 * (17/24, weight 500): "Autonomous · 5 building · 7 merged today · 0 reverts
 * · Claude 46% reserved for you", then the "Since you looked" strip.
 *
 * The strip compares against the operator's previous visit to Command,
 * remembered per viewer in localStorage (a convenience: if storage is
 * blocked the strip simply stays hidden — nothing depends on it).
 */
import { useEffect, useRef, useState } from 'react';
import { useSectionVisible } from '../shell/section-visibility.js';
import { verdictParts, type VerdictInputs } from './authority-model.js';
import type { SinceItem } from './command-model.js';
import styles from './command.module.css';

export function VerdictLine(props: VerdictInputs) {
  const parts = verdictParts(props);
  return (
    <p className={styles.verdict} data-testid="verdict">
      {parts.map((p, i) => (
        <span key={p.key} className={styles.verdictPart} data-tone={p.tone}>
          {i > 0 ? <span className={styles.verdictSep} aria-hidden="true"> · </span> : null}
          {p.text}
        </span>
      ))}
    </p>
  );
}

export const LAST_LOOKED_KEY = 'ashlr.verse.command.lastLooked.v1';

function readStored(): string | null {
  try {
    const v = window.localStorage.getItem(LAST_LOOKED_KEY);
    return v && Number.isFinite(Date.parse(v)) ? v : null;
  } catch {
    return null;
  }
}

function writeStored(value: string): void {
  try {
    window.localStorage.setItem(LAST_LOOKED_KEY, value);
  } catch {
    /* private window / blocked storage: the strip just stays hidden */
  }
}

/**
 * The previous visit's time. Each time Command comes into view (mount, or
 * back from another surface in the keep-alive shell), what was stored
 * becomes "last looked" and now is stored for next time.
 */
export function useLastLooked(): string | null {
  const visible = useSectionVisible();
  const [previous, setPrevious] = useState<string | null>(null);
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setPrevious(readStored());
      writeStored(new Date().toISOString());
    }
    wasVisible.current = visible;
  }, [visible]);
  return previous;
}

/** A glance back sooner than this is the same visit; the strip stays hidden. */
export const SINCE_MIN_GAP_MS = 3_600_000;

/**
 * "Since 9:40 AM: 3 merged · 1 reverted". Shown only when something changed
 * AND the previous look was at least an hour ago — "Since 2:14 PM: nothing
 * new" on every return from another surface was noise.
 */
export function SinceStrip({ lastLookedAt, items, now = Date.now() }: { lastLookedAt: string | null; items: SinceItem[]; now?: number }) {
  if (!lastLookedAt || items.length === 0) return null;
  const when = new Date(lastLookedAt);
  if (!Number.isFinite(when.getTime()) || now - when.getTime() < SINCE_MIN_GAP_MS) return null;
  const sameDay = when.toDateString() === new Date(now).toDateString();
  const label = sameDay
    ? when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : when.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return (
    <div className={styles.since} role="group" aria-label={`Since you looked at ${label}`}>
      <span className={styles.sinceLead}>Since {label}</span>
      {items.map((item) => (
        <span key={item.id} className={styles.sinceChip} data-tone={item.tone}>
          {item.text}
        </span>
      ))}
    </div>
  );
}

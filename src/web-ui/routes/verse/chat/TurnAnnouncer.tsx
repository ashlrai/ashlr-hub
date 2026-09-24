/**
 * routes/verse/chat/TurnAnnouncer.tsx — what a screen reader hears from the
 * transcript (SPEC-310C §2 "Screen readers", unit C2).
 *
 * The 3.9 log was `aria-live="polite"` with `aria-relevant="additions text"`:
 * every streamed token was a text change, so a screen reader either read the
 * reply one fragment at a time or queued minutes of speech behind it. The
 * log is now `aria-live="off"` and this polite region says only the moments
 * that change what the operator should do:
 *
 *   "Turn started." · "Turn finished." · "Turn failed." · "Turn stopped."
 *
 * Nothing is announced on mount or when switching chats (history is not
 * news) — only a transition observed while the same chat stays open.
 */
import { useEffect, useRef, useState } from 'react';
import type { TurnStatus } from './turn-model.js';

export interface TurnAnnouncerProps {
  /** A turn is in flight. */
  running: boolean;
  /** The last turn's status (null when there is none). */
  lastStatus: TurnStatus | null;
  /** The last turn's key — a new key with the same status is still a new turn. */
  lastKey: string | null;
}

/** A trailing no-break space makes a repeated sentence a CHANGE, so it is spoken again. */
const NBSP = '\u00a0';

const SETTLED: Readonly<Record<Exclude<TurnStatus, 'running'>, string>> = {
  ok: 'Turn finished.',
  error: 'Turn failed.',
  stopped: 'Turn stopped.',
};

/** Pure: what to say for a transition, or null. Exported for tests. */
export function turnAnnouncement(
  prev: { running: boolean; lastKey: string | null } | null,
  next: { running: boolean; lastStatus: TurnStatus | null; lastKey: string | null },
): string | null {
  if (prev === null) return null;
  if (!prev.running && next.running) return 'Turn started.';
  if (prev.running && !next.running) {
    if (next.lastStatus === null || next.lastStatus === 'running') return 'Turn finished.';
    return SETTLED[next.lastStatus];
  }
  return null;
}

export function TurnAnnouncer({ running, lastStatus, lastKey }: TurnAnnouncerProps) {
  const [message, setMessage] = useState('');
  const prev = useRef<{ running: boolean; lastKey: string | null } | null>(null);

  useEffect(() => {
    const said = turnAnnouncement(prev.current, { running, lastStatus, lastKey });
    prev.current = { running, lastKey };
    // Re-set even an identical sentence: two failures in a row are two events.
    if (said !== null) setMessage((current) => (current === said ? `${said}${NBSP}` : said));
  }, [running, lastStatus, lastKey]);

  return (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="turn-announcer">
      {message}
    </div>
  );
}

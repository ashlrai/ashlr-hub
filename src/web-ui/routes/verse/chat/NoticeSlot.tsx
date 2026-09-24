/**
 * routes/verse/chat/NoticeSlot.tsx — ONE notice above the composer, not a
 * stack of banners above the transcript (SPEC-310C §2, unit C2).
 *
 * Before 3.10 every advisory had its own row under the header: seat health,
 * the handoff note, the expansive suggestion, the compact panel, a "Started
 * …" status — on a bad day four of them pushed the transcript half a screen
 * down, and the one that mattered was wherever it happened to render. Now
 * they share one slot, in a fixed order of consequence:
 *
 *   1. seat health (A2)       — the account this chat runs on is broken;
 *   2. engine                 — the running turn is retrying, was recovered,
 *                               or has gone quiet (watchdog);
 *   3. context advice         — continue in a fresh chat / go expansive;
 *   4. compact                — the "Compact now" confirm panel.
 *
 * The highest one shows; "+N more" opens the rest in place. One exception
 * to the order, deliberately: a notice the operator JUST asked for (they
 * pressed "Compact now…") is shown first — hiding the panel they opened
 * behind a seat warning they have already read would make the click look
 * broken. The caller passes that id as `pinnedId`.
 *
 * Each candidate is only passed in when it has something to say, so the
 * slot takes no room at all on a quiet chat.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import styles from './NoticeSlot.module.css';

export const NOTICE_KINDS = ['seat-health', 'engine', 'context', 'compact'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

const PRIORITY: Readonly<Record<NoticeKind, number>> = { 'seat-health': 0, engine: 1, context: 2, compact: 3 };

export interface NoticeCandidate {
  /** Stable per notice (the pinned one and the list keys use it). */
  id: string;
  kind: NoticeKind;
  /** One short phrase for the "+N more" list ("Seat signed out"). */
  label: string;
  render: () => ReactNode;
}

/** Priority order; the pinned notice (when present) first. Stable within a kind. */
export function orderNotices(candidates: readonly NoticeCandidate[], pinnedId: string | null = null): NoticeCandidate[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      if (pinnedId !== null) {
        if (a.c.id === pinnedId && b.c.id !== pinnedId) return -1;
        if (b.c.id === pinnedId && a.c.id !== pinnedId) return 1;
      }
      return PRIORITY[a.c.kind] - PRIORITY[b.c.kind] || a.i - b.i;
    })
    .map(({ c }) => c);
}

export interface NoticeSlotProps {
  notices: readonly NoticeCandidate[];
  pinnedId?: string | null;
}

export function NoticeSlot({ notices, pinnedId = null }: NoticeSlotProps) {
  const ordered = orderNotices(notices, pinnedId);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const extra = ordered.length - 1;
  // Collapse again once only one is left: "Show fewer" with nothing to hide is noise.
  useEffect(() => {
    if (extra <= 0 && expanded) setExpanded(false);
  }, [extra, expanded]);

  if (ordered.length === 0) return null;
  const shown = expanded ? ordered : ordered.slice(0, 1);
  const hiddenLabels = ordered.slice(1).map((n) => n.label).join(', ');

  return (
    <section className={styles.slot} aria-label="Notices" data-count={ordered.length}>
      <div id={listId} className={styles.list}>
        {shown.map((notice) => (
          <div key={notice.id} className={styles.notice} data-kind={notice.kind}>{notice.render()}</div>
        ))}
      </div>
      {extra > 0 ? (
        <button type="button" className={styles.more} aria-expanded={expanded} aria-controls={listId}
          // The hidden ones are named before they are opened.
          aria-label={expanded ? undefined : `+${extra} more: ${hiddenLabels}`}
          title={expanded ? undefined : hiddenLabels} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `+${extra} more`}
        </button>
      ) : null}
    </section>
  );
}

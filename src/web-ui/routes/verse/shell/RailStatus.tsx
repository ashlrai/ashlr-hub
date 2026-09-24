/**
 * routes/verse/shell/RailStatus.tsx — what the rail says without being
 * opened (unit C1; SPEC-310C §1 "Rail badges"):
 *
 *   Command  the Needs-you count
 *   Chat     a pulsing amber dot while chats run (the count rides the
 *            accessible name); a quiet dot for unread replies
 *   Fleet    the autonomy state (off / propose / autonomous, paused, stopped)
 *   Mind     a dot when there is a memo the operator has not opened
 *   foot     a capacity ring for the scarcest seat — C6's `scarcestSeat`
 *            over the shared capacity rows, so the ring and Apps & Accounts
 *            can never describe the same seat two ways
 *
 * Every badge is a SHAPE plus words in the accessible name — never colour
 * alone — and an unknown state draws nothing at all: no dot is "we do not
 * know", never "zero" (the activity route may not be in this build yet).
 */
import { useMemo } from 'react';
import type {
  VerseActivityResponse,
  VerseAutonomyBadge,
  VerseCapacityBadge,
} from '../../../../core/verse/workbench-types.js';
import { buildCapacityRows, scarcestSeat, type CapacityRow } from '../usage/capacity-strip-model.js';
import { useCapacityData } from '../usage/CapacityStrip.js';
import type { VerseSectionId } from '../verse-ui-store.js';
import styles from './RailStatus.module.css';

export interface RailBadge {
  /** Appended to the rail button's accessible name (", 3 need you"). */
  spoken: string;
  kind: 'count' | 'pulse' | 'dot' | 'autonomy';
  /** The visible count, for `count`. */
  count?: number;
  tone?: 'running' | 'info' | 'warning' | 'danger' | 'success' | 'neutral';
  autonomy?: VerseAutonomyBadge;
}

export function autonomyTone(badge: VerseAutonomyBadge): NonNullable<RailBadge['tone']> {
  if (badge.stopped) return 'danger';
  if (badge.paused) return 'warning';
  if (badge.mode === 'autonomous') return 'success';
  if (badge.mode === 'propose') return 'info';
  return 'neutral';
}

/** The badge a rail item shows, or null (nothing to say, or not known). */
export function railBadgeFor(section: VerseSectionId, data: VerseActivityResponse | null): RailBadge | null {
  if (!data) return null;
  switch (section) {
    case 'command': {
      const n = data.counts.needsYou;
      return n > 0 ? { kind: 'count', count: n, spoken: `, ${n} need${n === 1 ? 's' : ''} you`, tone: 'warning' } : null;
    }
    case 'chat': {
      const running = data.counts.running;
      if (running > 0) return { kind: 'pulse', spoken: `, ${running} running`, tone: 'running' };
      const unread = data.counts.unread;
      return unread > 0 ? { kind: 'dot', spoken: `, ${unread} unread`, tone: 'info' } : null;
    }
    case 'fleet':
      return data.autonomy ? { kind: 'autonomy', spoken: `, ${data.autonomy.label}`, autonomy: data.autonomy, tone: autonomyTone(data.autonomy) } : null;
    case 'mind':
      return data.mind?.unseen ? { kind: 'dot', spoken: ', new memo', tone: 'info' } : null;
    default:
      return null;
  }
}

export function RailBadgeMark({ badge }: { badge: RailBadge }) {
  if (badge.kind === 'count') {
    const n = badge.count ?? 0;
    return (
      <span className={styles.count} data-tone={badge.tone} aria-hidden="true" data-badge="count">
        {n > 99 ? '99+' : n}
      </span>
    );
  }
  if (badge.kind === 'autonomy' && badge.autonomy) {
    const a = badge.autonomy;
    const shape = a.stopped ? 'stopped' : a.paused ? 'paused' : a.mode;
    return <span className={styles.autonomy} data-shape={shape} data-tone={badge.tone} aria-hidden="true" data-badge="autonomy" />;
  }
  return <span className={badge.kind === 'pulse' ? styles.pulse : styles.dot} data-tone={badge.tone} aria-hidden="true" data-badge={badge.kind} />;
}

// ---------------------------------------------------------------------------
// Capacity ring
// ---------------------------------------------------------------------------

export function capacityTone(usedPercent: number): 'ok' | 'tight' | 'critical' {
  if (usedPercent >= 90) return 'critical';
  if (usedPercent >= 70) return 'tight';
  return 'ok';
}

/**
 * What the rail foot shows for the scarcest seat: one CapacityRow (C6's
 * projection) reduced to a ring and a sentence. Built ONLY from a row that
 * `scarcestSeat` chose, so there is always a measured binding window or a
 * blocked seat behind it — never an invented percent.
 */
export interface RailCapacity {
  seatId: string;
  label: string;
  /** "5-hour window", "weekly fable window"; null when the seat is blocked with no window read. */
  windowLabel: string | null;
  /** 0–100 for the ring. A reached limit or a blocked seat fills it. */
  usedPercent: number;
  limitReached: boolean;
  /** Provider prose or a formatted instant; null when neither. */
  resetText: string | null;
  /** "blocked", "tight", … — C6's word for the class. */
  word: string;
}

export function railCapacityFromRow(row: CapacityRow | null): RailCapacity | null {
  if (!row) return null;
  const binding = row.windows.find((w) => w.binding) ?? null;
  const limitReached = binding?.limitReached === true;
  // Blocked (signed out, out of usage) reads as a full ring whatever the last
  // window said: the engine will refuse a turn on it.
  const used = row.cls === 'blocked' || limitReached ? 100 : binding?.usedPercent ?? null;
  if (used === null) return null;
  return {
    seatId: row.seatId,
    label: row.label,
    windowLabel: binding?.label ?? null,
    usedPercent: Math.max(0, Math.min(100, used)),
    limitReached,
    resetText: binding?.resetText ?? null,
    word: row.word,
  };
}

/** "Claude Max: weekly fable window 92% used · resets Sep 25" — the tooltip and the accessible name. */
export function describeRailCapacity(c: RailCapacity): string {
  const reset = c.resetText ? ` · ${c.resetText}` : '';
  if (c.limitReached) return `${c.label}: ${c.windowLabel ?? 'window'} limit reached${reset}`;
  if (c.windowLabel === null) return `${c.label}: ${c.word}`;
  return `${c.label}: ${c.windowLabel} ${Math.round(c.usedPercent)}% used${reset}`;
}

/**
 * The rail's scarcest seat, live. Reads the app-wide seat + health caches the
 * capacity strip uses (mounting it costs no extra request when Apps or Usage
 * is also mounted). Budget is NOT read: the reserve does not change which
 * seat is closest to running out, and the rail is on screen on every surface,
 * so it should not keep the 60 s budget poll alive by itself. Local seats are
 * left out — they have no quota to run out of.
 */
export function useRailCapacity(): RailCapacity | null {
  const data = useCapacityData({ withBudget: false });
  return useMemo(
    () => railCapacityFromRow(scarcestSeat(buildCapacityRows(data.seats, { health: data.health, local: 'hide' }))),
    [data.seats, data.health],
  );
}

const R = 7;
const C = 2 * Math.PI * R;

export function CapacityRing({ badge }: { badge: Pick<VerseCapacityBadge, 'usedPercent'> }) {
  const used = Math.max(0, Math.min(100, badge.usedPercent));
  const tone = capacityTone(used);
  return (
    <svg className={styles.ring} data-tone={tone} viewBox="0 0 18 18" width={18} height={18} aria-hidden="true" focusable="false">
      <circle className={styles.ringTrack} cx="9" cy="9" r={R} />
      <circle
        className={styles.ringFill}
        cx="9"
        cy="9"
        r={R}
        strokeDasharray={`${(used / 100) * C} ${C}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

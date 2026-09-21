/**
 * routes/verse/SeatSelector.tsx — grouped seat/model picker. A native
 * <select> with one <optgroup> per engine (Claude · Codex · Grok · Local)
 * and one option per seat×model; seats whose health is `unavailable` are
 * disabled with the reason in the label (and `title`), so the operator sees
 * why rather than just a greyed row. Value is `[seatId, modelId]` JSON so
 * ids containing ':' or '/' can never collide.
 *
 * Every option also carries its seat's CAPACITY (`seat-subscription.ts`).
 * Without it an exhausted seat was indistinguishable from a fresh one here:
 * the only annotation was `seatUnavailableReason`, which fires solely on
 * `health.state === 'unavailable'`, and Claude's health is `unknown` BY
 * CONSTRUCTION (docs/VERSE-TELEMETRY-V2.md). A Claude seat whose binding
 * weekly window read 100% used therefore appeared as an ordinary, enabled,
 * unannotated choice, and the exhaustion was discovered at turn time — the
 * exact failure the Usage section exists to prevent.
 *
 * The annotation reads `plan · word · binding phrase` — the plan tier only
 * when the provider published one, so nothing is invented for a seat whose
 * subscription was never read.
 *
 * A `blocked` seat is MARKED but stays selectable: a used-up window can
 * coexist with a spendable credit balance, so refusing the choice would be a
 * stronger claim than the data supports.
 */
import { useId } from 'react';
import type { VerseSeat } from '../../data/api-types.js';
import { seatSubscription } from './seat-subscription.js';
import { ENGINE_LABEL, groupSeats, seatUnavailableReason } from './verse-model.js';
import styles from './Composer.module.css';

export interface SeatChoice {
  seatId: string;
  model: string;
}

export interface SeatSelectorProps {
  seats: readonly VerseSeat[];
  value: SeatChoice | null;
  onChange: (choice: SeatChoice) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
  compact?: boolean;
}

export function encodeSeatChoice(choice: SeatChoice): string {
  return JSON.stringify([choice.seatId, choice.model]);
}

export function decodeSeatChoice(value: string): SeatChoice | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [seatId, model] = parsed as [unknown, unknown];
    if (typeof seatId !== 'string' || typeof model !== 'string') return null;
    return { seatId, model };
  } catch {
    return null;
  }
}

/** First selectable seat (ready/degraded/unknown) with its default model. */
export function defaultSeatChoice(seats: readonly VerseSeat[]): SeatChoice | null {
  for (const group of groupSeats(seats)) {
    for (const seat of group.seats) {
      if (seat.health.state === 'unavailable' || seat.models.length === 0) continue;
      return { seatId: seat.id, model: seat.models[0]!.id };
    }
  }
  return null;
}

export function SeatSelector({ seats, value, onChange, disabled = false, label = 'Seat and model', id, compact = false }: SeatSelectorProps) {
  const generated = useId();
  const selectId = id ?? generated;
  const groups = groupSeats(seats);
  const current = value ? encodeSeatChoice(value) : '';
  const known = value && seats.some((s) => s.id === value.seatId && s.models.some((m) => m.id === value.model));
  return (
    <label className={`${styles.seatField} ${compact ? styles.seatFieldCompact : ''}`} htmlFor={selectId}>
      <span className={compact ? 'visually-hidden' : styles.fieldLabel}>{label}</span>
      <select id={selectId} className={styles.seatSelect} value={known ? current : ''} disabled={disabled || groups.length === 0}
        aria-label={compact ? label : undefined}
        onChange={(event) => {
          const choice = decodeSeatChoice(event.target.value);
          if (choice) onChange(choice);
        }}>
        {!known ? <option value="" disabled>{groups.length === 0 ? 'No seats discovered' : 'Choose a seat…'}</option> : null}
        {groups.map((group) => (
          <optgroup key={group.engine} label={ENGINE_LABEL[group.engine]}>
            {group.seats.flatMap((seat) => {
              const reason = seatUnavailableReason(seat);
              const capacity = seatSubscription(seat);
              // `unread` is left unsaid: "no reading" on every Claude row
              // would be noise, and the absent figure already says it. A local
              // seat is left unsaid too — it has no subscription to report,
              // and its readiness is already carried by the disabled state.
              const note =
                reason !== null
                  ? `unavailable: ${reason}`
                  : capacity.cls === 'unread' || capacity.kind === 'local'
                    ? null
                    : `${capacity.plan === null ? '' : `${capacity.plan} · `}${capacity.word} · ${capacity.summary}`;
              // The label reads inline after the model name, so it stays
              // lowercase; the tooltip stands alone, so it is sentence case.
              const title = note === null ? undefined : note.charAt(0).toUpperCase() + note.slice(1);
              return seat.models.map((model) => (
                <option key={encodeSeatChoice({ seatId: seat.id, model: model.id })} value={encodeSeatChoice({ seatId: seat.id, model: model.id })}
                  disabled={reason !== null} title={title}>
                  {seat.label} — {model.label}{note ? ` (${note})` : ''}
                </option>
              ));
            })}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

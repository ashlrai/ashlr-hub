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
 *
 * V3.9 — EVERY ROW SAYS WHAT CONTEXT IT BUYS. A row used to read "Claude Max —
 * Opus 5", and the only window anywhere near the picker was the seat's DEFAULT
 * model's (so "200k" for every 1M Claude model). Now each row carries its own
 * model's window and compaction point in the mode that row would run in
 * ("1M ctx · compacts ≈367k"), and — when the dialog has sized the chosen
 * folders — whether that code would fit. A model the seat's pinned CLI cannot
 * run (Opus 5.5 on a 2.1.257 seat) is LISTED, disabled, with its reason, so
 * the operator learns why it is missing instead of wondering. The option's
 * tooltip carries the long form: the window's provenance, the pinned CLI
 * version and the seat's own notes. The new-chat dialog repeats those for the
 * chosen seat in visible text, because WebKit's native menus never show an
 * option's title.
 */
import { useId } from 'react';
import type { VerseModelOption, VerseSeat } from '../../data/api-types.js';
import type { VerseContextMode } from '../../../core/verse/types.js';
import { seatSubscription } from './seat-subscription.js';
import {
  FIT_SHORT,
  modelContextPhrase,
  modelContextSentence,
  modelFit,
  modelUnavailableReason,
  seatCliLine,
  seatContextNotes,
} from './usage/context-model.js';
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
  /**
   * Estimated tokens of the chosen folders' tracked code (GET /context-fit).
   * When present every row also says whether that code fits the model. Null
   * or absent: nothing is claimed.
   */
  workingSetTokens?: number | null;
  /**
   * The context mode each row would run in, so its compaction point is the
   * one the operator would actually get. Absent → standard for every row.
   */
  modeFor?: (seat: VerseSeat, model: VerseModelOption) => VerseContextMode;
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

/**
 * First selectable seat (ready/degraded/unknown) with its first RUNNABLE
 * model. The seat catalog already puts a runnable model first; skipping an
 * unavailable one here as well means a stale or hand-built roster can never
 * make "Start chat" land on a model the pinned CLI would reject.
 */
export function defaultSeatChoice(seats: readonly VerseSeat[]): SeatChoice | null {
  for (const group of groupSeats(seats)) {
    for (const seat of group.seats) {
      if (seat.health.state === 'unavailable') continue;
      const model = seat.models.find((m) => modelUnavailableReason(seat, m) === null);
      if (model) return { seatId: seat.id, model: model.id };
    }
  }
  return null;
}

/**
 * The option's text, which is also its accessible name:
 * "Claude Max — Opus 5.5 · 1M ctx · compacts ≈367k · code fits (usable · …)".
 * Seat and model lead so the CLOSED select still says what was chosen.
 */
export function seatOptionText(input: {
  seat: VerseSeat;
  model: VerseModelOption;
  mode: VerseContextMode;
  workingSetTokens?: number | null;
  note: string | null;
}): string {
  const verdict = modelFit(input.workingSetTokens, input.model, input.mode);
  const fit = verdict === null ? '' : ` · ${FIT_SHORT[verdict]}`;
  const note = input.note === null ? '' : ` (${input.note})`;
  return `${input.seat.label} — ${input.model.label} · ${modelContextPhrase(input.model, input.mode)}${fit}${note}`;
}

/**
 * The option's tooltip: the note first (it is why the row is marked), then the
 * model's full context sentence, then the seat facts no row has room for.
 */
export function seatOptionTitle(seat: VerseSeat, model: VerseModelOption, note: string | null): string {
  const lines: string[] = [];
  if (note !== null) lines.push(note.charAt(0).toUpperCase() + note.slice(1));
  lines.push(modelContextSentence(model));
  const cli = seatCliLine(seat);
  if (cli !== null) lines.push(`Runs ${cli}.`);
  lines.push(...seatContextNotes(seat));
  return lines.join('\n');
}

export function SeatSelector({
  seats,
  value,
  onChange,
  disabled = false,
  label = 'Seat and model',
  id,
  compact = false,
  workingSetTokens = null,
  modeFor,
}: SeatSelectorProps) {
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
              const seatReason = seatUnavailableReason(seat);
              const capacity = seatSubscription(seat);
              // `unread` is left unsaid: "no reading" on every Claude row
              // would be noise, and the absent figure already says it. A local
              // seat is left unsaid too — it has no subscription to report,
              // and its readiness is already carried by the disabled state.
              const capacityNote =
                capacity.cls === 'unread' || capacity.kind === 'local'
                  ? null
                  : `${capacity.plan === null ? '' : `${capacity.plan} · `}${capacity.word} · ${capacity.summary}`;
              return seat.models.map((model) => {
                // The seat's outage outranks the model's own reason: nothing
                // on an unreachable seat runs, whatever its CLI version.
                const reason = seatReason ?? modelUnavailableReason(seat, model);
                // The label reads inline after the model name, so it stays
                // lowercase; the tooltip stands alone, so it is sentence case.
                const note = reason !== null ? `unavailable: ${reason}` : capacityNote;
                const mode = modeFor?.(seat, model) ?? 'standard';
                const optionValue = encodeSeatChoice({ seatId: seat.id, model: model.id });
                return (
                  <option key={optionValue} value={optionValue} disabled={reason !== null}
                    title={seatOptionTitle(seat, model, note)}>
                    {seatOptionText({ seat, model, mode, workingSetTokens, note })}
                  </option>
                );
              });
            })}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

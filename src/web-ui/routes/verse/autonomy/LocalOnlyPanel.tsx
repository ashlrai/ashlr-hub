/**
 * routes/verse/autonomy/LocalOnlyPanel.tsx — the local-only switch, and an
 * honest account of what flipping it does.
 *
 * Local-only is a REFUSAL, not a preference (docs/LOCAL-FLEET.md). Cloud
 * engines become unreachable: `provider-client.ts` throws on a cloud provider
 * without `--allow-cloud` and `router.ts` checks `cloudKeyAvailable`. Calling
 * that "prefer local models" would be the single most expensive piece of
 * wrong copy in the app, because an operator who reads it as a preference will
 * assume a frontier dispatch is merely unlikely rather than impossible — and
 * the whole point of the switch is to make accidental spend impossible.
 *
 * So the panel does two things a toggle usually does not:
 *
 *   1. It states the refusal in the present tense, in the operator's own
 *      words back to them, before the click.
 *   2. It names, from the LIVE seat roster, exactly which of THEIR seats stop
 *      working. "Blocks cloud engines" is abstract; "blocks 3 of your 5 seats,
 *      here they are" is a decision an operator can actually make.
 *
 * Turning it ON is confirm-guarded even though it is reversible, because the
 * blast radius is the point. Turning it OFF is not: re-opening a door the
 * operator deliberately closed is their call, and a dialog there would only
 * teach them to click through dialogs.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { ConfirmDialog } from '../../inbox/ConfirmDialog.js';
import type { LocalOnlyPolicy, OptionalFleetRead } from './fleet-contract.js';
import { localOnlyImpact, localOnlySourceNote, type SeatLike } from './fleet-model.js';
import { setLocalOnly } from './fleet-queries.js';
import { tidyProse } from './format.js';
import type { GuardedAction } from './use-guarded-action.js';
import styles from './autonomy.module.css';

export interface LocalOnlyPanelProps {
  read: OptionalFleetRead<LocalOnlyPolicy> | null;
  /** The live seat roster, so the blast radius is the operator's own number. */
  seats: readonly SeatLike[];
  guard: GuardedAction;
  dispatchEnabled: boolean;
  loading?: boolean;
}

export function LocalOnlyPanel({
  read,
  seats,
  guard,
  dispatchEnabled,
  loading = false,
}: LocalOnlyPanelProps): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const policy = read?.value ?? null;
  const impact = localOnlyImpact(policy, seats);
  const sourceNote = localOnlySourceNote(policy);
  const enabled = policy?.enabled ?? false;
  const locked = !dispatchEnabled || guard.readOnly;
  const disabled = locked || guard.busy || !(policy?.mutable ?? false);

  const apply = (next: boolean): void => {
    guard.request(
      () => setLocalOnly(next),
      next
        ? 'Turning local-only on requires the dispatch token.'
        : 'Turning local-only off requires the dispatch token.',
      (result) => {
        setNote(result.note ? tidyProse(result.note) : null);
        setConfirming(false);
      },
    );
  };

  return (
    <section className={styles.panel} aria-labelledby="verse-local-only-title">
      <div className={styles.panelHead}>
        <h3 id="verse-local-only-title" className={styles.panelTitle}>
          Local only
        </h3>
        <p className={styles.panelNote}>
          While on, cloud engines are unreachable.
        </p>
      </div>

      {loading && read === null ? (
        <p className={styles.empty}>Reading the local-only policy…</p>
      ) : read === null || policy === null ? (
        <p className={styles.empty}>
          <span className={styles.emptyStrong}>No local-only source. </span>
          {read?.reason ??
            'Nothing answered for the local-only policy, so whether cloud engines are reachable cannot be stated here. It is not shown as off — an unread switch is not a switch that is off.'}
        </p>
      ) : (
        <>
          <div className={styles.toggleRow}>
            <span className={styles.toggleState} data-on={enabled ? 'true' : 'false'}>
              <StatusBadge
                status={enabled ? 'local-only-on' : 'local-only-off'}
                tone={enabled ? 'success' : 'neutral'}
              >
                {enabled ? 'on — cloud refused' : 'off — cloud reachable'}
              </StatusBadge>
            </span>
            <button
              type="button"
              className={`${styles.button} ${enabled ? '' : styles.buttonPrimary}`}
              disabled={disabled}
              aria-pressed={enabled}
              onClick={() => (enabled ? apply(false) : setConfirming(true))}
            >
              {enabled ? 'Turn local-only off' : 'Turn local-only on'}
            </button>
          </div>

          <p className={styles.policyExplain}>
            {enabled ? (
              <>
                Every non-local engine is <strong>refused at dispatch</strong>. A turn sent to one
                does not fall back, does not queue, and does not run more slowly — it fails with a
                named refusal. Nothing can spend money while this is on.
              </>
            ) : (
              <>
                Cloud engines are reachable. Turning this on makes them <strong>unreachable</strong>: a
                dispatch to one fails outright.
              </>
            )}
          </p>

          {sourceNote ? <p className={styles.capHelp}>{sourceNote}</p> : null}
          {!policy.mutable && dispatchEnabled && !guard.readOnly ? (
            <p className={styles.actionNote} role="status">
              Read-only here.
            </p>
          ) : null}

          <div className={styles.impact}>
            <h4 className={styles.impactTitle}>
              {enabled ? 'What is blocked right now' : 'What this would block'}
            </h4>
            <p className={styles.impactSummary}>{impact.summary}</p>

            {impact.blocked.length > 0 ? (
              <ul className={styles.seatList}>
                {impact.blocked.map((seat) => (
                  <li key={seat.id} className={styles.seatRow}>
                    <span className={styles.seatEngine} data-engine={seat.engine}>
                      {seat.engine}
                    </span>
                    <span className={styles.seatLabel}>{seat.label}</span>
                    <span className={styles.seatRefusal}>{impact.refusalFor(seat.engine)}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {impact.allowed.length > 0 ? (
              <p className={styles.capHelp}>
                Still reachable:{' '}
                {impact.allowed.map((s) => s.label).join(', ')}. Local seats cost nothing to run and
                are unaffected by this switch.
              </p>
            ) : (
              <p className={styles.capHelp}>
                No local seat is configured. With local-only on there would be nothing left to
                dispatch to — add a local seat before relying on this switch.
              </p>
            )}
          </div>

          {note && !guard.error ? (
            <p className={styles.actionNote} role="status">
              {note}
            </p>
          ) : null}

          {guard.error && !confirming ? (
            <p className={styles.capError} role="alert">
              {guard.error}
            </p>
          ) : null}

          <ConfirmDialog
            open={confirming}
            onClose={() => setConfirming(false)}
            title="Make cloud engines unreachable?"
            body={
              <>
                While local-only is on, a dispatch to a non-local engine <strong>fails</strong> with a
                named refusal — no fallback to a local seat, no waiting.
                <br />
                <br />
                {impact.blocked.length === 0
                  ? 'No seat on this machine is affected today: every configured seat is local.'
                  : `${impact.blocked.length} of your ${seats.length} ${seats.length === 1 ? 'seat' : 'seats'} ${
                      impact.blocked.length === 1 ? 'stops' : 'stop'
                    } working: ${impact.blocked.map((s) => s.label).join(', ')}.`}
                <br />
                <br />
                It is reversible from this panel at any time.
              </>
            }
            confirmLabel="Turn local-only on"
            busy={guard.busy}
            error={guard.error}
            onConfirm={() => apply(true)}
          />
        </>
      )}
    </section>
  );
}

/**
 * routes/verse/autonomy/DaemonControls.tsx — THREE stops with three honestly
 * different scopes, ordered by how much they break.
 *
 *   1. Pause / Resume — primary, UNCONFIRMED, obviously reversible.
 *      `POST /api/verse/daemon {action:'pause'}` writes the daemon-scoped
 *      sentinel `~/.ashlr/daemon.paused`. It halts autonomous dispatch and
 *      NOTHING else: the operator's own write tools keep working, a resident
 *      loop parks instead of dying, and Resume brings it back with no restart.
 *      It gets no confirm dialog on purpose — a control that is free to undo
 *      must be free to reach, or people reach for the drastic one instead.
 *
 *   2. Stop loop — confirmed. `stopDaemon()` is still `setKill(true)`
 *      (core/daemon/loop.ts), so the ordinary stop engages the SAME global
 *      sentinel as the emergency button. The confirm says that plainly and
 *      points at Pause, because with Pause shipped, Stop is now the WRONG
 *      choice for "just halt the loop" rather than the only one.
 *
 *   3. Emergency stop — confirmed, below a rule, danger-styled. The global
 *      kill switch, stated at its true blast radius.
 *
 * VERSE-CONTRACT-V2's two rules still hold: the kill switch is never labelled
 * "pause", and the confirm states what else it disables before the click. The
 * word "pause" now belongs to the control that earns it.
 */
import { useState } from 'react';
import { ConfirmDialog } from '../../inbox/ConfirmDialog.js';
import { engageEmergencyStop, releaseEmergencyStop, runDaemonAction } from './control-queries.js';
import type { VerseControlSnapshot, VerseDaemonActionResult } from './control-types.js';
import { runStateOf } from './StatusHeader.js';
import type { GuardedAction } from './use-guarded-action.js';
import styles from './autonomy.module.css';

type Confirming = 'engage' | 'release' | 'stop' | null;

export interface DaemonControlsProps {
  snapshot: VerseControlSnapshot;
  guard: GuardedAction;
  /** False when the server was started without dispatch: every POST 404s. */
  dispatchEnabled: boolean;
}

export function DaemonControls({ snapshot, guard, dispatchEnabled }: DaemonControlsProps) {
  const [confirming, setConfirming] = useState<Confirming>(null);
  // The server's own account of what the last action did. Every daemon action
  // returns one and every one of them used to be discarded — which is how
  // "Stop loop" could engage the global kill switch without the operator ever
  // being told. Cleared on the next action so it is never stale.
  const [lastNote, setLastNote] = useState<string | null>(null);
  const { state } = runStateOf(snapshot);
  const killed = snapshot.killSwitch?.state === 'active';
  const killUnknown = snapshot.killSwitch?.state === 'unknown';
  // The pause is its own sentinel with its own third state. `unknown` means
  // the sentinel could not be read, and the daemon FAILS SAFE by treating that
  // as paused — so the UI must too, rather than showing a running loop.
  const pauseState = snapshot.pause?.state ?? 'unknown';
  const paused = pauseState !== 'running';
  const pauseUnknown = pauseState === 'unknown';
  const locked = !dispatchEnabled || guard.readOnly;
  const disabled = locked || guard.busy;

  const noteOf = (result: VerseDaemonActionResult) => setLastNote(result.note || null);

  return (
    <section className={styles.panel} aria-label="Loop controls">
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Controls</h3>
      </div>

      <div className={styles.controls}>
        {paused ? (
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            disabled={disabled}
            onClick={() =>
              guard.request(
                () => runDaemonAction('resume'),
                'Resuming autonomous dispatch requires the dispatch token.',
                noteOf,
              )
            }
          >
            Resume
          </button>
        ) : (
          // No confirm. Pausing costs nothing, undoes in one click, and leaves
          // every other capability intact — a dialog here would only teach the
          // operator to click through dialogs.
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            disabled={disabled}
            onClick={() =>
              guard.request(
                () => runDaemonAction('pause'),
                'Pausing autonomous dispatch requires the dispatch token.',
                noteOf,
              )
            }
          >
            Pause
          </button>
        )}
        <button
          type="button"
          className={styles.button}
          disabled={disabled || state === 'running' || killed || paused}
          title={
            killed
              ? 'Release the emergency stop before starting the loop.'
              : paused
                ? 'Dispatch is paused — resume before starting the loop.'
                : undefined
          }
          onClick={() =>
            guard.request(
              () => runDaemonAction('start'),
              'Starting the autonomous loop requires the dispatch token.',
              noteOf,
            )
          }
        >
          Start loop
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={disabled || state === 'stopped'}
          onClick={() => setConfirming('stop')}
        >
          Stop loop
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={disabled || killed || paused}
          title={paused ? 'Dispatch is paused — resume before running a tick.' : undefined}
          onClick={() =>
            guard.request(
              () => runDaemonAction('once'),
              'Running one tick requires the dispatch token.',
              noteOf,
            )
          }
        >
          Run one tick
        </button>
      </div>

      {paused ? (
        <p className={styles.actionNote} role="status">
          {pauseUnknown
            ? 'Dispatch is treated as paused: the pause sentinel could not be read, and the daemon fails safe rather than running on an unreadable signal.'
            : 'Autonomous dispatch is paused. The loop parks between ticks; your own write tools are unaffected, and the global kill switch is not engaged.'}
        </p>
      ) : null}

      <div className={styles.emergency}>
        {killed ? (
          <>
            <button type="button" className={styles.button} disabled={disabled} onClick={() => setConfirming('release')}>
              Release emergency stop
            </button>
            <p className={styles.emergencyNote}>
              The global kill switch is engaged. The daemon refuses to tick <em>and</em> the agent&rsquo;s own write tools
              refuse to edit anything, anywhere — not just in enrolled repos.
            </p>
          </>
        ) : (
          <>
            <button type="button" className={styles.emergencyButton} disabled={disabled} onClick={() => setConfirming('engage')}>
              Emergency stop
            </button>
            <p className={styles.emergencyNote}>
              Engages the global kill switch. Wider than &ldquo;stop the loop&rdquo;: it also disables the agent&rsquo;s own
              write tools everywhere until you release it. To halt only the loop, use <strong>Pause</strong>.
              {killUnknown ? ' The switch’s current state could not be read.' : ''}
            </p>
          </>
        )}
      </div>

      {guard.error && confirming === null ? (
        <p className={styles.capError} role="alert">
          {guard.error}
        </p>
      ) : null}

      {lastNote && !guard.error ? (
        <p className={styles.actionNote} role="status">
          {lastNote}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming === 'stop'}
        onClose={() => setConfirming(null)}
        title="Stop the autonomous loop?"
        body={
          <>
            This is the ordinary stop, but it works by engaging the global kill switch — the same
            <code> ~/.ashlr/KILL </code> sentinel the emergency stop writes. While it is set, the agent&rsquo;s own write
            tools also refuse to edit anything, anywhere, until you release it from this panel.
            <br />
            <br />
            If you only want the loop to stop working, <strong>Pause</strong> does exactly that and nothing else — it
            leaves your own tools alone and undoes in one click.
            <br />
            <br />
            Nothing in flight is rolled back. The loop will not restart by itself.
          </>
        }
        confirmLabel="Stop loop"
        destructive
        busy={guard.busy}
        error={guard.error}
        onConfirm={() =>
          guard.request(
            () => runDaemonAction('stop'),
            'Stopping the autonomous loop requires the dispatch token.',
            (result) => {
              noteOf(result);
              setConfirming(null);
            },
          )
        }
      />

      <ConfirmDialog
        open={confirming === 'engage'}
        onClose={() => setConfirming(null)}
        title="Engage the emergency stop?"
        body={
          <>
            This writes the global kill switch. It stops the autonomous loop <strong>and</strong> disables the
            agent&rsquo;s own write tools — every edit, apply, and merge path refuses while it is engaged, in every repo,
            not only the enrolled ones. Nothing in flight is rolled back; nothing new can start.
            <br />
            <br />
            <strong>Pause</strong> halts autonomous dispatch only and leaves everything else working.{' '}
            <strong>Stop loop</strong> is not narrower than this button: it engages the same global kill switch.
          </>
        }
        confirmLabel="Engage emergency stop"
        destructive
        busy={guard.busy}
        error={guard.error}
        onConfirm={() =>
          guard.request(async () => {
            await engageEmergencyStop();
            setConfirming(null);
          }, 'Engaging the emergency stop requires the dispatch token.')
        }
      />

      <ConfirmDialog
        open={confirming === 'release'}
        onClose={() => setConfirming(null)}
        title="Release the emergency stop?"
        body={
          <>
            This clears the global kill switch. Write tools become usable again immediately. The autonomous loop does
            not restart by itself — use <strong>Start loop</strong> when you want it running.
          </>
        }
        confirmLabel="Release emergency stop"
        busy={guard.busy}
        error={guard.error}
        onConfirm={() =>
          guard.request(async () => {
            await releaseEmergencyStop();
            setConfirming(null);
          }, 'Releasing the emergency stop requires the dispatch token.')
        }
      />
    </section>
  );
}

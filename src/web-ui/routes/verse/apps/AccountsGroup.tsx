/**
 * routes/verse/apps/AccountsGroup.tsx — ACCOUNTS: every seat's plan,
 * connection (A2), 5-hour and weekly windows with their resets, and how much
 * is "Reserved for you" (A9) — the shared CapacityStrip in its accounts mode —
 * plus the one thing each seat needs from you.
 *
 * Every row leads with a status an operator can read at a glance —
 * "Connected · usable now", "Spent · resets Fri 11:46 PM" (and "usable again
 * in 7h 12m"), "Signed out · reconnect to use it", "Checking…" — says when it
 * was last checked, and usable accounts come first.
 *
 *   Reconnect    the provider's own sign-in, opened in Terminal by the health
 *                route (Verse never sees a credential);
 *   Check again  a zero-cost health sweep (status commands only), for a seat
 *                that is spent, unread or unavailable — run here, behind the
 *                mutation-token gate, with the row reading "Checking…";
 *   Fix          the command A2 says fixes it (a CLI re-pin), shown to copy —
 *                never run for you;
 *   Edit budget  A9's BudgetControl in a sheet.
 */
import { useId, useRef, useState } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import type { VerseSeat } from '../../../data/api-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { BudgetControl } from '../budget/BudgetControl.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { refreshSeatHealth } from '../health/health-queries.js';
import { CapacityStrip } from '../usage/CapacityStrip.js';
import { accountStatus, type CapacityRow } from '../usage/capacity-strip-model.js';
import { accountActions } from './apps-model.js';
import { AppGroup } from './AppRow.js';
import { CopyPill } from './CopyPill.js';
import { commandText } from './launch.js';
import styles from './Apps.module.css';

export const ACCOUNTS_EMPTY_TEXT =
  'No accounts connected yet. Sign in to Claude Code, Codex or Grok in a terminal, or start Ollama for local models — they show up here within a minute.';

export function AccountsGroup({
  seats,
  health,
  budget,
  loading,
  reconnecting,
  onReconnect,
  now,
}: {
  seats: readonly VerseSeat[];
  health: readonly SeatHealthReport[] | null;
  budget: BudgetView | null;
  loading: boolean;
  /** Seat whose sign-in window is being opened. */
  reconnecting: string | null;
  onReconnect: (row: CapacityRow) => void;
  /** Injected clock for tests. */
  now?: number;
}) {
  const [fixing, setFixing] = useState<CapacityRow | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'neutral' | 'danger'; text: string } | null>(null);
  const gate = useTokenGate();
  const fixTitle = useId();
  const sheetTitle = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const healthRead = health !== null;

  const checkAgain = async (row: CapacityRow) => {
    setChecking(row.seatId);
    setNote(null);
    try {
      const done = await gate.run(`Check ${row.label} again (status commands only — nothing is spent)`, () => refreshSeatHealth());
      if (done) setNote({ tone: 'neutral', text: `Checked ${row.label} again.` });
    } catch (err) {
      setNote({ tone: 'danger', text: describeContextError(err) });
    } finally {
      setChecking(null);
    }
  };

  return (
    <AppGroup
      id="accounts"
      title="Accounts"
      caveat="Which accounts you can use now, which are spent and when they reset, and how much autonomy leaves for you."
    >
      {loading ? (
        <p className={styles.loadingLine} aria-busy="true">Reading accounts…</p>
      ) : (
        <CapacityStrip
          seats={seats}
          health={health}
          budget={budget}
          labelledBy="apps-group-accounts"
          emptyText={ACCOUNTS_EMPTY_TEXT}
          accounts={{ healthRead, checkingSeatId: checking, ...(now !== undefined ? { now } : {}) }}
          renderActions={(row) =>
            // Actions come from the SETTLED status, so "Check again" stays in
            // place (busy) while its own check runs instead of vanishing.
            accountActions(row, accountStatus(row, { healthRead, ...(now !== undefined ? { now } : {}) })).map((action) => (
              <Button
                key={action.kind}
                size="sm"
                variant={action.primary && action.kind !== 'edit-budget' ? 'primary' : 'ghost'}
                busy={(action.kind === 'reconnect' && reconnecting === row.seatId) || (action.kind === 'check-again' && checking === row.seatId)}
                aria-label={`${action.label}: ${row.label}`}
                onClick={() => {
                  if (action.kind === 'reconnect') onReconnect(row);
                  else if (action.kind === 'check-again') void checkAgain(row);
                  else if (action.kind === 'fix') setFixing(row);
                  else setBudgetOpen(true);
                }}
              >
                {action.label}
              </Button>
            ))
          }
        />
      )}

      <p className={note ? styles.accountsNote : styles.visuallyHidden} data-tone={note?.tone} role="status" aria-live="polite">
        {note?.text ?? ''}
      </p>

      {fixing !== null && fixing.connection?.fixCommand ? (
        <Dialog
          open
          onClose={() => setFixing(null)}
          titleId={fixTitle}
          title={`Fix ${fixing.label}`}
          description={fixing.connection.word}
          initialFocusRef={closeRef}
        >
          <div className={styles.dialogBody}>
            {fixing.connection.reasons.map((reason) => <p key={reason}>{reason}</p>)}
            <div className={styles.commandBlock}>
              <span className={styles.commandLabel}>Run this in a terminal</span>
              <CopyPill text={commandText(fixing.connection.fixCommand)} what={`the fix for ${fixing.label}`} />
            </div>
            <p>Verse shows the command and never runs it for you: it changes which CLI this seat is pinned to.</p>
            <div className={styles.dialogActions}>
              <Button ref={closeRef} variant="subtle" onClick={() => setFixing(null)}>Done</Button>
            </div>
          </div>
        </Dialog>
      ) : null}

      <Sheet
        open={budgetOpen}
        onClose={() => setBudgetOpen(false)}
        titleId={sheetTitle}
        title="Budget"
        description="How much of each seat autonomy may use, and how much is kept for you."
        width={560}
      >
        {budgetOpen ? <BudgetControl /> : null}
      </Sheet>

      <MutationTokenDialog
        open={gate.dialog.open}
        reason={gate.dialog.reason}
        tokenLabel="Mutation token"
        tokenHelp="the mutation token ashlr verse printed"
        onClose={gate.dialog.onClose}
        onUnlocked={gate.dialog.onUnlocked}
      />
    </AppGroup>
  );
}

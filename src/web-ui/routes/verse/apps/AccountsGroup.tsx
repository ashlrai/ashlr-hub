/**
 * routes/verse/apps/AccountsGroup.tsx — ACCOUNTS: every seat's plan,
 * connection (A2), 5-hour and weekly windows with their resets, and how much
 * is "Reserved for you" (A9) — the shared CapacityStrip — plus the one thing
 * each seat needs from you:
 *
 *   Reconnect    the provider's own sign-in, opened in Terminal by the health
 *                route (Verse never sees a credential);
 *   Fix          the command A2 says fixes it (a CLI re-pin), shown to copy —
 *                never run for you;
 *   Edit budget  A9's BudgetControl in a sheet.
 */
import { useId, useRef, useState } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import type { VerseSeat } from '../../../data/api-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { BudgetControl } from '../budget/BudgetControl.js';
import { CapacityStrip } from '../usage/CapacityStrip.js';
import type { CapacityRow } from '../usage/capacity-strip-model.js';
import { accountActions } from './apps-model.js';
import { AppGroup } from './AppRow.js';
import { CopyPill } from './CopyPill.js';
import { commandText } from './launch.js';
import styles from './Apps.module.css';

export function AccountsGroup({
  seats,
  health,
  budget,
  loading,
  reconnecting,
  onReconnect,
}: {
  seats: readonly VerseSeat[];
  health: readonly SeatHealthReport[] | null;
  budget: BudgetView | null;
  loading: boolean;
  /** Seat whose sign-in window is being opened. */
  reconnecting: string | null;
  onReconnect: (row: CapacityRow) => void;
}) {
  const [fixing, setFixing] = useState<CapacityRow | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const fixTitle = useId();
  const sheetTitle = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <AppGroup
      id="accounts"
      title="Accounts"
      caveat="What each seat has left, when it resets, and how much autonomy leaves for you."
    >
      {loading ? (
        <p className={styles.loadingLine} aria-busy="true">Reading seats…</p>
      ) : (
        <CapacityStrip
          seats={seats}
          health={health}
          budget={budget}
          labelledBy="apps-group-accounts"
          renderActions={(row) =>
            accountActions(row).map((action) => (
              <Button
                key={action.kind}
                size="sm"
                variant={action.primary && action.kind !== 'edit-budget' ? 'primary' : 'ghost'}
                busy={action.kind === 'reconnect' && reconnecting === row.seatId}
                aria-label={`${action.label}: ${row.label}`}
                onClick={() => {
                  if (action.kind === 'reconnect') onReconnect(row);
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
    </AppGroup>
  );
}

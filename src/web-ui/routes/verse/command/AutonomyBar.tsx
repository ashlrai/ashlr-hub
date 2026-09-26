/**
 * routes/verse/command/AutonomyBar.tsx — Command's top bar (SPEC-310B §6,
 * SPEC-310C §5; unit C7):
 *
 *   Autonomy [Off | Propose | Autonomous]   Budget · Balanced ▾   Grant 23d   ■ Stop
 *
 *   - Lowering the switch is instant (no confirm, no Touch ID — I1).
 *   - Raising within what the installed grant allows is instant too.
 *   - Raising PAST the grant opens the Touch ID sheet with the draft's full
 *     scope and expiry; the switch then moves once the grant is signed.
 *   - The Budget pill opens A9's BudgetControl, with the grant's mode
 *     ceiling stated above it (autonomy never spends past it whatever the
 *     control shows — the server clamps; see CROSS-UNIT REQUEST to C6).
 *   - The grant chip reads "23d", or "Paused, re-approve" and opens the sheet.
 *   - Stop asks for confirmation (the catalog's `fleet.stop` guard copy),
 *     then writes KILL; while stopped it becomes Resume.
 *
 * At 375 px the bar is just [Autonomy][■] (SPEC-310C §5); the budget pill
 * and grant chip move under the verdict line (rendered by CommandSection).
 */
import { useState, type ReactNode } from 'react';
import type { AuthorityGrantDraft, AuthorityStatusV1, AutonomySwitch } from '../../../../core/authority/types.js';
import type { BudgetMode } from '../../../../core/routing/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { IconChevronDown, IconLock, IconPlay, IconStop } from '../../../components/primitives/icons.js';
import { BudgetControl } from '../budget/BudgetControl.js';
import { findCommand } from '../shell/command-catalog.js';
import { actionForDraft, SWITCH_LABEL, SWITCH_RANK, classifySwitch, grantChip, stopOutcomeSentence, switchOptions, type ChipTone } from './authority-model.js';
import { GrantSheet, type GrantIntent } from './GrantSheet.js';
import { postAuthority, type OptionalRead } from './surface-data.js';
import type { ConfirmSpec, SurfaceActions } from './actions.js';
import styles from './command.module.css';

const MODE_WORD: Record<BudgetMode, string> = { 'all-in': 'All-in', balanced: 'Balanced', reserve: 'Reserve' };

/** The catalog's Stop copy, so ⌘K "Stop the fleet…" and this button confirm with the same words. */
export function stopConfirm(): ConfirmSpec {
  const guard = findCommand('fleet.stop')?.guard?.confirm;
  return {
    title: guard?.title ?? 'Stop the fleet?',
    body: guard?.body ?? 'Autonomous work halts within one tick and stays stopped until you resume it. Chats keep running.',
    confirmLabel: guard?.confirmLabel ?? 'Stop fleet',
    destructive: true,
  };
}

const RESUME_CONFIRM: ConfirmSpec = {
  title: 'Resume the fleet?',
  body: 'Autonomy picks up at the switch position on its next tick. Stopping again is one click.',
  confirmLabel: 'Resume fleet',
  destructive: false,
};

export function ChipDot({ tone }: { tone: ChipTone }) {
  return <span className={styles.dot} data-tone={tone} aria-hidden="true" />;
}

/**
 * The Touch ID sheet and what approving it does, as one piece: the bar's
 * switch and grant chip open it, and so does Command's "Autonomy is off"
 * banner (autonomy/AutonomyOffState) — one sheet, one approve path.
 */
export interface GrantFlow {
  /** `then`: the switch position to apply after signing, if the new grant allows it. */
  open: (intent: GrantIntent, why: string, then?: AutonomySwitch | null) => void;
  /** Render once (the bar does unless its owner passes the flow in). */
  sheet: ReactNode;
}

export function useGrantFlow(actions: SurfaceActions): GrantFlow {
  const [sheet, setSheet] = useState<{ intent: GrantIntent; then: AutonomySwitch | null; why: string } | null>(null);

  function approve(draft: AuthorityGrantDraft): void {
    if (!sheet) return;
    const { then } = sheet;
    // The DRAFT decides grant vs re-approve (B-U1: GET …/draft answers with
    // `kind`, and POST refuses a digest whose kind does not match the action).
    // The sheet's intent is only what the operator clicked; a grant that is no
    // longer continuable is drafted as a new one, and signing it must say so.
    const intent = actionForDraft(draft, sheet.intent);
    actions.act(
      () => postAuthority({ action: intent, draftDigest: draft.digest }),
      intent === 're-approve' ? 'Re-approve the standing grant' : 'Sign a new standing grant',
      {
        onDone: (next) => {
          setSheet(null);
          // Apply the requested position only if the NEW grant allows it.
          if (then && next && SWITCH_RANK[then] <= SWITCH_RANK[next.maxSwitchWithoutGrant] && then !== next.switch) {
            actions.act(() => postAuthority({ action: 'switch', to: then }), `Switch autonomy to ${SWITCH_LABEL[then]}`);
          }
        },
      },
    );
  }

  return {
    open: (intent, why, then = null) => setSheet({ intent, then, why }),
    sheet: (
      <GrantSheet
        open={sheet !== null}
        intent={sheet?.intent ?? 'grant'}
        then={sheet?.then ?? null}
        why={sheet?.why ?? ''}
        busy={actions.busy}
        onApprove={approve}
        onClose={() => setSheet(null)}
      />
    ),
  };
}

export interface AutonomyBarProps {
  read: OptionalRead<AuthorityStatusV1> | undefined;
  loading: boolean;
  budgetMode: BudgetMode | null;
  actions: SurfaceActions;
  compact: boolean;
  now: number;
  /** A flow shared with the rest of the surface; its owner renders `sheet`. Omitted = the bar's own. */
  grantFlow?: GrantFlow;
}

export function AutonomyBar({ read, loading, budgetMode, actions, compact, now, grantFlow }: AutonomyBarProps) {
  const status = read?.value ?? null;
  const ownFlow = useGrantFlow(actions);
  const flow = grantFlow ?? ownFlow;
  /** What the last Stop did (drain count, merges revoked) — shown while stopped. */
  const [stopNote, setStopNote] = useState<string | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const unavailable = !status;
  const chip = grantChip(status, now);

  function onSwitch(to: AutonomySwitch): void {
    if (!status) return;
    const change = classifySwitch(status, to);
    if (change === 'same') return;
    if (change === 'raise-needs-grant') {
      const paused = status.grant.state === 'paused';
      flow.open(
        paused ? 're-approve' : 'grant',
        paused
          ? `${status.grant.reason ?? 'The grant is paused.'} ${SWITCH_LABEL[to]} needs it re-approved.`
          : `${SWITCH_LABEL[to]} is beyond what the installed grant allows, so it needs a new grant.`,
        to,
      );
      return;
    }
    // Lower, or raise within the grant: straight to the server, no dialog.
    actions.act(() => postAuthority({ action: 'switch', to }), `Switch autonomy to ${SWITCH_LABEL[to]}`);
  }

  const options = status ? switchOptions(status) : switchOptions({ switch: 'off', maxSwitchWithoutGrant: 'off' });
  const stopped = status?.kill ?? false;
  const disabled = unavailable || actions.busy || actions.readOnly;

  const switchControl = (
    <div className={styles.switchWrap} title={unavailable ? (read?.reason ?? 'Reading autonomy state…') : undefined}>
      {!compact ? <span className={styles.barLabel} aria-hidden="true">Autonomy</span> : null}
      <Segmented<AutonomySwitch>
        size="sm"
        aria-label="Autonomy"
        value={status?.switch ?? 'off'}
        onChange={onSwitch}
        options={options.map((o) => ({
          value: o.value,
          label: (
            <span className={styles.switchOption}>
              {compact ? o.short : o.label}
              {o.needsGrant ? <IconLock className={styles.touchMark} width={12} height={12} aria-hidden="true" /> : null}
            </span>
          ),
          ariaLabel: o.ariaLabel,
          disabled,
        }))}
      />
    </div>
  );

  const onStop = () => actions.act(() => postAuthority({ action: 'stop' }), 'Stop the fleet', {
    confirm: stopConfirm(),
    onDone: (next) => setStopNote(stopOutcomeSentence(next)),
  });
  const onResume = () => actions.act(() => postAuthority({ action: 'clear-stop' }), 'Resume the fleet', {
    confirm: RESUME_CONFIRM,
    onDone: () => setStopNote(null),
  });
  const stopButton = stopped
    ? compact
      ? <Button variant="subtle" size="sm" icon={<IconPlay />} iconOnly aria-label="Resume the fleet" disabled={disabled} onClick={onResume} />
      : <Button variant="subtle" size="sm" icon={<IconPlay />} disabled={disabled} onClick={onResume}>Resume</Button>
    : compact
      ? <Button variant="danger" size="sm" icon={<IconStop />} iconOnly aria-label="Stop the fleet" disabled={disabled} onClick={onStop} />
      : <Button variant="danger" size="sm" icon={<IconStop />} disabled={disabled} onClick={onStop}>Stop</Button>;

  return (
    <>
      <div className={styles.bar} role="toolbar" aria-label="Autonomy controls" data-loading={loading || undefined}>
        {switchControl}
        {!compact ? (
          <>
            <BudgetPill mode={budgetMode} onOpen={() => setBudgetOpen(true)} />
            <GrantChip chip={chip} onOpen={(intent) => flow.open(intent, chip.detail)} />
          </>
        ) : null}
        <span className={styles.barSpacer} />
        {stopButton}
      </div>
      {stopped && stopNote ? <p className={styles.muted} role="status">{stopNote}</p> : null}
      {compact ? (
        <div className={styles.barSecondary}>
          <BudgetPill mode={budgetMode} onOpen={() => setBudgetOpen(true)} />
          <GrantChip chip={chip} onOpen={(intent) => flow.open(intent, chip.detail)} />
        </div>
      ) : null}
      {grantFlow ? null : ownFlow.sheet}
      <BudgetSheet open={budgetOpen} onClose={() => setBudgetOpen(false)} status={status} />
    </>
  );
}

export function BudgetPill({ mode, onOpen }: { mode: BudgetMode | null; onOpen: () => void }) {
  return (
    <button type="button" className={styles.pill} aria-haspopup="dialog" onClick={onOpen}>
      <span className={styles.pillLabel}>Budget</span>
      <span>{mode ? MODE_WORD[mode] : '—'}</span>
      <IconChevronDown width={14} height={14} aria-hidden="true" />
    </button>
  );
}

export function GrantChip({ chip, onOpen }: { chip: ReturnType<typeof grantChip>; onOpen: (intent: GrantIntent) => void }) {
  const body: ReactNode = (
    <>
      <ChipDot tone={chip.tone} />
      <span className={styles.pillLabel}>Grant</span>
      <span>{chip.label}</span>
    </>
  );
  if (!chip.action) {
    return (
      <span className={styles.chip} data-tone={chip.tone} title={chip.detail} aria-label={`Grant: ${chip.label}. ${chip.detail}`} role="status">
        {body}
      </span>
    );
  }
  const intent = chip.action;
  return (
    <button type="button" className={styles.chip} data-tone={chip.tone} title={chip.detail} aria-haspopup="dialog" onClick={() => onOpen(intent)} aria-label={`Grant: ${chip.label}. ${chip.detail}`}>
      {body}
    </button>
  );
}

function BudgetSheet({ open, onClose, status }: { open: boolean; onClose: () => void; status: AuthorityStatusV1 | null }) {
  const max = status?.grant.state === 'active' ? status.grant.maxMode : null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      titleId="command-budget-sheet"
      width={560}
      title="Budget"
      description={
        max
          ? `Your grant allows up to ${MODE_WORD[max]}. Autonomy never spends past it, whatever is selected here — moving toward Reserve is always instant.`
          : 'No active grant: autonomy only proposes. The budget still decides which seats it would use.'
      }
    >
      {/* The grant's ceiling disables the modes above it (A9 control, C7 request). */}
      {open ? <BudgetControl maxMode={max} /> : null}
    </Sheet>
  );
}

/**
 * routes/verse/command/LeaderCard.tsx — the Leader's latest memo on Command
 * (span 7; SPEC-310B §6 "Leader card: Bottleneck, The Move, a Veto chip on
 * each action, and countdown rings for class-B actions"; unit C7).
 *
 * Every line is the Leader's own (untrusted model) text, rendered as plain
 * text — never markdown, never a link. Veto confirms, then asks for the
 * token; the server runs the action's recorded inverse, restoring the prior
 * state exactly. A dry-run memo (rollout shadow stage) says so in words.
 */
import type { LeaderAction, LeaderStateV1 } from '../../../../core/vision/leader-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { asSentence, formatRelative } from '../autonomy/format.js';
import { STATUS_WORD, expectedDeltaText, isApprovable, isVetoable, memoActions } from '../mind/leader-model.js';
import { approveLeaderAction } from '../leader/thread-data.js';
import { LeaderLine } from '../leader/LeaderLine.js';
import { CountdownRing } from './CountdownRing.js';
import { anchorId, goToSection } from './nav.js';
import { postLeader, type OptionalRead } from './surface-data.js';
import { Card, CardNote, MicroLabel } from './Surface.js';
import type { ConfirmSpec, SurfaceActions } from './actions.js';
import styles from './command.module.css';

export function vetoConfirm(action: Pick<LeaderAction, 'summary' | 'status'>): ConfirmSpec {
  return {
    title: 'Veto this action?',
    body:
      action.status === 'scheduled'
        ? `“${action.summary}” will not apply. The Leader records the veto and learns from it.`
        : `“${action.summary}” is undone exactly as it was applied. The Leader records the veto and learns from it.`,
    confirmLabel: 'Veto',
    destructive: true,
  };
}

export function approveConfirm(action: Pick<LeaderAction, 'summary' | 'status'>): ConfirmSpec {
  return {
    title: 'Approve this action?',
    body:
      action.status === 'scheduled'
        ? `“${action.summary}” applies now instead of waiting out its veto window. You can still veto it afterwards.`
        : `“${action.summary}” is outside the standing grant. Approving tells the Leader to go ahead; the server still checks it against your authority.`,
    confirmLabel: 'Approve',
  };
}

export interface ActionRowProps {
  action: LeaderAction;
  actions: SurfaceActions;
  compact?: boolean;
  /** Offer Approve on a class-B action in its window or a class-C ask (the Leader conversation). */
  approve?: boolean;
  /** A shadow-stage memo's action: shown, never applied — nothing to approve or veto. */
  dryRun?: boolean;
  /** The row's anchor id (the action log's rows are jump targets; a copy in the conversation is not). */
  anchored?: boolean;
}

export function ActionRow({ action, actions, compact = false, approve = false, dryRun = false, anchored = true }: ActionRowProps) {
  const vetoable = !dryRun && isVetoable(action);
  const approvable = approve && !dryRun && isApprovable(action);
  return (
    <li className={styles.actionRow} data-status={action.status} id={anchored ? anchorId(`action-${action.id}`) : undefined}>
      <span className={styles.classBadge} data-class={action.class} title={`Class ${action.class}`}>
        {action.class}
      </span>
      <span className={styles.actionText}>
        <span className={styles.actionSummary}>{action.summary}</span>
        {!compact ? <span className={styles.actionWhy}>{action.why}</span> : null}
      </span>
      <span className={styles.actionState}>
        {dryRun ? (
          <span className={styles.statusWord} data-status="dry-run">Dry run</span>
        ) : action.status === 'scheduled' ? (
          <CountdownRing action={action} />
        ) : (
          <span className={styles.statusWord} data-status={action.status}>{STATUS_WORD[action.status]}</span>
        )}
        {approvable ? (
          <Button
            size="sm"
            variant="subtle"
            disabled={actions.busy || actions.readOnly}
            aria-label={`Approve: ${action.summary}`}
            onClick={() => actions.act(() => approveLeaderAction(action.id), `Approve “${action.summary}”`, { confirm: approveConfirm(action) })}
          >
            Approve
          </Button>
        ) : null}
        {vetoable ? (
          <Button
            size="sm"
            variant="ghost"
            className={styles.vetoChip}
            disabled={actions.busy || actions.readOnly}
            aria-label={`Veto: ${action.summary}`}
            onClick={() => actions.act(() => postLeader({ action: 'veto', actionId: action.id }), `Veto “${action.summary}”`, { confirm: vetoConfirm(action) })}
          >
            Veto
          </Button>
        ) : null}
      </span>
    </li>
  );
}

export function LeaderCard({ read, loading, actions }: { read: OptionalRead<LeaderStateV1> | undefined; loading: boolean; actions: SurfaceActions }) {
  const state = read?.value ?? null;
  const memo = state?.latest ?? null;
  const list = memoActions(state);
  const delta = expectedDeltaText(memo?.move?.expectedDelta ?? null);
  const vetoable = list.some(isVetoable);
  return (
    <Card
      title="Leader"
      caption={memo ? `Memo ${formatRelative(memo.at)}${memo.seatId ? ` · ${memo.seatId}` : ''}${state?.nextRunAt ? ` · next run ${new Date(state.nextRunAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}` : undefined}
      actions={
        <>
          {memo?.dryRun ? <span className={styles.dryRun}>Dry run</span> : null}
          <button type="button" className={styles.linkButton} onClick={() => goToSection('mind', null)} aria-keyshortcuts="Meta+4">
            Open Mind <kbd className={styles.kbd}>⌘4</kbd>
          </button>
        </>
      }
    >
      {loading && !read ? (
        <p className={styles.muted} aria-busy="true">Reading the Leader…</p>
      ) : !state ? (
        <CardNote tone="unknown">{read?.reason ?? 'The Leader did not answer.'}</CardNote>
      ) : !memo ? (
        <CardNote>
          {/* The run's reason is server prose that may carry its own stop. */}
          {asSentence(`No memo yet${state.lastRun ? ` — last run ${formatRelative(state.lastRun.at)}: ${state.lastRun.reason ?? state.lastRun.outcome}` : ''}`)}
          {state.nextRunAt ? ` Next run ${new Date(state.nextRunAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : ''}
        </CardNote>
      ) : (
        <>
          <dl className={styles.memo}>
            <div className={styles.memoRow}>
              <dt><MicroLabel>Bottleneck</MicroLabel></dt>
              <dd className={styles.memoText}>{memo.bottleneck?.statement ?? '—'}</dd>
            </div>
            <div className={styles.memoRow}>
              <dt><MicroLabel>The move</MicroLabel></dt>
              <dd className={styles.memoText}>
                {memo.move?.statement ?? '—'}
                {delta ? <span className={styles.delta}>{delta}</span> : null}
              </dd>
            </div>
          </dl>
          {list.length ? (
            <ul className={styles.actionList} aria-label="Leader actions">
              {list.map((a) => (
                <ActionRow key={a.id} action={a} actions={actions} />
              ))}
            </ul>
          ) : null}
          {memo.dryRun ? <p className={styles.muted}>Shadow stage: these actions are shown, never applied.</p> : null}
          {vetoable && !memo.dryRun ? (
            <button
              type="button"
              className={styles.moreLink}
              disabled={actions.busy || actions.readOnly}
              onClick={() =>
                actions.act(() => postLeader({ action: 'veto-memo', memoId: memo.id }), 'Veto the whole memo', {
                  confirm: {
                    title: 'Veto the whole memo?',
                    body: 'Every applied action is undone exactly and every scheduled one is cancelled. The Leader records the veto.',
                    confirmLabel: 'Veto memo',
                    destructive: true,
                  },
                })
              }
            >
              Veto the whole memo
            </button>
          ) : null}
        </>
      )}
      <LeaderLine />
    </Card>
  );
}

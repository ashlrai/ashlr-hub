/**
 * routes/verse/cloud/CloudCard.tsx — the cloud lane on Command (3.11 unit C3;
 * mounted by sections/CommandSection.tsx beside the burn-downs).
 *
 *   Cloud                                  [New cloud task] [Improve Verse] [Edit budget] [↻]
 *   Credits remaining              $212 of $250 · estimate
 *   ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇░░░░░
 *   Estimated at $3 per session — Claude doesn't expose the credit balance…  Check usage on claude.ai ↗
 *   3 of 20 sessions today · 1 running · resets Sat 12:00 AM
 *   (●) Self-improvement   2 of 4 today, on ashlrai/ashlr-hub …
 *   ● Running   Fix the flaky tracker test
 *               ashlrai/ashlr-hub from master · started 5m ago
 *               Open in Claude ↗
 *
 * The balance is NOT readable anywhere (types.ts header), so every dollar is
 * an estimate and the card says so beside the number, with the link to the
 * real one. It reads GET /api/verse/cloud itself and polls it every 30 s
 * while Command is visible; every write goes through Command's guarded
 * actions (confirm → token → request) and the overview is re-read after.
 *
 * States: loading, not in this build (404), empty, running, pr-open, failed,
 * and budget-refused (the launch gate closed — its plain sentence is shown,
 * and New cloud task / Improve Verse are disabled with that sentence as
 * their tooltip).
 */
import { useId, useRef, useState } from 'react';
import { CLOUD_BALANCE_URL, type CloudBudgetUpdate, type CloudOverviewResponse, type CloudTaskV1 } from '../../../../core/cloud/types.js';
import { Button, IconButton } from '../../../components/primitives/Button.js';
import { useFocusTrap } from '../../../components/primitives/focus-trap.js';
import { IconExternalLink, IconPlus, IconRefresh } from '../../../components/primitives/icons.js';
import { Meter } from '../../../components/primitives/Meter.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { tidyProse } from '../autonomy/format.js';
import type { SurfaceActions } from '../command/actions.js';
import { Card, CardNote } from '../command/Surface.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { CloudBudgetForm } from './CloudBudgetForm.js';
import { CloudLaunchDialog } from './CloudLaunchDialog.js';
import {
  canDismiss,
  cardTasks,
  creditsMeter,
  formatDollars,
  gateText,
  launchBlock,
  safeHref,
  selfImproveLine,
  sessionsLine,
  seatText,
  stateWord,
  STATE_TONE,
  taskDetail,
  taskMeta,
} from './cloud-model.js';
import { CLOUD_POLL_MS, cloudQuery, dismissCloudTask, refreshCloudTasks, runCloudImprove, updateCloudBudget } from './cloud-queries.js';
import styles from './cloud.module.css';

interface CardNotice {
  tone: 'success' | 'warning' | 'danger';
  text: string;
  href?: string | null;
  linkText?: string;
}

/** An outbound link, always in a new tab and never carrying this page as referrer. */
function OutLink({ href, children, label }: { href: string; children: string; label?: string }) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noreferrer noopener" aria-label={label}>
      {children} <IconExternalLink width={12} height={12} aria-hidden="true" />
    </a>
  );
}

export function CloudTaskRow({ task, actions, now }: { task: CloudTaskV1; actions: SurfaceActions; now: number }) {
  const session = safeHref(task.sessionUrl, 'claude.ai');
  const pr = task.pr ? safeHref(task.pr.url, 'github.com') : null;
  const detail = taskDetail(task, now);
  return (
    <li className={styles.task} data-state={task.state}>
      <span className={styles.taskChip}>
        <StatusBadge status={task.state} tone={STATE_TONE[task.state]}>{stateWord(task)}</StatusBadge>
      </span>
      <span className={styles.taskMain}>
        <p className={styles.taskTitle}>{task.title}</p>
        <span className={styles.muted}>{taskMeta(task, now)}</span>
        {detail ? <span className={styles.facts}>{detail}</span> : null}
        <span className={styles.taskLinks}>
          {session ? <OutLink href={session} label={`Open “${task.title}” in Claude`}>Open in Claude</OutLink> : null}
          {pr && task.pr ? <OutLink href={pr} label={`Pull request #${task.pr.number} on GitHub`}>{`PR #${task.pr.number}`}</OutLink> : null}
          {canDismiss(task) ? (
            <button
              type="button"
              className={styles.linkButton}
              disabled={actions.busy || actions.readOnly}
              aria-label={`Dismiss “${task.title}”`}
              onClick={() =>
                actions.act(() => dismissCloudTask(task.id), `Dismiss the cloud task “${task.title}”.`, {
                  confirm: {
                    title: 'Dismiss this cloud task?',
                    body: `Verse stops tracking “${task.title}”. Nothing on GitHub or claude.ai changes — the session and any PR stay where they are.`,
                    confirmLabel: 'Dismiss',
                  },
                })
              }
            >
              Dismiss
            </button>
          ) : null}
        </span>
      </span>
    </li>
  );
}

/** "Edit budget": the shared budget form in a popover anchored under its button. */
function BudgetPopover({ overview, actions, onClose }: { overview: CloudOverviewResponse; actions: SurfaceActions; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap({ open: true, containerRef: panel, onClose });
  const save = (update: CloudBudgetUpdate) =>
    actions.act(() => updateCloudBudget(update), 'Change the cloud budget.', { onDone: onClose });
  return (
    <div ref={panel} className={styles.popover} role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}>
      <h4 id={titleId} className={styles.popoverTitle}>Cloud budget</h4>
      <CloudBudgetForm
        idPrefix="cloud-card-budget"
        budget={overview.budget.budget}
        busy={actions.busy}
        disabled={actions.readOnly}
        onSave={save}
        onCancel={onClose}
      />
    </div>
  );
}

function CloudBody({ overview, actions, now, onNotice }: { overview: CloudOverviewResponse; actions: SurfaceActions; now: number; onNotice: (n: CardNotice) => void }) {
  const view = overview.budget;
  const meter = creditsMeter(view);
  const seat = seatText(overview.seat);
  const refused = gateText(view.canLaunch, 'The cloud budget does not allow another launch right now.');
  const { shown, hidden } = cardTasks(overview.tasks, now);
  const si = view.budget.selfImprove;
  return (
    <div className={styles.body}>
      <div className={styles.meterBlock}>
        <Meter
          value={meter.value}
          max={meter.max}
          label="Credits remaining"
          valueText={meter.text}
          tone={meter.tone}
          aria-label={`Estimated credits remaining: ${meter.text}, ${meter.usedText}`}
        />
        <p className={styles.estimateNote}>
          {tidyProse(view.estimateNote, now)}{' '}
          <OutLink href={CLOUD_BALANCE_URL} label="Check the real balance on claude.ai">Check usage on claude.ai</OutLink>
        </p>
        {meter.warning ? <p className={styles.notice} data-tone="warning" role="note">{meter.warning}</p> : null}
      </div>
      <p className={styles.facts}>{sessionsLine(view, now)}</p>
      {seat ? <p className={styles.notice} data-tone="warning" role="note">{seat}</p> : null}
      {refused ? (
        <p className={styles.notice} data-tone="warning" role="note" data-testid="cloud-budget-refused">
          New launches are paused: {refused}
        </p>
      ) : null}
      <div className={styles.toggleRow}>
        <Switch
          checked={si.enabled}
          label="Self-improvement"
          disabled={actions.busy || actions.readOnly}
          onChange={(enabled) =>
            actions.act(() => updateCloudBudget({ selfImprove: { enabled } }), enabled ? 'Let Verse launch its own self-improvement tasks.' : 'Stop Verse launching its own self-improvement tasks.', {
              onDone: () => onNotice({ tone: 'success', text: enabled ? `Self-improvement is on — up to ${si.maxPerDay} a day.` : 'Self-improvement is off.' }),
            })
          }
        />
        <span className={`${styles.muted} ${styles.toggleText}`}>{selfImproveLine(view)}</span>
      </div>
      {shown.length === 0 ? (
        <CardNote>No cloud tasks yet. Start one with New cloud task, or let Verse improve itself.</CardNote>
      ) : (
        <ul className={styles.tasks} aria-label="Cloud tasks">
          {shown.map((t) => <CloudTaskRow key={t.id} task={t} actions={actions} now={now} />)}
        </ul>
      )}
      {hidden > 0 ? <p className={styles.muted}>{hidden} more {hidden === 1 ? 'task is' : 'tasks are'} listed by ashlr cloud list.</p> : null}
    </div>
  );
}

export function CloudCard({ actions, now = Date.now() }: { actions: SurfaceActions; now?: number }) {
  const read = useQuery(cloudQuery, { freshMs: 15_000 });
  const refetch = useRefetch(cloudQuery);
  usePollWhileVisible(refetch, CLOUD_POLL_MS);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [notice, setNotice] = useState<CardNotice | null>(null);

  const overview = read.data?.value ?? null;
  const loading = !read.data && (read.status === 'loading' || read.status === 'idle');
  const block = overview ? launchBlock(overview.seat, overview.budget) : null;
  const locked = actions.busy || actions.readOnly;
  const nextUp = overview?.backlog.nextUp ? overview.backlog.items.find((i) => i.id === overview.backlog.nextUp) ?? null : null;
  const improveBlock = !overview
    ? null
    : seatText(overview.seat) ?? gateText(overview.budget.canLaunch, 'The cloud budget does not allow another launch right now.') ?? (nextUp ? null : 'The self-improvement backlog has nothing left to launch.');
  const estimate = overview ? overview.budget.budget.estimatedCostPerSessionUsd : null;

  const improve = () => {
    if (!overview || !nextUp) return;
    actions.act(() => runCloudImprove({ count: 1 }), 'Launch the next self-improvement task as a cloud session.', {
      confirm: {
        title: 'Improve Verse now?',
        body: `Launches “${nextUp.title}” as a cloud session on ${nextUp.repo ?? overview.budget.budget.selfImprove.repo}${estimate !== null ? `, estimated at ${formatDollars(estimate)}` : ''}. It delivers a draft PR; nothing merges on its own.`,
        confirmLabel: 'Launch',
      },
      onDone: (result) => {
        const first = result.launched[0] ?? null;
        if (first) {
          setNotice({ tone: 'success', text: `Started “${first.title}”.`, href: safeHref(first.sessionUrl, 'claude.ai'), linkText: 'Open in Claude' });
        } else {
          const why = result.skipped[0]?.reason ?? 'Nothing was launched, and the server sent no reason.';
          setNotice({ tone: 'warning', text: tidyProse(why) });
        }
      },
    });
  };

  const head = overview ? (
    <span className={styles.headActions}>
      <Tooltip label={block ?? 'Start a cloud session with your own task'}>
        <Button size="sm" variant="primary" icon={<IconPlus width={14} height={14} />} disabled={locked || block !== null} onClick={() => setLaunchOpen(true)}>
          New cloud task
        </Button>
      </Tooltip>
      <Tooltip label={improveBlock ?? (nextUp ? `Launch the next backlog item: ${nextUp.title}` : 'Launch the next backlog item')}>
        <Button size="sm" disabled={locked || improveBlock !== null} onClick={improve}>
          Improve Verse
        </Button>
      </Tooltip>
      <Tooltip label="Credits, per-session estimate and daily caps">
        <Button size="sm" variant="ghost" aria-expanded={budgetOpen} aria-haspopup="dialog" onClick={() => setBudgetOpen((o) => !o)} disabled={actions.readOnly}>
          Edit budget
        </Button>
      </Tooltip>
      <Tooltip label="Check GitHub for task updates now">
        <IconButton
          size="sm"
          variant="ghost"
          icon={<IconRefresh width={14} height={14} />}
          aria-label="Check GitHub for task updates now"
          disabled={locked}
          onClick={() => actions.act(() => refreshCloudTasks(), 'Re-read the cloud tasks from GitHub.')}
        />
      </Tooltip>
      {budgetOpen ? <BudgetPopover overview={overview} actions={actions} onClose={() => setBudgetOpen(false)} /> : null}
    </span>
  ) : null;

  return (
    <Card title="Cloud" caption="Claude Code cloud sessions on your Claude credits" actions={head}>
      {loading ? (
        <p className={styles.muted} aria-busy="true">Reading the cloud lane…</p>
      ) : !overview ? (
        <CardNote tone="unknown">{read.data?.reason ?? read.error?.message ?? 'The cloud lane did not answer.'}</CardNote>
      ) : (
        <>
          {notice ? (
            <div className={styles.notice} data-tone={notice.tone} role="status">
              <span className={styles.noticeRow}>
                <span>
                  {notice.text}
                  {notice.href ? <> <OutLink href={notice.href}>{notice.linkText ?? 'Open'}</OutLink></> : null}
                </span>
                <button type="button" className={styles.linkButton} onClick={() => setNotice(null)}>Dismiss</button>
              </span>
            </div>
          ) : null}
          <CloudBody overview={overview} actions={actions} now={now} onNotice={setNotice} />
          <CloudLaunchDialog
            open={launchOpen}
            onClose={() => setLaunchOpen(false)}
            actions={actions}
            estimatePerSessionUsd={estimate}
            onLaunched={(task) =>
              setNotice({ tone: 'success', text: `Started “${task.title}”.`, href: safeHref(task.sessionUrl, 'claude.ai'), linkText: 'Open in Claude' })
            }
          />
        </>
      )}
    </Card>
  );
}

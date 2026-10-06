/**
 * routes/verse/mobile/screens/NeedsYouScreen.tsx — everything waiting on
 * Mason, one card each: approvals, fleet holds, Leader questions and veto
 * windows, failed chats, seats to sign in again.
 *
 * Reads the shell's ONE activity loop (useMobile().activity) — the same
 * GET /api/verse/activity the Mac's Needs-you drawer reads — minus what was
 * just acted on (resolved-store, shared with every list) and minus what was
 * hidden on this phone this session.
 *
 * Doing things:
 *   - every action is the item's own (label, route, confirmation) run through
 *     runNeedsYouAction — the same confirm, token, POST order the Mac uses,
 *     drawn by MobileGuardSheet. Approve / reject / veto always confirm.
 *   - a Leader question's Answer opens a sheet and posts to the question's
 *     answer route (leader/thread-data.ts).
 *   - swipe right starts the card's primary action, swipe left its veto /
 *     reject (or hides it when it has none). A swipe only STARTS the action:
 *     anything that confirms still confirms. Every swipe has a button twin,
 *     and under reduced motion there is no swipe at all.
 *   - "Hide" is local: in-memory for this session on this phone, never
 *     stored, never sent. The item stays on the Mac.
 *
 * Honesty: "All clear" only when every producer feeding the split answered
 * (needs-you-model splitCoverage) and nothing is hidden here.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { NeedsYouAction, NeedsYouActionKind, NeedsYouItem, NeedsYouKind, NeedsYouSeverity } from '../../../../../core/verse/workbench-types.js';
import { isRemoteMobileMode } from '../../../../data/remote-mode.js';
import type { QuestionFormStore } from '../../leader/LeaderQuestionForm.js';
const TypedQuestionForm = lazy(() => import('../../leader/LeaderQuestionForm.js'));

import { MobileComposer } from '../MobileComposer.js';
import { answerLeaderQuestion } from '../../leader/thread-data.js';
import { needsYouQuestionText, questionIdOfNeedsYouItem } from '../../leader/question-id.js';
import { runNeedsYouAction } from '../../shell/needs-you-actions.js';
import {
  describeSilence,
  itemsForSplit,
  needsYouRowView,
  SPLIT_LABEL,
  splitCounts,
  splitCoverage,
  until,
} from '../../shell/needs-you-model.js';
import { markResolved, useResolvedIds } from '../../shell/resolved-store.js';
import type { NeedsYouSplit } from '../../verse-ui-store.js';
import { sinceText } from '../connectivity.js';
import { runMobileAction } from '../mobile-actions.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { showMobileToast } from '../mobile-toast.js';
import { BottomSheet } from '../sheet.js';
import { Button, cx, Screen, SkeletonList } from '../ui.js';
import { Badge, Banner, EmptyState, ErrorState, ui, type Tone } from '../ui-parts.js';
import styles from './NeedsYouScreen.module.css';

// ---------------------------------------------------------------------------
// Hidden on this phone (session memory only — never storage, never the server)
// ---------------------------------------------------------------------------

let hidden: ReadonlySet<string> = new Set();
const hiddenListeners = new Set<() => void>();

function setHidden(next: ReadonlySet<string>): void {
  hidden = next;
  for (const l of [...hiddenListeners]) l();
}

export function hideOnThisPhone(id: string): void {
  setHidden(new Set(hidden).add(id));
}

export function unhideOnThisPhone(ids: readonly string[]): void {
  const next = new Set(hidden);
  for (const id of ids) next.delete(id);
  setHidden(next);
}

export function resetHiddenForTest(): void {
  setHidden(new Set());
}

function useHiddenIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      hiddenListeners.add(l);
      return () => hiddenListeners.delete(l);
    },
    () => hidden,
    () => hidden,
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const SPLITS = Object.keys(SPLIT_LABEL) as NeedsYouSplit[];

/** A swipe past this fraction of the card's width commits. */
export const SWIPE_COMMIT_FRACTION = 0.3;
/** Movement before a touch counts as a horizontal drag rather than a tap or a scroll. */
const SWIPE_SLOP_PX = 10;
const UNDO_MS = 6_000;

/** Swipe right / the card's lead button: the first non-destructive step, in this order. */
const PRIMARY_ORDER: readonly NeedsYouActionKind[] = ['approve', 'resume', 'renew', 'fix', 'done'];
/** Swipe left: saying no. */
const DESTRUCTIVE_ORDER: readonly NeedsYouActionKind[] = ['veto', 'reject'];

function firstOf(item: NeedsYouItem, order: readonly NeedsYouActionKind[]): NeedsYouAction | null {
  for (const kind of order) {
    const found = item.actions.find((a) => a.kind === kind);
    if (found) return found;
  }
  return null;
}

export function primaryAction(item: NeedsYouItem): NeedsYouAction | null {
  return firstOf(item, PRIMARY_ORDER);
}

export function destructiveAction(item: NeedsYouItem): NeedsYouAction | null {
  return firstOf(item, DESTRUCTIVE_ORDER);
}

/**
 * The gateway has a closed route policy. Keep the phone's action affordances
 * inside that policy so an activity producer cannot offer a button that is
 * guaranteed to fail remotely. The gateway still validates path, body, scope,
 * and fresh passkey at dispatch; this list only controls what the UI offers.
 */
function remoteNeedsYouRequestSupported(action: NeedsYouAction): boolean {
  const request = action.request;
  if (!request) return true; // Opens a target or the Leader answer sheet locally.
  if (request.method !== 'POST') return false;
  const { path, body } = request;
  if (path === '/api/verse/activity/seen') return true;
  if (path === '/api/verse/fleet/live') return body['action'] === 'resume-repo';
  if (path === '/api/verse/leader') return body['action'] === 'veto' || body['action'] === 'dismiss';
  if (/^\/api\/inbox\/[^/?#]+\/(approve|reject)$/.test(path)) return true;
  if (/^\/api\/verse\/leader\/actions\/[^/?#]+\/approve$/.test(path)) return true;
  if (/^\/api\/verse\/leader\/questions\/[^/?#]+\/answer$/.test(path)) return true;
  if (/^\/api\/verse\/(cloud|devin)\/tasks\/[^/?#]+\/(land|close|update-branch|dismiss)$/.test(path)) return true;
  if (/^\/api\/verse\/sessions\/[^/?#]+\/(turns|cancel|terminate)$/.test(path)) return true;
  if (/^\/api\/verse\/queue\/[^/?#]+$/.test(path)) return true;
  if (/^\/api\/verse\/agents\/ag_[a-z0-9]{8,32}\/plan$/.test(path)) {
    return Object.keys(body).length === 1 && (body['action'] === 'approve' || body['action'] === 'discard');
  }
  if (/^\/api\/verse\/queue\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[0-9a-f]{12}\/send$/.test(path)) {
    return Object.keys(body).length === 0;
  }
  return false;
}

/** Authority changes and gateway-denied routes require the Mac. */
export function macOnlyRemoteAction(item: NeedsYouItem, action: NeedsYouAction): boolean {
  return isRemoteMobileMode() && (item.kind === 'grant' || item.kind === 'kill'
    || action.request?.path.startsWith('/api/verse/authority') === true
    || !remoteNeedsYouRequestSupported(action));
}

const KIND_NAME: Readonly<Record<NeedsYouKind, string>> = {
  approval: 'Approval',
  'owner-lane-pr': 'Owner-lane PR',
  'class-c': 'Leader ask',
  'veto-window': 'Veto window',
  'leader-question': 'Leader question',
  'owner-hold': 'Owner hold',
  quarantine: 'Quarantined',
  revert: 'Reverted',
  grant: 'Grant',
  kill: 'Stopped',
  'chat-failed': 'Chat failed',
  'agent-plan': 'Agent plan',
  'agent-spend': 'Agent spend',
  'agent-ci': 'Agent checks',
  'agent-setup': 'Agent setup',
  'agent-waiting': 'Agent waiting',
  'queue-held': 'Queue held',
  reconnect: 'Sign-in',
  repin: 'CLI pin',
};

const SEVERITY_TONE: Readonly<Record<NeedsYouSeverity, Tone>> = { high: 'danger', warn: 'warning', info: 'info' };

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/** Specific words where the producer's own copy is not the clearest line for a card. */
const SPECIFIC: Readonly<Partial<Record<`${NeedsYouKind}/${NeedsYouActionKind}`, string>>> = {
  'owner-lane-pr/approve': 'Merges the PR on GitHub. This can’t be undone from the phone.',
  'veto-window/approve': 'Applies the Leader’s action now instead of when its veto window closes. You can still veto it afterwards.',
  'veto-window/veto': 'Cancels the Leader’s action before it applies.',
  'class-c/approve': 'Records your go-ahead for the Leader. Nothing applies until its next run, and the server re-checks your grant.',
  'kill/resume': 'Clears Stop: autonomy resumes within what the current grant allows.',
  'agent-plan/approve': 'Sends the approved plan to the agent, which can then edit its workspace.',
  'agent-plan/reject': 'Discards this plan; the agent will wait for another instruction.',
  'queue-held/resume': 'Sends the held message to the agent now.',
};

const GENERIC: Readonly<Record<NeedsYouActionKind, string>> = {
  approve: 'Approves it on your Mac.',
  reject: 'Rejects it on your Mac; it is never applied.',
  veto: 'Cancels the Leader’s action.',
  done: 'Clears it from Needs you on your Mac too.',
  resume: 'Resumes it on your Mac.',
  renew: 'Renews it on your Mac.',
  fix: 'Runs the fix on your Mac.',
};

/** One short line: what the card's primary action WILL do. */
export function consequenceLine(item: NeedsYouItem, action: NeedsYouAction): string {
  if (item.kind === 'leader-question' && action.request === null) return 'Sends your answer to the Leader — the same thread as Mind and Telegram.';
  if (action.request === null) {
    if (item.target.kind === 'session') return 'Opens the chat on this phone.';
    if (item.target.kind === 'url') return 'Opens it in your browser.';
    return 'This step happens on your Mac.';
  }
  const specific = SPECIFIC[`${item.kind}/${action.kind}`];
  if (specific) return specific;
  if (action.confirm?.body) return clip(action.confirm.body, 180);
  return GENERIC[action.kind];
}

function isHttps(url: string): boolean {
  return /^https:\/\//i.test(url);
}

/** A button that opens the item where the phone can show it (a chat, a link); null when only the Mac can. */
function openLabel(item: NeedsYouItem): string | null {
  if (item.target.kind === 'session') return 'Open chat';
  if (item.target.kind === 'url' && isHttps(item.target.url)) return /^https:\/\/github\.com\//i.test(item.target.url) ? 'Open on GitHub' : 'Open link';
  return null;
}

// ---------------------------------------------------------------------------
// Reduced motion and the swipe
// ---------------------------------------------------------------------------

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReduced(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener?.('change', listener);
  return () => mq.removeEventListener?.('change', listener);
}

function readReduced(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  const forced = document.documentElement.dataset['motion'];
  if (forced === 'reduce') return true;
  if (forced === 'full') return false;
  return window.matchMedia(REDUCED_QUERY).matches;
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, readReduced, () => false);
}

interface Gesture {
  id: number | undefined;
  x: number;
  y: number;
  width: number;
  dragging: boolean;
}

/**
 * Horizontal drag on a card. Vertical movement first = a scroll: the gesture
 * is abandoned. Past SWIPE_COMMIT_FRACTION of the width on release = commit.
 * A drag that began on a button never also clicks it.
 */
function useSwipe(enabled: { right: boolean; left: boolean }, onCommit: (dir: 'right' | 'left') => void) {
  const [dx, setDx] = useState(0);
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);
  const any = enabled.right || enabled.left;

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!any || (e.button !== undefined && e.button > 0)) return;
    swallowClick.current = false;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, width: e.currentTarget.offsetWidth || 320, dragging: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.id) return;
    const mx = e.clientX - g.x;
    const my = e.clientY - g.y;
    if (!g.dragging) {
      if (Math.abs(my) > SWIPE_SLOP_PX && Math.abs(my) >= Math.abs(mx)) {
        gesture.current = null;
        return;
      }
      if (Math.abs(mx) < SWIPE_SLOP_PX) return;
      g.dragging = true;
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is a nicety */
      }
    }
    // Follow only in a direction that does something.
    setDx(mx > 0 ? (enabled.right ? mx : 0) : enabled.left ? mx : 0);
  };

  const end = (e: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    setDx(0);
    if (!g || !g.dragging) return;
    swallowClick.current = true;
    const mx = e.clientX - g.x;
    if (!commit || Math.abs(mx) < g.width * SWIPE_COMMIT_FRACTION) return;
    if (mx > 0 && enabled.right) onCommit('right');
    else if (mx < 0 && enabled.left) onCommit('left');
  };

  const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return {
    dx,
    handlers: any
      ? {
        onPointerDown,
        onPointerMove,
        onPointerUp: (e: ReactPointerEvent<HTMLElement>) => end(e, true),
        onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => end(e, false),
        onClickCapture,
      }
      : {},
  };
}

// ---------------------------------------------------------------------------
// A card
// ---------------------------------------------------------------------------

interface CardProps {
  item: NeedsYouItem;
  canAct: boolean;
  /** The Mac is not answering: Mac actions are off (Hide and Open still work). */
  offline: boolean;
  reduced: boolean;
  onAction: (item: NeedsYouItem, action: NeedsYouAction) => void;
  onOpen: (item: NeedsYouItem) => void;
  onHide: (item: NeedsYouItem) => void;
}

function NeedsCard({ item, canAct, offline, reduced, onAction, onOpen, onHide }: CardProps) {
  const titleId = useId();
  const row = needsYouRowView(item);
  const allowedActions = item.actions.filter((action) => !macOnlyRemoteAction(item, action));
  const macOnly = allowedActions.length !== item.actions.length;
  const primary = canAct ? firstOf({ ...item, actions: allowedActions }, PRIMARY_ORDER) : null;
  const destructive = canAct ? firstOf({ ...item, actions: allowedActions }, DESTRUCTIVE_ORDER) : null;
  const actionsLive = canAct && !offline;
  const rightAction = actionsLive ? primary : null;
  const leftAction = actionsLive ? destructive : null;
  const open = openLabel(item);
  // An action with no route already opens the target: no second Open button.
  const showOpen = open !== null && !allowedActions.some((a) => a.request === null && canAct);

  const { dx, handlers } = useSwipe({ right: !reduced && rightAction !== null, left: !reduced }, (dir) => {
    if (dir === 'right' && rightAction) onAction(item, rightAction);
    else if (dir === 'left') {
      if (leftAction) onAction(item, leftAction);
      else onHide(item);
    }
  });

  const hint = dx > 0 && rightAction ? { side: 'right', text: rightAction.label } : dx < 0 ? (leftAction ? { side: 'left', text: leftAction.label } : { side: 'hide', text: 'Hide' }) : null;
  const expires = item.expiresAt ? `${item.kind === 'veto-window' ? 'Applies' : 'Expires'} ${until(item.expiresAt)}` : null;

  return (
    <li className={styles.swipe}>
      {hint ? (
        <div className={styles.hint} data-side={hint.side} aria-hidden="true">
          {hint.text}
        </div>
      ) : null}
      <article
        className={cx(ui.card, styles.card)}
        aria-labelledby={titleId}
        data-dragging={dx !== 0 ? '' : undefined}
        style={dx !== 0 ? { transform: `translateX(${dx}px)` } : undefined}
        {...handlers}
      >
        <div className={styles.head}>
          <Badge tone={SEVERITY_TONE[item.severity]}>{KIND_NAME[item.kind]}</Badge>
          <span className={styles.age} title={row.ageStamp}>{row.age}</span>
        </div>
        <h2 id={titleId} className={styles.title} title={row.fullTitle}>{row.title}</h2>
        {row.kindLabel || row.repo || row.run || expires ? (
          <p className={styles.meta}>
            {row.kindLabel ? <span>{row.kindLabel}</span> : null}
            {row.repo ? <span title={row.repoFull}>{row.repo}</span> : null}
            {row.run ? <span aria-label={row.run.statsSpoken}>{row.run.stats}</span> : null}
            {row.run ? <span title={row.run.sourceHint ?? undefined}>{row.run.source}</span> : null}
            {expires ? <span className={styles.expires}>{expires}</span> : null}
          </p>
        ) : null}
        {row.detail ? <p className={styles.detail}>{row.detail}</p> : null}
        {macOnly ? <p className={styles.consequence}>This action is available on your Mac.</p> : null}
        {primary ? <p className={styles.consequence}>{consequenceLine(item, primary)}</p> : null}
        <div className={ui.buttonRow}>
          {canAct
            ? allowedActions.map((action, i) => {
              const isPrimary = action === primary;
              const isNo = action.kind === 'veto' || action.kind === 'reject';
              return (
                <Button
                  key={`${action.kind}-${i}`}
                  variant={isPrimary ? 'primary' : isNo ? 'destructiveTinted' : 'secondary'}
                  disabled={offline}
                  aria-label={`${action.label}: ${row.title}`}
                  onClick={() => onAction(item, action)}
                >
                  {action.label}
                </Button>
              );
            })
            : null}
          {showOpen ? (
            <Button variant="secondary" aria-label={`${open}: ${row.title}`} onClick={() => onOpen(item)}>
              {open}
            </Button>
          ) : null}
          <Button variant="plain" aria-label={`Hide on this phone: ${row.title}`} onClick={() => onHide(item)}>
            Hide
          </Button>
        </div>
      </article>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function NeedsYouScreen() {
  const { activity, permissions, reachability, navigate, refreshActivity } = useMobile();
  const resolved = useResolvedIds();
  const hiddenIds = useHiddenIds();
  const reduced = usePrefersReducedMotion();
  const [split, setSplit] = useState<NeedsYouSplit>('all');
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  const [answering, setAnswering] = useState<NeedsYouItem | null>(null);
  const questionForms = useRef<QuestionFormStore>(new Map());

  const canAct = canShowActions(permissions);
  const offline = reachability === 'offline' || reachability === 'unreachable';
  const data = activity.data;
  const all = data?.needsYou ?? [];
  const waiting = all.filter((item) => !resolved.has(item.id) && !hiddenIds.has(item.id));
  const counts = splitCounts(waiting);
  const shown = itemsForSplit(waiting, split);
  const hiddenHere = itemsForSplit(all.filter((item) => hiddenIds.has(item.id) && !resolved.has(item.id)), split);
  const coverage = splitCoverage(data?.sources ?? null, split);

  // The undo offer lasts a few seconds; hiding itself lasts the session.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);

  const openTarget = useCallback(
    (item: NeedsYouItem) => {
      const target = item.target;
      if (target.kind === 'session') {
        navigate({ screen: 'agent', id: target.sessionId, pane: 'transcript' });
        return;
      }
      if (target.kind === 'url') {
        if (isHttps(target.url)) window.open(target.url, '_blank', 'noopener');
        else showMobileToast('That link is not https, so it was not opened.', 'danger');
        return;
      }
      showMobileToast('Open this on your Mac — the phone has no screen for it yet.', 'neutral');
    },
    [navigate],
  );

  const onAction = useCallback(
    (item: NeedsYouItem, action: NeedsYouAction) => {
      if (macOnlyRemoteAction(item, action)) {
        showMobileToast('This action is available on your Mac.', 'neutral');
        return;
      }
      // A Leader question's Answer has no route of its own: the phone collects the words here.
      if (item.kind === 'leader-question' && action.request === null && questionIdOfNeedsYouItem(item.id)) {
        setAnswering(item);
        return;
      }
      runNeedsYouAction(item, action, { openTarget, toast: showMobileToast });
    },
    [openTarget],
  );

  const onHide = useCallback((item: NeedsYouItem) => {
    hideOnThisPhone(item.id);
    setUndo({ id: item.id, title: needsYouRowView(item).title });
  }, []);

  const sendLegacyAnswer = async (text: string): Promise<boolean> => {
    const item = answering;
    const questionId = item ? questionIdOfNeedsYouItem(item.id) : null;
    if (!item || !questionId || !text.trim()) return false;
    const result = await answerLeaderQuestion(questionId, text);
    if (!result) return false;
    markResolved(item.id); void refreshActivity();
    showMobileToast('Answer sent to the Leader', 'success');
    return true;
  };

  let body;
  if (!data) {
    if (activity.status === 'idle' || activity.status === 'loading') {
      body = <SkeletonList rows={3} label="Loading what needs you" />;
    } else if (activity.status === 'unavailable' && !activity.error) {
      body = <ErrorState title="Needs you isn’t available" reason="Verse on your Mac does not serve Needs you in this build. Update Ashlr on the Mac." onRetry={() => void refreshActivity()} />;
    } else {
      body = <ErrorState title="Couldn’t load Needs you" reason={activity.error ?? 'Your Mac did not answer.'} onRetry={() => void refreshActivity()} />;
    }
  } else if (shown.length === 0) {
    if (hiddenHere.length > 0) {
      body = (
        <EmptyState
          title="Nothing else waiting"
          body={`${hiddenHere.length} hidden on this phone for now. ${hiddenHere.length === 1 ? 'It is' : 'They are'} still waiting on your Mac.`}
          action={<Button variant="tinted" onClick={() => unhideOnThisPhone(hiddenHere.map((i) => i.id))}>Show hidden</Button>}
        />
      );
    } else if (coverage.vouched) {
      body = (
        <EmptyState
          title="All clear"
          body={
            split === 'all'
              ? 'Nothing is waiting on you. Approvals, fleet holds, Leader questions, failed chats and seat sign-ins appear here.'
              : `Nothing waiting in ${SPLIT_LABEL[split]}.`
          }
        />
      );
    } else {
      body = <EmptyState title="Nothing from what answered" body={`${describeSilence(coverage)}, so this can’t say all clear.`} />;
    }
  } else {
    body = (
      <ul className={styles.list} aria-label={`${SPLIT_LABEL[split]} waiting on you`}>
        {shown.map((item) => (
          <NeedsCard key={item.id} item={item} canAct={canAct} offline={offline} reduced={reduced} onAction={onAction} onOpen={openTarget} onHide={onHide} />
        ))}
      </ul>
    );
  }


  return (
    <Screen
      title="Needs you"
      large
      onRefresh={refreshActivity}
      label="Waiting on you"
      footer={
        undo ? (
          <div className={styles.undo} role="status">
            <span>Hidden on this phone. It stays on your Mac.</span>
            <Button
              variant="plain"
              onClick={() => {
                unhideOnThisPhone([undo.id]);
                setUndo(null);
              }}
              aria-label={`Undo hide: ${undo.title}`}
            >
              Undo
            </Button>
          </div>
        ) : undefined
      }
    >
      {reachability === 'offline' ? (
        <Banner>This phone is offline. Showing what was waiting ({sinceText(activity.updatedAt).toLowerCase()}); actions are off until it reconnects.</Banner>
      ) : reachability === 'unreachable' && data ? (
        <Banner>Can’t reach your Mac. Showing what was waiting ({sinceText(activity.updatedAt).toLowerCase()}); actions are off until it answers.</Banner>
      ) : null}
      {!canAct && permissions.actReason ? <Banner tone="info">{permissions.actReason}</Banner> : null}

      {data ? (
        <div className={cx(ui.chips, styles.splits)} role="group" aria-label="Filter">
          {SPLITS.map((s) => (
            <button key={s} type="button" className={ui.chip} aria-pressed={split === s} onClick={() => setSplit(s)}>
              {SPLIT_LABEL[s]} {counts[s]}
            </button>
          ))}
        </div>
      ) : null}

      {body}

      {data && shown.length > 0 && !coverage.vouched ? <p className={styles.note}>Not everything answered: {describeSilence(coverage)}.</p> : null}
      {data && shown.length > 0 && hiddenHere.length > 0 ? (
        <p className={styles.note}>
          {hiddenHere.length} hidden on this phone.{' '}
          <button type="button" className={cx(ui.btn, ui.plain)} onClick={() => unhideOnThisPhone(hiddenHere.map((i) => i.id))}>Show</button>
        </p>
      ) : null}

      <BottomSheet open={answering !== null} onClose={() => setAnswering(null)} title="Answer the Leader"
        footer={<Button variant="plain" block onClick={() => setAnswering(null)}>Close</Button>}>
        {answering && questionIdOfNeedsYouItem(answering.id) ? <Suspense fallback={<p role="status">Reading the current question…</p>}>
          <TypedQuestionForm key={answering.id} questionId={questionIdOfNeedsYouItem(answering.id)!}
            store={questionForms.current} renderWrittenAnswer={props => <MobileComposer value={props.value} onChange={props.onChange}
              onSubmit={props.onSend} label={props.label} placeholder={props.placeholder} submitLabel="Send answer"
              disabled={props.disabledReason != null} hint={props.disabledReason} />} showQuestion fallbackText={needsYouQuestionText(answering)}
            disabledReason={offline ? 'Your Mac is not answering. Your draft is kept.' : !canAct ? permissions.actReason ?? 'This phone is read-only.' : null}
            requestSubmit={run => { runMobileAction({ title: 'Answer the Leader', consequences: 'Records the selected answer to this question.',
              confirmLabel: 'Submit answer', confirm: false, run }); }}
            onReconciled={() => { markResolved(answering.id); void refreshActivity(); }}
            onResult={() => { markResolved(answering.id); void refreshActivity(); }} onLegacyAnswer={sendLegacyAnswer} />
        </Suspense> : null}
      </BottomSheet>
    </Screen>
  );
}

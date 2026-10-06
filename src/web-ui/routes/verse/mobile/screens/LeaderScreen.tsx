/**
 * routes/verse/mobile/screens/LeaderScreen.tsx — the Leader conversation on
 * a phone: the SAME thread as Mind on the Mac and Telegram, the standing
 * directives, and a composer with quick replies.
 *
 * Reads and writes are the workbench's own (leader/thread-data.ts — same
 * cache keys, so the Mac's Mind and this screen never disagree); threading
 * and day separators are leader/thread-model.ts. The workbench's
 * LeaderConversation is not imported: its Markdown renderer, memo cards and
 * desktop dialogs would ride into this chunk.
 *
 *   - Text is untrusted (model output, or words that came over Telegram): it
 *     renders as plain text with its line breaks, never as HTML.
 *   - The thread polls every 10 s while visible; directives and the Leader's
 *     action states every 30 s.
 *   - Every write goes through runMobileAction: sends and answers without a
 *     confirmation (a message is cheap), Approve now and Retire WITH one.
 *     A failed send keeps the words in the box.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LeaderAction } from '../../../../../core/vision/leader-types.js';
import { refetchQuery } from '../../../../data/cache.js';
import { readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { leaderQuery } from '../../command/surface-data.js';
import {
  addLeaderDirective,
  answerLeaderQuestion,
  approveLeaderAction,
  fetchOlderThread,
  leaderDirectivesQuery,
  leaderThreadQuery,
  retireLeaderDirective,
  sendLeaderMessage,
  THREAD_PAGE_SIZE,
} from '../../leader/thread-data.js';
import { answeredQuestions, CHANNEL_LABEL, clockTime, displayThreadText, groupThread, mergeThread, previewText, type ThreadRow } from '../../leader/thread-model.js';
import { OPERATOR_DIRECTIVE_MAX, type DirectiveChip, type LeaderThreadKind, type LeaderThreadMessage } from '../../leader/thread-types.js';
import { isApprovable } from '../../mind/leader-model.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { sinceText } from '../connectivity.js';
import { MicButton } from '../MicButton.js';
import { MobileComposer } from '../MobileComposer.js';
import { runMobileAction } from '../mobile-actions.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { BottomSheet } from '../sheet.js';
import { Button, cx, Screen, SkeletonList } from '../ui.js';
import { Badge, Banner, EmptyState, ErrorState, ui, type Tone } from '../ui-parts.js';
import styles from './LeaderScreen.module.css';

export const LEADER_THREAD_POLL_MS = 10_000;
export const LEADER_SLOW_POLL_MS = 30_000;

/** Tapping one fills the box; it never sends by itself. */
export const QUICK_REPLIES = ['Yes, go ahead', 'Hold off for now', 'What’s blocking?', 'Status update?'] as const;

const KIND_BADGE: Readonly<Partial<Record<LeaderThreadKind, { label: string; tone: Tone }>>> = {
  question: { label: 'Question', tone: 'warning' },
  memo: { label: 'Memo', tone: 'info' },
  directive: { label: 'Directive', tone: 'neutral' },
  update: { label: 'Update', tone: 'neutral' },
  action: { label: 'Action', tone: 'running' },
};

const APPROVE_FALLBACK = 'Runs the Leader’s action now instead of waiting for its veto window to close. The server still checks it against your grant, and you can veto it afterwards.';

/** What Approve now WILL do, in the action's own words when the Leader's state has them. */
export function approveConsequences(action: Pick<LeaderAction, 'summary' | 'status'> | null): string {
  if (!action) return APPROVE_FALLBACK;
  return action.status === 'scheduled'
    ? `“${action.summary}” runs now instead of waiting out its veto window. You can still veto it afterwards.`
    : `“${action.summary}” is outside the standing grant. Approving tells the Leader to go ahead; the server still checks it against your authority.`;
}

/** One approvable action a message offers; `action` is null when the Leader's state did not answer. */
interface Approvable {
  id: string;
  action: LeaderAction | null;
}

function approvablesOf(message: LeaderThreadMessage, actions: readonly LeaderAction[] | null): Approvable[] {
  if (message.from !== 'leader' || !message.actionIds?.length) return [];
  if (actions) {
    return message.actionIds.flatMap((id) => {
      const action = actions.find((a) => a.id === id);
      return action && isApprovable(action) ? [{ id, action }] : [];
    });
  }
  // Without the Leader's state only an action note offers it (a memo's
  // actions may long since have applied); the server refuses what is not pending.
  return message.kind === 'action' ? message.actionIds.map((id) => ({ id, action: null })) : [];
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

interface DirectivesProps {
  chips: DirectiveChip[] | null;
  loading: boolean;
  reason: string | null;
  canAct: boolean;
  offline: boolean;
  onRetire: (chip: DirectiveChip) => void;
  onAdd: () => void;
}

function Directives({ chips, loading, reason, canAct, offline, onRetire, onAdd }: DirectivesProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const count = chips ? String(chips.length) : '—';
  return (
    <div className={styles.directives}>
      <button type="button" className={styles.directivesToggle} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span>
          Directives <span className={styles.count}>{count}</span>
        </span>
        <span className={styles.toggleWord} aria-hidden="true">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open ? (
        <div id={bodyId} className={styles.directivesBody}>
          {loading ? (
            <SkeletonList rows={2} label="Loading directives" />
          ) : chips === null ? (
            <p className={ui.faint}>{reason ?? 'Directives did not load.'}</p>
          ) : chips.length === 0 ? (
            <p className={ui.faint}>No standing directives. A directive steers every Leader run until you retire it.</p>
          ) : (
            <ul className={styles.directiveList} aria-label="Standing directives">
              {chips.map((chip) => (
                <li key={chip.id} className={styles.directive}>
                  <span className={styles.directiveText}>{chip.text}</span>
                  {canAct ? (
                    <Button variant="plain" disabled={offline} aria-label={`Retire directive: ${chip.text}`} onClick={() => onRetire(chip)}>
                      Retire
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canAct ? (
            <Button variant="tinted" block disabled={offline} onClick={onAdd}>
              Add directive
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

interface ThreadProps {
  rows: ThreadRow[];
  answered: ReadonlyMap<string, LeaderThreadMessage>;
  byId: ReadonlyMap<string, LeaderThreadMessage>;
  leaderActions: readonly LeaderAction[] | null;
  canAct: boolean;
  offline: boolean;
  answeringId: string | null;
  onAnswer: (question: LeaderThreadMessage) => void;
  onApprove: (item: Approvable) => void;
}

function Bubble({ message, ctx }: { message: LeaderThreadMessage; ctx: ThreadProps }) {
  const badge = KIND_BADGE[message.kind];
  const question = message.from === 'mason' && message.replyTo ? ctx.byId.get(message.replyTo) : undefined;
  const isQuestion = message.from === 'leader' && message.kind === 'question';
  const answer = isQuestion ? ctx.answered.get(message.id) : undefined;
  const approvables = approvablesOf(message, ctx.leaderActions);
  return (
    <div className={styles.bubble} data-from={message.from} data-answering={ctx.answeringId === message.id ? '' : undefined}>
      {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
      {question ? <span className={styles.replyTo}>Re: {previewText(question.text, 90)}</span> : null}
      {/* Untrusted text: plain, line breaks kept, never HTML. */}
      <p className={styles.text}>{displayThreadText(message)}</p>
      {isQuestion ? (
        answer ? (
          <span className={styles.answered}>Answered</span>
        ) : ctx.canAct ? (
          <Button variant="tinted" disabled={ctx.offline} aria-label={`Answer: ${previewText(message.text, 80)}`} onClick={() => ctx.onAnswer(message)}>
            Answer
          </Button>
        ) : null
      ) : null}
      {ctx.canAct && approvables.length > 0 ? (
        <ul className={styles.approvals} aria-label="Actions waiting">
          {approvables.map((item, i) => (
            <li key={item.id} className={styles.approval}>
              {item.action ? <span className={styles.approvalText}>{item.action.summary}</span> : null}
              <Button
                variant="secondary"
                disabled={ctx.offline}
                aria-label={`Approve now: ${item.action?.summary ?? `action ${i + 1}`}`}
                onClick={() => ctx.onApprove(item)}
              >
                Approve now
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {message.delivery?.telegram === 'failed' ? <span className={styles.delivery}>Telegram didn’t get this one</span> : null}
    </div>
  );
}

function Thread(props: ThreadProps) {
  return (
    <div className={styles.thread}>
      {props.rows.map((row) => {
        if (row.type === 'day') return <p key={row.key} className={styles.day}>{row.label}</p>;
        if (row.type === 'system') return <p key={row.key} className={styles.system}>{displayThreadText(row.entry.message)}</p>;
        const who = row.from === 'leader' ? 'Leader' : 'You';
        return (
          <section key={row.key} className={styles.group} data-from={row.from} aria-label={`${who}, ${clockTime(row.at)}`}>
            <p className={styles.groupHead}>
              <span className={styles.who}>{who}</span>
              {row.channel !== 'verse' ? <span className={styles.channel}>via {CHANNEL_LABEL[row.channel]}</span> : null}
              <time dateTime={row.at}>{clockTime(row.at)}</time>
            </p>
            {row.entries.map((entry) => (entry.type === 'message' ? <Bubble key={entry.key} message={entry.message} ctx={props} /> : null))}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function LeaderScreen() {
  const { permissions, reachability } = useMobile();
  const thread = useQuery(leaderThreadQuery, { freshMs: 5_000 });
  const refetchThread = useRefetch(leaderThreadQuery);
  const directives = useQuery(leaderDirectivesQuery, { freshMs: 30_000 });
  const refetchDirectives = useRefetch(leaderDirectivesQuery);
  const leader = useQuery(leaderQuery, { freshMs: 30_000 });
  const refetchLeader = useRefetch(leaderQuery);
  const slowPoll = useCallback(() => {
    refetchDirectives();
    refetchLeader();
  }, [refetchDirectives, refetchLeader]);
  usePollWhileVisible(refetchThread, LEADER_THREAD_POLL_MS);
  usePollWhileVisible(slowPoll, LEADER_SLOW_POLL_MS);

  const [older, setOlder] = useState<LeaderThreadMessage[]>([]);
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [received, setReceived] = useState<LeaderThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [answering, setAnswering] = useState<LeaderThreadMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [adding, setAdding] = useState(false);
  const [directiveDraft, setDirectiveDraft] = useState('');
  const [directiveInterim, setDirectiveInterim] = useState('');
  const directiveId = useId();
  const end = useRef<HTMLDivElement>(null);

  const canAct = canShowActions(permissions);
  const offline = reachability === 'offline' || reachability === 'unreachable';
  const read = thread.data;
  const page = read?.value?.messages ?? null;
  const unavailable = read !== undefined && read.value === null;

  const entries = useMemo(() => mergeThread(page ? [older, page] : [older], received), [older, page, received]);
  const messages = useMemo(() => entries.flatMap((e) => (e.type === 'message' ? [e.message] : [])), [entries]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const answered = useMemo(() => answeredQuestions(messages), [messages]);
  const rows = useMemo(() => groupThread(entries), [entries]);
  const leaderActions = leader.data?.value?.actions ?? null;

  // A send's echo is dropped once a server read carries it.
  useEffect(() => {
    if (!page || received.length === 0) return;
    const onPage = new Set(page.map((m) => m.id));
    if (received.some((m) => onPage.has(m.id))) setReceived((r) => r.filter((m) => !onPage.has(m.id)));
  }, [page, received]);

  // Follow the conversation to its newest message (not when older pages load above).
  const lastKey = entries.length ? entries[entries.length - 1]!.key : null;
  useLayoutEffect(() => {
    if (lastKey) end.current?.scrollIntoView?.({ block: 'end' });
  }, [lastKey]);

  const refreshThread = useCallback(() => refetchQuery(leaderThreadQuery.key, () => leaderThreadQuery.fetch(), true), []);
  const refreshAll = useCallback(
    () =>
      Promise.all([
        refreshThread(),
        refetchQuery(leaderDirectivesQuery.key, () => leaderDirectivesQuery.fetch(), true),
        refetchQuery(leaderQuery.key, () => leaderQuery.fetch(), true),
      ]),
    [refreshThread],
  );

  const disabledReason = !canAct
    ? (permissions.actReason ?? 'This device can read the conversation but not send.')
    : reachability === 'offline'
      ? 'This phone is offline. Sending is off until it reconnects; your words stay here.'
      : reachability === 'unreachable'
        ? 'Your Mac isn’t answering. Sending is off until it does; your words stay here.'
        : unavailable
          ? 'The conversation is not available on your Mac.'
          : null;

  // ---- writes ---------------------------------------------------------------

  const send = (text: string) => {
    const question = answering;
    runMobileAction({
      title: question ? 'Answer the Leader' : 'Message the Leader',
      consequences: 'Sends your words to the Leader.',
      confirmLabel: 'Send',
      confirm: false,
      run: async () => {
        setSending(true);
        try {
          const result = question ? await answerLeaderQuestion(question.questionId ?? question.id, text) : await sendLeaderMessage(text);
          if (result) setReceived((r) => [...r, result.message, ...(result.reply ? [result.reply] : [])]);
        } finally {
          setSending(false);
        }
      },
      onDone: () => {
        // Only what was sent is cleared: words typed meanwhile stay.
        setDraft((d) => (d.trim() === text ? '' : d));
        if (question) setAnswering(null);
        void refreshThread();
      },
    });
  };

  const approve = (item: Approvable) => {
    runMobileAction({
      title: 'Approve this action now?',
      consequences: approveConsequences(item.action),
      confirmLabel: 'Approve now',
      run: () => approveLeaderAction(item.id),
      success: 'Approved — the Leader acts on it now',
      onDone: () => {
        void refreshThread();
        void refetchQuery(leaderQuery.key, () => leaderQuery.fetch(), true);
      },
    });
  };

  const retire = (chip: DirectiveChip) => {
    runMobileAction({
      title: 'Retire this directive?',
      consequences: `“${chip.text}” stops steering the Leader from its next run. It stays in history, and you can add it again any time.`,
      confirmLabel: 'Retire',
      destructive: true,
      run: () => retireLeaderDirective(chip.id),
      success: 'Directive retired',
    });
  };

  const addDirective = () => {
    const text = directiveDraft.trim();
    if (!text) return;
    // Close first so the token sheet (if the hold lapsed) has the stage; a
    // failure reopens this sheet with the words still in it.
    setAdding(false);
    runMobileAction({
      title: 'Add directive',
      consequences: 'The Leader follows this on every run until you retire it.',
      confirmLabel: 'Add directive',
      confirm: false,
      run: async () => {
        try {
          await addLeaderDirective(text);
        } catch (err) {
          setAdding(true);
          throw err;
        }
      },
      success: 'Directive added — the Leader follows it from its next run',
      onDone: () => setDirectiveDraft(''),
    });
  };

  // ---- older pages ------------------------------------------------------------

  const oldestId = messages.length ? messages[0]!.id : null;
  const canLoadOlder = olderState !== 'done' && (page?.length ?? 0) >= THREAD_PAGE_SIZE && oldestId !== null;
  const loadOlder = async () => {
    if (!oldestId || olderState === 'loading') return;
    setOlderState('loading');
    try {
      const got = await fetchOlderThread(oldestId);
      setOlder((o) => [...got, ...o]);
      setOlderState(got.length < THREAD_PAGE_SIZE ? 'done' : 'idle');
    } catch {
      setOlderState('error');
    }
  };

  // ---- render -----------------------------------------------------------------

  let body;
  if (!read && thread.status === 'error') {
    body = <ErrorState title="Couldn’t load the conversation" reason={readFailureReason(thread.error)} onRetry={() => void refreshThread()} />;
  } else if (!read) {
    body = <SkeletonList rows={4} label="Loading the conversation" />;
  } else if (unavailable && entries.length === 0) {
    body = <ErrorState title="The conversation isn’t available" reason={read.reason ?? 'The Leader conversation did not answer.'} onRetry={() => void refreshThread()} />;
  } else if (entries.length === 0) {
    body = (
      <EmptyState
        title="No conversation yet — say hello"
        body="Ask the Leader what it is doing or why, or give it a standing directive. This is the same thread as Mind on your Mac and Telegram."
      />
    );
  } else {
    body = (
      <>
        {canLoadOlder || olderState === 'error' ? (
          <div className={styles.older}>
            <Button variant="plain" onClick={() => void loadOlder()} disabled={olderState === 'loading'}>
              {olderState === 'loading' ? 'Loading earlier…' : olderState === 'error' ? 'Earlier messages didn’t load — try again' : 'Load earlier'}
            </Button>
          </div>
        ) : null}
        <Thread
          rows={rows}
          answered={answered}
          byId={byId}
          leaderActions={leaderActions}
          canAct={canAct}
          offline={offline}
          answeringId={answering?.id ?? null}
          onAnswer={(q) => setAnswering(q)}
          onApprove={approve}
        />
      </>
    );
  }

  const quickReplies = disabledReason === null ? (
    <div className={cx(ui.chips, styles.quick)} role="group" aria-label="Quick replies">
      {QUICK_REPLIES.map((reply) => (
        <button key={reply} type="button" className={ui.chip} onClick={() => setDraft(reply)}>
          {reply}
        </button>
      ))}
    </div>
  ) : null;

  const above = (
    <>
      {answering ? (
        <div className={styles.answering}>
          <span className={styles.answeringText}>Answering: {previewText(answering.text, 100)}</span>
          <Button variant="plain" onClick={() => setAnswering(null)} aria-label="Stop answering">Cancel</Button>
        </div>
      ) : null}
      {quickReplies}
    </>
  );

  const directiveText = directiveInterim ? `${directiveDraft}${directiveDraft && !directiveDraft.endsWith(' ') ? ' ' : ''}${directiveInterim}` : directiveDraft;

  return (
    <Screen
      title="Leader"
      large
      label="Conversation with the Leader"
      onRefresh={refreshAll}
      header={(
        <Directives
          chips={directives.data?.value ?? null}
          loading={directives.data === undefined && directives.status !== 'error'}
          reason={directives.data?.reason ?? (directives.error ? readFailureReason(directives.error) : null)}
          canAct={canAct}
          offline={offline}
          onRetire={retire}
          onAdd={() => {
            setDirectiveInterim('');
            setAdding(true);
          }}
        />
      )}
      footer={(
        <MobileComposer
          label={answering ? 'Answer the Leader' : 'Message the Leader'}
          placeholder={answering ? 'Answer the Leader…' : 'Message the Leader…'}
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          disabled={disabledReason !== null || sending}
          hint={disabledReason ?? (answering ? 'Your answer closes this question for the Leader.' : 'Same thread as Mind and Telegram.')}
          above={above}
        />
      )}
    >
      {reachability === 'offline' ? (
        <Banner>This phone is offline. Showing the last conversation ({sinceText(thread.updatedAt).toLowerCase()}).</Banner>
      ) : reachability === 'unreachable' ? (
        <Banner>Can’t reach your Mac. Showing the last conversation ({sinceText(thread.updatedAt).toLowerCase()}).</Banner>
      ) : null}
      {body}
      <div ref={end} />

      <BottomSheet
        open={adding}
        onClose={() => setAdding(false)}
        title="Add directive"
        footer={(
          <>
            <Button variant="primary" block disabled={directiveDraft.trim().length === 0 || offline} onClick={addDirective}>Add directive</Button>
            <Button variant="plain" block onClick={() => setAdding(false)}>Cancel</Button>
          </>
        )}
      >
        <p className={ui.consequence}>A standing instruction the Leader follows on every run until you retire it — “Ship binshield before new goals”, “No spend raises overnight”.</p>
        <div className={ui.field}>
          <label className={ui.label} htmlFor={directiveId}>Directive</label>
          <textarea
            id={directiveId}
            className={ui.textarea}
            value={directiveText}
            maxLength={OPERATOR_DIRECTIVE_MAX}
            aria-describedby={`${directiveId}-count`}
            onChange={(e) => {
              setDirectiveInterim('');
              setDirectiveDraft(e.target.value.slice(0, OPERATOR_DIRECTIVE_MAX));
            }}
          />
          <span id={`${directiveId}-count`} className={ui.faint}>{directiveDraft.length}/{OPERATOR_DIRECTIVE_MAX}</span>
        </div>
        <MicButton
          onInterim={setDirectiveInterim}
          onFinal={(phrase) => setDirectiveDraft(`${directiveDraft}${directiveDraft && !directiveDraft.endsWith(' ') ? ' ' : ''}${phrase}`.slice(0, OPERATOR_DIRECTIVE_MAX))}
        />
      </BottomSheet>
    </Screen>
  );
}

/**
 * routes/verse/leader/LeaderConversation.tsx — talk to the Leader: the heart
 * of Mind (⌘4). Loaded lazily by MindSection (its own chunk: the chat's
 * first paint never pays for it).
 *
 *   ┌ Leader ───────────────────── One thread · Verse, Telegram, CLI ─ ● Autonomy off ┐
 *   │ DIRECTIVES [Ship binshield first ×] [+ Add directive]                          │
 *   │ ─────────────────────────── Today ───────────────────────────                  │
 *   │ L Leader · Telegram · 9:14 AM                                                  │
 *   │   ┌ MEMO ───────────────────────────────── Dry run ┐                           │
 *   │   │ BOTTLENECK  Judge queue on grok-a…              │                           │
 *   │   │ THE MOVE    Raise Grok to 3 lanes  +4 merges/day by Fri                     │
 *   │   │ [B] Raise Grok to 3 lanes     ◔ 18m  [Approve] [Veto]                       │
 *   │   ┌ QUESTION  Should measurably stay at local enforcement…?                     │
 *   │   │ [ Answer the Leader…                                   ↑ ]                  │
 *   │                                            You · Verse · 9:20 AM  [ Yes, keep… ]│
 *   │ ··· Leader is thinking…                                                        │
 *   │ [ Message the Leader…                                              ↑ ]         │
 *   └────────────────────────────────────────────────────────────────────────────────┘
 *
 * SENDING is optimistic: the words appear at once as a pending bubble; the
 * server's copy replaces it (thread-model mergeThread dedupes, even when a
 * poll lands before the POST returns); a failure keeps the words with the
 * server's reason, Retry and Discard. Every send needs the mutation token —
 * without one the token dialog opens FIRST and the draft stays in the box
 * until it is unlocked (cancelling loses nothing).
 *
 * "Leader is thinking…" shows while a send is in flight and, when the server
 * said it will reply later (reply: null), until the Leader's next message —
 * for at most AWAIT_REPLY_MS. Meanwhile the thread polls every 3 s instead
 * of 10 s. There is no Leader event stream to subscribe to (/api/events has
 * no leader topic), so polling while visible is the honest refresh.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LeaderStateV1 } from '../../../../core/vision/leader-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { DispatchDisabledError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { describeControlError } from '../autonomy/use-guarded-action.js';
import { useNow } from '../autonomy/use-ticker.js';
import type { SurfaceActions } from '../command/actions.js';
import type { OptionalRead } from '../command/surface-data.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { DirectivesStrip } from './DirectivesStrip.js';
import { getLeaderFocus, isLeaderFocusLive, subscribeLeaderFocus, takeLeaderFocus } from './leader-focus.js';
import { LeaderComposer, type LeaderComposerHandle } from './LeaderComposer.js';
import { answerLeaderQuestion, fetchOlderThread, leaderDirectivesQuery, leaderThreadQuery, sendLeaderMessage, THREAD_PAGE_SIZE } from './thread-data.js';
import {
  answeredQuestions,
  awaitingReply,
  findQuestion,
  groupThread,
  mergeThread,
  previewText,
  type PendingMessage,
} from './thread-model.js';
import { ThreadRows, type ThreadContext } from './ThreadItems.js';
import type { LeaderThreadMessage } from './thread-types.js';
import styles from './leader.module.css';

export const THREAD_POLL_MS = 10_000;
export const THREAD_POLL_THINKING_MS = 3_000;
export const DIRECTIVES_POLL_MS = 30_000;

const SEND_TOKEN_REASON = 'Messaging the Leader requires the dispatch token.';

/** A thread scrolled within this of its end counts as "at the end" (new messages follow it down). */
const STICK_PX = 96;

const SUGGESTIONS = ['What is the bottleneck right now?', 'Why this move, and what would change your mind?', 'What would you do with more Claude budget?'];

export interface LeaderConversationProps {
  /** The Leader's state (Mind already reads it): memo cards and action rows come from here. */
  leader: OptionalRead<LeaderStateV1> | undefined;
  /** Mind's actions: Approve / Veto / directives share its confirm → token → error line. */
  actions: SurfaceActions;
  /** Autonomy is off: the Leader still talks, its memos are dry runs. */
  dormant: boolean;
}

/**
 * Token first, then the send — so a cancelled unlock never leaves a
 * phantom pending bubble, and the draft is still in the box.
 */
function useTokenGate() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const next = useRef<(() => void) | null>(null);
  const run = useCallback((why: string, fn: () => void) => {
    if (hasMutationHold()) {
      fn();
      return;
    }
    next.current = fn;
    setReason(why);
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    const fn = next.current;
    next.current = null;
    // Read live: the dialog closes synchronously after the token is set.
    if (fn && hasMutationHold()) fn();
  }, []);
  return { run, dialog: <MutationTokenDialog open={open} onClose={close} reason={reason} tokenHelp="the mutation token ashlr verse printed" /> };
}

let localSeq = 0;

export function LeaderConversation({ leader, actions, dormant }: LeaderConversationProps) {
  const titleId = useId();
  const thread = useQuery(leaderThreadQuery, { freshMs: 5_000 });
  const refetchThread = useRefetch(leaderThreadQuery);
  const directives = useQuery(leaderDirectivesQuery, { freshMs: 30_000 });
  const refetchDirectives = useRefetch(leaderDirectivesQuery);
  const gate = useTokenGate();
  // Day labels and the "thinking" time-out only: a coarse tick is plenty.
  const now = useNow(10_000);

  const [older, setOlder] = useState<LeaderThreadMessage[]>([]);
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [received, setReceived] = useState<LeaderThreadMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [awaiting, setAwaiting] = useState<ReadonlySet<string>>(() => new Set());
  const [draft, setDraft] = useState('');
  /** A Needs-you question the thread has no message for: answered as a quoted message. */
  const [quote, setQuote] = useState<string | null>(null);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [focusQuestionId, setFocusQuestionId] = useState<string | null>(null);
  const [addingDirective, setAddingDirective] = useState(false);
  const [readOnly, setReadOnly] = useState(false);

  const composerRef = useRef<LeaderComposerHandle>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const stick = useRef(true);

  const read = thread.data;
  const page = read?.value?.messages ?? null;
  const entries = useMemo(() => mergeThread(page ? [older, page] : [older], received, pending), [older, page, received, pending]);
  const messages = useMemo(() => entries.flatMap((e) => (e.type === 'message' ? [e.message] : [])), [entries]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const answered = useMemo(() => answeredQuestions(messages), [messages]);
  const rows = useMemo(() => groupThread(entries, now), [entries, now]);
  const thinking = awaitingReply(entries, awaiting, now);

  usePollWhileVisible(refetchThread, thinking ? THREAD_POLL_THINKING_MS : THREAD_POLL_MS);
  usePollWhileVisible(refetchDirectives, DIRECTIVES_POLL_MS);

  // A send's echo is dropped once a server read carries it.
  useEffect(() => {
    if (!page || received.length === 0) return;
    const onPage = new Set(page.map((m) => m.id));
    if (received.some((m) => onPage.has(m.id))) setReceived((r) => r.filter((m) => !onPage.has(m.id)));
  }, [page, received]);

  const unavailable = read !== undefined && read.value === null;
  const sendDisabledReason =
    readOnly || actions.readOnly
      ? 'Read-only session — this server runs without dispatch, so messages cannot be sent.'
      : unavailable
        ? 'The conversation is not available on this server.'
        : null;

  // ---- sending ------------------------------------------------------------

  const deliver = useCallback(
    async (p: PendingMessage) => {
      try {
        const result =
          p.kind === 'answer' && p.questionId ? await answerLeaderQuestion(p.questionId, p.text) : await sendLeaderMessage(p.text, p.replyTo);
        setPending((ps) => ps.filter((x) => x.clientId !== p.clientId));
        if (result) {
          setReceived((r) => [...r, result.message, ...(result.reply ? [result.reply] : [])]);
          if (!result.reply) setAwaiting((a) => new Set(a).add(result.message.id));
        }
        stick.current = true;
        refetchThread();
      } catch (err) {
        if (err instanceof DispatchDisabledError) setReadOnly(true);
        setPending((ps) => ps.map((x) => (x.clientId === p.clientId ? { ...x, state: 'failed', error: describeControlError(err) } : x)));
      }
    },
    [refetchThread],
  );

  const submit = useCallback(
    (text: string, opts: { kind: 'message' | 'answer'; replyTo: string | null; questionId: string | null; onStart: () => void }) => {
      gate.run(SEND_TOKEN_REASON, () => {
        localSeq += 1;
        const p: PendingMessage = {
          clientId: `local-${localSeq}`,
          kind: opts.kind,
          text,
          at: new Date().toISOString(),
          replyTo: opts.replyTo,
          questionId: opts.questionId,
          state: 'sending',
          error: null,
        };
        opts.onStart();
        stick.current = true;
        setPending((ps) => [...ps, p]);
        void deliver(p);
      });
    },
    [gate, deliver],
  );

  const sendDraft = useCallback(
    (text: string) => {
      // A question the thread has no message for is answered as a quoted message.
      const body = quote ? `> ${quote.replace(/\n/g, ' ')}\n\n${text}` : text;
      submit(body, {
        kind: 'message',
        replyTo: null,
        questionId: null,
        onStart: () => {
          setDraft('');
          setQuote(null);
        },
      });
    },
    [quote, submit],
  );

  const onAnswer = useCallback(
    (question: LeaderThreadMessage, text: string) => {
      submit(text, {
        kind: 'answer',
        replyTo: question.id,
        questionId: question.questionId ?? question.id,
        onStart: () => setAnswerDrafts((d) => ({ ...d, [question.id]: '' })),
      });
    },
    [submit],
  );

  const onRetry = useCallback(
    (clientId: string) => {
      gate.run(SEND_TOKEN_REASON, () => {
        const found = pending.find((x) => x.clientId === clientId);
        if (!found) return;
        // Retried now: it moves to the end of the thread, where a new send would sit.
        const again: PendingMessage = { ...found, state: 'sending', error: null, at: new Date().toISOString() };
        stick.current = true;
        setPending((ps) => ps.map((x) => (x.clientId === clientId ? again : x)));
        void deliver(again);
      });
    },
    [gate, pending, deliver],
  );

  const onDiscard = useCallback((clientId: string) => setPending((ps) => ps.filter((x) => x.clientId !== clientId)), []);

  // ---- focus requests (⌘K, Command, Needs-you) ------------------------------

  const request = useSyncExternalStore(subscribeLeaderFocus, getLeaderFocus, () => null);
  useEffect(() => {
    if (!request) return;
    if (!isLeaderFocusLive(request)) {
      takeLeaderFocus(request.seq);
      return;
    }
    if (request.kind === 'composer') {
      stick.current = true;
      composerRef.current?.focus();
      takeLeaderFocus(request.seq);
      return;
    }
    if (request.kind === 'directive') {
      setAddingDirective(true);
      takeLeaderFocus(request.seq);
      return;
    }
    // A question: wait for the first read, then find it.
    if (!read) return;
    const q = findQuestion(messages, request);
    if (q) setFocusQuestionId(q.id);
    else {
      setQuote(request.text ?? 'the Leader’s question');
      composerRef.current?.focus();
    }
    takeLeaderFocus(request.seq);
  }, [request, read, messages]);

  // Reveal the asked-for question; focus its answer box when it has one.
  useEffect(() => {
    if (!focusQuestionId) return;
    // Matched by dataset, not a selector: ids are server strings.
    const host = [...(logRef.current?.querySelectorAll<HTMLElement>('[data-question-id]') ?? [])].find((el) => el.dataset['questionId'] === focusQuestionId);
    if (!host) return;
    host.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    const box = host.querySelector<HTMLTextAreaElement>('textarea');
    box?.focus({ preventScroll: true });
    const t = window.setTimeout(() => setFocusQuestionId(null), 2_400);
    return () => window.clearTimeout(t);
  }, [focusQuestionId]);

  // ---- scrolling ------------------------------------------------------------

  const onScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  }, []);

  const lastKey = entries.length ? entries[entries.length - 1]!.key : null;
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    // Follow the conversation down only when the operator is already at its end (or just sent).
    if (stick.current || atEnd.current) el.scrollTop = el.scrollHeight;
    stick.current = false;
  }, [lastKey, thinking]);

  // Content also grows WITHOUT a new message — the Markdown chunk lands, the
  // Leader's state turns a memo's text into its card, a font swaps in. An
  // operator at the end stays at the end through all of it.
  useEffect(() => {
    const el = logRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    // Judged against the height BEFORE this growth: the scroll event for the
    // growth can land first and call the operator "not at the end" when they were.
    let before = el.scrollHeight;
    const ro = new ResizeObserver(() => {
      const wasAtEnd = el.scrollTop + el.clientHeight >= before - STICK_PX;
      if (wasAtEnd || atEnd.current) {
        el.scrollTop = el.scrollHeight;
        atEnd.current = true;
      }
      before = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // ---- older pages ----------------------------------------------------------

  const oldestId = messages.length ? messages[0]!.id : null;
  const canLoadOlder = olderState !== 'done' && olderState !== 'loading' && (page?.length ?? 0) >= THREAD_PAGE_SIZE && oldestId !== null;
  const loadOlder = useCallback(async () => {
    if (!oldestId) return;
    const el = logRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    setOlderState('loading');
    try {
      const got = await fetchOlderThread(oldestId);
      setOlder((o) => [...got, ...o]);
      setOlderState(got.length < THREAD_PAGE_SIZE ? 'done' : 'idle');
      // Keep the operator's place: the page grows above them.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    } catch {
      setOlderState('error');
    }
  }, [oldestId]);

  // ---- render ---------------------------------------------------------------

  const answering = useMemo(
    () => new Set(pending.filter((p) => p.kind === 'answer' && p.state === 'sending' && p.questionId).map((p) => p.questionId!)),
    [pending],
  );
  const ctx: ThreadContext = {
    leader: leader?.value ?? null,
    actions,
    answered,
    byId,
    answering,
    focusQuestionId,
    answerDraft: (id) => answerDrafts[id] ?? '',
    setAnswerDraft: (id, text) => setAnswerDrafts((d) => ({ ...d, [id]: text })),
    onAnswer,
    onRetry,
    onDiscard,
    sendDisabledReason,
    dormant,
  };

  return (
    <section className={styles.panel} aria-labelledby={titleId} data-testid="leader-conversation">
      <header className={styles.head}>
        <span className={styles.heading}>
          <h3 id={titleId} className={styles.title}>Leader</h3>
          <span className={styles.caption}>One conversation across Verse, Telegram and the CLI</span>
        </span>
        {dormant ? (
          <span className={styles.dormant} title="The Leader still reads, answers and writes memos. With autonomy off, every memo is a dry run: its actions are shown, never applied.">
            <span className={styles.dormantDot} aria-hidden="true" />
            Autonomy off · memos are dry runs
          </span>
        ) : null}
      </header>

      <DirectivesStrip read={directives.data} actions={actions} adding={addingDirective} onAddingChange={setAddingDirective} />

      <div ref={logRef} className={styles.log} role="log" aria-label="Conversation with the Leader" aria-live="polite" aria-relevant="additions" onScroll={onScroll} tabIndex={0}>
        <div ref={contentRef} className={styles.logInner}>
          {canLoadOlder || olderState === 'error' || olderState === 'loading' ? (
            <div className={styles.older}>
              <button type="button" className={styles.textButton} onClick={() => void loadOlder()} disabled={olderState === 'loading'}>
                {olderState === 'loading' ? 'Loading earlier messages…' : olderState === 'error' ? 'Earlier messages did not load — try again' : 'Load earlier messages'}
              </button>
            </div>
          ) : null}
          {!read ? (
            <p className={styles.placeholder} aria-busy="true">Reading the conversation…</p>
          ) : unavailable && entries.length === 0 ? (
            <p className={styles.placeholder} data-tone="unknown">{read.reason ?? 'The Leader conversation did not answer.'}</p>
          ) : entries.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>No conversation yet</p>
              <p className={styles.emptyBody}>
                Ask the Leader why it made a move, what it would do next, or give it a standing directive. Replies here also reach Telegram when it is connected.
              </p>
              {sendDisabledReason === null ? (
                <div className={styles.suggestions}>
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={styles.suggestion}
                      onClick={() => {
                        setDraft(s);
                        composerRef.current?.focus();
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <ThreadRows rows={rows} ctx={ctx} />
          )}
          {thinking ? (
            <p className={styles.thinking} role="status">
              <span className={styles.dots} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              Leader is thinking…
            </p>
          ) : null}
        </div>
      </div>

      <div className={styles.foot}>
        <LeaderComposer
          ref={composerRef}
          label="Message the Leader"
          placeholder="Message the Leader…"
          value={draft}
          onChange={setDraft}
          onSend={sendDraft}
          disabledReason={sendDisabledReason}
          context={quote ? { label: `Answering: ${previewText(quote, 120)}`, onClear: () => setQuote(null) } : null}
        />
      </div>
      {gate.dialog}
    </section>
  );
}

export default LeaderConversation;

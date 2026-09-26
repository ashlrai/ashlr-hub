/**
 * routes/verse/leader/ThreadItems.tsx — how each kind of Leader-thread
 * message draws (grouping and order are thread-model.ts; state and sends
 * are LeaderConversation.tsx).
 *
 *   message / update   Leader: prose (sanitised Markdown), left
 *                      Mason:  a quiet bubble (plain text), right
 *   memo               a card: bottleneck, the move (+ expected delta), the
 *                      actions with their class chip, veto countdown and
 *                      [Approve] [Veto]; a dry-run memo says so and offers none
 *   question           the question and, until answered, its answer box
 *   answer             Mason's bubble, headed by the question it answers
 *   directive          a pinned chip ("Directive · …")
 *   action             the Leader's note plus the actions it is about
 *   system             one centred quiet line
 *   pending            Mason's bubble while sending; on failure the reason,
 *                      Retry and Discard
 *
 * Memo and action fields are the Leader's own text: plain text, like the
 * rest of Mind. Conversational text goes through MessageMarkdown, the chat's
 * sanitising renderer (DOMPurify; links open in a new tab, no HTML survives).
 */
import type { LeaderAction, LeaderStateV1 } from '../../../../core/vision/leader-types.js';
import { IconCheck } from '../../../components/primitives/icons.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import type { SurfaceActions } from '../command/actions.js';
import { ActionRow } from '../command/LeaderCard.js';
import { scrollToAnchor } from '../command/nav.js';
import commandStyles from '../command/command.module.css';
import { expectedDeltaText, memoActions } from '../mind/leader-model.js';
import { LeaderComposer } from './LeaderComposer.js';
import { CHANNEL_LABEL, clockTime, previewText, type PendingMessage, type ThreadEntry, type ThreadRow } from './thread-model.js';
import type { LeaderThreadChannel, LeaderThreadMessage } from './thread-types.js';
import styles from './leader.module.css';

export function ChannelBadge({ channel }: { channel: LeaderThreadChannel }) {
  return (
    <span className={styles.channel} data-channel={channel} title={`Sent via ${CHANNEL_LABEL[channel]}`}>
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

/** "Also sent to Telegram" / "Telegram: not delivered" — only what the server reported. */
function deliveryNote(delivery: LeaderThreadMessage['delivery']): { text: string; failed: boolean } | null {
  if (!delivery) return null;
  const channels = Object.entries(delivery).filter(([ch]) => ch !== 'verse');
  const failed = channels.filter(([, s]) => /fail|error|undeliver/i.test(s)).map(([ch]) => CHANNEL_LABEL[ch as LeaderThreadChannel] ?? ch);
  if (failed.length) return { text: `${failed.join(', ')}: not delivered`, failed: true };
  const sent = channels.filter(([, s]) => /sent|deliver|ok/i.test(s)).map(([ch]) => CHANNEL_LABEL[ch as LeaderThreadChannel] ?? ch);
  return sent.length ? { text: `Also sent to ${sent.join(', ')}`, failed: false } : null;
}

export interface ThreadContext {
  leader: LeaderStateV1 | null;
  actions: SurfaceActions;
  /** question message id → its answer. */
  answered: ReadonlyMap<string, LeaderThreadMessage>;
  /** Every known message by id (an answer names its question). */
  byId: ReadonlyMap<string, LeaderThreadMessage>;
  /** Question ids with an answer in flight. */
  answering: ReadonlySet<string>;
  /** The question whose box should take focus (a Needs-you "Answer"). */
  focusQuestionId: string | null;
  answerDraft: (questionMessageId: string) => string;
  setAnswerDraft: (questionMessageId: string, text: string) => void;
  onAnswer: (question: LeaderThreadMessage, text: string) => void;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
  /** Why sending is off (read-only, route absent); null = on. */
  sendDisabledReason: string | null;
  /** Autonomy is off: memos are dry runs. */
  dormant: boolean;
}

/** The question an answer closes, by its id or the message it replies to. */
function questionOf(m: LeaderThreadMessage, ctx: ThreadContext): LeaderThreadMessage | null {
  if (m.replyTo) {
    const q = ctx.byId.get(m.replyTo);
    if (q) return q;
  }
  if (m.questionId) {
    for (const q of ctx.byId.values()) if (q.kind === 'question' && q.questionId === m.questionId) return q;
  }
  return null;
}

function MemoCard({ message, ctx }: { message: LeaderThreadMessage; ctx: ThreadContext }) {
  const { leader } = ctx;
  const memoId = message.memoId ?? null;
  const memo = memoId && leader?.latest?.id === memoId ? leader.latest : null;
  const summary = memoId ? leader?.timeline.find((t) => t.id === memoId) ?? null : null;
  let list: LeaderAction[] = [];
  if (leader) {
    if (memo) list = memoActions(leader);
    else if (message.actionIds) list = message.actionIds.flatMap((id) => leader.actions.find((a) => a.id === id) ?? []);
    else if (memoId) list = leader.actions.filter((a) => a.memoId === memoId);
  }
  const bottleneck = memo?.bottleneck?.statement ?? summary?.bottleneck ?? null;
  const move = memo?.move?.statement ?? summary?.move ?? null;
  const delta = expectedDeltaText(memo?.move?.expectedDelta ?? summary?.expectedDelta ?? null);
  const dryRun = memo?.dryRun ?? false;
  const structured = bottleneck !== null || move !== null || list.length > 0;
  return (
    <article className={styles.memoCard} aria-label="Leader memo" data-dry-run={dryRun ? 'true' : undefined}>
      <header className={styles.memoHead}>
        <span className={styles.micro}>Memo</span>
        {dryRun ? <span className={commandStyles.dryRun}>Dry run</span> : null}
        {summary ? (
          <button type="button" className={styles.textButton} onClick={() => scrollToAnchor(`memo-${summary.id}`)}>
            In the timeline
          </button>
        ) : null}
      </header>
      {structured ? (
        <dl className={styles.memoFacts}>
          {bottleneck ? (
            <div>
              <dt className={styles.micro}>Bottleneck</dt>
              <dd>{bottleneck}</dd>
            </div>
          ) : null}
          {move ? (
            <div>
              <dt className={styles.micro}>The move</dt>
              <dd>
                {move}
                {delta ? <span className={styles.delta}>{delta}</span> : null}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <div className={styles.prose}>
          <MessageMarkdown text={message.text} />
        </div>
      )}
      {list.length ? (
        <ul className={`${commandStyles.actionList} ${styles.memoActions}`} aria-label="Memo actions">
          {list.map((a) => (
            <ActionRow key={a.id} action={a} actions={ctx.actions} approve dryRun={dryRun} anchored={false} />
          ))}
        </ul>
      ) : null}
      {dryRun ? (
        <p className={styles.muted}>
          {ctx.dormant ? 'Autonomy is off, so this memo is a dry run — its actions are shown, never applied.' : 'Shadow stage — these actions are shown, never applied.'}
        </p>
      ) : null}
      {structured && message.text.trim() ? (
        <details className={styles.more}>
          <summary>The Leader’s note</summary>
          <div className={styles.prose}>
            <MessageMarkdown text={message.text} />
          </div>
        </details>
      ) : null}
    </article>
  );
}

function QuestionCard({ message, ctx }: { message: LeaderThreadMessage; ctx: ThreadContext }) {
  const answer = ctx.answered.get(message.id) ?? null;
  const sending = ctx.answering.has(message.questionId ?? message.id);
  return (
    <article className={styles.question} aria-label="Leader question" data-answered={answer ? 'true' : undefined} data-focused={ctx.focusQuestionId === message.id ? 'true' : undefined} data-question-id={message.id}>
      <span className={styles.micro}>Question{message.memoId ? ' · from the memo' : ''}</span>
      <div className={styles.prose}>
        <MessageMarkdown text={message.text} />
      </div>
      {answer ? (
        <p className={styles.answered}>
          <IconCheck /> Answered{answer.channel !== 'verse' ? ` on ${CHANNEL_LABEL[answer.channel]}` : ''} · <span className={styles.answeredText}>{previewText(answer.text, 120)}</span>
        </p>
      ) : sending ? (
        <p className={styles.muted} role="status">Sending your answer…</p>
      ) : (
        <LeaderComposer
          variant="answer"
          label={`Answer the Leader: ${previewText(message.text, 80)}`}
          placeholder="Answer the Leader…"
          value={ctx.answerDraft(message.id)}
          onChange={(v) => ctx.setAnswerDraft(message.id, v)}
          onSend={(text) => ctx.onAnswer(message, text)}
          disabledReason={ctx.sendDisabledReason}
          autoFocus={ctx.focusQuestionId === message.id}
          maxLines={6}
        />
      )}
    </article>
  );
}

function ActionNote({ message, ctx }: { message: LeaderThreadMessage; ctx: ThreadContext }) {
  const list = ctx.leader && message.actionIds ? message.actionIds.flatMap((id) => ctx.leader!.actions.find((a) => a.id === id) ?? []) : [];
  return (
    <div className={styles.leaderText}>
      <div className={styles.prose}>
        <MessageMarkdown text={message.text} />
      </div>
      {list.length ? (
        <ul className={`${commandStyles.actionList} ${styles.memoActions}`} aria-label="Actions">
          {list.map((a) => (
            <ActionRow key={a.id} action={a} actions={ctx.actions} approve compact anchored={false} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MasonBubble({ message, ctx }: { message: LeaderThreadMessage; ctx: ThreadContext }) {
  const question = message.kind === 'answer' || message.replyTo ? questionOf(message, ctx) : null;
  const note = deliveryNote(message.delivery);
  return (
    <div className={styles.masonItem}>
      {question ? <span className={styles.replyTo} title={question.text}>Re: {previewText(question.text, 90)}</span> : null}
      {/* Mason's words, possibly from Telegram: plain text, never HTML. */}
      <p className={styles.bubble}>{message.text}</p>
      {note ? <span className={styles.delivery} data-failed={note.failed ? 'true' : undefined}>{note.text}</span> : null}
    </div>
  );
}

function PendingBubble({ pending, ctx }: { pending: PendingMessage; ctx: ThreadContext }) {
  return (
    <div className={styles.masonItem} data-state={pending.state}>
      <p className={styles.bubble} data-state={pending.state}>{pending.text}</p>
      {pending.state === 'sending' ? (
        <span className={styles.delivery}>Sending…</span>
      ) : (
        <span className={styles.failed} role="alert">
          Not sent{pending.error ? ` — ${pending.error.replace(/\.$/, '')}` : ''}.
          <button type="button" className={styles.textButton} onClick={() => ctx.onRetry(pending.clientId)} disabled={ctx.sendDisabledReason !== null}>
            Retry
          </button>
          <button type="button" className={styles.textButton} onClick={() => ctx.onDiscard(pending.clientId)}>
            Discard
          </button>
        </span>
      )}
    </div>
  );
}

function DirectiveNote({ message }: { message: LeaderThreadMessage }) {
  return (
    <p className={styles.directiveNote}>
      <span className={styles.pin} aria-hidden="true" />
      <span className={styles.micro}>Directive</span>
      <span className={styles.directiveNoteText}>{message.text}</span>
    </p>
  );
}

function EntryView({ entry, ctx }: { entry: ThreadEntry; ctx: ThreadContext }) {
  if (entry.type === 'pending') return <PendingBubble pending={entry.pending} ctx={ctx} />;
  const m = entry.message;
  switch (m.kind) {
    case 'memo':
      return <MemoCard message={m} ctx={ctx} />;
    case 'question':
      return <QuestionCard message={m} ctx={ctx} />;
    case 'directive':
      return <DirectiveNote message={m} />;
    case 'action':
      return m.from === 'leader' ? <ActionNote message={m} ctx={ctx} /> : <MasonBubble message={m} ctx={ctx} />;
    default:
      return m.from === 'mason' ? (
        <MasonBubble message={m} ctx={ctx} />
      ) : (
        <div className={styles.leaderText}>
          <div className={styles.prose}>
            <MessageMarkdown text={m.text} />
          </div>
        </div>
      );
  }
}

export function ThreadRows({ rows, ctx }: { rows: readonly ThreadRow[]; ctx: ThreadContext }) {
  return (
    <>
      {rows.map((row) => {
        if (row.type === 'day') {
          return (
            <div key={row.key} className={styles.day} role="separator" aria-label={row.label}>
              <span>{row.label}</span>
            </div>
          );
        }
        if (row.type === 'system') {
          return (
            <p key={row.key} className={styles.system} data-message-id={row.entry.message.id}>
              {row.entry.message.text} <time dateTime={row.entry.message.at}>{clockTime(row.entry.message.at)}</time>
            </p>
          );
        }
        const leader = row.from === 'leader';
        return (
          <section key={row.key} className={styles.group} data-from={row.from} aria-label={`${leader ? 'Leader' : 'You'}, ${clockTime(row.at)}`}>
            <header className={styles.groupHead}>
              <span className={styles.avatar} data-from={row.from} aria-hidden="true">{leader ? 'L' : 'M'}</span>
              <span className={styles.who}>{leader ? 'Leader' : 'You'}</span>
              <ChannelBadge channel={row.channel} />
              <time className={styles.time} dateTime={row.at} title={new Date(row.at).toLocaleString('en-US')}>
                {clockTime(row.at)}
              </time>
            </header>
            <div className={styles.groupBody}>
              {row.entries.map((e) => (
                <div key={e.key} className={styles.entry} data-message-id={e.type === 'message' ? e.message.id : undefined} data-kind={e.type === 'message' ? e.message.kind : 'pending'}>
                  <EntryView entry={e} ctx={ctx} />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

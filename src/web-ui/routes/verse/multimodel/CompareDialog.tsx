/**
 * routes/verse/multimodel/CompareDialog.tsx — answers side by side.
 *
 * COMPARE: pick 2–3 seats (default: the Auto choice plus the best seat of
 * each other engine, one local model when there is one — typically Claude +
 * Codex + local), then send. Each seat gets a real chat on the same folders,
 * linked to this one, with the zero-spend handoff note first when this chat
 * already has turns. Answers stream into columns; "Continue with this" opens
 * that chat (its context is already there) and records the pick, which the
 * Auto seat learns from.
 *
 * REVIEW: one cross-family reviewer on the last answer, side by side with it.
 *
 * Every chat here is created and every turn sent through the ordinary session
 * routes (multimodel-flows.ts), so the gates that apply to a typed message
 * apply to each of these. Nothing is sent until the operator presses the
 * button that says how many seats it goes to.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { VerseSeat, VerseSession } from '../../../data/api-types.js';
import { classifyPrompt } from '../../../../core/verse/multimodel/classify.js';
import { COMPARE_MAX_SEATS, defaultCompareSet, type FanOutEntry } from '../../../../core/verse/multimodel/compare.js';
import type { AdvisorSeat } from '../../../../core/verse/multimodel/advisor.js';
import type { SeatAdvice, SeatAdviceOption } from '../../../../core/verse/multimodel/types.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { useVerseSession } from '../useVerseSession.js';
import { useVerseTranscript } from '../useVerseTranscript.js';
import { formatTokens } from '../verse-readouts.js';
import { DEFAULT_FLOW_API, pickWinner, startCompare, startReview, type FlowTarget } from './multimodel-flows.js';
import styles from './multimodel.module.css';

type CompareProps = { mode: 'compare'; prompt: string };
type ReviewProps = { mode: 'review'; reviewer: SeatAdviceOption; question: string | null; answer: string; authorLabel: string };

export type CompareDialogProps = (CompareProps | ReviewProps) & {
  source: VerseSession;
  seats: readonly VerseSeat[];
  advisorSeats: readonly AdvisorSeat[];
  advice: SeatAdvice | null;
  /** The prompt left the composer (compare sent). */
  onStarted(): void;
  onClose(): void;
};

interface Column {
  key: string;
  label: string;
  engine: string;
  seatId: string;
  model: string | null;
  sessionId: string | null;
  error: string | null;
  /** A fixed text (the answer under review) instead of a live chat. */
  staticText?: string;
}

function toTarget(o: SeatAdviceOption): FlowTarget {
  return { seatId: o.seatId, model: o.model, label: o.label, engine: o.engine };
}

function columnsFrom(entries: readonly FanOutEntry[]): Column[] {
  return entries.map((e) => ({
    key: e.target.seatId,
    label: e.target.label,
    engine: e.target.engine,
    seatId: e.target.seatId,
    model: e.target.model,
    sessionId: e.sessionId,
    error: e.ok ? null : e.error,
  }));
}

export function CompareDialog(props: CompareDialogProps) {
  const titleId = useId();
  const { source, advice } = props;
  const kind = useMemo(() => classifyPrompt(props.mode === 'compare' ? props.prompt : props.question ?? '').kind, [props]);

  // Candidates: every seat the advisor could use for this chat (local-only repos: local seats only).
  const candidates: SeatAdviceOption[] = useMemo(() => {
    const ranked = advice ? [...(advice.choice ? [advice.choice] : []), ...advice.alternatives] : [];
    return ranked.length > 0 ? ranked : props.advisorSeats.filter((s) => s.model).map((s) => ({
      seatId: s.seatId, label: s.label, engine: s.engine, model: s.model, local: s.local, note: s.local ? 'free · local' : '',
    }));
  }, [advice, props.advisorSeats]);
  const [chosen, setChosen] = useState<string[]>(() => defaultCompareSet(advice?.choice ?? null, candidates).map((o) => o.seatId));
  const [columns, setColumns] = useState<Column[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  // Review starts on open: the click that opened it was the consent, and its label named the seat.
  useEffect(() => {
    if (props.mode !== 'review' || started.current) return;
    started.current = true;
    const reviewer = props.reviewer;
    const original: Column = { key: 'original', label: props.authorLabel, engine: source.engine, seatId: source.seatId, model: source.model, sessionId: null, error: null, staticText: props.answer };
    setColumns([original, { key: reviewer.seatId, label: reviewer.label, engine: reviewer.engine, seatId: reviewer.seatId, model: reviewer.model, sessionId: null, error: null }]);
    setBusy(true);
    void startReview(DEFAULT_FLOW_API, { source, reviewer: toTarget(reviewer), question: props.question, answer: props.answer, authorLabel: props.authorLabel })
      .then((session) => setColumns((cols) => cols?.map((c) => (c.key === reviewer.seatId ? { ...c, sessionId: session.id } : c)) ?? null))
      .catch((err: unknown) => setColumns((cols) => cols?.map((c) => (c.key === reviewer.seatId ? { ...c, error: err instanceof Error ? err.message : 'The review could not start.' } : c)) ?? null))
      .finally(() => setBusy(false));
  }, [props, source]);

  async function send() {
    if (props.mode !== 'compare') return;
    const targets = candidates.filter((c) => chosen.includes(c.seatId)).map(toTarget);
    if (targets.length < 2) {
      setError('Pick at least two seats to compare.');
      return;
    }
    setBusy(true);
    setError(null);
    setColumns(targets.map((t) => ({ key: t.seatId, label: t.label, engine: t.engine, seatId: t.seatId, model: t.model, sessionId: null, error: null })));
    try {
      const entries = await startCompare(DEFAULT_FLOW_API, { source, targets, text: props.prompt });
      setColumns(columnsFrom(entries));
      if (entries.some((e) => e.ok)) props.onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compare could not start.');
    } finally {
      setBusy(false);
    }
  }

  function toggle(seatId: string) {
    setChosen((cur) => (cur.includes(seatId) ? cur.filter((id) => id !== seatId) : cur.length >= COMPARE_MAX_SEATS ? cur : [...cur, seatId]));
  }

  async function choose(column: Column) {
    if (!column.sessionId || !columns) return;
    const entries = columns.filter((c) => c.sessionId && !c.staticText).map((c) => ({ sessionId: c.sessionId!, seatId: c.seatId, engine: c.engine, ...(c.model ? { model: c.model } : {}) }));
    await pickWinner(DEFAULT_FLOW_API, { winnerSessionId: column.sessionId, entries, kind });
    props.onClose();
  }

  const title = props.mode === 'compare' ? 'Compare answers' : `Review by ${props.reviewer.label}`;
  const description = props.mode === 'compare'
    ? (source.turnCount > 0
      ? 'Each seat gets this chat’s handoff note (built here, free) and your message, in its own chat on the same folders.'
      : 'Each seat gets your message in its own chat on the same folders.')
    : `A different model family reviews ${props.authorLabel}’s last answer. It may read the repository but changes nothing.`;

  return (
    <Dialog open onClose={props.onClose} titleId={titleId} title={title} description={description} widthClassName={styles.dialog}>
      {columns === null && props.mode === 'compare' ? (
        <>
          <ul className={styles.pickList} aria-label="Seats to compare">
            {candidates.map((c) => (
              <li key={c.seatId} className={styles.pickRow}>
                <label>
                  <input type="checkbox" checked={chosen.includes(c.seatId)} onChange={() => toggle(c.seatId)}
                    disabled={!chosen.includes(c.seatId) && chosen.length >= COMPARE_MAX_SEATS} />
                  {' '}{c.label}
                </label>
                <span className={styles.pickNote}>{c.note}</span>
              </li>
            ))}
          </ul>
          {error ? <p className={styles.noticeError} role="alert">{error}</p> : null}
          <div className={styles.footer}>
            <button type="button" className={styles.secondary} onClick={props.onClose}>Cancel</button>
            <button type="button" className={styles.primary} disabled={busy || chosen.length < 2} onClick={() => { void send(); }}>
              Send to {chosen.length} seats
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.columns}>
            {(columns ?? []).map((c) => (
              <AnswerColumn key={c.key} column={c} canChoose={props.mode === 'compare'} onChoose={() => { void choose(c); }} />
            ))}
          </div>
          {error ? <p className={styles.noticeError} role="alert">{error}</p> : null}
          <div className={styles.footer}>
            <button type="button" className={styles.secondary} onClick={props.onClose}>{busy ? 'Close (keeps running)' : 'Close'}</button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function AnswerColumn({ column, canChoose, onChoose }: { column: Column; canChoose: boolean; onChoose(): void }) {
  // Subscribing opens the chat's stream; a static column subscribes to nothing.
  const head = useVerseSession(column.staticText === undefined ? column.sessionId : null);
  const transcript = useVerseTranscript(column.staticText === undefined ? column.sessionId : null);
  const answer = column.staticText ?? transcript.items.flatMap((it) => (it.kind === 'assistant' ? [it.text] : [])).join('\n\n');
  const streaming = column.staticText === undefined && transcript.live;
  const failed = transcript.items.find((it) => it.kind === 'error');
  const usage = head.session?.usage;
  const status = column.error ? `Could not start: ${column.error}`
    : column.staticText !== undefined ? 'The answer under review'
      : column.sessionId === null ? 'Starting…'
        : failed?.kind === 'error' ? `Failed: ${failed.message}`
          : streaming ? 'Answering…' : answer ? 'Done' : 'Waiting…';
  return (
    <section className={styles.column} aria-label={column.label} aria-busy={streaming || undefined}>
      <header className={styles.columnHead}>
        <span className={styles.columnTitle}>{column.label}</span>
        <span className={styles.columnMeta}>
          {column.engine === 'local' ? 'on this Mac · ' : ''}
          {usage && usage.outputTokens > 0 ? `${formatTokens(usage.inputTokens + usage.outputTokens)} tok · ` : ''}
          {status}
        </span>
      </header>
      <div className={styles.columnBody}>
        {answer ? <MessageMarkdown text={answer} streaming={streaming} /> : null}
      </div>
      {canChoose && column.sessionId && !column.error ? (
        <div className={styles.columnActions}>
          <button type="button" className={styles.secondary} disabled={streaming || !answer} onClick={onChoose}>Continue with this</button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * routes/verse/context/HandoffDialog.tsx — "Continue in a fresh chat".
 *
 * A long session gets expensive (every turn re-sends the whole prefix) and
 * forgetful (after a couple of compactions its early turns survive only as
 * summaries). The fix is a NEW session that starts from a written note
 * instead of the full history. This dialog builds that note, lets the
 * operator read and edit it, picks where it continues, and creates the
 * session — and then STOPS. The note is handed back through `onCreated` so
 * the caller can drop it into the new chat's composer; the operator presses
 * Send. That keeps the spending rule simple enough to say in one sentence:
 *
 *   Building the preview and creating the chat spend nothing. The first
 *   thing spent is the turn the operator sends, having read it.
 *
 * The one optional spend is "Ask this seat to summarize first": an ordinary
 * turn on the CURRENT session (through `sendVerseTurn`, so it passes the
 * engine's spend chokepoint and the local-only policy like any other turn),
 * after which the preview is rebuilt with `includeLastAssistant` so the
 * seat's own summary is carried over verbatim. It is a button, never a
 * default, and its cost is stated beside it in the seat's own name.
 *
 * Mounted only while open (the exported wrapper returns null otherwise), so
 * every open starts from a clean state and nothing is fetched for a dialog
 * nobody opened.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { VerseEvent, VerseSeat, VerseSession } from '../../../data/api-types.js';
import {
  VERSE_HANDOFF_MAX_CHARS,
  VERSE_HANDOFF_SUMMARY_REQUEST,
  VERSE_MAX_TURN_TEXT_BYTES,
  type VerseContextMode,
  type VerseHandoffPreview,
} from '../../../../core/verse/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { useQuery } from '../../../data/hooks.js';
import { SeatSelector, type SeatChoice } from '../SeatSelector.js';
import { ENGINE_LABEL, seatById } from '../verse-model.js';
import { cancelVerseTurn, fetchVerseSessionDetail, sendVerseTurn } from '../verse-queries.js';
import {
  getVerseSessionState,
  seedVerseSession,
  setVerseSession,
  setVerseSessionStatus,
  subscribeVerseStore,
} from '../verse-store.js';
import { expansiveMeteringNote, expansiveRatioSentence } from '../usage/context-model.js';
import { rememberVerseSeat } from '../verse-ui-store.js';
import { extraRootsCaveat } from '../workspace-model.js';
import {
  budgetLine,
  defaultHandoffMode,
  defaultHandoffTarget,
  handoffFit,
  handoffTitle,
  modelOption,
  offersExpansive,
  requestMode,
  targetUnavailableReason,
  TITLE_MAX_CHARS,
  turnCostSentence,
  utf8Bytes,
  API_BODY_MAX_BYTES,
  jsonBodyBytes,
  type HandoffTarget,
} from './context-model.js';
import {
  createHandoffSession,
  fetchHandoffPreview,
  HANDOFF_FOCUS_MAX_CHARS,
  versePreferencesQuery,
} from './context-queries.js';
import { describeContextError, useTokenGate } from './use-token-gate.js';
import styles from './context.module.css';

export interface HandoffDialogProps {
  /** The session being handed off (the live record — its status gates "summarize"). */
  session: VerseSession;
  seats: readonly VerseSeat[];
  open: boolean;
  onClose: () => void;
  /**
   * The new session exists. `text` is the handoff exactly as the operator left
   * it in the editor — pre-fill it into the new chat's composer; do NOT send it.
   */
  onCreated: (session: VerseSession, text: string) => void;
  /**
   * The seat + model to open on, when the operator already named one — the
   * composer's "Continue on ‹seat›" (Workspace). Absent = the usual default
   * (same seat and model, "same agent, fresh context"). See
   * `initialHandoffTarget` for how a stale choice is resolved.
   */
  initialTarget?: SeatChoice;
}

/**
 * Where the dialog opens. An explicit `initial` choice wins over the default
 * because the operator just picked it; the dialog must not silently swap it
 * for "same seat" and make them pick again.
 *
 * - The seat is in the roster → that seat, on the named model (matched
 *   exactly, then by canonical id). If the model is gone, the seat's first
 *   runnable model: the seat was the choice; the model id may be an alias the
 *   roster has since renamed. If nothing on it runs, the named model stays
 *   selected so `targetUnavailableReason` says WHY, rather than a different
 *   seat appearing unasked.
 * - The roster is still empty (cold bootstrap) → null; the fill-once effect
 *   retries with the same choice when seats arrive.
 * - The seat is not in a loaded roster (removed since) → the ordinary default.
 */
export function initialHandoffTarget(
  seats: readonly VerseSeat[],
  source: Pick<VerseSession, 'seatId' | 'model'>,
  initial: SeatChoice | undefined,
): HandoffTarget | null {
  if (!initial) return defaultHandoffTarget(seats, source);
  if (seats.length === 0) return null;
  const seat = seats.find((s) => s.id === initial.seatId);
  if (!seat) return defaultHandoffTarget(seats, source);
  const named = modelOption(seat, initial.model);
  if (named) return { seatId: seat.id, model: named.id };
  const runnable = seat.models.find((m) => !m.unavailableReason);
  return { seatId: seat.id, model: runnable ? runnable.id : initial.model };
}

/** How often to re-read a session's log while waiting on a summary, when no live stream feeds the store. */
export const SUMMARY_POLL_MS = 4_000;

const PREVIEW_REASON = 'Building the handoff reads this chat’s log and runs `git diff --stat` on its folders. It spends nothing.';
const SUMMARY_REASON = 'Asking for a summary sends one turn to this chat’s seat.';
const CANCEL_REASON = 'Stopping the summary turn.';
const CREATE_REASON = 'Creating the chat records a new session on this machine. Nothing is sent to a model until you press Send in it.';

type PreviewStatus = 'idle' | 'locked' | 'loading' | 'ready' | 'error';

type SummaryState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'waiting'; turnId: string }
  | { phase: 'cancelling'; turnId: string }
  | { phase: 'done' }
  | { phase: 'failed'; message: string };

type TurnOutcome = { kind: 'ok' } | { kind: 'cancelled' } | { kind: 'failed'; message: string | null } | { kind: 'empty' };

/**
 * How a turn ended, read from the session's event log; null while it runs.
 * Every terminal path in the engine emits `turn-done` (a stopped turn emits
 * `cancelled` first), so waiting for one of those two is sufficient.
 */
export function turnOutcome(events: readonly VerseEvent[], turnId: string): TurnOutcome | null {
  let lastError: string | null = null;
  let wroteReply = false;
  for (const e of events) {
    if (!('turnId' in e) || e.turnId !== turnId) continue;
    if (e.type === 'error') lastError = e.message;
    else if (e.type === 'assistant-message' || (e.type === 'text-delta' && e.text.trim().length > 0)) wroteReply = true;
    else if (e.type === 'cancelled') return { kind: 'cancelled' };
    else if (e.type === 'turn-done') {
      if (!e.ok) return { kind: 'failed', message: lastError };
      return wroteReply ? { kind: 'ok' } : { kind: 'empty' };
    }
  }
  return null;
}

export function HandoffDialog(props: HandoffDialogProps) {
  if (!props.open) return null;
  return <HandoffDialogBody {...props} />;
}

function HandoffDialogBody({ session, seats, onClose, onCreated, initialTarget }: HandoffDialogProps) {
  const titleId = useId();
  const focusId = useId();
  const textId = useId();
  const statsId = useId();
  const seatId = useId();
  const nameId = useId();
  const modeLabelId = useId();
  const focusRef = useRef<HTMLInputElement>(null);
  const gate = useTokenGate();
  const prefs = useQuery(versePreferencesQuery);

  // ---- preview -----------------------------------------------------------
  const [preview, setPreview] = useState<VerseHandoffPreview | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [focus, setFocus] = useState('');
  const [includeLastAssistant, setIncludeLastAssistant] = useState(false);
  /** Only the newest preview request may land (a rebuild can race the first read). */
  const requestSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Read through a ref by the async paths below, which outlive the render
  // that started them (a summary turn can take minutes).
  const previewRef = useRef<VerseHandoffPreview | null>(null);
  previewRef.current = preview;
  const runGated = gate.run;

  const requestPreview = useCallback(async (opts: { includeLastAssistant: boolean; focus: string }) => {
    const seq = (requestSeq.current += 1);
    setPreviewStatus('loading');
    setPreviewError(null);
    try {
      const result = await runGated(PREVIEW_REASON, () => fetchHandoffPreview(session.id, opts));
      if (!mounted.current || seq !== requestSeq.current) return;
      if (result === null) {
        // Token prompt dismissed: keep whatever preview is already on screen.
        setPreviewStatus(previewRef.current ? 'ready' : 'locked');
        return;
      }
      setPreview(result);
      setText(result.text);
      setPreviewStatus('ready');
    } catch (err) {
      if (!mounted.current || seq !== requestSeq.current) return;
      setPreviewError(describeContextError(err));
      setPreviewStatus('error');
    }
  }, [runGated, session.id]);

  // First build on open. With no token held it waits for an explicit unlock
  // rather than stacking a second dialog on top of this one uninvited.
  useEffect(() => {
    if (hasMutationHold()) void requestPreview({ includeLastAssistant: false, focus: '' });
    else setPreviewStatus('locked');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open; the body is mounted per open.
  }, []);

  const edited = preview !== null && text !== preview.text;
  // The new chat sends this as its first turn: it must fit the turn cap AND
  // the API's request-body cap once JSON-escaped, or the Send would be refused.
  const overTurnLimit = useMemo(
    () => utf8Bytes(text) > VERSE_MAX_TURN_TEXT_BYTES || jsonBodyBytes({ text }) > API_BODY_MAX_BYTES,
    [text],
  );
  const overBudget = text.length > VERSE_HANDOFF_MAX_CHARS;

  // ---- target ------------------------------------------------------------
  // The body mounts per open, so `initialTarget` is read once per open: a
  // later pick inside the dialog is never overwritten by the prop.
  const [target, setTarget] = useState<HandoffTarget | null>(() => initialHandoffTarget(seats, session, initialTarget));
  // Seats that arrive after the dialog opened (cold bootstrap) fill an empty target once.
  useEffect(() => {
    if (target === null && seats.length > 0) setTarget(initialHandoffTarget(seats, session, initialTarget));
  }, [target, seats, session, initialTarget]);
  const targetSeat = target ? seatById(seats, target.seatId) ?? null : null;
  const option = target ? modelOption(targetSeat, target.model) : null;
  const [modeChoice, setModeChoice] = useState<VerseContextMode | null>(null);
  const defaultMode = defaultHandoffMode({ option, target, source: session, preferences: prefs.data });
  const mode: VerseContextMode = modeChoice !== null && requestMode(option, modeChoice) !== undefined ? modeChoice : defaultMode;
  const expansiveOffered = offersExpansive(option);
  const unavailable = targetUnavailableReason(targetSeat, option);
  // The TARGET seat's engine: the new chat carries that CLI's fixed prompt, not the source's.
  const fit = handoffFit(text.length, option, mode, targetSeat?.engine ?? null);
  // Expansive's cost in the shared wording: the re-send ratio, then (codex
  // only) the reported >272k metering that multiplies it.
  const expansiveCost = [expansiveRatioSentence(option), expansiveMeteringNote(targetSeat?.engine)].filter(Boolean).join(' ');
  const rootCount = 1 + (session.extraRoots?.filter((r) => r && r !== session.projectPath).length ?? 0);
  const reachCaveat = extraRootsCaveat(targetSeat?.engine ?? null, rootCount);

  function chooseTarget(choice: SeatChoice) {
    setTarget({ seatId: choice.seatId, model: choice.model });
    // A new model re-derives its own default mode; a choice made for the old
    // model may not even exist on the new one.
    setModeChoice(null);
  }

  const [title, setTitle] = useState(() => handoffTitle(session.title));

  // ---- summarize first ---------------------------------------------------
  const [summary, setSummary] = useState<SummaryState>({ phase: 'idle' });
  const sourceSeat = seatById(seats, session.seatId);
  const sourceSeatLabel = sourceSeat?.label ?? ENGINE_LABEL[session.engine];
  const summarizing = summary.phase === 'sending' || summary.phase === 'waiting' || summary.phase === 'cancelling';
  const summarizeBlocked = session.status === 'running'
    ? 'A turn is running in this chat. Wait for it to finish first.'
    : session.turnCount === 0
      ? 'This chat has no turns yet, so there is nothing to summarize.'
      : null;

  async function summarize() {
    setSummary({ phase: 'sending' });
    try {
      const turnId = await gate.run(SUMMARY_REASON, async () => {
        setVerseSessionStatus(session.id, 'running');
        try {
          // The SHARED constant, verbatim: the handoff builder recognises this
          // exact text and keeps it out of the new chat's "latest requests".
          const response = await sendVerseTurn(session.id, VERSE_HANDOFF_SUMMARY_REQUEST);
          // Same reconciliation ChatSection's send uses: the turn may already
          // have settled by the time the 202 is applied.
          setVerseSession(session.id, response.session, response.turnId);
          return response.turnId;
        } catch (err) {
          setVerseSessionStatus(session.id, 'idle');
          throw err;
        }
      });
      if (!mounted.current) return;
      setSummary(turnId === null ? { phase: 'idle' } : { phase: 'waiting', turnId });
    } catch (err) {
      if (mounted.current) setSummary({ phase: 'failed', message: describeContextError(err) });
    }
  }

  async function stopSummary() {
    if (summary.phase !== 'waiting') return;
    const turnId = summary.turnId;
    setSummary({ phase: 'cancelling', turnId });
    try {
      const done = await gate.run(CANCEL_REASON, () => cancelVerseTurn(session.id));
      if (done === null && mounted.current) setSummary({ phase: 'waiting', turnId });
      // Otherwise the `cancelled` event settles it through the store watcher.
    } catch (err) {
      if (mounted.current) setSummary({ phase: 'failed', message: describeContextError(err) });
    }
  }

  // Watch the session's event log for the summary turn to finish. The open
  // chat's SSE stream feeds verse-store already; when nothing is streaming
  // this session (the dialog was opened for a chat that is not selected), a
  // slow poll of its detail feeds the SAME store path instead.
  const focusRefValue = useRef(focus);
  focusRefValue.current = focus;
  useEffect(() => {
    if (summary.phase !== 'waiting' && summary.phase !== 'cancelling') return undefined;
    const turnId = summary.turnId;
    let settled = false;
    const check = () => {
      if (settled) return;
      const outcome = turnOutcome(getVerseSessionState(session.id).events, turnId);
      if (outcome === null) return;
      settled = true;
      switch (outcome.kind) {
        case 'ok':
          setSummary({ phase: 'done' });
          setIncludeLastAssistant(true);
          void requestPreview({ includeLastAssistant: true, focus: focusRefValue.current });
          break;
        case 'cancelled':
          setSummary({ phase: 'failed', message: 'Summary stopped. The automatic preview is unchanged.' });
          break;
        case 'empty':
          setSummary({ phase: 'failed', message: `${sourceSeatLabel} finished without writing a summary. The automatic preview is unchanged.` });
          break;
        default:
          setSummary({
            phase: 'failed',
            message: `The summary turn failed${outcome.message ? `: ${outcome.message}` : ''}. The automatic preview is unchanged.`,
          });
      }
    };
    check();
    const unsubscribe = subscribeVerseStore(check);
    const timer = setInterval(() => {
      const stream = getVerseSessionState(session.id).stream;
      if (stream === 'open' || stream === 'connecting' || stream === 'reconnecting') return;
      fetchVerseSessionDetail(session.id)
        .then((detail) => seedVerseSession(session.id, detail.session, detail.events))
        .catch(() => { /* the next tick retries; the operator can also stop waiting */ });
    }, SUMMARY_POLL_MS);
    return () => {
      settled = true;
      unsubscribe();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the turn being waited for, not on every render's callbacks.
  }, [summary, session.id]);

  // ---- create ------------------------------------------------------------
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const hasText = text.trim().length > 0;
  const createBlocked = unavailable
    ?? (!preview ? 'Build the handoff first.' : null)
    ?? (!hasText ? 'The handoff is empty — rebuild it or write one.' : null)
    ?? (overTurnLimit ? 'The handoff is over the 64 KB limit for one message. Trim it first.' : null)
    ?? (summarizing ? 'Wait for the summary to finish, or stop it.' : null);

  async function create() {
    if (!target || createBlocked !== null || creating) return;
    setCreating(true);
    setCreateError(null);
    const handoffText = text;
    try {
      const created = await gate.run(CREATE_REASON, () => createHandoffSession({
        source: session,
        seatId: target.seatId,
        model: target.model,
        contextMode: requestMode(option, mode),
        title: title.trim() || undefined,
      }));
      if (created === null) return;
      // Same bookkeeping ChatSection does for any new chat: the store knows
      // the record before its detail fetch lands, and the project remembers
      // the seat it was last started on.
      setVerseSession(created.id, created);
      rememberVerseSeat(created.projectPath, { seatId: created.seatId, model: created.model });
      onCreated(created, handoffText);
      onClose();
    } catch (err) {
      if (mounted.current) setCreateError(describeContextError(err));
    } finally {
      if (mounted.current) setCreating(false);
    }
  }

  // Escape on the token prompt must close only the prompt — both dialogs
  // listen on the document, so this one stands down while the prompt is up.
  const closeUnlessPrompting = () => {
    if (!gate.dialog.open) onClose();
  };

  const liveTokens = Math.ceil(text.length / 4);
  const rebuild = () => void requestPreview({ includeLastAssistant, focus });

  return (
    <>
      <Dialog open onClose={closeUnlessPrompting} titleId={titleId} title="Continue in a fresh chat" initialFocusRef={focusRef}
        widthClassName={styles.dialogWidth}
        description={<>Start a new chat from a written handoff of “{session.title || 'Untitled chat'}” instead of its full history.</>}>
        <form className={styles.form} noValidate onSubmit={(event) => { event.preventDefault(); void create(); }}>
          {/* ---- the note ---- */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor={focusId}>
              Focus for the next chat <span className={styles.optional}>optional</span>
            </label>
            <div className={styles.row}>
              <input id={focusId} ref={focusRef} className={styles.input} value={focus} maxLength={HANDOFF_FOCUS_MAX_CHARS}
                placeholder="e.g. finish the migration, then run the full test suite" autoComplete="off"
                onChange={(event) => setFocus(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (previewStatus !== 'loading') rebuild();
                  }
                }} />
              <button type="button" className={styles.secondary} onClick={rebuild}
                disabled={previewStatus === 'loading' || summarizing}>
                {edited ? 'Rebuild (replaces your edits)' : 'Rebuild'}
              </button>
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={textId}>Handoff — becomes the new chat’s first message</label>
            {previewStatus === 'locked' && !preview ? (
              <div className={styles.locked} role="status">
                <p>Building the handoff needs the mutation token: it reads this chat’s log and runs <code>git diff --stat</code>. It spends nothing.</p>
                <button type="button" className={styles.secondary} onClick={rebuild}>Unlock and build the handoff</button>
              </div>
            ) : (
              <textarea id={textId} className={styles.textarea} value={text} rows={12} spellCheck={false}
                aria-describedby={statsId} aria-busy={previewStatus === 'loading' ? true : undefined}
                disabled={!preview}
                placeholder={previewStatus === 'loading' ? 'Building the handoff from this chat’s log…' : ''}
                onChange={(event) => setText(event.target.value)} />
            )}
            <p id={statsId} className={styles.hint} aria-live="polite">
              {previewStatus === 'loading'
                ? preview ? 'Rebuilding…' : 'Reading this chat’s log…'
                : preview ? (
                  <>
                    {text.length.toLocaleString()} chars · ~{liveTokens.toLocaleString()} tokens
                    {' · '}{preview.stats.turnsCovered} {preview.stats.turnsCovered === 1 ? 'turn' : 'turns'}
                    {' · '}{preview.stats.filesTouched} {preview.stats.filesTouched === 1 ? 'file' : 'files'} touched
                    {edited ? ' · edited' : ''}
                    {includeLastAssistant ? ` · includes ${sourceSeatLabel}’s own summary` : ''}
                  </>
                ) : null}
            </p>
            {preview && preview.stats.truncated.length > 0 ? (
              <p className={styles.hint}>
                To stay under {VERSE_HANDOFF_MAX_CHARS.toLocaleString()} characters these sections were left out: {preview.stats.truncated.join(', ')}.
              </p>
            ) : null}
            {overTurnLimit ? (
              <p className={styles.error} role="alert">
                Over the 64 KB limit for one message (counted as it is sent, line breaks and quotes encoded) — the new chat could
                not send it. Trim it first.
              </p>
            ) : overBudget ? (
              <p className={styles.warn}>
                Longer than the {VERSE_HANDOFF_MAX_CHARS.toLocaleString()}-character handoff budget. It can still be sent; the new chat just starts bigger.
              </p>
            ) : null}
            {previewStatus === 'error' && previewError ? (
              <p className={styles.error} role="alert">
                Could not build the handoff: {previewError}{' '}
                <button type="button" className={styles.link} onClick={rebuild}>Try again</button>
              </p>
            ) : null}
          </div>

          {/* ---- optional: the seat's own summary ---- */}
          <section className={styles.aside} aria-labelledby={`${titleId}-summary`}>
            <h3 id={`${titleId}-summary`} className={styles.label}>Better summary <span className={styles.optional}>optional, spends</span></h3>
            <p className={styles.hint}>
              The handoff above is assembled from this chat’s log. For one in the agent’s own words, ask {sourceSeatLabel} to
              write it first — its reply is added to the handoff. {turnCostSentence(session.engine, sourceSeatLabel)}
            </p>
            {summary.phase === 'waiting' || summary.phase === 'cancelling' ? (
              <div className={styles.row} role="status">
                <span className={styles.pending} aria-hidden="true" />
                <span className={styles.hint}>
                  {summary.phase === 'cancelling' ? 'Stopping the summary…' : `Waiting for ${sourceSeatLabel} to finish its summary…`}
                </span>
                <button type="button" className={styles.secondary} onClick={() => void stopSummary()}
                  disabled={summary.phase === 'cancelling'}>Stop the summary</button>
              </div>
            ) : (
              <div className={styles.row}>
                <button type="button" className={styles.secondary} onClick={() => void summarize()}
                  disabled={summarizeBlocked !== null || summary.phase === 'sending'}>
                  {summary.phase === 'sending' ? 'Sending…' : summary.phase === 'done' ? `Ask ${sourceSeatLabel} again` : `Ask ${sourceSeatLabel} to summarize first`}
                </button>
                {summary.phase === 'done' ? <span className={styles.hint} role="status">Summary added.</span> : null}
              </div>
            )}
            {summarizeBlocked !== null && !summarizing ? <p className={styles.hint}>{summarizeBlocked}</p> : null}
            {summarizeBlocked === null && summary.phase === 'idle' && edited ? (
              <p className={styles.hint}>The handoff is rebuilt with the summary, which replaces your edits above.</p>
            ) : null}
            {summary.phase === 'failed' ? <p className={styles.error} role="alert">{summary.message}</p> : null}
          </section>

          {/* ---- where it continues ---- */}
          <div className={styles.field}>
            <SeatSelector id={seatId} seats={seats} value={target} onChange={chooseTarget} label="Continue on"
              modeFor={(seat, model) => (target && seat.id === target.seatId && model.id === target.model ? mode : 'standard')} />
            {unavailable ? <p className={styles.error} role="alert">{unavailable}</p> : null}
            {reachCaveat ? <p className={styles.hint}>{reachCaveat}</p> : null}
          </div>

          {option && !unavailable ? (
            <div className={styles.field}>
              {expansiveOffered ? (
                <>
                  <span id={modeLabelId} className={styles.label}>Context mode</span>
                  <Segmented<VerseContextMode> aria-labelledby={modeLabelId} size="sm" value={mode}
                    onChange={(next) => setModeChoice(next)}
                    options={[
                      { value: 'standard', label: 'Standard' },
                      { value: 'expansive', label: 'Expansive' },
                    ]} />
                  <p className={styles.hint}>
                    {budgetLine(option, mode)}.{' '}
                    {mode === 'expansive'
                      ? `Expansive keeps far more of the conversation before compacting, but every turn re-sends all of it — each turn costs more usage.${expansiveCost ? ` ${expansiveCost}` : ''}`
                      : 'Standard compacts sooner and keeps each turn cheaper. Expansive is one click away if the work needs it.'}
                  </p>
                </>
              ) : budgetLine(option, 'standard') ? (
                <p className={styles.hint}>{budgetLine(option, 'standard')}.</p>
              ) : null}
              <p className={`${styles.fit} ${styles[`fit-${fit.tone}`] ?? ''}`} data-verdict={fit.verdict ?? 'unknown'}>
                {fit.text}
              </p>
            </div>
          ) : null}

          <div className={styles.field}>
            <label className={styles.label} htmlFor={nameId}>Title</label>
            <input id={nameId} className={styles.input} value={title} maxLength={TITLE_MAX_CHARS} autoComplete="off"
              onChange={(event) => setTitle(event.target.value)} />
          </div>

          {createError ? <p className={styles.error} role="alert">{createError}</p> : null}

          <p className={styles.cost}>
            Creating the chat is free — nothing is sent to a model. The handoff goes into the new chat’s composer; read it,
            then press Send. That first turn is the first thing spent.
          </p>
          <div className={styles.actions}>
            {createBlocked && preview ? <span className={styles.blocked}>{createBlocked}</span> : null}
            <button type="button" className={styles.cancel} onClick={onClose}>Cancel</button>
            <button type="submit" className={styles.primary} disabled={createBlocked !== null || creating}>
              {creating ? 'Creating…' : 'Create chat'}
            </button>
          </div>
        </form>
      </Dialog>
      <MutationTokenDialog open={gate.dialog.open} reason={gate.dialog.reason} tokenLabel="Mutation token"
        tokenHelp="the mutation token ashlr verse printed" onClose={gate.dialog.onClose} onUnlocked={gate.dialog.onUnlocked} />
    </>
  );
}

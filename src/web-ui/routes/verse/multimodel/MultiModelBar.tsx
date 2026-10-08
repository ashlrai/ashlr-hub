/**
 * routes/verse/multimodel/MultiModelBar.tsx — one line above the composer box
 * that makes every seat work together (3.16):
 *
 *   [Auto ▾]  Codex — review; 62% of its 5-hour window left.  [Send to: Auto ▾]  Compare  ≈$1.24 · saved $0.30
 *   [Auto ▾]  Codex answered.  [up] [down]  Review with Claude Max   Compare   On this Mac · private · 42 tok/s
 *
 * - AUTO: while Mason types, the pure advisor (core/verse/multimodel) names the
 *   seat for THIS message and the one reason, over the seat list the app
 *   already polls. "Send to" overrides it for this message. On Enter the
 *   decision layer labels the message once (rules if it cannot), and a message
 *   bound for another seat continues the conversation there with the
 *   zero-spend handoff note. Auto follows the final label in the same send,
 *   while explicit per-message seat choices remain pinned.
 * - CHEAP-FIRST: local models draft; when the draft is weak (escalation.ts)
 *   the conversation escalates to the best frontier seat on its own, with the
 *   draft quoted. Savings show in the meter.
 * - COMPARE / REVIEW: the same prompt to 2–3 seats side by side, or one
 *   cross-family reviewer on the last answer (CompareDialog, lazy).
 * - LEARNING: thumbs, overrides, switches, Compare picks and escalations are
 *   recorded as outcomes the advisor learns from.
 * - LOCAL: when the chat or the Auto choice is a local model, its badge says
 *   what it is — on this Mac, private, context, measured speed — with Warm up.
 * - METER: what this chat has used across every seat it touched.
 *
 * Lazy-loaded by the Composer (never on the first-paint path). Every turn it
 * causes goes through the ordinary session routes (multimodel-flows.ts).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VerseSeat } from '../../../data/api-types.js';
import { classifyPrompt } from '../../../../core/verse/multimodel/classify.js';
import { crossFamilyReviewer } from '../../../../core/verse/multimodel/compare.js';
import { assessDraft } from '../../../../core/verse/multimodel/escalation.js';
import type { ChatMeter, PromptClassification, SeatAdvice, SeatAdviceOption } from '../../../../core/verse/multimodel/types.js';
import { useQuery } from '../../../data/hooks.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { useVerseTranscript } from '../useVerseTranscript.js';
import { formatTokens } from '../verse-readouts.js';
import { DEFAULT_FLOW_API, escalate, routeMessage, type FlowTarget } from './multimodel-flows.js';
import { chatMeterQuery, invalidateChatMeter, labelPromptRemote, recordOutcome, warmLocalSeat } from './multimodel-queries.js';
import { AUTO_PREFS, loadAutoPref, saveAutoPref, useAutoSeat, type AutoPref } from './useAutoSeat.js';
import { localSpeedReadout, localSpeedCompactReadout, localWarmReadout } from './local-speed-readout.js';
import styles from './multimodel.module.css';

const ManagerStatus = lazy(async () => ({ default: (await import('./ManagerStatus.js')).ManagerStatus }));
const CompareDialog = lazy(async () => ({ default: (await import('./CompareDialog.js')).CompareDialog }));

/** What the Composer does with a message: send it itself, or the bar already did (or held it). */
export type SendRoute = 'send-here' | 'handled' | 'held';
export type SendInterceptor = ((text: string) => Promise<SendRoute>) & { handlesRunning?: boolean };

export interface MultiModelBarProps {
  sessionId: string;
  seats: readonly VerseSeat[];
  text: string;
  running: boolean;
  /** The Composer asks this before every send (null = unregister). */
  registerInterceptor(fn: SendInterceptor | null): void;
  /** A flow used the draft (Compare): clear the box as if it had been sent. */
  onConsumeDraft(text: string): void;
}

const PREF_LABEL: Record<AutoPref, string> = { off: 'Manual', auto: 'Automatic', 'cheap-first': 'Local first', manager: 'Delegate' };
const PREF_DESCRIPTION: Record<AutoPref, string> = {
  off: 'Send to the model chosen for this chat.',
  auto: 'Choose a model for each message automatically.',
  'cheap-first': 'Prefer a local draft and escalate when needed.',
  manager: 'Let the fleet plan, delegate, and review.',
};

interface PendingDraft {
  text: string;
  cls: PromptClassification;
  localLabel: string;
}
/**
 * Cheap-first drafts waiting for their turn to end, by chat id. Module scope
 * on purpose: an Auto re-route opens a NEW chat, whose composer (and bar) is
 * a new instance — the pending draft must survive that remount.
 */
const pendingDrafts = new Map<string, PendingDraft>();

function Thumb({ down = false }: { down?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      style={down ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M5 7v7H2.5V7H5Zm0 0 3-5c1 0 1.8.8 1.6 1.8L9.2 6.5h3.6c.9 0 1.5.8 1.3 1.6l-1.1 4.6c-.2.8-.9 1.3-1.7 1.3H5" />
    </svg>
  );
}

function target(o: SeatAdviceOption): FlowTarget {
  return { seatId: o.seatId, model: o.model, label: o.label, engine: o.engine };
}

function money(usd: number): string {
  return usd >= 10 ? `$${usd.toFixed(0)}` : usd >= 0.1 ? `$${usd.toFixed(2)}` : usd > 0 ? '<$0.10' : '$0';
}

export function MultiModelBar({ sessionId, seats, text, running, registerInterceptor, onConsumeDraft }: MultiModelBarProps) {
  const [pref, setPref] = useState<AutoPref>(() => loadAutoPref(sessionId));
  const [pinned, setPinned] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [warming, setWarming] = useState(false);
  const [rated, setRated] = useState<'up' | 'down' | null>(null);
  const [dialog, setDialog] = useState<null | { mode: 'compare'; prompt: string } | { mode: 'review'; reviewer: SeatAdviceOption }>(null);
  const auto = useAutoSeat({ sessionId, seats, text, pref, pinnedSeatId: null });
  const { session, advice, context } = auto;
  const transcript = useVerseTranscript(sessionId);
  const meter = useQuery(chatMeterQuery(sessionId)).data ?? null;

  // A pin is for one message: cleared when the box empties.
  useEffect(() => { if (!text.trim()) setPinned(null); }, [text]);

  // ---- the last exchange (for feedback, review, cheap-first) --------------
  const last = useMemo(() => {
    const items = transcript.items;
    let userIndex = -1;
    for (let i = items.length - 1; i >= 0; i -= 1) if (items[i]!.kind === 'user') { userIndex = i; break; }
    if (userIndex === -1) return null;
    const after = items.slice(userIndex + 1);
    const answer = after.flatMap((it) => (it.kind === 'assistant' ? [it.text] : [])).join('\n\n');
    const done = after.find((it) => it.kind === 'turn-done');
    const user = items[userIndex]!;
    return {
      turnId: user.kind === 'user' ? user.turnId : '',
      question: user.kind === 'user' ? user.text : '',
      answer,
      done: done?.kind === 'turn-done' ? done : null,
      toolUses: after.filter((it) => it.kind === 'tool').length,
    };
  }, [transcript.items]);
  const doneCount = useMemo(() => transcript.items.filter((it) => it.kind === 'turn-done').length, [transcript.items]);
  useEffect(() => { invalidateChatMeter(sessionId); setRated(null); }, [sessionId, doneCount]);

  const currentSeat = seats.find((s) => s.id === session?.seatId) ?? null;
  const lastKind = useMemo(() => (last?.question ? classifyPrompt(last.question).kind : 'code'), [last?.question]);

  // Rank reviewers for the last answer with the advisor itself (review work).
  const reviewer = useMemo(() => {
    if (!last?.question || !session) return null;
    const ranked = auto.adviseWith({ ...classifyPrompt(`review: ${last.question}`), kind: 'review', task: 'review' }, null);
    if (!ranked) return null;
    return crossFamilyReviewer(session.engine, [...(ranked.choice ? [ranked.choice] : []), ...ranked.alternatives]);
  }, [auto, last?.question, session]);

  // ---- cheap-first: assess the local draft when its turn ends --------------
  const escalating = useRef(false);
  useEffect(() => {
    const pending = pendingDrafts.get(sessionId);
    if (!pending || running || !last?.done || !session || escalating.current) return;
    if (last.question.trim() !== pending.text.trim()) return;
    pendingDrafts.delete(sessionId);
    const verdict = assessDraft({ text: last.answer, ok: last.done.ok, classification: pending.cls, toolUses: last.toolUses });
    if (!verdict.escalate) {
      void recordOutcome({ seatId: session.seatId, kind: pending.cls.kind, signal: 'draft-accepted', sessionId });
      setNotice({ text: `Answered on ${pending.localLabel} — ${verdict.reasons[0]?.replace(/\.$/, '').toLowerCase() ?? 'the draft reads complete'}; no paid seat was used.`, error: false });
      return;
    }
    // The best frontier seat for this message, as if it had been hard.
    const frontier = auto.adviseWith({ ...pending.cls, difficulty: 'high' }, null);
    const pick = [...(frontier?.choice ? [frontier.choice] : []), ...(frontier?.alternatives ?? [])].find((o) => !o.local) ?? null;
    if (!pick) {
      setNotice({ text: `The local draft looks weak (${verdict.reasons.join(' ').replace(/\.$/, '')}), and no frontier seat can take it right now.`, error: true });
      return;
    }
    escalating.current = true;
    setNotice({ text: `Escalating to ${pick.label}: ${verdict.reasons.join(' ')}`, error: false });
    void escalate(DEFAULT_FLOW_API, {
      source: session, target: target(pick), question: pending.text, draft: last.answer, verdict, draftLabel: pending.localLabel, kind: pending.cls.kind,
    }).catch((err: unknown) => {
      setNotice({ text: `Escalation failed: ${err instanceof Error ? err.message : 'request failed'}`, error: true });
    }).finally(() => { escalating.current = false; });
  }, [last, running, session, sessionId, auto]);

  // ---- the send interceptor ------------------------------------------------
  const shownChoice = advice?.choice?.seatId ?? null;
  const intercept = useCallback<SendInterceptor>(async (message) => {
    if (pref === 'manager') {
      try {
        const { submitManagerMessage } = await import('./manager-queries.js');
        await submitManagerMessage(sessionId, message);
        setNotice({ text: 'Saved for the manager. The fleet plans, delegates and reviews from this conversation.', error: false });
        return 'handled';
      } catch (err) {
        setNotice({ text: err instanceof Error ? err.message : 'The manager message could not be confirmed. Your draft is preserved.', error: true });
        return 'held';
      }
    }
    if (pref === 'off' || !session) return 'send-here';
    const rules = classifyPrompt(message, { contextTokens: session.usage?.contextTokens ?? 0 });
    let cls: PromptClassification = rules;
    try {
      cls = (await labelPromptRemote({ text: message, sessionId: session.id, contextTokens: session.usage?.contextTokens ?? 0 })).classification;
    } catch { /* rules it is — labelling never blocks a send */ }
    const unpinned = auto.adviseWith(cls, null);
    const final = pinned ? auto.adviseWith(cls, pinned) : unpinned;
    const choice = final?.choice ?? null;
    if (!choice) {
      if (final) setNotice({ text: final.why, error: false });
      return 'send-here';
    }
    if (!pinned && choice.seatId !== shownChoice && choice.seatId === session.seatId) {
      // Read differently, but the answer is "stay": the safe direction — no move, no handoff. Said, then sent.
      if (shownChoice !== null) setNotice({ text: `Read as ${cls.label}${cls.decidedBy === 'jev' ? ' (Jev)' : ''}, so it stays on ${choice.label}.`, error: false });
      if (pref === 'cheap-first' && choice.local) pendingDrafts.set(session.id, { text: message, cls, localLabel: choice.label });
      return 'send-here';
    }
    const overridden = pinned && unpinned?.choice && unpinned.choice.seatId !== pinned ? { seatId: unpinned.choice.seatId } : null;
    if (choice.seatId === session.seatId) {
      if (overridden) void recordOutcome({ seatId: overridden.seatId, kind: cls.kind, signal: 'auto-overridden' });
      if (pref === 'cheap-first' && choice.local) pendingDrafts.set(session.id, { text: message, cls, localLabel: choice.label });
      return 'send-here';
    }
    setNotice({ text: session.turnCount > 0
      ? `Continuing on ${choice.label} with a handoff note…`
      : `Sending to ${choice.label}…`, error: false });
    try {
      const created = await routeMessage(DEFAULT_FLOW_API, { source: session, target: target(choice), text: message, kind: cls.kind, overridden });
      if (pref === 'cheap-first' && choice.local) pendingDrafts.set(created.id, { text: message, cls, localLabel: choice.label });
      saveAutoPref(created.id, pref);
      return 'handled';
    } catch (err) {
      setNotice({ text: `Could not move this to ${choice.label}: ${err instanceof Error ? err.message : 'request failed'}. Your message is still here.`, error: true });
      return 'held';
    }
  }, [pref, session, sessionId, auto, pinned, shownChoice]);
  intercept.handlesRunning = pref === 'manager';

  useEffect(() => {
    registerInterceptor(intercept);
    return () => registerInterceptor(null);
  }, [intercept, registerInterceptor]);

  // ---- actions -------------------------------------------------------------
  function changePref(next: AutoPref) {
    setPref(next);
    saveAutoPref(sessionId, next);
    setNotice(null);
  }

  function rate(signal: 'up' | 'down') {
    if (!session || rated) return;
    setRated(signal);
    void recordOutcome({ seatId: session.seatId, kind: lastKind, signal, sessionId, model: session.model });
  }

  async function warm(seatId: string) {
    setWarming(true);
    try {
      const r = await warmLocalSeat(seatId);
      setNotice(r.ok
        ? { text: localWarmReadout(r), error: false }
        : { text: r.error ?? 'Could not warm the model.', error: true });
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : 'Could not warm the model.', error: true });
    } finally {
      setWarming(false);
    }
  }

  const comparePrompt = text.trim() || last?.question || '';
  const localSeatId = currentSeat?.engine === 'local' ? currentSeat.id : advice?.choice?.local ? advice.choice.seatId : null;
  const badge = localSeatId ? context?.local.find((b) => b.seatId === localSeatId) ?? null : null;
  const typing = text.trim().length > 0;
  const showFeedback = !typing && !running && last?.done?.ok === true && last.answer.length > 0;
  const options: SeatAdviceOption[] = advice ? [...(advice.choice ? [advice.choice] : []), ...advice.alternatives] : [];

  return (
    <div className={styles.bar} role="group" aria-label="Models">
      <Tooltip label={PREF_DESCRIPTION[pref]}>
        <select className={styles.select} aria-label="Routing mode" value={pref} onChange={(e) => changePref(e.target.value as AutoPref)}>
          {AUTO_PREFS.map((p) => <option key={p} value={p}>{PREF_LABEL[p]}</option>)}
        </select>
      </Tooltip>

      {pref === 'manager' ? <Suspense fallback={<span className={styles.why}>Loading manager…</span>}><ManagerStatus sessionId={sessionId}
        retryMessage={async message => { const route = await intercept(message); if (route === 'handled' && text === message) onConsumeDraft(text); }} /></Suspense> : null}

      {typing && pref !== 'off' && pref !== 'manager' ? (
        <AdviceLine advice={advice} pinned={pinned} options={options} held={advice?.held ?? []}
          waiting={context === null} onPin={(id) => setPinned(id === 'auto' ? null : id)} />
      ) : null}

      {showFeedback && session ? (
        <span className={`${styles.group} ${styles.grow}`}>
          <span className={styles.why}>{currentSeat?.label ?? session.seatId} answered.</span>
          <button type="button" className={styles.iconButton} aria-label="Good answer" aria-pressed={rated === 'up'} disabled={rated !== null} onClick={() => rate('up')}><Thumb /></button>
          <button type="button" className={styles.iconButton} aria-label="Bad answer" aria-pressed={rated === 'down'} disabled={rated !== null} onClick={() => rate('down')}><Thumb down /></button>
          {reviewer ? (
            <button type="button" className={styles.chip} onClick={() => setDialog({ mode: 'review', reviewer })}
              title={`Ask ${reviewer.label} (a different model family) to review this answer — one turn on ${reviewer.label}`}>
              Review with {reviewer.label}
            </button>
          ) : null}
        </span>
      ) : null}

      {!typing && !showFeedback ? <span className={styles.grow} /> : null}

      <button type="button" className={styles.chip} disabled={!comparePrompt || running || !session || context === null}
        onClick={() => setDialog({ mode: 'compare', prompt: comparePrompt })}
        title={typing ? 'Send this message to 2–3 seats side by side' : 'Ask other seats the last question, side by side'}>
        Compare
      </button>

      {context?.localOnly.on ? (
        <span className={`${styles.chip} ${styles.chipWarn}`} title={context.localOnly.reason ?? undefined}>Local-only repo</span>
      ) : null}

      {badge ? (
        <span className={`${styles.group}`}>
          <span className={`${styles.chip} ${badge.private ? styles.chipPrivate : ''}`}
            title={localSpeedReadout(badge, context?.sampledAt ?? '')}>
            {badge.private ? 'On this Mac · private' : 'Local runtime'}
            {badge.contextWindow ? ` · ${formatTokens(badge.contextWindow)} ctx` : ''}
            {badge.tokPerSec ? ` · ${localSpeedCompactReadout(badge, context?.sampledAt ?? '')}` : ''}
          </span>
          <button type="button" className={styles.chip} disabled={warming} onClick={() => { void warm(badge.seatId); }}
            title="Load the model now and keep it resident, so the next turn starts at once">
            {warming ? 'Warming…' : 'Warm up'}
          </button>
        </span>
      ) : null}

      {meter && meter.sessions.length > 0 ? (
        <span className={styles.meter} title={meterTitle(meter)}>
          {meter.sessions.length > 1 ? `${new Set(meter.sessions.map((s) => s.seatId)).size} seats · ` : ''}
          {formatTokens(meter.totals.inputTokens + meter.totals.outputTokens)} tok
          {meter.totals.listUsd > 0 ? ` · ≈${money(meter.totals.listUsd)}` : ''}
          {meter.totals.savedUsd > 0 ? ` · saved ≈${money(meter.totals.savedUsd)}` : ''}
        </span>
      ) : null}

      {notice ? <span className={`${styles.notice} ${notice.error ? styles.noticeError : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</span> : null}

      {dialog && session ? (
        <Suspense fallback={null}>
          <CompareDialog
            source={session}
            seats={seats}
            advisorSeats={auto.advisorSeats}
            advice={dialog.mode === 'compare' && dialog.prompt === text.trim() ? advice : auto.adviseWith(classifyPrompt(dialog.mode === 'compare' ? dialog.prompt : last?.question ?? ''), null)}
            {...(dialog.mode === 'compare'
              ? { mode: 'compare' as const, prompt: dialog.prompt }
              : { mode: 'review' as const, reviewer: dialog.reviewer, question: last?.question ?? null, answer: last?.answer ?? '', authorLabel: currentSeat?.label ?? session.seatId })}
            onStarted={() => { if (dialog.mode === 'compare' && dialog.prompt === text.trim()) onConsumeDraft(text); }}
            onClose={() => setDialog(null)} />
        </Suspense>
      ) : null}
    </div>
  );
}

function AdviceLine({ advice, pinned, options, held, waiting, onPin }: {
  advice: SeatAdvice | null;
  pinned: string | null;
  options: readonly SeatAdviceOption[];
  held: ReadonlyArray<{ seatId: string; label: string; reason: string }>;
  waiting: boolean;
  onPin(id: string): void;
}) {
  if (waiting) return <span className={`${styles.why} ${styles.grow}`}>Checking whether this repo may leave this Mac…</span>;
  if (!advice) return <span className={`${styles.why} ${styles.grow}`}>Reading your message…</span>;
  const pinnedOption = pinned ? options.find((o) => o.seatId === pinned) ?? null : null;
  return (
    <>
      <span className={`${styles.why} ${advice.stay && !pinnedOption ? styles.whyStay : ''} ${styles.grow}`} title={advice.factors.join('\n')}>
        {pinnedOption ? `${pinnedOption.label} — you picked it for this message; ${pinnedOption.note}.` : advice.why}
      </span>
      {options.length > 1 || held.length > 0 ? (
        <select className={styles.select} aria-label="Send this message to" value={pinned ?? 'auto'} onChange={(e) => onPin(e.target.value)}>
          <option value="auto">{advice.choice ? `Auto: ${advice.choice.label}` : 'Auto'}</option>
          {options.map((o) => <option key={o.seatId} value={o.seatId}>{o.label} — {o.note}</option>)}
          {held.map((h) => <option key={h.seatId} value={h.seatId} disabled>{h.label} — {h.reason.replace(/\.$/, '').toLowerCase()}</option>)}
        </select>
      ) : null}
    </>
  );
}

function meterTitle(meter: ChatMeter): string {
  const lines = meter.sessions.map((s) => `${s.relation === 'root' ? 'This chat' : s.relation}: ${s.title} — ${formatTokens(s.inputTokens + s.outputTokens)} tok${s.local ? ' (local, free)' : s.listUsd !== null ? ` ≈${money(s.listUsd)}` : ''}`);
  const seats = meter.seats.map((s) => `${s.label}: ${s.window ?? 'no reading'}${s.fleetShare ? ` — ${s.fleetShare}` : ''}`);
  return [...lines, '', ...seats, '', `Budget mode: ${meter.budgetMode}.`, meter.note].join('\n');
}

export default MultiModelBar;

/** Test seam: forget pending cheap-first drafts. */
export function resetPendingDraftsForTest(): void {
  pendingDrafts.clear();
}

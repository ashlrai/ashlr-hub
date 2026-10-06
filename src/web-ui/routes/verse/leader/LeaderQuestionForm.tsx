/** Lazy shared question controls; drafts never leave this mounted surface's store. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { readFailureReason } from '../../../data/client.js';
import { fetchLeaderQuestion, submitLeaderQuestion } from './question-data.js';
import { matchesQuestionAcceptance } from './question-model.js';
import { LEADER_QUESTION_FORM_LIMITS, type LeaderQuestionProjection, type LeaderQuestionSubmission,
  type SubmitLeaderQuestionResult } from './thread-types.js';
import type { LeaderComposerProps } from './LeaderComposer.js';
import styles from './leader.module.css';

interface Draft { indices: number[]; text: string; write: boolean }
export interface QuestionFormState {
  question: LeaderQuestionProjection | null;
  capability: 'unknown' | 'supported' | 'unsupported';
  drafts: Record<string, Draft>;
  status: string | null;
  busy: boolean;
  uncertain: LeaderQuestionSubmission | null;
}
export type QuestionFormStore = Map<string, QuestionFormState>;
export interface LeaderQuestionFormProps {
  questionId: string;
  /** Changing thread metadata prompts a fresh exact read; it is never authoritative. */
  revisionHint?: string;
  store: QuestionFormStore;
  disabledReason: string | null;
  requestSubmit: (run: () => Promise<void>) => void;
  onResult?: (result: SubmitLeaderQuestionResult) => void;
  onLegacyAnswer: (text: string) => Promise<boolean>;
  fallbackText: string;
  autoFocus?: boolean;
  showQuestion?: boolean;
  onUnsupported?: () => void;
  onReconciled?: () => void;
  /** Desktop supplies its dictation composer; phone keeps its native text controls. */
  renderWrittenAnswer: (props: LeaderComposerProps) => ReactNode;
}
const blank = (): QuestionFormState => ({ question: null, capability: 'unknown', drafts: {}, status: null, busy: false, uncertain: null });
const emptyDraft = (): Draft => ({ indices: [], text: '', write: false });
const sameSubmission = (a: LeaderQuestionSubmission, b: LeaderQuestionSubmission) => JSON.stringify(a) === JSON.stringify(b);

export default function LeaderQuestionForm({ questionId, revisionHint, store, disabledReason, requestSubmit,
  onResult, onLegacyAnswer, fallbackText, autoFocus, showQuestion, onUnsupported, onReconciled, renderWrittenAnswer }: LeaderQuestionFormProps) {
  const [state, setState] = useState(() => store.get(questionId) ?? blank());
  const mounted = useRef(true);
  const reading = useRef<{ key: string; generation: number } | null>(null);
  const readGeneration = useRef(0);
  const currentQuestionId = useRef(questionId);
  currentQuestionId.current = questionId;
  const id = useId();
  const legacyKey = 'legacy';
  const update = (change: (current: QuestionFormState) => QuestionFormState) => {
    const next = change(store.get(questionId) ?? blank());
    store.set(questionId, next);
    if (mounted.current && currentQuestionId.current === questionId) setState(next);
    return next;
  };
  const reconcile = (question: LeaderQuestionProjection, previous: QuestionFormState): QuestionFormState => {
    if (!previous.uncertain) return { ...previous, question, capability: 'supported',
      status: previous.question?.questionForm && question.questionForm?.revision !== previous.question.questionForm.revision
        ? 'This question changed. Your previous draft is kept separately; choose again.' : null };
    if (matchesQuestionAcceptance(question, previous.uncertain)) {
      return { ...previous, question, capability: 'supported', uncertain: null,
        status: 'Your submitted answer is saved. A reply may still be pending.' };
    }
    return { ...previous, question, capability: 'supported', status: question.answered
      ? 'A saved answer is visible, but its revision or value differs from this request. Your draft is kept.'
      : 'The submitted answer is not confirmed. Your draft is kept; check again before retrying.' };
  };
  const read = async () => {
    const key = `${questionId}:${revisionHint ?? ''}`;
    if (reading.current?.key === key) return;
    const generation = ++readGeneration.current;
    reading.current = { key, generation };
    try {
      const result = await fetchLeaderQuestion(questionId);
      if (generation !== readGeneration.current || currentQuestionId.current !== questionId || !mounted.current) return;
      const pending = store.get(questionId)?.uncertain;
      update(current => result.supported ? reconcile(result.question, current)
        : { ...current, capability: 'unsupported', question: null, status: current.uncertain
          ? 'This server cannot reconcile the submitted answer. Your draft is kept.' : null });
      if (!result.supported && !store.get(questionId)?.uncertain) onUnsupported?.();
      if (result.supported && pending && matchesQuestionAcceptance(result.question, pending)) onReconciled?.();
    } catch (error) {
      if (generation !== readGeneration.current || currentQuestionId.current !== questionId || !mounted.current) return;
      update(current => ({ ...current, status: `${readFailureReason(error)} Your draft is kept.`, capability: 'unknown' }));
    } finally { if (reading.current?.generation === generation) reading.current = null; }
  };
  useEffect(() => {
    mounted.current = true;
    setState(store.get(questionId) ?? blank());
    void read();
    // Invalidate the latest numeric request generation; this ref is not a DOM node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { mounted.current = false; readGeneration.current++; reading.current = null; };
    // The callback deliberately reads the live store, not a captured draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId, revisionHint, store]);
  const question = state.question;
  const form = question?.questionForm;
  const key = form?.revision ?? legacyKey;
  const draft = state.drafts[key] ?? emptyDraft();
  const setDraft = (change: (value: Draft) => Draft) => update(current => ({ ...current,
    drafts: { ...current.drafts, [key]: change(current.drafts[key] ?? emptyDraft()) } }));
  const typed = state.capability === 'supported' && !!form;
  const expired = !!form && Date.now() >= Date.parse(form.expiresAt);
  const held = disabledReason ?? (state.capability === 'unknown' ? 'Read the current question before answering.' : null);
  const selectionText = form?.options?.filter((_, index) => draft.indices.includes(index)).join('; ') ?? '';
  const over = (draft.write || form?.mode === 'short-answer' ? draft.text : selectionText).length > LEADER_QUESTION_FORM_LIMITS.answerMaxChars;
  const asSubmission = (value: Draft): LeaderQuestionSubmission | null => {
    if (!form) return null;
    return value.write || form.mode === 'short-answer'
      ? { schemaVersion: 1, formRevision: form.revision, kind: 'text', text: value.text.trim() }
      : { schemaVersion: 1, formRevision: form.revision, kind: 'options', optionIndices: [...value.indices].sort((a, b) => a - b) };
  };
  const submit = (retry?: LeaderQuestionSubmission) => {
    const snapshot = retry ?? asSubmission(draft);
    if (!snapshot || (!retry && draft.write) || held || state.busy || (state.uncertain && !retry) || expired || (over && !retry)) return;
    requestSubmit(async () => {
      const live = store.get(questionId) ?? blank();
      if (live.busy || live.uncertain && (!retry || !sameSubmission(live.uncertain, retry))) return;
      // An earlier display read must not overwrite the answer operation's newer observation.
      readGeneration.current++; reading.current = null;
      update(current => ({ ...current, busy: true, status: 'Checking the current question…' }));
      let contacted = false;
      try {
        const current = await fetchLeaderQuestion(questionId);
        if (!current.supported || !current.question.questionForm || current.question.questionForm.revision !== snapshot.formRevision ||
          current.question.answered || Date.now() >= Date.parse(current.question.questionForm.expiresAt)) {
          update(value => current.supported ? { ...reconcile(current.question, value),
            status: matchesQuestionAcceptance(current.question, snapshot) ? 'Your submitted answer is saved. A reply may still be pending.' : 'This question changed, expired or was answered. Your draft is kept.' } :
            { ...value, status: 'This question could not be verified. Your draft is kept.' });
          return;
        }
        contacted = true;
        const result = await submitLeaderQuestion(questionId, snapshot);
        update(value => {
          const confirmed = result.outcome === 'recorded' && !!result.question && matchesQuestionAcceptance(result.question, snapshot);
          const sameRevision = !value.question || value.question.questionForm?.revision === snapshot.formRevision;
          const next = { ...value, ...(result.question && sameRevision ? { question: result.question } : {}), status: confirmed && !sameRevision
            ? 'Your answer to the previous version is saved. These current choices remain unanswered.' : result.reason ??
            (confirmed ? 'Your answer is saved. A reply may still be pending.' : result.outcome === 'recorded' ? 'Delivery is uncertain; check the saved answer. Your draft is kept.' :
              result.outcome === 'already-answered' ? 'This question was already answered. Your draft is kept.' : 'This question is held or changed. Your draft is kept.') };
          if (result.outcome === 'held' || result.outcome === 'recorded' && !confirmed) {
            next.uncertain = snapshot;
          } else if (confirmed) {
            next.uncertain = null;
            // Never clear edits made while an unlock/read/POST was in flight.
            const actual = value.drafts[snapshot.formRevision];
            if (actual && sameSubmission(asSubmission(actual)!, snapshot)) next.drafts = { ...value.drafts, [snapshot.formRevision]: emptyDraft() };
          }
          return next;
        });
        const observed = store.get(questionId)?.question;
        // A historical accepted response must not resolve a newer unanswered presentation.
        if (result.outcome === 'recorded' && result.question && matchesQuestionAcceptance(result.question, snapshot) &&
          observed?.questionForm?.revision === snapshot.formRevision && matchesQuestionAcceptance(observed, snapshot)) onResult?.(result);
        if (result.outcome === 'held') await read();
      } catch (error) {
        update(value => ({ ...value, ...(contacted ? { uncertain: snapshot } : {}),
          status: `${readFailureReason(error)} ${contacted ? 'Delivery is uncertain; check the saved answer.' : 'Your draft is kept.'}` }));
        if (contacted) await read();
      } finally { update(value => ({ ...value, busy: false })); }
    });
  };
  const sendWritten = (text: string) => {
    if (held || state.busy || state.uncertain || !text.trim() || text.length > LEADER_QUESTION_FORM_LIMITS.answerMaxChars) return;
    requestSubmit(async () => {
      const live = store.get(questionId) ?? blank();
      if (live.busy || live.uncertain) return;
      // An earlier display read must not overwrite the answer operation's newer observation.
      readGeneration.current++; reading.current = null;
      update(current => ({ ...current, busy: true, status: 'Checking the current question…' }));
      try {
        const current = await fetchLeaderQuestion(questionId);
        if (current.supported && form && current.question.questionForm?.revision !== form.revision) {
          update(value => ({ ...value, question: current.question, status: 'This question changed. Your written draft is kept.' }));
          return;
        }
        // Expiry permits a deliberate ordinary answer, never an uncertain typed retry.
        if (form?.mode === 'short-answer' && (!current.supported || current.question.answered ||
          current.question.questionForm?.mode !== 'short-answer' || Date.now() < Date.parse(current.question.questionForm.expiresAt))) {
          update(value => ({ ...value, ...(current.supported ? { question: current.question } : {}),
            status: 'This expired question could not be verified as unanswered. Your written draft is kept.' }));
          return;
        }
        const saved = await onLegacyAnswer(text);
        update(value => ({ ...value, status: saved ? 'Your written answer was sent.' : 'Delivery was not confirmed. Your draft is kept.',
          ...(saved && value.drafts[key]?.text.trim() === text ? { drafts: { ...value.drafts, [key]: emptyDraft() } } : {}) }));
        if (saved) await read();
      } catch (error) { update(value => ({ ...value, status: `${readFailureReason(error)} Your written draft is kept.` })); }
      finally { update(value => ({ ...value, busy: false })); }
    });
  };
  return (
    <div aria-busy={state.busy}>
      {showQuestion && (question || state.capability === 'unsupported') ? <p style={{ overflowWrap: 'anywhere' }}>{question?.text ?? fallbackText}</p> : null}
      {question?.answered ? <p className={styles.answered}>Answered · {question.answer?.text}</p> : null}
      {typed && question && form && !question.answered ? (
        <fieldset disabled={held !== null} style={{ minWidth: 0, border: 0, padding: 0, margin: 0 }}>
          <legend className={styles.muted}>{form.mode === 'multiple' ? 'Choose any, then Submit' : form.mode === 'single' ? 'Choose one, then Submit' : 'Write your answer'}</legend>
          {!draft.write && form.mode !== 'short-answer' ? <>
            <div role={form.mode === 'single' ? 'radiogroup' : 'group'} aria-label={question.text}>
              {form.options?.map((label, index) => <label key={index} style={{ display: 'flex', alignItems: 'flex-start', minHeight: 'var(--control-h-lg)', gap: 'var(--space-2)', padding: 'var(--space-2) 0', overflowWrap: 'anywhere' }}>
                <input type={form.mode === 'single' ? 'radio' : 'checkbox'} name={id} autoFocus={autoFocus && index === 0} checked={draft.indices.includes(index)}
                  onChange={() => setDraft(value => ({ ...value, indices: form.mode === 'single' ? [index] :
                    value.indices.includes(index) ? value.indices.filter(item => item !== index) : [...value.indices, index].sort((a, b) => a - b) }))} />
                <span style={{ minWidth: 0 }}>{label}</span>
              </label>)}
            </div>
            {form.mode === 'multiple' ? <div>
              <button type="button" className={styles.textButton} onClick={() => setDraft(value => ({ ...value, indices: form.options!.map((_, index) => index) }))}>Select all</button>{' '}
              <button type="button" className={styles.textButton} onClick={() => setDraft(value => ({ ...value, indices: [] }))}>Clear</button>
            </div> : null}
            <button type="button" className={styles.textButton} onClick={() => setDraft(value => ({ ...value, write: true }))}>Write an answer</button>
          </> : draft.write ? <div>
            {renderWrittenAnswer({ variant: 'answer', label: 'Your answer', placeholder: 'Write your own answer…',
              value: draft.text, onChange: text => setDraft(value => ({ ...value, text })), onSend: sendWritten,
              disabledReason: held ?? (state.busy || state.uncertain ? 'Check the pending submission before writing a replacement answer.' : null), autoFocus: true })}
            <button type="button" className={styles.textButton} onClick={() => setDraft(value => ({ ...value, write: false }))}>{form.mode === 'short-answer' ? 'Back to form' : 'Back to choices'}</button>
          </div> : <label style={{ display: 'block' }} htmlFor={`${id}-text`}>Your answer
            <div className={styles.composerRow}>
              <textarea id={`${id}-text`} className={styles.composerBox} style={{ width: '100%', minHeight: 'var(--control-h-lg)', overflowWrap: 'anywhere' }}
                value={draft.text} onChange={event => setDraft(value => ({ ...value, text: event.target.value }))} autoFocus={autoFocus} />
            </div>
          </label>}
          {!draft.write ? <button type="button" className={styles.send} style={{ width: 'auto', minHeight: 'var(--control-h-lg)', paddingInline: 'var(--space-3)' }} disabled={state.busy || !!state.uncertain || expired || over ||
            (draft.write || form.mode === 'short-answer' ? !draft.text.trim() : draft.indices.length === 0)} onClick={() => submit()}>Submit answer</button> : null}
          {over ? <p role="alert">The complete answer must fit within 2,000 characters.</p> : null}
          {expired && form.mode === 'short-answer' && !draft.write ? <button type="button" className={styles.textButton}
            disabled={state.busy || !!state.uncertain} onClick={() => setDraft(value => ({ ...value, write: true }))}>Write an answer</button> : null}
          {expired ? <p role="status">These controls expired. You can still write an answer.</p> : null}
        </fieldset>
      ) : !question?.answered && (state.capability === 'unsupported' || state.capability === 'supported' && !form) && !state.uncertain ? (
        renderWrittenAnswer({ variant: 'answer', label: showQuestion ? 'Your answer' : `Answer the Leader: ${question?.text ?? fallbackText}`, placeholder: 'Answer the Leader…',
          value: draft.text, onChange: text => setDraft(value => ({ ...value, text })), onSend: sendWritten,
          disabledReason: held ?? (state.busy ? 'Sending your written answer…' : null), autoFocus })
      ) : null}
      {held ? <p className={styles.muted} role="status">{held}</p> : null}
      {state.status ? <p className={styles.muted} role="status">{state.status}</p> : null}
      <button type="button" className={styles.textButton} disabled={state.busy} onClick={() => void read()}>Check saved answer</button>
      {state.uncertain && state.capability === 'supported' && question && !question.answered && form?.revision === state.uncertain.formRevision ?
        <button type="button" className={styles.textButton} disabled={state.busy || held !== null || expired}
          onClick={() => submit(state.uncertain!)}>Retry the same submission</button> : null}
    </div>
  );
}

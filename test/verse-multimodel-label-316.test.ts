/**
 * 3.16 — once-per-send labelling: the Jev decision layer behind its
 * confidence gate, the rules as the fallback, and a record of which path
 * decided. Never a hard dependency; never asked about a local-only repo.
 *
 * The fake `decide` below follows the PUBLISHED contract (decide/types.ts on
 * jev-everywhere): it runs the caller's `interpret` over the answers, gates on
 * the returned confidence, and answers with `path: 'jev' | 'fallback'`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  interpretLabel,
  LABEL_CONFIDENCE_GATE,
  LABEL_DECISION_KIND,
  LABEL_QUESTIONS,
  labelPrompt,
  loadDecide,
  resetLabelCacheForTest,
  type DecideAnswer,
  type DecideFn,
} from '../src/core/verse/multimodel/label.js';

function answers(kind: string, difficulty: string, confidence: number, frontier = 0.8): Record<string, DecideAnswer> {
  return {
    task_class: { type: 'choice', choice: kind, confidence },
    complexity: { type: 'choice', choice: difficulty, confidence },
    needs_frontier: { type: 'noul', noul: frontier },
  };
}

/** A decide() that behaves like the real gate. `reply: null` = the layer itself fell back with `reason`. */
function fakeDecide(reply: Record<string, DecideAnswer> | null, reason = 'no-key'): DecideFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (_kind, _state, _questions, opts) => {
    const fb = typeof opts.fallback === 'function' ? (opts.fallback as () => unknown)() : opts.fallback;
    const threshold = opts.threshold ?? 0.75;
    if (!reply) return { value: fb, path: 'fallback', confidence: 1, threshold, reason };
    const read = opts.interpret?.(reply);
    if (!read) return { value: fb, path: 'fallback', confidence: 1, threshold, reason: 'no-answer', answers: reply };
    if (read.confidence < threshold) return { value: fb, path: 'fallback', confidence: 1, threshold, reason: 'below-threshold', jevConfidence: read.confidence, answers: reply };
    return { value: read.value, path: 'jev', confidence: read.confidence, threshold, jevConfidence: read.confidence, answers: reply };
  }) as unknown as DecideFn & ReturnType<typeof vi.fn>;
}

beforeEach(() => resetLabelCacheForTest());

describe('labelPrompt', () => {
  it('a confident label wins, keeps the measured size, and records that Jev decided', async () => {
    const decide = fakeDecide(answers('review', 'high', 0.94, 0.83));
    const out = await labelPrompt('stop the dashboard from double-counting merges', { decide });
    expect(out.fallbackReason).toBeNull();
    expect(out.classification).toMatchObject({ kind: 'review', task: 'review', difficulty: 'high', label: 'deep review', decidedBy: 'jev', confidence: 0.94, needsFrontier: 0.83 });
    expect(out.classification.estTokens).toBe(Math.ceil('stop the dashboard from double-counting merges'.length / 4));
    // One call, the task-class kind, all three questions, the gate stated.
    expect(decide).toHaveBeenCalledTimes(1);
    const [kind, state, questions, opts] = decide.mock.calls[0]!;
    expect(kind).toBe(LABEL_DECISION_KIND);
    expect(state).toBe('stop the dashboard from double-counting merges');
    expect(Object.keys(questions as object)).toEqual(Object.keys(LABEL_QUESTIONS));
    expect((opts as { threshold: number }).threshold).toBe(LABEL_CONFIDENCE_GATE);
  });

  it('below the gate the rules label it, and say how sure Jev was', async () => {
    const out = await labelPrompt('fix the typo in the README', { decide: fakeDecide(answers('refactor', 'low', 0.57)) });
    expect(out.classification).toMatchObject({ kind: 'code', decidedBy: 'rules' });
    expect(out.fallbackReason).toBe('Jev was 57% sure — below the 75% gate, so the rules labelled this.');
  });

  it('when the layer itself falls back (unkeyed, killed, over budget) its reason is said, and it is asked again next time', async () => {
    const decide = fakeDecide(null, 'budget-exhausted');
    const out = await labelPrompt('fix it', { decide });
    expect(out.classification.decidedBy).toBe('rules');
    expect(out.fallbackReason).toBe('The decision layer deferred (today’s call budget is spent); the rules labelled this.');
    await labelPrompt('fix it', { decide });
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it('never a hard dependency: not installed, throwing or slow all fall back to the rules', async () => {
    expect((await labelPrompt('fix it', { decide: null })).fallbackReason).toMatch(/not installed/);
    const boom = await labelPrompt('fix it', { decide: (async () => { throw new Error('ECONNREFUSED'); }) as DecideFn });
    expect(boom.classification.decidedBy).toBe('rules');
    expect(boom.fallbackReason).toMatch(/did not answer \(ECONNREFUSED\)/);
    const slow = await labelPrompt('fix it', { decide: (() => new Promise(() => {})) as DecideFn, timeoutMs: 20 });
    expect(slow.fallbackReason).toMatch(/timed out/);
  });

  it('a local-only repo is never sent to the decision layer', async () => {
    const decide = fakeDecide(answers('review', 'high', 0.99));
    const out = await labelPrompt('review the payment code', { decide, localOnlyReason: 'notes is listed in foundry.wiki.localOnlyRepos.' });
    expect(decide).not.toHaveBeenCalled();
    expect(out.classification.decidedBy).toBe('rules');
    expect(out.fallbackReason).toBe('Labelled on this Mac: notes is listed in foundry.wiki.localOnlyRepos.');
  });

  it('a label is cached by input (a paid call is not repeated); outages are not cached', async () => {
    const decide = fakeDecide(answers('review', 'medium', 0.9));
    await labelPrompt('review this', { decide });
    await labelPrompt('review this', { decide });
    expect(decide).toHaveBeenCalledTimes(1);
    let calls = 0;
    const flaky = (async () => { calls += 1; throw new Error('down'); }) as DecideFn;
    await labelPrompt('something else', { decide: flaky });
    await labelPrompt('something else', { decide: flaky });
    expect(calls).toBe(2);
  });

  it('an out-of-vocabulary answer is no answer', async () => {
    expect(interpretLabel(answers('poetry', 'high', 0.99))).toBeUndefined();
    expect(interpretLabel(answers('review', 'extreme', 0.99))).toBeUndefined();
    expect(interpretLabel({ ...answers('review', 'high', 0.99), complexity: { type: 'choice', choice: 'high', confidence: 0.6 } })?.confidence).toBe(0.6);
    const out = await labelPrompt('do the thing', { decide: fakeDecide(answers('poetry', 'high', 0.99)) });
    expect(out.classification.decidedBy).toBe('rules');
    expect(out.fallbackReason).toBe('The decision layer deferred (no usable answer); the rules labelled this.');
  });

  it('the real resolver answers a function or null — never throws', async () => {
    const fn = await loadDecide();
    expect(fn === null || typeof fn === 'function').toBe(true);
  });
});

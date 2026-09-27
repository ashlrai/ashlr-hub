/**
 * Once-per-send prompt labelling for the Auto seat: the Jev decision layer
 * (`src/core/decide/**`, docs/JEV-INTEGRATION.md) behind its confidence gate,
 * with the deterministic rules (classify.ts) as the fallback — and a record of
 * which path decided (`classification.decidedBy`, plus the layer's own ledger).
 *
 * RULES FROM THE INTEGRATION CONTRACT, AS APPLIED HERE
 *   - Never a hard dependency: the rules answer whenever the decision layer is
 *     not installed, unkeyed, killed, over budget, slow (LABEL_TIMEOUT_MS),
 *     failing, or below the gate. Availability never depends on it.
 *   - Never on a safety gate: it only LABELS the message. Which seats are
 *     eligible (readiness, local-only, reserves) stays deterministic, and the
 *     label can only change the ORDER of eligible seats.
 *   - Never on a hot path: the live Auto line uses the rules per pause in
 *     typing; this runs once, when a message is sent with Auto on.
 *   - Budget-aware: one call carries all three questions (task class,
 *     complexity, needs-frontier), the layer caches by input hash (and so does
 *     this module, before even loading it), and nothing is asked for a
 *     local-only repo — that text must not leave the machine at all.
 *
 * `decide` is resolved lazily from `../../decide/index.js` (branch
 * jev-everywhere). Until that module is on master the resolver answers "not
 * installed" and the rules decide. `DecideFn` below restates the PUBLISHED
 * signature (decide/types.ts, stable, additive-only) structurally:
 *   decide<T>(kind, state, questions, { fallback, threshold, interpret, timeoutMs, signal }) → Decision<T>
 * with kind `task-class` — this IS task-class labelling, for a chat message.
 *
 * NODE-ONLY (crypto). The browser uses classify.ts directly.
 */
import { createHash } from 'node:crypto';

import { classifyPrompt, promptLabel, taskOf } from './classify.js';
import { PROMPT_KINDS, type PromptClassification, type PromptKind } from './types.js';
import type { RoutingDifficulty } from '../../routing/types.js';

/** The `task-class` kind's registry gate (decide/registry.ts), passed explicitly so this module states it. */
export const LABEL_CONFIDENCE_GATE = 0.75;
export const LABEL_TIMEOUT_MS = 1_500;
/** The decision kind this call is recorded under in the layer's ledger. */
export const LABEL_DECISION_KIND = 'task-class';
const CACHE_MAX = 200;
/** The decision layer sees at most this much of a message (it labels intent, not content). */
const STATE_MAX_CHARS = 4_000;

// ---------------------------------------------------------------------------
// The decision-layer contract (restated structurally from decide/types.ts)
// ---------------------------------------------------------------------------

export type DecideQuestion =
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly min?: number; readonly max?: number }
  | { readonly type: 'noul'; readonly instructions: string };

export type DecideAnswer =
  | { readonly type: 'choice'; readonly choice: string; readonly confidence: number; readonly probabilities?: Readonly<Record<string, number>> }
  | { readonly type: 'score'; readonly score: number; readonly confidence: number }
  | { readonly type: 'noul'; readonly noul: number };

export interface DecideInterpretation<T> {
  readonly value: T;
  readonly confidence: number;
  readonly label?: string;
}

export interface DecideOptions<T> {
  readonly fallback: T | (() => T);
  readonly threshold?: number;
  readonly interpret?: (answers: Readonly<Record<string, DecideAnswer>>) => DecideInterpretation<T> | undefined;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface Decision<T> {
  readonly value: T;
  /** Which path produced `value`. */
  readonly path: 'jev' | 'fallback';
  readonly confidence: number;
  readonly threshold: number;
  /** Why the fallback was used (e.g. `below-threshold`, `no-key`, `killed`, `budget-exhausted`). */
  readonly reason?: string;
  readonly jevLabel?: string;
  readonly jevConfidence?: number;
  readonly answers?: Readonly<Record<string, DecideAnswer>>;
  readonly cached?: boolean;
}

export type DecideFn = <T>(kind: string, state: string, questions: Readonly<Record<string, DecideQuestion>>, opts: DecideOptions<T>) => Promise<Decision<T>>;

/**
 * Resolve the decision layer. A missing module is "not installed" (null); any
 * other load failure is also null — labelling must never break a send.
 */
export async function loadDecide(): Promise<DecideFn | null> {
  try {
    const mod = (await import('../../decide/index.js' as string)) as Record<string, unknown>;
    return typeof mod['decide'] === 'function' ? (mod['decide'] as DecideFn) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

const KIND_CRITERIA: Record<PromptKind, string> = {
  question: 'a short factual or how-to question that needs no code changes',
  explain: 'asks to explain, summarise or walk through existing code or a concept',
  code: 'asks to write, add, change or fix code',
  debug: 'reports a failure, error, crash or wrong behaviour to diagnose',
  refactor: 'restructures, renames, migrates or cleans up existing code without changing behaviour',
  review: 'asks for a review, critique or second opinion of code, a diff or an answer',
  plan: 'asks for a plan, design, architecture or trade-off analysis before building',
  bulk: 'a mechanical change applied across many files',
};

export const LABEL_QUESTIONS: Readonly<Record<string, DecideQuestion>> = {
  task_class: {
    type: 'choice',
    instructions: 'What kind of task does this chat message from a software engineer ask an AI coding assistant to do?',
    criteria: KIND_CRITERIA,
  },
  complexity: {
    type: 'choice',
    instructions: 'How hard is this task for an AI coding assistant?',
    criteria: {
      low: 'trivial or quick: a small answer or a one-line change',
      medium: 'ordinary: a focused change or explanation',
      high: 'hard: architecture, subtle bugs, concurrency, security, or many files',
    },
  },
  needs_frontier: {
    type: 'noul',
    instructions: 'Does this task need a frontier model, rather than a small model running on a laptop?',
  },
};

/** What the decision is about: intent, difficulty, and whether a laptop model will do. */
export interface LabelValue {
  kind: PromptKind;
  difficulty: RoutingDifficulty;
  needsFrontier: number | null;
}

function isKind(v: unknown): v is PromptKind {
  return typeof v === 'string' && (PROMPT_KINDS as readonly string[]).includes(v);
}

function isDifficulty(v: unknown): v is RoutingDifficulty {
  return v === 'low' || v === 'medium' || v === 'high';
}

/**
 * Jev's answers → a value, gated on the LOWER of its two choice confidences
 * (both labels must be trusted to act on either). An out-of-vocabulary label
 * is no answer at all.
 */
export function interpretLabel(answers: Readonly<Record<string, DecideAnswer>>): DecideInterpretation<LabelValue> | undefined {
  const kind = answers['task_class'];
  const diff = answers['complexity'];
  const frontier = answers['needs_frontier'];
  if (kind?.type !== 'choice' || diff?.type !== 'choice' || !isKind(kind.choice) || !isDifficulty(diff.choice)) return undefined;
  const confidence = Math.min(kind.confidence, diff.confidence);
  if (!Number.isFinite(confidence)) return undefined;
  return {
    value: {
      kind: kind.choice,
      difficulty: diff.choice,
      needsFrontier: frontier?.type === 'noul' && Number.isFinite(frontier.noul) ? Math.max(0, Math.min(1, frontier.noul)) : null,
    },
    confidence,
    label: `${kind.choice}/${diff.choice}`,
  };
}

// ---------------------------------------------------------------------------
// Labelling
// ---------------------------------------------------------------------------

export interface LabelOptions {
  contextTokens?: number | null;
  /** Non-null = this text must not leave the machine; the rules decide and this is the reason. */
  localOnlyReason?: string | null;
  /** Test seam / override. Default: `loadDecide()`. */
  decide?: DecideFn | null;
  timeoutMs?: number;
}

export interface LabelResult {
  classification: PromptClassification;
  fallbackReason: string | null;
}

const cache = new Map<string, LabelResult>();

export function resetLabelCacheForTest(): void {
  cache.clear();
}

function hashOf(text: string, contextBucket: number): string {
  return createHash('sha256').update(`${contextBucket}\0${text}`).digest('hex');
}

function withTimeout<T>(promise: Promise<T>, ms: number, abort: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error('timed out'));
    }, ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}

const REASON_TEXT: Record<string, string> = {
  'below-threshold': 'below the gate',
  'no-answer': 'no usable answer',
  killed: 'switched off',
  'kind-disabled': 'switched off for task labels',
  'budget-exhausted': 'today’s call budget is spent',
  'no-input': 'nothing to label',
};

/**
 * Label `text` for the Auto seat. Never throws; the result always carries a
 * classification and says which path produced it.
 */
export async function labelPrompt(text: string, opts: LabelOptions = {}): Promise<LabelResult> {
  const rules: PromptClassification = { ...classifyPrompt(text, { contextTokens: opts.contextTokens ?? null }), decidedBy: 'rules', confidence: null };
  if (opts.localOnlyReason) return { classification: rules, fallbackReason: `Labelled on this Mac: ${opts.localOnlyReason.replace(/\.$/, '')}.` };
  if (text.trim().length === 0) return { classification: rules, fallbackReason: 'Nothing to label.' };

  const bucket = (opts.contextTokens ?? 0) > 150_000 ? 1 : 0;
  const key = hashOf(text, bucket);
  const cached = cache.get(key);
  if (cached) return cached;

  const decide = opts.decide === undefined ? await loadDecide() : opts.decide;
  if (!decide) return { classification: rules, fallbackReason: 'The decision layer is not installed; the rules labelled this.' };

  const timeoutMs = opts.timeoutMs ?? LABEL_TIMEOUT_MS;
  const abort = new AbortController();
  let decision: Decision<LabelValue>;
  try {
    decision = await withTimeout(
      decide<LabelValue>(LABEL_DECISION_KIND, text.slice(0, STATE_MAX_CHARS), LABEL_QUESTIONS, {
        fallback: () => ({ kind: rules.kind, difficulty: rules.difficulty, needsFrontier: null }),
        threshold: LABEL_CONFIDENCE_GATE,
        interpret: interpretLabel,
        timeoutMs,
        signal: abort.signal,
      }),
      // A little past the layer's own deadline: it answers with its fallback first.
      timeoutMs + 250,
      abort,
    );
  } catch (err) {
    // Not cached: a timeout or outage should be retried on the next send.
    return { classification: rules, fallbackReason: `The decision layer did not answer (${err instanceof Error ? err.message : 'error'}); the rules labelled this.` };
  }

  let out: LabelResult;
  const value = decision?.value;
  if (decision?.path !== 'jev' || !value || !isKind(value.kind) || !isDifficulty(value.difficulty)) {
    const jevPct = typeof decision?.jevConfidence === 'number' ? Math.round(decision.jevConfidence * 100) : null;
    const why = decision?.reason === 'below-threshold' && jevPct !== null
      ? `Jev was ${jevPct}% sure — below the ${Math.round(LABEL_CONFIDENCE_GATE * 100)}% gate, so the rules labelled this.`
      : decision?.reason
        ? `The decision layer deferred (${REASON_TEXT[decision.reason] ?? decision.reason}); the rules labelled this.`
        : 'The decision layer deferred to the rules.';
    out = { classification: rules, fallbackReason: why };
  } else {
    // Keep the rules' size and token estimate (measured, not judged) and take
    // Jev's reading of intent and difficulty.
    out = {
      classification: {
        ...rules,
        kind: value.kind,
        task: taskOf(value.kind),
        difficulty: value.difficulty,
        label: promptLabel(value.kind, value.difficulty),
        signals: rules.signals.filter((s) => !/^(asks|a question|names|stack|restructures|touches|includes)/.test(s)),
        decidedBy: 'jev',
        confidence: decision.jevConfidence ?? decision.confidence,
        needsFrontier: value.needsFrontier,
      },
      fallbackReason: null,
    };
  }
  // Cache what will not change on a retry (a label, or a considered "not
  // sure"); an outage, a missing key or a spent budget is asked again next send.
  if (decision?.path === 'jev' || decision?.reason === 'below-threshold' || decision?.reason === 'no-answer') {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, out);
  }
  return out;
}

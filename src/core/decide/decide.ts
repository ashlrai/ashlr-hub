/**
 * decide/decide.ts — the one entry point every Jev call site goes through.
 *
 *   decide(kind, state, questions, { fallback, threshold?, interpret?, ... })
 *   decideEach(kind, items, question, { ... })   // N items, ONE paid call
 *
 * In order, and each step can only fall back, never throw:
 *   1. The deterministic fallback is the answer until something better wins.
 *   2. Blank input, the kill switch, a disabled kind, or a spent daily budget →
 *      fallback with zero I/O.
 *   3. Input-hash cache hit → reuse the answer set (no paid call).
 *   4. One askTypeSafe call with ALL of the site's questions (batched).
 *   5. Interpret (registry vocabulary by default), then gate on the kind's
 *      threshold. Escalate-only kinds additionally refuse any answer ranked
 *      below the deterministic one.
 *   6. Record the outcome (path, reason, confidence, tokens, est. cost,
 *      latency) to the ledger — never the classified text.
 *
 * CONTRACT (docs/JEV-INTEGRATION.md): never a hard dependency, confidence-gated
 * with the path recorded, never on a safety gate (escalate-only at most), never
 * on a hot path, budget-aware.
 */

import type { AshlrConfig } from '../types.js';
import {
  askTypeSafe,
  typeSafeAvailable,
  type TypeSafeAnswer,
  type TypeSafeOk,
  type TypeSafeQuestion,
} from '../classify/typesafe-client.js';
import { cacheGet, cacheKey, cacheSet } from './cache.js';
import {
  estimateCostUsd,
  jevKilledByEnv,
  paidCallsToday,
  readJevConfig,
  recordDecision,
} from './ledger.js';
import { DECISION_KINDS } from './registry.js';
import type {
  DecideOptions,
  Decision,
  DecisionFallbackReason,
  DecisionKind,
  Interpretation,
} from './types.js';

let cachedCfg: AshlrConfig | undefined;

/**
 * Fallbacks that say "Jev is not set up / switched off", not "Jev was asked".
 * Not recorded: an unkeyed install should not grow a ~/.ashlr/jev ledger of
 * 100%-fallback lines, and status reports the unkeyed/killed state directly.
 */
const UNRECORDED_REASONS: ReadonlySet<DecisionFallbackReason> = new Set<DecisionFallbackReason>([
  'no-key',
  'disabled',
  'killed',
  'kind-disabled',
  'no-input',
]);

/** Most items folded into one batched call. Keeps the state small and the answer set legible. */
export const MAX_BATCH_ITEMS = 10;

/** Read-only config for key resolution; `{}` if unreadable (phantom off → env/file only). */
async function defaultCfg(): Promise<AshlrConfig> {
  if (cachedCfg) return cachedCfg;
  try {
    const { loadConfigReadOnly } = await import('../config.js');
    cachedCfg = loadConfigReadOnly();
  } catch {
    cachedCfg = {} as AshlrConfig;
  }
  return cachedCfg;
}

/** True when a Jev call could go out right now (enabled, keyed, kind on). No network. */
export async function jevReady(kind?: DecisionKind, cfg?: AshlrConfig): Promise<boolean> {
  if (jevKilledByEnv()) return false;
  const jc = readJevConfig();
  if (!jc.enabled) return false;
  if (kind && jc.disabledKinds.includes(kind)) return false;
  return typeSafeAvailable(cfg ?? (await defaultCfg()));
}

/** The threshold a kind will actually use (explicit override, then config, then registry). */
export function effectiveThreshold(kind: DecisionKind, override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0 && override <= 1) return override;
  const fromConfig = readJevConfig().thresholds[kind];
  return fromConfig ?? DECISION_KINDS[kind].threshold;
}

// ---------------------------------------------------------------------------
// The shared transport step: kill switch, budget, cache, one call
// ---------------------------------------------------------------------------

type TransportOptions = Pick<
  DecideOptions<unknown>,
  'cfg' | 'model' | 'timeoutMs' | 'signal' | 'endpoint' | 'cache' | 'cacheSalt'
>;

type Asked =
  | { readonly ok: true; readonly result: TypeSafeOk; readonly cached: boolean; readonly called: boolean }
  | { readonly ok: false; readonly reason: DecisionFallbackReason; readonly called: boolean };

async function askJev(
  kind: DecisionKind,
  state: string,
  questions: Readonly<Record<string, TypeSafeQuestion>>,
  opts: TransportOptions,
): Promise<Asked> {
  if (typeof state !== 'string' || state.trim() === '') return { ok: false, reason: 'no-input', called: false };
  if (Object.keys(questions).length === 0) return { ok: false, reason: 'no-input', called: false };

  const jc = readJevConfig();
  if (jevKilledByEnv() || !jc.enabled) return { ok: false, reason: 'killed', called: false };
  if (jc.disabledKinds.includes(kind)) return { ok: false, reason: 'kind-disabled', called: false };

  const modelId = opts.model ?? 'jev-latest';
  const key = cacheKey([kind, modelId, JSON.stringify(questions), opts.cacheSalt ?? '', state]);
  const useCache = opts.cache !== false;
  if (useCache) {
    const hit = cacheGet(key);
    if (hit) return { ok: true, result: hit, cached: true, called: false };
  }

  if (paidCallsToday() >= jc.dailyCallBudget) return { ok: false, reason: 'budget-exhausted', called: false };

  const cfg = opts.cfg ?? (await defaultCfg());
  const result = await askTypeSafe(
    { state, questions, model: modelId },
    cfg,
    {
      timeoutMs: opts.timeoutMs ?? DECISION_KINDS[kind].timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    },
  );
  if (!result.ok) {
    // A request left the machine unless we stopped before dispatch.
    const called = result.reason !== 'no-key' && result.reason !== 'disabled';
    return { ok: false, reason: result.reason, called };
  }
  if (useCache) cacheSet(key, result);
  return { ok: true, result, cached: false, called: true };
}

// ---------------------------------------------------------------------------
// Interpretation + gating (shared by decide and decideEach)
// ---------------------------------------------------------------------------

function defaultInterpret<T>(
  kind: DecisionKind,
  question: TypeSafeQuestion | undefined,
  answer: TypeSafeAnswer | undefined,
): Interpretation<T> | undefined {
  if (!answer || answer.type !== 'choice') return undefined;
  const spec = DECISION_KINDS[kind];
  const vocab: readonly string[] = spec.labels.length > 0
    ? spec.labels
    : question && question.type === 'choice' ? Object.keys(question.criteria) : [];
  // An invented label is as unusable as no answer.
  if (!vocab.includes(answer.choice)) return undefined;
  if (question && question.type === 'choice' && !(answer.choice in question.criteria)) return undefined;
  return { value: answer.choice as unknown as T, confidence: answer.confidence, label: answer.choice };
}

function shortLabel(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length <= 48 && !/\s{2,}|\n/.test(value)) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return undefined;
}

function lazy<T>(fallback: T | (() => T)): () => T {
  let computed = false;
  let value: T | undefined;
  return () => {
    if (!computed) {
      value = typeof fallback === 'function' ? (fallback as () => T)() : fallback;
      computed = true;
    }
    return value as T;
  };
}

interface Accounting {
  readonly called: boolean;
  readonly usage?: TypeSafeOk['usage'];
}

function record<T>(decision: Decision<T>, acct: Accounting): void {
  if (decision.path === 'fallback' && decision.reason && UNRECORDED_REASONS.has(decision.reason)) return;
  try {
    const inputTokens = acct.called ? acct.usage?.inputTokens : undefined;
    const outputTokens = acct.called ? acct.usage?.outputTokens : undefined;
    const label = shortLabel(decision.value);
    recordDecision({
      ts: new Date().toISOString(),
      kind: decision.kind,
      path: decision.path,
      ...(decision.reason ? { reason: decision.reason } : {}),
      confidence: decision.confidence,
      ...(decision.jevLabel !== undefined ? { jevLabel: decision.jevLabel } : {}),
      ...(decision.jevConfidence !== undefined ? { jevConfidence: decision.jevConfidence } : {}),
      ...(label !== undefined ? { label } : {}),
      cached: decision.cached,
      called: acct.called,
      ...(decision.model ? { model: decision.model } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(inputTokens !== undefined && outputTokens !== undefined
        ? { estCostUsd: estimateCostUsd(inputTokens, outputTokens) }
        : {}),
      durationMs: decision.durationMs,
    });
  } catch {
    /* never fail a decision on observability */
  }
}

interface GateInput<T> {
  readonly kind: DecisionKind;
  readonly threshold: number;
  readonly fallback: () => T;
  readonly started: number;
  readonly asked: Asked;
  readonly interpret: (answers: Readonly<Record<string, TypeSafeAnswer>>) => Interpretation<T> | undefined;
  readonly escalateOnly?: (value: T) => number;
}

function gate<T>(g: GateInput<T>): Decision<T> {
  const base = { kind: g.kind, threshold: g.threshold };
  const elapsed = (): number => Date.now() - g.started;
  const fellBack = (reason: DecisionFallbackReason, extra: Partial<Decision<T>> = {}): Decision<T> => ({
    ...base,
    value: g.fallback(),
    path: 'fallback',
    confidence: 1,
    reason,
    cached: false,
    durationMs: elapsed(),
    ...extra,
  });

  if (!g.asked.ok) return fellBack(g.asked.reason);
  const { result, cached } = g.asked;
  const answers = result.answers;
  const seen = { answers, model: result.model, cached };

  let interp: Interpretation<T> | undefined;
  try {
    interp = g.interpret(answers);
  } catch {
    interp = undefined;
  }
  if (!interp || !Number.isFinite(interp.confidence)) return fellBack('no-answer', seen);

  const jevLabel = interp.label ?? shortLabel(interp.value) ?? 'value';
  const heard = { ...seen, jevLabel, jevConfidence: interp.confidence };
  if (interp.confidence < g.threshold) return fellBack('below-threshold', heard);

  if (g.escalateOnly) {
    let lower: boolean;
    try {
      lower = g.escalateOnly(interp.value) < g.escalateOnly(g.fallback());
    } catch {
      lower = true;
    }
    if (lower) return fellBack('escalate-only', heard);
  }

  return { ...base, value: interp.value, path: 'jev', confidence: interp.confidence, durationMs: elapsed(), ...heard };
}

// ---------------------------------------------------------------------------
// Public: decide
// ---------------------------------------------------------------------------

/**
 * Ask Jev a batch of typed questions about one piece of state and return the
 * gated decision. NEVER THROWS — every failure is the fallback plus a reason.
 */
export async function decide<T>(
  kind: DecisionKind,
  state: string,
  questions: Readonly<Record<string, TypeSafeQuestion>>,
  opts: DecideOptions<T>,
): Promise<Decision<T>> {
  const started = Date.now();
  const fallback = lazy(opts.fallback);
  let threshold = DECISION_KINDS[kind].threshold;
  let asked: Asked = { ok: false, reason: 'network', called: false };
  try {
    threshold = effectiveThreshold(kind, opts.threshold);
    asked = await askJev(kind, state, questions, opts);
  } catch {
    asked = { ok: false, reason: 'network', called: false };
  }
  const primary = DECISION_KINDS[kind].primary;
  const decision = gate<T>({
    kind,
    threshold,
    fallback,
    started,
    asked,
    interpret: opts.interpret ?? ((answers) => defaultInterpret<T>(kind, questions[primary], answers[primary])),
    ...(opts.escalateOnly ? { escalateOnly: opts.escalateOnly } : {}),
  });
  record(decision, { called: asked.called, ...(asked.ok ? { usage: asked.result.usage } : {}) });
  return decision;
}

// ---------------------------------------------------------------------------
// Public: decideEach — many items, one call
// ---------------------------------------------------------------------------

export interface BatchItem<T> {
  /** Stable id, echoed back in order. Not sent to Jev. */
  readonly id: string;
  /** The item's text. Blank items are answered by their fallback, never sent. */
  readonly text: string;
  readonly fallback: T | (() => T);
}

export interface DecideEachOptions<T> extends Omit<DecideOptions<T>, 'fallback' | 'interpret' | 'escalateOnly'> {
  /** Sentence placed above the numbered items (e.g. "Each item is a PR title."). */
  readonly preamble?: string;
  /** Per-item interpretation of that item's answer. Default: registry vocabulary. */
  readonly interpret?: (answer: TypeSafeAnswer | undefined, item: BatchItem<T>) => Interpretation<T> | undefined;
  /** Per-item escalate-only rank (see DecideOptions.escalateOnly). */
  readonly escalateOnly?: (value: T, item: BatchItem<T>) => number;
}

/**
 * Classify many items with ONE paid call per MAX_BATCH_ITEMS: the items are
 * numbered into one state and asked as `item_1..item_n`, each with the same
 * question shape. Every item is gated independently and gets its own ledger
 * line; the call's tokens are attributed to the first item of its chunk so
 * cost sums correctly.
 */
export async function decideEach<T>(
  kind: DecisionKind,
  items: readonly BatchItem<T>[],
  question: TypeSafeQuestion,
  opts: DecideEachOptions<T> = {},
): Promise<Decision<T>[]> {
  const out: Decision<T>[] = [];
  let threshold = DECISION_KINDS[kind].threshold;
  try {
    threshold = effectiveThreshold(kind, opts.threshold);
  } catch {
    /* registry default */
  }

  for (let offset = 0; offset < items.length; offset += MAX_BATCH_ITEMS) {
    const chunk = items.slice(offset, offset + MAX_BATCH_ITEMS);
    const started = Date.now();
    const live = chunk.map((item, i) => ({ item, name: `item_${i + 1}` })).filter((x) => x.item.text.trim() !== '');
    const questions: Record<string, TypeSafeQuestion> = {};
    for (const { name } of live) {
      questions[name] = { ...question, instructions: `[${name}] ${question.instructions}` } as TypeSafeQuestion;
    }
    const state = [
      opts.preamble ?? '',
      ...live.map(({ item, name }) => `[${name}]\n${item.text.trim()}`),
    ].filter(Boolean).join('\n\n');

    let asked: Asked;
    try {
      asked = live.length > 0
        ? await askJev(kind, state, questions, opts)
        : { ok: false, reason: 'no-input', called: false };
    } catch {
      asked = { ok: false, reason: 'network', called: false };
    }

    let accounted = false;
    for (const item of chunk) {
      const entry = live.find((x) => x.item === item);
      const itemAsked: Asked = entry ? asked : { ok: false, reason: 'no-input', called: false };
      const fallback = lazy(item.fallback);
      const decision = gate<T>({
        kind,
        threshold,
        fallback,
        started,
        asked: itemAsked,
        interpret: (answers) => {
          const answer = entry ? answers[entry.name] : undefined;
          return opts.interpret
            ? opts.interpret(answer, item)
            : defaultInterpret<T>(kind, question, answer);
        },
        ...(opts.escalateOnly ? { escalateOnly: (v: T) => opts.escalateOnly!(v, item) } : {}),
      });
      // Only the answers for THIS item are exposed on its decision.
      const scoped: Decision<T> = decision.answers && entry
        ? { ...decision, answers: entry.name in decision.answers ? { [entry.name]: decision.answers[entry.name]! } : {} }
        : decision;
      const called = !accounted && itemAsked.called;
      if (called) accounted = true;
      record(scoped, { called, ...(called && itemAsked.ok ? { usage: itemAsked.result.usage } : {}) });
      out.push(scoped);
    }
  }
  return out;
}

/** Test seam. */
export function resetDecideConfigForTests(): void {
  cachedCfg = undefined;
}

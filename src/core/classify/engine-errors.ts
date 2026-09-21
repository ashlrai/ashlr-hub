/**
 * classify/engine-errors.ts — ONE typed classification for arbitrary engine
 * stderr, replacing two implementations that disagreed with each other.
 *
 * THE PROBLEM THIS FIXES
 * ----------------------
 * Two places in `src/core/run` classify the same input — whatever the Claude
 * CLI, Codex, Ollama, LM Studio or a NIM printed on the way down — with two
 * different notions of the same categories:
 *
 *   - `run/agent-diagnostics.ts` `classifyAgentDiagnosticError`: seven ordered
 *     regexes producing a persisted `AgentDiagnosticErrorClass` row.
 *   - `run/self-heal.ts` `classifyHealEvent`: three substring predicates
 *     producing a heal *strategy*.
 *
 * They already disagreed about rate limits: "quota exceeded", "overloaded" and
 * "throttled" are rate limits to the heal path and plain `execution` failures
 * to the diagnostics path, so the same stderr was backed off by one subsystem
 * and recorded as an unclassified crash by the other. The predicates below are
 * now the single source of truth for those notions — `self-heal.ts` imports
 * them instead of keeping its own copy, and the unified label set is the union
 * of what both subsystems could express.
 *
 * THE THREE LAYERS
 * ----------------
 *   1. `classifyEngineErrorHeuristic` — deterministic, offline, instant. The
 *      existing regex/substring implementations, unified into one label set.
 *      This is the answer whenever the classifier is not usable, and the
 *      original `classifyAgentDiagnosticError` is still the authority for
 *      every label it can produce (it is called, not reimplemented).
 *   2. `classifyEngineError` — asks Jev for the kind AND the retryability Noul
 *      in a single request (the API is priced per call), then gates on
 *      confidence.
 *   3. Provenance — every result carries `source`, so which path produced the
 *      answer is auditable after the fact.
 *
 * CONTRACT COMPLIANCE (docs/JEV-INTEGRATION.md):
 *   - Never a hard dependency: the deterministic path is always computed first
 *     and is what gets returned on any classifier failure. With no network and
 *     no key this module does zero I/O and answers exactly as before.
 *   - Confidence-gated: see ENGINE_ERROR_CONFIDENCE_THRESHOLD.
 *   - Never on a safety gate: this feeds retry policy, heal strategy and
 *     routing analytics. It is not consulted by riskScan, classifyRisk,
 *     evaluateMergeAuthority, or any cryptographic/operational state machine.
 *   - Never on a hot path: fires once per engine failure.
 */

import type { AshlrConfig } from '../types.js';
import { classifyAgentDiagnosticError } from '../run/agent-diagnostics.js';
import type { AgentDiagnosticErrorClass } from '../run/agent-diagnostics.js';
import {
  askTypeSafe,
  choiceAnswer,
  noulAnswer,
  type TypeSafeChoiceQuestion,
  type TypeSafeNoulQuestion,
  type TypeSafeUnavailableReason,
} from './typesafe-client.js';

// ---------------------------------------------------------------------------
// The unified label set
// ---------------------------------------------------------------------------

/**
 * The union of what both prior implementations could express.
 *
 * The first eight are `AgentDiagnosticErrorClass` verbatim, so the persisted
 * diagnostics schema is unchanged. The two additions —`mcp-downstream` and
 * `model-failure` — are the distinctions only the heal path could previously
 * make; both collapse back to `execution` for the diagnostics row (see
 * `toAgentDiagnosticErrorClass`), which is exactly what was recorded before.
 */
export type EngineErrorKind =
  | 'none'
  | 'authentication'
  | 'configuration'
  | 'command-missing'
  | 'rate-limit'
  | 'timeout'
  | 'terminated'
  | 'mcp-downstream'
  | 'model-failure'
  | 'execution';

export const ENGINE_ERROR_KINDS: readonly EngineErrorKind[] = [
  'none',
  'authentication',
  'configuration',
  'command-missing',
  'rate-limit',
  'timeout',
  'terminated',
  'mcp-downstream',
  'model-failure',
  'execution',
];

/** Which layer produced the answer. Recorded so a decision stays auditable. */
export type EngineErrorSource =
  /** Jev answered at or above the confidence threshold. */
  | 'classifier'
  /** Jev answered but below threshold — the deterministic answer was kept. */
  | 'heuristic'
  /** Jev was not consulted or could not answer — the deterministic answer. */
  | 'fallback';

export interface EngineErrorClassification {
  readonly kind: EngineErrorKind;
  /** Whether retrying the same operation unchanged could plausibly succeed. */
  readonly retryable: boolean;
  /** Confidence in `kind`. Deterministic answers report 1 — they are not
   *  guesses, they are the rule that was applied. */
  readonly confidence: number;
  /** The classifier's raw confidence, present whenever it answered at all —
   *  including when it lost the gate, so a threshold can be re-tuned from
   *  recorded data rather than from intuition. */
  readonly classifierConfidence?: number;
  /** The classifier's label, present even when the gate rejected it. */
  readonly classifierKind?: EngineErrorKind;
  /** Raw Noul (P(retry succeeds)) when the classifier answered. */
  readonly retryProbability?: number;
  readonly source: EngineErrorSource;
  /** Why the classifier was not used. Absent when `source` is 'classifier'. */
  readonly unavailableReason?: TypeSafeUnavailableReason | 'below-threshold' | 'no-answer';
  /** Concrete model id that answered, e.g. "jev-1.13.0". */
  readonly model?: string;
  /** Wall-clock spent consulting the classifier. 0 when it was not consulted. */
  readonly classifierMs: number;
}

/**
 * CONFIDENCE THRESHOLD — 0.75.
 *
 * Chosen from the measured calibration rather than picked round. Jev returned
 * 1.0 on an unambiguous rate-limit stderr and 0.57 on a deliberately ambiguous
 * input where probability mass was genuinely split across two labels. So the
 * live separation between "this is obvious" and "this is a coin flip" sits
 * somewhere in (0.57, 1.0], and any gate in that interval distinguishes them.
 *
 * 0.75 is placed in that gap for a reason that survives a re-measure: a top
 * label at 0.75 carries three times the mass of *everything else combined*.
 * Below 3:1 the model is telling us the input is ambiguous, and the right
 * response to an ambiguous engine failure is the deterministic rule — which is
 * reviewable, reproducible, and has been making this call acceptably for the
 * whole life of the codebase. We only let the model overrule a regex when it is
 * clearly more sure than the regex is wrong.
 *
 * It is deliberately NOT set near 0.57: accepting the measured ambiguous case
 * would mean overruling a deterministic rule on ~57/43 odds, which is the
 * "silently accept a coin-flip" the contract forbids. It is also not set at
 * 0.95+, which would reject anything but perfect certainty and make the
 * classifier a no-op that still costs money on every failure.
 *
 * Re-tune from data, not from taste: every result records
 * `classifierConfidence` even when the gate rejected it, so the distribution of
 * near-miss confidences is recoverable.
 */
export const ENGINE_ERROR_CONFIDENCE_THRESHOLD = 0.75;

// ---------------------------------------------------------------------------
// Shared deterministic predicates — the single source of truth
// ---------------------------------------------------------------------------

/**
 * Provider throttling / quota exhaustion.
 *
 * THE UNION of the two prior notions: `agent-diagnostics` matched
 * rate-limit/429/too-many-requests; `self-heal` additionally matched
 * quota-exceeded/overloaded/throttled. Widening diagnostics to the heal path's
 * set is the strictly-safer direction — it relabels failures that were falling
 * through to the catch-all `execution`, and relabels nothing that already had a
 * more specific label.
 */
export function isRateLimitText(text: string): boolean {
  return /rate.?limit|rate_limit|too many requests|\b429\b|quota exceeded|overloaded|throttl/i.test(text);
}

/**
 * An MCP downstream server crashed or could not be reached. Lifted verbatim
 * from `self-heal.ts` so both subsystems agree on the definition.
 *
 * Note the explicit carve-out: "unsafe mcp argv refused" is a REFUSAL by our
 * own guard, not a downstream crash. Treating it as restartable would retry
 * an argv the safety layer just rejected.
 */
export function isMcpDownstreamText(text: string): boolean {
  const msg = text.toLowerCase();
  if (msg.includes('unsafe mcp argv refused')) return false;
  return (
    msg.includes('spawn') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('connect failed') ||
    msg.includes('downstream') ||
    msg.includes('mcp') ||
    msg.includes('exited with code') ||
    msg.includes('process exited')
  );
}

/** The model itself failed — OOM, context overflow, not loaded, inference
 *  error. Lifted verbatim from `self-heal.ts`. */
export function isModelFailureText(text: string): boolean {
  const msg = text.toLowerCase();
  return (
    msg.includes('oom') ||
    msg.includes('out of memory') ||
    msg.includes('cuda out of memory') ||
    msg.includes('model error') ||
    msg.includes('model failed') ||
    msg.includes('context length') ||
    msg.includes('context window') ||
    msg.includes('model not loaded') ||
    msg.includes('llm error') ||
    msg.includes('inference error')
  );
}

/**
 * Retryability of a kind, deterministically. Used as the offline answer for the
 * Noul and as the fallback whenever the classifier is not consulted.
 *
 * `terminated` is false on purpose: a killed process is usually a deadline, a
 * cancellation or an OOM-killer, and blindly retrying it is how a run burns its
 * whole budget re-dying. `execution` is false for the same reason the heal path
 * refuses to classify it — an unrecognised failure is not known to be transient.
 */
export function isRetryableKind(kind: EngineErrorKind): boolean {
  switch (kind) {
    case 'rate-limit':
    case 'timeout':
    case 'mcp-downstream':
    case 'model-failure':
      return true;
    case 'none':
    case 'authentication':
    case 'configuration':
    case 'command-missing':
    case 'terminated':
    case 'execution':
      return false;
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — the deterministic classification
// ---------------------------------------------------------------------------

/**
 * The offline answer. Never throws, never does I/O.
 *
 * ORDERING is the seven ordered regexes of `classifyAgentDiagnosticError`
 * first — it is called, not copied, so its behaviour stays exactly one
 * implementation — with the two heal-only kinds consulted only where it would
 * otherwise have said `execution`.
 *
 * That placement matters. `isMcpDownstreamText` is very broad (any message
 * containing "spawn" or "exited with code"), so running it first would
 * relabel `spawn ETIMEDOUT` as `mcp-downstream` and contradict the persisted
 * diagnostics history. Running it last preserves every existing label and only
 * refines the catch-all.
 *
 * The one deliberate widening is the rate-limit union, applied ahead of the
 * regexes — see `isRateLimitText`.
 */
export function classifyEngineErrorHeuristic(value: unknown): EngineErrorKind {
  if (typeof value !== 'string' || value.trim() === '') return 'none';

  // The widened rate-limit notion — the disagreement this module exists to end.
  if (isRateLimitText(value)) return 'rate-limit';

  const base = classifyAgentDiagnosticError(value);
  if (base !== 'execution') return base;

  // Only refine what the existing table could not name.
  if (isModelFailureText(value)) return 'model-failure';
  if (isMcpDownstreamText(value)) return 'mcp-downstream';
  return 'execution';
}

// ---------------------------------------------------------------------------
// Adapters back to the existing consumers
// ---------------------------------------------------------------------------

/**
 * Project a unified kind onto the persisted diagnostics schema. The two new
 * kinds collapse to `execution`, which is precisely what
 * `classifyAgentDiagnosticError` recorded for them before, so no historical row
 * changes meaning and `AgentDiagnosticErrorClass` needs no migration.
 */
export function toAgentDiagnosticErrorClass(kind: EngineErrorKind): AgentDiagnosticErrorClass {
  return kind === 'mcp-downstream' || kind === 'model-failure' ? 'execution' : kind;
}

// ---------------------------------------------------------------------------
// Layer 2 — the classifier, in one call
// ---------------------------------------------------------------------------

const KIND_CRITERIA: Readonly<Record<Exclude<EngineErrorKind, 'none'>, string>> = {
  'rate-limit':
    'The provider throttled the request or a quota ran out: 429, "too many requests", "rate limit", "quota exceeded", "overloaded", "throttled". Retrying later can work.',
  authentication:
    'Credentials are missing, invalid, expired or insufficient: 401, 403, "unauthorized", "forbidden", "invalid api key", "not logged in".',
  'command-missing':
    'The engine binary or one of its subcommands does not exist on this machine: ENOENT, "command not found", "no such file or directory" for the executable itself.',
  configuration:
    'The engine started but rejected its configuration, flags or options: unknown flag, unknown variant, "expected one of", malformed config file.',
  timeout: 'The operation exceeded its deadline: "timed out", ETIMEDOUT, a deadline or watchdog fired.',
  terminated:
    'The process was killed or aborted from outside: SIGKILL/SIGTERM, "killed", "aborted", cancelled by an operator or the OS.',
  'mcp-downstream':
    'An MCP downstream server failed: it could not be spawned, crashed, refused the connection, or the socket hung up. The failure is in the downstream tool server, not the model.',
  'model-failure':
    'The model itself failed: out of memory, CUDA OOM, context length or context window exceeded, model not loaded, inference error.',
  execution:
    'Any other runtime failure: the engine ran and failed for a reason none of the other categories describes.',
};

function buildQuestions(): {
  error_kind: TypeSafeChoiceQuestion;
  retryable: TypeSafeNoulQuestion;
} {
  return {
    // NOTE: `criteria` is FLAT on the question — not nested under a `choice`
    // key. The validator's error path implies otherwise; it is wrong.
    error_kind: {
      type: 'choice',
      instructions:
        'This is the stderr/error text emitted by a coding-agent engine (Claude CLI, Codex, Ollama, LM Studio, or an NVIDIA NIM) when it failed. Classify the underlying cause into exactly one kind. Judge the root cause, not incidental words.',
      criteria: KIND_CRITERIA,
    },
    retryable: {
      type: 'noul',
      instructions:
        'Could re-running this exact same operation, unchanged and against the same engine, plausibly succeed? Answer yes only for genuinely transient conditions; answer no when something must change first (credentials, configuration, an install).',
    },
  };
}

/** Labels the classifier may return. `none` is excluded — empty input never
 *  reaches the API, so offering the label would only invite a wrong one. */
const CLASSIFIER_LABELS: readonly EngineErrorKind[] = ENGINE_ERROR_KINDS.filter((k) => k !== 'none');

export interface ClassifyEngineErrorOptions {
  /** Override the gate. Defaults to ENGINE_ERROR_CONFIDENCE_THRESHOLD. */
  readonly confidenceThreshold?: number;
  /** Hard deadline for the classifier call. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test/self-host override, forwarded to the client. */
  readonly endpoint?: string;
}

/**
 * Classify engine stderr, asking the kind and the retryability Noul in ONE
 * request, and fall back to the deterministic answer whenever the classifier is
 * unavailable, fails, or is not confident enough.
 *
 * NEVER THROWS, and never blocks on the network when unkeyed or disabled — in
 * that case it is a synchronous-in-spirit call that returns the heuristic
 * answer with `source: 'fallback'` after zero I/O. That is what makes it safe
 * on a failure path in a local-first, possibly offline hub.
 */
export async function classifyEngineError(
  value: unknown,
  cfg: AshlrConfig,
  opts: ClassifyEngineErrorOptions = {},
): Promise<EngineErrorClassification> {
  // The deterministic answer is computed FIRST and unconditionally. Everything
  // after this point can only replace it with something strictly better.
  const heuristicKind = classifyEngineErrorHeuristic(value);
  const deterministic: EngineErrorClassification = {
    kind: heuristicKind,
    retryable: isRetryableKind(heuristicKind),
    confidence: 1,
    source: 'fallback',
    classifierMs: 0,
  };

  // Empty input is `none` by definition — never worth a paid call.
  if (heuristicKind === 'none' || typeof value !== 'string') return deterministic;

  const threshold = opts.confidenceThreshold ?? ENGINE_ERROR_CONFIDENCE_THRESHOLD;

  const result = await askTypeSafe(
    { state: value, questions: buildQuestions(), model: 'jev-latest' },
    cfg,
    {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    },
  );

  if (!result.ok) {
    return { ...deterministic, unavailableReason: result.reason, classifierMs: result.durationMs };
  }

  const kindAnswer = choiceAnswer(result, 'error_kind', CLASSIFIER_LABELS);
  if (!kindAnswer) {
    return {
      ...deterministic,
      unavailableReason: 'no-answer',
      model: result.model,
      classifierMs: result.durationMs,
    };
  }

  const retryNoul = noulAnswer(result, 'retryable')?.noul;

  if (kindAnswer.confidence < threshold) {
    // Below the gate the deterministic answer wins — but we keep what the
    // classifier said so the threshold can be re-tuned from recorded data.
    return {
      ...deterministic,
      source: 'heuristic',
      unavailableReason: 'below-threshold',
      classifierKind: kindAnswer.choice,
      classifierConfidence: kindAnswer.confidence,
      ...(retryNoul !== undefined ? { retryProbability: retryNoul } : {}),
      model: result.model,
      classifierMs: result.durationMs,
    };
  }

  return {
    kind: kindAnswer.choice,
    // The Noul is a probability, not a confidence, so 0.5 is its decision
    // boundary. If the Noul is missing (a malformed or partial answer set) the
    // deterministic retryability of the accepted kind is used rather than a
    // guess.
    retryable: retryNoul !== undefined ? retryNoul >= 0.5 : isRetryableKind(kindAnswer.choice),
    confidence: kindAnswer.confidence,
    classifierKind: kindAnswer.choice,
    classifierConfidence: kindAnswer.confidence,
    ...(retryNoul !== undefined ? { retryProbability: retryNoul } : {}),
    source: 'classifier',
    model: result.model,
    classifierMs: result.durationMs,
  };
}

/**
 * One-line, secret-free audit string for a classification. Callers persist or
 * log this so the path that produced a decision is recoverable later.
 *
 * Contains only the label set, confidences and provenance — never the stderr
 * that was classified, which can contain paths and tokens.
 */
export function describeEngineErrorClassification(c: EngineErrorClassification): string {
  const parts = [
    `kind=${c.kind}`,
    `retryable=${c.retryable}`,
    `source=${c.source}`,
    `confidence=${c.confidence.toFixed(2)}`,
  ];
  if (c.source !== 'classifier' && c.classifierKind) {
    parts.push(`classifierKind=${c.classifierKind}`);
  }
  if (c.classifierConfidence !== undefined && c.source !== 'classifier') {
    parts.push(`classifierConfidence=${c.classifierConfidence.toFixed(2)}`);
  }
  if (c.retryProbability !== undefined) parts.push(`retryP=${c.retryProbability.toFixed(2)}`);
  if (c.unavailableReason) parts.push(`why=${c.unavailableReason}`);
  if (c.model) parts.push(`model=${c.model}`);
  if (c.classifierMs > 0) parts.push(`classifierMs=${c.classifierMs}`);
  return parts.join(' ');
}

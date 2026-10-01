/**
 * decide/types.ts — the stable public types of the Jev decision layer.
 *
 * STABILITY: other agents (multi-model orchestration, automations, Leader /
 * Telegram, the Devin fleet) import these types. Additive changes only — never
 * rename or narrow an exported field.
 */

import type { AshlrConfig } from '../types.js';
import type {
  TypeSafeAnswer,
  TypeSafeModel,
  TypeSafeQuestion,
  TypeSafeUnavailableReason,
} from '../classify/typesafe-client.js';

export type { TypeSafeAnswer, TypeSafeModel, TypeSafeQuestion, TypeSafeUnavailableReason };

/**
 * Every decision Jev may help with. One registry entry per kind (see
 * registry.ts) carries its label vocabulary, default threshold, and whether it
 * sits next to a safety gate (escalate-only).
 */
export type DecisionKind =
  | 'engine-error'
  | 'task-class'
  | 'judge-verdict'
  | 'taste-verdict'
  | 'red-team-verdict'
  | 'completion-claim'
  | 'retro-root-cause'
  | 'needs-you-priority'
  | 'interrupt-worthiness'
  | 'lane-choice'
  | 'resource-choice'
  | 'trigger-triage'
  | 'action-class'
  | 'operator-intent';

/** Which path produced the value. `jev` = the model cleared the gate. */
export type DecisionPath = 'jev' | 'fallback';

/**
 * Why the deterministic fallback was used. Recorded on every fallback so the
 * fallback rate is explainable, not just countable.
 */
export type DecisionFallbackReason =
  | TypeSafeUnavailableReason
  /** Jev answered, but below the kind's confidence threshold. */
  | 'below-threshold'
  /** Jev answered, but not the question we needed (or an out-of-vocabulary label). */
  | 'no-answer'
  /** Global kill switch (env ASHLR_JEV_DISABLE or jev config `enabled: false`). */
  | 'killed'
  /** This kind is switched off in jev config. */
  | 'kind-disabled'
  /** The daily call budget is spent. */
  | 'budget-exhausted'
  /** Empty/blank input — never worth a paid call. */
  | 'no-input'
  /** Escalate-only kind: Jev's answer would have de-escalated, so it was refused. */
  | 'escalate-only';

/** The outcome of one decision. Never thrown — always returned. */
export interface Decision<T> {
  readonly kind: DecisionKind;
  /** The value to act on. Deterministic whenever `path === 'fallback'`. */
  readonly value: T;
  readonly path: DecisionPath;
  /** Confidence in `value`. 1 for a deterministic answer (it is the rule that was applied). */
  readonly confidence: number;
  /** The threshold that was applied. */
  readonly threshold: number;
  /** Present when `path === 'fallback'`. */
  readonly reason?: DecisionFallbackReason;
  /** Jev's primary label, whenever it answered — including when it lost the gate. */
  readonly jevLabel?: string;
  /** Jev's calibrated confidence, whenever it answered. */
  readonly jevConfidence?: number;
  /**
   * Every typed answer Jev returned (secondary Nouls, scores). Present whenever
   * Jev answered, even below threshold, so a caller can record near-misses.
   * Callers must NOT act on a secondary answer when `path === 'fallback'`.
   */
  readonly answers?: Readonly<Record<string, TypeSafeAnswer>>;
  /** Served from the input-hash cache (no paid call was made). */
  readonly cached: boolean;
  /** Concrete model id that answered, e.g. "jev-1.13.0". */
  readonly model?: string;
  /** Wall-clock spent in the decision (0 for a pure fallback with no I/O). */
  readonly durationMs: number;
}

/** What a custom interpreter returns: the value plus the confidence to gate on. */
export interface Interpretation<T> {
  readonly value: T;
  readonly confidence: number;
  /** The label to record as `jevLabel`. Defaults to String(value). */
  readonly label?: string;
}

export interface DecideOptions<T> {
  /**
   * The deterministic answer. Always required — Jev is never a hard
   * dependency. A thunk is evaluated lazily and at most once.
   */
  readonly fallback: T | (() => T);
  /** Override the kind's registry threshold. */
  readonly threshold?: number;
  /**
   * Map Jev's answers to a value + confidence. Default: read the registry's
   * `primary` choice question and require its label to be in the kind's
   * vocabulary (then `value = label as T`).
   */
  readonly interpret?: (answers: Readonly<Record<string, TypeSafeAnswer>>) => Interpretation<T> | undefined;
  /**
   * Escalate-only gate (for kinds adjacent to a safety gate). Higher rank =
   * stricter. Jev may only return a value whose rank is >= the fallback's.
   */
  readonly escalateOnly?: (value: T) => number;
  /** Config for key resolution (phantom). Loaded read-only when omitted. */
  readonly cfg?: AshlrConfig;
  readonly model?: TypeSafeModel;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test/self-host override, forwarded to the client. */
  readonly endpoint?: string;
  /** Default true. Set false for inputs that never repeat. */
  readonly cache?: boolean;
  /** Extra non-secret context mixed into the cache key (e.g. a playbook list). */
  readonly cacheSalt?: string;
}

/** One registry entry. */
export interface DecisionKindSpec {
  readonly kind: DecisionKind;
  readonly description: string;
  /** The primary choice question's name in the question map. */
  readonly primary: string;
  /**
   * The closed label vocabulary for the primary question. Empty for kinds
   * whose vocabulary is supplied per call (e.g. trigger-triage playbooks).
   */
  readonly labels: readonly string[];
  /** Default confidence gate. */
  readonly threshold: number;
  /** Default classifier deadline for this kind. */
  readonly timeoutMs: number;
  /**
   * Sits next to a safety gate. Jev output is advisory-only or escalate-only
   * here and never replaces the deterministic authority.
   */
  readonly safetyAdjacent: boolean;
  /** Where it is wired, for docs/status output. */
  readonly callSites: readonly string[];
}

/** One line of the decision ledger. Never contains the classified text. */
export interface DecisionRecord {
  readonly ts: string;
  readonly kind: DecisionKind;
  readonly path: DecisionPath;
  readonly reason?: DecisionFallbackReason;
  readonly confidence: number;
  readonly jevLabel?: string;
  readonly jevConfidence?: number;
  /** The final value, only when it is a short label (never free text). */
  readonly label?: string;
  readonly cached: boolean;
  /** True when a paid request actually went out. */
  readonly called: boolean;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estCostUsd?: number;
  readonly costSource?: 'published-model' | 'operator-rates';
  readonly durationMs: number;
}

export interface JevKindStats {
  readonly kind: DecisionKind;
  readonly decisions: number;
  readonly jev: number;
  readonly fallback: number;
  readonly cached: number;
  readonly calls: number;
  /** Mean Jev confidence over decisions where Jev answered. */
  readonly avgConfidence: number | null;
  readonly fallbackRate: number;
  readonly estCostUsd: number | null;
  readonly avgLatencyMs: number | null;
  readonly topFallbackReasons: ReadonlyArray<{ reason: string; count: number }>;
}

export interface JevStatus {
  readonly enabled: boolean;
  readonly keyed: boolean;
  /** Human-readable why-not when disabled. */
  readonly disabledBy?: string;
  readonly day: string;
  readonly decisionsToday: number;
  readonly callsToday: number;
  readonly dailyCallBudget: number | null;
  readonly inputTokensToday: number | null;
  readonly outputTokensToday: number | null;
  readonly estCostUsdToday: number | null;
  /** Missing/malformed counts are unknown; an actually reported zero remains zero. */
  readonly usageCoverage?: { readonly reportedCalls: number; readonly unknownCalls: number };
  /** Includes historical recorded estimates, never repriced using today's tariff. */
  readonly costCoverage?: { readonly pricedCalls: number; readonly unknownCalls: number; readonly source: 'recorded-estimates' };
  readonly lastSuccessfulCallAt?: string | null;
  readonly fallbackRateToday: number;
  readonly avgConfidenceToday: number | null;
  readonly avgLatencyMsToday: number | null;
  readonly byKind: readonly JevKindStats[];
  readonly disabledKinds: readonly DecisionKind[];
}

/**
 * Reasoning as data — V3.10 contract (unit A0, frozen once written).
 *
 * Model reasoning (Verse thinking, fleet agent-log thinking blocks, codex
 * rollout reasoning items, grok reasoning) is stored LOCALLY and mined by
 * deterministic extractors for insights the Leader agent reads.
 *
 * Operator opt-in (2026-09-24) and its limits, enforced by the store:
 *  - text is scrubbed (util/scrub.ts) before it is written, and capped at
 *    REASONING_TEXT_MAX_BYTES;
 *  - files are private (0700 dir / 0600 files) under ~/.ashlr/reasoning/;
 *  - text is kept REASONING_TEXT_RETENTION_DAYS, derived features
 *    REASONING_FEATURE_RETENTION_DAYS;
 *  - stored reasoning is NEVER replayed into a prompt — only derived features.
 *
 * Honesty rule: null = unknown.
 *
 * BROWSER-SAFE: the insights UI imports this — plain types and consts only.
 */

export type ReasoningSource = 'verse' | 'fleet' | 'codex-rollout' | 'grok';
export type ReasoningStepKind = 'thinking' | 'summary' | 'progress';
export type ReasoningOutcome = 'ok' | 'error' | 'cancelled';

export const REASONING_TEXT_MAX_BYTES = 8 * 1024;
export const REASONING_TEXT_RETENTION_DAYS = 30;
export const REASONING_FEATURE_RETENTION_DAYS = 180;

/** One stored reasoning step (one JSONL line). */
export interface ReasoningStepV1 {
  v: 1;
  /** Stable unique id for the step (evidence refs point at it). */
  id: string;
  source: ReasoningSource;
  /**
   * The conversation it came from: a Verse session id, a codex rollout /
   * grok session id. Null for fleet steps, which carry `runId` instead.
   * At least one of `sessionId` / `runId` is non-null.
   */
  sessionId: string | null;
  /** Fleet run id; null for conversational sources. */
  runId: string | null;
  /** Canonical repo path or slug; null when unknown. */
  repo: string | null;
  /** Engine / backend name (e.g. `claude`, `codex`, `grok`, `local`). */
  engine: string;
  /** Model id; null when unknown. */
  model: string | null;
  /** ISO time the step was produced. */
  at: string;
  turnId: string | null;
  kind: ReasoningStepKind;
  /** Scrubbed reasoning text, ≤ REASONING_TEXT_MAX_BYTES (UTF-8). Emptied ('') by retention after the text window. */
  text: string;
  /** Reasoning tokens for this step; null when unknown. */
  tokens: number | null;
  /** Name of the tool the agent ran right after this step; null when none / unknown. */
  toolAfter: string | null;
  /** How the enclosing turn/run ended; null while unknown. */
  outcome: ReasoningOutcome | null;
}

export type ReasoningInsightKind = 'struggle' | 'loop' | 'uncertainty' | 'verification-gap' | 'backtrack' | 'win';
export type ReasoningSeverity = 'info' | 'warn' | 'high';

export interface ReasoningEvidence {
  /** A ReasoningStepV1.id (or `session:<id>#<seq>` for event-derived evidence). */
  ref: string;
  at: string;
}

export interface ReasoningInsight {
  id: string;
  kind: ReasoningInsightKind;
  repo: string | null;
  engine: string | null;
  severity: ReasoningSeverity;
  /** Short plain-language headline. Derived — never raw reasoning text. */
  title: string;
  evidence: ReasoningEvidence[];
  /** Occurrences folded into this insight. */
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface ReasoningTrendDay {
  /** YYYY-MM-DD (local day). */
  day: string;
  steps: number;
  struggles: number;
  wins: number;
}

/** GET /api/reasoning/digest */
export interface ReasoningDigest {
  generatedAt: string;
  window: { from: string; to: string };
  totals: {
    steps: number;
    sessions: number;
    /** Step count keyed by engine name. */
    byEngine: Record<string, number>;
  };
  insights: ReasoningInsight[];
  trends: ReasoningTrendDay[];
}

/** GET /api/reasoning/steps?q=&sessionId=&limit= */
export interface ReasoningStepsQuery {
  /** Case-insensitive substring over step text. */
  q?: string;
  sessionId?: string;
  /** Default REASONING_STEPS_DEFAULT_LIMIT, clamped to REASONING_STEPS_MAX_LIMIT. */
  limit?: number;
}

export interface ReasoningStepsResponse {
  /** Newest first. */
  steps: ReasoningStepV1[];
  /** true when more steps matched than `limit` returned. */
  truncated: boolean;
}

export const REASONING_STEPS_DEFAULT_LIMIT = 100;
export const REASONING_STEPS_MAX_LIMIT = 500;

export const REASONING_API_PREFIX = '/api/reasoning';
export const REASONING_DIGEST_PATH = '/api/reasoning/digest';
export const REASONING_STEPS_PATH = '/api/reasoning/steps';

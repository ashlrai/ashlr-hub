/**
 * Does the agent's closing message match what the agent actually did?
 *
 * WHY THIS EXISTS — three measured failures on one afternoon, all on the local
 * seat, none of which raised an error anywhere:
 *
 *   1. "Fixed `mul` in n.js:11 — `a + b` → `a * b`."   file unchanged, one line long
 *   2. "DONE"                                          no Edit call was ever made
 *   3. a turn that stopped at `stop_reason=cancelled`   read as the model declining
 *
 * Every one of them exited zero. A run that reports success while changing
 * nothing is the worst shape of failure for an unattended fleet, because the
 * work is marked done and nobody looks again.
 *
 * THE SPLIT THAT MATTERS. The classifier is asked exactly one thing: what does
 * this text CLAIM. Whether the working tree actually changed is a fact the
 * caller already holds, so it is never sent to a model and never inferred —
 * `turnIntegrity` combines the two with plain comparisons. Asking a model
 * something the filesystem knows would be slower, cost money, and be wrong more
 * often than `changedFileCount === 0`.
 *
 * Follows the same contract as engine-errors.ts: the deterministic answer is
 * computed first and unconditionally, the classifier can only replace it with
 * something strictly better, and this NEVER THROWS and never blocks on the
 * network when unkeyed or disabled.
 */

import {
  askTypeSafe,
  choiceAnswer,
  type TypeSafeChoiceQuestion,
  type TypeSafeUnavailableReason,
} from './typesafe-client.js';
import type { AshlrConfig } from '../types.js';

/** What the closing message asserts about work performed. */
export type CompletionClaim =
  /** Says it changed something: "fixed", "updated", "applied the edit". */
  | 'claims-change'
  /** Says it could not, or stopped short: "I was unable to", "blocked by". */
  | 'reports-blocked'
  /** Answers a question or describes findings without asserting an edit. */
  | 'answers-only'
  /** Genuinely ambiguous, or empty. Never treated as evidence either way. */
  | 'unknown';

/** Agreement between the claim and the observed working tree. */
export type TurnIntegrity =
  /** Claim and evidence agree, or there is nothing to disagree about. */
  | 'consistent'
  /** Claimed an edit; the tree did not move. THE ONE THIS MODULE EXISTS FOR. */
  | 'unsupported-claim'
  /** Said it was blocked, yet files changed — review before trusting either. */
  | 'silent-change'
  /** Not enough signal to judge; must not be reported as either of the above. */
  | 'unknown';

export interface CompletionClaimAssessment {
  readonly claim: CompletionClaim;
  /** 0..1. Always 1 for the deterministic answer, which is certain of itself. */
  readonly confidence: number;
  readonly source: 'classifier' | 'fallback';
  readonly classifierMs: number;
  readonly unavailableReason?: TypeSafeUnavailableReason;
}

/**
 * Below this, the classifier's answer is discarded and the heuristic stands.
 * Matched to the engine-error gate deliberately: one project-wide notion of
 * "confident enough to act on" is easier to reason about than two.
 */
export const COMPLETION_CLAIM_CONFIDENCE_THRESHOLD = 0.75;

/** Cap on text sent out. A closing message is short; a transcript is not. */
const MAX_CLAIM_CHARS = 4_000;

const CLAIM_LABELS = [
  'claims-change',
  'reports-blocked',
  'answers-only',
  'unknown',
] as const satisfies readonly CompletionClaim[];

/**
 * Past-tense assertions that work landed. Deliberately narrow: a bare "DONE"
 * is NOT here, because on its own it is as consistent with "I answered your
 * question" as with "I edited the file". The classifier is what resolves that,
 * and over-reaching in the heuristic would produce exactly the false
 * `unsupported-claim` reports that would make this feature ignorable.
 */
const CHANGE_PATTERNS: readonly RegExp[] = [
  /\b(?:i\s+)?(?:have\s+)?(?:fixed|updated|changed|edited|replaced|corrected|patched|added|removed|renamed|refactored)\b/i,
  /\b(?:applied|made)\s+(?:the\s+)?(?:edit|change|fix)/i,
];

const BLOCKED_PATTERNS: readonly RegExp[] = [
  /\b(?:could\s?n[o']t|cannot|can\s?not|was\s+unable|were\s+unable|unable\s+to)\b/i,
  /\b(?:i\s+)?(?:stopped|gave\s+up|did\s+not\s+(?:make|apply)|have\s+not\s+(?:made|applied))\b/i,
  /\b(?:blocked|denied|refused|cancelled|canceled)\b/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Deterministic reading of the closing message. Answers `unknown` freely —
 * an honest shrug keeps the integrity check quiet rather than making it noisy.
 */
export function classifyCompletionClaimHeuristic(value: unknown): CompletionClaim {
  if (typeof value !== 'string') return 'unknown';
  const text = value.trim();
  if (text.length === 0) return 'unknown';

  const blocked = matchesAny(text, BLOCKED_PATTERNS);
  const changed = matchesAny(text, CHANGE_PATTERNS);

  // Both present is the common "I fixed A but could not do B" shape. That is a
  // change claim: something is asserted to have landed and is checkable.
  if (changed) return 'claims-change';
  if (blocked) return 'reports-blocked';
  return 'unknown';
}

/**
 * Keyed by question NAME, not an array. `askTypeSafe` reads the record's keys
 * to name each answer, so an array would send a question called "0" and every
 * lookup for `claim` would miss — which reads exactly like the classifier being
 * unavailable, and silently degrades to the heuristic forever.
 */
function buildQuestions(): { claim: TypeSafeChoiceQuestion } {
  return {
    claim: {
      type: 'choice',
      instructions:
        'An autonomous coding agent has just finished a turn. Read ONLY its closing message '
        + 'and decide what that message asserts about work it performed. Judge the claim itself; '
        + 'you are not being shown the repository and must not guess whether the work succeeded.',
      criteria: {
        'claims-change':
          'Asserts it modified, created or deleted something in the project — an edit, a fix, a '
          + 'file written. Includes a bare completion token such as "DONE" when the surrounding '
          + 'message is about carrying out an edit.',
        'reports-blocked':
          'States it did not or could not complete the work: refused, ran out of permission, hit '
          + 'an error, or stopped to ask. Asserts that nothing landed.',
        'answers-only':
          'Answers a question, explains code, or reports findings, without asserting that it '
          + 'changed anything.',
        unknown: 'Too short, too ambiguous, or empty to place in any of the above.',
      },
    },
  };
}

export interface ClassifyCompletionClaimOptions {
  readonly confidenceThreshold?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test/self-host override, forwarded to the client. */
  readonly endpoint?: string;
}

/**
 * Classify what a closing message claims, falling back to the deterministic
 * reading whenever the classifier is unavailable, fails, or is not confident.
 *
 * NEVER THROWS. Safe to call on a completion path in an offline hub.
 */
export async function classifyCompletionClaim(
  value: unknown,
  cfg: AshlrConfig,
  opts: ClassifyCompletionClaimOptions = {},
): Promise<CompletionClaimAssessment> {
  const heuristic = classifyCompletionClaimHeuristic(value);
  const deterministic: CompletionClaimAssessment = {
    claim: heuristic,
    confidence: 1,
    source: 'fallback',
    classifierMs: 0,
  };

  // Nothing to read is `unknown` by definition — never worth a paid call.
  if (typeof value !== 'string' || value.trim().length === 0) return deterministic;

  const threshold = opts.confidenceThreshold ?? COMPLETION_CLAIM_CONFIDENCE_THRESHOLD;

  const result = await askTypeSafe(
    {
      state: value.slice(0, MAX_CLAIM_CHARS),
      questions: buildQuestions(),
      model: 'jev-latest',
    },
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

  const answer = choiceAnswer(result, 'claim', CLAIM_LABELS);
  if (!answer || answer.confidence < threshold) {
    return { ...deterministic, classifierMs: result.durationMs };
  }

  return {
    claim: answer.choice,
    confidence: answer.confidence,
    source: 'classifier',
    classifierMs: result.durationMs,
  };
}

/**
 * Compare a claim against what the working tree actually did.
 *
 * `changedFileCount` is a FACT the caller already has. It is never guessed and
 * never sent to the classifier. Pass `null` when the caller genuinely did not
 * observe the tree — that yields `unknown` rather than a fabricated verdict,
 * because "we did not look" and "nothing changed" are different states and
 * conflating them would raise false alarms on read-only turns.
 */
export function turnIntegrity(
  claim: CompletionClaim,
  changedFileCount: number | null,
): TurnIntegrity {
  if (changedFileCount === null || !Number.isFinite(changedFileCount)) return 'unknown';
  const changed = changedFileCount > 0;

  if (claim === 'claims-change') return changed ? 'consistent' : 'unsupported-claim';
  if (claim === 'reports-blocked') return changed ? 'silent-change' : 'consistent';
  if (claim === 'answers-only') return 'consistent';
  return 'unknown';
}

/** One line for a log or a transcript. Empty when there is nothing worth saying. */
export function describeTurnIntegrity(integrity: TurnIntegrity): string {
  switch (integrity) {
    case 'unsupported-claim':
      return 'the agent reported a change, but no file was modified';
    case 'silent-change':
      return 'the agent reported it was blocked, but files were modified';
    default:
      return '';
  }
}

/**
 * How many files a unified diff actually touches.
 *
 * The missing half of the integrity check. `turnIntegrity` needs a count, and
 * the fleet already carries a proposal's `diff` — this turns one into the other
 * so wiring the check is a single call rather than a parsing exercise repeated
 * at each site.
 *
 * Returns `null` when there is no diff to read, which is deliberately NOT zero:
 * "we did not look" and "nothing changed" are different states, and
 * `turnIntegrity` only reports a verdict for the second.
 *
 * Counts distinct `+++ b/<path>` targets, ignoring `/dev/null` (the target of a
 * pure deletion hunk's counterpart) and de-duplicating, because one file can
 * appear in several hunks.
 */
export function changedFileCountFromDiff(diff: unknown): number | null {
  if (typeof diff !== 'string') return null;
  if (diff.trim().length === 0) return 0;

  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    const path = line.slice(4).replace(/^[ab]\//, '').trim();
    if (path && path !== '/dev/null') files.add(path);
  }
  return files.size;
}

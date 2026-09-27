/**
 * Prompt classification for the Auto seat — kind, size, difficulty — from the
 * text alone. PURE, deterministic, no model call: it runs in the browser on
 * every pause in typing, so it has to be instant and it must never send the
 * draft anywhere.
 *
 * It is deliberately a small set of legible rules rather than a scorer: the
 * Auto line shows the verdict ("quick question", "hard refactor") and the
 * operator must be able to see why and disagree. When the rules are unsure
 * they say `medium`, which leaves the router's own quality order in charge.
 *
 * BROWSER-SAFE.
 */
import type { RoutingDifficulty, RoutingTask } from '../../routing/types.js';
import type { PromptClassification, PromptKind, PromptSize } from './types.js';

/** chars / 4, rounded up — the same estimator the handoff and fit badges use. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const RE = {
  review: /\b(review|critique|audit|look over|second opinion|sanity[- ]check|double[- ]check|code review|pr review|poke holes)\b/i,
  debug: /\b(error|exception|stack ?trace|traceback|failing|fails|failed|bug|crash(?:es|ed)?|broken|doesn'?t work|not working|segfault|panic|regression|flaky|TypeError|ReferenceError|undefined is not|cannot read propert)/i,
  refactor: /\b(refactor|restructure|clean ?up|extract (?:a |the )?\w+|migrate|port (?:it|this|the)|rename (?:all|every)|split (?:up|into)|consolidate|decouple)\b/i,
  plan: /\b(plan|design|architect(?:ure)?|approach|strategy|roadmap|trade-?offs?|should (?:we|i)|how should|pros and cons|options for|spec(?:ification)?)\b/i,
  /** Asking for a change: an imperative verb. */
  code: /\b(implement|write|add|create|build|fix|make|update|change|wire|hook up|remove|delete|replace|convert|generate)\b/i,
  /** Code nouns: a change when paired with a verb, but "what does this function do?" is still a question. */
  codeNoun: /\b(function|class|component|endpoint|tests?|script|handler|route|migration|schema)\b/i,
  bulk: /\b(all files|every file|across the (?:repo|codebase|project)|bulk|batch|each of (?:the|these)|every (?:module|package|test)|codemod|mass[- ]rename)\b/i,
  question: /^\s*(what|why|how|when|where|who|which|is|are|does|do|can|could|should|would|will|explain|tell me)\b/i,
  explain: /\b(explain|what does|what is|how does|walk me through|summari[sz]e|describe|meaning of|difference between)\b/i,
  hard: /\b(architect(?:ure)?|concurren(?:t|cy)|race condition|deadlock|security|vulnerab|auth(?:entication|orization)?|migration|performance|optimi[sz]e|distributed|memory leak|end[- ]to[- ]end|from scratch|entire|whole (?:codebase|repo|system)|complex|tricky|subtle|production)\b/i,
  easy: /\b(typo|quick|simple|small|tiny|trivial|one[- ]liner|rename|bump|format|lint|comment|docstring)\b/i,
  stackTrace: /(^\s+at .+\(.+:\d+:\d+\)$)|(Traceback \(most recent call last\))|(^\s*File ".+", line \d+)/m,
};

const LABEL: Record<PromptKind, Record<RoutingDifficulty, string>> = {
  question: { low: 'quick question', medium: 'question', high: 'hard question' },
  explain: { low: 'quick explanation', medium: 'explanation', high: 'deep explanation' },
  code: { low: 'small code change', medium: 'code change', high: 'hard code change' },
  debug: { low: 'quick fix', medium: 'debugging', high: 'hard debugging' },
  refactor: { low: 'small refactor', medium: 'refactor', high: 'hard refactor' },
  review: { low: 'quick review', medium: 'review', high: 'deep review' },
  plan: { low: 'quick plan', medium: 'planning', high: 'architecture planning' },
  bulk: { low: 'bulk edit', medium: 'bulk edit', high: 'large bulk edit' },
};

/** The Auto line's noun phrase for a kind at a difficulty ("hard refactor"). */
export function promptLabel(kind: PromptKind, difficulty: RoutingDifficulty): string {
  return LABEL[kind][difficulty];
}

export function taskOf(kind: PromptKind): RoutingTask {
  if (kind === 'review') return 'review';
  if (kind === 'plan') return 'plan';
  if (kind === 'bulk') return 'bulk';
  return 'code';
}

function kindOf(text: string, hasCode: boolean, signals: string[]): PromptKind {
  // Order matters: the most specific intent wins. "Review this fix" is a
  // review, "plan the refactor" is a plan, a pasted trace is debugging.
  if (RE.bulk.test(text)) { signals.push('touches many files'); return 'bulk'; }
  if (RE.review.test(text)) { signals.push('asks for a review'); return 'review'; }
  if (RE.stackTrace.test(text)) { signals.push('stack trace'); return 'debug'; }
  if (RE.debug.test(text)) { signals.push('names a failure'); return 'debug'; }
  if (RE.refactor.test(text)) { signals.push('restructures code'); return 'refactor'; }
  if (RE.plan.test(text)) { signals.push('asks for a plan or design'); return 'plan'; }
  const verb = RE.code.test(text);
  if (RE.explain.test(text) && !verb) { signals.push('asks for an explanation'); return 'explain'; }
  if ((RE.question.test(text) || text.trim().endsWith('?')) && !verb && !hasCode) { signals.push('a question'); return 'question'; }
  if (verb || hasCode || RE.codeNoun.test(text)) { signals.push(hasCode ? 'includes code' : 'asks for a change'); return 'code'; }
  return 'code';
}

function sizeOf(tokens: number, fileRefs: number): PromptSize {
  if (tokens > 2_000 || fileRefs >= 4) return 'large';
  if (tokens < 120 && fileRefs <= 1) return 'small';
  return 'medium';
}

/**
 * Classify one message. `contextTokens` is what the chat already holds — a
 * small question deep into a 400k-token session is not a small turn.
 */
export function classifyPrompt(text: string, opts: { contextTokens?: number | null } = {}): PromptClassification {
  const trimmed = text.trim();
  const signals: string[] = [];
  const estTokens = estimateTokens(trimmed);
  const hasCode = /```/.test(trimmed) || /^( {4}|\t)\S/m.test(trimmed);
  const fileRefs = (trimmed.match(/(^|\s)@[\w./-]+/g) ?? []).length
    + (trimmed.match(/\b[\w-]+\/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|swift|kt|css|md|json|ya?ml)\b/g) ?? []).length;
  if (fileRefs > 0) signals.push(fileRefs === 1 ? '1 file named' : `${fileRefs} files named`);

  const kind = kindOf(trimmed, hasCode, signals);
  const size = sizeOf(estTokens, fileRefs);
  if (size === 'large') signals.push(`≈${estTokens.toLocaleString('en-US')} tokens`);

  let difficulty: RoutingDifficulty = 'medium';
  const hard = RE.hard.test(trimmed);
  const easy = RE.easy.test(trimmed);
  if (hard) signals.push('hard subject');
  if (hard || size === 'large' || (kind === 'plan' && size !== 'small') || (kind === 'refactor' && fileRefs >= 2)) {
    difficulty = 'high';
  } else if (easy || (size === 'small' && (kind === 'question' || kind === 'explain'))) {
    difficulty = 'low';
    if (easy) signals.push('small by its own words');
  }
  // A long chat makes every turn heavier: the whole prefix is re-sent.
  const context = opts.contextTokens ?? 0;
  if (difficulty === 'low' && context > 150_000) {
    difficulty = 'medium';
    signals.push('deep into a long chat');
  }

  return { kind, task: taskOf(kind), difficulty, size, estTokens, label: LABEL[kind][difficulty], signals };
}

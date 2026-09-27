/**
 * decide/task-class.ts — ONE task-class label set for the whole hub.
 *
 * Three keyword tables did the same job with three vocabularies:
 *   fleet/skill-library.ts deriveTaskClass   bug-fix | feature-add | ... | general
 *   learn/reflect.ts       classifyGoal      bugfix | feature | ... | other
 *   learn/retro/inject.ts  classifyTaskKind  fix | feature | ... | other
 * and deriveTaskClass is the partition key for learned routing priors, so a
 * mislabel silently corrupts engine selection statistics.
 *
 * Now: Jev answers in the unified TASK_CLASSES vocabulary and each consumer
 * PROJECTS that onto the vocabulary it persists (so no stored row changes
 * meaning and no migration is needed). Each consumer keeps its own regex table
 * verbatim as the offline fallback.
 *
 * SYNC CONSUMERS. All three classifiers are synchronous and sit in sync call
 * chains, so they cannot await a network call. Instead their async parents
 * PRIME the labels in one batched call (`primeTaskClasses`), and the sync
 * classifier consults `peekTaskClass` — a bounded memo of Jev answers that
 * cleared the gate — before falling back to its regex. Unprimed text (or no
 * key) behaves exactly as before.
 */

import type { TypeSafeChoiceQuestion } from '../classify/typesafe-client.js';
import { decide, decideEach } from './decide.js';
import { TASK_CLASSES } from './registry.js';
import type { DecideOptions, Decision } from './types.js';

export type TaskClass = (typeof TASK_CLASSES)[number];

/** skill-library's persisted vocabulary. */
export type SkillTaskClass =
  | 'bug-fix' | 'feature-add' | 'refactor' | 'test-improvement' | 'dependency-update'
  | 'documentation' | 'performance' | 'security' | 'type-lint' | 'general';

/** reflect's GOAL_CATEGORIES. */
export type GoalCategory = 'feature' | 'bugfix' | 'refactor' | 'test' | 'docs' | 'chore' | 'other';

/** retro's TaskKind (minus 'leader', which is assigned by source, never by text). */
export type RetroTaskKind = 'fix' | 'feature' | 'refactor' | 'tests' | 'docs' | 'deps' | 'ci' | 'revert' | 'other';

// ---------------------------------------------------------------------------
// Projections — the one place the vocabularies are reconciled
// ---------------------------------------------------------------------------

const TO_SKILL: Readonly<Record<TaskClass, SkillTaskClass>> = {
  'bug-fix': 'bug-fix',
  feature: 'feature-add',
  refactor: 'refactor',
  tests: 'test-improvement',
  docs: 'documentation',
  deps: 'dependency-update',
  ci: 'general',
  revert: 'general',
  performance: 'performance',
  security: 'security',
  'type-lint': 'type-lint',
  other: 'general',
};

const TO_GOAL: Readonly<Record<TaskClass, GoalCategory>> = {
  'bug-fix': 'bugfix',
  feature: 'feature',
  refactor: 'refactor',
  tests: 'test',
  docs: 'docs',
  deps: 'chore',
  ci: 'chore',
  revert: 'other',
  performance: 'refactor',
  security: 'bugfix',
  'type-lint': 'chore',
  other: 'other',
};

const TO_RETRO: Readonly<Record<TaskClass, RetroTaskKind>> = {
  'bug-fix': 'fix',
  feature: 'feature',
  refactor: 'refactor',
  tests: 'tests',
  docs: 'docs',
  deps: 'deps',
  ci: 'ci',
  revert: 'revert',
  performance: 'refactor',
  security: 'fix',
  'type-lint': 'ci',
  other: 'other',
};

export const toSkillTaskClass = (c: TaskClass): SkillTaskClass => TO_SKILL[c];
export const toGoalCategory = (c: TaskClass): GoalCategory => TO_GOAL[c];
export const toRetroTaskKind = (c: TaskClass): RetroTaskKind => TO_RETRO[c];

/** Deterministic unified label (for callers with no legacy vocabulary of their own). */
export function taskClassHeuristic(text: unknown): TaskClass {
  if (typeof text !== 'string' || text.trim() === '') return 'other';
  const t = text.toLowerCase();
  if (/\brevert(s|ed|ing)?\b/.test(t)) return 'revert';
  if (/\b(security|vuln\w*|cve|xss|csrf|injection)\b/.test(t)) return 'security';
  if (/\b(fix|fixes|fixed|bug|bugs|crash|regression|hotfix|broken|exception|error)\b/.test(t)) return 'bug-fix';
  if (/\b(bump|deps|dependency|dependencies|upgrade|renovate|dependabot|lockfile)\b/.test(t)) return 'deps';
  if (/\b(ci|workflow|workflows|github actions|pipeline)\b/.test(t)) return 'ci';
  if (/\b(test|tests|testing|coverage|vitest|jest|spec)\b/.test(t)) return 'tests';
  if (/\b(doc|docs|documentation|readme|changelog|jsdoc)\b/.test(t)) return 'docs';
  if (/\b(perf|performance|optimi[sz]e\w*|speed|latency|throughput)\b/.test(t)) return 'performance';
  if (/\b(type|types|typescript|typecheck|lint|eslint)\b/.test(t)) return 'type-lint';
  if (/\b(refactor|cleanup|clean-up|rename|restructure|simplify|dedupe|tidy|extract)\b/.test(t)) return 'refactor';
  if (/\b(add|adds|implement|implements|build|create|support|introduce|feature|new)\b/.test(t)) return 'feature';
  return 'other';
}

const CRITERIA: Readonly<Record<TaskClass, string>> = {
  'bug-fix': 'Corrects wrong behaviour: a bug, crash, regression, incorrect output — even when worded without the word "fix".',
  feature: 'Adds new user-visible capability or behaviour.',
  refactor: 'Restructures existing code without changing behaviour: rename, extract, simplify, dedupe, move.',
  tests: 'Adds or improves tests or coverage; no production behaviour change.',
  docs: 'Documentation, READMEs, comments, changelogs.',
  deps: 'Dependency or toolchain version changes: bumps, upgrades, lockfiles.',
  ci: 'CI pipelines, workflows, build/release automation.',
  revert: 'Reverts a previous change.',
  performance: 'Makes something faster or cheaper without changing what it does.',
  security: 'Fixes or hardens a security weakness: vulnerabilities, injection, secrets, auth.',
  'type-lint': 'Type errors, type annotations, lint or formatting fixes.',
  other: 'None of the above fits.',
};

export const TASK_CLASS_QUESTION: TypeSafeChoiceQuestion = {
  type: 'choice',
  instructions: 'Classify the kind of engineering work this task describes. Judge what the change does, not incidental words.',
  criteria: CRITERIA,
};

// ---------------------------------------------------------------------------
// The sync memo — only Jev answers that CLEARED the gate
// ---------------------------------------------------------------------------

const MEMO_MAX = 2_000;
const memo = new Map<string, TaskClass>();
/** Texts already asked in this process (confident or not) — never re-paid for. */
const attempted = new Set<string>();

function memoKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
}

function remember(text: string, cls: TaskClass): void {
  const k = memoKey(text);
  if (!k) return;
  memo.delete(k);
  memo.set(k, cls);
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/**
 * Sync lookup for a Jev label primed earlier. Undefined = not primed (or Jev
 * was not confident) → the caller uses its own regex, exactly as before.
 */
export function peekTaskClass(text: unknown): TaskClass | undefined {
  if (typeof text !== 'string') return undefined;
  return memo.get(memoKey(text));
}

export function clearTaskClassMemo(): void {
  memo.clear();
  attempted.clear();
}

export type LabelTaskClassOptions = Omit<DecideOptions<TaskClass>, 'fallback' | 'interpret' | 'escalateOnly'>;

/**
 * Label one task. NEVER THROWS. A confident answer is also memoized for the
 * sync classifiers.
 *
 * STABLE API — multi-model orchestration may call this for task typing.
 */
export async function labelTaskClass(
  text: string,
  opts: LabelTaskClassOptions & { readonly fallback?: TaskClass | (() => TaskClass) } = {},
): Promise<Decision<TaskClass>> {
  const safe = typeof text === 'string' ? text.slice(0, 3_000) : '';
  const d = await decide<TaskClass>('task-class', safe, { task_class: TASK_CLASS_QUESTION }, {
    ...opts,
    fallback: opts.fallback ?? (() => taskClassHeuristic(safe)),
  });
  if (d.path === 'jev') remember(safe, d.value);
  return d;
}

/**
 * Prime many texts in ONE call per 10 (dedup'd, already-memoized skipped).
 * Called by the async parents of the sync classifiers. Never throws; returns
 * how many labels cleared the gate.
 */
export async function primeTaskClasses(texts: readonly unknown[], opts: LabelTaskClassOptions = {}): Promise<number> {
  const seen = new Set<string>();
  const todo: string[] = [];
  for (const t of texts) {
    if (typeof t !== 'string' || t.trim() === '') continue;
    const k = memoKey(t);
    if (seen.has(k) || memo.has(k) || attempted.has(k)) continue;
    seen.add(k);
    todo.push(t.slice(0, 1_000));
    if (todo.length >= 50) break; // bound the spend of one priming pass
  }
  if (todo.length === 0) return 0;
  try {
    const decisions = await decideEach<TaskClass>(
      'task-class',
      todo.map((text, i) => ({ id: String(i), text, fallback: () => taskClassHeuristic(text) })),
      TASK_CLASS_QUESTION,
      { ...opts, preamble: 'Each item below is the title or goal of one engineering task.' },
    );
    let accepted = 0;
    decisions.forEach((d, i) => {
      // Only a real answer (or a confident miss) marks a text as asked; a
      // transport failure leaves it eligible for the next pass.
      if (d.path === 'jev' || d.reason === 'below-threshold' || d.reason === 'no-answer') {
        if (attempted.size > MEMO_MAX * 2) attempted.clear();
        attempted.add(memoKey(todo[i]!));
      }
      if (d.path === 'jev') {
        remember(todo[i]!, d.value);
        accepted += 1;
      }
    });
    return accepted;
  } catch {
    return 0;
  }
}

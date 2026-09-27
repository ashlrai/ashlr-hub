/**
 * decide/lane.ts — which lane should run this task?
 *
 *   chooseLane(task, context) → fleet | cloud | devin | interactive
 *
 *   fleet        the local autonomous fleet: small, well-scoped maintenance
 *                (lint, deps, a focused bug fix, tests) on an enrolled repo.
 *   cloud        a Claude cloud session: substantial multi-file work on a
 *                GitHub repo that benefits from a long, capable run.
 *   devin        a Devin session: well-specified, self-contained tickets on a
 *                GitHub repo that a remote agent can own end to end.
 *   interactive  needs Mason in the loop: ambiguous, design/product
 *                judgement, exploratory, or touching protected surfaces.
 *
 * Only lanes the caller marks available are offered to Jev, and an answer
 * naming an unavailable lane is discarded. This is a routing suggestion; each
 * lane's own launch gates (budget, authority, enablement) still apply.
 */

import type { TypeSafeChoiceQuestion } from '../classify/typesafe-client.js';
import { decide } from './decide.js';
import { WORK_LANES } from './registry.js';
import type { DecideOptions, Decision } from './types.js';

export type WorkLane = (typeof WORK_LANES)[number];

export interface LaneTask {
  readonly title: string;
  readonly body?: string | null;
  readonly repo?: string | null;
  /** True when the repo is on GitHub (cloud and Devin need a remote). */
  readonly githubRepo?: boolean;
  /** Rough size, when the caller knows it. */
  readonly estimatedFiles?: number | null;
  readonly labels?: readonly string[];
  /** Touches paths the authority layer protects (always interactive). */
  readonly protectedPaths?: boolean;
}

export interface LaneContext {
  /** Lanes usable right now. Omitted lanes are treated as available. */
  readonly available?: Partial<Record<WorkLane, boolean>>;
  /** Tie-break preference when the heuristic has no strong signal. */
  readonly preferred?: WorkLane;
  /** Mason is at the keyboard (interactive is cheap now). */
  readonly operatorPresent?: boolean;
}

export type ChooseLaneOptions = Omit<DecideOptions<WorkLane>, 'fallback' | 'interpret' | 'escalateOnly'>;

const INTERACTIVE_HINT = /\b(design|decide|should we|explore|brainstorm|figure out|investigate why|proposal|rfc|spec out|product|pricing|ux|question|discuss|plan)\b/i;
const SMALL_HINT = /\b(lint|typo|bump|deps?|dependency|upgrade|format|test|flaky|docs?|readme|changelog|rename|small|minor|one-line|typecheck)\b/i;
const LARGE_HINT = /\b(migrate|migration|rewrite|overhaul|port|end-to-end|across the codebase|new (?:service|feature|app)|implement|build out|multi-?file|refactor .* (?:module|package|system))\b/i;

export function availableLanes(context: LaneContext = {}): WorkLane[] {
  return WORK_LANES.filter((lane) => context.available?.[lane] !== false);
}

/** Pure, offline, never throws. */
export function chooseLaneHeuristic(task: LaneTask, context: LaneContext = {}): WorkLane {
  const open = availableLanes(context);
  const pick = (...order: WorkLane[]): WorkLane =>
    order.find((l) => open.includes(l)) ?? open[0] ?? 'interactive';
  const text = `${task.title ?? ''}\n${task.body ?? ''}\n${(task.labels ?? []).join(' ')}`;
  const remoteOk = task.githubRepo !== false;

  if (task.protectedPaths) return pick('interactive');
  if (INTERACTIVE_HINT.test(text) && !SMALL_HINT.test(task.title ?? '')) return pick('interactive', 'cloud', 'fleet', 'devin');
  const files = task.estimatedFiles ?? null;
  const large = (files !== null && files >= 8) || LARGE_HINT.test(text);
  if (large) {
    return remoteOk ? pick('cloud', 'devin', 'fleet', 'interactive') : pick('fleet', 'interactive');
  }
  if (SMALL_HINT.test(text) || (files !== null && files <= 3)) return pick('fleet', 'devin', 'cloud', 'interactive');
  if (context.preferred && open.includes(context.preferred)) return context.preferred;
  return remoteOk ? pick('fleet', 'devin', 'cloud', 'interactive') : pick('fleet', 'interactive');
}

const LANE_CRITERIA: Readonly<Record<WorkLane, string>> = {
  fleet: 'Small, well-scoped maintenance an unattended local agent can finish safely: a focused bug fix, lint/type errors, dependency bumps, tests, docs.',
  cloud: 'Substantial multi-file engineering on a GitHub repository that benefits from a long, capable autonomous run: features, migrations, cross-cutting refactors.',
  devin: 'A well-specified, self-contained ticket on a GitHub repository that a remote agent can own end to end and deliver as a pull request.',
  interactive: 'Needs the operator in the loop: ambiguous requirements, product or design judgement, exploration, or sensitive/protected areas.',
};

export function laneTaskState(task: LaneTask): string {
  const lines = [`Task: ${task.title}`];
  if (task.body) lines.push(`Details: ${task.body.slice(0, 3_000)}`);
  if (task.repo) lines.push(`Repository: ${task.repo}${task.githubRepo === false ? ' (local only, not on GitHub)' : ''}`);
  if (typeof task.estimatedFiles === 'number') lines.push(`Estimated files touched: ${task.estimatedFiles}`);
  if (task.labels?.length) lines.push(`Labels: ${task.labels.join(', ')}`);
  return lines.join('\n');
}

export function laneQuestion(open: readonly WorkLane[]): TypeSafeChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const lane of open) criteria[lane] = LANE_CRITERIA[lane];
  return {
    type: 'choice',
    instructions: 'Choose the execution lane best suited to this engineering task, among the lanes offered.',
    criteria,
  };
}

/**
 * Pick a lane for one task. NEVER THROWS.
 *
 * STABLE API — the Devin fleet and multi-model orchestration agents call this.
 */
export async function chooseLane(
  task: LaneTask,
  context: LaneContext = {},
  opts: ChooseLaneOptions = {},
): Promise<Decision<WorkLane>> {
  const open = availableLanes(context);
  const fallback = (): WorkLane => chooseLaneHeuristic(task, context);
  // One lane (or none) open: nothing to decide, nothing to pay for.
  const state = open.length > 1 && task.protectedPaths !== true ? laneTaskState(task) : '';
  return decide<WorkLane>('lane-choice', state, { lane: laneQuestion(open) }, {
    ...opts,
    fallback,
    cacheSalt: open.join(','),
    interpret: (answers) => {
      const a = answers['lane'];
      if (!a || a.type !== 'choice' || !open.includes(a.choice as WorkLane)) return undefined;
      return { value: a.choice as WorkLane, confidence: a.confidence, label: a.choice };
    },
  });
}

// ---------------------------------------------------------------------------
// Adapter: the Devin fleet launcher's lane-advisor hook
// ---------------------------------------------------------------------------

/** Structurally the launcher's DevinLaneQuestion (kept local: decide never imports devin). */
export interface DevinLaneQuestionLike {
  readonly itemId: string;
  readonly title: string;
  readonly area: string;
  readonly repo: string;
  readonly priority: number;
  readonly promptChars: number;
}

/** Structurally the launcher's DevinLaneAdvice. */
export interface DevinLaneAdviceLike {
  readonly lane: 'fleet' | 'cloud' | 'devin';
  readonly confidence: number;
  readonly reason?: string;
}

/**
 * Lane advice for one Devin-fleet backlog candidate, in the launcher's own
 * shape (src/core/devin/fleet-launcher.ts `laneAdvisor`). Returns null — "the
 * heuristic stands" — whenever the decision fell back (unkeyed, off, slow,
 * unsure): the launcher must only ever hear a lane Jev chose above its gate.
 * The launcher itself can only NARROW on this advice (a confident non-Devin
 * answer skips the item for the tick); it never launches anything the
 * heuristic refused.
 */
export async function adviseDevinLane(
  question: DevinLaneQuestionLike,
  opts: ChooseLaneOptions = {},
): Promise<DevinLaneAdviceLike | null> {
  const decision = await chooseLane(
    {
      title: question.title,
      body: `Backlog area: ${question.area}. Priority ${question.priority} (1 = highest). Brief length: ${question.promptChars} characters.`,
      repo: question.repo,
      githubRepo: true,
    },
    { available: { fleet: true, cloud: true, devin: true, interactive: false }, preferred: 'devin' },
    opts,
  );
  if (decision.path !== 'jev' || decision.value === 'interactive') return null;
  return {
    lane: decision.value,
    confidence: decision.confidence,
    reason: `jev lane-choice ${decision.value} @ ${decision.confidence.toFixed(2)}`,
  };
}

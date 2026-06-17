/**
 * prompts/roles.ts — per-role prompt text.
 *
 * The executor role ships verbosity variants (it is the ReAct chokepoint and
 * benefits most from adaptation). The planner and synthesizer roles are strict,
 * format-bearing contracts whose exact wording must not drift — they are the
 * SINGLE SOURCE of those prompts, imported by orchestrator.ts for BOTH the
 * legacy (flag-off) and adaptive (flag-on) paths so behavior stays identical
 * when the suite is disabled.
 */

import type { LayerVariants } from './layers.js';

/** Executor: per-task guidance layered on top of base/tool/output. */
export const EXECUTOR_ROLE: LayerVariants = {
  terse: 'Focus only on the assigned task. Finish it, then report the result.',
  standard:
    'You are executing ONE task within a larger plan. Stay focused on this task only — ' +
    'do not wander into adjacent work. Finish it and report the concrete result.',
  rich:
    'You are executing ONE task within a larger plan. Stay strictly within its scope — ' +
    'do not expand it or drift into adjacent work. Drive the task to completion, verify ' +
    'the outcome where you can, and report the concrete result so the next task can build on it.',
};

/**
 * Planner role — decompose a goal into a task DAG.
 * VERBATIM source of the run planner prompt (was orchestrator PLANNING_SYSTEM).
 */
export const PLANNER_ROLE = `You are a task planner. Decompose the user's goal into 1-6 subtasks that together accomplish it.
Respond ONLY with a JSON array. Each element must have:
  "id": string (unique short slug, e.g. "t1", "t2"),
  "goal": string (clear sub-goal for this task),
  "deps": string[] (ids of tasks that must complete before this one; empty for root tasks)

Rules:
- deps must reference earlier ids only (no cycles).
- Keep tasks focused and independently executable.
- Use a minimal number of tasks (don't over-decompose).

Example:
[
  {"id":"t1","goal":"Research the topic","deps":[]},
  {"id":"t2","goal":"Summarize findings","deps":["t1"]}
]

Return ONLY the JSON array — no prose, no markdown fences.`;

/**
 * Synthesizer role — combine task results into one answer.
 * VERBATIM source of the run synthesis prompt (was orchestrator SYNTHESIS_SYSTEM).
 */
export const SYNTHESIZER_ROLE = `You are a helpful assistant. The user asked a goal and several subtasks were executed to answer it.
Combine the results into a single, coherent final answer. Be concise and accurate.`;

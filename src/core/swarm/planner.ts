/**
 * core/swarm/planner.ts — M12 swarm planner.
 *
 * planSwarm({goal, specBody?}, cfg, signal?): Promise<SwarmPlan>
 *
 * Decomposes a goal (+ optional spec body) into a phased SwarmPlan via a
 * single bounded model call (LOCAL-first). Guardrails:
 *  - Single model call; never throws — all failures fall back to a sensible
 *    default plan.
 *  - Tasks per phase capped at <= 6; total tasks capped at <= 18.
 *  - BUILD-phase tasks are independent (no intra-build deps); later phases
 *    carry deps on the tasks from the prior phase.
 *  - IDs are stable slugs: scaffold-1, build-1..N, integrate-1, verify-1, review-1.
 */

import type { SwarmPlan, SwarmTaskSpec, SwarmPhaseName, AshlrConfig } from '../types.js';
import { getActiveClient } from '../run/provider-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TASKS_PER_PHASE = 6;
const MAX_TOTAL_TASKS = 18;

// ---------------------------------------------------------------------------
// Planning prompt
// ---------------------------------------------------------------------------

const PLANNING_SYSTEM = `You are an expert software engineering planner. Given a goal (and optionally a detailed end-state spec), decompose the work into a phased plan suitable for a fleet of autonomous coding agents.

Output a JSON object with the following shape (STRICT — no markdown fences, no extra keys):
{
  "scaffold": [
    { "id": "scaffold-1", "goal": "<concrete task goal>" }
  ],
  "build": [
    { "id": "build-1", "goal": "<concrete task goal>" },
    { "id": "build-2", "goal": "<concrete task goal>" }
  ],
  "integrate": [
    { "id": "integrate-1", "goal": "<concrete task goal>" }
  ],
  "verify": [
    { "id": "verify-1", "goal": "<concrete task goal>" }
  ],
  "review": [
    { "id": "review-1", "goal": "<concrete task goal>" }
  ]
}

Phase meanings:
- scaffold: Set up project structure, config files, boilerplate (1-2 tasks).
- build: Core implementation tasks — these run IN PARALLEL and must be independent of each other (2-6 tasks).
- integrate: Wire together the built components (1-2 tasks).
- verify: Run tests, type-checks, linting, confirm correctness (1-2 tasks).
- review: Final review, documentation, cleanup (1-2 tasks).

Rules:
- scaffold: 1-2 tasks max.
- build: 2-6 tasks max (parallelizable, no mutual deps).
- integrate: 1-2 tasks max.
- verify: 1-2 tasks max.
- review: 1-2 tasks max.
- Total tasks across all phases: <= 18.
- Every task goal must be CONCRETE and actionable (not vague like "implement the feature").
- Every task goal must be CODE/BUILD/TEST work ONLY. NEVER include any outward or destructive action: no git push, no deploy/publish/release, no repository creation, no "ship"/"tidy --apply", no opening PRs. Tasks operate strictly within the target project directory.
- Output ONLY the raw JSON object — no explanation, no markdown, no surrounding text.`;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface RawPhaseTask {
  id?: unknown;
  goal?: unknown;
}

interface RawPlan {
  scaffold?: RawPhaseTask[];
  build?: RawPhaseTask[];
  integrate?: RawPhaseTask[];
  verify?: RawPhaseTask[];
  review?: RawPhaseTask[];
}

/**
 * Extract a JSON object from model output that may contain prose or markdown
 * fences. Tries the full string first, then scans for the first { ... } block.
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();

  // 1. Strip markdown code fences if present (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  // 2. Try direct parse
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    // fall through
  }

  // 3. Find first top-level { ... } block in the original raw string
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1)) as unknown;
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Parse a raw phase array into SwarmTaskSpec[]. Caps at maxCount.
 * Assigns canonical ids of the form "<phase>-<N>" if the model's ids look wrong.
 */
function parsePhase(
  raw: RawPhaseTask[] | undefined,
  phase: SwarmPhaseName,
  maxCount: number,
  budgetRemaining: number,
): SwarmTaskSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const tasks: SwarmTaskSpec[] = [];
  const effectiveMax = Math.min(maxCount, budgetRemaining);

  for (let i = 0; i < Math.min(raw.length, effectiveMax); i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;

    const goal = typeof item.goal === 'string' && item.goal.trim().length > 0
      ? item.goal.trim()
      : null;

    if (!goal) continue;

    // Normalise id: use canonical form to guarantee uniqueness and phase tagging.
    const id = `${phase}-${tasks.length + 1}`;

    // deps are assigned by the caller based on phase ordering, not the model output.
    tasks.push({ id, phase, goal, deps: [] });
  }

  return tasks;
}

/**
 * Assign cross-phase deps so later phases depend on all tasks in the
 * immediately preceding phase. Build-phase tasks are independent (no intra-
 * build deps). Non-build phases get deps on the last-phase task ids.
 *
 * Phase ordering: scaffold -> build -> integrate -> verify -> review.
 */
function wireDeps(tasks: SwarmTaskSpec[]): SwarmTaskSpec[] {
  const byPhase: Record<SwarmPhaseName, SwarmTaskSpec[]> = {
    scaffold: [],
    build: [],
    integrate: [],
    verify: [],
    review: [],
  };

  for (const t of tasks) {
    byPhase[t.phase].push(t);
  }

  const phaseOrder: SwarmPhaseName[] = ['scaffold', 'build', 'integrate', 'verify', 'review'];

  const wired: SwarmTaskSpec[] = [];
  let prevPhaseIds: string[] = [];

  for (const phase of phaseOrder) {
    const phaseTasks = byPhase[phase];
    for (const t of phaseTasks) {
      // BUILD tasks are parallel — all depend on scaffold tasks only (the
      // previous phase), not on each other.
      // All other phases depend on the entire previous phase completing.
      wired.push({ ...t, deps: [...prevPhaseIds] });
    }
    // After processing this phase, its task ids become deps for the next phase.
    prevPhaseIds = phaseTasks.map((t) => t.id);
  }

  return wired;
}

/**
 * Try to parse a SwarmPlan from model output. Returns null if parsing fails
 * or produces no tasks.
 */
function parsePlan(raw: string, goal: string): SwarmPlan | null {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const rp = parsed as RawPlan;

  // Track total budget across phases
  let totalRemaining = MAX_TOTAL_TASKS;

  const scaffoldTasks = parsePhase(rp.scaffold, 'scaffold', 2, totalRemaining);
  totalRemaining -= scaffoldTasks.length;

  const buildTasks = parsePhase(rp.build, 'build', MAX_TASKS_PER_PHASE, totalRemaining);
  totalRemaining -= buildTasks.length;

  const integrateTasks = parsePhase(rp.integrate, 'integrate', 2, totalRemaining);
  totalRemaining -= integrateTasks.length;

  const verifyTasks = parsePhase(rp.verify, 'verify', 2, totalRemaining);
  totalRemaining -= verifyTasks.length;

  const reviewTasks = parsePhase(rp.review, 'review', 2, totalRemaining);

  const allTasks = [
    ...scaffoldTasks,
    ...buildTasks,
    ...integrateTasks,
    ...verifyTasks,
    ...reviewTasks,
  ];

  if (allTasks.length === 0) return null;

  const wired = wireDeps(allTasks);

  return { specId: null, goal, tasks: wired };
}

// ---------------------------------------------------------------------------
// Default fallback plan
// ---------------------------------------------------------------------------

/**
 * Build a sensible default plan when model output cannot be parsed.
 * 1 scaffold, 3 build (independent), 1 integrate, 1 verify, 1 review.
 */
function defaultPlan(goal: string): SwarmPlan {
  const scaffoldTask: SwarmTaskSpec = {
    id: 'scaffold-1',
    phase: 'scaffold',
    goal: `Set up project structure and boilerplate for: ${goal}`,
    deps: [],
  };

  const buildTasks: SwarmTaskSpec[] = [
    {
      id: 'build-1',
      phase: 'build',
      goal: `Implement core data models and types for: ${goal}`,
      deps: ['scaffold-1'],
    },
    {
      id: 'build-2',
      phase: 'build',
      goal: `Implement primary business logic for: ${goal}`,
      deps: ['scaffold-1'],
    },
    {
      id: 'build-3',
      phase: 'build',
      goal: `Implement CLI or API interface for: ${goal}`,
      deps: ['scaffold-1'],
    },
  ];

  const integrateTask: SwarmTaskSpec = {
    id: 'integrate-1',
    phase: 'integrate',
    goal: `Wire together all components and ensure they work end-to-end for: ${goal}`,
    deps: ['build-1', 'build-2', 'build-3'],
  };

  const verifyTask: SwarmTaskSpec = {
    id: 'verify-1',
    phase: 'verify',
    goal: `Run tests, type-checks, and lint; fix any failures for: ${goal}`,
    deps: ['integrate-1'],
  };

  const reviewTask: SwarmTaskSpec = {
    id: 'review-1',
    phase: 'review',
    goal: `Review code quality, add documentation, and clean up for: ${goal}`,
    deps: ['verify-1'],
  };

  return {
    specId: null,
    goal,
    tasks: [scaffoldTask, ...buildTasks, integrateTask, verifyTask, reviewTask],
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === 'string' && signal.reason.length > 0
      ? signal.reason
      : 'Swarm planning cancelled.',
  );
  error.name = 'AbortError';
  return error;
}

function plannerUsage(usage: unknown): SwarmPlan['usage'] {
  if (!usage || typeof usage !== 'object') return undefined;
  const value = usage as { tokensIn?: unknown; tokensOut?: unknown };
  if (!Number.isFinite(value.tokensIn) || !Number.isFinite(value.tokensOut)) return undefined;
  return {
    tokensIn: value.tokensIn as number,
    tokensOut: value.tokensOut as number,
  };
}

function withUsage(plan: SwarmPlan, usage: SwarmPlan['usage']): SwarmPlan {
  return usage === undefined ? plan : { ...plan, usage };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decompose a goal (+ optional spec body) into a phased SwarmPlan.
 *
 * CONTRACT (from docs/contracts/CONTRACT-M12.md):
 *   planSwarm(input, cfg, signal?): Promise<SwarmPlan>
 *
 * Guardrails:
 *  - Single bounded model call; only owner cancellation throws.
 *  - Tasks per phase <= 6; total tasks <= 18.
 *  - BUILD-phase tasks are independent (deps = scaffold tasks only).
 *  - Falls back to a sensible default plan on any failure.
 *  - LOCAL-first (opts.allowCloud defaults false).
 */
export async function planSwarm(
  input: { goal: string; specBody?: string },
  cfg: AshlrConfig,
  signal?: AbortSignal,
): Promise<SwarmPlan> {
  const { goal, specBody } = input;

  if (signal?.aborted) throw abortReason(signal);

  // Build the user prompt
  const userPrompt = specBody
    ? `Goal: ${goal}\n\nSpec:\n${specBody.slice(0, 8000)}` // guard against enormous spec bodies
    : `Goal: ${goal}`;

  // Attempt a single LOCAL-first model call
  let rawOutput: string;
  let usage: SwarmPlan['usage'];
  try {
    const client = await getActiveClient(cfg, { allowCloud: false });
    if (signal?.aborted) throw abortReason(signal);
    const result = await client.chat([
      { role: 'system', content: PLANNING_SYSTEM },
      { role: 'user', content: userPrompt },
    ], undefined, signal);
    rawOutput = result.content;
    usage = plannerUsage(result.usage);
    if (signal?.aborted) throw abortReason(signal);
  } catch (err) {
    if (signal?.aborted) throw abortReason(signal);
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ashlr swarm] planner model call failed: ${msg} — using default plan\n`);
    return defaultPlan(goal);
  }

  // Parse the model output
  try {
    const plan = parsePlan(rawOutput, goal);
    if (plan && plan.tasks.length > 0) {
      return withUsage(plan, usage);
    }
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    process.stderr.write(`[ashlr swarm] planner parse error: ${msg} — using default plan\n`);
  }

  // Fall back to default
  process.stderr.write(
    `[ashlr swarm] planner could not extract a valid plan from model output — using default plan\n`,
  );
  return withUsage(defaultPlan(goal), usage);
}

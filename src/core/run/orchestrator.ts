/**
 * core/run/orchestrator.ts — M4 local-first agent orchestrator.
 *
 * Responsibilities:
 *  - planGoal:  single chat call -> RunTask[] DAG (1-6 tasks, deps valid).
 *  - runGoal:   resolve client, plan/resume, execute DAG (parallel up to opts.parallel),
 *               enforce HARD budget, persist RunState after every step, synthesize
 *               final answer, best-effort Pulse POST.
 *  - loadRun / listRuns / saveRun: JSON persistence under ~/.ashlr/runs/.
 *
 * M7 addition: genome-aware injection. Before planning, runGoal calls
 * recall(goal, cfg) from src/core/genome/recall.ts (dynamic import, best-effort)
 * and prepends a bounded "Relevant project memory:" block to the planning system
 * prompt so the planner starts with relevant cross-project context.
 * Gated on cfg.genome?.injectOnRun (default true) and opts.noMemory (opt-out).
 * Never throws — if recall fails or is empty, the run proceeds unchanged.
 *
 * Safety guardrails (binding):
 *  - Never writes outside ~/.ashlr/runs/ — no repos/Desktop, no git.
 *  - Budget is a HARD ceiling (aborts with partial results preserved).
 *  - Cloud endpoints require explicit allowCloud + key present (delegated to getActiveClient).
 *  - Zero new runtime deps (Node builtins + @modelcontextprotocol/sdk only).
 *  - Genome recall is local-only (keyword/TF-IDF, optional local Ollama embeddings).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import type {
  AshlrConfig,
  RunTask,
  RunTaskStatus,
  RunState,
  RunOptions,
  RunStep,
  ProviderClient,
  ChatMessage,
} from '../types.js';

import { getActiveClient } from './provider-client.js';
import { newUsage, overBudget, estCostUsd } from './budget.js';
import { runTask } from './agent-loop.js';
import { withToolEnv } from '../env-bridge.js';

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

/** Default token budget per run. */
export const DEFAULT_MAX_TOKENS = 50_000;
/** Default step budget per run. */
export const DEFAULT_MAX_STEPS = 40;
/** Default parallel task execution limit. */
export const DEFAULT_PARALLEL = 2;
/** Directory for persisted run state. */
const RUNS_DIR = path.join(os.homedir(), '.ashlr', 'runs');
/**
 * Sentinel error attached to tasks that were force-failed by a budget abort
 * (as opposed to a genuine model failure). On --resume we reset tasks bearing
 * this exact error back to 'pending' so they re-run under the new budget.
 */
const ABORT_TASK_ERROR = 'Aborted: run budget exceeded';

/**
 * Maximum characters of genome memory injected into the planning prompt.
 * Keeps the injection bounded regardless of entry size.
 */
const GENOME_INJECT_CHAR_CAP = 1500;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the runs directory exists (mkdir -p).
 * Only creates entries under ~/.ashlr/runs — never repos/Desktop.
 */
function ensureRunsDir(): void {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

/**
 * Compute the absolute path for a run file.
 * Validates the id contains only safe characters to prevent path traversal.
 */
function runFilePath(id: string): string {
  // Only allow alphanumeric, hyphens, underscores, dots — no slashes or traversal
  if (!/^[\w.-]+$/.test(id)) {
    throw new Error(`Invalid run id: ${JSON.stringify(id)}`);
  }
  return path.join(RUNS_DIR, `${id}.json`);
}

/**
 * Load a persisted RunState by id. Returns null if absent, unreadable, or invalid JSON.
 */
export function loadRun(id: string): RunState | null {
  try {
    const file = runFilePath(id);
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

/**
 * List all persisted runs, newest first by createdAt.
 */
export function listRuns(): RunState[] {
  try {
    ensureRunsDir();
    const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'));
    const runs: RunState[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(RUNS_DIR, file), 'utf8');
        const state = JSON.parse(raw) as RunState;
        runs.push(state);
      } catch {
        // Skip corrupt/unreadable files silently
      }
    }
    return runs.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

/**
 * Atomically persist a RunState to ~/.ashlr/runs/<id>.json (write-then-rename).
 * ONLY writes under RUNS_DIR — never touches repos or Desktop.
 */
export function saveRun(s: RunState): void {
  ensureRunsDir();
  const dest = runFilePath(s.id);
  const tmp = dest + '.tmp';
  const payload = JSON.stringify(s, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, dest);
}

// ---------------------------------------------------------------------------
// Run id generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique run id from the wall clock (format: run-<timestamp>-<random>).
 * Callers may inject an id for test determinism.
 */
function generateRunId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  return `run-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// M7: Genome recall injection (best-effort, local-only)
// ---------------------------------------------------------------------------

/**
 * Attempt to recall relevant genome entries for the goal and format them as a
 * bounded context block suitable for prepending to a planning system prompt.
 *
 * Rules:
 *  - Dynamic import of ../genome/recall.js — if the module does not exist yet
 *    (other M7 agents have not shipped it), returns '' gracefully.
 *  - Total injected text is capped at GENOME_INJECT_CHAR_CAP characters.
 *  - Never throws — any error returns '' so the run proceeds unchanged.
 *  - Local-only: embeddings via local Ollama only, never cloud.
 */
async function buildMemoryBlock(goal: string, cfg: AshlrConfig): Promise<string> {
  try {
    // Dynamic import: tolerates the module being absent (pre-M7 build).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recallMod = await import('../genome/recall.js') as any;

    if (typeof recallMod.recall !== 'function') return '';

    const limit = cfg.genome?.maxRecall ?? 3;
    const hits: Array<{
      entry: { title: string; text: string; project: string | null };
      score: number;
    }> = await recallMod.recall(goal, cfg, { limit });

    if (!Array.isArray(hits) || hits.length === 0) return '';

    const lines: string[] = ['Relevant project memory:'];
    let charCount = lines[0]!.length + 1;

    for (const hit of hits) {
      if (!hit?.entry) continue;
      const project = hit.entry.project ? ` [${hit.entry.project}]` : '';
      const header = `- ${hit.entry.title ?? 'note'}${project}:`;
      const body = String(hit.entry.text ?? '').replace(/\s+/g, ' ').trim();
      const fragment = `${header} ${body}`;

      // Stop if adding this entry would exceed the character cap
      if (charCount + fragment.length + 1 > GENOME_INJECT_CHAR_CAP) {
        // Attempt a truncated version (at least 20 chars of body are worth showing)
        const remaining = GENOME_INJECT_CHAR_CAP - charCount - header.length - 4;
        if (remaining > 20) {
          lines.push(`${header} ${body.slice(0, remaining)}…`);
        }
        break;
      }

      lines.push(fragment);
      charCount += fragment.length + 1;
    }

    // Only return the block if we actually added at least one entry beyond header
    if (lines.length <= 1) return '';

    return lines.join('\n');
  } catch {
    // Module absent, recall failed, or any other error — proceed without memory
    return '';
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Prompt template for decomposing a goal into a task DAG. */
const PLANNING_SYSTEM = `You are a task planner. Decompose the user's goal into 1-6 subtasks that together accomplish it.
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
 * Parse a RunTask[] from model output, tolerating prose wrapped around JSON.
 * Returns null if no valid JSON array of tasks is found.
 */
function parseTaskList(text: string): RunTask[] | null {
  // Try to find a JSON array in the output (tolerate leading/trailing prose)
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const tasks: RunTask[] = [];
  const seenIds = new Set<string>();

  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null;
    const obj = item as Record<string, unknown>;

    const id = typeof obj['id'] === 'string' ? obj['id'].trim() : null;
    const goal = typeof obj['goal'] === 'string' ? obj['goal'].trim() : null;

    if (!id || !goal) return null;
    if (seenIds.has(id)) return null; // duplicate id
    seenIds.add(id);

    const rawDeps = Array.isArray(obj['deps']) ? obj['deps'] : [];
    const deps = rawDeps.filter((d): d is string => typeof d === 'string');

    tasks.push({
      id,
      goal,
      deps,
      status: 'pending' as RunTaskStatus,
    });
  }

  // Validate deps reference only known ids (no forward deps that are cycles)
  const taskIds = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (!taskIds.has(dep)) return null; // unknown dep
      if (dep === task.id) return null; // self-dep
    }
  }

  // Reject multi-node cycles (e.g. t1->t2->t1). A cycle is a broken plan: at
  // runtime it would otherwise be silently swallowed as 'skipped' tasks after
  // the planning call was already charged. Returning null surfaces it as a
  // plan-parse failure so planGoal falls back to the single-task plan.
  if (hasCycle(tasks)) return null;

  return tasks.length > 0 ? tasks : null;
}

/**
 * DFS-based cycle detection over the task DAG (deps are edges dep -> task).
 * Returns true if any cycle exists.
 */
function hasCycle(tasks: RunTask[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const VISITING = 1;
  const DONE = 2;
  const mark = new Map<string, number>();

  const visit = (id: string): boolean => {
    const cur = mark.get(id);
    if (cur === VISITING) return true; // back-edge -> cycle
    if (cur === DONE) return false;
    mark.set(id, VISITING);
    const task = byId.get(id);
    if (task) {
      for (const dep of task.deps) {
        if (byId.has(dep) && visit(dep)) return true;
      }
    }
    mark.set(id, DONE);
    return false;
  };

  for (const t of tasks) {
    if (visit(t.id)) return true;
  }
  return false;
}

/**
 * Planning call: ask the model to decompose `goal` into a RunTask[] DAG.
 * Falls back to a single task whose goal is the original goal on parse failure.
 *
 * @param memoryContext Optional genome memory block to prepend to the system prompt.
 *   When non-empty, injects "Relevant project memory:" context so the planner
 *   benefits from cross-project knowledge. Kept bounded upstream (GENOME_INJECT_CHAR_CAP).
 */
export async function planGoal(
  goal: string,
  client: ProviderClient,
  onUsage?: (usage: { tokensIn: number; tokensOut: number }) => void,
  memoryContext?: string,
): Promise<RunTask[]> {
  // Prepend memory block when present (bounded by caller)
  const systemContent =
    memoryContext && memoryContext.length > 0
      ? `${memoryContext}\n\n${PLANNING_SYSTEM}`
      : PLANNING_SYSTEM;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: goal },
  ];

  let result: import('../types.js').ChatResult;
  try {
    result = await client.chat(messages);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ashlr run] planning call failed: ${msg} — using single-task fallback\n`);
    return [{ id: 't1', goal, deps: [], status: 'pending' }];
  }

  // Report planning-call usage so the orchestrator can charge it to the budget
  // and the cost summary. Best-effort: a failed plan call (handled above)
  // reports nothing.
  if (onUsage) onUsage({ tokensIn: result.usage.tokensIn, tokensOut: result.usage.tokensOut });

  const parsed = parseTaskList(result.content);
  if (!parsed) {
    process.stderr.write(
      `[ashlr run] could not parse task list from planning response — using single-task fallback\n`,
    );
    return [{ id: 't1', goal, deps: [], status: 'pending' }];
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

const SYNTHESIS_SYSTEM = `You are a helpful assistant. The user asked a goal and several subtasks were executed to answer it.
Combine the results into a single, coherent final answer. Be concise and accurate.`;

/**
 * Synthesize a final answer from completed task results.
 * Returns a best-effort string even if the model call fails.
 */
async function synthesize(
  goal: string,
  tasks: RunTask[],
  client: ProviderClient,
): Promise<{ content: string; usage: { tokensIn: number; tokensOut: number } }> {
  const doneTasks = tasks.filter((t) => t.status === 'done' && t.result);
  if (doneTasks.length === 0) {
    return {
      content: 'No tasks completed successfully — no result to synthesize.',
      usage: { tokensIn: 0, tokensOut: 0 },
    };
  }

  const taskSummary = doneTasks
    .map((t) => `### ${t.id}: ${t.goal}\n${t.result ?? '(no result)'}`)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYNTHESIS_SYSTEM },
    {
      role: 'user',
      content: `Goal: ${goal}\n\nTask results:\n\n${taskSummary}\n\nPlease synthesize a final answer.`,
    },
  ];

  try {
    const res = await client.chat(messages);
    return { content: res.content, usage: res.usage };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Best-effort fallback: concatenate task results
    const fallback = doneTasks.map((t) => `[${t.id}] ${t.result ?? ''}`).join('\n');
    process.stderr.write(`[ashlr run] synthesis call failed: ${msg} — using concatenated fallback\n`);
    return { content: fallback, usage: { tokensIn: 0, tokensOut: 0 } };
  }
}

// ---------------------------------------------------------------------------
// DAG execution helpers
// ---------------------------------------------------------------------------

/**
 * Returns all tasks that are ready to run (pending + all deps done).
 */
function readyTasks(tasks: RunTask[]): RunTask[] {
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return tasks.filter(
    (t) => t.status === 'pending' && t.deps.every((dep) => doneIds.has(dep)),
  );
}

/**
 * Returns true when all tasks are in a terminal state (done/failed/skipped/aborted).
 */
function allTerminal(tasks: RunTask[]): boolean {
  const terminal: RunTaskStatus[] = ['done', 'failed', 'skipped'];
  return tasks.every((t) => terminal.includes(t.status));
}

// ---------------------------------------------------------------------------
// Pulse reporting (best-effort, non-blocking)
// ---------------------------------------------------------------------------

/**
 * POST a best-effort run-summary to the configured Pulse endpoint.
 *
 * Format: a single bespoke JSON object summarising the run (NOT OTLP).
 * This is an opt-in, best-effort side-channel — it is only attempted when
 * cfg.telemetry.pulse is set. Failures (network, timeout, non-2xx) are logged
 * to stderr and never thrown to the caller.
 *
 * Never throws, never blocks the caller.
 */
function reportToPulse(pulseUrl: string, state: RunState): void {
  const payload = JSON.stringify({
    runId: state.id,
    goal: state.goal,
    status: state.status,
    engine: state.engine,
    provider: state.provider,
    tasks: state.tasks.length,
    usage: state.usage,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  });

  // Fire-and-forget with a 5 s timeout — log failures to stderr so the caller
  // knows the report was not delivered (instead of silently swallowing errors).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  fetch(pulseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal: ctrl.signal,
  })
    .then((res) => {
      clearTimeout(timer);
      if (!res.ok) {
        process.stderr.write(
          `[ashlr run] pulse: best-effort POST to ${pulseUrl} returned HTTP ${res.status}\n`,
        );
      }
    })
    .catch((err: unknown) => {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[ashlr run] pulse: best-effort POST to ${pulseUrl} failed — ${msg}\n`,
      );
    });
}

// ---------------------------------------------------------------------------
// Engine delegation helpers
// ---------------------------------------------------------------------------

/**
 * Check if a binary is installed by probing PATH via `which`.
 * Uses the top-level execFileSync import (Node builtin, ESM-safe).
 */
function isBinaryInstalled(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main: runGoal
// ---------------------------------------------------------------------------

/**
 * Top-level orchestrator driver. Builds/loads RunState, plans (unless resuming),
 * executes the DAG with parallelism up to opts.parallel, enforces HARD budget,
 * persists after every step, synthesizes final answer, best-effort Pulse POST.
 *
 * M7: genome-aware. Before planning, recalls top-k genome hits for the goal
 * and injects them as context into the planning prompt — bounded, local-only,
 * best-effort. Disabled via opts.noMemory or cfg.genome?.injectOnRun === false.
 */
export async function runGoal(
  goal: string,
  cfg: AshlrConfig,
  opts: RunOptions,
): Promise<RunState> {
  // Optional CLI progress hook. The CLI (src/cli/run.ts) attaches a non-typed
  // __onStep property to opts to receive live per-step progress. We read it off
  // here and invoke it after each persisted step (model/plan/synthesize). It is
  // best-effort: it must never crash the run.
  const rawCliOnStep = (opts as RunOptions & {
    __onStep?: (step: RunStep, tasks: RunTask[]) => void;
  }).__onStep;
  const cliOnStep =
    typeof rawCliOnStep === 'function'
      ? (step: RunStep, tasks: RunTask[]): void => {
          try {
            rawCliOnStep(step, tasks);
          } catch {
            // Progress reporting must never break the run.
          }
        }
      : undefined;

  // M7: read noMemory from opts. Not yet typed in RunOptions (avoid editing
  // types.ts) — read as an extended property, same pattern as __onStep above.
  const noMemory = (opts as RunOptions & { noMemory?: boolean }).noMemory === true;

  // -- Resume short-circuit (M10 fix: must run BEFORE engine delegation) -------
  // When --resume is requested we must NEVER delegate to an external engine —
  // the run was already started by whichever engine created it, and resuming
  // means continuing with the builtin executor against the persisted state.
  // Previously the engine-delegation block ran first, so
  // `run --engine ashlrcode --resume <id>` would re-run via ashlrcode instead
  // of resuming.  Now we handle all resume guards here, before engine selection:
  //   1. Not found  → throw immediately.
  //   2. Already complete → return early (no-op).
  //   3. Incomplete → fall through with opts.resumeId set; engine selection
  //      below skips delegation because we override engine to 'builtin'.
  if (opts.resumeId) {
    const existingForResume = loadRun(opts.resumeId);
    if (!existingForResume) {
      throw new Error(`Run "${opts.resumeId}" not found in ${RUNS_DIR}`);
    }
    if (existingForResume.status === 'done' && existingForResume.result) {
      process.stderr.write(
        `[ashlr run] run ${existingForResume.id} is already complete — nothing to resume\n`,
      );
      return existingForResume;
    }
    // Incomplete resume: force builtin so engine delegation is skipped.
    // The full state reload / task-reset happens in the "Load or create
    // RunState" block further below.
    opts = { ...opts, engine: 'builtin' };
  }

  // -- Engine selection --------------------------------------------------------
  const requestedEngine = opts.engine ?? 'builtin';
  let engine = requestedEngine;
  if (engine !== 'builtin') {
    if (!isBinaryInstalled(engine)) {
      process.stderr.write(
        `[ashlr run] engine "${engine}" not found on PATH — falling back to builtin\n`,
      );
      engine = 'builtin';
    } else {
      // Delegate to the external engine binary (ashlrcode / aw).
      // Spawn synchronously with an inherited stdio so the binary can render its
      // own progress output, then capture stdout as the run result.
      // Bounded by the budget maxSteps wall-clock via the fact that the sub-process
      // owns its own execution — we do NOT forward the token budget to it (unknown
      // protocol) but we do honour the caller's intent to use a different engine.
      process.stderr.write(
        `[ashlr run] delegating to engine "${engine}" (${goal.slice(0, 60)}…)\n`,
      );
      const engineResult = spawnSync(engine, ['--goal', goal], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        timeout: 5 * 60 * 1000,      // 5 min hard wall-clock limit
        // M10 env-bridge: project unified config into the delegated engine's
        // environment so ashlrcode/aw honours the same provider/model/roots
        // config as the hub — without modifying those tools.
        env: withToolEnv(cfg),
      });

      const id = generateRunId();
      const now = new Date().toISOString();
      const delegatedState: RunState = {
        id,
        goal,
        engine,
        provider: 'external',
        createdAt: now,
        updatedAt: now,
        budget: {
          maxTokens: opts.budget?.maxTokens ?? DEFAULT_MAX_TOKENS,
          maxSteps: opts.budget?.maxSteps ?? DEFAULT_MAX_STEPS,
          allowCloud: opts.allowCloud ?? false,
        },
        usage: newUsage(),
        tasks: [],
        steps: [],
        status: 'running',
      };

      if (engineResult.error || engineResult.status !== 0) {
        const errMsg = engineResult.error?.message
          ?? (engineResult.stderr ? String(engineResult.stderr).trim() : `exit ${engineResult.status ?? 'unknown'}`);
        process.stderr.write(`[ashlr run] engine "${engine}" failed: ${errMsg}\n`);
        delegatedState.status = 'failed';
        delegatedState.result = `Engine "${engine}" failed: ${errMsg}`;
        delegatedState.updatedAt = new Date().toISOString();
        saveRun(delegatedState);
        return delegatedState;
      }

      delegatedState.status = 'done';
      delegatedState.result = String(engineResult.stdout ?? '').trim();
      delegatedState.updatedAt = new Date().toISOString();
      saveRun(delegatedState);
      return delegatedState;
    }
  }

  // -- Budget / parallel defaults ----------------------------------------------
  const allowCloud = opts.allowCloud ?? false;
  const budget = {
    maxTokens: opts.budget?.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxSteps: opts.budget?.maxSteps ?? DEFAULT_MAX_STEPS,
    allowCloud,
  };
  const parallel = Math.max(1, opts.parallel ?? DEFAULT_PARALLEL);

  // -- Resolve provider client -------------------------------------------------
  const client = await getActiveClient(cfg, { allowCloud });

  // -- Load or create RunState -------------------------------------------------
  let state: RunState;

  if (opts.resumeId) {
    const existing = loadRun(opts.resumeId);
    if (!existing) {
      throw new Error(`Run "${opts.resumeId}" not found in ${RUNS_DIR}`);
    }
    // Already-complete run: do NOT redo work. Re-running synthesis would
    // double-count usage, append duplicate steps, and re-POST Pulse. Return the
    // loaded state unchanged so `--resume <id>` on a finished run is a no-op.
    if (existing.status === 'done' && existing.result) {
      process.stderr.write(
        `[ashlr run] run ${existing.id} is already complete — nothing to resume\n`,
      );
      return existing;
    }

    state = {
      ...existing,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    // Reset tasks that should re-run with the (presumably larger) new budget:
    //  - 'running': were mid-flight when the previous invocation stopped.
    //  - abort-failures: tasks the budget abort marked 'failed' with the
    //    sentinel error. Genuine model failures are left as-is so we don't
    //    loop on a deterministically-failing task.
    for (const task of state.tasks) {
      if (
        task.status === 'running' ||
        (task.status === 'failed' && task.error === ABORT_TASK_ERROR)
      ) {
        task.status = 'pending';
        task.error = undefined;
      }
    }
    saveRun(state);
    process.stderr.write(`[ashlr run] resumed run ${state.id} (${state.tasks.length} tasks)\n`);
  } else {
    const id = generateRunId();
    const now = new Date().toISOString();
    state = {
      id,
      goal,
      engine,
      provider: client.id,
      createdAt: now,
      updatedAt: now,
      budget,
      usage: newUsage(),
      tasks: [],
      steps: [],
      status: 'running',
    };
    saveRun(state);
  }

  // -- Tool wiring (optional) --------------------------------------------------
  // When opts.tools !== false, attempt to connect to the MCP gateway as a client.
  // On any failure, continue tool-free with a warning.
  let tools: unknown[] | undefined;
  if (opts.tools !== false && client.supportsTools) {
    try {
      tools = await loadGatewayTools(cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashlr run] tool gateway unavailable (${msg}) — continuing tool-free\n`);
      tools = undefined;
    }
  }

  // -- M7: Genome recall injection (best-effort, bounded, local-only) ----------
  // Recall top-k genome hits for the goal and inject as planning context.
  // Skipped when: noMemory is set, cfg disables injection, or this is a resume
  // with existing tasks (context was already embedded in those task goals).
  let memoryContext = '';
  const injectOnRun = cfg.genome?.injectOnRun ?? true;
  if (!noMemory && injectOnRun && state.tasks.length === 0) {
    memoryContext = await buildMemoryBlock(goal, cfg);
    if (memoryContext.length > 0) {
      process.stderr.write(
        `[ashlr run] genome: injecting ${memoryContext.length} chars of memory context\n`,
      );
    }
  }

  // -- Plan (unless resuming with existing tasks) ------------------------------
  if (state.tasks.length === 0) {
    const planStep: RunStep = {
      ts: new Date().toISOString(),
      taskId: '__plan__',
      kind: 'plan',
      summary: `Planning: decomposing goal into tasks`,
    };
    state.steps.push(planStep);
    state.updatedAt = planStep.ts;
    saveRun(state);

    let planTokensIn = 0;
    let planTokensOut = 0;
    const tasks = await planGoal(
      goal,
      client,
      (u) => {
        planTokensIn = u.tokensIn;
        planTokensOut = u.tokensOut;
      },
      memoryContext || undefined,
    );
    state.tasks = tasks;

    // Charge the planning call to the run budget so usage/cost stay accurate.
    // (Previously the planning tokens were silently discarded.)
    state.usage.tokensIn += planTokensIn;
    state.usage.tokensOut += planTokensOut;
    state.usage.steps += 1;
    state.usage.estCostUsd = estCostUsd(client.id, state.usage.tokensIn, state.usage.tokensOut);
    state.updatedAt = new Date().toISOString();

    const planDoneStep: RunStep = {
      ts: state.updatedAt,
      taskId: '__plan__',
      kind: 'plan',
      summary: `Planned ${tasks.length} task(s): ${tasks.map((t) => t.id).join(', ')}`,
      usage: { tokensIn: planTokensIn, tokensOut: planTokensOut, steps: 1, estCostUsd: 0 },
    };
    state.steps.push(planDoneStep);
    cliOnStep?.(planDoneStep, state.tasks);
    saveRun(state);
  }

  // -- DAG execution loop ------------------------------------------------------
  let aborted = false;

  while (!allTerminal(state.tasks) && !aborted) {
    // Check global budget before picking next batch
    if (overBudget(state.usage, budget)) {
      aborted = true;
      break;
    }

    const ready = readyTasks(state.tasks);
    if (ready.length === 0) {
      // No ready tasks but not all terminal — means some tasks have deps on
      // failed/skipped tasks. Mark them skipped.
      const pendingBlocked = state.tasks.filter((t) => t.status === 'pending');
      if (pendingBlocked.length > 0) {
        for (const t of pendingBlocked) {
          t.status = 'skipped';
          t.error = 'Dependency failed or was skipped';
        }
        state.updatedAt = new Date().toISOString();
        saveRun(state);
      }
      break;
    }

    // Run up to `parallel` tasks concurrently
    const batch = ready.slice(0, parallel);

    // Mark them running before spawning
    for (const task of batch) {
      task.status = 'running';
    }
    state.updatedAt = new Date().toISOString();
    saveRun(state);

    // Run the batch in parallel; each task must not crash the whole run
    await Promise.all(
      batch.map(async (task) => {
        try {
          await runTask(task, client, {
            tools,
            budget,
            usage: state.usage,
            onStep: (step: RunStep) => {
              state.steps.push(step);
              // Merge step usage into global usage.
              //
              // SINGLE-WRITER INVARIANT: the orchestrator is the only place that
              // accumulates into state.usage. The agent loop reports per-step
              // deltas via this callback and does NOT mutate ctx.usage itself.
              // We mutate state.usage IN PLACE (never rebind) so the object
              // identity handed to every in-flight runTask as ctx.usage stays
              // authoritative — the agent loop's hard-ceiling check
              // overBudget(ctx.usage, ctx.budget) reads the live global total,
              // which is essential under --parallel > 1.
              if (step.usage) {
                state.usage.tokensIn += step.usage.tokensIn;
                state.usage.tokensOut += step.usage.tokensOut;
                state.usage.steps += step.usage.steps;
                state.usage.estCostUsd = estCostUsd(
                  client.id,
                  state.usage.tokensIn,
                  state.usage.tokensOut,
                );
              }
              state.updatedAt = new Date().toISOString();
              cliOnStep?.(step, state.tasks);
              saveRun(state);
            },
          });
        } catch (err) {
          // Defensive: runTask should handle its own errors, but catch any leak
          const msg = err instanceof Error ? err.message : String(err);
          task.status = 'failed';
          task.error = `Unexpected orchestrator error: ${msg}`;
          process.stderr.write(`[ashlr run] task ${task.id} crashed unexpectedly: ${msg}\n`);
        }
      }),
    );

    state.updatedAt = new Date().toISOString();
    saveRun(state);

    // Check budget after batch completes
    if (overBudget(state.usage, budget)) {
      aborted = true;
      break;
    }
  }

  // -- Abort: mark remaining pending/running tasks as aborted ------------------
  if (aborted) {
    for (const task of state.tasks) {
      if (task.status === 'pending' || task.status === 'running') {
        task.status = 'failed';
        task.error = ABORT_TASK_ERROR;
      }
    }
    state.status = 'aborted';
    state.updatedAt = new Date().toISOString();
    saveRun(state);

    // Report to Pulse (best-effort)
    if (cfg.telemetry.pulse) {
      reportToPulse(cfg.telemetry.pulse, state);
    }

    return state;
  }

  // -- Synthesize final answer -------------------------------------------------
  const synthStep: RunStep = {
    ts: new Date().toISOString(),
    taskId: '__synthesize__',
    kind: 'synthesize',
    summary: 'Synthesizing final answer from task results',
  };
  state.steps.push(synthStep);
  state.updatedAt = synthStep.ts;
  saveRun(state);

  // Budget guard for synthesis: if the run already hit the ceiling, do NOT
  // spend another model call. Fall back to concatenating the completed task
  // results so maxTokens stays a hard ceiling at the synthesis boundary too.
  let synthResult: string;
  let synthUsage: { tokensIn: number; tokensOut: number };
  if (overBudget(state.usage, budget)) {
    const doneTasks = state.tasks.filter((t) => t.status === 'done' && t.result);
    synthResult =
      doneTasks.length > 0
        ? doneTasks.map((t) => `[${t.id}] ${t.result ?? ''}`).join('\n')
        : 'No tasks completed successfully — no result to synthesize.';
    synthUsage = { tokensIn: 0, tokensOut: 0 };
    process.stderr.write(
      `[ashlr run] budget reached — skipping model synthesis, using concatenated task results\n`,
    );
  } else {
    const synth = await synthesize(goal, state.tasks, client);
    synthResult = synth.content;
    synthUsage = synth.usage;
  }

  state.usage.tokensIn += synthUsage.tokensIn;
  state.usage.tokensOut += synthUsage.tokensOut;
  state.usage.steps += 1;
  state.usage.estCostUsd = estCostUsd(client.id, state.usage.tokensIn, state.usage.tokensOut);

  const synthDoneStep: RunStep = {
    ts: new Date().toISOString(),
    taskId: '__synthesize__',
    kind: 'synthesize',
    summary: 'Synthesis complete',
    usage: { tokensIn: synthUsage.tokensIn, tokensOut: synthUsage.tokensOut, steps: 1, estCostUsd: 0 },
  };
  state.steps.push(synthDoneStep);
  cliOnStep?.(synthDoneStep, state.tasks);
  state.result = synthResult;

  // Determine final status
  const failedCount = state.tasks.filter((t) => t.status === 'failed').length;
  state.status = failedCount === state.tasks.length ? 'failed' : 'done';
  state.updatedAt = new Date().toISOString();
  saveRun(state);

  // -- Best-effort Pulse POST --------------------------------------------------
  if (cfg.telemetry.pulse) {
    reportToPulse(cfg.telemetry.pulse, state);
  }

  return state;
}

// ---------------------------------------------------------------------------
// Gateway tool loading (optional)
// ---------------------------------------------------------------------------

/**
 * Attempt to load aggregated tools from the MCP gateway as a client.
 * Returns the tool list (OpenAI-style tool specs) or throws on failure.
 * Used only when opts.tools !== false AND client.supportsTools.
 */
async function loadGatewayTools(cfg: AshlrConfig): Promise<unknown[]> {
  // Lazy-import MCP SDK to keep startup fast when tools are disabled
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  // Resolve the ashlr binary path from the config tools map, or fall back to PATH
  const ashlrBin = cfg.tools?.['ashlr'] ?? 'ashlr';

  const transport = new StdioClientTransport({
    command: ashlrBin,
    args: ['mcp'],
    stderr: 'ignore',
  });

  const mcpClient = new Client(
    { name: 'ashlr-orchestrator', version: '0.1.0' },
    { capabilities: {} },
  );

  // Connect with a 10s timeout
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    await mcpClient.connect(transport);
    clearTimeout(timer);

    const listed = await mcpClient.listTools({}, { timeout: 10_000 });

    // Convert MCP tool specs to OpenAI-style function specs for the provider
    const tools = (listed.tools ?? []).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? t.name,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      },
    }));

    // Close client after fetching — tools are passed as static specs to the model
    try { await mcpClient.close(); } catch { /* ignore */ }

    return tools;
  } catch (err) {
    clearTimeout(timer);
    try { await mcpClient.close(); } catch { /* ignore */ }
    throw err;
  }
}

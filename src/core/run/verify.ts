/**
 * Task result verification for `ashlr run`.
 *
 * Two-stage: heuristic-first (cheap, synchronous), then an optional single
 * cheap model call only when the heuristic is inconclusive AND budget remains.
 *
 * CONTRACT guarantees:
 * - Never throws.
 * - Never exceeds the global budget (checks overBudget before any model call).
 * - Mutates `usage` in-place (same pattern as agent-loop.ts) to account for
 *   the optional model check.
 */

import type {
  RunTask,
  ProviderClient,
  RunBudget,
  RunUsage,
  VerifyVerdict,
  ChatMessage,
  AshlrConfig,
} from '../types.js';
import { overBudget, addUsage } from './budget.js';
import { detectVerifyCommands, runVerifyCommandAsync } from './verify-commands.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Error sentinels that strongly suggest the result is a failure / error message
 * rather than a meaningful answer.
 */
const ERROR_SENTINELS = [
  'error:',
  'traceback',
  'exception:',
  'syntaxerror',
  'typeerror',
  'referenceerror',
  'uncaught ',
  'fatal:',
  'command not found',
  'permission denied',
  'enoent',
  'eacces',
  'task failed',
  'aborted',
  'budget exceeded',
];

/**
 * Heuristic verdict.
 *
 * Returns { ok: false, reason, method:'heuristic' } when it is CONFIDENT the
 * result is bad, or { ok: true, reason, method:'heuristic' } when heuristic
 * is confident the result is good enough.
 *
 * Returns null when the heuristic is inconclusive (caller may attempt model check).
 */
function heuristicVerify(task: RunTask): VerifyVerdict | null {
  const result = task.result ?? '';
  const goal = task.goal;

  // 1. Empty result → confident fail.
  if (result.trim().length === 0) {
    return {
      ok: false,
      reason: 'Result is empty.',
      method: 'heuristic',
    };
  }

  // 2. Error sentinel match → confident fail.
  const lower = result.toLowerCase();
  for (const sentinel of ERROR_SENTINELS) {
    if (lower.includes(sentinel)) {
      return {
        ok: false,
        reason: `Result contains error marker "${sentinel}".`,
        method: 'heuristic',
      };
    }
  }

  // 3. On-topic keyword overlap with the goal.
  // Extract meaningful words from the goal (>= 4 chars, alpha-only).
  const goalWords = goal
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 4);

  if (goalWords.length > 0) {
    const matchCount = goalWords.filter((w) => lower.includes(w)).length;
    const overlapRatio = matchCount / goalWords.length;

    // High overlap → confident pass.
    if (overlapRatio >= 0.5) {
      return {
        ok: true,
        reason: `Result appears on-topic (${matchCount}/${goalWords.length} goal keywords matched).`,
        method: 'heuristic',
      };
    }

    // Very low overlap on a goal with many words → confident fail.
    if (goalWords.length >= 3 && overlapRatio === 0) {
      return {
        ok: false,
        reason: 'Result shares no keywords with the goal.',
        method: 'heuristic',
      };
    }
  }

  // 4. Result is non-empty and no errors → weakly pass (inconclusive, but lean ok).
  // Return null to signal the caller should do a model check if budget allows.
  return null;
}

/**
 * Build the cheap yes/no model prompt asking whether the result satisfies the goal.
 */
function buildVerifyMessages(task: RunTask): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a strict but concise evaluator. Answer only "yes" or "no" followed by a one-line reason (≤ 20 words).',
    },
    {
      role: 'user',
      content:
        `Does this result plausibly satisfy the goal?\n\n` +
        `Goal: ${task.goal}\n\n` +
        `Result (first 500 chars): ${(task.result ?? '').slice(0, 500)}\n\n` +
        `Answer "yes" or "no" and one short reason.`,
    },
  ];
}

/**
 * Parse the model's yes/no response into a VerifyVerdict.
 */
function parseModelVerdict(raw: string): VerifyVerdict {
  const text = raw.trim().toLowerCase();
  const ok = text.startsWith('yes');
  // Extract the reason: everything after the first word/punctuation.
  const reasonMatch = raw.trim().match(/^(?:yes|no)[.,:\s]*(.*)/i);
  const reason = reasonMatch?.[1]?.trim() || raw.trim();
  return {
    ok,
    reason: reason || (ok ? 'Model judged result satisfactory.' : 'Model judged result unsatisfactory.'),
    method: 'model',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Judge whether `task.result` plausibly satisfies `task.goal`.
 *
 * 1. Heuristic first (cheap, sync): empty / error-sentinel / keyword overlap.
 *    If confident → return immediately.
 * 2. Optional model check only when:
 *    - heuristic was inconclusive, AND
 *    - budget has not been exceeded (overBudget check before the call), AND
 *    - client is available.
 *    Mutates `usage` to account for the model call.
 *    On any model error or budget exhaustion → falls back to a heuristic verdict.
 *
 * Never throws.
 */
export async function verifyTask(
  task: RunTask,
  client: ProviderClient,
  budget: RunBudget,
  usage: RunUsage,
  opts?: { model?: boolean },
): Promise<VerifyVerdict> {
  // Stage 1: heuristic.
  const heuristic = heuristicVerify(task);
  if (heuristic !== null) {
    return heuristic;
  }

  // The optional model check is opt-in. When disabled (the default for the
  // orchestrator's per-task verify, which keeps M4 deterministic accounting
  // intact) the inconclusive heuristic resolves to a lenient pass WITHOUT any
  // model call or usage mutation. verifyTask's own callers (and tests) may
  // enable it explicitly via { model: true }.
  if (opts?.model !== true) {
    return {
      ok: true,
      reason: 'Heuristic pass (non-empty result with no error markers; model check disabled).',
      method: 'heuristic',
    };
  }

  // Heuristic inconclusive — check budget before a model call.
  if (overBudget(usage, budget)) {
    // Budget exhausted: fall back to a lenient heuristic pass (non-empty, no errors).
    return {
      ok: true,
      reason: 'Heuristic pass (budget exhausted; model check skipped).',
      method: 'heuristic',
    };
  }

  // Stage 2: cheap single model call.
  try {
    const messages = buildVerifyMessages(task);
    const result = await client.chat(messages, /* tools */ undefined);

    // Account for the tokens used by the verification call.
    const delta = {
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      steps: 1,
      estCostUsd: 0, // local providers → 0
    };
    const merged = addUsage(usage, delta);
    // Mutate the caller's usage object in-place (same pattern as agent-loop.ts).
    usage.tokensIn = merged.tokensIn;
    usage.tokensOut = merged.tokensOut;
    usage.steps = merged.steps;
    usage.estCostUsd = merged.estCostUsd;

    return parseModelVerdict(result.content);
  } catch {
    // Model check failed — fall back to a lenient heuristic pass.
    return {
      ok: true,
      reason: 'Heuristic pass (model check failed; non-empty result with no error markers).',
      method: 'heuristic',
    };
  }
}

// ---------------------------------------------------------------------------
// M43: Structured verification (typecheck/lint/build/test) + verdict wrapper
// ---------------------------------------------------------------------------

/** Tail of a command's output to surface in a failure verdict (~2KB). */
const FAILURE_TAIL_CHARS = 2 * 1024;

/**
 * A VerifyVerdict enriched with the command that produced it. When a structured
 * (command) verification fails, `command` names the failing command and
 * `failure` carries the tail of its output for the repair loop to feed back.
 */
export interface StructuredVerdict extends VerifyVerdict {
  /** The verify command that produced this verdict (when method === 'command'). */
  command?: string;
  /** Tail of the failing command's output (~2KB), for repair feedback. */
  failure?: string;
}

/**
 * Structured verification for a completed task.
 *
 * When a workspace is available AND execution is permitted AND detectable
 * verify commands exist, run them in order (typecheck → test → lint). The FIRST
 * non-ok command short-circuits to a failure verdict carrying the command + a
 * tail of its output. When every command passes, return an ok 'command' verdict.
 *
 * Otherwise (no workspace, exec not allowed, no cfg, or nothing detected) fall
 * back to the heuristic/model verifyTask, wrapped to the StructuredVerdict shape.
 *
 * Never throws (runVerifyCommandAsync and verifyTask are both non-throwing).
 */
export async function verifyTaskStructured(
  task: RunTask,
  client: ProviderClient,
  budget: RunBudget,
  usage: RunUsage,
  opts: {
    model?: boolean;
    workspaceRoot?: string;
    allowExec?: boolean;
    cfg?: AshlrConfig;
  },
): Promise<StructuredVerdict> {
  const { workspaceRoot, allowExec, cfg } = opts;

  if (workspaceRoot && allowExec && cfg) {
    const commands = detectVerifyCommands(workspaceRoot);
    if (commands.length > 0) {
      for (const vc of commands) {
        const res = await runVerifyCommandAsync(vc, workspaceRoot, cfg);
        if (!res.ok && vc.required !== false) {
          return {
            ok: false,
            method: 'command',
            reason: `${vc.kind} failed: ${res.command}`,
            command: res.command,
            failure: res.output.slice(-FAILURE_TAIL_CHARS),
          };
        }
      }
      return {
        ok: true,
        method: 'command',
        reason: `verify commands passed (${commands.length})`,
      };
    }
  }

  // Fall back to the heuristic/model verdict (already StructuredVerdict-shaped:
  // StructuredVerdict only adds optional fields over VerifyVerdict).
  const verdict = await verifyTask(task, client, budget, usage, { model: opts.model });
  return verdict;
}

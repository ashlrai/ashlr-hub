/**
 * prompts/index.ts — assemble a model-adaptive system prompt from layers.
 *
 * Executor prompts are fully layered (base persona → tool discipline →
 * output contract → executor role → optional memory). Planner / synthesizer
 * prompts are strict format contracts, so they are assembled minimally
 * (optional memory, then the role text LAST so its "return ONLY …" instruction
 * stays the final, strongest line).
 */

import type { AssembleOptions, AssembledPrompt } from './types.js';
import {
  BASE_PERSONA,
  TOOL_DISCIPLINE,
  NO_TOOL_CONTRACT,
  OUTPUT_CONTRACT,
  pick,
} from './layers.js';
import { EXECUTOR_ROLE, PLANNER_ROLE, SYNTHESIZER_ROLE } from './roles.js';
import { composeWithinBudget, type BudgetPart } from './budget.js';

export type { PromptRole, AssembleOptions, AssembledPrompt } from './types.js';

function nonExecutorRoleText(role: AssembleOptions['role']): string {
  switch (role) {
    case 'planner':
      return PLANNER_ROLE;
    case 'synthesizer':
      return SYNTHESIZER_ROLE;
    default:
      return '';
  }
}

export function assembleSystemPrompt(opts: AssembleOptions): AssembledPrompt {
  const cap = opts.charCap ?? opts.profile.promptCharCap;
  const v = opts.profile.verbosity;
  const parts: BudgetPart[] = [];

  if (opts.role === 'executor') {
    parts.push({ key: 'base', text: pick(BASE_PERSONA, v), essential: true });

    let toolText: string;
    if (opts.useTools) {
      toolText = pick(TOOL_DISCIPLINE, v);
      // Weak models that fumble native tool calls get an explicit JSON hint.
      if (opts.profile.toolFormat === 'json' && opts.profile.toolFormatHint) {
        toolText += '\n' + opts.profile.toolFormatHint;
      }
    } else {
      toolText = pick(NO_TOOL_CONTRACT, v);
    }
    parts.push({ key: 'tool', text: toolText, essential: true });
    parts.push({ key: 'output', text: pick(OUTPUT_CONTRACT, v), essential: true });
    parts.push({ key: 'role', text: pick(EXECUTOR_ROLE, v), essential: true });
    if (opts.memory) parts.push({ key: 'memory', text: opts.memory, essential: false });
  } else {
    // planner / synthesizer: memory first (context), role contract last.
    if (opts.memory) parts.push({ key: 'memory', text: opts.memory, essential: false });
    parts.push({ key: 'role', text: nonExecutorRoleText(opts.role), essential: true });
  }

  const { system, included, chars } = composeWithinBudget(parts, cap);
  return { system, included, chars };
}

/** Convenience: the assembled string only. */
export function systemPromptFor(opts: AssembleOptions): string {
  return assembleSystemPrompt(opts).system;
}

/**
 * prompts/budget.ts — single budget authority for assembled system prompts.
 *
 * Essential discipline layers (base/tool/output/role) are always kept; the
 * optional memory layer is truncated to whatever budget remains, or dropped
 * entirely when nothing meaningful fits. This mirrors (and replaces) the ad-hoc
 * genome truncation the orchestrator previously did at GENOME_INJECT_CHAR_CAP.
 */

import type { PromptLayer } from './types.js';

const SEP = '\n\n';
/** Below this many chars, an injected memory block isn't worth including. */
const MIN_MEMORY_CHARS = 80;

export interface BudgetPart {
  key: PromptLayer['key'];
  text: string;
  /** Essential parts are never dropped (only hard-truncated as a last resort). */
  essential: boolean;
}

export interface ComposeResult {
  system: string;
  included: PromptLayer['key'][];
  chars: number;
}

/** Truncate to maxLen, appending '…' when cut. */
function truncate(s: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/**
 * Compose ordered parts into a single system prompt within `charCap`.
 * Order is preserved. Only the (non-essential) memory part is truncated/dropped.
 */
export function composeWithinBudget(
  parts: BudgetPart[],
  charCap: number,
): ComposeResult {
  const present = parts.filter((p) => p.text && p.text.trim().length > 0);
  const memory = present.find((p) => !p.essential);
  const nonMemory = present.filter((p) => p.essential);

  // Fixed cost = essential text + separators between ALL present parts.
  const sepCount = Math.max(0, present.length - 1);
  const fixed =
    nonMemory.reduce((n, p) => n + p.text.length, 0) + sepCount * SEP.length;

  let memText = '';
  if (memory) {
    const allot = charCap - fixed;
    if (allot >= MIN_MEMORY_CHARS) {
      memText =
        memory.text.length <= allot ? memory.text : truncate(memory.text, allot);
    }
  }

  const renderable = present.filter((p) => p.essential || (p === memory && memText));
  const rendered = renderable
    .map((p) => (p === memory ? memText : p.text))
    .join(SEP);

  // Pathological tiny caps: hard-truncate the whole thing as a last resort.
  const system = rendered.length <= charCap ? rendered : truncate(rendered, charCap);
  return {
    system,
    included: renderable.map((p) => p.key),
    chars: system.length,
  };
}

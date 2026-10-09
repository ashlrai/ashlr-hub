/**
 * Two local runtime context shapes, and the guard for moving between
 * them. See docs/LOCAL-CONTEXT-STRATEGY.md.
 *
 * `llama-server` divides `-c` by `--parallel` AT LAUNCH, so a slot cannot borrow
 * from its neighbours and "give the planner the whole window" is a different
 * server shape rather than a request-time option. September 21–22, 2026 trials
 * on a 128 GB machine with a locally named Qwen3.8 27B Q8_0 artifact recorded
 * startup residency with an empty cache (not current or steady-state costs):
 *
 *   plan      1 slot  x 262,144   43.0 GB   read widely, plan, review
 *   execute   4 slots x  65,536   43.4 GB   four targeted edits at once
 *
 * The historical readings do not establish constant memory use or a causal
 * shape-cost difference. Filled cache, artifact, runtime and workload matter.
 * The historical restart took seconds with weights in the OS page cache;
 * that is not a current restart-time guarantee.
 *
 * WHY THIS IS NOT AUTOMATIC. Reshaping restarts llama-server. A restart while a
 * slot is generating kills that turn mid-flight, and the agent sees a truncated
 * stream rather than an error it can act on. So the switch is a deliberate
 * command, and `reshapeBlockedBy` is the guard that refuses to pull the rug out
 * from under work already running.
 */

import type { LlamaSlotCapacity } from './types.js';

export type RuntimeShapeName = 'plan' | 'execute';

export interface RuntimeShape {
  readonly name: RuntimeShapeName;
  /** `--parallel`. */
  readonly slots: number;
  /** `-c`, the TOTAL shared across slots. Per-agent is this divided by slots. */
  readonly context: number;
  /** One line for `--help` and for the reshape result. */
  readonly summary: string;
}

/**
 * Both shapes carry the same requested total context. The upstream Qwen3.8-27B
 * model card reports a native 262,144-token window (linked in the strategy doc);
 * local tag names alone do not prove converted-weight provenance. Equal total
 * context does not guarantee equal residency or quality.
 */
export const RUNTIME_SHAPES: Readonly<Record<RuntimeShapeName, RuntimeShape>> = {
  plan: {
    name: 'plan',
    slots: 1,
    context: 262_144,
    summary: 'one agent with the whole 262,144-token window — read widely, plan, review',
  },
  execute: {
    name: 'execute',
    slots: 4,
    context: 262_144,
    summary: 'four agents at 65,536 each — independent, targeted edits in parallel',
  },
};

/** Per-agent window a shape actually yields. */
export function contextPerAgent(shape: RuntimeShape): number {
  return Math.floor(shape.context / shape.slots);
}

export function resolveRuntimeShape(value: unknown): RuntimeShape | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (key === 'plan' || key === 'execute') return RUNTIME_SHAPES[key];
  return null;
}

/**
 * Is a Claude Code agent's own system prompt going to fit in this shape?
 *
 * Historical September 2026 trial: 23,310 tokens. This existing shape guard's
 * reference is not a measurement of the current CLI/system/tool request. The
 * old 65,536 TOTAL default yielded four 16,384-token slots, smaller than that
 * trial's instructions. Actual request admission also uses context-fit checks.
 */
export const AGENT_SYSTEM_PROMPT_TOKENS = 23_310;

export function headroomPerAgent(shape: RuntimeShape): number {
  return contextPerAgent(shape) - AGENT_SYSTEM_PROMPT_TOKENS;
}

export type ReshapeBlock =
  /** Slots are generating right now; a restart would truncate those turns. */
  | { readonly kind: 'busy'; readonly busy: number; readonly detail: string }
  /** The requested shape cannot hold an agent's system prompt. */
  | { readonly kind: 'too-small'; readonly headroom: number; readonly detail: string }
  /** Already in this shape; restarting would cost the turn for nothing. */
  | { readonly kind: 'already'; readonly detail: string };

export interface ReshapeGuardInput {
  readonly target: RuntimeShape;
  /** Live capacity from `/props` and `/slots`. Null when the runtime is down. */
  readonly capacity: LlamaSlotCapacity | null;
  /** Per-slot context the live server reports, when known. */
  readonly currentContextPerSlot?: number | null;
}

/**
 * Why a reshape should be refused, or `null` when it is safe.
 *
 * Returns the reason rather than throwing, so a caller can present it and offer
 * `--force` instead of losing the command to an exception.
 *
 * A null `capacity` means the runtime is DOWN, which is never a block: starting
 * into the requested shape is exactly right, and there is no turn to interrupt.
 */
export function reshapeBlockedBy(input: ReshapeGuardInput): ReshapeBlock | null {
  const { target, capacity } = input;

  const headroom = headroomPerAgent(target);
  if (headroom <= 0) {
    return {
      kind: 'too-small',
      headroom,
      detail: `${contextPerAgent(target)} tokens per agent does not fit a `
        + `${AGENT_SYSTEM_PROMPT_TOKENS}-token system prompt`,
    };
  }

  if (capacity === null) return null;

  const busy = capacity.busy;
  if (typeof busy === 'number' && busy > 0) {
    return {
      kind: 'busy',
      busy,
      detail: `${busy} slot${busy === 1 ? ' is' : 's are'} generating — reshaping restarts `
        + 'llama-server and would truncate that work mid-stream',
    };
  }

  // Same shape already: same slot count AND same per-slot window. Checking only
  // the slot count would call a 1x262144 runtime "already plan" even if it were
  // actually running 1x65536.
  const sameSlots = capacity.configured === target.slots;
  const current = input.currentContextPerSlot;
  const sameContext = typeof current === 'number' ? current === contextPerAgent(target) : true;
  if (sameSlots && sameContext) {
    return {
      kind: 'already',
      detail: `already running ${target.slots} slot${target.slots === 1 ? '' : 's'} `
        + `at ${contextPerAgent(target).toLocaleString('en-US')} tokens each`,
    };
  }

  return null;
}

/** One line describing a shape, for `--help` and command output. */
export function describeShape(shape: RuntimeShape): string {
  const per = contextPerAgent(shape).toLocaleString('en-US');
  return `${shape.name}: ${shape.slots} slot${shape.slots === 1 ? '' : 's'} x ${per} tokens — ${shape.summary}`;
}

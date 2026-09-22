/**
 * Pins the two runtime shapes and the guard that refuses an unsafe reshape.
 *
 * The numbers here are measured on this machine, not chosen: 23,310 tokens is a
 * real Claude Code system prompt, and 262,144 is Qwen3.8 27B's native trained
 * context.
 */
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_SHAPES,
  resolveRuntimeShape,
  contextPerAgent,
  headroomPerAgent,
  reshapeBlockedBy,
  describeShape,
  AGENT_SYSTEM_PROMPT_TOKENS,
} from '../src/core/local-runtime/llama/shapes.js';
import type { LlamaSlotCapacity } from '../src/core/local-runtime/llama/types.js';

const cap = (configured: number | null, busy: number | null): LlamaSlotCapacity =>
  ({ configured, busy, source: 'props' }) as LlamaSlotCapacity;

describe('runtime shapes', () => {
  it('divides the same total context two different ways', () => {
    // Both shapes carry the same -c so switching changes only the division,
    // which is what keeps the memory footprint essentially constant.
    expect(RUNTIME_SHAPES.plan.context).toBe(RUNTIME_SHAPES.execute.context);
    expect(contextPerAgent(RUNTIME_SHAPES.plan)).toBe(262_144);
    expect(contextPerAgent(RUNTIME_SHAPES.execute)).toBe(65_536);
  });

  it('leaves every shape room for an agents own system prompt', () => {
    // The old 65,536 TOTAL default gave each of 4 slots 16,384 — less than the
    // agent's instructions, with no error reported anywhere.
    for (const shape of Object.values(RUNTIME_SHAPES)) {
      expect(headroomPerAgent(shape)).toBeGreaterThan(0);
    }
    expect(headroomPerAgent(RUNTIME_SHAPES.execute)).toBe(65_536 - AGENT_SYSTEM_PROMPT_TOKENS);
  });

  it('resolves names case-insensitively and rejects anything else', () => {
    expect(resolveRuntimeShape('plan')).toBe(RUNTIME_SHAPES.plan);
    expect(resolveRuntimeShape('  EXECUTE ')).toBe(RUNTIME_SHAPES.execute);
    for (const bad of ['wide', '', undefined, null, 4, {}]) {
      expect(resolveRuntimeShape(bad)).toBeNull();
    }
  });

  it('describes a shape in one line with the per-agent window', () => {
    expect(describeShape(RUNTIME_SHAPES.execute)).toContain('65,536');
    expect(describeShape(RUNTIME_SHAPES.plan)).toContain('1 slot ');
  });
});

describe('reshapeBlockedBy', () => {
  it('refuses while slots are generating, because a restart truncates them', () => {
    const block = reshapeBlockedBy({ target: RUNTIME_SHAPES.plan, capacity: cap(4, 2) });
    expect(block?.kind).toBe('busy');
    expect(block?.detail).toMatch(/truncate/);
  });

  it('allows a reshape when every slot is idle', () => {
    expect(reshapeBlockedBy({ target: RUNTIME_SHAPES.plan, capacity: cap(4, 0) })).toBeNull();
  });

  it('never blocks when the runtime is down — there is no turn to interrupt', () => {
    expect(reshapeBlockedBy({ target: RUNTIME_SHAPES.execute, capacity: null })).toBeNull();
  });

  it('refuses a pointless reshape into the shape already running', () => {
    const block = reshapeBlockedBy({
      target: RUNTIME_SHAPES.execute,
      capacity: cap(4, 0),
      currentContextPerSlot: 65_536,
    });
    expect(block?.kind).toBe('already');
  });

  it('does NOT call it "already" when the slot count matches but the window does not', () => {
    // A 1x65536 runtime is not the plan shape, even though it has one slot.
    // Checking slots alone would refuse a reshape that genuinely needs doing.
    expect(reshapeBlockedBy({
      target: RUNTIME_SHAPES.plan,
      capacity: cap(1, 0),
      currentContextPerSlot: 65_536,
    })).toBeNull();
  });

  it('puts the busy check ahead of the already check', () => {
    // Reshaping into the current shape while busy is still a restart, and still
    // kills the turn. Reporting "already" would make that sound harmless.
    const block = reshapeBlockedBy({
      target: RUNTIME_SHAPES.execute,
      capacity: cap(4, 3),
      currentContextPerSlot: 65_536,
    });
    expect(block?.kind).toBe('busy');
  });

  it('refuses a shape too small to hold the system prompt, even when idle', () => {
    const tiny = { name: 'execute' as const, slots: 4, context: 65_536, summary: 'too small' };
    const block = reshapeBlockedBy({ target: tiny, capacity: cap(4, 0) });
    expect(block?.kind).toBe('too-small');
    expect(block?.detail).toMatch(/does not fit/);
  });

  it('tolerates an unknown busy count rather than blocking on ignorance', () => {
    expect(reshapeBlockedBy({ target: RUNTIME_SHAPES.plan, capacity: cap(4, null) })).toBeNull();
  });
});

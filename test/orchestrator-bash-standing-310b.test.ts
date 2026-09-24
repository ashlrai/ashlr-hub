/**
 * V3.10 R3a (INT4 item 4) — `allowBash` is refused while a standing policy is
 * live (run/orchestrator.ts runGoal). The engineer's bash tool runs agent
 * shell commands in the daemon's own process tree; under standing authority
 * nobody reviews them. The refusal names the standing policy so the reason
 * stays exact after the generic "no OS confinement yet" gate is lifted; an
 * unreadable authority state counts as live. Nothing runs in either case.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const standing = vi.hoisted(() => ({ policy: null as unknown, throws: false }));
vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/effective-config.js')>()),
  currentStandingPolicy: () => {
    if (standing.throws) throw new Error('authority state unreadable');
    return standing.policy;
  },
}));

const { runGoal } = await import('../src/core/run/orchestrator.js');
type AshlrConfig = import('../src/core/types.js').AshlrConfig;
type RunOptions = Parameters<typeof runGoal>[2];

const cfg = {} as AshlrConfig;
const opts = { allowBash: true, engineer: true } as RunOptions;

beforeEach(() => {
  standing.policy = null;
  standing.throws = false;
});

describe('runGoal allowBash under a standing policy', () => {
  it('refuses with the standing-policy reason while a policy is live', async () => {
    standing.policy = { grantId: 'g' };
    await expect(runGoal('do things', cfg, opts)).rejects.toThrow(/refused while a standing policy is live/);
  });

  it('treats an unreadable standing state as live', async () => {
    standing.throws = true;
    await expect(runGoal('do things', cfg, opts)).rejects.toThrow(/refused while a standing policy is live/);
  });

  it('without a policy the existing generic refusal still applies (unchanged)', async () => {
    await expect(runGoal('do things', cfg, opts)).rejects.toThrow(/unavailable until OS-enforced filesystem confinement is active/);
  });
});

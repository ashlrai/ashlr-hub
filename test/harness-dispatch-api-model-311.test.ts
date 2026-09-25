/**
 * V3.11 — runApiModelSandboxed (the local lane) builds its client with the
 * adopted harness's temperature / top_p / reasoning_effort and lowers the
 * per-call output cap to the harness's maxOutputTokens; without a harness the
 * provider defaults and the governed cap apply. Own file: it doMocks the
 * worktree, client and agent loop. No network, no model call; HOME-isolated
 * by setup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DispatchHarness } from '../src/core/run/harness-dispatch.js';
import type { EngineId } from '../src/core/types.js';

function harness(over: Partial<DispatchHarness> = {}): DispatchHarness {
  return { versionId: 'h-0007', effort: {}, sampling: {}, ...over };
}

// ---------------------------------------------------------------------------
// runApiModelSandboxed — client options and the per-call output cap
// ---------------------------------------------------------------------------

describe('runApiModelSandboxed applies the local-lane harness to the client', () => {
  let tmpRepo: string;
  let clientArgs: unknown[][];
  let reservedCaps: number[];

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'ashlr-h311-api-'));
    mkdirSync(join(tmpRepo, '.git'), { recursive: true });
    clientArgs = [];
    reservedCaps = [];
    vi.doMock('../src/core/sandbox/policy.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(),
      assertMayMutate: () => {},
      killSwitchOn: () => false,
    }));
    vi.doMock('../src/core/sandbox/mutation-fence.js', () => ({
      acquireOutwardMutationFence: () => ({}),
      acquireOutwardMutationFenceAsync: async () => ({}),
      ownsOutwardMutationFence: (fence: unknown) => fence !== null,
      releaseOutwardMutationFence: () => {},
    }));
    vi.doMock('../src/core/sandbox/worktree.js', () => {
      const double = {
        createSandbox: (repo: string) => ({ id: 'sb-h', worktreePath: tmpRepo, sourceRepo: repo, branch: 'ashlr-sandbox-h' }),
        borrowSandboxCleanupAuthority: () => ({ outwardFence: {} }),
        removeSandbox: () => {},
        removeSandboxWithBorrowedAuthority: () => {},
        sandboxDiff: () => ({ files: 0, patch: '', insertions: 0, deletions: 0 }),
      };
      return { ...double, createSandboxAsync: async (repo: string) => double.createSandbox(repo) };
    });
    vi.doMock('../src/core/run/provider-client.js', () => ({
      buildOpenAICompatibleClient: (...args: unknown[]) => {
        clientArgs.push(args);
        return { id: 'openai-compat', model: args[2], supportsTools: true };
      },
    }));
    vi.doMock('../src/core/run/agent-loop.js', () => ({
      runTask: async (
        task: { status: string; result?: string },
        _client: unknown,
        ctx: { reserveModelStep?: (n: number) => { maxOutputTokens: number; finalize(s: string, u?: { tokensIn: number; tokensOut: number }): void } | undefined },
      ) => {
        const reservation = ctx.reserveModelStep?.(500);
        if (reservation) {
          reservedCaps.push(reservation.maxOutputTokens);
          reservation.finalize('step', { tokensIn: 1, tokensOut: 1 });
        }
        task.status = 'done';
        task.result = 'no change';
        return task;
      },
    }));
    vi.doMock('../src/core/mcp-native-engineer.js', () => ({ buildEngineerToolSpecs: () => [] }));
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
    vi.restoreAllMocks();
    for (const m of [
      '../src/core/sandbox/policy.js',
      '../src/core/sandbox/mutation-fence.js',
      '../src/core/sandbox/worktree.js',
      '../src/core/run/provider-client.js',
      '../src/core/run/agent-loop.js',
      '../src/core/mcp-native-engineer.js',
    ]) vi.doUnmock(m);
    vi.resetModules();
  });

  async function run(h?: DispatchHarness): Promise<void> {
    const { runApiModelSandboxed } = await import(
      '../src/core/run/sandboxed-engine.js?bust=' + randomUUID()
    ) as typeof import('../src/core/run/sandboxed-engine.js');
    await runApiModelSandboxed('llama-server' as EngineId, 'increment x', { foundry: {} } as never, {
      sourceRepo: tmpRepo, propose: false, ...(h ? { harness: h } : {}),
    });
  }

  it('adopted harness ⇒ temperature, top_p, reasoning_effort and a lower output cap', async () => {
    await run(harness({
      effort: { local: 'medium' },
      sampling: { local: { temperature: 0.2, topP: 0.9, maxOutputTokens: 1024 } },
    }));
    expect(clientArgs).toHaveLength(1);
    expect(clientArgs[0]![4]).toBe(0.2);
    expect(clientArgs[0]![6]).toMatchObject({ topP: 0.9, reasoningEffort: 'medium' });
    expect(reservedCaps).toEqual([1024]);
  });

  it('no harness ⇒ provider defaults and the governed cap', async () => {
    await run();
    expect(clientArgs).toHaveLength(1);
    expect(clientArgs[0]![4]).toBeUndefined();
    const transport = clientArgs[0]![6] as Record<string, unknown>;
    expect(transport).not.toHaveProperty('topP');
    expect(transport).not.toHaveProperty('reasoningEffort');
    expect(reservedCaps).toEqual([4096]);
  });
});

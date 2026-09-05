/**
 * m117.api-model-dispatch.test.ts — M117: api-model engines (local-coder/Ollama)
 * produce real diffs in the autonomous fleet via in-process sandboxed dispatch.
 *
 * Test groups:
 *
 *   1. KNOWN_ENGINE_IDS — 'local-coder' is now in KNOWN_ENGINE_IDS so it reaches
 *      engineInstalled() instead of the arbitrary-binary isBinaryInstalled() path.
 *
 *   2. INSTALL PROBE — engineInstalled for local-coder uses Node http probe (not
 *      curl): Node child process exits 0 when server responds, 1 on ECONNREFUSED.
 *
 *   3. runApiModelSandboxed EXPORT — function is exported from sandboxed-engine.
 *
 *   4. runApiModelSandboxed REJECTS NON-API-MODEL — returns 'failed' when called
 *      with a cli-agent engine.
 *
 *   5. runApiModelSandboxed SANDBOX FAILURE — when sandbox creation throws,
 *      returns status:'failed' with a descriptive result.
 *
 *   6. runApiModelSandboxed FULL ROUND-TRIP (mocked) — mocks worktree, runTask,
 *      buildOpenAICompatibleClient, buildEngineerToolSpecs, selectInboxStore:
 *      asserts that (a) a ProviderClient is built with the correct baseUrl/model,
 *      (b) runTask is called with engineer tools, (c) sandboxDiff result is
 *      captured and filed as a PENDING proposal, (d) returned state is 'done'
 *      with a proposalId.
 *
 *   7. ORCHESTRATOR DISPATCH (mocked) — runGoal with engine='local-coder' and
 *      sandboxEngine:true routes to runApiModelSandboxed (not builtin) and
 *      returns a RunState with status='done'.
 *
 *   8. LIVE INTEGRATION (skipped unless OLLAMA_LIVE=1) — real end-to-end:
 *      runApiModelSandboxed against a real enrolled repo with Ollama running,
 *      asserts a non-empty proposalId and non-empty diff patch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InboxStore } from '../src/core/seams/inbox.js';
import type { Proposal } from '../src/core/types.js';
import {
  PROPOSAL_PERSISTENCE_MISMATCH_REASON,
  PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
} from '../src/core/inbox/persistence-mismatch.js';

function durableInboxStore(
  proposalId: string,
  capturedProposalArgs: unknown[],
): InboxStore {
  const proposals = new Map<string, Proposal>();

  return {
    list: (filter) => [...proposals.values()]
      .filter((proposal) => filter?.status === undefined || proposal.status === filter.status)
      .map((proposal) => structuredClone(proposal)),
    create: (input) => {
      capturedProposalArgs.push(input);
      const proposal: Proposal = {
        ...input,
        id: proposalId,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      proposals.set(proposal.id, structuredClone(proposal));
      return structuredClone(proposal);
    },
    load: (id) => {
      const proposal = proposals.get(id);
      return proposal ? structuredClone(proposal) : null;
    },
    setStatus: (id, status, result) => {
      const proposal = proposals.get(id);
      if (!proposal) return;
      proposals.set(id, {
        ...proposal,
        status,
        ...(result !== undefined ? { result } : {}),
      });
    },
    pendingCount: () => [...proposals.values()]
      .filter((proposal) => proposal.status === 'pending').length,
  };
}

// ---------------------------------------------------------------------------
// 1. KNOWN_ENGINE_IDS — local-coder must be in the set
// ---------------------------------------------------------------------------
describe('M117 — KNOWN_ENGINE_IDS', () => {
  it('local-coder is recognised as a known engine id (reaches engineInstalled path)', async () => {
    // We test this indirectly: buildEngineCommand for local-coder returns null
    // (api-model, no argv) which is the correct pre-condition for the api-model
    // dispatch branch. If it were NOT in KNOWN_ENGINE_IDS, the orchestrator
    // would call isBinaryInstalled('local-coder') instead, which always fails.
    const { buildEngineCommand } = await import('../src/core/run/engines.js');
    const result = buildEngineCommand('local-coder', 'test goal', {} as never, {});
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. INSTALL PROBE — Node http child process, not curl
// ---------------------------------------------------------------------------
describe('M117 — engineInstalled Node-http probe', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('uses a Node child process (process.execPath) not curl for api-model probe', async () => {
    const calls: Array<[string, string[]]> = [];

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        // Scope the stub to the engine PROBE commands only. A blanket
        // spawnSync stub also swallows the real `/bin/ls -lde` ACL check inside
        // private-storage.ts, which makes acquireExecutionAuthority() fail with
        // 'adapter-failed' — surfacing much later as a confusing "execution
        // authority unavailable" error in an unrelated test in this file, since
        // doMock registrations outlive the test that declared them.
        spawnSync: (cmd: string, args?: string[], opts?: object) => {
          if (cmd !== process.execPath && cmd !== 'curl') {
            return (actual.spawnSync as unknown as (
              c: string, a?: string[], o?: object,
            ) => ReturnType<typeof actual.spawnSync>)(cmd, args, opts);
          }
          calls.push([cmd, args ?? []]);
          return { status: 0, stdout: '', stderr: '', pid: 1, output: [] };
        },
      };
    });

    const { engineInstalled } = await import('../src/core/run/engines.js?bust1=' + randomUUID());
    const result = engineInstalled('local-coder');

    // Must have been called with process.execPath (Node), not 'curl'
    const nodeCalls = calls.filter(([cmd]) => cmd === process.execPath);
    const curlCalls = calls.filter(([cmd]) => cmd === 'curl');
    expect(nodeCalls.length).toBeGreaterThan(0);
    expect(curlCalls.length).toBe(0);
    expect(result).toBe(true);
  });

  it('returns false when Node probe exits with status 1 (Ollama not running)', async () => {
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return {
        ...actual,
        // Scoped to the probe commands for the same reason as above — a blanket
        // status:1 stub breaks the real private-storage ACL check.
        spawnSync: (cmd: string, args?: string[], opts?: object) => {
          if (cmd !== process.execPath && cmd !== 'curl') {
            return (actual.spawnSync as unknown as (
              c: string, a?: string[], o?: object,
            ) => ReturnType<typeof actual.spawnSync>)(cmd, args, opts);
          }
          return { status: 1, stdout: '', stderr: '', pid: 1, output: [] };
        },
      };
    });

    const { engineInstalled } = await import('../src/core/run/engines.js?bust2=' + randomUUID());
    expect(engineInstalled('local-coder')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. runApiModelSandboxed EXPORT
// ---------------------------------------------------------------------------
describe('M117 — runApiModelSandboxed export', () => {
  it('is exported from sandboxed-engine', async () => {
    const mod = await import('../src/core/run/sandboxed-engine.js');
    expect(typeof mod.runApiModelSandboxed).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 4. runApiModelSandboxed REJECTS non-api-model engine
// ---------------------------------------------------------------------------
describe('M117 — runApiModelSandboxed rejects cli-agent', () => {
  it('returns status:failed for a cli-agent engine (no api spec)', async () => {
    const { runApiModelSandboxed } = await import('../src/core/run/sandboxed-engine.js');
    const result = await runApiModelSandboxed('claude', 'test goal', {} as never, {
      sourceRepo: '/tmp/fake',
    });
    expect(result.state.status).toBe('failed');
    expect(result.state.result).toMatch(/not an api-model/);
  });
});

// ---------------------------------------------------------------------------
// 5. runApiModelSandboxed SANDBOX FAILURE
// ---------------------------------------------------------------------------
describe('M117 — runApiModelSandboxed sandbox failure', () => {
  it('returns status:failed when sandbox creation throws', async () => {
    // We need a real worktree module mock — use doMock so it applies before import
    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox: () => { throw new Error('no git repo here'); },
      removeSandbox: () => {},
      sandboxDiff: () => ({ files: 0, patch: '', insertions: 0, deletions: 0 }),
    }));

    const mod = await import('../src/core/run/sandboxed-engine.js?bust=' + randomUUID());
    const result = await (mod as typeof import('../src/core/run/sandboxed-engine.js'))
      .runApiModelSandboxed('local-coder', 'test goal', {} as never, {
        sourceRepo: '/tmp/fake-no-git',
      });

    expect(result.state.status).toBe('failed');
    expect(result.state.result).toMatch(/sandbox unavailable/);
    vi.doUnmock('../src/core/sandbox/worktree.js');
  });
});

// ---------------------------------------------------------------------------
// 6. runApiModelSandboxed FULL ROUND-TRIP (mocked)
// ---------------------------------------------------------------------------
describe('M117 — runApiModelSandboxed full round-trip (mocked)', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'ashlr-m117-'));
    mkdirSync(join(tmpRepo, '.git'), { recursive: true });
    writeFileSync(join(tmpRepo, 'hello.ts'), 'const x = 1;\n');

    vi.doMock('../src/core/sandbox/policy.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(),
      assertMayMutate: () => {},
      killSwitchOn: () => false,
    }));

    vi.doMock('../src/core/sandbox/mutation-fence.js', () => ({
      acquireOutwardMutationFence: () => ({}),
      ownsOutwardMutationFence: (fence: unknown) => fence !== null,
      releaseOutwardMutationFence: () => {},
    }));
  });

  afterEach(() => {
    try { rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ok */ }
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/core/sandbox/policy.js');
    vi.doUnmock('../src/core/sandbox/mutation-fence.js');
  });

  it('builds ProviderClient with correct baseUrl/model, calls runTask with engineer tools, files proposal', async () => {
    const fakeProposalId = `prop-${randomUUID().slice(0, 8)}`;
    const capturedClientArgs: unknown[] = [];
    const capturedTaskArgs: unknown[] = [];
    const capturedProposalArgs: unknown[] = [];
    const capturedGateArgs: unknown[] = [];

    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox: (repo: string) => ({
        id: 'sb-test',
        worktreePath: tmpRepo,
        sourceRepo: repo,
        branch: 'ashlr-sandbox-test',
      }),
      borrowSandboxCleanupAuthority: () => ({ outwardFence: {} }),
      removeSandbox: () => {},
      removeSandboxWithBorrowedAuthority: () => {},
      sandboxDiff: () => ({
        files: 1,
        patch: '--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n',
        insertions: 1,
        deletions: 1,
      }),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      buildOpenAICompatibleClient: (...args: unknown[]) => {
        capturedClientArgs.push(...args);
        return { id: 'openai-compat', model: args[2], supportsTools: true };
      },
    }));

    vi.doMock('../src/core/run/agent-loop.js', () => ({
      runTask: async (
        task: { status: string; result?: string },
        _client: unknown,
        ctx: {
          tools?: unknown[];
          adaptivePrompts?: boolean;
          reserveModelStep?: (promptTokenReservation: number) => {
            maxOutputTokens: number;
            finalize(summary: string, usage?: { tokensIn: number; tokensOut: number }): void;
          } | undefined;
        },
      ) => {
        capturedTaskArgs.push(ctx);
        const reservation = ctx.reserveModelStep?.(500);
        if (!reservation) throw new Error('expected api-model token reservation');
        expect(reservation.maxOutputTokens).toBe(4_096);
        reservation.finalize('changed hello.ts', { tokensIn: 11, tokensOut: 7 });
        task.status = 'done';
        task.result = 'Made the change.';
        return task;
      },
    }));

    vi.doMock('../src/core/mcp-native-engineer.js', () => ({
      buildEngineerToolSpecs: () => [
        { name: 'read_file', fn: async () => 'content' },
        { name: 'write_file', fn: async () => 'ok' },
      ],
    }));

    vi.doMock('../src/core/seams/inbox.js', () => ({
      selectInboxStore: () => durableInboxStore(fakeProposalId, capturedProposalArgs),
    }));

    vi.doMock('../src/core/knowledge/index.js', () => ({
      scrubSecrets: (s: string) => s,
    }));

    vi.doMock('../src/core/foundry/provenance.js', () => ({
      hashDiff: () => 'hash-abc',
      signProvenance: () => 'sig-abc',
    }));

    vi.doMock('../src/core/run/completeness-gate.js', () => ({
      runCompletenessGate: async (args: unknown) => {
        capturedGateArgs.push(args);
        return { pass: true };
      },
    }));

    const { runApiModelSandboxed } = await import(
      '../src/core/run/sandboxed-engine.js?bust=' + randomUUID()
    ) as typeof import('../src/core/run/sandboxed-engine.js');

    const cfg = {
      models: { adaptivePrompts: true },
      foundry: {
        models: { 'local-coder': 'qwen2.5:72b-instruct-q4_K_M' },
      },
    } as never;

    const result = await runApiModelSandboxed('local-coder', 'increment x', cfg, {
      sourceRepo: tmpRepo,
      propose: true,
    });

    // ProviderClient built with correct baseUrl and model
    expect(capturedClientArgs[0]).toBe('http://localhost:11434/v1');
    expect(capturedClientArgs[2]).toBe('qwen2.5:72b-instruct-q4_K_M');

    // runTask called with engineer tools
    const taskContext = capturedTaskArgs[0] as {
      tools?: unknown[];
      adaptivePrompts?: boolean;
      reserveModelStep?: unknown;
    };
    expect(Array.isArray(taskContext.tools)).toBe(true);
    expect(taskContext.tools!.length).toBeGreaterThan(0);
    expect(taskContext.adaptivePrompts).toBe(true);
    expect(taskContext.reserveModelStep).toEqual(expect.any(Function));

    // Proposal filed with correct fields
    expect(capturedGateArgs.length).toBe(1);
    expect(capturedProposalArgs.length).toBe(1);
    const proposal = capturedProposalArgs[0] as Record<string, unknown>;
    expect(proposal['engineModel']).toBe('local-coder:qwen2.5:72b-instruct-q4_K_M');
    expect(proposal['engineTier']).toBe('mid');
    expect(typeof proposal['diff']).toBe('string');
    expect((proposal['diff'] as string).length).toBeGreaterThan(0);
    expect(proposal['diffHash']).toBe('hash-abc');
    expect(proposal['provenanceSig']).toBe('sig-abc');
    expect(proposal['runEventSummary']).toMatchObject({
      runId: result.state.id,
      status: 'done',
      outcome: 'filed',
      proposalCreated: true,
      diffFiles: 1,
      diffLines: 2,
      tokensIn: 11,
      tokensOut: 7,
    });
    expect(proposal['runEventSummary']).toMatchObject({
      contextSummary: {
        prompt: {
          role: 'executor',
          profileId: 'local-context-v1',
          toolCount: 2,
        },
        retrieval: {
          source: 'local-context',
        },
        compression: {
          source: 'local-context',
          strategy: 'truncate',
          maxChars: 2_400,
        },
      },
    });
    expect(result.state.runEventSummary?.contextSummary).toMatchObject(
      (proposal['runEventSummary'] as { contextSummary?: unknown }).contextSummary,
    );
    const contextSummaryJson = JSON.stringify(
      (proposal['runEventSummary'] as { contextSummary?: unknown }).contextSummary,
    );
    expect(contextSummaryJson).not.toContain('--- a/hello.ts');
    expect(contextSummaryJson).not.toContain('+++ b/hello.ts');
    expect(contextSummaryJson).not.toContain('changed hello.ts');

    // Result is 'done' with proposalId
    expect(result.state.status).toBe('done');
    expect(result.proposalId).toBe(fakeProposalId);
    expect(result.candidateProposalId).toBeUndefined();
    expect(result.state.steps.length).toBeGreaterThan(0);
    expect(result.state.usage.tokensIn).toBe(11);

    vi.resetModules();
  });

  it('fails closed when a failed api-model producer capture dependency throws', async () => {
    const agentActions: Array<Record<string, unknown>> = [];

    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox: (repo: string) => ({
        id: 'sb-failed-capture',
        worktreePath: tmpRepo,
        sourceRepo: repo,
        branch: 'ashlr-sandbox-test',
      }),
      borrowSandboxCleanupAuthority: () => ({ outwardFence: {} }),
      removeSandbox: () => {},
      removeSandboxWithBorrowedAuthority: () => {},
      sandboxDiff: () => ({
        files: 2,
        patch: '--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n',
        insertions: 3,
        deletions: 1,
      }),
    }));
    vi.doMock('../src/core/run/provider-client.js', () => ({
      buildOpenAICompatibleClient: () => ({ id: 'openai-compat', model: 'local', supportsTools: true }),
    }));
    vi.doMock('../src/core/run/agent-loop.js', () => ({
      runTask: async (task: { status: string; error?: string }) => {
        task.status = 'failed';
        task.error = 'model task failed after editing';
        return task;
      },
    }));
    vi.doMock('../src/core/mcp-native-engineer.js', () => ({
      buildEngineerToolSpecs: () => [{ name: 'write_file', fn: async () => 'ok' }],
    }));
    vi.doMock('../src/core/seams/inbox.js', () => ({
      selectInboxStore: () => { throw new Error('capture dependency exploded with raw patch'); },
    }));
    vi.doMock('../src/core/fleet/agent-action-ledger.js', () => ({
      recordAgentAction: (action: Record<string, unknown>) => agentActions.push(action),
    }));

    const { runApiModelSandboxed } = await import(
      '../src/core/run/sandboxed-engine.js?bust=' + randomUUID(),
    ) as typeof import('../src/core/run/sandboxed-engine.js');
    const result = await runApiModelSandboxed('local-coder', 'increment x', {
      foundry: { models: { 'local-coder': 'qwen' } },
    } as never, {
      sourceRepo: tmpRepo,
      propose: true,
    });

    expect(result).toMatchObject({
      proposalId: undefined,
      proposalOutcome: {
        kind: 'proposal-capture-error',
        reason: 'proposal capture failed before durable proposal filing',
      },
      state: {
        status: 'failed',
        proposalOutcome: { kind: 'proposal-capture-error' },
        runEventSummary: {
          outcome: 'proposal-capture-error',
          proposalCreated: false,
          diffFiles: 2,
          diffLines: 4,
          actionCounts: { proposalCaptureAttempts: 1, proposalBlocked: 1, proposalCreated: 0 },
        },
      },
    });
    expect(result.state.result).toBe('model task failed after editing');
    expect(JSON.stringify(result)).not.toContain('raw patch');
    expect(agentActions).toEqual([expect.objectContaining({
      runId: result.state.id,
      outcome: 'failed',
      reason: 'proposal-capture-error',
      runEventSummary: expect.objectContaining({ outcome: 'proposal-capture-error', proposalCreated: false }),
    })]);
  });

  it('runs the completeness gate before filing an api-model proposal', async () => {
    const capturedProposalArgs: unknown[] = [];
    const capturedGateArgs: unknown[] = [];

    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox: (repo: string) => ({
        id: 'sb-test',
        worktreePath: tmpRepo,
        sourceRepo: repo,
        branch: 'ashlr-sandbox-test',
      }),
      borrowSandboxCleanupAuthority: () => ({ outwardFence: {} }),
      removeSandbox: () => {},
      removeSandboxWithBorrowedAuthority: () => {},
      sandboxDiff: () => ({
        files: 1,
        patch: '--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n',
        insertions: 1,
        deletions: 1,
      }),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      buildOpenAICompatibleClient: () => ({ id: 'openai-compat', model: 'local', supportsTools: true }),
    }));

    vi.doMock('../src/core/run/agent-loop.js', () => ({
      runTask: async (task: { status: string; result?: string }) => {
        task.status = 'done';
        task.result = '[step cap reached — partial result]\nMade the change.';
        return task;
      },
    }));

    vi.doMock('../src/core/mcp-native-engineer.js', () => ({
      buildEngineerToolSpecs: () => [{ name: 'write_file', fn: async () => 'ok' }],
    }));

    vi.doMock('../src/core/seams/inbox.js', () => ({
      selectInboxStore: () => durableInboxStore('partial-review-prop', capturedProposalArgs),
    }));

    vi.doMock('../src/core/knowledge/index.js', () => ({
      scrubSecrets: (s: string) => s,
    }));

    vi.doMock('../src/core/foundry/provenance.js', () => ({
      hashDiff: () => 'hash-abc',
      signProvenance: () => 'sig-abc',
    }));

    vi.doMock('../src/core/run/completeness-gate.js', () => ({
      runCompletenessGate: async (args: unknown) => {
        capturedGateArgs.push(args);
        return { pass: false, reason: 'typecheck failed' };
      },
    }));

    const { runApiModelSandboxed } = await import(
      '../src/core/run/sandboxed-engine.js?bust=' + randomUUID()
    ) as typeof import('../src/core/run/sandboxed-engine.js');

    const result = await runApiModelSandboxed('local-coder', 'increment x', {
      foundry: {
        models: { 'local-coder': 'qwen2.5:72b-instruct-q4_K_M' },
      },
    } as never, {
      sourceRepo: tmpRepo,
      propose: true,
    });

    expect(capturedGateArgs).toHaveLength(1);
    expect(capturedGateArgs[0]).toMatchObject({ isPartial: true });
    expect(capturedProposalArgs).toHaveLength(1);
    expect(capturedProposalArgs[0]).toMatchObject({
      isPartial: true,
      verifyResult: {
        passed: false,
        source: 'capture-gate',
        failed: [expect.stringContaining('typecheck failed')],
      },
    });
    expect(result.state.status).toBe('done');
    expect(result.proposalId).toBe('partial-review-prop');
    expect(result.proposalOutcome).toMatchObject({
      kind: 'filed',
      isPartial: true,
      proposalId: 'partial-review-prop',
      files: 1,
      insertions: 1,
      deletions: 1,
    });
    expect(result.state.proposalOutcome).toMatchObject({
      kind: 'filed',
      isPartial: true,
      proposalId: 'partial-review-prop',
    });

    vi.resetModules();
  });

  it('fails closed when an optimistic pending proposal is not durably loadable', async () => {
    const capturedProposalArgs: unknown[] = [];
    const setStatus = vi.fn();
    let returnMismatchedPending = false;
    let throwOnLoad = false;
    let lastCreated: Record<string, unknown> | null = null;

    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      sandboxDiff: () => ({
        files: 1,
        patch: '--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n',
        insertions: 1,
        deletions: 1,
      }),
    }));

    vi.doMock('../src/core/seams/inbox.js', () => ({
      selectInboxStore: () => ({
        create: (input: Record<string, unknown>) => {
          capturedProposalArgs.push(input);
          lastCreated = {
            ...input,
            id: 'optimistic-only-prop',
            status: 'pending',
            createdAt: new Date().toISOString(),
            isPartial: input['isPartial'] === true,
          };
          return lastCreated;
        },
        load: () => {
          if (throwOnLoad) throw new Error('load failed with raw proposal contents');
          return returnMismatchedPending && lastCreated
            ? { ...lastCreated, repo: '/mismatched-repo' }
            : null;
        },
        setStatus,
      }),
    }));

    vi.doMock('../src/core/knowledge/index.js', () => ({
      scrubSecrets: (s: string) => s,
    }));

    vi.doMock('../src/core/foundry/provenance.js', () => ({
      hashDiff: () => 'hash-abc',
      signProvenance: () => 'sig-abc',
    }));

    vi.doMock('../src/core/run/completeness-gate.js', () => ({
      runCompletenessGate: async () => ({ pass: true }),
    }));

    const { captureSandboxedProposal } = await import(
      '../src/core/run/sandboxed-engine.js?bust=' + randomUUID()
    ) as typeof import('../src/core/run/sandboxed-engine.js');

    const result = await captureSandboxedProposal('local-coder', 'increment x', {
      foundry: {
        models: { 'local-coder': 'qwen2.5:72b-instruct-q4_K_M' },
      },
    } as never, {
      sourceRepo: tmpRepo,
      existingWorktree: {
        id: 'sb-test',
        worktreePath: tmpRepo,
        sourceRepo: tmpRepo,
        branch: 'ashlr-sandbox-test',
      },
      runId: 'run-m117-durable-missing',
    });

    expect(capturedProposalArgs).toHaveLength(1);
    expect(setStatus).not.toHaveBeenCalled();
    expect(result.proposalId).toBeUndefined();
    expect(result.candidateProposalId).toBe('optimistic-only-prop');
    expect(result.proposalOutcome).toMatchObject({
      kind: 'proposal-capture-error',
      reason: 'proposal capture requires persistence reconciliation',
      files: 1,
      insertions: 1,
      deletions: 1,
    });
    expect(result.proposalOutcome).not.toHaveProperty('proposalId');
    expect(result.state.proposalOutcome).toMatchObject({
      kind: 'proposal-capture-error',
    });
    expect(result.state.proposalOutcome).not.toHaveProperty('proposalId');
    expect(result.state.runEventSummary).toMatchObject({
      proposalCreated: false,
    });
    expect(result.state.runEventSummary).not.toHaveProperty('proposalId');

    returnMismatchedPending = true;
    setStatus.mockClear();
    const mismatchResult = await captureSandboxedProposal('local-coder', 'increment x', {
      foundry: {
        models: { 'local-coder': 'qwen2.5:72b-instruct-q4_K_M' },
      },
    } as never, {
      sourceRepo: tmpRepo,
      existingWorktree: {
        id: 'sb-test',
        worktreePath: tmpRepo,
        sourceRepo: tmpRepo,
        branch: 'ashlr-sandbox-test',
      },
      runId: 'run-m117-durable-mismatch',
    });
    expect(mismatchResult.proposalOutcome?.kind).toBe('proposal-capture-error');
    expect(mismatchResult.proposalId).toBeUndefined();
    expect(mismatchResult.candidateProposalId).toBe('optimistic-only-prop');
    expect(mismatchResult.proposalOutcome).not.toHaveProperty('proposalId');
    expect(mismatchResult.state.runEventSummary).toMatchObject({ proposalCreated: false });
    expect(mismatchResult.state.runEventSummary).not.toHaveProperty('proposalId');
    expect(setStatus).toHaveBeenCalledWith(
      'optimistic-only-prop',
      'rejected',
      PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
      PROPOSAL_PERSISTENCE_MISMATCH_REASON,
    );

    throwOnLoad = true;
    setStatus.mockClear();
    const loadFailureResult = await captureSandboxedProposal('local-coder', 'increment x', {
      foundry: { models: { 'local-coder': 'qwen2.5:72b-instruct-q4_K_M' } },
    } as never, {
      sourceRepo: tmpRepo,
      existingWorktree: {
        id: 'sb-test',
        worktreePath: tmpRepo,
        sourceRepo: tmpRepo,
        branch: 'ashlr-sandbox-test',
      },
      runId: 'run-m117-durable-load-throws',
    });
    expect(loadFailureResult).toMatchObject({
      candidateProposalId: 'optimistic-only-prop',
      proposalOutcome: {
        kind: 'proposal-capture-error',
        reason: 'proposal capture requires persistence reconciliation',
      },
    });
    expect(loadFailureResult.proposalId).toBeUndefined();
    expect(loadFailureResult.proposalOutcome).not.toHaveProperty('proposalId');
    expect(loadFailureResult.state.runEventSummary).toMatchObject({ proposalCreated: false });
    expect(loadFailureResult.state.runEventSummary).not.toHaveProperty('proposalId');
    expect(JSON.stringify(loadFailureResult)).not.toContain('raw proposal contents');
    expect(setStatus).not.toHaveBeenCalled();

    vi.resetModules();
  });

  it('blocks tiny docs-only api-model diffs before filing', async () => {
    const capturedProposalArgs: unknown[] = [];
    const capturedGateArgs: unknown[] = [];

    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox: (repo: string) => ({
        id: 'sb-test',
        worktreePath: tmpRepo,
        sourceRepo: repo,
        branch: 'ashlr-sandbox-test',
      }),
      borrowSandboxCleanupAuthority: () => ({ outwardFence: {} }),
      removeSandbox: () => {},
      removeSandboxWithBorrowedAuthority: () => {},
      sandboxDiff: () => ({
        files: 1,
        patch: [
          'diff --git a/README.md b/README.md',
          '--- a/README.md',
          '+++ b/README.md',
          '@@ -0,0 +1,2 @@',
          '+# Notes',
          '+Tiny clarification.',
        ].join('\n'),
        insertions: 2,
        deletions: 0,
      }),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      buildOpenAICompatibleClient: () => ({ id: 'openai-compat', model: 'local', supportsTools: true }),
    }));

    vi.doMock('../src/core/run/agent-loop.js', () => ({
      runTask: async (task: { status: string; result?: string }) => {
        task.status = 'done';
        task.result = 'Made docs change.';
        return task;
      },
    }));

    vi.doMock('../src/core/mcp-native-engineer.js', () => ({
      buildEngineerToolSpecs: () => [{ name: 'write_file', fn: async () => 'ok' }],
    }));

    vi.doMock('../src/core/seams/inbox.js', () => ({
      selectInboxStore: () => ({
        create: (args: unknown) => {
          capturedProposalArgs.push(args);
          return { id: 'should-not-file' };
        },
      }),
    }));

    vi.doMock('../src/core/knowledge/index.js', () => ({
      scrubSecrets: (s: string) => s,
    }));

    vi.doMock('../src/core/run/completeness-gate.js', () => ({
      runCompletenessGate: async (args: unknown) => {
        capturedGateArgs.push(args);
        return { pass: true };
      },
    }));

    const { runApiModelSandboxed } = await import(
      '../src/core/run/sandboxed-engine.js?bust=' + randomUUID()
    ) as typeof import('../src/core/run/sandboxed-engine.js');

    const result = await runApiModelSandboxed('local-coder', 'clarify docs', {
      foundry: {
        models: { 'local-coder': 'qwen2.5:72b-instruct-q4_K_M' },
      },
    } as never, {
      sourceRepo: tmpRepo,
      propose: true,
    });

    expect(capturedGateArgs).toHaveLength(0);
    expect(capturedProposalArgs).toHaveLength(0);
    expect(result.proposalId).toBeUndefined();
    expect(result.proposalOutcome).toMatchObject({
      kind: 'trivial-proposal',
      files: 1,
      insertions: 2,
      deletions: 0,
    });
    expect(result.state.proposalOutcome).toMatchObject({ kind: 'trivial-proposal' });

    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// 7. ORCHESTRATOR DISPATCH (mocked) — runGoal routes api-model to runApiModelSandboxed
// ---------------------------------------------------------------------------
describe('M117 — orchestrator dispatch for api-model engine (mocked)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('runGoal with engine=local-coder routes to runApiModelSandboxed, not builtin', async () => {
    let apiModelSandboxedCalled = false;
    const fakeRunState = {
      id: 'run-test',
      goal: 'test',
      engine: 'local-coder',
      provider: 'openai-compat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      budget: { maxTokens: 50000, maxSteps: 40, allowCloud: false },
      usage: { tokensIn: 10, tokensOut: 20, steps: 1, estCostUsd: 0 },
      tasks: [],
      steps: [],
      status: 'done' as const,
      result: 'Done.',
    };

    vi.doMock('../src/core/run/sandboxed-engine.js', async () => {
      const actual = await vi.importActual('../src/core/run/sandboxed-engine.js');
      return {
        ...(actual as object),
        runApiModelSandboxed: async () => {
          apiModelSandboxedCalled = true;
          return { state: fakeRunState, proposalId: 'prop-mock-1' };
        },
      };
    });

    // Mock engineInstalled to return true for local-coder
    vi.doMock('../src/core/run/engines.js', async () => {
      const actual = await vi.importActual('../src/core/run/engines.js');
      return {
        ...(actual as object),
        engineInstalled: (engine: string) => engine === 'local-coder' ? true : false,
      };
    });

    // This test owns routing only; isolate it from the process-global durable
    // execution lease exercised by the dedicated lifecycle-authority suite.
    vi.doMock('../src/core/util/execution-lease.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/core/util/execution-lease.js')>(),
      acquireExecutionAuthority: () => ({ ok: true, authority: {} }),
      beginExecutionAuthority: () => true,
      finishExecutionAuthority: () => {},
      abandonExecutionAuthority: () => {},
    }));

    vi.doMock('../src/core/util/case-folded-ownership.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/core/util/case-folded-ownership.js')>(),
      acquireCaseFoldedOwnership: () => null,
      completeCaseFoldedOwnership: () => {},
    }));

    vi.doMock('../src/core/util/private-file-write.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/core/util/private-file-write.js')>(),
      writePrivateFileAtomically: () => {},
    }));

    const { runGoal } = await import('../src/core/run/orchestrator.js?bust=' + randomUUID()) as
      typeof import('../src/core/run/orchestrator.js');

    const cfg = {
      foundry: {
        allowedBackends: ['local-coder'],
        models: { 'local-coder': 'qwen2.5:72b-instruct-q4_K_M' },
        sandboxEngines: ['local-coder'],
      },
    } as never;

    const result = await runGoal('increment x', cfg, {
      engine: 'local-coder',
      sandboxEngine: true,
    });

    expect(apiModelSandboxedCalled).toBe(true);
    expect(result.status).toBe('done');
    expect(result.engine).toBe('local-coder');

    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// 8. DURABLE CLI-ENGINE CLAIM LIFECYCLE
// ---------------------------------------------------------------------------
describe('M117 — durable CLI-engine claim lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/core/sandbox/policy.js');
    vi.doUnmock('../src/core/sandbox/worktree.js');
    vi.doUnmock('../src/core/sandbox/mutation-fence.js');
  });

  it.each([
    'pre-entry-abort',
    'kill-switch',
    'sandbox-failure',
    'post-sandbox-abort',
    'mutation-fence-failure',
  ] as const)('retires exclusive stream authority after %s', async (refusal) => {
    const previousHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'ashlr-m117-cli-claim-'));
    process.env.HOME = home;
    const controller = new AbortController();
    if (refusal === 'pre-entry-abort') controller.abort();

    vi.doMock('../src/core/sandbox/policy.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(),
      assertMayMutate: () => {},
      killSwitchOn: () => refusal === 'kill-switch',
    }));
    vi.doMock('../src/core/sandbox/worktree.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/core/sandbox/worktree.js')>(),
      createSandbox: (repo: string) => {
        if (refusal === 'sandbox-failure') throw new Error('fixture sandbox failure');
        if (refusal === 'post-sandbox-abort') controller.abort();
        return { id: 'claim-sb', worktreePath: home, sourceRepo: repo, branch: 'claim-test' };
      },
      borrowSandboxCleanupAuthority: () => ({ outwardFence: {} }),
      removeSandbox: () => {},
      removeSandboxWithBorrowedAuthority: () => {},
    }));
    vi.doMock('../src/core/sandbox/mutation-fence.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/core/sandbox/mutation-fence.js')>(),
      acquireOutwardMutationFence: () => ({}),
      ownsOutwardMutationFence: () => refusal !== 'mutation-fence-failure',
      releaseOutwardMutationFence: () => {},
    }));

    try {
      const streaming = await import('../src/core/run/streaming.js');
      const runId = `cli-claim-${refusal}`;
      const claim = streaming.claimRunOutputStream(runId);
      expect(claim).toBeDefined();
      const streamPath = streaming.runStreamFilePath(runId)!;
      const activeLockPath = `${streamPath}.active.lock`;
      expect(existsSync(activeLockPath)).toBe(true);

      const sandboxed = await import('../src/core/run/sandboxed-engine.js?claim-lifecycle=' + randomUUID()) as
        typeof import('../src/core/run/sandboxed-engine.js');
      const result = await sandboxed.runEngineSandboxed('codex', 'fixture refusal', {
        foundry: {
          models: { codex: 'gpt-5.5' },
          runOutputPersistence: { enabled: true },
        },
      } as never, {
        sourceRepo: home,
        propose: false,
        runId,
        runOutputStreamClaim: claim,
        signal: controller.signal,
      });

      expect(result.state.status).not.toBe('running');
      expect(existsSync(activeLockPath)).toBe(false);
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      utimesSync(streamPath, eightDaysAgo, eightDaysAgo);
      streaming.gcRunStreams(true);
      expect(existsSync(streamPath)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9. DURABLE API-MODEL OUTPUT (exact opt-in only)
// ---------------------------------------------------------------------------
describe('M117 — durable api-model output policy', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'ashlr-m117-stream-'));
    mkdirSync(join(tmpRepo, '.git'), { recursive: true });
    vi.doMock('../src/core/sandbox/policy.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(),
      assertMayMutate: () => {},
      killSwitchOn: () => false,
    }));
    vi.doMock('../src/core/sandbox/mutation-fence.js', () => ({
      acquireOutwardMutationFence: () => ({}),
      ownsOutwardMutationFence: () => true,
      releaseOutwardMutationFence: () => {},
    }));
    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox: (repo: string) => ({
        id: 'sb-stream', worktreePath: tmpRepo, sourceRepo: repo, branch: 'stream-test',
      }),
      borrowSandboxCleanupAuthority: () => ({ outwardFence: {} }),
      removeSandbox: () => {},
      removeSandboxWithBorrowedAuthority: () => {},
      sandboxDiff: () => ({ files: 0, patch: '', insertions: 0, deletions: 0 }),
    }));
    vi.doMock('../src/core/run/provider-client.js', () => ({
      buildOpenAICompatibleClient: () => ({ id: 'local', model: 'qwen', supportsTools: true }),
    }));
    vi.doMock('../src/core/mcp-native-engineer.js', () => ({
      buildEngineerToolSpecs: () => [{ name: 'read_file', safety: 'read', fn: async () => 'ok' }],
    }));
    vi.doMock('../src/core/run/agent-loop.js', () => ({
      runTask: async (
        task: { id: string; goal: string; status: string; result?: string; error?: string },
        _client: unknown,
        ctx: {
          sink?: (event: import('../src/core/types.js').RunStreamEvent) => void;
          onStep(step: import('../src/core/types.js').RunStep): void;
        },
      ) => {
        const ts = new Date().toISOString();
        if (task.goal.includes('fail-stream')) {
          ctx.sink?.({ kind: 'model-delta', taskId: task.id, text: 'api_', ts });
          ctx.sink?.({ kind: 'model-delta', taskId: task.id, text: 'key=super-secret-canary', ts });
          task.status = 'failed';
          task.error = 'provider failed cleanly';
        } else {
          ctx.sink?.({ kind: 'model-delta', taskId: task.id, text: 'useful bounded output', ts });
          ctx.onStep({ ts, taskId: task.id, kind: 'model', summary: 'model completed' });
          task.status = 'done';
          task.result = 'complete';
        }
        return task;
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('is byte-silent unless enabled exactly true and produces reader-compatible lifecycle output', async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = tmpRepo;
    try {
      const { runApiModelSandboxed } = await import(
        '../src/core/run/sandboxed-engine.js?stream=' + randomUUID()
      ) as typeof import('../src/core/run/sandboxed-engine.js');
      const streaming = await import('../src/core/run/streaming.js');

      for (const [runId, setting] of [
        ['api-stream-absent', undefined],
        ['api-stream-false', false],
        ['api-stream-string', 'true'],
      ] as const) {
        const cfg = setting === undefined
          ? { foundry: { models: { 'local-coder': 'qwen' } } }
          : { foundry: {
              models: { 'local-coder': 'qwen' },
              runOutputPersistence: { enabled: setting },
            } };
        await runApiModelSandboxed('local-coder', 'ordinary-stream', cfg as never, {
          sourceRepo: tmpRepo, propose: false, runId,
        });
        expect(streaming.readRunStreamChunk(runId, 0)).toBeUndefined();
      }

      const enabledId = 'api-stream-enabled';
      const enabled = await runApiModelSandboxed('local-coder', 'ordinary-stream', {
        foundry: {
          models: { 'local-coder': 'qwen' },
          runOutputPersistence: { enabled: true },
        },
      } as never, { sourceRepo: tmpRepo, propose: false, runId: enabledId });
      expect(enabled.state.status).toBe('done');
      const read = streaming.readRunStreamChunk(enabledId, 0);
      expect(read).toBeDefined();
      const records = read!.bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(records.map((record) => record.kind)).toEqual([
        'task-start', 'model-delta', 'log', 'task-done',
      ]);
      expect(records.map((record) => record.text).join(' ')).toContain('useful bounded output');
      expect(read!.nextOffset).toBe(read!.bytes.length);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('redacts a split secret and finalizes the sink when the task fails', async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = tmpRepo;
    try {
      const { runApiModelSandboxed } = await import(
        '../src/core/run/sandboxed-engine.js?failure-stream=' + randomUUID()
      ) as typeof import('../src/core/run/sandboxed-engine.js');
      const streaming = await import('../src/core/run/streaming.js');
      const runId = 'api-stream-failed';
      const result = await runApiModelSandboxed('local-coder', 'fail-stream', {
        foundry: {
          models: { 'local-coder': 'qwen' },
          runOutputPersistence: { enabled: true },
        },
      } as never, { sourceRepo: tmpRepo, propose: false, runId });
      expect(result.state.status).toBe('failed');
      const raw = streaming.readRunStreamChunk(runId, 0)!.bytes.toString('utf8');
      expect(raw).toContain('[REDACTED]');
      expect(raw).not.toContain('super-secret-canary');
      expect(raw).not.toContain('api_key');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

// ---------------------------------------------------------------------------
// 10. LIVE INTEGRATION (skipped unless OLLAMA_LIVE=1)
// ---------------------------------------------------------------------------
describe('M117 — live Ollama integration (OLLAMA_LIVE=1 only)', () => {
  const isLive = process.env['OLLAMA_LIVE'] === '1';

  it.skipIf(!isLive)(
    'runApiModelSandboxed produces a non-empty diff proposal against a real worktree',
    async () => {
      // Requires: Ollama running at localhost:11434, qwen2.5:72b-instruct-q4_K_M pulled,
      // and a real enrolled repo at ASHLR_LIVE_REPO env var.
      const repoPath = process.env['ASHLR_LIVE_REPO'];
      if (!repoPath) throw new Error('Set ASHLR_LIVE_REPO to a real enrolled repo path');

      const { runApiModelSandboxed } = await import('../src/core/run/sandboxed-engine.js');
      const cfg = {
        foundry: {
          models: { 'local-coder': 'qwen2.5:72b-instruct-q4_K_M' },
        },
      } as never;

      const result = await runApiModelSandboxed(
        'local-coder',
        'Add a comment "// M117 live test" to the first TypeScript file you find',
        cfg,
        { sourceRepo: repoPath, propose: true },
      );

      expect(result.state.status).toBe('done');
      expect(result.proposalId).toBeTruthy();
      console.info('[M117 live] proposal id:', result.proposalId);
    },
    // 10 min timeout — 72b is slow
    600_000,
  );
});

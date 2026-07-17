/**
 * Adversarial cancellation coverage for sandbox proposal capture.
 *
 * Cancellation before inbox creation aborts capture without filing. Once
 * create() has durably stored a proposal, capture reports it as filed and the
 * producer caller returns ownership of that proposal on its aborted RunState.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxStore } from '../src/core/seams/inbox.js';
import type { Proposal } from '../src/core/types.js';

interface CancellationHarness {
  actions: Array<Record<string, unknown>>;
  createCalls: unknown[];
  lifecycle: string[];
}

function durableInboxStore(
  proposalId: string,
  createCalls: unknown[],
  lifecycle: string[],
  afterCreate?: () => void,
): InboxStore {
  const proposals = new Map<string, Proposal>();

  return {
    list: (filter) => [...proposals.values()]
      .filter((proposal) => filter?.status === undefined || proposal.status === filter.status)
      .map((proposal) => structuredClone(proposal)),
    create: (input) => {
      createCalls.push(input);
      const proposal: Proposal = {
        ...input,
        id: proposalId,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      proposals.set(proposal.id, structuredClone(proposal));
      lifecycle.push(`durable:${proposal.id}`);
      afterCreate?.();
      return structuredClone(proposal);
    },
    load: (id) => {
      const proposal = proposals.get(id);
      return proposal ? structuredClone(proposal) : null;
    },
    setStatus: (id, status, result) => {
      const proposal = proposals.get(id);
      if (!proposal) return false;
      proposals.set(id, {
        ...proposal,
        status,
        ...(result !== undefined ? { result } : {}),
      });
      return true;
    },
    pendingCount: () => [...proposals.values()]
      .filter((proposal) => proposal.status === 'pending').length,
  };
}

function installHarness(opts: {
  repo: string;
  controller: AbortController;
  abortAt: 'gate' | 'create';
  proposalId: string;
  producerStatus?: 'done' | 'failed';
  terminationReason?: 'error-exit';
}): CancellationHarness {
  const actions: Array<Record<string, unknown>> = [];
  const createCalls: unknown[] = [];
  const lifecycle: string[] = [];

  vi.doMock('../src/core/sandbox/worktree.js', () => ({
    createSandbox: (sourceRepo: string) => ({
      id: 'sb-cancellation',
      worktreePath: opts.repo,
      sourceRepo,
      branch: 'ashlr-sandbox-cancellation',
    }),
    removeSandbox: (sandbox: { id: string }) => lifecycle.push(`removed:${sandbox.id}`),
    inspectSandboxSourceRevision: () => ({ ok: true, baseHead: 'test-head', currentHead: 'test-head' }),
    sandboxDiff: () => ({
      files: 1,
      patch: [
        'diff --git a/cancelled.ts b/cancelled.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/cancelled.ts',
        '@@ -0,0 +1 @@',
        '+export const captured = true;',
        '',
      ].join('\n'),
      insertions: 1,
      deletions: 0,
    }),
  }));

  vi.doMock('../src/core/run/provider-client.js', () => ({
    buildOpenAICompatibleClient: () => ({
      id: 'openai-compat',
      model: 'qwen2.5:72b-instruct-q4_K_M',
      supportsTools: true,
    }),
  }));

  vi.doMock('../src/core/run/engines.js', () => ({
    buildEngineCommand: () => ({ bin: 'mock-engine', args: [], cwd: opts.repo }),
    spawnEngine: async () => opts.producerStatus === 'done'
      ? {
          ok: true,
          output: 'producer completed after a paid attempt',
          usage: { tokensIn: 13, tokensOut: 6 },
        }
      : {
          ok: false,
          output: '',
          error: 'producer failed after a paid attempt',
          usage: { tokensIn: 13, tokensOut: 6 },
          ...(opts.terminationReason ? { terminationReason: opts.terminationReason } : {}),
        },
  }));

  vi.doMock('../src/core/run/agent-diagnostics.js', () => ({
    classifyAgentDiagnosticError: () => 'execution',
    measureAgentDiagnosticText: () => ({ present: false, bytes: 0, lines: 0, truncated: false }),
    recordAgentDiagnostic: () => {},
  }));

  vi.doMock('../src/core/sandbox/policy.js', () => ({
    killSwitchOn: () => false,
  }));

  vi.doMock('../src/core/run/agent-loop.js', () => ({
    runTask: async (
      task: { status: string; result?: string },
      _client: unknown,
      ctx: { onStep?: (step: unknown) => void },
    ) => {
      ctx.onStep?.({
        ts: new Date().toISOString(),
        taskId: 't1',
        kind: 'model',
        summary: 'produced a candidate diff',
        usage: { tokensIn: 13, tokensOut: 6, steps: 1, estCostUsd: 0 },
      });
      task.status = 'done';
      task.result = 'candidate complete';
      return task;
    },
  }));

  vi.doMock('../src/core/mcp-native-engineer.js', () => ({
    buildEngineerToolSpecs: () => [],
  }));

  vi.doMock('../src/core/seams/inbox.js', () => ({
    selectInboxStore: () => durableInboxStore(
      opts.proposalId,
      createCalls,
      lifecycle,
      opts.abortAt === 'create' ? () => opts.controller.abort() : undefined,
    ),
  }));

  vi.doMock('../src/core/foundry/provenance.js', () => ({
    hashDiff: () => 'hash-cancellation',
    signProvenance: () => 'sig-cancellation',
  }));

  vi.doMock('../src/core/run/completeness-gate.js', () => ({
    runCompletenessGate: async () => {
      if (opts.abortAt === 'gate') opts.controller.abort();
      return { pass: true };
    },
  }));

  vi.doMock('../src/core/fleet/agent-action-ledger.js', () => ({
    recordAgentAction: (event: Record<string, unknown>) => {
      actions.push(event);
      const summary = event['runEventSummary'] as Record<string, unknown> | undefined;
      lifecycle.push(`action:${String(summary?.['status'] ?? 'unknown')}`);
    },
  }));

  vi.doMock('../src/core/fleet/decisions-ledger.js', () => ({
    recordDecision: vi.fn(),
  }));

  return { actions, createCalls, lifecycle };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('sandbox proposal cancellation commit point', () => {
  it('propagates cancellation before create as an aborted api-model run with usage', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ashlr-capture-cancel-before-'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'seed.ts'), 'export const seed = true;\n');
    const controller = new AbortController();
    const harness = installHarness({
      repo,
      controller,
      abortAt: 'gate',
      proposalId: 'must-not-file',
    });

    try {
      const { runApiModelSandboxed } = await import(
        '../src/core/run/sandboxed-engine.js?cancel-before=' + randomUUID()
      ) as typeof import('../src/core/run/sandboxed-engine.js');

      const result = await runApiModelSandboxed('local-coder', 'capture candidate', {
        foundry: {
          completenessGate: true,
          models: { 'local-coder': 'qwen2.5:72b-instruct-q4_K_M' },
        },
      } as never, {
        sourceRepo: repo,
        propose: true,
        signal: controller.signal,
      });

      expect(result.state).toMatchObject({
        status: 'aborted',
        terminationReason: 'cancelled',
        usage: { tokensIn: 13, tokensOut: 6 },
      });
      expect(result).not.toHaveProperty('proposalId');
      expect(harness.createCalls).toHaveLength(0);
      expect(harness.actions.at(-1)).toMatchObject({
        runEventSummary: { status: 'aborted', tokensIn: 13, tokensOut: 6 },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns a durably created proposal as filed while the api-model run aborts', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ashlr-capture-cancel-after-'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'seed.ts'), 'export const seed = true;\n');
    const controller = new AbortController();
    const proposalId = 'filed-before-cancellation';
    const harness = installHarness({
      repo,
      controller,
      abortAt: 'create',
      proposalId,
    });

    try {
      const { runApiModelSandboxed } = await import(
        '../src/core/run/sandboxed-engine.js?cancel-after=' + randomUUID()
      ) as typeof import('../src/core/run/sandboxed-engine.js');

      const result = await runApiModelSandboxed('local-coder', 'capture candidate', {
        foundry: {
          completenessGate: false,
          models: { 'local-coder': 'qwen2.5:72b-instruct-q4_K_M' },
        },
      } as never, {
        sourceRepo: repo,
        propose: true,
        signal: controller.signal,
      });

      expect(result.state).toMatchObject({
        status: 'aborted',
        terminationReason: 'cancelled',
        usage: { tokensIn: 13, tokensOut: 6 },
        proposalOutcome: { kind: 'filed', proposalId },
      });
      expect(result.proposalId).toBe(proposalId);
      expect(result.proposalOutcome).toMatchObject({ kind: 'filed', proposalId });
      expect(harness.createCalls).toHaveLength(1);
      expect(harness.actions.at(-1)).toMatchObject({
        outcome: 'blocked',
        proposalId,
        runEventSummary: {
          status: 'aborted',
          outcome: 'proposal-created',
          proposalId,
          tokensIn: 13,
          tokensOut: 6,
        },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps successful cli proposal ownership while reporting post-create cancellation', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ashlr-successful-cli-cancel-'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'seed.ts'), 'export const seed = true;\n');
    const controller = new AbortController();
    const proposalId = 'successful-cli-filed-before-cancellation';
    const harness = installHarness({
      repo,
      controller,
      abortAt: 'create',
      proposalId,
      producerStatus: 'done',
    });

    try {
      const { runEngineSandboxed } = await import(
        '../src/core/run/sandboxed-engine.js?successful-cli-cancel=' + randomUUID()
      ) as typeof import('../src/core/run/sandboxed-engine.js');

      const result = await runEngineSandboxed('claude', 'capture successful producer work', {
        models: { providerChain: [] },
        foundry: {
          completenessGate: false,
          dispatchRetries: 0,
          fleetMcp: false,
          models: { claude: 'claude-sonnet-4-5' },
        },
      } as never, {
        sourceRepo: repo,
        propose: true,
        signal: controller.signal,
      });

      expect(result.state).toMatchObject({
        status: 'aborted',
        terminationReason: 'cancelled',
        usage: { tokensIn: 13, tokensOut: 6 },
        proposalOutcome: { kind: 'filed', proposalId },
      });
      expect(result.proposalId).toBe(proposalId);
      expect(result.proposalOutcome).toMatchObject({ kind: 'filed', proposalId });
      expect(harness.createCalls).toHaveLength(1);
      expect(harness.actions.at(-1)).toMatchObject({
        outcome: 'blocked',
        proposalId,
        runEventSummary: {
          status: 'aborted',
          outcome: 'proposal-created',
          proposalId,
          tokensIn: 13,
          tokensOut: 6,
        },
      });
      expect(harness.lifecycle).toEqual([
        `durable:${proposalId}`,
        'action:aborted',
        'removed:sb-cancellation',
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports failed-producer capture cancellation before create as aborted', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ashlr-failed-producer-cancel-before-'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'seed.ts'), 'export const seed = true;\n');
    const controller = new AbortController();
    const harness = installHarness({
      repo,
      controller,
      abortAt: 'gate',
      proposalId: 'failed-producer-must-not-file',
    });

    try {
      const { runEngineSandboxed } = await import(
        '../src/core/run/sandboxed-engine.js?failed-producer-cancel-before=' + randomUUID()
      ) as typeof import('../src/core/run/sandboxed-engine.js');

      const result = await runEngineSandboxed('claude', 'capture failed producer work', {
        models: { providerChain: [] },
        foundry: {
          completenessGate: true,
          dispatchRetries: 0,
          fleetMcp: false,
          models: { claude: 'claude-sonnet-4-5' },
        },
      } as never, {
        sourceRepo: repo,
        propose: true,
        signal: controller.signal,
      });

      expect(result.state).toMatchObject({
        status: 'aborted',
        terminationReason: 'cancelled',
        usage: { tokensIn: 13, tokensOut: 6 },
      });
      expect(result).not.toHaveProperty('proposalId');
      expect(result).not.toHaveProperty('proposalOutcome');
      expect(harness.createCalls).toHaveLength(0);
      expect(harness.actions.at(-1)).toMatchObject({
        outcome: 'blocked',
        runEventSummary: {
          status: 'aborted',
          tokensIn: 13,
          tokensOut: 6,
        },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not let a failed-capture abort relabel an authoritative error exit', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ashlr-error-exit-capture-race-'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'seed.ts'), 'export const seed = true;\n');
    const controller = new AbortController();
    const harness = installHarness({
      repo,
      controller,
      abortAt: 'gate',
      proposalId: 'error-exit-must-not-file',
      terminationReason: 'error-exit',
    });

    try {
      const { runEngineSandboxed } = await import(
        '../src/core/run/sandboxed-engine.js?error-exit-capture-race=' + randomUUID()
      ) as typeof import('../src/core/run/sandboxed-engine.js');

      const result = await runEngineSandboxed('claude', 'preserve failed producer truth', {
        models: { providerChain: [] },
        foundry: {
          completenessGate: true,
          dispatchRetries: 0,
          fleetMcp: false,
          models: { claude: 'claude-sonnet-4-5' },
        },
      } as never, {
        sourceRepo: repo,
        propose: true,
        signal: controller.signal,
      });

      expect(controller.signal.aborted).toBe(true);
      expect(result.state).toMatchObject({
        status: 'failed',
        terminationReason: 'error-exit',
        usage: { tokensIn: 13, tokensOut: 6 },
      });
      expect(result.state.result).toContain('producer failed after a paid attempt');
      expect(result).not.toHaveProperty('proposalId');
      expect(harness.createCalls).toHaveLength(0);
      expect(harness.actions.at(-1)).toMatchObject({
        runEventSummary: {
          status: 'failed',
          tokensIn: 13,
          tokensOut: 6,
        },
      });
      expect(harness.lifecycle.at(-1)).toBe('removed:sb-cancellation');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps failed-producer proposal ownership while reporting capture cancellation', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ashlr-failed-producer-cancel-'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'seed.ts'), 'export const seed = true;\n');
    const controller = new AbortController();
    const proposalId = 'failed-producer-filed-before-cancellation';
    const harness = installHarness({
      repo,
      controller,
      abortAt: 'create',
      proposalId,
    });

    try {
      const { runEngineSandboxed } = await import(
        '../src/core/run/sandboxed-engine.js?failed-producer-cancel=' + randomUUID()
      ) as typeof import('../src/core/run/sandboxed-engine.js');

      const result = await runEngineSandboxed('claude', 'capture failed producer work', {
        models: { providerChain: [] },
        foundry: {
          completenessGate: false,
          dispatchRetries: 0,
          fleetMcp: false,
          models: { claude: 'claude-sonnet-4-5' },
        },
      } as never, {
        sourceRepo: repo,
        propose: true,
        signal: controller.signal,
      });

      expect(result.state).toMatchObject({
        status: 'aborted',
        terminationReason: 'cancelled',
        usage: { tokensIn: 13, tokensOut: 6 },
        proposalOutcome: { kind: 'filed', proposalId, isPartial: true },
      });
      expect(result.proposalId).toBe(proposalId);
      expect(result.proposalOutcome).toMatchObject({ kind: 'filed', proposalId, isPartial: true });
      expect(harness.createCalls).toHaveLength(1);
      expect(harness.actions.at(-1)).toMatchObject({
        outcome: 'blocked',
        proposalId,
        runEventSummary: {
          status: 'aborted',
          proposalId,
          tokensIn: 13,
          tokensOut: 6,
        },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxStore } from '../src/core/seams/inbox.js';
import type { Proposal } from '../src/core/types.js';

type CaptureMode = 'durable' | 'missing' | 'mismatch' | 'throw';
type ProducerKind = 'api' | 'cli';

describe('M470 - proposal capture candidate identity', () => {
  let repo: string;
  let captureMode: CaptureMode;
  let nextProposalId: string;
  let agentActions: Array<Record<string, unknown>>;
  let onProposalLoad: (() => void) | undefined;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ashlr-m470-'));
    mkdirSync(join(repo, '.git'), { recursive: true });
    captureMode = 'durable';
    nextProposalId = 'candidate-proposal';
    agentActions = [];
    onProposalLoad = undefined;

    vi.doMock('../src/core/sandbox/worktree.js', () => ({
      createSandbox: (sourceRepo: string) => ({
        id: 'sb-m470',
        worktreePath: repo,
        sourceRepo,
        branch: 'ashlr-sandbox-m470',
      }),
      borrowSandboxCleanupAuthority: () => ({ outwardFence: {} }),
      removeSandbox: () => {},
      removeSandboxWithBorrowedAuthority: () => {},
      sandboxDiff: () => ({
        files: 1,
        patch: [
          'diff --git a/candidate.ts b/candidate.ts',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/candidate.ts',
          '@@ -0,0 +1 @@',
          '+export const candidate = true;',
          '',
        ].join('\n'),
        insertions: 1,
        deletions: 0,
      }),
    }));

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

    vi.doMock('../src/core/run/engines.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/core/run/engines.js')>(),
      buildEngineCommand: () => ({ bin: 'mock-engine', args: [], cwd: repo }),
      spawnEngine: async () => ({
        ok: true,
        output: 'producer completed',
        usage: { tokensIn: 5, tokensOut: 3 },
      }),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      buildOpenAICompatibleClient: () => ({
        id: 'openai-compat',
        model: 'qwen2.5:72b-instruct-q4_K_M',
        supportsTools: true,
      }),
    }));

    vi.doMock('../src/core/run/agent-loop.js', () => ({
      runTask: async (task: { status: string; result?: string }) => {
        task.status = 'done';
        task.result = 'producer completed';
        return task;
      },
    }));

    vi.doMock('../src/core/mcp-native-engineer.js', () => ({
      buildEngineerToolSpecs: () => [],
    }));

    vi.doMock('../src/core/seams/inbox.js', () => ({
      selectInboxStore: (): InboxStore => {
        let created: Proposal | undefined;
        return {
          list: () => [],
          create: (input) => {
            created = {
              ...input,
              id: nextProposalId,
              status: 'pending',
              createdAt: new Date().toISOString(),
            };
            return structuredClone(created);
          },
          load: () => {
            onProposalLoad?.();
            if (captureMode === 'throw') {
              throw new Error('RAW_CAPTURE_EXCEPTION secret-proposal-body');
            }
            if (captureMode === 'missing' || !created) return null;
            if (captureMode === 'mismatch') {
              return { ...structuredClone(created), repo: '/mismatched-repo' };
            }
            return structuredClone(created);
          },
          setStatus: () => {},
          pendingCount: () => 0,
        };
      },
    }));

    vi.doMock('../src/core/foundry/provenance.js', () => ({
      hashDiff: () => 'hash-m470',
      signProvenance: () => 'sig-m470',
    }));

    vi.doMock('../src/core/run/completeness-gate.js', () => ({
      runCompletenessGate: async () => ({ pass: true }),
    }));

    vi.doMock('../src/core/fleet/agent-action-ledger.js', () => ({
      recordAgentAction: (event: Record<string, unknown>) => agentActions.push(event),
    }));

    vi.doMock('../src/core/fleet/decisions-ledger.js', () => ({
      recordDecision: vi.fn(),
    }));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function runProducer(kind: ProducerKind, signal?: AbortSignal) {
    const mod = await import(
      '../src/core/run/sandboxed-engine.js?m470=' + randomUUID()
    ) as typeof import('../src/core/run/sandboxed-engine.js');
    const cfg = {
      models: { providerChain: [] },
      foundry: {
        completenessGate: false,
        dispatchRetries: 0,
        fleetMcp: false,
        models: {
          claude: 'claude-sonnet-4-5',
          'local-coder': 'qwen2.5:72b-instruct-q4_K_M',
        },
      },
    } as never;
    const opts = {
      sourceRepo: repo,
      propose: true,
      runId: `attempt-${randomUUID()}`,
      ...(signal ? { signal } : {}),
    };

    return kind === 'api'
      ? mod.runApiModelSandboxed('local-coder', 'capture candidate identity', cfg, opts)
      : mod.runEngineSandboxed('claude', 'capture candidate identity', cfg, opts);
  }

  it.each<ProducerKind>(['api', 'cli'])(
    'returns an authoritative proposal id only after %s persistence is verified',
    async (kind) => {
      nextProposalId = `${kind}-durable-proposal`;

      const result = await runProducer(kind);

      expect(result.proposalId).toBe(nextProposalId);
      expect(result.candidateProposalId).toBeUndefined();
      expect(result.proposalOutcome).toMatchObject({
        kind: 'filed',
        proposalId: nextProposalId,
      });
      expect(result.state.runEventSummary).toMatchObject({
        proposalId: nextProposalId,
        proposalCreated: true,
      });
    },
  );

  it.each([
    ['api', 'missing'],
    ['api', 'mismatch'],
    ['api', 'throw'],
    ['cli', 'missing'],
    ['cli', 'mismatch'],
    ['cli', 'throw'],
  ] as const)(
    'preserves %s %s persistence identity only as a candidate',
    async (kind, mode) => {
      captureMode = mode;
      nextProposalId = `${kind}-${mode}-candidate`;

      const result = await runProducer(kind);

      expect(result.proposalId).toBeUndefined();
      expect(result.candidateProposalId).toBe(nextProposalId);
      expect(result.proposalOutcome).toMatchObject({
        kind: 'proposal-capture-error',
        reason: 'proposal capture requires persistence reconciliation',
      });
      expect(result.proposalOutcome).not.toHaveProperty('proposalId');
      expect(result.state.proposalOutcome).not.toHaveProperty('proposalId');
      expect(result.state.runEventSummary).toMatchObject({ proposalCreated: false });
      expect(result.state.runEventSummary).not.toHaveProperty('proposalId');
      expect(JSON.stringify(agentActions)).not.toContain(nextProposalId);
      expect(JSON.stringify(result)).not.toContain('RAW_CAPTURE_EXCEPTION');
      expect(JSON.stringify(result)).not.toContain('secret-proposal-body');
    },
  );

  it.each([
    ['api', 'missing'],
    ['api', 'throw'],
    ['cli', 'missing'],
    ['cli', 'throw'],
  ] as const)(
    'keeps the %s %s candidate non-authoritative when cancellation races reconciliation',
    async (kind, mode) => {
      const controller = new AbortController();
      captureMode = mode;
      nextProposalId = `${kind}-${mode}-cancelled-candidate`;
      onProposalLoad = () => controller.abort();

      const result = await runProducer(kind, controller.signal);

      expect(result.state.status).toBe('aborted');
      expect(result.proposalId).toBeUndefined();
      expect(result.candidateProposalId).toBe(nextProposalId);
      expect(result.proposalOutcome).toMatchObject({
        kind: 'proposal-capture-error',
        reason: 'proposal capture requires persistence reconciliation',
      });
      expect(result.proposalOutcome).not.toHaveProperty('proposalId');
      expect(result.state.runEventSummary).toMatchObject({ proposalCreated: false });
      expect(result.state.runEventSummary).not.toHaveProperty('proposalId');
      expect(JSON.stringify(agentActions)).not.toContain(nextProposalId);
      expect(JSON.stringify(result)).not.toContain('RAW_CAPTURE_EXCEPTION');
      expect(JSON.stringify(result)).not.toContain('secret-proposal-body');
    },
  );
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const recordDecision = vi.fn();

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  recordDecision,
  readDecisions: vi.fn(() => {
    const rows: unknown[] = [];
    Object.defineProperty(rows, 'sourceQuality', {
      value: {
        sourceState: 'healthy', sourcePresent: true, complete: true,
        stopReasons: [], filesRead: 0, bytesRead: 0, rowsScanned: 0,
        invalidRows: 0, unreadableFiles: 0,
      },
      enumerable: false,
    });
    return rows;
  }),
}));

vi.mock('../src/core/sandbox/worktree.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/sandbox/worktree.js')>();
  return {
    ...real,
    sandboxDiff: () => ({
      files: 1,
      patch: `diff --git a/src/fix.ts b/src/fix.ts\n${Array.from({ length: 20 }, (_, i) => `+const value${i} = ${i};`).join('\n')}`,
      insertions: 20,
      deletions: 0,
    }),
  };
});

vi.mock('../src/core/run/completeness-gate.js', () => ({
  runCompletenessGate: vi.fn(async () => ({ pass: true })),
}));

vi.mock('../src/core/knowledge/index.js', () => ({
  scrubSecrets: (value: string) => value,
}));

vi.mock('../src/core/foundry/provenance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/foundry/provenance.js')>();
  return {
    ...real,
    hashDiff: () => 'shared-diff-hash',
    signProvenance: () => 'shared-signature',
    verifyProvenance: (proposal: { provenanceSig?: string }) => ({
      ok: proposal.provenanceSig === 'shared-signature',
      reason: 'test legacy provenance',
    }),
    signProducerProvenanceV2: () => 'shared-producer-signature',
    verifyProducerProvenanceV2: (proposal: {
      producerProvenanceVersion?: number;
      producerProvenanceSig?: string;
    }) => ({
      ok: proposal.producerProvenanceVersion === 2 &&
        proposal.producerProvenanceSig === 'shared-producer-signature',
      reason: 'test producer provenance v2',
    }),
  };
});

vi.mock('../src/core/run/engines.js', () => ({
  buildEngineCommand: vi.fn(() => ({ cmd: 'mock-engine', args: [] })),
  spawnEngine: vi.fn(async () => ({
    ok: true,
    output: 'completed',
    usage: { tokensIn: 10, tokensOut: 5 },
  })),
}));

describe('M259 diff dedup producer credit', () => {
  const originalHome = process.env.HOME;
  const originalAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-m259-credit-'));
    process.env.HOME = home;
    process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
    recordDecision.mockClear();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    else process.env.ASHLR_TEST_ALLOW_ANY_REPO = originalAllowAnyRepo;
    rmSync(home, { recursive: true, force: true });
  });

  it('does not file or emit proposed telemetry for a reused proposal id', async () => {
    const { createProposal, loadProposal } = await import('../src/core/inbox/store.js');
    const existing = createProposal({
      repo: '/tmp/repo',
      origin: 'agent',
      kind: 'patch',
      title: 'original producer',
      summary: 'original producer summary',
      diff: 'original diff bytes',
      diffHash: 'shared-diff-hash',
      runId: 'run-original',
      workItemId: '/tmp/repo:issue:original',
      workSource: 'issue',
      engineModel: 'claude:claude-sonnet-5',
      engineTier: 'frontier',
      provenanceSig: 'shared-signature',
    });

    const { captureSandboxedProposal } = await import('../src/core/run/sandboxed-engine.js');
    const result = await captureSandboxedProposal('codex', 'retry the same fix', {
      foundry: { completenessGate: true },
    } as never, {
      sourceRepo: '/tmp/repo',
      existingWorktree: {
        id: 'sandbox-retry',
        sourceRepo: '/tmp/repo',
        worktreePath: '/tmp/repo',
        branch: 'ashlr-sandbox-retry',
      },
      runId: 'run-retry',
      workItemId: '/tmp/repo:issue:original',
    });

    expect(result.proposalId).toBeUndefined();
    expect(result.proposalOutcome).toMatchObject({
      kind: 'proposal-disabled',
      reason: `duplicate diff skipped; existing pending proposal ${existing.id} remains authoritative`,
    });
    expect(recordDecision).not.toHaveBeenCalled();
    expect(loadProposal(existing.id)).toMatchObject({
      id: existing.id,
      status: 'pending',
      runId: 'run-original',
      engineModel: 'claude:claude-sonnet-5',
      producerProvenanceVersion: 2,
      producerProvenanceSig: 'shared-producer-signature',
    });
    expect(readdirSync(join(home, '.ashlr', 'inbox')).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  });

  it('does not report the direct sandbox producer path as newly filed', async () => {
    const { createProposal, loadProposal } = await import('../src/core/inbox/store.js');
    const existing = createProposal({
      repo: '/tmp/repo',
      origin: 'agent',
      kind: 'patch',
      title: 'first direct producer',
      summary: 'first direct producer summary',
      diff: 'original diff bytes',
      diffHash: 'shared-diff-hash',
      runId: 'run-first-direct',
      workItemId: '/tmp/repo:issue:first-direct',
      workSource: 'issue',
      engineModel: 'claude:claude-sonnet-5',
      engineTier: 'frontier',
      provenanceSig: 'shared-signature',
    });

    const { runEngineSandboxed } = await import('../src/core/run/sandboxed-engine.js');
    const result = await runEngineSandboxed('codex', 'retry through direct capture', {
      version: 1,
      models: {},
      foundry: { completenessGate: true, fleetMcp: false },
    } as never, {
      sourceRepo: '/tmp/repo',
      existingWorktree: {
        id: 'sandbox-direct-retry',
        sourceRepo: '/tmp/repo',
        worktreePath: '/tmp/repo',
        branch: 'ashlr-sandbox-direct-retry',
      },
      runId: 'run-direct-retry',
      workItemId: '/tmp/repo:issue:first-direct',
    });

    expect(result.proposalId).toBeUndefined();
    expect(result.proposalOutcome).toMatchObject({
      kind: 'proposal-disabled',
      reason: `duplicate diff skipped; existing pending proposal ${existing.id} remains authoritative`,
    });
    expect(recordDecision).not.toHaveBeenCalled();
    expect(loadProposal(existing.id)).toMatchObject({
      runId: 'run-first-direct',
      engineModel: 'claude:claude-sonnet-5',
      producerProvenanceVersion: 2,
      producerProvenanceSig: 'shared-producer-signature',
    });
    expect(readdirSync(join(home, '.ashlr', 'inbox')).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  });
});

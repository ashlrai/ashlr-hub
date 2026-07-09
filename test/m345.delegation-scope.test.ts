import { describe, expect, it } from 'vitest';
import {
  normalizeDelegationScope,
  renderDelegationScopeForPrompt,
  scopeFromWorkItem,
  scopeHintFiles,
  summarizeDelegationScope,
} from '../src/core/run/delegation-scope.js';
import type { WorkItem } from '../src/core/types.js';

describe('M345 delegation scope contract', () => {
  it('normalizes advisory file scope, budgets, backend, and result contracts', () => {
    const scope = normalizeDelegationScope({
      allowedFiles: {
        include: [
          '/Users/mason/project/src/index.ts',
          './src/index.ts',
          'src/routes/api.ts',
          '../outside.ts',
        ],
        exclude: ['.env', 'secrets/token=ghp_1234567890abcdefABCDEF.txt'],
        enforceWrites: true,
      },
      contextBudget: {
        maxPromptChars: 12_345.9,
        memoryChars: Number.POSITIVE_INFINITY,
      },
      memoryMode: 'repo-only',
      resultContract: {
        kind: 'proposal',
        requireDiff: true,
        requireProposal: true,
        maxChangedFiles: 4.8,
      },
      backend: {
        engine: 'codex',
        model: 'gpt-5.5',
        tier: 'frontier',
        assignedBy: 'router token=ghp_1234567890abcdefABCDEF',
      },
    }, {
      origin: 'daemon',
      sourceRepo: '/Users/mason/project',
      objective: `ship safely with Bearer ${'a'.repeat(32)}`,
      budget: { maxTokens: 5000.7, maxSteps: 12, allowCloud: true },
    });

    expect(scope).toMatchObject({
      schemaVersion: 1,
      origin: 'daemon',
      sourceRepo: '/Users/mason/project',
      objective: 'ship safely with Bearer [REDACTED]',
      allowedFiles: {
        include: ['src/index.ts', 'src/routes/api.ts'],
        exclude: ['.env', 'secrets/token=[REDACTED]'],
        enforceWrites: true,
      },
      budget: { maxTokens: 5000, maxSteps: 12, allowCloud: true },
      contextBudget: { maxPromptChars: 12345 },
      memoryMode: 'repo-only',
      resultContract: {
        kind: 'proposal',
        requireDiff: true,
        requireProposal: true,
        maxChangedFiles: 4,
      },
      backend: {
        engine: 'codex',
        model: 'gpt-5.5',
        tier: 'frontier',
        assignedBy: 'router token=[REDACTED]',
      },
    });
  });

  it('summarizes large file lists without persisting every hint', () => {
    const summary = summarizeDelegationScope({
      origin: 'best-of-n',
      sourceRepo: '/tmp/repo',
      allowedFiles: {
        include: Array.from({ length: 40 }, (_, i) => `src/file-${i}.ts`),
        exclude: ['dist/**'],
      },
      memoryMode: 'bounded',
      resultContract: { kind: 'verified-proposal', requireVerification: true },
    });

    expect(summary).toMatchObject({
      schemaVersion: 1,
      origin: 'best-of-n',
      sourceRepo: '/tmp/repo',
      allowedFiles: {
        includeCount: 32,
        excludeCount: 1,
        includeSamples: [
          'src/file-0.ts',
          'src/file-1.ts',
          'src/file-2.ts',
          'src/file-3.ts',
          'src/file-4.ts',
          'src/file-5.ts',
        ],
        excludeSamples: ['dist/**'],
      },
      memoryMode: 'bounded',
      resultContract: { kind: 'verified-proposal', requireVerification: true },
    });
    expect(JSON.stringify(summary)).not.toContain('src/file-39.ts');
  });

  it('renders a compact prompt prefix and file hints without leaking absolute paths', () => {
    const scope = normalizeDelegationScope({
      origin: 'run',
      sourceRepo: '/Users/mason/project',
      executionRoot: '/Users/mason/project/.worktree',
      allowedFiles: { include: ['/Users/mason/project/src/fleet/status.ts'], exclude: ['.env'] },
      contextBudget: { maxPromptChars: 6000 },
      memoryMode: 'none',
      resultContract: { kind: 'analysis-only' },
      backend: { engine: 'local-coder', model: 'qwen' },
    });

    const prefix = renderDelegationScopeForPrompt(scope);

    expect(scopeHintFiles(scope)).toEqual(['src/fleet/status.ts']);
    expect(prefix).toContain('Delegation scope:');
    expect(prefix).toContain('Memory mode: none');
    expect(prefix).toContain('Focus files: src/fleet/status.ts');
    expect(prefix).toContain('Avoid files: .env');
    expect(prefix).not.toContain('/Users/mason/project');
  });

  it('derives a daemon proposal scope from a work item', () => {
    const item: WorkItem = {
      id: 'repo:todo:abc',
      repo: '/tmp/repo',
      source: 'todo',
      title: 'Fix missing verification contract',
      detail: 'Add verifier',
      value: 5,
      effort: 2,
      score: 8,
      tags: ['verification'],
      ts: '2026-07-09T00:00:00.000Z',
    };

    expect(scopeFromWorkItem(item, { backend: { engine: 'codex', model: 'gpt-5.5' } })).toMatchObject({
      origin: 'daemon',
      sourceRepo: '/tmp/repo',
      workItemId: 'repo:todo:abc',
      workSource: 'todo',
      objective: 'Fix missing verification contract',
      resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
      backend: { engine: 'codex', model: 'gpt-5.5' },
    });
  });
});

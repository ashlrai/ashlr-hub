import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({
  spawnEngine: vi.fn(async () => ({ ok: true, output: '' })),
  buildProvider: vi.fn(() => ({ id: 'openai-compat', model: 'local', supportsTools: true })),
  runTask: vi.fn(async (task: { status: string }) => {
    task.status = 'done';
    return task;
  }),
}));

vi.mock('../src/core/run/engines.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/run/engines.js')>()),
  buildEngineCommand: vi.fn(() => ({ command: 'node', args: ['-e', ''] })),
  spawnEngine: mocks.spawnEngine,
}));

vi.mock('../src/core/run/provider-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/run/provider-client.js')>()),
  buildOpenAICompatibleClient: mocks.buildProvider,
}));

vi.mock('../src/core/run/agent-loop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/run/agent-loop.js')>()),
  runTask: mocks.runTask,
}));

import {
  createSandbox,
  inspectSandboxSourceRevision,
  removeSandbox,
} from '../src/core/sandbox/worktree.js';
import {
  captureSandboxedProposal,
  runApiModelSandboxed,
  runEngineSandboxed,
} from '../src/core/run/sandboxed-engine.js';
import type { AshlrConfig, Sandbox } from '../src/core/types.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function initRepo(root: string, name: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'ashlr-test@example.com']);
  git(repo, ['config', 'user.name', 'Ashlr Test']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n', 'utf8');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-qm', 'base']);
  return repo;
}

function advance(repo: string): string {
  writeFileSync(join(repo, 'advanced.txt'), `${Date.now()}\n`, 'utf8');
  git(repo, ['add', 'advanced.txt']);
  git(repo, ['commit', '-qm', 'advance']);
  return git(repo, ['rev-parse', 'HEAD']);
}

const cfg = {
  version: 1,
  roots: [],
  editor: 'vscode',
  models: { providerChain: [] },
  foundry: {
    completenessGate: false,
    fleetMcp: false,
    models: { claude: 'claude-test', 'local-coder': 'local-test' },
  },
} as unknown as AshlrConfig;

describe('M403 source-revision admission', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldTestAllow: string | undefined;
  let sandboxes: Sandbox[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ashlr-m403-'));
    oldHome = process.env.HOME;
    oldTestAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    process.env.HOME = join(root, 'home');
    process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
    sandboxes = [];
    mocks.spawnEngine.mockClear();
    mocks.buildProvider.mockClear();
    mocks.runTask.mockClear();
  });

  afterEach(() => {
    for (const sandbox of sandboxes) {
      try { removeSandbox(sandbox); } catch { /* best effort */ }
    }
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldTestAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    else process.env.ASHLR_TEST_ALLOW_ANY_REPO = oldTestAllow;
    rmSync(root, { recursive: true, force: true });
  });

  function sandbox(repo: string): Sandbox {
    const created = createSandbox(repo, { allowAnyRepo: true });
    sandboxes.push(created);
    return created;
  }

  it('accepts the exact source revision through a physical repo alias', () => {
    const repo = initRepo(root, 'repo');
    const alias = join(root, 'repo-alias');
    symlinkSync(repo, alias, 'dir');
    const sb = sandbox(repo);

    expect(inspectSandboxSourceRevision(sb, alias)).toEqual({
      ok: true,
      baseHead: sb.baseHead,
      currentHead: sb.baseHead,
    });
  });

  it('rejects a different physical repository even when its HEAD is identical', () => {
    const repo = initRepo(root, 'repo');
    const other = initRepo(root, 'other');
    const sb = sandbox(repo);

    expect(inspectSandboxSourceRevision(sb, other)).toMatchObject({
      ok: false,
      reason: 'source-repo-mismatch',
    });
  });

  it('rejects a source HEAD that advanced after sandbox creation', () => {
    const repo = initRepo(root, 'repo');
    const sb = sandbox(repo);
    const currentHead = advance(repo);

    expect(inspectSandboxSourceRevision(sb, repo)).toEqual({
      ok: false,
      reason: 'source-revision-stale',
      baseHead: sb.baseHead,
      currentHead,
    });
  });

  it('spends no CLI or API model call for a stale existing sandbox', async () => {
    const repo = initRepo(root, 'repo');
    const sb = sandbox(repo);
    advance(repo);

    const cli = await runEngineSandboxed('claude', 'stale cli task', cfg, {
      sourceRepo: repo,
      existingWorktree: sb,
      runId: 'run-m403-stale-cli',
    });
    const api = await runApiModelSandboxed('local-coder', 'stale api task', cfg, {
      sourceRepo: repo,
      existingWorktree: sb,
      runId: 'run-m403-stale-api',
    });

    expect(mocks.spawnEngine).not.toHaveBeenCalled();
    expect(mocks.buildProvider).not.toHaveBeenCalled();
    expect(mocks.runTask).not.toHaveBeenCalled();
    expect(cli.proposalOutcome).toMatchObject({
      kind: 'sandbox-unavailable',
      reason: expect.stringContaining('source-revision-stale'),
    });
    expect(api.proposalOutcome).toMatchObject({
      kind: 'sandbox-unavailable',
      reason: expect.stringContaining('source-revision-stale'),
    });
  });

  it('stops CLI retries when the source advances after an attempt', async () => {
    const repo = initRepo(root, 'repo');
    const sb = sandbox(repo);
    mocks.spawnEngine.mockImplementationOnce(async () => {
      advance(repo);
      return {
        ok: false,
        output: '',
        error: 'network error',
        terminationReason: 'error-exit' as const,
      };
    });

    const result = await runEngineSandboxed('claude', 'retry stale task', cfg, {
      sourceRepo: repo,
      existingWorktree: sb,
      runId: 'run-m403-retry-stale',
    });

    expect(mocks.spawnEngine).toHaveBeenCalledTimes(1);
    expect(result.proposalId).toBeUndefined();
    expect(result.proposalOutcome).toMatchObject({
      kind: 'sandbox-unavailable',
      reason: expect.stringContaining('source-revision-stale'),
    });
  });

  it('returns no draft or partial artifact when capture is stale', async () => {
    const repo = initRepo(root, 'repo');
    const sb = sandbox(repo);
    writeFileSync(join(sb.worktreePath, 'draft.txt'), 'candidate\n', 'utf8');
    advance(repo);

    const result = await captureSandboxedProposal('claude', 'stale capture', cfg, {
      sourceRepo: repo,
      existingWorktree: sb,
      draftOnly: true,
      isPartial: true,
      runId: 'run-m403-stale-capture',
    });

    expect(result.proposalDraft).toBeUndefined();
    expect(result.proposalId).toBeUndefined();
    expect(result.proposalOutcome).toMatchObject({
      kind: 'sandbox-unavailable',
      reason: expect.stringContaining('source-revision-stale'),
    });
  });
});

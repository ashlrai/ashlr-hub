/**
 * m165.self-heal.test.ts — self-healing fix-forward loop.
 *
 * WHAT IS TESTED:
 *  - detectBreakage flags a red build/test (mocked exec → failure) and
 *    clears on green.
 *  - proposeHeal builds a high-priority self-heal WorkItem with the failure
 *    detail in title and full detail body.
 *  - runSelfHealCycle iterates enrolled repos (mocked), proposes heals only
 *    for broken ones, returns []/no-op when all green or flag is off.
 *  - Never throws on exec errors.
 *
 * SAFETY / HERMETICITY:
 *  - HOME overridden to a tmp dir — no real ~/.ashlr state touched.
 *  - detectVerifyCommands and runVerifyCommand are MOCKED — no real processes.
 *  - listEnrolled is MOCKED — no real enrollment registry read.
 *  - No git, no network, no real repos mutated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WorkItem } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation — set before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports (vi.mock hoisting)
// ---------------------------------------------------------------------------

const mockDetectVerifyCommands = vi.fn();
const mockRunVerifyCommand = vi.fn();

vi.mock('../src/core/run/verify-commands.js', () => ({
  detectVerifyCommands: (...args: unknown[]) => mockDetectVerifyCommands(...args),
  runVerifyCommand: (...args: unknown[]) => mockRunVerifyCommand(...args),
  runVerifyCommandAsync: (...args: unknown[]) => mockRunVerifyCommand(...args),
}));

const mockListEnrolled = vi.fn();
vi.mock('../src/core/sandbox/policy.js', () => ({
  listEnrolled: () => mockListEnrolled(),
  isEnrolled: vi.fn(() => true),
  readRegistry: vi.fn(() => ({ repos: [] })),
}));

// ---------------------------------------------------------------------------
// Lazy imports (after mocks)
// ---------------------------------------------------------------------------

const { detectBreakage, proposeHeal, runSelfHealCycle } = await import(
  '../src/core/fleet/self-heal.js'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCfg(overrides?: Partial<AshlrConfig['foundry']>): Pick<AshlrConfig, 'foundry'> {
  return { foundry: { ...overrides } };
}

const GREEN_VC = { kind: 'test' as const, cmd: ['npx', 'vitest', 'run'] };
const BUILD_VC = { kind: 'typecheck' as const, cmd: ['npx', 'tsc', '--noEmit'] };

const OK_RESULT = {
  ok: true,
  command: 'npx vitest run',
  exitCode: 0,
  output: '',
  timedOut: false,
};

const FAIL_RESULT = {
  ok: false,
  command: 'npx vitest run',
  exitCode: 1,
  output: 'FAIL src/core/fleet/self-heal.ts\nError: expected true to be false',
  timedOut: false,
};

const BUILD_FAIL_RESULT = {
  ok: false,
  command: 'npx tsc --noEmit',
  exitCode: 2,
  output: "src/core/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable",
  timedOut: false,
};

const TOOL_FAIL_RESULT = {
  ok: false,
  command: 'missing-tool --version',
  exitCode: 127,
  output: '[verify-runner] failed to start: spawn missing-tool ENOENT',
  timedOut: false,
  failureCategory: 'tool',
};

const TIMEOUT_FAIL_RESULT = {
  ok: false,
  command: 'npm test',
  exitCode: 124,
  output: '[verify-runner] timed out after 1000ms; terminating process group',
  timedOut: true,
  failureCategory: 'timeout',
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'm165-'));
  process.env.HOME = tmpHome;
  vi.resetAllMocks();
});

afterEach(() => {
  process.env.HOME = origHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// detectBreakage
// ---------------------------------------------------------------------------

describe('detectBreakage', () => {
  it('returns broken:false when no verify commands are detected', async () => {
    mockDetectVerifyCommands.mockReturnValue([]);
    const result = await detectBreakage('/tmp/fake-repo', makeCfg());
    expect(result.broken).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('no-verify-commands');
    expect(result.kind).toBeUndefined();
  });

  it('returns broken:false when all commands pass', async () => {
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockReturnValue(OK_RESULT);
    const result = await detectBreakage('/tmp/fake-repo', makeCfg());
    expect(result.broken).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('returns broken:true with kind=test when test command fails', async () => {
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockReturnValue(FAIL_RESULT);
    const result = await detectBreakage('/tmp/fake-repo', makeCfg());
    expect(result.broken).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.kind).toBe('test');
    expect(result.detail).toBeTruthy();
    expect(result.detail!.length).toBeLessThanOrEqual(200);
  });

  it('returns broken:true with kind=build when typecheck fails', async () => {
    mockDetectVerifyCommands.mockReturnValue([BUILD_VC]);
    mockRunVerifyCommand.mockReturnValue(BUILD_FAIL_RESULT);
    const result = await detectBreakage('/tmp/fake-repo', makeCfg());
    expect(result.broken).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.kind).toBe('build');
    expect(result.detail).toMatch(/error|Error|FAIL/i);
  });

  it('returns broken:false when verification fails because a tool is unavailable', async () => {
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockReturnValue(TOOL_FAIL_RESULT);
    const result = await detectBreakage('/tmp/fake-repo', makeCfg());
    expect(result.broken).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('untrusted-verify-result');
    expect(result.kind).toBeUndefined();
  });

  it('returns broken:false when verification times out', async () => {
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockReturnValue(TIMEOUT_FAIL_RESULT);
    const result = await detectBreakage('/tmp/fake-repo', makeCfg());
    expect(result.broken).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('untrusted-verify-result');
    expect(result.kind).toBeUndefined();
  });

  it('stops at first failing command (does not run all)', async () => {
    mockDetectVerifyCommands.mockReturnValue([BUILD_VC, GREEN_VC]);
    mockRunVerifyCommand
      .mockReturnValueOnce(BUILD_FAIL_RESULT)
      .mockReturnValueOnce(OK_RESULT);
    const result = await detectBreakage('/tmp/fake-repo', makeCfg());
    expect(result.broken).toBe(true);
    expect(result.kind).toBe('build');
    // Only the first command should have been run
    expect(mockRunVerifyCommand).toHaveBeenCalledTimes(1);
  });

  it('returns broken:false when repo dir does not exist (detectVerifyCommands returns [])', async () => {
    // detectVerifyCommands returns [] for a nonexistent dir — real behavior.
    // Mirror that in the mock so the test is self-consistent.
    mockDetectVerifyCommands.mockReturnValue([]);
    const result = await detectBreakage('/tmp/nonexistent-repo-xyz-12345', makeCfg());
    expect(result.broken).toBe(false);
    expect(result.verified).toBe(false);
  });

  it('never throws on exec errors — returns unknown, not proven green', async () => {
    mockDetectVerifyCommands.mockImplementation(() => { throw new Error('spawnSync failed'); });
    await expect(detectBreakage('/tmp/fake-repo', makeCfg())).resolves.toMatchObject({
      broken: false,
      verified: false,
      reason: 'detect-error',
    });
  });

  it('extracts first error line from multi-line output', async () => {
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockReturnValue({
      ...FAIL_RESULT,
      output: 'compiling...\nsome noise\nError: null pointer\nmore noise',
    });
    const result = await detectBreakage('/tmp/fake-repo', makeCfg());
    expect(result.broken).toBe(true);
    expect(result.detail).toMatch(/Error: null pointer/);
  });
});

// ---------------------------------------------------------------------------
// proposeHeal
// ---------------------------------------------------------------------------

describe('proposeHeal', () => {
  const repo = '/Users/mason/projects/my-app';
  const testBreakage: { broken: true; kind: 'test'; detail: string } = {
    broken: true,
    kind: 'test',
    detail: 'FAIL src/foo.test.ts: expected 1 to equal 2',
  };
  const buildBreakage: { broken: true; kind: 'build'; detail: string } = {
    broken: true,
    kind: 'build',
    detail: "error TS2345: Argument of type 'string' is not assignable",
  };

  it('returns a WorkItem with source=self', () => {
    const item = proposeHeal(repo, testBreakage);
    expect(item.source).toBe('self');
  });

  it('embeds kind and repo name in the title', () => {
    const item = proposeHeal(repo, testBreakage);
    expect(item.title).toMatch(/test/);
    expect(item.title).toMatch(/my-app/);
    expect(item.title).toMatch(/FAIL src\/foo\.test\.ts/);
  });

  it('sets maximum priority: value=5, effort=1, score=5', () => {
    const item = proposeHeal(repo, testBreakage);
    expect(item.value).toBe(5);
    expect(item.effort).toBe(1);
    expect(item.score).toBe(5);
  });

  it('includes the failure detail in the item detail body', () => {
    const item = proposeHeal(repo, testBreakage);
    expect(item.detail).toContain(testBreakage.detail);
  });

  it('tags the item with self-heal and the kind', () => {
    const item = proposeHeal(repo, testBreakage);
    expect(item.tags).toContain('self-heal');
    expect(item.tags).toContain('test');
    expect(item.tags).toContain('high-priority');
  });

  it('generates a stable id (same inputs → same id)', () => {
    const a = proposeHeal(repo, testBreakage);
    const b = proposeHeal(repo, testBreakage);
    expect(a.id).toBe(b.id);
  });

  it('generates different ids for different kinds', () => {
    const a = proposeHeal(repo, testBreakage);
    const b = proposeHeal(repo, buildBreakage);
    expect(a.id).not.toBe(b.id);
  });

  it('sets repo to the repoDir absolute path', () => {
    const item = proposeHeal(repo, testBreakage);
    expect(item.repo).toBe(repo);
  });

  it('sets ts to a valid ISO string', () => {
    const item = proposeHeal(repo, testBreakage);
    expect(() => new Date(item.ts).toISOString()).not.toThrow();
  });

  it('handles missing detail gracefully', () => {
    const item = proposeHeal(repo, { broken: true, kind: 'build' });
    expect(item.title).toMatch(/unknown failure/);
  });
});

// ---------------------------------------------------------------------------
// runSelfHealCycle
// ---------------------------------------------------------------------------

describe('runSelfHealCycle', () => {
  it('returns zeroed result when flag is disabled', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a', '/tmp/repo-b']);
    const result = await runSelfHealCycle({ foundry: { selfHeal: false } as unknown as AshlrConfig['foundry'] });
    expect(result.checked).toBe(0);
    expect(result.broken).toHaveLength(0);
    expect(result.healItems).toHaveLength(0);
    // listEnrolled should NOT have been called
    expect(mockListEnrolled).not.toHaveBeenCalled();
  });

  it('leaves existing queue files untouched when flag is disabled', async () => {
    const ashlrDir = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(ashlrDir, { recursive: true });
    const repoA = path.join(tmpHome, 'repo-a');
    const staleA = proposeHeal(repoA, {
      broken: true,
      kind: 'build',
      detail: 'old TypeScript error',
    });
    const before = JSON.stringify([staleA], null, 2);
    fs.writeFileSync(path.join(ashlrDir, 'self-heal-queue.json'), before, 'utf8');

    const result = await runSelfHealCycle({
      foundry: { selfHeal: false } as unknown as AshlrConfig['foundry'],
    });

    expect(result).toEqual({ checked: 0, broken: [], healItems: [] });
    expect(fs.readFileSync(path.join(ashlrDir, 'self-heal-queue.json'), 'utf8')).toBe(before);
  });

  it('no-op when enrollment is empty', async () => {
    mockListEnrolled.mockReturnValue([]);
    const result = await runSelfHealCycle(makeCfg());
    expect(result.checked).toBe(0);
    expect(result.broken).toHaveLength(0);
    expect(result.healItems).toHaveLength(0);
  });

  it('returns no heal items when all repos are green', async () => {
    mockListEnrolled.mockReturnValue(['/tmp/repo-a', '/tmp/repo-b']);
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockReturnValue(OK_RESULT);

    // repos exist on the mock FS — override existsSync via the mock path
    // detectBreakage calls existsSync; we need to create the dirs in tmpHome
    // or use the fact that detectVerifyCommands returning [] degrades gracefully.
    // Easier: return [] from detectVerifyCommands when repoDir doesn't exist,
    // but here we return GREEN_VC+OK_RESULT which means broken=false anyway.
    const result = await runSelfHealCycle(makeCfg());
    expect(result.checked).toBe(2);
    expect(result.broken).toHaveLength(0);
    expect(result.healItems).toHaveLength(0);
  });

  it('removes stale self-heal queue and backlog items for repos verified green', async () => {
    const repoA = path.join(tmpHome, 'repo-a');
    const repoB = path.join(tmpHome, 'repo-b');
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    const ashlrDir = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(ashlrDir, { recursive: true });

    const staleA = proposeHeal(repoA, {
      broken: true,
      kind: 'build',
      detail: 'old TypeScript error',
    });
    const staleB = proposeHeal(repoB, {
      broken: true,
      kind: 'test',
      detail: 'other repo still broken',
    });
    const inventA: WorkItem = {
      ...staleA,
      id: 'invent-a',
      source: 'invent',
      tags: ['generative'],
      title: 'Invent a useful repo-a feature',
    };

    fs.writeFileSync(
      path.join(ashlrDir, 'self-heal-queue.json'),
      JSON.stringify([staleA, staleB], null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: '2026-07-02T00:00:00.000Z',
        repos: [repoA, repoB],
        items: [staleA, staleB, inventA],
      }, null, 2),
      'utf8',
    );

    mockListEnrolled.mockReturnValue([repoA, repoB]);
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockImplementation((_vc: unknown, dir: string) => {
      if (dir === repoB) return FAIL_RESULT;
      return OK_RESULT;
    });

    const result = await runSelfHealCycle(makeCfg());

    expect(result.checked).toBe(2);
    expect(result.broken).toEqual([repoB]);
    expect(result.healItems.map((item) => item.id)).toEqual([staleB.id]);

    const queue = JSON.parse(
      fs.readFileSync(path.join(ashlrDir, 'self-heal-queue.json'), 'utf8'),
    ) as WorkItem[];
    expect(queue.map((item) => item.id)).toEqual([staleB.id]);

    const backlog = JSON.parse(
      fs.readFileSync(path.join(ashlrDir, 'backlog.json'), 'utf8'),
    ) as { items: WorkItem[] };
    expect(backlog.items.map((item) => item.id)).toEqual([inventA.id]);
  });

  it('replaces stale prior-kind self-heal items with the current first failure', async () => {
    const repoA = path.join(tmpHome, 'repo-a');
    fs.mkdirSync(repoA, { recursive: true });
    const ashlrDir = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(ashlrDir, { recursive: true });

    const staleBuild = proposeHeal(repoA, {
      broken: true,
      kind: 'build',
      detail: 'old TypeScript error',
    });
    const staleTest = proposeHeal(repoA, {
      broken: true,
      kind: 'test',
      detail: 'old test failure',
    });
    const inventA: WorkItem = {
      ...staleBuild,
      id: 'invent-a',
      source: 'invent',
      tags: ['generative'],
      title: 'Invent a useful repo-a feature',
    };

    fs.writeFileSync(
      path.join(ashlrDir, 'self-heal-queue.json'),
      JSON.stringify([staleBuild, staleTest], null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: '2026-07-02T00:00:00.000Z',
        repos: [repoA],
        items: [staleBuild, staleTest, inventA],
      }, null, 2),
      'utf8',
    );

    mockListEnrolled.mockReturnValue([repoA]);
    mockDetectVerifyCommands.mockReturnValue([BUILD_VC, GREEN_VC]);
    mockRunVerifyCommand
      .mockReturnValueOnce(OK_RESULT)
      .mockReturnValueOnce(FAIL_RESULT);

    const result = await runSelfHealCycle(makeCfg());

    expect(result.checked).toBe(1);
    expect(result.broken).toEqual([repoA]);
    expect(result.healItems).toHaveLength(1);
    expect(result.healItems[0]!.id).toBe(staleTest.id);
    expect(result.healItems[0]!.title).toContain('FAIL src/core/fleet/self-heal.ts');

    const queue = JSON.parse(
      fs.readFileSync(path.join(ashlrDir, 'self-heal-queue.json'), 'utf8'),
    ) as WorkItem[];
    expect(queue.map((item) => item.id)).toEqual([staleTest.id]);
    expect(queue[0]!.title).toContain('FAIL src/core/fleet/self-heal.ts');

    const backlog = JSON.parse(
      fs.readFileSync(path.join(ashlrDir, 'backlog.json'), 'utf8'),
    ) as { items: WorkItem[] };
    expect(backlog.items.map((item) => item.id)).toEqual([inventA.id]);
  });

  it('drops self-heal items for missing or unenrolled repos', async () => {
    const repoA = path.join(tmpHome, 'repo-a');
    const repoB = path.join(tmpHome, 'repo-b');
    const missingRepo = path.join(tmpHome, 'deleted-repo');
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    const ashlrDir = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(ashlrDir, { recursive: true });

    const enrolled = proposeHeal(repoA, {
      broken: true,
      kind: 'build',
      detail: 'still tracked',
    });
    const unenrolled = proposeHeal(repoB, {
      broken: true,
      kind: 'build',
      detail: 'not enrolled',
    });
    const missing = proposeHeal(missingRepo, {
      broken: true,
      kind: 'test',
      detail: 'deleted temp repo',
    });
    const inventUnenrolled: WorkItem = {
      ...unenrolled,
      id: 'invent-unenrolled',
      source: 'invent',
      tags: ['generative'],
      title: 'Keep non-self-heal invent work untouched',
    };

    fs.writeFileSync(
      path.join(ashlrDir, 'self-heal-queue.json'),
      JSON.stringify([enrolled, unenrolled, missing], null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: '2026-07-02T00:00:00.000Z',
        repos: [repoA, repoB, missingRepo],
        items: [enrolled, unenrolled, missing, inventUnenrolled],
      }, null, 2),
      'utf8',
    );

    mockListEnrolled.mockReturnValue([repoA]);
    mockDetectVerifyCommands.mockReturnValue([]);

    const result = await runSelfHealCycle(makeCfg());

    expect(result.checked).toBe(1);
    const queue = JSON.parse(
      fs.readFileSync(path.join(ashlrDir, 'self-heal-queue.json'), 'utf8'),
    ) as WorkItem[];
    expect(queue.map((item) => item.id)).toEqual([enrolled.id]);

    const backlog = JSON.parse(
      fs.readFileSync(path.join(ashlrDir, 'backlog.json'), 'utf8'),
    ) as { items: WorkItem[] };
    expect(backlog.items.map((item) => item.id)).toEqual([enrolled.id, inventUnenrolled.id]);
  });

  it('keeps existing self-heal items when verification state is unknown', async () => {
    const repoA = path.join(tmpHome, 'repo-a');
    fs.mkdirSync(repoA, { recursive: true });
    const ashlrDir = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(ashlrDir, { recursive: true });
    const staleA = proposeHeal(repoA, {
      broken: true,
      kind: 'build',
      detail: 'old TypeScript error',
    });
    fs.writeFileSync(
      path.join(ashlrDir, 'self-heal-queue.json'),
      JSON.stringify([staleA], null, 2),
      'utf8',
    );

    mockListEnrolled.mockReturnValue([repoA]);
    mockDetectVerifyCommands.mockImplementation(() => { throw new Error('detector unavailable'); });

    const result = await runSelfHealCycle(makeCfg());

    expect(result.checked).toBe(1);
    expect(result.broken).toHaveLength(0);
    expect(result.healItems).toHaveLength(0);
    const queue = JSON.parse(
      fs.readFileSync(path.join(ashlrDir, 'self-heal-queue.json'), 'utf8'),
    ) as WorkItem[];
    expect(queue.map((item) => item.id)).toEqual([staleA.id]);
  });

  it('keeps existing self-heal items when no verify commands are detected', async () => {
    const repoA = path.join(tmpHome, 'repo-a');
    fs.mkdirSync(repoA, { recursive: true });
    const ashlrDir = path.join(tmpHome, '.ashlr');
    fs.mkdirSync(ashlrDir, { recursive: true });
    const staleA = proposeHeal(repoA, {
      broken: true,
      kind: 'build',
      detail: 'old TypeScript error',
    });
    fs.writeFileSync(
      path.join(ashlrDir, 'self-heal-queue.json'),
      JSON.stringify([staleA], null, 2),
      'utf8',
    );

    mockListEnrolled.mockReturnValue([repoA]);
    mockDetectVerifyCommands.mockReturnValue([]);

    const result = await runSelfHealCycle(makeCfg());

    expect(result.checked).toBe(1);
    expect(result.broken).toHaveLength(0);
    expect(result.healItems).toHaveLength(0);
    const queue = JSON.parse(
      fs.readFileSync(path.join(ashlrDir, 'self-heal-queue.json'), 'utf8'),
    ) as WorkItem[];
    expect(queue.map((item) => item.id)).toEqual([staleA.id]);
  });

  it('does not create or persist heal items for untrusted verify failures', async () => {
    const repoA = path.join(tmpHome, 'repo-a');
    fs.mkdirSync(repoA, { recursive: true });

    mockListEnrolled.mockReturnValue([repoA]);
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockReturnValue(TOOL_FAIL_RESULT);

    const result = await runSelfHealCycle(makeCfg());

    expect(result.checked).toBe(1);
    expect(result.broken).toHaveLength(0);
    expect(result.healItems).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'self-heal-queue.json'))).toBe(false);
  });

  it('proposes heal only for broken repos', async () => {
    const repoA = path.join(tmpHome, 'repo-a');
    const repoB = path.join(tmpHome, 'repo-b');
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });

    mockListEnrolled.mockReturnValue([repoA, repoB]);
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockImplementation((_vc: unknown, dir: string) => {
      // repoA is broken, repoB is green
      if (dir === repoA) return FAIL_RESULT;
      return OK_RESULT;
    });

    const result = await runSelfHealCycle(makeCfg());
    expect(result.checked).toBe(2);
    expect(result.broken).toEqual([repoA]);
    expect(result.healItems).toHaveLength(1);
    expect(result.healItems[0]!.repo).toBe(repoA);
    expect(result.healItems[0]!.score).toBe(5);
    expect(result.healItems[0]!.tags).toContain('self-heal');
  });

  it('proposes heal for multiple broken repos', async () => {
    const repoA = path.join(tmpHome, 'repo-a');
    const repoB = path.join(tmpHome, 'repo-b');
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });

    mockListEnrolled.mockReturnValue([repoA, repoB]);
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockReturnValue(FAIL_RESULT);

    const result = await runSelfHealCycle(makeCfg());
    expect(result.checked).toBe(2);
    expect(result.broken).toHaveLength(2);
    expect(result.healItems).toHaveLength(2);
  });

  it('flag defaults to TRUE (fix-forward posture) — runs when cfg has no selfHeal key', async () => {
    mockListEnrolled.mockReturnValue([]);
    const result = await runSelfHealCycle(makeCfg());
    expect(result.checked).toBe(0); // empty enrollment → 0 checked, but NOT skipped
    // If the flag were false/undefined-means-off, checked would still be 0 but
    // listEnrolled would not be called. We verify it WAS called:
    expect(mockListEnrolled).toHaveBeenCalled();
  });

  it('never throws even when listEnrolled throws', async () => {
    mockListEnrolled.mockImplementation(() => { throw new Error('registry corrupt'); });
    await expect(runSelfHealCycle(makeCfg())).resolves.toMatchObject({
      checked: 0,
      broken: [],
      healItems: [],
    });
  });

  it('never throws even when detectBreakage throws per-repo', async () => {
    const repoA = path.join(tmpHome, 'repo-a');
    fs.mkdirSync(repoA, { recursive: true });
    mockListEnrolled.mockReturnValue([repoA]);
    mockDetectVerifyCommands.mockImplementation(() => { throw new Error('boom'); });
    await expect(runSelfHealCycle(makeCfg())).resolves.toMatchObject({
      checked: 1,
      broken: [],
      healItems: [],
    });
  });

  it('persists heal items to self-heal-queue.json under HOME', async () => {
    const repoA = path.join(tmpHome, 'repo-a');
    fs.mkdirSync(repoA, { recursive: true });
    mockListEnrolled.mockReturnValue([repoA]);
    mockDetectVerifyCommands.mockReturnValue([GREEN_VC]);
    mockRunVerifyCommand.mockReturnValue(FAIL_RESULT);

    await runSelfHealCycle(makeCfg());

    const qPath = path.join(tmpHome, '.ashlr', 'self-heal-queue.json');
    expect(fs.existsSync(qPath)).toBe(true);
    const queue = JSON.parse(fs.readFileSync(qPath, 'utf8')) as WorkItem[];
    expect(Array.isArray(queue)).toBe(true);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue[0]!.tags).toContain('self-heal');
  });
});

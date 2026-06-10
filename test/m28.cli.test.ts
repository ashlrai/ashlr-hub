/**
 * M28 CLI tests — `ashlr goals` (cmdGoals).
 *
 * SAFETY GUARDRAILS (mirrors the M24/M26/M27 test discipline):
 *  - HOME is overridden to a tmp dir so NO real ~/.ashlr state is touched.
 *  - runSwarm is MOCKED — no real agents, no subprocesses, no API calls. The
 *    mock simulates the propose path by creating a PENDING inbox proposal whose
 *    summary carries `swarm=<id>` (exactly as the real runner stamps it).
 *  - authorSpec is MOCKED — no real spec authoring / model calls.
 *  - Tmp git repos only; enrolled only for the test that needs it.
 *  - The CLI NEVER applies/approves a proposal, never pushes, never deploys.
 *
 * Coverage:
 *  - add -> list -> show round-trip (a goal persists and reads back).
 *  - plan creates milestones + links specs (mocked authorSpec).
 *  - advance (mocked runSwarm) reports a PENDING proposal, sets the milestone
 *    'proposed', and calls runSwarm with sandbox+requireSandbox+propose; it
 *    does NOT ship/apply.
 *  - a non-enrolled --project HARD-ERRORS (exit 1) on `add`.
 *  - advancing a goal whose project is not enrolled HARD-ERRORS before runSwarm.
 *  - --allow-cloud off => decompose makes no cloud/model call (deterministic).
 *  - list/show/status are READ-ONLY (no file mutation).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation — before any module resolves homedir().
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origInSwarm = process.env.ASHLR_IN_SWARM;

let tmpHome: string;
let tmpRepo: string;

// ---------------------------------------------------------------------------
// Mocks — declared before the lazy core imports happen inside cmdGoals.
// ---------------------------------------------------------------------------

// runSwarm mock: records calls + simulates the propose path (creates a PENDING
// proposal whose summary contains `swarm=<run.id>`, like the real runner).
const mockRunSwarm = vi.fn();

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

// authorSpec mock: returns a deterministic SpecArtifact; never calls a model.
const mockAuthorSpec = vi.fn();

vi.mock('../src/core/spec/spec-store.js', () => ({
  authorSpec: (...args: unknown[]) => mockAuthorSpec(...args),
  // listSpecs/loadSpec are unused by the planner path under test.
  listSpecs: () => [],
  loadSpec: () => null,
}));

// getActiveClient spy: asserts the DEFAULT (no --allow-cloud) path NEVER
// constructs a client. If it is ever called in the default path the test fails.
const mockGetActiveClient = vi.fn(async () => {
  throw new Error('getActiveClient must NOT be called on the default (local-first) path');
});

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (...args: unknown[]) => mockGetActiveClient(...args),
}));

// ---------------------------------------------------------------------------
// Imports after mocks.
// ---------------------------------------------------------------------------

import { cmdGoals } from '../src/cli/goals.js';
import { enroll, unenroll, listEnrolled } from '../src/core/sandbox/policy.js';
import { loadProposal, listProposals } from '../src/core/inbox/store.js';

// ---------------------------------------------------------------------------
// stdout/stderr capture.
// ---------------------------------------------------------------------------

let stdout = '';
let stderr = '';
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function captureIO(): void {
  stdout = '';
  stderr = '';
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
}

function restoreIO(): void {
  outSpy?.mockRestore();
  errSpy?.mockRestore();
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function initGitRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n', 'utf8');
}

function goalsDirPath(): string {
  return path.join(tmpHome, '.ashlr', 'goals');
}

/** Snapshot the goals dir as a path->content map for read-only assertions. */
function snapshotGoals(): Record<string, string> {
  const dir = goalsDirPath();
  const snap: Record<string, string> = {};
  if (!fs.existsSync(dir)) return snap;
  for (const f of fs.readdirSync(dir)) {
    snap[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return snap;
}

/** Configure the runSwarm mock to simulate a successful propose-path run. */
function configureRunSwarmSuccess(): void {
  mockRunSwarm.mockImplementation(
    async (_input: unknown, _cfg: unknown, _opts: unknown) => {
      const id = `mock-swarm-${mockRunSwarm.mock.calls.length}`;
      // Simulate the runner's propose path creating a PENDING proposal.
      const { createProposal } = await import('../src/core/inbox/store.js');
      createProposal({
        repo: tmpRepo,
        origin: 'swarm',
        kind: 'patch',
        title: 'Mock swarm proposal',
        summary: `Autonomous swarm proposal (swarm=${id}, status=done)`,
        diff: 'diff --git a/x.ts b/x.ts\n',
      });
      return {
        id,
        goal: 'mock goal',
        specId: null,
        project: tmpRepo,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        budget: { maxTokens: 1, maxSteps: 1, allowCloud: false },
        usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0 },
        parallel: 1,
        status: 'done',
        plan: { specId: null, goal: 'mock goal', tasks: [] },
        tasks: [],
        result: 'mock done',
      };
    },
  );
}

/** Read back the single persisted goal id from disk (robust to ANSI in stdout). */
function extractGoalId(): string {
  const files = fs.existsSync(goalsDirPath())
    ? fs.readdirSync(goalsDirPath()).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    : [];
  expect(files.length).toBeGreaterThan(0);
  return files[0]!.replace(/\.json$/, '');
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m28-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m28-repo-'));
  process.env.HOME = tmpHome;
  delete process.env.ASHLR_IN_SWARM;
  initGitRepo(tmpRepo);
  mockRunSwarm.mockReset();
  mockAuthorSpec.mockReset();
  mockGetActiveClient.mockClear();
  mockAuthorSpec.mockImplementation(async (goal: string) => ({
    id: `spec-${Buffer.from(goal).toString('hex').slice(0, 8)}`,
    goal,
    version: 1,
    project: tmpRepo,
    path: path.join(tmpRepo, '.ashlr', 'specs', 'mock-v1.md'),
    status: 'draft',
    createdAt: new Date().toISOString(),
  }));
});

afterEach(() => {
  restoreIO();
  try {
    for (const r of listEnrolled()) unenroll(r);
  } catch {
    /* best-effort */
  }
  process.env.HOME = origHome;
  if (origInSwarm === undefined) delete process.env.ASHLR_IN_SWARM;
  else process.env.ASHLR_IN_SWARM = origInSwarm;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('cmdGoals — add/list/show round-trip', () => {
  it('creates, lists, and shows a goal', async () => {
    captureIO();
    let code = await cmdGoals(['add', 'Ship the new auth flow']);
    expect(code).toBe(0);
    const id = extractGoalId();

    stdout = '';
    code = await cmdGoals(['list', '--json']);
    expect(code).toBe(0);
    const list = JSON.parse(stdout);
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((g: { id: string }) => g.id === id)).toBe(true);

    stdout = '';
    code = await cmdGoals(['show', id, '--json']);
    expect(code).toBe(0);
    const shown = JSON.parse(stdout);
    expect(shown.id).toBe(id);
    expect(shown.objective).toBe('Ship the new auth flow');
    expect(shown.status).toBe('planning');
    expect(shown.milestones).toEqual([]);
  });

  it('rejects add with no objective (exit 2)', async () => {
    captureIO();
    const code = await cmdGoals(['add']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/requires an objective/i);
  });
});

describe('cmdGoals — enrollment scoping on add', () => {
  it('HARD-ERRORS (exit 1) when --project is not enrolled, and creates no goal', async () => {
    captureIO();
    const code = await cmdGoals(['add', 'Do work', '--project', tmpRepo]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/not enrolled/i);
    // No goal persisted.
    expect(fs.existsSync(goalsDirPath()) ? fs.readdirSync(goalsDirPath()) : []).toEqual([]);
  });

  it('accepts --project when the repo IS enrolled', async () => {
    enroll(tmpRepo);
    captureIO();
    const code = await cmdGoals(['add', 'Do work', '--project', tmpRepo, '--json']);
    expect(code).toBe(0);
    const goal = JSON.parse(stdout);
    expect(goal.project).toBe(path.resolve(tmpRepo));
  });
});

describe('cmdGoals — plan (deterministic, local-first)', () => {
  it('creates milestones + links specs WITHOUT any cloud/model call', async () => {
    enroll(tmpRepo);
    captureIO();
    await cmdGoals(['add', 'First do design then implement then test', '--project', tmpRepo]);
    const id = extractGoalId();

    stdout = '';
    const code = await cmdGoals(['plan', id, '--json']);
    expect(code).toBe(0);

    const goal = JSON.parse(stdout);
    expect(goal.milestones.length).toBeGreaterThanOrEqual(3);
    // Deterministic split on "then" => three milestones.
    expect(goal.milestones.every((m: { specId: string | null }) => m.specId !== null)).toBe(true);
    // authorSpec was used (mocked); getActiveClient was NOT (default path).
    expect(mockAuthorSpec).toHaveBeenCalled();
    expect(mockGetActiveClient).not.toHaveBeenCalled();
  });

  it('is bounded by --max', async () => {
    enroll(tmpRepo);
    captureIO();
    await cmdGoals(['add', 'a then b then c then d then e', '--project', tmpRepo]);
    const id = extractGoalId();
    stdout = '';
    await cmdGoals(['plan', id, '--max', '2', '--json']);
    const goal = JSON.parse(stdout);
    expect(goal.milestones.length).toBe(2);
  });
});

describe('cmdGoals — advance (sandboxed, proposal-only)', () => {
  it('reports a PENDING proposal and calls runSwarm with sandbox+requireSandbox+propose', async () => {
    enroll(tmpRepo);
    configureRunSwarmSuccess();
    captureIO();

    await cmdGoals(['add', 'Build a feature', '--project', tmpRepo]);
    const id = extractGoalId();
    stdout = '';
    await cmdGoals(['plan', id, '--json']);

    stdout = '';
    const code = await cmdGoals(['advance', id]);
    expect(code).toBe(0);

    // runSwarm called exactly once with the NON-NEGOTIABLE flags.
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    const opts = mockRunSwarm.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.sandbox).toBe(true);
    expect(opts.requireSandbox).toBe(true);
    expect(opts.propose).toBe(true);
    expect(opts.project).toBe(path.resolve(tmpRepo));

    // A PENDING proposal exists and was reported; the milestone is 'proposed'.
    const pending = listProposals({ status: 'pending' });
    expect(pending.length).toBe(1);
    expect(stdout).toMatch(/PENDING/);
    expect(stdout).toContain(pending[0]!.id);

    // The linked proposal is still PENDING — never approved/applied.
    const linked = loadProposal(pending[0]!.id);
    expect(linked?.status).toBe('pending');

    // The goal milestone records 'proposed' + the proposal id.
    const goalFile = JSON.parse(
      fs.readFileSync(path.join(goalsDirPath(), `${id}.json`), 'utf8'),
    );
    const advanced = goalFile.milestones.find(
      (m: { proposalId: string | null }) => m.proposalId === pending[0]!.id,
    );
    expect(advanced).toBeTruthy();
    expect(advanced.status).toBe('proposed');
  });

  it('HARD-ERRORS before runSwarm when the goal project is not enrolled', async () => {
    // Create an enrolled goal, then un-enroll the repo so advance must refuse.
    enroll(tmpRepo);
    configureRunSwarmSuccess();
    captureIO();
    await cmdGoals(['add', 'Build it', '--project', tmpRepo]);
    const id = extractGoalId();
    await cmdGoals(['plan', id, '--json']);

    unenroll(tmpRepo);
    mockRunSwarm.mockClear();
    stdout = '';
    stderr = '';
    const code = await cmdGoals(['advance', id]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/not enrolled/i);
    // CRITICAL: refused BEFORE any swarm started.
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('HARD-ERRORS when the goal has no project', async () => {
    configureRunSwarmSuccess();
    captureIO();
    await cmdGoals(['add', 'No project goal']);
    const id = extractGoalId();
    stdout = '';
    stderr = '';
    const code = await cmdGoals(['advance', id]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/no enrolled project/i);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });
});

describe('cmdGoals — read-only tracking', () => {
  it('list/show/status leave ~/.ashlr/goals untouched', async () => {
    enroll(tmpRepo);
    captureIO();
    await cmdGoals(['add', 'Track me then verify', '--project', tmpRepo]);
    const id = extractGoalId();
    await cmdGoals(['plan', id, '--json']);

    const before = snapshotGoals();
    await cmdGoals(['list']);
    await cmdGoals(['show', id]);
    await cmdGoals(['status']);
    await cmdGoals(['list', '--json']);
    await cmdGoals(['status', '--json']);
    const after = snapshotGoals();

    expect(after).toEqual(before);
  });
});

describe('cmdGoals — steering', () => {
  it('pause / resume / skip mutate only the local goal record', async () => {
    enroll(tmpRepo);
    captureIO();
    await cmdGoals(['add', 'do a then b then c', '--project', tmpRepo]);
    const id = extractGoalId();
    await cmdGoals(['plan', id, '--json']);

    const m0 = `${id}-m0`;
    let code = await cmdGoals(['skip', id, m0]);
    expect(code).toBe(0);
    let goal = JSON.parse(fs.readFileSync(path.join(goalsDirPath(), `${id}.json`), 'utf8'));
    expect(goal.milestones.find((m: { id: string }) => m.id === m0).status).toBe('skipped');

    code = await cmdGoals(['pause', id]);
    expect(code).toBe(0);
    goal = JSON.parse(fs.readFileSync(path.join(goalsDirPath(), `${id}.json`), 'utf8'));
    expect(goal.status).toBe('paused');

    code = await cmdGoals(['resume', id]);
    expect(code).toBe(0);
    goal = JSON.parse(fs.readFileSync(path.join(goalsDirPath(), `${id}.json`), 'utf8'));
    expect(goal.status).not.toBe('paused');
  });
});

describe('cmdGoals — plan idempotency (M28 regression)', () => {
  it('re-planning an already-planned goal HARD-ERRORS (no duplicate milestones)', async () => {
    enroll(tmpRepo);
    captureIO();
    await cmdGoals(['add', 'a then b then c', '--project', tmpRepo]);
    const id = extractGoalId();
    await cmdGoals(['plan', id, '--json']);
    const first = JSON.parse(
      fs.readFileSync(path.join(goalsDirPath(), `${id}.json`), 'utf8'),
    );
    const count = first.milestones.length;
    expect(count).toBeGreaterThanOrEqual(3);

    stdout = '';
    stderr = '';
    const code = await cmdGoals(['plan', id]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/already planned/i);
    // Milestone set is UNCHANGED — no second copy appended.
    const after = JSON.parse(
      fs.readFileSync(path.join(goalsDirPath(), `${id}.json`), 'utf8'),
    );
    expect(after.milestones.length).toBe(count);
  });

  it('--replace clears the prior plan and re-plans without duplication', async () => {
    enroll(tmpRepo);
    captureIO();
    await cmdGoals(['add', 'a then b then c then d', '--project', tmpRepo]);
    const id = extractGoalId();
    await cmdGoals(['plan', id, '--json']);
    const first = JSON.parse(
      fs.readFileSync(path.join(goalsDirPath(), `${id}.json`), 'utf8'),
    );

    stdout = '';
    const code = await cmdGoals(['plan', id, '--replace', '--max', '2', '--json']);
    expect(code).toBe(0);
    const after = JSON.parse(stdout);
    // Exactly the new plan size — old milestones gone, not appended.
    expect(after.milestones.length).toBe(2);
    expect(after.milestones.length).toBeLessThan(first.milestones.length);
    // Orders restart from 0 (no 0..n + n+1.. corruption).
    expect(after.milestones.map((m: { order: number }) => m.order)).toEqual([0, 1]);
  });
});

describe('cmdGoals — reorder + delete steering (M28 regression)', () => {
  it('reorder rewrites milestone order to the given id sequence', async () => {
    enroll(tmpRepo);
    captureIO();
    await cmdGoals(['add', 'a then b then c', '--project', tmpRepo]);
    const id = extractGoalId();
    await cmdGoals(['plan', id, '--json']);

    const m0 = `${id}-m0`;
    const m1 = `${id}-m1`;
    const m2 = `${id}-m2`;
    stdout = '';
    const code = await cmdGoals(['reorder', id, m2, m0, m1, '--json']);
    expect(code).toBe(0);
    const goal = JSON.parse(stdout);
    // m2 now first (order 0).
    const first = goal.milestones.find((m: { order: number }) => m.order === 0);
    expect(first.id).toBe(m2);
  });

  it('reorder with no milestone ids returns 2', async () => {
    enroll(tmpRepo);
    captureIO();
    await cmdGoals(['add', 'a then b', '--project', tmpRepo]);
    const id = extractGoalId();
    stdout = '';
    stderr = '';
    const code = await cmdGoals(['reorder', id]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/requires a goal id and at least one milestone/i);
  });

  it('delete removes the goal record', async () => {
    enroll(tmpRepo);
    captureIO();
    await cmdGoals(['add', 'throwaway goal', '--project', tmpRepo]);
    const id = extractGoalId();
    expect(fs.existsSync(path.join(goalsDirPath(), `${id}.json`))).toBe(true);

    stdout = '';
    const code = await cmdGoals(['delete', id]);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(goalsDirPath(), `${id}.json`))).toBe(false);
  });

  it('delete on a missing goal returns 1', async () => {
    captureIO();
    const code = await cmdGoals(['delete', 'no-such-goal']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/not found/i);
  });
});

describe('cmdGoals — plan spec authoring is local-first by default (M28 regression)', () => {
  it('default (no --allow-cloud) passes allowCloud:false to spec authoring', async () => {
    enroll(tmpRepo);
    captureIO();
    await cmdGoals(['add', 'design then build', '--project', tmpRepo]);
    const id = extractGoalId();
    stdout = '';
    await cmdGoals(['plan', id, '--json']);

    expect(mockAuthorSpec).toHaveBeenCalled();
    // authorSpec(goalText, cfg, opts) — opts.allowCloud MUST be false on the
    // default path so spec authoring can never reach a cloud provider.
    for (const call of mockAuthorSpec.mock.calls) {
      const opts = call[2] as { allowCloud?: boolean } | undefined;
      expect(opts?.allowCloud).toBe(false);
    }
  });
});

describe('cmdGoals — help and bad usage', () => {
  it('--help returns 0', async () => {
    captureIO();
    const code = await cmdGoals(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/ashlr goals/);
  });

  it('unknown subcommand returns 2', async () => {
    captureIO();
    const code = await cmdGoals(['frobnicate']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown subcommand/i);
  });
});

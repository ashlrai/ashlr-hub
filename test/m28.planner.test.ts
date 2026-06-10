/**
 * M28 planner tests — hermetic. NO real ~/.ashlr, NO real portfolio, NO real
 * swarm, NO network. getActiveClient + authorSpec are mocked; specs (when
 * exercised) write under a tmpdir.
 *
 * Covers (CONTRACT-M28):
 *   - decomposeGoal is DETERMINISTIC + STABLE across runs (byte-identical).
 *   - decomposeGoal is BOUNDED by maxMilestones AND the hard ceiling (16).
 *   - allowCloud=false (default) constructs NO client (zero getActiveClient calls)
 *     ⇒ ZERO network on the default path.
 *   - decomposeGoal segments numbered lists / "then" sequencing.
 *   - single-clause objective falls back to the standard phase scaffold.
 *   - allowCloud=true routes through getActiveClient but preserves count + order;
 *     a bad/mismatched model response falls back to the deterministic split.
 *   - planMilestoneSpec links a spec id via authorSpec, scoped to goal.project,
 *     and NEVER touches a working tree.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AshlrConfig,
  Goal,
  Milestone,
  SpecArtifact,
} from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks — provider-client (no model) + spec-store (no fs writes)
// ---------------------------------------------------------------------------

const mockChat = vi.fn();
const getActiveClientMock = vi.fn(async () => ({
  id: 'mock',
  supportsTools: false,
  chat: mockChat,
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (...args: unknown[]) =>
    (getActiveClientMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

const authorSpecMock = vi.fn();
vi.mock('../src/core/spec/spec-store.js', () => ({
  authorSpec: (...args: unknown[]) =>
    (authorSpecMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

// Import AFTER mocks are registered.
import { decomposeGoal, planMilestoneSpec } from '../src/core/goals/planner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function makeGoal(overrides?: Partial<Goal>): Goal {
  return {
    id: 'goal-1',
    objective: 'Build a CLI',
    project: null,
    status: 'planning',
    milestones: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMilestone(overrides?: Partial<Milestone>): Milestone {
  return {
    id: 'm0-design-abc123',
    title: 'Design',
    detail: 'Clarify scope.',
    order: 0,
    status: 'pending',
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockChat.mockReset();
  getActiveClientMock.mockClear();
  authorSpecMock.mockReset();
});

// ---------------------------------------------------------------------------
// Determinism + bounds
// ---------------------------------------------------------------------------

describe('decomposeGoal — deterministic default', () => {
  it('produces byte-identical output across repeated runs (no clock/randomness)', async () => {
    const cfg = makeConfig();
    const obj = 'First scaffold the parser. Then implement the evaluator. Finally write the docs.';
    const a = await decomposeGoal(obj, cfg);
    const b = await decomposeGoal(obj, cfg);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    // All milestones share the fixed stable epoch (no Date.now leak).
    for (const m of a) {
      expect(m.createdAt).toBe('1970-01-01T00:00:00.000Z');
      expect(m.updatedAt).toBe('1970-01-01T00:00:00.000Z');
    }
  });

  it('makes ZERO cloud/model client calls on the default path (no network)', async () => {
    await decomposeGoal('Build a thing. Ship it.', makeConfig());
    expect(getActiveClientMock).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('assigns contiguous orders 0..n-1, pending status, and null link handles', async () => {
    const out = await decomposeGoal(
      '1. Parse input\n2. Validate\n3. Emit output',
      makeConfig(),
    );
    expect(out.length).toBe(3);
    out.forEach((m, i) => {
      expect(m.order).toBe(i);
      expect(m.status).toBe('pending');
      expect(m.specId).toBeNull();
      expect(m.swarmId).toBeNull();
      expect(m.proposalId).toBeNull();
      expect(m.title.length).toBeGreaterThan(0);
    });
    // Ids unique within the goal.
    const ids = new Set(out.map((m) => m.id));
    expect(ids.size).toBe(out.length);
  });

  it('segments a numbered list into one milestone per item', async () => {
    const out = await decomposeGoal(
      '1. Design the schema\n2. Build the API\n3. Add tests',
      makeConfig(),
    );
    expect(out.length).toBe(3);
    expect(out[0].title.toLowerCase()).toContain('design');
    expect(out[1].title.toLowerCase()).toContain('build');
    expect(out[2].title.toLowerCase()).toContain('test');
  });

  it('segments on "then" / "finally" sequencing words', async () => {
    const out = await decomposeGoal(
      'Set up the project then build the core finally polish the UI',
      makeConfig(),
    );
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it('falls back to the standard phase scaffold for a single clause', async () => {
    const out = await decomposeGoal('Refactor the auth module', makeConfig());
    const titles = out.map((m) => m.title);
    expect(titles).toEqual(['Design', 'Implement', 'Test', 'Document']);
  });
});

describe('decomposeGoal — bounded', () => {
  it('respects a caller maxMilestones cap', async () => {
    const obj = Array.from({ length: 30 }, (_, i) => `Step ${i + 1}`).join('. ');
    const out = await decomposeGoal(obj, makeConfig(), { maxMilestones: 3 });
    expect(out.length).toBe(3);
  });

  it('never exceeds the hard ceiling (16) even when asked for more', async () => {
    const obj = Array.from({ length: 50 }, (_, i) => `Step ${i + 1}`).join('. ');
    const out = await decomposeGoal(obj, makeConfig(), { maxMilestones: 999 });
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out.length).toBe(16);
  });

  it('defaults the cap to 8 when maxMilestones is unset', async () => {
    const obj = Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`).join('. ');
    const out = await decomposeGoal(obj, makeConfig());
    expect(out.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Optional local-first refinement
// ---------------------------------------------------------------------------

describe('decomposeGoal — allowCloud refinement (local-first)', () => {
  it('routes through getActiveClient and applies a count-preserving refinement', async () => {
    const cfg = makeConfig();
    const deterministic = await decomposeGoal(
      '1. Parse\n2. Validate\n3. Emit',
      cfg,
    );
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify(
        deterministic.map((m, i) => ({
          title: `Refined ${i}`,
          detail: `Refined detail ${i}`,
        })),
      ),
      usage: { tokensIn: 1, tokensOut: 1 },
    });

    const refined = await decomposeGoal('1. Parse\n2. Validate\n3. Emit', cfg, {
      allowCloud: true,
    });
    expect(getActiveClientMock).toHaveBeenCalledTimes(1);
    // allowCloud:true is forwarded to the client.
    expect(getActiveClientMock.mock.calls[0][1]).toMatchObject({ allowCloud: true });
    expect(refined.length).toBe(3);
    expect(refined.map((m) => m.title)).toEqual(['Refined 0', 'Refined 1', 'Refined 2']);
    // Order + count preserved.
    refined.forEach((m, i) => expect(m.order).toBe(i));
  });

  it('falls back to the deterministic split when the model errors', async () => {
    const cfg = makeConfig();
    mockChat.mockRejectedValueOnce(new Error('no local model'));
    const out = await decomposeGoal('1. Parse\n2. Validate\n3. Emit', cfg, {
      allowCloud: true,
    });
    expect(getActiveClientMock).toHaveBeenCalledTimes(1);
    expect(out.length).toBe(3);
    expect(out[0].title.toLowerCase()).toContain('parse');
  });

  it('falls back when the model returns a different milestone count', async () => {
    const cfg = makeConfig();
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify([{ title: 'only one', detail: 'x' }]),
      usage: { tokensIn: 1, tokensOut: 1 },
    });
    const out = await decomposeGoal('1. Parse\n2. Validate\n3. Emit', cfg, {
      allowCloud: true,
    });
    expect(out.length).toBe(3);
    // Mismatched count discarded → deterministic titles retained.
    expect(out[0].title.toLowerCase()).toContain('parse');
  });

  it('falls back when the model returns garbage (non-JSON)', async () => {
    const cfg = makeConfig();
    mockChat.mockResolvedValueOnce({
      content: 'not json at all',
      usage: { tokensIn: 0, tokensOut: 0 },
    });
    const out = await decomposeGoal('1. Parse\n2. Validate\n3. Emit', cfg, {
      allowCloud: true,
    });
    expect(out.length).toBe(3);
    expect(out[0].title.toLowerCase()).toContain('parse');
  });
});

// ---------------------------------------------------------------------------
// planMilestoneSpec
// ---------------------------------------------------------------------------

describe('planMilestoneSpec', () => {
  it('links a spec id via authorSpec (returns the artifact)', async () => {
    const artifact: SpecArtifact = {
      id: 'spec-xyz',
      goal: 'g',
      version: 1,
      project: null,
      path: '/tmp/spec.md',
      status: 'draft',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    authorSpecMock.mockResolvedValueOnce(artifact);

    const goal = makeGoal({ objective: 'Build a CLI' });
    const milestone = makeMilestone({ title: 'Design', detail: 'Clarify scope.' });
    const result = await planMilestoneSpec(goal, milestone, makeConfig());

    expect(result.id).toBe('spec-xyz');
    expect(authorSpecMock).toHaveBeenCalledTimes(1);
    const [promptArg, , optsArg] = authorSpecMock.mock.calls[0] as [
      string,
      AshlrConfig,
      { project?: string } | undefined,
    ];
    // The prompt incorporates the objective + milestone title + detail.
    expect(promptArg).toContain('Build a CLI');
    expect(promptArg).toContain('Design');
    expect(promptArg).toContain('Clarify scope.');
    // No project on the goal ⇒ global spec store (project undefined).
    expect(optsArg?.project).toBeUndefined();
  });

  it('scopes the spec to the goal project when set', async () => {
    authorSpecMock.mockResolvedValueOnce({
      id: 's',
      goal: 'g',
      version: 1,
      project: '/repo',
      path: '/repo/.ashlr/specs/s-v1.md',
      status: 'draft',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    } as SpecArtifact);

    const goal = makeGoal({ project: '/repo' });
    await planMilestoneSpec(goal, makeMilestone(), makeConfig());

    const [, , optsArg] = authorSpecMock.mock.calls[0] as [
      string,
      AshlrConfig,
      { project?: string } | undefined,
    ];
    expect(optsArg?.project).toBe('/repo');
  });
});

/**
 * M26 playbook distillation tests — hermetic, mocked stores + provider.
 *
 * SAFETY GUARDRAILS asserted here:
 *  - playbooks distilled ONLY from SUCCESSFUL (status 'done') swarms;
 *  - each distilled playbook persisted via appendHubEntry({ hubOnly: true });
 *  - LOCAL-FIRST: on the DEFAULT path (no narrative) getActiveClient is NEVER
 *    constructed — zero LLM, zero network;
 *  - with allowCloud=false and narrative requested, getActiveClient is forwarded
 *    { allowCloud: false } and NO cloud client is used (local stays true);
 *  - BOUNDED: at most maxRuns swarms are analyzed; emitted playbooks capped.
 *
 * All stores + the provider client are mocked — the real ~/.ashlr is NEVER
 * touched and NO network call is ever attempted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AshlrConfig,
  GenomeEntry,
  SwarmRun,
  SwarmTaskRun,
} from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks — swarm store (READ), genome store (the ONLY write), provider client.
// ---------------------------------------------------------------------------

const mockListSwarms = vi.fn<[], SwarmRun[]>(() => []);

const appendedEntries: Array<{ text: string; title?: string; tags?: string[]; hubOnly?: boolean }> = [];
const mockAppendHubEntry = vi.fn(
  (input: { text: string; title?: string; tags?: string[]; hubOnly?: boolean }): GenomeEntry => {
    appendedEntries.push(input);
    return {
      id: `hub-${appendedEntries.length}`,
      project: input.project ?? null,
      source: 'hub',
      title: input.title ?? 'Note',
      text: input.text,
      tags: input.tags ?? [],
      ts: new Date().toISOString(),
    } as GenomeEntry;
  },
);

/** Tracks every getActiveClient call so we can prove the default path skips it. */
const getActiveClientCalls: Array<{ allowCloud: boolean }> = [];
const mockGetActiveClient = vi.fn(
  async (_cfg: AshlrConfig, opts: { allowCloud: boolean }) => {
    getActiveClientCalls.push({ allowCloud: opts.allowCloud });
    // Simulate a LOCAL Ollama client.
    return {
      id: 'ollama',
      supportsTools: false,
      chat: async () => ({
        content: 'POLISHED NARRATIVE',
        usage: { tokensIn: 5, tokensOut: 5 },
      }),
    };
  },
);

vi.mock('../src/core/swarm/store.js', () => ({
  listSwarms: () => mockListSwarms(),
}));

vi.mock('../src/core/genome/store.js', () => ({
  appendHubEntry: (input: { text: string; title?: string; tags?: string[]; hubOnly?: boolean }) =>
    mockAppendHubEntry(input),
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (cfg: AshlrConfig, opts: { allowCloud: boolean }) =>
    mockGetActiveClient(cfg, opts),
}));

// ---------------------------------------------------------------------------
// Lazy import of the module-under-test (after mocks are registered).
// ---------------------------------------------------------------------------

import {
  distillPlaybooks,
  distillAndPersist,
} from '../src/core/learn/playbooks.js';

// ---------------------------------------------------------------------------
// Fixtures
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
  } as unknown as AshlrConfig;
}

function task(phase: string): SwarmTaskRun {
  return { id: `t-${phase}-${Math.random().toString(36).slice(2)}`, phase, status: 'done' } as SwarmTaskRun;
}

function makeSwarm(overrides: Partial<SwarmRun> & { goal: string; status: SwarmRun['status'] }): SwarmRun {
  return {
    id: overrides.id ?? `s-${Math.random().toString(36).slice(2)}`,
    goal: overrides.goal,
    specId: null,
    project: null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: {} as SwarmRun['budget'],
    usage: overrides.usage ?? { tokensIn: 1000, tokensOut: 500, steps: 4, estCostUsd: 0.02 },
    parallel: 1,
    status: overrides.status,
    plan: {} as SwarmRun['plan'],
    tasks: overrides.tasks ?? [task('plan'), task('build'), task('verify')],
    result: 'ok',
  } as SwarmRun;
}

beforeEach(() => {
  mockListSwarms.mockReset();
  mockListSwarms.mockReturnValue([]);
  mockAppendHubEntry.mockClear();
  mockGetActiveClient.mockClear();
  appendedEntries.length = 0;
  getActiveClientCalls.length = 0;
});

// ---------------------------------------------------------------------------
// distillPlaybooks — pure distillation
// ---------------------------------------------------------------------------

describe('distillPlaybooks — pure distillation from successful swarms', () => {
  it('distills a playbook from a recurring SUCCESSFUL pattern', () => {
    const swarms = [
      makeSwarm({ goal: 'implement user login feature', status: 'done' }),
      makeSwarm({ goal: 'implement billing feature', status: 'done' }),
      makeSwarm({ goal: 'add CSV export feature', status: 'done' }),
    ];
    const pbs = distillPlaybooks(swarms);
    expect(pbs.length).toBe(1);
    expect(pbs[0].category).toBe('feature');
    expect(pbs[0].supportCount).toBe(3);
    expect(pbs[0].text).toContain('phase pattern');
    expect(pbs[0].tags).toContain('playbook');
  });

  it('ignores FAILED / ABORTED swarms (only status===done counts as success)', () => {
    const swarms = [
      makeSwarm({ goal: 'implement feature A', status: 'done' }),
      makeSwarm({ goal: 'implement feature B', status: 'failed' }),
      makeSwarm({ goal: 'implement feature C', status: 'aborted' }),
    ];
    const pbs = distillPlaybooks(swarms);
    // Only one success -> below MIN_SUPPORT(2) -> no playbook.
    expect(pbs.length).toBe(0);
  });

  it('requires recurrence (a single success does not yield a playbook)', () => {
    const pbs = distillPlaybooks([makeSwarm({ goal: 'fix the crash', status: 'done' })]);
    expect(pbs).toEqual([]);
  });

  it('groups by goal category and sorts by supportCount desc', () => {
    const swarms = [
      makeSwarm({ goal: 'fix login bug', status: 'done' }),
      makeSwarm({ goal: 'fix billing bug', status: 'done' }),
      makeSwarm({ goal: 'fix export crash', status: 'done' }),
      makeSwarm({ goal: 'refactor the auth module', status: 'done' }),
      makeSwarm({ goal: 'refactor the router', status: 'done' }),
    ];
    const pbs = distillPlaybooks(swarms);
    expect(pbs.length).toBe(2);
    expect(pbs[0].category).toBe('bugfix'); // 3 > 2
    expect(pbs[0].supportCount).toBe(3);
    expect(pbs[1].category).toBe('refactor');
  });

  it('is pure and never throws on empty / malformed input', () => {
    expect(distillPlaybooks([])).toEqual([]);
    expect(distillPlaybooks(undefined as unknown as SwarmRun[])).toEqual([]);
    expect(() => distillPlaybooks([{ status: 'done' } as unknown as SwarmRun])).not.toThrow();
  });

  it('captures the phase pattern from completed tasks', () => {
    const swarms = [
      makeSwarm({ goal: 'add feature one', status: 'done', tasks: [task('plan'), task('build')] }),
      makeSwarm({ goal: 'add feature two', status: 'done', tasks: [task('plan'), task('build')] }),
    ];
    const pbs = distillPlaybooks(swarms);
    expect(pbs[0].text).toContain('plan -> build');
  });
});

// ---------------------------------------------------------------------------
// distillAndPersist — persistence via genome hub (the only write)
// ---------------------------------------------------------------------------

describe('distillAndPersist — persists distilled playbooks via appendHubEntry', () => {
  it('persists each distilled playbook via appendHubEntry with hubOnly:true', async () => {
    mockListSwarms.mockReturnValue([
      makeSwarm({ goal: 'implement feature A', status: 'done' }),
      makeSwarm({ goal: 'implement feature B', status: 'done' }),
    ]);

    const res = await distillAndPersist(makeConfig(), { persist: true });

    expect(res.playbooks.length).toBe(1);
    expect(res.persisted.length).toBe(1);
    expect(res.didPersist).toBe(true);
    expect(mockAppendHubEntry).toHaveBeenCalledTimes(1);

    // CRITICAL invariant: hubOnly:true so NO file is dropped into a user repo.
    for (const call of appendedEntries) {
      expect(call.hubOnly).toBe(true);
      expect(call.text.length).toBeGreaterThan(0);
      expect(call.tags).toContain('playbook');
    }
    expect(res.persisted[0].source).toBe('hub');
  });

  it('persists nothing when there are no recurring successes', async () => {
    mockListSwarms.mockReturnValue([
      makeSwarm({ goal: 'implement feature A', status: 'done' }),
      makeSwarm({ goal: 'fix a bug', status: 'failed' }),
    ]);
    const res = await distillAndPersist(makeConfig(), { persist: true });
    expect(res.playbooks).toEqual([]);
    expect(res.persisted).toEqual([]);
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
  });

  it('never throws when the swarm store throws', async () => {
    mockListSwarms.mockImplementation(() => {
      throw new Error('store unavailable');
    });
    await expect(distillAndPersist(makeConfig())).resolves.toEqual({
      playbooks: [],
      persisted: [],
      local: true,
      didPersist: false,
    });
  });

  // --- M26 fix (finding: unreviewed genome write) ---------------------------
  it('DEFAULT path is REPORT-ONLY: distills but NEVER writes the genome', async () => {
    mockListSwarms.mockReturnValue([
      makeSwarm({ goal: 'implement feature A', status: 'done' }),
      makeSwarm({ goal: 'implement feature B', status: 'done' }),
    ]);

    const res = await distillAndPersist(makeConfig());

    // Playbooks are distilled and returned to the caller...
    expect(res.playbooks.length).toBe(1);
    // ...but NOTHING is persisted to the genome hub without persist:true.
    expect(res.persisted).toEqual([]);
    expect(res.didPersist).toBe(false);
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
  });

  it('persist:true is the ONLY path that writes the genome hub', async () => {
    mockListSwarms.mockReturnValue([
      makeSwarm({ goal: 'implement feature A', status: 'done' }),
      makeSwarm({ goal: 'implement feature B', status: 'done' }),
    ]);

    const off = await distillAndPersist(makeConfig(), { persist: false });
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
    expect(off.didPersist).toBe(false);

    const on = await distillAndPersist(makeConfig(), { persist: true });
    expect(mockAppendHubEntry).toHaveBeenCalledTimes(1);
    expect(on.didPersist).toBe(true);
    expect(on.persisted.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LOCAL-FIRST invariant — the default path constructs NO model client.
// ---------------------------------------------------------------------------

describe('distillAndPersist — LOCAL-FIRST / no-cloud invariants', () => {
  it('DEFAULT path (no narrative) NEVER constructs getActiveClient', async () => {
    mockListSwarms.mockReturnValue([
      makeSwarm({ goal: 'implement feature A', status: 'done' }),
      makeSwarm({ goal: 'implement feature B', status: 'done' }),
    ]);

    const res = await distillAndPersist(makeConfig());

    expect(mockGetActiveClient).not.toHaveBeenCalled();
    expect(getActiveClientCalls.length).toBe(0);
    expect(res.local).toBe(true);
  });

  it('with allowCloud=false + narrative, forwards { allowCloud:false } and stays LOCAL (no cloud client)', async () => {
    mockListSwarms.mockReturnValue([
      makeSwarm({ goal: 'implement feature A', status: 'done' }),
      makeSwarm({ goal: 'implement feature B', status: 'done' }),
    ]);

    const res = await distillAndPersist(makeConfig(), { narrative: true, allowCloud: false });

    // getActiveClient was invoked but ONLY with allowCloud:false (local-only).
    expect(mockGetActiveClient).toHaveBeenCalled();
    for (const call of getActiveClientCalls) {
      expect(call.allowCloud).toBe(false);
    }
    // The mocked client id is 'ollama' (LOCAL) -> local stays true, NO cloud.
    expect(res.local).toBe(true);
    // Narrative polish was applied from the LOCAL model.
    expect(res.playbooks[0].text).toBe('POLISHED NARRATIVE');
  });

  it('narrative path falls back to the deterministic body when the model throws (never cloud, never throws)', async () => {
    mockListSwarms.mockReturnValue([
      makeSwarm({ goal: 'implement feature A', status: 'done' }),
      makeSwarm({ goal: 'implement feature B', status: 'done' }),
    ]);
    mockGetActiveClient.mockImplementationOnce(async () => {
      // Mirrors getActiveClient's local-first refusal.
      throw new Error('local-first: no local model available');
    });

    const res = await distillAndPersist(makeConfig(), { narrative: true, allowCloud: false, persist: true });

    expect(res.local).toBe(true);
    // Deterministic body retained (NOT the polished narrative).
    expect(res.playbooks[0].text).toContain('Playbook');
    // Still persisted despite the model failure.
    expect(res.persisted.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BOUNDED invariant — at most maxRuns swarms analyzed.
// ---------------------------------------------------------------------------

describe('distillAndPersist — BOUNDED reads', () => {
  it('analyzes at most maxRuns swarms', async () => {
    // 200 successful feature swarms, but maxRuns=3 -> only 3 inform the playbook.
    const many = Array.from({ length: 200 }, (_, i) =>
      makeSwarm({ goal: `implement feature ${i}`, status: 'done' }),
    );
    mockListSwarms.mockReturnValue(many);

    const res = await distillAndPersist(makeConfig(), { maxRuns: 3 });

    expect(res.playbooks.length).toBe(1);
    expect(res.playbooks[0].supportCount).toBe(3);
  });

  it('caps emitted playbooks (MAX_PLAYBOOKS) even with many distinct categories', async () => {
    const swarms: SwarmRun[] = [];
    const goalsPerCat: Record<string, string[]> = {
      feature: ['implement feature one', 'implement feature two'],
      bugfix: ['fix bug one', 'fix bug two'],
      refactor: ['refactor module one', 'refactor module two'],
      test: ['add tests one', 'add tests two'],
      docs: ['write docs one', 'write docs two'],
      chore: ['bump deps one', 'bump deps two'],
    };
    for (const goals of Object.values(goalsPerCat)) {
      for (const g of goals) swarms.push(makeSwarm({ goal: g, status: 'done' }));
    }
    mockListSwarms.mockReturnValue(swarms);

    const res = await distillAndPersist(makeConfig(), { persist: true });
    // Six eligible categories, but capped at MAX_PLAYBOOKS (5).
    expect(res.playbooks.length).toBeLessThanOrEqual(5);
    expect(res.persisted.length).toBe(res.playbooks.length);
  });
});

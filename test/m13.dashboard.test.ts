/**
 * M13 dashboard tests — hermetic, all data-source modules mocked.
 *
 * Tests buildSnapshot() from src/core/dashboard.ts:
 *   - Aggregates fixtured index/runs/swarms into the correct DashboardSnapshot shape.
 *   - Never throws when data sources return missing/empty/error data.
 *   - generatedAt is a valid ISO timestamp string.
 *   - repos.total / dirty / stale counts are derived from the index fixture.
 *   - tools.installed / total are derived from the tools-registry fixture.
 *   - activity fields come from the observability rollup fixture.
 *   - runs array is most-recent-first, tokens = tokensIn + tokensOut.
 *   - swarms array includes tasksDone / tasksTotal / phase.
 *   - mcp array maps name + ok + tools count.
 *   - genome fields come from the loadGenome() entries fixture.
 *   - Degrades gracefully (zeroed/empty fields) when each source throws.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DashboardSnapshot, AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Config fixture
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
  };
}

// ---------------------------------------------------------------------------
// Mock fixtures
// ---------------------------------------------------------------------------

const FIXTURE_INDEX = {
  version: 1,
  generatedAt: new Date().toISOString(),
  root: '/home/user/Desktop',
  items: [
    {
      id: 'repo-a',
      name: 'repo-a',
      path: '/home/user/Desktop/github/dev-tools/repo-a',
      kind: 'repo' as const,
      category: 'dev-tools',
      description: null,
      org: null,
      remote: null,
      language: 'TypeScript',
      lastModified: new Date().toISOString(),
      active: true,
      git: { branch: 'main', dirty: 2, ahead: 0, behind: 0, lastCommit: new Date().toISOString() },
    },
    {
      id: 'repo-b',
      name: 'repo-b',
      path: '/home/user/Desktop/github/dev-tools/repo-b',
      kind: 'repo' as const,
      category: 'dev-tools',
      description: null,
      org: null,
      remote: null,
      language: 'TypeScript',
      lastModified: new Date(Date.now() - 100 * 86400000).toISOString(), // stale (100 days ago)
      active: false,
      git: { branch: 'main', dirty: 0, ahead: 0, behind: 0, lastCommit: null },
    },
    {
      id: 'doc-folder',
      name: 'docs',
      path: '/home/user/Desktop/docs',
      kind: 'doc-folder' as const,
      category: null,
      description: null,
      org: null,
      remote: null,
      language: null,
      lastModified: new Date().toISOString(),
      active: true,
    },
  ],
};

const FIXTURE_TOOLS_REGISTRY = {
  tools: [
    { id: 'phantom', name: 'Phantom', installed: true, version: '1.0.0', path: '/usr/bin/phantom' },
    { id: 'ashlr-hub', name: 'ashlr-hub', installed: true, version: '0.13.0', path: '/usr/bin/ashlr' },
    { id: 'stack', name: 'stack', installed: false, version: null, path: null },
    { id: 'pulse', name: 'pulse-agent', installed: false, version: null, path: null },
  ],
  installedCount: 2,
};

const FIXTURE_ROLLUP = {
  window: '7d' as const,
  since: new Date(Date.now() - 7 * 86400000).toISOString(),
  totals: {
    tokensIn: 12000,
    tokensOut: 8000,
    estCostUsd: 0.42,
    sessions: 5,
    commits: 11,
  },
  byProject: [],
  byDay: [],
  byModel: [],
  budget: {
    level: 'ok' as const,
    window: '7d',
    spentUsd: 0.42,
    capUsd: null,
    spentTokens: 20000,
    capTokens: null,
    message: 'ok',
  },
};

const FIXTURE_RUNS = [
  {
    id: 'run-001',
    goal: 'Build feature X',
    engine: 'builtin',
    provider: 'ollama',
    createdAt: '2026-06-08T10:00:00.000Z',
    updatedAt: '2026-06-08T10:05:00.000Z',
    budget: { maxTokens: 50000, maxSteps: 100, allowCloud: false },
    usage: { tokensIn: 3000, tokensOut: 1500, steps: 5, estCostUsd: 0.1 },
    tasks: [],
    steps: [],
    status: 'done' as const,
    result: 'Feature X complete.',
  },
  {
    id: 'run-002',
    goal: 'Refactor module Y',
    engine: 'builtin',
    provider: 'ollama',
    createdAt: '2026-06-07T09:00:00.000Z',
    updatedAt: '2026-06-07T09:10:00.000Z',
    budget: { maxTokens: 50000, maxSteps: 100, allowCloud: false },
    usage: { tokensIn: 2000, tokensOut: 1000, steps: 3, estCostUsd: 0.05 },
    tasks: [],
    steps: [],
    status: 'running' as const,
  },
];

const FIXTURE_SWARMS = [
  {
    id: 'swarm-001',
    goal: 'Implement M13 surfaces',
    specId: null,
    project: '/home/user/Desktop/github/dev-tools/ashlr-hub',
    createdAt: '2026-06-08T08:00:00.000Z',
    updatedAt: '2026-06-08T09:00:00.000Z',
    budget: { maxTokens: 200000, maxSteps: 500, allowCloud: false },
    usage: { tokensIn: 5000, tokensOut: 2500, steps: 10, estCostUsd: 0.2 },
    parallel: 3,
    status: 'running' as const,
    plan: {
      specId: null,
      goal: 'Implement M13 surfaces',
      tasks: [
        { id: 'scaffold-1', phase: 'scaffold' as const, goal: 'Setup', deps: [] },
        { id: 'build-1', phase: 'build' as const, goal: 'Build dashboard', deps: ['scaffold-1'] },
        { id: 'build-2', phase: 'build' as const, goal: 'Build TUI', deps: ['scaffold-1'] },
      ],
    },
    tasks: [
      { id: 'scaffold-1', phase: 'scaffold' as const, status: 'done' as const, result: 'done' },
      { id: 'build-1', phase: 'build' as const, status: 'running' as const },
      { id: 'build-2', phase: 'build' as const, status: 'pending' as const },
    ],
  },
];

const FIXTURE_MCP_REGISTRY = {
  servers: [
    { name: 'ashlr', command: 'node', args: ['dist/index.js'], source: '~/.claude.json' },
    { name: 'phantom-secrets', command: 'phantom', args: ['mcp'], source: '~/.claude.json' },
  ],
};

const FIXTURE_GENOME_HEALTH = {
  totalEntries: 42,
  projects: 7,
  hubEntries: 15,
  sizeBytes: 8192,
  lastLearnedAt: '2026-06-08T07:00:00.000Z',
  embeddingsAvailable: false,
};

// buildSnapshot now derives genome counts from loadGenome() directly (no
// embedding probe). Build a fixture of 42 entries across 7 distinct projects
// so snap.genome.entries === 42 and snap.genome.projects === 7, matching the
// FIXTURE_GENOME_HEALTH expectations the assertions already use.
const FIXTURE_GENOME_ENTRIES = Array.from({ length: 42 }, (_, i) => ({
  id: `g-${i}`,
  project: `project-${i % 7}`,
  source: 'project' as const,
  title: `entry ${i}`,
  text: `body ${i}`,
  tags: [],
  ts: '2026-06-08T07:00:00.000Z',
}));

// ---------------------------------------------------------------------------
// Module mocks (vi.mock hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock('../src/core/index-engine.js', () => ({
  loadIndex: vi.fn(() => FIXTURE_INDEX),
}));

vi.mock('../src/core/tools-registry.js', () => ({
  getToolsRegistry: vi.fn(() => FIXTURE_TOOLS_REGISTRY),
}));

vi.mock('../src/core/observability/rollup.js', () => ({
  buildRollup: vi.fn(() => FIXTURE_ROLLUP),
}));

vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: vi.fn(() => FIXTURE_RUNS),
  loadRun: vi.fn((id: string) => FIXTURE_RUNS.find(r => r.id === id) ?? null),
}));

vi.mock('../src/core/swarm/store.js', () => ({
  listSwarms: vi.fn(() => FIXTURE_SWARMS),
  loadSwarm: vi.fn((id: string) => FIXTURE_SWARMS.find(s => s.id === id) ?? null),
}));

vi.mock('../src/core/mcp-registry.js', () => ({
  discoverMcpServers: vi.fn(() => FIXTURE_MCP_REGISTRY),
}));

vi.mock('../src/core/genome/store.js', () => ({
  loadGenome: vi.fn(() => FIXTURE_GENOME_ENTRIES),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { buildSnapshot } from '../src/core/dashboard.js';

// ---------------------------------------------------------------------------
// Reset mocks to fixture defaults before each test
// ---------------------------------------------------------------------------

beforeEach(async () => {
  const indexEngine = await import('../src/core/index-engine.js');
  const toolsRegistry = await import('../src/core/tools-registry.js');
  const rollup = await import('../src/core/observability/rollup.js');
  const orchestrator = await import('../src/core/run/orchestrator.js');
  const swarmStore = await import('../src/core/swarm/store.js');
  const mcpRegistry = await import('../src/core/mcp-registry.js');
  const genomeStore = await import('../src/core/genome/store.js');

  vi.mocked(indexEngine.loadIndex).mockReturnValue(FIXTURE_INDEX);
  vi.mocked(toolsRegistry.getToolsRegistry).mockReturnValue(FIXTURE_TOOLS_REGISTRY);
  vi.mocked(rollup.buildRollup).mockReturnValue(FIXTURE_ROLLUP);
  vi.mocked(orchestrator.listRuns).mockReturnValue(FIXTURE_RUNS);
  vi.mocked(orchestrator.loadRun).mockImplementation((id: string) => FIXTURE_RUNS.find(r => r.id === id) ?? null);
  vi.mocked(swarmStore.listSwarms).mockReturnValue(FIXTURE_SWARMS);
  vi.mocked(swarmStore.loadSwarm).mockImplementation((id: string) => FIXTURE_SWARMS.find(s => s.id === id) ?? null);
  vi.mocked(mcpRegistry.discoverMcpServers).mockReturnValue(FIXTURE_MCP_REGISTRY);
  vi.mocked(genomeStore.loadGenome).mockReturnValue(FIXTURE_GENOME_ENTRIES);
});

// ---------------------------------------------------------------------------
// Shape / contract invariants
// ---------------------------------------------------------------------------

describe('buildSnapshot — shape invariants', () => {
  it('resolves to a DashboardSnapshot (does not throw)', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toBeDefined();
    expect(typeof snap).toBe('object');
  });

  it('generatedAt is a non-empty ISO string', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(typeof snap.generatedAt).toBe('string');
    expect(snap.generatedAt.length).toBeGreaterThan(0);
    // Must parse as a valid date
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
  });

  it('has all required top-level fields', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap).toHaveProperty('generatedAt');
    expect(snap).toHaveProperty('repos');
    expect(snap).toHaveProperty('tools');
    expect(snap).toHaveProperty('activity');
    expect(snap).toHaveProperty('runs');
    expect(snap).toHaveProperty('swarms');
    expect(snap).toHaveProperty('mcp');
    expect(snap).toHaveProperty('genome');
  });
});

// ---------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------

describe('buildSnapshot — repos', () => {
  it('repos.total counts all repo-kind items in the index', async () => {
    const snap = await buildSnapshot(makeConfig());
    // FIXTURE_INDEX has 2 repo items (repo-a and repo-b)
    expect(snap.repos.total).toBe(2);
  });

  it('repos.dirty counts repos with git.dirty > 0', async () => {
    const snap = await buildSnapshot(makeConfig());
    // repo-a has dirty=2; repo-b has dirty=0
    expect(snap.repos.dirty).toBe(1);
  });

  it('repos.stale counts repos that are not active', async () => {
    const snap = await buildSnapshot(makeConfig());
    // repo-b is active=false (stale)
    expect(snap.repos.stale).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

describe('buildSnapshot — tools', () => {
  it('tools.installed matches installedCount from getToolsRegistry()', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.tools.installed).toBe(FIXTURE_TOOLS_REGISTRY.installedCount);
  });

  it('tools.total matches the total number of tools probed', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.tools.total).toBe(FIXTURE_TOOLS_REGISTRY.tools.length);
  });
});

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------

describe('buildSnapshot — activity', () => {
  it('activity.sessions comes from rollup totals', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.activity.sessions).toBe(FIXTURE_ROLLUP.totals.sessions);
  });

  it('activity.tokens is sum of tokensIn + tokensOut from rollup', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.activity.tokens).toBe(
      FIXTURE_ROLLUP.totals.tokensIn + FIXTURE_ROLLUP.totals.tokensOut,
    );
  });

  it('activity.estCostUsd matches rollup totals', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.activity.estCostUsd).toBeCloseTo(FIXTURE_ROLLUP.totals.estCostUsd, 5);
  });

  it('activity.commits matches rollup totals', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.activity.commits).toBe(FIXTURE_ROLLUP.totals.commits);
  });
});

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

describe('buildSnapshot — runs', () => {
  it('runs is an array', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(Array.isArray(snap.runs)).toBe(true);
  });

  it('each run entry has required fields', async () => {
    const snap = await buildSnapshot(makeConfig());
    for (const r of snap.runs) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.goal).toBe('string');
      expect(typeof r.status).toBe('string');
      expect(typeof r.tokens).toBe('number');
    }
  });

  it('run tokens = tokensIn + tokensOut from usage', async () => {
    const snap = await buildSnapshot(makeConfig());
    const run = snap.runs.find(r => r.id === 'run-001');
    expect(run).toBeDefined();
    expect(run!.tokens).toBe(
      FIXTURE_RUNS[0]!.usage.tokensIn + FIXTURE_RUNS[0]!.usage.tokensOut,
    );
  });

  it('run goal and status are mapped from RunState', async () => {
    const snap = await buildSnapshot(makeConfig());
    const run = snap.runs.find(r => r.id === 'run-001');
    expect(run!.goal).toBe('Build feature X');
    expect(run!.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// swarms
// ---------------------------------------------------------------------------

describe('buildSnapshot — swarms', () => {
  it('swarms is an array', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(Array.isArray(snap.swarms)).toBe(true);
  });

  it('each swarm entry has required fields', async () => {
    const snap = await buildSnapshot(makeConfig());
    for (const s of snap.swarms) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.goal).toBe('string');
      expect(typeof s.status).toBe('string');
      expect(typeof s.tasksDone).toBe('number');
      expect(typeof s.tasksTotal).toBe('number');
    }
  });

  it('tasksDone counts tasks with status done', async () => {
    const snap = await buildSnapshot(makeConfig());
    const swarm = snap.swarms.find(s => s.id === 'swarm-001');
    expect(swarm).toBeDefined();
    // FIXTURE has 1 done task out of 3
    expect(swarm!.tasksDone).toBe(1);
  });

  it('tasksTotal counts all tasks in the swarm', async () => {
    const snap = await buildSnapshot(makeConfig());
    const swarm = snap.swarms.find(s => s.id === 'swarm-001');
    expect(swarm!.tasksTotal).toBe(3);
  });

  it('phase field is present when there is an active/running task', async () => {
    const snap = await buildSnapshot(makeConfig());
    const swarm = snap.swarms.find(s => s.id === 'swarm-001');
    // build-1 is 'running' so phase should be 'build'
    expect(swarm!.phase).toBeDefined();
    expect(swarm!.phase).toBe('build');
  });
});

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

describe('buildSnapshot — mcp', () => {
  it('mcp is an array', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(Array.isArray(snap.mcp)).toBe(true);
  });

  it('each mcp entry has name, ok, and tools fields', async () => {
    const snap = await buildSnapshot(makeConfig());
    for (const m of snap.mcp) {
      expect(typeof m.name).toBe('string');
      expect(typeof m.ok).toBe('boolean');
      expect(typeof m.tools).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// genome
// ---------------------------------------------------------------------------

describe('buildSnapshot — genome', () => {
  it('genome.entries matches the loadGenome entry count', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.genome.entries).toBe(FIXTURE_GENOME_HEALTH.totalEntries);
  });

  it('genome.projects matches the distinct project count from loadGenome', async () => {
    const snap = await buildSnapshot(makeConfig());
    expect(snap.genome.projects).toBe(FIXTURE_GENOME_HEALTH.projects);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation — never throws on missing/failing sources
// ---------------------------------------------------------------------------

describe('buildSnapshot — graceful degradation', () => {
  it('does not throw when loadIndex() returns null', async () => {
    const { loadIndex } = await import('../src/core/index-engine.js');
    vi.mocked(loadIndex).mockReturnValue(null);
    await expect(buildSnapshot(makeConfig())).resolves.toBeDefined();
  });

  it('returns zeroed repos when loadIndex() returns null', async () => {
    const { loadIndex } = await import('../src/core/index-engine.js');
    vi.mocked(loadIndex).mockReturnValue(null);
    const snap = await buildSnapshot(makeConfig());
    expect(snap.repos.total).toBe(0);
    expect(snap.repos.dirty).toBe(0);
    expect(snap.repos.stale).toBe(0);
  });

  it('does not throw when loadIndex() throws', async () => {
    const { loadIndex } = await import('../src/core/index-engine.js');
    vi.mocked(loadIndex).mockImplementation(() => { throw new Error('disk error'); });
    await expect(buildSnapshot(makeConfig())).resolves.toBeDefined();
  });

  it('does not throw when getToolsRegistry() throws', async () => {
    const { getToolsRegistry } = await import('../src/core/tools-registry.js');
    vi.mocked(getToolsRegistry).mockImplementation(() => { throw new Error('which failed'); });
    await expect(buildSnapshot(makeConfig())).resolves.toBeDefined();
  });

  it('returns zeroed tools when getToolsRegistry() throws', async () => {
    const { getToolsRegistry } = await import('../src/core/tools-registry.js');
    vi.mocked(getToolsRegistry).mockImplementation(() => { throw new Error('which failed'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.tools.installed).toBe(0);
    expect(snap.tools.total).toBe(0);
  });

  it('does not throw when buildRollup() throws', async () => {
    const { buildRollup } = await import('../src/core/observability/rollup.js');
    vi.mocked(buildRollup).mockImplementation(() => { throw new Error('no events'); });
    await expect(buildSnapshot(makeConfig())).resolves.toBeDefined();
  });

  it('returns zeroed activity when buildRollup() throws', async () => {
    const { buildRollup } = await import('../src/core/observability/rollup.js');
    vi.mocked(buildRollup).mockImplementation(() => { throw new Error('no events'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.activity.sessions).toBe(0);
    expect(snap.activity.tokens).toBe(0);
    expect(snap.activity.estCostUsd).toBe(0);
    expect(snap.activity.commits).toBe(0);
  });

  it('does not throw when listRuns() throws', async () => {
    const { listRuns } = await import('../src/core/run/orchestrator.js');
    vi.mocked(listRuns).mockImplementation(() => { throw new Error('fs error'); });
    await expect(buildSnapshot(makeConfig())).resolves.toBeDefined();
  });

  it('returns empty runs array when listRuns() throws', async () => {
    const { listRuns } = await import('../src/core/run/orchestrator.js');
    vi.mocked(listRuns).mockImplementation(() => { throw new Error('fs error'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.runs).toEqual([]);
  });

  it('does not throw when listSwarms() throws', async () => {
    const { listSwarms } = await import('../src/core/swarm/store.js');
    vi.mocked(listSwarms).mockImplementation(() => { throw new Error('fs error'); });
    await expect(buildSnapshot(makeConfig())).resolves.toBeDefined();
  });

  it('returns empty swarms array when listSwarms() throws', async () => {
    const { listSwarms } = await import('../src/core/swarm/store.js');
    vi.mocked(listSwarms).mockImplementation(() => { throw new Error('fs error'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.swarms).toEqual([]);
  });

  it('does not throw when discoverMcpServers() throws', async () => {
    const { discoverMcpServers } = await import('../src/core/mcp-registry.js');
    vi.mocked(discoverMcpServers).mockImplementation(() => { throw new Error('parse error'); });
    await expect(buildSnapshot(makeConfig())).resolves.toBeDefined();
  });

  it('returns empty mcp array when discoverMcpServers() throws', async () => {
    const { discoverMcpServers } = await import('../src/core/mcp-registry.js');
    vi.mocked(discoverMcpServers).mockImplementation(() => { throw new Error('parse error'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.mcp).toEqual([]);
  });

  it('does not throw when loadGenome() throws', async () => {
    const { loadGenome } = await import('../src/core/genome/store.js');
    vi.mocked(loadGenome).mockImplementation(() => { throw new Error('store error'); });
    await expect(buildSnapshot(makeConfig())).resolves.toBeDefined();
  });

  it('returns zeroed genome when loadGenome() throws', async () => {
    const { loadGenome } = await import('../src/core/genome/store.js');
    vi.mocked(loadGenome).mockImplementation(() => { throw new Error('store error'); });
    const snap = await buildSnapshot(makeConfig());
    expect(snap.genome.entries).toBe(0);
    expect(snap.genome.projects).toBe(0);
  });

  it('returns a well-formed snapshot even when ALL sources fail', async () => {
    const { loadIndex } = await import('../src/core/index-engine.js');
    const { getToolsRegistry } = await import('../src/core/tools-registry.js');
    const { buildRollup } = await import('../src/core/observability/rollup.js');
    const { listRuns } = await import('../src/core/run/orchestrator.js');
    const { listSwarms } = await import('../src/core/swarm/store.js');
    const { discoverMcpServers } = await import('../src/core/mcp-registry.js');
    const { loadGenome } = await import('../src/core/genome/store.js');

    vi.mocked(loadIndex).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(getToolsRegistry).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(buildRollup).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(listRuns).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(listSwarms).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(discoverMcpServers).mockImplementation(() => { throw new Error('fail'); });
    vi.mocked(loadGenome).mockImplementation(() => { throw new Error('fail'); });

    const snap: DashboardSnapshot = await buildSnapshot(makeConfig());

    expect(typeof snap.generatedAt).toBe('string');
    expect(typeof snap.repos.total).toBe('number');
    expect(typeof snap.repos.dirty).toBe('number');
    expect(typeof snap.repos.stale).toBe('number');
    expect(typeof snap.tools.installed).toBe('number');
    expect(typeof snap.tools.total).toBe('number');
    expect(typeof snap.activity.sessions).toBe('number');
    expect(Array.isArray(snap.runs)).toBe(true);
    expect(Array.isArray(snap.swarms)).toBe(true);
    expect(Array.isArray(snap.mcp)).toBe(true);
    expect(typeof snap.genome.entries).toBe('number');
    expect(typeof snap.genome.projects).toBe('number');
  });

  it('does not throw when listRuns() returns an empty array', async () => {
    const { listRuns } = await import('../src/core/run/orchestrator.js');
    vi.mocked(listRuns).mockReturnValue([]);
    const snap = await buildSnapshot(makeConfig());
    expect(snap.runs).toEqual([]);
  });

  it('does not throw when listSwarms() returns an empty array', async () => {
    const { listSwarms } = await import('../src/core/swarm/store.js');
    vi.mocked(listSwarms).mockReturnValue([]);
    const snap = await buildSnapshot(makeConfig());
    expect(snap.swarms).toEqual([]);
  });
});

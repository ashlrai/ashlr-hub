/**
 * M12 store tests — hermetic, all operations in os.tmpdir().
 *
 * SAFETY GUARDRAIL: process.env.HOME is overridden to a tmp dir so swarmsDir()
 * lands under the tmp dir, not the real ~/.ashlr. NEVER touches real ~/.ashlr.
 *
 * Covers:
 *   - swarmsDir(): returns path ending in .ashlr/swarms under HOME
 *   - saveSwarm / loadSwarm: round-trip (id, goal, status, plan, tasks, usage)
 *   - loadSwarm: returns null for unknown id
 *   - loadSwarm: returns null for corrupt JSON
 *   - listSwarms: returns all saved swarms, sorted newest first
 *   - saveSwarm: idempotent — second save overwrites first
 *   - saveSwarm: writes to <swarmsDir>/<id>.json
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SwarmRun, SwarmPlan, SwarmTaskRun, RunBudget, RunUsage } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Override HOME before any swarm store module is imported so swarmsDir()
// lands under the tmp dir, not the real ~/.ashlr.
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m12-store-'));
}

// Lazy import — set HOME before first import so swarmsDir() resolves correctly.
let swarmsDir: () => string;
let saveSwarm: (s: SwarmRun) => void;
let loadSwarm: (id: string) => SwarmRun | null;
let listSwarms: () => SwarmRun[];

async function ensureImported(): Promise<void> {
  if (!swarmsDir) {
    const store = await import('../src/core/swarm/store.js');
    swarmsDir = store.swarmsDir;
    saveSwarm = store.saveSwarm;
    loadSwarm = store.loadSwarm;
    listSwarms = store.listSwarms;
  }
}

beforeEach(async () => {
  tmpHome = freshTmpHome();
  process.env.HOME = tmpHome;
  await ensureImported();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBudget(maxTokens = 50_000, maxSteps = 100): RunBudget {
  return { maxTokens, maxSteps, allowCloud: false };
}

function makeUsage(overrides: Partial<RunUsage> = {}): RunUsage {
  return { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0, ...overrides };
}

function makePlan(goal = 'test goal'): SwarmPlan {
  return {
    specId: null,
    goal,
    tasks: [
      { id: 'scaffold-1', phase: 'scaffold', goal: 'Set up project structure', deps: [] },
      { id: 'build-1', phase: 'build', goal: 'Implement feature A', deps: ['scaffold-1'] },
      { id: 'build-2', phase: 'build', goal: 'Implement feature B', deps: ['scaffold-1'] },
      { id: 'verify-1', phase: 'verify', goal: 'Run tests', deps: ['build-1', 'build-2'] },
    ],
  };
}

let idCounter = 0;

function makeSwarmRun(overrides: Partial<SwarmRun> = {}): SwarmRun {
  const id = `m12-store-test-${Date.now()}-${++idCounter}`;
  const plan = makePlan(overrides.goal ?? 'default goal');
  const tasks: SwarmTaskRun[] = plan.tasks.map(t => ({
    id: t.id,
    phase: t.phase,
    status: 'pending' as const,
  }));
  return {
    id,
    goal: 'default goal',
    specId: null,
    project: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: makeBudget(),
    usage: makeUsage(),
    parallel: 3,
    status: 'planning',
    plan,
    tasks,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// swarmsDir
// ---------------------------------------------------------------------------

describe('swarmsDir', () => {
  it('returns an absolute path', () => {
    expect(path.isAbsolute(swarmsDir())).toBe(true);
  });

  it('path ends with .ashlr/swarms', () => {
    const d = swarmsDir();
    expect(d.endsWith(path.join('.ashlr', 'swarms'))).toBe(true);
  });

  it('is under the HOME directory', () => {
    expect(swarmsDir()).toContain('.ashlr');
  });
});

// ---------------------------------------------------------------------------
// loadSwarm — unknown / corrupt
// ---------------------------------------------------------------------------

describe('loadSwarm — unknown and corrupt', () => {
  it('returns null for an unknown id', () => {
    expect(loadSwarm('nonexistent-swarm-id-xyz')).toBeNull();
  });

  it('returns null for a corrupt JSON file', () => {
    const dir = swarmsDir();
    fs.mkdirSync(dir, { recursive: true });
    const corruptId = `corrupt-${Date.now()}`;
    fs.writeFileSync(path.join(dir, `${corruptId}.json`), '{not valid json!!!');
    expect(loadSwarm(corruptId)).toBeNull();
  });

  it('returns null for an empty file', () => {
    const dir = swarmsDir();
    fs.mkdirSync(dir, { recursive: true });
    const emptyId = `empty-${Date.now()}`;
    fs.writeFileSync(path.join(dir, `${emptyId}.json`), '');
    expect(loadSwarm(emptyId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// saveSwarm / loadSwarm — round-trip
// ---------------------------------------------------------------------------

describe('saveSwarm / loadSwarm — round-trip', () => {
  it('saves and reloads the same id', () => {
    const s = makeSwarmRun({ goal: 'round-trip goal' });
    saveSwarm(s);
    const loaded = loadSwarm(s.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(s.id);
  });

  it('preserves the goal', () => {
    const s = makeSwarmRun({ goal: 'unique goal text' });
    saveSwarm(s);
    expect(loadSwarm(s.id)!.goal).toBe('unique goal text');
  });

  it('preserves status', () => {
    const s = makeSwarmRun({ status: 'running' });
    saveSwarm(s);
    expect(loadSwarm(s.id)!.status).toBe('running');
  });

  it('preserves the full plan (tasks array)', () => {
    const s = makeSwarmRun();
    saveSwarm(s);
    const loaded = loadSwarm(s.id)!;
    expect(loaded.plan.tasks.length).toBe(s.plan.tasks.length);
    expect(loaded.plan.tasks[0]!.id).toBe(s.plan.tasks[0]!.id);
  });

  it('preserves task run states', () => {
    const s = makeSwarmRun();
    s.tasks[0]!.status = 'done';
    s.tasks[0]!.result = 'scaffold done';
    saveSwarm(s);
    const loaded = loadSwarm(s.id)!;
    expect(loaded.tasks[0]!.status).toBe('done');
    expect(loaded.tasks[0]!.result).toBe('scaffold done');
  });

  it('preserves usage', () => {
    const s = makeSwarmRun({ usage: makeUsage({ tokensIn: 250, tokensOut: 125, steps: 5 }) });
    saveSwarm(s);
    const loaded = loadSwarm(s.id)!;
    expect(loaded.usage.tokensIn).toBe(250);
    expect(loaded.usage.tokensOut).toBe(125);
    expect(loaded.usage.steps).toBe(5);
  });

  it('preserves budget', () => {
    const s = makeSwarmRun({ budget: makeBudget(99_000, 42) });
    saveSwarm(s);
    const loaded = loadSwarm(s.id)!;
    expect(loaded.budget.maxTokens).toBe(99_000);
    expect(loaded.budget.maxSteps).toBe(42);
  });

  it('preserves specId when set', () => {
    const s = makeSwarmRun({ specId: 'spec-abc-123' });
    saveSwarm(s);
    expect(loadSwarm(s.id)!.specId).toBe('spec-abc-123');
  });

  it('preserves project when set', () => {
    const s = makeSwarmRun({ project: '/tmp/my-project' });
    saveSwarm(s);
    expect(loadSwarm(s.id)!.project).toBe('/tmp/my-project');
  });

  it('preserves parallel setting', () => {
    const s = makeSwarmRun({ parallel: 5 });
    saveSwarm(s);
    expect(loadSwarm(s.id)!.parallel).toBe(5);
  });

  it('preserves the result when done', () => {
    const s = makeSwarmRun({ status: 'done', result: 'All phases complete.' });
    saveSwarm(s);
    expect(loadSwarm(s.id)!.result).toBe('All phases complete.');
  });

  it('writes to <swarmsDir>/<id>.json', () => {
    const s = makeSwarmRun();
    saveSwarm(s);
    const expectedPath = path.join(swarmsDir(), `${s.id}.json`);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it('written file is valid JSON', () => {
    const s = makeSwarmRun();
    saveSwarm(s);
    const raw = fs.readFileSync(path.join(swarmsDir(), `${s.id}.json`), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// saveSwarm — idempotency
// ---------------------------------------------------------------------------

describe('saveSwarm — idempotent overwrites', () => {
  it('second save overwrites status', () => {
    const s = makeSwarmRun({ status: 'planning' });
    saveSwarm(s);
    s.status = 'done';
    s.result = 'Updated result';
    saveSwarm(s);
    const loaded = loadSwarm(s.id)!;
    expect(loaded.status).toBe('done');
    expect(loaded.result).toBe('Updated result');
  });

  it('second save overwrites usage', () => {
    const s = makeSwarmRun();
    saveSwarm(s);
    s.usage = makeUsage({ tokensIn: 500, tokensOut: 250, steps: 10 });
    saveSwarm(s);
    const loaded = loadSwarm(s.id)!;
    expect(loaded.usage.tokensIn).toBe(500);
    expect(loaded.usage.steps).toBe(10);
  });

  it('multiple saves still produce one file', () => {
    const s = makeSwarmRun();
    saveSwarm(s);
    saveSwarm(s);
    saveSwarm(s);
    const dir = swarmsDir();
    const files = fs.readdirSync(dir).filter(f => f === `${s.id}.json`);
    expect(files.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// listSwarms
// ---------------------------------------------------------------------------

describe('listSwarms', () => {
  it('returns an empty array when no swarms exist', () => {
    expect(listSwarms()).toEqual([]);
  });

  it('returns saved swarms', () => {
    const a = makeSwarmRun({ goal: 'swarm A' });
    const b = makeSwarmRun({ goal: 'swarm B' });
    saveSwarm(a);
    saveSwarm(b);
    const ids = listSwarms().map(s => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('returns newest first (sorted by updatedAt desc)', () => {
    const older = makeSwarmRun();
    older.updatedAt = '2024-01-01T00:00:00.000Z';
    const newer = makeSwarmRun();
    newer.updatedAt = '2025-06-01T00:00:00.000Z';
    saveSwarm(older);
    saveSwarm(newer);
    const swarms = listSwarms();
    const olderIdx = swarms.findIndex(s => s.id === older.id);
    const newerIdx = swarms.findIndex(s => s.id === newer.id);
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it('skips corrupt JSON files without throwing', () => {
    const dir = swarmsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad-file.json'), 'THIS IS NOT JSON');
    const good = makeSwarmRun({ goal: 'good swarm' });
    saveSwarm(good);
    expect(() => listSwarms()).not.toThrow();
    const ids = listSwarms().map(s => s.id);
    expect(ids).toContain(good.id);
  });

  it('each returned entry is a valid SwarmRun shape', () => {
    const s = makeSwarmRun({ status: 'done', result: 'Test result' });
    saveSwarm(s);
    const swarms = listSwarms();
    const found = swarms.find(r => r.id === s.id);
    expect(found).toBeDefined();
    expect(typeof found!.id).toBe('string');
    expect(typeof found!.goal).toBe('string');
    expect(typeof found!.createdAt).toBe('string');
    expect(Array.isArray(found!.tasks)).toBe(true);
    expect(typeof found!.usage.tokensIn).toBe('number');
  });
});

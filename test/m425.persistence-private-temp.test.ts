import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunState, SwarmRun } from '../src/core/types.js';

const mocks = vi.hoisted(() => ({
  assure: vi.fn(() => ({ ok: true, reason: 'exact-private-dacl' })),
}));

vi.mock('../src/core/util/private-storage.js', () => ({
  assurePrivateStoragePath: mocks.assure,
}));

import { saveRun } from '../src/core/run/orchestrator.js';
import { saveSwarm } from '../src/core/swarm/store.js';

function runState(id: string): RunState {
  const now = '2026-07-14T12:00:00.000Z';
  return {
    id,
    goal: 'secure run persistence',
    engine: 'builtin',
    provider: 'ollama',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    tasks: [],
    steps: [],
    status: 'running',
  };
}

function swarmState(id: string): SwarmRun {
  const now = '2026-07-14T12:00:00.000Z';
  const goal = 'secure swarm persistence';
  return {
    id,
    goal,
    specId: null,
    project: null,
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    parallel: 1,
    status: 'running',
    plan: { specId: null, goal, tasks: [] },
    tasks: [],
  };
}

describe('M425 private persistence temporaries', () => {
  let home: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    home = mkdtempSync(join(tmpdir(), 'ashlr-m425-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mocks.assure.mockReset();
    mocks.assure.mockReturnValue({ ok: true, reason: 'exact-private-dacl' });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses and cleans a run temporary when private-file assurance fails', () => {
    const id = 'm425-run';
    mocks.assure.mockImplementation((path: string, kind: string, mode: string) =>
      path.includes(`${id}.json.`) && path.endsWith('.tmp') &&
        kind === 'file' && mode === 'secure-created'
        ? { ok: false, reason: 'adapter-failed' }
        : { ok: true, reason: 'exact-private-dacl' });

    expect(() => saveRun(runState(id))).toThrow(/temporary file is unsafe: adapter-failed/i);

    const dir = join(home, '.ashlr', 'runs');
    expect(existsSync(join(dir, `${id}.json`))).toBe(false);
    expect(readdirSync(dir).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('refuses and cleans a swarm temporary when private-file assurance fails', () => {
    const id = 'm425-swarm';
    mocks.assure.mockImplementation((path: string, kind: string, mode: string) =>
      path.includes(`${id}.json.`) && path.endsWith('.tmp') &&
        kind === 'file' && mode === 'secure-created'
        ? { ok: false, reason: 'adapter-failed' }
        : { ok: true, reason: 'exact-private-dacl' });

    expect(saveSwarm(swarmState(id))).toEqual({ ok: false, reason: 'unavailable' });

    const dir = join(home, '.ashlr', 'swarms');
    expect(existsSync(join(dir, `${id}.json`))).toBe(false);
    expect(readdirSync(dir).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('secures each store temporary before publishing its record', () => {
    saveRun(runState('m425-run-success'));
    expect(saveSwarm(swarmState('m425-swarm-success'))).toEqual({ ok: true, revision: 1 });

    const securedTemporaries = mocks.assure.mock.calls.filter(([path, kind, mode]) =>
      /m425-(?:run|swarm)-success\.json\..*\.tmp$/u.test(String(path)) &&
        kind === 'file' && mode === 'secure-created');
    expect(securedTemporaries).toHaveLength(2);
    for (const [path, , , options] of securedTemporaries) {
      expect(options).toEqual({ anchorPath: join(home, '.ashlr') });
      expect(existsSync(String(path))).toBe(false);
    }
  });
});

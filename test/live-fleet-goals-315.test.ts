/**
 * 3.15 "the live fleet actually works" — goals reach the fleet mirrors.
 *
 * Live (2026-09-27): goals are bound to Mason's checkouts
 * (~/Desktop/github/dev-tools/binshield) while a standing daemon enrolls only
 * the fleet's mirrors (~/.ashlr/fleet/mirrors/ashlrai__binshield), and
 * scanGoals matched paths exactly — so no goal ever became work under a
 * grant, not even the three on in-grant repos.
 *
 * Hermetic: tmp HOME with a fake checkout (.git/config origin) and a mirror.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { goalProjectMatchesRepo } from '../src/core/goals/project-match.js';
import { goalFocusSnapshot } from '../src/core/goals/focus.js';
import { addMilestone, createGoal } from '../src/core/goals/store.js';
import { scanGoals } from '../src/core/portfolio/scanners.js';
import type { Goal } from '../src/core/types.js';

let home = '';
let savedHome: string | undefined;

function checkout(name: string, origin: string | null): string {
  const dir = join(home, 'dev-tools', name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), origin === null
    ? '[core]\n\trepositoryformatversion = 0\n'
    : `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  return dir;
}

function mirror(slug: string): string {
  const dir = join(home, '.ashlr', 'fleet', 'mirrors', slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'live-fleet-goals-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('goalProjectMatchesRepo', () => {
  it('matches the exact checkout, as before', () => {
    const co = checkout('binshield', 'https://github.com/ashlrai/binshield.git');
    expect(goalProjectMatchesRepo(co, co)).toBe(true);
    expect(goalProjectMatchesRepo(`${co}/`, co)).toBe(true);
  });

  it('matches the fleet mirror of the same GitHub repo (https and ssh origins, any case)', () => {
    const https = checkout('binshield', 'https://github.com/ashlrai/binshield.git');
    const ssh = checkout('ashlrcode', 'git@github.com:AshlrAI/ashlrcode.git');
    expect(goalProjectMatchesRepo(https, mirror('ashlrai__binshield'))).toBe(true);
    expect(goalProjectMatchesRepo(ssh, mirror('ashlrai__ashlrcode'))).toBe(true);
  });

  it('never matches another repo, a checkout without a GitHub origin, or no project', () => {
    const co = checkout('binshield', 'https://github.com/ashlrai/binshield.git');
    const noOrigin = checkout('scratch', null);
    const gitlab = checkout('elsewhere', 'https://gitlab.com/ashlrai/binshield.git');
    expect(goalProjectMatchesRepo(co, mirror('ashlrai__fleet-canary'))).toBe(false);
    expect(goalProjectMatchesRepo(noOrigin, mirror('ashlrai__binshield'))).toBe(false);
    expect(goalProjectMatchesRepo(gitlab, mirror('ashlrai__binshield'))).toBe(false);
    expect(goalProjectMatchesRepo(null, mirror('ashlrai__binshield'))).toBe(false);
    expect(goalProjectMatchesRepo('', mirror('ashlrai__binshield'))).toBe(false);
  });

  it('only a MIRROR widens the match: two checkouts of one repo still do not match each other', () => {
    const a = checkout('binshield', 'https://github.com/ashlrai/binshield.git');
    const b = checkout('binshield-copy', 'https://github.com/ashlrai/binshield.git');
    expect(goalProjectMatchesRepo(a, b)).toBe(false);
    // A directory that merely looks like a mirror but is not under ~/.ashlr/fleet/mirrors.
    const fake = join(home, 'elsewhere', 'ashlrai__binshield');
    mkdirSync(fake, { recursive: true });
    expect(goalProjectMatchesRepo(a, fake)).toBe(false);
  });
});

describe('goal focus sees goals through their mirror', () => {
  function goal(id: string, project: string | null): Goal {
    return {
      id,
      objective: `Objective ${id}`,
      project,
      status: 'active',
      milestones: [{ id: 'm1', title: 'Step', status: 'pending', order: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    } as unknown as Goal;
  }

  it('scopes to the mirror repo the daemon enrolled', () => {
    const bin = checkout('binshield', 'https://github.com/ashlrai/binshield.git');
    const hub = checkout('ashlr-hub', 'https://github.com/ashlrai/ashlr-hub.git');
    const goals = [goal('g-bin', bin), goal('g-hub', hub), goal('g-none', null)];
    const snap = goalFocusSnapshot(goals, null, { repo: mirror('ashlrai__binshield') });
    expect(snap.activeGoalCount).toBe(1);
    expect(snap.focusedGoalIds).toEqual(['g-bin']);
    const both = goalFocusSnapshot(goals, null, { repos: [mirror('ashlrai__binshield'), mirror('ashlrai__fleet-canary')] });
    expect(both.activeGoalCount).toBe(1);
  });
});

describe('scanGoals emits goal work in the fleet mirror', () => {
  it('a goal bound to Mason\'s checkout becomes a work item for its mirror, and only there', async () => {
    const bin = checkout('binshield', 'https://github.com/ashlrai/binshield.git');
    const hub = checkout('ashlr-hub', 'https://github.com/ashlrai/ashlr-hub.git');
    const g = createGoal('Add a circuit breaker to the worker scan', { project: bin });
    addMilestone(g.id, { title: 'Wrap the scan loop', detail: 'Add a breaker around the worker scan.' });
    const h = createGoal('Hub-only goal', { project: hub });
    addMilestone(h.id, { title: 'Hub step', detail: 'Something in the hub.' });

    const binMirror = mirror('ashlrai__binshield');
    const items = await scanGoals(binMirror);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: binMirror, source: 'goal' });
    expect(JSON.stringify(items[0])).toContain(g.id);
    // A mirror of a repo no goal targets gets nothing; the checkout itself still works as before.
    expect(await scanGoals(mirror('ashlrai__fleet-canary'))).toEqual([]);
    expect((await scanGoals(bin)).map((i) => i.repo)).toEqual([bin]);
  });
});

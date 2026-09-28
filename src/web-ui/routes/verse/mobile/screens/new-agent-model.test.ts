/**
 * New agent's pure decisions: repo order and default, which seats can run
 * (and why not), what each selected seat will run, and when Start is ready.
 */
import { describe, expect, it } from 'vitest';
import type { VerseProject, VerseSeat, VerseSession } from '../../../../data/api-types.js';
import {
  defaultProjectPath,
  defaultSeatId,
  joinNames,
  modelOptionText,
  orderProjects,
  orderSeats,
  partialFailureText,
  seatBlockedReason,
  spawnConsequences,
  spawnPlan,
  startBlocker,
} from './new-agent-model.js';

function seat(id: string, engine: VerseSeat['engine'], over: Partial<VerseSeat> = {}): VerseSeat {
  return {
    id,
    engine,
    label: over.label ?? id,
    accountId: id,
    models: [
      { id: `${id}-m1`, label: `${id} model 1`, contextWindow: 200_000 },
      { id: `${id}-m2`, label: `${id} model 2`, contextWindow: 200_000 },
    ],
    contextWindow: 200_000,
    health: { state: 'ready', summary: null, windows: [], observedAt: null },
    ...over,
  };
}

const project = (name: string, enrolled = false): VerseProject => ({ path: `/Users/me/code/${name}`, name, enrolled });

function session(path: string, updatedAt: string): VerseSession {
  return { projectPath: path, updatedAt } as unknown as VerseSession;
}

describe('repos', () => {
  const projects = [project('zeta'), project('alpha'), project('hub', true), project('beta')];
  const sessions = [session('/Users/me/code/beta', '2026-09-27T10:00:00Z'), session('/Users/me/code/zeta', '2026-09-26T10:00:00Z')];

  it('puts enrolled repos first, then the most recently used, then by name', () => {
    expect(orderProjects(projects, sessions).map((p) => p.name)).toEqual(['hub', 'beta', 'zeta', 'alpha']);
  });

  it('filters by name or path, case-insensitively', () => {
    expect(orderProjects(projects, sessions, 'ALP').map((p) => p.name)).toEqual(['alpha']);
    expect(orderProjects(projects, sessions, 'code/be').map((p) => p.name)).toEqual(['beta']);
    expect(orderProjects(projects, sessions, 'nothing')).toEqual([]);
  });

  it('preselects the repo used last, else the first in list order', () => {
    expect(defaultProjectPath(projects, sessions)).toBe('/Users/me/code/beta');
    expect(defaultProjectPath(projects, [])).toBe('/Users/me/code/hub');
    expect(defaultProjectPath([], [])).toBeNull();
  });
});

describe('seats', () => {
  const claude = seat('claude', 'claude', { label: 'Claude Code' });
  const codex = seat('codex', 'codex', { label: 'Codex', health: { state: 'unavailable', summary: 'signed out of Codex', windows: [], observedAt: null } });
  const grok = seat('grok', 'grok', { label: 'Grok' });
  const local = seat('local:qwen', 'local', { label: 'Qwen (local)' });
  const stale = seat('devin', 'devin', { label: 'Devin', models: [{ id: 'd', label: 'Devin', contextWindow: null, unavailableReason: 'needs a newer CLI' }] });
  const seats = [local, grok, stale, codex, claude];

  it('orders seats like the workbench picker', () => {
    expect(orderSeats(seats).map((s) => s.id)).toEqual(['claude', 'codex', 'devin', 'grok', 'local:qwen']);
  });

  it('says why a seat cannot run', () => {
    expect(seatBlockedReason(claude, seats)).toBeNull();
    expect(seatBlockedReason(codex, seats)).toBe('signed out of Codex');
    expect(seatBlockedReason(stale, seats)).toBe('no model this seat can run');
  });

  it('refuses an exhausted seat and names where to go', () => {
    const spent = seat('claude', 'claude', {
      label: 'Claude Code',
      capacity: { usability: 'exhausted', windows: [], binding: null } as unknown as VerseSeat['capacity'],
    });
    const reason = seatBlockedReason(spent, [spent, grok]);
    expect(reason).toMatch(/out of usage/);
    expect(reason).toMatch(/try Grok/);
  });

  it('defaults to the first seat that can run', () => {
    expect(defaultSeatId(seats)).toBe('claude');
    expect(defaultSeatId([codex, stale])).toBeNull();
  });

  it('labels a model that cannot run with why', () => {
    expect(modelOptionText({ id: 'x', label: 'Opus', contextWindow: null, unavailableReason: 'needs 2.1.280' })).toBe('Opus — needs 2.1.280');
    expect(modelOptionText({ id: 'x', label: 'Opus', contextWindow: null })).toBe('Opus');
  });

  it('plans the chosen model for the primary seat and defaults for the rest, dropping blocked seats', () => {
    const plan = spawnPlan({ seats, seatIds: ['claude', 'codex', 'grok'], primaryModel: 'claude-m2' });
    expect(plan).toEqual([
      { seatId: 'claude', seatLabel: 'Claude Code', model: 'claude-m2' },
      { seatId: 'grok', seatLabel: 'Grok', model: 'grok-m1' },
    ]);
  });

  it('ignores a chosen model the seat cannot run', () => {
    const odd = seat('claude', 'claude', { models: [{ id: 'a', label: 'A', contextWindow: null, unavailableReason: 'old CLI' }, { id: 'b', label: 'B', contextWindow: null }] });
    expect(spawnPlan({ seats: [odd], seatIds: ['claude'], primaryModel: 'a' })[0]?.model).toBe('b');
  });
});

describe('start', () => {
  const plan = [
    { seatId: 'claude', seatLabel: 'Claude Code', model: 'm' },
    { seatId: 'codex', seatLabel: 'Codex', model: 'm' },
    { seatId: 'grok', seatLabel: 'Grok', model: 'm' },
  ];

  it('is blocked until a repo, a seat and a prompt are there', () => {
    expect(startBlocker({ projectPath: null, plan, prompt: 'x' })).toBe('Choose a repo.');
    expect(startBlocker({ projectPath: '/r', plan: [], prompt: 'x' })).toBe('Choose a seat that can run.');
    expect(startBlocker({ projectPath: '/r', plan, prompt: '   ' })).toBe('Say what the agent should do.');
    expect(startBlocker({ projectPath: '/r', plan, prompt: 'fix it' })).toBeNull();
  });

  it('says what several agents will do', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(spawnConsequences(plan, 'hub')).toBe('Starts 3 agents on Claude Code, Codex and Grok in hub; each spends from its own seat.');
  });

  it('names the seats that failed', () => {
    const text = partialFailureText([
      { target: plan[0]!, sessionId: 's1', error: null },
      { target: plan[1]!, sessionId: null, error: 'Codex is signed out.' },
    ]);
    expect(text).toBe('Started 1 of 2 agents. Codex: Codex is signed out.');
  });
});

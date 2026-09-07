import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as campaignStore from '../src/core/universe/campaign-store.js';
import {
  buildUniversePortfolioPlan, readUniversePortfolioPlan, validateUniversePortfolioDefinition,
} from '../src/core/universe/portfolio-plan.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';

const sampledAt = '2026-09-07T00:00:00.000Z';
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function definition(ids = ['a', 'b', 'c']): UniversePortfolioDefinition {
  return { schemaVersion: 1, id: 'portfolio', tasks: ids.map((campaignId) => ({ campaignId, dependsOn: [] })),
    maxParallel: 2, maxDurationMs: 60_000 };
}

function campaign(id: string, state: UniverseCampaignSummary['state'] = 'ready'): UniverseCampaignSummary {
  const definition = { schemaVersion: 1 as const, id, universeId: `universe-${id}`, feedback: true,
    budget: { maxGenerations: 3, maxDurationMs: 60_000, maxModelRequests: 3, maxStagnantGenerations: 2, maxReportedTokens: null } };
  return { definition, definitionDigest: digest(canonical(definition)), manifestDigest: 'a'.repeat(64),
    comparatorDigest: 'b'.repeat(64), createdAt: sampledAt, state, reason: null,
    startedAt: null, deadlineAt: null, finishedAt: null, steps: [],
    progress: { attempts: 0, completedRuns: 0, interruptedRuns: 0, reservedModelRequests: 0,
      reportedTokens: 0, recordedTokens: 0, usageComplete: true, admissions: 0, improvements: 0, stagnantGenerations: 0 },
    owner: null, sourceState: 'healthy', reasons: [] };
}

function evidence(ids = ['a', 'b', 'c']): Map<string, UniverseCampaignSummary | null> {
  return new Map(ids.map((id) => [id, campaign(id)]));
}

describe('strict bounded Universe portfolio definitions', () => {
  it('clones the exact definition without retaining mutable caller arrays', () => {
    const input = definition();
    input.tasks[1]!.dependsOn = ['a'];
    const validated = validateUniversePortfolioDefinition(input);
    expect(validated).toEqual(input);
    expect(validated).not.toBe(input);
    expect(validated.tasks).not.toBe(input.tasks);
    expect(validated.tasks[1]!.dependsOn).not.toBe(input.tasks[1]!.dependsOn);
    input.tasks[1]!.dependsOn.push('c');
    expect(validated.tasks[1]!.dependsOn).toEqual(['a']);
  });

  it.each([
    ['schemaVersion', 2], ['id', ''], ['id', '../outside'], ['id', 'UPPER'], ['id', 'x'.repeat(65)],
    ['maxParallel', 0], ['maxParallel', 9], ['maxParallel', 1.5], ['maxParallel', NaN],
    ['maxDurationMs', 0], ['maxDurationMs', 86_400_001], ['maxDurationMs', Infinity],
    ['tasks', []], ['tasks', new Array(2)], ['tasks', Array.from({ length: 65 }, (_, index) => ({ campaignId: `x${index}`, dependsOn: [] }))],
  ])('rejects invalid %s=%j before reading selected campaigns', (key, value) => {
    const reader = vi.spyOn(campaignStore, 'readUniverseCampaign');
    expect(() => readUniversePortfolioPlan({ ...definition(), [key]: value })).toThrow(/Invalid Universe portfolio/);
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([
    { ...definition(), extra: true },
    { ...definition(), tasks: [{ campaignId: 'a', dependsOn: [], extra: true }] },
    { ...definition(), tasks: [{ campaignId: 'a', dependsOn: [] }, { campaignId: 'a', dependsOn: [] }] },
    { ...definition(), tasks: [{ campaignId: 'a', dependsOn: ['a'] }] },
    { ...definition(), tasks: [{ campaignId: 'a', dependsOn: ['missing'] }] },
    { ...definition(), tasks: [{ campaignId: 'a', dependsOn: [] }, { campaignId: 'b', dependsOn: ['a', 'a'] }] },
    { ...definition(), tasks: [{ campaignId: 'a', dependsOn: new Array(1) }] },
    { ...definition(), tasks: [{ campaignId: 'a', dependsOn: null }] },
    { ...definition(), tasks: [{ campaignId: 'a', dependsOn: Array.from({ length: 64 }, (_, index) => `x${index}`) }] },
    Object.assign(Object.create({ inherited: true }), definition()),
    { ...definition(), [Symbol('hidden')]: true },
  ])('rejects malformed or ambiguous exact task schema %#', (input) => {
    expect(() => validateUniversePortfolioDefinition(input)).toThrow(/Invalid Universe portfolio/);
  });

  it('rejects disconnected cycles using bounded iterative traversal', () => {
    const input = definition();
    input.tasks[1]!.dependsOn = ['c']; input.tasks[2]!.dependsOn = ['b'];
    expect(() => validateUniversePortfolioDefinition(input)).toThrow(/cycle/);
  });

  it('supports all64 tasks and the maximum acyclic dependency set', () => {
    const ids = Array.from({ length: 64 }, (_, index) => `task-${index}`);
    const input = definition(ids);
    input.maxParallel = 8; input.maxDurationMs = 86_400_000;
    input.tasks.forEach((task, index) => { task.dependsOn = ids.slice(0, index); });
    const result = buildUniversePortfolioPlan(input, evidence(ids), sampledAt);
    expect(result.sourceState).toBe('healthy');
    expect(result.topologicalOrder).toEqual(ids);
    expect(result.nodes.filter((node) => node.state === 'ready')).toHaveLength(1);
  });
});

describe('Universe portfolio evidence and dependency planning', () => {
  it('uses deterministic input-priority topology while retaining input node order', () => {
    const input = definition(['dependent', 'root', 'independent']);
    input.tasks[0]!.dependsOn = ['root'];
    const plan = buildUniversePortfolioPlan(input, evidence(['dependent', 'root', 'independent']), sampledAt);
    expect(plan.topologicalOrder).toEqual(['root', 'dependent', 'independent']);
    expect(plan.nodes.map((node) => node.campaignId)).toEqual(['dependent', 'root', 'independent']);
    expect(plan.nodes.map((node) => node.state)).toEqual(['waiting', 'ready', 'ready']);
    expect(plan.definitionDigest).toBe(digest(canonical(input)));
    expect(plan).toMatchObject({ schemaVersion: 1, sampledAt, sourceState: 'healthy', measurementScope: 'local-experiment', reasons: [] });
  });

  it('accepts completion as ordering without inventing accepted changes or historical causality', () => {
    const input = definition(); input.tasks[1]!.dependsOn = ['a']; input.tasks[2]!.dependsOn = ['b'];
    const snapshots = evidence(); snapshots.get('a')!.state = 'failed'; snapshots.get('b')!.state = 'completed';
    const plan = buildUniversePortfolioPlan(input, snapshots, sampledAt);
    expect(plan.nodes.map((node) => node.state)).toEqual(['blocked', 'completed', 'ready']);
    expect(plan.nodes[1]!.campaign!.progress.admissions).toBe(0);
    expect(plan.nodes[1]!.reason).toMatch(/not an accepted-work claim/);
    expect(plan.sourceState).toBe('healthy');
  });

  it.each(['ready', 'paused', 'interrupted'] as const)('allows explicit enrollment to run or resume %s', (state) => {
    const result = buildUniversePortfolioPlan(definition(['a']), new Map([['a', campaign('a', state)]]), sampledAt);
    expect(result.nodes[0]!.state).toBe('ready');
  });

  it.each(['failed', 'stopped', 'pause-requested', 'stop-requested'] as const)('blocks transitive descendants of %s while independent work stays ready', (state) => {
    const input = definition(['a', 'b', 'c', 'independent']);
    input.tasks[1]!.dependsOn = ['a']; input.tasks[2]!.dependsOn = ['b'];
    const snapshots = evidence(['a', 'b', 'c', 'independent']); snapshots.get('a')!.state = state;
    const plan = buildUniversePortfolioPlan(input, snapshots, sampledAt);
    expect(plan.nodes.map((node) => node.state)).toEqual(['blocked', 'blocked', 'blocked', 'ready']);
    expect(plan.sourceState).toBe('healthy');
  });

  it('reports external running work as busy, leaving descendants waiting', () => {
    const input = definition(['a', 'b']); input.tasks[1]!.dependsOn = ['a'];
    const snapshots = evidence(['a', 'b']); snapshots.get('a')!.state = 'running';
    const plan = buildUniversePortfolioPlan(input, snapshots, sampledAt);
    expect(plan.nodes.map((node) => node.state)).toEqual(['busy', 'waiting']);
  });

  it.each(['absent', 'null', 'degraded', 'wrong-id', 'wrong-digest', 'malformed-pin', 'contradictory-reasons'] as const)(
    'degrades the whole plan on %s evidence without private error text or usable identity pins', (mode) => {
      const input = definition(); input.tasks[1]!.dependsOn = ['a'];
      const snapshots = evidence();
      if (mode === 'absent') snapshots.delete('a');
      else if (mode === 'null') snapshots.set('a', null);
      else {
        const selected = snapshots.get('a')!;
        if (mode === 'degraded') selected.sourceState = 'degraded';
        if (mode === 'wrong-id') selected.definition.id = 'other';
        if (mode === 'wrong-digest') selected.definitionDigest = 'c'.repeat(64);
        if (mode === 'malformed-pin') selected.manifestDigest = 'not-a-digest';
        if (mode === 'contradictory-reasons') selected.reasons.push('private /Users/secret error');
      }
      const result = buildUniversePortfolioPlan(input, snapshots, sampledAt);
      expect(result.sourceState).toBe('degraded');
      expect(result.nodes.map((node) => node.state)).toEqual(['unavailable', 'blocked', 'ready']);
      expect(result.nodes[0]).toMatchObject({ universeId: null, definitionDigest: null, manifestDigest: null, comparatorDigest: null });
      expect(JSON.stringify(result.reasons)).not.toContain('/Users/');
      expect(result.reasons).toHaveLength(1);
    });

  it('rejects duplicate Universe enrollment even if both campaigns completed previously', () => {
    const snapshots = evidence(['a', 'b']);
    snapshots.get('a')!.state = 'completed'; snapshots.get('b')!.state = 'completed';
    snapshots.get('b')!.definition.universeId = snapshots.get('a')!.definition.universeId;
    snapshots.get('b')!.definitionDigest = digest(canonical(snapshots.get('b')!.definition));
    const result = buildUniversePortfolioPlan(definition(['a', 'b']), snapshots, sampledAt);
    expect(result.sourceState).toBe('degraded');
    expect(result.nodes.map((node) => node.state)).toEqual(['blocked', 'blocked']);
    expect(result.reasons).toHaveLength(2);
  });

  it('does not alias caller definitions, campaign snapshots or identity data', () => {
    const input = definition(); const snapshots = evidence();
    const result = buildUniversePortfolioPlan(input, snapshots, sampledAt);
    const original = structuredClone(result);
    input.tasks[0]!.campaignId = 'mutated';
    snapshots.get('a')!.definition.universeId = 'mutated'; snapshots.get('a')!.manifestDigest = 'd'.repeat(64);
    snapshots.clear();
    expect(result).toEqual(original);
    result.nodes[0]!.dependsOn.push('c');
    expect(result.definition.tasks[0]!.dependsOn).toEqual([]);
  });

  it('keeps sample-time changes out of the definition identity', () => {
    const input = definition(); const snapshots = evidence();
    expect(buildUniversePortfolioPlan(input, snapshots, sampledAt).definitionDigest)
      .toBe(buildUniversePortfolioPlan(input, snapshots, '2026-09-07T01:00:00.000Z').definitionDigest);
    expect(() => buildUniversePortfolioPlan(input, snapshots, 'not-time')).toThrow(/sample time/);
  });

  it('reads each enrolled campaign exactly once, forwarding the selected root and ignoring unrelated inventory', () => {
    const reader = vi.spyOn(campaignStore, 'readUniverseCampaign').mockImplementation((id) => campaign(id));
    const inventory = vi.spyOn(campaignStore, 'readUniverseCampaigns');
    const result = readUniversePortfolioPlan(definition(['a', 'b']), { root: '/selected/private/store' });
    expect(reader.mock.calls).toEqual([['a', { root: '/selected/private/store' }], ['b', { root: '/selected/private/store' }]]);
    expect(inventory).not.toHaveBeenCalled();
    expect(result.sourceState).toBe('healthy');
  });

  it('handles read failures as bounded unavailable evidence without stopping later targeted reads', () => {
    const reader = vi.spyOn(campaignStore, 'readUniverseCampaign').mockImplementation((id) => {
      if (id === 'a') throw new Error('private /Users/secret error');
      return campaign(id);
    });
    const result = readUniversePortfolioPlan(definition(['a', 'b']));
    expect(reader).toHaveBeenCalledTimes(2);
    expect(result.nodes.map((node) => node.state)).toEqual(['unavailable', 'ready']);
    expect(JSON.stringify(result)).not.toContain('/Users/');
  });

  it('does not create a missing store during planning', () => {
    const parent = mkdtempSync(join(tmpdir(), 'universe-portfolio-plan-')); temporary.push(parent);
    const root = join(parent, 'missing');
    const result = readUniversePortfolioPlan(definition(['missing']), { root });
    expect(result.sourceState).toBe('degraded');
    expect(result.nodes[0]!.state).toBe('unavailable');
    expect(existsSync(root)).toBe(false);
  });
});

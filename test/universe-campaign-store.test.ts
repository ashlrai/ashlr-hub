import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCampaignEvent, campaignDirectory, foldCampaignEvents, initUniverseCampaign, readCampaignEvents,
  readUniverseCampaign, readUniverseCampaigns, requestUniverseCampaignControl, validateUniverseCampaignDefinition,
} from '../src/core/universe/campaign-store.js';
import type { UniverseCampaignDefinition, UniverseSummary } from '../src/core/universe/types.js';

const state = vi.hoisted(() => ({ universe: null as UniverseSummary | null }));
vi.mock('../src/core/universe/store.js', () => ({
  projectUniverse: vi.fn(() => {
    if (!state.universe) throw new Error('Fixture Universe missing');
    return structuredClone(state.universe);
  }),
  universePath: (root: string, id: string) => `${root}/universes/${id}`,
  scheduledVariants: (manifest: UniverseSummary['manifest'], generation: number) => {
    const count = Math.min(manifest.budget.maxTrials, manifest.variants.length);
    return Array.from({ length: count }, (_, index) => manifest.variants[((generation - 1) * count + index) % manifest.variants.length]);
  },
}));

const roots: string[] = [];
afterEach(() => {
  state.universe = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; definition: UniverseCampaignDefinition } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-campaign-store-')));
  roots.push(root);
  state.universe = { manifest: { schemaVersion: 1, id: 'fixture', name: 'Fixture', objective: 'Measure fixture',
    seed: { repo: '/fixture-repository', revision: 'a'.repeat(40) },
    metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 1000, trialTimeoutMs: 1000 },
    evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'change', niche: 'correct', hypothesis: 'Change value', command: ['node', 'change.mjs'] }] },
  manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), runs: [], elites: [], activeRun: null,
  sourceState: 'healthy', reasons: [] };
  return { root, definition: { schemaVersion: 1, id: 'test-campaign', universeId: 'fixture', feedback: true,
    budget: { maxGenerations: 3, maxDurationMs: 60_000, maxModelRequests: 3, maxStagnantGenerations: 2, maxReportedTokens: null } } };
}

describe('strict Universe campaign definition and private store', () => {
  it.each([
    ['maxGenerations', 0], ['maxGenerations', 129], ['maxDurationMs', 0], ['maxDurationMs', 86_400_001],
    ['maxModelRequests', -1], ['maxModelRequests', 8193], ['maxStagnantGenerations', 0], ['maxReportedTokens', 0],
    ['maxReportedTokens', Infinity], ['maxModelRequests', 1.5],
  ])('rejects invalid budget %s=%s', (key, value) => {
    const { definition } = fixture();
    expect(() => validateUniverseCampaignDefinition({ ...definition, budget: { ...definition.budget, [key]: value } })).toThrow(/Invalid Universe campaign/);
  });

  it('accepts command-only zero-request budgets and clones caller-owned definitions', () => {
    const { definition } = fixture();
    definition.budget.maxModelRequests = 0;
    const validated = validateUniverseCampaignDefinition(definition);
    expect(validated).toEqual(definition);
    expect(validated).not.toBe(definition);
    expect(validated.budget).not.toBe(definition.budget);
    expect(() => validateUniverseCampaignDefinition({ ...definition, id: '../escape' })).toThrow();
    expect(() => validateUniverseCampaignDefinition({ ...definition, extra: true })).toThrow();
  });

  it('initializes once, pins Universe identity, and rejects definition replacement', () => {
    const { root, definition } = fixture();
    const first = initUniverseCampaign(definition, { root });
    expect(first).toMatchObject({ definition, state: 'ready', sourceState: 'healthy', startedAt: null, deadlineAt: null,
      manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), progress: { attempts: 0, reservedModelRequests: 0 } });
    expect(initUniverseCampaign(definition, { root })).toEqual(first);
    expect(readUniverseCampaigns({ root })).toMatchObject({ sourceState: 'healthy', campaigns: [first], reasons: [] });
    expect(() => initUniverseCampaign({ ...definition, feedback: false }, { root })).toThrow(/immutable/);
    expect(readCampaignEvents(campaignDirectory(definition.id, { root }))).toHaveLength(1);
  });

  it('never initializes missing state from observation or controls', () => {
    const { root } = fixture();
    const absent = join(root, 'absent');
    expect(readUniverseCampaigns({ root: absent })).toEqual({ campaigns: [], sourceState: 'missing', reasons: [] });
    expect(() => readUniverseCampaign('missing', { root: absent })).toThrow();
    expect(() => requestUniverseCampaignControl('missing', 'stop', { root: absent })).toThrow();
    expect(existsSync(absent)).toBe(false);
  });

  it('reports a dangling inventory symlink as degraded without creating its target', () => {
    const { root } = fixture();
    const target = join(root, 'absent');
    symlinkSync(target, join(root, 'campaigns'), 'dir');
    expect(readUniverseCampaigns({ root }).sourceState).toBe('degraded');
    expect(existsSync(target)).toBe(false);
  });

  it('acknowledges idle controls and keeps terminal stop idempotent', () => {
    const { root, definition } = fixture();
    initUniverseCampaign(definition, { root });
    expect(requestUniverseCampaignControl(definition.id, 'pause', { root }).state).toBe('paused');
    expect(requestUniverseCampaignControl(definition.id, 'pause', { root }).state).toBe('paused');
    expect(requestUniverseCampaignControl(definition.id, 'stop', { root }).state).toBe('stopped');
    const before = readCampaignEvents(campaignDirectory(definition.id, { root }));
    expect(requestUniverseCampaignControl(definition.id, 'pause', { root }).state).toBe('stopped');
    expect(requestUniverseCampaignControl(definition.id, 'stop', { root }).state).toBe('stopped');
    expect(readCampaignEvents(campaignDirectory(definition.id, { root }))).toEqual(before);
  });

  it('persists pause and stop requests without falsely acknowledging a live owner', () => {
    const { root, definition } = fixture();
    initUniverseCampaign(definition, { root });
    const directory = campaignDirectory(definition.id, { root });
    const at = new Date().toISOString();
    appendCampaignEvent(directory, { kind: 'started', at,
      deadlineAt: new Date(Date.parse(at) + definition.budget.maxDurationMs).toISOString(), owner: { pid: process.pid, startRef: 'fixture-owner' } });
    expect(requestUniverseCampaignControl(definition.id, 'pause', { root }).state).toBe('pause-requested');
    expect(requestUniverseCampaignControl(definition.id, 'stop', { root }).state).toBe('stop-requested');
    expect(readCampaignEvents(directory).filter((event) => event.kind === 'settled')).toHaveLength(0);
    expect(() => appendCampaignEvent(directory, { kind: 'settled', state: 'completed', at, reason: 'Cannot ignore stop' })).toThrow(/ignored/);
    appendCampaignEvent(directory, { kind: 'settled', state: 'stopped', at, reason: 'Owner acknowledged stop' });
    expect(readUniverseCampaign(definition.id, { root }).owner).toBeNull();
  });

  it('does not reset a damaged history to a fresh campaign budget', () => {
    const { root, definition } = fixture();
    initUniverseCampaign(definition, { root });
    const directory = campaignDirectory(definition.id, { root });
    const first = readFileSync(join(directory, 'ledger', 'records', '00000000.json'), 'utf8');
    writeFileSync(join(directory, 'ledger', 'records', '00000001.json'), '{"invalid":true}\n', { mode: 0o600 });
    const summary = readUniverseCampaign(definition.id, { root });
    expect(summary).toMatchObject({ state: 'failed', sourceState: 'degraded', progress: { reportedTokens: null, usageComplete: false } });
    expect(summary.reasons.length).toBeGreaterThan(0);
    expect(() => initUniverseCampaign(definition, { root })).toThrow(/degraded/);
    expect(() => requestUniverseCampaignControl(definition.id, 'stop', { root })).toThrow(/degraded/);
    expect(readFileSync(join(directory, 'ledger', 'records', '00000000.json'), 'utf8')).toBe(first);
  });

  it('fails closed when pinned Universe evidence changes', () => {
    const { root, definition } = fixture();
    initUniverseCampaign(definition, { root });
    state.universe!.comparatorDigest = 'd'.repeat(64);
    expect(readUniverseCampaign(definition.id, { root })).toMatchObject({ sourceState: 'degraded', reasons: ['Campaign pinned Universe identity changed'] });
    expect(() => initUniverseCampaign(definition, { root })).toThrow(/degraded/);
  });

  it('requires contiguous sequence numbers and immutable deadline across pauses', () => {
    const { root, definition } = fixture();
    initUniverseCampaign(definition, { root });
    const directory = campaignDirectory(definition.id, { root });
    const at = new Date().toISOString();
    const deadlineAt = new Date(Date.parse(at) + definition.budget.maxDurationMs).toISOString();
    appendCampaignEvent(directory, { kind: 'started', at, deadlineAt, owner: { pid: process.pid, startRef: 'fixture-owner' } });
    appendCampaignEvent(directory, { kind: 'settled', at, state: 'paused', reason: 'Pause fixture' });
    expect(() => appendCampaignEvent(directory, { kind: 'started', at,
      deadlineAt: new Date(Date.parse(deadlineAt) + 1).toISOString(), owner: { pid: process.pid, startRef: 'fixture-owner' } })).toThrow(/cannot be reset/);
    const events = readCampaignEvents(directory);
    const damaged = structuredClone(events);
    damaged[1]!.sequence = 7;
    expect(() => foldCampaignEvents(damaged)).toThrow(/sequence/);
    expect(readCampaignEvents(directory)).toEqual(events);
  });
});

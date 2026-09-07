import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import {
  appendCampaignEvent, CampaignControlConflictError, campaignDirectory, initUniverseCampaign,
  readCampaignEvents, readUniverseCampaign, requestUniverseCampaignControl,
} from '../src/core/universe/campaign-store.js';
import { runUniverseCampaign, type UniverseCampaignExpectation } from '../src/core/universe/campaign.js';
import type { UniverseCampaignDefinition, UniverseRun, UniverseSummary } from '../src/core/universe/types.js';

const hooks = vi.hoisted(() => ({
  beforeControlLock: undefined as (() => void) | undefined,
  onUniverseRead: undefined as (() => void) | undefined,
  universe: undefined as UniverseSummary | undefined,
  run: vi.fn(),
}));
vi.mock('../src/core/fleet/local-store-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/local-store-lock.js')>();
  return { ...actual, acquireLocalStoreLock: (...args: Parameters<typeof actual.acquireLocalStoreLock>) => {
    if (args[0].endsWith('/.control.lock')) {
      const callback = hooks.beforeControlLock; hooks.beforeControlLock = undefined; callback?.();
    }
    return actual.acquireLocalStoreLock(...args);
  } };
});
vi.mock('../src/core/universe/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/universe/store.js')>();
  return { ...actual, projectUniverse: (...args: Parameters<typeof actual.projectUniverse>) => {
    const callback = hooks.onUniverseRead; hooks.onUniverseRead = undefined; callback?.();
    return hooks.universe ? structuredClone(hooks.universe) : actual.projectUniverse(...args);
  } };
});
vi.mock('../src/core/universe/runner.js', () => ({ runUniverseOwned: hooks.run }));

const roots: string[] = [];
afterEach(() => {
  hooks.beforeControlLock = undefined; hooks.onUniverseRead = undefined; hooks.universe = undefined;
  hooks.run.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-campaign-expectation-'))); roots.push(root);
  mkdirSync(join(root, 'universes', 'fixture'), { recursive: true, mode: 0o700 });
  hooks.universe = { manifest: { schemaVersion: 1, id: 'fixture', name: 'Expectation fixture', objective: 'Exercise durable admission',
    seed: { repo: '/unused/fixture', revision: 'a'.repeat(40) }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 10_000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'change', niche: 'value', hypothesis: 'Change fixture data', command: ['node', 'worker.mjs'] }] },
  manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), runs: [], elites: [], activeRun: null,
  sourceState: 'healthy', reasons: [] };
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: 'campaign', universeId: 'fixture', feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 60_000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } };
  const summary = initUniverseCampaign(definition, { root });
  const expectedIdentity: UniverseCampaignExpectation = { universeId: definition.universeId,
    definitionDigest: summary.definitionDigest, manifestDigest: summary.manifestDigest,
    comparatorDigest: summary.comparatorDigest, summaryDigest: digest(canonical(summary)) };
  const directory = campaignDirectory(definition.id, { root });
  hooks.run.mockImplementation(async (_id: string, options: { runId: string; campaign: UniverseRun['campaign'] }): Promise<UniverseRun> => {
    const run: UniverseRun = { id: options.runId, universeId: 'fixture', generation: hooks.universe!.runs.length + 1,
      manifestDigest: summary.manifestDigest, comparatorDigest: summary.comparatorDigest,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'completed', campaign: options.campaign,
      trials: [{ id: 'trial', variantId: 'change', niche: 'value', parentTrialId: null, status: 'failed', score: null,
        metrics: {}, artifact: null, durationMs: 1, delta: null, selected: false }], durationMs: 1, tokensUsed: null, costUsd: null };
    hooks.universe!.runs.push(run); return run;
  });
  return { root, directory, definition, expectedIdentity };
}

describe('atomic campaign admission checkpoints', () => {
  it('appends only against the exact control ledger captured by the caller', () => {
    const value = fixture();
    const checkpoint = digest(canonical(readCampaignEvents(value.directory)));
    const written = appendCampaignEvent(value.directory, { kind: 'control', action: 'pause', at: new Date().toISOString() },
      { expectedRecordsDigest: checkpoint });
    expect(written).toHaveLength(2);
    expect(() => appendCampaignEvent(value.directory, { kind: 'settled', state: 'paused', reason: 'Fixture acknowledgment',
      at: new Date().toISOString() }, { expectedRecordsDigest: checkpoint })).toThrow(CampaignControlConflictError);
    expect(readCampaignEvents(value.directory)).toEqual(written);
    appendCampaignEvent(value.directory, { kind: 'settled', state: 'paused', reason: 'Fixture acknowledgment',
      at: new Date().toISOString() }, { expectedRecordsDigest: digest(canonical(written)) });
    expect(readUniverseCampaign('campaign', value).state).toBe('paused');
  });

  it('compares after acquiring the control lock, rejecting a control inserted at the exact boundary', () => {
    const value = fixture(); const checkpoint = digest(canonical(readCampaignEvents(value.directory)));
    hooks.beforeControlLock = () => { requestUniverseCampaignControl('campaign', 'pause', value); };
    expect(() => appendCampaignEvent(value.directory, { kind: 'started', at: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(), owner: { pid: process.pid, startRef: 'fixture-owner' } },
    { expectedRecordsDigest: checkpoint })).toThrow(CampaignControlConflictError);
    expect(readCampaignEvents(value.directory).map((event) => event.kind)).toEqual(['created', 'control', 'settled']);
    expect(readUniverseCampaign('campaign', value).state).toBe('paused');
  });

  it('rejects an invalid checkpoint without adding evidence', () => {
    const value = fixture();
    expect(() => appendCampaignEvent(value.directory, { kind: 'control', action: 'pause', at: new Date().toISOString() },
      { expectedRecordsDigest: 'not-a-hash' })).toThrow(/checkpoint/);
    expect(readCampaignEvents(value.directory)).toHaveLength(1);
  });

  it.each(['universeId', 'definitionDigest', 'manifestDigest', 'comparatorDigest', 'summaryDigest'] as const)(
    'rejects changed admission %s without dispatch or failure settlement', async (field) => {
      const value = fixture(); value.expectedIdentity[field] = field === 'universeId' ? 'different' : 'e'.repeat(64);
      await expect(runUniverseCampaign('campaign', value)).rejects.toThrow(/changed after portfolio admission/);
      expect(hooks.run).not.toHaveBeenCalled();
      expect(readCampaignEvents(value.directory)).toHaveLength(1);
    });

  it('binds snapshot state as well as immutable identity before acquiring execution ownership', async () => {
    const value = fixture(); requestUniverseCampaignControl('campaign', 'pause', value);
    const before = readCampaignEvents(value.directory);
    await expect(runUniverseCampaign('campaign', value)).rejects.toThrow(/changed after portfolio admission/);
    expect(hooks.run).not.toHaveBeenCalled(); expect(readCampaignEvents(value.directory)).toEqual(before);
  });

  it.each(['pause', 'stop'] as const)('never resumes or settles through a late ownerless %s', async (action) => {
    const value = fixture();
    // The first control lock belongs to the started append, after all admission
    // snapshot checks. Inject a real competing control transaction immediately before it.
    hooks.beforeControlLock = () => { requestUniverseCampaignControl('campaign', action, value); };
    await expect(runUniverseCampaign('campaign', value)).rejects.toThrow(CampaignControlConflictError);
    expect(hooks.run).not.toHaveBeenCalled();
    const result = readUniverseCampaign('campaign', value);
    expect(result.state).toBe(action === 'pause' ? 'paused' : 'stopped');
    expect(result.progress.attempts).toBe(0);
    expect(readCampaignEvents(value.directory).map((event) => event.kind)).toEqual(['created', 'control', 'settled']);
  });

  it('does not refresh its checkpoint to adopt a pause that occurs during the captured snapshot projection', async () => {
    const value = fixture();
    // First read is the public preflight. Arm a callback for the under-lease
    // projection, after its events have been captured but before it can append.
    hooks.onUniverseRead = () => {
      hooks.onUniverseRead = () => { requestUniverseCampaignControl('campaign', 'pause', value); };
    };
    await expect(runUniverseCampaign('campaign', value)).rejects.toThrow(CampaignControlConflictError);
    expect(hooks.run).not.toHaveBeenCalled();
    expect(readUniverseCampaign('campaign', value).state).toBe('paused');
    expect(readCampaignEvents(value.directory)).toHaveLength(3);
  });

  it('supports an explicitly enrolled paused campaign and ordinary legacy invocation', async () => {
    const value = fixture(); requestUniverseCampaignControl('campaign', 'pause', value);
    const paused = readUniverseCampaign('campaign', value);
    value.expectedIdentity.summaryDigest = digest(canonical(paused));
    const completed = await runUniverseCampaign('campaign', value);
    expect(completed.sourceState).toBe('healthy'); expect(completed.state).toBe('completed');
    expect(hooks.run).toHaveBeenCalledOnce();
    expect(await runUniverseCampaign('campaign', { root: value.root })).toEqual(completed);
    expect(hooks.run).toHaveBeenCalledOnce();
  });

  it('advances the checkpoint only for its own recovered interruption before starting', async () => {
    const value = fixture(); const at = new Date().toISOString();
    appendCampaignEvent(value.directory, { kind: 'started', at, deadlineAt: new Date(Date.parse(at) + 60_000).toISOString(),
      owner: { pid: 2_147_000_000, startRef: 'exited-fixture-owner' } });
    value.expectedIdentity.summaryDigest = digest(canonical(readUniverseCampaign('campaign', value)));
    const completed = await runUniverseCampaign('campaign', value);
    expect(completed.state).toBe('completed'); expect(completed.sourceState).toBe('healthy');
    expect(hooks.run).toHaveBeenCalledOnce();
    const records = readCampaignEvents(value.directory);
    expect(records.map((event) => event.kind)).toEqual(['created', 'started', 'settled', 'started', 'step', 'settled']);
    expect(records[2]).toMatchObject({ kind: 'settled', state: 'interrupted' });
  });

  it('rejects a foreign pause after its own recovery settlement without advancing past that control', async () => {
    const value = fixture(); const at = new Date().toISOString();
    appendCampaignEvent(value.directory, { kind: 'started', at, deadlineAt: new Date(Date.parse(at) + 60_000).toISOString(),
      owner: { pid: 2_147_000_000, startRef: 'exited-fixture-owner' } });
    value.expectedIdentity.summaryDigest = digest(canonical(readUniverseCampaign('campaign', value)));
    hooks.beforeControlLock = () => {
      hooks.beforeControlLock = () => { requestUniverseCampaignControl('campaign', 'pause', value); };
    };
    await expect(runUniverseCampaign('campaign', value)).rejects.toThrow(CampaignControlConflictError);
    expect(hooks.run).not.toHaveBeenCalled();
    const records = readCampaignEvents(value.directory);
    expect(records.map((event) => event.kind)).toEqual(['created', 'started', 'settled', 'control', 'settled']);
    expect(records[2]).toMatchObject({ kind: 'settled', state: 'interrupted' });
    expect(readUniverseCampaign('campaign', value).state).toBe('paused');
  });
});

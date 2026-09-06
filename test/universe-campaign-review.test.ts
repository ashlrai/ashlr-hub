import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { appendCampaignEvent, foldCampaignEvents, projectCampaign, readCampaignEvents, requestUniverseCampaignControl,
  type CampaignEvent, type CampaignEventInput } from '../src/core/universe/campaign-store.js';
import { assertUniverseExecution, withUniverseExecution } from '../src/core/universe/execution.js';
import { generationResources, newGenerationReceipt } from '../src/core/universe/generation.js';
import type { UniverseCampaignDefinition, UniverseRun, UniverseSummary, UniverseTrial } from '../src/core/universe/types.js';

const hooks = vi.hoisted(() => ({ beforeControlLock: undefined as (() => void) | undefined, universe: undefined as unknown }));
vi.mock('../src/core/fleet/local-store-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/local-store-lock.js')>();
  return { ...actual, acquireLocalStoreLock: (...args: Parameters<typeof actual.acquireLocalStoreLock>) => {
    if (args[0].endsWith('/.control.lock')) {
      const before = hooks.beforeControlLock;
      hooks.beforeControlLock = undefined;
      before?.();
    }
    return actual.acquireLocalStoreLock(...args);
  } };
});
vi.mock('../src/core/universe/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/universe/store.js')>();
  return { ...actual, projectUniverse: (...args: Parameters<typeof actual.projectUniverse>) => hooks.universe ?? actual.projectUniverse(...args) };
});

const RUN_ONE = '11111111-1111-4111-8111-111111111111';
const RUN_TWO = '22222222-2222-4222-8222-222222222222';
const AT = '2026-09-06T12:00:00.000Z';
const DEADLINE = '2026-09-06T12:01:00.000Z';
const roots: string[] = [];
afterEach(() => {
  hooks.beforeControlLock = undefined;
  hooks.universe = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { definition: UniverseCampaignDefinition; universe: UniverseSummary; events: CampaignEvent[] } {
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: 'review', universeId: 'fixture', feedback: true,
    budget: { maxGenerations: 4, maxDurationMs: 60_000, maxModelRequests: 4, maxStagnantGenerations: 2, maxReportedTokens: 100 } };
  const universe: UniverseSummary = { manifest: { schemaVersion: 1, id: 'fixture', name: 'Review fixture', objective: 'Correct the output',
    seed: { repo: '/unused/review-fixture', revision: 'a'.repeat(40) }, metric: { name: 'checks', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 10_000, trialTimeoutMs: 5_000, maxParallel: 1 },
    evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 1_000 },
    variants: [{ id: 'repair', niche: 'correctness', hypothesis: 'Correct an observed error',
      generation: { kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture', files: ['value.mjs'], maxOutputTokens: 256 } }] },
  manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), runs: [], elites: [], activeRun: null, sourceState: 'healthy', reasons: [] };
  const events: CampaignEvent[] = [];
  append(events, { kind: 'created', at: AT, definition, definitionDigest: digest(canonical(definition)),
    manifestDigest: universe.manifestDigest, comparatorDigest: universe.comparatorDigest });
  append(events, { kind: 'started', at: AT, deadlineAt: DEADLINE, owner: { pid: process.pid, startRef: 'test-owner' } });
  return { definition, universe, events };
}

function append(events: CampaignEvent[], input: CampaignEventInput): void {
  events.push({ ...input, id: String(events.length).padStart(8, '0'), sequence: events.length });
}

function step(events: CampaignEvent[], ordinal = 1, runId = RUN_ONE, generation = 1): void {
  append(events, { kind: 'step', at: AT, ordinal, runId, generation, variantIds: ['repair'], reservedModelRequests: 1 });
}

function recordedRun(definition: UniverseCampaignDefinition, universe: UniverseSummary,
  options: { id?: string; ordinal?: number; generation?: number; status?: UniverseRun['status']; usage?: 'reported' | 'unknown' | 'preflight'; feedback?: boolean } = {}): UniverseRun {
  const generation = newGenerationReceipt(universe.manifest.variants[0]!.generation!);
  generation.error = 'Model attempt failed';
  if (options.usage !== 'preflight') {
    generation.requestStarted = true;
    generation.promptDigest = 'd'.repeat(64);
    if (options.usage !== 'unknown') generation.usage = { state: 'reported', inputTokens: 2, outputTokens: 3 };
  }
  const trials: UniverseTrial[] = [{ id: 'trial', variantId: 'repair', niche: 'correctness', parentTrialId: null,
    status: 'failed', score: null, metrics: {}, artifact: null, durationMs: 5, delta: null, selected: false, generation }];
  const status = options.status ?? 'completed';
  return { id: options.id ?? RUN_ONE, universeId: universe.manifest.id, generation: options.generation ?? 1,
    manifestDigest: universe.manifestDigest, comparatorDigest: universe.comparatorDigest, startedAt: AT,
    finishedAt: status === 'running' ? null : AT, status, durationMs: 5, trials,
    ...generationResources(trials, status === 'completed'), campaign: { id: definition.id, ordinal: options.ordinal ?? 1,
      definitionDigest: digest(canonical(definition)) }, ...(options.feedback === false ? {} : { feedbackEnabled: true as const }) };
}

describe('independent campaign accounting and replay review', () => {
  it('retains a request reservation when a process dies before producing any Universe run', () => {
    const { universe, events } = fixture();
    step(events);
    append(events, { kind: 'settled', at: AT, state: 'interrupted', reason: 'Owner interrupted' });
    const summary = projectCampaign(events, universe);
    expect(summary.sourceState).toBe('healthy');
    expect(summary.progress).toMatchObject({ attempts: 1, reservedModelRequests: 1, usageComplete: false, reportedTokens: null, recordedTokens: 0 });
    expect(summary.steps[0]!.state).toBe('interrupted');
  });

  it.each(['unknown', 'reported'] as const)('keeps interrupted %s usage incomplete even when some exact counters survived', (usage) => {
    const { definition, universe, events } = fixture();
    step(events);
    universe.runs.push(recordedRun(definition, universe, { status: 'interrupted', usage }));
    const summary = projectCampaign(events, universe);
    expect(summary.progress).toMatchObject({ reservedModelRequests: 1, usageComplete: false, reportedTokens: null,
      recordedTokens: usage === 'reported' ? 5 : 0 });
  });

  it('counts provider-reported spend even when the candidate fails and never fabricates unknown usage', () => {
    const { definition, universe, events } = fixture();
    step(events);
    universe.runs.push(recordedRun(definition, universe));
    expect(projectCampaign(events, universe).progress).toMatchObject({ reportedTokens: 5, recordedTokens: 5, usageComplete: true, reservedModelRequests: 1 });
    universe.runs[0] = recordedRun(definition, universe, { usage: 'unknown' });
    expect(projectCampaign(events, universe).progress).toMatchObject({ reportedTokens: null, recordedTokens: 0, usageComplete: false, reservedModelRequests: 1 });
    universe.runs[0] = recordedRun(definition, universe, { usage: 'preflight' });
    expect(projectCampaign(events, universe).progress).toMatchObject({ reportedTokens: 0, recordedTokens: 0, usageComplete: true, reservedModelRequests: 1 });
  });

  it('preserves an orphan reservation while allowing a distinct later campaign attempt to occupy its never-started generation', () => {
    const { definition, universe, events } = fixture();
    step(events);
    append(events, { kind: 'settled', at: AT, state: 'interrupted', reason: 'Owner exited before run start' });
    append(events, { kind: 'started', at: AT, deadlineAt: DEADLINE, owner: { pid: process.pid, startRef: 'new-owner' } });
    step(events, 2, RUN_TWO, 1);
    universe.runs.push(recordedRun(definition, universe, { id: RUN_TWO, ordinal: 2, generation: 1 }));
    append(events, { kind: 'settled', at: AT, state: 'completed', reason: 'Observed cutoff reached' });
    const summary = projectCampaign(events, universe);
    expect(summary.sourceState, JSON.stringify(summary.reasons)).toBe('healthy');
    expect(summary.steps.map((item) => item.state)).toEqual(['interrupted', 'completed']);
    expect(summary.progress).toMatchObject({ attempts: 2, reservedModelRequests: 2, usageComplete: false, reportedTokens: null, recordedTokens: 5 });
  });

  it('does not label earlier abandoned reservations pending under the new owner', () => {
    const { universe, events } = fixture();
    step(events);
    append(events, { kind: 'settled', at: AT, state: 'interrupted', reason: 'Owner exited before run start' });
    append(events, { kind: 'started', at: AT, deadlineAt: DEADLINE, owner: { pid: process.pid, startRef: 'new-owner' } });
    step(events, 2, RUN_TWO, 1);
    expect(projectCampaign(events, universe).steps.map((item) => item.state)).toEqual(['interrupted', 'pending']);
  });

  it('rejects a run that changes the campaign-pinned feedback policy', () => {
    const { definition, universe, events } = fixture();
    step(events);
    universe.runs.push(recordedRun(definition, universe, { feedback: false }));
    expect(projectCampaign(events, universe).sourceState).toBe('degraded');
  });

  it.each(['completed', 'interrupted'] as const)('rejects duplicated variant trials in a %s run', (status) => {
    const { definition, universe, events } = fixture();
    universe.manifest.variants.push({ ...universe.manifest.variants[0]!, id: 'second' });
    universe.manifest.budget.maxTrials = 2;
    append(events, { kind: 'step', at: AT, ordinal: 1, runId: RUN_ONE, generation: 1,
      variantIds: ['repair', 'second'], reservedModelRequests: 2 });
    const run = recordedRun(definition, universe, { status });
    run.trials.push({ ...run.trials[0]!, id: 'different-trial-same-variant' });
    Object.assign(run, generationResources(run.trials, status === 'completed'));
    universe.runs.push(run);
    expect(projectCampaign(events, universe).sourceState).toBe('degraded');
  });

  it.each(['pause', 'stop'] as const)('does not prematurely acknowledge %s when a runner starts after the initial control snapshot', (action) => {
    const { definition, universe, events } = fixture();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-review-control-')));
    roots.push(root);
    const directory = join(root, 'campaigns', definition.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendCampaignEvent(directory, events[0]!);
    hooks.universe = universe;
    // Insert a real durable start immediately before control takes its short
    // write lock, after requestControl already observed the ownerless snapshot.
    hooks.beforeControlLock = () => {
      appendCampaignEvent(directory, { kind: 'started', at: AT, deadlineAt: DEADLINE,
        owner: { pid: process.pid, startRef: 'racing-owner' } });
    };
    const summary = requestUniverseCampaignControl(definition.id, action, { root });
    expect(summary.state).toBe(`${action}-requested`);
    expect(summary.owner?.pid).toBe(process.pid);
    expect(readCampaignEvents(directory).map((event) => event.kind)).toEqual(['created', 'started', 'control']);
  });

  it('rejects foreign generation occupancy and missing request reservations', () => {
    const { definition, universe, events } = fixture();
    step(events);
    universe.runs.push({ ...recordedRun(definition, universe, { id: RUN_TWO }), campaign: undefined });
    expect(projectCampaign(events, universe).sourceState).toBe('degraded');
    universe.runs = [];
    const last = events.at(-1)!;
    if (last.kind === 'step') last.reservedModelRequests = 0;
    expect(projectCampaign(events, universe).sourceState).toBe('degraded');
  });

  it('does not reset the original deadline or request allowance across resume', () => {
    const { events } = fixture();
    step(events);
    append(events, { kind: 'settled', at: AT, state: 'paused', reason: 'Paused by caller' });
    append(events, { kind: 'started', at: AT, deadlineAt: '2026-09-06T12:02:00.000Z', owner: { pid: process.pid, startRef: 'new-owner' } });
    expect(() => foldCampaignEvents(events)).toThrow(/deadline cannot be reset/);
    const latest = events.at(-1)!;
    if (latest.kind === 'started') latest.deadlineAt = DEADLINE;
    for (let ordinal = 2; ordinal <= 5; ordinal++) step(events, ordinal, `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, ordinal);
    expect(() => foldCampaignEvents(events)).toThrow(/reserved budget/);
  });

  it('cannot dispatch after a durable stop request or extend terminal history', () => {
    const { events } = fixture();
    append(events, { kind: 'control', at: AT, action: 'stop' });
    step(events);
    expect(() => foldCampaignEvents(events)).toThrow(/reserved budget/);
    events.pop();
    append(events, { kind: 'settled', at: AT, state: 'stopped', reason: 'Stopped' });
    append(events, { kind: 'started', at: AT, deadlineAt: DEADLINE, owner: { pid: process.pid, startRef: 'new-owner' } });
    expect(() => foldCampaignEvents(events)).toThrow(/terminal history/);
  });
});

describe('independent shared Universe execution ownership', () => {
  it('excludes overlapping owners between generations and releases ownership after failure', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-review-lease-')));
    roots.push(root);
    mkdirSync(join(root, 'universes', 'fixture'), { recursive: true, mode: 0o700 });
    await withUniverseExecution('fixture', { root }, async () => {
      await expect(withUniverseExecution('fixture', { root }, async () => 'unexpected')).rejects.toThrow(/active execution owner/);
    });
    await expect(withUniverseExecution('fixture', { root }, async () => { throw new Error('test failure'); })).rejects.toThrow('test failure');
    await expect(withUniverseExecution('fixture', { root }, async () => 'new owner')).resolves.toBe('new owner');
  });

  it('rejects a lease from another Universe or a released owner token', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-review-context-')));
    roots.push(root);
    const directory = join(root, 'universes', 'fixture');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const released = await withUniverseExecution('fixture', { root }, async (lock) => {
      expect(() => assertUniverseExecution(join(root, 'universes', 'different'), lock)).toThrow(/ownership lost/);
      return lock;
    });
    expect(() => assertUniverseExecution(directory, released)).toThrow(/ownership lost/);
  });
});

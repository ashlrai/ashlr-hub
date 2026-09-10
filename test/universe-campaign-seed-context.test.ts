/** Real private records only: no model, evaluator, subprocess or repository execution. */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import * as campaigns from '../src/core/universe/campaign-store.js';
import { readCampaignSeedContext } from '../src/core/universe/campaign-seed-context.js';
import * as store from '../src/core/universe/store.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
import * as modelCandidate from '../src/core/universe/model-candidate.js';
import * as providerClient from '../src/core/run/provider-client.js';
import * as locks from '../src/core/fleet/local-store-lock.js';
import { acquireUniverseExecution } from '../src/core/universe/execution.js';
import { runUniverseOwned } from '../src/core/universe/runner.js';
import { generationResources, newGenerationReceipt, validGenerationReceipt } from '../src/core/universe/generation.js';
import { seedContextReceipt } from '../src/core/universe/seed-context.js';
import { buildUniverseSearchContext, searchContextReceipt } from '../src/core/universe/search-context.js';
import type { UniverseCampaignDefinition, UniverseCampaignSeedIntent, UniverseCampaignSeedResult,
  UniverseRun, UniverseSeedContext, UniverseTrial } from '../src/core/universe/types.js';

const roots: string[] = [];
const at = '2026-09-10T12:00:00.000Z';
const measuredAt = '2026-09-10T12:00:00.010Z';
const stepAt = '2026-09-10T12:00:00.020Z';
const runAt = '2026-09-10T12:00:00.030Z';
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(options: { measureSeed?: boolean; feedback?: boolean; result?: 'pending' | 'failed' | 'measured' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'campaign-seed-context-'))); roots.push(root);
  const directory = join(root, 'universes', 'fixture'); const seed = join(directory, 'seed');
  mkdirSync(seed, { recursive: true, mode: 0o700 }); mkdirSync(join(directory, 'artifacts'), { mode: 0o700 });
  writeFileSync(join(seed, 'value.mjs'), 'export const value = 0;');
  writeFileSync(join(seed, 'evaluate.mjs'), 'throw new Error("PRIVATE: never execute this fixture evaluator");');
  const manifest: store.ManifestRecord['manifest'] = { schemaVersion: 1, id: 'fixture', name: 'Seed context fixture', objective: 'Correct a measured seed',
    seed: { repo: join(root, 'source'), revision: 'a'.repeat(40) }, metric: { name: 'checks', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 1000, trialTimeoutMs: 1000 },
    evaluation: { command: ['evaluate.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'repair', niche: 'quality', hypothesis: 'Correct value', generation: { kind: 'local-chat',
      endpoint: 'http://127.0.0.1:11434/v1', model: 'inert', files: ['value.mjs'], maxOutputTokens: 256 } }] };
  const partial: Omit<store.ManifestRecord, 'comparatorDigest'> = { id: 'manifest', kind: 'manifest', manifest,
    manifestDigest: digest(canonical(manifest)), seedArtifact: { path: seed, digest: artifactDigest(seed), revision: manifest.seed.revision },
    evaluationCommand: [join(seed, 'evaluate.mjs')], evaluationExecutableDigest: digest(readFileSync(join(seed, 'evaluate.mjs'))) };
  const record = { ...partial, comparatorDigest: store.comparatorDigest(partial) };
  store.appendRecord(directory, record);
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: 'campaign', universeId: 'fixture', feedback: options.feedback ?? true,
    ...(options.measureSeed === false ? {} : { measureSeed: true as const }),
    budget: { maxGenerations: 3, maxDurationMs: 60_000, maxModelRequests: 3, maxStagnantGenerations: 3, maxReportedTokens: null } };
  const summary = campaigns.initUniverseCampaign(definition, { root });
  const campaignDirectory = campaigns.campaignDirectory(definition.id, { root });
  campaigns.appendCampaignEvent(campaignDirectory, { kind: 'started', at,
    deadlineAt: '2026-09-10T12:01:00.000Z', owner: { pid: process.pid, startRef: 'fixture-owner' } });
  const intent: UniverseCampaignSeedIntent = { schemaVersion: 1, id: '11111111-1111-4111-8111-111111111111', sessionSequence: 1,
    definitionDigest: summary.definitionDigest, manifestDigest: record.manifestDigest, comparatorDigest: record.comparatorDigest,
    seedArtifactDigest: record.seedArtifact.digest, context: 'campaign-seed-v1', startedAt: at, deadlineAt: '2026-09-10T12:01:00.000Z' };
  const result: UniverseCampaignSeedResult = { schemaVersion: 1, intentDigest: digest(canonical(intent)),
    status: options.result === 'failed' ? 'failed' : 'measured', finishedAt: measuredAt, durationMs: 10,
    processGroupSettlement: 'group-exit-confirmed', reason: options.result === 'failed' ? 'evaluator-failed' : null,
    measurement: options.result === 'failed' ? null : { passed: false, score: -2, metrics: { checks: 82 } } };
  if (definition.measureSeed) {
    campaigns.appendCampaignEvent(campaignDirectory, { kind: 'seed-evaluation-intent', at, evaluation: intent });
    if (options.result !== 'pending') campaigns.appendCampaignEvent(campaignDirectory, { kind: 'seed-evaluation-result', at: measuredAt, evaluation: result });
  }
  const run = store.newRun(record, 1); run.startedAt = runAt;
  run.campaign = { id: definition.id, ordinal: 1, definitionDigest: summary.definitionDigest };
  if (definition.feedback) { run.feedbackEnabled = true; run.feedbackVersion = 2; }
  if (!definition.measureSeed || result.status === 'measured' && options.result !== 'pending') {
    campaigns.appendCampaignEvent(campaignDirectory, { kind: 'step', at: stepAt, ordinal: 1, runId: run.id,
      generation: 1, variantIds: ['repair'], reservedModelRequests: 1 });
  }
  return { root, directory, seed, campaignDirectory, definition, record, intent, result, run };
}
type Fixture = ReturnType<typeof fixture>;
const read = (f: Fixture, run = f.run, record = f.record) => readCampaignSeedContext(run, record, f.root);

function inventory(root: string): string {
  const entries: unknown[] = [];
  function visit(path: string) {
    const stat = lstatSync(path); entries.push({ path: path.slice(root.length), mode: stat.mode, inode: stat.ino,
      mtime: stat.mtimeMs, ctime: stat.ctimeMs, bytes: stat.isFile() ? digest(readFileSync(path)) : null });
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
  visit(root); return canonical(entries);
}
function mutateEvent(f: Fixture, kind: campaigns.CampaignEvent['kind'], change: (event: campaigns.CampaignEvent) => void) {
  const event = campaigns.readCampaignEvents(f.campaignDirectory).find(value => value.kind === kind)!;
  change(event);
  writeFileSync(join(f.campaignDirectory, 'ledger', 'records', `${event.id}.json`), `${canonical(event)}\n`);
}
function persistRun(f: Fixture, options: { pinned?: boolean; prompted?: boolean; receipt?: 'missing' | 'wrong' | 'valid';
  changePin?: (context: UniverseSeedContext) => void; changeFinal?: (run: UniverseRun) => void; final?: boolean } = {}) {
  const context = read(f);
  const prior = store.projectUniverse(f.directory);
  if (options.pinned !== false) {
    if (!context) throw new Error('Expected fixture seed context');
    f.run.seedContext = structuredClone(context); options.changePin?.(f.run.seedContext);
  }
  store.appendRecord(f.directory, { id: `${f.run.id}.start`, kind: 'start', run: f.run, ownerPid: process.pid, ownerStart: 'fixture-owner' });
  const receipt = newGenerationReceipt(f.record.manifest.variants[0]!.generation!);
  if (options.prompted !== false) receipt.promptDigest = digest('fixture prompt');
  if (options.prompted !== false && f.run.feedbackVersion === 2) {
    receipt.search = searchContextReceipt(buildUniverseSearchContext(prior, f.record.manifest.variants[0]!));
  }
  if (options.receipt !== 'missing' && (options.pinned !== false || options.receipt)) {
    if (!context) throw new Error('Expected receipt context');
    receipt.seedContext = options.receipt === 'wrong' ? { schemaVersion: 1, digest: 'f'.repeat(64) } : seedContextReceipt(context);
  }
  const trial: UniverseTrial = { id: 'trial-repair', variantId: 'repair', niche: 'quality', parentTrialId: null,
    status: 'failed', score: null, metrics: {}, artifact: null, durationMs: 0, delta: null, selected: false, generation: receipt };
  store.appendRecord(f.directory, { id: `${f.run.id}.trial.${trial.id}`, kind: 'trial', runId: f.run.id, trial });
  const final: UniverseRun = { ...structuredClone(f.run), status: 'completed', finishedAt: '2026-09-10T12:00:00.040Z',
    trials: [trial], durationMs: 10, ...generationResources([trial], true) };
  options.changeFinal?.(final);
  if (options.final !== false) store.appendRecord(f.directory, { id: `${f.run.id}.final`, kind: 'final', run: final });
  return { context, receipt, trial, final };
}

describe('raw measured seed context reconstruction', () => {
  it('returns exact detached source evidence with normalized diagnostics and no invented trial lineage', () => {
    const f = fixture(); const context = read(f)!;
    expect(context).toEqual({ schemaVersion: 1, source: { universeId: 'fixture', campaignId: 'campaign',
      definitionDigest: f.run.campaign!.definitionDigest, manifestDigest: f.record.manifestDigest, comparatorDigest: f.record.comparatorDigest,
      seedArtifactDigest: f.record.seedArtifact.digest, intentDigest: digest(canonical(f.intent)), resultDigest: digest(canonical(f.result)) },
    measurement: { passed: false, score: -2, metrics: { checks: 82 }, diagnostics: [] } });
    expect(canonical(context)).not.toContain(f.root); expect(canonical(context)).not.toContain('PRIVATE');
    expect(context).not.toHaveProperty('parentTrialId'); expect(context).not.toHaveProperty('generation');
    context.measurement.metrics.checks = 0;
    expect(read(f)?.measurement.metrics.checks).toBe(82);
  });
  it('does not use recursive summaries, locks, evaluator calls, provider calls or filesystem writes', () => {
    const f = fixture(); const before = inventory(f.root);
    const campaign = vi.spyOn(campaigns, 'readUniverseCampaign').mockImplementation(() => { throw new Error('Recursive campaign summary'); });
    const universe = vi.spyOn(store, 'projectUniverse').mockImplementation(() => { throw new Error('Recursive Universe projection'); });
    const lock = vi.spyOn(locks, 'acquireLocalStoreLock').mockImplementation(() => { throw new Error('Unexpected ownership'); });
    const evaluate = vi.spyOn(evaluator, 'runFixedUniverseEvaluator').mockRejectedValue(new Error('Unexpected evaluator'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider'));
    expect(read(f)?.measurement.passed).toBe(false); expect(inventory(f.root)).toBe(before);
    for (const spy of [campaign, universe, lock, evaluate, fetch]) expect(spy).not.toHaveBeenCalled();
  });
  it.each(['no-campaign', 'legacy', 'feedback-disabled'] as const)('preserves optional absence for %s', (kind) => {
    const f = fixture({ measureSeed: kind !== 'legacy', feedback: kind !== 'feedback-disabled' });
    if (kind === 'no-campaign') delete f.run.campaign;
    expect(read(f)).toBeUndefined();
    expect(f.run).not.toHaveProperty('seedContext');
  });
  it.each(['pending', 'failed'] as const)('refuses eligible %s seed evaluation rather than silently omitting evidence', (result) => {
    const f = fixture({ result }); expect(() => read(f)).toThrow(/seed context/);
  });
  it.each(['run-id', 'ordinal', 'generation', 'campaign-id', 'definition', 'universe', 'manifest', 'comparator'] as const)('refuses foreign %s linkage', (field) => {
    const f = fixture(); const run = structuredClone(f.run);
    if (field === 'run-id') run.id = '22222222-2222-4222-8222-222222222222';
    else if (field === 'ordinal') run.campaign!.ordinal++;
    else if (field === 'generation') run.generation++;
    else if (field === 'campaign-id') run.campaign!.id = 'other';
    else if (field === 'definition') run.campaign!.definitionDigest = 'a'.repeat(64);
    else if (field === 'universe') run.universeId = 'other';
    else if (field === 'manifest') run.manifestDigest = 'a'.repeat(64);
    else run.comparatorDigest = 'a'.repeat(64);
    expect(() => read(f, run)).toThrow();
  });
  it('refuses a different pinned seed even when its digest is well formed', () => {
    const f = fixture(); const record = structuredClone(f.record); record.seedArtifact.digest = 'a'.repeat(64);
    expect(() => read(f, f.run, record)).toThrow(/seed context/);
  });
  it.each(['result-after-step', 'step-after-run', 'invalid-run-time'] as const)('rejects late or invalid chronological evidence: %s', (kind) => {
    const f = fixture();
    if (kind === 'result-after-step') mutateEvent(f, 'step', event => { event.at = at; });
    else f.run.startedAt = kind === 'step-after-run' ? measuredAt : 'not-a-time';
    expect(() => read(f)).toThrow(/preceding its exact run/);
  });
  it('rejects a changed raw history between reconstruction reads', () => {
    const f = fixture(); const original = campaigns.readCampaignEvents;
    let calls = 0;
    vi.spyOn(campaigns, 'readCampaignEvents').mockImplementation(directory => {
      const events = original(directory);
      if (++calls === 2) events.push({ kind: 'control', action: 'pause', at: stepAt, sequence: events.length, id: String(events.length).padStart(8, '0') });
      return events;
    });
    expect(() => read(f)).toThrow(/changed during context reconstruction/);
  });
  it('retains the same seed evidence for later campaign generations without resetting their parent semantics', () => {
    const f = fixture(); const first = read(f);
    const later = { ...f.run, id: '22222222-2222-4222-8222-222222222222', generation: 2,
      campaign: { ...f.run.campaign!, ordinal: 2 } };
    campaigns.appendCampaignEvent(f.campaignDirectory, { kind: 'step', at: stepAt, ordinal: 2,
      runId: later.id, generation: 2, variantIds: ['repair'], reservedModelRequests: 1 });
    expect(read(f, later)).toEqual(first);
  });
});

describe('seed context run pins and generation receipts in Universe projection', () => {
  it('rejects a seed pin without the required version-two search protocol', () => {
    const f = fixture(); delete f.run.feedbackVersion;
    expect(() => persistRun(f)).toThrow();
  });
  it.each(['version', 'search', 'both'] as const)('refuses persisted removal of required seeded %s evidence', (removed) => {
    const f = fixture(); persistRun(f);
    const records = store.readRecords(f.directory);
    for (const record of records) {
      if (record.kind === 'start' || record.kind === 'final') {
        if (removed !== 'search') delete record.run.feedbackVersion;
        if (removed !== 'version') for (const trial of record.run.trials) if (trial.generation) delete trial.generation.search;
      }
      if (record.kind === 'trial' && removed !== 'version' && record.trial.generation) delete record.trial.generation.search;
      writeFileSync(join(f.directory, 'ledger', 'records', `${record.id}.json`), `${canonical(record)}\n`);
    }
    expect(() => store.projectUniverse(f.directory)).toThrow();
  });
  it('preserves genuinely version-one unpinned histories without adding search evidence', () => {
    const f = fixture(); delete f.run.feedbackVersion;
    persistRun(f, { pinned: false });
    const summary = store.projectUniverse(f.directory);
    expect(summary.sourceState).toBe('healthy'); expect(summary.runs[0]).not.toHaveProperty('seedContext');
    expect(summary.runs[0]!.trials[0]!.generation).not.toHaveProperty('search');
  });
  it('reconstructs a matching pin and receipt without synthesizing accepted lineage', () => {
    const f = fixture(); const { context } = persistRun(f);
    const summary = store.projectUniverse(f.directory);
    expect(summary.sourceState).toBe('healthy'); expect(summary.elites).toEqual([]);
    expect(summary.runs[0]).toMatchObject({ seedContext: context, trials: [{ parentTrialId: null, delta: null, selected: false,
      generation: { seedContext: seedContextReceipt(context!) } }] });
  });
  it('keeps historical unpinned runs readable without adding context or changing retained receipt bytes', () => {
    const f = fixture(); persistRun(f, { pinned: false });
    const before = inventory(f.root); const summary = store.projectUniverse(f.directory);
    expect(summary.sourceState).toBe('healthy'); expect(summary.runs[0]).not.toHaveProperty('seedContext');
    expect(summary.runs[0]!.trials[0]!.generation).not.toHaveProperty('seedContext');
    expect(inventory(f.root)).toBe(before);
  });
  it.each(['missing', 'wrong'] as const)('refuses %s receipt when a pinned run built a prompt', (receipt) => {
    const f = fixture(); persistRun(f, { receipt });
    expect(() => store.projectUniverse(f.directory)).toThrow(/seed context/);
  });
  it('refuses a seed receipt on an unpinned run', () => {
    const f = fixture(); persistRun(f, { pinned: false, receipt: 'valid' });
    expect(() => store.projectUniverse(f.directory)).toThrow(/seed context/);
  });
  it('allows failed preflight with no prompt and no seed receipt', () => {
    const f = fixture(); persistRun(f, { prompted: false, receipt: 'missing' });
    expect(store.projectUniverse(f.directory).sourceState).toBe('healthy');
    const receipt = newGenerationReceipt(f.record.manifest.variants[0]!.generation!);
    receipt.seedContext = seedContextReceipt(read(f)!);
    expect(validGenerationReceipt(receipt)).toBe(false);
  });
  it('refuses a valid but altered run seed pin and mismatching start/final pins', () => {
    const f = fixture(); persistRun(f, { changePin: context => { context.measurement.score++; } });
    expect(() => store.projectUniverse(f.directory)).toThrow(/seed context/);
    const second = fixture(); persistRun(second, { changeFinal: run => { run.seedContext!.measurement.score++; } });
    expect(() => store.projectUniverse(second.directory)).toThrow(/Final run/);
  });
  it('rejects later raw measurement edits against the already captured run pin', () => {
    const f = fixture(); persistRun(f);
    mutateEvent(f, 'seed-evaluation-result', event => {
      if (event.kind === 'seed-evaluation-result') event.evaluation.measurement!.metrics.checks++;
    });
    expect(() => store.projectUniverse(f.directory)).toThrow(/seed context/);
  });
  it('preserves pins during interrupted-run reconstruction without executing or reevaluating', () => {
    const f = fixture(); const { context } = persistRun(f, { final: false }); const before = inventory(f.root);
    const evaluate = vi.spyOn(evaluator, 'runFixedUniverseEvaluator').mockRejectedValue(new Error('Unexpected evaluator'));
    const summary = store.projectUniverse(f.directory);
    expect(summary.sourceState).toBe('healthy');
    expect(summary.runs[0]).toMatchObject({ status: 'interrupted', seedContext: context });
    expect(inventory(f.root)).toBe(before); expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('runner rechecks parent stop state after synchronous seed verification', () => {
  it.each(['stopped', 'unavailable'] as const)('refuses transport when parent state becomes %s during contextCurrent', async (state) => {
    const f = fixture();
    // The callback represents the parent's KILL/deadline/ownership verdict;
    // no host KILL file, real clock or provider is changed by this regression.
    let parentChanged = false; let insideBroker = false;
    const order: string[] = [];
    const stopped = () => {
      order.push(parentChanged ? 'parent-changed' : 'parent-running');
      if (parentChanged && state === 'unavailable') throw new Error('Parent ownership became unavailable');
      return parentChanged;
    };
    const originalComparator = store.assertComparatorUnchanged;
    vi.spyOn(store, 'assertComparatorUnchanged').mockImplementation(record => {
      originalComparator(record);
      if (insideBroker && !parentChanged) { parentChanged = true; order.push('changed-during-seed-check'); }
    });
    const originalBroker = modelCandidate.generateModelCandidate;
    const broker = vi.spyOn(modelCandidate, 'generateModelCandidate').mockImplementation(async (config, context) => {
      insideBroker = true;
      try { return await originalBroker(config, context); }
      finally { insideBroker = false; }
    });
    const transport = vi.spyOn(providerClient, 'buildOpenAICompatibleClient').mockImplementation(() => {
      throw new Error('Transport must not be constructed');
    });
    const evaluate = vi.spyOn(evaluator, 'runFixedUniverseEvaluator').mockRejectedValue(new Error('Evaluator must not run'));
    const ownership = acquireUniverseExecution('fixture', { root: f.root });
    if (ownership.state !== 'acquired') throw new Error('Fixture lease unavailable');
    let result: UniverseRun;
    try {
      result = await runUniverseOwned('fixture', { root: f.root, runId: f.run.id, campaign: f.run.campaign,
        feedback: true, isExecutionStopped: stopped }, ownership.lock);
    } finally { locks.releaseLocalStoreLock(ownership.lock); }
    expect(broker).toHaveBeenCalledOnce();
    const changed = order.indexOf('changed-during-seed-check');
    expect(changed).toBeGreaterThan(0);
    expect(order[changed - 1]).toBe('parent-running');
    expect(order[changed + 1]).toBe('parent-changed');
    expect(transport).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled();
    expect(result.trials).toHaveLength(1);
    expect(result.trials[0]!.generation).toMatchObject({ requestStarted: false, responseDigest: null,
      usage: { state: 'unavailable', inputTokens: null, outputTokens: null } });
  });
});

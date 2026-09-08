import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as locks from '../src/core/fleet/local-store-lock.js';
import * as execution from '../src/core/universe/execution.js';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { readUniverseCampaignReadiness, type UniverseCampaignReadinessReason } from '../src/core/universe/campaign-readiness.js';
import * as campaigns from '../src/core/universe/campaign-store.js';
import { generationResources, newGenerationReceipt, resourceGenerationTaskId } from '../src/core/universe/generation.js';
import { appendRecord, comparatorDigest, newRun, projectUniverse, readRecords, scheduledVariants, type ManifestRecord } from '../src/core/universe/store.js';
import type { UniverseCampaignDefinition, UniverseManifest, UniverseResourceGenerationEvidence, UniverseRun, UniverseTrial } from '../src/core/universe/types.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type VariantKind = 'resource' | 'local' | 'command';
type ResourceOutcome = 'withheld' | 'not-started' | 'unavailable' | 'replayed' | 'reserved' |
  'completed' | 'failed' | 'timed-out' | 'cancelled' | 'uncertain';

/** Real private immutable evidence and pinned bytes; nothing in the seed executes. */
function fixture(kinds: VariantKind[] = ['resource'], budget: Partial<UniverseCampaignDefinition['budget']> = {}, maxTrials = kinds.length) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-campaign-readiness-')));
  roots.push(root);
  const directory = join(root, 'universes', 'fixture');
  const seed = join(directory, 'seed');
  mkdirSync(seed, { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, 'artifacts'), { mode: 0o700 });
  writeFileSync(join(seed, 'value.mjs'), 'export const value = 0;');
  writeFileSync(join(seed, 'evaluate.mjs'), 'throw new Error("Readiness must never execute this evaluator");');
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'fixture', name: 'Readiness fixture', objective: 'Verify recorded control evidence',
    seed: { repo: join(root, 'source'), revision: 'a'.repeat(40) }, metric: { name: 'checks', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials, maxDurationMs: 10_000, trialTimeoutMs: 1_000, maxParallel: 1 },
    evaluation: { command: ['evaluate.mjs'], timeoutMs: 1_000 },
    variants: kinds.map((kind, index) => ({ id: `variant-${index}`, niche: `niche-${index}`, hypothesis: 'Correct fixture behavior',
      ...(kind === 'command' ? { command: ['worker.mjs'] } : { generation: kind === 'local'
        ? { kind: 'local-chat' as const, endpoint: 'http://127.0.0.1:11434/v1', model: 'inert', files: ['value.mjs'], maxOutputTokens: 256 }
        : { kind: 'resource-pool' as const, poolId: 'fixture-pool', poolDigest: 'b'.repeat(64),
          allowedWorkerIds: ['native'], files: ['value.mjs'], maxOutputTokens: 256 } }) })) };
  const partial: Omit<ManifestRecord, 'comparatorDigest'> = { id: 'manifest', kind: 'manifest', manifest,
    manifestDigest: digest(canonical(manifest)), seedArtifact: { path: seed, digest: artifactDigest(seed), revision: manifest.seed.revision },
    evaluationCommand: [join(seed, 'evaluate.mjs')], evaluationExecutableDigest: digest(readFileSync(join(seed, 'evaluate.mjs'))) };
  const record: ManifestRecord = { ...partial, comparatorDigest: comparatorDigest(partial) };
  appendRecord(directory, record);
  const summary = campaigns.initUniverseCampaign({ schemaVersion: 1, id: 'campaign', universeId: manifest.id, feedback: false,
    budget: { maxGenerations: 10, maxDurationMs: 60_000, maxModelRequests: 64, maxStagnantGenerations: 10,
      maxReportedTokens: null, ...budget } }, { root });
  return { root, directory, record, summary, campaignDirectory: campaigns.campaignDirectory('campaign', { root }) };
}
type Fixture = ReturnType<typeof fixture>;

function start(f: Fixture, at = Date.now(), pid = process.pid): void {
  const prior = campaigns.foldCampaignEvents(campaigns.readCampaignEvents(f.campaignDirectory));
  campaigns.appendCampaignEvent(f.campaignDirectory, { kind: 'started', at: new Date(at).toISOString(),
    deadlineAt: prior.deadlineAt ?? new Date(at + f.summary.definition.budget.maxDurationMs).toISOString(), owner: { pid, startRef: 'fixture-owner' } });
}
function settle(f: Fixture, state: 'paused' | 'interrupted' | 'completed' | 'stopped' | 'failed' = 'paused', reason = 'Arbitrary private diagnostic'): void {
  campaigns.appendCampaignEvent(f.campaignDirectory, { kind: 'settled', state, at: new Date().toISOString(), reason });
}
function control(f: Fixture, action: 'pause' | 'stop'): void {
  campaigns.appendCampaignEvent(f.campaignDirectory, { kind: 'control', at: new Date().toISOString(), action });
}
function trialFor(f: Fixture, run: UniverseRun, variant: UniverseManifest['variants'][number], outcome: ResourceOutcome = 'withheld'): UniverseTrial {
  const trial: UniverseTrial = { id: `trial-${variant.id}`, variantId: variant.id, niche: variant.niche,
    parentTrialId: null, status: 'failed', score: 0, metrics: {}, artifact: null, durationMs: 1, delta: null, selected: false };
  if (!variant.generation) return trial;
  const receipt = newGenerationReceipt(variant.generation);
  trial.generation = receipt;
  if (variant.generation.kind === 'local-chat') {
    Object.assign(receipt, { status: 'succeeded', requestStarted: true, promptDigest: 'c'.repeat(64), responseDigest: 'd'.repeat(64),
      usage: { state: 'reported', inputTokens: 3, outputTokens: 2 } });
    return trial;
  }
  if (outcome === 'not-started') return trial;
  receipt.promptDigest = 'c'.repeat(64);
  const resource = receipt.resource!;
  resource.taskId = resourceGenerationTaskId({ universeId: f.record.manifest.id, runId: run.id, variantId: variant.id });
  if (outcome === 'withheld' || outcome === 'unavailable') { resource.dispatch = outcome; return trial; }
  Object.assign(resource, { taskDigest: 'd'.repeat(64), workerId: 'native', workerProvider: 'codex', workerModel: 'fixture', receiptDigest: 'e'.repeat(64),
    dispatch: outcome === 'replayed' || outcome === 'reserved' ? 'replayed' : 'settled',
    taskStatus: outcome === 'replayed' ? 'completed' : outcome } satisfies Partial<UniverseResourceGenerationEvidence>);
  if (resource.dispatch === 'settled') {
    receipt.usage = { state: 'reported', inputTokens: 3, outputTokens: 2 };
    resource.usageScope = 'codex-turn';
  }
  if (outcome === 'completed') { receipt.status = 'succeeded'; receipt.responseDigest = 'f'.repeat(64); }
  return trial;
}
function makeRun(f: Fixture, outcomes: ResourceOutcome[] = ['withheld']): UniverseRun {
  const generation = projectUniverse(f.directory).runs.length + 1;
  const ordinal = campaigns.foldCampaignEvents(campaigns.readCampaignEvents(f.campaignDirectory)).steps.length + 1;
  const run = newRun(f.record, generation);
  run.campaign = { id: f.summary.definition.id, ordinal, definitionDigest: f.summary.definitionDigest };
  run.trials = scheduledVariants(f.record.manifest, generation).map((variant, index) => trialFor(f, run, variant, outcomes[index] ?? 'withheld'));
  Object.assign(run, { status: 'completed', finishedAt: new Date().toISOString(), durationMs: 1 }, generationResources(run.trials, true));
  return run;
}
function recordStep(f: Fixture, run: UniverseRun): void {
  campaigns.appendCampaignEvent(f.campaignDirectory, { kind: 'step', at: new Date().toISOString(), ordinal: run.campaign!.ordinal,
    runId: run.id, generation: run.generation, variantIds: run.trials.map((trial) => trial.variantId),
    reservedModelRequests: run.trials.filter((trial) => !!trial.generation).length });
}
function persistRun(f: Fixture, run: UniverseRun, final = true): void {
  const initial = { ...run, trials: [], status: 'running' as const, finishedAt: null, durationMs: 0, ...generationResources([], false) };
  delete initial.generationUsage;
  appendRecord(f.directory, { id: `${run.id}.start`, kind: 'start', run: initial, ownerPid: process.pid, ownerStart: 'fixture-owner' });
  for (const trial of run.trials) appendRecord(f.directory, { id: `${run.id}.trial.${trial.id}`, kind: 'trial', runId: run.id, trial });
  if (final) appendRecord(f.directory, { id: `${run.id}.final`, kind: 'final', run });
}
function runAndPause(f: Fixture, outcomes?: ResourceOutcome[], change?: (run: UniverseRun) => void): UniverseRun {
  start(f);
  const run = makeRun(f, outcomes);
  change?.(run);
  Object.assign(run, generationResources(run.trials, run.status === 'completed'));
  recordStep(f, run); persistRun(f, run); settle(f);
  expect(campaigns.readUniverseCampaign('campaign', { root: f.root }).sourceState).toBe('healthy');
  return run;
}
function check(f: Fixture) { return readUniverseCampaignReadiness('campaign', { root: f.root }); }
function expectReason(f: Fixture, reasonCode: UniverseCampaignReadinessReason) {
  const report = check(f);
  expect(report.sourceState).toBe('healthy');
  expect(report.reasonCode).toBe(reasonCode);
  expect(report.automaticAction).toBe(reasonCode === 'never-started' ? 'run' : 'none');
  expect(report.expectedIdentity?.summaryDigest).toBe(digest(canonical(campaigns.readUniverseCampaign('campaign', { root: f.root }))));
  return report;
}
function inventory(root: string): string {
  const entries: unknown[] = [];
  function visit(path: string): void {
    const stat = lstatSync(path);
    entries.push({ path: path.slice(root.length), mode: stat.mode, inode: stat.ino,
      data: stat.isFile() ? digest(readFileSync(path)) : null });
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
  visit(root);
  return canonical(entries);
}

describe('explicit read-only campaign readiness scope', () => {
  it.each([undefined, {}, { root: '' }, { root: '.' }, { root: '/' }, { root: '/tmp/../tmp' }, { root: '/tmp/' },
    { root: '/tmp/\0private' }, { root: '/tmp/\nprivate' }, { root: '/tmp/\u007fprivate' }, { root: '/tmp/\u0085private' },
    { root: `/tmp/${'é'.repeat(2_048)}` }])('refuses invalid explicit root %j before reading', (options) => {
    expect(() => readUniverseCampaignReadiness('campaign', options as { root: string })).toThrow(/explicit canonical absolute root/);
  });

  it('validates campaign identity before reading an arbitrary path', () => {
    expect(() => readUniverseCampaignReadiness('../other', { root: '/absent-private-readiness' })).toThrow(/campaign id/);
  });

  it('does not create a missing root or missing campaign directory', () => {
    const f = fixture();
    const before = inventory(f.root);
    for (const options of [{ root: join(f.root, 'missing') }, { root: f.root }]) {
      const report = readUniverseCampaignReadiness('missing', options);
      expect(report).toMatchObject({ sourceState: 'missing', disposition: 'unavailable', reasonCode: 'campaign-missing',
        automaticAction: 'none', expectedIdentity: null, recordsDigest: null, resourceRuntimeRequired: null });
    }
    expect(inventory(f.root)).toBe(before);
  });

  it.each(['insecure', 'symlink'] as const)('refuses %s root with no filesystem mutation', (kind) => {
    const f = fixture();
    let root = f.root;
    if (kind === 'insecure') chmodSync(root, 0o755);
    else { root = join(f.root, 'alias'); symlinkSync(f.root, root); }
    const before = inventory(f.root);
    expect(readUniverseCampaignReadiness('campaign', { root })).toMatchObject({ sourceState: 'degraded', reasonCode: 'evidence-degraded' });
    expect(inventory(f.root)).toBe(before);
  });

  it.each(['resource', 'local', 'command'] as const)('reports a never-started %s campaign without locks, writes or execution', (kind) => {
    const f = fixture([kind]);
    const before = inventory(f.root);
    const lock = vi.spyOn(locks, 'acquireLocalStoreLock').mockImplementation(() => { throw new Error('Unexpected lock acquisition'); });
    const execute = vi.spyOn(execution, 'withUniverseExecution').mockRejectedValue(new Error('Unexpected execution admission'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider contact'));
    const report = expectReason(f, 'never-started');
    expect(report).toMatchObject({ schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', disposition: 'startable',
      observedState: 'ready', universeId: 'fixture', resourceRuntimeRequired: kind === 'resource' });
    expect(report.recordsDigest).toBe(digest(canonical(campaigns.readCampaignEvents(f.campaignDirectory))));
    expect(canonical(report)).not.toContain(f.root);
    expect(canonical(report)).not.toContain('127.0.0.1');
    expect(lock).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(inventory(f.root)).toBe(before);
  });
});

describe('recorded owner controls and interruption', () => {
  it.each(['pause', 'stop'] as const)('preserves pending %s even with exhausted budgets', (action) => {
    const f = fixture(['resource'], { maxModelRequests: 0 });
    control(f, action);
    expect(expectReason(f, action === 'pause' ? 'pause-requested' : 'stop-requested').disposition).toBe('owner-held');
  });

  it('recognizes acknowledged owner pause from events, not settlement prose', () => {
    const f = fixture(); start(f); control(f, 'pause'); settle(f, 'paused', 'Unrelated arbitrary words');
    expectReason(f, 'owner-paused');
  });

  it('does not manufacture owner authority from a matching free-form reason', () => {
    const f = fixture(); start(f); settle(f, 'paused', 'Paused by owner');
    expectReason(f, 'paused-unclassified');
  });

  it('does not preserve a consumed pause after a later explicit start', () => {
    const f = fixture(); start(f); control(f, 'pause'); settle(f);
    runAndPause(f);
    expectReason(f, 'resource-withheld');
  });

  it('keeps an alive or unconfirmed owner held, including an expired recorded deadline', () => {
    const f = fixture(); start(f, Date.now() - 70_000);
    expect(expectReason(f, 'owner-active').disposition).toBe('owned');
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Unconfirmed'), { code: 'EPERM' }); });
    expectReason(f, 'owner-active');
  });

  it('identifies an abandoned owner without writing recovery records', () => {
    const f = fixture(); start(f);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Absent'), { code: 'ESRCH' }); });
    const before = inventory(f.root);
    expect(expectReason(f, 'owner-abandoned')).toMatchObject({ disposition: 'recovery-required', observedState: 'interrupted' });
    expect(inventory(f.root)).toBe(before);
  });

  it('holds a reserved campaign step that has no run evidence', () => {
    const f = fixture(); start(f); recordStep(f, makeRun(f)); settle(f);
    expectReason(f, 'run-incomplete');
  });

  it.each([true, false])('holds an unrelated unfinished Universe run (recorded alive=%s)', (alive) => {
    const f = fixture(['command']);
    const run = makeRun(f); delete run.campaign;
    persistRun(f, run, false);
    vi.spyOn(locks, 'verifiedProcessStartRef').mockReturnValue(alive ? 'fixture-owner' : null);
    expectReason(f, alive ? 'owner-active' : 'run-incomplete');
  });

  it('does not classify a finalized interrupted run as clean withholding', () => {
    const f = fixture();
    runAndPause(f, ['withheld'], (run) => { run.status = 'interrupted'; });
    expectReason(f, 'run-incomplete');
  });

  it('does not turn an unexplained interrupted settlement into an automatic resume', () => {
    const f = fixture(); start(f); settle(f, 'interrupted');
    expectReason(f, 'interrupted-unclassified');
  });

  it.each(['completed', 'stopped', 'failed'] as const)('preserves recorded terminal %s instead of inferring goal completion', (state) => {
    const f = fixture(['resource'], { maxModelRequests: 0 });
    settle(f, state, 'Campaign duration budget exhausted');
    expect(expectReason(f, `campaign-${state}`).disposition).toBe('terminal');
  });
});

describe('resource withholding and recorded ambiguity', () => {
  it('reports a completed clean refusal without refunding its reserved request', () => {
    const f = fixture(); runAndPause(f);
    const before = inventory(f.root);
    expect(expectReason(f, 'resource-withheld').disposition).toBe('resource-withheld');
    expect(campaigns.readUniverseCampaign('campaign', { root: f.root }).progress.reservedModelRequests).toBe(1);
    expect(inventory(f.root)).toBe(before);
  });

  it('allows clean withholding alongside settled completion and ordinary evaluator rejection', () => {
    const f = fixture(['resource', 'resource', 'local', 'command']);
    runAndPause(f, ['withheld', 'completed']);
    expectReason(f, 'resource-withheld');
  });

  it.each(['unavailable', 'replayed', 'reserved', 'uncertain'] as const)('keeps %s resource evidence distinct from a clean refusal', (outcome) => {
    const f = fixture(); runAndPause(f, [outcome]);
    expect(expectReason(f, 'resource-outcome-ambiguous').disposition).toBe('recovery-required');
  });

  it('does not hide an earlier ambiguous handoff behind a newer clean refusal', () => {
    const f = fixture(); runAndPause(f, ['uncertain']); runAndPause(f, ['withheld']);
    expectReason(f, 'resource-outcome-ambiguous');
  });

  it.each(['not-started', 'failed', 'timed-out', 'cancelled'] as const)('reports known %s resource attention without claiming uncertain occupancy', (outcome) => {
    const f = fixture(); runAndPause(f, [outcome]);
    expect(expectReason(f, 'resource-attention-required').disposition).toBe('attention-required');
  });

  it.each(['resource', 'local'] as const)('does not label failed %s generation plus withholding as a clean attempt', (kind) => {
    const f = fixture(['resource', kind]);
    runAndPause(f, ['withheld', 'completed'], (run) => { run.trials[1]!.generation!.status = 'failed'; });
    expectReason(f, kind === 'resource' ? 'resource-attention-required' : 'generation-attention-required');
  });
});

describe('original campaign budgets remain authoritative', () => {
  it('observes the original duration threshold without settling it', () => {
    const f = fixture(); start(f, Date.now() - 70_000); settle(f);
    expect(expectReason(f, 'duration-budget-exhausted').observedState).toBe('paused');
  });

  it.each([['maxGenerations', 'generation-budget-exhausted'], ['maxStagnantGenerations', 'stagnation-budget-exhausted']] as const)(
    'observes %s after a complete refused generation', (key, reason) => {
      const f = fixture(['resource'], { [key]: 1 }); runAndPause(f);
      expect(expectReason(f, reason).disposition).toBe('budget-exhausted');
    });

  it('cannot refund a withheld request to make the campaign runnable', () => {
    const f = fixture(['resource'], { maxModelRequests: 1 }); runAndPause(f);
    expectReason(f, 'request-budget-exhausted');
  });

  it('does not label a never-started generative campaign startable without request allowance', () => {
    expectReason(fixture(['resource'], { maxModelRequests: 0 }), 'request-budget-exhausted');
  });

  it('keeps command-prefix work startable at zero request allowance', () => {
    expectReason(fixture(['command', 'resource'], { maxModelRequests: 0 }), 'never-started');
  });

  it('matches the next rotated schedule instead of the first manifest variant', () => {
    const f = fixture(['command', 'resource'], { maxModelRequests: 0 }, 1); runAndPause(f);
    expectReason(f, 'request-budget-exhausted');
  });

  it('observes reported tokens without claiming they measure engineering acceptance', () => {
    const f = fixture(['resource'], { maxReportedTokens: 5 }); runAndPause(f, ['completed']);
    expectReason(f, 'reported-token-budget-exhausted');
  });

  it('does not invent zero usage when a completed provider failed to report counters', () => {
    const f = fixture(['resource'], { maxReportedTokens: 5 });
    runAndPause(f, ['completed'], (run) => {
      run.trials[0]!.generation!.usage = { state: 'unavailable', inputTokens: null, outputTokens: null };
      run.trials[0]!.generation!.resource!.usageScope = null;
    });
    expect(expectReason(f, 'usage-unavailable').disposition).toBe('attention-required');
  });
});

describe('stable identity and degraded evidence', () => {
  it('returns no identity when a control arrives during the captured Universe projection', () => {
    const f = fixture();
    const original = campaigns.campaignUniverse;
    const projection = vi.spyOn(campaigns, 'campaignUniverse').mockImplementation((...args) => {
      const result = original(...args);
      control(f, 'pause');
      return result;
    });
    expect(check(f)).toMatchObject({ sourceState: 'degraded', reasonCode: 'snapshot-changed',
      automaticAction: 'none', expectedIdentity: null, recordsDigest: null });
    expect(projection).toHaveBeenCalledTimes(1);
  });

  it('binds expected identity to observed summary and exact durable event history', () => {
    const f = fixture();
    const first = check(f); control(f, 'pause'); settle(f);
    const second = check(f);
    expect(first.expectedIdentity?.definitionDigest).toBe(second.expectedIdentity?.definitionDigest);
    expect(first.expectedIdentity?.summaryDigest).not.toBe(second.expectedIdentity?.summaryDigest);
    expect(first.recordsDigest).not.toBe(second.recordsDigest);
    expect(second.automaticAction).toBe('none');
  });

  it.each(['seed', 'campaign-record', 'manifest', 'slot'] as const)('fails closed for changed %s without exposing private diagnostics', (kind) => {
    const f = fixture();
    if (kind === 'seed') writeFileSync(join(f.record.seedArtifact.path, 'value.mjs'), 'changed');
    if (kind === 'manifest') rmSync(join(f.directory, 'ledger', 'records', 'manifest.json'));
    if (kind === 'campaign-record') {
      const path = join(f.campaignDirectory, 'ledger', 'records', '00000000.json');
      chmodSync(path, 0o600); writeFileSync(path, '{malformed private diagnostic');
    }
    if (kind === 'slot') {
      const path = join(f.campaignDirectory, 'ledger', 'records', '00000000.json');
      const events = campaigns.readCampaignEvents(f.campaignDirectory);
      const created = events[0]!;
      if (created.kind !== 'created') throw new Error('Fixture lacks creation');
      created.definition.id = 'another'; created.definitionDigest = digest(canonical(created.definition));
      chmodSync(path, 0o600); writeFileSync(path, `${canonical(created)}\n`);
    }
    const before = inventory(f.root);
    const report = check(f);
    expect(report).toMatchObject({ sourceState: 'degraded', disposition: 'unavailable', reasonCode: 'evidence-degraded',
      automaticAction: 'none', expectedIdentity: null, recordsDigest: null });
    expect(canonical(report)).not.toContain(f.root);
    expect(canonical(report)).not.toContain('private diagnostic');
    expect(inventory(f.root)).toBe(before);
  });

  it('does not interpret an interleaved wrong campaign run as resource withholding', () => {
    const f = fixture(); runAndPause(f);
    for (const record of readRecords(f.directory)) {
      if (record.kind !== 'start' && record.kind !== 'final') continue;
      record.run.campaign!.definitionDigest = 'f'.repeat(64);
      const path = join(f.directory, 'ledger', 'records', `${record.id}.json`);
      chmodSync(path, 0o600); writeFileSync(path, `${canonical(record)}\n`);
    }
    expect(check(f)).toMatchObject({ sourceState: 'degraded', reasonCode: 'evidence-degraded', expectedIdentity: null });
  });
});

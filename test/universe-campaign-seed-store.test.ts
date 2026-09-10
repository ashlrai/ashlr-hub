/** Independent seed-ledger validation. Local fixture initialization never executes its evaluator. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { appendCampaignEvent, campaignDirectory, foldCampaignEvents, initUniverseCampaign, readCampaignEvents,
  readUniverseCampaign, validateUniverseCampaignDefinition, type CampaignEvent, type CampaignEventInput } from '../src/core/universe/campaign-store.js';
import { initUniverse, manifestRecord } from '../src/core/universe/store.js';
import { acquireUniverseExecution, withUniverseExecution } from '../src/core/universe/execution.js';
import { releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { runUniverseCampaign } from '../src/core/universe/campaign.js';
import type { UniverseCampaignDefinition, UniverseCampaignSeedIntent, UniverseCampaignSeedResult } from '../src/core/universe/types.js';

const at = '2026-09-10T12:00:00.000Z';
const deadlineAt = '2026-09-10T12:01:00.000Z';
const finishedAt = '2026-09-10T12:00:00.010Z';
const owner = { pid: process.pid, startRef: 'seed-store-fixture' };
const roots: string[] = [];
afterEach(() => {
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function definition(measureSeed = true): UniverseCampaignDefinition {
  return { schemaVersion: 1, id: 'seed-campaign', universeId: 'seed-fixture', feedback: true,
    ...(measureSeed ? { measureSeed: true as const } : {}),
    budget: { maxGenerations: 2, maxDurationMs: 60_000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: null } };
}
function records(inputs: CampaignEventInput[]): CampaignEvent[] {
  return inputs.map((input, sequence) => ({ ...input, sequence, id: String(sequence).padStart(8, '0') }));
}
function fixture(measureSeed = true) {
  const def = definition(measureSeed);
  const created: CampaignEventInput = { kind: 'created', at, definition: def, definitionDigest: digest(canonical(def)),
    manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64) };
  const started: CampaignEventInput = { kind: 'started', at, deadlineAt, owner };
  const intent: UniverseCampaignSeedIntent = { schemaVersion: 1, id: '11111111-1111-4111-8111-111111111111', sessionSequence: 1,
    definitionDigest: created.definitionDigest, manifestDigest: created.manifestDigest, comparatorDigest: created.comparatorDigest,
    seedArtifactDigest: 'd'.repeat(64), context: 'campaign-seed-v1', startedAt: at, deadlineAt };
  const result: UniverseCampaignSeedResult = { schemaVersion: 1, intentDigest: digest(canonical(intent)), status: 'measured',
    finishedAt, durationMs: 10, processGroupSettlement: 'group-exit-confirmed', measurement: { passed: false, score: 0, metrics: { cases: 142 } }, reason: null };
  const intention: CampaignEventInput = { kind: 'seed-evaluation-intent', at, evaluation: intent };
  const completion: CampaignEventInput = { kind: 'seed-evaluation-result', at: finishedAt, evaluation: result };
  const step: CampaignEventInput = { kind: 'step', at: finishedAt, ordinal: 1, generation: 1,
    runId: '22222222-2222-4222-8222-222222222222', variantIds: ['change'], reservedModelRequests: 1 };
  const inputs = [created, started, intention, completion];
  return { def, created, started, intent, result, intention, completion, step, inputs };
}
function fold(inputs: CampaignEventInput[]) { return foldCampaignEvents(records(inputs)); }
function badIntent(patch: Record<string, unknown>): CampaignEventInput {
  const f = fixture(); return { ...f.intention, evaluation: { ...f.intent, ...patch } } as CampaignEventInput;
}
function badResult(patch: Record<string, unknown>): CampaignEventInput {
  const f = fixture(); return { ...f.completion, evaluation: { ...f.result, ...patch } } as CampaignEventInput;
}

describe('seed measurement is an immutable explicit campaign policy', () => {
  it('preserves absent legacy shape and changes only opted-in definition identity', () => {
    const legacy = definition(false); const checked = validateUniverseCampaignDefinition(legacy);
    expect(checked).toEqual(legacy); expect(Object.hasOwn(checked, 'measureSeed')).toBe(false);
    expect(digest(canonical(checked))).toBe(digest(canonical(legacy)));
    expect(digest(canonical(validateUniverseCampaignDefinition(definition())))).not.toBe(digest(canonical(legacy)));
    const f = fixture(false); expect(fold([f.created, f.started, f.step])).not.toHaveProperty('seedEvaluation');
  });
  it.each([false, undefined, null, 1, 'true'])('rejects explicit non-true opt-in %s', (measureSeed) => {
    expect(() => validateUniverseCampaignDefinition({ ...definition(false), measureSeed })).toThrow();
  });
  it('rejects inherited options, getters and unknown properties without invoking option accessors', () => {
    const getter = vi.fn(() => true); const accessor = definition(false);
    Object.defineProperty(accessor, 'measureSeed', { enumerable: true, get: getter });
    for (const input of [accessor, Object.assign(Object.create({ measureSeed: true }), definition(false)),
      { ...definition(), seedPrompt: 'not a supported field' }]) expect(() => validateUniverseCampaignDefinition(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('seed intent/result ledger linkage and restart rules', () => {
  it.each([false, true])('accepts a real measurement with passed=%s without inventing trials or consuming model budget', (passed) => {
    const f = fixture(); f.result.measurement = { passed, score: -2.5, metrics: { cases: 142 } };
    const folded = fold(f.inputs);
    expect(folded.seedEvaluation).toEqual({ intent: f.intent, result: f.result });
    expect(folded.steps).toEqual([]); expect(folded.state).toBe('running');
    expect(fold([...f.inputs, f.step]).steps).toHaveLength(1);
  });
  it('requires opt-in, active ownership, measurement before dispatch, and exactly one intent/result', () => {
    const f = fixture(); const legacy = fixture(false);
    for (const inputs of [[legacy.created, legacy.started, legacy.intention], [f.created, f.intention],
      [f.created, f.started, f.step], [f.created, f.started, f.intention, f.step],
      [f.created, f.started, f.completion], [...f.inputs, f.intention], [...f.inputs, f.completion],
      [...f.inputs, f.step, f.intention]]) expect(() => fold(inputs)).toThrow();
  });
  it.each([
    { sessionSequence: 2 }, { definitionDigest: 'a'.repeat(64) }, { manifestDigest: 'a'.repeat(64) },
    { comparatorDigest: 'a'.repeat(64) }, { seedArtifactDigest: 'not-a-digest' }, { context: 'generation-1' },
    { id: 'not-a-uuid' }, { deadlineAt: '2026-09-10T12:02:00.000Z' }, { startedAt: finishedAt },
    { evaluatorOutput: 'PRIVATE-SEED-SENTINEL' },
  ])('rejects malformed or foreign intent %j', (patch) => {
    const f = fixture(); expect(() => fold([f.created, f.started, badIntent(patch)])).toThrow();
  });
  it.each([
    { intentDigest: 'a'.repeat(64) }, { finishedAt: at }, { durationMs: -1 }, { durationMs: Infinity },
    { processGroupSettlement: 'unknown' }, { processGroupSettlement: 'not-started' },
    { reason: 'evaluator-failed' }, { measurement: null },
    { measurement: { passed: false, score: Infinity, metrics: {} } },
    { measurement: { passed: 'false', score: 0, metrics: {} } },
    { measurement: { passed: false, score: 0, metrics: { count: NaN } } },
    { measurement: { passed: false, score: 0, metrics: {}, stdout: 'PRIVATE-SEED-SENTINEL' } },
    { stdout: 'PRIVATE-SEED-SENTINEL' }, { status: 'succeeded' },
  ])('rejects malformed or falsely measured result %j', (patch) => {
    const f = fixture(); expect(() => fold([f.created, f.started, f.intention, badResult(patch)])).toThrow();
  });
  it('rejects measurement at the original deadline and before its intent', () => {
    const f = fixture();
    for (const time of [deadlineAt, '2026-09-10T11:59:59.999Z']) {
      expect(() => fold([f.created, f.started, f.intention,
        { kind: 'seed-evaluation-result', at: time, evaluation: { ...f.result, finishedAt: time } }])).toThrow();
    }
  });
  it.each(['pause', 'stop'] as const)('honors pending %s while recording honest cancellation, never late measurement', (action) => {
    const f = fixture(); const pending = [f.created, f.started, f.intention,
      { kind: 'control', at, action } as CampaignEventInput];
    expect(() => fold([...pending, f.completion])).toThrow();
    const evaluation: UniverseCampaignSeedResult = { ...f.result, status: 'cancelled', reason: 'evaluation-cancelled', measurement: null };
    const inputs: CampaignEventInput[] = [...pending, { kind: 'seed-evaluation-result', at: finishedAt, evaluation },
      { kind: 'settled', at: finishedAt, state: action === 'pause' ? 'paused' : 'stopped', reason: 'Owner acknowledged control' }];
    expect(fold(inputs).seedEvaluation?.result).toEqual(evaluation);
  });
  it.each([
    ['failed', 'evaluator-failed'], ['failed', 'evaluator-invalid-result'], ['failed', 'integrity-changed'],
    ['cancelled', 'evaluation-cancelled'], ['timed-out', 'evaluation-timed-out'],
  ] as const)('records %s/%s without treating it as a measurement or dispatch authorization', (status, reason) => {
    const f = fixture(); const evaluation: UniverseCampaignSeedResult = { ...f.result, status, reason, measurement: null, processGroupSettlement: 'not-started' };
    const inputs: CampaignEventInput[] = [f.created, f.started, f.intention, { kind: 'seed-evaluation-result', at: finishedAt, evaluation }];
    expect(fold(inputs).seedEvaluation?.result?.measurement).toBeNull();
    expect(() => fold([...inputs, f.step])).toThrow();
    expect(() => fold([...inputs.slice(0, 3), { kind: 'seed-evaluation-result', at: finishedAt,
      evaluation: { ...evaluation, measurement: f.result.measurement } }])).toThrow();
  });
  it.each(['paused', 'interrupted', 'stopped', 'failed'] as const)('can settle unresolved evaluator as %s but cannot replay it', (state) => {
    const f = fixture(); const inputs: CampaignEventInput[] = [f.created, f.started, f.intention,
      { kind: 'settled', at: finishedAt, state, reason: 'Evaluation ownership ended' }];
    expect(fold(inputs)).toMatchObject({ state, seedEvaluation: { result: null } });
    expect(() => fold([...inputs, f.started])).toThrow();
    expect(() => fold([...inputs, f.step])).toThrow();
  });
  it('never completes an unresolved intent, and reuses measured evidence across resume without a renewed deadline', () => {
    const f = fixture();
    expect(() => fold([f.created, f.started, f.intention, { kind: 'settled', at: finishedAt, state: 'completed', reason: 'Invalid completion' }])).toThrow();
    const resumed: CampaignEventInput[] = [...f.inputs,
      { kind: 'settled', at: finishedAt, state: 'paused', reason: 'Pause after measurement' },
      { kind: 'started', at: finishedAt, deadlineAt, owner }];
    expect(fold([...resumed, f.step])).toMatchObject({ deadlineAt, seedEvaluation: { intent: f.intent, result: f.result } });
    expect(() => fold([...resumed, f.intention])).toThrow();
    const changed = structuredClone(resumed); changed[5] = { kind: 'started', at: finishedAt, deadlineAt: '2026-09-10T12:02:00.000Z', owner };
    expect(() => fold(changed)).toThrow();
  });
  it('cannot claim opt-in completion without a measured seed, including a settled operational failure', () => {
    const f = fixture(); const completion: CampaignEventInput = { kind: 'settled', at: finishedAt, state: 'completed', reason: 'Budget exhausted' };
    expect(() => fold([f.created, f.started, completion])).toThrow();
    for (const [status, reason] of [['failed', 'evaluator-failed'], ['cancelled', 'evaluation-cancelled'],
      ['timed-out', 'evaluation-timed-out']] as const) {
      const evaluation: UniverseCampaignSeedResult = { ...f.result, status, reason, measurement: null };
      expect(() => fold([f.created, f.started, f.intention, { kind: 'seed-evaluation-result', at: finishedAt, evaluation }, completion])).toThrow();
    }
    expect(fold([...f.inputs, completion]).state).toBe('completed');
  });
});

function initializedFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'campaign-seed-store-'))); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'evaluate.mjs'), "throw new Error('Fixture evaluator must never execute');\n");
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } }).trim();
  git('init', '-q', '--template=', '--initial-branch=main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  initUniverse({ schemaVersion: 1, id: 'seed-fixture', name: 'Seed store fixture', objective: 'Validate durable measurement records',
    seed: { repo, revision: git('rev-parse', 'HEAD') }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 1000, trialTimeoutMs: 1000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'change', niche: 'quality', hypothesis: 'Fixture only', command: [process.execPath, '-e', 'process.exit(0)'] }] }, { root });
  return { root, directory: campaignDirectory('seed-campaign', { root }) };
}

describe('private seed record persistence and observation', () => {
  it('projects retained measurement with zero synthetic runs/reservations and refuses invalid appends without persisting private data', () => {
    const { root, directory } = initializedFixture(); const f = fixture();
    const first = initUniverseCampaign(f.def, { root }); expect(first).not.toHaveProperty('seedEvaluation');
    const intent = { ...f.intent, definitionDigest: first.definitionDigest, manifestDigest: first.manifestDigest, comparatorDigest: first.comparatorDigest };
    const result = { ...f.result, intentDigest: digest(canonical(intent)) };
    appendCampaignEvent(directory, f.started);
    appendCampaignEvent(directory, { kind: 'seed-evaluation-intent', at, evaluation: intent });
    appendCampaignEvent(directory, { kind: 'seed-evaluation-result', at: finishedAt, evaluation: result });
    const before = readCampaignEvents(directory);
    const files = readdirSync(join(directory, 'ledger', 'records')).sort();
    const bytes = files.map((name) => readFileSync(join(directory, 'ledger', 'records', name), 'utf8'));
    expect(() => appendCampaignEvent(directory, { kind: 'seed-evaluation-result', at: finishedAt,
      evaluation: { ...result, stdout: 'PRIVATE-SEED-SENTINEL' } } as CampaignEventInput)).toThrow();
    const summary = readUniverseCampaign(f.def.id, { root });
    expect(summary).toMatchObject({ sourceState: 'healthy', seedEvaluation: { intent, result }, steps: [],
      progress: { attempts: 0, completedRuns: 0, reservedModelRequests: 0, admissions: 0, improvements: 0 } });
    expect(readUniverseCampaign(f.def.id, { root })).toEqual(summary);
    expect(readCampaignEvents(directory)).toEqual(before);
    expect(readdirSync(join(directory, 'ledger', 'records')).sort()).toEqual(files);
    expect(files.map((name) => readFileSync(join(directory, 'ledger', 'records', name), 'utf8'))).toEqual(bytes);
    expect(bytes.join('')).not.toContain('PRIVATE-SEED-SENTINEL');
    for (const name of files) expect(lstatSync(join(directory, 'ledger', 'records', name)).mode & 0o077).toBe(0);
  });
  it('does not upgrade an existing legacy campaign or reset its budget by changing opt-in', () => {
    const { root, directory } = initializedFixture(); const legacy = definition(false);
    const first = initUniverseCampaign(legacy, { root }); const recordsBefore = readCampaignEvents(directory);
    expect(() => initUniverseCampaign(definition(), { root })).toThrow(/immutable/);
    expect(initUniverseCampaign(legacy, { root })).toEqual(first);
    expect(readCampaignEvents(directory)).toEqual(recordsBefore);
    expect(readUniverseCampaign(legacy.id, { root })).not.toHaveProperty('seedEvaluation');
  });
});

describe('shared Universe acquisition refuses residual seed evaluator uncertainty', () => {
  function pending() {
    const f = initializedFixture(); const base = fixture();
    const summary = initUniverseCampaign(base.def, { root: f.root });
    const intent = { ...base.intent, definitionDigest: summary.definitionDigest, manifestDigest: summary.manifestDigest,
      comparatorDigest: summary.comparatorDigest,
      seedArtifactDigest: manifestRecord(join(f.root, 'universes', base.def.universeId)).seedArtifact.digest };
    appendCampaignEvent(f.directory, base.started);
    appendCampaignEvent(f.directory, { kind: 'seed-evaluation-intent', at, evaluation: intent });
    return { ...f, base, intent };
  }
  function acquireAndRelease(root: string, id = 'seed-fixture') {
    const outcome = acquireUniverseExecution(id, { root });
    expect(outcome.state).toBe('acquired');
    if (outcome.state === 'acquired') releaseLocalStoreLock(outcome.lock);
    expect(existsSync(join(root, 'universes', id, '.execution.lock'))).toBe(false);
  }

  it.each(['paused', 'stopped'] as const)('blocks sibling campaigns and direct acquisition after unresolved %s, releasing every refused lease', async (state) => {
    const f = pending();
    appendCampaignEvent(f.directory, { kind: 'settled', at: finishedAt, state, reason: 'Unconfirmed evaluator termination' });
    initUniverseCampaign({ ...definition(), id: 'sibling' }, { root: f.root });
    const before = readCampaignEvents(f.directory);
    const operation = vi.fn(async () => 'must not execute');
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => acquireUniverseExecution('seed-fixture', { root: f.root })).toThrow(/unresolved campaign seed evaluator/);
      expect(existsSync(join(f.root, 'universes', 'seed-fixture', '.execution.lock'))).toBe(false);
    }
    await expect(withUniverseExecution('seed-fixture', { root: f.root }, operation)).rejects.toThrow(/unresolved campaign seed evaluator/);
    await expect(runUniverseCampaign('sibling', { root: f.root })).rejects.toThrow(/unresolved campaign seed evaluator/);
    expect(operation).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'universes', 'seed-fixture', '.execution.lock'))).toBe(false);
    expect(readCampaignEvents(f.directory)).toEqual(before);
    expect(readUniverseCampaign('sibling', { root: f.root })).toMatchObject({ state: 'ready', progress: { attempts: 0 } });
  });

  it('does not block another valid Universe because an unrelated campaign has an unresolved evaluator', () => {
    const f = pending();
    const manifest = manifestRecord(join(f.root, 'universes', 'seed-fixture')).manifest;
    initUniverse({ ...manifest, id: 'other-fixture' }, { root: f.root });
    initUniverseCampaign({ ...definition(), id: 'other-campaign', universeId: 'other-fixture' }, { root: f.root });
    const before = readCampaignEvents(f.directory);
    acquireAndRelease(f.root, 'other-fixture');
    expect(readCampaignEvents(f.directory)).toEqual(before);
    expect(() => acquireUniverseExecution('seed-fixture', { root: f.root })).toThrow(/unresolved campaign seed evaluator/);
  });

  it.each(['failed', 'cancelled', 'timed-out'] as const)('does not confuse a settled %s receipt with a residual-process fence', (status) => {
    const f = pending();
    const evaluation: UniverseCampaignSeedResult = { ...f.base.result, intentDigest: digest(canonical(f.intent)), status, measurement: null,
      reason: status === 'failed' ? 'evaluator-failed' : status === 'cancelled' ? 'evaluation-cancelled' : 'evaluation-timed-out' };
    appendCampaignEvent(f.directory, { kind: 'seed-evaluation-result', at: finishedAt, evaluation });
    appendCampaignEvent(f.directory, { kind: 'settled', at: finishedAt, state: 'paused', reason: 'Operational attention required' });
    const before = readCampaignEvents(f.directory);
    acquireAndRelease(f.root);
    expect(readCampaignEvents(f.directory)).toEqual(before);
  });

  it('preserves acquisition with no campaign inventory, absent legacy policy, and opted-in but unstarted campaigns', () => {
    const f = initializedFixture();
    acquireAndRelease(f.root);
    initUniverseCampaign(definition(false), { root: f.root });
    acquireAndRelease(f.root);
    initUniverseCampaign({ ...definition(), id: 'unstarted' }, { root: f.root });
    acquireAndRelease(f.root);
  });

  it.each([1, 3])('propagates a prepublication veto at writer checkpoint %s without publishing a seed result', (refuseAt) => {
    const f = pending(); const before = readCampaignEvents(f.directory);
    let calls = 0;
    const prepublish = () => { if (++calls === refuseAt) throw new Error('Final ownership or stop veto'); };
    expect(() => appendCampaignEvent(f.directory, { kind: 'seed-evaluation-result', at: finishedAt,
      evaluation: { ...f.base.result, intentDigest: digest(canonical(f.intent)) } }, { prepublish })).toThrow(/evidence write failed/);
    expect(calls).toBe(refuseAt);
    expect(readCampaignEvents(f.directory)).toEqual(before);
    expect(existsSync(join(f.directory, '.control.lock'))).toBe(false);
    expect(existsSync(join(f.directory, 'ledger', '.records.lock'))).toBe(false);
  });
});

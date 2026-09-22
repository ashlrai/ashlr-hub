import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { appendCampaignEvent, campaignDirectory, foldCampaignEvents, initUniverseCampaign, projectCampaign,
  readCampaignEvents, type CampaignEvent, type CampaignEventInput } from '../src/core/universe/campaign-store.js';
import { readCompletedUniverseCampaignDispatch } from '../src/core/universe/campaign-dispatch.js';
import { runUniverseCampaign } from '../src/core/universe/campaign.js';
import { appendRecord, comparatorDigest, type ManifestRecord } from '../src/core/universe/store.js';
import type { UniverseCampaignDefinition, UniverseCampaignSeedIntent, UniverseCampaignSeedResult, UniverseRun, UniverseSummary } from '../src/core/universe/types.js';

const hooks = vi.hoisted(() => ({ events: [] as CampaignEvent[], universe: undefined as UniverseSummary | undefined,
  reads: 0, failRead: false, realRecords: false, mutateRead: undefined as (() => void) | undefined, run: vi.fn() }));
vi.mock('../src/core/universe/campaign-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/universe/campaign-store.js')>();
  return { ...actual,
    readCampaignEvents: (...args: Parameters<typeof actual.readCampaignEvents>) => {
      if (hooks.realRecords) return actual.readCampaignEvents(...args);
      hooks.reads++; if (hooks.failRead) throw new Error('Unavailable synthetic evidence');
      const mutate = hooks.mutateRead; hooks.mutateRead = undefined; mutate?.();
      actual.foldCampaignEvents(hooks.events); return structuredClone(hooks.events);
    },
    readUniverseCampaign: (...args: Parameters<typeof actual.readUniverseCampaign>) => hooks.realRecords ? actual.readUniverseCampaign(...args) : actual.projectCampaign(hooks.events, hooks.universe!),
    campaignUniverse: () => hooks.universe!,
    appendCampaignEvent: (directory: string, input: CampaignEventInput) => {
      if (hooks.realRecords) return actual.appendCampaignEvent(directory, input);
      const next = [...hooks.events, { ...input, id: String(hooks.events.length).padStart(8, '0'), sequence: hooks.events.length }];
      actual.foldCampaignEvents(next); hooks.events = next; return structuredClone(next);
    },
  };
});
vi.mock('../src/core/universe/execution.js', () => ({ assertUniverseExecution: () => {}, withUniverseExecution: async (_id: string, _options: unknown,
  callback: (lock: unknown) => unknown) => callback({}) }));
vi.mock('../src/core/fleet/local-store-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/local-store-lock.js')>();
  return { ...actual, ownsLocalStoreLock: (...args: Parameters<typeof actual.ownsLocalStoreLock>) => hooks.realRecords ? actual.ownsLocalStoreLock(...args) : true,
    verifiedProcessStartRef: (...args: Parameters<typeof actual.verifiedProcessStartRef>) => hooks.realRecords ? actual.verifiedProcessStartRef(...args) : 'synthetic-owner' };
});
vi.mock('../src/core/universe/runner.js', () => ({ runUniverseOwned: hooks.run }));

const DISPATCH = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:00:01.000Z';
const DEADLINE = '2026-01-01T00:01:00.000Z';
const roots: string[] = [];
afterEach(() => { hooks.events = []; hooks.universe = undefined; hooks.reads = 0; hooks.failRead = false;
  hooks.realRecords = false; hooks.mutateRead = undefined; hooks.run.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function append(input: CampaignEventInput): void {
  hooks.events.push({ ...input, id: String(hooks.events.length).padStart(8, '0'), sequence: hooks.events.length });
}
function fixture() {
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: 'campaign', universeId: 'fixture', feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 60_000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } };
  hooks.universe = { manifest: { schemaVersion: 1, id: 'fixture', name: 'Synthetic dispatch fixture', objective: 'Test attribution',
    seed: { repo: '/unused/synthetic', revision: 'a'.repeat(40) }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 10_000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'change', niche: 'value', hypothesis: 'Synthetic change', command: ['node', 'worker.mjs'] }] },
  manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), runs: [], elites: [], activeRun: null, sourceState: 'healthy', reasons: [] };
  append({ kind: 'created', at: AT, definition, definitionDigest: digest(canonical(definition)),
    manifestDigest: hooks.universe.manifestDigest, comparatorDigest: hooks.universe.comparatorDigest });
  return { dispatchId: DISPATCH, intentAt: AT, universeId: 'fixture', definitionDigest: digest(canonical(definition)),
    manifestDigest: hooks.universe.manifestDigest, comparatorDigest: hooks.universe.comparatorDigest,
    recordsDigest: digest(canonical(hooks.events)) };
}
function start(dispatchId: string | undefined = DISPATCH): void {
  append({ kind: 'started', at: AT, deadlineAt: DEADLINE, owner: { pid: process.pid, startRef: 'synthetic-owner' },
    ...(dispatchId === undefined ? {} : { dispatchId }) });
}
function complete(dispatchId: string | undefined = DISPATCH): void {
  append({ kind: 'settled', at: LATER, state: 'completed', reason: 'Synthetic completed receipt',
    ...(dispatchId === undefined ? {} : { dispatchId }) });
}
function proof(expected: ReturnType<typeof fixture>) {
  return readCompletedUniverseCampaignDispatch('campaign', expected, { root: '/unused/synthetic' });
}

describe('campaign session dispatch identity', () => {
  it('keeps nonce-free legacy history readable', () => {
    fixture(); start(); delete (hooks.events[1] as { dispatchId?: string }).dispatchId;
    complete(); delete (hooks.events[2] as { dispatchId?: string }).dispatchId;
    expect(foldCampaignEvents(hooks.events).state).toBe('completed');
  });
  it.each(['started', 'settled'] as const)('rejects malformed %s identity', (kind) => {
    fixture(); start(); complete();
    Object.assign(hooks.events.find((event) => event.kind === kind)!, { dispatchId: 'invalid' });
    expect(() => foldCampaignEvents(hooks.events)).toThrow(/invalid records/);
  });
  it('rejects a settlement attributed to another session', () => {
    fixture(); start(); complete(OTHER);
    expect(() => foldCampaignEvents(hooks.events)).toThrow(/does not match/);
  });
  it('rejects attribution without a started session', () => {
    fixture(); complete(); expect(() => foldCampaignEvents(hooks.events)).toThrow(/does not match/);
  });
  it('rejects reuse after a paused session', () => {
    fixture(); start(); append({ kind: 'settled', at: AT, state: 'paused', reason: 'Paused', dispatchId: DISPATCH }); start();
    expect(() => foldCampaignEvents(hooks.events)).toThrow(/cannot be reused/);
  });
  it('does not copy an old identity through generic owner settlement', () => {
    fixture(); start(); append({ kind: 'settled', at: AT, state: 'paused', reason: 'Owner paused' });
    complete(); expect(() => foldCampaignEvents(hooks.events)).toThrow(/does not match/);
  });
  it('validates runner identity before reading or writing evidence', async () => {
    await expect(runUniverseCampaign('campaign', { dispatchId: 'bad' })).rejects.toThrow(/Invalid campaign dispatch/);
    expect(hooks.reads).toBe(0); expect(hooks.events).toHaveLength(0); expect(hooks.run).not.toHaveBeenCalled();
  });
  it('does not attribute pre-start cancellation to the supplied identity', async () => {
    fixture(); const controller = new AbortController(); controller.abort();
    const result = await runUniverseCampaign('campaign', { dispatchId: DISPATCH, signal: controller.signal });
    expect(result.state).toBe('paused'); expect(hooks.events.at(-1)).not.toHaveProperty('dispatchId');
    expect(hooks.events.some((event) => event.kind === 'started')).toBe(false);
    expect(hooks.run).not.toHaveBeenCalled();
  });
  it('refuses reused runner identity without altering a paused history', async () => {
    fixture(); start(); append({ kind: 'settled', at: AT, state: 'paused', reason: 'Paused', dispatchId: DISPATCH });
    const before = canonical(hooks.events);
    await expect(runUniverseCampaign('campaign', { dispatchId: DISPATCH })).rejects.toThrow(/cannot be reused/);
    expect(canonical(hooks.events)).toBe(before); expect(hooks.run).not.toHaveBeenCalled();
  });
  it('copies invocation identity and stamps only its own successful start and finish', async () => {
    fixture(); const options = { dispatchId: DISPATCH };
    hooks.run.mockImplementation(async (_id: string, runOptions: { runId: string; campaign: UniverseRun['campaign'] }) => {
      options.dispatchId = OTHER;
      const run: UniverseRun = { id: runOptions.runId, universeId: 'fixture', generation: 1,
        manifestDigest: hooks.universe!.manifestDigest, comparatorDigest: hooks.universe!.comparatorDigest,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'completed', campaign: runOptions.campaign,
        trials: [{ id: 'trial', variantId: 'change', niche: 'value', parentTrialId: null, status: 'failed', score: null,
          metrics: {}, artifact: null, durationMs: 1, delta: null, selected: false }], durationMs: 1, tokensUsed: null, costUsd: null };
      hooks.universe!.runs.push(run); return run;
    });
    const result = await runUniverseCampaign('campaign', options);
    expect(result.state).toBe('completed');
    expect(hooks.events.filter((event) => event.kind === 'started' || event.kind === 'settled'))
      .toEqual([expect.objectContaining({ kind: 'started', dispatchId: DISPATCH }), expect.objectContaining({ kind: 'settled', dispatchId: DISPATCH })]);
    expect(hooks.run).toHaveBeenCalledOnce();
  });
});

describe('read-only completed dispatch proof', () => {
  it('proves the exact admitted prefix and attributed completion without mutation', () => {
    const expected = fixture(); start(); complete(); const before = canonical(hooks.events);
    expect(proof(expected)).toEqual({ campaign: projectCampaign(hooks.events, hooks.universe!), recordsDigest: digest(before) });
    expect(canonical(hooks.events)).toBe(before); expect(hooks.run).not.toHaveBeenCalled();
  });
  it.each(['recordsDigest', 'definitionDigest', 'manifestDigest', 'comparatorDigest'] as const)('rejects changed %s', (field) => {
    const expected = fixture(); start(); complete(); expect(proof({ ...expected, [field]: 'f'.repeat(64) })).toBeNull();
  });
  it('rejects unrelated completed dispatch identity', () => {
    const expected = fixture(); start(OTHER); complete(OTHER); expect(proof(expected)).toBeNull();
  });
  it('does not infer missing historical settlement identity', () => {
    const expected = fixture(); start(); complete(); delete (hooks.events.at(-1) as { dispatchId?: string }).dispatchId;
    expect(proof(expected)).toBeNull();
  });
  it.each(['paused', 'interrupted', 'failed', 'stopped'] as const)('does not reconcile %s work', (state) => {
    const expected = fixture(); start(); append({ kind: 'settled', at: LATER, state, reason: 'Synthetic hold', dispatchId: DISPATCH });
    expect(proof(expected)).toBeNull(); expect(hooks.run).not.toHaveBeenCalled();
  });
  it('rejects later unrelated completion after an interrupted session', () => {
    const expected = fixture(); start(); append({ kind: 'settled', at: AT, state: 'interrupted', reason: 'Interrupted', dispatchId: DISPATCH });
    start(OTHER); complete(OTHER); expect(proof(expected)).toBeNull();
  });
  it('does not accept an owner control inside the attributed suffix', () => {
    const expected = fixture(); start(); append({ kind: 'control', at: AT, action: 'pause' });
    append({ kind: 'settled', at: AT, state: 'paused', reason: 'Paused by owner', dispatchId: DISPATCH });
    start(OTHER); complete(OTHER); expect(proof(expected)).toBeNull();
  });
  it('rejects raw evidence that changes during projection checks', () => {
    const expected = fixture(); start(); complete();
    let observations = 0;
    const source = hooks.universe!;
    Object.defineProperty(source, 'sourceState', { get: () => {
      if (++observations === 2) hooks.events.at(-1)!.at = '2026-01-01T00:00:02.000Z';
      return 'healthy';
    } });
    expect(proof(expected)).toBeNull();
  });
  it('rejects a timestamp rollback in an otherwise completed history', () => {
    const expected = fixture(); start(); complete(); hooks.events.at(-1)!.at = '2025-12-31T23:59:59.000Z';
    expect(proof(expected)).toBeNull();
  });
  it('rejects starts before controller intent and future settlement evidence', () => {
    const expected = fixture(); start(); complete(); expect(proof({ ...expected, intentAt: LATER })).toBeNull();
    hooks.events.at(-1)!.at = '2999-01-01T00:00:00.000Z'; expect(proof(expected)).toBeNull();
  });
  it('rejects degraded projection and unavailable private evidence', () => {
    const expected = fixture(); start(); complete(); hooks.universe!.sourceState = 'degraded'; hooks.universe!.reasons = ['Synthetic degradation'];
    expect(proof(expected)).toBeNull(); hooks.failRead = true; expect(proof(expected)).toBeNull();
  });
});

describe('completed seed measurement dispatch proof from real private records', () => {
  function measuredFixture() {
    hooks.realRecords = true;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'seed-dispatch-proof-'))); roots.push(root);
    const universe = join(root, 'universes', 'fixture'); const seed = join(universe, 'seed');
    mkdirSync(seed, { recursive: true, mode: 0o700 }); mkdirSync(join(universe, 'artifacts'), { mode: 0o700 });
    writeFileSync(join(seed, 'evaluate.mjs'), 'throw new Error("Fixture evaluator must not execute");');
    const manifest: ManifestRecord['manifest'] = { schemaVersion: 1, id: 'fixture', name: 'Seed dispatch fixture', objective: 'Verify exact recorded attribution',
      seed: { repo: join(root, 'source'), revision: 'a'.repeat(40) }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 1000, trialTimeoutMs: 1000 },
      evaluation: { command: ['evaluate.mjs'], timeoutMs: 1000 },
      variants: [{ id: 'change', niche: 'quality', hypothesis: 'Fixture only', command: ['evaluate.mjs'] }] };
    const partial: Omit<ManifestRecord, 'comparatorDigest'> = { id: 'manifest', kind: 'manifest', manifest,
      manifestDigest: digest(canonical(manifest)), seedArtifact: { path: seed, digest: artifactDigest(seed), revision: manifest.seed.revision },
      evaluationCommand: [join(seed, 'evaluate.mjs')], evaluationExecutableDigest: digest(readFileSync(join(seed, 'evaluate.mjs'))) };
    const record = { ...partial, comparatorDigest: comparatorDigest(partial) }; appendRecord(universe, record);
    const summary = initUniverseCampaign({ schemaVersion: 1, id: 'campaign', universeId: 'fixture', feedback: false, measureSeed: true,
      budget: { maxGenerations: 1, maxDurationMs: 60_000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root });
    const directory = campaignDirectory('campaign', { root });
    const expected = { dispatchId: DISPATCH, intentAt: AT, universeId: 'fixture', definitionDigest: summary.definitionDigest,
      manifestDigest: record.manifestDigest, comparatorDigest: record.comparatorDigest, recordsDigest: digest(canonical(readCampaignEvents(directory))) };
    appendCampaignEvent(directory, { kind: 'started', at: AT, deadlineAt: DEADLINE,
      owner: { pid: process.pid, startRef: 'fixture-owner' }, dispatchId: DISPATCH });
    const intent: UniverseCampaignSeedIntent = { schemaVersion: 1, id: OTHER, sessionSequence: 1,
      definitionDigest: summary.definitionDigest, manifestDigest: record.manifestDigest, comparatorDigest: record.comparatorDigest,
      seedArtifactDigest: record.seedArtifact.digest, context: 'campaign-seed-v1', startedAt: AT, deadlineAt: DEADLINE };
    appendCampaignEvent(directory, { kind: 'seed-evaluation-intent', at: AT, evaluation: intent });
    const result: UniverseCampaignSeedResult = { schemaVersion: 1, intentDigest: digest(canonical(intent)), status: 'measured',
      finishedAt: LATER, durationMs: 1000, processGroupSettlement: 'group-exit-confirmed',
      measurement: { passed: false, score: 0, metrics: { checks: 82 } }, reason: null };
    appendCampaignEvent(directory, { kind: 'seed-evaluation-result', at: LATER, evaluation: result });
    appendCampaignEvent(directory, { kind: 'settled', at: LATER, state: 'completed', reason: 'Recorded fixture completion', dispatchId: DISPATCH });
    return { root, directory, expected };
  }
  function snapshot(root: string) {
    const rows: unknown[] = [];
    const visit = (path: string) => {
      const stat = lstatSync(path); rows.push({ path: path.slice(root.length), mode: stat.mode, inode: stat.ino,
        mtime: stat.mtimeMs, ctime: stat.ctimeMs, bytes: stat.isFile() ? digest(readFileSync(path)) : null });
      if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    };
    visit(root); return canonical(rows);
  }
  it('accepts a measured seed suffix without reevaluation, redispatch, or any store mutation', () => {
    const f = measuredFixture(); const before = snapshot(f.root);
    const result = readCompletedUniverseCampaignDispatch('campaign', f.expected, { root: f.root });
    expect(result).toMatchObject({ campaign: { state: 'completed', sourceState: 'healthy', seedEvaluation: {
      result: { status: 'measured', measurement: { passed: false, score: 0 } } } },
    recordsDigest: digest(canonical(readCampaignEvents(f.directory))) });
    expect(snapshot(f.root)).toBe(before); expect(hooks.run).not.toHaveBeenCalled();
    expect(readCompletedUniverseCampaignDispatch('campaign', { ...f.expected, dispatchId: OTHER }, { root: f.root })).toBeNull();
  });
  it.each(['orphan-result', 'intent-mismatch', 'operational-result', 'operational-completed'] as const)('refuses %s without repairing or replaying private evidence', (kind) => {
    const f = measuredFixture(); const events = readCampaignEvents(f.directory);
    if (kind === 'orphan-result') events[2] = { kind: 'control', action: 'pause', at: AT, sequence: 2, id: '00000002' };
    else {
      const event = events[3]; if (event?.kind !== 'seed-evaluation-result') throw new Error('Fixture result missing');
      if (kind === 'intent-mismatch') event.evaluation.intentDigest = 'f'.repeat(64);
      else {
        event.evaluation = { ...event.evaluation, status: 'failed', measurement: null, reason: 'evaluator-failed' };
        if (kind === 'operational-result') {
          const settled = events[4]; if (settled?.kind !== 'settled') throw new Error('Fixture settlement missing');
          settled.state = 'failed';
        }
      }
    }
    for (const event of events.slice(2)) writeFileSync(join(f.directory, 'ledger', 'records', `${event.id}.json`), `${canonical(event)}\n`);
    if (kind === 'operational-result') expect(foldCampaignEvents(readCampaignEvents(f.directory)).state).toBe('failed');
    const before = snapshot(f.root);
    expect(readCompletedUniverseCampaignDispatch('campaign', f.expected, { root: f.root })).toBeNull();
    expect(snapshot(f.root)).toBe(before); expect(hooks.run).not.toHaveBeenCalled();
  });
});

/** Integration of real mission journals, feedback projection and accounted local
 * proposal transport. Delivered campaigns/setup/console adapters are synthetic;
 * this is NOT native evaluator, Git delivery, external model or product acceptance. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const adapters = vi.hoisted(() => ({ check: vi.fn(), prepare: vi.fn(), proof: vi.fn(), start: vi.fn(), request: vi.fn() }));
vi.mock('../src/core/resources/engineering-autonomous-setup.js', async original => ({
  ...await original<typeof import('../src/core/resources/engineering-autonomous-setup.js')>(),
  checkResourceEngineeringAutonomousSetup: adapters.check, prepareResourceEngineeringAutonomousSetup: adapters.prepare,
}));
vi.mock('../src/core/resources/engineering-predecessor-check.js', () => ({ checkResourceEngineeringPredecessor: adapters.proof }));
vi.mock('../src/core/web/resource-console-server.js', () => ({ startResourceConsoleServer: adapters.start }));
vi.mock('../src/core/resources/engineering-mission-console.js', () => ({
  requestEngineeringMissionConsole: adapters.request, MissionConsoleRequestError: class extends Error {},
}));
vi.mock('../src/core/sandbox/policy.js', () => ({ readKillSwitch: () => ({ state: 'inactive', sourceState: 'healthy' }) }));
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { resourcePoolStatus, runResourceTask, setResourcePoolAllocation, type ResourceTask } from '../src/core/resources/pool-runtime.js';
import { runResourceEngineeringMission } from '../src/core/resources/engineering-mission.js';
import { missionHash, readEngineeringMissionRecords, readResourceEngineeringMissionStatus, type ResourceEngineeringMissionConfig } from '../src/core/resources/engineering-mission-store.js';
import { projectEngineeringMissionFeedback } from '../src/core/resources/engineering-mission-feedback.js';
import type { ResourceEngineeringOutcomes } from '../src/core/resources/engineering-outcomes-types.js';
import type { ResourceEngineeringAutonomousSetupOptions } from '../src/core/resources/engineering-autonomous-setup.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.clearAllMocks(); });
type Mode = 'measured' | 'unknown' | 'tampered-history' | 'changed-receipt' | 'stop' | 'stop-before-publication';
async function fixture(mode: Mode) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mission-feedback-loop-')));
  const root = join(base, 'ledger'), missionRoot = join(base, 'mission'), workspace = join(base, 'project');
  for (const path of [missionRoot, workspace, join(base, 'transport')]) mkdirSync(path, { mode: 0o700 });
  const contexts: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const output = canonical(mode === 'stop' ? { action: 'stop' } : {
    action: 'propose', name: 'Reduce repeated verification', objective: 'Batch repeated fixed verification reads while preserving all acceptance checks.',
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; let bytes = 0;
    req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 128 * 1024) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const context = JSON.parse(body.messages[0].content); contexts.push(context);
        if (context.kind !== 'engineering-mission-proposal') throw Error();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      } catch { errors.push('Fixture protocol mismatch'); res.writeHead(500); res.end('Fixture refused'); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(base, { recursive: true, force: true }); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture listener unavailable');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'feedback', workers: [{ id: 'fixture', provider: 'local', model: 'inert-fixture',
    maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 2, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'fixture', capacityKey: 'fixture', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const observations = [{ workerId: 'fixture', health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }];
  const save = (name: string, data: unknown) => { const path = join(base, name); writeFileSync(path, canonical(data) + '\n', { mode: 0o600 }); return path; };
  const runtime = save('runtime.json', { schemaVersion: 1, root, workspace: join(base, 'transport'),
    poolPath: save('pool.json', pool), bindingsPath: save('bindings.json', bindings), observationsPath: save('observations.json', observations) });
  const allocation = setResourcePoolAllocation(root, pool, bindings, 75, 0);
  const policy = { schemaVersion: 1, id: 'first-queue', registrationScope: 'first-scope', profileId: 'fixed', label: 'Fixed benchmark',
    acceptance: 'Fixed evaluator only; local branch is not product acceptance.', maxEnrollments: 2, maxConcurrent: 1,
    successors: { allowedWorkerIds: ['fixture'], maxOutputTokens: 256, proposalTimeoutMs: 5000, maxSuccessors: 1, pollIntervalMs: 100 } };
  const recipe = { schemaVersion: 1, id: 'initial', projectId: 'default', name: 'Initial hypothesis', objective: 'Improve verification efficiency.',
    seedRevision: 'a'.repeat(40), metric: { name: 'processes', direction: 'minimize' as const, minImprovement: 1 },
    evaluation: { builtin: 'preparation-process-score-v1', timeoutMs: 1800_000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 1900_000, trialTimeoutMs: 1800_000 },
    campaignBudget: { maxGenerations: 1, maxModelRequests: 1 }, generation: { files: ['target.ts'], allowedWorkerIds: ['fixture'] },
    delivery: { branch: 'codex/initial' }, execution: { maxDurationMs: 2000_000 }, supervision: { maxDurationMs: 2100_000 } };
  const setup: ResourceEngineeringAutonomousSetupOptions = { recipe, policy, output: join(base, 'initial'), resourceRuntime: runtime,
    workspace, projectsFile: save('projects.json', { schemaVersion: 1, projects: [] }) };
  const plan = (value: ResourceEngineeringAutonomousSetupOptions) => ({ planDigest: missionHash(value), initialEnrollmentDigest: 'b'.repeat(64),
    paths: { profiles: join(value.output, 'profiles.json'), supervision: join(value.output, 'supervision.json'), successors: join(value.output, 'successors.json') } });
  const config: ResourceEngineeringMissionConfig = { schemaVersion: 1, id: 'feedback-loop', root: missionRoot,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), maxScopes: 2, pollIntervalMs: 100,
    proposalFeedback: 'measured-outcomes-v1', initial: { setup, expectedPlanDigest: plan(setup).planDigest } };
  const controller = new AbortController(); const prepared: ResourceEngineeringAutonomousSetupOptions[] = [];
  const scopes = new Map<string, ResourceEngineeringAutonomousSetupOptions>(); let active: ResourceEngineeringAutonomousSetupOptions | undefined;
  let isOpen = false; let task: ResourceTask | undefined; let resultRead = false;
  adapters.check.mockImplementation((value: ResourceEngineeringAutonomousSetupOptions) => { const checked = plan(value); scopes.set(checked.paths.profiles, value); return checked; });
  adapters.prepare.mockImplementation((value: ResourceEngineeringAutonomousSetupOptions & { expectedPlanDigest: string }, host: { beforePublication(): void }) => {
    if (prepared.length && mode === 'stop-before-publication') controller.abort();
    host.beforePublication(); const { expectedPlanDigest: _expected, ...published } = value;
    prepared.push(published); return plan(published);
  });
  const tipFor = (value: ResourceEngineeringAutonomousSetupOptions) => ({ enrollmentId: value.output === setup.output ? 'initial' : 'second',
    enrollmentDigest: 'b'.repeat(64), projectId: 'default', commit: (value.output === setup.output ? 'c' : 'd').repeat(40) });
  adapters.proof.mockImplementation(({ setup: value, proposalFeedback }: { setup: ResourceEngineeringAutonomousSetupOptions; proposalFeedback?: string }) => {
    expect(isOpen).toBe(false); const tip = tipFor(value);
    const usage = { attempts: 1, joinedAttempts: 1, reportedAttempts: mode === 'unknown' ? 0 : 1, unknownAttempts: mode === 'unknown' ? 1 : 0,
      recordedInputTokens: mode === 'unknown' ? 0 : 10, recordedOutputTokens: mode === 'unknown' ? 0 : 5,
      totalTokens: mode === 'unknown' ? null : 15, complete: mode !== 'unknown' };
    const timing = { scope: 'summed-worker-execution' as const, attempts: 1, measuredAttempts: mode === 'unknown' ? 0 : 1,
      recordedDurationMs: mode === 'unknown' ? 0 : 100, totalDurationMs: mode === 'unknown' ? null : 100, complete: mode !== 'unknown' };
    const outcomes: Omit<ResourceEngineeringOutcomes, 'sampledAt'> = { schemaVersion: 1, enrollmentId: tip.enrollmentId,
      enrollmentDigest: tip.enrollmentDigest, sourceState: mode === 'unknown' ? 'degraded' : 'healthy',
      scope: 'campaign-evaluations-and-recorded-worker-usage', authority: 'observation-only', productionAccepted: null, routingChanged: false,
      acceptanceScope: 'fixed-evaluator-and-local-branch-only', attribution: 'campaign-cumulative-not-graph-invocation', complete: mode !== 'unknown', reasons: [], usage, timing,
      campaigns: [{ campaignId: 'campaign', universeId: 'universe', sourceState: 'healthy', reasons: [], state: 'completed',
        definitionDigest: 'e'.repeat(64), comparatorDigest: 'f'.repeat(64), metric: recipe.metric, seed: { status: 'measured', score: 150, passed: true },
        stages: { trials: 1, evaluated: 1, passed: 1, rejected: 0, selected: 1, strictImprovements: 0, verifiedLocalDeliveries: 1 }, usage, timing,
        workers: [], niches: [{ niche: 'verification', score: 149, deltaFromSeed: 1, artifactDigest: 'a'.repeat(64), runId: 'run', trialId: 'trial' }] }] };
    return { schemaVersion: 1, scope: 'predecessor-completion-evidence-only', status: 'verified', reasons: [], sampledAt: config.deadlineAt,
      executionAuthorized: false, effectsExecuted: false, providerContacted: false, evidenceDigest: missionHash(tip), tip, continuation: 'eligible',
      ...(proposalFeedback ? { feedback: projectEngineeringMissionFeedback({ tip, deliveryDigest: '1'.repeat(64), outcomes }) } : {}) };
  });
  adapters.start.mockImplementation(async (options: { engineeringPreparationFile?: string }) => {
    expect(isOpen).toBe(false); isOpen = true; active = scopes.get(options.engineeringPreparationFile ?? '');
    return { url: 'http://127.0.0.1:1', consoleUrl: 'http://127.0.0.1:1', close: async () => { isOpen = false; } };
  });
  adapters.request.mockImplementation(async ({ path, body }: { path: string; body?: Record<string, unknown> }) => {
    if (path === '/api/resources/engineering-supervision') return { configId: (active!.policy as typeof policy).id, sourceState: 'healthy', paused: false,
      deadlineAt: config.deadlineAt, entries: [{ state: 'completed' }] };
    if (path === '/api/resources/engineering-successors') return { supervisionId: (active!.policy as typeof policy).id,
      deadlineAt: config.deadlineAt, entries: [{ state: 'admitted' }] };
    if (path === '/api/resources/tasks') {
      const { retainHistory: _retain, projectId: _project, ...submitted } = body!;
      task = { ...submitted, schemaVersion: 1, cwd: workspace } as ResourceTask;
      const result = await runResourceTask({ root, pool, bindings, observations, task, signal: controller.signal });
      expect(result.receipt?.status).toBe('completed'); return {};
    }
    if (path === '/api/resources') return { supervisor: { paused: false, closing: false, jobs: [{ id: task!.id, state: 'settled' }] } };
    if (path.endsWith('/history')) {
      resultRead = true;
      return { id: task!.id, prompt: task!.prompt, output: { text: mode === 'tampered-history' ? canonical({ action: 'stop' }) : output, truncated: false } };
    }
    throw Error('Unexpected fixture route');
  });
  if (mode === 'changed-receipt') {
    // Deliberately corrupt only the private fixture's previously settled receipt
    // after result publication; no production reader or join is mocked.
    const actual = adapters.start.getMockImplementation()!;
    adapters.start.mockImplementation(async (...args) => {
      const handle = await actual(...args);
      return { ...handle, close: async () => {
        await handle.close();
        if (resultRead) {
          const file = join(root, 'pool-state.json'); const state = JSON.parse(readFileSync(file, 'utf8'));
          state.attempts[0].outputDigest = '0'.repeat(64);
          writeFileSync(file, canonical(state) + '\n', { mode: 0o600 });
        }
      } };
    });
  }
  return { config, prepared, contexts, errors, controller, recipe, policy, allocation,
    status: () => resourcePoolStatus(root, pool, bindings, []), records: () => readEngineeringMissionRecords(config) };
}

describe('measured feedback through an accounted proposal into the next mission scope', () => {
  it.each(['measured', 'unknown'] as const)('retains %s evidence, uses the delivered seed, and never renews policy or repeats settled proposal transport', async mode => {
    const f = await fixture(mode);
    expect(await runResourceEngineeringMission(f.config)).toMatchObject({ state: 'completed', reason: 'scope-limit', scopesReserved: 2, deadlineAt: f.config.deadlineAt });
    expect(f.errors).toEqual([]); expect(f.contexts).toHaveLength(1);
    expect(f.contexts[0]).toMatchObject({ feedbackVersion: 'measured-outcomes-v1', measuredFeedback: {
      authority: 'observation-only', productionAccepted: null, source: { enrollmentId: 'initial', commit: 'c'.repeat(40) },
      campaigns: [{ seed: { score: 150 }, selected: [{ score: 149, deltaFromSeed: 1 }],
        usage: { totalTokens: mode === 'unknown' ? null : 15 }, timing: { totalDurationMs: mode === 'unknown' ? null : 100 } }] } });
    expect(f.prepared).toHaveLength(2);
    const next = f.prepared[1]!; const nextRecipe = next.recipe as typeof f.recipe; const nextPolicy = next.policy as typeof f.policy;
    expect(nextRecipe).toEqual({ ...f.recipe, id: nextRecipe.id, name: 'Reduce repeated verification',
      objective: 'Batch repeated fixed verification reads while preserving all acceptance checks.', seedRevision: 'c'.repeat(40), delivery: { branch: `codex/${nextRecipe.id}` } });
    expect(nextPolicy).toEqual({ ...f.policy, id: nextRecipe.id, registrationScope: nextRecipe.id });
    expect(nextRecipe.id).not.toBe(f.recipe.id); expect(next.resourceRuntime).toBe(f.config.initial.setup.resourceRuntime);
    const status = f.status(); expect(status.attempts).toHaveLength(1); expect(status.attempts[0]).toMatchObject({ status: 'completed', outputDigest: expect.any(String) });
    expect(status.allocation).toEqual(f.allocation);
    const before = f.records(); const proposal = before.find(row => row.kind === 'proposal')!.payload as { task: ResourceTask };
    expect(readResourceEngineeringMissionStatus(f.config).recordedFeedback).toMatchObject({ state: 'recorded', scopeIndex: 1,
      availability: 'available', campaignCount: 1, scope: 'retained-proposal-intent-only', evidenceState: 'not-revalidated' });
    const result = before.find(row => row.kind === 'result')!.payload as { output: string; receiptDigest: string };
    expect(status.attempts[0]!.taskDigest).toBe(missionHash(proposal.task)); expect(digest(result.output)).toBe(status.attempts[0]!.outputDigest);
    expect(result.receiptDigest).toBe(missionHash(status.attempts[0]));
    expect(await runResourceEngineeringMission(f.config)).toMatchObject({ state: 'completed', reason: 'scope-limit', scopesReserved: 2 });
    expect(f.records()).toEqual(before); expect(f.contexts).toHaveLength(1); expect(f.prepared).toHaveLength(2); expect(f.status().attempts).toHaveLength(1);
  }, 30_000);
  it.each(['tampered-history', 'changed-receipt', 'stop-before-publication'] as const)('does not publish the next prepared scope after %s', async mode => {
    const f = await fixture(mode);
    const result = await runResourceEngineeringMission(f.config, { signal: f.controller.signal });
    expect(result.state).toBe(mode === 'stop-before-publication' ? 'stopped' : 'held');
    expect(f.prepared).toHaveLength(1); expect(f.contexts).toHaveLength(1); expect(f.errors).toEqual([]);
    expect(f.records().filter(row => row.kind === 'prepared')).toHaveLength(1);
    if (mode === 'tampered-history') expect(result.reason).toBe('mission-proposal-output-unavailable');
    if (mode === 'changed-receipt') expect(result.reason).toBe('mission-proposal-result-changed');
  }, 30_000);
  it('honors an accounted proposer stop without reserving a second scope', async () => {
    const f = await fixture('stop');
    expect(await runResourceEngineeringMission(f.config)).toMatchObject({ state: 'completed', reason: 'stop-requested', scopesReserved: 1 });
    expect(f.records().filter(row => row.kind === 'reserved')).toHaveLength(1); expect(f.prepared).toHaveLength(1); expect(f.contexts).toHaveLength(1);
  }, 30_000);
});

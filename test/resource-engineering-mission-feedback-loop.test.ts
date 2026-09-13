/** Integration of real mission journals, feedback projection and accounted local
 * proposal transport. Delivered campaigns/setup/console adapters are synthetic;
 * this is NOT native evaluator, Git delivery, external model or product acceptance. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const adapters = vi.hoisted(() => ({ check: vi.fn(), prepare: vi.fn(), proof: vi.fn(), start: vi.fn(), request: vi.fn() }));
vi.mock('../src/core/resources/engineering-mission-proof.js', () => ({ readEngineeringMissionProof: async (request: { kind: string; input: unknown }) =>
  request.kind === 'setup' ? adapters.check(request.input) : adapters.proof(request.input) }));
vi.mock('../src/core/resources/engineering-autonomous-setup.js', async original => ({
  ...await original<typeof import('../src/core/resources/engineering-autonomous-setup.js')>(),
  checkResourceEngineeringAutonomousSetup: adapters.check,
}));
vi.mock('../src/core/resources/engineering-setup.js', () => ({ prepareEngineeringMissionSetup: adapters.prepare }));
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
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import type { ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import type { ResourceEngineeringLifetime } from '../src/core/resources/engineering-lifetime.js';
import { captureResourceEngineeringLifetime } from '../src/core/resources/engineering-lifetime.js';
import type { EngineeringSetupRequest, EngineeringSetupHost } from '../src/core/resources/engineering-setup.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.clearAllMocks(); });
type Mode = 'measured' | 'unknown' | 'stale-queue' | 'tampered-history' | 'changed-receipt' | 'stop' | 'stop-before-publication' | 'restart-recovery' | 'exhausted-recovery';
type ProposalStatus = 'progress' | 'paused' | 'closing' | 'error' | 'missing' | 'foreign' | 'unresolved' | 'cancelled' | 'unknown';
async function fixture(mode: Mode, proposalStatus?: ProposalStatus) {
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
  if (mode === 'exhausted-recovery') {
    // Actual completed loopback tasks exhaust the existing shared window. These
    // are unrelated prior tasks, not fabricated campaign or evaluator receipts.
    for (let index = 1; index <= 2; index++) {
      const result = await runResourceTask({ root, pool, bindings, observations, task: {
        schemaVersion: 1, id: `prior-accounted-${index}`, cwd: workspace, mode: 'read-only',
        allowedWorkerIds: ['fixture'], maxOutputTokens: 256, timeoutMs: 5000,
        prompt: canonical({ kind: 'engineering-mission-proposal', fixturePriorTask: index }),
      } });
      expect(result.receipt?.status).toBe('completed');
    }
  }
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
  let proposalWork: Promise<unknown> | undefined;
  let durableOwner: ResourcePoolSupervisor | undefined; let crashOnce = mode === 'restart-recovery' || mode === 'exhausted-recovery';
  let queueReads = 0; const drainReads: number[] = []; const statusPaths: string[] = [];
  adapters.check.mockImplementation((value: ResourceEngineeringAutonomousSetupOptions) => { const checked = plan(value); scopes.set(checked.paths.profiles, value); return checked; });
  adapters.prepare.mockImplementation(async ({ input: value, predecessor }: EngineeringSetupRequest, host: EngineeringSetupHost) => {
    if (prepared.length && mode === 'stop-before-publication') controller.abort();
    // Synthetic publication seam only; the real cooperative worker is covered separately.
    if (captureResourceEngineeringLifetime({ engineeringLifetime: host.lifetime }).isStopped()) throw Error('Fixture stopped');
    if (predecessor) {
      const proof = adapters.proof(predecessor.options);
      if (proof.status !== 'verified' || proof.continuation !== 'eligible' ||
        canonical(proof.tip) !== canonical(predecessor.expectedTip)) throw Error('Fixture predecessor changed');
    }
    const { expectedPlanDigest: _expected, ...published } = value;
    prepared.push(published); return plan(published);
  });
  const tipFor = (value: ResourceEngineeringAutonomousSetupOptions) => ({ enrollmentId: value.output === setup.output ? 'initial' : 'second',
    enrollmentDigest: 'b'.repeat(64), projectId: 'default', commit: (value.output === setup.output ? 'c' : 'd').repeat(40) });
  adapters.proof.mockImplementation(({ setup: value, proposalFeedback }: { setup: ResourceEngineeringAutonomousSetupOptions; proposalFeedback?: string }) => {
    expect(active).toBeUndefined(); const tip = tipFor(value);
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
  adapters.start.mockImplementation(async () => {
    expect(isOpen).toBe(false); isOpen = true;
    if (mode === 'restart-recovery' || mode === 'exhausted-recovery') {
      durableOwner = await createResourcePoolSupervisor({ root, pool, bindings, workspace, readObservations: () => observations, pollIntervalMs: 20 });
      const owned = durableOwner; cleanup.push(() => owned.close());
    }
    let attachment: { id: string; close(): Promise<void> } | null = null;
    return { url: 'http://127.0.0.1:1', consoleUrl: 'http://127.0.0.1:1', close: async () => { await durableOwner?.close(); isOpen = false; },
      engineeringAttachment: () => attachment, engineeringCustody: () => undefined,
      attachEngineering: async (options: { engineeringPreparationFile: string }) => {
        active = scopes.get(options.engineeringPreparationFile);
        attachment = { id: options.engineeringPreparationFile, close: async () => {
          if (active) drainReads.push(queueReads); active = undefined;
        } }; return attachment;
      },
      recoverTask: (body: Record<string, unknown>, lifetime: ResourceEngineeringLifetime) => {
        const { retainHistory: _retain, projectId: _project, ...submitted } = body;
        task = { ...submitted, schemaVersion: 1, cwd: workspace } as ResourceTask;
        if (durableOwner) {
          const job = durableOwner.recover(body as unknown as ResourceConsoleTaskInput, lifetime);
          task.id = job.id;
          if (crashOnce) { crashOnce = false; void durableOwner.close(); throw Error('Fixture owner lost after durable admission'); }
          return job;
        }
        proposalWork = runResourceTask({ root, pool, bindings, observations, task, signal: controller.signal });
        return { id: task.id };
      },
      cancelTaskAndDrain: async (id: string, expectedTaskDigest: string) => {
        if (durableOwner) await durableOwner.cancelAndDrain(id, expectedTaskDigest); else await proposalWork;
      } };
  });
  adapters.request.mockImplementation(async ({ path, body }: { path: string; body?: Record<string, unknown> }) => {
    if (path === '/api/resources/engineering-supervision') {
      queueReads++;
      return { configId: (active!.policy as typeof policy).id, sourceState: 'healthy', paused: false,
        deadlineAt: config.deadlineAt, entries: [{ enrollmentId: 'initial', state: 'completed' },
          ...(mode === 'stale-queue' && queueReads === 1 ? [] : [{ enrollmentId: 'child', state: 'completed' }])] };
    }
    if (path === '/api/resources/engineering-successors') return { supervisionId: (active!.policy as typeof policy).id,
      deadlineAt: config.deadlineAt, entries: [{ state: 'admitted', successorId: 'child' }] };
    if (path === '/api/resources/tasks') {
      const { retainHistory: _retain, projectId: _project, ...submitted } = body!;
      task = { ...submitted, schemaVersion: 1, cwd: workspace } as ResourceTask;
      const result = await runResourceTask({ root, pool, bindings, observations, task, signal: controller.signal });
      expect(result.receipt?.status).toBe('completed'); return {};
    }
    if (path === `/api/resources/tasks/${task?.id}`) {
      statusPaths.push(path);
      if (durableOwner) {
        const { jobs, ...supervisor } = durableOwner.snapshot();
        return { supervisor, job: jobs.find(row => row.id === task!.id) ?? null };
      }
      await proposalWork;
      // This endpoint intentionally has no job collection. Scope/setup evidence
      // above remains synthetic; proposal transport and accounting are real.
      const supervisor = { paused: proposalStatus === 'paused', closing: proposalStatus === 'closing',
        error: proposalStatus === 'error' ? 'supervisor-persistence-unavailable' : null };
      const state = proposalStatus === 'progress' ? ['queued', 'dispatching', 'settled'][Math.min(statusPaths.length - 1, 2)]
        : ['unresolved', 'cancelled', 'unknown'].includes(proposalStatus ?? '') ? proposalStatus : 'settled';
      return { supervisor, job: proposalStatus === 'missing' ? null : { id: proposalStatus === 'foreign' ? 'unrelated-human-task' : task!.id, state } };
    }
    if (path.endsWith('/history')) {
      resultRead = true;
      if (durableOwner) return durableOwner.history(task!.id);
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
      return { ...handle, cancelTaskAndDrain: async () => {
        await handle.cancelTaskAndDrain();
        if (resultRead) {
          const file = join(root, 'pool-state.json'); const state = JSON.parse(readFileSync(file, 'utf8'));
          state.attempts[0].outputDigest = '0'.repeat(64);
          writeFileSync(file, canonical(state) + '\n', { mode: 0o600 });
        }
      } };
    });
  }
  return { config, prepared, contexts, errors, controller, recipe, policy, allocation, drainReads, statusPaths,
    ownerSnapshot: () => durableOwner?.snapshot(),
    capacityStatus: () => resourcePoolStatus(root, pool, bindings, observations),
    ownerLockPresent: () => existsSync(join(root, '.resource-console.lock')),
    consoleState: () => JSON.parse(readFileSync(join(root, 'resource-console-state.json'), 'utf8')),
    status: () => resourcePoolStatus(root, pool, bindings, []), records: () => readEngineeringMissionRecords(config) };
}

describe('measured feedback through an accounted proposal into the next mission scope', () => {
  it('polls only the exact proposal identity through queued, dispatching and settled status without requiring all history', async () => {
    const f = await fixture('measured', 'progress');
    expect(await runResourceEngineeringMission(f.config)).toMatchObject({ state: 'completed', scopesReserved: 2 });
    const proposal = f.records().find(row => row.kind === 'proposal')!.payload as { task: ResourceTask };
    expect(f.statusPaths).toEqual(Array(3).fill(`/api/resources/tasks/${proposal.task.id}`));
    expect(adapters.request.mock.calls.map(([input]) => input.path)).not.toContain('/api/resources');
    expect(f.contexts).toHaveLength(1); expect(f.status().attempts).toHaveLength(1);
    expect(f.prepared).toHaveLength(2); expect(f.errors).toEqual([]);
  }, 30_000);
  it.each(['paused', 'closing', 'error', 'missing', 'foreign', 'unresolved', 'cancelled', 'unknown'] as const)(
    'holds a proposal on exact-task %s without consuming history or publishing the next scope', async status => {
      const f = await fixture('measured', status);
      const result = await runResourceEngineeringMission(f.config);
      expect(result).toMatchObject({ state: 'held', scopesReserved: 1, reason: ['paused', 'closing', 'error'].includes(status)
        ? 'mission-proposal-console-unavailable' : 'mission-proposal-unresolved' });
      const proposal = f.records().find(row => row.kind === 'proposal')!.payload as { task: ResourceTask };
      expect(f.statusPaths).toEqual([`/api/resources/tasks/${proposal.task.id}`]);
      const paths = adapters.request.mock.calls.map(([input]) => input.path as string);
      expect(paths).not.toContain('/api/resources'); expect(paths.some(path => path.endsWith('/history'))).toBe(false);
      expect(f.records().some(row => row.kind === 'result')).toBe(false);
      expect(f.prepared).toHaveLength(1); expect(f.contexts).toHaveLength(1);
      expect(f.status().attempts).toHaveLength(1); expect(f.errors).toEqual([]);
    }, 30_000);
  it('keeps an exhausted shared task window exhausted when a never-dispatched mission proposal is recovered', async () => {
    const f = await fixture('exhausted-recovery');
    const before = f.capacityStatus(), contexts = structuredClone(f.contexts), deadlineAt = f.config.deadlineAt;
    expect(before.attempts).toHaveLength(2); expect(contexts).toHaveLength(2);
    expect(before.attempts.every(row => row.status === 'completed')).toBe(true);
    expect(before.plan.candidates).toEqual([]);
    expect(before.plan.exclusions).toContainEqual(expect.objectContaining({ workerId: 'fixture', reasons: expect.arrayContaining(['operator-task-cap-reached']) }));
    expect(await runResourceEngineeringMission(f.config)).toMatchObject({ state: 'held', reason: 'shutdown-unresolved', scopesReserved: 1, deadlineAt });
    const originalRows = f.records(), intent = originalRows.find(row => row.kind === 'proposal')!;
    const abandoned = f.consoleState().jobs[0];
    expect(abandoned).toMatchObject({ state: 'queued', executionDeadlineAt: deadlineAt });
    expect(f.status().attempts).toEqual(before.attempts); expect(f.contexts).toEqual(contexts);
    expect(f.ownerLockPresent()).toBe(false);

    const stop = new AbortController();
    const running = runResourceEngineeringMission(f.config, { signal: stop.signal });
    try {
      // Unlike the synthetic completed scope above, this admission/recovery
      // uses the real durable supervisor and real shared-ledger task limit.
      await vi.waitFor(() => {
        expect(f.ownerSnapshot()).toMatchObject({ activeCount: 0, queuedCount: 1, error: null });
        const job = f.ownerSnapshot()!.jobs.find(row => row.id !== abandoned.id);
        expect(job).toMatchObject({ state: 'queued', reason: 'no-eligible-capacity', workerId: null, outcome: null });
      }, { timeout: 5000, interval: 20 });
      const jobs = f.consoleState().jobs;
      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({ id: abandoned.id, state: 'cancelled', reason: 'task-owner-unavailable', executionDeadlineAt: deadlineAt });
      expect(jobs[1]).toMatchObject({ recoveryOf: abandoned.id, state: 'queued', executionDeadlineAt: deadlineAt });
      expect(f.capacityStatus().plan.exclusions).toContainEqual(expect.objectContaining({ workerId: 'fixture', reasons: expect.arrayContaining(['operator-task-cap-reached']) }));
      expect(f.contexts).toEqual(contexts); expect(f.status().attempts).toEqual(before.attempts);
    } finally { stop.abort(); await running; }
    expect(await running).toMatchObject({ state: 'stopped', scopesReserved: 1, deadlineAt });
    expect(f.config.deadlineAt).toBe(deadlineAt); expect(f.ownerLockPresent()).toBe(false);
    expect(f.ownerSnapshot()).toMatchObject({ closing: true, activeCount: 0, queuedCount: 0 });
    expect(f.records().find(row => row.kind === 'proposal')).toEqual(intent);
    for (const row of originalRows) expect(f.records().find(current => current.id === row.id)).toEqual(row);
    expect(f.records().filter(row => row.kind === 'reserved')).toHaveLength(1);
    expect(f.records().some(row => row.kind === 'result' || row.kind === 'finished')).toBe(false);
    expect(f.prepared).toHaveLength(1); expect(f.contexts).toEqual(contexts); expect(f.errors).toEqual([]);
    expect(f.capacityStatus()).toMatchObject({ attempts: before.attempts, allocation: before.allocation,
      workerAccess: before.workerAccess, quotaScopeAccess: before.quotaScopeAccess });
  }, 15000);
  it('automatically recovers a crashed proposal owner and joins the replacement result on later restart', async () => {
    const f = await fixture('restart-recovery');
    expect(await runResourceEngineeringMission(f.config)).toMatchObject({ state: 'held', reason: 'shutdown-unresolved' });
    expect(f.contexts).toEqual([]); expect(f.status().attempts).toEqual([]);
    const before = f.records(); const intent = before.find(row => row.kind === 'proposal')!;
    expect(f.consoleState().jobs[0].state).toBe('queued');
    expect(await runResourceEngineeringMission(f.config)).toMatchObject({ state: 'completed', scopesReserved: 2, deadlineAt: f.config.deadlineAt });
    expect(f.records().find(row => row.kind === 'proposal')).toEqual(intent);
    const jobs = f.consoleState().jobs;
    expect(jobs).toHaveLength(2); expect(jobs[0]).toMatchObject({ state: 'cancelled', reason: 'task-owner-unavailable' });
    expect(jobs[1]).toMatchObject({ recoveryOf: jobs[0].id, state: 'settled', outcome: 'completed', executionDeadlineAt: f.config.deadlineAt });
    expect(f.status().attempts).toHaveLength(1); expect(f.status().attempts[0]!.id).toBe(jobs[1].id);
    expect(f.status().allocation).toEqual(f.allocation); expect(f.contexts).toHaveLength(1);
    const final = f.records();
    expect(await runResourceEngineeringMission(f.config)).toMatchObject({ state: 'completed', scopesReserved: 2 });
    expect(f.records()).toEqual(final); expect(f.contexts).toHaveLength(1); expect(f.errors).toEqual([]);
  }, 30_000);
  it.each(['measured', 'unknown', 'stale-queue'] as const)('retains %s evidence, uses the delivered seed, and never renews policy or repeats settled proposal transport', async mode => {
    const f = await fixture(mode);
    expect(await runResourceEngineeringMission(f.config)).toMatchObject({ state: 'completed', reason: 'scope-limit', scopesReserved: 2, deadlineAt: f.config.deadlineAt });
    expect(f.errors).toEqual([]); expect(f.contexts).toHaveLength(1);
    if (mode === 'stale-queue') expect(f.drainReads[0]).toBe(2);
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

/** Actual pinned registration, without starting a worker or evaluator. */
import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import { checkResourceEngineeringAutonomousSetup as check, prepareResourceEngineeringAutonomousSetup as prepare,
  type ResourceEngineeringAutonomousSetupPolicy } from '../src/core/resources/engineering-autonomous-setup.js';
import { validateResourceEngineeringAutonomousSetupPolicy } from '../src/core/resources/engineering-autonomous-setup.js';
import { createResourceEngineeringPreparationRegistry, readResourceEngineeringPreparationRegistrations,
  resourceEngineeringPreparationRegistrationRoot } from '../src/core/resources/engineering-preparation-registry.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import * as ownership from '../src/core/fleet/local-store-lock.js';
import * as bundle from '../src/core/resources/engineering-preparation.js';
import * as deliveredSource from '../src/core/resources/engineering-delivered-source.js';
import { setResourcePoolAllocation, readResourceJson, resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import * as runtime from '../src/core/resources/pool-runtime.js';
import type { ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { createResourceWorkspaceCustody, readResourceWorkspaceCustody } from '../src/core/resources/workspace-custody.js';
import { acquireResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { readEngineeringMissionProof } from '../src/core/resources/engineering-mission-proof.js';
import * as proofRpc from '../src/core/resources/engineering-worker-rpc.js';
import { prepareEngineeringMissionSetup } from '../src/core/resources/engineering-setup.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return;
    chmodSync(file, 0o700); for (const child of readdirSync(file)) writable(join(file, child)); };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
function fixture(endpoint = 'http://127.0.0.1:9/v1') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-core-'))); roots.push(base);
  const workspace = join(base, 'repo'); const transport = join(base, 'transport'); const ledger = join(base, 'ledger');
  for (const dir of [workspace, transport]) { mkdirSync(dir, { mode: 0o700 }); git(dir, 'init', '-q', '--template=', '--initial-branch=main'); }
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("must not execute during preparation");\n');
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const poolPath = join(base, 'pool.json'); const bindingsPath = join(base, 'bindings.json'); const observationsPath = join(base, 'observations.json');
  save(poolPath, { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
  save(bindingsPath, [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint }]);
  save(observationsPath, [{ workerId: 'worker', health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }]);
  const resourceRuntime = join(base, 'runtime.json'); save(resourceRuntime, { schemaVersion: 1, root: ledger, workspace: transport,
    poolPath, bindingsPath, observationsPath });
  const projectsFile = join(base, 'projects.json'); save(projectsFile, { schemaVersion: 1, projects: [] });
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'repair', name: 'Bounded repair', objective: 'Improve a measured value', projectId: 'default',
    seedRevision: git(workspace, 'rev-parse', 'HEAD'), metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
    trialBudget: { maxTrials: 2, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 5000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 20_000, maxModelRequests: 2, maxStagnantGenerations: 1, maxReportedTokens: null },
    generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'first', niche: 'value', hypothesis: 'First approach' }, { id: 'second', niche: 'value', hypothesis: 'Second approach' }] },
    delivery: { branch: 'codex/repair', allowInitialRepair: true }, execution: { maxDurationMs: 30_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
    supervision: { maxDurationMs: 60_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } };
  const policy: ResourceEngineeringAutonomousSetupPolicy = { schemaVersion: 1, id: 'fleet', profileId: 'fixed', label: 'Fixed evaluation',
    acceptance: 'Measured fixture only', maxEnrollments: 3, maxConcurrent: 1,
    successors: { allowedWorkerIds: ['worker'], maxOutputTokens: 128, proposalTimeoutMs: 5000, maxSuccessors: 2, pollIntervalMs: 1000 } };
  mkdirSync(ledger, { mode: 0o700 }); mkdirSync(join(base, 'bundle'), { mode: 0o700 });
  const pool = validateResourcePool(readResourceJson(poolPath));
  setResourcePoolAllocation(ledger, pool, validateResourceBindings(readResourceJson(bindingsPath), pool), 75, 0);
  return { base, ledger, observationsPath, policy, options: { recipe, policy, workspace, resourceRuntime, projectsFile, output: join(base, 'bundle') } };
}

function evidence(directory: string): string {
  const rows: unknown[] = [];
  function visit(file: string) { const stat = lstatSync(file); rows.push([file, stat.mode, stat.size, stat.mtimeMs,
    stat.isFile() ? readFileSync(file).toString('base64') : null]); if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name)); }
  visit(directory); return JSON.stringify(rows);
}
describe('offline autonomous setup', () => {
  it('refuses unavailable complete unresolved-query evidence without publishing setup', () => {
    const f = fixture(); const read = runtime.resourcePoolQueryStatus; const queried = vi.fn();
    vi.spyOn(runtime, 'resourcePoolQueryStatus').mockImplementation((...args) => {
      const status = read(...args);
      return { ...status, receipts: { ...status.receipts, unresolved(capacityKey?: string) {
        // Let the nested per-capacity readiness check finish; exercise setup's
        // own complete-set read, not its earlier preparation preflight.
        if (capacityKey !== undefined) return status.receipts.unresolved(capacityKey);
        queried(); throw new Error('Receipt query unavailable');
      } } };
    });
    const before = evidence(f.base);
    expect(() => check(f.options)).toThrow('Receipt query unavailable'); expect(queried).toHaveBeenCalled();
    expect(evidence(f.base)).toBe(before); expect(readdirSync(f.options.output)).toEqual([]);
  });
  it('creates and exactly replays an offline setup through the fixed worker', async () => {
    const f = fixture(); const plan = check(f.options);
    const request = { input: { ...f.options, expectedPlanDigest: plan.planDigest } };
    const host = { lifetime: { deadlineAt: new Date(Date.now() + 60_000).toISOString() } };
    const created = await prepareEngineeringMissionSetup(request, host);
    expect(created.disposition).toBe('created'); expect(created.providerContacted).toBe(false);
    const before = evidence(f.options.output);
    const replay = await prepareEngineeringMissionSetup(request, host);
    expect(replay.disposition).toBe('replayed'); expect(replay.initialEnrollmentDigest).toBe(created.initialEnrollmentDigest);
    expect(evidence(f.options.output)).toBe(before);
    for (const file of ['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock', '.resource-engineering-setup.lock']) {
      expect(existsSync(join(f.ledger, file))).toBe(false);
    }
  }, 60_000);
  it('refuses an uncompleted predecessor before creating the next setup', async () => {
    const f = fixture(); const plan = check(f.options); const before = evidence(f.options.output);
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    await expect(prepareEngineeringMissionSetup({ input: { ...f.options, expectedPlanDigest: plan.planDigest }, predecessor: {
      options: { setup: f.options, expectedPlanDigest: plan.planDigest, expectedDeadlineAt: deadlineAt },
      expectedTip: { enrollmentId: 'repair', enrollmentDigest: 'a'.repeat(64), projectId: 'default', commit: f.options.recipe.seedRevision },
    } }, { lifetime: { deadlineAt } })).rejects.toThrow('Engineering');
    expect(evidence(f.options.output)).toBe(before);
    expect(readResourceEngineeringPreparationRegistrations(f.ledger)).toEqual([]);
  }, 60_000);
  it('withholds a prepared result when an inner initialization lease remains owned', async () => {
    const f = fixture(); const plan = check(f.options);
    const file = join(plan.paths.initialBundle, 'universe', 'universes', f.options.recipe.id, '.run.lock');
    let retained: ownership.LocalStoreLock | null = null;
    const createHost = proofRpc.createEngineeringWorkerRpcHost;
    vi.spyOn(proofRpc, 'createEngineeringWorkerRpcHost').mockImplementation(options => createHost({ ...options,
      handlers: { ...options.handlers, 'setup.active': input => {
        if (!retained && existsSync(join(plan.paths.initialBundle, 'receipt.json'))) {
          retained = acquireLocalStoreLock(file, 0, { anchorPath: plan.paths.initialBundle, exactPrivateStorage: true });
          expect(retained).not.toBeNull();
        }
        return options.handlers['setup.active']!(input);
      } } }));
    try {
      await expect(prepareEngineeringMissionSetup({ input: { ...f.options, expectedPlanDigest: plan.planDigest } },
        { lifetime: { deadlineAt: new Date(Date.now() + 60_000).toISOString() } })).rejects.toThrow('setup-cleanup-unconfirmed');
      expect(retained).not.toBeNull(); expect(ownership.ownsLocalStoreLock(retained)).toBe(true);
      expect(existsSync(plan.paths.intent)).toBe(true);
      for (const name of ['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock']) expect(existsSync(join(f.ledger, name))).toBe(false);
    } finally { if (retained) expect(releaseLocalStoreLock(retained)).toBe(true); }
  }, 60_000);
  it('materializes in a worker while parent HTTP and real human task settlement remain responsive', async () => {
    const responses: ServerResponse[] = [];
    const server = createServer((req, res) => {
      if (req.url === '/health') { res.end('ready'); return; }
      req.resume(); req.on('end', () => responses.push(res));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing listener');
    const f = fixture(`http://127.0.0.1:${address.port}/v1`);
    const runtime = readResourceJson(f.options.resourceRuntime) as { poolPath: string; bindingsPath: string };
    const pool = validateResourcePool(readResourceJson(runtime.poolPath));
    const bindings = validateResourceBindings(readResourceJson(runtime.bindingsPath), pool);
    const supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.options.workspace, projects: [], pool, bindings,
      readObservations: () => readResourceJson(f.observationsPath) as ResourceObservation[] });
    const quota = await acquireResourceQuotaRefreshLease(f.ledger);
    const custody = createResourceWorkspaceCustody(supervisor, quota, () => {});
    let done = false, released = false, settledDuringSetup = false;
    const latencies: number[] = []; const errors: string[] = [];
    let probing: Promise<void> | undefined;
    try {
      supervisor.submit({ id: 'human-during-setup', prompt: 'Hold until materialization', mode: 'read-only', allowedWorkerIds: ['worker'], timeoutMs: 60_000, maxOutputTokens: 128 });
      await vi.waitFor(() => expect(responses).toHaveLength(1));
      const plan = check(f.options, custody);
      const preparation = prepareEngineeringMissionSetup({ input: { ...f.options, expectedPlanDigest: plan.planDigest } },
        { custody, lifetime: { deadlineAt: new Date(Date.now() + 60_000).toISOString() } }).finally(() => { done = true; });
      probing = (async () => {
        do {
          if (!released && existsSync(join(plan.paths.initialBundle, 'universe'))) {
            released = true;
            responses[0]!.end(JSON.stringify({ choices: [{ message: { content: 'Human work completed during setup' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
          }
          const start = performance.now();
          try {
            const response = await fetch(`http://127.0.0.1:${address.port}/health`, { signal: AbortSignal.timeout(1000) });
            if (response.status !== 200 || await response.text() !== 'ready') errors.push('health response');
          } catch { errors.push('health unavailable'); }
          latencies.push(performance.now() - start);
          if (!done && supervisor.snapshot().jobs.find(row => row.id === 'human-during-setup')?.outcome === 'completed') settledDuringSetup = true;
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (!done);
      })();
      const result = await preparation; await probing;
      expect(result.disposition).toBe('created'); expect(released).toBe(true); expect(settledDuringSetup).toBe(true);
      expect(errors).toEqual([]); expect(latencies.length).toBeGreaterThan(3); expect(Math.max(...latencies)).toBeLessThan(1000);
      expect(supervisor.snapshot().jobs.find(row => row.id === 'human-during-setup')?.outcome).toBe('completed');
      expect(resourcePoolStatus(f.ledger, pool, bindings, []).allocation.ceilingPercent).toBe(75);
      expect(readResourceWorkspaceCustody(custody).locks).toHaveLength(2);
      expect(existsSync(join(f.ledger, '.resource-engineering-setup.lock'))).toBe(false);
      expect(check(f.options, custody).initialEnrollmentDigest).toBe(result.initialEnrollmentDigest);
      console.log('MISSION_SETUP_WRITE_RESPONSIVENESS', JSON.stringify({ samples: latencies.length, maxMs: Math.max(...latencies), settledDuringSetup }));
    } finally {
      done = true; await probing;
      for (const response of responses) response.destroy(); quota.close(); await supervisor.close();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 120_000);
  it('cooperatively stops new setup after intent publication and preserves the workspace owner', async () => {
    const f = fixture(); const runtime = readResourceJson(f.options.resourceRuntime) as { poolPath: string; bindingsPath: string };
    const pool = validateResourcePool(readResourceJson(runtime.poolPath));
    const supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.options.workspace, projects: [], pool,
      bindings: validateResourceBindings(readResourceJson(runtime.bindingsPath), pool), readObservations: () => [] });
    const custody = createResourceWorkspaceCustody(supervisor, null, () => {}); const stop = new AbortController();
    const createHost = proofRpc.createEngineeringWorkerRpcHost; let stoppedAfterIntent = false;
    vi.spyOn(proofRpc, 'createEngineeringWorkerRpcHost').mockImplementation(options => createHost({ ...options,
      handlers: { ...options.handlers, 'setup.active': input => {
        if (existsSync(join(f.options.output, 'setup-intent.json'))) { stoppedAfterIntent = true; stop.abort(); }
        return options.handlers['setup.active']!(input);
      } } }));
    try {
      const plan = check(f.options, custody);
      await expect(prepareEngineeringMissionSetup({ input: { ...f.options, expectedPlanDigest: plan.planDigest } },
        { custody, lifetime: { deadlineAt: new Date(Date.now() + 60_000).toISOString(), signal: stop.signal } })).rejects.toThrow('Engineering');
      expect(stoppedAfterIntent).toBe(true); expect(existsSync(plan.paths.intent)).toBe(true); expect(existsSync(plan.paths.receipt)).toBe(false);
      expect(existsSync(join(f.ledger, '.resource-engineering-setup.lock'))).toBe(false);
      expect(existsSync(join(f.ledger, '.resource-quota-refresh.lock'))).toBe(false);
      expect(readResourceWorkspaceCustody(custody).locks).toHaveLength(1);
    } finally { await supervisor.close(); }
  }, 60_000);
  it.each(['released', 'retained', 'revoked'] as const)('samples live-owner ledger availability with %s transaction custody', async mode => {
    const f = fixture(); const runtime = readResourceJson(f.options.resourceRuntime) as { poolPath: string; bindingsPath: string };
    const pool = validateResourcePool(readResourceJson(runtime.poolPath));
    const supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.options.workspace, projects: [], pool,
      bindings: validateResourceBindings(readResourceJson(runtime.bindingsPath), pool), readObservations: () => [] });
    const custody = createResourceWorkspaceCustody(supervisor, null, () => {});
    let transaction: ownership.LocalStoreLock | null = null; let injected = false;
    const rpcHost = proofRpc.createEngineeringWorkerRpcHost;
    vi.spyOn(proofRpc, 'createEngineeringWorkerRpcHost').mockImplementation(options => {
      for (const invalid of [null, 0, -1, 1, 0.5, '1', { sampleId: 1, root: f.ledger }]) {
        expect(() => options.handlers['custody.poolAvailable']!(invalid)).toThrow('Mission proof');
      }
      const host = rpcHost(options);
      return { ...host, handle(message: unknown) {
        // Model the worker receiving its scope sample while the parent begins
        // a ledger transaction. The parent can answer its next message only
        // after the synchronous transaction releases its real lock.
        if (transaction && mode !== 'retained') { expect(releaseLocalStoreLock(transaction)).toBe(true); transaction = null; }
        if (mode === 'revoked' && (message as { method?: string })?.method === 'custody.poolAvailable') supervisor.setPaused(true);
        if (!injected && (message as { method?: string })?.method === 'custody.sample') {
          injected = true; transaction = acquireLocalStoreLock(join(f.ledger, '.pool.lock'), 0,
            { anchorPath: f.ledger, exactPrivateStorage: true });
          expect(transaction).not.toBeNull();
        }
        return host.handle(message);
      } };
    });
    try {
      const reading = readEngineeringMissionProof({ kind: 'setup', input: f.options },
        { custody, lifetime: { deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
      if (mode !== 'released') {
        await expect(reading).rejects.toThrow('Mission proof');
        expect(injected).toBe(true);
        if (mode === 'retained') expect(ownership.ownsLocalStoreLock(transaction)).toBe(true);
        else expect(supervisor.snapshot().paused).toBe(true);
        return;
      }
      const plan = await reading;
      expect(injected).toBe(true);
      expect(plan.holds).not.toContain('pool-ownership-present');
      expect(plan).toEqual(check(f.options, custody));
    } finally { if (transaction) releaseLocalStoreLock(transaction); await supervisor.close(); }
  });
  it.each(['append', 'pause'] as const)('handles %s between the worker read and live ownership sample without changing scope', async change => {
    const f = fixture(); const plan = check(f.options); prepare({ ...f.options, expectedPlanDigest: plan.planDigest });
    const runtime = readResourceJson(f.options.resourceRuntime) as { poolPath: string; bindingsPath: string };
    const pool = validateResourcePool(readResourceJson(runtime.poolPath));
    const supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.options.workspace, projects: [], pool,
      bindings: validateResourceBindings(readResourceJson(runtime.bindingsPath), pool), readObservations: () => [] });
    let appended = false; const createRpc = proofRpc.createEngineeringWorkerRpcHost;
    const captureRpc = vi.spyOn(proofRpc, 'createEngineeringWorkerRpcHost').mockImplementation(options => createRpc({ ...options,
      handlers: { ...options.handlers, 'custody.sample': input => {
        if (!appended) {
          appended = true;
          if (change === 'pause') supervisor.setPaused(true);
          else supervisor.submit({ id: 'human-new', prompt: 'Independent human queue append', mode: 'read-only', allowedWorkerIds: ['worker'], timeoutMs: 1000, maxOutputTokens: 128 });
        }
        return options.handlers['custody.sample']!(input);
      } } }));
    try {
      const custody = createResourceWorkspaceCustody(supervisor, null, () => {});
      const expected = check(f.options, custody);
      const reading = readEngineeringMissionProof({ kind: 'setup', input: f.options }, { custody,
        lifetime: { deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
      if (change === 'pause') await expect(reading).rejects.toThrow();
      else { expect(await reading).toEqual(expected); expect(supervisor.snapshot().jobs.find(row => row.id === 'human-new')?.state).toBe('queued'); }
      expect(appended).toBe(true); expect(supervisor.snapshot().paused).toBe(change === 'pause');
    } finally { captureRpc.mockRestore(); await supervisor.close(); }
  });
  it('joins a real actively owned human receipt across the proof worker boundary', async () => {
    let requests = 0;
    const transport = createServer((req, _res) => { req.resume(); req.on('end', () => { requests++; }); });
    await new Promise<void>(resolve => transport.listen(0, '127.0.0.1', resolve));
    const address = transport.address(); if (!address || typeof address === 'string') throw Error('Missing fixture transport');
    let supervisor: Awaited<ReturnType<typeof createResourcePoolSupervisor>> | undefined;
    try {
      const f = fixture(`http://127.0.0.1:${address.port}/v1`);
      const plan = check(f.options); prepare({ ...f.options, expectedPlanDigest: plan.planDigest });
      const runtime = readResourceJson(f.options.resourceRuntime) as { poolPath: string; bindingsPath: string };
      const pool = validateResourcePool(readResourceJson(runtime.poolPath));
      supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.options.workspace, projects: [], pool,
        bindings: validateResourceBindings(readResourceJson(runtime.bindingsPath), pool),
        readObservations: () => readResourceJson(f.observationsPath) as ResourceObservation[] });
      supervisor.submit({ id: 'human-active', prompt: 'Local fixture waits', mode: 'read-only', allowedWorkerIds: ['worker'],
        timeoutMs: 60_000, maxOutputTokens: 128 });
      await vi.waitFor(() => expect(requests).toBe(1));
      const custody = createResourceWorkspaceCustody(supervisor, null, () => {});
      const expected = check(f.options, custody);
      expect(await readEngineeringMissionProof({ kind: 'setup', input: f.options }, { custody,
        lifetime: { deadlineAt: new Date(Date.now() + 60_000).toISOString() } })).toEqual(expected);
      expect(supervisor.snapshot().jobs[0]!.state).toBe('dispatching');
    } finally {
      await supervisor?.close(); transport.closeAllConnections(); await new Promise<void>(resolve => transport.close(() => resolve()));
    }
  });
  it('accepts a human receipt that settles after the worker reads its reservation', async () => {
    let response: ServerResponse | undefined;
    const transport = createServer((req, res) => { req.resume(); req.on('end', () => { response = res; }); });
    await new Promise<void>(resolve => transport.listen(0, '127.0.0.1', resolve));
    const address = transport.address(); if (!address || typeof address === 'string') throw Error('Missing fixture transport');
    let supervisor: Awaited<ReturnType<typeof createResourcePoolSupervisor>> | undefined;
    let settling: Promise<void> | undefined;
    const createRpc = proofRpc.createEngineeringWorkerRpcHost;
    let delayed = false;
    const captureRpc = vi.spyOn(proofRpc, 'createEngineeringWorkerRpcHost').mockImplementation(options => {
      const host = createRpc(options);
      return { ...host, handle(message) {
        const request = message as { method?: string };
        if (!delayed && request.method === 'custody.receipt') {
          delayed = true;
          // Delay only transport delivery, not a host handler: settle a real
          // supervisor-owned task while the worker holds its earlier snapshot.
          settling = (async () => {
            try {
              response!.writeHead(200, { 'content-type': 'application/json' });
              response!.end(JSON.stringify({ choices: [{ message: { content: 'Human result' }, finish_reason: 'stop' }] }));
              await vi.waitFor(() => expect(supervisor!.snapshot().jobs[0]!.state).toBe('settled'));
            } finally { host.handle(message); }
          })();
          void settling.catch(() => {}); // The test awaits and reports it below.
          return true;
        }
        return host.handle(message);
      } };
    });
    try {
      const f = fixture(`http://127.0.0.1:${address.port}/v1`);
      const plan = check(f.options); prepare({ ...f.options, expectedPlanDigest: plan.planDigest });
      const runtime = readResourceJson(f.options.resourceRuntime) as { poolPath: string; bindingsPath: string };
      const pool = validateResourcePool(readResourceJson(runtime.poolPath));
      supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.options.workspace, projects: [], pool,
        bindings: validateResourceBindings(readResourceJson(runtime.bindingsPath), pool),
        readObservations: () => readResourceJson(f.observationsPath) as ResourceObservation[] });
      supervisor.submit({ id: 'human-settles', prompt: 'Local fixture completes', mode: 'read-only', allowedWorkerIds: ['worker'],
        timeoutMs: 60_000, maxOutputTokens: 128 });
      await vi.waitFor(() => expect(response).toBeDefined());
      const custody = createResourceWorkspaceCustody(supervisor, null, () => {});
      const actual = await readEngineeringMissionProof({ kind: 'setup', input: f.options }, { custody,
        lifetime: { deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
      await settling;
      expect(delayed).toBe(true);
      expect(actual).toEqual(check(f.options, custody));
      expect(actual.holds).not.toContain('resource-work-unresolved');
    } finally {
      captureRpc.mockRestore();
      try { await settling; } finally {
        await supervisor?.close();
        transport.closeAllConnections(); await new Promise<void>(resolve => transport.close(() => resolve()));
      }
    }
  });
  it('prepares on a genuine live workspace without draining queued human work or releasing borrowed locks', async () => {
    const f = fixture(); const runtime = readResourceJson(f.options.resourceRuntime) as { poolPath: string; bindingsPath: string };
    const pool = validateResourcePool(readResourceJson(runtime.poolPath));
    const supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.options.workspace, projects: [], pool,
      bindings: validateResourceBindings(readResourceJson(runtime.bindingsPath), pool), readObservations: () => [] });
    const quota = await acquireResourceQuotaRefreshLease(f.ledger);
    try {
      quota.markPending();
      supervisor.submit({ id: 'human', prompt: 'Retain this unrelated human task', mode: 'read-only', allowedWorkerIds: ['worker'], timeoutMs: 1000, maxOutputTokens: 128 });
      expect(() => check(f.options)).toThrow('stopped');
      const custody = createResourceWorkspaceCustody(supervisor, quota, () => {});
      const plan = check(f.options, custody);
      expect(plan.holds).not.toContain('ordinary-queued-work-retained');
      const result = prepare({ ...f.options, expectedPlanDigest: plan.planDigest }, { workspaceCustody: custody,
        beforePublication: locks => {
          expect(locks).toHaveLength(2); expect(locks.every(ownership.ownsLocalStoreLock)).toBe(true);
          expect(existsSync(join(f.ledger, '.resource-engineering-setup.lock'))).toBe(true);
          // Use the real ledger transaction, not just a filesystem absence
          // assertion: setup must not monopolize ordinary settlement's lock.
          const bindings = validateResourceBindings(readResourceJson(runtime.bindingsPath), pool);
          const revision = resourcePoolStatus(f.ledger, pool, bindings, []).allocation.revision;
          setResourcePoolAllocation(f.ledger, pool, bindings, 75, revision);
        } });
      expect(result.disposition).toBe('created');
      expect(existsSync(join(f.ledger, '.resource-engineering-setup.lock'))).toBe(false);
      expect(readResourceWorkspaceCustody(custody).metadataPending).toBe(true);
      expect(supervisor.snapshot().jobs.find(row => row.id === 'human')?.state).toBe('queued');
      expect(existsSync(join(f.ledger, '.pool.lock'))).toBe(false);
      expect(existsSync(join(f.ledger, '.resource-console.lock'))).toBe(true);
      expect(existsSync(join(f.ledger, '.resource-quota-refresh.lock'))).toBe(true);
      expect(check(f.options, custody).initialEnrollmentDigest).toBe(result.initialEnrollmentDigest);
      const nextSetupLease = acquireLocalStoreLock(join(f.ledger, '.resource-engineering-setup.lock'), 0,
        { anchorPath: f.ledger, exactPrivateStorage: true });
      expect(nextSetupLease).not.toBeNull();
      try {
        // A successor's preparation ownership must not invalidate the already
        // completed setup used by its historical predecessor check.
        const historical = check(f.options, custody);
        expect(historical.initialEnrollmentDigest).toBe(result.initialEnrollmentDigest);
        expect(historical.holds.some(reason => reason.endsWith('-ownership-present'))).toBe(false);
        expect(prepare({ ...f.options, expectedPlanDigest: plan.planDigest }, { workspaceCustody: custody }).disposition).toBe('replayed');
        expect(ownership.ownsLocalStoreLock(nextSetupLease)).toBe(true);
      } finally { releaseLocalStoreLock(nextSetupLease); }
      // Real proof worker reads the same files while live parent custody answers
      // only ownership questions. This does not delegate execution credentials.
      const lifetime = { deadlineAt: new Date(Date.now() + 60_000).toISOString() };
      const health = createServer((_req, res) => { res.writeHead(200); res.end('ready'); });
      await new Promise<void>(resolve => health.listen(0, '127.0.0.1', resolve));
      const address = health.address(); if (!address || typeof address === 'string') throw Error('Fixture listener missing');
      let reading = true; const latencies: number[] = []; const errors: string[] = [];
      const probing = (async () => {
        do {
          const start = performance.now();
          try {
            const response = await fetch(`http://127.0.0.1:${address.port}/health`, { signal: AbortSignal.timeout(1000) });
            if (response.status !== 200 || await response.text() !== 'ready') errors.push('health response');
          } catch { errors.push('health unavailable'); }
          latencies.push(performance.now() - start);
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (reading);
      })();
      try {
        const asyncPlan = await readEngineeringMissionProof({ kind: 'setup', input: f.options }, { custody, lifetime });
        reading = false; await probing;
        expect(asyncPlan).toEqual(check(f.options, custody));
        expect(errors).toEqual([]); expect(latencies.length).toBeGreaterThan(2); expect(Math.max(...latencies)).toBeLessThan(1000);
        console.log('MISSION_SETUP_READ_RESPONSIVENESS', JSON.stringify({ samples: latencies.length, maxMs: Math.max(...latencies) }));
        expect(supervisor.snapshot().jobs.find(row => row.id === 'human')?.state).toBe('queued');
      } finally {
        reading = false; await probing; health.closeAllConnections(); await new Promise<void>(resolve => health.close(() => resolve()));
      }
    } finally { quota.close(); await supervisor.close(); }
  });
  it.each(['publication-failure', 'pause', 'lease-loss', 'lease-replacement'] as const)('cleans up live setup after %s without releasing workspace ownership', async failure => {
    const f = fixture(); const runtime = readResourceJson(f.options.resourceRuntime) as { poolPath: string; bindingsPath: string };
    const pool = validateResourcePool(readResourceJson(runtime.poolPath));
    const supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.options.workspace, projects: [], pool,
      bindings: validateResourceBindings(readResourceJson(runtime.bindingsPath), pool), readObservations: () => [] });
    const custody = createResourceWorkspaceCustody(supervisor, null, () => {});
    const setupPath = join(f.ledger, '.resource-engineering-setup.lock');
    let setupLock: ownership.LocalStoreLock | undefined;
    let replacementLock: ownership.LocalStoreLock | null = null;
    const acquire = ownership.acquireLocalStoreLockWithOutcome;
    vi.spyOn(ownership, 'acquireLocalStoreLockWithOutcome').mockImplementation((...args) => {
      const result = acquire(...args);
      if (args[0] === setupPath && result.state === 'acquired') setupLock = result.lock;
      return result;
    });
    try {
      const expectedPlanDigest = check(f.options, custody).planDigest;
      const beforePublication = vi.fn((locks: readonly ownership.LocalStoreLock[]) => {
        expect(locks).toHaveLength(2); expect(locks.every(ownership.ownsLocalStoreLock)).toBe(true);
        if (failure === 'publication-failure') throw Error('fixture publication failure');
        if (failure === 'pause') supervisor.setPaused(true);
        if (failure === 'lease-loss' || failure === 'lease-replacement') expect(releaseLocalStoreLock(setupLock)).toBe(true);
        if (failure === 'lease-replacement') {
          replacementLock = acquireLocalStoreLock(setupPath, 0, { anchorPath: f.ledger, exactPrivateStorage: true });
          expect(replacementLock).not.toBeNull();
        }
      });
      const message = failure === 'publication-failure' ? 'fixture publication failure' : failure === 'pause' ?
        'Resource supervisor custody unavailable' : failure === 'lease-replacement' ? 'Setup ownership cleanup could not be confirmed' : 'Setup ownership changed';
      expect(() => prepare({ ...f.options, expectedPlanDigest }, { workspaceCustody: custody, beforePublication })).toThrow(message);
      expect(beforePublication).toHaveBeenCalled();
      expect(existsSync(join(f.options.output, 'setup-intent.json'))).toBe(true);
      expect(existsSync(join(f.options.output, 'setup-receipt.json'))).toBe(false);
      expect(existsSync(setupPath)).toBe(failure === 'lease-replacement');
      if (replacementLock) expect(ownership.ownsLocalStoreLock(replacementLock)).toBe(true);
      expect(supervisor.snapshot().paused).toBe(failure === 'pause');
      expect(existsSync(join(f.ledger, '.pool.lock'))).toBe(false);
      expect(existsSync(join(f.ledger, '.resource-quota-refresh.lock'))).toBe(false);
      expect(existsSync(join(f.ledger, '.resource-console.lock'))).toBe(true);
    } finally { if (replacementLock) releaseLocalStoreLock(replacementLock); await supervisor.close(); }
  });
  it('refuses a competing live setup lease without writing output or reclaiming ownership', async () => {
    const f = fixture(); const runtime = readResourceJson(f.options.resourceRuntime) as { poolPath: string; bindingsPath: string };
    const pool = validateResourcePool(readResourceJson(runtime.poolPath));
    const supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.options.workspace, projects: [], pool,
      bindings: validateResourceBindings(readResourceJson(runtime.bindingsPath), pool), readObservations: () => [] });
    const custody = createResourceWorkspaceCustody(supervisor, null, () => {});
    const expectedPlanDigest = check(f.options, custody).planDigest;
    const lock = acquireLocalStoreLock(join(f.ledger, '.resource-engineering-setup.lock'), 0, { anchorPath: f.ledger, exactPrivateStorage: true });
    expect(lock).not.toBeNull();
    try {
      const before = evidence(f.base);
      expect(() => prepare({ ...f.options, expectedPlanDigest }, { workspaceCustody: custody })).toThrow('Setup publication ownership unavailable');
      expect(evidence(f.base)).toBe(before);
      expect(ownership.ownsLocalStoreLock(lock)).toBe(true);
    } finally { releaseLocalStoreLock(lock); await supervisor.close(); }
  });
  it('refuses forged or revoked workspace custody before publishing a setup', async () => {
    const f = fixture(); const runtime = readResourceJson(f.options.resourceRuntime) as { poolPath: string; bindingsPath: string };
    const pool = validateResourcePool(readResourceJson(runtime.poolPath));
    const supervisor = await createResourcePoolSupervisor({ root: f.ledger, workspace: f.options.workspace, projects: [], pool,
      bindings: validateResourceBindings(readResourceJson(runtime.bindingsPath), pool), readObservations: () => [] });
    try {
      let stopped = false;
      const custody = createResourceWorkspaceCustody(supervisor, null, () => { if (stopped) throw Error('attachment replaced'); });
      const plan = check(f.options, custody);
      const lifetime = { deadlineAt: new Date(Date.now() + 60_000).toISOString() };
      await expect(readEngineeringMissionProof({ kind: 'setup', input: f.options }, { lifetime, custody: { ...custody } })).rejects.toThrow('Unrecognized');
      const running = readEngineeringMissionProof({ kind: 'setup', input: f.options }, { custody, lifetime });
      const rejected = expect(running).rejects.toThrow();
      stopped = true; await rejected;
      expect(() => prepare({ ...f.options, expectedPlanDigest: plan.planDigest }, { workspaceCustody: { ...custody } })).toThrow('Unrecognized');
      stopped = true;
      expect(() => prepare({ ...f.options, expectedPlanDigest: plan.planDigest }, { workspaceCustody: custody })).toThrow('attachment replaced');
      expect(readdirSync(f.options.output)).toEqual([]);
      expect(existsSync(join(f.ledger, '.pool.lock'))).toBe(false);
    } finally { await supervisor.close(); }
  });
  it('withholds new publication on a host veto without touching the setup or accounting', () => {
    const f = fixture(); const expectedPlanDigest = check(f.options).planDigest; const before = evidence(f.base);
    expect(() => prepare({ ...f.options, expectedPlanDigest }, { isExecutionStopped: () => true })).toThrow('Host setup publication stopped');
    expect(evidence(f.base)).toBe(before);
  });
  it('checks the host at owned registration publication and retains incomplete output after refusal', () => {
    const f = fixture(); const expectedPlanDigest = check(f.options).planDigest;
    const accounting = readFileSync(join(f.ledger, 'pool-state.json'));
    const beforePublication = vi.fn((locks: readonly ownership.LocalStoreLock[]) => {
      expect(locks).toHaveLength(3); expect(locks.every(lock => ownership.ownsLocalStoreLock(lock))).toBe(true);
      throw Error('host publication refused');
    });
    expect(() => prepare({ ...f.options, expectedPlanDigest }, { beforePublication })).toThrow('host publication refused');
    expect(beforePublication).toHaveBeenCalled(); expect(existsSync(join(f.options.output, 'setup-receipt.json'))).toBe(false);
    expect(readFileSync(join(f.ledger, 'pool-state.json'))).toEqual(accounting);
    expect(['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock'].some(name => existsSync(join(f.ledger, name)))).toBe(false);
  });
  it('prepares explicitly separate histories against one unchanged ledger and replays each original setup', () => {
    const f = fixture(); const accounting = readFileSync(join(f.ledger, 'pool-state.json'));
    f.policy.registrationScope = 'mission-first';
    const first = prepare({ ...f.options, expectedPlanDigest: check(f.options).planDigest });
    expect(first.paths.registration).toBe(join(resourceEngineeringPreparationRegistrationRoot(f.ledger, 'mission-first'), 'records', 'repair.json'));
    expect(readResourceJson(first.paths.profiles)).toHaveProperty('registrationScope', 'mission-first');
    const firstHistory = evidence(resourceEngineeringPreparationRegistrationRoot(f.ledger, 'mission-first'));
    const firstOutput = evidence(f.options.output);
    const output = join(f.base, 'next-bundle'); mkdirSync(output, { mode: 0o700 });
    const secondOptions = { ...f.options, output, policy: { ...f.policy, id: 'fleet-next', registrationScope: 'mission-next' },
      recipe: { ...f.options.recipe, id: 'repair-next', delivery: { ...f.options.recipe.delivery, branch: 'codex/repair-next' } } };
    const beforeCheck = evidence(f.base); const plan = check(secondOptions); expect(evidence(f.base)).toBe(beforeCheck);
    const second = prepare({ ...secondOptions, expectedPlanDigest: plan.planDigest });
    expect(second.initialEnrollmentDigest).not.toBe(first.initialEnrollmentDigest);
    expect(readResourceEngineeringPreparationRegistrations(f.ledger)).toEqual([]);
    expect(readResourceEngineeringPreparationRegistrations(f.ledger, 'mission-first').map(row => row.request.id)).toEqual(['repair']);
    expect(readResourceEngineeringPreparationRegistrations(f.ledger, 'mission-next').map(row => row.request.id)).toEqual(['repair-next']);
    expect(evidence(resourceEngineeringPreparationRegistrationRoot(f.ledger, 'mission-first'))).toBe(firstHistory);
    expect(evidence(f.options.output)).toBe(firstOutput);
    expect(readFileSync(join(f.ledger, 'pool-state.json'))).toEqual(accounting);
    const completed = evidence(f.base);
    expect(prepare({ ...f.options, expectedPlanDigest: first.planDigest }).disposition).toBe('replayed');
    expect(prepare({ ...secondOptions, expectedPlanDigest: second.planDigest }).disposition).toBe('replayed');
    expect(evidence(f.base)).toBe(completed);
    expect(() => check({ ...secondOptions, policy: { ...secondOptions.policy, registrationScope: 'mission-first' } })).toThrow();
    expect(evidence(f.base)).toBe(completed);
  }, 120_000);
  it.each(['', '../escape', 'UPPER', 'x'.repeat(65), null, false])('rejects invalid history scope %j before setup effects', registrationScope => {
    const f = fixture(); const before = evidence(f.base);
    expect(() => validateResourceEngineeringAutonomousSetupPolicy({ ...f.policy, registrationScope })).toThrow('Invalid autonomous setup');
    expect(evidence(f.base)).toBe(before);
  });
  it('does not use a new history scope to bypass unresolved shared collector ownership', () => {
    const f = fixture(); f.policy.registrationScope = 'mission-next';
    save(join(f.ledger, '.resource-quota-refresh-pending.json'), { unresolved: true });
    const before = evidence(f.base); expect(() => check(f.options)).toThrow(); expect(evidence(f.base)).toBe(before);
    expect(existsSync(resourceEngineeringPreparationRegistrationRoot(f.ledger, 'mission-next'))).toBe(false);
  });
  it('checks without effects, registers the exact manager row, and replays without any writes', () => {
    const sourceRead = vi.spyOn(deliveredSource, 'readResourceEngineeringDeliveredRegistration').mockImplementation(() => {
      throw new Error('Ordinary setup must not add delivered-source verification');
    });
    const f = fixture(); const before = evidence(f.base);
    const accounting = readFileSync(join(f.ledger, 'pool-state.json'), 'utf8');
    const plan = check(f.options);
    expect(plan).toMatchObject({ status: 'planned', initialEnrollmentDigest: null, executionStarted: false, providerContacted: false });
    expect(evidence(f.base)).toBe(before);
    const result = prepare({ ...f.options, expectedPlanDigest: plan.planDigest });
    expect(result).toMatchObject({ status: 'prepared', disposition: 'created', planDigest: plan.planDigest });
    expect(result.consoleArguments).toContain('--engineering-preparation'); expect(result.consoleArguments).not.toContain('--engineering');
    const registrations = readResourceEngineeringPreparationRegistrations(f.ledger);
    expect(registrations).toHaveLength(1); expect(registrations[0]).toMatchObject({ request: { id: 'repair', profileId: 'fixed' }, enrollmentDigest: result.initialEnrollmentDigest });
    const queue = JSON.parse(readFileSync(result.paths.supervision, 'utf8'));
    expect(queue).toMatchObject({ id: 'fleet', maxEnrollments: 3, enrollments: [{ enrollmentId: 'repair', expectedEnrollmentDigest: result.initialEnrollmentDigest }] });
    expect(readFileSync(join(f.ledger, 'pool-state.json'), 'utf8')).toBe(accounting);
    expect(existsSync(join(f.ledger, 'resource-console-state.json'))).toBe(false);
    expect(git(f.options.workspace, 'branch', '--list', 'codex/*')).toBe('');
    const completed = evidence(f.base);
    expect(check(f.options).initialEnrollmentDigest).toBe(result.initialEnrollmentDigest);
    expect(prepare({ ...f.options, expectedPlanDigest: plan.planDigest }).disposition).toBe('replayed');
    expect(evidence(f.base)).toBe(completed);
    expect(sourceRead).not.toHaveBeenCalled();
    const config = JSON.parse(readFileSync(result.paths.profiles, 'utf8'));
    const runtime = JSON.parse(readFileSync(f.options.resourceRuntime, 'utf8'));
    const registry = createResourceEngineeringPreparationRegistry({ config, configFile: result.paths.profiles, root: f.ledger, workspace: f.options.workspace,
      projectsFile: f.options.projectsFile, poolFile: runtime.poolPath, bindingsFile: runtime.bindingsPath, observationsFile: runtime.observationsPath });
    const request = registrations[0]!.request;
    expect(() => { registry.config.profiles[0]!.recipe.generation.files.push('unauthorized'); }).toThrow();
    expect(() => { registry.objective(request).recipe.generation.files.push('unauthorized'); }).toThrow();
    expect(() => { registry.materialize(request).plan.files.push('unauthorized'); }).toThrow();
    expect(registry.committed(registrations[0]!).catalog.enrollments[0]!.id).toBe('repair');
    expect(() => registry.publish({ ...registrations[0]!, configDigest: 'f'.repeat(64) }, () => {})).toThrow('context changed');
    expect(evidence(f.base)).toBe(completed);
    // Completed replay is inspection, even while the actual runtime owns every
    // admission fence. No acquisition/reclamation or lease-byte rewrite occurs.
    const held = ['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock'].map(name =>
      acquireLocalStoreLock(join(f.ledger, name), 0, { anchorPath: f.ledger, exactPrivateStorage: true }));
    const acquire = vi.spyOn(ownership, 'acquireLocalStoreLockWithOutcome').mockImplementation(() => { throw new Error('Replay attempted ownership'); });
    try {
      expect(held.every(Boolean)).toBe(true); const locked = evidence(f.base);
      expect(check(f.options).holds).toEqual(expect.arrayContaining(['console-ownership-present', 'pool-ownership-present', 'quota-ownership-present']));
      expect(prepare({ ...f.options, expectedPlanDigest: plan.planDigest })).toMatchObject({ disposition: 'replayed', initialEnrollmentDigest: result.initialEnrollmentDigest });
      expect(acquire).not.toHaveBeenCalled(); expect(evidence(f.base)).toBe(locked);
    } finally { acquire.mockRestore(); for (const lock of held.reverse()) expect(releaseLocalStoreLock(lock)).toBe(true); }
    // Exercise setup's own receipt/config join, not merely the nested bundle reader.
    for (const file of [result.paths.receipt, result.paths.profiles, result.paths.supervision, result.paths.successors]) {
      const original = readFileSync(file, 'utf8'); const value = JSON.parse(original);
      if (file === result.paths.receipt) value.registrationDigest = '0'.repeat(64);
      if (file === result.paths.profiles) value.profiles[0].acceptance += ' changed';
      if (file === result.paths.supervision) value.maxDurationMs++;
      if (file === result.paths.successors) value.maxOutputTokens++;
      save(file, value);
      try {
        const tampered = evidence(f.base);
        expect(() => check(f.options), file).toThrow();
        expect(() => prepare({ ...f.options, expectedPlanDigest: plan.planDigest }), file).toThrow();
        expect(evidence(f.base), file).toBe(tampered);
      } finally { writeFileSync(file, original); }
    }
    const restored = evidence(f.base);
    expect(check(f.options).initialEnrollmentDigest).toBe(result.initialEnrollmentDigest);
    expect(evidence(f.base)).toBe(restored);
  }, 120_000);
  it.each(['branch', 'capacity', 'worker', 'output'])('refuses known unsafe %s before creating output or registry', kind => {
    const f = fixture();
    if (kind === 'branch') f.options.recipe.delivery.branch = 'codex/other';
    if (kind === 'capacity') f.policy.successors.maxSuccessors = 3;
    if (kind === 'worker') f.policy.successors.allowedWorkerIds = ['foreign'];
    if (kind === 'output') save(join(f.options.output, 'unrelated.json'), {});
    const before = evidence(f.base); expect(() => check(f.options)).toThrow(); expect(evidence(f.base)).toBe(before);
  });
  it.each(['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock'])('does not reclaim existing %s ownership or write partial setup on known contention', name => {
    const f = fixture(); const lock = acquireLocalStoreLock(join(f.ledger, name), 0, { anchorPath: f.ledger, exactPrivateStorage: true });
    expect(lock).not.toBeNull();
    try { const before = evidence(f.base); expect(() => check(f.options)).toThrow('stopped'); expect(evidence(f.base)).toBe(before); }
    finally { releaseLocalStoreLock(lock); }
    expect(check(f.options).status).toBe('planned');
  });
  it.each(['missing-ledger', 'invalid-console', 'pending-quota'])('refuses %s without writing or repairing evidence', condition => {
    const f = fixture();
    if (condition === 'missing-ledger') rmSync(join(f.ledger, 'pool-state.json'));
    if (condition === 'invalid-console') save(join(f.ledger, 'resource-console-state.json'), { schemaVersion: 4, jobs: 'invalid' });
    if (condition === 'pending-quota') save(join(f.ledger, '.resource-quota-refresh-pending.json'), { unresolved: true });
    const before = evidence(f.base); expect(() => check(f.options)).toThrow(); expect(evidence(f.base)).toBe(before);
  });
  it('holds partial output after a failed local registration instead of adopting or repairing it', () => {
    const f = fixture(); const plan = check(f.options);
    const fault = vi.spyOn(bundle, 'prepareResourceEngineeringBundle').mockImplementation(() => { throw new Error('fixture interruption'); });
    expect(() => prepare({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow('fixture interruption');
    fault.mockRestore(); const partial = evidence(f.base);
    expect(existsSync(plan.paths.intent)).toBe(true); expect(existsSync(plan.paths.receipt)).toBe(false);
    expect(() => prepare({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow('Incomplete setup');
    expect(evidence(f.base)).toBe(partial);
  }, 60_000);
});

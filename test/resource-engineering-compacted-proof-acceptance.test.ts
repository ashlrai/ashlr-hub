/** Real proof worker and private archive I/O. Setup never runs the evaluator;
 * the sole model response is test-owned loopback data, not provider acceptance. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { createResourceWorkspaceCustody, readResourceWorkspaceCustody } from '../src/core/resources/workspace-custody.js';
import { readResourceJson, readResourcePoolHistory, resourcePoolStatus, setResourcePoolAllocation } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { compactResourceConsoleStorage, readResourceConsoleStorage, resourceConsoleArchiveRoot, resourceConsoleStorageProof } from '../src/core/resources/console-state-storage.js';
import { prepareResourceConsoleHistoryArchive } from '../src/core/resources/console-history-archive.js';
import { createResourceConsoleHistoryArchiveStore } from '../src/core/resources/console-history-archive-store.js';
import { createWorkspaceProofHandlers } from '../src/core/resources/workspace-proof-host.js';
import { matchesWorkspaceProofStorage, type ResourceWorkspaceProofSample } from '../src/core/resources/workspace-proof-context.js';
import { checkResourceEngineeringAutonomousSetup, type ResourceEngineeringAutonomousSetupOptions } from '../src/core/resources/engineering-autonomous-setup.js';
import { readEngineeringMissionProof } from '../src/core/resources/engineering-mission-proof.js';
import * as proofRpc from '../src/core/resources/engineering-worker-rpc.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
function save(path: string, value: unknown): void { writeFileSync(path, `${canonical(value)}\n`, { mode: 0o600 }); }
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'compacted-mission-proof-')));
  const root = join(base, 'ledger'), workspace = join(base, 'project'), transport = join(base, 'transport'), output = join(base, 'bundle');
  for (const path of [root, workspace, transport, output]) mkdirSync(path, { mode: 0o700 });
  for (const path of [workspace, transport]) git(path, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("Evaluator must not execute in read-only proof");\n');
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Proof Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed proof seed');
  let calls = 0;
  const server = createServer((req, res) => { req.resume(); req.on('end', () => {
    calls++; res.end(JSON.stringify({ choices: [{ message: { content: 'PRIVATE_ARCHIVED_ANSWER' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'proof', workers: [{ id: 'worker', provider: 'local', model: 'inert',
    maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const at = Date.now(); const observations: ResourceObservation[] = [{ workerId: 'worker', health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date(at - 100).toISOString(), expiresAt: new Date(at + 60_000).toISOString() }];
  const poolPath = join(base, 'pool.json'), bindingsPath = join(base, 'bindings.json'), observationsPath = join(base, 'observations.json');
  save(poolPath, pool); save(bindingsPath, bindings); save(observationsPath, observations);
  const resourceRuntime = join(base, 'runtime.json'), projectsFile = join(base, 'projects.json');
  save(resourceRuntime, { schemaVersion: 1, root, workspace: transport, poolPath, bindingsPath, observationsPath });
  save(projectsFile, { schemaVersion: 1, projects: [] }); setResourcePoolAllocation(root, pool, bindings, 75, 0);
  const options: ResourceEngineeringAutonomousSetupOptions = { workspace, output, resourceRuntime, projectsFile,
    recipe: { schemaVersion: 1, id: 'repair', name: 'Bounded repair', objective: 'Improve measured value', projectId: 'default',
      seedRevision: git(workspace, 'rev-parse', 'HEAD'), metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
      trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 5000 },
      campaignBudget: { maxGenerations: 1, maxDurationMs: 20_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null },
      generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
        hypotheses: [{ id: 'first', niche: 'value', hypothesis: 'First approach' }] },
      delivery: { branch: 'codex/repair', allowInitialRepair: true },
      execution: { maxDurationMs: 30_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
      supervision: { maxDurationMs: 60_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } },
    policy: { schemaVersion: 1, id: 'fleet', profileId: 'fixed', label: 'Fixed evaluation', acceptance: 'Measured fixture only',
      maxEnrollments: 2, maxConcurrent: 1, successors: { allowedWorkerIds: ['worker'], maxOutputTokens: 128,
        proposalTimeoutMs: 5000, maxSuccessors: 1, pollIntervalMs: 1000 } } };
  const owners: ResourcePoolSupervisor[] = []; const closedAfterExpectedDamage = new Set<ResourcePoolSupervisor>();
  cleanups.push(async () => {
    try { for (const owner of owners) if (!closedAfterExpectedDamage.has(owner)) await owner.close(); }
    finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(base, { recursive: true, force: true }); }
  });
  const start = async () => {
    const owner = await createResourcePoolSupervisor({ root, workspace, projects: [], pool, bindings,
      readObservations: () => observations, pollIntervalMs: 20 }); owners.push(owner); return owner;
  };
  const first = await start(); first.submit({ id: 'human', prompt: 'PRIVATE_ARCHIVED_REQUEST', allowedWorkerIds: ['worker'],
    mode: 'read-only', timeoutMs: 5000, maxOutputTokens: 128, retainHistory: true });
  await vi.waitFor(() => expect(first.snapshot().jobs[0]).toMatchObject({ state: 'settled', outcome: 'completed' }));
  const receipt = structuredClone(resourcePoolStatus(root, pool, bindings, observations).attempts[0]!);
  await first.close();
  const statePath = join(root, 'resource-console-state.json');
  const storageOptions = { root, workspace, pool, bindings, configHistory: readResourcePoolHistory(root, pool, bindings) };
  const before = readResourceConsoleStorage(readResourceJson(statePath), storageOptions);
  // Test-seeded representation of an already settled real receipt, while no
  // owner is live. Actual257 admission is covered by compaction acceptance.
  const compacted = compactResourceConsoleStorage(before, ['human'], storageOptions, () => {});
  save(statePath, compacted.source);
  const owner = await start(); const custody = createResourceWorkspaceCustody(owner, null, () => {});
  const read = () => readResourceConsoleStorage(readResourceJson(statePath), storageOptions);
  const proof = () => readEngineeringMissionProof({ kind: 'setup', input: options }, { custody,
    lifetime: { deadlineAt: new Date(Date.now() + 30_000).toISOString() } });
  const archiveRoot = resourceConsoleArchiveRoot(root);
  const archive = () => createResourceConsoleHistoryArchiveStore({ root: archiveRoot, scopeDigest: read().hotState.scopeDigest });
  const closeAfterArchiveDamage = async () => {
    await expect(owner.close()).rejects.toThrow('Resource supervisor closed with unresolved evidence');
    expect(existsSync(join(root, '.resource-console.lock'))).toBe(false);
    closedAfterExpectedDamage.add(owner);
  };
  return { base, root, owner, custody, receipt, read, proof, options, storageOptions, statePath, archiveRoot, archive, closeAfterArchiveDamage, calls: () => calls,
    recordId: compacted.archivedRecords.get('human')! };
}

describe.skipIf(process.platform === 'win32')('compacted mission proof acceptance', () => {
  it('reads setup through the real fixed worker and separately proves genuine host ownership of an archived receipt', async () => {
    const f = await fixture(); const expected = checkResourceEngineeringAutonomousSetup(f.options, f.custody);
    const ledger = readFileSync(join(f.root, 'pool-state.json')); const state = readFileSync(f.statePath);
    const handlers = createWorkspaceProofHandlers(f.custody, () => { readResourceWorkspaceCustody(f.custody); });
    try {
      const sample = handlers.handlers['custody.sample'](null);
      expect(sample.consoleStorageScopeDigest).toMatch(/^[a-f0-9]{64}$/);
      // Setup inspects reserved receipts only. This explicit host-handler check
      // is distinct evidence for the already-completed archived receipt.
      expect(handlers.handlers['custody.receipt']({ sampleId: sample.sampleId, receipt: f.receipt })).toBe(true);
      expect(handlers.handlers['custody.receipt']({ sampleId: sample.sampleId, receipt: { ...f.receipt, taskDigest: digest('foreign') } })).toBe(false);
      expect(await f.proof()).toEqual(expected);
      expect(expected).toMatchObject({ status: 'planned', executionStarted: false, providerContacted: false });
      expect(f.owner.snapshot().jobs).toHaveLength(1); expect(f.read().hotState.jobs).toHaveLength(0);
      expect(readFileSync(f.statePath)).toEqual(state); expect(readFileSync(join(f.root, 'pool-state.json'))).toEqual(ledger);
      expect(readdirSync(f.options.output)).toEqual([]); expect(f.calls()).toBe(1);
    } finally { handlers.close(); }
  }, 30_000);

  it.each(['append', 'pause'] as const)('handles real %s between worker source capture and custody sample', async change => {
    const f = await fixture(); const expected = checkResourceEngineeringAutonomousSetup(f.options, f.custody);
    const createRpc = proofRpc.createEngineeringWorkerRpcHost; let injected = false;
    vi.spyOn(proofRpc, 'createEngineeringWorkerRpcHost').mockImplementation(options => createRpc({ ...options,
      handlers: { ...options.handlers, 'custody.sample': input => {
        if (!injected) {
          injected = true;
          if (change === 'pause') f.owner.setPaused(true);
          else {
            f.owner.submit({ id: 'ordinary-new', prompt: 'Non-dispatching independent fixture work', allowedWorkerIds: ['worker'],
              mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 128 });
            f.owner.cancel('ordinary-new');
          }
        }
        return options.handlers['custody.sample']!(input);
      } } }));
    if (change === 'pause') await expect(f.proof()).rejects.toThrow();
    else { expect(await f.proof()).toEqual(expected); expect(f.owner.snapshot().jobs.find(row => row.id === 'ordinary-new')?.state).toBe('cancelled'); }
    expect(injected).toBe(true); expect(f.calls()).toBe(1);
  }, 30_000);

  it.each(['metadata', 'text'] as const)('refuses missing required archive %s instead of returning a setup proof', async part => {
    const f = await fixture(); const createRpc = proofRpc.createEngineeringWorkerRpcHost; let injected = false;
    vi.spyOn(proofRpc, 'createEngineeringWorkerRpcHost').mockImplementation(options => createRpc({ ...options,
      handlers: { ...options.handlers, 'custody.sample': input => {
        const sample = options.handlers['custody.sample']!(input);
        if (!injected) {
          injected = true;
          const path = part === 'metadata' ? join(f.archiveRoot, 'metadata', 'records', `${f.recordId}.json`)
            : join(f.archiveRoot, 'texts', `${digest(canonical({ scopeDigest: f.read().hotState.scopeDigest, jobId: 'human' }))}.json`);
          unlinkSync(path);
        }
        return sample;
      } } }));
    await expect(f.proof()).rejects.toThrow(); expect(injected).toBe(true); expect(f.calls()).toBe(1);
    expect(readdirSync(f.options.output)).toEqual([]);
    await f.closeAfterArchiveDamage();
  }, 30_000);

  it('binds header and archive scope even when the exact raw descriptor digest matches a supplied sample', async () => {
    const f = await fixture(); const view = f.read(); const proof = resourceConsoleStorageProof(view);
    const sample: ResourceWorkspaceProofSample = { root: f.root, workspace: f.options.workspace, poolDigest: f.receipt.poolDigest,
      stateDigest: proof.sourceDigest, consoleStorageScopeDigest: proof.scopeDigest,
      lockPaths: [], metadataPending: false, ownsReceipt: () => false, isPoolAvailable: () => true };
    expect(proof.requiresStorageProof).toBe(true); expect(matchesWorkspaceProofStorage(sample, view)).toBe(true);
    expect(matchesWorkspaceProofStorage({ ...sample, consoleStorageScopeDigest: digest('wrong') }, view)).toBe(false);
    const { consoleStorageScopeDigest: _scope, ...legacy } = sample;
    expect(matchesWorkspaceProofStorage(legacy, view)).toBe(false);
    const original = readResourceJson(f.statePath) as { console: Record<string, unknown> };
    for (const mutation of [{ paused: true }, { scopeDigest: digest('foreign') }, { originPoolDigest: digest('foreign') }]) {
      const changed = structuredClone(original); Object.assign(changed.console, mutation);
      let accepted = false;
      try { accepted = matchesWorkspaceProofStorage(sample, readResourceConsoleStorage(changed, f.storageOptions)); } catch { /* Invalid header is also refusal. */ }
      expect(accepted).toBe(false);
    }
  }, 30_000);

  it('binds a durable deletion overlay for a still-hot row without rewriting the original root', async () => {
    const f = await fixture(); f.owner.setPaused(true);
    f.owner.submit({ id: 'hot-retained', prompt: 'PRIVATE_HOT_OVERLAY', allowedWorkerIds: ['worker'], mode: 'read-only',
      timeoutMs: 1000, maxOutputTokens: 128, retainHistory: true }); f.owner.cancel('hot-retained'); await f.owner.close();
    const original = readFileSync(f.statePath); const hot = f.read().hotState;
    const entry = prepareResourceConsoleHistoryArchive(hot, f.storageOptions, ['hot-retained']).entries[0]!;
    const store = f.archive(); store.stage(entry);
    const before = resourceConsoleStorageProof(f.read());
    store.deleteTaskText('hot-retained', entry.record.job.taskDigest);
    const afterView = f.read(); const after = resourceConsoleStorageProof(afterView);
    expect(after.sourceDigest).toBe(before.sourceDigest); expect(after.scopeDigest).not.toBe(before.scopeDigest);
    expect(after.identityDigest).not.toBe(before.identityDigest); expect(after.requiresStorageProof).toBe(true);
    expect(afterView.getJob('hot-retained')).toMatchObject({ retainHistory: true, history: null });
    expect(readFileSync(f.statePath)).toEqual(original); expect(original.toString()).toContain('PRIVATE_HOT_OVERLAY');
    expect(f.calls()).toBe(1); expect(existsSync(join(f.options.output, 'setup-receipt.json'))).toBe(false);
  }, 30_000);
});

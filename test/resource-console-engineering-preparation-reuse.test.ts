/** Real private Git and stores, with observing spies on the existing preparation APIs. No evaluator,
 * native client, account, or worker is invoked. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourceConsoleEngineeringPreparation } from '../src/core/resources/console-engineering-preparation.js';
import type { ResourceConsoleEngineeringPreparationConfig } from '../src/core/resources/console-engineering-preparation-types.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { createResourceConsoleEngineeringOwner, type ResourceConsoleEngineeringOwner } from '../src/core/resources/console-engineering.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import * as preparation from '../src/core/resources/engineering-preparation.js';
import * as artifacts from '../src/core/universe/artifacts.js';
import * as campaigns from '../src/core/universe/campaign-store.js';
import * as deliveryRecovery from '../src/core/universe/campaign-delivery-recovery.js';
import type { UniverseDeliveryReceipt } from '../src/core/universe/delivery.js';

const roots: string[] = []; const owners: ResourceConsoleEngineeringOwner[] = []; const supervisors: ResourcePoolSupervisor[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(owners.splice(0).map(owner => owner.close()));
  await Promise.allSettled(supervisors.splice(0).map(owner => owner.close()));
  const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return; chmodSync(file, 0o700); for (const name of readdirSync(file)) writable(join(file, name)); };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
function tree(file: string): unknown {
  const stat = lstatSync(file, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isFile() ? digest(readFileSync(file)) : Object.fromEntries(readdirSync(file).sort().map(name => [name, tree(join(file, name))])) };
}
const request = { id: 'objective', profileId: 'pinned', name: 'Measured improvement', objective: 'Increase the value within the fixed checks.' };
async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'console-preparation-reuse-'))); roots.push(base);
  const workspace = join(base, 'repo'); const transport = join(base, 'transport'); const outputRoot = join(base, 'prepared'); const root = join(base, 'ledger');
  mkdirSync(outputRoot, { mode: 0o700 });
  for (const path of [workspace, transport]) { mkdirSync(path, { mode: 0o700 }); git(path, 'init', '-q', '--template=', '--initial-branch=main'); }
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("Preparation must not execute evaluator");\n');
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const poolFile = join(base, 'pool.json'); const bindingsFile = join(base, 'bindings.json'); const observationsFile = join(base, 'observations.json');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }], pool);
  save(poolFile, pool); save(bindingsFile, bindings); save(observationsFile, []);
  const resourceRuntime = join(base, 'runtime.json'); const runtime = { schemaVersion: 1, root, workspace: transport,
    poolPath: poolFile, bindingsPath: bindingsFile, observationsPath: observationsFile }; save(resourceRuntime, runtime);
  const projectsFile = join(base, 'projects.json'); save(projectsFile, { schemaVersion: 1, projects: [] });
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'template', name: 'Pinned template', objective: 'Fixed template objective', projectId: 'default',
    seedRevision: git(workspace, 'rev-parse', 'HEAD'), metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 5000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 20_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null },
    generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
      hypotheses: [{ id: 'repair', niche: 'value', hypothesis: 'Improve value' }] }, delivery: { branch: 'codex/template', allowInitialRepair: true },
    execution: { maxDurationMs: 30_000, constitutionVersion: 'fixture', policyEpoch: 1 },
    supervision: { maxDurationMs: 60_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } };
  const config: ResourceConsoleEngineeringPreparationConfig = { schemaVersion: 1, outputRoot, resourceRuntime,
    profiles: [{ id: 'pinned', label: 'Fixed checks', acceptance: 'Only value may change; fixed evaluator applies.', recipe }] };
  const configFile = join(base, 'preparation.json'); save(configFile, config);
  const supervisor = await createResourcePoolSupervisor({ root, pool, bindings, workspace, projects: [], readObservations: () => [], pollIntervalMs: 60_000 });
  supervisors.push(supervisor);
  const ownerOptions = { root, poolFile, bindingsFile, observationsFile, supervisor, registrationEnabled: true as const };
  const newOwner = () => { const owner = createResourceConsoleEngineeringOwner(ownerOptions); owners.push(owner); return owner; };
  const owner = newOwner();
  const options = { configFile, config, root, workspace, projectsFile, poolFile, bindingsFile, observationsFile, owner };
  const create = () => createResourceConsoleEngineeringPreparation(options);
  return { base, root, workspace, outputRoot, runtime, resourceRuntime, recipe, config, configFile, options, owner, newOwner, create,
    bundle: join(outputRoot, request.id) };
}

describe('call-local console preparation validation reuse', () => {
  it('omits malformed complete source while preserving BOM and truthful prefix truncation in successor evidence', async () => {
    // Real registration and fresh bundle validation; controlled delivery/run witnesses isolate
    // evidence formatting here. This does not assert evaluator or delivery-proof correctness.
    const f = await fixture();
    const originalSnapshot = f.owner.snapshot.bind(f.owner);
    vi.spyOn(f.owner, 'snapshot').mockImplementation(id => ({ ...originalSnapshot(id), state: 'completed' }));
    const manager = f.create(); const plan = manager.check(request);
    const prepared = manager.prepare({ ...request, expectedPlanDigest: plan.planDigest });
    const universeRoot = join(f.bundle, 'universe');
    const campaign = campaigns.readUniverseCampaign(request.id, { root: universeRoot });
    const universe = campaigns.campaignUniverse(campaign, { root: universeRoot });
    const artifactPath = join(f.base, 'controlled-artifact'); const artifactDigest = 'a'.repeat(64);
    const receipt: UniverseDeliveryReceipt = { schemaVersion: 1, id: 'delivery', universeId: universe.manifest.id,
      trialId: 'trial', runId: 'run', niche: 'value', manifestDigest: campaign.manifestDigest,
      comparatorDigest: campaign.comparatorDigest, artifactDigest, repo: f.workspace, branch: 'codex/objective',
      baseCommit: f.recipe.seedRevision, commit: 'b'.repeat(40), tree: 'c'.repeat(40), changedFiles: ['value.json'],
      status: 'delivered', createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z' };
    vi.spyOn(deliveryRecovery, 'readCompletedCampaignDelivery').mockReturnValue(receipt);
    vi.spyOn(campaigns, 'campaignUniverse').mockReturnValue({ ...universe, runs: [{ id: 'run', universeId: universe.manifest.id,
      generation: 1, manifestDigest: campaign.manifestDigest, comparatorDigest: campaign.comparatorDigest,
      startedAt: receipt.createdAt, finishedAt: receipt.completedAt, status: 'completed', durationMs: 1000, tokensUsed: null, costUsd: null,
      trials: [{ id: 'trial', variantId: 'repair', niche: 'value', parentTrialId: null, status: 'passed', score: 2, metrics: {},
        artifact: { path: artifactPath, digest: artifactDigest, revision: receipt.commit }, durationMs: 1000, delta: 1, selected: true }] }] });
    let sourceBytes = Buffer.from([0x61, 0xe2, 0x82]);
    const originalArtifact = artifacts.readArtifactSnapshot;
    vi.spyOn(artifacts, 'readArtifactSnapshot').mockImplementation(path => path === artifactPath ? { digest: artifactDigest,
      entries: [{ path: 'value.json', data: sourceBytes, executable: false },
        { path: 'evaluate.mjs', data: Buffer.from('\ufeffvalid\r\n'), executable: false }] } : originalArtifact(path));
    const before = tree(f.base);
    const context = () => {
      const source = manager.successorSource(request.id, prepared.enrollment.enrollmentDigest);
      expect(source).not.toBeNull();
      return JSON.parse(source!.context) as { files: Array<{ path: string; text: string; truncated: boolean }>; omittedFiles: number };
    };
    expect(context()).toMatchObject({ files: [{ path: 'evaluate.mjs', text: '\ufeffvalid\r\n', truncated: false }], omittedFiles: 1 });
    sourceBytes = Buffer.from('a'.repeat(1599) + '💡tail');
    expect(context()).toMatchObject({ files: [{ path: 'value.json', text: 'a'.repeat(1599), truncated: true },
      { path: 'evaluate.mjs', text: '\ufeffvalid\r\n', truncated: false }], omittedFiles: 0 });
    sourceBytes = Buffer.from('binary\0source');
    expect(context()).toMatchObject({ files: [{ path: 'evaluate.mjs', text: '\ufeffvalid\r\n', truncated: false }], omittedFiles: 1 });
    expect(tree(f.base)).toEqual(before); expect(originalSnapshot(request.id).launched).toBe(false);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  });

  it('checks and replays an existing objective using one fresh committed read per call without writes', async () => {
    const f = await fixture(); const manager = f.create(); const plan = manager.check(request);
    const prepared = manager.prepare({ ...request, expectedPlanDigest: plan.planDigest });
    const check = vi.spyOn(preparation, 'checkResourceEngineeringPreparation');
    const read = vi.spyOn(preparation, 'readPreparedResourceEngineeringBundle');
    const create = vi.spyOn(preparation, 'prepareResourceEngineeringBundle');
    const before = tree(f.base);
    expect(manager.check(request)).toEqual(plan);
    expect(check).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
    expect(manager.prepare({ ...request, expectedPlanDigest: plan.planDigest })).toEqual({ ...prepared, disposition: 'replayed' });
    expect(check).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(2); expect(create).not.toHaveBeenCalled();
    expect(tree(f.base)).toEqual(before); expect(f.owner.snapshot(request.id).launched).toBe(false);
    expect(existsSync(join(f.root, 'pool-state.json'))).toBe(false);
  });

  it('restores two registrations with one fresh committed read each and still checks the startup profile', async () => {
    const f = await fixture(); const manager = f.create();
    for (const id of ['first', 'second']) {
      const objective = { ...request, id }; const plan = manager.check(objective);
      manager.prepare({ ...objective, expectedPlanDigest: plan.planDigest });
    }
    const check = vi.spyOn(preparation, 'checkResourceEngineeringPreparation');
    const read = vi.spyOn(preparation, 'readPreparedResourceEngineeringBundle');
    const before = tree(f.base); const owner = f.newOwner();
    createResourceConsoleEngineeringPreparation({ ...f.options, owner });
    expect(check).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(2);
    expect(owner.catalog()).toEqual(f.owner.catalog()); expect(tree(f.base)).toEqual(before);
  });

  it('rejects changed incoming identity fields even when the saved bundle and reviewed digest remain valid', async () => {
    const f = await fixture();
    f.config.profiles.push({ ...f.config.profiles[0]!, id: 'other' }); save(f.configFile, f.config);
    const manager = f.create(); const plan = manager.check(request);
    manager.prepare({ ...request, expectedPlanDigest: plan.planDigest }); const before = tree(f.base);
    for (const changed of [{ ...request, name: 'Changed name' }, { ...request, objective: 'Changed objective' }, { ...request, profileId: 'other' }]) {
      expect(() => manager.check(changed)).toThrow();
      expect(() => manager.prepare({ ...changed, expectedPlanDigest: plan.planDigest })).toThrow();
    }
    expect(() => manager.prepare({ ...request, expectedPlanDigest: '0'.repeat(64) })).toThrow();
    expect(tree(f.base)).toEqual(before); expect(f.owner.catalog()).toHaveLength(1);
  });

  it('never reuses a successful committed read across calls after bundle evidence is removed', async () => {
    const f = await fixture(); const manager = f.create(); const plan = manager.check(request);
    manager.prepare({ ...request, expectedPlanDigest: plan.planDigest }); expect(manager.check(request)).toEqual(plan);
    unlinkSync(join(f.bundle, 'receipt.json')); const before = tree(f.base);
    expect(() => manager.check(request)).toThrow('Incomplete preparation');
    expect(() => manager.prepare({ ...request, expectedPlanDigest: plan.planDigest })).toThrow('Incomplete preparation');
    expect(tree(f.base)).toEqual(before); expect(f.owner.snapshot(request.id).launched).toBe(false);
  });
});

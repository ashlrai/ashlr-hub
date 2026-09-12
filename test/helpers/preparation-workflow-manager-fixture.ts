/** Trusted setup of real registrations, never candidate execution or provider work. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../../src/core/universe/artifacts.js';
import { createResourceConsoleEngineeringPreparation } from '../../src/core/resources/console-engineering-preparation.js';
import type { ResourceConsoleEngineeringPreparationConfig } from '../../src/core/resources/console-engineering-preparation-types.js';
import { createResourceConsoleEngineeringOwner } from '../../src/core/resources/console-engineering.js';
import { createResourcePoolSupervisor } from '../../src/core/resources/pool-supervisor.js';
import { validateResourcePool } from '../../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../../src/core/resources/worker.js';
import { createResourceEngineeringPreparationRegistry } from '../../src/core/resources/engineering-preparation-registry.js';

export async function preparationManagerFixture(base: string) {
  const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
  const workspace = join(base, 'repo'), transport = join(base, 'transport'), root = join(base, 'ledger');
  const outputRoot = join(base, 'prepared'); mkdirSync(outputRoot, { mode: 0o700 });
  const git = (repo: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
  for (const directory of [workspace, transport]) {
    mkdirSync(directory, { mode: 0o700 }); git(directory, 'init', '-q', '--template=', '--initial-branch=main');
  }
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("Preparation must not execute evaluator");\n');
  git(workspace, 'add', '.');
  git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const poolFile = join(base, 'pool.json'), bindingsFile = join(base, 'bindings.json');
  const observationsFile = join(base, 'observations.json'), projectsFile = join(base, 'projects.json');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local',
    model: 'inert', maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat',
    endpoint: 'http://127.0.0.1:9/v1' }], pool);
  save(poolFile, pool); save(bindingsFile, bindings); save(observationsFile, []);
  save(projectsFile, { schemaVersion: 1, projects: [] });
  const resourceRuntime = join(base, 'runtime.json');
  const runtime = { schemaVersion: 1, root, workspace: transport, poolPath: poolFile,
    bindingsPath: bindingsFile, observationsPath: observationsFile }; save(resourceRuntime, runtime);
  const config: ResourceConsoleEngineeringPreparationConfig = { schemaVersion: 1, outputRoot, resourceRuntime,
    profiles: [{ id: 'pinned', label: 'Fixed checks', acceptance: 'Only value may change.', recipe: {
      schemaVersion: 1, id: 'template', name: 'Pinned template', objective: 'Fixed template objective', projectId: 'default',
      seedRevision: git(workspace, 'rev-parse', 'HEAD'), metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
      trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10000, trialTimeoutMs: 5000 },
      campaignBudget: { maxGenerations: 1, maxDurationMs: 20000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null },
      generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
        hypotheses: [{ id: 'repair', niche: 'value', hypothesis: 'Improve value' }] },
      delivery: { branch: 'codex/template', allowInitialRepair: true },
      execution: { maxDurationMs: 30000, constitutionVersion: 'fixture', policyEpoch: 1 },
      supervision: { maxDurationMs: 60000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 },
    } }] };
  const configFile = join(base, 'preparation.json'); save(configFile, config);
  const options = { configFile, config, root, workspace, projectsFile, poolFile, bindingsFile, observationsFile };
  const supervisor = await createResourcePoolSupervisor({ root, pool, bindings, workspace, projects: [],
    readObservations: () => [], pollIntervalMs: 60000 });
  const owner = createResourceConsoleEngineeringOwner({ root, poolFile, bindingsFile, observationsFile,
    supervisor, registrationEnabled: true });
  try {
    const manager = createResourceConsoleEngineeringPreparation({ ...options, owner });
    const requests = ['first', 'second'].map(id => ({ id, profileId: 'pinned', name: `Improve ${id}`, objective: `Improve ${id} value` }));
    const plans = requests.map(request => manager.check(request));
    const prepared = requests.map((request, index) => manager.prepare({ ...request, expectedPlanDigest: plans[index]!.planDigest }));
    const registry = createResourceEngineeringPreparationRegistry(options);
    const registration = registry.registrations().find(row => row.request.id === requests[0]!.id)!;
    const bundleInput = { ...registry.objective(requests[0]).bundleOptions, expectedPlanDigest: registration.bundlePlanDigest };
    return { options, requests, plans, prepared, catalog: owner.catalog(), runtime, save, bundleInput };
  } finally { await owner.close(); await supervisor.close(); }
}

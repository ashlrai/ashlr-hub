/** Actual pinned registration, without starting a worker or evaluator. */
import { execFileSync } from 'node:child_process';
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
import { setResourcePoolAllocation, readResourceJson } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';

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
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-core-'))); roots.push(base);
  const workspace = join(base, 'repo'); const transport = join(base, 'transport'); const ledger = join(base, 'ledger');
  for (const dir of [workspace, transport]) { mkdirSync(dir, { mode: 0o700 }); git(dir, 'init', '-q', '--template=', '--initial-branch=main'); }
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("must not execute during preparation");\n');
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const poolPath = join(base, 'pool.json'); const bindingsPath = join(base, 'bindings.json'); const observationsPath = join(base, 'observations.json');
  save(poolPath, { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
  save(bindingsPath, [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]);
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

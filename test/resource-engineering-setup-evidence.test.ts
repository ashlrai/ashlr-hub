/** Private Git/setup receipts only; no owner, worker, evaluator or delivery is started. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import { checkResourceEngineeringAutonomousSetup as check, prepareResourceEngineeringAutonomousSetup as prepare,
  readResourceEngineeringAutonomousSetupEvidence as readEvidence,
  type ResourceEngineeringAutonomousSetupPolicy } from '../src/core/resources/engineering-autonomous-setup.js';
import * as bundle from '../src/core/resources/engineering-preparation.js';
import * as delivered from '../src/core/resources/engineering-delivered-source.js';
import { setResourcePoolAllocation, readResourceJson } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';

const roots: string[] = [];
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
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
let current: ReturnType<typeof fixture>;
let prepared: ReturnType<typeof prepare>;
beforeAll(() => {
  current = fixture();
  prepared = prepare({ ...current.options, expectedPlanDigest: check(current.options).planDigest });
}, 60_000);

describe('call-local completed setup evidence', () => {
  it('returns the unchanged public plan while reconstructing each committed metadata entry once', () => {
    const expected = check(current.options); const before = evidence(current.base);
    const metadata = vi.spyOn(bundle, 'readPreparedResourceEngineeringMetadata');
    const source = vi.spyOn(delivered, 'readResourceEngineeringDeliveredRegistration');
    const result = readEvidence(current.options);
    expect(result.plan).toEqual(expected);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ registration: { enrollmentDigest: prepared.initialEnrollmentDigest },
      verified: { report: { enrollmentDigest: prepared.initialEnrollmentDigest } }, source: null });
    expect(result.entries[0]!.verified.catalog.enrollments).toHaveLength(1);
    expect(metadata).toHaveBeenCalledTimes(1); expect(source).toHaveBeenCalledTimes(1);
    expect(evidence(current.base)).toBe(before);
  });

  it('keeps the public plan check independent from delivered-source derivation', () => {
    const source = vi.spyOn(delivered, 'readResourceEngineeringDeliveredRegistration').mockImplementation(() => { throw Error('Must not derive delivery'); });
    expect(check(current.options).initialEnrollmentDigest).toBe(prepared.initialEnrollmentDigest);
    expect(source).not.toHaveBeenCalled();
  });

  it('creates fresh registry and metadata objects on every call instead of retaining caller-mutated results', () => {
    const metadata = vi.spyOn(bundle, 'readPreparedResourceEngineeringMetadata');
    const first = readEvidence(current.options);
    const pristine = structuredClone({ plan: first.plan, entries: first.entries });
    first.plan.initialEnrollmentDigest = '0'.repeat(64);
    first.entries[0]!.registration.enrollmentDigest = '0'.repeat(64);
    first.entries[0]!.verified.catalog.enrollments.length = 0;
    const second = readEvidence(current.options);
    expect(second.registry).not.toBe(first.registry);
    expect({ plan: second.plan, entries: second.entries }).toEqual(pristine);
    expect(metadata).toHaveBeenCalledTimes(2);
  });

  it.each(['receipt', 'profiles', 'supervision', 'successors', 'runtime'])('refuses changed %s evidence on the next invocation', kind => {
    const prior = readEvidence(current.options);
    const file = kind === 'runtime' ? current.options.resourceRuntime : prepared.paths[kind as 'receipt' | 'profiles' | 'supervision' | 'successors'];
    const original = readFileSync(file); const changed = JSON.parse(original.toString('utf8'));
    if (kind === 'receipt') changed.registrationDigest = '0'.repeat(64);
    else if (kind === 'profiles') changed.profiles[0].acceptance += ' changed';
    else if (kind === 'runtime') changed.capacityWaitMs = 1;
    else changed.maxConcurrent = kind === 'supervision' ? 2 : 1;
    try {
      save(file, changed); const before = evidence(current.base);
      expect(() => readEvidence(current.options)).toThrow();
      expect(evidence(current.base)).toBe(before);
      expect(prior.plan.initialEnrollmentDigest).toBe(prepared.initialEnrollmentDigest);
    } finally { writeFileSync(file, original); }
  });

  it('retains the final source/runtime capture after call-local metadata reuse', () => {
    const original = readFileSync(current.options.resourceRuntime);
    const read = bundle.readPreparedResourceEngineeringMetadata;
    vi.spyOn(bundle, 'readPreparedResourceEngineeringMetadata').mockImplementationOnce(options => {
      const result = read(options);
      save(current.options.resourceRuntime, { ...JSON.parse(original.toString('utf8')), capacityWaitMs: 1 });
      return result;
    });
    try { expect(() => readEvidence(current.options)).toThrow(); }
    finally { writeFileSync(current.options.resourceRuntime, original); }
  });

  it('does not accept a caller proof field or invoke its accessor', () => {
    const prior = readEvidence(current.options); const before = evidence(current.base);
    const metadata = vi.spyOn(bundle, 'readPreparedResourceEngineeringMetadata');
    const getter = vi.fn(() => prior);
    expect(() => readEvidence({ ...current.options, evidence: prior } as typeof current.options)).toThrow();
    expect(() => readEvidence(Object.defineProperty({ ...current.options }, 'evidence', { enumerable: true, get: getter }))).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(metadata).not.toHaveBeenCalled(); expect(evidence(current.base)).toBe(before);
  });

  it('refuses missing completed setup without creating or repairing output', () => {
    const incomplete = join(current.base, 'incomplete'); mkdirSync(incomplete, { mode: 0o700 });
    const options = { ...current.options, output: incomplete,
      policy: { ...current.policy, id: 'unstarted', registrationScope: 'unstarted' } };
    const before = evidence(current.base);
    expect(() => readEvidence(options)).toThrow('Completed setup evidence is required');
    expect(evidence(current.base)).toBe(before);
  });
});


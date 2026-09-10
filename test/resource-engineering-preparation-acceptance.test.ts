/** Real private preparation -> unchanged generated configuration -> evaluated delivery.
 * Only the test-owned loopback endpoint receives model requests.
 */
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { checkResourceConsoleEngineering } from '../src/core/resources/console-engineering-check.js';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle } from '../src/core/resources/engineering-preparation.js';
import type { ResourceEngineeringRecipe, ResourceEngineeringPreparationPlan, ResourceEngineeringPreparationReport } from '../src/core/resources/engineering-preparation-types.js';
import { startResourceConsoleServer } from '../src/core/web/resource-console-server.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
import * as deliveryGit from '../src/core/universe/delivery-git.js';
import { readControlGraph } from '../src/core/universe/control-graph.js';
import { readUniverseCampaign, readUniverseDeliveries, type UniverseManifest } from '../src/core/universe/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); }
});
const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}
/** Ignore access times only; identity/times detect temporary create-remove writes. */
function evidence(root: string) {
  if (!existsSync(root)) return null;
  const rows: Record<string, unknown> = {};
  const visit = (path: string, name: string) => {
    const s = lstatSync(path, { bigint: true }); expect(s.isSymbolicLink()).toBe(false);
    rows[name] = { mode: String(s.mode), dev: String(s.dev), ino: String(s.ino), nlink: String(s.nlink),
      mtime: String(s.mtimeNs), ctime: String(s.ctimeNs), ...(s.isFile() ? { bytes: String(s.size), digest: digest(readFileSync(path)) } : {}) };
    if (s.isDirectory()) for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`);
  };
  visit(root, ''); return rows;
}
async function fixture() {
  expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-preparation-acceptance-')));
  const repo = join(base, 'project'); const transport = join(base, 'transport'); const root = join(base, 'ledger');
  for (const path of [repo, transport]) mkdirSync(path, { mode: 0o700 });
  git(repo, 'init', '-q', '--template=', '--initial-branch=main'); git(transport, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'evaluate.mjs'), `import{readFileSync}from'node:fs';import{join}from'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:value===1,score:value===1?1:0,metrics:{value},diagnostics:value===1?[]:[{code:'EXPECTED_ONE',message:'The declared value must equal one.',path:'value.json'}]}));`);
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=Preparation Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fresh failing seed');
  const revision = git(repo, 'rev-parse', 'HEAD'); const requests: unknown[] = []; const errors: string[] = [];
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const messages = JSON.parse(input.messages[0].content) as Array<{ role: string; content: string }>;
        const generation = JSON.parse(messages.find(row => row.role === 'user')!.content); requests.push(generation);
        expect(generation.seedContext.measurement).toMatchObject({ passed: false, score: 0, metrics: { value: 0 },
          diagnostics: [{ code: 'EXPECTED_ONE', path: 'value.json' }] });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ operations: [
          { op: 'replace', path: 'value.json', content: `${generation.seedContext.measurement.metrics.value + 1}\n` },
        ] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('Unexpected fixture protocol'); }
    });
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve()));
    const writable = (path: string): void => { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) return;
      chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name)); };
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  const address = worker.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'preparation-pool', workers: ['repair', 'spare'].map(id => ({
    id, provider: 'local', model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, reservePercent: 0, priority: 1,
  })) });
  const bindings = validateResourceBindings(pool.workers.map(row => ({ workerId: row.id, capacityKey: `${row.id}-account`,
    kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` })), pool);
  const observations = pool.workers.map(row => ({ workerId: row.id, health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() }));
  const files = { poolFile: join(base, 'pool.json'), bindingsFile: join(base, 'bindings.json'), observationsFile: join(base, 'observations.json'),
    projectsFile: join(base, 'projects.json'), resourceRuntime: join(base, 'runtime.json') };
  save(files.poolFile, pool); save(files.bindingsFile, bindings); save(files.observationsFile, observations);
  save(files.projectsFile, { schemaVersion: 1, projects: [] });
  const runtime = { schemaVersion: 1, root, workspace: transport, poolPath: files.poolFile, bindingsPath: files.bindingsFile,
    observationsPath: files.observationsFile, capacityWaitMs: 1000 }; save(files.resourceRuntime, runtime);
  const existing = await createResourcePoolSupervisor({ root, pool, bindings, workspace: repo, projects: [], readObservations: () => observations });
  await existing.close(); setResourcePoolAllocation(root, pool, bindings, 70, 0); setResourceWorkerAccess(root, pool, bindings, ['spare'], 0);
  loadOrCreateKey();
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'prepared-value', name: 'Fresh measured preparation fixture', objective: 'Correct a freshly measured value',
    seed: { repo, revision }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 30_000, trialTimeoutMs: 15_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 }, variants: [{ id: 'repair', niche: 'value', hypothesis: 'Repair measured defect',
      generation: { kind: 'resource-pool', poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })), allowedWorkerIds: ['repair'],
        files: ['value.json'], maxOutputTokens: 256, fileOperations: { schemaVersion: 1, contextFiles: [] } } }] };
  const evaluations = vi.spyOn(evaluator, 'runFixedUniverseEvaluator');
  const originalGit = deliveryGit.deliveryGit; let publications = 0;
  vi.spyOn(deliveryGit, 'deliveryGit').mockImplementation((...args) => { const api = originalGit(...args);
    return { ...api, createRef: async (...createArgs) => { publications++; await api.createRef(...createArgs); } }; });
  return { base, root, repo, revision, transport, files, runtime, manifest, requests, errors, evaluations, publications: () => publications,
    protectedEvidence: () => Object.fromEntries([root, repo, transport, homedir(), ...Object.values(files)].map(path => [path, evidence(path)])),
    ledger: () => resourcePoolStatus(root, pool, bindings, observations) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function options(f: Fixture) {
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: f.manifest.id, name: f.manifest.name,
    objective: f.manifest.objective, projectId: 'default', seedRevision: f.revision,
    metric: f.manifest.metric, evaluation: f.manifest.evaluation, trialBudget: f.manifest.budget,
    campaignBudget: { maxGenerations: 1, maxDurationMs: 45_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 30 },
    generation: { files: ['value.json'], contextFiles: [], allowedWorkerIds: ['repair'], maxOutputTokens: 256,
      hypotheses: [{ id: 'repair', niche: 'value', hypothesis: 'Repair the declared measured defect' }] },
    delivery: { branch: 'codex/prepared-value', allowInitialRepair: true },
    execution: { maxDurationMs: 60_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
    supervision: { maxDurationMs: 90_000, pollIntervalMs: 100, maxAttemptsPerEnrollment: 3 } };
  return { recipe, output: join(f.base, 'bundle'), resourceRuntime: f.files.resourceRuntime, workspace: f.repo, projectsFile: f.files.projectsFile };
}
function noEffects(f: Fixture) {
  expect(f.requests).toEqual([]); expect(f.evaluations).not.toHaveBeenCalled(); expect(f.publications()).toBe(0);
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
}
async function until(check: () => Promise<boolean>, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Prepared fixture did not complete'); await new Promise(resolve => setTimeout(resolve, 100)); }
}
async function preparationCli<T>(input: ReturnType<typeof options>, recipeFile: string, extra: string[]) {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli/index.ts',
    'resources', 'pool', 'engineering', 'prepare', '--recipe', recipeFile, '--output', input.output,
    '--resource-runtime', input.resourceRuntime, '--workspace', input.workspace, '--projects', input.projectsFile, '--json', ...extra], {
    timeout: 30_000, maxBuffer: 256 * 1024, env: { ...process.env, HOME: homedir(), USERPROFILE: homedir(),
      ASHLR_HOME: process.env.ASHLR_HOME ?? join(homedir(), '.ashlr'), TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  expect(stderr).toBe(''); expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(256 * 1024);
  return JSON.parse(stdout) as T;
}

describe.runIf(process.platform === 'darwin')('real engineering preparation and unchanged bundle execution', () => {
  it('checks and prepares through the actual CLI, replays exactly, then automatically delivers measured work using the same ledger and generated bundle', async () => {
    const f = await fixture(); const input = options(f); const recipeFile = join(f.base, 'recipe.json'); save(recipeFile, input.recipe);
    const protectedEvidence = () => ({ ...f.protectedEvidence(), recipe: evidence(recipeFile) });
    const before = evidence(f.base); const protectedBefore = protectedEvidence();
    const plan = await preparationCli<ResourceEngineeringPreparationPlan>(input, recipeFile, ['--check']);
    expect(plan).toMatchObject({ status: 'planned', projectRegistration: 'persisted', executionStarted: false, providerContacted: false });
    expect(evidence(f.base)).toEqual(before); noEffects(f); expect(existsSync(input.output)).toBe(false);
    const prepared = await preparationCli<ResourceEngineeringPreparationReport>(input, recipeFile, ['--expected-plan-digest', plan.planDigest]);
    expect(prepared).toMatchObject({ status: 'prepared', disposition: 'created', planDigest: plan.planDigest,
      commissioning: { status: 'configured' } });
    expect(protectedEvidence()).toEqual(protectedBefore); noEffects(f);
    expect(readUniverseCampaign(prepared.ids.campaignId, { root: prepared.paths.universeRoot }).seedEvaluation).toBeUndefined();
    const bundle = evidence(input.output);
    const replay = await prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest });
    expect(replay).toMatchObject({ disposition: 'replayed', planDigest: plan.planDigest, enrollmentDigest: prepared.enrollmentDigest });
    expect(evidence(input.output)).toEqual(bundle); expect(protectedEvidence()).toEqual(protectedBefore); noEffects(f);
    const checkOptions = { root: f.root, poolFile: f.files.poolFile, bindingsFile: f.files.bindingsFile,
      observationsFile: f.files.observationsFile, workspace: f.repo, projectsFile: f.files.projectsFile, engineeringFile: prepared.paths.engineering };
    const commissioning = checkResourceConsoleEngineering(checkOptions);
    expect(commissioning).toMatchObject({ status: 'configured', effectsExecuted: false, providerContacted: false,
      enrollments: [{ enrollmentDigest: prepared.enrollmentDigest }] });
    expect(evidence(input.output)).toEqual(bundle); expect(protectedEvidence()).toEqual(protectedBefore); noEffects(f);
    const configurationFiles = [prepared.paths.manifest, prepared.paths.campaign, prepared.paths.engineering, prepared.paths.supervision, prepared.paths.receipt];
    const configBytes = configurationFiles.map(path => readFileSync(path, 'utf8'));
    expect(prepared.consoleArguments.automatic).toContain(prepared.paths.supervision);
    const ledgerBefore = json(join(f.root, 'pool-state.json'));
    const console = await startResourceConsoleServer({ ...checkOptions, execute: true, engineeringSupervisionFile: prepared.paths.supervision });
    cleanups.push(() => console.close());
    await until(async () => readControlGraph(prepared.paths.graphRoot).status === 'completed');
    await console.close();
    expect(f.errors).toEqual([]); expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2); expect(f.publications()).toBe(1);
    expect(f.ledger().attempts).toHaveLength(1); expect(f.ledger().attempts[0]).toMatchObject({ workerId: 'repair', capacityKey: 'repair-account', status: 'completed' });
    const ledgerAfter = json(join(f.root, 'pool-state.json'));
    expect(ledgerAfter.allocation).toEqual(ledgerBefore.allocation); expect(ledgerAfter.workerAccess).toEqual(ledgerBefore.workerAccess);
    expect(configurationFiles.map(path => readFileSync(path, 'utf8'))).toEqual(configBytes);
    expect(git(f.repo, 'show', `${input.recipe.delivery.branch}:value.json`)).toBe('1');
    expect(git(f.repo, 'diff', '--name-only', f.revision, input.recipe.delivery.branch)).toBe('value.json');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
    expect(readUniverseCampaign(prepared.ids.campaignId, { root: prepared.paths.universeRoot }).seedEvaluation?.result).toBeDefined();
    expect(readUniverseDeliveries(prepared.ids.universeId, { root: prepared.paths.universeRoot }).deliveries).toHaveLength(1);
    const completed = evidence(f.base);
    expect(await prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest })).toMatchObject({ disposition: 'replayed',
      enrollmentDigest: prepared.enrollmentDigest });
    expect(evidence(f.base)).toEqual(completed);
    expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2); expect(f.publications()).toBe(1);
  }, 75_000);

  it.each(['recipe', 'runtime'] as const)('refuses a reviewed plan after %s drift without publishing or dispatching', async mode => {
    const f = await fixture(); const input = options(f); const plan = await checkResourceEngineeringPreparation(input);
    if (mode === 'recipe') input.recipe.objective += ' changed after review';
    else save(f.files.resourceRuntime, { ...f.runtime, capacityWaitMs: 2000 });
    const before = evidence(f.base);
    await expect((async () => prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest }))()).rejects.toThrow();
    expect(evidence(f.base)).toEqual(before); noEffects(f); expect(existsSync(input.output)).toBe(false);
  });

  it('refuses an incomplete bundle without synthesizing its completion receipt', async () => {
    const f = await fixture(); const input = options(f); const plan = await checkResourceEngineeringPreparation(input);
    const prepared = await prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest });
    // Fixture-only simulation of interruption before final receipt publication.
    rmSync(prepared.paths.receipt); const before = evidence(f.base);
    await expect((async () => prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: plan.planDigest }))()).rejects.toThrow();
    expect(evidence(f.base)).toEqual(before); noEffects(f); expect(existsSync(prepared.paths.receipt)).toBe(false);
  });
});

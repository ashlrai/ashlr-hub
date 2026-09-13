/** Actual operator CLI -> preserved conversation -> new prepared engineering work.
 * All worker traffic is loopback; source, accounting and Git refs are fixture-owned.
 */
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { readResourceJson, resourcePoolStatus, setResourcePoolAllocation } from '../src/core/resources/pool-runtime.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { checkResourceConsoleEngineering } from '../src/core/resources/console-engineering-check.js';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle } from '../src/core/resources/engineering-preparation.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import type { ResourcePoolEvolutionPlan, ResourcePoolEvolutionReport } from '../src/core/resources/pool-evolution-types.js';
import { startResourceConsoleServer } from '../src/core/web/resource-console-server.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
import * as deliveryGit from '../src/core/universe/delivery-git.js';
import * as campaignDelivery from '../src/core/universe/campaign-delivery.js';
import * as campaignRuntime from '../src/core/universe/campaign.js';
import { readControlGraph } from '../src/core/universe/control-graph.js';
import { readUniverseCampaign, readUniverseOverview, readUniversePortfolioController } from '../src/core/universe/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); }
});
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}
function tree(root: string) {
  const rows: Record<string, unknown> = {};
  const visit = (file: string, name: string) => {
    const stat = lstatSync(file, { bigint: true }); expect(stat.isSymbolicLink()).toBe(false);
    rows[name] = { mode: String(stat.mode), ino: String(stat.ino), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      ...(stat.isFile() ? { digest: digest(readFileSync(file)) } : {}) };
    if (stat.isDirectory()) for (const child of readdirSync(file).sort()) visit(join(file, child), `${name}/${child}`);
  };
  visit(root, ''); return rows;
}
async function cli<T>(files: { root: string; workspace: string; pool: string; bindings: string; nextPool: string; nextBindings: string }, action: 'check' | 'apply', digest?: string): Promise<T> {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'resources', 'pool', 'evolve', action,
    '--root', files.root, '--workspace', files.workspace, '--pool', files.pool, '--bindings', files.bindings,
    '--next-pool', files.nextPool, '--next-bindings', files.nextBindings, '--json', ...(digest ? ['--expected-plan-digest', digest] : [])], {
    timeout: 30_000, maxBuffer: 256 * 1024, env: { ...process.env, HOME: homedir(), USERPROFILE: homedir(),
      ASHLR_HOME: process.env.ASHLR_HOME ?? join(homedir(), '.ashlr'), TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  expect(stderr).toBe(''); return JSON.parse(stdout) as T;
}

describe.runIf(process.platform === 'darwin')('evolved ledger engineering bridge', () => {
  it('uses the real upgrade CLI, then prepares and automatically delivers new work without rewriting old history or accounting', async () => {
    expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'evolved-engineering-')));
    const root = join(base, 'ledger'); const repo = join(base, 'project'); const transport = join(base, 'transport');
    for (const path of [repo, transport]) { mkdirSync(path, { mode: 0o700 }); git(path, 'init', '-q', '--template=', '--initial-branch=main'); }
    writeFileSync(join(repo, 'value.json'), '0\n');
    writeFileSync(join(repo, 'evaluate.mjs'), `import{readFileSync}from'node:fs';import{join}from'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:value===1,score:value===1?1:0,metrics:{value},diagnostics:[]}));`);
    git(repo, 'add', '.'); git(repo, '-c', 'user.name=Evolution Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fresh failing seed');
    const revision = git(repo, 'rev-parse', 'HEAD');
    const calls: string[] = []; const errors: string[] = [];
    const worker = createServer((request, response) => {
      const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          let content = 'PRIVATE_EVOLUTION_OLD_ANSWER';
          if (body.model === 'repair-model') {
            const messages = JSON.parse(body.messages[0].content) as Array<{ role: string; content: string }>;
            const generation = JSON.parse(messages.find(row => row.role === 'user')!.content);
            expect(generation.seedContext.measurement).toMatchObject({ passed: false, score: 0, metrics: { value: 0 } });
            content = JSON.stringify({ operations: [{ op: 'replace', path: 'value.json', content: '1\n' }] });
          }
          calls.push(body.model); response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
        } catch (error) { errors.push(String(error)); response.writeHead(500); response.end('Invalid fixture input'); }
      });
    });
    await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve()));
      const writable = (path: string): void => { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name)); };
      writable(base); rmSync(base, { recursive: true, force: true });
    });
    const address = worker.address(); if (!address || typeof address === 'string') throw new Error('No fixture listener');
    const pool = validateResourcePool({ schemaVersion: 1, id: 'evolved-engineering', workers: [{ id: 'legacy', provider: 'local', model: 'old-model',
      maxConcurrent: 1, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, reservePercent: 0 }] });
    const bindings = validateResourceBindings([{ workerId: 'legacy', capacityKey: 'same-account', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
    const nextPool = validateResourcePool({ ...pool, workers: [...pool.workers, { ...pool.workers[0]!, id: 'repair', model: 'repair-model' }] });
    const nextBindings = validateResourceBindings([...bindings, { ...bindings[0]!, workerId: 'repair' }], nextPool);
    const observations = nextPool.workers.map(row => ({ workerId: row.id, health: 'ready' as const, windows: [], retryAfter: null,
      observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() }));
    const owners: ResourcePoolSupervisor[] = []; cleanups.push(async () => { for (const owner of owners) await owner.close(); });
    const old = await createResourcePoolSupervisor({ root, workspace: repo, pool, bindings, projects: [], readObservations: () => observations.slice(0, 1), pollIntervalMs: 20 }); owners.push(old);
    const oldInput = { id: 'old-task', prompt: 'PRIVATE_EVOLUTION_OLD_PROMPT', mode: 'read-only' as const,
      allowedWorkerIds: ['legacy'], maxOutputTokens: 128, timeoutMs: 10_000, retainHistory: true };
    old.submit(oldInput);
    await vi.waitFor(() => expect(old.snapshot().jobs[0]?.state).toBe('settled'), { timeout: 10_000 });
    const transcript = old.history(oldInput.id)!; await old.close(); setResourcePoolAllocation(root, pool, bindings, 70, 0);
    loadOrCreateKey();
    const beforeReceipt = resourcePoolStatus(root, pool, bindings, observations.slice(0, 1)).attempts[0]!;
    const files = { root, workspace: repo, pool: join(base, 'pool-old.json'), bindings: join(base, 'bindings-old.json'),
      nextPool: join(base, 'pool-next.json'), nextBindings: join(base, 'bindings-next.json') };
    save(files.pool, pool); save(files.bindings, bindings); save(files.nextPool, nextPool); save(files.nextBindings, nextBindings);
    const beforeCheck = tree(base); const plan = await cli<ResourcePoolEvolutionPlan>(files, 'check');
    expect(plan).toMatchObject({ status: 'planned', preservedJobCount: 1, preservedReceiptCount: 1, addedWorkerIds: ['repair'] });
    expect(tree(base)).toEqual(beforeCheck); expect(calls).toEqual(['old-model']);
    expect(await cli<ResourcePoolEvolutionReport>(files, 'apply', plan.planDigest)).toMatchObject({ status: 'applied', disposition: 'created' });
    const journalRoot = join(root, 'pool-evolution');
    for (const name of readdirSync(journalRoot, { recursive: true }) as string[]) {
      const file = join(journalRoot, name);
      if (lstatSync(file).isFile()) {
        const text = readFileSync(file, 'utf8');
        expect(text).not.toContain(oldInput.prompt); expect(text).not.toContain(transcript.output!.text);
      }
    }
    const afterUpgrade = tree(base);
    expect(await cli<ResourcePoolEvolutionReport>(files, 'apply', plan.planDigest)).toMatchObject({ disposition: 'replayed' });
    expect(tree(base)).toEqual(afterUpgrade);
    expect(readResourceJson(join(root, 'resource-console-state.json'))).toMatchObject({ schemaVersion: 5 });
    const upgraded = await createResourcePoolSupervisor({ root, workspace: repo, pool: nextPool, bindings: nextBindings, projects: [], readObservations: () => observations }); owners.push(upgraded);
    expect(upgraded.history(oldInput.id)).toEqual(transcript); upgraded.submit(oldInput); await upgraded.close();
    const projectsFile = join(base, 'projects.json'); const observationsFile = join(base, 'observations.json'); const resourceRuntime = join(base, 'runtime.json');
    save(projectsFile, { schemaVersion: 1, projects: [] }); save(observationsFile, observations);
    save(resourceRuntime, { schemaVersion: 1, root, workspace: transport, poolPath: files.nextPool, bindingsPath: files.nextBindings,
      observationsPath: observationsFile, capacityWaitMs: 1000 });
    const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'evolved-repair', name: 'Repair after pool evolution', objective: 'Correct the measured seed',
      projectId: 'default', seedRevision: revision, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 },
      trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 30_000, trialTimeoutMs: 15_000 },
      campaignBudget: { maxGenerations: 1, maxDurationMs: 45_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 30 },
      generation: { files: ['value.json'], contextFiles: [], allowedWorkerIds: ['repair'], maxOutputTokens: 256,
        hypotheses: [{ id: 'repair', niche: 'value', hypothesis: 'Repair the measured defect' }] },
      delivery: { branch: 'codex/evolved-repair', allowInitialRepair: true }, execution: { maxDurationMs: 60_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
      supervision: { maxDurationMs: 90_000, pollIntervalMs: 100, maxAttemptsPerEnrollment: 3 } };
    const input = { recipe, output: join(base, 'bundle'), resourceRuntime, workspace: repo, projectsFile };
    const evaluations = vi.spyOn(evaluator, 'runFixedUniverseEvaluator'); let publications = 0; const originalGit = deliveryGit.deliveryGit;
    const deliveryErrors: string[] = []; const originalDelivery = campaignDelivery.deliverCompletedUniverseCampaign;
    vi.spyOn(campaignDelivery, 'deliverCompletedUniverseCampaign').mockImplementation(async (...args) => {
      try { return await originalDelivery(...args); }
      catch (error) { deliveryErrors.push(error instanceof Error ? error.stack ?? error.message : 'Unknown delivery failure'); throw error; }
    });
    const campaignErrors: string[] = []; const originalCampaign = campaignRuntime.runUniverseCampaignOwned;
    vi.spyOn(campaignRuntime, 'runUniverseCampaignOwned').mockImplementation(async (...args) => {
      try { return await originalCampaign(...args); }
      catch (error) { campaignErrors.push(error instanceof Error ? error.stack ?? error.message : 'Unknown campaign failure'); throw error; }
    });
    vi.spyOn(deliveryGit, 'deliveryGit').mockImplementation((...args) => { const api = originalGit(...args);
      return { ...api, createRef: async (...createArgs) => { publications++; await api.createRef(...createArgs); } }; });
    const beforePreparation = tree(base); const preparation = checkResourceEngineeringPreparation(input);
    expect(preparation).toMatchObject({ status: 'planned', projectRegistration: 'persisted' }); expect(tree(base)).toEqual(beforePreparation);
    const accountingBefore = tree(root); const prepared = prepareResourceEngineeringBundle({ ...input, expectedPlanDigest: preparation.planDigest });
    expect(prepared.commissioning.status).toBe('configured'); expect(tree(root)).toEqual(accountingBefore);
    const checkOptions = { root, poolFile: files.nextPool, bindingsFile: files.nextBindings, observationsFile, workspace: repo, projectsFile, engineeringFile: prepared.paths.engineering };
    const beforeInspection = tree(base); const checked = checkResourceConsoleEngineering(checkOptions);
    expect(checked).toMatchObject({ status: 'configured', admission: 'not-attested', effectsExecuted: false, providerContacted: false,
      enrollments: [{ projectRegistration: 'persisted', graph: { sourceState: 'missing' }, runtime: { status: 'valid', sourceState: 'healthy', allocationCeilingPercent: 70 } }] });
    expect(tree(base)).toEqual(beforeInspection); expect(evaluations).not.toHaveBeenCalled(); expect(publications).toBe(0); expect(calls).toEqual(['old-model']);
    const generated = [prepared.paths.engineering, prepared.paths.supervision, prepared.paths.receipt].map(file => readFileSync(file, 'utf8'));
    const server = await startResourceConsoleServer({ ...checkOptions, execute: true, engineeringSupervisionFile: prepared.paths.supervision }); cleanups.push(() => server.close());
    try {
      await vi.waitFor(() => expect(readControlGraph(prepared.paths.graphRoot).status).toBe('completed'), { timeout: 45_000, interval: 100 });
    } catch {
      const graph = readControlGraph(prepared.paths.graphRoot);
      const campaign = readUniverseCampaign(prepared.ids.campaignId, { root: prepared.paths.universeRoot });
      const controller = readUniversePortfolioController(prepared.ids.controllerId, { root: prepared.paths.universeRoot });
      throw new Error(JSON.stringify({ calls, errors, deliveryErrors, campaignErrors, evaluations: evaluations.mock.calls.length, publications,
        graph: { status: graph.status, sourceState: graph.sourceState, nodes: graph.nodes, reasons: graph.reasons },
        controller: { status: controller.status, sourceState: controller.sourceState, outcomes: controller.outcomes, reasons: controller.reasons, diagnostics: controller.diagnostics },
        campaign: { state: campaign.state, reason: campaign.reason, reasons: campaign.reasons, progress: campaign.progress,
          seedResult: campaign.seedEvaluation?.result },
        runs: readUniverseOverview({ root: prepared.paths.universeRoot }).universes.flatMap(universe => universe.runs.map(run => ({ status: run.status,
          error: run.error, trials: run.trials.map(trial => ({ status: trial.status, score: trial.score, error: trial.error, generation: trial.generation })) }))),
        receipts: resourcePoolStatus(root, nextPool, nextBindings, observations).attempts.map(row => ({ id: row.id, workerId: row.workerId, status: row.status, reason: row.reason })) }).replaceAll(base, '<fixture>'));
    }
    await server.close();
    expect(errors).toEqual([]); expect(calls).toEqual(['old-model', 'repair-model']); expect(evaluations).toHaveBeenCalledTimes(2); expect(publications).toBe(1);
    const status = resourcePoolStatus(root, nextPool, nextBindings, observations);
    expect(status.attempts).toHaveLength(2); expect(status.attempts.find(row => row.id === 'old-task')).toEqual(beforeReceipt);
    expect(status.attempts.find(row => row.id !== 'old-task')).toMatchObject({ workerId: 'repair', capacityKey: 'same-account', status: 'completed', poolDigest: plan.toPoolDigest });
    expect(status.allocation).toMatchObject({ ceilingPercent: 70, revision: 1 });
    expect([prepared.paths.engineering, prepared.paths.supervision, prepared.paths.receipt].map(file => readFileSync(file, 'utf8'))).toEqual(generated);
    expect(git(repo, 'show', 'codex/evolved-repair:value.json')).toBe('1'); expect(git(repo, 'diff', '--name-only', revision, 'codex/evolved-repair')).toBe('value.json');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(revision); expect(git(repo, 'status', '--porcelain=v1')).toBe('');
    const finalOwner = await createResourcePoolSupervisor({ root, workspace: repo, pool: nextPool, bindings: nextBindings, projects: [], readObservations: () => observations }); owners.push(finalOwner);
    expect(finalOwner.history(oldInput.id)).toEqual(transcript); finalOwner.submit(oldInput); await finalOwner.close();
    const completed = tree(base); expect(await cli<ResourcePoolEvolutionReport>(files, 'apply', plan.planDigest)).toMatchObject({ disposition: 'replayed' });
    expect(tree(base)).toEqual(completed); expect(calls).toHaveLength(2); expect(existsSync(prepared.paths.receipt)).toBe(true);
  }, 90_000);
});

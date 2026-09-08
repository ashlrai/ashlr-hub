/** Real private ledgers and confined evaluators; the native transport is an inert Node fixture. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview,
  type UniverseCampaignDefinition, type UniverseManifest } from '../src/core/universe/index.js';
import { runUniversePortfolio } from '../src/core/universe/portfolio.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { resourceGenerationTaskId } from '../src/core/universe/generation.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { serializeUniverseConsoleOverview } from '../src/core/web/universe-console-public.js';

const scratch: string[] = [];
const EVALUATOR = [
  "import {readFileSync} from 'node:fs';import {join} from 'node:path';",
  "const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));",
  'console.log(JSON.stringify({passed:Number.isInteger(value)&&value===1,score:value,metrics:{value}}));',
].join('\n');

afterEach(() => {
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const path of scratch.splice(0)) { writable(path); rmSync(path, { recursive: true, force: true }); }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
  }).trim();
}

function fixture(specifications: Array<{ name: string; command?: boolean }>,
  options: { usedPercent?: number; maxTasks?: number; workerDelayMs?: number; holdUntilReleased?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-portfolio-resource-')));
  scratch.push(base);
  const root = join(base, 'store');
  const workspace = join(base, 'empty-native-workspace');
  mkdirSync(workspace, { mode: 0o700 });
  git(workspace, 'init', '-q', '--template=', '--initial-branch=main');
  const workerFile = join(base, 'inert-codex.cjs');
  const callsFile = join(base, 'fixture-calls.jsonl');
  const releaseFile = join(base, 'fixture-release');
  // This test-only instrumentation lives outside the empty native workspace.
  // It counts actual subprocess contacts, not campaign attempts or reservations.
  writeFileSync(workerFile, [
    "const {appendFileSync,existsSync}=require('node:fs');let input='';",
    "process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);",
    "process.stdin.on('end',async()=>{const messages=JSON.parse(input);const p=JSON.parse(messages.find(m=>m.role==='user').content);",
    `appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({pid:process.pid})+'\\n',{mode:0o600});`,
    "if(input.includes('UNDECLARED_SEED_DATA')||input.includes('evaluate.mjs'))process.exit(20);",
    "if(p.generation!==1||p.files.length!==1||p.files[0].path!=='value.json'||p.files[0].content!=='0\\n')process.exit(21);",
    options.holdUntilReleased ? `while(!existsSync(${JSON.stringify(releaseFile)}))await new Promise(resolve=>setTimeout(resolve,10));` : '',
    `await new Promise(resolve=>setTimeout(resolve,${options.workerDelayMs ?? 0}));`,
    "const content=JSON.stringify({edits:[{path:'value.json',content:'1\\n'}]});",
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:content}}));",
    "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:10}}));});",
  ].join('\n'), { mode: 0o600 });
  const pool = validateResourcePool({ schemaVersion: 1, id: 'portfolio-pool', workers: [{
    id: 'inert-codex', provider: 'codex', model: 'inert-fixture', maxConcurrent: 1, reservePercent: 10,
    maxTasksPerWindow: options.maxTasks ?? 10, taskWindowMs: 60_000, priority: 1,
  }] });
  const bindings = validateResourceBindings([{ workerId: 'inert-codex', capacityKey: 'one-shared-subscription',
    kind: 'native-cli', command: [process.execPath, workerFile] }], pool);
  const now = Date.now();
  const observations: ResourceObservation[] = [{ workerId: 'inert-codex',
    observedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    health: 'ready', retryAfter: null, windows: [{ id: 'weekly', usedPercent: options.usedPercent ?? 20,
      resetsAt: new Date(now + 3_600_000).toISOString() }] }];
  const poolPath = join(base, 'pool.json');
  const bindingsPath = join(base, 'bindings.json');
  const observationsPath = join(base, 'observations.json');
  const ledgerRoot = join(base, 'shared-resource-ledger');
  const resourceRuntime = join(base, 'runtime.json');
  const runtime = { schemaVersion: 1, poolPath, bindingsPath, observationsPath, root: ledgerRoot, workspace };
  const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  writeJson(poolPath, pool); writeJson(bindingsPath, bindings); writeJson(observationsPath, observations); writeJson(resourceRuntime, runtime);
  const privateFiles = [poolPath, bindingsPath, observationsPath, resourceRuntime, workerFile]
    .map((path) => ({ path, bytes: readFileSync(path) }));
  const definitions: UniverseCampaignDefinition[] = [];
  const seeds: Array<{ repo: string; revision: string }> = [];
  for (const specification of specifications) {
    const repo = join(base, `repo-${specification.name}`);
    mkdirSync(repo, { mode: 0o700 });
    git(repo, 'init', '-q', '--template=', '--initial-branch=main');
    writeFileSync(join(repo, 'value.json'), '0\n');
    writeFileSync(join(repo, 'evaluate.mjs'), EVALUATOR);
    writeFileSync(join(repo, 'private.txt'), 'UNDECLARED_SEED_DATA');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=Portfolio Fixture', '-c', 'user.email=portfolio@example.invalid', 'commit', '-qm', 'private pinned fixture');
    const seed = { repo, revision: git(repo, 'rev-parse', 'HEAD') }; seeds.push(seed);
    const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${specification.name}`, name: `Portfolio ${specification.name}`,
      objective: 'Make the integer one under an independent fixed evaluator', seed,
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
      evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
      variants: [{ id: 'advance', niche: 'value', hypothesis: 'Advance the measured integer',
        ...(specification.command
          ? { command: [process.execPath, '-e', "require('node:fs').writeFileSync('value.json','1\\n')"] }
          : { generation: { kind: 'resource-pool' as const, poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })),
            allowedWorkerIds: ['inert-codex'], files: ['value.json'], maxOutputTokens: 256 } }) }] };
    initUniverse(manifest, { root });
    const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: `campaign-${specification.name}`, universeId: manifest.id,
      feedback: true, budget: { maxGenerations: 1, maxDurationMs: 30_000, maxModelRequests: specification.command ? 0 : 1,
        maxStagnantGenerations: 1, maxReportedTokens: null } };
    initUniverseCampaign(definition, { root }); definitions.push(definition);
  }
  const portfolio = (dependencies: Record<string, string[]> = {}, maxParallel = 2): UniversePortfolioDefinition => ({
    schemaVersion: 1, id: 'resource-portfolio', maxParallel, maxDurationMs: 20_000,
    tasks: definitions.map((definition) => ({ campaignId: definition.id, dependsOn: dependencies[definition.id] ?? [] })),
  });
  return { base, root, resourceRuntime, runtime, pool, bindings, observations, ledgerRoot, workspace, seeds, definitions, privateFiles, portfolio,
    calls: (): Array<{ pid: number }> => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [],
    release: (): void => writeFileSync(releaseFile, '', { mode: 0o600 }),
    status: () => resourcePoolStatus(ledgerRoot, pool, bindings, observations) };
}

function unchangedBoundaries(value: ReturnType<typeof fixture>): void {
  expect(readdirSync(value.workspace)).toEqual(['.git']);
  expect(git(value.workspace, 'for-each-ref', '--format=%(refname)')).toBe('');
  expect(git(value.workspace, 'ls-files')).toBe('');
  for (const seed of value.seeds) {
    expect(git(seed.repo, 'rev-parse', 'HEAD')).toBe(seed.revision);
    expect(git(seed.repo, 'status', '--porcelain=v1')).toBe('');
    expect(git(seed.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/codex/')).toBe('');
    expect(git(seed.repo, 'remote')).toBe('');
    expect(readFileSync(join(seed.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(readFileSync(join(seed.repo, 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
  }
  for (const file of value.privateFiles) expect(readFileSync(file.path)).toEqual(file.bytes);
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Inert worker did not reach the expected active state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Native worker bytes are inert; candidate/evaluator execution still requires the
// actual macOS confinement supported by the existing Universe execution lane.
describe.runIf(process.platform === 'darwin')('resource-backed Universe portfolios', () => {
  it('orders two Universes through one ledger, links measured receipts, and reruns terminal campaigns without contact', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }]);
    const definition = value.portfolio({ 'campaign-b': ['campaign-a'] });
    const result = await runUniversePortfolio(definition, value);
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.outcomes.every((outcome) => outcome.status === 'completed' && outcome.attempted)).toBe(true);
    expect(value.calls()).toHaveLength(2);
    const status = value.status();
    expect(status.attempts).toHaveLength(2);
    expect(new Set(status.attempts.map((receipt) => receipt.id)).size).toBe(2);
    const overview = readUniverseOverview(value);
    expect(overview.sourceState, overview.reasons.join('; ')).toBe('healthy');
    const a = overview.universes.find((universe) => universe.manifest.id === 'universe-a')!.runs[0]!;
    const b = overview.universes.find((universe) => universe.manifest.id === 'universe-b')!.runs[0]!;
    expect(Date.parse(b.startedAt)).toBeGreaterThanOrEqual(Date.parse(a.finishedAt!));
    for (const universe of overview.universes) {
      expect(universe.runs).toHaveLength(1); expect(universe.elites).toHaveLength(1);
      const run = universe.runs[0]!; const trial = run.trials[0]!;
      expect(run.generationUsage).toMatchObject({ requestsStarted: 0, reportedRequests: 0,
        resourceAttempts: 1, resourceReportedAttempts: 1, inputTokens: 20, outputTokens: 10 });
      expect(run.tokensUsed).toBe(30);
      expect(trial).toMatchObject({ status: 'passed', score: 1, selected: true,
        generation: { provider: 'resource-pool', endpoint: null, model: null, requestStarted: false, status: 'succeeded',
          resource: { dispatch: 'settled', taskStatus: 'completed', workerId: 'inert-codex', usageScope: 'codex-turn' } } });
      expect(trial.generation!.resource!.taskId).toBe(resourceGenerationTaskId({ universeId: universe.manifest.id, runId: run.id, variantId: 'advance' }));
      const receipt = status.attempts.find((row) => row.id === trial.generation!.resource!.taskId)!;
      expect(receipt).toMatchObject({ status: 'completed', capacityKey: 'one-shared-subscription', inputTokens: 20, outputTokens: 10,
        verifiedAccepted: false, execution: { usageScope: 'codex-turn' } });
      expect(digest(canonical(receipt))).toBe(trial.generation!.resource!.receiptDigest);
      expect(receipt.taskDigest).toBe(trial.generation!.resource!.taskDigest);
      expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
      expect(readFileSync(join(trial.artifact!.path, 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
      expect(readUniverseCampaign(`campaign-${universe.manifest.id.slice('universe-'.length)}`, value).progress)
        .toMatchObject({ attempts: 1, reservedModelRequests: 1, reportedTokens: 30, usageComplete: true, admissions: 1 });
    }
    const summaries = value.definitions.map((campaign) => readUniverseCampaign(campaign.id, value));
    const rerun = await runUniversePortfolio(definition, value);
    expect(rerun.status).toBe('completed'); expect(rerun.outcomes.every((outcome) => !outcome.attempted)).toBe(true);
    expect(value.calls()).toHaveLength(2); expect(value.status().attempts).toEqual(status.attempts);
    expect(value.definitions.map((campaign) => readUniverseCampaign(campaign.id, value))).toEqual(summaries);
    expect(readUniverseOverview(value).universes.map((universe) => universe.runs)).toEqual(overview.universes.map((universe) => universe.runs));
    const publicOverview = serializeUniverseConsoleOverview(overview);
    for (const receipt of status.attempts) expect(publicOverview).toContain(receipt.id);
    for (const privateValue of [value.resourceRuntime, value.workspace, value.runtime.bindingsPath, 'resourceRuntime', 'inert-codex.cjs']) {
      expect(publicOverview).not.toContain(privateValue); expect(JSON.stringify(result)).not.toContain(privateValue);
    }
    unchangedBoundaries(value);
  });

  it('shares the task-window cap across dependent campaigns and never retries a withheld node', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }, { name: 'c' }], { maxTasks: 1 });
    const result = await runUniversePortfolio(value.portfolio({ 'campaign-b': ['campaign-a'], 'campaign-c': ['campaign-b'] }), value);
    expect(result.status, JSON.stringify(result)).toBe('incomplete');
    expect(result.outcomes.map(({ campaignId, status, attempted }) => ({ campaignId, status, attempted }))).toEqual([
      { campaignId: 'campaign-a', status: 'completed', attempted: true },
      { campaignId: 'campaign-b', status: 'paused', attempted: true },
      { campaignId: 'campaign-c', status: 'blocked', attempted: false },
    ]);
    expect(value.calls()).toHaveLength(1); expect(value.status().attempts).toHaveLength(1);
    // No contact contributes zero to campaign accounting; this does not turn the
    // unmeasured run below into a zero-token invocation.
    expect(readUniverseCampaign('campaign-b', value).progress)
      .toMatchObject({ attempts: 1, reservedModelRequests: 1, reportedTokens: 0, usageComplete: true });
    expect(readUniverseCampaign('campaign-c', value).progress.attempts).toBe(0);
    const withheld = readUniverseOverview(value).universes.find((universe) => universe.manifest.id === 'universe-b')!.runs[0]!;
    expect(withheld.trials[0]!.generation).toMatchObject({ status: 'failed', requestStarted: false,
      resource: { dispatch: 'withheld', taskStatus: null } });
    expect(withheld.trials[0]!.artifact).toBeNull(); expect(withheld.tokensUsed).toBeNull();
    unchangedBoundaries(value);
  });

  it('withholds an overlapping branch at one shared slot even when portfolio concurrency is two', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }, { name: 'c' }], { holdUntilReleased: true });
    const controller = new AbortController();
    const pending = runUniversePortfolio(value.portfolio({ 'campaign-c': ['campaign-a', 'campaign-b'] }, 2),
      { ...value, signal: controller.signal });
    try {
      // Release only once the other branch records its refusal. A fixed sleep
      // would make this concurrency proof depend on unrelated machine load.
      await until(() => value.calls().length === 1 && ['a', 'b'].some((name) => readUniverseCampaign(`campaign-${name}`, value).state === 'paused'));
    } catch (error) {
      value.release(); controller.abort(); await pending; throw error;
    }
    value.release();
    const result = await pending;
    expect(result.status, JSON.stringify(result)).toBe('incomplete');
    expect(result.outcomes.slice(0, 2).map((outcome) => outcome.status).sort()).toEqual(['completed', 'paused']);
    expect(result.outcomes[2]).toMatchObject({ status: 'blocked', attempted: false });
    expect(value.calls()).toHaveLength(1); expect(value.status().attempts).toHaveLength(1);
    expect(value.status().attempts[0]!.status).toBe('completed');
    for (const name of ['a', 'b']) expect(readUniverseCampaign(`campaign-${name}`, value).progress.attempts).toBe(1);
    const overview = readUniverseOverview(value);
    expect(overview.sourceState).toBe('healthy');
    expect(overview.universes.every((universe) => universe.activeRun === null)).toBe(true);
    expect(overview.universes.flatMap((universe) => universe.runs.flatMap((run) => run.trials))
      .filter((trial) => trial.generation?.resource?.dispatch === 'withheld')).toHaveLength(1);
    expect(readUniverseCampaign('campaign-c', value).progress.attempts).toBe(0);
    unchangedBoundaries(value);
  });

  it('preserves reserve denial and blocks descendants while an independent command campaign proceeds', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }, { name: 'c', command: true }], { usedPercent: 90 });
    const result = await runUniversePortfolio(value.portfolio({ 'campaign-b': ['campaign-a'] }), value);
    expect(result.status, JSON.stringify(result)).toBe('incomplete');
    expect(result.outcomes[0]).toMatchObject({ status: 'paused', attempted: true });
    expect(result.outcomes[1]).toMatchObject({ status: 'blocked', attempted: false });
    expect(result.outcomes[2]).toMatchObject({ status: 'completed', attempted: true });
    expect(value.calls()).toEqual([]); expect(value.status().attempts).toEqual([]);
    expect(readUniverseCampaign('campaign-a', value).progress)
      .toMatchObject({ attempts: 1, reservedModelRequests: 1, reportedTokens: 0, usageComplete: true });
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(0);
    const universes = readUniverseOverview(value).universes;
    expect(universes.find((universe) => universe.manifest.id === 'universe-a')!.runs[0]!.trials[0]!.generation!.resource!.dispatch).toBe('withheld');
    const command = universes.find((universe) => universe.manifest.id === 'universe-c')!;
    expect(command.runs[0]!.trials[0]).toMatchObject({ status: 'passed', selected: true });
    expect(command.runs[0]!.trials[0]!.generation).toBeUndefined();
    expect(command.runs[0]!.tokensUsed).toBeNull();
    unchangedBoundaries(value);
  });

  it.each(['missing', 'mismatched'] as const)('never contacts a worker with a %s private runtime', async (kind) => {
    const value = fixture([{ name: 'a' }, { name: 'b' }]);
    let resourceRuntime: string | undefined;
    if (kind === 'mismatched') {
      const poolPath = join(value.base, 'other-pool.json'); resourceRuntime = join(value.base, 'other-runtime.json');
      writeFileSync(poolPath, JSON.stringify({ ...value.pool, id: 'different-pool' }), { mode: 0o600 });
      writeFileSync(resourceRuntime, JSON.stringify({ ...value.runtime, poolPath }), { mode: 0o600 });
    }
    const result = await runUniversePortfolio(value.portfolio({ 'campaign-b': ['campaign-a'] }),
      { root: value.root, ...(resourceRuntime === undefined ? {} : { resourceRuntime }) });
    expect(result.status, JSON.stringify(result)).toBe('incomplete');
    expect(result.outcomes[0]).toMatchObject({ status: 'paused', attempted: true });
    expect(result.outcomes[1]).toMatchObject({ status: 'blocked', attempted: false });
    expect(value.calls()).toEqual([]); expect(value.status().attempts).toEqual([]);
    expect(existsSync(value.ledgerRoot)).toBe(false);
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(0);
    const overview = readUniverseOverview(value);
    expect(overview.sourceState).toBe('healthy');
    const trial = overview.universes.find((universe) => universe.manifest.id === 'universe-a')!.runs[0]!.trials[0]!;
    expect(trial).toMatchObject({ status: 'failed', artifact: null,
      generation: { requestStarted: false, resource: { dispatch: 'not-started', taskId: null, taskStatus: null } } });
    unchangedBoundaries(value);
  });

  it('awaits native cancellation and durable settlement without starting waiting descendants', async () => {
    const value = fixture([{ name: 'a' }, { name: 'b' }], { workerDelayMs: 3_000 });
    const controller = new AbortController();
    const pending = runUniversePortfolio(value.portfolio({ 'campaign-b': ['campaign-a'] }), { ...value, signal: controller.signal });
    try {
      await until(() => value.calls().length === 1 && value.status().attempts.some((receipt) => receipt.status === 'reserved'));
    } catch (error) {
      controller.abort(); await pending; throw error;
    }
    controller.abort();
    const result = await pending;
    expect(result.status, JSON.stringify(result)).toBe('cancelled');
    expect(result.outcomes[1]).toMatchObject({ status: 'cancelled', attempted: false });
    expect(value.calls()).toHaveLength(1);
    const status = value.status();
    expect(status.attempts).toHaveLength(1);
    const receipt = status.attempts[0]!;
    expect(receipt).toMatchObject({ inputTokens: null, outputTokens: null, verifiedAccepted: false });
    // The existing runner conservatively retains capacity if leader exit loses
    // process-group authority. Awaiting cancellation must preserve that result,
    // not upgrade it to confirmed termination or silently reclaim the slot.
    expect(['cancelled', 'uncertain']).toContain(receipt.status);
    if (receipt.status === 'uncertain') {
      expect(receipt.reason).toBe('worker-termination-uncertain');
      expect(status.plan.selectedWorkerId).toBeNull();
    } else expect(receipt.reason).toBe('worker-cancelled');
    expect(receipt.finishedAt).not.toBeNull();
    // This confirms only our instrumented leader, not every possible group member.
    expect(() => process.kill(value.calls()[0]!.pid, 0)).toThrow();
    expect(readUniverseCampaign('campaign-a', value).state).toBe('paused');
    expect(readUniverseCampaign('campaign-a', value).progress).toMatchObject({ reportedTokens: null, usageComplete: false });
    expect(readUniverseCampaign('campaign-b', value).progress.attempts).toBe(0);
    const overview = readUniverseOverview(value);
    expect(overview.sourceState).toBe('healthy');
    expect(overview.universes.every((universe) => universe.activeRun === null)).toBe(true);
    const run = overview.universes.find((universe) => universe.manifest.id === 'universe-a')!.runs[0]!;
    expect(run.tokensUsed).toBeNull();
    expect(run.trials[0]).toMatchObject({ selected: false, artifact: null,
      generation: { requestStarted: false, usage: { state: 'unavailable', inputTokens: null, outputTokens: null },
        resource: { dispatch: 'settled', taskStatus: receipt.status } } });
    expect(run.trials[0]!.generation!.resource!.receiptDigest).toBe(digest(canonical(receipt)));
    unchangedBoundaries(value);
  });
});

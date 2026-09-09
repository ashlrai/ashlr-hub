/** Real subprocess, durable resource ledger and frozen evaluator; no real provider. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview, runUniverse, runUniverseCampaign,
  type UniverseCampaignDefinition, type UniverseManifest } from '../src/core/universe/index.js';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { projectUniverse, readRecords } from '../src/core/universe/store.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { serializeUniverseConsoleOverview } from '../src/core/web/universe-console-public.js';
import * as verification from '../src/core/run/verify-commands.js';

const roots: string[] = [];
const EVALUATOR = [
  "import {readFileSync} from 'node:fs';import {join} from 'node:path';",
  "const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));",
  "console.log(JSON.stringify({passed:Number.isInteger(value)&&value>=0&&value<=100,score:value,",
  "metrics:{value},diagnostics:value<0?[{code:'NONNEGATIVE',message:'Value must be nonnegative',path:'value.json',line:1}]:[]}));",
].join('\n');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function fixture(options: { exhausted?: boolean; usage?: boolean; malformed?: boolean;
  evaluatorDelayMs?: number; evaluatorTimeoutMs?: number; workerDelayMs?: number } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-universe-resource-integration-')));
  roots.push(base);
  const root = join(base, 'universe-store');
  const repo = join(base, 'seed-repository');
  const workspace = join(base, 'empty-native-workspace');
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  const git = (cwd: string, args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(workspace, ['init', '-q']); git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'evaluate.mjs'), options.evaluatorDelayMs
    ? 'await new Promise(r=>setTimeout(r,' + options.evaluatorDelayMs + '));\n' + EVALUATOR : EVALUATOR);
  writeFileSync(join(repo, 'private.txt'), 'UNDECLARED_SEED_DATA');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=Universe Test', '-c', 'user.email=universe@example.invalid', 'commit', '-qm', 'resource fixture']);

  const workerFile = join(base, 'inert-codex.cjs');
  // The fixture validates feedback without reading the seed or writing candidate files.
  writeFileSync(workerFile, [
    "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);",
    "process.stdin.on('end',async()=>{const messages=JSON.parse(input);const p=JSON.parse(messages.find(m=>m.role==='user').content);",
    'await new Promise(r=>setTimeout(r,' + (options.workerDelayMs ?? 0) + '));',
    "if(input.includes('UNDECLARED_SEED_DATA')||input.includes('evaluate.mjs'))process.exit(20);",
    "if(p.generation===1&&(p.feedback||p.files[0].content!=='0\\n'))process.exit(21);",
    "if(p.generation===2&&(p.feedback?.status!=='failed'||p.feedback.score!==-1||p.parentTrialId!==null||p.files[0].content!=='0\\n'))process.exit(22);",
    "if(p.generation===3&&(p.feedback?.status!=='passed'||p.feedback.score!==2||!p.parentTrialId||p.files[0].content!=='2\\n'))process.exit(23);",
    options.malformed ? "const content='invalid candidate JSON';" :
      "const content=JSON.stringify({edits:[{path:'value.json',content:String([-1,2,3][p.generation-1])+'\\n'}]});",
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:content}}));",
    options.usage === false ? "console.log(JSON.stringify({type:'turn.completed'}));" :
      "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:10}}));",
    '});',
  ].join('\n'), { mode: 0o600 });
  const pool = validateResourcePool({ schemaVersion: 1, id: 'engineering-pool', workers: [{
    id: 'codex-a', provider: 'codex', model: 'inert-fixture', maxConcurrent: 1, reservePercent: 10,
    maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1,
  }] });
  const bindings = validateResourceBindings([{ workerId: 'codex-a', capacityKey: 'shared-subscription',
    kind: 'native-cli', command: [process.execPath, workerFile] }], pool);
  const now = Date.now();
  const observations: ResourceObservation[] = [{ workerId: 'codex-a',
    observedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    health: 'ready', retryAfter: null, windows: [{ id: 'weekly', usedPercent: options.exhausted ? 100 : 20,
      resetsAt: new Date(now + 3_600_000).toISOString() }] }];
  const poolPath = join(base, 'pool.json');
  const bindingsPath = join(base, 'bindings.json');
  const observationsPath = join(base, 'observations.json');
  const ledgerRoot = join(base, 'shared-resource-ledger');
  const resourceRuntime = join(base, 'runtime.json');
  const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  writeJson(poolPath, pool); writeJson(bindingsPath, bindings); writeJson(observationsPath, observations);
  writeJson(resourceRuntime, { schemaVersion: 1, poolPath, bindingsPath, observationsPath, root: ledgerRoot, workspace });
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'resource-engineering', name: 'Resource engineering fixture',
    objective: 'Increase a value under an independent fixed evaluator',
    seed: { repo, revision: git(repo, ['rev-parse', 'HEAD']) }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: options.evaluatorTimeoutMs ?? 3_000 },
    variants: [{ id: 'resource-candidate', niche: 'value', hypothesis: 'Use measured feedback to improve the value',
      generation: { kind: 'resource-pool', poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })),
        allowedWorkerIds: ['codex-a'], files: ['value.json'], maxOutputTokens: 256 } }],
  };
  initUniverse(manifest, { root });
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: 'resource-campaign', universeId: manifest.id, feedback: true,
    budget: { maxGenerations: 3, maxDurationMs: 30_000, maxModelRequests: 3, maxStagnantGenerations: 3, maxReportedTokens: null } };
  return { root, repo, manifest, resourceRuntime, definition, ledgerRoot, pool, bindings, observations,
    directory: join(root, 'universes', manifest.id), workspace, workerFile,
    status: () => resourcePoolStatus(ledgerRoot, pool, bindings, observations) };
}

describe.runIf(process.platform === 'darwin')('resource-backed Universe end-to-end', () => {
  it('rejects a completed worker candidate, returns feedback, then independently admits and improves artifacts', async () => {
    const f = fixture();
    initUniverseCampaign(f.definition, f);
    const final = await runUniverseCampaign(f.definition.id, f);
    expect(final.sourceState, JSON.stringify(final)).toBe('healthy');
    expect(final.state, JSON.stringify(final)).toBe('completed');
    expect(final.progress).toMatchObject({ attempts: 3, completedRuns: 3, admissions: 1, improvements: 1,
      reservedModelRequests: 3, reportedTokens: 90, usageComplete: true });
    const overview = readUniverseOverview(f);
    expect(overview.sourceState, JSON.stringify(overview.reasons)).toBe('healthy');
    const universe = overview.universes[0]!;
    expect(universe.runs.map((run) => run.trials[0]!.score)).toEqual([-1, 2, 3]);
    expect(universe.runs.map((run) => run.trials[0]!.selected)).toEqual([false, true, true]);
    expect(universe.elites[0]!.score).toBe(3);
    const status = f.status();
    expect(status.attempts).toHaveLength(3);
    for (const run of universe.runs) {
      const trial = run.trials[0]!;
      expect(run.generationUsage).toMatchObject({ requestsStarted: 0, reportedRequests: 0,
        resourceAttempts: 1, resourceReportedAttempts: 1, inputTokens: 20, outputTokens: 10 });
      expect(trial.generation).toMatchObject({ provider: 'resource-pool', endpoint: null, model: null,
        status: 'succeeded', requestStarted: false,
        resource: { dispatch: 'settled', taskStatus: 'completed', workerId: 'codex-a', usageScope: 'codex-turn' } });
      const receipt = status.attempts.find((row) => row.id === trial.generation!.resource!.taskId)!;
      expect(receipt.verifiedAccepted).toBe(false);
      expect(digest(canonical(receipt))).toBe(trial.generation!.resource!.receiptDigest);
      expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
      expect(readFileSync(join(trial.artifact!.path, 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
    }
    expect(readFileSync(join(f.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(readdirSync(f.workspace)).toEqual(['.git']);
    const publicOverview = serializeUniverseConsoleOverview(overview);
    for (const run of universe.runs) expect(publicOverview).toContain(run.trials[0]!.generation!.resource!.taskId);
    for (const secret of ['resourceRuntime', 'bindingsPath', f.resourceRuntime, f.workspace, 'inert-codex.cjs']) {
      expect(publicOverview).not.toContain(secret);
    }
    expect(await runUniverseCampaign(f.definition.id, f)).toEqual(final);
    expect(f.status().attempts).toHaveLength(3);
    const records = structuredClone(readRecords(f.directory));
    for (const record of records) {
      const trials = record.kind === 'trial' ? [record.trial] : record.kind === 'final' ? record.run.trials : [];
      for (const trial of trials) if (trial.generation?.resource) trial.generation.resource.poolId = 'another-pool';
    }
    expect(() => projectUniverse(f.directory, records)).toThrow(/resource generation identity/);
  }, 25_000);

  it('pauses after one withheld admission without burning the campaign budget', async () => {
    const f = fixture({ exhausted: true });
    initUniverseCampaign(f.definition, f);
    const final = await runUniverseCampaign(f.definition.id, f);
    expect(final.sourceState, JSON.stringify(final)).toBe('healthy');
    expect(final.state).toBe('paused');
    expect(final.progress.attempts).toBe(1);
    expect(final.progress.reservedModelRequests).toBe(1);
    expect(f.status().attempts).toEqual([]);
    const run = readUniverseOverview(f).universes[0]!.runs[0]!;
    expect(run.trials[0]!.generation).toMatchObject({ status: 'failed', requestStarted: false,
      resource: { dispatch: 'withheld', taskStatus: null } });
    expect(run.trials[0]!.artifact).toBeNull();
    expect(run.tokensUsed).toBeNull();
  });

  it('stops a token-budgeted campaign when native usage is unknown', async () => {
    const f = fixture({ usage: false });
    f.definition.budget.maxReportedTokens = 1000;
    initUniverseCampaign(f.definition, f);
    const final = await runUniverseCampaign(f.definition.id, f);
    expect(final.state, JSON.stringify(final)).toBe('failed');
    expect(final.reason).toMatch(/usage is unavailable/);
    expect(final.progress).toMatchObject({ attempts: 1, usageComplete: false, reportedTokens: null });
    expect(f.status().attempts).toHaveLength(1);
    expect(readUniverseOverview(f).universes[0]!.runs[0]!.tokensUsed).toBeNull();
  });

  it('does not equate completed native output with a parseable or accepted candidate', async () => {
    const f = fixture({ malformed: true });
    const run = await runUniverse(f.manifest.id, f);
    expect(run.trials[0], JSON.stringify(run)).toMatchObject({ status: 'failed', selected: false, artifact: null,
      generation: { status: 'failed', changedFiles: [], resource: { dispatch: 'settled', taskStatus: 'completed' } } });
    expect(run.tokensUsed).toBe(30);
    expect(readUniverseOverview(f).sourceState).toBe('healthy');
    expect(f.status().attempts[0]!.status).toBe('completed');
  });

  it('fails without machine bindings and never contacts the worker', async () => {
    const f = fixture();
    const run = await runUniverse(f.manifest.id, { root: f.root });
    expect(run.trials[0]!.generation?.status).toBe('failed');
    expect(run.trials[0]!.artifact).toBeNull();
    expect(f.status().attempts).toEqual([]);
    expect(readUniverseOverview(f).sourceState).toBe('healthy');
  });

  it.each(['timeout', 'cancel'] as const)('preserves completed generation evidence when the evaluator stops: %s', async (stop) => {
    const f = fixture({ evaluatorDelayMs: 1500, evaluatorTimeoutMs: stop === 'timeout' ? 50 : 3000 });
    const controller = new AbortController();
    if (stop === 'cancel') {
      const original = verification.runVerifySubprocessAsync;
      vi.spyOn(verification, 'runVerifySubprocessAsync').mockImplementation((command, options) => {
        // Abort only once the real frozen evaluator is invoked, not during generation.
        if (command[0] === '/usr/bin/sandbox-exec') setTimeout(() => controller.abort(), 20);
        return original(command, options);
      });
    }
    const run = await runUniverse(f.manifest.id, { ...f, signal: controller.signal });
    // Cancellation can conservatively report failed if native teardown loses
    // process-group identity; it must still preserve the completed generation.
    if (stop === 'timeout') expect(run.trials[0]!.status).toBe('timed-out');
    else {
      expect(['cancelled', 'failed']).toContain(run.trials[0]!.status);
      if (run.trials[0]!.status === 'failed') expect(run.trials[0]!.error).toMatch(/termination authority lost/);
    }
    expect(run.trials[0], JSON.stringify(run)).toMatchObject({ selected: false,
      generation: { status: 'succeeded', changedFiles: ['value.json'],
        resource: { dispatch: 'settled', taskStatus: 'completed' } } });
    expect(run.trials[0]!.artifact).not.toBeNull();
    expect(readUniverseOverview(f).sourceState).toBe('healthy');
  });

  it('reports deadline completion rather than resource-attention pause when a campaign exhausts its time budget', async () => {
    const f = fixture({ workerDelayMs: 60_000 });
    initUniverseCampaign(f.definition, f);
    const original = verification.runVerifySubprocessAsync;
    let nativeTimedOut = false;
    vi.spyOn(verification, 'runVerifySubprocessAsync').mockImplementation(async (command, options) => {
      if (command[1] !== f.workerFile) return original(command, options);
      // Campaign reservation precedes native resource admission. A short wall
      // budget could expire in between under suite load, never reaching a worker.
      // Establish the real durable reservation first, then time out the actual
      // subprocess and advance only the wall clock past the persisted deadline.
      expect(f.status().attempts).toHaveLength(1);
      const deadlineAt = readUniverseCampaign(f.definition.id, f).deadlineAt;
      expect(deadlineAt).not.toBeNull();
      const result = await original(command, { ...options, timeoutMs: 50 });
      expect(result.timedOut).toBe(true);
      nativeTimedOut = true;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.parse(deadlineAt!) + 1));
      return result;
    });
    const final = await runUniverseCampaign(f.definition.id, f);
    expect(nativeTimedOut).toBe(true);
    expect(final.sourceState, JSON.stringify(final)).toBe('healthy');
    expect(final.state, JSON.stringify(final)).toBe('completed');
    expect(final.reason).toMatch(/duration budget exhausted/);
    expect(final.progress.attempts).toBe(1);
    expect(f.status().attempts).toHaveLength(1);
    expect(f.status().attempts[0]!.status).not.toBe('completed');
  });
});

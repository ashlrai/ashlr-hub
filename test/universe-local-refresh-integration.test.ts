/** Real private Git/evaluators and ephemeral HTTP fixtures; never contacts an installed model. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseOverview, requestUniverseCampaignControl, runUniverseCampaign,
  type UniverseCampaignDefinition, type UniverseManifest } from '../src/core/universe/index.js';
import { readUniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { serializeUniverseConsoleOverview } from '../src/core/web/universe-console-public.js';

const roots: string[] = [];
const servers: Server[] = [];
const MODEL = 'inert-inventory-fixture:latest';
const MODEL_DIGEST = `sha256:${'a'.repeat(64)}`;
const EVALUATOR = [
  "import {readFileSync} from 'node:fs';import {join} from 'node:path';",
  "const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));",
  'console.log(JSON.stringify({passed:Number.isInteger(value)&&value>=0&&value<=2,score:value,metrics:{value}}));',
].join('\n');

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  }).trim();
}

function tree(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? { mode: stat.mode, entries: readdirSync(path).sort().map((name) => [name, tree(join(path, name))]) }
    : { mode: stat.mode, bytes: readFileSync(path).toString('base64') };
}

async function fixture(options: { replaceDigest?: boolean } = {}) {
  const events: string[] = []; const failures: string[] = []; let chats = 0; let inventoryDigest = MODEL_DIGEST;
  const server = createServer((request, response) => {
    events.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, digest: inventoryDigest, size: 1, details: {} }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      failures.push('Unexpected fixture route'); response.statusCode = 404; response.end('{}'); return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 256 * 1024) { failures.push('Unexpected fixture request size'); request.destroy(); }
    });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const messages = JSON.parse(parsed.messages[0].content);
        const prompt = JSON.parse(messages.find((row: { role: string }) => row.role === 'user').content);
        const generation = chats + 1;
        if (parsed.model !== MODEL || parsed.stream !== false || parsed.messages.length !== 1 ||
            prompt.generation !== generation || prompt.files.length !== 1 || prompt.files[0].path !== 'value.json' ||
            prompt.files[0].content !== `${generation - 1}\n` || body.includes('UNDECLARED_SEED_DATA') || body.includes('evaluate.mjs') ||
            generation === 2 && (prompt.feedback?.status !== 'passed' || prompt.feedback.score !== 1 || !prompt.parentTrialId)) {
          throw new Error('Unexpected fixture inference contract');
        }
        chats++;
        // Change inventory only after the first real resource chat reaches this
        // fixture. The next generation must re-read identity before inference.
        if (options.replaceDigest) inventoryDigest = `sha256:${'b'.repeat(64)}`;
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
          edits: [{ path: 'value.json', content: `${generation}\n` }],
        }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      } catch {
        failures.push('Unexpected fixture inference contract'); response.statusCode = 400; response.end('{}');
      }
    });
  });
  servers.push(server);
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture endpoint unavailable');
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'universe-local-refresh-'))); roots.push(base);
  const root = join(base, 'universe-store'); const repo = join(base, 'seed'); const workspace = join(base, 'empty-workspace');
  for (const path of [repo, workspace]) {
    mkdirSync(path, { mode: 0o700 }); git(path, 'init', '-q', '--template=', '--initial-branch=main');
  }
  writeFileSync(join(repo, 'value.json'), '0\n'); writeFileSync(join(repo, 'evaluate.mjs'), EVALUATOR);
  writeFileSync(join(repo, 'private.txt'), 'UNDECLARED_SEED_DATA'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Local Refresh Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed evaluator');
  const revision = git(repo, 'rev-parse', 'HEAD');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'inventory-pool', workers: [{ id: 'local', provider: 'local', model: MODEL,
    maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'one-local-model', kind: 'local-chat', endpoint }], pool);
  const poolDigest = digest(canonical({ pool, bindings }));
  const now = Date.now();
  const observations: ResourceObservation[] = [{ workerId: 'local', health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date(now - 120_000).toISOString(), expiresAt: new Date(now - 60_000).toISOString() }];
  const localModelConfigPath = join(base, 'local-model.json'); const resourceRuntime = join(base, 'runtime.json');
  const ledgerRoot = join(base, 'pool-ledger');
  const runtime = { schemaVersion: 1, poolPath: join(base, 'pool.json'), bindingsPath: join(base, 'bindings.json'),
    observationsPath: join(base, 'observations.json'), root: ledgerRoot, workspace, localModelConfigPath };
  const configFiles = new Map<string, unknown>([[runtime.poolPath, pool], [runtime.bindingsPath, bindings],
    [runtime.observationsPath, observations], [localModelConfigPath, { schemaVersion: 1, poolDigest,
      workers: [{ workerId: 'local', modelDigest: MODEL_DIGEST }] }], [resourceRuntime, runtime]]);
  for (const [path, value] of configFiles) writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  const configBefore = new Map([...configFiles.keys()].map((path) => [path, tree(path)]));
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'local-inventory', name: 'Local inventory fixture',
    objective: 'Increase a bounded integer using a fixed independent evaluator', seed: { repo, revision },
    metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 15_000, trialTimeoutMs: 5_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
    variants: [{ id: 'advance', niche: 'value', hypothesis: 'Advance the measured integer', generation: {
      kind: 'resource-pool', poolId: pool.id, poolDigest, allowedWorkerIds: ['local'], files: ['value.json'], maxOutputTokens: 256,
    } }] };
  initUniverse(manifest, { root });
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id: 'local-campaign', universeId: manifest.id, feedback: true,
    budget: { maxGenerations: options.replaceDigest ? 3 : 2, maxDurationMs: 25_000, maxModelRequests: 3,
      maxStagnantGenerations: 3, maxReportedTokens: null } };
  initUniverseCampaign(definition, { root });
  const seedBefore = tree(repo); const workspaceBefore = tree(workspace);
  return { base, root, repo, workspace, runtime, resourceRuntime, ledgerRoot, localModelConfigPath, pool, bindings, observations,
    configBefore, seedBefore, workspaceBefore, definition, events, failures, endpoint,
    run: () => runUniverseCampaign(definition.id, { root, resourceRuntime }),
    check: () => readUniverseCampaignReadiness(definition.id, { root }),
    status: () => resourcePoolStatus(ledgerRoot, pool, bindings, observations) };
}

function verifyBoundaries(value: Awaited<ReturnType<typeof fixture>>): void {
  expect(value.failures).toEqual([]);
  expect(tree(value.repo)).toEqual(value.seedBefore);
  expect(tree(value.workspace)).toEqual(value.workspaceBefore);
  for (const [path, before] of value.configBefore) expect(tree(path)).toEqual(before);
  const overview = readUniverseOverview({ root: value.root });
  expect(overview.sourceState, JSON.stringify(overview.reasons)).toBe('healthy');
  const publicData = serializeUniverseConsoleOverview(overview);
  const report = JSON.stringify(value.check());
  // The authenticated overview intentionally retains seed/artifact paths, but
  // never the separate resource-runtime bindings. Readiness contains no paths.
  expect(report).not.toContain(value.base);
  for (const hidden of [value.localModelConfigPath, value.resourceRuntime, value.runtime.bindingsPath,
    value.workspace, value.endpoint, '"localModelConfigPath"', '"resourceRuntime"', 'UNDECLARED_SEED_DATA']) {
    expect(publicData).not.toContain(hidden); expect(report).not.toContain(hidden);
  }
}

describe.runIf(process.platform === 'darwin')('Universe resource generation with explicit local inventory refresh', () => {
  it('refreshes stale inventory once per generation, improves verified artifacts, and makes no terminal-rerun contacts', async () => {
    const value = await fixture();
    const summary = await value.run();
    expect(summary.state, JSON.stringify(summary)).toBe('completed');
    expect(summary.progress).toMatchObject({ attempts: 2, completedRuns: 2, reservedModelRequests: 2,
      admissions: 1, improvements: 1, reportedTokens: 60, recordedTokens: 60, usageComplete: true });
    expect(value.events).toEqual(['GET /api/tags', 'POST /v1/chat/completions', 'GET /api/tags', 'POST /v1/chat/completions']);
    const universe = readUniverseOverview({ root: value.root }).universes[0]!;
    expect(universe.runs.map((run) => run.trials[0]!.score)).toEqual([1, 2]);
    const receipts = value.status().attempts;
    expect(receipts).toHaveLength(2);
    for (const run of universe.runs) {
      expect(run.generationUsage).toMatchObject({ requestsStarted: 0, reportedRequests: 0,
        resourceAttempts: 1, resourceReportedAttempts: 1, inputTokens: 20, outputTokens: 10 });
      const trial = run.trials[0]!;
      expect(trial).toMatchObject({ status: 'passed', selected: true, generation: { status: 'succeeded', requestStarted: false,
        resource: { dispatch: 'settled', taskStatus: 'completed', workerProvider: 'local', usageScope: 'local-chat-completion' } } });
      const receipt = receipts.find((row) => row.id === trial.generation!.resource!.taskId)!;
      expect(receipt).toMatchObject({ status: 'completed', inputTokens: 20, outputTokens: 10, verifiedAccepted: false });
      expect(digest(canonical(receipt))).toBe(trial.generation!.resource!.receiptDigest);
      expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
      expect(readFileSync(join(trial.artifact!.path, 'value.json'), 'utf8')).toBe(`${run.generation}\n`);
      expect(readFileSync(join(trial.artifact!.path, 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
    }
    expect(value.check()).toMatchObject({ sourceState: 'healthy', disposition: 'terminal', automaticAction: 'none' });
    const contacts = [...value.events]; const before = tree(value.root);
    expect(await value.run()).toEqual(summary);
    expect(value.events).toEqual(contacts); expect(value.status().attempts).toEqual(receipts);
    expect(tree(value.root)).toEqual(before); verifyBoundaries(value);
  }, 30_000);

  it('withholds the second chat after model identity changes and preserves both generation reservations without a third attempt', async () => {
    const value = await fixture({ replaceDigest: true });
    const summary = await value.run();
    expect(summary.state, JSON.stringify(summary)).toBe('paused');
    expect(summary.progress).toMatchObject({ attempts: 2, reservedModelRequests: 2, recordedTokens: 30, reportedTokens: 30, usageComplete: true });
    expect(value.events).toEqual(['GET /api/tags', 'POST /v1/chat/completions', 'GET /api/tags']);
    expect(value.status().attempts).toHaveLength(1);
    const universe = readUniverseOverview({ root: value.root }).universes[0]!;
    expect(universe.runs).toHaveLength(2);
    expect(universe.runs[1]!.trials[0]).toMatchObject({ status: 'failed', selected: false, artifact: null,
      generation: { requestStarted: false, usage: { state: 'unavailable', inputTokens: null, outputTokens: null },
        resource: { dispatch: 'withheld', taskStatus: null } } });
    const before = tree(value.root); const contacts = [...value.events];
    expect(value.check()).toMatchObject({ sourceState: 'healthy', disposition: 'resource-withheld', reasonCode: 'resource-withheld', automaticAction: 'none' });
    expect(value.events).toEqual(contacts); expect(tree(value.root)).toEqual(before);
    verifyBoundaries(value);
  }, 30_000);

  it('reports an explicit owner pause without inventory, inference, or check-side ledger changes', async () => {
    const value = await fixture();
    expect(requestUniverseCampaignControl(value.definition.id, 'pause', { root: value.root }).state).toBe('paused');
    const before = tree(value.root);
    for (let index = 0; index < 2; index++) {
      expect(value.check()).toMatchObject({ sourceState: 'healthy', disposition: 'owner-held', reasonCode: 'owner-paused', automaticAction: 'none' });
    }
    expect(value.events).toEqual([]); expect(value.status().attempts).toEqual([]);
    expect(tree(value.root)).toEqual(before); verifyBoundaries(value);
  }, 30_000);
});

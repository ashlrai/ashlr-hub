/** Actual CLI responsiveness during successor proof/preparation. No provider calls. */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { readUniverseCampaign, campaignUniverse } from '../src/core/universe/campaign-store.js';
import { readCompletedCampaignDelivery } from '../src/core/universe/campaign-delivery-recovery.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import type { ResourceConsoleEngineeringCatalog } from '../src/core/resources/console-engineering.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot } from '../src/core/resources/console-engineering-supervisor-types.js';
import type { ResourceEngineeringSuccessorCoordinatorSnapshot } from '../src/core/resources/engineering-successor-coordinator-types.js';

const cleanups: Array<() => Promise<void>> = [];
const measurements: Array<Record<string, string | number | null>> = [];
const point = (phase: string) => { if (measurements.length < 32) measurements.push({ phase, monotonicMs: performance.now() }); };
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { console.log('RESPONSIVENESS_MEASUREMENTS ' + JSON.stringify(measurements.splice(0))); }
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
const childEnv = () => ({ ...process.env, HOME: homedir(), USERPROFILE: homedir(), ASHLR_HOME: process.env.ASHLR_HOME ?? join(homedir(), '.ashlr'),
  TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1', GIT_OPTIONAL_LOCKS: '0' });
type SetupReport = { status: 'planned' | 'prepared'; disposition?: 'created' | 'replayed'; planDigest: string; output: string;
  projectId: string; seedRevision: string; initialEnrollmentDigest: string | null; consoleArguments?: string[];
  paths: { registration: string }; executionStarted: false; providerContacted: false };
type Generation = { generation: number; parentTrialId: string | null; files: Array<{ path: string; content: string }>;
  seedContext: { source: { campaignId: string }; measurement: { passed: boolean; score: number } }; feedback?: unknown };

async function fixture() {
  expect(process.env.ASHLR_VITEST_REAL_HOME).toBeTruthy(); expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-responsiveness-')));
  const repo = join(base, 'project'); const transport = join(base, 'transport'); const root = join(base, 'ledger'); const output = join(base, 'setup');
  for (const file of [repo, transport, output]) mkdirSync(file, { mode: 0o700 });
  git(repo, 'init', '-q', '--template=', '--initial-branch=main'); git(transport, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'evaluate.mjs'), "import{readFileSync}from'node:fs';import{join}from'node:path';const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));const passed=Number.isInteger(value)&&value>=0&&value<=4;console.log(JSON.stringify({passed,score:passed?value:0,metrics:{value},diagnostics:[]}));");
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=Setup Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed passing seed');
  const revision = git(repo, 'rev-parse', 'HEAD'); const generations: Generation[] = []; const proposals: unknown[] = []; const errors: string[] = [];
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); const raw = JSON.parse(input.messages[0].content);
        const context = Array.isArray(raw) ? JSON.parse(raw.find((row: { role: string }) => row.role === 'user').content) : raw;
        let content: unknown;
        if (context.seedContext) {
          const generation = context as Generation; generations.push(generation);
          point(`generation-${generations.length}`);
          const value = JSON.parse(generation.files.find(row => row.path === 'value.json')!.content) as number;
          expect(value).toBe(generations.length - 1); expect(generation.seedContext.measurement).toMatchObject({ passed: true, score: value < 2 ? 0 : 2 });
          expect(generation.generation).toBe(value % 2 + 1);
          if (value % 2 === 0) expect(generation.parentTrialId).toBeNull();
          else { expect(generation.parentTrialId).toBeTruthy(); expect(generation.feedback).toBeDefined(); }
          content = { operations: [{ op: 'replace', path: 'value.json', content: `${value + 1}\n` }] };
        } else {
          proposals.push(context); expect(generations).toHaveLength(2); expect(context.kind).toBe('engineering-successor-proposal');
          point('proposal');
          expect(JSON.parse(context.source.context)).toMatchObject({ source: { delivered: { score: 2, deltaFromParent: 1 },
            files: [{ path: 'value.json', text: '2\n', truncated: false }] } });
          expect(readFileSync(join(repo, 'value.json'), 'utf8')).toBe('0\n');
          content = { action: 'propose', name: 'Improve verified result again', objective: 'Increase the fixed measured score beyond two.' };
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      } catch { errors.push('Fixture protocol expectation failed'); res.writeHead(500); res.end('Fixture protocol refused'); }
    });
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve()));
    const writable = (file: string): void => { const stat = lstatSync(file); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      chmodSync(file, 0o700); for (const name of readdirSync(file)) writable(join(file, name)); };
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  const address = worker.address(); if (!address || typeof address === 'string') throw Error('Missing test listener');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'setup-fixture', workers: ['repair', 'spare'].map(id => ({
    id, provider: 'local', model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 8, taskWindowMs: 600_000, reservePercent: 0, priority: 1 })) });
  const bindings = validateResourceBindings(pool.workers.map(row => ({ workerId: row.id, capacityKey: `${row.id}-account`,
    kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` })), pool);
  const observations = pool.workers.map(row => ({ workerId: row.id, health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 290_000).toISOString() }));
  const files = { pool: join(base, 'pool.json'), bindings: join(base, 'bindings.json'), observations: join(base, 'observations.json'),
    projects: join(base, 'projects.json'), runtime: join(base, 'runtime.json'), recipe: join(base, 'recipe.json'), policy: join(base, 'policy.json') };
  save(files.pool, pool); save(files.bindings, bindings); save(files.observations, observations); save(files.projects, { schemaVersion: 1, projects: [] });
  save(files.runtime, { schemaVersion: 1, root, workspace: transport, poolPath: files.pool, bindingsPath: files.bindings, observationsPath: files.observations, capacityWaitMs: 1000 });
  const previous = await createResourcePoolSupervisor({ root, pool, bindings, workspace: repo, projects: [], readObservations: () => observations }); await previous.close();
  const allocation = setResourcePoolAllocation(root, pool, bindings, 70, 0); const workerAccess = setResourceWorkerAccess(root, pool, bindings, ['spare'], 0); loadOrCreateKey();
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'campaign-a', name: 'First evaluated improvement', objective: 'Improve the measured value twice',
    projectId: 'default', seedRevision: revision, metric: { name: 'value', direction: 'maximize', minImprovement: 1 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 30_000, trialTimeoutMs: 15_000 },
    campaignBudget: { maxGenerations: 2, maxDurationMs: 90_000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: 60 },
    generation: { files: ['value.json'], contextFiles: [], allowedWorkerIds: ['repair'], maxOutputTokens: 256,
      hypotheses: [{ id: 'improve', niche: 'value', hypothesis: 'Improve fixed score by one' }] }, delivery: { branch: 'codex/campaign-a' },
    execution: { maxDurationMs: 100_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
    supervision: { maxDurationMs: 360_000, pollIntervalMs: 100, maxAttemptsPerEnrollment: 3 } };
  save(files.recipe, recipe); save(files.policy, { schemaVersion: 1, id: 'setup-queue', profileId: 'fixed-profile', label: 'Fixed integer experiment',
    acceptance: 'Only value.json may change; the fixed integer evaluator applies.', maxEnrollments: 2, maxConcurrent: 1,
    successors: { allowedWorkerIds: ['repair'], maxOutputTokens: 256, proposalTimeoutMs: 30_000, maxSuccessors: 1, pollIntervalMs: 100 } });
  return { base, root, repo, transport, output, revision, files, recipe, pool, bindings, observations, allocation, workerAccess, generations, proposals, errors };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function setupCli(f: Fixture, extra: string[]) {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli/index.ts',
    'resources', 'pool', 'engineering', 'setup', '--recipe', f.files.recipe, '--policy', f.files.policy, '--output', f.output,
    '--resource-runtime', f.files.runtime, '--workspace', f.repo, '--projects', f.files.projects, '--json', ...extra],
  { timeout: 90_000, maxBuffer: 256 * 1024, env: childEnv() });
  expect(stderr).toBe(''); return JSON.parse(stdout) as SetupReport;
}
async function until(check: (deadlineMonotonicMs: number) => Promise<boolean>, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (!await check(deadline)) { if (performance.now() >= deadline) throw Error('Setup acceptance condition not reached'); await new Promise(resolve => setTimeout(resolve, 500)); }
}
function delivered(f: Fixture, id: string) {
  const catalog = JSON.parse(readFileSync(join(f.output, id, 'engineering.json'), 'utf8')) as ResourceConsoleEngineeringCatalog;
  const host = catalog.enrollments[0]!.host; const target = host.deliveryPlan.deliveries[0]!;
  const campaign = readUniverseCampaign(target.campaignId, { root: host.root }); const receipt = readCompletedCampaignDelivery(campaign, target, { root: host.root });
  if (!receipt) throw Error('Missing verified local delivery');
  const universe = campaignUniverse(campaign, { root: host.root });
  expect(campaign.seedEvaluation?.result?.status).toBe('measured'); expect(universe.runs).toHaveLength(2);
  expect(universe.runs.every(run => run.status === 'completed' && run.trials.length === 1 && run.trials[0]!.status === 'passed')).toBe(true);
  expect(git(f.repo, 'rev-parse', `refs/heads/${target.branch}`)).toBe(receipt.commit);
  return { receipt, campaign, universe };
}


type ReadResult = { status: number | null; body: unknown; error: string | null; elapsedMs: number };
async function consoleCli(argv: string[], overallDeadline: number) {
  const extra = [...(argv.includes('--json') ? [] : ['--json']), ...(argv.includes('--port') ? [] : ['--port', '0'])];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...argv, ...extra], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let exited = false; let exitCode: number | null = null;
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => { exited = true; exitCode = code; resolve(); });
  });
  child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 128 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 128 * 1024) child.kill('SIGKILL'); });
  cleanups.push(async () => { if (!exited) { child.kill('SIGKILL'); await exit; } });
  await until(async () => stdout.includes('\n') || exited, 45_000);
  const startup = JSON.parse(stdout.split('\n')[0]!) as { url: string; readToken: string; controlToken: string };
  if (!startup.url || typeof startup.readToken !== 'string' || typeof startup.controlToken !== 'string') throw Error('Console startup unavailable');
  // Fresh connection each time, no transport recovery or repeated mutations.
  // A 90s observation ceiling records the known ~73s baseline stall; the actual
  // responsiveness assertion remains 2s and does not inherit this ceiling.
  async function request(phase: string, path: string, body?: unknown): Promise<ReadResult> {
    const started = performance.now(); const deadline = Math.min(overallDeadline, started + 90_000);
    const result = await new Promise<ReadResult>(resolve => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      let settled = false;
      const finish = (status: number | null, value: unknown, error: string | null) => {
        if (settled) return; settled = true;
        resolve({ status, body: value, error, elapsedMs: performance.now() - started });
      };
      const req = httpRequest(startup.url + path, { agent: false, method: bytes === undefined ? 'GET' : 'POST',
        headers: { connection: 'close', 'x-ashlr-token': bytes === undefined ? startup.readToken : startup.controlToken,
          ...(bytes === undefined ? {} : { origin: startup.url, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bytes)) }) } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 256 * 1024) req.destroy(Error('Response bound')); else chunks.push(chunk); });
        response.once('error', () => finish(null, null, 'RESPONSE_ERROR'));
        response.once('end', () => {
          try {
            if (!response.complete || performance.now() >= deadline) throw Error('Incomplete response');
            finish(response.statusCode ?? null, JSON.parse(Buffer.concat(chunks).toString('utf8')), null);
          } catch { finish(response.statusCode ?? null, null, 'INVALID_RESPONSE'); }
        });
      });
      const timer = setTimeout(() => req.destroy(Object.assign(Error('Observation ceiling'), { code: 'OBSERVATION_TIMEOUT' })), Math.max(0, deadline - performance.now()));
      req.once('close', () => clearTimeout(timer));
      req.once('error', error => { const code = (error as NodeJS.ErrnoException).code;
        finish(null, null, typeof code === 'string' && /^[A-Z_0-9]+$/.test(code) ? code : 'TRANSPORT_ERROR'); });
      req.end(bytes);
    });
    if (measurements.length < 32) measurements.push({ phase, startMs: started, endMs: performance.now(), elapsedMs: result.elapsedMs,
      status: result.status, error: result.error, childExited: exited ? 1 : 0 });
    return result;
  }
  return { request, close: async () => {
    const started = performance.now(); if (!exited) child.kill('SIGTERM');
    await until(async () => exited, 20_000); await exit;
    measurements.push({ phase: 'close', elapsedMs: performance.now() - started, exitCode, stderrBytes: Buffer.byteLength(stderr) });
    expect(exitCode).toBe(0); expect(stderr).toBe('');
  } };
}
async function durableUntil<T>(read: () => T | null, timeoutMs: number): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const value = read(); if (value !== null) return value;
    if (performance.now() >= deadline) throw Error('Durable responsiveness phase unavailable');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.runIf(process.platform === 'darwin')('actual console responsiveness during successor preparation', () => {
  it('serves fresh status and accepts pause within two seconds without admitting B', async () => {
    const overallDeadline = performance.now() + 360_000;
    const f = await fixture(); const before = tree(f.base);
    point('check.start'); const plan = await setupCli(f, ['--check']); point('check.end');
    expect(tree(f.base)).toEqual(before); expect(f.generations).toEqual([]); expect(f.proposals).toEqual([]);
    point('setup.start'); const prepared = await setupCli(f, ['--expected-plan-digest', plan.planDigest]); point('setup.end');
    const console = await consoleCli(prepared.consoleArguments!, overallDeadline); point('console.ready');
    const initialResponse = await console.request('initial-status', '/api/resources/engineering-supervision');
    expect(initialResponse.status).toBe(200);
    const initial = initialResponse.body as ResourceConsoleEngineeringSupervisionSnapshot;
    expect(initial.entries).toHaveLength(1);
    const records = join(f.root, 'engineering-successors', 'setup-queue', 'events', 'records');
    const key = await durableUntil(() => {
      if (!existsSync(records)) return null;
      const file = readdirSync(records).find(name => /^intent-[a-f0-9]{48}\.json$/.test(name));
      if (!file) return null;
      const row = JSON.parse(readFileSync(join(records, file), 'utf8')) as { kind: string; key: string };
      if (row.kind !== 'intent' || !/^[a-f0-9]{48}$/.test(row.key)) throw Error('Invalid durable proposal intent');
      return row.key;
    }, 180_000);
    point('proposal-intent-durable');
    const admissionHealth = console.request('proposal-admission-health', '/health');
    const admissionStatus = console.request('proposal-admission-status', '/api/resources/engineering-successors');
    await durableUntil(() => existsSync(join(records, `result-${key}.json`)) ? true : null, 90_000);
    point('proposal-result-durable');
    const sourceHealth = console.request('source-proof-health', '/health');
    const sourceStatus = console.request('source-proof-status', '/api/resources/engineering-successors');
    const successorId = 'successor-' + key;
    await durableUntil(() => existsSync(join(f.output, successorId, 'intent.json')) ? true : null, 90_000);
    point('successor-bundle-intent-durable');
    const [health, status, pause, sourceHealthResult, sourceStatusResult, admissionHealthResult, admissionStatusResult] = await Promise.all([
      console.request('preparation-health', '/health'),
      console.request('preparation-status', '/api/resources/engineering-successors'),
      console.request('preparation-pause', '/api/resources/engineering-supervision', { paused: true, expectedRevision: initial.revision }),
      sourceHealth, sourceStatus, admissionHealth, admissionStatus,
    ]);
    const afterResponse = await console.request('after-pause-status', '/api/resources/engineering-supervision');
    const phaseResponse = await console.request('after-pause-successors', '/api/resources/engineering-successors');
    const after = afterResponse.body as ResourceConsoleEngineeringSupervisionSnapshot;
    const phases = phaseResponse.body as ResourceEngineeringSuccessorCoordinatorSnapshot;
    measurements.push({ phase: 'terminal-evidence', generations: f.generations.length, proposals: f.proposals.length,
      enrolled: after?.entries?.length ?? -1, paused: after?.paused === true ? 1 : 0,
      successorState: phases?.entries?.[0]?.state ?? 'unknown' });
    await console.close();
    // Assert once observations and cleanup are captured, so a baseline failure
    // reports real stall duration instead of cutting off measurement at 2s.
    for (const sample of [admissionHealthResult, admissionStatusResult, sourceHealthResult, sourceStatusResult, health, status, pause]) {
      expect.soft(sample.error).toBeNull(); expect.soft(sample.status).toBe(200); expect.soft(sample.elapsedMs).toBeLessThanOrEqual(2000);
    }
    expect(afterResponse.status).toBe(200); expect(after.paused).toBe(true); expect(after.deadlineAt).toBe(initial.deadlineAt);
    expect(after.entries).toHaveLength(1); expect(phases.entries[0]?.state).not.toBe('admitted');
    expect(f.errors).toEqual([]); expect(f.generations).toHaveLength(2); expect(f.proposals).toHaveLength(1);
    delivered(f, f.recipe.id);
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort()).toEqual(['refs/heads/codex/campaign-a', 'refs/heads/main']);
    const ledger = resourcePoolStatus(f.root, f.pool, f.bindings, f.observations);
    expect(ledger.attempts).toHaveLength(3); expect(ledger.attempts.every(row => row.status === 'completed')).toBe(true);
    expect(ledger.attempts.reduce((sum, row) => sum + row.inputTokens! + row.outputTokens!, 0)).toBe(90);
    expect(ledger.allocation).toEqual(f.allocation); expect(ledger.workerAccess).toEqual(f.workerAccess);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
  }, 360_000);
});

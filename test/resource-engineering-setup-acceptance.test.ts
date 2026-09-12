/** Actual offline setup CLI -> emitted foreground console -> accounted A/proposal/B.
 * Everything uses private test repositories, HOME, and a loopback response fixture. */
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
const point = (phase: string, details?: Record<string, number>) => { if (process.env.ASHLR_ENGINEERING_SETUP_PHASE_TIMING === '1') console.log('SETUP_PHASE ' + JSON.stringify({ phase, monotonicMs: performance.now(), ...details })); };
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-setup-acceptance-')));
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
async function consoleCli(consoleArguments: string[], recovery: { count: number; deadlineMonotonicMs: number }) {
  // Only operational handshake/ephemeral-port flags are added. Every emitted
  // configuration argument is passed unchanged to the real source CLI.
  const extra = [...(consoleArguments.includes('--json') ? [] : ['--json']), ...(consoleArguments.includes('--port') ? [] : ['--port', '0'])];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...consoleArguments, ...extra], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let exited = false; let outputLimit = false;
  let exitCode: number | null = null; let exitSignal: NodeJS.Signals | null = null;
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => {
    exited = true; exitCode = code; exitSignal = signal; resolve(code);
  }); });
  child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 128 * 1024) { outputLimit = true; child.kill('SIGKILL'); } });
  child.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 128 * 1024) { outputLimit = true; child.kill('SIGKILL'); } });
  cleanups.push(async () => { if (!exited) { child.kill('SIGKILL'); await exit; } });
  await until(async () => stdout.includes('\n') || exited, 45_000);
  let startup: { url: string; readToken: string; port: number };
  try { startup = JSON.parse(stdout.split('\n')[0]!); } catch { throw Error('Console CLI did not emit valid startup metadata'); }
  if (!startup.url || !Number.isInteger(startup.port) || typeof startup.readToken !== 'string') throw Error('Console CLI startup unavailable');
  async function read<T>(path: string, deadlineMonotonicMs = recovery.deadlineMonotonicMs): Promise<T> {
    const startedAt = performance.now();
    try {
      const response = await fetch(`${startup.url}${path}`, { headers: { 'x-ashlr-token': startup.readToken } });
      expect(response.status).toBe(200); return await response.json() as T;
    } catch (error) {
      const elapsedMs = performance.now() - startedAt;
      const cause = error instanceof Error ? error.cause : undefined;
      const causeCode = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Z_0-9]+$/.test(cause.code) ? cause.code : null;
      // Never print startup stdout: it contains private session credentials.
      // At most one observational recovery across both console lifetimes. It
      // cannot retry a setup, proposal, generation, admission or delivery.
      await new Promise(resolve => setTimeout(resolve, 50));
      let recoveryFailure: string | null = null;
      const recoveryDeadline = Math.min(deadlineMonotonicMs, recovery.deadlineMonotonicMs);
      if (causeCode === 'ECONNRESET' && !exited && !outputLimit && recovery.count === 0 && performance.now() < recoveryDeadline &&
        ['/api/resources/engineering-supervision', '/api/resources/engineering-successors'].includes(path)) {
        recovery.count++;
        const freshAttemptDeadline = Math.min(performance.now() + 5000, recoveryDeadline);
        try {
          const fresh = await new Promise<T>((resolve, reject) => {
            const request = httpRequest(`${startup.url}${path}`, { agent: false, headers: { connection: 'close', 'x-ashlr-token': startup.readToken } }, response => {
              const chunks: Buffer[] = []; let size = 0;
              response.on('data', (chunk: Buffer) => { size += chunk.length;
                if (size > 256 * 1024) request.destroy(Error('Recovery response exceeds bound')); else chunks.push(chunk); });
              response.once('error', reject);
              response.once('end', () => {
                try {
                  if (response.statusCode !== 200 || !response.complete) throw Error('Incomplete recovery response');
                  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid recovery snapshot');
                  resolve(value as T);
                } catch (error) { reject(error); }
              });
            });
            const timeout = setTimeout(() => request.destroy(Error('Recovery deadline')), Math.max(0, freshAttemptDeadline - performance.now()));
            request.once('close', () => clearTimeout(timeout)); request.once('error', reject); request.end();
          });
          if (performance.now() >= freshAttemptDeadline) throw Error('Recovery deadline');
          point('read-recovery', { count: recovery.count, elapsedMs: performance.now() - startedAt });
          return fresh;
        } catch { recoveryFailure = 'fresh-read-unavailable'; }
      }
      const summary = stderr.slice(0, 4096).replaceAll(startup.readToken, '[token]')
        .replace(/\/[\w./@%-]+/g, '[path]').replace(/[A-Za-z0-9_=-]{24,}/g, '[opaque]');
      throw Error('Console read failed: ' + JSON.stringify({ elapsedMs, causeCode, exited, exitCode, exitSignal, outputLimit,
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stderrSummary: summary, recoveryCount: recovery.count, recoveryFailure }));
    }
  }
  return { read, close: async () => { if (!exited) child.kill('SIGTERM'); await until(async () => exited, 20_000); expect(await exit).toBe(0); expect(stderr).toBe(''); } };
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

describe.runIf(process.platform === 'darwin')('offline autonomous engineering setup actual CLI', () => {
  it('checks without effects, registers a coherent seed, executes emitted arguments and restarts without replay', async () => {
    const recovery = { count: 0, deadlineMonotonicMs: performance.now() + 360_000 };
    const f = await fixture(); const before = tree(f.base); const homeBefore = tree(homedir());
    point('check.start'); const plan = await setupCli(f, ['--check']); point('check.end');
    expect(plan).toMatchObject({ status: 'planned', output: f.output, projectId: 'default', seedRevision: f.revision, initialEnrollmentDigest: null,
      executionStarted: false, providerContacted: false });
    expect(tree(f.base)).toEqual(before); expect(tree(homedir())).toEqual(homeBefore); expect(f.generations).toEqual([]); expect(f.proposals).toEqual([]);
    const stateBefore = readFileSync(join(f.root, 'resource-console-state.json')); const ledgerBefore = readFileSync(join(f.root, 'pool-state.json'));
    point('prepare.start'); const prepared = await setupCli(f, ['--expected-plan-digest', plan.planDigest]); point('prepare.end');
    expect(prepared).toMatchObject({ status: 'prepared', disposition: 'created', planDigest: plan.planDigest, executionStarted: false, providerContacted: false });
    expect(prepared.initialEnrollmentDigest).toMatch(/^[a-f0-9]{64}$/); const argv = prepared.consoleArguments!;
    expect(JSON.parse(readFileSync(prepared.paths.registration, 'utf8'))).toMatchObject({ request: { id: f.recipe.id }, enrollmentDigest: prepared.initialEnrollmentDigest });
    expect(argv.slice(0, 3)).toEqual(['resources', 'pool', 'console']);
    for (const flag of ['--execute', '--engineering-preparation', '--engineering-supervision', '--engineering-successors']) expect(argv).toContain(flag);
    expect(argv).not.toContain('--engineering');
    expect(readFileSync(join(f.root, 'resource-console-state.json'))).toEqual(stateBefore); expect(readFileSync(join(f.root, 'pool-state.json'))).toEqual(ledgerBefore);
    expect(existsSync(join(f.root, 'engineering-supervision'))).toBe(false); expect(existsSync(join(f.root, 'engineering-successors'))).toBe(false);
    expect(f.generations).toEqual([]); expect(f.proposals).toEqual([]); expect(tree(homedir())).toEqual(homeBefore);
    const setupBeforeStart = tree(f.output); expect((await setupCli(f, ['--expected-plan-digest', plan.planDigest])).disposition).toBe('replayed');
    expect(tree(f.output)).toEqual(setupBeforeStart);
    const firstStartAt = Date.now();
    point('first-start.start'); const first = await consoleCli(argv, recovery); point('first-start.end');
    const initial = await first.read<ResourceConsoleEngineeringSupervisionSnapshot>('/api/resources/engineering-supervision');
    expect(initial.entries).toHaveLength(1); expect(initial.entries[0]).toMatchObject({ enrollmentId: f.recipe.id, enrollmentDigest: prepared.initialEnrollmentDigest });
    const originalDeadline = initial.deadlineAt;
    let state = initial;
    await until(async deadline => { state = await first.read('/api/resources/engineering-supervision', deadline); return state.entries.length === 2 && state.entries.every(row => row.state === 'completed'); }, 300_000);
    point('both-delivered');
    const sampleStartedAt = Date.now();
    const successors = await first.read<ResourceEngineeringSuccessorCoordinatorSnapshot>('/api/resources/engineering-successors');
    const sampleFinishedAt = Date.now();
    expect(successors.entries).toHaveLength(1); expect(successors.entries[0]).toMatchObject({ sourceEnrollmentId: f.recipe.id, state: 'admitted' });
    expect(successors).toMatchObject({ state: 'observing', supervisionId: 'setup-queue',
      observation: { kind: 'durable-journal', workerState: 'connected' } });
    const sampledAt = Date.parse(successors.observation!.sampledAt);
    expect(new Date(sampledAt).toISOString()).toBe(successors.observation!.sampledAt);
    expect(sampledAt).toBeGreaterThanOrEqual(sampleStartedAt); expect(sampledAt).toBeLessThanOrEqual(sampleFinishedAt);
    expect(successors.observation!.coordinator).toMatchObject({ schemaVersion: 1, supervisionId: successors.supervisionId,
      configDigest: successors.configDigest, deadlineAt: originalDeadline, state: 'running', reason: null });
    expect(successors.observation!.coordinator!.sequence).toBeGreaterThan(0);
    expect(Date.parse(successors.observation!.coordinator!.reportedAt)).toBeGreaterThanOrEqual(firstStartAt);
    expect(Date.parse(successors.observation!.coordinator!.reportedAt)).toBeLessThanOrEqual(sampleFinishedAt);
    expect(successors.entries[0]!.reason).toBeNull();
    const journalDirectory = join(f.root, 'engineering-successors', 'setup-queue', 'events', 'records');
    const journalRecords = readdirSync(journalDirectory).sort().map(name => JSON.parse(readFileSync(join(journalDirectory, name), 'utf8')));
    expect(journalRecords.map(row => row.kind)).toEqual(['admitted', 'enrollment', 'intent', 'prepared', 'result']);
    expect(successors.observation!.recordsDigest).toBe(digest(canonical(journalRecords)));
    expect(successors.deadlineAt).toBe(originalDeadline); const successorId = successors.entries[0]!.successorId;
    await first.close();
    const a = delivered(f, f.recipe.id); const b = delivered(f, successorId);
    expect(b.universe.manifest.seed.revision).toBe(a.receipt.commit);
    expect([a, b].reduce((sum, row) => sum + (row.campaign.seedEvaluation?.result?.status === 'measured' ? 1 : 0) +
      row.universe.runs.reduce((count, run) => count + run.trials.length, 0), 0)).toBe(6);
    expect(git(f.repo, 'show', `${b.receipt.commit}:value.json`)).toBe('4'); expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision);
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort()).toEqual([
      'refs/heads/main', 'refs/heads/codex/campaign-a', `refs/heads/codex/${successorId}`,
    ].sort());
    expect(git(f.repo, 'status', '--porcelain=v1')).toBe(''); expect(f.errors).toEqual([]); expect(f.generations).toHaveLength(4); expect(f.proposals).toHaveLength(1);
    expect(f.generations.map(row => row.seedContext.measurement.score)).toEqual([0, 0, 2, 2]);
    expect(f.generations.map(row => row.seedContext.source.campaignId)).toEqual([f.recipe.id, f.recipe.id, successorId, successorId]);
    expect(state.entries.every(row => row.attempts === 1)).toBe(true);
    const ledger = resourcePoolStatus(f.root, f.pool, f.bindings, f.observations);
    expect(ledger.attempts).toHaveLength(5); expect(ledger.attempts.every(row => row.status === 'completed' && row.workerId === 'repair')).toBe(true);
    expect(ledger.allocation).toEqual(f.allocation); expect(ledger.workerAccess).toEqual(f.workerAccess);
    expect(ledger.attempts.every(row => row.inputTokens !== null && row.outputTokens !== null)).toBe(true);
    expect(ledger.attempts.reduce((sum, row) => sum + row.inputTokens! + row.outputTokens!, 0)).toBe(150);
    const after = tree(f.output); const restartStartedAt = Date.now();
    point('restart.start'); const restarted = await consoleCli(argv, recovery); point('restart.end');
    const again = await restarted.read<ResourceConsoleEngineeringSupervisionSnapshot>('/api/resources/engineering-supervision');
    expect(again.deadlineAt).toBe(originalDeadline); expect(again.entries).toEqual(state.entries);
    const restartSampleStartedAt = Date.now();
    const observedAgain = await restarted.read<ResourceEngineeringSuccessorCoordinatorSnapshot>('/api/resources/engineering-successors');
    const restartSampleFinishedAt = Date.now();
    expect(observedAgain.entries).toEqual(successors.entries);
    expect(observedAgain).toMatchObject({ state: 'observing', configDigest: successors.configDigest, deadlineAt: originalDeadline,
      observation: { kind: 'durable-journal', workerState: 'connected', recordsDigest: successors.observation!.recordsDigest } });
    expect(Date.parse(observedAgain.observation!.sampledAt)).toBeGreaterThanOrEqual(restartSampleStartedAt);
    expect(Date.parse(observedAgain.observation!.sampledAt)).toBeLessThanOrEqual(restartSampleFinishedAt);
    expect(observedAgain.observation!.coordinator).toMatchObject({ schemaVersion: 1, supervisionId: successors.supervisionId,
      configDigest: successors.configDigest, deadlineAt: originalDeadline });
    // Reports are process-local: restart supplies new evidence, not the old
    // running transition or a renewed campaign deadline.
    expect(observedAgain.observation!.coordinator!.sequence).toBeGreaterThan(0);
    expect(Date.parse(observedAgain.observation!.coordinator!.reportedAt)).toBeGreaterThanOrEqual(restartStartedAt);
    expect(Date.parse(observedAgain.observation!.coordinator!.reportedAt)).toBeLessThanOrEqual(restartSampleFinishedAt);
    await restarted.close(); expect(f.generations).toHaveLength(4); expect(f.proposals).toHaveLength(1); expect(tree(f.output)).toEqual(after);
    expect(resourcePoolStatus(f.root, f.pool, f.bindings, f.observations).attempts).toEqual(ledger.attempts);
    const finalBefore = tree(f.base); expect((await setupCli(f, ['--expected-plan-digest', plan.planDigest])).disposition).toBe('replayed');
    expect(tree(f.base)).toEqual(finalBefore);
  }, 360_000);
});

/** Actual standalone CLI checks. All mutable setup precedes the filesystem baseline. */
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { initUniverse, initUniverseCampaign, type UniverseManifest } from '../src/core/universe/index.js';

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
const PRIVATE_TEXT = 'PRIVATE_INSPECTOR_HISTORY_MUST_NOT_APPEAR_IN_REPORT';
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}

/** Directory identity/times detect even a create-then-remove lock or migration.
 * Access time is deliberately excluded: ordinary reads may update it.
 */
function treeEvidence(root: string) {
  const rows: Record<string, unknown> = {};
  const visit = (file: string, name: string) => {
    const stat = lstatSync(file, { bigint: true });
    expect(stat.isSymbolicLink()).toBe(false);
    rows[name] = { kind: stat.isDirectory() ? 'directory' : 'file', mode: stat.mode.toString(), dev: stat.dev.toString(),
      ino: stat.ino.toString(), nlink: stat.nlink.toString(), mtime: stat.mtimeNs.toString(), ctime: stat.ctimeNs.toString(),
      ...(stat.isFile() ? { bytes: stat.size.toString(), digest: digest(readFileSync(file)) } : {}) };
    if (stat.isDirectory()) for (const child of readdirSync(file).sort()) visit(join(file, child), `${name}/${child}`);
    else expect(stat.isFile()).toBe(true);
  };
  visit(root, ''); return rows;
}

async function fixture(options: { key?: boolean; historical?: boolean } = {}) {
  expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-inspect-')));
  const home = join(base, 'home'); const workspace = join(base, 'default-workspace'); const repo = join(base, 'app-project');
  const transport = join(base, 'sterile-transport'); const graphRoot = join(base, 'graph'); const universeRoot = join(base, 'universe');
  for (const directory of [home, workspace, repo, transport, graphRoot]) mkdirSync(directory, { mode: 0o700 });
  git(repo, 'init', '-q', '--template=', '--initial-branch=main'); git(transport, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'value.json'), '0\n'); writeFileSync(join(repo, 'evaluate.mjs'), 'throw new Error("Inspector must never run evaluator");\n');
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=Inspector Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'inspection seed');
  const revision = git(repo, 'rev-parse', 'HEAD'); let requests = 0;
  const worker = createServer((_req, res) => { requests++; res.writeHead(500); res.end('Inspector must never invoke a worker'); });
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    worker.closeAllConnections(); await new Promise<void>((resolve) => worker.close(() => resolve()));
    const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return;
      chmodSync(file, 0o700); for (const child of readdirSync(file)) writable(join(file, child)); };
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  const address = worker.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'engineering-inspect', workers: [{ id: 'local-worker', provider: 'local', model: 'inert',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'local-worker', capacityKey: 'fixture-account', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const observations = [{ workerId: 'local-worker', health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() }];
  const files = { root: join(base, 'absent-ledger'), pool: join(base, 'pool.json'), bindings: join(base, 'bindings.json'),
    observations: join(base, 'observations.json'), workspace, projects: join(base, 'projects.json'), engineering: join(base, 'engineering.json') };
  const projects = [{ id: 'app', label: 'App project', workspace: repo }];
  save(files.pool, pool); save(files.bindings, bindings); save(files.observations, observations); save(files.projects, { schemaVersion: 1, projects });
  const runtime = { schemaVersion: 1, root: files.root, workspace: transport, poolPath: files.pool, bindingsPath: files.bindings,
    observationsPath: files.observations, capacityWaitMs: 1000 };
  const runtimeFile = join(base, 'runtime.json'); save(runtimeFile, runtime);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'inspect-app', name: 'Inspector fixture', objective: 'Check configuration without execution',
    seed: { repo, revision }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 20_000, trialTimeoutMs: 10_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 }, variants: [{ id: 'repair', niche: 'value', hypothesis: 'Never invoked by inspection',
      generation: { kind: 'resource-pool', poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })), allowedWorkerIds: ['local-worker'],
        files: ['value.json'], maxOutputTokens: 128, fileOperations: { schemaVersion: 1, contextFiles: [] } } }] };
  initUniverse(manifest, { root: universeRoot });
  initUniverseCampaign({ schemaVersion: 1, id: 'inspect-campaign', universeId: manifest.id, feedback: true,
    budget: { maxGenerations: 1, maxDurationMs: 20_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root: universeRoot });
  const host = { nodeId: 'inspect-delivery', root: universeRoot, constitutionVersion: 'fixture-v1', policyEpoch: 1,
    definition: { schemaVersion: 1, id: 'inspect-controller', tasks: [{ campaignId: 'inspect-campaign', dependsOn: [] }], maxParallel: 1, maxDurationMs: 30_000 },
    deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId: 'inspect-campaign', branch: 'codex/inspect-only', baseCommit: revision }] },
    resourceRuntime: runtimeFile, expectedRuntimeDigest: digest(canonical(runtime)) };
  save(files.engineering, { schemaVersion: 1, enrollments: [{ id: 'inspect-app', projectId: 'app', graphId: 'inspect-graph', graphRoot, host }] });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'),
    TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1', GIT_OPTIONAL_LOCKS: '0' };
  if (options.key !== false) {
    await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      "const {loadOrCreateKey}=await import('./src/core/foundry/provenance.ts');loadOrCreateKey();"], { env, timeout: 20_000 });
  }
  if (options.historical) {
    // Real normal setup, completed before the inspected baseline. Never submit
    // an executable task: pausing first makes retained cancellation deterministic.
    const supervisor = await createResourcePoolSupervisor({ root: files.root, workspace, projects, pool, bindings, readObservations: () => observations });
    try {
      supervisor.setPaused(true);
      supervisor.submit({ id: 'historical-private-task', projectId: 'app', prompt: PRIVATE_TEXT, retainHistory: true,
        allowedWorkerIds: ['local-worker'], mode: 'read-only', timeoutMs: 5000, maxOutputTokens: 100 });
      supervisor.cancel('historical-private-task'); supervisor.setPaused(false);
    } finally { await supervisor.close(); }
    setResourcePoolAllocation(files.root, pool, bindings, 75, 0);
    setResourceWorkerAccess(files.root, pool, bindings, ['local-worker'], 0);
  }
  const args = ['resources', 'pool', 'engineering', 'check', ...Object.entries(files).flatMap(([key, value]) => [`--${key}`, value]), '--json'];
  const invoke = async () => {
    let stdout: string; let stderr: string; let code = 0;
    try { ({ stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], { env, timeout: 30_000, maxBuffer: 1024 * 1024 })); }
    catch (error) { const result = error as Error & { code?: number; stdout?: string; stderr?: string; signal?: string };
      if (typeof result.code !== 'number' || result.signal) throw error;
      code = result.code; stdout = result.stdout ?? ''; stderr = result.stderr ?? ''; }
    expect(stderr).toBe(''); expect(Buffer.byteLength(stdout)).toBeLessThan(1024 * 1024);
    const report = JSON.parse(stdout) as { status: 'configured' | 'held' | 'unavailable'; [key: string]: unknown };
    expect(report).toMatchObject({ admission: 'not-attested', scope: 'local-commissioning-check-only', effectsExecuted: false, providerContacted: false });
    expect(code).toBe(report.status === 'configured' ? 0 : 1); expect(stdout).not.toContain(PRIVATE_TEXT);
    return report;
  };
  const unchanged = async () => { const before = treeEvidence(base); const report = await invoke();
    expect(treeEvidence(base)).toEqual(before); expect(requests).toBe(0); return report; };
  return { base, home, repo, graphRoot, universeRoot, files, pool, bindings, unchanged, requests: () => requests };
}

describe('standalone engineering commissioning CLI is read-only', () => {
  it('projects missing supervisor and ledger registration without creating either store', async () => {
    const f = await fixture(); expect(existsSync(f.files.root)).toBe(false);
    const report = await f.unchanged(); expect(report.status).toBe('configured');
    expect(JSON.stringify(report)).toContain('would-register'); expect(existsSync(f.files.root)).toBe(false);
    expect(readdirSync(f.graphRoot)).toEqual([]);
  });

  it('reports a missing provenance key as a hold without creating a key or store', async () => {
    const f = await fixture({ key: false }); expect(readdirSync(f.home)).toEqual([]);
    const report = await f.unchanged(); expect(report.status).toBe('held');
    expect(JSON.stringify(report)).toContain('provenance-unavailable'); expect(readdirSync(f.home)).toEqual([]);
    expect(existsSync(f.files.root)).toBe(false);
  });

  it('reads matching persisted projects, retained history and account policy without resetting or resuming them', async () => {
    const f = await fixture({ historical: true }); const report = await f.unchanged();
    expect(report.status).not.toBe('unavailable'); expect(JSON.stringify(report)).not.toContain('would-register');
    const state = JSON.parse(readFileSync(join(f.files.root, 'resource-console-state.json'), 'utf8'));
    expect(state.jobs[0].history.prompt).toBe(PRIVATE_TEXT);
    const ledger = JSON.parse(readFileSync(join(f.files.root, 'pool-state.json'), 'utf8'));
    expect(ledger.workerAccess.pausedWorkerIds).toEqual(['local-worker']); expect(ledger.allocation.ceilingPercent).toBe(75);
  });

  it('keeps an existing enrollment project persisted when an unrelated project would be registered', async () => {
    const f = await fixture({ historical: true }); const additional = join(f.base, 'additional-project'); mkdirSync(additional, { mode: 0o700 });
    const catalog = JSON.parse(readFileSync(f.files.projects, 'utf8'));
    catalog.projects.push({ id: 'additional', label: 'Additional project', workspace: additional }); save(f.files.projects, catalog);
    const report = await f.unchanged(); expect(report.status).not.toBe('unavailable');
    expect(report.enrollments).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'inspect-app', projectRegistration: 'persisted' })]));
  });

  it('reports a real existing supervisor owner without disturbing its lock or private history', async () => {
    const f = await fixture({ historical: true });
    const acquired = acquireLocalStoreLockWithOutcome(join(f.files.root, '.resource-console.lock'), 0,
      { anchorPath: f.files.root, exactPrivateStorage: true });
    expect(acquired.state).toBe('acquired'); if (acquired.state !== 'acquired') throw new Error('Fixture supervisor lock unavailable');
    try {
      const report = await f.unchanged(); expect(report.status).toBe('held');
      expect(JSON.stringify(report)).toContain('supervisor-ownership-present');
    } finally { expect(releaseLocalStoreLock(acquired.lock)).toBe(true); }
  });

  it('rejects a padded project catalog beyond the same 256 KiB startup limit', async () => {
    const f = await fixture(); const content = readFileSync(f.files.projects, 'utf8');
    writeFileSync(f.files.projects, content + ' '.repeat(256 * 1024));
    expect((await f.unchanged()).status).toBe('unavailable');
  });

  it.each(['binding identity', 'ledger identity', 'worker policy'] as const)('rejects mismatched %s instead of substituting a fresh ledger', async (condition) => {
    const f = await fixture({ historical: true });
    const file = condition === 'binding identity' ? f.files.bindings : join(f.files.root, 'pool-state.json');
    const changed = JSON.parse(readFileSync(file, 'utf8'));
    if (condition === 'binding identity') changed[0].capacityKey = 'different-fixture-account';
    else if (condition === 'ledger identity') changed.poolDigest = 'f'.repeat(64);
    else changed.workerAccess.pausedWorkerIds = ['foreign-worker'];
    save(file, changed);
    expect((await f.unchanged()).status).toBe('unavailable');
  });

  it('rejects malformed historical jobs even when the persisted project header is valid', async () => {
    const f = await fixture({ historical: true }); const file = join(f.files.root, 'resource-console-state.json');
    const state = JSON.parse(readFileSync(file, 'utf8')); state.jobs[0].history.output = { text: PRIVATE_TEXT, truncated: 'invalid' }; save(file, state);
    expect((await f.unchanged()).status).toBe('unavailable');
  });

  it.each(['disabled', 'replaced'] as const)('holds a %s historical project without registering a new identity', async (condition) => {
    const f = await fixture({ historical: true });
    if (condition === 'disabled') save(f.files.projects, { schemaVersion: 1, projects: [] });
    else { renameSync(f.repo, join(f.base, 'original-app-project')); mkdirSync(f.repo, { mode: 0o700 }); }
    const report = await f.unchanged(); expect(report.status).toBe('held');
    expect(JSON.stringify(report)).not.toContain('would-register');
  });

  it.each(['global KILL', 'graph KILL', 'graph lock'] as const)('reports %s without clearing it or consuming an enrollment', async (condition) => {
    const f = await fixture(); let release: (() => void) | undefined;
    if (condition === 'graph lock') {
      const acquired = acquireLocalStoreLockWithOutcome(join(f.graphRoot, '.control-execution.lock'), 0,
        { anchorPath: f.graphRoot, exactPrivateStorage: true });
      expect(acquired.state).toBe('acquired'); if (acquired.state !== 'acquired') throw new Error('Fixture lock unavailable');
      release = () => { expect(releaseLocalStoreLock(acquired.lock)).toBe(true); };
    } else writeFileSync(condition === 'global KILL' ? join(f.home, '.ashlr', 'KILL') : join(f.graphRoot, 'KILL'), 'isolated stop\n', { mode: 0o600 });
    try { const report = await f.unchanged(); expect(report.status).toBe('held'); expect(existsSync(f.files.root)).toBe(false); }
    finally { release?.(); }
  });
});

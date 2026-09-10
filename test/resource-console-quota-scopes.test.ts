import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResourceConsoleSnapshot } from '../src/core/resources/console-types.js';
import { validateResourcePool, type ResourceObservation, type ResourcePool } from '../src/core/resources/pool-policy.js';
import { resourceQuotaBuckets } from '../src/core/resources/quota-scope.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle } from '../src/core/web/resource-console-server.js';

let directory: string;
const handles: ResourceConsoleServerHandle[] = [];
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-quota-http-'))); });
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  rmSync(directory, { recursive: true, force: true });
});
const timestamp = (offset = 0) => new Date(Date.now() + offset).toISOString();
const candidates = (snapshot: ResourceConsoleSnapshot) => snapshot.plan?.candidates.map((candidate) => candidate.workerId);

function fixture(kind: 'independent' | 'same-bucket' | 'legacy' = 'independent') {
  const pool: ResourcePool = structuredClone(validateResourcePool({ schemaVersion: 1, id: 'quota-http', workers: [
    { id: 'general', provider: 'codex', model: 'gpt-6-astra', quotaScope: 'codex-general-v1',
      maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, allowUnknownQuota: true },
    { id: 'spark', provider: 'codex', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1',
      maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, allowUnknownQuota: true },
  ] }));
  if (kind === 'same-bucket') Object.assign(pool.workers[1]!, { model: 'gpt-5.6-sol', quotaScope: 'codex-general-v1' });
  if (kind === 'legacy') delete pool.workers[1]!.quotaScope;
  // This command is inert configuration: execution and metadata collection are
  // both disabled. The HTTP read must never launch a native client or provider.
  const bindings: ResourceBinding[] = pool.workers.map((worker) => ({ workerId: worker.id,
    capacityKey: 'one-account', kind: 'native-cli', command: [process.execPath, join(directory, 'never-executed.cjs')] }));
  const observations: ResourceObservation[] = pool.workers.map((worker) => ({ workerId: worker.id,
    observedAt: timestamp(-1000), expiresAt: timestamp(60_000), health: 'ready', retryAfter: null,
    windows: [{ id: `codex_${resourceQuotaBuckets(worker)?.[0] ?? 'codex'}_primary`, usedPercent: 20, resetsAt: timestamp(3_600_000) }] }));
  const options = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'),
    bindingsFile: join(directory, 'bindings.json'), observationsFile: join(directory, 'observations.json') };
  return { pool, bindings, observations, options };
}

async function readSnapshot(f: ReturnType<typeof fixture>, ceiling = 75, paused = false): Promise<ResourceConsoleSnapshot> {
  for (const [file, value] of [[f.options.poolFile, f.pool], [f.options.bindingsFile, f.bindings],
    [f.options.observationsFile, f.observations]] as const) writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  setResourcePoolAllocation(f.options.root, f.pool, f.bindings, ceiling, 0);
  if (paused) setResourceWorkerAccess(f.options.root, f.pool, f.bindings, ['general'], 0);
  const ledgerFile = join(f.options.root, 'pool-state.json');
  const beforeLedger = readFileSync(ledgerFile); const beforeObservations = readFileSync(f.options.observationsFile);
  const handle = await startResourceConsoleServer(f.options); handles.push(handle);
  expect(handle.scope.readOnly).toBe(true); expect(handle.controlToken).toBeNull();
  const snapshot = await new Promise<ResourceConsoleSnapshot>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: handle.port, path: '/api/resources', agent: false,
      headers: { 'x-ashlr-token': handle.readToken } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try { expect(response.statusCode).toBe(200); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.setTimeout(15_000, () => req.destroy(new Error('Fixture HTTP timeout'))); req.end();
  });
  expect(snapshot.sourceState).toBe('healthy'); expect(snapshot.supervisor).toBeNull();
  expect(snapshot.quotaRefresh).toBeUndefined();
  expect(snapshot.groups).toHaveLength(1); expect(snapshot.groups[0]!.workerIds).toEqual(['general', 'spark']);
  expect(snapshot.activeAttempts).toEqual([]);
  expect(readFileSync(ledgerFile)).toEqual(beforeLedger);
  expect(readFileSync(f.options.observationsFile)).toEqual(beforeObservations);
  return snapshot;
}

describe('resource console HTTP ceiling respects pinned quota scopes', () => {
  it.each([0, 1])('keeps the independent bucket available when bucket %i reaches the allocation ceiling', async (index) => {
    const f = fixture(); f.observations[index]!.windows[0]!.usedPercent = 80;
    const snapshot = await readSnapshot(f);
    const runtime = resourcePoolStatus(f.options.root, f.pool, f.bindings, f.observations);
    expect(runtime.plan.candidates.map((candidate) => candidate.workerId)).toEqual([f.pool.workers[1 - index]!.id]);
    expect(candidates(snapshot)).toEqual(runtime.plan.candidates.map((candidate) => candidate.workerId));
    expect(snapshot.plan?.selectedWorkerId).toBe(f.pool.workers[1 - index]!.id);
  });

  it.each(['missing', 'unknown', 'stale', 'future', 'reset-expired'] as const)('withholds only the mapped quota scope for %s evidence', async (kind) => {
    const f = fixture(); const general = f.observations[0]!;
    if (kind === 'missing') f.observations.shift();
    if (kind === 'unknown') general.windows[0]!.usedPercent = null;
    if (kind === 'stale') { general.observedAt = timestamp(-120_000); general.expiresAt = timestamp(-60_000); }
    if (kind === 'future') general.observedAt = timestamp(20_000);
    if (kind === 'reset-expired') general.windows[0]!.resetsAt = timestamp(-1000);
    expect(candidates(await readSnapshot(f))).toEqual(['spark']);
  });

  it.each(['same-bucket', 'legacy'] as const)('keeps %s aliases conservative for stale quota evidence', async (kind) => {
    const f = fixture(kind); f.observations[0]!.observedAt = timestamp(-120_000); f.observations[0]!.expiresAt = timestamp(-60_000);
    expect(candidates(await readSnapshot(f))).toEqual([]);
  });

  it.each(['health', 'retry', 'access'] as const)('preserves the account-wide %s veto across independent scopes', async (kind) => {
    const f = fixture();
    if (kind === 'health') f.observations[0]!.health = 'unavailable';
    if (kind === 'retry') f.observations[0]!.retryAfter = timestamp(60_000);
    expect(candidates(await readSnapshot(f, 75, kind === 'access'))).toEqual([]);
  });

  it('withholds both buckets at a zero allocation ceiling', async () => {
    expect(candidates(await readSnapshot(fixture(), 0))).toEqual([]);
  });
});

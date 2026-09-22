/** Real loopback HTTP and inert native children; no account or host configuration. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as policy from '../src/core/sandbox/policy.js';
import * as poolRuntime from '../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { acceptanceContractDigestV1, createValueHypothesisV1, digestResourceEnvelopeV1, type ValueHypothesisDraftV1 } from '../src/core/vision/value-portfolio.js';
import { createValueAllocationReceipt } from '../src/core/universe/value-allocation.js';
import { recordValueAllocation } from '../src/core/universe/value-allocation-store.js';
import { executeFirmResourceTask, type FirmResourceExecutionHost, type FirmResourceExecutionRequest } from '../src/core/universe/firm-resource-execution.js';

let base: string;
let cleanups: Array<() => Promise<void>>;
const keyOptions = { testKey: Buffer.alloc(32, 7) };
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const hash = (character: string) => character.repeat(64);
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'firm-resource-'))); cleanups = [];
  vi.spyOn(policy, 'readKillSwitch').mockImplementation(() => ({ state: 'inactive', sourceState: 'healthy', reason: 'missing', path: join(base, 'KILL') }));
});
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true });
});
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(options: { native?: boolean; hang?: boolean; constraints?: Partial<ValueHypothesisDraftV1['constraints']>;
  budget?: Partial<ValueHypothesisDraftV1['budget']>; expired?: boolean; resetOffset?: number } = {}) {
  const allocationRoot = join(base, 'allocations'); mkdirSync(allocationRoot, { mode: 0o700 });
  const candidatePath = join(allocationRoot, 'candidate'); mkdirSync(candidatePath, { mode: 0o700 });
  const workspace = join(base, 'empty-workspace'); mkdirSync(workspace, { mode: 0o700 });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', workspace], { stdio: 'pipe',
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  let requests = 0; let closed = false;
  const respond = (response: ServerResponse) => {
    requests++; response.on('close', () => { closed = true; });
    if (options.hang) return;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fixture completion' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
  };
  const server = createServer((request, response) => { request.resume(); request.once('end', () => respond(response)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
  const marker = join(base, 'native-calls'); const script = join(base, 'inert.cjs');
  writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(marker)},'x');` +
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture completion'}}));" +
    "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:3}}));});", { mode: 0o600 });
  const provider = options.native ? 'codex' as const : 'local' as const;
  const pool = validateResourcePool({ schemaVersion: 1, id: 'fixture-pool', workers: [{ id: 'worker', provider, model: 'inert-fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([options.native
    ? { workerId: 'worker', capacityKey: 'fixture-capacity', kind: 'native-cli', command: [process.execPath, script] }
    : { workerId: 'worker', capacityKey: 'fixture-capacity', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const now = Date.now(); const at = (offset: number) => new Date(now + offset).toISOString();
  const observations = [{ workerId: 'worker', observedAt: at(-1000), expiresAt: at(60_000), health: 'ready' as const, retryAfter: null,
    windows: options.native ? [{ id: 'weekly', usedPercent: 10, resetsAt: at(120_000) }] : [] }];
  const runtime = { schemaVersion: 1, poolPath: join(base, 'pool.json'), bindingsPath: join(base, 'bindings.json'),
    observationsPath: join(base, 'observations.json'), root: join(base, 'ledger'), workspace };
  const runtimePath = join(base, 'runtime.json');
  save(runtimePath, runtime); save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings); save(runtime.observationsPath, observations);
  const visionSpec = { content: 'Fictional vision', expectedDigest: digest('Fictional vision') };
  const missionGraph = { content: 'Fictional mission', expectedDigest: digest('Fictional mission') };
  const contract = { baselineDigest: hash('6'), metric: 'accepted-changes', unit: 'changes', direction: 'increase' as const,
    effectiveThreshold: 20, refutationThreshold: 5, windowStart: at(-5000), windowEnd: at(options.expired ? -200 : 60_000),
    minimumCausalGrade: 'quasi-experimental' as const };
  const draft: ValueHypothesisDraftV1 = { schemaVersion: 1, provenanceDigest: hash('0'), specDigest: visionSpec.expectedDigest,
    missionDigest: missionGraph.expectedDigest, missionNodeKey: 'fixture', producerDigest: hash('d'), claim: 'Fictional bounded completion',
    constraints: { dependenciesSatisfied: true, humanGateRequired: false, reversible: true, allowedProviders: [provider],
      shardable: false, shardPlanDigest: null, ...options.constraints },
    frozenOutcome: { acceptanceContractDigest: acceptanceContractDigestV1(contract)!, ...contract },
    budget: { maxTokens: 100_000, maxMinutes: 240, maxAttempts: 4, maxInconclusiveWindows: 2, spentTokens: 0,
      spentMinutes: 0, attempts: 0, inconclusiveWindows: 0, deadline: at(options.expired ? -100 : 120_000), minimumMarginalValue: 0.05, ...options.budget },
    factors: { productImpact: 0.9, informationGain: 0.8, strategicLeverage: 0.9, ipLeverage: 0.85, dependencyUnlock: 0.7,
      probability: 0.75, risk: 0.2, uncertainty: 0.3, estimatedTokens: 2000, estimatedMinutes: 2, factorSourceDigest: hash('7') },
    outcomeSource: { complete: true, sourceDigest: hash('e'), evidence: null } };
  const hypothesis = createValueHypothesisV1(draft); if (!hypothesis) throw new Error('Invalid hypothesis fixture');
  const resourceEnvelope = { schemaVersion: 1 as const, sourceComplete: true, sourceDigest: hash('c'), reserveFraction: 0.1,
    capacity: [{ executionIdentityDigest: hash('1'), provider, state: 'open' as const, trustedTokens: 100_000, trustedMinutes: 120, resetAt: at(options.resetOffset ?? 120_000) }] };
  const allocated = createValueAllocationReceipt({ schemaVersion: 1, asOf: at(-1000), constitutionVersion: 'v1', policyEpoch: 2,
    visionSpec, missionGraph, resourceEnvelope, expectedResourceEnvelopeDigest: digestResourceEnvelopeV1(resourceEnvelope),
    hypotheses: [hypothesis], expectedHypothesesDigest: digest(canonical([hypothesis])) }, keyOptions);
  if (!allocated.ok) throw new Error(allocated.reason);
  recordValueAllocation({ root: allocationRoot, allocationId: 'first', receipt: allocated.receipt, trace: allocated.trace }, keyOptions);
  const host: FirmResourceExecutionHost = { allocationRoot, candidatePath, constitutionVersion: 'v1', policyEpoch: 2,
    enrollments: [{ executionIdentityDigest: hash('1'), resourceRuntime: runtimePath, runtimeDigest: digest(canonical(runtime)),
      poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })), workerId: 'worker' }] };
  const request: FirmResourceExecutionRequest = { allocationId: 'first', expectedReceiptDigest: allocated.receipt.receiptDigest,
    hypothesisId: hypothesis.hypothesisId, hypotheses: [hypothesis], expectedHypothesesDigest: digest(canonical([hypothesis])),
    prompt: 'Produce an inert fixture response.', timeoutMs: 5000, maxOutputTokens: 100 };
  const controller = new AbortController();
  return { host, request, allocated, runtime, pool, bindings, observations, controller, marker, now,
    requests: () => requests, closed: () => closed,
    run: () => executeFirmResourceTask(request, host, { ...keyOptions, signal: controller.signal }) };
}

describe.skipIf(process.platform === 'win32')('explicitly enrolled firm resource task', () => {
  it.each([false, true])('executes a real inert transport once and replays aliases without output (native: %s)', async (native) => {
    const f = await fixture({ native }); const first = await f.run();
    expect(first).toMatchObject({ disposition: 'attempted', verifiedAccepted: false,
      completion: { status: 'succeeded', content: 'fixture completion', resource: { dispatch: 'settled', workerId: 'worker' } } });
    expect(Object.values(f.allocated.receipt.authority)).toEqual([false, false, false, false]);
    recordValueAllocation({ root: f.host.allocationRoot, allocationId: 'alias', receipt: f.allocated.receipt, trace: f.allocated.trace }, keyOptions);
    f.request.allocationId = 'alias';
    expect(await f.run()).toMatchObject({ taskId: first.taskId, completion: { content: null, resource: { dispatch: 'replayed' }, usage: { state: 'unavailable' } } });
    if (native) expect(readFileSync(f.marker, 'utf8')).toBe('x'); else expect(f.requests()).toBe(1);
    expect(poolRuntime.resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toHaveLength(1);
  });

  it.each(['prompt', 'timeoutMs', 'maxOutputTokens'] as const)('conflicts changed %s against the existing ledger identity', async (field) => {
    const f = await fixture(); const first = await f.run();
    if (field === 'prompt') f.request.prompt += ' Changed'; else f.request[field]++;
    const conflict = await f.run();
    expect(conflict).toMatchObject({ taskId: first.taskId, completion: { status: 'failed', content: null } });
    expect(f.requests()).toBe(1); expect(poolRuntime.resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toHaveLength(1);
  });

  it.each(['missing', 'wrong-identity', 'duplicate', 'runtime-drift', 'pool-drift', 'policy-drift'] as const)('holds %s enrollment before contact', async (kind) => {
    const f = await fixture();
    if (kind === 'missing') f.host.enrollments = [];
    if (kind === 'wrong-identity') f.host.enrollments[0]!.executionIdentityDigest = hash('2');
    if (kind === 'duplicate') f.host.enrollments.push({ ...f.host.enrollments[0]! });
    if (kind === 'runtime-drift') save(f.host.enrollments[0]!.resourceRuntime, { ...f.runtime, root: join(base, 'other-ledger') });
    if (kind === 'pool-drift') f.host.enrollments[0]!.poolDigest = hash('0');
    if (kind === 'policy-drift') f.host.policyEpoch++;
    expect(await f.run()).toMatchObject({ disposition: 'held', completion: null }); expect(f.requests()).toBe(0);
    expect(existsSync(f.runtime.root)).toBe(false);
  });

  it('repins runtime inside the actual generation read before changed ledger locations can execute', async () => {
    const f = await fixture(); const original = poolRuntime.readResourceJson; let reads = 0;
    vi.spyOn(poolRuntime, 'readResourceJson').mockImplementation((path, maxBytes) => {
      if (path === f.host.enrollments[0]!.resourceRuntime && ++reads === 2) {
        save(path, { ...f.runtime, root: join(base, 'other-ledger') });
      }
      return original(path, maxBytes);
    });
    expect(await f.run()).toMatchObject({ completion: { status: 'failed', resource: { dispatch: 'not-started' } } });
    expect(reads).toBe(2); expect(f.requests()).toBe(0); expect(existsSync(join(base, 'other-ledger'))).toBe(false);
  });

  it.each(['human-gate', 'irreversible', 'sharded', 'dependency'] as const)('holds original %s constraints', async (kind) => {
    const constraints = kind === 'human-gate' ? { humanGateRequired: true } : kind === 'irreversible' ? { reversible: false }
      : kind === 'sharded' ? { shardable: true, shardPlanDigest: hash('a') } : { dependenciesSatisfied: false };
    const f = await fixture({ constraints });
    expect(await f.run()).toMatchObject({ disposition: 'held' }); expect(f.requests()).toBe(0);
  });

  it('holds a deadline that elapsed after allocation', async () => {
    const f = await fixture({ expired: true });
    expect(await f.run()).toMatchObject({ disposition: 'held', reason: 'budget-held' }); expect(f.requests()).toBe(0);
  });

  it.each(['timeoutMs', 'maxOutputTokens'] as const)('holds excessive %s relative to the selected hypothesis budget', async (field) => {
    const f = await fixture(); f.request[field] = field === 'timeoutMs' ? 900_000 : 16_384;
    expect(await f.run()).toMatchObject({ disposition: 'held', reason: 'budget-held' }); expect(f.requests()).toBe(0);
  });

  it.each(['attempts', 'inconclusiveWindows', 'spentTokens', 'spentMinutes'] as const)('cannot execute a hypothesis with exhausted %s', async (field) => {
    const limits = { attempts: 4, inconclusiveWindows: 2, spentTokens: 100_000, spentMinutes: 240 };
    const f = await fixture({ budget: { [field]: limits[field] } });
    expect(f.allocated.receipt.portfolio.decisions[0]!.allocation).toBeNull();
    expect(await f.run()).toMatchObject({ disposition: 'held', reason: 'selection-unavailable' });
    expect(f.requests()).toBe(0); expect(existsSync(f.runtime.root)).toBe(false);
  });

  it('rechecks selection reset expiry after synchronous enrollment reads and before handoff', async () => {
    const f = await fixture({ resetOffset: 30_000 }); const original = poolRuntime.readResourceJson;
    vi.spyOn(poolRuntime, 'readResourceJson').mockImplementation((path, maxBytes) => {
      const result = original(path, maxBytes);
      if (path === f.runtime.bindingsPath) vi.spyOn(Date, 'now').mockReturnValue(f.now + 30_001);
      return result;
    });
    expect(await f.run()).toMatchObject({ disposition: 'held', reason: 'kill-or-cancellation' });
    expect(f.requests()).toBe(0); expect(existsSync(f.runtime.root)).toBe(false);
  });

  it('refuses expiry observed under the actual resource ledger lock without reserving or dispatching', async () => {
    const f = await fixture({ resetOffset: 30_000 }); const original = poolRuntime.readResourceJson;
    let inspectedUnderLock = false;
    vi.spyOn(poolRuntime, 'readResourceJson').mockImplementation((path, maxBytes) => {
      const result = original(path, maxBytes);
      if (path === f.runtime.observationsPath && existsSync(join(f.runtime.root, '.pool.lock'))) {
        inspectedUnderLock = true;
        vi.spyOn(Date, 'now').mockReturnValue(f.now + 30_001);
      }
      return result;
    });
    expect(await f.run()).toMatchObject({ completion: { status: 'timed-out', content: null } });
    expect(inspectedUnderLock).toBe(true); expect(f.requests()).toBe(0);
    expect(existsSync(join(f.runtime.root, '.pool.lock'))).toBe(false);
    expect(poolRuntime.resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toEqual([]);
  });

  it('cancels in-flight work at selection reset expiry before the hypothesis deadline', async () => {
    const f = await fixture({ hang: true, resetOffset: 30_000 }); const pending = f.run();
    await until(() => f.requests() === 1); vi.spyOn(Date, 'now').mockReturnValue(f.now + 30_001);
    expect(await pending).toMatchObject({ completion: { status: 'cancelled', content: null, resource: { taskStatus: 'cancelled' } } });
    await until(f.closed); expect(f.requests()).toBe(1);
  });

  it.each(['digest', 'hypothesis', 'getter', 'oversized'] as const)('rejects %s request corruption without invoking accessors or transport', async (kind) => {
    const f = await fixture(); const getter = vi.fn(() => 'private');
    if (kind === 'digest') f.request.expectedReceiptDigest = hash('f');
    if (kind === 'hypothesis') f.request.hypotheses[0]!.constraints.humanGateRequired = true;
    if (kind === 'getter') Object.defineProperty(f.request, 'prompt', { get: getter, enumerable: true });
    if (kind === 'oversized') f.request.prompt = 'x'.repeat(128 * 1024 + 1);
    expect(await f.run()).toMatchObject({ disposition: 'held' }); expect(getter).not.toHaveBeenCalled(); expect(f.requests()).toBe(0);
  });

  it.each(['paused', 'stale', 'quota'] as const)('defers %s admission to the existing current resource policy', async (kind) => {
    const f = await fixture({ native: kind === 'quota' });
    if (kind === 'paused') poolRuntime.setResourceWorkerAccess(f.runtime.root, f.pool, f.bindings, ['worker'], 0);
    if (kind === 'stale') save(f.runtime.observationsPath, f.observations.map((row) => ({ ...row, expiresAt: new Date(Date.now() - 1).toISOString() })));
    if (kind === 'quota') poolRuntime.setResourcePoolAllocation(f.runtime.root, f.pool, f.bindings, 0, 0);
    expect(await f.run()).toMatchObject({ completion: { status: 'failed', resource: { dispatch: 'withheld' } } });
    expect(f.requests()).toBe(0); expect(existsSync(f.marker)).toBe(false);
  });

  it.each(['caller', 'global-kill', 'local-kill'] as const)('withholds existing %s before ledger or transport activity', async (kind) => {
    const f = await fixture();
    if (kind === 'caller') f.controller.abort();
    if (kind === 'global-kill') vi.mocked(policy.readKillSwitch).mockReturnValue({ state: 'active', sourceState: 'healthy', reason: 'present', path: join(base, 'KILL') });
    if (kind === 'local-kill') writeFileSync(join(f.host.allocationRoot, 'KILL'), 'stop', { mode: 0o600 });
    expect(await f.run()).toMatchObject({ disposition: 'held', reason: 'kill-or-cancellation' });
    expect(f.requests()).toBe(0); expect(existsSync(f.runtime.root)).toBe(false);
  });

  it.each(['caller', 'global-kill', 'local-kill'] as const)('cancels in-flight HTTP and retains no-retry settlement on %s', async (kind) => {
    const f = await fixture({ hang: true }); const pending = f.run(); await until(() => f.requests() === 1);
    if (kind === 'caller') f.controller.abort();
    if (kind === 'global-kill') vi.mocked(policy.readKillSwitch).mockReturnValue({ state: 'active', sourceState: 'healthy', reason: 'present', path: join(base, 'KILL') });
    if (kind === 'local-kill') writeFileSync(join(f.host.allocationRoot, 'KILL'), 'stop', { mode: 0o600 });
    expect(await pending).toMatchObject({ completion: { status: 'cancelled', content: null, resource: { taskStatus: 'cancelled' } } });
    await until(f.closed); expect(f.requests()).toBe(1);
    const attempts = poolRuntime.resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts;
    expect(attempts).toHaveLength(1); expect(attempts[0]!.status).toBe('cancelled');
    expect((await f.run()).disposition).toBe('held'); expect(f.requests()).toBe(1);
  });
});

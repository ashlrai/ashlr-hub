import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SharedStore } from '../src/core/fleet/shared-store.js';

const QUEUE_FILE = 'ashlr-fleet-queue.json';
const CHILD_SOURCE = String.raw`
  import { SharedStore } from './src/core/fleet/shared-store.ts';
  const store = new SharedStore(process.env.QUEUE_DIR, 30_000);
  const [ref] = store.claimLeases(['race-item'], 1, 'same-machine');
  if (!process.send) throw new Error('IPC unavailable');
  process.send({ claimed: Boolean(ref), epoch: ref?.epoch ?? null });
  process.disconnect();
`;

let dir: string;

function queuePath(): string {
  return path.join(dir, QUEUE_FILE);
}

function rawQueue(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(queuePath(), 'utf8')) as Record<string, unknown>;
}

function spawnClaimant(): Promise<{ claimed: boolean; epoch: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', CHILD_SOURCE],
      {
        cwd: process.cwd(),
        env: { ...process.env, QUEUE_DIR: dir },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
    let stderr = '';
    let result: { claimed: boolean; epoch: number | null } | null = null;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claimant timed out: ${stderr}`));
    }, 12_000);
    child.once('message', (message: { claimed?: unknown; epoch?: unknown }) => {
      result = {
        claimed: message.claimed === true,
        epoch: typeof message.epoch === 'number' ? message.epoch : null,
      };
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && result) resolve(result);
      else reject(new Error(`claimant exited ${code ?? 'without status'}: ${stderr}`));
    });
  });
}

function unlinkFromChild(target: string, delayMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      `import fs from 'node:fs'; setTimeout(() => { fs.unlinkSync(${JSON.stringify(target)}); }, ${delayMs});`,
    ], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`unlink child exited ${code}`)));
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m392-queue-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('M392 shared queue exact claim generations', () => {
  it('allows exactly one independent process to win a same-machine claim race', async () => {
    const results = await Promise.all([spawnClaimant(), spawnClaimant(), spawnClaimant()]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => result.epoch !== null)).toHaveLength(1);
    expect(new SharedStore(dir, 30_000).readSnapshot().claims).toEqual({
      'race-item': expect.objectContaining({ machineId: 'same-machine' }),
    });
  }, 30_000);

  it('persists a token commitment and queue epoch without exposing the capability', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const store = new SharedStore(dir, 1_000);

    const [ref] = store.claimLeases(['item-a'], 1, 'machine-A');

    expect(ref).toMatchObject({
      itemId: 'item-a',
      machineId: 'machine-A',
      phase: 'claimed',
      leaseUntil: 11_000,
    });
    expect(ref?.epoch).toBeGreaterThan(0);
    expect(ref?.queueId).toMatch(/^[0-9a-f-]{36}$/i);
    const raw = fs.readFileSync(queuePath(), 'utf8');
    expect(raw).not.toContain(ref!.ownerToken);
    expect(raw).toContain('ashlr-q2:c:');
    expect(rawQueue()).toMatchObject({
      schemaVersion: 2,
      queueId: ref!.queueId,
      nextClaimEpoch: ref!.epoch + 1,
    });
    expect(store.readSnapshot().claims['item-a']?.machineId).toBe('machine-A');

    const forged = { ...ref!, ownerToken: randomUUID() };
    expect(store.renewClaims([forged])).toEqual([]);
  });

  it('rechecks worked cooldown after a stale selection before installing a claim', () => {
    const worker = new SharedStore(dir, 30_000);
    const contender = new SharedStore(dir, 30_000);
    const [ref] = worker.claimLeases(['race-cooldown-item'], 1, 'worker-A');
    expect(ref).toBeDefined();
    const executing = worker.beginClaimExecution(ref!);
    expect(executing).toBeDefined();
    expect(worker.completeClaim(executing!, 'race-cooldown-key', 'empty')).toBe(true);

    // The contender represents a daemon that selected from a snapshot taken
    // before worker A completed. The claim transaction must observe the newer
    // worked event while holding the queue lock.
    const policies = new Map([[
      'race-cooldown-item',
      { itemIds: ['race-cooldown-key'], cooldownMs: 60_000 },
    ]]);
    expect(contender.claimLeases(['race-cooldown-item'], 1, 'worker-B', policies)).toEqual([]);

    // Outcome-specific windows are resolved against that same latest event.
    const expiredFastPolicy = new Map([[
      'race-cooldown-item',
      {
        itemIds: ['race-cooldown-key'],
        cooldownMs: 60_000,
        outcomeCooldownMs: { empty: 0 },
      },
    ]]);
    expect(contender.claimLeases(['race-cooldown-item'], 1, 'worker-B', expiredFastPolicy))
      .toHaveLength(1);
  });

  it('guards a raced successful diff when no explicit claim policy is supplied', () => {
    const worker = new SharedStore(dir, 30_000);
    const contender = new SharedStore(dir, 30_000);
    expect(worker.recordOutcome('diff-race-item', 'diff', 'worker-A')).toBe(true);

    expect(contender.claimLeases(['diff-race-item'], 1, 'worker-B')).toEqual([]);
  });

  it('strictly expires a claim and fences same-machine ABA mutations', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(20_000);
    const storeA = new SharedStore(dir, 100);
    const storeB = new SharedStore(dir, 100);
    const [first] = storeA.claimLeases(['item-a'], 1, 'same-machine');
    expect(first).toBeDefined();

    now.mockReturnValue(20_100);
    expect(storeA.renewClaims([first!])).toEqual([]);
    const [successor] = storeB.claimLeases(['item-a'], 1, 'same-machine');
    expect(successor).toBeDefined();
    expect(successor!.epoch).toBeGreaterThan(first!.epoch);
    expect(successor!.ownerKey).not.toBe(first!.ownerKey);

    expect(storeA.releaseClaims([first!])).toEqual([]);
    expect(storeA.completeClaim(first!, 'cooldown-a', 'empty')).toBe(false);
    expect(storeA.renewClaims([first!])).toEqual([]);
    expect(storeB.readSnapshot().worked).toEqual([]);
    expect(storeB.readSnapshot().claims['item-a']?.machineId).toBe('same-machine');
  });

  it('makes an expired executing claim ambiguous and never reclaimable', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(30_000);
    const owner = new SharedStore(dir, 100);
    const contender = new SharedStore(dir, 100);
    const [claimed] = owner.claimLeases(['item-a'], 1, 'machine-A');
    const executing = owner.beginClaimExecution(claimed!);
    expect(executing).toMatchObject({ phase: 'executing' });
    expect(rawQueue()).toMatchObject({
      claims: { 'item-a': { leaseUntil: Number.MAX_SAFE_INTEGER } },
    });

    now.mockReturnValue(30_100);
    expect(contender.claimLeases(['item-a'], 1, 'machine-B')).toEqual([]);
    expect(owner.renewClaims([executing!])).toEqual([]);
    expect(owner.releaseClaims([executing!])).toEqual([]);
    expect(owner.completeClaim(executing!, 'item-a', 'diff')).toBe(false);

    const health = contender.readHealth({ machineId: 'machine-A', now: 30_100 });
    expect(health.activeClaims).toBe(0);
    expect(health.reclaimableClaims).toBe(0);
    expect(health.executingClaims).toBe(1);
    expect(health.ambiguousClaims).toBe(1);
    expect(health.claimSamples).toEqual([
      expect.objectContaining({
        itemId: 'item-a',
        machineId: 'machine-A',
        state: 'ambiguous',
        phase: 'executing',
      }),
    ]);
  });

  it('keeps executing work non-expiring to a legacy claimant while modern health uses the real deadline', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(35_000);
    const owner = new SharedStore(dir, 100);
    const [claimed] = owner.claimLeases(['item-a'], 1, 'machine-A');
    owner.beginClaimExecution(claimed!);

    now.mockReturnValue(35_100);
    const legacy = rawQueue();
    const legacyClaims = legacy['claims'] as Record<string, { machineId: string; leaseUntil: number }>;
    const legacyCanReclaim = !legacyClaims['item-a'] || legacyClaims['item-a']!.leaseUntil <= Date.now();
    if (legacyCanReclaim) {
      legacyClaims['item-a'] = { machineId: 'legacy-machine', leaseUntil: Date.now() + 100 };
      fs.writeFileSync(queuePath(), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
    }

    expect(legacyCanReclaim).toBe(false);
    expect(owner.readHealth({ now: 35_100 })).toMatchObject({
      activeClaims: 0,
      reclaimableClaims: 0,
      executingClaims: 1,
      ambiguousClaims: 1,
    });
  });

  it('atomically completes an exact executing claim with a distinct cooldown key', () => {
    vi.spyOn(Date, 'now').mockReturnValue(40_000);
    const store = new SharedStore(dir, 1_000);
    const [claimed] = store.claimLeases(['repair-item'], 1, 'machine-A');
    const executing = store.beginClaimExecution(claimed!);

    expect(store.completeClaim(executing!, 'repair-generation-key', 'diff')).toBe(true);
    const snapshot = store.readSnapshot();
    expect(snapshot.claims['repair-item']).toBeUndefined();
    expect(snapshot.worked).toEqual([
      expect.objectContaining({ itemId: 'repair-generation-key', outcome: 'diff' }),
    ]);
  });

  it('renews the embedded executing deadline and completes after the original deadline', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(45_000);
    const store = new SharedStore(dir, 1_000);
    const [claimed] = store.claimLeases(['item-a'], 1, 'machine-A');
    const executing = store.beginClaimExecution(claimed!);

    now.mockReturnValue(45_900);
    const [renewed] = store.renewClaims([executing!]);
    expect(renewed?.leaseUntil).toBe(46_900);
    expect(rawQueue()).toMatchObject({
      claims: { 'item-a': { leaseUntil: Number.MAX_SAFE_INTEGER } },
    });

    now.mockReturnValue(46_000);
    expect(store.completeClaim(renewed!, 'item-a', 'diff')).toBe(true);
  });

  it('quarantines expired legacy claims because their execution phase is unknowable', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(50_000);
    fs.writeFileSync(queuePath(), JSON.stringify({
      claims: { 'legacy-item': { machineId: 'legacy-machine', leaseUntil: 50_100 } },
      worked: [],
      usage: [],
    }, null, 2));
    const store = new SharedStore(dir, 100);

    expect(store.claimLeases(['legacy-item'], 1, 'machine-A')).toEqual([]);
    now.mockReturnValue(50_100);
    expect(store.claimLeases(['legacy-item'], 1, 'machine-A')).toEqual([]);
    expect(store.readHealth({ now: 50_100 })).toMatchObject({
      reclaimableClaims: 0,
      ambiguousClaims: 1,
      claimSamples: [expect.objectContaining({ itemId: 'legacy-item', state: 'ambiguous' })],
    });
  });

  it('fails closed when a downgrade strips metadata from a modern claim', () => {
    vi.spyOn(Date, 'now').mockReturnValue(60_000);
    const store = new SharedStore(dir, 1_000);
    const [ref] = store.claimLeases(['item-a'], 1, 'machine-A');
    const raw = rawQueue();
    delete raw['schemaVersion'];
    delete raw['queueId'];
    delete raw['nextClaimEpoch'];
    fs.writeFileSync(queuePath(), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const before = fs.readFileSync(queuePath(), 'utf8');

    expect(store.renewClaims([ref!])).toEqual([]);
    expect(store.releaseClaims([ref!])).toEqual([]);
    expect(store.completeClaim(ref!, 'item-a', 'empty')).toBe(false);
    expect(store.claimLeases(['item-b'], 1, 'machine-B')).toEqual([]);
    expect(fs.readFileSync(queuePath(), 'utf8')).toBe(before);
    expect(store.readHealth().readable).toBe(false);
  });

  it('distinguishes transient lock contention from loss of an active exact claim', () => {
    vi.spyOn(Date, 'now').mockReturnValue(70_000);
    const store = new SharedStore(dir, 1_000);
    const [ref] = store.claimLeases(['item-a'], 1, 'machine-A');
    const lockPath = path.join(dir, 'ashlr-fleet-queue.json.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ token: randomUUID() }), 'utf8');

    expect(store.renewClaims([ref!])).toEqual([]);
    expect(store.validateClaims([ref!])).toEqual([
      expect.objectContaining({ itemId: 'item-a', ownerToken: ref!.ownerToken }),
    ]);
  });

  it('pins the exact mutation lock so a stale reclaimer cannot overlap the queue commit', () => {
    const owner = new SharedStore(dir, 100);
    const contender = new SharedStore(dir, 100);
    const internals = owner as unknown as {
      acquireLock(): { path: string; token: string; dev: bigint; ino: bigint } | null;
      pinLock(lock: { path: string; token: string; dev: bigint; ino: bigint }): string | null;
      unpinLock(guard: string, lock: { path: string; token: string; dev: bigint; ino: bigint }): void;
      releaseLock(lock: { path: string; token: string; dev: bigint; ino: bigint }): void;
    };
    const lock = internals.acquireLock();
    expect(lock).not.toBeNull();
    const guard = internals.pinLock(lock!);
    expect(guard).not.toBeNull();
    expect(contender.claimLeases(['item-a'], 1, 'machine-B')).toEqual([]);

    internals.unpinLock(guard!, lock!);
    internals.releaseLock(lock!);
    expect(contender.claimLeases(['item-a'], 1, 'machine-B')).toHaveLength(1);
  });

  it('keeps a stale commit-pin residue fail-closed for explicit recovery', () => {
    const owner = new SharedStore(dir, 100);
    const contender = new SharedStore(dir, 100);
    const internals = owner as unknown as {
      acquireLock(): { path: string; token: string; dev: bigint; ino: bigint } | null;
      pinLock(lock: { path: string; token: string; dev: bigint; ino: bigint }): string | null;
    };
    const lock = internals.acquireLock();
    expect(lock).not.toBeNull();
    expect(internals.pinLock(lock!)).not.toBeNull();
    fs.utimesSync(lock!.path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    expect(contender.claimLeases(['item-a'], 1, 'machine-B')).toEqual([]);
    expect(contender.readHealth().lock).toMatchObject({
      present: true,
      stale: true,
      links: 2,
      recoveryRequired: true,
    });
  });

  it('keeps a crashed unlink-guard residue fail-closed instead of deleting a successor', () => {
    const owner = new SharedStore(dir, 100);
    const contender = new SharedStore(dir, 100);
    const internals = owner as unknown as {
      acquireLock(): { path: string; token: string; dev: bigint; ino: bigint } | null;
    };
    const lock = internals.acquireLock();
    expect(lock).not.toBeNull();
    fs.linkSync(lock!.path, `${lock!.path}.unlink-crash.guard`);
    fs.utimesSync(lock!.path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    expect(contender.claimLeases(['item-a'], 1, 'machine-B')).toEqual([]);
    expect(contender.readHealth().lock).toMatchObject({ recoveryRequired: true, links: 2 });
  });

  it('retries transient authority-lock contention for execution and completion', async () => {
    const store = new SharedStore(dir, 5_000);
    const [claimed] = store.claimLeases(['item-a'], 1, 'machine-A');
    const lockPath = path.join(dir, 'ashlr-fleet-queue.json.lock');

    fs.writeFileSync(lockPath, `${JSON.stringify({ token: randomUUID() })}\n`, 'utf8');
    const firstRelease = unlinkFromChild(lockPath);
    const executing = store.beginClaimExecution(claimed!);
    await firstRelease;
    expect(executing).toMatchObject({ phase: 'executing' });

    fs.writeFileSync(lockPath, `${JSON.stringify({ token: randomUUID() })}\n`, 'utf8');
    const secondRelease = unlinkFromChild(lockPath);
    expect(store.completeClaim(executing!, 'item-a', 'diff')).toBe(true);
    await secondRelease;
    expect(store.readSnapshot().claims['item-a']).toBeUndefined();
  });

  it('reconciles a visible mutation when durability reports indeterminate after rename', () => {
    const store = new SharedStore(dir, 5_000);
    const [claimed] = store.claimLeases(['item-a'], 1, 'machine-A');
    const internals = store as unknown as {
      writeQueue(queue: unknown): boolean;
    };
    const writeQueue = internals.writeQueue.bind(store);
    internals.writeQueue = (queue) => {
      expect(writeQueue(queue)).toBe(true);
      return false;
    };

    const began = store.beginClaimExecutionResult(claimed!);
    expect(began).toMatchObject({ status: 'success', value: { phase: 'executing' } });
    if (began.status !== 'success') throw new Error('expected executing readback');
    const completionId = randomUUID();
    expect(store.completeClaimResult(began.value, 'item-a', 'diff', completionId)).toEqual({
      status: 'success',
      value: undefined,
    });
    expect(store.readSnapshot().worked).toEqual([
      expect.objectContaining({ itemId: 'item-a', claimCompletionId: completionId }),
    ]);
  });

  it('treats prototype-reserved item ids as ordinary exact claim keys', () => {
    vi.spyOn(Date, 'now').mockReturnValue(80_000);
    const store = new SharedStore(dir, 1_000);
    const ids = ['__proto__', 'constructor', 'toString'];

    const refs = store.claimLeases(ids, ids.length, 'machine-A');

    expect(refs.map((ref) => ref.itemId)).toEqual(ids);
    expect(Object.keys(store.readSnapshot().claims).sort()).toEqual([...ids].sort());
  });

  it('preserves corrupt queue bytes and refuses every authority mutation', () => {
    const store = new SharedStore(dir, 1_000);
    fs.writeFileSync(queuePath(), '{"claims":', 'utf8');
    const before = fs.readFileSync(queuePath(), 'utf8');

    expect(store.claimLeases(['item-a'], 1, 'machine-A')).toEqual([]);
    expect(store.recordOutcome('item-a', 'empty', 'machine-A')).toBe(false);
    expect(store.renewClaims([])).toEqual([]);
    expect(fs.readFileSync(queuePath(), 'utf8')).toBe(before);
    expect(store.readHealth().readable).toBe(false);
  });

  it('rejects an oversized queue before allocation and preserves its bytes', () => {
    const store = new SharedStore(dir, 1_000);
    fs.writeFileSync(queuePath(), '{');
    fs.truncateSync(queuePath(), 16 * 1024 * 1024 + 1);
    const size = fs.statSync(queuePath()).size;

    expect(store.readHealth().readable).toBe(false);
    expect(store.claimLeases(['item-a'], 1, 'machine-A')).toEqual([]);
    expect(fs.statSync(queuePath()).size).toBe(size);
  });

  it('refuses a mutation whose encoded queue would exceed the reader ceiling', () => {
    const store = new SharedStore(dir, 1_000) as unknown as {
      writeQueue(queue: {
        schemaVersion: 2;
        queueId: string;
        nextClaimEpoch: number;
        claims: Record<string, { machineId: string; leaseUntil: number }>;
        worked: never[];
        usage: never[];
      }): boolean;
    };
    const claims = Object.fromEntries(Array.from({ length: 9_000 }, (_, index) => [
      `${index}-${'x'.repeat(2_000)}`,
      { machineId: 'legacy', leaseUntil: 1 },
    ]));

    expect(store.writeQueue({
      schemaVersion: 2,
      queueId: randomUUID(),
      nextClaimEpoch: 1,
      claims,
      worked: [],
      usage: [],
    })).toBe(false);
    expect(fs.existsSync(queuePath())).toBe(false);
  });

  it('refuses semantically invalid mutation values without poisoning the queue', () => {
    const store = new SharedStore(dir, 5_000);
    const [claimed] = store.claimLeases(['item-a'], 1, 'machine-A');
    const executing = store.beginClaimExecution(claimed!);
    const oversized = 'x'.repeat(2_049);

    expect(store.completeClaim(executing!, oversized, 'diff')).toBe(false);
    expect(store.recordOutcome(oversized, 'empty', 'machine-A')).toBe(false);
    store.publishUsage({ machineId: 'm'.repeat(513), engine: 'codex', ts: new Date().toISOString() });

    expect(store.readHealth().readable).toBe(true);
    expect(store.readSnapshot().claims['item-a']).toBeDefined();
    expect(store.readSnapshot().worked).toEqual([]);
    expect(store.readSnapshot().usage).toEqual([]);
  });

  it('reports local primitive failure separately from queue readability', () => {
    const regularFile = path.join(dir, 'not-a-directory');
    fs.writeFileSync(regularFile, 'fixture', 'utf8');
    const store = new SharedStore(regularFile, 1_000);
    const capability = store.readCapabilityStatus({ probe: true });
    const health = store.readHealth();

    expect(health.readable).toBe(true);
    expect(capability).toMatchObject({
      scope: 'local-primitives-only',
      checked: true,
      verified: false,
      failure: 'directory-create',
    });
  });
});

/** Real private header publication with inert transport; no provider calls. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runResourceTask, setResourcePoolAllocation } from '../src/core/resources/pool-runtime.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import type { ResourcePool, ResourceObservation } from '../src/core/resources/pool-policy.js';
import * as workers from '../src/core/resources/worker.js';

const hooks = vi.hoisted(() => ({ afterSync: null as (() => void) | null,
  afterAssurance: null as ((path: string) => void) | null, afterDirectorySync: null as (() => void) | null }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: (fd: number) => { actual.fsyncSync(fd); hooks.afterSync?.(); } };
});
vi.mock('../src/core/util/private-storage.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return { ...actual, assurePrivateStoragePath: (...args: Parameters<typeof actual.assurePrivateStoragePath>) => {
    const result = actual.assurePrivateStoragePath(...args); hooks.afterAssurance?.(args[0]); return result;
  } };
});
vi.mock('../src/core/util/durability.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/util/durability.js')>();
  return { ...actual, fsyncDirectory: (...args: Parameters<typeof actual.fsyncDirectory>) => {
    const result = actual.fsyncDirectory(...args); hooks.afterDirectorySync?.(); return result;
  } };
});
const roots: string[] = [];
afterEach(() => {
  hooks.afterSync = null; hooks.afterAssurance = null; hooks.afterDirectorySync = null; vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(existing = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'resource-publication-'))); roots.push(base);
  const root = join(base, 'ledger'); const cwd = join(base, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
  const pool: ResourcePool = { schemaVersion: 1, id: 'publication', workers: [{ id: 'local', provider: 'local', model: 'inert',
    maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] };
  const bindings: workers.ResourceBinding[] = [{ workerId: 'local', capacityKey: 'local-account', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }];
  const observations: ResourceObservation[] = [{ workerId: 'local', observedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'ready', retryAfter: null, windows: [] }];
  const execute = vi.spyOn(workers, 'executeResourceWorker').mockResolvedValue({ status: 'completed', output: 'inert',
    inputTokens: 1, outputTokens: 1, usageScope: 'local-chat-completion', reason: 'worker-completed' });
  if (existing) setResourcePoolAllocation(root, pool, bindings, 75, 0);
  const file = join(root, 'pool-state.json');
  const empty = JSON.stringify({ schemaVersion: 1, poolDigest: resourcePoolConfigSnapshot(pool, bindings).poolDigest, observations: [], attempts: [] }) + '\n';
  const run = (change: () => void = () => {}) => {
    const evidence = vi.fn(() => { change(); return { observations, unavailableWorkerIds: [] }; });
    const result = runResourceTask({ root, pool, bindings, observations, task: { schemaVersion: 1, id: 'task',
      allowedWorkerIds: ['local'], prompt: 'inert', cwd, mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 32 }, readAdmissionEvidence: evidence });
    return { result, evidence };
  };
  const noStaging = () => expect(readdirSync(root).filter(name => name.startsWith('.pool-state-') || name === '.pool.lock')).toEqual([]);
  return { root, file, empty, run, execute, noStaging };
}

describe.skipIf(process.platform === 'win32')('resource header source custody and publication', () => {
  it.each(['in-place', 'same-bytes-replacement', 'removed', 'permissions'] as const)(
    'refuses an admission callback that changes the captured source: %s', async kind => {
      const f = fixture(); const before = readFileSync(f.file, 'utf8'); let external = before;
      const { result, evidence } = f.run(() => {
        if (kind === 'in-place') {
          const value = JSON.parse(before); value.allocation.ceilingPercent = 0;
          external = JSON.stringify(value) + '\n'; writeFileSync(f.file, external);
        } else if (kind === 'same-bytes-replacement') {
          const replacement = join(f.root, 'external.json'); writeFileSync(replacement, before, { mode: 0o600 }); renameSync(replacement, f.file);
        } else if (kind === 'removed') unlinkSync(f.file);
        else chmodSync(f.file, 0o644);
      });
      await expect(result).rejects.toThrow('Resource ledger source changed');
      expect(evidence).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
      if (kind === 'removed') expect(existsSync(f.file)).toBe(false); else expect(readFileSync(f.file, 'utf8')).toBe(external);
      f.noStaging();
    });
  it('does not overwrite a header created after capturing a missing source', async () => {
    const f = fixture(false);
    const { result, evidence } = f.run(() => writeFileSync(f.file, f.empty, { mode: 0o600 }));
    await expect(result).rejects.toThrow('Resource ledger source changed');
    expect(readFileSync(f.file, 'utf8')).toBe(f.empty); expect(evidence).toHaveBeenCalledOnce();
    expect(f.execute).not.toHaveBeenCalled(); f.noStaging();
  });
  it('rechecks the source after staging/fsync, immediately before publication', async () => {
    const f = fixture(); const before = readFileSync(f.file, 'utf8'); let changed = false;
    hooks.afterSync = () => {
      if (!readdirSync(f.root).some(name => name.startsWith('.pool-state-'))) return;
      hooks.afterSync = null; changed = true;
      const replacement = join(f.root, 'external.json'); writeFileSync(replacement, before, { mode: 0o600 }); renameSync(replacement, f.file);
    };
    const { result, evidence } = f.run(); await expect(result).rejects.toThrow('Resource ledger source changed');
    expect(changed).toBe(true); expect(evidence).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
    expect(readFileSync(f.file, 'utf8')).toBe(before); f.noStaging();
  });
  it.each(['bytes', 'permissions', 'replacement'] as const)('refuses a staged header changed during fsync: %s', async kind => {
    const f = fixture(); const before = readFileSync(f.file, 'utf8'); let changed = false;
    hooks.afterSync = () => {
      const name = readdirSync(f.root).find(name => name.startsWith('.pool-state-')); if (!name) return;
      hooks.afterSync = null; changed = true; const staged = join(f.root, name);
      if (kind === 'bytes') writeFileSync(staged, '{}\n');
      else if (kind === 'permissions') chmodSync(staged, 0o644);
      else {
        const replacement = join(f.root, 'external.json'); writeFileSync(replacement, readFileSync(staged), { mode: 0o600 }); renameSync(replacement, staged);
      }
    };
    await expect(f.run().result).rejects.toThrow(); expect(changed).toBe(true);
    expect(readFileSync(f.file, 'utf8')).toBe(before); expect(f.execute).not.toHaveBeenCalled();
    if (kind === 'replacement') {
      expect(readdirSync(f.root).filter(name => name.startsWith('.pool-state-'))).toHaveLength(1);
      expect(existsSync(join(f.root, '.pool.lock'))).toBe(false);
    } else f.noStaging();
  });
  it('compares source identity after the assurance adapter returns', async () => {
    const f = fixture(); const before = readFileSync(f.file, 'utf8'); let changed = false;
    hooks.afterAssurance = path => {
      if (path !== f.file || !readdirSync(f.root).some(name => name.startsWith('.pool-state-'))) return;
      hooks.afterAssurance = null; changed = true;
      const replacement = join(f.root, 'external.json'); writeFileSync(replacement, before, { mode: 0o600 }); renameSync(replacement, f.file);
    };
    await expect(f.run().result).rejects.toThrow('Resource ledger source changed');
    expect(changed).toBe(true); expect(readFileSync(f.file, 'utf8')).toBe(before); expect(f.execute).not.toHaveBeenCalled(); f.noStaging();
  });
  it('rechecks staged evidence after the last source guard', async () => {
    const f = fixture(); const before = readFileSync(f.file, 'utf8'); let changed = false;
    hooks.afterAssurance = path => {
      if (path !== f.file) return;
      const name = readdirSync(f.root).find(name => name.startsWith('.pool-state-')); if (!name) return;
      hooks.afterAssurance = null; changed = true; writeFileSync(join(f.root, name), '{}\n');
    };
    await expect(f.run().result).rejects.toThrow('Resource ledger staged header changed');
    expect(changed).toBe(true); expect(readFileSync(f.file, 'utf8')).toBe(before); expect(f.execute).not.toHaveBeenCalled(); f.noStaging();
  });
  it('retains a published reservation after a directory-sync failure without replaying effects', async () => {
    const f = fixture(); let failed = false;
    hooks.afterDirectorySync = () => {
      if (!existsSync(f.file) || JSON.parse(readFileSync(f.file, 'utf8')).attempts[0]?.status !== 'reserved') return;
      hooks.afterDirectorySync = null; failed = true; throw new Error('fixture post-publication sync failure');
    };
    const first = f.run(); await expect(first.result).rejects.toThrow('post-publication sync failure');
    expect(failed).toBe(true); expect(first.evidence).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(f.file, 'utf8')).attempts[0].status).toBe('reserved');
    const replay = f.run(() => { throw new Error('must not replay'); });
    expect(await replay.result).toMatchObject({ replayed: true, receipt: { status: 'reserved' } });
    expect(replay.evidence).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); f.noStaging();
  });
  it('publishes a normal reservation/settlement and replays without running admission effects again', async () => {
    const f = fixture(); const first = f.run(); expect((await first.result).receipt?.status).toBe('completed');
    expect(first.evidence).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
    const replay = f.run(() => { throw new Error('must not replay callback'); });
    expect((await replay.result).replayed).toBe(true); expect(replay.evidence).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledOnce(); f.noStaging();
  });
});

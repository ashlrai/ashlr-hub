import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { LocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const hooks = vi.hoisted(() => ({ stat: vi.fn(), open: vi.fn(), inspect: vi.fn(), owns: vi.fn(), acquire: vi.fn(), release: vi.fn(),
  read: vi.fn(), close: vi.fn() }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), lstatSync: hooks.stat, opendirSync: hooks.open }));
vi.mock('../src/core/universe/artifacts.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/artifacts.js')>(), inspectPrivateDirectory: hooks.inspect,
}));
vi.mock('../src/core/fleet/local-store-lock.js', async (original) => ({
  ...await original<typeof import('../src/core/fleet/local-store-lock.js')>(), ownsLocalStoreLock: hooks.owns,
  acquireLocalStoreLockWithOutcome: hooks.acquire, releaseLocalStoreLock: hooks.release,
}));
import { recoverControllerRecordLock } from '../src/core/universe/controller-lock-recovery.js';

const root = '/private/controller-recovery-fixture';
const directory = join(root, 'portfolios', 'controller');
const ledger = join(directory, 'ledger');
const records = join(ledger, 'records');
const staging = join(ledger, 'staging');
const writerPath = join(ledger, '.records.lock');
const execution = { path: join(directory, '.execution.lock'), token: 'execution', dev: 1n, ino: 2n } as LocalStoreLock;
const writer = { path: writerPath, token: 'writer', dev: 1n, ino: 3n } as LocalStoreLock;
const missing = () => Object.assign(new Error('missing fixture path'), { code: 'ENOENT' });
const run = () => recoverControllerRecordLock('controller', { root }, execution);

beforeEach(() => {
  for (const hook of Object.values(hooks)) hook.mockReset();
  hooks.stat.mockReturnValue({ dev: 1n, ino: 1n });
  hooks.owns.mockReturnValue(true);
  hooks.acquire.mockReturnValue({ state: 'acquired', lock: writer });
  hooks.release.mockReturnValue(true);
  hooks.read.mockReturnValue(null);
  hooks.open.mockReturnValue({ readSync: hooks.read, closeSync: hooks.close });
});

describe('controller writer-mutex recovery', () => {
  it('uses the authoritative exact scoped mutex and releases it before returning', () => {
    run();
    expect(hooks.acquire).toHaveBeenCalledExactlyOnceWith(writerPath, 0, { anchorPath: directory, exactPrivateStorage: true });
    expect(hooks.release).toHaveBeenCalledExactlyOnceWith(writer);
    expect(hooks.read).toHaveBeenCalledTimes(2);
    expect(hooks.close).toHaveBeenCalledTimes(2);
    expect(hooks.inspect.mock.calls.map(([path]) => path)).toEqual([directory, ledger, records, staging, ledger, records, staging]);
  });

  it.each([ledger, writerPath])('does not initialize absent storage or mutex: %s', (missingPath) => {
    hooks.stat.mockImplementation((path) => { if (path === missingPath) throw missing(); return { dev: 1n, ino: 1n }; });
    run();
    expect(hooks.acquire).not.toHaveBeenCalled();
    expect(hooks.release).not.toHaveBeenCalled();
  });

  it.each([records, staging])('rejects missing existing ledger subdirectory: %s', (missingPath) => {
    hooks.inspect.mockImplementation((path) => { if (path === missingPath) throw missing(); });
    expect(run).toThrow('missing fixture path');
    expect(hooks.acquire).not.toHaveBeenCalled();
  });

  it('rejects unsafe private layout before touching mutex ownership', () => {
    hooks.inspect.mockImplementation((path) => { if (path === ledger) throw new Error('unsafe'); });
    expect(run).toThrow('unsafe');
    expect(hooks.acquire).not.toHaveBeenCalled();
  });

  it('requires actual controller execution ownership', () => {
    hooks.owns.mockReturnValue(false);
    expect(run).toThrow('Controller execution ownership unavailable');
    expect(hooks.stat).not.toHaveBeenCalled();
    expect(hooks.acquire).not.toHaveBeenCalled();
  });

  it('rejects an ownership handle for a different controller', () => {
    expect(() => recoverControllerRecordLock('controller', { root }, { ...execution, path: '/unrelated/.execution.lock' })).toThrow('Controller execution ownership unavailable');
    expect(hooks.acquire).not.toHaveBeenCalled();
  });

  it.each(['contended', 'unavailable'])('leaves live or unknown writer ownership untouched: %s', (state) => {
    hooks.acquire.mockReturnValue({ state, lock: null });
    expect(run).toThrow('Controller record ownership unavailable');
    expect(hooks.release).not.toHaveBeenCalled();
  });

  it('withholds staged publication before any mutex mutation using one bounded entry read', () => {
    hooks.read.mockReturnValue({ name: '.unpublished.stage' });
    expect(run).toThrow('Controller publication requires explicit recovery');
    expect(hooks.acquire).not.toHaveBeenCalled();
    expect(hooks.read).toHaveBeenCalledTimes(1);
    expect(hooks.close).toHaveBeenCalledTimes(1);
  });

  it('releases its mutex but withholds publication appearing during acquisition', () => {
    hooks.read.mockReturnValueOnce(null).mockReturnValueOnce({ name: '.unpublished.stage' });
    expect(run).toThrow('Controller publication requires explicit recovery');
    expect(hooks.release).toHaveBeenCalledExactlyOnceWith(writer);
  });

  it.each([ledger, records, staging])('rejects swapped storage identity under mutex: %s', (changedPath) => {
    const observations = new Map<string, number>();
    hooks.stat.mockImplementation((path: string, options?: { bigint?: boolean }) => {
      if (options?.bigint) observations.set(path, (observations.get(path) ?? 0) + 1);
      return { dev: 1n, ino: path === changedPath && (observations.get(path) ?? 0) > 1 ? 2n : 1n };
    });
    expect(run).toThrow('Controller record storage changed');
    expect(hooks.release).toHaveBeenCalledExactlyOnceWith(writer);
  });

  it('does not report success after failed release', () => {
    hooks.release.mockReturnValue(false);
    expect(run).toThrow('Controller record ownership release failed');
  });

  it('releases its mutex if outer execution ownership is lost during acquisition', () => {
    hooks.owns.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    expect(run).toThrow('Controller execution ownership unavailable');
    expect(hooks.release).toHaveBeenCalledExactlyOnceWith(writer);
  });

  it('closes the bounded staging handle when inspection fails', () => {
    hooks.read.mockImplementation(() => { throw new Error('read failed'); });
    expect(run).toThrow('read failed');
    expect(hooks.close).toHaveBeenCalledExactlyOnceWith();
    expect(hooks.acquire).not.toHaveBeenCalled();
  });
});

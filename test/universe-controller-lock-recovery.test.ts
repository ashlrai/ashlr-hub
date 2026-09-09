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
import { ControllerRecoveryError, readControllerRecoveryDiagnostic, type ControllerRecoveryErrorCode } from '../src/core/universe/controller-recovery-error.js';

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
function expectRecoveryCode(code: ControllerRecoveryErrorCode): void {
  let failure: unknown;
  try { run(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ControllerRecoveryError);
  expect(readControllerRecoveryDiagnostic(failure)?.code).toBe(code);
}

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
    expectRecoveryCode('controller-execution-ownership-unavailable');
    expect(hooks.stat).not.toHaveBeenCalled();
    expect(hooks.acquire).not.toHaveBeenCalled();
  });

  it('rejects an ownership handle for a different controller', () => {
    expect(() => recoverControllerRecordLock('controller', { root }, { ...execution, path: '/unrelated/.execution.lock' })).toThrow('Controller execution ownership unavailable');
    expect(hooks.acquire).not.toHaveBeenCalled();
  });

  it.each(['contended', 'unavailable'])('leaves live or unknown writer ownership untouched: %s', (state) => {
    hooks.acquire.mockReturnValue({ state, lock: null });
    expectRecoveryCode(state === 'contended' ? 'controller-record-writer-busy' : 'controller-record-ownership-unavailable');
    expect(hooks.release).not.toHaveBeenCalled();
  });

  it('withholds staged publication before any mutex mutation using one bounded entry read', () => {
    hooks.read.mockReturnValue({ name: '.unpublished.stage' });
    expectRecoveryCode('controller-publication-recovery-required');
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
    expectRecoveryCode('controller-record-storage-changed');
    expect(hooks.release).toHaveBeenCalledExactlyOnceWith(writer);
  });

  it('does not report success after failed release', () => {
    hooks.release.mockReturnValue(false);
    expectRecoveryCode('controller-record-release-failed');
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

describe('allowlisted controller recovery diagnostics', () => {
  it.each([
    ['controller-execution-ownership-unavailable', 'Controller execution ownership unavailable for record-lock recovery', 'Do not remove locks manually.'],
    ['controller-publication-recovery-required', 'Controller publication requires explicit recovery', 'Preserve staged records'],
    ['controller-record-writer-busy', 'Controller record writer is busy', 'original deadline'],
    ['controller-record-ownership-unavailable', 'Controller record ownership unavailable', 'Unknown ownership'],
    ['controller-record-storage-changed', 'Controller record storage changed during ownership recovery', 'Do not recreate or replace ledger directories.'],
    ['controller-record-release-failed', 'Controller record ownership release failed', 'did not confirm'],
  ] as const)('maps %s to fixed safe text', (code, message, hint) => {
    const error = new ControllerRecoveryError(code);
    expect(error.message).toBe(message);
    const diagnostic = readControllerRecoveryDiagnostic(error);
    expect(diagnostic).toEqual({ code, message, nextStep: error.nextStep });
    expect(diagnostic!.nextStep).toContain(hint);
  });

  it.each([null, undefined, 'controller-record-writer-busy', new Error('Controller record writer is busy'),
    { code: 'controller-record-writer-busy', message: 'Controller record writer is busy' },
    Object.assign(new Error('PRIVATE-CREDENTIAL'), { code: 'controller-record-writer-busy' }),
  ])('does not classify untyped failure %#', (error) => {
    expect(readControllerRecoveryDiagnostic(error)).toBeNull();
  });

  it('does not copy mutable message, cause, or next-step text', () => {
    const error = new ControllerRecoveryError('controller-record-writer-busy');
    Object.assign(error, { message: 'PRIVATE-CREDENTIAL', cause: 'PRIVATE-CREDENTIAL', nextStep: 'PRIVATE-CREDENTIAL' });
    const result = readControllerRecoveryDiagnostic(error);
    expect(result?.code).toBe('controller-record-writer-busy');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-CREDENTIAL');
  });

  it.each(['unknown', '__proto__', 'constructor', null, 42])('rejects a changed nonallowlisted code: %s', (code) => {
    const error = new ControllerRecoveryError('controller-record-writer-busy');
    Object.defineProperty(error, 'code', { value: code });
    expect(readControllerRecoveryDiagnostic(error)).toBeNull();
  });

  it('does not invoke a code accessor', () => {
    const error = new ControllerRecoveryError('controller-record-writer-busy');
    const getter = vi.fn(() => { throw new Error('PRIVATE-CREDENTIAL'); });
    Object.defineProperty(error, 'code', { get: getter });
    expect(readControllerRecoveryDiagnostic(error)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it('requires an own code rather than an inherited code', () => {
    const error = Object.create(new ControllerRecoveryError('controller-record-writer-busy')) as unknown;
    expect(readControllerRecoveryDiagnostic(error)).toBeNull();
  });

  it('contains inspection failures without revealing their prose', () => {
    const error = new Proxy(new ControllerRecoveryError('controller-record-writer-busy'), {
      getOwnPropertyDescriptor: () => { throw new Error('PRIVATE-CREDENTIAL'); },
    });
    expect(readControllerRecoveryDiagnostic(error)).toBeNull();
  });
});

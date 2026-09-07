import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdResourcePool } from '../src/cli/resource-pool.js';

const backend = vi.hoisted(() => ({ imported: vi.fn(), read: vi.fn(), validateTask: vi.fn(), status: vi.fn(), run: vi.fn(),
  bindings: vi.fn(), config: vi.fn(), monitor: vi.fn() }));
vi.mock('../src/core/resources/pool-runtime.js', async (original) => {
  const { mergeResourceObservations } = await original<typeof import('../src/core/resources/pool-runtime.js')>();
  backend.imported(); return { readResourceJson: backend.read, validateResourceTask: backend.validateTask,
    resourcePoolStatus: backend.status, runResourceTask: backend.run, mergeResourceObservations };
});
vi.mock('../src/core/resources/worker.js', () => ({ validateResourceBindings: backend.bindings }));
vi.mock('../src/core/config.js', () => { backend.config(); throw new Error('Legacy config must not load'); });
vi.mock('../src/core/fabric/resource-monitor.js', () => { backend.monitor(); throw new Error('Legacy monitor must not load'); });

const root = '/private/fixture/resource-root';
const files = { pool: '/private/fixture/pool.json', bindings: '/private/fixture/bindings.json',
  observations: '/private/fixture/observations.json', task: '/private/fixture/task.json' };
const scope = ['--root', root, '--pool', files.pool, '--bindings', files.bindings, '--observations', files.observations];
const definition = () => ({ schemaVersion: 1, id: 'pool-a', workers: [{ id: 'codex-a', provider: 'codex', model: 'fixture-model',
  maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 0, allowUnknownQuota: true }] });
const task = () => ({ schemaVersion: 1, id: 'task-a', allowedWorkerIds: ['codex-a'], prompt: 'PRIVATE_TASK_PROMPT',
  cwd: '/private/fixture/work', timeoutMs: 1_000, maxOutputTokens: 16, mode: 'read-only' });
const bindings = [{ workerId: 'codex-a', capacityKey: 'codex-account-a', kind: 'native-cli', command: ['/private/fixture/owned-wrapper'] }];
const plan = { schemaVersion: 1, poolId: 'pool-a', sampledAt: '2026-09-07T00:00:00.000Z', selectedWorkerId: 'codex-a',
  candidates: [{ workerId: 'codex-a' }], exclusions: [], nextEligibleAt: null };
function result(status = 'completed') {
  return { receipt: { status, verifiedAccepted: false, workerId: 'codex-a' }, plan, replayed: false, output: 'PRIVATE_WORKER_OUTPUT é' };
}
function added(signal: 'SIGINT' | 'SIGTERM', before: ReturnType<typeof process.listeners>) {
  const listener = process.listeners(signal).find((entry) => !before.includes(entry));
  expect(listener).toBeDefined(); return listener!;
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const directories: string[] = [];
function scratch(): string { const path = mkdtempSync(join(tmpdir(), 'resource-pool-cli-')); directories.push(path); return path; }
let output: ReturnType<typeof vi.spyOn>; let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  backend.read.mockImplementation((path: string) => {
    if (path === files.pool) return definition(); if (path === files.bindings) return bindings;
    if (path === files.observations) return []; if (path === files.task) return task();
    throw new Error('Unexpected owned fixture read');
  });
  backend.bindings.mockReturnValue(bindings); backend.validateTask.mockImplementation((value: unknown) => value);
  backend.status.mockReturnValue({ schemaVersion: 1, sourceState: 'healthy', poolId: 'pool-a', plan, attempts: [] });
  backend.run.mockResolvedValue(result());
});
afterEach(() => {
  expect(backend.config).not.toHaveBeenCalled(); expect(backend.monitor).not.toHaveBeenCalled();
  vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('explicit resource pool CLI parsing and admission', () => {
  it.each([
    [], ['other'], ['status'], ['run', ...scope], ['status', ...scope, '--task', files.task],
    ['status', ...scope, '--output', '/private/fixture/output'], ['status', ...scope, '--root', '/private/other'],
    ['status', ...scope, '--json', '--json'], ['status', ...scope, '--unknown'], ['status', ...scope, 'extra'],
    ['status', ...scope, '--'], ['status', ...scope, '--help'], ['status', '--help', '--json'],
    ['status', '--root=somewhere'], ['status', ...scope, '--bindings'],
    ['run', ...scope, '--task', files.task, '--output'], ['run', ...scope, '--task', files.task, '--output', 'relative'],
    ['run', ...scope, '--task', files.task, '--output', '/'], ['status', '--root', '/', ...scope.slice(2)],
    ['status', '--root', '~/.ashlr', ...scope.slice(2)], ['status', '--root', '/private/..', ...scope.slice(2)],
    ['status', '--root', '/private/x\n', ...scope.slice(2)], ['status', '--root', '/private/x\u0085', ...scope.slice(2)],
    ['status', '--root', `/${'é'.repeat(2048)}`, ...scope.slice(2)], Array.from({ length: 21 }, () => '--json'),
  ])('rejects %j before runtime import, file read or dispatch', async (...args) => {
    const imports = backend.imported.mock.calls.length;
    expect(await cmdResourcePool(args)).toBe(2); expect(backend.imported).toHaveBeenCalledTimes(imports);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.run).not.toHaveBeenCalled();
  });

  it.each([['--help'], ['-h'], ['status', '--help'], ['run', '-h']])('shows help without runtime contact for %j', async (...args) => {
    const imports = backend.imported.mock.calls.length;
    expect(await cmdResourcePool(args)).toBe(0); expect(backend.imported).toHaveBeenCalledTimes(imports);
    expect(output.mock.calls[0]![0]).toContain('completion is not verified');
    expect(output.mock.calls[0]![0]).toContain('Existing files are never overwritten');
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.run).not.toHaveBeenCalled();
  });

  it.each(['healthy', 'missing'])('status reports %s without initializing or executing', async (sourceState) => {
    backend.status.mockReturnValue({ schemaVersion: 1, sourceState, poolId: 'pool-a', plan, attempts: [] });
    expect(await cmdResourcePool(['status', ...scope, '--json'])).toBe(0);
    expect(backend.status).toHaveBeenCalledWith(root, definition(), bindings, []);
    expect(JSON.parse(output.mock.calls[0]![0] as string).sourceState).toBe(sourceState);
    expect(backend.read.mock.calls.map(([path]) => path)).toEqual([files.pool, files.bindings, files.observations]);
    expect(backend.read.mock.calls.every(([, bound]) => bound === 2 * 1024 * 1024)).toBe(true);
    expect(backend.run).not.toHaveBeenCalled();
  });

  it.each(['pool', 'bindings', 'observations', 'task'])('rejects an invalid %s manifest before output reservation or worker contact', async (kind) => {
    const destination = join(scratch(), 'result.txt');
    if (kind === 'pool') backend.read.mockImplementation((path: string) => path === files.pool ? {} : path === files.task ? task() : []);
    if (kind === 'bindings') backend.bindings.mockImplementation(() => { throw new Error('Private binding detail'); });
    if (kind === 'observations') backend.read.mockImplementation((path: string) => path === files.pool ? definition() : path === files.observations ? {} : task());
    if (kind === 'task') backend.validateTask.mockImplementation(() => { throw new Error('Private task detail'); });
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--output', destination, '--json'])).toBe(2);
    expect(existsSync(destination)).toBe(false); expect(backend.run).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string).error).toBe('Invalid resource pool, binding, observation or task manifest');
  });

  it('sanitizes file read failures without echoing raw paths or prompts', async () => {
    backend.read.mockImplementation(() => { throw new Error('private credential pathname'); });
    expect(await cmdResourcePool(['status', ...scope, '--json'])).toBe(1);
    expect(JSON.stringify(output.mock.calls)).not.toContain('private credential pathname'); expect(backend.run).not.toHaveBeenCalled();
  });

  it('rejects a task naming unenrolled workers before reserving output or invoking runtime dispatch', async () => {
    const destination = join(scratch(), 'result.txt');
    backend.validateTask.mockReturnValue({ ...task(), allowedWorkerIds: ['not-in-pool'] });
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--output', destination, '--json'])).toBe(2);
    expect(existsSync(destination)).toBe(false); expect(backend.run).not.toHaveBeenCalled();
  });
});

describe('foreground resource task result, output and cancellation', () => {
  it.each([false, true])('dispatches exact inputs and never prints transient output or prompt (json=%s)', async (json) => {
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, ...(json ? ['--json'] : [])])).toBe(0);
    expect(backend.run).toHaveBeenCalledExactlyOnceWith({ root, pool: definition(), bindings, observations: [], task: task(), signal: expect.any(AbortSignal) });
    const printed = [...output.mock.calls, ...errors.mock.calls].flat().join('\n');
    expect(printed).not.toContain('PRIVATE_WORKER_OUTPUT'); expect(printed).not.toContain('PRIVATE_TASK_PROMPT');
    if (json) {
      const parsed = JSON.parse(output.mock.calls[0]![0] as string);
      expect(parsed).not.toHaveProperty('output'); expect(parsed.outputFile).toBeNull(); expect(parsed.receipt.verifiedAccepted).toBe(false);
    } else expect(printed).toContain('not verified accepted');
  });

  it.each(['reserved', 'failed', 'timed-out', 'cancelled', 'uncertain'])('returns exit1 for %s without worker text', async (status) => {
    backend.run.mockResolvedValue(result(status));
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string).receipt.status).toBe(status);
    expect(JSON.stringify(output.mock.calls)).not.toContain('PRIVATE_WORKER_OUTPUT');
  });

  it('returns exit3 for no capacity without claiming a dispatch', async () => {
    backend.run.mockResolvedValue({ receipt: null, plan: { ...plan, selectedWorkerId: null, candidates: [] }, replayed: false, output: null });
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--json'])).toBe(3);
    expect(JSON.parse(output.mock.calls[0]![0] as string).receipt).toBeNull();
  });

  it('reserves an exclusive private file before contact and writes only completed output via its descriptor', async () => {
    const destination = join(scratch(), 'result.txt');
    backend.run.mockImplementation(async () => {
      expect(existsSync(destination)).toBe(true); expect(readFileSync(destination, 'utf8')).toBe('');
      if (process.platform !== 'win32') expect(lstatSync(destination).mode & 0o777).toBe(0o600);
      return result();
    });
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--output', destination, '--json'])).toBe(0);
    expect(readFileSync(destination, 'utf8')).toBe('PRIVATE_WORKER_OUTPUT é');
    expect(JSON.parse(output.mock.calls[0]![0] as string).outputFile).toEqual({ path: destination, state: 'written',
      bytes: Buffer.byteLength('PRIVATE_WORKER_OUTPUT é') });
    expect(JSON.stringify(output.mock.calls)).not.toContain('PRIVATE_WORKER_OUTPUT');
  });

  it.each([false, true])('rejects an existing output %s before model contact and preserves it', async (symlink) => {
    const directory = scratch(); const existing = join(directory, 'existing'); const destination = join(directory, 'result.txt');
    writeFileSync(existing, 'retain-existing');
    if (symlink) symlinkSync(existing, destination); else writeFileSync(destination, 'retain-target');
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--output', destination])).toBe(1);
    expect(backend.run).not.toHaveBeenCalled(); expect(readFileSync(existing, 'utf8')).toBe('retain-existing');
    expect(readFileSync(destination, 'utf8')).toBe(symlink ? 'retain-existing' : 'retain-target');
  });

  it.each(['failed', 'cancelled', 'uncertain'])('leaves and identifies its empty reserved output after %s', async (status) => {
    const destination = join(scratch(), 'result.txt'); backend.run.mockResolvedValue(result(status));
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--output', destination, '--json'])).toBe(1);
    expect(readFileSync(destination, 'utf8')).toBe('');
    expect(JSON.parse(output.mock.calls[0]![0] as string).outputFile).toEqual({ path: destination, state: 'empty', bytes: 0 });
  });

  it('withholds oversized task text and preserves an identified empty output reservation', async () => {
    const destination = join(scratch(), 'result.txt');
    backend.run.mockResolvedValue({ ...result(), output: '!'.repeat(1024 * 1024 + 1) });
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--output', destination, '--json'])).toBe(1);
    expect(readFileSync(destination, 'utf8')).toBe('');
    expect(JSON.parse(output.mock.calls[0]![0] as string).outputFile).toEqual({ path: destination, state: 'empty', bytes: 0 });
    expect(JSON.stringify(output.mock.calls).length).toBeLessThan(1_024);
  });

  it('cancels during manifest validation before output reservation or dispatch', async () => {
    const destination = join(scratch(), 'result.txt'); const before = process.listeners('SIGINT');
    backend.validateTask.mockImplementation((value: unknown) => { added('SIGINT', before)(); return value; });
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--output', destination])).toBe(1);
    expect(existsSync(destination)).toBe(false); expect(backend.run).not.toHaveBeenCalled();
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('does not redispatch a replayed result or invent recoverable output', async () => {
    backend.run.mockResolvedValue({ ...result(), replayed: true, output: null });
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string).replayed).toBe(true);
    const destination = join(scratch(), 'result.txt'); output.mockClear();
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--output', destination, '--json'])).toBe(1);
    expect(readFileSync(destination, 'utf8')).toBe(''); expect(backend.run).toHaveBeenCalledTimes(2);
  });

  it('cancels during lazy import without reading files or reserving output', async () => {
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM');
    const running = cmdResourcePool(['run', ...scope, '--task', files.task]); added('SIGINT', beforeInt)();
    expect(await running).toBe(1); expect(backend.read).not.toHaveBeenCalled(); expect(backend.run).not.toHaveBeenCalled();
    expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it('aborts and awaits the exact owned task for repeated SIGINT/SIGTERM, then removes listeners', async () => {
    const pending = deferred<ReturnType<typeof result>>(); backend.run.mockReturnValue(pending.promise);
    const beforeInt = process.listeners('SIGINT'); const beforeTerm = process.listeners('SIGTERM'); let finished = false;
    const running = cmdResourcePool(['run', ...scope, '--task', files.task, '--json']).then((code) => { finished = true; return code; });
    await vi.waitFor(() => expect(backend.run).toHaveBeenCalledOnce());
    const signal = backend.run.mock.calls[0]![0].signal as AbortSignal;
    added('SIGINT', beforeInt)(); added('SIGTERM', beforeTerm)(); expect(signal.aborted).toBe(true);
    await Promise.resolve(); expect(finished).toBe(false); pending.resolve(result('cancelled'));
    expect(await running).toBe(1); expect(backend.run).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(beforeInt); expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it('sanitizes a rejected dispatch and closes the reserved descriptor without losing its file', async () => {
    const destination = join(scratch(), 'result.txt'); const before = process.listeners('SIGINT');
    backend.run.mockRejectedValue(new Error('PRIVATE_MODEL_FAILURE'));
    expect(await cmdResourcePool(['run', ...scope, '--task', files.task, '--output', destination, '--json'])).toBe(1);
    expect(readFileSync(destination, 'utf8')).toBe(''); expect(JSON.stringify(output.mock.calls)).not.toContain('PRIVATE_MODEL_FAILURE');
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('delegates from resources before loading the legacy monitor or configuration', async () => {
    const { cmdResources } = await import('../src/cli/resources.js');
    expect(await cmdResources(['pool', 'run', '--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('ashlr resources pool'); expect(backend.run).not.toHaveBeenCalled();
    output.mockClear(); expect(await cmdResources(['--help'])).toBe(0);
    expect(output.mock.calls.flat().join('\n')).toContain('pool status|run|observe|probe|console|benchmark --help');
  });
});

describe('owner-supplied quota export normalization CLI', () => {
  const capturedMs = Date.now() - 120_000;
  const capturedAt = new Date(capturedMs).toISOString();
  const nativeFile = '/private/fixture/native-result.json'; const previousFile = '/private/fixture/previous.json';
  const observe = (extra: string[] = []) => ['observe', '--pool', files.pool, '--worker', 'codex-a', '--provider', 'codex',
    '--input', nativeFile, '--captured-at', capturedAt, '--bucket', 'codex', ...extra];
  const native = () => ({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 25,
    windowDurationMins: 300, resetsAt: Math.floor((capturedMs + 3_600_000) / 1000) } } }, privateAccountEmail: 'PRIVATE_OWNER_METADATA' });
  function inputs(poolValue: unknown = definition(), nativeValue: unknown = native(), prior: unknown = []) {
    backend.read.mockImplementation((path: string) => {
      if (path === files.pool) return poolValue; if (path === nativeFile) return nativeValue; if (path === previousFile) return prior;
      throw new Error('Unexpected fixture read');
    });
  }

  it.each([
    ['observe'], ['observe', '--help', '--json'], ['observe', '--pool', 'relative'],
    ['observe', '--pool', files.pool, '--worker', 'unknown', '--provider', 'local', '--input', nativeFile, '--captured-at', capturedAt],
    ['observe', '--pool', files.pool, '--worker', 'codex-a', '--provider', 'codex', '--input', nativeFile],
    ['observe', '--pool', files.pool, '--worker', 'codex-a', '--provider', 'codex', '--input', nativeFile, '--captured-at', capturedAt],
    ['observe', '--pool', files.pool, '--worker', 'codex-a', '--provider', 'claude', '--input', nativeFile, '--captured-at', capturedAt, '--bucket', 'codex'],
    [...observe(), '--bucket', 'codex'], [...observe(), '--bucket', 'b', '--bucket', 'c', '--bucket', 'd', '--bucket', 'e'],
    [...observe(), '--root', root], [...observe(), '--output', '/private/fixture/extra'], [...observe(), '--json', '--json'],
    [...observe(), '--captured-at', capturedAt],
  ])('rejects invalid observe options %j before runtime import or reads', async (...args) => {
    const imported = backend.imported.mock.calls.length;
    expect(await cmdResourcePool(args)).toBe(2); expect(backend.imported).toHaveBeenCalledTimes(imported);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.run).not.toHaveBeenCalled();
  });

  it.each(['bad', '2026-02-30T00:00:00.000Z', '2026-09-07T00:00:00Z', '9999-12-31T23:59:59.000Z']) (
    'rejects malformed or future capture timestamp %s without restamping', async (value) => {
      const args = observe(); args[args.indexOf('--captured-at') + 1] = value;
      expect(await cmdResourcePool(args)).toBe(2); expect(backend.read).not.toHaveBeenCalled();
    });

  it('prints observe help without loading the runtime', async () => {
    const imported = backend.imported.mock.calls.length;
    expect(await cmdResourcePool(['observe', '--help'])).toBe(0); expect(backend.imported).toHaveBeenCalledTimes(imported);
    expect(output.mock.calls[0]![0]).toContain('operator-attested capture timestamp'); expect(backend.read).not.toHaveBeenCalled();
  });

  it('normalizes only selected Codex buckets and keeps an old file capture stale', async () => {
    inputs(); expect(await cmdResourcePool(observe(['--json']))).toBe(0);
    const rows = JSON.parse(output.mock.calls[0]![0] as string);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ workerId: 'codex-a', observedAt: capturedAt,
      expiresAt: new Date(capturedMs + 60_000).toISOString(), health: 'ready', windows: [
        { id: 'codex_codex_primary', usedPercent: 25, resetsAt: expect.any(String) },
      ] });
    expect(Date.parse(rows[0].expiresAt)).toBeLessThan(Date.now());
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_OWNER_METADATA');
    expect(backend.status).not.toHaveBeenCalled(); expect(backend.run).not.toHaveBeenCalled(); expect(backend.bindings).not.toHaveBeenCalled();
    expect(backend.read.mock.calls.map(([path]) => path)).toEqual([files.pool, nativeFile]);
  });

  it('preserves other workers when exporting an updated observation array', async () => {
    const definitionValue = definition(); definitionValue.workers.push({ ...definitionValue.workers[0]!, id: 'codex-b' });
    const other = { workerId: 'codex-b', observedAt: capturedAt, expiresAt: new Date(capturedMs + 60_000).toISOString(),
      health: 'ready', windows: [], retryAfter: null };
    inputs(definitionValue, native(), [other]);
    expect(await cmdResourcePool(observe(['--previous', previousFile, '--json']))).toBe(0);
    const rows = JSON.parse(output.mock.calls[0]![0] as string);
    expect(rows.map((row: { workerId: string }) => row.workerId)).toEqual(['codex-a', 'codex-b']); expect(rows[1]).toEqual(other);
  });

  it('does not overwrite a later normalized capture with an older native export', async () => {
    const previous = { workerId: 'codex-a', observedAt: capturedAt, updatedAt: new Date(capturedMs + 1).toISOString(),
      expiresAt: new Date(capturedMs + 60_000).toISOString(), health: 'ready', windows: [], retryAfter: null };
    inputs(definition(), native(), [previous]);
    expect(await cmdResourcePool(observe(['--previous', previousFile, '--json']))).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string).error).toContain('capture chronology');
  });

  it('retains an omitted exhausted Codex weekly bucket with its original freshness', async () => {
    const previous = { workerId: 'codex-a', observedAt: new Date(capturedMs - 30_000).toISOString(),
      expiresAt: new Date(capturedMs + 30_000).toISOString(), health: 'ready', retryAfter: null,
      windows: [{ id: 'codex_codex_secondary', usedPercent: 100, resetsAt: new Date(capturedMs + 3_600_000).toISOString() }] };
    inputs(definition(), native(), [previous]);
    expect(await cmdResourcePool(observe(['--previous', previousFile, '--json']))).toBe(0);
    const row = JSON.parse(output.mock.calls[0]![0] as string)[0];
    expect(row.windows).toContainEqual(previous.windows[0]); expect(row.windows).toHaveLength(2);
    expect(row.observedAt).toBe(previous.observedAt); expect(row.expiresAt).toBe(previous.expiresAt);
    expect(row.updatedAt).toBe(capturedAt);
  });

  it('normalizes a Claude partial event without freshening retained windows', async () => {
    const definitionValue = definition(); definitionValue.workers[0]!.provider = 'claude';
    const previous = { workerId: 'codex-a', observedAt: new Date(capturedMs - 30_000).toISOString(),
      expiresAt: new Date(capturedMs + 30_000).toISOString(), health: 'ready',
      windows: [{ id: 'seven_day', usedPercent: 30, resetsAt: new Date(capturedMs + 3_600_000).toISOString() }], retryAfter: null };
    const event = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour',
      utilization: 0.2, resetsAt: Math.floor((capturedMs + 3_600_000) / 1000) } };
    inputs(definitionValue, event, [previous]);
    const args = observe(); args[args.indexOf('--provider') + 1] = 'claude'; args.splice(args.indexOf('--bucket'), 2);
    expect(await cmdResourcePool([...args, '--previous', previousFile, '--json'])).toBe(0);
    const row = JSON.parse(output.mock.calls[0]![0] as string)[0];
    expect(row.observedAt).toBe(previous.observedAt); expect(row.expiresAt).toBe(previous.expiresAt);
    expect(row.updatedAt).toBe(capturedAt); expect(row.windows).toHaveLength(2);
  });

  it.each(['provider', 'payload', 'previous'])('rejects invalid %s evidence without emitting raw account metadata', async (kind) => {
    const definitionValue = definition(); if (kind === 'provider') definitionValue.workers[0]!.provider = 'claude';
    inputs(definitionValue, kind === 'payload' ? { private: 'PRIVATE_OWNER_METADATA' } : native(), kind === 'previous' ? {} : []);
    expect(await cmdResourcePool(observe(['--previous', previousFile, '--json']))).toBe(2);
    expect(JSON.stringify(output.mock.calls)).not.toContain('PRIVATE_OWNER_METADATA'); expect(backend.run).not.toHaveBeenCalled();
  });

  it('renders owner-attestation and no-contact limits in human output', async () => {
    inputs(); expect(await cmdResourcePool(observe())).toBe(0);
    const printed = output.mock.calls[0]![0] as string;
    expect(printed).toContain('Operator-attested capture'); expect(printed).toContain('No provider contact or ledger mutation');
    expect(printed).toContain('not independently verified account headroom');
  });
});

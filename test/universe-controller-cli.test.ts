import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ runUniversePortfolioController: vi.fn(), readUniversePortfolioController: vi.fn() }));
const files = vi.hoisted(() => ({ readResourceJson: vi.fn() }));
vi.mock('../src/core/universe/index.js', async () => ({
  validateUniversePortfolioDefinition: (await import('../src/core/universe/portfolio-plan.js')).validateUniversePortfolioDefinition, ...core,
}));
vi.mock('../src/core/resources/pool-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/resources/pool-runtime.js')>(), ...files,
}));
import { cmdUniverseController } from '../src/cli/universe-controller.js';
import { ControllerRecoveryError, readControllerRecoveryDiagnostic } from '../src/core/universe/controller-recovery-error.js';

const manifest = '/private/config/portfolio.json';
const definition = { schemaVersion: 1, id: 'work', tasks: [{ campaignId: 'one', dependsOn: [] }], maxParallel: 1, maxDurationMs: 60_000 };
const deliveryPlan = { schemaVersion: 1, deliveries: [{ campaignId: 'one', branch: 'codex/one', baseCommit: 'a'.repeat(40) }] };
function report(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, controllerId: 'work', definitionDigest: 'a'.repeat(64), sourceState: 'healthy', status: 'completed',
    createdAt: '2026-09-09T00:00:00.000Z', deadlineAt: '2026-09-09T00:01:00.000Z', observedAt: '2026-09-09T00:00:30.000Z',
    outcomes: [{ campaignId: 'one', state: 'completed', attempted: true, reasonCode: 'completed',
      campaignDigest: 'b'.repeat(64), deliveryDigest: null }], reasons: [], ...overrides };
}
const listeners = () => ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
const recoveryCodes = [
  'controller-execution-ownership-unavailable', 'controller-publication-recovery-required', 'controller-record-writer-busy',
  'controller-record-ownership-unavailable', 'controller-record-storage-changed', 'controller-record-release-failed',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  files.readResourceJson.mockImplementation((path: string) => path === '/private/config/delivery.json' ? deliveryPlan : definition);
  core.runUniversePortfolioController.mockResolvedValue(report());
  core.readUniversePortfolioController.mockReturnValue(report());
});
afterEach(() => vi.restoreAllMocks());

describe('Universe persisted controller CLI', () => {
  it.each([
    [], ['unknown'], ['run'], ['run', manifest], ['run', '--manifest', manifest, 'extra'], ['status'],
    ['status', '../work'], ['status', 'Uppercase'], ['status', 'a'.repeat(65)], ['status', 'one', 'two'],
    ['status', 'one', '--manifest', manifest], ['status', 'one', '--resource-runtime', '/private/runtime.json'],
    ['status', 'one', '--delivery-plan', '/private/config/delivery.json'],
    ['run', '--manifest', manifest, '--json', '--json'], ['--help', '-h'], ['run', '--bad-flag'],
    ['run', '--manifest', manifest, '--manifest', manifest], ['run', '--manifest=' + manifest],
    ['status', 'one', '--root=/private/root'], ['status', 'one\n'],
  ])('rejects invalid arguments %j before reading files or attaching signals', async (...args) => {
    const before = listeners();
    expect(await cmdUniverseController([...args, '--json'])).toBe(2);
    expect(files.readResourceJson).not.toHaveBeenCalled();
    expect(core.runUniversePortfolioController).not.toHaveBeenCalled();
    expect(core.readUniversePortfolioController).not.toHaveBeenCalled();
    expect(listeners()).toEqual(before);
  });

  it.each(['--manifest', '--root', '--resource-runtime', '--delivery-plan'])('requires a canonical bounded path for %s', async (flag) => {
    for (const path of ['relative.json', '/', '/private/../config/file.json', '/private/config/', '/private/./file.json', '/private/x\n', '/' + 'é'.repeat(2048)]) {
      const args = ['run', ...(flag === '--manifest' ? [] : ['--manifest', manifest]), flag, path, '--json'];
      expect(await cmdUniverseController(args)).toBe(2);
    }
    expect(files.readResourceJson).not.toHaveBeenCalled();
    expect(core.runUniversePortfolioController).not.toHaveBeenCalled();
  });

  it.each(['--root', '--resource-runtime', '--delivery-plan'])('rejects duplicate or missing %s values', async (flag) => {
    for (const suffix of [[flag], [flag, '/private/value', flag, '/private/other']]) {
      expect(await cmdUniverseController(['run', '--manifest', manifest, ...suffix, '--json'])).toBe(2);
    }
    expect(core.runUniversePortfolioController).not.toHaveBeenCalled();
  });

  it.each(['help', '--help', '-h'])('documents the persisted boundary in %s', async (arg) => {
    expect(await cmdUniverseController([arg])).toBe(0);
    const text = vi.mocked(console.log).mock.calls[0]![0];
    expect(text).toContain('original persisted deadline');
    expect(text).toContain('wait for a busy Universe execution lock');
    expect(text).toContain('No dispatch intent or worker request is recorded while waiting');
    expect(text).toContain('reclaim a proven-dead controller record-writer lock');
    expect(text).toContain('Status does not clear locks');
    expect(text).toContain('bounded reasonCode and nextStep');
    expect(text).toContain('do not authorize deletion, publication repair, or worker retry');
    expect(text).toContain('not a resident daemon');
    expect(text).toContain('uncertain or paused work');
    expect(text).toContain('Campaign pause/stop targets only that campaign');
    expect(text).toContain('a successful request is not worker exit');
    expect(text).toContain('independent ready work may continue');
    expect(text).toContain('There is no controller-wide durable drain/resume command');
    expect(files.readResourceJson).not.toHaveBeenCalled();
    expect(core.runUniversePortfolioController).not.toHaveBeenCalled();
  });

  it('passes exact validated intent and optional runtime to the foreground API', async () => {
    const before = listeners();
    expect(await cmdUniverseController(['run', '--manifest', manifest, '--root', '/private/store',
      '--resource-runtime', '/private/runtime.json', '--delivery-plan', '/private/config/delivery.json', '--json'])).toBe(0);
    expect(files.readResourceJson.mock.calls).toEqual([[manifest, 256 * 1024], ['/private/config/delivery.json', 64 * 1024]]);
    expect(core.runUniversePortfolioController).toHaveBeenCalledWith(definition, {
      root: '/private/store', resourceRuntime: '/private/runtime.json', deliveryPlan, signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual(report());
    expect(core.readUniversePortfolioController).not.toHaveBeenCalled();
    expect(listeners()).toEqual(before);
  });

  it('does not discover default runtime or delivery intent', async () => {
    expect(await cmdUniverseController(['run', '--manifest', manifest, '--json'])).toBe(0);
    expect(core.runUniversePortfolioController).toHaveBeenCalledWith(definition, { root: undefined, signal: expect.any(AbortSignal) });
    expect(files.readResourceJson).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'incomplete', 'cancelled', 'timed-out', 'unavailable'])('maps run status %s without altering the JSON report', async (status) => {
    const value = report({ status });
    core.runUniversePortfolioController.mockResolvedValue(value);
    expect(await cmdUniverseController(['run', '--manifest', manifest, '--json'])).toBe(status === 'completed' ? 0 : status === 'cancelled' ? 130 : 1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual(value);
  });

  it.each(['healthy', 'missing', 'degraded'])('reads %s status evidence without mutation or signal handlers', async (sourceState) => {
    const before = listeners();
    const value = report({ sourceState, status: 'incomplete' });
    core.readUniversePortfolioController.mockImplementation(() => {
      expect(listeners()).toEqual(before);
      return value;
    });
    expect(await cmdUniverseController(['status', 'work', '--root', '/private/store', '--json'])).toBe(sourceState === 'healthy' ? 0 : 1);
    expect(core.readUniversePortfolioController).toHaveBeenCalledWith('work', { root: '/private/store' });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual(value);
    expect(core.runUniversePortfolioController).not.toHaveBeenCalled();
    expect(files.readResourceJson).not.toHaveBeenCalled();
    expect(listeners()).toEqual(before);
  });

  it('renders original deadline, reason codes and uncertain worker state without a liveness claim', async () => {
    core.readUniversePortfolioController.mockReturnValue(report({ sourceState: 'healthy', status: 'incomplete',
      outcomes: [{ campaignId: 'one', state: 'in-flight', attempted: true, reasonCode: 'unresolved', campaignDigest: null, deliveryDigest: null }] }));
    expect(await cmdUniverseController(['status', 'work'])).toBe(0);
    const text = vi.mocked(console.log).mock.calls[0]![0];
    expect(text).toContain('original deadline: 2026-09-09T00:01:00.000Z');
    expect(text).toContain('one · in-flight · attempted · unresolved');
    expect(text).toContain('not proof of a live worker');
    expect(text).toContain('No resident daemon');
    expect(core.readUniversePortfolioController).toHaveBeenCalledWith('work', { root: undefined });
  });

  it.each(['file', 'schema', 'delivery-file', 'delivery-schema'])('sanitizes %s validation failures before attaching signals', async (failure) => {
    const before = listeners();
    if (failure === 'file') files.readResourceJson.mockImplementation(() => { throw new Error('PRIVATE-CREDENTIAL /private/secret'); });
    if (failure === 'schema') files.readResourceJson.mockReturnValue({ ...definition, token: 'PRIVATE-CREDENTIAL' });
    if (failure === 'delivery-file' || failure === 'delivery-schema') {
      files.readResourceJson.mockImplementation((path: string) => {
        if (path === manifest) return definition;
        if (failure === 'delivery-file') throw new Error('PRIVATE-CREDENTIAL /private/secret');
        return { schemaVersion: 1, deliveries: [{ ...deliveryPlan.deliveries[0], campaignId: 'other' }] };
      });
    }
    expect(await cmdUniverseController(['run', '--manifest', manifest, '--delivery-plan', '/private/config/delivery.json', '--json'])).toBe(2);
    expect(vi.mocked(console.log).mock.calls[0]![0]).not.toContain('PRIVATE-CREDENTIAL');
    expect(core.runUniversePortfolioController).not.toHaveBeenCalled();
    expect(listeners()).toEqual(before);
  });

  it.each(['run', 'status'])('sanitizes unexpected %s core failures', async (command) => {
    const before = listeners();
    core.runUniversePortfolioController.mockRejectedValue(new Error('PRIVATE-CREDENTIAL /private/secret'));
    core.readUniversePortfolioController.mockImplementation(() => { throw new Error('PRIVATE-CREDENTIAL /private/secret'); });
    expect(await cmdUniverseController([command, ...(command === 'run' ? ['--manifest', manifest] : ['work']), '--json'])).toBe(1);
    expect(vi.mocked(console.log).mock.calls[0]![0]).not.toContain('PRIVATE-CREDENTIAL');
    expect(listeners()).toEqual(before);
  });

  it.each(recoveryCodes)('renders only the canonical run diagnostic for %s in JSON and text', async (code) => {
    const before = listeners();
    const failure = new ControllerRecoveryError(code);
    const expected = readControllerRecoveryDiagnostic(failure)!;
    // Mutable error prose and causes must never escape the fixed lookup table.
    failure.message = 'PRIVATE-CREDENTIAL /private/secret\nINJECTED';
    failure.stack = 'PRIVATE-STACK';
    Object.assign(failure, { nextStep: 'PRIVATE-GUIDANCE', cause: new Error('PRIVATE-CAUSE') });
    core.runUniversePortfolioController.mockRejectedValue(failure);
    expect(await cmdUniverseController(['run', '--manifest', manifest, '--json'])).toBe(1);
    expect(vi.mocked(console.log).mock.calls).toHaveLength(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual({
      error: expected.message, reasonCode: code, nextStep: expected.nextStep,
    });
    expect(console.error).not.toHaveBeenCalled();
    expect(listeners()).toEqual(before);
    vi.mocked(console.log).mockClear();
    expect(await cmdUniverseController(['run', '--manifest', manifest])).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls).toEqual([
      [`universe controller: [${code}] ${expected.message}\nNext step: ${expected.nextStep}`],
    ]);
    expect(listeners()).toEqual(before);
  });

  it.each([
    'message', 'name-and-code', 'plain-object', 'unknown-code', 'throwing-code', 'non-error',
  ])('retains the generic run fallback for %s without exposing private fields', async (kind) => {
    const before = listeners();
    const code = recoveryCodes[0];
    let failure: unknown;
    if (kind === 'message') failure = new Error(`Controller execution ownership unavailable for record-lock recovery ${code} PRIVATE-CREDENTIAL`);
    if (kind === 'name-and-code') failure = Object.assign(new Error('PRIVATE-CREDENTIAL'), {
      name: 'ControllerRecoveryError', code, reasonCode: code, nextStep: 'PRIVATE-GUIDANCE',
    });
    if (kind === 'plain-object') failure = { name: 'ControllerRecoveryError', code, message: 'PRIVATE-CREDENTIAL', nextStep: 'PRIVATE-GUIDANCE' };
    if (kind === 'unknown-code') {
      failure = new ControllerRecoveryError(code);
      Object.assign(failure as object, { code: 'PRIVATE-UNKNOWN-CODE', message: 'PRIVATE-CREDENTIAL' });
    }
    if (kind === 'throwing-code') {
      failure = new ControllerRecoveryError(code);
      Object.defineProperty(failure, 'code', { get() { throw new Error('PRIVATE-CREDENTIAL'); } });
    }
    if (kind === 'non-error') failure = 'PRIVATE-CREDENTIAL';
    core.runUniversePortfolioController.mockRejectedValue(failure);
    expect(await cmdUniverseController(['run', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual({ error: 'Portfolio controller execution unavailable' });
    expect(listeners()).toEqual(before);
  });

  it.each(recoveryCodes)('keeps typed %s failures generic at the read-only status boundary', async (code) => {
    const before = listeners();
    const failure = new ControllerRecoveryError(code);
    failure.message = 'PRIVATE-CREDENTIAL';
    core.readUniversePortfolioController.mockImplementation(() => { throw failure; });
    expect(await cmdUniverseController(['status', 'work', '--json'])).toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual({ error: 'Portfolio controller evidence unavailable' });
    expect(core.runUniversePortfolioController).not.toHaveBeenCalled();
    expect(files.readResourceJson).not.toHaveBeenCalled();
    expect(listeners()).toEqual(before);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('prioritizes %s cancellation over a known startup diagnostic', async (signal) => {
    const before = listeners();
    core.runUniversePortfolioController.mockImplementation(async () => {
      process.emit(signal);
      throw new ControllerRecoveryError('controller-record-writer-busy');
    });
    expect(await cmdUniverseController(['run', '--manifest', manifest, '--json'])).toBe(130);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual({
      error: 'Portfolio controller cancelled; inspect persisted evidence before retrying',
    });
    expect(listeners()).toEqual(before);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('awaits settlement after %s before returning and cleans handlers', async (signal) => {
    const before = listeners();
    let settle!: (value: ReturnType<typeof report>) => void;
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => { admitted = resolve; });
    core.runUniversePortfolioController.mockImplementation((_definition, options) => {
      expect(listeners()).toEqual(before.map((count) => count + 1));
      process.emit(signal);
      expect(options.signal.aborted).toBe(true);
      admitted();
      return new Promise((resolve) => { settle = resolve; });
    });
    let returned = false;
    const pending = cmdUniverseController(['run', '--manifest', manifest, '--json']).then((code) => { returned = true; return code; });
    await started;
    expect(returned).toBe(false);
    settle(report({ status: 'cancelled' }));
    expect(await pending).toBe(130);
    expect(listeners()).toEqual(before);
  });

  it('preserves completed evidence when cancellation arrives after settlement', async () => {
    core.runUniversePortfolioController.mockImplementation(async () => { process.emit('SIGINT'); return report(); });
    expect(await cmdUniverseController(['run', '--manifest', manifest, '--json'])).toBe(0);
  });

  it('reports uncertain cancellation separately from ordinary failure', async () => {
    const before = listeners();
    core.runUniversePortfolioController.mockImplementation(async () => { process.emit('SIGTERM'); throw new Error('PRIVATE-CREDENTIAL'); });
    expect(await cmdUniverseController(['run', '--manifest', manifest, '--json'])).toBe(130);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0]).error).toContain('inspect persisted evidence before retrying');
    expect(listeners()).toEqual(before);
  });

  it('routes through the main universe dispatcher', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse(['controller', 'status', 'work', '--json'])).toBe(0);
    expect(core.readUniversePortfolioController).toHaveBeenCalledWith('work', { root: undefined });
  });
});

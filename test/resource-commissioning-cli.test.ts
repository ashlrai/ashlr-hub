/** CLI contracts only; core tests separately exercise real private files and inert processes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ check: vi.fn(), launcher: vi.fn(), read: vi.fn(), legacy: vi.fn() }));
vi.mock('../src/core/universe/resource-runtime-check.js', () => ({ checkResourceGenerationRuntime: backend.check }));
vi.mock('../src/core/resources/launcher-compatibility.js', () => ({ checkResourceLauncherCompatibility: backend.launcher }));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: backend.read }));
vi.mock('../src/core/config.js', () => ({ loadConfig: backend.legacy }));
import { cmdUniverse } from '../src/cli/universe.js';
import { cmdResources } from '../src/cli/resources.js';

const runtime = '/private/fixture/runtime.json';
const launcherArgs = ['launcher', 'check', '--provider', 'codex', '--command', '/private/fixture/command.json', '--cwd', '/private/fixture/workspace'];
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  backend.check.mockReturnValue({ schemaVersion: 1, status: 'valid', evidenceScope: 'local-configuration-only',
    providerContacted: false, checks: [{ code: 'runtime', status: 'passed' }], workers: [{ workerId: 'codex-a', provider: 'codex',
      capacityKey: 'account-a', eligibility: 'excluded', exclusionReasons: ['unknown-quota'], quotaRefreshConfigured: false,
      localModelRefreshConfigured: false, warnings: ['quota-refresh-not-configured'] }], warnings: ['execution-and-account-identity-unverified'] });
  backend.read.mockReturnValue(['/private/fixture/launcher']);
  backend.launcher.mockResolvedValue({ schemaVersion: 1, provider: 'codex', status: 'supported', reason: 'launcher-help-compatible',
    version: '0.136.0', missingFlags: [], hubTransport: 'native-cli' });
});
afterEach(() => vi.restoreAllMocks());

describe('explicit resource commissioning CLI', () => {
  it('routes Universe check without loading legacy defaults or executing a worker', async () => {
    expect(await cmdUniverse(['resources', 'check', '--resource-runtime', runtime, '--json'])).toBe(0);
    expect(backend.check).toHaveBeenCalledWith({ resourceRuntime: runtime });
    expect(JSON.parse(output.mock.calls[0]![0]).providerContacted).toBe(false);
    expect(output.mock.calls[0]![0]).not.toContain(runtime);
    expect(backend.legacy).not.toHaveBeenCalled(); expect(backend.launcher).not.toHaveBeenCalled(); expect(backend.read).not.toHaveBeenCalled();
  });
  it('renders excluded workers without calling configuration invalid or fleet ready', async () => {
    expect(await cmdUniverse(['resources', 'check', '--resource-runtime', runtime])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('codex-a · codex · capacity=account-a · excluded');
    expect(output.mock.calls[0]![0]).toContain('not authenticated fleet readiness');
  });
  it('returns 1 for a structured invalid runtime report', async () => {
    backend.check.mockReturnValue({ status: 'invalid', checks: [], workers: [], warnings: [] });
    expect(await cmdUniverse(['resources', 'check', '--resource-runtime', runtime, '--json'])).toBe(1);
  });
  it.each([
    [], ['check'], ['check', '--resource-runtime'], ['check', '--resource-runtime', 'relative'],
    ['check', '--resource-runtime', '/'], ['check', '--resource-runtime', '/private/../a'],
    ['check', '--resource-runtime', '/private/x\n'], ['check', '--resource-runtime', '/private/x\u0085'],
    ['check', '--resource-runtime', runtime, '--json', '--json'],
    ['check', '--resource-runtime', runtime, '--resource-runtime', runtime],
    ['check', '--resource-runtime', runtime, '--root', '/private/u'], ['check', '--resource-runtime', runtime, '--run'],
    ['check', '--help'], ['--help', '--json'], ['check', '--resource-runtime', `/${'é'.repeat(2048)}`],
  ])('rejects invalid runtime syntax %j before reads', async (...args) => {
    expect(await cmdUniverse(['resources', ...args, '--json'])).toBe(2);
    expect(backend.check).not.toHaveBeenCalled(); expect(backend.read).not.toHaveBeenCalled();
  });
  it.each(['resources', 'launcher'])('help for %s does not inspect accounts', async (kind) => {
    const code = kind === 'resources' ? await cmdUniverse(['resources', '--help']) : await cmdResources(['launcher', '--help']);
    expect(code).toBe(0); expect(backend.check).not.toHaveBeenCalled(); expect(backend.read).not.toHaveBeenCalled();
    expect(backend.launcher).not.toHaveBeenCalled(); expect(backend.legacy).not.toHaveBeenCalled();
  });
  it.each(['codex', 'claude', 'grok'])('forwards only explicit %s launcher and bounded scope', async (provider) => {
    const args = [...launcherArgs]; args[3] = provider;
    expect(await cmdResources([...args, '--json'])).toBe(0);
    expect(backend.read).toHaveBeenCalledWith('/private/fixture/command.json');
    expect(backend.launcher).toHaveBeenCalledWith({ provider, command: ['/private/fixture/launcher'], cwd: '/private/fixture/workspace',
      timeoutMs: 10000, signal: expect.any(AbortSignal) });
    expect(backend.legacy).not.toHaveBeenCalled();
    expect(output.mock.calls[0]![0]).not.toContain('/private/fixture');
  });
  it('does not turn advertised Grok upstream support into usable Hub transport', async () => {
    backend.launcher.mockResolvedValue({ provider: 'grok', status: 'incompatible', reason: 'launcher-hub-transport-not-implemented',
      version: '0.2.118', hubTransport: 'not-implemented', missingFlags: [] });
    const args = [...launcherArgs]; args[3] = 'grok';
    expect(await cmdResources(args)).toBe(1);
    expect(output.mock.calls[0]![0]).toContain('Hub transport: not-implemented');
  });
  it.each(['0', '-1', '30001', '1e3', '1.5', '+1', '01'])('rejects timeout %s before input reads', async (timeout) => {
    expect(await cmdResources([...launcherArgs, '--timeout-ms', timeout, '--json'])).toBe(2);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.launcher).not.toHaveBeenCalled();
  });
  it.each([
    ['--provider', 'other'], ['--command', 'relative'], ['--cwd', '/'], ['--json', '--json'],
    ['--login'], ['--help'], ['--provider', 'codex'],
  ])('rejects malformed/duplicate launcher flags %j', async (...extra) => {
    expect(await cmdResources([...launcherArgs, ...extra])).toBe(2);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.launcher).not.toHaveBeenCalled();
  });
  it('redacts unexpected errors and removes its signal handlers', async () => {
    const before = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    backend.read.mockImplementation(() => { throw new Error('SECRET native file details'); });
    expect(await cmdResources([...launcherArgs, '--json'])).toBe(1);
    expect(output.mock.calls[0]![0]).not.toContain('SECRET');
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(before);
  });
  it('awaits cancellation cleanup and reports 130 without leaving signal listeners', async () => {
    const before = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    backend.launcher.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      process.listeners('SIGTERM').find((entry) => !before[1]!.includes(entry))!();
      expect(signal.aborted).toBe(true);
      return { provider: 'codex', status: 'unavailable', reason: 'launcher-cancelled', missingFlags: [], hubTransport: 'native-cli' };
    });
    expect(await cmdResources([...launcherArgs, '--json'])).toBe(130);
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(before);
  });
});

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
    counts: { workers: 1, eligibleWorkers: 0, excludedWorkers: 1, capacities: 1, eligibleCapacities: 0 },
    allocationCeilingPercent: null, nextEligibleAt: null,
    providerContacted: false, checks: [{ code: 'runtime', status: 'passed' }], workers: [{ workerId: 'codex-a', provider: 'codex',
      capacityKey: 'account-a', eligibility: 'excluded', exclusionReasons: ['unknown-quota'], quotaRefreshConfigured: false,
      localModelRefreshConfigured: false, warnings: ['quota-refresh-not-configured'], nextEligibleAt: null,
      policyHolds: [], nextChecks: ['refresh-quota-evidence'] }], warnings: ['execution-and-account-identity-unverified'] });
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
    expect(output.mock.calls[0]![0]).toContain('Snapshot workers: 0/1 eligible · 1 excluded');
    expect(output.mock.calls[0]![0]).toContain('distinct capacity groups: 0/1 eligible');
    expect(output.mock.calls[0]![0]).toContain('No corrective action was executed');
  });

  it('preserves typed timing, counts, allocation and hold fields in JSON without taking actions', async () => {
    const report = backend.check.getMockImplementation()!();
    Object.assign(report, { allocationCeilingPercent: 75, nextEligibleAt: '2026-09-09T12:00:00.000Z' });
    Object.assign(report.workers[0], { policyHolds: ['owner-paused'], nextChecks: ['review-owner-pause'],
      nextEligibleAt: report.nextEligibleAt });
    backend.check.mockReturnValue(report);
    expect(await cmdUniverse(['resources', 'check', '--resource-runtime', runtime, '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0])).toEqual(report);
    expect(backend.check).toHaveBeenCalledOnce(); expect(backend.read).not.toHaveBeenCalled();
    expect(backend.launcher).not.toHaveBeenCalled(); expect(backend.legacy).not.toHaveBeenCalled();
  });

  it('explains intentional holds without recommending an unpause or treating the ceiling as remaining usage', async () => {
    const report = backend.check.getMockImplementation()!();
    report.allocationCeilingPercent = 0;
    Object.assign(report.workers[0], { policyHolds: ['owner-paused', 'subscription-allocation-disabled'],
      nextChecks: ['review-owner-pause', 'review-subscription-allocation'] });
    backend.check.mockReturnValue(report);
    expect(await cmdUniverse(['resources', 'check', '--resource-runtime', runtime])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('Subscription allocation ceiling: 0% (policy, not remaining quota)');
    expect(text).toContain('Policy holds: owner-paused, subscription-allocation-disabled');
    expect(text).toContain('Preserve the owner policy');
    expect(text).toContain('Preserve the allocation policy');
    expect(text).not.toContain('undefined');
  });

  it('labels recheck timing as a hint and preserves reserve and uncertain ownership guidance', async () => {
    const report = backend.check.getMockImplementation()!();
    report.nextEligibleAt = '2026-09-09T12:00:00.000Z';
    Object.assign(report.workers[0], { nextEligibleAt: report.nextEligibleAt,
      nextChecks: ['recheck-after-hint', 'review-reserve-evidence', 'inspect-capacity-ownership'] });
    backend.check.mockReturnValue(report);
    expect(await cmdUniverse(['resources', 'check', '--resource-runtime', runtime])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('2026-09-09T12:00:00.000Z (not promised availability)');
    expect(text).toContain('Time passage alone does not establish capacity');
    expect(text).toContain('Preserve the configured reserve');
    expect(text).toContain('do not delete receipts or start a competing worker');
  });

  it.each(['runtime', 'boundaries', 'workspace', 'pool', 'bindings', 'observations', 'quota-refresh', 'local-model-refresh', 'ledger'])(
    'gives fixed guidance for failed %s without fabricating zero counts', async (code) => {
      backend.check.mockReturnValue({ status: 'invalid', counts: null, nextEligibleAt: null, allocationCeilingPercent: null,
        checks: [{ code, status: 'failed' }], workers: [], warnings: [] });
      expect(await cmdUniverse(['resources', 'check', '--resource-runtime', runtime])).toBe(1);
      const text = output.mock.calls[0]![0] as string;
      expect(text).toContain('Worker and capacity counts: unavailable');
      expect(text).toContain('Subscription allocation ceiling: unchecked');
      expect(text).toContain(`${code} · failed\n  Next check:`);
      expect(text).not.toContain('0/0'); expect(text).not.toContain('undefined'); expect(text).not.toContain(runtime);
    });

  it.each(['refresh-local-evidence', 'wait-for-active-work', 'review-task-window', 'review-worker-availability', 'review-worker-scope'])(
    'renders %s guidance without executing it', async (next) => {
      const report = backend.check.getMockImplementation()!(); report.workers[0].nextChecks = [next];
      backend.check.mockReturnValue(report);
      expect(await cmdUniverse(['resources', 'check', '--resource-runtime', runtime])).toBe(0);
      expect(output.mock.calls[0]![0]).toContain(`Next check [${next}]:`);
      expect(output.mock.calls[0]![0]).not.toContain('undefined'); expect(backend.launcher).not.toHaveBeenCalled();
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

/** Real private journals/locks; execution and provider boundaries are deterministic doubles. */
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ setup: vi.fn(), start: vi.fn(), close: vi.fn(), request: vi.fn(), releaseFails: false }));
vi.mock('../src/core/resources/engineering-autonomous-setup.js', () => ({
  checkResourceEngineeringAutonomousSetup: runtime.setup,
  prepareResourceEngineeringAutonomousSetup: vi.fn(() => ({ planDigest: 'a'.repeat(64) })),
  validateResourceEngineeringAutonomousSetupPolicy: (value: unknown) => value,
}));
vi.mock('../src/core/universe/resource-generation.js', () => ({ validateResourceGenerationRuntime: (value: unknown) => value }));
vi.mock('../src/core/resources/pool-policy.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/resources/pool-policy.js')>(), validateResourcePool: (value: unknown) => value,
}));
vi.mock('../src/core/resources/worker.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/resources/worker.js')>(), validateResourceBindings: (value: unknown) => value,
}));
vi.mock('../src/core/resources/pool-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/resources/pool-runtime.js')>(),
  readResourceJson: (path: string) => path.endsWith('runtime.json') ? {
    root: '/fixture/ledger', workspace: '/fixture/transport', poolPath: '/fixture/pool.json',
    bindingsPath: '/fixture/bindings.json', observationsPath: '/fixture/observations.json',
  } : path.endsWith('projects.json') ? { projects: [] } : {},
  validateResourceTask: (value: unknown) => value,
}));
vi.mock('../src/core/web/resource-console-server.js', () => ({ startResourceConsoleServer: runtime.start }));
vi.mock('../src/core/resources/engineering-mission-console.js', () => ({
  requestEngineeringMissionConsole: runtime.request, MissionConsoleRequestError: class extends Error {},
}));
vi.mock('../src/core/sandbox/policy.js', () => ({ readKillSwitch: () => ({ state: 'inactive', sourceState: 'healthy' }) }));
vi.mock('../src/core/fleet/local-store-lock.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/local-store-lock.js')>();
  return { ...actual, releaseLocalStoreLock: (lock: Parameters<typeof actual.releaseLocalStoreLock>[0]) => {
    const released = actual.releaseLocalStoreLock(lock);
    return runtime.releaseFails && lock.path.endsWith('.mission.lock') ? false : released;
  } };
});
import { runResourceEngineeringMission } from '../src/core/resources/engineering-mission.js';
import { readResourceEngineeringMissionStatus, type ResourceEngineeringMissionConfig } from '../src/core/resources/engineering-mission-store.js';
const roots: string[] = [];
function fixture(): ResourceEngineeringMissionConfig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mission-diagnostics-'))); roots.push(root);
  return { schemaVersion: 1, id: 'diagnostics', root, maxScopes: 2, pollIntervalMs: 100,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), initial: { expectedPlanDigest: 'a'.repeat(64), setup: {
      recipe: { projectId: 'default' }, policy: {}, output: join(root, 'initial'), resourceRuntime: '/fixture/runtime.json',
      projectsFile: '/fixture/projects.json', workspace: '/fixture/project',
    } } };
}
beforeEach(() => {
  vi.clearAllMocks(); runtime.releaseFails = false;
  runtime.setup.mockReturnValue({ planDigest: 'a'.repeat(64), initialEnrollmentDigest: 'b'.repeat(64), paths: {} });
  runtime.close.mockResolvedValue(undefined);
  runtime.start.mockResolvedValue({ url: 'http://127.0.0.1:1', consoleUrl: 'http://127.0.0.1:1/private-token', close: runtime.close });
  runtime.request.mockRejectedValue(Error('PRIVATE_PROVIDER_ERROR'));
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('mission invocation cleanup diagnostics', () => {
  it.each([
    ['request', 'executing-held'], ['close', 'shutdown-unresolved'], ['release', 'ownership-release-unresolved'],
  ])('retains the final %s outcome after cleanup without leaking console or provider data', async (failure, reason) => {
    const config = fixture();
    if (failure === 'close') runtime.close.mockRejectedValue(Error('PRIVATE_CLOSE_ERROR'));
    if (failure === 'release') runtime.releaseFails = true;
    const result = await runResourceEngineeringMission(config);
    expect(result).toMatchObject({ state: 'held', reason, scopesReserved: 1 });
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(existsSync(join(config.root, '.mission.lock'))).toBe(false);
    const files = readdirSync(config.root, { recursive: true });
    const status = readResourceEngineeringMissionStatus(config);
    expect(JSON.stringify(status.invocations)).toContain(reason);
    expect(status).toMatchObject({ recordedPhase: 'prepared', ownerState: 'not-observed', executionAuthorized: false });
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE|private-token|127\.0\.0\.1/);
    expect(readdirSync(config.root, { recursive: true })).toEqual(files);
    expect(runtime.start).toHaveBeenCalledOnce();
  });
  it('retains a stopped invocation before any scope dispatch', async () => {
    const config = fixture(); const stop = new AbortController(); stop.abort();
    const result = await runResourceEngineeringMission(config, { signal: stop.signal });
    expect(result.state).toBe('stopped'); expect(runtime.start).not.toHaveBeenCalled();
    const status = readResourceEngineeringMissionStatus(config);
    expect(JSON.stringify(status.invocations)).toContain('mission-execution-stopped');
    expect(status.recordedPhase).toBe('not-started');
  });
  it('retains a failed scope drain even after the console handle was detached', async () => {
    const config = fixture();
    runtime.request.mockResolvedValueOnce({ sourceState: 'healthy', paused: false, deadlineAt: config.deadlineAt,
      entries: [{ state: 'completed' }] }).mockResolvedValueOnce({ deadlineAt: config.deadlineAt, entries: [{ state: 'stopped' }] });
    runtime.close.mockRejectedValue(Error('PRIVATE_DRAIN_ERROR'));
    expect(await runResourceEngineeringMission(config)).toMatchObject({ state: 'held', reason: 'shutdown-unresolved' });
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(readResourceEngineeringMissionStatus(config).invocations.latest?.outcome).toMatchObject({ reason: 'shutdown-unresolved' });
  });
  it('does not create observation history for a setup rejected before ownership', async () => {
    const config = fixture(); runtime.setup.mockImplementation(() => { throw Error('PRIVATE_SETUP_ERROR'); });
    expect(await runResourceEngineeringMission(config)).toMatchObject({ state: 'held', reason: 'startup-held' });
    expect(readdirSync(config.root)).toEqual([]); expect(runtime.start).not.toHaveBeenCalled();
  });
  it('does not let an observer exception discard durable execution diagnostics', async () => {
    const config = fixture();
    await runResourceEngineeringMission(config, { onProgress() { throw Error('PRIVATE_CALLBACK_ERROR'); } });
    expect(JSON.stringify(readResourceEngineeringMissionStatus(config).invocations)).toContain('executing-held');
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});

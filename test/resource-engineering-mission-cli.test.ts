/** CLI authority boundary: readers and runner are doubles; no account or filesystem effects. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ read: vi.fn(), validate: vi.fn(), hash: vi.fn(), setup: vi.fn(), run: vi.fn() }));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: backend.read }));
vi.mock('../src/core/resources/engineering-mission-store.js', () => ({ validateResourceEngineeringMissionConfig: backend.validate, missionHash: backend.hash }));
vi.mock('../src/core/resources/engineering-autonomous-setup.js', () => ({ checkResourceEngineeringAutonomousSetup: backend.setup }));
vi.mock('../src/core/resources/engineering-mission.js', () => ({ runResourceEngineeringMission: backend.run }));
import { cmdResourcePool } from '../src/cli/resource-pool.js';
const digest = 'a'.repeat(64);
const config = { id: 'fixture', initial: { setup: { fixture: true }, expectedPlanDigest: 'b'.repeat(64) }, deadlineAt: '2026-09-12T20:00:00.000Z', maxScopes: 3 };
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); backend.read.mockReturnValue(config); backend.validate.mockReturnValue(config); backend.hash.mockReturnValue(digest);
  backend.setup.mockReturnValue({ planDigest: config.initial.expectedPlanDigest, initialEnrollmentDigest: 'c'.repeat(64), holds: [] });
  backend.run.mockResolvedValue({ state: 'completed', reason: 'scope-limit' });
  output = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const command = (args: string[]) => cmdResourcePool(['engineering', 'mission', ...args]);
describe('engineering mission CLI', () => {
  it('checks an existing setup without a runner or signal handlers', async () => {
    const signals = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    expect(await command(['check', '--config', '/private/mission.json', '--json'])).toBe(0);
    expect(backend.read).toHaveBeenCalledExactlyOnceWith('/private/mission.json', 512 * 1024);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ state: 'checked', configDigest: digest, effectsExecuted: false });
    expect(backend.run).not.toHaveBeenCalled(); expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(signals);
  });
  it('requires the exact checked digest and removes run signal handlers after completion', async () => {
    const signals = [process.listeners('SIGINT'), process.listeners('SIGTERM')];
    expect(await command(['run', '--config', '/private/mission.json', '--expected-config-digest', digest, '--execute', '--json'])).toBe(0);
    expect(backend.run).toHaveBeenCalledOnce(); expect(backend.run.mock.calls[0]![0]).toEqual(config);
    expect(backend.run.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(signals);
  });
  it.each(['held', 'stopped'])('returns nonzero for a %s mission', async state => {
    backend.run.mockResolvedValue({ state, reason: 'fixture' });
    expect(await command(['run', '--config', '/private/mission.json', '--expected-config-digest', digest, '--execute'])).toBe(1);
  });
  it.each([
    [], ['run'], ['check', '--execute'], ['run', '--config', '/private/mission.json', '--execute'],
    ['run', '--config', '/private/mission.json', '--expected-config-digest', digest],
    ['check', '--config', '/'], ['check', '--config', 'relative'], ['check', '--config', '/private/../mission'],
    ['check', '--config', '/private/mission.json', '--json', '--json'],
    ['check', '--config', '/private/mission.json', '--unknown'],
    ['run', '--config', '/private/mission.json', '--expected-config-digest', digest, '--execute', '--execute'],
  ].map(args => ({ args })))('rejects malformed arguments before readers %#', async ({ args }) => {
    expect(await command(args)).toBe(2); expect(backend.read).not.toHaveBeenCalled(); expect(backend.run).not.toHaveBeenCalled();
  });
  it.each(['digest', 'setup', 'unprepared'])('withholds %s drift before execution', async kind => {
    if (kind === 'digest') backend.hash.mockReturnValue('d'.repeat(64));
    else backend.setup.mockReturnValue({ planDigest: kind === 'setup' ? 'e'.repeat(64) : config.initial.expectedPlanDigest,
      initialEnrollmentDigest: kind === 'unprepared' ? null : 'c'.repeat(64) });
    expect(await command(['run', '--config', '/private/mission.json', '--expected-config-digest', digest, '--execute', '--json'])).toBe(1);
    expect(backend.run).not.toHaveBeenCalled();
  });
  it('redacts backend failures and cleans signal handlers', async () => {
    const signals = [process.listeners('SIGINT'), process.listeners('SIGTERM')]; backend.run.mockRejectedValue(Error('PRIVATE_TOKEN'));
    expect(await command(['run', '--config', '/private/mission.json', '--expected-config-digest', digest, '--execute', '--json'])).toBe(1);
    expect(String(output.mock.calls[0]![0])).not.toContain('PRIVATE_TOKEN');
    expect([process.listeners('SIGINT'), process.listeners('SIGTERM')]).toEqual(signals);
  });
  it('help performs no reads or execution', async () => {
    expect(await command(['--help'])).toBe(0); expect(output.mock.calls[0]![0]).toContain('foreground owner');
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.run).not.toHaveBeenCalled();
  });
});

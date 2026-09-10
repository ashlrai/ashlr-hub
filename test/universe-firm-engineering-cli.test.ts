/** Real private enrollment reads; controller/model/evaluator boundaries remain inert. */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { ControlGraphReport } from '../src/core/universe/control-graph.js';
const core = vi.hoisted(() => ({ factory: vi.fn(), run: vi.fn() }));
vi.mock('../src/core/universe/firm-engineering-control-handler.js', () => ({
  createFirmEngineeringControlHandler: core.factory, isFirmEngineeringControlHandler: () => false,
}));
vi.mock('../src/core/universe/control-graph.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/control-graph.js')>(), runControlGraph: core.run,
}));
import { cmdUniverseFirmEngineering } from '../src/cli/universe-firm-engineering.js';

let base: string; let root: string; let file: string;
let enrollment: Record<string, unknown>;
let output: ReturnType<typeof vi.spyOn>;
const handler = { effectClass: 'engineering-portfolio-local-delivery', constitutionVersion: 'fixture-v1', policyEpoch: 1,
  bindingDigest: 'a'.repeat(64), run: async () => ({ artifact: {} }) };
const nodeInput = { bindingDigest: handler.bindingDigest, requestDigest: 'b'.repeat(64) };
function report(status: ControlGraphReport['status'] = 'completed', sourceState: ControlGraphReport['sourceState'] = 'healthy'): ControlGraphReport {
  return { schemaVersion: 1, sourceState, status, graphId: 'fixture-graph', definitionDigest: 'd'.repeat(64),
    deadlineAt: '2026-09-10T00:00:00.000Z', nodes: [{ id: 'deliver', kind: 'deliver', state: 'completed', artifactDigest: 'c'.repeat(64) }],
    edges: [], traces: [], reasons: [] };
}
function save(value: unknown = enrollment) { writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
function args(...extra: string[]) { return ['--root', root, '--enrollment', file, ...extra]; }
function executeArgs(...extra: string[]) { return args('--expected-enrollment-digest', digest(canonical(enrollment)), ...extra); }
beforeEach(() => {
  vi.resetAllMocks(); output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-engineering-cli-')));
  root = join(base, 'graph'); mkdirSync(root, { mode: 0o700 }); file = join(base, 'enrollment.json');
  enrollment = { schemaVersion: 1, graphId: 'fixture-graph', host: { nodeId: 'deliver', root: join(base, 'universe'),
    constitutionVersion: 'fixture-v1', policyEpoch: 1, resourceRuntime: join(base, 'runtime.json'), expectedRuntimeDigest: 'e'.repeat(64),
    definition: { schemaVersion: 1, id: 'portfolio', tasks: [{ campaignId: 'campaign', dependsOn: [] }], maxParallel: 1, maxDurationMs: 9000 },
    deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId: 'campaign', branch: 'codex/fixture', baseCommit: 'f'.repeat(40) }] } } };
  save(); core.factory.mockReturnValue({ handler, nodeInput }); core.run.mockResolvedValue(report());
});
afterEach(() => { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });

describe('firm engineering CLI boundary', () => {
  it('checks real private JSON without executing graph/evaluator/provider work or creating state', async () => {
    const signals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const before = readdirSync(base); expect(await cmdUniverseFirmEngineering(args('--check', '--json'))).toBe(0);
    expect(core.factory).toHaveBeenCalledExactlyOnceWith(enrollment.host); expect(core.run).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ status: 'validated-enrollment',
      enrollmentDigest: digest(canonical(enrollment)), graphId: 'fixture-graph', bindingDigest: nodeInput.bindingDigest,
      campaigns: ['campaign'], effectsExecuted: false, providerContacted: false });
    expect(readdirSync(base)).toEqual(before); expect(readdirSync(root)).toEqual([]);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(signals);
  });
  it('hashes canonical parsed enrollment, independent of file whitespace or object insertion order', async () => {
    const reordered = { host: enrollment.host, graphId: enrollment.graphId, schemaVersion: enrollment.schemaVersion };
    writeFileSync(file, JSON.stringify(reordered, null, 4));
    expect(await cmdUniverseFirmEngineering(executeArgs('--json'))).toBe(0);
    expect(core.run).toHaveBeenCalledExactlyOnceWith({ schemaVersion: 1, id: 'fixture-graph', maxConcurrent: 1, maxDurationMs: 9000,
      nodes: [{ id: 'deliver', kind: 'deliver', requires: [], input: nodeInput }] },
    { root, signal: expect.any(AbortSignal), handlers: { deliver: handler } });
    expect(core.run.mock.calls[0]![1]).not.toHaveProperty('traceKeys');
  });
  it.each([false, true])('refuses a stale enrollment digest before invoking the factory (check=%s)', async (check) => {
    expect(await cmdUniverseFirmEngineering(args('--expected-enrollment-digest', '0'.repeat(64), ...(check ? ['--check'] : []), '--json'))).toBe(1);
    expect(core.factory).not.toHaveBeenCalled(); expect(core.run).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ status: 'unavailable' });
  });
  it.each([[], ['--unknown'], ['--check', '--check'], ['--json', '--json'], ['--root'],
    ['--expected-enrollment-digest', 'not-a-hash'], ['--enrollment', 'bad\npath']])('rejects malformed options %j without enrollment execution', async (...suffix) => {
    const invocation = suffix.length ? args(...suffix) : args();
    expect(await cmdUniverseFirmEngineering(invocation)).toBe(2); expect(core.factory).not.toHaveBeenCalled(); expect(core.run).not.toHaveBeenCalled();
  });
  it.each(['graph', '/absolute/../graph'])('refuses a noncanonical graph root %j before opening enrollment', async (invalidRoot) => {
    expect(await cmdUniverseFirmEngineering(['--root', invalidRoot, '--enrollment', file, '--check'])).toBe(2);
    expect(core.factory).not.toHaveBeenCalled(); expect(core.run).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { schemaVersion: 2, graphId: 'x', host: {} },
    { schemaVersion: 1, graphId: 'x', host: {}, command: ['not-authority'] }])('refuses nonclosed enrollment %#', async (value) => {
    save(value); expect(await cmdUniverseFirmEngineering(args('--check', '--json'))).toBe(1);
    expect(core.factory).not.toHaveBeenCalled(); expect(core.run).not.toHaveBeenCalled();
  });
  it('uses the actual graph validator for invalid IDs before running', async () => {
    enrollment.graphId = '../escape'; save(); expect(await cmdUniverseFirmEngineering(args('--check'))).toBe(1);
    expect(core.run).not.toHaveBeenCalled();
  });
  it('refuses a nonprivate or linked enrollment through the real resource JSON reader', async () => {
    chmodSync(file, 0o644); expect(await cmdUniverseFirmEngineering(args('--check'))).toBe(1);
    chmodSync(file, 0o600); const alias = join(base, 'alias.json'); symlinkSync(file, alias);
    expect(await cmdUniverseFirmEngineering(['--root', root, '--enrollment', alias, '--check'])).toBe(1);
    expect(core.factory).not.toHaveBeenCalled(); expect(core.run).not.toHaveBeenCalled();
  });
  it.each(['incomplete', 'stopped', 'unavailable'] as const)('returns failure for %s instead of claiming execution acceptance', async (status) => {
    core.run.mockResolvedValue(report(status)); expect(await cmdUniverseFirmEngineering(executeArgs('--json'))).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string).status).toBe(status);
  });
  it('does not accept a completed report whose evidence is degraded', async () => {
    core.run.mockResolvedValue(report('completed', 'degraded')); expect(await cmdUniverseFirmEngineering(executeArgs())).toBe(1);
  });
  it.each(['SIGINT', 'SIGTERM'] as const)('forwards %s cancellation and removes its listeners without signalling the host', async (signal) => {
    const callbacks = new Map<string, () => void>(); const original = process.once;
    const subscribe = vi.spyOn(process, 'once').mockImplementation((event, listener) => {
      if (event === 'SIGINT' || event === 'SIGTERM') { callbacks.set(event, listener as () => void); return process; }
      return original.call(process, event, listener);
    });
    const unsubscribe = vi.spyOn(process, 'removeListener');
    core.run.mockImplementation(async (_definition, options: { signal: AbortSignal }) => {
      expect(options.signal.aborted).toBe(false); callbacks.get(signal)!(); expect(options.signal.aborted).toBe(true); return report('stopped');
    });
    expect(await cmdUniverseFirmEngineering(executeArgs('--json'))).toBe(1);
    expect(subscribe).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(unsubscribe).toHaveBeenCalledWith('SIGINT', callbacks.get('SIGINT'));
    expect(unsubscribe).toHaveBeenCalledWith('SIGTERM', callbacks.get('SIGTERM'));
  });
  it('bounds private failures and cleans listeners when execution rejects', async () => {
    const signals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    core.run.mockRejectedValue(new Error('private-config-token-must-not-leak'));
    expect(await cmdUniverseFirmEngineering(executeArgs('--json'))).toBe(1);
    expect(output.mock.calls.flat().join(' ')).not.toContain('private-config-token');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(signals);
  });
  it('prints help without opening enrollment or invoking a factory', async () => {
    expect(await cmdUniverseFirmEngineering(['--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('NEW controller ID'); expect(core.factory).not.toHaveBeenCalled(); expect(core.run).not.toHaveBeenCalled();
  });
});

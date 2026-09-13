/** Real private control journal; mission runner is an explicit lifecycle double. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readdirSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/core/resources/engineering-mission.js', () => ({ runResourceEngineeringMission: backend.run }));
import { createEngineeringMissionManager } from '../src/core/resources/engineering-mission-manager.js';
import { readEngineeringMissionControl, setEngineeringMissionControl } from '../src/core/resources/engineering-mission-control.js';
import type { ResourceEngineeringMissionConfig } from '../src/core/resources/engineering-mission-store.js';
import type { ResourceConsoleWorkspaceHandle } from '../src/core/web/resource-console-server.js';
import type { ResourceEngineeringMissionHost, ResourceEngineeringMissionReport } from '../src/core/resources/engineering-mission.js';
import type { EngineeringMissionSnapshot } from '../src/core/resources/engineering-mission-manager-types.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
beforeEach(() => vi.resetAllMocks());
const command = (value: EngineeringMissionSnapshot) => ({ expectedControllerId: value.controllerId, expectedConfigDigest: value.configDigest, expectedRevision: value.revision });
function fixture(autoStart = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mission-manager-'))); roots.push(root);
  const config: ResourceEngineeringMissionConfig = { schemaVersion: 1, id: 'fixture', root, maxScopes: 2, pollIntervalMs: 100,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), initial: { expectedPlanDigest: 'a'.repeat(64), setup: {
      recipe: {}, policy: {}, output: join(root, 'initial'), resourceRuntime: '/fixture/runtime.json', workspace: '/fixture/project', projectsFile: '/fixture/projects.json' } } };
  const configFile = join(root, 'mission.json'); writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const close = vi.fn(), attachment = { id: 'attachment', state: vi.fn(() => 'closed') };
  const workspace = { close, engineeringAttachment: () => attachment } as unknown as ResourceConsoleWorkspaceHandle;
  const isStopped = vi.fn(() => false);
  const options = { config, configFile, autoStart, workspace, isStopped };
  let finish!: (report: ResourceEngineeringMissionReport) => void;
  backend.run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const manager = createEngineeringMissionManager(options);
  const settle = (state: ResourceEngineeringMissionReport['state'] = 'stopped') => finish({ schemaVersion: 1, missionId: config.id,
    state, reason: state === 'held' ? 'shutdown-unresolved' : 'scope-limit', scopesReserved: 1, deadlineAt: config.deadlineAt, tip: null });
  return { config, configFile, manager, options, close, attachment, settle, isStopped };
}
describe('managed mission control and lifetime', () => {
  it('is inert until explicitly started, with browser-safe status', async () => {
    const f = fixture(); f.manager.startConfigured();
    expect(backend.run).not.toHaveBeenCalled(); expect(readEngineeringMissionControl(f.config).revision).toBe(0);
    expect(JSON.stringify(f.manager.snapshot())).not.toContain(f.config.root);
    expect(f.manager.snapshot()).toMatchObject({ state: 'idle', enabled: false, scope: 0, lastOutcome: null });
    await f.manager.close(); expect(f.close).not.toHaveBeenCalled();
  });
  it('starts the exact runner with borrowed custody; duplicate and stale starts do not dispatch', async () => {
    const f = fixture(), initial = command(f.manager.snapshot());
    const started = f.manager.start(initial); expect(started).toMatchObject({ state: 'running', phase: 'startup', revision: 1 });
    expect(() => f.manager.start(initial)).toThrow(); expect(() => f.manager.start(command(started))).toThrow();
    await Promise.resolve(); expect(backend.run).toHaveBeenCalledOnce();
    expect(backend.run.mock.calls[0]![0]).toEqual(f.config);
    const host = backend.run.mock.calls[0]![1] as ResourceEngineeringMissionHost;
    expect(host.workspace).toEqual({ handle: f.options.workspace, expectedAttachment: f.attachment });
    host.onProgress!({ missionId: 'fixture', scope: 1, phase: 'executing', consoleUrl: '/private/url' });
    expect(f.manager.snapshot()).toMatchObject({ phase: 'executing', scope: 1 });
    f.settle('completed'); await vi.waitFor(() => expect(f.manager.snapshot().state).toBe('completed'));
    expect(() => f.manager.start(command(f.manager.snapshot()))).toThrow(); await f.manager.close();
  });
  it('persists stop before abort and waits for actual drain without closing human work', async () => {
    const f = fixture(true); f.manager.startConfigured(); await Promise.resolve();
    f.manager.startConfigured(); expect(f.manager.snapshot().state).toBe('running'); expect(backend.run).toHaveBeenCalledOnce();
    const host = backend.run.mock.calls[0]![1] as ResourceEngineeringMissionHost;
    host.signal!.addEventListener('abort', () => expect(readEngineeringMissionControl(f.config).enabled).toBe(false));
    expect(f.manager.stop(command(f.manager.snapshot()))).toMatchObject({ enabled: false, state: 'stopping', revision: 2 });
    expect(host.signal!.aborted).toBe(true);
    host.onProgress!({ missionId: 'fixture', scope: 2, phase: 'proposing', consoleUrl: null });
    expect(f.manager.snapshot().scope).toBe(0);
    let closed = false; const closing = f.manager.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); expect(f.close).not.toHaveBeenCalled();
    f.settle(); await closing;
    const restarted = createEngineeringMissionManager(f.options); restarted.startConfigured();
    expect(backend.run).toHaveBeenCalledOnce(); expect(restarted.snapshot()).toMatchObject({ enabled: false, revision: 2 });
    expect(restarted.snapshot().deadlineAt).toBe(f.config.deadlineAt); await restarted.close();
  });
  it('host shutdown preserves enabled intent but cannot accept a new command while draining', async () => {
    const f = fixture(true); f.manager.startConfigured(); await Promise.resolve();
    const closing = f.manager.close(); expect(() => f.manager.start(command(f.manager.snapshot()))).toThrow();
    f.settle(); await closing; expect(readEngineeringMissionControl(f.config).enabled).toBe(true);
    const restarted = createEngineeringMissionManager(f.options);
    expect(() => restarted.start(command(f.manager.snapshot()))).toThrow();
    restarted.startConfigured(); await Promise.resolve(); expect(backend.run).toHaveBeenCalledTimes(2);
    f.settle(); await restarted.close();
  });
  it('does not auto-retry held work or erase uncertainty with stop', async () => {
    const f = fixture(true); f.manager.startConfigured(); await Promise.resolve(); f.settle('held');
    await vi.waitFor(() => expect(f.manager.snapshot().state).toBe('held'));
    f.manager.stop(command(f.manager.snapshot())); expect(f.manager.snapshot().state).toBe('held');
    expect(() => f.manager.start(command(f.manager.snapshot()))).toThrow();
    expect(backend.run).toHaveBeenCalledOnce(); await expect(f.manager.close()).rejects.toThrow('uncertain');
  });
  it('does not take over unrelated active engineering', async () => {
    const f = fixture(); f.attachment.state.mockReturnValue('running');
    expect(() => f.manager.start(command(f.manager.snapshot()))).toThrow('active engineering');
    expect(readEngineeringMissionControl(f.config).revision).toBe(0); expect(backend.run).not.toHaveBeenCalled(); await f.manager.close();
  });
  it('aborts owned work but retains a held result when a verified stop cannot be persisted', async () => {
    const f = fixture(true); f.manager.startConfigured(); await Promise.resolve();
    const input = command(f.manager.snapshot()), host = backend.run.mock.calls[0]![1] as ResourceEngineeringMissionHost;
    writeFileSync(join(f.config.root, 'mission-controls', 'records', '0001.json'), '{}');
    expect(() => f.manager.stop(input)).toThrow(); expect(host.signal!.aborted).toBe(true);
    f.settle(); await vi.waitFor(() => expect(f.manager.snapshot().lastOutcome?.reason).toBe('mission-control-unavailable'));
    expect(f.manager.snapshot().state).toBe('held'); await expect(f.manager.close()).rejects.toThrow('uncertain');
  });
  it.each(['digest', 'controller', 'revision', 'extra'])('rejects malformed or stale %s controls before publication', async kind => {
    const f = fixture(); const input = command(f.manager.snapshot());
    const changed = kind === 'digest' ? { ...input, expectedConfigDigest: 'b'.repeat(64) } : kind === 'controller' ? { ...input, expectedControllerId: 'c'.repeat(32) }
      : kind === 'revision' ? { ...input, expectedRevision: 8 } : { ...input, prompt: 'outside scope' };
    expect(() => f.manager.start(changed)).toThrow(); expect(readEngineeringMissionControl(f.config).revision).toBe(0);
    expect(backend.run).not.toHaveBeenCalled(); await f.manager.close();
  });
  it.each(['deadline', 'host', 'file'])('withholds %s changes without launching', async kind => {
    const f = fixture();
    if (kind === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.config.deadlineAt));
    if (kind === 'host') f.isStopped.mockReturnValue(true);
    if (kind === 'file') writeFileSync(f.configFile, JSON.stringify({ ...f.config, maxScopes: 3 }));
    try { expect(() => f.manager.start(command(f.manager.snapshot()))).toThrow(); expect(backend.run).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f.manager.close(); }
  });
});
describe('immutable mission intent history', () => {
  it('retains a contiguous digest chain and rejects stale revisions and a changed mission definition', () => {
    const f = fixture(); const a = setEngineeringMissionControl(f.config, true, 0), b = setEngineeringMissionControl(f.config, false, 1);
    expect(a.revision).toBe(1); expect(b).toEqual(readEngineeringMissionControl(f.config));
    expect(() => setEngineeringMissionControl(f.config, true, 1)).toThrow();
    expect(() => readEngineeringMissionControl({ ...f.config, maxScopes: 3 })).toThrow();
    expect(readdirSync(join(f.config.root, 'mission-controls', 'records'))).toEqual(['0001.json', '0002.json']);
  });
  it('refuses truncated and symlinked control history rather than re-enabling startup', () => {
    const f = fixture(true); setEngineeringMissionControl(f.config, true, 0); setEngineeringMissionControl(f.config, false, 1);
    const first = join(f.config.root, 'mission-controls', 'records', '0001.json'); unlinkSync(first);
    expect(() => createEngineeringMissionManager(f.options)).toThrow();
    symlinkSync(f.configFile, first); expect(() => readEngineeringMissionControl(f.config)).toThrow(); expect(backend.run).not.toHaveBeenCalled();
  });
});

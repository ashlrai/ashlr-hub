/** Lifecycle isolation only: all factories are inert, no provider or filesystem use. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const factories = vi.hoisted(() => ({ owner: vi.fn(), preparation: vi.fn(), supervision: vi.fn(), background: vi.fn(), admission: vi.fn() }));
vi.mock('../src/core/resources/console-engineering.js', () => ({ createResourceConsoleEngineeringOwner: factories.owner }));
vi.mock('../src/core/resources/console-engineering-preparation.js', () => ({ createResourceConsoleEngineeringPreparation: factories.preparation }));
vi.mock('../src/core/resources/console-engineering-supervisor.js', () => ({ createResourceConsoleEngineeringSupervisor: factories.supervision }));
vi.mock('../src/core/resources/engineering-background.js', () => ({ createEngineeringBackground: factories.background }));
vi.mock('../src/core/resources/engineering-automatic-admission.js', () => ({ createResourceEngineeringAutomaticAdmission: factories.admission }));
import { createResourceEngineeringComponent, type ResourceEngineeringComponent, type ResourceEngineeringComponentOptions } from '../src/core/resources/engineering-component.js';
const components: ResourceEngineeringComponent[] = [];
beforeEach(() => { vi.resetAllMocks(); });
afterEach(async () => { await Promise.allSettled(components.splice(0).map(component => component.closeWorkspace())); vi.useRealTimers(); });
function fixture() {
  const states: string[] = [], fault = vi.fn(), workspace = { close: vi.fn().mockResolvedValue(undefined) };
  const owner = { close: vi.fn().mockResolvedValue(undefined) };
  const supervision = { start: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  const background = { configureSuccessors: vi.fn().mockResolvedValue(undefined), start: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  const admission = { start: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  factories.owner.mockReturnValueOnce(owner); factories.supervision.mockReturnValueOnce(supervision);
  factories.background.mockResolvedValueOnce(background); factories.admission.mockReturnValueOnce(admission);
  const options = {
    owner: { root: '/inert', supervisor: workspace }, preparation: { config: {} },
    supervision: { autoAdmitPrepared: true }, successors: {},
    readAdmissionEvidence: () => ({ observations: [], unavailableWorkerIds: [] }),
    isWorkspaceStopped: () => false, onState: (state: string) => states.push(state), onFault: fault,
  } as unknown as ResourceEngineeringComponentOptions;
  const create = () => { const component = createResourceEngineeringComponent(options); components.push(component); return component; };
  return { options, create, states, fault, workspace, owner, supervision, background, admission };
}
describe('independently owned engineering components', () => {
  it('closes one initialized scope without starting or closing its workspace', async () => {
    const f = fixture(), c = f.create(); await c.initialize();
    expect(c.owner).toBe(f.owner); expect(c.preparation).toBe(f.background);
    expect(f.supervision.start).not.toHaveBeenCalled();
    await c.start(); await c.close();
    expect(f.supervision.start).toHaveBeenCalledOnce(); expect(f.background.start).toHaveBeenCalledOnce();
    expect(f.owner.close).toHaveBeenCalledExactlyOnceWith({ preserveSupervisorTasks: true });
    expect(f.workspace.close).not.toHaveBeenCalled(); expect(c.isStopped()).toBe(true);
    expect(f.states).toEqual(['running', 'stopping', 'closed']);
    expect(c.close()).toBe(c.close());
    await expect(c.start()).rejects.toThrow('unavailable');
  });
  it('pins drain callbacks to their own component instead of a later host scope', async () => {
    const first = fixture(), a = first.create(); await a.initialize(); await a.start();
    const firstOptions = factories.owner.mock.calls[0]![0];
    const second = fixture(), b = second.create(); await b.initialize(); await b.start();
    await a.close(); await firstOptions.waitForResourceDrain();
    expect(first.workspace.close).not.toHaveBeenCalled(); expect(second.workspace.close).not.toHaveBeenCalled();
    expect(second.background.close).not.toHaveBeenCalled(); expect(second.owner.close).not.toHaveBeenCalled();
    expect(b.isStopped()).toBe(false);
  });
  it('keeps whole-workspace shutdown distinct from component-only drain', async () => {
    const f = fixture(), c = f.create(); await c.initialize();
    const ownerOptions = factories.owner.mock.calls[0]![0];
    await c.close(); await c.closeWorkspace(); await ownerOptions.waitForResourceDrain();
    expect(f.owner.close.mock.calls).toEqual([[{ preserveSupervisorTasks: true }], []]);
    expect(f.workspace.close).toHaveBeenCalledOnce(); expect(c.closeWorkspace()).toBe(c.closeWorkspace());
  });
  it.each(['component', 'workspace'] as const)('waits for late background construction before %s drain', async mode => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    factories.background.mockReset().mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const c = f.create(), initialize = c.initialize();
    const initialized = expect(initialize).rejects.toThrow('stopped');
    await Promise.resolve();
    const close = mode === 'component' ? c.close() : c.closeWorkspace();
    let finished = false; void close.then(() => { finished = true; }); await Promise.resolve();
    expect(finished).toBe(false); expect(f.owner.close).not.toHaveBeenCalled();
    resolve(f.background); await initialized; await close;
    expect(f.background.close).toHaveBeenCalledOnce(); expect(f.owner.close).toHaveBeenCalledOnce();
    expect(factories.supervision).not.toHaveBeenCalled(); expect(f.background.configureSuccessors).not.toHaveBeenCalled();
  });
  it('drains remaining owners even if automatic admission cleanup rejects', async () => {
    const f = fixture(), c = f.create(); await c.initialize();
    f.admission.close.mockRejectedValue(new Error('inert failure'));
    await expect(c.closeWorkspace()).rejects.toThrow('uncertain');
    expect(f.owner.close).toHaveBeenCalledOnce(); expect(f.supervision.close).toHaveBeenCalledOnce();
    expect(f.background.close).toHaveBeenCalledOnce(); expect(f.states.at(-1)).toBe('held');
  });
  it('awaits initialization before starting any producer', async () => {
    const f = fixture(); let resolve!: (value: unknown) => void;
    factories.background.mockReset().mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const c = f.create(), initializing = c.initialize(), starting = c.start();
    await Promise.resolve(); expect(f.supervision.start).not.toHaveBeenCalled();
    resolve(f.background); await initializing; await starting;
    expect(f.supervision.start).toHaveBeenCalledOnce(); expect(f.background.start).toHaveBeenCalledOnce();
  });
  it('continues whole-workspace cleanup after a synchronous worker-close failure', async () => {
    const f = fixture(), c = f.create(); await c.initialize();
    f.background.close.mockImplementation(() => { throw new Error('synchronous close failure'); });
    await expect(c.closeWorkspace()).rejects.toThrow('uncertain');
    expect(f.owner.close).toHaveBeenCalledOnce(); expect(f.supervision.close).toHaveBeenCalledOnce();
    expect(f.admission.close).toHaveBeenCalledOnce();
  });
  it('removes its child observer and never closes a second component on child abort', async () => {
    vi.useFakeTimers();
    const first = fixture(), child = new AbortController(); first.options.lifetime = { signal: child.signal };
    const a = first.create(); await a.initialize(); await a.start();
    const second = fixture(), b = second.create(); await b.initialize(); await b.start();
    expect(vi.getTimerCount()).toBe(1); child.abort(); await a.close();
    expect(vi.getTimerCount()).toBe(0); expect(second.owner.close).not.toHaveBeenCalled(); expect(b.isStopped()).toBe(false);
  });
  it('retains a fault even if each cleanup promise fulfills', async () => {
    const f = fixture(), c = f.create(); await c.initialize();
    factories.background.mock.calls[0]![0].onFault();
    expect(c.isFaulted()).toBe(true); expect(f.fault).toHaveBeenCalledOnce();
    expect(c.isStopped()).toBe(true); await expect(c.start()).rejects.toThrow('unavailable');
    await expect(c.close()).rejects.toThrow('uncertain'); expect(f.states.at(-1)).toBe('held');
  });
  it('refuses initialization after an early close and refuses duplicate initialization', async () => {
    const f = fixture(), c = f.create(); await c.close();
    expect(() => c.initialize()).toThrow('unavailable'); expect(factories.owner).not.toHaveBeenCalled();
    const g = fixture(), next = g.create(); await next.initialize();
    expect(() => next.initialize()).toThrow('unavailable');
  });
});

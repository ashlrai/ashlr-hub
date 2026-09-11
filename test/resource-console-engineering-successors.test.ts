/** Isolated host adapter tests: no stores, coordinator loop, or provider calls. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceConsoleEngineeringSuccessors } from '../src/core/resources/console-engineering-successors.js';
import type { ResourceEngineeringSuccessorCoordinatorOptions } from '../src/core/resources/engineering-successor-coordinator-types.js';

const mocks = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), kill: vi.fn() }));
vi.mock('../src/core/resources/engineering-successor-coordinator.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/resources/engineering-successor-coordinator.js')>(),
  createResourceEngineeringSuccessorCoordinator: mocks.create,
}));
vi.mock('../src/core/resources/pool-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/resources/pool-runtime.js')>(), readResourceJson: mocks.read,
}));
vi.mock('../src/core/sandbox/policy.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(), readKillSwitch: mocks.kill,
}));
type Options = Parameters<typeof createResourceConsoleEngineeringSuccessors>[0];
beforeEach(() => { vi.clearAllMocks(); mocks.kill.mockReturnValue({ state: 'inactive' }); });
function fixture() {
  const config = { schemaVersion: 1 as const, supervisionId: 'queue', profileId: 'profile', allowedWorkerIds: ['worker'],
    maxOutputTokens: 256, proposalTimeoutMs: 1000, maxSuccessors: 2, pollIntervalMs: 100 };
  mocks.read.mockReturnValue(structuredClone(config));
  const binding = { workspace: '/private/project', dev: 1, ino: 2 };
  const enrollment = { id: 'next', expectedEnrollmentDigest: 'e'.repeat(64) };
  const actual = { projectId: 'project', commit: 'c'.repeat(40), objective: 'Delivered objective',
    source: { expectedDeliveryDigest: 'd'.repeat(64) }, context: JSON.stringify({ files: [{ path: 'value.json', content: '2' }], score: 2 }) };
  const preparation = { successorSource: vi.fn(() => actual), prepareSuccessor: vi.fn(async () => ({ enrollment })) };
  const supervision = { snapshot: vi.fn(() => ({ entries: [{ enrollmentId: 'source', enrollmentDigest: 'a'.repeat(64), state: 'completed' }] })),
    admit: vi.fn(), isExecutionStopped: vi.fn(() => false) };
  const supervisor = { projectFileBinding: vi.fn(() => binding), projectExecutionBinding: vi.fn(() => ({ ...binding })) };
  const isClosing = vi.fn(() => false); const readAdmissionEvidence = vi.fn(() => ({ observations: [], unavailableWorkerIds: [] }));
  const abort = new AbortController();
  const options = { root: '/private/ledger', configFile: '/private/successors.json', config, projectId: 'project',
    acceptance: 'Fixed host acceptance', preparation, supervision, supervisor, pool: { schemaVersion: 1, id: 'pool', workers: [] },
    bindings: [], readAdmissionEvidence, isClosing, signal: abort.signal } as unknown as Options;
  const create = () => { createResourceConsoleEngineeringSuccessors(options); return mocks.create.mock.calls.at(-1)![0] as ResourceEngineeringSuccessorCoordinatorOptions; };
  return { options, config, binding, actual, enrollment, preparation, supervision, supervisor, isClosing, readAdmissionEvidence, abort, create };
}

describe('private console successor host adapter', () => {
  it.each(['config', 'acceptance', 'isClosing', 'signal', 'preparation'] as const)('rejects option accessor %s without invoking it', key => {
    const f = fixture(); const getter = vi.fn(() => f.options[key]);
    Object.defineProperty(f.options, key, { enumerable: true, get: getter });
    expect(f.create).toThrow('Invalid successor console options'); expect(getter).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled(); expect(f.supervisor.projectFileBinding).not.toHaveBeenCalled();
  });
  it('rejects inherited, extra and symbolic options before host access', () => {
    const f = fixture();
    for (const options of [Object.create(f.options), { ...f.options, unexpected: true }, { ...f.options, [Symbol('authority')]: true }]) {
      expect(() => createResourceConsoleEngineeringSuccessors(options)).toThrow('Invalid successor console options');
    }
    expect(mocks.create).not.toHaveBeenCalled(); expect(f.supervisor.projectFileBinding).not.toHaveBeenCalled();
  });
  it.each(['accessor', 'inherited'] as const)('rejects %s host methods without invoking them', kind => {
    const f = fixture(); const getter = vi.fn(() => f.preparation.successorSource);
    const preparation = kind === 'inherited' ? Object.create(f.preparation) : { ...f.preparation };
    if (kind === 'accessor') Object.defineProperty(preparation, 'successorSource', { get: getter });
    f.options.preparation = preparation;
    expect(f.create).toThrow('Invalid successor console host'); expect(getter).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('captures paths, callbacks, acceptance and detached config rather than later option replacements', () => {
    const f = fixture(); const captured = f.create(); const originalRead = f.readAdmissionEvidence;
    Object.assign(f.options, { root: '/redirected', configFile: '/redirected/config', projectId: 'foreign', acceptance: 'Changed acceptance',
      isClosing: () => true, readAdmissionEvidence: () => { throw Error('replacement'); }, signal: AbortSignal.abort() });
    f.config.allowedWorkerIds.push('foreign'); f.config.maxSuccessors = 10;
    expect(captured.root).toBe('/private/ledger'); expect(captured.config.allowedWorkerIds).toEqual(['worker']);
    expect(captured.config.maxSuccessors).toBe(2); expect(captured.readAdmissionEvidence).toBe(originalRead);
    expect(captured.host.isExecutionStopped()).toBe(false);
    const source = captured.host.source('source', 'a'.repeat(64))!;
    expect(f.supervision.snapshot).not.toHaveBeenCalled();
    expect(f.preparation.successorSource).toHaveBeenCalledWith('source', 'a'.repeat(64));
    expect(JSON.parse(source.context)).toEqual({ acceptance: 'Fixed host acceptance', source: JSON.parse(f.actual.context) });
    expect(mocks.read).toHaveBeenLastCalledWith('/private/successors.json', 16 * 1024);
    expect(f.supervisor.projectExecutionBinding).toHaveBeenLastCalledWith('project');
    f.abort.abort(); expect(captured.host.isExecutionStopped()).toBe(true);
  });
  it('binds original host methods and uses only fresh host-derived delivery authority for preparation', async () => {
    const f = fixture(); const captured = f.create();
    const originalSource = f.preparation.successorSource; const originalPrepare = f.preparation.prepareSuccessor;
    const originalSnapshot = f.supervision.snapshot; const originalAdmit = f.supervision.admit;
    const originalBinding = f.supervisor.projectExecutionBinding;
    f.preparation.successorSource = vi.fn(() => { throw Error('replacement'); });
    f.preparation.prepareSuccessor = vi.fn(async () => { throw Error('replacement'); });
    f.supervision.snapshot = vi.fn(() => { throw Error('replacement'); });
    f.supervision.admit = vi.fn(() => { throw Error('replacement'); });
    f.supervision.isExecutionStopped = vi.fn(() => true);
    f.supervisor.projectExecutionBinding = vi.fn(() => { throw Error('replacement'); });
    const source = captured.host.source('source', 'a'.repeat(64))!;
    expect(await captured.host.prepare({ id: 'next', profileId: 'profile', name: 'Next', objective: 'Improve again', source })).toEqual(f.enrollment);
    expect(originalPrepare).toHaveBeenCalledWith({ id: 'next', profileId: 'profile', name: 'Next', objective: 'Improve again', source: f.actual.source });
    captured.supervision.admit({ enrollments: [], expectedRevision: 0 });
    expect(originalSource.mock.contexts.every(value => value === f.preparation)).toBe(true);
    expect(originalPrepare.mock.contexts[0]).toBe(f.preparation); expect(originalSnapshot.mock.contexts[0]).toBe(f.supervision);
    expect(originalAdmit.mock.contexts[0]).toBe(f.supervision); expect(originalBinding.mock.contexts[0]).toBe(f.supervisor);
    await expect(captured.host.prepare({ id: 'next', profileId: 'profile', name: 'Next', objective: 'Improve again',
      source: { ...source, commit: 'f'.repeat(40) } })).rejects.toThrow('Successor source changed');
    expect(originalPrepare).toHaveBeenCalledTimes(1);
  });
  it('withholds admission result if closing begins during completed preparation', async () => {
    const f = fixture(); f.preparation.prepareSuccessor.mockImplementation(async () => {
      f.isClosing.mockReturnValue(true); return { enrollment: f.enrollment };
    });
    const captured = f.create(); const source = captured.host.source('source', 'a'.repeat(64))!;
    await expect(captured.host.prepare({ id: 'next', profileId: 'profile', name: 'Next', objective: 'Improve again', source }))
      .rejects.toThrow('admission withheld');
    expect(f.preparation.prepareSuccessor).toHaveBeenCalledTimes(1); expect(f.supervision.admit).not.toHaveBeenCalled();
  });
});

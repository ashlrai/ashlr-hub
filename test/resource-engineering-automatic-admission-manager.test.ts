/** Real manager recovery logic with mocked verified registry and in-memory owner. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const registry = vi.hoisted(() => ({ create: vi.fn(), registrations: vi.fn(), committed: vi.fn(), currentConfig: vi.fn(), prepare: vi.fn() }));
vi.mock('../src/core/resources/engineering-preparation-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/resources/engineering-preparation-registry.js')>(),
  createResourceEngineeringPreparationRegistry: registry.create,
}));
import { createResourceConsoleEngineeringPreparation, ResourceEngineeringAutomaticAdmissionOwnershipError } from '../src/core/resources/console-engineering-preparation.js';
import type { ResourceEngineeringPreparationRegistration } from '../src/core/resources/engineering-preparation-registry.js';

const binding = { schemaVersion: 1 as const, supervisionId: 'original', configDigest: 'a'.repeat(64), deadlineAt: '2026-09-12T12:01:00.000Z' };
const row = (id: string): ResourceEngineeringPreparationRegistration => ({ schemaVersion: 1, configDigest: 'b'.repeat(64),
  request: { id, profileId: 'fixed', name: id, objective: 'Private objective' }, planDigest: 'c'.repeat(64), bundlePlanDigest: 'd'.repeat(64),
  enrollmentDigest: 'e'.repeat(64), automaticAdmission: binding });
beforeEach(() => {
  vi.clearAllMocks(); registry.registrations.mockReturnValue([]);
  registry.committed.mockImplementation((value: ResourceEngineeringPreparationRegistration) => ({ catalog: { schemaVersion: 1, enrollments: [{ id: value.request.id, enrollmentDigest: value.enrollmentDigest }] } }));
  registry.create.mockReturnValue({ config: { profiles: [] }, contextDigest: 'b'.repeat(64), currentConfig: registry.currentConfig,
    registrations: registry.registrations, committed: registry.committed, prepare: registry.prepare });
});
function manager() {
  const owner = { register: vi.fn(), catalog: vi.fn(() => []), checkRegistration: vi.fn() };
  const value = createResourceConsoleEngineeringPreparation({ configFile: '/private/config', config: { profiles: [] }, root: '/private/root',
    workspace: '/private/repo', projectsFile: '/private/projects', poolFile: '/private/pool', bindingsFile: '/private/bindings', observationsFile: '/private/observations',
    owner } as unknown as Parameters<typeof createResourceConsoleEngineeringPreparation>[0]);
  owner.register.mockClear(); registry.committed.mockClear(); return { value, owner };
}
describe('verified registration-only pending admission', () => {
  it('passes host authorization separately into atomic registry preparation, leaving ordinary calls unchanged', () => {
    const f = manager(); const enrollment = { id: 'first', enrollmentDigest: 'e'.repeat(64) };
    registry.prepare.mockReturnValue({ plan: { id: 'first' }, catalog: { schemaVersion: 1, enrollments: [enrollment] }, enrollmentDigest: enrollment.enrollmentDigest, disposition: 'created' });
    f.owner.register.mockReturnValue([enrollment]);
    const request = { id: 'first', expectedPlanDigest: 'a'.repeat(64) };
    f.value.prepareAutomatically(request, binding);
    expect(registry.prepare.mock.calls[0]?.[0]).toBe(request); expect(registry.prepare.mock.calls[0]?.[2]).toEqual(binding);
    f.value.prepare(request); expect(registry.prepare.mock.calls[1]?.[2]).toBeUndefined();
  });
  it('ignores unmarked legacy rows and successor rows without scanning owner catalog', () => {
    const f = manager(); const manual = row('manual'); delete manual.automaticAdmission;
    registry.registrations.mockReturnValue([manual, { ...manual, request: { ...manual.request, id: 'successor' }, source: {} }]);
    expect(f.value.pendingAutomaticAdmissions(binding, [])).toEqual([]); expect(f.owner.catalog).not.toHaveBeenCalled(); expect(f.owner.register).not.toHaveBeenCalled();
  });
  it('restores a missing map entry from a verified durable obligation', () => {
    const f = manager(); registry.registrations.mockReturnValue([row('first')]);
    expect(f.value.pendingAutomaticAdmissions(binding, [])).toEqual([{ enrollmentId: 'first', expectedEnrollmentDigest: 'e'.repeat(64), reason: null }]);
    expect(f.owner.register).toHaveBeenCalledOnce(); expect(registry.committed).toHaveBeenCalledWith(row('first'), row('first').request, true);
  });
  it('skips exact admitted pairs but reports digest conflicts without rereading their bundle', () => {
    const f = manager(); registry.registrations.mockReturnValue([row('first')]);
    expect(f.value.pendingAutomaticAdmissions(binding, [{ enrollmentId: 'first', enrollmentDigest: 'e'.repeat(64) }])).toEqual([]);
    expect(f.value.pendingAutomaticAdmissions(binding, [{ enrollmentId: 'first', enrollmentDigest: 'f'.repeat(64) }])[0]?.reason).toBe('binding-changed');
    expect(registry.committed).not.toHaveBeenCalled();
  });
  it('holds original-budget mismatch without redirecting it to the current deadline', () => {
    const f = manager(); registry.registrations.mockReturnValue([{ ...row('first'), automaticAdmission: { ...binding, deadlineAt: '2027-01-01T00:00:00.000Z' } }]);
    expect(f.value.pendingAutomaticAdmissions(binding, [])[0]?.reason).toBe('binding-changed'); expect(f.owner.register).not.toHaveBeenCalled();
  });
  it('holds failed proof independently but does not swallow an owner registration failure', () => {
    const f = manager(); registry.registrations.mockReturnValue([row('first'), row('second')]);
    registry.committed.mockImplementationOnce(() => { throw new Error('changed bundle'); });
    expect(f.value.pendingAutomaticAdmissions(binding, []).map(value => value.reason)).toEqual(['evidence-unavailable', 'verification-pending']);
    expect(registry.committed).toHaveBeenCalledTimes(1);
    expect(f.value.pendingAutomaticAdmissions(binding, []).map(value => value.reason)).toEqual(['verification-pending', null]);
    expect(registry.committed).toHaveBeenCalledTimes(2);
    f.owner.register.mockImplementation(() => { throw new Error('owner lost'); });
    expect(() => f.value.pendingAutomaticAdmissions(binding, [])).toThrow(ResourceEngineeringAutomaticAdmissionOwnershipError);
  });
  it('prioritizes a freshly prepared marked row but cannot promote a legacy row', () => {
    const f = manager(); const legacy = row('legacy'); delete legacy.automaticAdmission;
    registry.registrations.mockReturnValue([row('first'), row('second'), legacy]);
    expect(f.value.pendingAutomaticAdmissions(binding, [], 'second').map(value => value.reason)).toEqual(['verification-pending', null]);
    expect(f.value.pendingAutomaticAdmissions(binding, [], 'legacy').some(value => value.enrollmentId === 'legacy')).toBe(false);
  });
  it('permits an invalid marked ordinary proof to remain held at startup but not a legacy proof', () => {
    registry.registrations.mockReturnValue([row('first')]); registry.committed.mockImplementation(() => { throw new Error('changed proof'); });
    expect(() => manager()).not.toThrow();
    const legacy = row('legacy'); delete legacy.automaticAdmission; registry.registrations.mockReturnValue([legacy]);
    expect(() => manager()).toThrow('changed proof');
  });
});

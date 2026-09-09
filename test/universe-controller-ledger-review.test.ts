import { describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { foldPortfolioController } from '../src/core/universe/portfolio-controller-store.js';
import type { PortfolioControllerEnrollment, PortfolioControllerEvent, PortfolioControllerPin,
  UniversePortfolioControllerOutcome } from '../src/core/universe/portfolio-controller-types.js';

// Synthetic identity pins exercise ledger semantics only; these fixtures do not
// prove campaign execution, repository delivery, or authenticated provider work.
const HASH = 'a'.repeat(64);
const DELIVERED = 'b'.repeat(64);
const EPOCH = Date.parse('2026-09-09T12:00:00.000Z');
const at = (offset: number) => new Date(EPOCH + offset).toISOString();

function pin(campaignId: string, initialState: PortfolioControllerPin['initialState'] = 'pending'): PortfolioControllerPin {
  return { campaignId, universeId: `universe-${campaignId}`, definitionDigest: HASH, manifestDigest: HASH,
    comparatorDigest: HASH, campaignDigest: HASH, recordsDigest: HASH, initialState,
    dispatch: initialState === 'pending' ? 'campaign' : 'none', reasonCode: initialState };
}

function enrollment(plannedDelivery = false): PortfolioControllerEnrollment {
  const definition = { schemaVersion: 1 as const, id: 'portfolio',
    tasks: [{ campaignId: 'a', dependsOn: [] }, { campaignId: 'b', dependsOn: ['a'] }],
    maxParallel: 2, maxDurationMs: 1_000 };
  return { definition, definitionDigest: digest(canonical(definition)), deadlineAt: at(1_000),
    deliveryPlan: plannedDelivery ? { schemaVersion: 1,
      deliveries: [{ campaignId: 'a', branch: 'codex/a', baseCommit: 'a'.repeat(40) }] } : null,
    pins: [pin('a'), pin('b')] };
}

function created(value = enrollment()): PortfolioControllerEvent {
  return { id: '00000000', sequence: 0, at: at(0), kind: 'created', enrollment: value };
}

function intent(sequence: number, campaignId = 'a', offset = sequence): PortfolioControllerEvent {
  return { id: String(sequence).padStart(8, '0'), sequence, at: at(offset), kind: 'intent', campaignId };
}

function settled(sequence: number, overrides: Partial<UniversePortfolioControllerOutcome> = {}, offset = sequence): PortfolioControllerEvent {
  return { id: String(sequence).padStart(8, '0'), sequence, at: at(offset), kind: 'settled', recordsDigest: HASH,
    outcome: { campaignId: 'a', state: 'completed', attempted: true, reasonCode: 'completed',
      campaignDigest: HASH, deliveryDigest: null, ...overrides } };
}

describe('Independent persisted controller ledger review', () => {
  it('folds a closed valid ordered graph without inventing worker liveness', () => {
    const folded = foldPortfolioController([created(), intent(1), settled(2), intent(3, 'b')]);
    expect(folded.states.get('a')?.state).toBe('completed');
    expect(folded.states.get('b')).toMatchObject({ state: 'in-flight', attempted: true, reasonCode: 'reconciliation-required' });
    expect([...folded.intents]).toEqual(['a', 'b']);
  });

  it('requires a registration before any other event', () => {
    expect(() => foldPortfolioController([])).toThrow();
    expect(() => foldPortfolioController([intent(0)])).toThrow();
  });

  it('rejects sequence gaps and inconsistent record identities', () => {
    expect(() => foldPortfolioController([created(), intent(2)])).toThrow();
    expect(() => foldPortfolioController([created(), { ...intent(1), id: '00000002' }])).toThrow();
  });

  it('rejects replacement registration and duplicate intent', () => {
    expect(() => foldPortfolioController([created(), created()])).toThrow();
    expect(() => foldPortfolioController([created(), { ...created(), sequence: 1, id: '00000001', at: at(1) }])).toThrow();
    expect(() => foldPortfolioController([created(), intent(1), intent(2)])).toThrow();
  });

  it('rejects time regression even for a read observation', () => {
    expect(() => foldPortfolioController([created(), intent(1, 'a', 20), settled(2, {}, 19)])).toThrow();
    expect(() => foldPortfolioController([created(), intent(1, 'a', 20), {
      id: '00000002', sequence: 2, kind: 'observed', at: at(19),
    }])).toThrow();
  });

  it('rejects undeclared campaign intents and settlements', () => {
    expect(() => foldPortfolioController([created(), intent(1, 'outsider')])).toThrow();
    expect(() => foldPortfolioController([created(), intent(1), settled(2, { campaignId: 'outsider' })])).toThrow();
  });

  it('rejects settlement before intent and duplicate settlement', () => {
    expect(() => foldPortfolioController([created(), settled(1)])).toThrow();
    expect(() => foldPortfolioController([created(), intent(1), settled(2), settled(3)])).toThrow();
  });

  it('rejects changing attempted attribution between intent and settlement', () => {
    expect(() => foldPortfolioController([created(), intent(1), settled(2, { attempted: false })])).toThrow();
    const deliveryOnly = enrollment(true);
    deliveryOnly.pins[0]!.dispatch = 'delivery';
    expect(() => foldPortfolioController([created(deliveryOnly), intent(1), settled(2, { deliveryDigest: DELIVERED })])).toThrow();
    const good = foldPortfolioController([created(deliveryOnly), intent(1), settled(2, { attempted: false, deliveryDigest: DELIVERED })]);
    expect(good.states.get('a')).toMatchObject({ state: 'completed', attempted: false, deliveryDigest: DELIVERED });
  });

  it('requires the planned delivery receipt before recording completion', () => {
    expect(() => foldPortfolioController([created(enrollment(true)), intent(1), settled(2)])).toThrow();
    const good = foldPortfolioController([created(enrollment(true)), intent(1), settled(2, { deliveryDigest: DELIVERED })]);
    expect(good.states.get('a')?.deliveryDigest).toBe(DELIVERED);
  });

  it('rejects unplanned delivery evidence and delivery-only dispatch without a plan', () => {
    expect(() => foldPortfolioController([created(), intent(1), settled(2, { deliveryDigest: DELIVERED })])).toThrow();
    const invalid = enrollment();
    invalid.pins[0]!.dispatch = 'delivery';
    expect(() => foldPortfolioController([created(invalid)])).toThrow();
  });

  it('does not allow a planned delivery target to bypass evidence by enrolling as completed', () => {
    const invalid = enrollment(true);
    invalid.pins[0] = pin('a', 'completed');
    expect(() => foldPortfolioController([created(invalid)])).toThrow();
  });

  it('rejects dispatch after the original deadline but allows in-flight settlement afterward', () => {
    expect(() => foldPortfolioController([created(), intent(1, 'a', 1_000)])).toThrow();
    const good = foldPortfolioController([created(), intent(1, 'a', 999), settled(2, {}, 1_001)]);
    expect(good.states.get('a')?.state).toBe('completed');
    expect(good.first.enrollment.deadlineAt).toBe(at(1_000));
  });

  it('does not renew the initial deadline through later observations', () => {
    const observed: PortfolioControllerEvent = { id: '00000001', sequence: 1, kind: 'observed', at: at(1_001) };
    expect(() => foldPortfolioController([created(), observed, intent(2, 'a', 1_002)])).toThrow();
    const invalid = enrollment();
    invalid.deadlineAt = at(2_000);
    expect(() => foldPortfolioController([created(invalid)])).toThrow();
  });

  it('holds dependent dispatch until its direct prerequisite settles', () => {
    expect(() => foldPortfolioController([created(), intent(1, 'b')])).toThrow();
    expect(() => foldPortfolioController([created(), intent(1), settled(2, { state: 'held', reasonCode: 'paused' }), intent(3, 'b')])).toThrow();
  });

  it('refuses histories that exceed pinned concurrency and releases capacity only on settlement', () => {
    const value = enrollment();
    value.definition.tasks[1]!.dependsOn = [];
    value.definition.maxParallel = 1;
    value.definitionDigest = digest(canonical(value.definition));
    expect(() => foldPortfolioController([created(value), intent(1), intent(2, 'b')])).toThrow();
    const good = foldPortfolioController([created(value), intent(1), settled(2), intent(3, 'b')]);
    expect(good.states.get('b')?.state).toBe('in-flight');
  });

  it('preserves a planned ancestor gate through a precompleted intermediate', () => {
    const value = enrollment(true);
    value.definition.tasks.push({ campaignId: 'c', dependsOn: ['b'] });
    value.definitionDigest = digest(canonical(value.definition));
    value.pins[1] = pin('b', 'completed');
    value.pins.push(pin('c'));
    expect(() => foldPortfolioController([created(value), intent(1, 'c')])).toThrow();
    expect(() => foldPortfolioController([created(value), intent(1),
      settled(2, { state: 'held', reasonCode: 'delivery-withheld' }), intent(3, 'c')])).toThrow();
    const good = foldPortfolioController([created(value), intent(1), settled(2, { deliveryDigest: DELIVERED }), intent(3, 'c')]);
    expect(good.states.get('c')?.state).toBe('in-flight');
  });

  it('rejects changed enrollment definition identity and pin ordering', () => {
    const wrongDigest = enrollment();
    wrongDigest.definitionDigest = 'f'.repeat(64);
    expect(() => foldPortfolioController([created(wrongDigest)])).toThrow();
    const wrongOrder = enrollment();
    wrongOrder.pins.reverse();
    expect(() => foldPortfolioController([created(wrongOrder)])).toThrow();
  });

  it('rejects open-schema data and malformed hash pins', () => {
    const invalid = enrollment();
    invalid.pins[0]!.campaignDigest = 'not-an-evidence-digest';
    expect(() => foldPortfolioController([created(invalid)])).toThrow();
    const extra = { ...intent(1), retry: true } as PortfolioControllerEvent;
    expect(() => foldPortfolioController([created(), extra])).toThrow();
  });
});

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { queryDecisionTracesV1, signDecisionTraceV1, validateDecisionTraceV1, verifyDecisionTraceV1,
  type UnsignedDecisionTraceV1 } from '../src/core/universe/decision-trace.js';

const hooks = vi.hoisted(() => ({ readKey: vi.fn(), createKey: vi.fn() }));
vi.mock('../src/core/foundry/provenance.js', () => ({
  loadExistingProvenanceKeyReadOnly: hooks.readKey, loadOrCreateKey: hooks.createKey,
}));
const testKey = Buffer.alloc(32, 7);
const options = { testKey };
function input(patch: Partial<UnsignedDecisionTraceV1> = {}): UnsignedDecisionTraceV1 {
  return { id: 'decision-1', ts: '2026-09-10T10:00:00.000Z', entities: ['mission:hub', 'repo:hub'], action: 'evaluate-candidate',
    constitutionVersion: 'v1', policyEpoch: 4, inputsDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64),
    verifier: { id: 'inert-verifier', verdict: 'pass', independent: true },
    authority: { effectClass: 'observe', denied: true }, spend: { unknown: true },
    conflicts: [{ otherId: 'decision-old', reason: 'value' }, { otherId: 'decision-old', reason: 'scope' }], ...patch };
}
const signed = (patch: Partial<UnsignedDecisionTraceV1> = {}) => signDecisionTraceV1(input(patch), options)!;
beforeEach(() => { hooks.readKey.mockReset().mockReturnValue(null); hooks.createKey.mockReset(); });

describe('strict DecisionTraceV1 provenance', () => {
  it('signs a detached trace with a domain-separated existing host key', () => {
    hooks.readKey.mockReturnValue(testKey);
    const source = input(); const trace = signDecisionTraceV1(source)!;
    expect(trace.provenanceSig).toBe(createHmac('sha256', testKey).update('ashlr:universe:decision-trace:v1\n').update(canonical(source)).digest('hex'));
    expect(verifyDecisionTraceV1(trace)).toBe(true);
    expect(hooks.readKey).toHaveBeenCalledTimes(2); expect(hooks.createKey).not.toHaveBeenCalled();
    expect(trace).not.toBe(source); expect(trace.verifier).not.toBe(source.verifier); expect(trace.conflicts).not.toBe(source.conflicts);
  });

  it('never creates a key when default provenance evidence is missing or fails to load', () => {
    expect(signDecisionTraceV1(input())).toBeNull(); expect(verifyDecisionTraceV1(signed())).toBe(false);
    hooks.readKey.mockImplementation(() => { throw new Error('/private/key-location'); });
    expect(signDecisionTraceV1(input())).toBeNull(); expect(verifyDecisionTraceV1(signed())).toBe(false);
    expect(hooks.createKey).not.toHaveBeenCalled();
  });

  it('keeps explicit inert keys separate from default host verification', () => {
    const trace = signed();
    expect(hooks.readKey).not.toHaveBeenCalled();
    expect(verifyDecisionTraceV1(trace, options)).toBe(true);
    expect(verifyDecisionTraceV1(trace)).toBe(false);
    expect(verifyDecisionTraceV1(trace, { testKey: Buffer.alloc(32, 8) })).toBe(false);
  });

  it.each(['pass', 'fail', 'unavailable'] as const)('accepts a recorded %s verdict without granting authority', (verdict) => {
    const trace = signed({ verifier: { id: 'verifier', verdict, independent: false }, authority: { effectClass: 'build', permitId: 'permit-1', denied: true } });
    expect(verifyDecisionTraceV1(trace, options)).toBe(true);
    expect(trace.verifier.independent).toBe(false); expect(trace.authority.denied).toBe(true);
    expect(trace).not.toHaveProperty('authorized');
  });

  it('rejects forged, transplanted and wrong-domain signatures', () => {
    const trace = signed();
    expect(verifyDecisionTraceV1({ ...trace, provenanceSig: '0'.repeat(64) }, options)).toBe(false);
    expect(verifyDecisionTraceV1({ ...trace, id: 'decision-2' }, options)).toBe(false);
    const provenanceSig = createHmac('sha256', testKey).update(canonical(input())).digest('hex');
    expect(verifyDecisionTraceV1({ ...trace, provenanceSig }, options)).toBe(false);
  });

  it.each([
    { verifier: undefined }, { verifier: null }, { verifier: { id: 'v', verdict: 'pass' } },
    { verifier: { id: 'v', verdict: 'accepted', independent: true } },
    { verifier: { id: 'v', verdict: 'pass', independent: 'yes' } },
    { verifier: { id: 'v', verdict: 'pass', independent: true, private: 'secret' } },
    { ts: '2026-02-30T10:00:00.000Z' }, { policyEpoch: -1 }, { policyEpoch: 0.1 },
    { inputsDigest: 'not-a-digest' }, { artifactDigest: undefined }, { id: '../decision' },
    { entities: ['duplicate', 'duplicate'] }, { entities: Array(65).fill('entity') },
    { authority: { effectClass: 'operate', executable: true } }, { authority: { effectClass: 'operate', denied: 'false' } },
    { spend: { unknown: false } }, { spend: { unknown: false, tokens: 2 } },
    { spend: { unknown: true, tokens: -1 } }, { spend: { unknown: true, tokens: 1.5 } },
    { spend: { unknown: true, usd: Infinity } }, { spend: { unknown: true, usd: -1 } },
    { conflicts: [{ otherId: 'other', reason: 'opinion' }] }, { conflicts: [{ otherId: 'decision-1', reason: 'scope' }] },
    { conflicts: Array(129).fill({ otherId: 'other', reason: 'value' }) }, { supersedes: 'decision-1' },
    { unexpected: 'field' },
  ])('rejects malformed or unknown evidence (%j)', (patch) => {
    const value = { ...input(), ...patch };
    expect(signDecisionTraceV1(value, options)).toBeNull();
    expect(() => validateDecisionTraceV1({ ...value, provenanceSig: '0'.repeat(64) })).toThrow('Invalid DecisionTraceV1 evidence');
    expect(verifyDecisionTraceV1({ ...value, provenanceSig: '0'.repeat(64) }, options)).toBe(false);
  });

  it('requires an actual verifier field, rejecting omission before key lookup', () => {
    const { verifier: _verifier, ...missing } = input();
    expect(signDecisionTraceV1(missing)).toBeNull(); expect(hooks.readKey).not.toHaveBeenCalled();
  });

  it('rejects accessors, symbols, custom prototypes and sparse arrays without reading getters', () => {
    const getter = vi.fn(() => 'secret');
    const root = Object.defineProperty(input(), 'action', { get: getter });
    const nested = input(); Object.defineProperty(nested.verifier, 'id', { get: getter });
    const entities = ['entity']; Object.defineProperty(entities, '0', { get: getter });
    for (const value of [root, nested, { ...input(), entities }, { ...input(), entities: Array(1) },
      Object.assign(Object.create({ inherited: true }), input()), { ...input(), [Symbol('hidden')]: true }]) {
      expect(signDecisionTraceV1(value, options)).toBeNull();
    }
    const keyOptions = Object.defineProperty({}, 'testKey', { get: getter });
    expect(signDecisionTraceV1(input(), keyOptions)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it('retains unknown/partial spend without coercion to zero and accepts measured zero', () => {
    expect(signed().spend).toEqual({ unknown: true });
    expect(signed({ spend: { tokens: 21, unknown: true } }).spend).toEqual({ tokens: 21, unknown: true });
    expect(signed({ spend: { usd: 0.02, unknown: true } }).spend).toEqual({ usd: 0.02, unknown: true });
    expect(signed({ spend: { tokens: 0, usd: 0, unknown: false } }).spend).toEqual({ tokens: 0, usd: 0, unknown: false });
  });

  it('detaches validation snapshots and detects mutation of every signed nested section', () => {
    const trace = signed(); const copy = validateDecisionTraceV1(trace);
    copy.entities.push('new'); copy.verifier.independent = false; copy.authority.denied = false;
    copy.spend.tokens = 1; copy.conflicts[0]!.reason = 'date';
    expect(verifyDecisionTraceV1(copy, options)).toBe(false);
    expect(verifyDecisionTraceV1(trace, options)).toBe(true);
    const source = input(); const original = signDecisionTraceV1(source, options)!;
    source.entities.push('later'); source.conflicts[0]!.reason = 'date';
    expect(verifyDecisionTraceV1(original, options)).toBe(true);
  });
});

describe('bounded pure decision trace queries', () => {
  it('preserves all conflict links and superseded history even when targets are outside the page', () => {
    const first = signed({ supersedes: 'decision-old', conflicts: [
      { otherId: 'decision-old', reason: 'value' }, { otherId: 'decision-old', reason: 'date' }, { otherId: 'decision-2', reason: 'scope' },
    ] });
    const second = signed({ id: 'decision-2' });
    const result = queryDecisionTracesV1([first, second], { limit: 1 });
    expect(result).toMatchObject({ total: 2, truncated: true, signatureVerification: 'not-performed' });
    expect(result.traces[0]!.conflicts).toEqual(first.conflicts); expect(result.traces[0]!.supersedes).toBe('decision-old');
    result.traces[0]!.conflicts.pop(); expect(first.conflicts).toHaveLength(3);
    expect(hooks.readKey).not.toHaveBeenCalled();
  });

  it('filters literally by entity, action and inclusive dates while preserving supplied order', () => {
    const traces = [signed({ id: 'latest', ts: '2026-09-10T11:00:00Z' }), signed({ id: 'earlier' }),
      signed({ id: 'other', action: 'build', entities: ['repo:other'] })];
    const result = queryDecisionTracesV1(traces, { entity: 'mission:hub', action: 'evaluate-candidate', since: '2026-09-10T10:00:00Z', until: '2026-09-10T11:00:00Z' });
    expect(result.traces.map((trace) => trace.id)).toEqual(['latest', 'earlier']);
    expect(queryDecisionTracesV1(traces, { entity: 'mission:missing' }).traces).toEqual([]);
    expect(queryDecisionTracesV1([])).toMatchObject({ traces: [], total: 0, truncated: false });
  });

  it('does not silently remove duplicate IDs or unauthenticated but structurally valid records', () => {
    const trace = signed(); const changed = { ...trace, action: 'different-action' };
    const result = queryDecisionTracesV1([trace, changed]);
    expect(result.traces).toHaveLength(2); expect(result.signatureVerification).toBe('not-performed');
    expect(verifyDecisionTraceV1(result.traces[1], options)).toBe(false);
  });

  it.each([{ limit: 0 }, { limit: 257 }, { limit: 1.5 }, { unknown: true },
    { since: 'invalid' }, { since: '2026-09-11T00:00:00Z', until: '2026-09-10T00:00:00Z' }])('rejects invalid query bounds (%j)', (query) => {
      expect(() => queryDecisionTracesV1([signed()], query)).toThrow();
    });

  it('validates the entire bounded input instead of hiding invalid evidence past the result limit', () => {
    expect(() => queryDecisionTracesV1([signed(), { invalid: true }], { limit: 1 })).toThrow();
    expect(() => queryDecisionTracesV1(Array(4_097).fill(signed()))).toThrow();
    expect(queryDecisionTracesV1(Array(256).fill(signed()), { limit: 256 }).traces).toHaveLength(256);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { seedContextReceipt, validateUniverseSeedContext, validSeedContextReceipt } from '../src/core/universe/seed-context.js';
import { newGenerationReceipt, validGenerationReceipt } from '../src/core/universe/generation.js';
import type { UniverseSeedContext } from '../src/core/universe/types.js';
function fixture(): UniverseSeedContext {
  return { schemaVersion: 1, source: { universeId: 'universe', campaignId: 'campaign', definitionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64),
    comparatorDigest: 'c'.repeat(64), seedArtifactDigest: 'd'.repeat(64), intentDigest: 'e'.repeat(64), resultDigest: 'f'.repeat(64) },
  measurement: { passed: false, score: -5, metrics: { checks: 142 }, diagnostics: [{ code: 'case_failed', message: 'Fix the measured case', path: 'src/example.ts', line: 1 }] } };
}
describe('distinct bounded measured seed context', () => {
  it('detaches exact evidence and hashes its canonical bytes without inventing lineage', () => {
    const input = fixture(); const checked = validateUniverseSeedContext(input);
    expect(checked).toEqual(input); expect(seedContextReceipt(checked)).toEqual({ schemaVersion: 1, digest: digest(canonical(input)) });
    input.source.campaignId = 'changed'; input.measurement.metrics.checks = 0; input.measurement.diagnostics[0]!.message = 'changed';
    expect(checked).toEqual(fixture()); expect(checked).not.toHaveProperty('runId'); expect(checked).not.toHaveProperty('trialId');
  });
  it.each([true, false])('permits genuine passed=%s including finite zero/negative scores', passed => {
    for (const score of [-5, 0, 5]) expect(validateUniverseSeedContext({ ...fixture(), measurement: { passed, score, metrics: {}, diagnostics: [] } }).measurement.score).toBe(score);
  });
  it.each(['universeId', 'campaignId', 'definitionDigest', 'manifestDigest', 'comparatorDigest', 'seedArtifactDigest', 'intentDigest', 'resultDigest'])(
    'requires valid exact %s', key => {
      for (const value of ['', undefined, null, 'INVALID / ID', 4]) {
        const input = fixture(); Object.assign(input.source, { [key]: value }); expect(() => validateUniverseSeedContext(input)).toThrow();
      }
    });
  it.each([NaN, Infinity, -Infinity, '1', null])('refuses unmeasured/nonfinite score %s', score => {
    const input = fixture(); Object.assign(input.measurement, { score }); expect(() => validateUniverseSeedContext(input)).toThrow();
  });
  it('bounds metric count, key grammar and values', () => {
    for (const metrics of [{ key: Infinity }, { 'bad key': 1 }, { ['x'.repeat(81)]: 1 }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`metric${i}`, i]))]) {
      expect(() => validateUniverseSeedContext({ ...fixture(), measurement: { ...fixture().measurement, metrics } })).toThrow();
    }
  });
  it('refuses extra fields, omitted diagnostics and oversized UTF8 diagnostic evidence', () => {
    for (const input of [{ ...fixture(), trialId: 'fake' }, { ...fixture(), source: { ...fixture().source, runId: 'fake' } },
      { ...fixture(), measurement: { passed: false, score: 0, metrics: {} } },
      { ...fixture(), measurement: { ...fixture().measurement, diagnostics: Array.from({ length: 16 }, () => ({ code: 'case', message: '界'.repeat(512) })) } }]) {
      expect(() => validateUniverseSeedContext(input)).toThrow();
    }
  });
  it('rejects getters at every input depth without invoking them', () => {
    const getter = vi.fn(() => 'unsafe');
    for (const location of ['top', 'source', 'measurement', 'metrics', 'diagnostic', 'array'] as const) {
      const input = fixture();
      const target = location === 'top' ? input : location === 'source' ? input.source : location === 'measurement' ? input.measurement :
        location === 'metrics' ? input.measurement.metrics : location === 'diagnostic' ? input.measurement.diagnostics[0]! : input.measurement.diagnostics;
      const key = location === 'top' ? 'source' : location === 'source' ? 'campaignId' : location === 'measurement' ? 'score' :
        location === 'metrics' ? 'checks' : location === 'diagnostic' ? 'message' : '0';
      Object.defineProperty(target, key, { enumerable: true, get: getter }); expect(() => validateUniverseSeedContext(input)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects inherited objects, sparse arrays, symbols and custom array methods', () => {
    const inherited = Object.assign(Object.create({ authority: true }), fixture());
    const sparse = fixture(); delete sparse.measurement.diagnostics[0];
    const symbol = fixture(); Object.assign(symbol, { [Symbol('hidden')]: true });
    const custom = fixture(); Object.setPrototypeOf(custom.measurement.diagnostics, { map: () => { throw new Error('must not call'); } });
    for (const input of [inherited, sparse, symbol, custom]) expect(() => validateUniverseSeedContext(input)).toThrow();
  });
  it('accepts only exact seed receipts attached to a formed generation prompt', () => {
    const initial = newGenerationReceipt({ kind: 'local-chat', endpoint: 'http://127.0.0.1:11434', model: 'fixture', files: ['value'], maxOutputTokens: 128 });
    const seedContext = seedContextReceipt(fixture());
    expect(validGenerationReceipt(initial)).toBe(true); expect(validGenerationReceipt({ ...initial, seedContext })).toBe(false);
    expect(validGenerationReceipt({ ...initial, promptDigest: 'a'.repeat(64), seedContext })).toBe(true);
    for (const value of [{ ...seedContext, runId: 'fake' }, { ...seedContext, schemaVersion: 2 }, { ...seedContext, digest: 'bad' }, undefined]) {
      expect(validSeedContextReceipt(value)).toBe(false); expect(validGenerationReceipt({ ...initial, promptDigest: 'a'.repeat(64), seedContext: value })).toBe(false);
    }
    const getter = vi.fn(); const receipt = { ...initial }; Object.defineProperty(receipt, 'seedContext', { enumerable: true, get: getter });
    expect(validGenerationReceipt(receipt)).toBe(false); expect(getter).not.toHaveBeenCalled();
  });
});

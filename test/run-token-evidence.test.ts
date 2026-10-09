import { describe, expect, it } from 'vitest';
import { addUsage, newUsage, overBudget } from '../src/core/run/budget.js';
import { completeReportedTokens, mergeTokenEvidence, neutralTokenEvidence, reportedTokenPair, requestTokenEvidence, tokenEvidenceFromSteps, tokenEvidenceLabel, validateTokenEvidence } from '../src/core/run/token-evidence.js';
import type { RunStep, RunUsage } from '../src/core/types.js';

const observed = (basis: 'reported' | 'estimated' | 'reserved' | 'unknown' | 'no-contact', input: number, output: number): RunUsage =>
  ({ tokensIn: input, tokensOut: output, steps: 1, estCostUsd: 0, tokenEvidence: requestTokenEvidence(basis, input, output) });

describe('run token evidence preserves conservative accounting', () => {
  it('distinguishes actual reported zero, no-contact and an empty/legacy zero', () => {
    expect(completeReportedTokens(observed('reported', 0, 0))).toBe(true);
    expect(completeReportedTokens(observed('no-contact', 0, 0))).toBe(false);
    expect(completeReportedTokens({ ...newUsage(), tokenEvidence: neutralTokenEvidence() })).toBe(false);
    expect(tokenEvidenceLabel(newUsage())).toContain('unknown');
    expect(requestTokenEvidence('no-contact', 1, 0)).toBeUndefined();
    const large = observed('reported', 123456, 0);
    expect(tokenEvidenceLabel(large)).toBe('Reported 123,456');
    expect(tokenEvidenceLabel(large, value => value.toPrecision(2))).toBe('Reported 1.2e+5');
    expect(large.tokensIn).toBe(123456);
    expect(large.tokenEvidence?.input.reported).toBe(123456);
  });

  it('merges two attempts once and preserves reservations, estimates and legacy uncertainty', () => {
    const exact = observed('reported', 12, 3); const failed = observed('reserved', 100, 4096);
    const merged = addUsage(exact, failed);
    expect(merged.tokensOut).toBe(4099); expect(merged.tokenEvidence?.output.reserved).toBe(4096);
    expect(merged.tokenEvidence?.requests).toEqual({ reported: 1, estimated: 0, reserved: 1, unknown: 0, noContact: 0 });
    expect(completeReportedTokens(merged)).toBe(false); expect(tokenEvidenceLabel(merged)).toContain('Partial reported 15');
    expect(overBudget(merged, { maxTokens: 4200, maxSteps: 10, allowCloud: false })).toBe(true);
    const estimated = addUsage(merged, observed('estimated', 5, 8));
    const legacy = addUsage(estimated, newUsage());
    expect(legacy.tokenEvidence?.unclassified).toBe(true);
    expect(legacy.tokenEvidence?.requests.unknown).toBe(0); // No invented legacy request count.
    expect(mergeTokenEvidence(observed('reported', Number.MAX_SAFE_INTEGER, 0), observed('reported', 1, 0))).toBeUndefined();
  });

  it('settles the original reserved step without changing its timestamp or promoting tools', () => {
    const step: RunStep = { ts: '2026-10-09T00:00:00.000Z', taskId: 't1', kind: 'model', summary: 'reserved', usage: observed('reserved', 100, 4096) };
    const usage = { ...step.usage! };
    expect(tokenEvidenceFromSteps(usage, [step])?.output.reserved).toBe(4096);
    step.usage = observed('reported', 12, 3);
    usage.tokensIn = 12; usage.tokensOut = 3;
    const evidence = tokenEvidenceFromSteps(usage, [step, { ...step, kind: 'tool' }]);
    expect(completeReportedTokens({ ...usage, tokenEvidence: evidence })).toBe(true);
    expect(step.ts).toBe('2026-10-09T00:00:00.000Z');
  });

  it('rejects malformed/foreign evidence and counter accessors without invoking them', () => {
    const valid = observed('reported', 4, 2); let getters = 0;
    const getter = { get tokensIn() { getters++; return 4; }, tokensOut: 2 };
    expect(reportedTokenPair(getter)).toBeUndefined();
    expect(reportedTokenPair(Object.create({ tokensIn: 4, tokensOut: 2 }))).toBeUndefined();
    const explicitGetter = { ...valid.tokenEvidence, get input() { getters++; return valid.tokenEvidence!.input; } };
    expect(validateTokenEvidence(explicitGetter, 4, 2)).toBeUndefined(); expect(getters).toBe(0);
    expect(validateTokenEvidence({ ...valid.tokenEvidence, schemaVersion: 2 }, 4, 2)).toBeUndefined();
    expect(validateTokenEvidence({ ...valid.tokenEvidence, secret: 'private' }, 4, 2)).toBeUndefined();
    expect(validateTokenEvidence(valid.tokenEvidence, 5, 2)).toBeUndefined();
    expect(requestTokenEvidence('reported', 0.5, 2)).toBeUndefined();
    expect(requestTokenEvidence('reported', Number.POSITIVE_INFINITY, 2)).toBeUndefined();
    expect(requestTokenEvidence('reported', Number.MAX_SAFE_INTEGER, 1)).toBeUndefined();
    const cold = JSON.parse(JSON.stringify(valid.tokenEvidence));
    expect(validateTokenEvidence(cold, 4, 2)).toEqual(valid.tokenEvidence);
    expect(JSON.stringify(cold)).not.toMatch(/prompt|endpoint|path|credential/);
  });
});

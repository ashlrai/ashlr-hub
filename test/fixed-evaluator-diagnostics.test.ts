/** Pure diagnostic encoding; does not launch evaluators or establish custody. */
import { describe, expect, it, vi } from 'vitest';
import { summarizeFixedEvaluatorCustody, validateFixedEvaluatorCustodyDiagnostics } from '../src/core/universe/fixed-evaluator-diagnostics.js';
import type { VerifySubprocessResult } from '../src/core/run/verify-commands.js';

describe('fixed evaluator diagnostic envelope', () => {
  it('represents unobserved transport as unknown rather than clean execution', () => {
    expect(summarizeFixedEvaluatorCustody(undefined, 'unobserved')).toEqual({ schemaVersion: 1, boundary: 'unobserved',
      exitCode: null, signalled: null, timedOut: null, cancelled: null, outputTruncated: null });
  });
  it('returns only fixed metadata, excluding raw output, errors and signal names', () => {
    const result = { exitCode: 1, signal: 'SIGTERM', stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_ERROR', error: 'PRIVATE_PATH',
      timedOut: false, cancelled: true } as VerifySubprocessResult;
    const summary = summarizeFixedEvaluatorCustody(result, 'outer-process-group');
    expect(summary).toMatchObject({ exitCode: 1, signalled: true, timedOut: false, cancelled: true, outputTruncated: null });
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|SIGTERM/);
    expect(validateFixedEvaluatorCustodyDiagnostics(summary)).toEqual(summary);
  });
  it('detaches validated envelopes and rejects extra fields, getters and proxies', () => {
    const input = summarizeFixedEvaluatorCustody(undefined, 'unobserved');
    expect(validateFixedEvaluatorCustodyDiagnostics(input)).not.toBe(input);
    const getter = vi.fn(() => 'completed');
    for (const value of [{ ...input, raw: 'PRIVATE' }, new Proxy(input, {}),
      Object.defineProperty({ ...input }, 'boundary', { enumerable: true, get: getter })]) {
      expect(() => validateFixedEvaluatorCustodyDiagnostics(value)).toThrow(/unavailable/);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([{ schemaVersion: 2 }, { boundary: 'PRIVATE' }, { exitCode: -2 }, { exitCode: 256 }, { exitCode: 1.5 },
    { signalled: 'no' }, { timedOut: 0 }, { cancelled: undefined }, { outputTruncated: [] }])('rejects invalid fields %j', patch => {
    expect(() => validateFixedEvaluatorCustodyDiagnostics({ ...summarizeFixedEvaluatorCustody(undefined, 'unobserved'), ...patch })).toThrow();
  });
});

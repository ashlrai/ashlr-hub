import { describe, expect, it } from 'vitest';
import { RESOURCE_NATIVE_PROCESS_SIGNALS, validResourceNativeProcessDiagnostic, validResourceNativeProcessForReceipt,
  type ResourceNativeProcessDiagnostic } from '../src/core/resources/native-diagnostics.js';

function diagnostic(patch: Partial<ResourceNativeProcessDiagnostic> = {}): ResourceNativeProcessDiagnostic {
  return { schemaVersion: 1, scope: 'native-process', exitCode: 0, signal: null, stderrPresent: false,
    outputTruncated: false, ...patch };
}

describe('bounded native process diagnostic contract', () => {
  it.each([0, 1, 124, 255, null])('retains a bounded observed exit value %s without interpreting its cause', (exitCode) => {
    expect(validResourceNativeProcessDiagnostic(diagnostic({ exitCode }))).toBe(true);
  });
  it.each(RESOURCE_NATIVE_PROCESS_SIGNALS)('accepts the fixed signal %s with an unknown exit', (signal) => {
    expect(validResourceNativeProcessDiagnostic(diagnostic({ signal, exitCode: null }))).toBe(true);
  });
  it.each([undefined, null, [], 'private text', {},
    diagnostic({ exitCode: -1 }), diagnostic({ exitCode: 256 }), diagnostic({ exitCode: NaN }),
    diagnostic({ exitCode: Infinity }), diagnostic({ exitCode: 1.5 }),
    { ...diagnostic(), signal: 'PRIVATE_SIGNAL_TEXT' }, { ...diagnostic(), signal: 'SIGRTMIN+99' },
    { ...diagnostic(), exitCode: '1' }, { ...diagnostic(), stderrPresent: 1 },
    { ...diagnostic(), outputTruncated: null }, { ...diagnostic(), schemaVersion: 2 },
    { ...diagnostic(), scope: 'provider-error' }, { ...diagnostic(), stderr: 'PRIVATE' },
    { ...diagnostic(), signal: 'SIGKILL' }])('rejects unbounded or contradictory metadata %#', (value) => {
    expect(validResourceNativeProcessDiagnostic(value)).toBe(false);
  });
  it('rejects accessors, symbols and custom prototypes without evaluating getters', () => {
    let invoked = false; const getter = diagnostic();
    Object.defineProperty(getter, 'signal', { get() { invoked = true; return null; } });
    expect(validResourceNativeProcessDiagnostic(getter)).toBe(false); expect(invoked).toBe(false);
    expect(validResourceNativeProcessDiagnostic({ ...diagnostic(), [Symbol('private')]: 'value' })).toBe(false);
    expect(validResourceNativeProcessDiagnostic(Object.assign(Object.create({ private: 'value' }), diagnostic()))).toBe(false);
    expect(validResourceNativeProcessDiagnostic(Object.assign(Object.create(null), diagnostic()))).toBe(true);
  });
  it.each(['codex', 'claude'])('accepts consistent %s receipt evidence and rejects status contradictions', (provider) => {
    expect(validResourceNativeProcessForReceipt(diagnostic(), 'completed', provider)).toBe(true);
    expect(validResourceNativeProcessForReceipt(diagnostic({ stderrPresent: true }), 'completed', provider)).toBe(true);
    for (const value of [diagnostic({ exitCode: 1 }), diagnostic({ exitCode: null }),
      diagnostic({ exitCode: null, signal: 'SIGTERM' }), diagnostic({ outputTruncated: true })]) {
      expect(validResourceNativeProcessForReceipt(value, 'completed', provider)).toBe(false);
    }
    for (const status of ['cancelled', 'timed-out', 'uncertain']) {
      expect(validResourceNativeProcessForReceipt(diagnostic({ exitCode: null, signal: 'SIGKILL' }), status, provider)).toBe(true);
      expect(validResourceNativeProcessForReceipt(diagnostic({ exitCode: 124 }), status, provider)).toBe(false);
    }
    expect(validResourceNativeProcessForReceipt(diagnostic(), 'failed', provider)).toBe(true);
    expect(validResourceNativeProcessForReceipt(diagnostic({ exitCode: 1 }), 'failed', provider)).toBe(true);
    expect(validResourceNativeProcessForReceipt(diagnostic(), 'reserved', provider)).toBe(false);
    expect(validResourceNativeProcessForReceipt(diagnostic(), 'unrecognized', provider)).toBe(false);
  });
  it.each(['local', 'unknown'])('rejects diagnostic claims for non-native provider %s', (provider) => {
    expect(validResourceNativeProcessForReceipt(diagnostic(), 'completed', provider)).toBe(false);
  });
});

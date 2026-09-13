/** Dependency-free, browser-safe native cleanup evidence. No logs or identities. */
export interface CodexProbeCleanupDiagnostics {
  readonly failure: 'runner-rejected' | 'probe-rejected' | 'lifecycle-publication-failed' | 'group-exit-unconfirmed' |
    'native-timed-out' | 'native-cancelled' | 'process-failed' | 'diagnostics-unavailable';
  readonly processGroupSettlement: 'not-started' | 'group-exit-confirmed' | 'unconfirmed' | 'unknown';
  readonly timedOut: boolean | 'unknown';
  readonly cancelled: boolean | 'unknown';
}

/** Project only own data properties; injected diagnostics cannot execute getters or carry private text. */
export function sanitizeCodexProbeCleanupDiagnostics(value: unknown): CodexProbeCleanupDiagnostics | undefined {
  try {
    if (value === null || typeof value !== 'object') return undefined;
    const read = (key: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property && 'value' in property ? property.value : undefined;
    };
    const failure = read('failure'); const processGroupSettlement = read('processGroupSettlement');
    const timedOut = read('timedOut'); const cancelled = read('cancelled');
    if (!['runner-rejected', 'probe-rejected', 'lifecycle-publication-failed', 'group-exit-unconfirmed',
      'native-timed-out', 'native-cancelled', 'process-failed', 'diagnostics-unavailable'].includes(failure as string) ||
      !['not-started', 'group-exit-confirmed', 'unconfirmed', 'unknown'].includes(processGroupSettlement as string) ||
      !(typeof timedOut === 'boolean' || timedOut === 'unknown') ||
      !(typeof cancelled === 'boolean' || cancelled === 'unknown')) return undefined;
    return Object.freeze({ failure, processGroupSettlement, timedOut, cancelled }) as CodexProbeCleanupDiagnostics;
  } catch { return undefined; }
}

/** Browser-safe process facts only; never provider text, fault guesses, or retry authority. */
export const RESOURCE_NATIVE_PROCESS_SIGNALS = Object.freeze(['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP',
  'SIGILL', 'SIGINT', 'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR',
  'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP',
  'SIGTTIN', 'SIGTTOU', 'SIGUNUSED', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH',
  'SIGXCPU', 'SIGXFSZ', 'SIGBREAK', 'SIGINFO', 'SIGLOST'] as const);
export type ResourceNativeProcessSignal = typeof RESOURCE_NATIVE_PROCESS_SIGNALS[number];
export interface ResourceNativeProcessDiagnostic {
  schemaVersion: 1;
  scope: 'native-process';
  /** Observed POSIX exit status only. Runner sentinel/timeout codes are never reported as exits. */
  exitCode: number | null;
  signal: ResourceNativeProcessSignal | null;
  /** Captured stderr was nonempty; capture may include runner-generated termination notices. */
  stderrPresent: boolean;
  /** Either bounded stdout or stderr capture was truncated. No captured text is included. */
  outputTruncated: boolean;
}

export function validResourceNativeProcessSignal(value: unknown): value is ResourceNativeProcessSignal {
  return RESOURCE_NATIVE_PROCESS_SIGNALS.some((signal) => signal === value);
}

export function validResourceNativeProcessDiagnostic(value: unknown): value is ResourceNativeProcessDiagnostic {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = ['schemaVersion', 'scope', 'exitCode', 'signal', 'stderrPresent', 'outputTruncated'];
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key) ||
    !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 1 && row.scope === 'native-process' &&
    (row.exitCode === null || Number.isSafeInteger(row.exitCode) && Number(row.exitCode) >= 0 && Number(row.exitCode) <= 255) &&
    (row.signal === null || validResourceNativeProcessSignal(row.signal)) &&
    (row.exitCode === null || row.signal === null) &&
    typeof row.stderrPresent === 'boolean' && typeof row.outputTruncated === 'boolean';
}

/** The optional extension is absent on legacy/local/reserved rows, not backfilled with zeros. */
export function validResourceNativeProcessForReceipt(value: unknown, status: string, provider: string): value is ResourceNativeProcessDiagnostic {
  if (!validResourceNativeProcessDiagnostic(value) || !['codex', 'claude'].includes(provider)) return false;
  if (status === 'completed') return value.exitCode === 0 && value.signal === null && !value.outputTruncated;
  if (['timed-out', 'cancelled', 'uncertain'].includes(status)) return value.exitCode === null;
  return status === 'failed';
}

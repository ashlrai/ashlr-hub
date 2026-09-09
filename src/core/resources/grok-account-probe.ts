/** Explicit native metadata sampling. No login, session, prompt, or credential export. */
import { lstatSync, mkdtempSync, realpathSync, rmdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isVerifyProcessGroupLifecycle, runVerifySubprocessAsync, type VerifyProcessGroupLifecycle } from '../run/verify-commands.js';
import { workerEnvironment } from './worker.js';

export interface GrokAccountProbeOptions {
  /** Explicit native profile launcher; account/environment isolation belongs to that launcher. */
  command: string[];
  /** Validated caller scope. The native process runs in a new private temporary cwd. */
  cwd: string;
  timeoutMs?: number;
  expectedAccountHint?: string;
  signal?: AbortSignal;
  /** In-process ownership evidence only; never forwarded to the native protocol. */
  processGroupLifecycle?: VerifyProcessGroupLifecycle;
}
export interface GrokAccountProbeWindow { id: string; usedPercent: number | null; resetsAt: string | null }
export interface GrokAccountProbeReport {
  schemaVersion: 1;
  scope: 'grok-native-metadata';
  status: 'observed' | 'failed' | 'cancelled' | 'timed-out' | 'uncertain';
  reason: string;
  startedAt: string;
  finishedAt: string;
  /** Private comparison hint only, not a provider-issued stable account identifier. */
  accountHint: string | null;
  planType: string | null;
  /** True only after successful live billing and unchanged before/after identity. */
  loggedIn: boolean | null;
  windows: GrokAccountProbeWindow[];
  onDemandEnabled: boolean | null;
  observedAt: string | null;
  expiresAt: string | null;
}
export interface GrokProbeProcessInput {
  schemaVersion: 1;
  command: string[];
  expectedAccountHint: string | null;
  startedAt: string;
}
export type GrokProbeProcessOutput = Pick<GrokAccountProbeReport,
  'status' | 'reason' | 'accountHint' | 'planType' | 'loggedIn' | 'windows' | 'onDemandEnabled' | 'observedAt' | 'expiresAt'>;

const HASH = /^[a-f0-9]{64}$/;
const PLANS = new Set(['Free', 'SuperGrok', 'SuperGrok Heavy', 'SuperGrok Pro', 'SuperGrok Plus', 'SuperGrok Lite',
  'SuperGrokPro', 'SuperGrokPlus', 'SuperGrokLite', 'GrokPro', 'XPremiumPlus', 'XPremium', 'XBasic']);
const REASONS = new Set(['probe-observed', 'probe-native-unavailable', 'probe-protocol-invalid', 'probe-output-limit',
  'probe-provider-error', 'probe-protocol-unsupported', 'probe-server-request-refused', 'probe-account-unavailable',
  'probe-account-unsupported', 'probe-account-hint-mismatch', 'probe-account-changed', 'probe-quota-invalid',
  'probe-native-exit-failed']);
const WINDOW_ID = /^grok_(?:credits|unified|build)(?:_weekly|_monthly)?$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Reflect.ownKeys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => typeof key === 'string' &&
    [...required, ...optional].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max &&
    [...value].every((c) => c.charCodeAt(0) >= 32 && !(c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));
}
function configuration(options: GrokAccountProbeOptions) {
  if (!record(options) || !exact(options, ['command', 'cwd'], ['timeoutMs', 'expectedAccountHint', 'signal', 'processGroupLifecycle'])) throw new Error();
  const lifecycle = options.processGroupLifecycle;
  if (lifecycle !== undefined && !isVerifyProcessGroupLifecycle(lifecycle)) throw new Error();
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!text(options.cwd, 4096) || !isAbsolute(options.cwd) || resolve(options.cwd) === parse(options.cwd).root ||
    !lstatSync(options.cwd).isDirectory() || lstatSync(options.cwd).isSymbolicLink() || realpathSync(options.cwd) !== resolve(options.cwd) ||
    !Array.isArray(options.command) || options.command.length < 1 || options.command.length > 32 ||
    Reflect.ownKeys(options.command).length !== options.command.length + 1 ||
    !Array.from({ length: options.command.length }, (_, i) => i).every((i) => Object.hasOwn(options.command, i) &&
      'value' in Object.getOwnPropertyDescriptor(options.command, i)! && text(options.command[i], 4096)) ||
    !isAbsolute(options.command[0]!) || options.command.reduce((n, v) => n + Buffer.byteLength(v), 0) > 16_384 ||
    options.expectedAccountHint !== undefined && (typeof options.expectedAccountHint !== 'string' || !HASH.test(options.expectedAccountHint)) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
    options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error();
  return { command: [...options.command], timeoutMs, expectedAccountHint: options.expectedAccountHint ?? null,
    signal: options.signal, processGroupLifecycle: lifecycle };
}
function helperArgv(): string[] {
  if (import.meta.url.endsWith('/grok-account-probe.ts')) {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./grok-account-probe-process.ts', import.meta.url).href;
    return [process.execPath, '--input-type=module', '--eval',
      `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`];
  }
  return [process.execPath, fileURLToPath(new URL('./grok-account-probe-process.js', import.meta.url))];
}
function checkedOutput(raw: string, startedAt: string, expectedAccountHint: string | null): GrokProbeProcessOutput | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!record(v) || !exact(v, ['status', 'reason', 'accountHint', 'planType', 'loggedIn', 'windows', 'onDemandEnabled', 'observedAt', 'expiresAt']) ||
      !['observed', 'failed'].includes(String(v.status)) || typeof v.reason !== 'string' || !REASONS.has(v.reason) ||
      v.accountHint !== null && (typeof v.accountHint !== 'string' || !HASH.test(v.accountHint)) ||
      v.planType !== null && (typeof v.planType !== 'string' || !PLANS.has(v.planType)) ||
      !Array.isArray(v.windows)) return null;
    if (v.status === 'failed') {
      if (v.reason === 'probe-observed' || v.accountHint !== null || v.planType !== null || v.loggedIn !== null ||
        v.windows.length !== 0 || v.onDemandEnabled !== null || v.observedAt !== null || v.expiresAt !== null) return null;
    } else {
      if (v.reason !== 'probe-observed' || !v.accountHint || v.loggedIn !== true || v.windows.length !== 1 ||
        expectedAccountHint !== null && v.accountHint !== expectedAccountHint ||
        v.onDemandEnabled !== null && typeof v.onDemandEnabled !== 'boolean' || v.observedAt !== startedAt ||
        v.expiresAt !== new Date(Date.parse(startedAt) + 60_000).toISOString()) return null;
      const w: unknown = v.windows[0];
      if (!record(w) || !exact(w, ['id', 'usedPercent', 'resetsAt']) || typeof w.id !== 'string' || !WINDOW_ID.test(w.id) ||
        w.usedPercent !== null && (typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) ||
        w.resetsAt !== null && (typeof w.resetsAt !== 'string' || !Number.isFinite(Date.parse(w.resetsAt)) ||
          new Date(w.resetsAt).toISOString() !== w.resetsAt)) return null;
    }
    return v as unknown as GrokProbeProcessOutput;
  } catch { return null; }
}

/**
 * ACP v1 + Grok extensions documented by upstream source (2026-09-08).
 * Native startup can refresh auth/settings, maintain native state, and initialize
 * ancillary services. Four fixed metadata requests do not imply zero native IO.
 * Unsupported installed protocol responses fail closed; no speculative fallback.
 */
export async function probeGrokAccount(options: GrokAccountProbeOptions): Promise<GrokAccountProbeReport> {
  let pinned: ReturnType<typeof configuration>;
  try { pinned = configuration(options); } catch { throw new Error('Invalid Grok account probe configuration'); }
  const started = performance.now(); const startedAt = new Date().toISOString();
  const report = (status: GrokAccountProbeReport['status'], reason: string, metadata?: GrokProbeProcessOutput): GrokAccountProbeReport => ({
    schemaVersion: 1, scope: 'grok-native-metadata', status, reason, startedAt, finishedAt: new Date().toISOString(),
    accountHint: metadata?.accountHint ?? null, planType: metadata?.planType ?? null, loggedIn: metadata?.loggedIn ?? null,
    windows: metadata?.windows ?? [], onDemandEnabled: metadata?.onDemandEnabled ?? null,
    observedAt: metadata?.observedAt ?? null, expiresAt: metadata?.expiresAt ?? null,
  });
  if (pinned.signal?.aborted) return report('cancelled', 'probe-cancelled');
  if (process.platform === 'win32') return report('failed', 'probe-platform-unsupported');
  let scratch: string | undefined; let cleanupConfirmed = false; let invocationAttempted = false;
  try {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), 'ashlr-grok-metadata-'));
    const remaining = pinned.timeoutMs - (performance.now() - started);
    if (remaining <= 0) { cleanupConfirmed = true; return report('timed-out', 'probe-timed-out'); }
    const input: GrokProbeProcessInput = { schemaVersion: 1, command: pinned.command, expectedAccountHint: pinned.expectedAccountHint, startedAt };
    const argv = helperArgv();
    const executionOptions = { cwd: scratch, env: workerEnvironment(), input: JSON.stringify(input),
      timeoutMs: Math.max(1, Math.floor(remaining)), maxOutputChars: 32 * 1024, signal: pinned.signal,
      requireProcessGroupExit: true, processGroupLifecycle: pinned.processGroupLifecycle };
    // A rejected runner call provides no teardown witness, even if it threw synchronously.
    invocationAttempted = true;
    const executed = await runVerifySubprocessAsync(argv, executionOptions);
    // Exit status and output are not evidence that native descendants have stopped.
    if (executed.processGroupSettlement !== 'not-started' && executed.processGroupSettlement !== 'group-exit-confirmed') {
      return report('uncertain', 'probe-termination-uncertain');
    }
    cleanupConfirmed = true;
    if (executed.cancelled || pinned.signal?.aborted) return report('cancelled', 'probe-cancelled');
    if (executed.timedOut || performance.now() - started >= pinned.timeoutMs) return report('timed-out', 'probe-timed-out');
    if (executed.outputTruncated || executed.error || executed.exitCode !== 0 || executed.signal) return report('failed', 'probe-process-failed');
    const metadata = checkedOutput(executed.stdout, startedAt, pinned.expectedAccountHint);
    return metadata ? report(metadata.status, metadata.reason, metadata) : report('failed', 'probe-process-output-invalid');
  } catch { return invocationAttempted && !cleanupConfirmed
    ? report('uncertain', 'probe-termination-uncertain') : report('failed', 'probe-process-failed'); }
  finally {
    // Exact owned empty directory only; preserve native-created data or uncertain teardown.
    if (scratch && cleanupConfirmed) { try { rmdirSync(scratch); } catch { /* Private retained scratch. */ } }
  }
}

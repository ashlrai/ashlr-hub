/** Native login metadata only; never quota, subscription entitlement or billing attestation. */
import { mkdtempSync, realpathSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { isVerifyProcessGroupLifecycle, runVerifySubprocessAsync, type VerifyProcessGroupLifecycle } from '../run/verify-commands.js';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { workerEnvironment } from './worker.js';

export interface ClaudeAccountStatusOptions {
  /** Explicit trusted native executable/wrapper prefix; never model-generated input. */
  command: string[];
  /** Validated caller scope only; native status runs in a fresh private temporary cwd. */
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** In-process ownership evidence, preserved across each usage subcommand. */
  processGroupLifecycle?: VerifyProcessGroupLifecycle;
}
export interface ClaudeAccountStatusResult {
  schemaVersion: 1;
  scope: 'claude-native-auth-status';
  status: 'observed' | 'failed' | 'cancelled' | 'timed-out' | 'uncertain';
  reason: string;
  loggedIn: boolean | null;
  authMethod: 'claude.ai' | 'api-key' | 'none' | 'unknown';
  /** Recognized native plan label only; unknown values and all identity fields are discarded. */
  subscriptionType: string | null;
  /** Private comparison hint only; never publish the native identity or this hash. */
  accountHint: string | null;
  startedAt: string;
  finishedAt: string;
}

const MAX_OUTPUT = 32 * 1024;
const PLAN_TYPES = new Set(['free', 'pro', 'max', 'team', 'enterprise']);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096 &&
    [...value].every((character) => { const code = character.charCodeAt(0); return code >= 32 && (code < 127 || code > 159); });
}
export function validateClaudeAccountStatusOptions(options: ClaudeAccountStatusOptions) {
  const invalid = (): never => { throw new Error('Invalid Claude account status configuration'); };
  if (!record(options)) return invalid();
  const keys = Reflect.ownKeys(options);
  if (!['command', 'cwd'].every((key) => keys.includes(key)) ||
    !keys.every((key) => typeof key === 'string' && ['command', 'cwd', 'timeoutMs', 'signal', 'processGroupLifecycle'].includes(key) &&
      'value' in Object.getOwnPropertyDescriptor(options, key)!)) return invalid();
  const lifecycle = options.processGroupLifecycle;
  if (lifecycle !== undefined && !isVerifyProcessGroupLifecycle(lifecycle)) return invalid();
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Array.isArray(options.command) || options.command.length < 1 || options.command.length > 32 ||
    Reflect.ownKeys(options.command).length !== options.command.length + 1 ||
    !Array.from({ length: options.command.length }, (_, i) => i).every((i) => Object.hasOwn(options.command, i) &&
      'value' in Object.getOwnPropertyDescriptor(options.command, i)! && text(options.command[i])) ||
    !isAbsolute(options.command[0]!) || options.command.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 16 * 1024 ||
    !text(options.cwd) || !isAbsolute(options.cwd) || resolve(options.cwd) !== options.cwd || parse(options.cwd).root === options.cwd ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))) return invalid();
  inspectPrivateDirectory(options.cwd);
  return { command: [...options.command], cwd: options.cwd, timeoutMs, signal: options.signal, processGroupLifecycle: lifecycle };
}

/**
 * Exactly one `auth status --json` call, no login, refresh command or model request.
 * Native startup may maintain its own configuration/authentication. The trusted
 * launcher selects its isolated profile; Hub never reads credential files here.
 * An observed login does not establish current provider connectivity or allowance.
 */
export async function probeClaudeAccountStatus(options: ClaudeAccountStatusOptions): Promise<ClaudeAccountStatusResult> {
  let pinned: ReturnType<typeof validateClaudeAccountStatusOptions>;
  try { pinned = validateClaudeAccountStatusOptions(options); } catch { throw new Error('Invalid Claude account status configuration'); }
  const started = performance.now(); const startedAt = new Date().toISOString();
  const result = (status: ClaudeAccountStatusResult['status'], reason: string,
    metadata?: Pick<ClaudeAccountStatusResult, 'loggedIn' | 'authMethod' | 'subscriptionType' | 'accountHint'>): ClaudeAccountStatusResult => ({
    schemaVersion: 1, scope: 'claude-native-auth-status', status, reason,
    loggedIn: metadata?.loggedIn ?? null, authMethod: metadata?.authMethod ?? 'unknown',
    subscriptionType: metadata?.subscriptionType ?? null, accountHint: metadata?.accountHint ?? null,
    startedAt, finishedAt: new Date().toISOString(),
  });
  if (pinned.signal?.aborted) return result('cancelled', 'status-cancelled');
  if (process.platform === 'win32') return result('failed', 'status-platform-unsupported');
  let scratch: string | undefined; let cleanupConfirmed = false; let invocationAttempted = false;
  try {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), 'ashlr-claude-status-'));
    const remaining = Math.floor(pinned.timeoutMs - (performance.now() - started));
    if (remaining < 1) { cleanupConfirmed = true; return result('timed-out', 'status-timed-out'); }
    const argv = [...pinned.command, 'auth', 'status', '--json'];
    const executionOptions = {
      cwd: scratch, env: workerEnvironment(), timeoutMs: remaining, maxOutputChars: MAX_OUTPUT, signal: pinned.signal,
      requireProcessGroupExit: true, processGroupLifecycle: pinned.processGroupLifecycle,
    };
    // A rejected runner call provides no teardown witness, even if it threw synchronously.
    invocationAttempted = true;
    const executed = await runVerifySubprocessAsync(argv, executionOptions);
    // Exit status and output are not evidence that native descendants have stopped.
    if (executed.processGroupSettlement !== 'not-started' && executed.processGroupSettlement !== 'group-exit-confirmed') {
      return result('uncertain', 'status-termination-uncertain');
    }
    cleanupConfirmed = true;
    if (executed.cancelled || pinned.signal?.aborted) return result('cancelled', 'status-cancelled');
    if (executed.timedOut || performance.now() - started >= pinned.timeoutMs) return result('timed-out', 'status-timed-out');
    if (executed.outputTruncated || Buffer.byteLength(executed.stdout) > MAX_OUTPUT || Buffer.byteLength(executed.stderr) > MAX_OUTPUT) {
      return result('failed', 'status-output-limit');
    }
    if (executed.error || executed.signal || ![0, 1].includes(executed.exitCode!)) return result('failed', 'status-process-failed');
    let value: unknown;
    try { value = JSON.parse(executed.stdout); } catch { return result('failed', 'status-output-invalid'); }
    if (!record(value) || typeof value.loggedIn !== 'boolean' ||
      executed.exitCode !== (value.loggedIn ? 0 : 1)) return result('failed', 'status-output-invalid');
    // Native Claude 2.1.257 authStatus emits these exact strings. Other native
    // methods (oauth_token/api_key_helper/third_party) are deliberately unsupported.
    const method = value.authMethod === 'claude.ai' ? 'claude.ai'
      : value.authMethod === 'api_key' ? 'api-key' : value.authMethod === 'none' ? 'none' : 'unknown';
    if (method === 'unknown') return result('failed', 'status-auth-method-unsupported');
    if ((method === 'none') === value.loggedIn) return result('failed', 'status-output-invalid');
    const subscriptionType = method === 'claude.ai' && typeof value.subscriptionType === 'string' &&
      PLAN_TYPES.has(value.subscriptionType) ? value.subscriptionType : null;
    return result('observed', value.loggedIn ? 'status-login-observed' : 'status-not-logged-in', {
      loggedIn: value.loggedIn, authMethod: method, subscriptionType,
      accountHint: method === 'claude.ai' && text(value.email) && text(value.orgId)
        ? createHash('sha256').update(JSON.stringify(['claude-native-auth-v1', value.email, value.orgId])).digest('hex') : null,
    });
  } catch { return invocationAttempted && !cleanupConfirmed
    ? result('uncertain', 'status-termination-uncertain') : result('failed', 'status-process-failed'); }
  finally {
    // No recursive deletion: native-created data and uncertain-process cwd stay private.
    if (scratch && cleanupConfirmed) { try { rmdirSync(scratch); } catch { /* Exact owned directory only. */ } }
  }
}

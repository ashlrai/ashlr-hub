/** Native local-command report, deliberately not an admission observation. */
import { mkdtempSync, realpathSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runVerifySubprocessAsync } from '../run/verify-commands.js';
import { probeClaudeAccountStatus, validateClaudeAccountStatusOptions,
  type ClaudeAccountStatusOptions, type ClaudeAccountStatusResult } from './claude-account-status.js';
import type { ResourceConnectionQuotaWindow } from './connection-types.js';
import { workerEnvironment } from './worker.js';

export interface ClaudeAccountUsageResult extends ClaudeAccountStatusResult {
  windows: ResourceConnectionQuotaWindow[];
}
const MAX_OUTPUT = 32 * 1024;
const INTRO = 'You are currently using your subscription to power your Claude Code usage';
const TITLES: Record<string, string> = {
  'Current session': 'five_hour', 'Current week (all models)': 'seven_day',
  'Current week (Sonnet only)': 'seven_day_sonnet', 'Current week (Sonnet)': 'seven_day_sonnet',
  'Current week (Opus only)': 'seven_day_opus', 'Current week (Opus)': 'seven_day_opus',
  'Current week (Fable)': 'seven_day_fable',
};
// Preserve the native display string, not an invented timestamp/year/timezone conversion.
const RESET = /^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]) at )?(?:[1-9]|1[0-2])(?::[0-5]\d)?(?:am|pm) \([A-Za-z_+-]+(?:\/[A-Za-z_+-]+){0,2}\)$/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Accept only the tested local-command result; never parse assistant/model text as quota. */
export function parseClaudeNativeUsage(raw: string): ResourceConnectionQuotaWindow[] | null {
  if (Buffer.byteLength(raw) > MAX_OUTPUT) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value) || value.type !== 'result' || value.subtype !== 'success' || value.is_error !== false ||
    value.total_cost_usd !== 0 || value.duration_api_ms !== 0 || !record(value.usage) ||
    !['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every((key) => value.usage &&
      (value.usage as Record<string, unknown>)[key] === 0) || !record(value.modelUsage) || Object.keys(value.modelUsage).length !== 0 ||
    typeof value.result !== 'string' || !value.result.startsWith(`${INTRO}\n`)) return null;
  const windows: ResourceConnectionQuotaWindow[] = [];
  const ids = new Set<string>();
  for (const line of value.result.split('\n').slice(1)) {
    if (!line.startsWith('Current ')) continue; // Never publish activity/behavior diagnostics.
    const match = /^(Current [^:]+): (\d{1,3})% used(?: · resets (.+))?$/.exec(line);
    if (!match || !Object.hasOwn(TITLES, match[1]!) || Number(match[2]) > 100 ||
      match[3] !== undefined && (match[3].length > 128 || !RESET.test(match[3]))) return null;
    const id = TITLES[match[1]!]!;
    if (ids.has(id)) return null;
    ids.add(id);
    windows.push({ id, usedPercent: Number(match[2]), resetsAt: null,
      nativeReport: { source: 'claude-usage', resetDescription: match[3] ?? null } });
  }
  // Do not turn a partial/native-changed response into a complete allowance claim.
  return ids.has('five_hour') && ids.has('seven_day') ? windows : null;
}

/**
 * Exact-version local /usage, with customization/tools disabled and no conversation
 * persistence. Auth before/after binds the report to the same native profile.
 * Claude 2.1.257 may silently seed /usage from cached headers; observedAt is the
 * collection time, NOT quota freshness. These windows must never feed admission.
 */
export async function probeClaudeAccountUsage(options: ClaudeAccountStatusOptions): Promise<ClaudeAccountUsageResult> {
  const pinned = validateClaudeAccountStatusOptions(options);
  const started = performance.now();
  const remaining = () => Math.max(0, Math.floor(pinned.timeoutMs - (performance.now() - started)));
  const before = await probeClaudeAccountStatus(pinned);
  const report = (reason: string, windows: ResourceConnectionQuotaWindow[] = []): ClaudeAccountUsageResult =>
    ({ ...before, reason, windows, finishedAt: new Date().toISOString() });
  const failed = (status: ClaudeAccountStatusResult['status'], reason: string): ClaudeAccountUsageResult =>
    ({ ...report(reason), status, loggedIn: null, authMethod: 'unknown', subscriptionType: null, accountHint: null });
  if (before.status !== 'observed' || !before.loggedIn || before.authMethod !== 'claude.ai') return report(before.reason);
  if (!before.accountHint) return report('usage-identity-unavailable');
  let scratch: string | undefined; let cleanupConfirmed = true;
  try {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), 'ashlr-claude-usage-'));
    const run = async (args: string[]) => {
      if (pinned.signal?.aborted) throw failed('cancelled', 'status-cancelled');
      const timeoutMs = remaining();
      if (!timeoutMs) throw failed('timed-out', 'status-timed-out');
      cleanupConfirmed = false;
      const value = await runVerifySubprocessAsync([...pinned.command, ...args], {
        cwd: scratch!, env: workerEnvironment(), timeoutMs, maxOutputChars: MAX_OUTPUT, signal: pinned.signal,
        requireProcessGroupExit: true, processGroupLifecycle: pinned.processGroupLifecycle,
      });
      // Every subcommand must settle before the next native command is admitted.
      if (value.processGroupSettlement !== 'not-started' && value.processGroupSettlement !== 'group-exit-confirmed') {
        throw failed('uncertain', 'status-termination-uncertain');
      }
      cleanupConfirmed = true;
      if (value.cancelled || pinned.signal?.aborted) throw failed('cancelled', 'status-cancelled');
      if (value.timedOut || !remaining()) throw failed('timed-out', 'status-timed-out');
      if (value.outputTruncated || Buffer.byteLength(value.stdout) > MAX_OUTPUT || Buffer.byteLength(value.stderr) > MAX_OUTPUT) {
        throw report('usage-output-invalid');
      }
      if (value.error || value.signal || value.exitCode !== 0) throw report('usage-process-failed');
      return value.stdout;
    };
    // Unknown versions never receive a slash command: its fallback could be inference.
    if ((await run(['--version'])).trim() !== '2.1.257 (Claude Code)') return report('usage-version-unsupported');
    const raw = await run(['--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config',
      '{"mcpServers":{}}', '--no-chrome', '--no-session-persistence', '--output-format', 'json', '-p', '/usage']);
    const windows = parseClaudeNativeUsage(raw);
    if (!windows) return report('usage-output-invalid');
    if (!remaining()) return failed('timed-out', 'status-timed-out');
    const after = await probeClaudeAccountStatus({ ...pinned, timeoutMs: remaining() });
    if (after.status !== 'observed') return { ...after, windows: [], startedAt: before.startedAt };
    if (!after.loggedIn || after.authMethod !== before.authMethod || after.subscriptionType !== before.subscriptionType ||
      after.accountHint !== before.accountHint) return failed('failed', 'usage-account-changed');
    if (pinned.signal?.aborted) return failed('cancelled', 'status-cancelled');
    if (!remaining()) return failed('timed-out', 'status-timed-out');
    return report('usage-native-reported', windows);
  } catch (error) {
    if (record(error) && error.scope === 'claude-native-auth-status' && Array.isArray(error.windows)) return error as unknown as ClaudeAccountUsageResult;
    return failed(cleanupConfirmed ? 'failed' : 'uncertain', cleanupConfirmed ? 'usage-process-failed' : 'status-termination-uncertain');
  } finally {
    if (scratch && cleanupConfirmed) { try { rmdirSync(scratch); } catch { /* Keep native-created private files. */ } }
  }
}

/** Version-pinned native local command; legacy text alone is never fresh quota evidence. */
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
  /** Complete current structured endpoint reply, after same-account/plan checks. */
  quotaFresh?: boolean;
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

/** Calendar-valid provider ISO, including fractional seconds and explicit offset. */
function nativeResetInstant(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  if (month! < 1 || month! > 12 || day! < 1 || hour! > 23 || minute! > 59 || second! > 59 ||
    parts[7] !== undefined && (Number(parts[8]) > 23 || Number(parts[9]) > 59)) return null;
  // Date.parse normalizes some impossible calendar dates (e.g. February30).
  // Validate local components independently before applying the reported offset.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year!, month! - 1, day!);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Experimental SDK0.3.280 `SDKUsageReport` twin on Claude2.1.280's local
 * /usage assistant frame. Its limits[] are the endpoint's CURRENT reply,
 * explicitly excluding cached/header-built meters. Never infer freshness from
 * the fallback prose or status-line callbacks. No native IDs/content escape.
 */
export function parseClaudeNativeUsageStream(raw: string, observedAt: string): {
  windows: ResourceConnectionQuotaWindow[]; quotaFresh: boolean;
} | null {
  if (Buffer.byteLength(raw) > MAX_OUTPUT) return null;
  let frames: Record<string, unknown>[];
  try {
    frames = raw.trim().split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch { return null; }
  if (!frames.length || !frames.every(record)) return null;
  const results = frames.filter((frame) => frame.type === 'result');
  const result = results[0];
  if (results.length !== 1 || frames.at(-1) !== result || !result || result.num_turns !== 0 ||
    typeof result.session_id !== 'string' || !result.session_id || result.session_id.length > 256 ||
    result.subtype !== 'success' || result.is_error !== false || result.total_cost_usd !== 0 ||
    result.duration_api_ms !== 0 || !record(result.usage) ||
    !['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
      .every((key) => (result.usage as Record<string, unknown>)[key] === 0) ||
    !record(result.modelUsage) || Object.keys(result.modelUsage).length !== 0) return null;
  const seen = new Set<string>();
  for (const frame of frames) {
    if (!['system', 'assistant', 'result'].includes(String(frame.type)) ||
      frame.session_id !== result.session_id || frame.parent_tool_use_id != null) return null;
    if ((frame.type === 'assistant' || frame.type === 'result') && frame.uuid === undefined) return null;
    if (frame.uuid !== undefined) {
      if (typeof frame.uuid !== 'string' || !frame.uuid || frame.uuid.length > 256 || seen.has(frame.uuid)) return null;
      seen.add(frame.uuid);
    }
    // The only assistant frame allowed is the local command's structured twin.
    if (frame.type === 'assistant' && !Object.hasOwn(frame, 'usage_report')) return null;
  }
  const reports = frames.filter((frame) => frame.type === 'assistant' && Object.hasOwn(frame, 'usage_report'));
  // A valid zero-inference terminal text can still serve the original display
  // contract, but it MUST NOT become numeric freshness evidence.
  const legacy = () => {
    const windows = parseClaudeNativeUsage(JSON.stringify(result));
    return windows ? { windows, quotaFresh: false } : null;
  };
  if (reports.length === 0) return legacy();
  if (reports.length !== 1) return null;
  const report = reports[0]!.usage_report;
  if (!record(report) || !record(report.session) || report.session.total_cost_usd !== 0 ||
    report.session.total_api_duration_ms !== 0 || !record(report.session.model_usage) ||
    Object.keys(report.session.model_usage).length !== 0) return null;
  if (!record(report.rate_limits) || !Array.isArray(report.rate_limits.limits) || !report.rate_limits.limits.length) return legacy();
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return null;
  const windows: ResourceConnectionQuotaWindow[] = [];
  const ids = new Set<string>();
  for (const row of report.rate_limits.limits) {
    if (!record(row) || typeof row.percent !== 'number' || !Number.isFinite(row.percent) || row.percent < 0 || row.percent > 100 ||
      typeof row.is_active !== 'boolean' || typeof row.severity !== 'string' || row.severity.length > 64) return null;
    let id: string;
    if (row.kind === 'session' && row.group === 'session' && row.scope == null) id = 'five_hour';
    else if (row.kind === 'weekly_all' && row.group === 'weekly' && row.scope == null) id = 'seven_day';
    else if (row.kind === 'weekly_scoped' && row.group === 'weekly' && record(row.scope) &&
      row.scope.surface == null && record(row.scope.model) && typeof row.scope.model.display_name === 'string') {
      // Classify on kind, then bind ONLY already-supported native model scopes.
      const family = row.scope.model.display_name.toLowerCase();
      if (!['sonnet', 'opus', 'fable'].includes(family)) return null;
      id = `seven_day_${family}`;
    } else return null; // Unknown meters cannot silently disappear from a complete snapshot.
    if (ids.has(id)) return null;
    ids.add(id);
    let resetsAt: string | null = null;
    if (row.resets_at !== null) {
      resetsAt = nativeResetInstant(row.resets_at);
      if (resetsAt === null || Date.parse(resetsAt) <= observed) return null;
    }
    windows.push({ id, usedPercent: row.percent, resetsAt,
      nativeReport: { source: 'claude-usage-structured', resetDescription: null },
      ...(id === 'five_hour' && resetsAt ? { resetProvenance: {
        kind: 'rolling-release' as const, at: resetsAt, source: 'claude-native-usage-report',
        description: 'Provider-reported five-hour recovery; not fixed weekly expiry.',
      } } : {}),
    });
  }
  return ids.has('five_hour') && ids.has('seven_day') ? { windows, quotaFresh: true } : null;
}

/**
 * Exact-version local /usage, with customization/tools disabled and no conversation
 * persistence. Auth before/after binds the report to the same native profile.
 * Claude 2.1.257 may silently seed /usage from cached headers; observedAt is the
 * collection time, NOT quota freshness for that legacy text.2.1.280 may carry
 * a validated current endpoint twin, separately qualified after matching auth.
 */
/**
 * Claude Code builds whose `-p /usage` is VERIFIED to be a local command that
 * never reaches a model, and whose output `parseClaudeNativeUsage` reads.
 *
 * Any other version still fails closed: an unknown build could route the slash
 * command to inference. Add a version ONLY after repeating BOTH checks:
 *   1. the binary's command table defines `name:"usage"` as `type:"local"` with
 *      `supportsNonInteractive:!0` (grep `strings <binary>`), and
 *   2. one live `-p /usage` run reports `num_turns: 0` and `total_cost_usd: 0`
 *      and parses to windows.
 *
 * 2.1.257 — the original pin.
 * 2.1.280 — verified 2026-09-24: identical local definition in the binary; a
 *           live run returned num_turns 0, total_cost_usd 0 and three windows
 *           (five_hour, seven_day, seven_day_fable). Needed because Opus 5.5
 *           (`claude-opus-5-5`) exists only from 2.1.280, so seats re-pinned
 *           for it would otherwise lose their usage meter.
 */
export const CLAUDE_USAGE_VERIFIED_VERSIONS: readonly string[] = ['2.1.257', '2.1.280'];

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
    const reported = (await run(['--version'])).trim();
    if (!CLAUDE_USAGE_VERIFIED_VERSIONS.some((version) => reported === `${version} (Claude Code)`)) {
      return report('usage-version-unsupported');
    }
    const structured = reported === '2.1.280 (Claude Code)';
    const raw = await run(['--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config',
      '{"mcpServers":{}}', '--no-chrome', '--no-session-persistence', '--output-format', ...(structured ? ['stream-json', '--verbose'] : ['json']), '-p', '/usage']);
    const parsed = structured ? parseClaudeNativeUsageStream(raw, before.startedAt) : null;
    const windows = structured ? parsed?.windows : parseClaudeNativeUsage(raw);
    if (!windows) return report('usage-output-invalid');
    if (!remaining()) return failed('timed-out', 'status-timed-out');
    const after = await probeClaudeAccountStatus({ ...pinned, timeoutMs: remaining() });
    if (after.status !== 'observed') return { ...after, windows: [], startedAt: before.startedAt };
    if (!after.loggedIn || after.authMethod !== before.authMethod || after.subscriptionType !== before.subscriptionType ||
      after.accountHint !== before.accountHint) return failed('failed', 'usage-account-changed');
    if (pinned.signal?.aborted) return failed('cancelled', 'status-cancelled');
    if (!remaining()) return failed('timed-out', 'status-timed-out');
    if (parsed?.quotaFresh && (after.subscriptionType === 'pro' || after.subscriptionType === 'max')) {
      for (const window of windows) if (window.id === 'seven_day' && window.resetsAt) window.resetProvenance = {
        kind: 'weekly-deadline', at: window.resetsAt, source: 'claude-native-usage-report', plan: after.subscriptionType,
        description: 'Native weekly deadline on an authenticated Pro/Max plan; no period start inferred.',
      };
    }
    return { ...report(parsed?.quotaFresh ? 'usage-native-current' : 'usage-native-reported', windows),
      ...(parsed?.quotaFresh ? { quotaFresh: true } : {}) };
  } catch (error) {
    if (record(error) && error.scope === 'claude-native-auth-status' && Array.isArray(error.windows)) return error as unknown as ClaudeAccountUsageResult;
    return failed(cleanupConfirmed ? 'failed' : 'uncertain', cleanupConfirmed ? 'usage-process-failed' : 'status-termination-uncertain');
  } finally {
    if (scratch && cleanupConfirmed) { try { rmdirSync(scratch); } catch { /* Keep native-created private files. */ } }
  }
}

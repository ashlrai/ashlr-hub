/**
 * core/phantom.ts — Phantom secrets CLI integration.
 *
 * INTENTIONALLY VALUES-FREE: this module inspects only the Phantom CLI's
 * metadata (version, initialization state, secret NAMES).  It never reads,
 * captures, logs, or returns secret values under any code path.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { PhantomAgentReportRollup, PhantomCapabilitySnapshot, PhantomStatus } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PHANTOM_BIN = 'phantom';
const TIMEOUT_MS = 5_000;
const FLEET_TIMEOUT_MS = 500;
const FLEET_CACHE_TTL_MS = 30_000;
const OUTPUT_MAX_BYTES = 1_048_576;
const SECRET_NAMES_MAX = 10_000;

const UNKNOWN_PHANTOM_COMMANDS: PhantomCapabilitySnapshot['commands'] = {
  commandsKnown: false,
  setupAvailable: false,
  execAvailable: false,
  mcpAvailable: false,
  agentAvailable: false,
};

const AGENT_REPORT_COUNT_MAX = Number.MAX_SAFE_INTEGER;
const AGENT_REPORT_ARRAY_MAX = 10_000;

type CountKind = 'status' | 'risk' | 'severity' | 'safety' | 'action';

interface PhantomStatusOptions {
  cwd?: string;
  timeoutMs?: number;
  includeAgentReport?: boolean;
}

export const PHANTOM_KNOWN_FLEET_SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'ASHLR_PULSE_PAT',
  'ASHLR_PULSE_TOKEN',
  'NVIDIA_NIM_API_KEY',
] as const;

/**
 * Run a phantom sub-command synchronously.
 * Returns stdout/stderr as strings and the exit status.
 * Never throws — all errors are caught and returned in `error`.
 */
function runPhantom(
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): { stdout: string; stderr: string; status: number | null; error?: string } {
  try {
    const result = spawnSync(PHANTOM_BIN, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? TIMEOUT_MS,
      maxBuffer: OUTPUT_MAX_BYTES,
      cwd: options.cwd,
      // Do NOT inherit env vars that could trigger interactive prompts.
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    });

    if (result.error) {
      return { stdout: '', stderr: '', status: null, error: result.error.message };
    }

    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: '', status: null, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let cachedFleetStatus: { key: string; expiresAt: number; status: PhantomStatus } | null = null;

function phantomCacheKey(options: { cwd: string; includeAgentReport?: boolean }): string {
  return JSON.stringify({
    cwd: options.cwd,
    home: process.env.HOME ?? '',
    userProfile: process.env.USERPROFILE ?? '',
    path: process.env.PATH ?? '',
    includeAgentReport: options.includeAgentReport === true,
  });
}

/**
 * Returns true when the `phantom` binary is resolvable and executes without a
 * fatal error.  Uses `phantom --version` as the probe (fast, side-effect-free).
 */
export function phantomInstalled(options: { cwd?: string; timeoutMs?: number } = {}): boolean {
  const { status, error } = runPhantom(['--version'], options);
  // spawnSync returns null status when the binary could not be found/launched.
  return error === undefined && status !== null && status === 0;
}

/**
 * Returns a read-only status snapshot of the Phantom CLI.
 *
 * Guarantees:
 *  - Never throws.
 *  - Never returns secret values — only secret NAMES (keys).
 *  - Degrades gracefully when phantom is absent, uninitialized, or returns
 *    an unexpected format.
 */
export function getPhantomStatus(options: PhantomStatusOptions = {}): PhantomStatus {
  const timeoutMs = options.timeoutMs;
  let cwd: string;
  try {
    cwd = resolve(options.cwd ?? process.cwd());
  } catch {
    return {
      installed: false,
      version: null,
      initialized: false,
      secretNames: [],
      error: 'status-unavailable',
      capability: buildPhantomCapabilitySnapshot({ installed: false, initialized: false, secretNames: [] }),
    };
  }
  // ── 1. Binary presence ──────────────────────────────────────────────────
  if (!phantomInstalled({ cwd, timeoutMs })) {
    return {
      installed: false,
      version: null,
      initialized: false,
      secretNames: [],
      capability: buildPhantomCapabilitySnapshot({
        installed: false,
        initialized: false,
        secretNames: [],
      }),
    };
  }

  // ── 2. Version ──────────────────────────────────────────────────────────
  let version: string | null = null;
  {
    const { stdout, status } = runPhantom(['--version'], { cwd, timeoutMs });
    if (status === 0) {
      // Expected format: "phantom 0.6.0"
      const match = stdout.trim().match(/\d+\.\d+(?:\.\d+)?/);
      version = match ? match[0] : null;
    }
  }

  // ── 3. Project configuration (schema-versioned metadata only) ────────────
  // A valid report proves readable project configuration, not vault health,
  // listener authentication, injection capability, or authorization to act.
  // Legacy text and unsuccessful commands remain unknown, never "ready".
  let initialized = false;
  let statusError: string | undefined;
  {
    const { stdout, status, error } = runPhantom(['status', '--json'], { cwd, timeoutMs });
    if (error !== undefined || status !== 0) {
      statusError = 'status-unavailable';
    } else {
      const structured = parseMetadataStatus(stdout);
      if (structured === null) {
        statusError = 'status-contract-unsupported';
      } else if (structured.configUnavailable) {
        statusError = 'status-config-unavailable';
      } else {
        initialized = structured.initialized;
      }
    }
  }

  // ── 4. Secret NAMES (phantom list --json) ───────────────────────────────
  //
  // Only attempt when initialized; avoids spurious error output.
  // We use --json for deterministic parsing.  Expected shape (when secrets
  // exist) is an array of objects each containing at minimum a "name" or
  // "key" field.  If the shape is unrecognised we return [] rather than
  // risk accidentally surfacing values.
  let secretNames: string[] = [];
  if (initialized) {
    const { stdout, status, error } = runPhantom(['list', '--json'], { cwd, timeoutMs });
    if (error === undefined && status === 0 && stdout.trim().length > 0) {
      secretNames = parseSecretNames(stdout);
    }
  }

  const commands = detectPhantomCommandSupport({ cwd, timeoutMs });
  const agentReport = options.includeAgentReport === true && commands.agentAvailable
    ? readPhantomAgentReport({ cwd, timeoutMs })
    : undefined;

  const base = {
    installed: true,
    version,
    initialized,
    secretNames,
    commands,
  };

  const result: PhantomStatus = {
    ...base,
    capability: buildPhantomCapabilitySnapshot(base),
    ...(agentReport ? { agentReport } : {}),
  };

  if (statusError !== undefined) {
    result.error = statusError;
  }

  return result;
}

export function getCachedFleetPhantomStatus(options: {
  cwd?: string;
  ttlMs?: number;
  timeoutMs?: number;
  nowMs?: number;
  includeAgentReport?: boolean;
} = {}): PhantomStatus {
  const nowMs = options.nowMs ?? Date.now();
  let cwd: string;
  try {
    cwd = resolve(options.cwd ?? process.cwd());
  } catch {
    return getPhantomStatus(options);
  }
  const key = phantomCacheKey({ cwd, includeAgentReport: options.includeAgentReport });
  if (cachedFleetStatus && cachedFleetStatus.key === key && cachedFleetStatus.expiresAt > nowMs) {
    return cachedFleetStatus.status;
  }
  const status = getPhantomStatus({
    cwd,
    timeoutMs: options.timeoutMs ?? FLEET_TIMEOUT_MS,
    includeAgentReport: options.includeAgentReport,
  });
  cachedFleetStatus = {
    key,
    expiresAt: nowMs + (options.ttlMs ?? FLEET_CACHE_TTL_MS),
    status,
  };
  return status;
}

export function resetPhantomStatusCache(): void {
  cachedFleetStatus = null;
}

export function buildPhantomCapabilitySnapshot(
  status: Pick<PhantomStatus, 'installed' | 'initialized' | 'secretNames'> & {
    commands?: PhantomCapabilitySnapshot['commands'];
  },
): PhantomCapabilitySnapshot {
  const safeNames = [...new Set(status.secretNames.slice(0, SECRET_NAMES_MAX).filter(isSafeSecretName))].sort();
  const known = [...PHANTOM_KNOWN_FLEET_SECRET_NAMES];
  const present = known.filter((name) => safeNames.includes(name));
  const missing = known.filter((name) => !safeNames.includes(name));
  const commands = status.commands ?? UNKNOWN_PHANTOM_COMMANDS;
  return {
    valueMode: 'metadata-and-names-only',
    secretCount: safeNames.length,
    knownFleetSecrets: {
      names: known,
      present,
      missing,
      pulsePatPresent: present.includes('ASHLR_PULSE_PAT'),
      pulseTokenPresent: present.includes('ASHLR_PULSE_TOKEN'),
      pulseCredentialPresent: present.includes('ASHLR_PULSE_PAT') || present.includes('ASHLR_PULSE_TOKEN'),
    },
    modes: {
      metadataStatus: true,
      // Configuration and command presence cannot verify a credential-using
      // runtime. This observer never authenticates or activates one.
      childEnvInjectionAvailable: false,
      mcpServerAvailable: status.installed && commands.commandsKnown && commands.mcpAvailable,
      mutationRequiresHumanApproval: status.installed,
    },
    commands,
  };
}

// ---------------------------------------------------------------------------
// Private parsing — deliberately conservative
// ---------------------------------------------------------------------------

/**
 * Validate the closed, values-free schema v1 shipped by Secrets v0.7.9.
 * Unsupported or malformed reports are unknown; no legacy text inference.
 * See phantom-secrets/docs/hub-status-contract.md.
 */
function parseMetadataStatus(raw: string): { initialized: boolean; configUnavailable: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!hasExactKeys(parsed, [
    'schema_version', 'initialized', 'inspection', 'managed_dotenv', 'vault', 'proxy', 'issues',
  ])) return null;
  if (parsed['schema_version'] !== 1 || typeof parsed['initialized'] !== 'boolean' ||
      parsed['inspection'] !== 'metadata-only') return null;
  const dotenv = parsed['managed_dotenv'];
  const vault = parsed['vault'];
  const proxy = parsed['proxy'];
  if (!hasExactKeys(dotenv, ['inspected']) || dotenv['inspected'] !== false ||
      !hasExactKeys(vault, ['inspected']) || vault['inspected'] !== false ||
      !hasExactKeys(proxy, ['lifecycle_lock', 'listener_authenticated']) ||
      proxy['listener_authenticated'] !== false) return null;
  if (typeof proxy['lifecycle_lock'] !== 'string' ||
      !['not-inspected', 'missing', 'available', 'held', 'unknown'].includes(proxy['lifecycle_lock'])) {
    return null;
  }
  const issues = parsed['issues'];
  const allowedIssues = ['config-missing', 'config-unreadable', 'config-invalid', 'proxy-lock-unavailable'];
  if (!Array.isArray(issues) || issues.length > allowedIssues.length ||
      !issues.every((issue: unknown) => typeof issue === 'string' && allowedIssues.includes(issue))) return null;
  return {
    initialized: parsed['initialized'],
    configUnavailable: issues.includes('config-unreadable') || issues.includes('config-invalid'),
  };
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function detectPhantomCommandSupport(
  options: { cwd?: string; timeoutMs?: number } = {},
): PhantomCapabilitySnapshot['commands'] {
  const { stdout, stderr, status, error } = runPhantom(['--help'], options);
  if (error !== undefined || status !== 0) return UNKNOWN_PHANTOM_COMMANDS;
  return parsePhantomCommandHelp(`${stdout}\n${stderr}`);
}

function readPhantomAgentReport(options: { cwd?: string; timeoutMs?: number } = {}): PhantomAgentReportRollup {
  const { stdout, error } = runPhantom(['agent', 'report', '--json'], options);
  if (error !== undefined || stdout.trim().length === 0) {
    return failedAgentReportRollup();
  }
  return aggregatePhantomAgentReport(stdout);
}

export function aggregatePhantomAgentReport(raw: string): PhantomAgentReportRollup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failedAgentReportRollup();
  }

  const records = extractAgentReportRecords(parsed);
  let rollup = records.length > 0 ? aggregateAgentReportRecords(records) : emptyAgentReportRollup();
  let sawAggregate = records.length > 0 || hasExplicitAgentReportRecordList(parsed);

  for (const source of aggregateSources(parsed)) {
    const applied = applyAgentReportAggregateFields(rollup, source);
    rollup = applied.rollup;
    sawAggregate = sawAggregate || applied.sawAggregate;
  }

  return sawAggregate ? rollup : failedAgentReportRollup();
}

function parsePhantomCommandHelp(raw: string): PhantomCapabilitySnapshot['commands'] {
  const commandNames = new Set<string>();
  let inCommandsBlock = false;
  let sawCommandsBlock = false;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (/^commands:\s*$/i.test(trimmed)) {
      inCommandsBlock = true;
      sawCommandsBlock = true;
      continue;
    }
    if (!inCommandsBlock) continue;
    if (!trimmed) break;
    if (/^(?:usage|options|flags|global flags|examples):/i.test(trimmed)) break;

    const match = trimmed.match(/^([a-z][a-z0-9_-]*)\b/i);
    if (match?.[1]) commandNames.add(match[1].toLowerCase());
  }

  return {
    commandsKnown: sawCommandsBlock,
    setupAvailable: commandNames.has('setup'),
    execAvailable: commandNames.has('exec'),
    mcpAvailable: commandNames.has('mcp'),
    agentAvailable: commandNames.has('agent'),
  };
}

function emptyAgentReportRollup(): PhantomAgentReportRollup {
  return {
    valuesHidden: true,
    scannedRepos: 0,
    validReports: 0,
    failedReports: 0,
    statusCounts: {},
    riskCounts: {},
    severityCounts: {},
    requiresApprovalCount: 0,
  };
}

function failedAgentReportRollup(): PhantomAgentReportRollup {
  return {
    ...emptyAgentReportRollup(),
    failedReports: 1,
  };
}

function aggregateSources(parsed: unknown): Record<string, unknown>[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;
  const sources = [obj];
  for (const key of ['summary', 'aggregate', 'rollup', 'totals']) {
    const value = obj[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sources.push(value as Record<string, unknown>);
    }
  }
  return sources;
}

function hasExplicitAgentReportRecordList(parsed: unknown): boolean {
  if (Array.isArray(parsed)) return true;
  if (parsed === null || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  return ['reports', 'repos', 'results', 'items', 'entries'].some((key) => Array.isArray(obj[key]));
}

function applyAgentReportAggregateFields(
  input: PhantomAgentReportRollup,
  source: Record<string, unknown>,
): { rollup: PhantomAgentReportRollup; sawAggregate: boolean } {
  const rollup: PhantomAgentReportRollup = {
    ...input,
    statusCounts: { ...input.statusCounts },
    riskCounts: { ...input.riskCounts },
    severityCounts: { ...input.severityCounts },
    ...(input.delegationSafety
      ? {
          delegationSafety: {
            safetyCounts: { ...input.delegationSafety.safetyCounts },
            statusCounts: { ...input.delegationSafety.statusCounts },
            primaryActionCounts: { ...input.delegationSafety.primaryActionCounts },
          },
        }
      : {}),
  };
  let sawAggregate = false;

  const scannedRepos = readCountField(source, ['scannedRepos', 'scanned_repos', 'reposScanned', 'repos_scanned', 'totalRepos', 'total_repos']);
  if (scannedRepos !== undefined) {
    rollup.scannedRepos = scannedRepos;
    sawAggregate = true;
  }

  const validReports = readCountField(source, ['validReports', 'valid_reports']);
  if (validReports !== undefined) {
    rollup.validReports = validReports;
    sawAggregate = true;
  }

  const failedReports = readCountField(source, ['failedReports', 'failed_reports', 'invalidReports', 'invalid_reports']);
  if (failedReports !== undefined) {
    rollup.failedReports = failedReports;
    sawAggregate = true;
  }

  const requiresApprovalCount = readCountField(source, [
    'requiresApprovalCount',
    'requires_approval_count',
    'approvalRequiredCount',
    'approval_required_count',
  ]);
  if (requiresApprovalCount !== undefined) {
    rollup.requiresApprovalCount = requiresApprovalCount;
    sawAggregate = true;
  }

  const statusCounts = readCountObject(source, ['statusCounts', 'status_counts', 'statuses', 'byStatus', 'by_status'], 'status');
  if (statusCounts !== undefined) {
    rollup.statusCounts = statusCounts;
    sawAggregate = true;
  }

  const riskCounts = readCountObject(source, ['riskCounts', 'risk_counts', 'risks', 'riskLevels', 'risk_levels', 'byRisk', 'by_risk'], 'risk');
  if (riskCounts !== undefined) {
    rollup.riskCounts = riskCounts;
    sawAggregate = true;
  }

  const severityCounts = readCountObject(source, [
    'severityCounts',
    'severity_counts',
    'severities',
    'bySeverity',
    'by_severity',
  ], 'severity');
  if (severityCounts !== undefined) {
    rollup.severityCounts = severityCounts;
    sawAggregate = true;
  }

  const safetyCounts = readCountObject(source, [
    'safetyCounts',
    'safety_counts',
    'delegationSafetyCounts',
    'delegation_safety_counts',
    'bySafety',
    'by_safety',
  ], 'safety');
  if (safetyCounts !== undefined) {
    ensureDelegationSafety(rollup).safetyCounts = exactSafetyCounts(safetyCounts);
    sawAggregate = true;
  }

  const nestedDelegationSafety = source['delegationSafety'];
  if (
    nestedDelegationSafety !== null &&
    typeof nestedDelegationSafety === 'object' &&
    !Array.isArray(nestedDelegationSafety)
  ) {
    const nested = nestedDelegationSafety as Record<string, unknown>;
    const nestedSafetyCounts = readCountObject(nested, [
      'safetyCounts',
      'safety_counts',
      'delegationSafetyCounts',
      'delegation_safety_counts',
      'bySafety',
      'by_safety',
    ], 'safety');
    const nestedStatusCounts = readCountObject(nested, [
      'statusCounts',
      'status_counts',
      'delegationStatusCounts',
      'delegation_status_counts',
      'byStatus',
      'by_status',
    ], 'status');
    const nestedActionCounts = readCountObject(nested, [
      'primaryActionCounts',
      'primary_action_counts',
      'recommendedActionCounts',
      'recommended_action_counts',
      'byPrimaryAction',
      'by_primary_action',
    ], 'action');
    const delegation = ensureDelegationSafety(rollup);
    if (nestedSafetyCounts !== undefined) {
      delegation.safetyCounts = exactSafetyCounts(nestedSafetyCounts);
      sawAggregate = true;
    }
    if (nestedStatusCounts !== undefined) {
      delegation.statusCounts = nestedStatusCounts;
      sawAggregate = true;
    }
    if (nestedActionCounts !== undefined) {
      delegation.primaryActionCounts = nestedActionCounts;
      sawAggregate = true;
    }
  }

  const delegationStatusCounts = readCountObject(source, [
    'delegationStatusCounts',
    'delegation_status_counts',
    'delegationStatuses',
    'delegation_statuses',
    'byDelegationStatus',
    'by_delegation_status',
  ], 'status');
  if (delegationStatusCounts !== undefined) {
    ensureDelegationSafety(rollup).statusCounts = delegationStatusCounts;
    sawAggregate = true;
  }

  const primaryActionCounts = readCountObject(source, [
    'primaryActionCounts',
    'primary_action_counts',
    'recommendedActionCounts',
    'recommended_action_counts',
    'byPrimaryAction',
    'by_primary_action',
    'byRecommendedAction',
    'by_recommended_action',
  ], 'action');
  if (primaryActionCounts !== undefined) {
    ensureDelegationSafety(rollup).primaryActionCounts = primaryActionCounts;
    sawAggregate = true;
  }

  return { rollup, sawAggregate };
}

function ensureDelegationSafety(
  rollup: PhantomAgentReportRollup,
): NonNullable<PhantomAgentReportRollup['delegationSafety']> {
  if (!rollup.delegationSafety) {
    rollup.delegationSafety = {
      safetyCounts: { safe: 0, unsafe: 0, unknown: 0 },
      statusCounts: {},
      primaryActionCounts: {},
    };
  }
  return rollup.delegationSafety;
}

function exactSafetyCounts(counts: Record<string, number>): NonNullable<PhantomAgentReportRollup['delegationSafety']>['safetyCounts'] {
  return {
    safe: counts.safe ?? 0,
    unsafe: counts.unsafe ?? 0,
    unknown: counts.unknown ?? 0,
  };
}

function extractAgentReportRecords(parsed: unknown): Record<string, unknown>[] {
  const rawRecords = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? firstArrayField(parsed as Record<string, unknown>, ['reports', 'repos', 'results', 'items', 'entries'])
      : [];

  return rawRecords
    .slice(0, AGENT_REPORT_ARRAY_MAX)
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item));
}

function aggregateAgentReportRecords(records: Record<string, unknown>[]): PhantomAgentReportRollup {
  const rollup = emptyAgentReportRollup();
  rollup.scannedRepos = records.length;

  for (const record of records) {
    const status = readStringField(record, ['status', 'state', 'result', 'outcome']);
    const normalizedStatus = status ? normalizeAgentReportCountKey('status', status) : undefined;
    if (normalizedStatus) {
      addCount(rollup.statusCounts, normalizedStatus, 1);
    }

    const requiresApproval = recordRequiresApproval(record, normalizedStatus);
    if (requiresApproval) {
      rollup.requiresApprovalCount += 1;
    }

    if (recordIndicatesFailure(record, normalizedStatus)) {
      rollup.failedReports += 1;
    } else {
      rollup.validReports += 1;
    }

    const findings = firstArrayField(record, ['findings', 'issues', 'risks', 'violations']);
    if (findings.length > 0) {
      for (const finding of findings.slice(0, AGENT_REPORT_ARRAY_MAX)) {
        if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) continue;
        addRiskSeverityCounts(rollup, finding as Record<string, unknown>);
      }
    } else {
      addRiskSeverityCounts(rollup, record);
    }

    addDelegationSafetyCounts(rollup, record);
  }

  return rollup;
}

function addDelegationSafetyCounts(rollup: PhantomAgentReportRollup, record: Record<string, unknown>): void {
  const safety = readDelegationSafety(record);
  const status = readStringField(record, ['delegationStatus', 'delegation_status']);
  const action = readStringField(record, [
    'primaryAction',
    'primary_action',
    'recommendedAction',
    'recommended_action',
  ]);
  if (!safety && !status && !action) return;

  const delegation = ensureDelegationSafety(rollup);
  if (safety) delegation.safetyCounts[safety] += 1;
  if (status) addCount(delegation.statusCounts, normalizeAgentReportCountKey('status', status), 1);
  if (action) addCount(delegation.primaryActionCounts, normalizeAgentReportCountKey('action', action), 1);
}

function addRiskSeverityCounts(rollup: PhantomAgentReportRollup, source: Record<string, unknown>): void {
  const risk = readStringField(source, ['risk', 'riskLevel', 'risk_level', 'maxRisk', 'max_risk']);
  if (risk) addCount(rollup.riskCounts, normalizeAgentReportCountKey('risk', risk), 1);

  const severity = readStringField(source, ['severity', 'maxSeverity', 'max_severity']);
  if (severity) addCount(rollup.severityCounts, normalizeAgentReportCountKey('severity', severity), 1);
}

function recordRequiresApproval(record: Record<string, unknown>, normalizedStatus: string | undefined): boolean {
  if (normalizedStatus === 'requires-approval') return true;
  return readBooleanField(record, ['requiresApproval', 'requires_approval', 'approvalRequired', 'approval_required']) === true;
}

function recordIndicatesFailure(record: Record<string, unknown>, normalizedStatus: string | undefined): boolean {
  if (normalizedStatus === 'failed') return true;
  if (readBooleanField(record, ['valid', 'ok', 'passed']) === false) return true;
  if (readBooleanField(record, ['failed', 'error', 'errored']) === true) return true;
  const error = record['error'];
  return typeof error === 'string' && error.trim().length > 0;
}

function readCountField(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const count = coerceCount(source[key]);
    if (count !== undefined) return count;
  }
  return undefined;
}

function readCountObject(
  source: Record<string, unknown>,
  keys: string[],
  kind: CountKind,
): Record<string, number> | undefined {
  for (const key of keys) {
    const value = source[key];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const counts: Record<string, number> = {};
    let sawCount = false;
    for (const [rawKey, rawCount] of Object.entries(value as Record<string, unknown>)) {
      const count = coerceCount(rawCount);
      if (count === undefined) continue;
      addCount(counts, normalizeAgentReportCountKey(kind, rawKey), count);
      sawCount = true;
    }
    if (sawCount) return counts;
  }
  return undefined;
}

function firstArrayField(source: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function readStringField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function readBooleanField(source: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function readDelegationSafety(record: Record<string, unknown>): 'safe' | 'unsafe' | 'unknown' | undefined {
  const bool = readBooleanField(record, [
    'safeToDelegate',
    'safe_to_delegate',
    'delegationSafe',
    'delegation_safe',
  ]);
  if (bool === true) return 'safe';
  if (bool === false) return 'unsafe';

  const raw = readStringField(record, [
    'delegationSafety',
    'delegation_safety',
    'safety',
    'safetyStatus',
    'safety_status',
  ]);
  if (!raw) return undefined;
  const normalized = normalizeAgentReportCountKey('safety', raw);
  return normalized === 'safe' || normalized === 'unsafe' || normalized === 'unknown'
    ? normalized
    : 'unknown';
}

function coerceCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), AGENT_REPORT_COUNT_MAX);
}

function addCount(counts: Record<string, number>, key: string, amount: number): void {
  counts[key] = Math.min((counts[key] ?? 0) + amount, AGENT_REPORT_COUNT_MAX);
}

function normalizeAgentReportCountKey(kind: CountKind, value: string): string {
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!key) return 'unknown';

  if (kind === 'status') {
    if (['ok', 'pass', 'passed', 'success', 'succeeded', 'clean', 'valid'].includes(key)) return 'ok';
    if (['warn', 'warning'].includes(key)) return 'warning';
    if (['review', 'needs-review'].includes(key)) return 'review';
    if (['requires-approval', 'approval-required', 'needs-approval'].includes(key)) return 'requires-approval';
    if (['fail', 'failed', 'error', 'errored', 'invalid'].includes(key)) return 'failed';
    if (['blocked', 'skipped', 'unknown'].includes(key)) return key;
    return 'other';
  }

  if (kind === 'risk') {
    if (['none', 'no-risk'].includes(key)) return 'none';
    if (['low', 'medium', 'high', 'critical', 'unknown'].includes(key)) return key;
    if (key === 'med') return 'medium';
    if (key === 'crit') return 'critical';
    return 'other';
  }

  if (kind === 'safety') {
    if (['safe', 'ok', 'pass', 'passed', 'true', 'yes', 'clean', 'allowed'].includes(key)) return 'safe';
    if (['unsafe', 'not-safe', 'fail', 'failed', 'false', 'no', 'blocked', 'danger'].includes(key)) return 'unsafe';
    if (key === 'unknown') return 'unknown';
    return 'unknown';
  }

  if (kind === 'action') {
    if (['delegate', 'delegation', 'run', 'proceed'].includes(key)) return 'delegate';
    if (['review', 'needs-review', 'human-review', 'requires-review'].includes(key)) return 'review';
    if (['approve', 'approval', 'requires-approval', 'needs-approval'].includes(key)) return 'approve';
    if (['block', 'blocked', 'deny', 'stop'].includes(key)) return 'block';
    if (['initialize', 'init', 'setup'].includes(key)) return 'initialize';
    if (['configure', 'config'].includes(key)) return 'configure';
    if (['none', 'noop', 'no-op', 'skip'].includes(key)) return 'none';
    if (key === 'unknown') return 'unknown';
    return 'other';
  }

  if (['info', 'informational'].includes(key)) return 'info';
  if (['low', 'minor'].includes(key)) return 'low';
  if (['medium', 'moderate'].includes(key)) return 'medium';
  if (['high', 'major'].includes(key)) return 'high';
  if (['critical', 'crit', 'blocker'].includes(key)) return 'critical';
  if (key === 'unknown') return 'unknown';
  return 'other';
}

/**
 * Extract ONLY secret names from `phantom list --json` output.
 *
 * The function intentionally returns an empty array whenever it cannot
 * confidently identify a "name" field, preventing accidental value leakage
 * if the JSON schema changes.
 *
 * NEVER include or return values, tokens, or any field that is not the
 * human-readable key name.
 */
function parseSecretNames(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    // ── Array of objects: [{ name: "KEY" }, ...]  or  [{ key: "KEY" }, ...]
    if (Array.isArray(parsed)) {
      const names: string[] = [];
      for (const item of parsed.slice(0, SECRET_NAMES_MAX)) {
        if (item !== null && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          // Prefer "name", fall back to "key" — both are safe identifier fields.
          const name = typeof obj['name'] === 'string'
            ? obj['name']
            : typeof obj['key'] === 'string'
              ? obj['key']
              : undefined;
          if (name && isSafeSecretName(name)) {
            names.push(name.trim());
          }
          // Deliberately skip any other field to avoid leaking values.
        } else if (typeof item === 'string') {
          // Some CLIs emit a flat string array of names.
          if (isSafeSecretName(item)) names.push(item.trim());
        }
      }
      return [...new Set(names)].sort();
    }

    // ── Object with a "secrets" or "keys" array at the top level
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['secrets', 'keys', 'names']) {
        if (Array.isArray(obj[key])) {
          return parseSecretNames(JSON.stringify(obj[key]));
        }
      }
    }

    // Unknown shape — return empty rather than risk leaking values.
    return [];
  } catch {
    // JSON parse failed — fall back to line-based extraction.
    return parseSecretNamesFromText(raw);
  }
}

function isSafeSecretName(value: string): boolean {
  const name = value.trim();
  if (!name || name.length > 120) return false;
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name)) return false;
  if (/\s|=/.test(name)) return false;
  if (/^sk-[A-Za-z0-9_-]{8,}/.test(name)) return false;
  if (/^gh[poursa]_[A-Za-z0-9]{8,}/.test(name)) return false;
  if (/^xox[baprs]-[A-Za-z0-9-]{8,}/i.test(name)) return false;
  if (/^Bearer\s+/i.test(name)) return false;
  if (/^AKIA[0-9A-Z]{16}$/.test(name)) return false;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(name)) return false;
  return true;
}

/**
 * Last-resort line-by-line name extractor for plain-text `phantom list` output.
 *
 * Phantom's table format typically looks like:
 *   NAME            PROTECTED
 *   MY_API_KEY      yes
 *   ANOTHER_SECRET  yes
 *
 * We extract the first whitespace-delimited token from each non-header line
 * that looks like an environment-variable name (ALL_CAPS / SCREAMING_SNAKE).
 *
 * Deliberately conservative — returns [] for any line that doesn't look like
 * a canonical env-var name.
 */
function parseSecretNamesFromText(text: string): string[] {
  const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
  const names: string[] = [];

  for (const raw of text.split('\n').slice(0, SECRET_NAMES_MAX)) {
    const line = raw.trim();
    if (!line) continue;
    const token = line.split(/\s+/)[0];
    // Skip header lines ("NAME", "KEY", etc.) implicitly — they pass the
    // same regex but are single-word and won't look like multi-word values.
    if (token && ENV_VAR_RE.test(token) && token !== 'NAME' && token !== 'KEY' && isSafeSecretName(token)) {
      names.push(token);
    }
  }

  return [...new Set(names)].sort();
}

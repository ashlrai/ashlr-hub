/** Package-owned ACP metadata helper. Native output is data, never executable input. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { canonical } from '../universe/artifacts.js';
import type { GrokProbeProcessInput, GrokProbeProcessOutput, GrokAccountProbeWindow } from './grok-account-probe.js';

// ACP v1 extensions use a leading underscore on the wire, unlike Rust ExtRequest names.
// https://agentclientprotocol.com/protocol/v1/extensibility
// https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/extensions/{auth,billing}.rs
const SUFFIX = ['--no-auto-update', 'agent', '--no-leader', 'stdio'];
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_MESSAGES = 256;
const HASH = /^[a-f0-9]{64}$/;
const PLANS = new Set(['Free', 'SuperGrok', 'SuperGrok Heavy', 'SuperGrok Pro', 'SuperGrok Plus', 'SuperGrok Lite',
  'SuperGrokPro', 'SuperGrokPlus', 'SuperGrokLite', 'GrokPro', 'XPremiumPlus', 'XPremium', 'XBasic']);

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max &&
    [...value].every((c) => c.charCodeAt(0) >= 32 && !(c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));
}
function empty(reason = 'probe-native-unavailable'): GrokProbeProcessOutput {
  return { status: 'failed', reason, accountHint: null, planType: null, loggedIn: null, windows: [],
    onDemandEnabled: null, observedAt: null, expiresAt: null };
}
function validInput(value: unknown): value is GrokProbeProcessInput {
  return record(value) && Object.keys(value).length === 4 && value.schemaVersion === 1 && Array.isArray(value.command) &&
    value.command.length >= 1 && value.command.length <= 32 && value.command.every((v) => text(v, 4096)) &&
    isAbsolute(value.command[0]) && value.command.reduce((n, v: string) => n + Buffer.byteLength(v), 0) <= 16_384 &&
    (value.expectedAccountHint === null || typeof value.expectedAccountHint === 'string' && HASH.test(value.expectedAccountHint)) &&
    typeof value.startedAt === 'string' && value.startedAt.length === 24 && Number.isFinite(Date.parse(value.startedAt)) &&
    new Date(value.startedAt).toISOString() === value.startedAt;
}
/** Accept RFC3339 offsets/fractional seconds, but not Date.parse's invalid-date normalization. */
function timestamp(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const date = new Date(0); date.setUTCFullYear(year!, month!, 0);
  if (month! < 1 || month! > 12 || day! < 1 || day! > date.getUTCDate() || hour! > 23 || minute! > 59 || second! > 59) return undefined;
  if (m[7] !== 'Z' && (Number(m[7]!.slice(1, 3)) > 23 || Number(m[7]!.slice(4, 6)) > 59)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 253_402_300_799_999 ? new Date(parsed).toISOString() : undefined;
}
function billing(value: unknown): { windows: GrokAccountProbeWindow[]; planType: string | null; onDemandEnabled: boolean | null } | null {
  if (!record(value) || !Object.hasOwn(value, 'config') || value.config !== null && !record(value.config) ||
    value.on_demand_enabled !== undefined && value.on_demand_enabled !== null && typeof value.on_demand_enabled !== 'boolean' ||
    value.subscription_tier !== undefined && value.subscription_tier !== null && typeof value.subscription_tier !== 'string') return null;
  const cfg = record(value.config) ? value.config : {};
  const used = cfg.creditUsagePercent;
  if (used !== undefined && used !== null && (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) ||
    cfg.isUnifiedBillingUser !== undefined && cfg.isUnifiedBillingUser !== null && typeof cfg.isUnifiedBillingUser !== 'boolean' ||
    cfg.currentPeriod !== undefined && cfg.currentPeriod !== null && !record(cfg.currentPeriod)) return null;
  const period = record(cfg.currentPeriod) ? cfg.currentPeriod : {};
  const start = timestamp(period.start); const end = timestamp(period.end);
  if (start === undefined || end === undefined || start !== null && end !== null && start >= end ||
    period.type !== undefined && period.type !== null && !['USAGE_PERIOD_TYPE_WEEKLY', 'USAGE_PERIOD_TYPE_MONTHLY'].includes(String(period.type))) return null;
  const scope = cfg.isUnifiedBillingUser === true ? 'unified' : cfg.isUnifiedBillingUser === false ? 'build' : 'credits';
  const suffix = period.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? '_weekly' : period.type === 'USAGE_PERIOD_TYPE_MONTHLY' ? '_monthly' : '';
  return { windows: [{ id: `grok_${scope}${suffix}`, usedPercent: typeof used === 'number' ? used : null, resetsAt: end }],
    planType: typeof value.subscription_tier === 'string' && PLANS.has(value.subscription_tier) ? value.subscription_tier : null,
    onDemandEnabled: typeof value.on_demand_enabled === 'boolean' ? value.on_demand_enabled : null };
}

// The outer verify runner owns this live POSIX group leader throughout escalation.
let terminating = false; let keepAlive: ReturnType<typeof setInterval> | undefined;
const holdForOwner = (): void => { terminating = true; keepAlive ??= setInterval(() => {}, 1000); };
process.on('SIGINT', holdForOwner); process.on('SIGTERM', holdForOwner);
let inputBytes = 0; let inputFailed = false; const chunks: Buffer[] = [];
process.stdin.on('data', (chunk: Buffer) => { inputBytes += chunk.length; if (inputBytes <= MAX_INPUT_BYTES) chunks.push(chunk); });
process.stdin.on('error', () => { inputFailed = true; process.exitCode = 1; });
process.stdin.on('end', () => {
  if (terminating) return;
  try {
    if (inputFailed || inputBytes > MAX_INPUT_BYTES) throw new Error();
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!validInput(input)) throw new Error();
    start(input);
  } catch { process.exitCode = 1; }
});

function start(input: GrokProbeProcessInput): void {
  let child: ChildProcessWithoutNullStreams; let output = empty();
  let ending = false; let closed = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
  let bytes = 0; let messages = 0; let pending = 1; let line = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let before: string | null = null; let quota: ReturnType<typeof billing> = null;
  function endNative(kill: boolean): void {
    ending = true; child.stdin.end();
    if (kill) { try { child.kill('SIGTERM'); } catch { /* Outer deadline owns group escalation. */ } }
    // Upstream normal stdio teardown sleeps 2 seconds after draining telemetry.
    killTimer = setTimeout(() => {
      if (!closed && !terminating) {
        output = empty('probe-native-exit-failed');
        try { child.kill('SIGKILL'); } catch { /* Outer deadline remains authoritative. */ }
      }
    }, kill ? 500 : 4000);
  }
  function fail(reason: string): void {
    if (terminating || ending && output.status === 'failed') return;
    output = empty(reason); if (!ending) endNative(true);
  }
  function send(method: string, params: Record<string, unknown> = {}): void {
    if (ending || terminating) return;
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: pending, method, params }) + '\n'); }
    catch { fail('probe-protocol-invalid'); }
  }
  function account(value: unknown): string | null {
    // auth/info is cached metadata and may be expired. Never infer loggedIn here.
    if (!record(value) || !Object.hasOwn(value, 'methodId') || value.methodId !== null && !text(value.methodId, 128) ||
      !text(value.email, 320) || !value.email.trim()) { fail('probe-account-unavailable'); return null; }
    if (value.methodId !== null && !['cached_token', 'grok.com'].includes(value.methodId as string)) {
      fail('probe-account-unsupported'); return null;
    }
    const identity: Record<string, unknown> = { schemaVersion: 1, provider: 'grok', methodId: value.methodId, email: value.email };
    for (const key of ['principalId', 'principalType', 'teamId', 'organizationId']) {
      if (value[key] !== undefined && value[key] !== null && !text(value[key], 512)) { fail('probe-account-unavailable'); return null; }
      identity[key] = value[key] ?? null;
    }
    return createHash('sha256').update(canonical(identity)).digest('hex');
  }
  function message(v: unknown): void {
    if (terminating || ending && output.status === 'failed') return;
    if (++messages > MAX_MESSAGES) { fail('probe-output-limit'); return; }
    if (!record(v) || v.jsonrpc !== '2.0') { fail('probe-protocol-invalid'); return; }
    if (Object.hasOwn(v, 'method')) {
      if (Object.hasOwn(v, 'id')) { fail('probe-server-request-refused'); return; }
      if (!text(v.method, 160) || Object.keys(v).some((k) => !['jsonrpc', 'method', 'params'].includes(k))) { fail('probe-protocol-invalid'); return; }
      // Unknown notifications are discarded, bounded, never retained or acted on.
      if (v.method === 'session/update' || v.method === '_x.ai/auth/updated') fail('probe-account-changed');
      return;
    }
    if (v.id !== pending || Object.keys(v).some((k) => !['jsonrpc', 'id', 'result', 'error'].includes(k)) ||
      Object.hasOwn(v, 'result') === Object.hasOwn(v, 'error')) { fail('probe-protocol-invalid'); return; }
    if (Object.hasOwn(v, 'error')) {
      fail(record(v.error) && v.error.code === -32601 ? 'probe-protocol-unsupported' : 'probe-provider-error'); return;
    }
    if (pending === 1) {
      const init = v.result;
      if (!record(init) || init.protocolVersion !== 1 || !record(init.agentCapabilities) || !record(init._meta) ||
        init._meta.grokShell !== true || typeof init._meta.agentVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(init._meta.agentVersion)) {
        fail('probe-protocol-unsupported'); return;
      }
      pending = 2; send('_x.ai/auth/info');
    } else if (pending === 2) {
      before = account(v.result); if (!before) return;
      if (input.expectedAccountHint !== null && before !== input.expectedAccountHint) { fail('probe-account-hint-mismatch'); return; }
      pending = 3; send('_x.ai/billing');
    } else if (pending === 3) {
      quota = billing(v.result); if (!quota) { fail('probe-quota-invalid'); return; }
      pending = 4; send('_x.ai/auth/info');
    } else if (pending === 4) {
      const after = account(v.result); if (!after) return;
      if (before !== after) { fail('probe-account-changed'); return; }
      output = { status: 'observed', reason: 'probe-observed', accountHint: after, loggedIn: true, ...quota!,
        observedAt: input.startedAt, expiresAt: new Date(Date.parse(input.startedAt) + 60_000).toISOString() };
      pending = 5; endNative(false);
    } else fail('probe-protocol-invalid');
  }
  try { child = spawn(input.command[0]!, [...input.command.slice(1), ...SUFFIX],
    { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: false, shell: false }); }
  catch { process.stdout.write(JSON.stringify(output) + '\n'); return; }
  child.stdin.on('error', () => fail('probe-protocol-invalid'));
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) { fail('probe-output-limit'); return; }
    try {
      line += decoder.decode(chunk, { stream: true }); let newline: number;
      while ((newline = line.indexOf('\n')) >= 0) {
        const complete = line.slice(0, newline); line = line.slice(newline + 1);
        if (Buffer.byteLength(complete) > MAX_LINE_BYTES) { fail('probe-output-limit'); return; }
        if (complete.trim()) message(JSON.parse(complete));
      }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) fail('probe-output-limit');
    } catch { fail('probe-protocol-invalid'); }
  });
  child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) fail('probe-output-limit'); });
  child.on('error', () => { output = empty('probe-native-unavailable'); });
  child.on('close', (code, signal) => {
    closed = true; if (killTimer) clearTimeout(killTimer); if (terminating) return;
    try { line += decoder.decode(); } catch { output = empty('probe-protocol-invalid'); }
    if (line.trim()) output = empty('probe-protocol-invalid');
    if (output.status === 'observed' && (code !== 0 || signal)) output = empty('probe-native-exit-failed');
    process.stdout.write(JSON.stringify(output) + '\n');
  });
  send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'ashlr_hub_grok_account_probe', version: '1' },
    _meta: { startupHints: { nonInteractive: true, skipGitStatus: true, skipProjectLayout: true } } });
}

/** Package-owned NDJSON handshake helper. Never use provider output as executable input. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { canonical } from '../universe/artifacts.js';
import { normalizeCodexResourceObservation } from './provider-observations.js';
import type { CodexProbeProcessInput, CodexProbeProcessOutput } from './codex-account-probe.js';

// Installed codex-cli 0.136.0 generated schema and official App Server protocol:
// https://learn.chatgpt.com/docs/app-server (checked 2026-09-07).
// account/rateLimits/read accepts absent/null params, not an empty object.
const SUFFIX = ['app-server', '--stdio', '-c', 'analytics.enabled=false'];
// Binding argv is capped at 16 KiB before JSON escaping, plus fixed metadata.
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_MESSAGES = 256;
const PLAN_TYPES = new Set(['free', 'go', 'plus', 'pro', 'prolite', 'team', 'self_serve_business_usage_based',
  'business', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'unknown']);
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max &&
    [...value].every((character) => character.charCodeAt(0) >= 32 &&
      !(character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159));
}
function validInput(value: unknown): value is CodexProbeProcessInput {
  return record(value) && Object.keys(value).length === 6 && value.schemaVersion === 1 &&
    Array.isArray(value.command) && value.command.length >= 1 && value.command.length <= 32 &&
    value.command.every((part) => text(part, 4_096)) && isAbsolute(value.command[0]) &&
    typeof value.workerId === 'string' && ID.test(value.workerId) && Array.isArray(value.bucketIds) &&
    value.bucketIds.length >= 1 && value.bucketIds.length <= 4 &&
    value.bucketIds.every((id) => typeof id === 'string' && ID.test(id)) && new Set(value.bucketIds).size === value.bucketIds.length &&
    (value.expectedAccountHint === null || typeof value.expectedAccountHint === 'string' && /^[a-f0-9]{64}$/.test(value.expectedAccountHint)) &&
    typeof value.startedAt === 'string' && value.startedAt.length === 24 && Number.isFinite(Date.parse(value.startedAt)) &&
    new Date(value.startedAt).toISOString() === value.startedAt;
}

// The outer verify runner owns our POSIX group. Stay its live leader throughout
// cancellation, even when the native child exits first, until group SIGKILL.
// This prevents the runner losing safe escalation authority to a recycled PID.
let terminating = false;
let keepAlive: ReturnType<typeof setInterval> | undefined;
const holdForOwner = (): void => {
  terminating = true;
  keepAlive ??= setInterval(() => {}, 1_000);
};
process.on('SIGINT', holdForOwner);
process.on('SIGTERM', holdForOwner);

let inputBytes = 0; let inputFailed = false; const chunks: Buffer[] = [];
process.stdin.on('data', (chunk: Buffer) => {
  inputBytes += chunk.length;
  if (inputBytes <= MAX_INPUT_BYTES) chunks.push(chunk);
});
process.stdin.on('error', () => { inputFailed = true; process.exitCode = 1; });
process.stdin.on('end', () => {
  if (terminating) return;
  try {
    if (inputFailed || inputBytes > MAX_INPUT_BYTES) throw new Error('Invalid helper input');
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!validInput(input)) throw new Error('Invalid helper input');
    start(input);
  } catch { process.exitCode = 1; }
});

function start(input: CodexProbeProcessInput): void {
  let child: ChildProcessWithoutNullStreams;
  let output: CodexProbeProcessOutput = { schemaVersion: 1, status: 'failed', reason: 'probe-native-unavailable',
    accountHint: null, planType: null, observation: null };
  let ending = false; let childClosed = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
  let bytes = 0; let messages = 0; let pending = 1; let line = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let before: { accountHint: string; planType: string } | null = null;
  let quota: unknown;

  function fail(reason: string): void {
    if (terminating || ending && output.status === 'failed') return;
    output = { ...output, status: 'failed', reason, observation: null };
    if (!ending) endNative(true);
  }
  function endNative(kill: boolean): void {
    ending = true;
    child.stdin.end();
    if (kill) {
      try { child.kill('SIGTERM'); } catch { /* Outer group deadline remains authoritative. */ }
    }
    // Signal only this still-owned child. The helper stays alive until close;
    // inherited pipes/background descendants remain bounded by the outer group.
    killTimer = setTimeout(() => {
      if (!childClosed && !terminating) {
        output = { ...output, status: 'failed', reason: 'probe-native-exit-failed', observation: null };
        try { child.kill('SIGKILL'); } catch { /* Outer group deadline remains authoritative. */ }
      }
    }, 500);
  }
  function send(value: unknown): void {
    if (ending || terminating) return;
    try { child.stdin.write(JSON.stringify(value) + '\n'); } catch { fail('probe-protocol-invalid'); }
  }
  function account(value: unknown): { accountHint: string; planType: string } | null {
    if (!record(value) || typeof value.requiresOpenaiAuth !== 'boolean') { fail('probe-protocol-invalid'); return null; }
    if (!record(value.account)) { fail('probe-account-unavailable'); return null; }
    if (value.account.type !== 'chatgpt' || !value.requiresOpenaiAuth) { fail('probe-account-unsupported'); return null; }
    const email = value.account.email; const planType = value.account.planType;
    if (!text(email, 320) || !email.trim() || typeof planType !== 'string' || !PLAN_TYPES.has(planType)) {
      fail('probe-account-unavailable'); return null;
    }
    const accountHint = createHash('sha256').update(canonical({ schemaVersion: 1, type: 'chatgpt', email, planType })).digest('hex');
    return { accountHint, planType };
  }
  function message(value: unknown): void {
    if (terminating || ending && output.status === 'failed') return;
    if (++messages > MAX_MESSAGES) { fail('probe-output-limit'); return; }
    if (!record(value)) { fail('probe-protocol-invalid'); return; }
    if (Object.hasOwn(value, 'method')) {
      if (Object.hasOwn(value, 'id')) { fail('probe-server-request-refused'); return; }
      if (!text(value.method, 160) || Object.keys(value).some((key) => !['method', 'params'].includes(key))) {
        fail('probe-protocol-invalid'); return;
      }
      if (before && value.method === 'account/updated') fail('probe-account-changed');
      return;
    }
    if (value.id !== pending || Object.keys(value).some((key) => !['id', 'result', 'error'].includes(key)) ||
      Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) { fail('probe-protocol-invalid'); return; }
    if (Object.hasOwn(value, 'error')) { fail('probe-provider-error'); return; }
    if (pending === 1) {
      const info = value.result;
      if (!record(info) || !text(info.codexHome, 4_096) || !isAbsolute(info.codexHome) ||
        !text(info.userAgent, 512) || !text(info.platformFamily, 128) || !text(info.platformOs, 128)) {
        fail('probe-protocol-invalid'); return;
      }
      send({ method: 'initialized' });
      pending = 2;
      send({ id: pending, method: 'account/read', params: { refreshToken: false } });
    } else if (pending === 2) {
      before = account(value.result);
      if (!before) return;
      output = { ...output, ...before };
      if (input.expectedAccountHint !== null && before.accountHint !== input.expectedAccountHint) {
        fail('probe-account-hint-mismatch'); return;
      }
      pending = 3;
      send({ id: pending, method: 'account/rateLimits/read' });
    } else if (pending === 3) {
      quota = value.result;
      pending = 4;
      send({ id: pending, method: 'account/read', params: { refreshToken: false } });
    } else if (pending === 4) {
      const after = account(value.result);
      if (!after) return;
      if (after.accountHint !== before?.accountHint) { fail('probe-account-changed'); return; }
      const observation = normalizeCodexResourceObservation(input.workerId, quota,
        { nowMs: Date.parse(input.startedAt), ttlMs: 60_000, bucketIds: input.bucketIds });
      if (!observation) { fail('probe-quota-invalid'); return; }
      output = { ...output, status: 'observed', reason: 'probe-observed', observation };
      pending = 5;
      endNative(false);
    } else fail('probe-protocol-invalid');
  }

  try { child = spawn(input.command[0]!, [...input.command.slice(1), ...SUFFIX],
    { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: false, shell: false }); }
  catch { process.stdout.write(JSON.stringify(output) + '\n'); return; }
  child.stdin.on('error', () => { fail('probe-protocol-invalid'); });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) { fail('probe-output-limit'); return; }
    try {
      line += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = line.indexOf('\n')) >= 0) {
        const complete = line.slice(0, newline); line = line.slice(newline + 1);
        if (Buffer.byteLength(complete) > MAX_LINE_BYTES) { fail('probe-output-limit'); return; }
        if (complete.trim()) message(JSON.parse(complete));
      }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) fail('probe-output-limit');
    } catch { fail('probe-protocol-invalid'); }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) fail('probe-output-limit');
    // Native diagnostics can contain identity, file paths or auth material.
    // Count for boundedness, never echo or retain them in helper output.
  });
  child.on('error', () => { output = { ...output, status: 'failed', reason: 'probe-native-unavailable', observation: null }; });
  child.on('close', (code, signal) => {
    childClosed = true;
    if (killTimer) clearTimeout(killTimer);
    if (terminating) return;
    try { line += decoder.decode(); } catch { output = { ...output, status: 'failed', reason: 'probe-protocol-invalid', observation: null }; }
    if (line.trim()) output = { ...output, status: 'failed', reason: 'probe-protocol-invalid', observation: null };
    if (output.status === 'observed' && (code !== 0 || signal)) {
      output = { ...output, status: 'failed', reason: 'probe-native-exit-failed', observation: null };
    }
    process.stdout.write(JSON.stringify(output) + '\n');
  });
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ashlr_hub_resource_probe', version: '1' },
    capabilities: { experimentalApi: false, requestAttestation: false } } });
}

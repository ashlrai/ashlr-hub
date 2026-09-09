/** Explicit native metadata collection. This monitor never enrolls or dispatches workers. */
import { isAbsolute } from 'node:path';
import type { VerifyProcessGroupLifecycle } from '../run/verify-commands.js';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { probeCodexResourceAccount } from './codex-account-probe.js';
import { probeClaudeAccountUsage } from './claude-account-usage.js';
import { probeGrokAccount } from './grok-account-probe.js';
import type { ResourceAccountConnection, ResourceConnectionsSnapshot } from './connection-types.js';
import type { NativeMetadataCoordinator } from './metadata-coordinator.js';

export interface ResourceConnectionConfig {
  schemaVersion: 1;
  intervalMs: number;
  accounts: Array<{ id: string; label: string; provider: ResourceAccountConnection['provider']; command: string[];
    expectedAccountHint?: string }>;
}
export interface ResourceConnectionMonitor { snapshot(): ResourceConnectionsSnapshot; close(): Promise<void> }
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every((key) => typeof key === 'string' &&
    [...required, ...optional].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function text(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= bytes &&
    [...value].every((character) => { const code = character.charCodeAt(0); return code >= 32 && (code < 127 || code > 159); });
}
function array(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.length <= max && Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, index)).every((item) => item && 'value' in item);
}
export function validateResourceConnectionConfig(value: unknown): ResourceConnectionConfig {
  if (!record(value) || !exact(value, ['schemaVersion', 'intervalMs', 'accounts']) || value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.intervalMs) || Number(value.intervalMs) < 30_000 || Number(value.intervalMs) > 3_600_000 || !array(value.accounts, 8)) {
    throw new Error('Invalid native connection configuration');
  }
  const ids = new Set<string>();
  const accounts = value.accounts.map((row) => {
    if (!record(row) || !exact(row, ['id', 'label', 'provider', 'command'], ['expectedAccountHint']) ||
      !text(row.id, 64) || !ID.test(row.id) || ids.has(row.id) || !text(row.label, 80) ||
      typeof row.provider !== 'string' || !['codex', 'claude', 'grok'].includes(row.provider) || !array(row.command, 32) ||
      !row.command.every((arg) => text(arg, 4096)) || !isAbsolute(row.command[0] as string) ||
      row.command.reduce((sum: number, arg) => sum + Buffer.byteLength(arg as string), 0) > 16_384 ||
      (row.expectedAccountHint !== undefined && (typeof row.expectedAccountHint !== 'string' || !/^[a-f0-9]{64}$/.test(row.expectedAccountHint)))) {
      throw new Error('Invalid native connection account');
    }
    ids.add(row.id);
    return { id: row.id, label: row.label, provider: row.provider as ResourceAccountConnection['provider'], command: [...row.command] as string[],
      ...(row.expectedAccountHint === undefined ? {} : { expectedAccountHint: row.expectedAccountHint as string }) };
  });
  return { schemaVersion: 1, intervalMs: Number(value.intervalMs), accounts };
}

export function createResourceConnectionMonitor(options: { config: ResourceConnectionConfig; cwd: string;
  signal?: AbortSignal; assertOwnership: () => void; coordinator?: NativeMetadataCoordinator }): ResourceConnectionMonitor {
  const config = validateResourceConnectionConfig(options.config); inspectPrivateDirectory(options.cwd);
  const signal = options.coordinator ? AbortSignal.any([options.coordinator.signal, ...(options.signal ? [options.signal] : [])]) : options.signal;
  const abort = new AbortController(); let closing = false; let uncertain = false; let refreshing = false;
  let timer: ReturnType<typeof setTimeout> | undefined; let pending: Promise<void> = Promise.resolve();
  const hints = new Map(config.accounts.filter((row) => row.expectedAccountHint).map((row) => [row.id, row.expectedAccountHint!]));
  const blank = (row: ResourceConnectionConfig['accounts'][number]): ResourceAccountConnection => ({ id: row.id, label: row.label,
    provider: row.provider, state: 'checking', authentication: 'unknown', health: 'unknown', planType: null,
    observedAt: null, expiresAt: null, windows: [], reason: 'connection-not-checked', onDemandEnabled: null, executionSupported: row.provider !== 'grok' });
  let rows = config.accounts.map(blank);
  const projectStopped = () => { rows = rows.map((row) => ({ ...row, state: 'unavailable', authentication: 'unknown',
    health: 'unknown', windows: [], reason: 'connection-monitor-stopped' })); };
  abort.signal.addEventListener('abort', projectStopped, { once: true });
  function owns(): void {
    try { options.assertOwnership(); }
    catch { uncertain = true; options.coordinator?.abort(); abort.abort(); throw new Error('Connection ownership unavailable'); }
  }
  async function native<T extends { status: string }>(operation: (processGroupLifecycle?: VerifyProcessGroupLifecycle) => Promise<T>): Promise<T> {
    const collect = async (processGroupLifecycle?: VerifyProcessGroupLifecycle) => {
      if (options.coordinator) owns();
      if (abort.signal.aborted) throw new Error('Metadata collection stopped');
      const unsettled = (): void => {
        uncertain = true;
        // Cancel the other collector and its queued calls before releasing the permit.
        options.coordinator?.abort(); abort.abort();
      };
      try {
        const result = await operation(processGroupLifecycle);
        const status = record(result) ? Object.getOwnPropertyDescriptor(result, 'status') : undefined;
        if (!status || !('value' in status) || typeof status.value !== 'string' ||
          !['observed', 'failed', 'timed-out', 'cancelled', 'uncertain'].includes(status.value)) {
          throw new Error('Native connection settlement unavailable');
        }
        if (status.value === 'uncertain') unsettled();
        return result;
      } catch {
        // An invocation that throws or rejects has provided no cleanup witness.
        unsettled();
        throw new Error('Native connection settlement unavailable');
      }
    };
    return options.coordinator ? options.coordinator.run(collect, (value) => value.status !== 'uncertain') : collect();
  }
  async function sample(account: ResourceConnectionConfig['accounts'][number], index: number): Promise<void> {
    let row = blank(account); row.state = 'unavailable'; row.health = 'unavailable'; row.reason = 'connection-probe-unavailable';
    try {
      owns(); if (abort.signal.aborted) return;
      if (account.provider === 'codex') {
        // This ephemeral definition supplies the existing probe's validation
        // contract only. No pool files, ledger, task or model selection is made.
        const pool = { schemaVersion: 1 as const, id: 'connection-metadata', workers: [{ id: account.id, provider: 'codex' as const,
          model: 'metadata-only', maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 1, taskWindowMs: 60_000, priority: 1 }] };
        const result = await native((processGroupLifecycle) => probeCodexResourceAccount({ pool, bindings: [{ workerId: account.id, capacityKey: account.id,
          kind: 'native-cli', command: account.command }], workerId: account.id, bucketIds: ['codex'], cwd: options.cwd,
          timeoutMs: 10_000, signal: abort.signal, ...(processGroupLifecycle ? { processGroupLifecycle } : {}),
          ...(hints.has(account.id) ? { expectedAccountHint: hints.get(account.id)! } : {}) }));
        if (result.status === 'uncertain') uncertain = true;
        row.reason = result.reason;
        if (result.status === 'observed' && result.observation && result.accountHint) {
          hints.set(account.id, result.accountHint);
          row = { ...row, state: 'observed', authentication: 'signed-in', health: 'reachable', planType: result.planType,
            observedAt: result.observation.observedAt, expiresAt: result.observation.expiresAt, windows: result.observation.windows };
        }
      } else if (account.provider === 'claude') {
        const result = await native((processGroupLifecycle) => probeClaudeAccountUsage({ command: account.command, cwd: options.cwd,
          timeoutMs: 20_000, signal: abort.signal, ...(processGroupLifecycle ? { processGroupLifecycle } : {}) }));
        if (result.status === 'uncertain') uncertain = true;
        row.reason = result.reason;
        if (result.status === 'observed' && result.loggedIn && hints.has(account.id) && result.accountHint !== hints.get(account.id)) {
          row.reason = 'usage-account-changed';
        } else if (result.status === 'observed') {
          if (result.loggedIn && result.accountHint) hints.set(account.id, result.accountHint);
          row = { ...row, state: result.loggedIn ? 'observed' : 'signed-out',
          authentication: result.loggedIn ? 'signed-in' : 'signed-out', health: 'unknown', planType: result.subscriptionType,
          observedAt: result.startedAt, expiresAt: new Date(Date.parse(result.startedAt) + 60_000).toISOString(), windows: result.windows };
        }
      } else {
        const result = await native((processGroupLifecycle) => probeGrokAccount({ command: account.command, cwd: options.cwd, timeoutMs: 15_000, signal: abort.signal,
          ...(processGroupLifecycle ? { processGroupLifecycle } : {}),
          ...(hints.has(account.id) ? { expectedAccountHint: hints.get(account.id)! } : {}) }));
        if (result.status === 'uncertain') uncertain = true;
        row.reason = result.reason;
        if (result.status === 'observed' && result.loggedIn === true && result.accountHint) {
          hints.set(account.id, result.accountHint);
          row = { ...row, state: 'observed', authentication: 'signed-in', health: 'reachable', planType: result.planType,
            observedAt: result.observedAt, expiresAt: result.expiresAt, windows: result.windows, onDemandEnabled: result.onDemandEnabled };
        }
      }
      owns();
    } catch { row = { ...blank(account), state: 'unavailable', health: 'unavailable', reason: 'connection-probe-unavailable' }; }
    if (uncertain) abort.abort();
    if (!closing && !abort.signal.aborted) rows[index] = row;
  }
  async function cycle(): Promise<void> {
    refreshing = true;
    try {
      // At most two simultaneous native clients; no overlapping refresh cycles.
      for (let i = 0; i < config.accounts.length && !abort.signal.aborted; i += 2) {
        await Promise.all(config.accounts.slice(i, i + 2).map((account, offset) => sample(account, i + offset)));
      }
    } finally {
      refreshing = false;
      if (abort.signal.aborted) projectStopped();
      if (!closing && !abort.signal.aborted) timer = setTimeout(() => { pending = cycle(); }, config.intervalMs);
    }
  }
  const stopped = () => { abort.abort(); if (timer) clearTimeout(timer); };
  if (signal?.aborted) stopped(); else signal?.addEventListener('abort', stopped, { once: true });
  if (!abort.signal.aborted) pending = cycle();
  return {
    snapshot: () => ({ sampledAt: new Date().toISOString(), refreshing, accounts: structuredClone(rows) }),
    async close() { closing = true; stopped(); signal?.removeEventListener('abort', stopped); await pending;
      rows = rows.map((row) => ({ ...row, health: 'unknown' }));
      if (uncertain) throw new Error('Native connection process cleanup uncertain'); },
  };
}

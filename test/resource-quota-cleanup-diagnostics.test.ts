/** Private temporary leases and mocked subprocesses only; no native/provider contact. */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeCodexResourceAccount, sanitizeCodexProbeCleanupDiagnostics,
  type CodexProbeCleanupDiagnostics, type CodexResourceProbeOptions, type CodexResourceProbeResult } from '../src/core/resources/codex-account-probe.js';
import { refreshResourceQuotaOnce, ResourceQuotaRefreshError } from '../src/core/resources/quota-refresh.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import * as verify from '../src/core/run/verify-commands.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'quota-diagnostics-')));
  vi.stubEnv('TMPDIR', root);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const pool: ResourcePool = { schemaVersion: 1, id: 'diagnostics', workers: ['first', 'second'].map(id => ({
    id, provider: 'codex', model: 'inert', maxConcurrent: 1, reservePercent: 25,
    maxTasksPerWindow: 2, taskWindowMs: 60_000, priority: 1,
  })) };
  const bindings: ResourceBinding[] = pool.workers.map(({ id }) => ({ workerId: id, capacityKey: id,
    kind: 'native-cli', command: ['/PRIVATE/never-invoked'] }));
  const config = { schemaVersion: 1 as const, poolDigest: digest(canonical({ pool, bindings })),
    workers: pool.workers.map(({ id }, index) => ({ workerId: id, accountHint: (index ? 'b' : 'a').repeat(64), bucketIds: ['codex'] })) };
  return { pool, bindings, config, cwd: root, timeoutMs: 5000, observations: [] };
}
const unknown: CodexProbeCleanupDiagnostics = { failure: 'diagnostics-unavailable', processGroupSettlement: 'unknown',
  timedOut: 'unknown', cancelled: 'unknown' };
const execution = (patch: Partial<verify.VerifySubprocessResult>): verify.VerifySubprocessResult => ({
  stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR', exitCode: 0, signal: null, timedOut: false, cancelled: false,
  processGroupSettlement: 'group-exit-confirmed', ...patch,
});

describe('bounded cleanup diagnostic evidence', () => {
  it.each([
    [{ timedOut: true }, 'native-timed-out', 'timed-out'],
    [{ cancelled: true }, 'native-cancelled', 'cancelled'],
    [{ processGroupSettlement: 'unconfirmed', timedOut: true }, 'group-exit-unconfirmed', 'uncertain'],
    [{ processGroupSettlement: 'unconfirmed', error: 'process-group lifecycle publication failed' }, 'lifecycle-publication-failed', 'uncertain'],
    [{ processGroupSettlement: undefined }, 'group-exit-unconfirmed', 'uncertain'],
    [{ error: '/PRIVATE/raw-error', exitCode: -1 }, 'process-failed', 'failed'],
  ] as Array<[Partial<verify.VerifySubprocessResult>, string, string]>)('projects subprocess failure %# without native text', async (patch, failure, status) => {
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue(execution(patch));
    const f = fixture();
    const result = await probeCodexResourceAccount({ pool: f.pool, bindings: f.bindings, cwd: root,
      workerId: 'first', bucketIds: ['codex'] });
    expect(result.status).toBe(status);
    expect(result.cleanupDiagnostics).toEqual({ failure, processGroupSettlement: patch.processGroupSettlement === undefined &&
      Object.hasOwn(patch, 'processGroupSettlement') ? 'unknown' : patch.processGroupSettlement ?? 'group-exit-confirmed',
    timedOut: 'timedOut' in patch ? patch.timedOut : false, cancelled: 'cancelled' in patch ? patch.cancelled : false });
    expect(Object.isFrozen(result.cleanupDiagnostics)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('preserves runner rejection separately without retaining the exception', async () => {
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockRejectedValue(new Error('/PRIVATE/runner'));
    const f = fixture(); const result = await probeCodexResourceAccount({ pool: f.pool, bindings: f.bindings,
      cwd: root, workerId: 'first', bucketIds: ['codex'] });
    expect(result).toMatchObject({ status: 'uncertain', reason: 'probe-termination-uncertain',
      cleanupDiagnostics: { ...unknown, failure: 'runner-rejected' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('distinguishes an earlier observation from a later uncertain probe without attaching the sample', async () => {
    const f = fixture();
    const probe = vi.fn(async (options: CodexResourceProbeOptions) => {
      if (options.workerId === 'second') return { status: 'uncertain' } as CodexResourceProbeResult;
      const captured = new Date().toISOString();
      return { schemaVersion: 1, scope: 'codex-native-metadata', workerId: 'first', poolDigest: f.config.poolDigest,
        status: 'observed', reason: 'probe-observed', startedAt: captured, finishedAt: captured,
        accountHint: 'a'.repeat(64), planType: 'pro', observation: { workerId: 'first', health: 'ready', retryAfter: null,
          observedAt: captured, updatedAt: captured, expiresAt: new Date(Date.parse(captured) + 60_000).toISOString(),
          windows: [{ id: 'codex_primary', usedPercent: 20, resetsAt: new Date(Date.now() + 60_000).toISOString() }] },
      } as CodexResourceProbeResult;
    });
    const error = await refreshResourceQuotaOnce({ ...f, _probe: probe }).catch(error => error);
    expect(error.workerDiagnostics).toEqual([
      { workerId: 'first', probeStatus: 'observed', cleanupDiagnostics: unknown },
      { workerId: 'second', probeStatus: 'uncertain', cleanupDiagnostics: unknown },
    ]);
    expect(error).not.toHaveProperty('observations'); expect(JSON.stringify(error)).not.toMatch(/accountHint|usedPercent|aaaaaaaa/);
  });

  it('carries lifecycle evidence through one-shot cleanup failure without partial observations or another call', async () => {
    const runner = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue(execution({
      processGroupSettlement: 'unconfirmed', timedOut: true, error: 'process-group lifecycle publication failed',
    }));
    const f = fixture(); const error = await refreshResourceQuotaOnce(f).catch(error => error);
    expect(error).toBeInstanceOf(ResourceQuotaRefreshError);
    expect(error.message).toBe('Resource quota refresh cleanup unconfirmed');
    expect(error.workerDiagnostics).toEqual([{ workerId: 'first', probeStatus: 'uncertain', cleanupDiagnostics: {
      failure: 'lifecycle-publication-failed', timedOut: true, cancelled: false, processGroupSettlement: 'unconfirmed',
    } }]);
    expect(runner).toHaveBeenCalledOnce(); expect(existsSync(join(root, '.resource-quota-refresh-pending.json'))).toBe(true);
    expect(Object.isFrozen(error.workerDiagnostics)).toBe(true);
    expect(Object.isFrozen(error.workerDiagnostics[0])).toBe(true);
    expect(Object.isFrozen(error.workerDiagnostics[0].cleanupDiagnostics)).toBe(true);
    expect(error).not.toHaveProperty('observations'); expect(error).not.toHaveProperty('unavailableWorkerIds');
    expect(error).not.toHaveProperty('cause'); expect(JSON.stringify(error)).not.toMatch(/PRIVATE|accountHint|aaaaaaaa/);
  });

  it.each(['accessor', 'nested-accessor', 'private-enum', 'extra-fields', 'rejected'] as const)(
    'sanitizes injected %s evidence without invoking accessors', async kind => {
      const getter = vi.fn(() => '/PRIVATE/getter');
      const diagnostics = { ...unknown, failure: 'group-exit-unconfirmed', processGroupSettlement: 'unconfirmed',
        timedOut: false, cancelled: false, privateField: '/PRIVATE/extra' };
      const value: Record<string, unknown> = { status: 'uncertain', reason: '/PRIVATE/reason', workerId: '/PRIVATE/identity',
        cleanupDiagnostics: diagnostics };
      if (kind === 'accessor') Object.defineProperty(value, 'cleanupDiagnostics', { get: getter });
      if (kind === 'nested-accessor') Object.defineProperty(diagnostics, 'failure', { get: getter });
      if (kind === 'private-enum') diagnostics.failure = '/PRIVATE/enum';
      const probe = vi.fn(async () => { if (kind === 'rejected') throw new Error('/PRIVATE/rejection'); return value as unknown as CodexResourceProbeResult; });
      const error = await refreshResourceQuotaOnce({ ...fixture(), _probe: probe }).catch(error => error);
      expect(error).toBeInstanceOf(ResourceQuotaRefreshError); expect(probe).toHaveBeenCalledOnce(); expect(getter).not.toHaveBeenCalled();
      expect(error.workerDiagnostics).toEqual([{ workerId: 'first', probeStatus: kind === 'rejected' ? 'rejected' : 'uncertain', cleanupDiagnostics: kind === 'extra-fields'
        ? { failure: 'group-exit-unconfirmed', processGroupSettlement: 'unconfirmed', timedOut: false, cancelled: false }
        : { ...unknown, ...(kind === 'rejected' ? { failure: 'probe-rejected' } : {}) } }]);
      expect(JSON.stringify(error)).not.toContain('PRIVATE');
    });

  it('rejects inherited and malformed diagnostic fields and detaches accepted data', () => {
    expect(sanitizeCodexProbeCleanupDiagnostics(Object.create(unknown))).toBeUndefined();
    expect(sanitizeCodexProbeCleanupDiagnostics({ ...unknown, timedOut: 1 })).toBeUndefined();
    const input = { ...unknown }; const clean = sanitizeCodexProbeCleanupDiagnostics(input)!;
    input.failure = 'runner-rejected'; expect(clean.failure).toBe('diagnostics-unavailable');
    expect(new ResourceQuotaRefreshError('fixture', Array.from({ length: 70 }, () => ({
      workerId: 'first', probeStatus: 'unknown', cleanupDiagnostics: clean,
    }))).workerDiagnostics).toHaveLength(64);
  });
});

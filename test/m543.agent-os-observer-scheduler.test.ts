import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, DaemonTick } from '../src/core/types.js';
import {
  agentOsDurableTickDigestV1,
  agentOsObserverAttemptIdForTickV1,
  agentOsObserverChildInvocationV1,
  agentOsObserverChildEnvironmentV1,
  readAgentOsObserverSchedulerStatusV1,
  resolveAgentOsObserverConfigV1,
  scheduleAgentOsObserverV1,
} from '../src/core/daemon/agent-os-observer-scheduler.js';
import { runAgentOsObserverChildV1 } from '../src/core/daemon/agent-os-observer-child.js';
import {
  cancelDaemonPostTickChildren,
  scheduleAgentOsObserverAfterTick,
} from '../src/core/daemon/loop.js';
import {
  agentOsSourceTrustKeyIdV1,
  agentOsSourceTrustPolicyDigestV1,
  type AgentOsSourceTrustPolicyV1,
} from '../src/core/vision/agent-os-source-bundle.js';
import type { AgentOsSourceBundleStoreReadResultV1 } from '../src/core/vision/agent-os-source-bundle-store.js';
import type { AgentOsObserverResultV1 } from '../src/core/vision/agent-os-observer.js';
import { beginAgentOsObserverAttemptV1 } from '../src/core/vision/agent-os-observer-attempt-store.js';

const NOW = '2026-09-03T16:00:01.000Z';
const TICK_AT = '2026-09-03T16:00:00.000Z';
const BUNDLE_DIGEST = '2'.repeat(64);

const { publicKey } = generateKeyPairSync('ed25519');
const publicKeySpki = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
const keyId = agentOsSourceTrustKeyIdV1(publicKeySpki, 'source-observer')!;
const policy: AgentOsSourceTrustPolicyV1 = Object.freeze({
  schemaVersion: 1,
  protocol: 'ashlr-agent-os-source-trust-v1',
  generation: 1,
  keys: Object.freeze([{
    keyId,
    principalDigest: '1'.repeat(64),
    role: 'source-observer',
    signatureAlgorithm: 'ed25519',
    publicKeySpki,
    notBefore: '2026-09-01T00:00:00.000Z',
    notAfter: '2026-09-10T00:00:00.000Z',
    revokedAt: null,
  }]),
});
const policyDigest = agentOsSourceTrustPolicyDigestV1(policy)!;

function config(enabled = true): AshlrConfig {
  return {
    daemon: {
      agentOsObserver: enabled ? { enabled: true, deadlineMs: 5_000, trustPolicy: policy } : { enabled: false },
    },
  } as unknown as AshlrConfig;
}

function tick(overrides: Partial<DaemonTick> = {}): DaemonTick {
  return {
    ts: TICK_AT,
    itemsConsidered: 0,
    proposalsCreated: 0,
    spentUsd: 0,
    reason: 'ok',
    ...overrides,
  };
}

const bundleEnvelope = Object.freeze({ bundleDigest: BUNDLE_DIGEST, sequence: 1 });

function source(
  sourceState: 'missing' | 'healthy' | 'degraded' = 'healthy',
): AgentOsSourceBundleStoreReadResultV1 {
  const healthy = sourceState === 'healthy';
  return {
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: healthy,
    bundles: healthy ? [bundleEnvelope as never] : [],
    current: healthy ? { bundleDigest: BUNDLE_DIGEST } as never : null,
    stopReasons: sourceState === 'degraded' ? ['current-policy-verification-failed'] : [],
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    limitExceeded: false,
    authority: 'observation-only',
    planningAuthority: false,
    executionAuthority: false,
    proposalAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deployAuthority: false,
    publicationAuthority: false,
    externalMutationAuthority: false,
  };
}

class FakeChild extends EventEmitter {
  pid = 4321;
  killResult = true;
  kills: Array<NodeJS.Signals | number | undefined> = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    return this.killResult;
  }
}

function schedulerDeps(child: FakeChild) {
  return {
    now: () => Date.parse(NOW),
    killSwitchOn: () => false,
    readSource: vi.fn(() => source()),
    attemptState: vi.fn(() => ({ state: 'missing' as const })),
    spawn: vi.fn(() => child),
    invocation: vi.fn((args: readonly string[]) => ({ command: '/node', args: [...args] })),
  };
}

describe('M543 default-off Agent OS observer scheduler', () => {
  it('is inert by default and rejects enabled configuration without trust roots', () => {
    expect(resolveAgentOsObserverConfigV1({} as AshlrConfig)).toMatchObject({ enabled: false, valid: true });
    expect(scheduleAgentOsObserverV1({ tick: tick(), config: {} as AshlrConfig })).toMatchObject({
      disposition: 'disabled', attemptId: null, sourceState: 'not-read',
    });
    expect(resolveAgentOsObserverConfigV1({
      daemon: { agentOsObserver: { enabled: true } },
    } as AshlrConfig)).toMatchObject({ enabled: true, valid: false, trustPolicy: null });
  });

  it('derives a stable canonical UUIDv4 attempt from the complete durable tick', () => {
    const first = agentOsDurableTickDigestV1(tick())!;
    const reordered = {
      reason: 'ok', spentUsd: 0, proposalsCreated: 0, itemsConsidered: 0, ts: TICK_AT,
    } as DaemonTick;
    expect(agentOsDurableTickDigestV1(reordered)).toBe(first);
    expect(agentOsDurableTickDigestV1(tick({ spentUsd: 1 }))).not.toBe(first);
    expect(agentOsObserverAttemptIdForTickV1(first)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('reports missing and degraded verified source stores without spawning', () => {
    for (const state of ['missing', 'degraded'] as const) {
      const child = new FakeChild();
      const deps = schedulerDeps(child);
      deps.readSource.mockReturnValue(source(state));
      expect(scheduleAgentOsObserverV1({ tick: tick(), config: config(), deps })).toMatchObject({
        disposition: state === 'missing' ? 'source-missing' : 'source-degraded',
        sourceState: state,
      });
      expect(readAgentOsObserverSchedulerStatusV1()).toMatchObject({
        durable: false,
        active: false,
        lastDisposition: state === 'missing' ? 'source-missing' : 'source-degraded',
        sourceState: state,
      });
      expect(deps.spawn).not.toHaveBeenCalled();
    }
  });

  it('regenerates only a wholly missing snapshot ledger and surfaces corrupted snapshot state', () => {
    const repairChild = new FakeChild();
    const repairDeps = schedulerDeps(repairChild);
    repairDeps.attemptState.mockReturnValue({ state: 'snapshot-repair-required' });
    const repair = scheduleAgentOsObserverV1({ tick: tick(), config: config(), deps: repairDeps });
    expect(repair).toMatchObject({
      disposition: 'scheduled',
      sourceStopReasons: expect.arrayContaining(['snapshot-repair-required']),
    });
    repairChild.emit('close', 0, null);

    const degradedChild = new FakeChild();
    const degradedDeps = schedulerDeps(degradedChild);
    degradedDeps.attemptState.mockReturnValue({ state: 'snapshot-store-degraded' });
    expect(scheduleAgentOsObserverV1({ tick: tick(), config: config(), deps: degradedDeps })).toMatchObject({
      disposition: 'snapshot-store-degraded',
      sourceStopReasons: expect.arrayContaining(['snapshot-store-degraded']),
    });
    expect(degradedDeps.spawn).not.toHaveBeenCalled();
  });

  it('schedules one bounded child with exact tick/source lineage and an allowlisted environment', async () => {
    const child = new FakeChild();
    const deps = schedulerDeps(child);
    const scheduled = scheduleAgentOsObserverV1({ tick: tick(), config: config(), deps });
    const digest = agentOsDurableTickDigestV1(tick())!;
    const attemptId = agentOsObserverAttemptIdForTickV1(digest)!;

    expect(scheduled).toMatchObject({
      disposition: 'scheduled', attemptId, tickDigest: digest, sourceState: 'healthy',
    });
    expect(deps.invocation).toHaveBeenCalledWith([
      attemptId,
      digest,
      TICK_AT,
      '2026-09-03T16:00:06.000Z',
      BUNDLE_DIGEST,
      policyDigest,
    ]);
    const spawnOptions = deps.spawn.mock.calls[0]?.[2];
    expect(spawnOptions).toMatchObject({ detached: false, stdio: 'ignore', windowsHide: true });
    expect(spawnOptions?.env).toEqual(expect.objectContaining({ ASHLR_AGENT_OS_OBSERVER_CHILD: '1' }));
    child.emit('close', 0, null);
    await expect(scheduled.completion).resolves.toEqual({ outcome: 'completed', code: 0, signal: null });
  });

  it('suppresses overlap, remembers terminal attempts, and cancels through AbortSignal', async () => {
    const child = new FakeChild();
    const deps = schedulerDeps(child);
    const controller = new AbortController();
    const first = scheduleAgentOsObserverV1({ tick: tick(), config: config(), signal: controller.signal, deps });
    const overlap = scheduleAgentOsObserverV1({ tick: tick({ ts: NOW }), config: config(), deps });
    expect(overlap.disposition).toBe('overlap-suppressed');
    expect(overlap.completion).toBe(first.completion);
    overlap.cancel();
    expect(child.kills).toEqual([]);
    controller.abort();
    expect(child.kills).toContain('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await expect(first.completion).resolves.toMatchObject({ outcome: 'cancelled' });

    const completedChild = new FakeChild();
    const completedDeps = schedulerDeps(completedChild);
    completedDeps.attemptState.mockReturnValue({ state: 'source-observed' });
    expect(scheduleAgentOsObserverV1({ tick: tick(), config: config(), deps: completedDeps })).toMatchObject({
      disposition: 'already-observed',
    });
    expect(completedDeps.spawn).not.toHaveBeenCalled();
  });

  it('keeps an already-spawned child referenced and tracked until close', async () => {
    const child = new FakeChild();
    const deps = schedulerDeps(child);
    const scheduled = scheduleAgentOsObserverV1({ tick: tick(), config: config(), deps });
    expect(scheduled.disposition).toBe('scheduled');
    child.emit('close', 0, null);
    await expect(scheduled.completion).resolves.toMatchObject({ outcome: 'completed' });
  });

  it('does not fabricate child exit after TERM/KILL or permit overlap before close', async () => {
    const child = new FakeChild();
    child.killResult = false;
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const deps = {
      ...schedulerDeps(child),
      setTimeout: vi.fn((callback: () => void, delayMs: number) => {
        timers.push({ callback, delayMs });
        return { delayMs } as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimeout: vi.fn(),
    };
    const scheduled = scheduleAgentOsObserverV1({ tick: tick(), config: config(), deps });
    scheduled.cancel();
    expect(child.kills).toEqual(['SIGTERM']);
    timers.find((entry) => entry.delayMs === 1_000)!.callback();
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(readAgentOsObserverSchedulerStatusV1()).toMatchObject({
      active: true,
      childOutcome: 'degraded-stuck',
    });
    const overlap = scheduleAgentOsObserverV1({ tick: tick({ ts: NOW }), config: config(), deps });
    expect(overlap.disposition).toBe('overlap-suppressed');

    let completed = false;
    void scheduled.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    child.emit('close', null, 'SIGKILL');
    await expect(scheduled.completion).resolves.toMatchObject({ outcome: 'cancelled', signal: 'SIGKILL' });
    expect(readAgentOsObserverSchedulerStatusV1()).toMatchObject({ active: false, childOutcome: 'cancelled' });
  });

  it('treats a child error as degraded until close proves process release', async () => {
    const child = new FakeChild();
    const deps = schedulerDeps(child);
    const scheduled = scheduleAgentOsObserverV1({ tick: tick(), config: config(), deps });
    child.emit('error', new Error('kill failed'));
    expect(readAgentOsObserverSchedulerStatusV1()).toMatchObject({
      active: true,
      childOutcome: 'degraded-stuck',
    });
    expect(scheduleAgentOsObserverV1({ tick: tick({ ts: NOW }), config: config(), deps }).disposition)
      .toBe('overlap-suppressed');
    child.emit('close', null, null);
    await expect(scheduled.completion).resolves.toMatchObject({ outcome: 'failed' });
  });

  it('resumes an open attempt with exact persisted deadline and source bindings', () => {
    const child = new FakeChild();
    const timerDelays: number[] = [];
    const deps = {
      ...schedulerDeps(child),
      setTimeout: vi.fn((callback: () => void, delayMs: number) => {
        timerDelays.push(delayMs);
        return { callback, delayMs } as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimeout: vi.fn(),
    };
    deps.attemptState.mockReturnValue({
      state: 'resume-started',
      attemptId: '018f3f6a-7c21-4f2a-9b5c-0123456789ab',
      tickDigest: '7'.repeat(64),
      tickAt: '2026-09-03T15:59:00.000Z',
      deadlineAt: '2026-09-03T15:59:05.000Z',
      bundleDigest: BUNDLE_DIGEST,
    });
    const scheduled = scheduleAgentOsObserverV1({ tick: tick(), config: config(), deps });
    expect(scheduled).toMatchObject({
      disposition: 'scheduled',
      attemptId: '018f3f6a-7c21-4f2a-9b5c-0123456789ab',
      tickDigest: '7'.repeat(64),
    });
    expect(deps.invocation).toHaveBeenCalledWith([
      '018f3f6a-7c21-4f2a-9b5c-0123456789ab',
      '7'.repeat(64),
      '2026-09-03T15:59:00.000Z',
      '2026-09-03T15:59:05.000Z',
      BUNDLE_DIGEST,
      policyDigest,
    ]);
    expect(timerDelays).toEqual([1]);
    child.emit('close', 1, null);
  });

  it('does not inherit ambient credential or provider variables into the child', () => {
    expect(agentOsObserverChildEnvironmentV1({
      HOME: '/Users/example',
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      NODE_OPTIONS: '--require hostile.js',
      ASHLR_IN_DAEMON: '1',
    })).toEqual({
      ASHLR_AGENT_OS_OBSERVER_CHILD: '1',
      HOME: '/Users/example',
      PATH: '/usr/bin',
    });
  });

  it('does not forward arbitrary parent preload hooks into the development child', () => {
    const prior = process.execArgv;
    process.execArgv = ['--require=hostile.cjs', '--import=hostile.mjs', '--import', 'tsx'];
    try {
      const invocation = agentOsObserverChildInvocationV1(['attempt']);
      expect(invocation.args).not.toContain('--require=hostile.cjs');
      expect(invocation.args).not.toContain('--import=hostile.mjs');
      expect(invocation.args).toContain('--import');
      expect(invocation.args).toContain('tsx');
    } finally {
      process.execArgv = prior;
    }
  });

  it('integrates only after a successful durable resident tick and awaits shutdown cancellation', async () => {
    const handle = {
      disposition: 'scheduled' as const,
      attemptId: '018f3f6a-7c21-4f2a-9b5c-0123456789ab',
      tickDigest: '1'.repeat(64),
      sourceState: 'healthy' as const,
      sourceStopReasons: [],
      completion: Promise.resolve({ outcome: 'cancelled' as const, code: null, signal: null }),
      cancel: vi.fn(),
    };
    const schedule = vi.fn(() => handle);
    const durableTick = tick();
    expect(scheduleAgentOsObserverAfterTick(
      durableTick, config(), { dryRun: false, once: false }, schedule, () => false,
    )).toBeNull();
    expect(scheduleAgentOsObserverAfterTick(
      durableTick, config(), { dryRun: false, once: false }, schedule, () => false, () => true,
    )).toBe(handle);
    expect(schedule).toHaveBeenCalledWith({ tick: tick(), config: config() });
    expect(scheduleAgentOsObserverAfterTick(
      tick(), config(), { dryRun: true, once: false }, schedule, () => false,
    )).toBeNull();
    expect(scheduleAgentOsObserverAfterTick(
      tick({ reason: 'state-persistence-failed' }), config(), { dryRun: false, once: false }, schedule, () => false,
    )).toBeNull();

    await cancelDaemonPostTickChildren(null, null, handle);
    expect(handle.cancel).toHaveBeenCalledOnce();
  });
});

describe('M543 Agent OS observer child runtime', () => {
  function childArgs(): string[] {
    const digest = agentOsDurableTickDigestV1(tick())!;
    return [
      agentOsObserverAttemptIdForTickV1(digest)!,
      digest,
      TICK_AT,
      '2026-09-03T16:00:06.000Z',
      BUNDLE_DIGEST,
      policyDigest,
    ];
  }

  function childDependencies(observe: ReturnType<typeof vi.fn>) {
    return {
      loadConfig: vi.fn(() => config()),
      killSwitchOn: vi.fn(() => false),
      clock: () => new Date(NOW),
      sourceStore: vi.fn(() => ({
        anchorPath: '/private/test', rootPath: '/private/test/source', trustPolicy: policy, clock: () => new Date(NOW),
      })),
      readSource: vi.fn(() => source()),
      readDurableTicks: vi.fn(() => [tick()]),
      withCurrentSource: vi.fn((_digest, _dependencies, consume) => ({
        state: 'held' as const,
        current: source().current!,
        value: consume(source().current!),
      })),
      attemptStore: vi.fn(() => ({
        anchorPath: '/private/test', rootPath: '/private/test/attempts', key: Buffer.alloc(32),
      })),
      snapshotStore: vi.fn(() => ({
        anchorPath: '/private/test', rootPath: '/private/test/snapshots', signer: null, verifier: null,
        readModelVerifier: null, clock: () => new Date(NOW),
      })),
      observe,
    };
  }

  it('reads only the current verified bundle and passes exact runtime bindings', () => {
    const observe = vi.fn(() => ({
      disposition: 'completed', terminalPersisted: true,
    } as AgentOsObserverResultV1));
    const deps = childDependencies(observe);
    expect(runAgentOsObserverChildV1(childArgs(), deps)).toBe(0);
    expect(deps.readSource).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: childArgs()[0],
      initiatingTickDigest: childArgs()[1],
      initiatingTickAt: TICK_AT,
      deadlineAt: '2026-09-03T16:00:06.000Z',
      sourceBundle: bundleEnvelope,
    }), expect.objectContaining({
      sourceTrustPolicy: policy,
      attemptStore: expect.any(Object),
      snapshotStore: expect.any(Object),
    }));
    expect(observe.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });

  it('rejects fabricated or mismatched durable tick provenance before observation', () => {
    const observe = vi.fn();
    const deps = childDependencies(observe);
    deps.readDurableTicks.mockReturnValue([]);
    expect(runAgentOsObserverChildV1(childArgs(), deps)).toBe(1);
    expect(observe).not.toHaveBeenCalled();

    const mismatched = [...childArgs()];
    mismatched[0] = '018f3f6a-7c21-4f2a-9b5c-0123456789ab';
    expect(runAgentOsObserverChildV1(mismatched, childDependencies(observe))).toBe(1);
    expect(observe).not.toHaveBeenCalled();
  });

  it('does not let a real generic open-attempt receipt replace durable tick provenance', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'ashlr-observer-provenance-'));
    try {
      const attemptStore = {
        anchorPath: temporary,
        rootPath: join(temporary, 'attempts'),
        key: Buffer.alloc(32, 0x45),
      };
      expect(beginAgentOsObserverAttemptV1({
        attemptId: childArgs()[0]!,
        initiatingTickDigest: childArgs()[1]!,
        initiatingTickAt: TICK_AT,
        bundleDigest: BUNDLE_DIGEST,
        startedAt: TICK_AT,
        deadlineAt: '2026-09-03T16:00:06.000Z',
      }, attemptStore).disposition).toBe('recorded');
      const observe = vi.fn();
      const deps = {
        ...childDependencies(observe),
        attemptStore: vi.fn(() => attemptStore),
        readDurableTicks: vi.fn(() => []),
      };
      expect(runAgentOsObserverChildV1(childArgs(), deps)).toBe(1);
      expect(observe).not.toHaveBeenCalled();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('refuses absent, stale, or changed source state without synthesizing input', () => {
    for (const current of [source('missing'), source('degraded'), {
      ...source(), current: { bundleDigest: '9'.repeat(64) },
    } as AgentOsSourceBundleStoreReadResultV1]) {
      const observe = vi.fn();
      const deps = childDependencies(observe);
      deps.readSource.mockReturnValue(current);
      expect(runAgentOsObserverChildV1(childArgs(), deps)).toBe(1);
      expect(observe).not.toHaveBeenCalled();
    }
  });

  it('rechecks KILL and configuration revocation through the observer kill gate', () => {
    const observe = vi.fn((_input, deps) => ({
      disposition: deps.killCheck() ? 'cancelled-before-commit' : 'completed',
      terminalPersisted: true,
    } as AgentOsObserverResultV1));
    const deps = childDependencies(observe);
    deps.loadConfig
      .mockReturnValueOnce(config())
      .mockReturnValueOnce(config(false));
    expect(runAgentOsObserverChildV1(childArgs(), deps)).toBe(1);
    expect(observe).toHaveBeenCalledOnce();
  });

  it('rechecks exact current source freshness immediately before observer commit gates', () => {
    const observe = vi.fn((_input, deps) => ({
      disposition: deps.killCheck() ? 'cancelled-before-commit' : 'completed',
      terminalPersisted: true,
    } as AgentOsObserverResultV1));
    const deps = childDependencies(observe);
    deps.readSource
      .mockReturnValueOnce(source())
      .mockReturnValueOnce({
        ...source(),
        current: { bundleDigest: '9'.repeat(64) } as never,
      });
    expect(runAgentOsObserverChildV1(childArgs(), deps)).toBe(1);
    expect(deps.readSource).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledOnce();
  });

  it('terminalizes an exact superseded open attempt without publishing a snapshot', () => {
    const observe = vi.fn();
    const completeAttempt = vi.fn(() => ({
      disposition: 'recorded' as const,
      receipt: {} as never,
    }));
    const deps = { ...childDependencies(observe), completeAttempt };
    deps.readSource.mockReturnValue({
      ...source(),
      bundles: [bundleEnvelope as never, { bundleDigest: '9'.repeat(64), sequence: 2 } as never],
      current: { bundleDigest: '9'.repeat(64) } as never,
    });
    expect(runAgentOsObserverChildV1(childArgs(), deps)).toBe(0);
    expect(completeAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: childArgs()[0],
      bundleDigest: BUNDLE_DIGEST,
      outcome: 'cancelled-before-commit',
      snapshotDigest: null,
    }), expect.any(Object));
    expect(observe).not.toHaveBeenCalled();
    expect(deps.snapshotStore).not.toHaveBeenCalled();
  });
});

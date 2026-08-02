import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LAUNCHD_RETRY_MAX_ATTEMPTS,
  LAUNCHD_RETRY_WINDOW_MS,
  runLaunchdRetryController,
} from '../src/core/daemon/launchd-retry-controller.js';
import type { DaemonRunResult } from '../src/core/daemon/loop.js';

const RELEASE_A = 'a'.repeat(40);
const RELEASE_B = 'b'.repeat(40);

function daemonResult(
  reason: DaemonRunResult['termination']['reason'],
  retryable: boolean,
): DaemonRunResult {
  return {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks: [],
    ...(retryable ? { startRefusal: 'fixture-pre-effect-refusal' } : {}),
    termination: {
      reason,
      retryable,
      exitCode: retryable ? 1 : 0,
      ...(retryable ? { diagnosticCode: 'state-io-transient' as const } : {}),
    },
  };
}

describe('M470 bounded launchd retry controller', () => {
  let home: string;
  let nowMs: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-launchd-retry-'));
    chmodSync(home, 0o700);
    nowMs = 10_000;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function run(
    runDaemon: () => Promise<DaemonRunResult>,
    overrides: Partial<Parameters<typeof runLaunchdRetryController>[0]> = {},
  ) {
    return runLaunchdRetryController({
      expectedReleaseRevision: RELEASE_A,
      runtimeReleaseRevision: RELEASE_A,
      runtimeReleaseTrusted: true,
      platform: 'darwin',
      homeDir: home,
      now: () => nowMs,
      killSwitchState: () => ({
        state: 'inactive',
        sourceState: 'healthy',
        reason: 'missing',
        path: join(home, '.ashlr', 'KILL'),
      }),
      runDaemon,
      ...overrides,
    });
  }

  it('durably claims exactly three attempts and returns terminal zero after exhaustion', async () => {
    const runDaemon = vi.fn(async () => daemonResult('persistence-failure', true));

    expect(await run(runDaemon)).toMatchObject({
      exitCode: 1, reason: 'retry-authorized', claimNumber: 1, attemptsRemaining: 2,
    });
    nowMs++;
    expect(await run(runDaemon)).toMatchObject({
      exitCode: 1, reason: 'retry-authorized', claimNumber: 2, attemptsRemaining: 1,
    });
    nowMs++;
    expect(await run(runDaemon)).toMatchObject({
      exitCode: 0, reason: 'retry-exhausted', claimNumber: 3, attemptsRemaining: 0,
    });
    nowMs++;
    expect(await run(runDaemon)).toMatchObject({
      exitCode: 0, reason: 'retry-exhausted', daemonInvoked: false, attemptsRemaining: 0,
    });
    expect(runDaemon).toHaveBeenCalledTimes(LAUNCHD_RETRY_MAX_ATTEMPTS);

    const root = join(home, '.ashlr', 'daemon-supervision');
    const key = join(root, 'launchd-retry.ed25519.pem');
    const state = join(root, 'launchd-retry.json');
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(statSync(state).mode & 0o777).toBe(0o600);
    const envelope = JSON.parse(readFileSync(state, 'utf8')) as Record<string, unknown>;
    expect(envelope).toEqual(expect.objectContaining({ signature: expect.any(String) }));
    expect((envelope['state'] as { claims: unknown[] }).claims).toHaveLength(3);
  });

  it('does not renew an expired failure window', async () => {
    const runDaemon = vi.fn(async () => daemonResult('persistence-failure', true));
    expect((await run(runDaemon)).exitCode).toBe(1);
    nowMs += LAUNCHD_RETRY_WINDOW_MS + 1;

    expect(await run(runDaemon)).toMatchObject({
      exitCode: 0, reason: 'retry-window-expired', daemonInvoked: false,
    });
    expect(runDaemon).toHaveBeenCalledOnce();
  });

  it('resets only after an exact healthy completion returned by the owned daemon call', async () => {
    const retry = vi.fn(async () => daemonResult('persistence-failure', true));
    expect((await run(retry)).claimNumber).toBe(1);
    nowMs++;
    expect(await run(async () => daemonResult('clean-completion', false))).toMatchObject({
      exitCode: 0,
      reason: 'healthy-completion',
      daemonInvoked: true,
      attemptsRemaining: LAUNCHD_RETRY_MAX_ATTEMPTS,
    });
    nowMs++;
    expect(await run(retry)).toMatchObject({ claimNumber: 1, attemptsRemaining: 2 });
  });

  it('consumes a claim when the process fails between claim persistence and daemon completion', async () => {
    expect(await run(async () => { throw new Error('crash before daemon disposition'); })).toMatchObject({
      exitCode: 0, reason: 'daemon-disposition-invalid', daemonInvoked: true, claimNumber: 1,
    });
    nowMs++;
    expect(await run(async () => daemonResult('persistence-failure', true))).toMatchObject({
      exitCode: 1, reason: 'retry-authorized', claimNumber: 2,
    });
  });

  it('serializes concurrent launches and gives the contender no daemon authority', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstRun = vi.fn(async () => {
      await held;
      return daemonResult('clean-completion', false);
    });
    const secondRun = vi.fn(async () => daemonResult('clean-completion', false));

    const first = run(firstRun);
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledOnce());
    expect(await run(secondRun)).toMatchObject({
      exitCode: 0, reason: 'concurrent-launch', daemonInvoked: false,
    });
    expect(secondRun).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toMatchObject({ reason: 'healthy-completion' });
  });

  it('fails closed for explicit stop before claim and for a KILL race after claim', async () => {
    const runDaemon = vi.fn(async () => daemonResult('clean-completion', false));
    expect(await run(runDaemon, {
      killSwitchState: () => ({
        state: 'active', sourceState: 'healthy', reason: 'present', path: join(home, '.ashlr', 'KILL'),
      }),
    })).toMatchObject({ exitCode: 0, reason: 'operator-stop', daemonInvoked: false, claimNumber: null });

    let reads = 0;
    expect(await run(runDaemon, {
      killSwitchState: () => ({
        state: ++reads >= 3 ? 'active' : 'inactive',
        sourceState: 'healthy',
        reason: reads >= 3 ? 'present' : 'missing',
        path: join(home, '.ashlr', 'KILL'),
      }),
    })).toMatchObject({ exitCode: 0, reason: 'operator-stop', daemonInvoked: false, claimNumber: 1 });
    expect(runDaemon).not.toHaveBeenCalled();
  });

  it('refuses stale releases, rollback clocks, unsupported platforms, and invalid dispositions', async () => {
    const runDaemon = vi.fn(async () => daemonResult('persistence-failure', true));
    expect(await run(runDaemon, { expectedReleaseRevision: RELEASE_B })).toMatchObject({
      exitCode: 0, reason: 'stale-release', daemonInvoked: false,
    });
    expect(await run(runDaemon, { runtimeReleaseTrusted: false })).toMatchObject({
      exitCode: 0, reason: 'stale-release', daemonInvoked: false,
    });
    expect(await run(runDaemon, { platform: 'linux' })).toMatchObject({
      exitCode: 0, reason: 'unsupported-platform', daemonInvoked: false,
    });
    expect((await run(runDaemon)).exitCode).toBe(1);
    nowMs--;
    expect(await run(runDaemon)).toMatchObject({
      exitCode: 0, reason: 'clock-rollback', daemonInvoked: false,
    });
    nowMs += 2;
    expect(await run(async () => ({
      ...daemonResult('persistence-failure', true),
      termination: { reason: 'persistence-failure', retryable: true, exitCode: 0 },
    } as unknown as DaemonRunResult))).toMatchObject({
      exitCode: 0, reason: 'daemon-disposition-invalid', daemonInvoked: true,
    });
  });

  it('refuses missing half-state and corrupt signed state without recreating authority', async () => {
    const retry = async () => daemonResult('persistence-failure', true);
    expect((await run(retry)).exitCode).toBe(1);
    const statePath = join(home, '.ashlr', 'daemon-supervision', 'launchd-retry.json');
    unlinkSync(statePath);
    expect(await run(retry)).toMatchObject({
      exitCode: 0, reason: 'state-unavailable', daemonInvoked: false,
    });

    rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(join(tmpdir(), 'ashlr-launchd-retry-'));
    chmodSync(home, 0o700);
    expect((await run(retry)).exitCode).toBe(1);
    const corruptPath = join(home, '.ashlr', 'daemon-supervision', 'launchd-retry.json');
    const envelope = JSON.parse(readFileSync(corruptPath, 'utf8')) as { signature: string };
    envelope.signature = Buffer.alloc(64, 7).toString('base64');
    writeFileSync(corruptPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    chmodSync(corruptPath, 0o600);
    expect(await run(retry)).toMatchObject({
      exitCode: 0, reason: 'state-corrupt', daemonInvoked: false,
    });
  });

  it('binds persisted state to one exact release revision', async () => {
    expect((await run(async () => daemonResult('persistence-failure', true))).exitCode).toBe(1);
    expect(await run(async () => daemonResult('clean-completion', false), {
      expectedReleaseRevision: RELEASE_B,
      runtimeReleaseRevision: RELEASE_B,
    })).toMatchObject({ exitCode: 0, reason: 'stale-release', daemonInvoked: false });
  });
});

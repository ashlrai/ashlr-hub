import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trustPolicyFixture = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('../src/core/daemon/launchd-retry-trust-roots.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/daemon/launchd-retry-trust-roots.js')>();
  return {
    ...actual,
    readLaunchdRetryTrustPolicy: () =>
      trustPolicyFixture.current ?? actual.LAUNCHD_RETRY_TRUST_POLICY,
  };
});

import {
  LAUNCHD_RETRY_RECEIPT_PROTOCOL,
  LAUNCHD_RETRY_SERVICE_IDENTITY,
  canonicalLaunchdRetryEpochReceiptPayload,
  launchdRetryAuthorityKeyId,
  launchdRetryTrustPolicyDigest,
  verifyLaunchdRetryEpochReceipt,
  type LaunchdRetryEpochReceipt,
  type LaunchdRetryEpochReceiptUnsigned,
} from '../src/core/daemon/launchd-retry-authority.js';
import {
  LAUNCHD_RETRY_MAX_ATTEMPTS,
  LAUNCHD_RETRY_WINDOW_MS,
  runLaunchdRetryController,
  type LaunchdRetryCasRequest,
  type LaunchdRetryExternalAuthority,
} from '../src/core/daemon/launchd-retry-controller.js';
import {
  LAUNCHD_RETRY_SIGNATURE_ALGORITHM,
  LAUNCHD_RETRY_SIGNER_ROLE,
  LAUNCHD_RETRY_TRUST_PROTOCOL,
  type LaunchdRetryTrustPolicy,
} from '../src/core/daemon/launchd-retry-trust-roots.js';
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

function signedReceipt(
  unsigned: LaunchdRetryEpochReceiptUnsigned,
  privateKey: KeyObject,
): LaunchdRetryEpochReceipt {
  const payload = canonicalLaunchdRetryEpochReceiptPayload(unsigned);
  if (!payload) throw new Error('invalid receipt fixture');
  return { ...unsigned, signature: sign(null, payload, privateKey).toString('base64url') };
}

interface ExternalStore {
  current: LaunchdRetryEpochReceipt;
  compareAndSwap: ReturnType<typeof vi.fn<(request: LaunchdRetryCasRequest) => Promise<{
    status: 'committed' | 'conflict' | 'unavailable';
    receipt?: LaunchdRetryEpochReceipt;
  }>>>;
}

describe('M470 externally anchored launchd retry controller', () => {
  let home: string;
  let nowMs: number;
  let privateKey: KeyObject;
  let policy: LaunchdRetryTrustPolicy;
  let store: ExternalStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-launchd-retry-'));
    chmodSync(home, 0o700);
    nowMs = 10_000;
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    const publicKeySpki = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' }))
      .toString('base64url');
    const keyId = launchdRetryAuthorityKeyId(publicKeySpki)!;
    policy = {
      schemaVersion: 1,
      protocol: LAUNCHD_RETRY_TRUST_PROTOCOL,
      policyGeneration: 1,
      roots: [{
        keyId,
        publicKeySpki,
        signerRole: LAUNCHD_RETRY_SIGNER_ROLE,
        signatureAlgorithm: LAUNCHD_RETRY_SIGNATURE_ALGORITHM,
        notBeforeMs: 0,
        notAfterMs: Number.MAX_SAFE_INTEGER,
        revokedAtMs: null,
      }],
    };
    trustPolicyFixture.current = policy;
    const trustPolicyDigest = launchdRetryTrustPolicyDigest(policy)!;
    const initial = signedReceipt({
      schemaVersion: 1,
      protocol: LAUNCHD_RETRY_RECEIPT_PROTOCOL,
      serviceIdentity: LAUNCHD_RETRY_SERVICE_IDENTITY,
      releaseRevision: RELEASE_A,
      epoch: 1,
      sequence: 0,
      transition: 'initialize',
      claimCount: 0,
      windowStartedAtMs: nowMs,
      maxObservedAtMs: nowMs,
      previousReceiptDigest: null,
      trustPolicyDigest,
      policyGeneration: policy.policyGeneration,
      keyId,
      signerRole: LAUNCHD_RETRY_SIGNER_ROLE,
      signatureAlgorithm: LAUNCHD_RETRY_SIGNATURE_ALGORITHM,
    }, privateKey);
    store = {
      current: initial,
      compareAndSwap: vi.fn(async (request: LaunchdRetryCasRequest) => {
        const verified = verifyLaunchdRetryEpochReceipt(store.current, {
          releaseRevision: RELEASE_A,
          serviceIdentity: LAUNCHD_RETRY_SERVICE_IDENTITY,
          nowMs,
        }, policy);
        if (!verified.ok || request.expectedReceiptDigest !== verified.value.receiptDigest) {
          return { status: 'conflict' as const };
        }
        const next = signedReceipt({
          schemaVersion: 1,
          protocol: LAUNCHD_RETRY_RECEIPT_PROTOCOL,
          serviceIdentity: request.serviceIdentity,
          releaseRevision: request.releaseRevision,
          epoch: request.nextEpoch,
          sequence: request.nextSequence,
          transition: request.action === 'claim' ? 'claim' : 'healthy-reset',
          claimCount: request.nextClaimCount,
          windowStartedAtMs: request.nextWindowStartedAtMs,
          maxObservedAtMs: request.nextMaxObservedAtMs,
          previousReceiptDigest: request.expectedReceiptDigest,
          trustPolicyDigest,
          policyGeneration: policy.policyGeneration,
          keyId,
          signerRole: LAUNCHD_RETRY_SIGNER_ROLE,
          signatureAlgorithm: LAUNCHD_RETRY_SIGNATURE_ALGORITHM,
        }, privateKey);
        store.current = next;
        return { status: 'committed' as const, receipt: next };
      }),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function authority(receipt: unknown = store.current): LaunchdRetryExternalAuthority {
    return { currentReceipt: receipt, compareAndSwap: store.compareAndSwap };
  }

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
      externalAuthority: authority(),
      runDaemon,
      ...overrides,
    });
  }

  it('ships dormant without an external CAS transport and creates no local authority', async () => {
    const runDaemon = vi.fn(async () => daemonResult('persistence-failure', true));
    expect(await run(runDaemon, { externalAuthority: undefined })).toMatchObject({
      exitCode: 0,
      reason: 'external-retry-transport-unavailable',
      externalAuthority: 'blocked',
      daemonInvoked: false,
    });
    expect(runDaemon).not.toHaveBeenCalled();
    expect(store.compareAndSwap).not.toHaveBeenCalled();
    expect(() => statSync(join(home, '.ashlr', 'daemon-supervision'))).toThrow();
  });

  it('refuses empty trust, missing receipts, unavailable CAS, and invalid signatures', async () => {
    const runDaemon = vi.fn(async () => daemonResult('persistence-failure', true));
    trustPolicyFixture.current = {
      schemaVersion: 1,
      protocol: LAUNCHD_RETRY_TRUST_PROTOCOL,
      policyGeneration: 0,
      roots: [],
    };
    expect(await run(runDaemon)).toMatchObject({
      reason: 'external-retry-trust-unprovisioned', exitCode: 0,
    });
    trustPolicyFixture.current = policy;
    expect(await run(runDaemon, {
      externalAuthority: { ...authority(), currentReceipt: undefined },
    })).toMatchObject({ reason: 'external-retry-receipt-invalid', exitCode: 0 });
    expect(await run(runDaemon, {
      externalAuthority: {
        ...authority(),
        compareAndSwap: async () => ({ status: 'unavailable' }),
      },
    })).toMatchObject({ reason: 'external-retry-transport-unavailable', exitCode: 0 });
    expect(await run(runDaemon, {
      externalAuthority: {
        ...authority({ ...store.current, signature: 'A'.repeat(86) }),
      },
    })).toMatchObject({ reason: 'external-retry-receipt-invalid', exitCode: 0 });
    expect(runDaemon).not.toHaveBeenCalled();
  });

  it('ignores caller-minted trust roots and requires deployment-owned roots', async () => {
    trustPolicyFixture.current = {
      schemaVersion: 1,
      protocol: LAUNCHD_RETRY_TRUST_PROTOCOL,
      policyGeneration: 0,
      roots: [],
    };
    const callerAuthority = {
      ...authority(),
      trustPolicy: policy,
    } as unknown as LaunchdRetryExternalAuthority;
    const runDaemon = vi.fn(async () => daemonResult('persistence-failure', true));

    expect(await run(runDaemon, { externalAuthority: callerAuthority })).toMatchObject({
      exitCode: 0,
      reason: 'external-retry-trust-unprovisioned',
      daemonInvoked: false,
    });
    expect(runDaemon).not.toHaveBeenCalled();
    expect(store.compareAndSwap).not.toHaveBeenCalled();
  });

  it('consumes a durable claim before a child spawn or preload failure', async () => {
    expect(await run(async () => {
      throw new Error('child spawn failed');
    })).toMatchObject({
      exitCode: 0,
      reason: 'daemon-disposition-invalid',
      daemonInvoked: true,
      claimNumber: 1,
      attemptsRemaining: 2,
    });
    expect(store.compareAndSwap).toHaveBeenCalledOnce();
    expect(store.current).toMatchObject({ transition: 'claim', claimCount: 1, sequence: 1 });
  });

  it('durably claims exactly three externally committed attempts', async () => {
    const runDaemon = vi.fn(async () => daemonResult('persistence-failure', true));
    expect(await run(runDaemon)).toMatchObject({
      exitCode: 0, reason: 'retry-exhausted', claimNumber: 3, attemptsRemaining: 0,
    });
    nowMs++;
    expect(await run(runDaemon)).toMatchObject({
      exitCode: 0, reason: 'retry-exhausted', daemonInvoked: false, attemptsRemaining: 0,
    });
    expect(runDaemon).toHaveBeenCalledTimes(LAUNCHD_RETRY_MAX_ATTEMPTS);
    expect(store.compareAndSwap).toHaveBeenCalledTimes(LAUNCHD_RETRY_MAX_ATTEMPTS);

    const root = join(home, '.ashlr', 'daemon-supervision');
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'launchd-retry.json')).mode & 0o777).toBe(0o600);
    expect(() => statSync(join(root, 'launchd-retry.ed25519.pem'))).toThrow();
  });

  it('does not renew an expired externally signed failure window', async () => {
    const runDaemon = vi.fn(async () => {
      nowMs += LAUNCHD_RETRY_WINDOW_MS + 1;
      return daemonResult('persistence-failure', true);
    });
    expect(await run(runDaemon)).toMatchObject({
      exitCode: 0, reason: 'retry-window-expired', daemonInvoked: true, claimNumber: 1,
    });
    expect(runDaemon).toHaveBeenCalledOnce();
  });

  it('resets only through a fresh external healthy-reset receipt', async () => {
    let calls = 0;
    expect(await run(async () => {
      calls++;
      nowMs++;
      return calls === 1
        ? daemonResult('persistence-failure', true)
        : daemonResult('clean-completion', false);
    })).toMatchObject({
      reason: 'healthy-completion', claimNumber: 2, attemptsRemaining: 3,
    });
    expect(store.current).toMatchObject({ transition: 'healthy-reset', epoch: 2, claimCount: 0 });
    nowMs++;
    expect(await run(async () => daemonResult('runtime-failure', false))).toMatchObject({
      reason: 'daemon-terminal', claimNumber: 1, attemptsRemaining: 2,
    });
  });

  it('settles malformed config, missing modules, and re-entrancy throws after a durable claim', async () => {
    for (const message of ['malformed config', 'loop module missing', 'daemon re-entrancy']) {
      expect(await run(async () => { throw new Error(message); })).toMatchObject({
        exitCode: 0,
        reason: 'daemon-disposition-invalid',
        daemonInvoked: true,
      });
      nowMs++;
    }
    expect(store.current.claimCount).toBe(3);
  });

  it('serializes overlapping launches and withholds daemon authority from the contender', async () => {
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

  it('fails closed for explicit stop before claim and a KILL race after claim', async () => {
    const runDaemon = vi.fn(async () => daemonResult('clean-completion', false));
    expect(await run(runDaemon, {
      killSwitchState: () => ({
        state: 'active', sourceState: 'healthy', reason: 'present', path: join(home, '.ashlr', 'KILL'),
      }),
    })).toMatchObject({ reason: 'operator-stop', daemonInvoked: false, claimNumber: null });

    let reads = 0;
    expect(await run(runDaemon, {
      killSwitchState: () => ({
        state: ++reads >= 4 ? 'active' : 'inactive',
        sourceState: 'healthy',
        reason: reads >= 4 ? 'present' : 'missing',
        path: join(home, '.ashlr', 'KILL'),
      }),
    })).toMatchObject({ reason: 'operator-stop', daemonInvoked: false, claimNumber: 1 });
    expect(runDaemon).not.toHaveBeenCalled();
  });

  it('does not consume another claim when KILL activates between child attempts', async () => {
    let killed = false;
    const runDaemon = vi.fn(async () => {
      killed = true;
      return daemonResult('persistence-failure', true);
    });
    expect(await run(runDaemon, {
      killSwitchState: () => ({
        state: killed ? 'active' : 'inactive',
        sourceState: 'healthy',
        reason: killed ? 'present' : 'missing',
        path: join(home, '.ashlr', 'KILL'),
      }),
    })).toMatchObject({
      reason: 'operator-stop', daemonInvoked: true, claimNumber: 1, attemptsRemaining: 2,
    });
    expect(runDaemon).toHaveBeenCalledOnce();
    expect(store.compareAndSwap).toHaveBeenCalledOnce();
  });

  it('reports prior child authority when KILL activates after a later claim', async () => {
    let reads = 0;
    const runDaemon = vi.fn(async () => daemonResult('persistence-failure', true));
    expect(await run(runDaemon, {
      killSwitchState: () => ({
        state: ++reads >= 6 ? 'active' : 'inactive',
        sourceState: 'healthy',
        reason: reads >= 6 ? 'present' : 'missing',
        path: join(home, '.ashlr', 'KILL'),
      }),
    })).toMatchObject({
      reason: 'operator-stop', daemonInvoked: true, claimNumber: 2, attemptsRemaining: 1,
    });
    expect(runDaemon).toHaveBeenCalledOnce();
    expect(store.compareAndSwap).toHaveBeenCalledTimes(2);
  });

  it('rejects stale releases, rollback clocks, and invalid daemon dispositions', async () => {
    const runDaemon = vi.fn(async () => daemonResult('runtime-failure', false));
    expect(await run(runDaemon, { expectedReleaseRevision: RELEASE_B })).toMatchObject({
      reason: 'stale-release', daemonInvoked: false,
    });
    expect(await run(runDaemon, { runtimeReleaseTrusted: false })).toMatchObject({
      reason: 'stale-release', daemonInvoked: false,
    });
    expect((await run(runDaemon)).claimNumber).toBe(1);
    nowMs--;
    expect(await run(runDaemon)).toMatchObject({ reason: 'clock-rollback', daemonInvoked: false });
    nowMs += 2;
    expect(await run(async () => ({
      ...daemonResult('persistence-failure', true),
      termination: { reason: 'persistence-failure', retryable: true, exitCode: 0 },
    } as unknown as DaemonRunResult))).toMatchObject({
      reason: 'daemon-disposition-invalid', daemonInvoked: true,
    });
  });

  it('rejects local state replay, current-state deletion, and deleted initialization replay', async () => {
    const retry = async () => daemonResult('runtime-failure', false);
    const initialReceipt = store.current;
    expect((await run(retry)).claimNumber).toBe(1);
    const statePath = join(home, '.ashlr', 'daemon-supervision', 'launchd-retry.json');
    const firstState = readFileSync(statePath);
    const firstReceipt = store.current;
    nowMs++;
    expect((await run(retry)).claimNumber).toBe(2);

    writeFileSync(statePath, firstState, { mode: 0o600 });
    expect(await run(retry)).toMatchObject({ reason: 'external-retry-receipt-replayed', exitCode: 0 });
    expect(await run(retry, { externalAuthority: authority(firstReceipt) })).toMatchObject({
      reason: 'external-retry-receipt-replayed', exitCode: 0,
    });

    unlinkSync(statePath);
    expect(await run(retry)).toMatchObject({ reason: 'retry-state-deleted', exitCode: 0 });
    expect(await run(retry, { externalAuthority: authority(initialReceipt) })).toMatchObject({
      reason: 'external-retry-receipt-replayed', exitCode: 0,
    });
  });

  it('rejects receipt sequence rollback and legacy local signing authority', async () => {
    const retry = async () => daemonResult('runtime-failure', false);
    const initial = store.current;
    expect((await run(retry)).claimNumber).toBe(1);
    expect(await run(retry, { externalAuthority: authority(initial) })).toMatchObject({
      reason: 'external-retry-receipt-replayed', exitCode: 0,
    });
    const legacyKey = join(home, '.ashlr', 'daemon-supervision', 'launchd-retry.ed25519.pem');
    writeFileSync(legacyKey, 'legacy-local-key\n', { mode: 0o600 });
    expect(await run(retry)).toMatchObject({ reason: 'legacy-local-authority-present', exitCode: 0 });
  });
});

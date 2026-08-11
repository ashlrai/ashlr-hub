import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateKey, provenanceKeyPath } from '../src/core/foundry/provenance.js';
import {
  hostMergeRevocationAuthorityId,
  hostMergeRevocationStatePath,
  prepareHostMergeRevocation,
  readHostMergeRevocationState,
  recoverHostMergeRevocation,
  transitionHostMergeRevocation,
  type HostMergeRevocationIdentityV1,
  type HostMergeRevocationWriteResult,
} from '../src/core/autonomy/host-merge-revocation-protocol.js';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
} from '../src/core/fleet/local-store-lock.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const NOW = new Date('2026-07-28T14:00:00.000Z');
const PROTOCOL_MODULE_URL = new URL(
  '../src/core/autonomy/host-merge-revocation-protocol.ts',
  import.meta.url,
).href;
const PRIVATE_STORAGE_MODULE_URL = new URL(
  '../src/core/util/private-storage.ts',
  import.meta.url,
).href;
const CHILD_SOURCE = String.raw`
  import { transitionHostMergeRevocation } from ${JSON.stringify(PROTOCOL_MODULE_URL)};
  import {
    PRIVATE_STORAGE_TEST_CONTROL,
    _setPrivateStorageTestControlForTest,
  } from ${JSON.stringify(PRIVATE_STORAGE_MODULE_URL)};

  if (process.platform === 'win32') {
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      runner: (invocation) => {
        const request = JSON.parse(invocation.input);
        const reason = request.operation === 'assure-private-paths'
          ? 'owned-safe-paths'
          : request.mode === 'inspect-owned'
            ? 'owned-safe-path'
            : 'exact-private-dacl';
        return {
          status: 0,
          stdout: JSON.stringify({
            nonce: request.nonce,
            operation: request.operation,
            ok: true,
            reason,
          }),
        };
      },
    });
  }

  const input = JSON.parse(process.env.TRANSITION_INPUT);
  input.now = new Date(input.now);
  if (!process.send) throw new Error('IPC unavailable');
  process.send({ ready: true });
  process.once('message', (message) => {
    if (!message || message.go !== true) throw new Error('invalid transition signal');
    const result = transitionHostMergeRevocation(input);
    process.send({ result });
    process.disconnect();
  });
`;
let home: string;
const children = new Set<ChildProcess>();
const semanticPrivateStorageRunner: PrivateStorageRunner = (invocation) => {
  const request = JSON.parse(invocation.input) as {
    nonce: string;
    operation: string;
    mode?: 'secure-created' | 'inspect-existing' | 'inspect-owned';
  };
  const reason = request.operation === 'assure-private-paths'
    ? 'owned-safe-paths'
    : request.mode === 'inspect-owned'
      ? 'owned-safe-path'
      : 'exact-private-dacl';
  return {
    status: 0,
    stdout: JSON.stringify({
      nonce: request.nonce,
      operation: request.operation,
      ok: true,
      reason,
    }),
  };
};

function restore(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function identity(overrides: Partial<HostMergeRevocationIdentityV1> = {}): HostMergeRevocationIdentityV1 {
  return {
    nameWithOwner: 'ashlrai/ashlr-hub',
    repositoryId: 'R_kgDOHostMerge',
    baseRef: 'master',
    baseOid: '1'.repeat(40),
    headRef: 'ashlr/proposal-466',
    headOid: '2'.repeat(40),
    pullRequestId: 'PR_kwDOHostMerge',
    pullRequestNumber: 466,
    evidencePackDigest: '3'.repeat(64),
    verifierManifestDigest: '4'.repeat(64),
    protectionPolicyDigest: '5'.repeat(64),
    killEpoch: '6'.repeat(64),
    policyEpoch: '7'.repeat(64),
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function applied(result: HostMergeRevocationWriteResult) {
  expect(result.status).toBe('applied');
  return result.status === 'applied' ? result : (null as never);
}

function prepare(exactIdentity = identity()) {
  return applied(prepareHostMergeRevocation({
    identity: exactIdentity,
    operationId: 'prepare-466',
    now: NOW,
  }));
}

function arm(exactIdentity: HostMergeRevocationIdentityV1, prepared = prepare(exactIdentity)) {
  return applied(transitionHostMergeRevocation({
    identity: exactIdentity,
    action: 'arm',
    operationId: 'arm-466',
    expectedSequence: prepared.record.sequence,
    expectedReceiptDigest: prepared.receipt.receiptDigest,
    now: new Date(NOW.getTime() + 1_000),
  }));
}

function spawnTransition(
  input: Parameters<typeof transitionHostMergeRevocation>[0],
): {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<HostMergeRevocationWriteResult>;
} {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', CHILD_SOURCE],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TRANSITION_INPUT: JSON.stringify(input),
        VITEST: 'true',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.add(child);
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`transition child did not become ready: ${stderr}`));
    }, 10_000);
    child.once('message', (message: { ready?: unknown }) => {
      clearTimeout(timer);
      if (message.ready === true) resolve();
      else reject(new Error(`transition child failed before readiness: ${stderr}`));
    });
    child.once('error', reject);
  });
  const result = new Promise<HostMergeRevocationWriteResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`transition child did not finish: ${stderr}`));
    }, 15_000);
    const onMessage = (message: { result?: HostMergeRevocationWriteResult }) => {
      if (!message.result) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message.result);
    };
    child.on('message', onMessage);
    child.once('error', reject);
    child.once('exit', (code) => {
      children.delete(child);
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`transition child exited ${code}: ${stderr}`));
      }
    });
  });
  return { child, ready, result };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m466-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  _setPrivateStorageTestControlForTest(
    PRIVATE_STORAGE_TEST_CONTROL,
    process.platform === 'win32' ? { runner: semanticPrivateStorageRunner } : undefined,
  );
  loadOrCreateKey();
});

afterEach(async () => {
  try {
    const active = [...children];
    for (const child of active) child.kill();
    await Promise.all(active.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    })));
    children.clear();
    fs.rmSync(home, { recursive: true, force: true });
  } finally {
    restore('HOME', originalHome);
    restore('USERPROFILE', originalUserProfile);
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
  }
});

describe('M466 durable host merge cancellation and revocation protocol foundation', () => {
  it('persists an authenticated prepared -> armed -> revoked receipt chain with no authority', () => {
    const exactIdentity = identity();
    const prepared = prepare(exactIdentity);
    const armed = arm(exactIdentity, prepared);
    const revoked = applied(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'revoke',
      operationId: 'revoke-466',
      expectedSequence: armed.record.sequence,
      expectedReceiptDigest: armed.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 2_000),
    }));

    expect(revoked.record).toMatchObject({
      phase: 'revoked',
      sequence: 3,
      operationalAuthority: false,
      hostAutoMergeEnabled: false,
      receipts: [
        { phase: 'prepared', sequence: 1, previousReceiptDigest: null },
        { phase: 'armed', sequence: 2, previousReceiptDigest: prepared.receipt.receiptDigest },
        { phase: 'revoked', sequence: 3, previousReceiptDigest: armed.receipt.receiptDigest },
      ],
    });
    expect(recoverHostMergeRevocation(exactIdentity)).toMatchObject({
      state: 'healthy',
      record: { phase: 'revoked', operationalAuthority: false, hostAutoMergeEnabled: false },
    });
  });

  it('supports consumed as the only competing terminal state', () => {
    const exactIdentity = identity();
    const armed = arm(exactIdentity);
    const consumed = applied(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'consume',
      operationId: 'consume-466',
      expectedSequence: armed.record.sequence,
      expectedReceiptDigest: armed.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 2_000),
    }));
    expect(consumed.record.phase).toBe('consumed');
    expect(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'revoke',
      operationId: 'late-revoke-466',
      expectedSequence: consumed.record.sequence,
      expectedReceiptDigest: consumed.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 3_000),
    })).toMatchObject({ status: 'refused', reason: 'authority-terminal' });
  });

  it('returns the exact durable receipt when a caller retries after losing the write response', () => {
    const exactIdentity = identity();
    const first = prepare(exactIdentity);
    const replay = prepareHostMergeRevocation({
      identity: exactIdentity,
      operationId: 'prepare-466',
      now: new Date(NOW.getTime() + 5_000),
    });
    expect(replay).toMatchObject({
      status: 'replayed',
      receipt: { receiptDigest: first.receipt.receiptDigest },
      record: { stateDigest: first.record.stateDigest },
    });

    const armed = arm(exactIdentity, first);
    const armReplay = transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'arm',
      operationId: 'arm-466',
      expectedSequence: first.record.sequence,
      expectedReceiptDigest: first.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 6_000),
    });
    expect(armReplay).toMatchObject({
      status: 'replayed',
      receipt: { receiptDigest: armed.receipt.receiptDigest },
      record: { stateDigest: armed.record.stateDigest },
    });
  });

  it('prevents ABA reinitialization and conflicting operation-id replay', () => {
    const exactIdentity = identity();
    const prepared = prepare(exactIdentity);
    expect(prepareHostMergeRevocation({
      identity: exactIdentity,
      operationId: 'prepare-again-466',
      now: new Date(NOW.getTime() + 1_000),
    })).toMatchObject({ status: 'refused', reason: 'authority-already-exists' });
    expect(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'arm',
      operationId: 'prepare-466',
      expectedSequence: prepared.record.sequence,
      expectedReceiptDigest: prepared.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 1_000),
    })).toMatchObject({ status: 'refused', reason: 'operation-id-conflict' });
  });

  it('linearizes concurrent revoke and consume requests with exact CAS', async () => {
    const exactIdentity = identity();
    const armed = arm(exactIdentity);
    const common = {
      identity: exactIdentity,
      expectedSequence: armed.record.sequence,
      expectedReceiptDigest: armed.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 2_000),
    };
    const revokeChild = spawnTransition({
      ...common, action: 'revoke', operationId: 'race-revoke-466',
    });
    const consumeChild = spawnTransition({
      ...common, action: 'consume', operationId: 'race-consume-466',
    });
    await Promise.all([revokeChild.ready, consumeChild.ready]);
    revokeChild.child.send({ go: true });
    consumeChild.child.send({ go: true });
    const [revoke, consume] = await Promise.all([revokeChild.result, consumeChild.result]);
    const attempts = [
      { action: 'revoke' as const, operationId: 'race-revoke-466', result: revoke },
      { action: 'consume' as const, operationId: 'race-consume-466', result: consume },
    ];
    expect(attempts.filter(({ result }) => result.status === 'applied')).toHaveLength(1);
    const [loser] = attempts.filter(({ result }) => result.status !== 'applied');
    expect(loser).toBeDefined();
    if (loser.result.status === 'degraded') {
      // The competing lock's create/release also changes the authority
      // directory snapshot, so the stable reader may fail closed first.
      expect([
        'state-lock-contended',
        'state-read-changed-during-read',
      ]).toContain(loser.result.reason);
      expect(transitionHostMergeRevocation({
        ...common,
        action: loser.action,
        operationId: loser.operationId,
      })).toMatchObject({
        status: 'refused',
        reason: 'compare-and-swap-mismatch',
      });
    } else {
      expect(loser.result).toMatchObject({
        status: 'refused',
        reason: 'compare-and-swap-mismatch',
      });
    }
    expect(readHostMergeRevocationState(exactIdentity)).toMatchObject({
      state: 'healthy',
      record: { sequence: 3 },
    });
  });

  it('refuses to publish when lock ownership is lost during a transition', () => {
    const exactIdentity = identity();
    const prepared = prepare(exactIdentity);
    const lockPath = path.join(
      path.dirname(hostMergeRevocationStatePath(exactIdentity)!),
      `${prepared.authorityId}.lock`,
    );
    let timeReads = 0;
    class LockDroppingDate extends Date {
      override getTime(): number {
        timeReads += 1;
        if (timeReads === 2) fs.unlinkSync(lockPath);
        return super.getTime();
      }
    }
    const result = transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'arm',
      operationId: 'lost-lock-arm-466',
      expectedSequence: prepared.record.sequence,
      expectedReceiptDigest: prepared.receipt.receiptDigest,
      now: new LockDroppingDate(NOW.getTime() + 1_000),
    });
    expect(result).toMatchObject({ status: 'degraded', reason: 'state-lock-lost' });
    expect(readHostMergeRevocationState(exactIdentity)).toMatchObject({
      state: 'healthy',
      record: { phase: 'prepared', sequence: 1 },
    });
  });

  it('refuses clock rollback and expiry for authority-advancing transitions', () => {
    const exactIdentity = identity();
    const prepared = prepare(exactIdentity);
    expect(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'arm',
      operationId: 'rollback-arm-466',
      expectedSequence: prepared.record.sequence,
      expectedReceiptDigest: prepared.receipt.receiptDigest,
      now: new Date(NOW.getTime() - 1),
    })).toMatchObject({ status: 'refused', reason: 'clock-rollback' });
    expect(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'arm',
      operationId: 'expired-arm-466',
      expectedSequence: prepared.record.sequence,
      expectedReceiptDigest: prepared.receipt.receiptDigest,
      now: new Date(exactIdentity.expiresAt),
    })).toMatchObject({ status: 'refused', reason: 'authority-expired' });
  });

  it('revalidates expiry after waiting for the authority lock', async () => {
    const exactIdentity = identity({
      expiresAt: new Date(NOW.getTime() + 500).toISOString(),
    });
    const prepared = prepare(exactIdentity);
    const authorityId = hostMergeRevocationAuthorityId(exactIdentity)!;
    const statePath = hostMergeRevocationStatePath(exactIdentity)!;
    const held = acquireLocalStoreLock(
      path.join(path.dirname(statePath), `${authorityId}.lock`),
      2_000,
      { anchorPath: home, exactPrivateStorage: true },
    );
    expect(held).not.toBeNull();

    const child = spawnTransition({
      identity: exactIdentity,
      action: 'arm',
      operationId: 'delayed-expiry-arm-466',
      expectedSequence: prepared.record.sequence,
      expectedReceiptDigest: prepared.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 100),
    });
    await child.ready;
    child.child.send({ go: true });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(releaseLocalStoreLock(held)).toBe(true);

    await expect(child.result).resolves.toMatchObject({
      status: 'refused',
      reason: 'authority-expired',
    });
    expect(readHostMergeRevocationState(exactIdentity)).toMatchObject({
      state: 'healthy',
      record: { phase: 'prepared', sequence: 1 },
    });
  });

  it('preserves logical receipt time after a successful delayed lock acquisition', async () => {
    const exactIdentity = identity();
    const prepared = prepare(exactIdentity);
    const authorityId = hostMergeRevocationAuthorityId(exactIdentity)!;
    const statePath = hostMergeRevocationStatePath(exactIdentity)!;
    const held = acquireLocalStoreLock(
      path.join(path.dirname(statePath), `${authorityId}.lock`),
      2_000,
      { anchorPath: home, exactPrivateStorage: true },
    );
    expect(held).not.toBeNull();

    const logicalArmTime = new Date(NOW.getTime() + 100);
    const child = spawnTransition({
      identity: exactIdentity,
      action: 'arm',
      operationId: 'delayed-success-arm-466',
      expectedSequence: prepared.record.sequence,
      expectedReceiptDigest: prepared.receipt.receiptDigest,
      now: logicalArmTime,
    });
    await child.ready;
    child.child.send({ go: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(releaseLocalStoreLock(held)).toBe(true);

    const armed = applied(await child.result);
    expect(armed.receipt.recordedAt).toBe(logicalArmTime.toISOString());
    expect(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'revoke',
      operationId: 'after-delayed-arm-revoke-466',
      expectedSequence: armed.record.sequence,
      expectedReceiptDigest: armed.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 200),
    })).toMatchObject({
      status: 'applied',
      receipt: { recordedAt: new Date(NOW.getTime() + 200).toISOString() },
      record: { phase: 'revoked', sequence: 3 },
    });
  });

  it('allows only the restrictive revoke transition after expiry', () => {
    const exactIdentity = identity();
    const armed = arm(exactIdentity);
    const expiredAt = new Date(Date.parse(exactIdentity.expiresAt) + 1);
    expect(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'consume',
      operationId: 'expired-consume-466',
      expectedSequence: armed.record.sequence,
      expectedReceiptDigest: armed.receipt.receiptDigest,
      now: expiredAt,
    })).toMatchObject({ status: 'refused', reason: 'authority-expired' });
    expect(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'revoke',
      operationId: 'expired-revoke-466',
      expectedSequence: armed.record.sequence,
      expectedReceiptDigest: armed.receipt.receiptDigest,
      now: expiredAt,
    })).toMatchObject({
      status: 'applied',
      record: { phase: 'revoked', operationalAuthority: false, hostAutoMergeEnabled: false },
    });
  });

  it('does not replay authority-advancing receipts after expiry', () => {
    const armIdentity = identity();
    const prepared = prepare(armIdentity);
    arm(armIdentity, prepared);
    const expiredAt = new Date(Date.parse(armIdentity.expiresAt) + 1);
    expect(transitionHostMergeRevocation({
      identity: armIdentity,
      action: 'arm',
      operationId: 'arm-466',
      expectedSequence: prepared.record.sequence,
      expectedReceiptDigest: prepared.receipt.receiptDigest,
      now: expiredAt,
    })).toMatchObject({ status: 'refused', reason: 'authority-expired' });

    const consumeIdentity = identity({ pullRequestNumber: 467, pullRequestId: 'PR_kwDOHostMerge467' });
    const armed = arm(consumeIdentity);
    const consumed = applied(transitionHostMergeRevocation({
      identity: consumeIdentity,
      action: 'consume',
      operationId: 'consume-expiry-466',
      expectedSequence: armed.record.sequence,
      expectedReceiptDigest: armed.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 2_000),
    }));
    expect(transitionHostMergeRevocation({
      identity: consumeIdentity,
      action: 'consume',
      operationId: 'consume-expiry-466',
      expectedSequence: consumed.record.sequence - 1,
      expectedReceiptDigest: consumed.record.receipts.at(-2)!.receiptDigest,
      now: new Date(Date.parse(consumeIdentity.expiresAt) + 1),
    })).toMatchObject({ status: 'refused', reason: 'authority-expired' });
  });

  it('fails closed on a partial write and never repairs ambiguous state', () => {
    const exactIdentity = identity();
    prepare(exactIdentity);
    const statePath = hostMergeRevocationStatePath(exactIdentity)!;
    fs.writeFileSync(statePath, '{"schemaVersion":1,"protocol":', { mode: 0o600 });

    expect(readHostMergeRevocationState(exactIdentity)).toMatchObject({
      state: 'degraded',
      reason: 'state-invalid',
      operationalAuthority: false,
      hostAutoMergeEnabled: false,
    });
    expect(prepareHostMergeRevocation({
      identity: exactIdentity,
      operationId: 'repair-prepare-466',
      now: new Date(NOW.getTime() + 1_000),
    })).toMatchObject({ status: 'degraded', reason: 'state-invalid' });
  });

  it('fails closed on an orphaned crash-stage file beside otherwise healthy state', () => {
    const exactIdentity = identity();
    prepare(exactIdentity);
    const statePath = hostMergeRevocationStatePath(exactIdentity)!;
    fs.writeFileSync(
      `${statePath}.123.${'a'.repeat(24)}.tmp`,
      '{"partial":',
      { mode: 0o600 },
    );
    expect(readHostMergeRevocationState(exactIdentity)).toMatchObject({
      state: 'degraded',
      reason: 'state-crash-artifact-ambiguous',
      operationalAuthority: false,
      hostAutoMergeEnabled: false,
    });
  });

  it('refuses a first prepare when a prior prepare left only a crash-stage file', () => {
    const exactIdentity = identity();
    const statePath = hostMergeRevocationStatePath(exactIdentity)!;
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(path.dirname(statePath), 0o700);
    fs.writeFileSync(
      `${statePath}.123.${'b'.repeat(24)}.tmp`,
      '{"partial":',
      { mode: 0o600 },
    );
    expect(prepareHostMergeRevocation({
      identity: exactIdentity,
      operationId: 'ambiguous-first-prepare-466',
      now: NOW,
    })).toMatchObject({
      status: 'degraded',
      reason: 'state-crash-artifact-ambiguous',
    });
  });

  it('degrades when aggregate committed, lock, and crash entries exceed the store bound', () => {
    const exactIdentity = identity();
    const statePath = hostMergeRevocationStatePath(exactIdentity)!;
    const root = path.dirname(statePath);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    for (let index = 0; index <= 4_096; index += 1) {
      fs.writeFileSync(path.join(root, `noise-${index}.tmp`), '', { mode: 0o600 });
    }
    expect(readHostMergeRevocationState(exactIdentity)).toMatchObject({
      state: 'degraded',
      reason: 'store-entry-limit-exceeded',
    });
  });

  it('fails closed when the local signing key generation changes', () => {
    const exactIdentity = identity();
    prepare(exactIdentity);
    fs.writeFileSync(provenanceKeyPath(), Buffer.alloc(32, 0xa5), { mode: 0o600 });
    expect(readHostMergeRevocationState(exactIdentity)).toMatchObject({
      state: 'degraded',
      reason: 'state-authentication-failed',
    });
  });

  it.each([
    ['base', { baseOid: '8'.repeat(40) }],
    ['head', { headOid: '8'.repeat(40) }],
    ['pull request', { pullRequestId: 'PR_kwDOStaleMerge' }],
    ['evidence', { evidencePackDigest: '8'.repeat(64) }],
    ['verifier', { verifierManifestDigest: '8'.repeat(64) }],
    ['protection', { protectionPolicyDigest: '8'.repeat(64) }],
    ['kill epoch', { killEpoch: '8'.repeat(64) }],
    ['policy epoch', { policyEpoch: '8'.repeat(64) }],
  ])('refuses stale or mismatched %s identity', (_label, changed) => {
    const exactIdentity = identity();
    const prepared = prepare(exactIdentity);
    const staleIdentity = identity(changed);
    expect(hostMergeRevocationAuthorityId(staleIdentity)).not.toBe(prepared.authorityId);
    expect(transitionHostMergeRevocation({
      identity: staleIdentity,
      action: 'arm',
      operationId: `stale-${String(_label).replace(' ', '-')}-466`,
      expectedSequence: prepared.record.sequence,
      expectedReceiptDigest: prepared.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 1_000),
    })).toMatchObject({ status: 'refused', reason: 'authority-missing' });
  });

  it('fails closed when the store is degraded or the exact CAS receipt is stale', () => {
    const exactIdentity = identity();
    const prepared = prepare(exactIdentity);
    expect(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'arm',
      operationId: 'stale-cas-466',
      expectedSequence: prepared.record.sequence,
      expectedReceiptDigest: '9'.repeat(64),
      now: new Date(NOW.getTime() + 1_000),
    })).toMatchObject({ status: 'refused', reason: 'compare-and-swap-mismatch' });

    const root = path.dirname(hostMergeRevocationStatePath(exactIdentity)!);
    if (process.platform !== 'win32') fs.chmodSync(root, 0o777);
    else fs.rmSync(root, { recursive: true, force: true });
    // Windows has no POSIX mode corruption analogue; deleting the store is a
    // distinct fail-closed missing state, not a degraded existing directory.
    expect(readHostMergeRevocationState(exactIdentity)).toMatchObject({
      state: process.platform === 'win32' ? 'missing' : 'degraded',
    });
  });

  it('refuses invalid TTLs, direct terminal transitions, and self-target refs', () => {
    expect(prepareHostMergeRevocation({
      identity: identity({ expiresAt: new Date(NOW.getTime() + 16 * 60 * 1000).toISOString() }),
      operationId: 'long-ttl-466',
      now: NOW,
    })).toMatchObject({ status: 'refused', reason: 'expiry-invalid' });
    expect(prepareHostMergeRevocation({
      identity: identity({ headRef: 'master' }),
      operationId: 'self-target-466',
      now: NOW,
    })).toMatchObject({ status: 'refused', reason: 'prepare-input-invalid' });

    const exactIdentity = identity();
    const prepared = prepare(exactIdentity);
    expect(transitionHostMergeRevocation({
      identity: exactIdentity,
      action: 'consume',
      operationId: 'consume-before-arm-466',
      expectedSequence: prepared.record.sequence,
      expectedReceiptDigest: prepared.receipt.receiptDigest,
      now: new Date(NOW.getTime() + 1_000),
    })).toMatchObject({ status: 'refused', reason: 'transition-invalid' });
  });
});

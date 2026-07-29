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

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const NOW = new Date('2026-07-28T14:00:00.000Z');
const PROTOCOL_MODULE_URL = new URL(
  '../src/core/autonomy/host-merge-revocation-protocol.ts',
  import.meta.url,
).href;
const CHILD_SOURCE = String.raw`
  import { transitionHostMergeRevocation } from ${JSON.stringify(PROTOCOL_MODULE_URL)};

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
  loadOrCreateKey();
});

afterEach(async () => {
  const active = [...children];
  for (const child of active) child.kill();
  await Promise.all(active.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  })));
  children.clear();
  fs.rmSync(home, { recursive: true, force: true });
  restore('HOME', originalHome);
  restore('USERPROFILE', originalUserProfile);
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
    const outcomes = [revoke, consume];
    expect(outcomes.filter((result) => result.status === 'applied')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'refused')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'refused')).toMatchObject({
      reason: 'compare-and-swap-mismatch',
    });
    expect(readHostMergeRevocationState(exactIdentity)).toMatchObject({
      state: 'healthy',
      record: { sequence: 3 },
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
    expect(readHostMergeRevocationState(exactIdentity)).toMatchObject({
      state: 'degraded',
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

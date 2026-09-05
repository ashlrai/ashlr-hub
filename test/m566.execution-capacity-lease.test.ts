import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EXECUTION_CAPACITY_EVIDENCE_V1_PROTOCOL,
  EXECUTION_CAPACITY_LEASE_V1_PROTOCOL,
  ExecutionCapacityLeaseStoreV1,
  canonicalExecutionCapacityEvidenceBytesV1,
  digestExecutionCapacityEvidenceV1,
  setExecutionCapacityLeaseTestHooksForTests,
  type ExecutionCapacityEvidenceEnvelopeV1,
  type ExecutionCapacityEvidenceUnsignedV1,
  type ExecutionCapacityEvidenceVerifierV1,
  type ExecutionCapacityLeaseBatchItemV1,
} from '../src/core/fabric/execution-capacity-lease.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const NOW = Date.parse('2026-09-04T16:00:00.000Z');
const pair = generateKeyPairSync('ed25519');
const VERIFIER_ID = `sha256:${createHash('sha256').update('m566\0trusted-verifier').digest('hex')}`;

function digest(label: string): string {
  return `sha256:${createHash('sha256').update(`m566\0${label}`).digest('hex')}`;
}

function unsignedEvidence(
  identity: string,
  epoch: number,
  slots: number,
  overrides: Partial<ExecutionCapacityEvidenceUnsignedV1> = {},
): ExecutionCapacityEvidenceUnsignedV1 {
  return {
    schemaVersion: 1,
    protocol: EXECUTION_CAPACITY_EVIDENCE_V1_PROTOCOL,
    authority: 'observation-only',
    executionAuthority: false,
    providerContactAuthority: false,
    routingMutation: false,
    verifierIdentityDigest: VERIFIER_ID,
    executionIdentityDigest: identity,
    observationEpoch: epoch,
    trustedSlots: slots,
    observedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 120_000).toISOString(),
    ...overrides,
  };
}

function evidence(
  identity: string,
  epoch = 1,
  slots = 2,
  overrides: Partial<ExecutionCapacityEvidenceUnsignedV1> = {},
): ExecutionCapacityEvidenceEnvelopeV1 {
  const unsigned = unsignedEvidence(identity, epoch, slots, overrides);
  return {
    ...unsigned,
    evidenceDigest: digestExecutionCapacityEvidenceV1(unsigned),
    authenticator: signEd25519(
      null,
      canonicalExecutionCapacityEvidenceBytesV1(unsigned),
      pair.privateKey,
    ).toString('base64url'),
  };
}

const verifier: ExecutionCapacityEvidenceVerifierV1 = {
  verifierIdentityDigest: VERIFIER_ID,
  verify: ({ canonicalDomainSeparatedEnvelope, authenticator }) => verifyEd25519(
    null,
    Buffer.from(canonicalDomainSeparatedEnvelope),
    pair.publicKey,
    Buffer.from(authenticator, 'base64url'),
  ),
};

function item(envelope: ExecutionCapacityEvidenceEnvelopeV1, slots = 1): ExecutionCapacityLeaseBatchItemV1 {
  return {
    executionIdentityDigest: envelope.executionIdentityDigest,
    slots,
    expectedEvidenceDigest: envelope.evidenceDigest,
    evidenceEnvelope: envelope,
  };
}

interface Fixture {
  anchor: string;
  root: string;
  statePath: string;
  now: { value: number };
  store: ExecutionCapacityLeaseStoreV1;
}

const fixtures: Fixture[] = [];

function fixture(enabled = true, pinnedVerifier: ExecutionCapacityEvidenceVerifierV1 | null = verifier): Fixture {
  const anchor = mkdtempSync(join(tmpdir(), 'ashlr-m566-'));
  chmodSync(anchor, 0o700);
  const root = join(anchor, 'capacity');
  const now = { value: NOW };
  const store = new ExecutionCapacityLeaseStoreV1({
    anchorPath: anchor,
    rootPath: root,
    enabled,
    verifier: pinnedVerifier,
    clock: () => new Date(now.value),
    lockWaitMs: 0,
  });
  const result = { anchor, root, statePath: join(root, 'leases-v1.json'), now, store };
  fixtures.push(result);
  return result;
}

function acquire(
  store: ExecutionCapacityLeaseStoreV1,
  allocationId: string,
  items: readonly ExecutionCapacityLeaseBatchItemV1[],
  leaseTtlMs = 60_000,
) {
  return store.acquire({ allocationId, items, leaseTtlMs });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function rewriteFirstLeaseEpoch(statePath: string, epoch: number): void {
  const ledger = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown> & {
    leases: Array<Record<string, unknown>>;
  };
  ledger.leases[0]!.epoch = epoch;
  const { stateDigest: _priorDigest, ...unsigned } = ledger;
  expect(unsigned).toMatchObject({
    schemaVersion: 1,
    protocol: EXECUTION_CAPACITY_LEASE_V1_PROTOCOL,
  });
  ledger.stateDigest = `sha256:${createHash('sha256')
    .update('ashlr.execution-capacity-lease.ledger.v1', 'utf8')
    .update('\0')
    .update(canonicalJson(unsigned))
    .digest('hex')}`;
  writeFileSync(statePath, `${canonicalJson(ledger)}\n`, { mode: 0o600 });
}

afterEach(() => {
  setExecutionCapacityLeaseTestHooksForTests(undefined);
  for (const entry of fixtures.splice(0)) rmSync(entry.anchor, { recursive: true, force: true });
});

describe('M566 Execution Capacity Lease V1', () => {
  it('is private, default-off, values-free, and grants no execution/provider/routing authority', () => {
    const entry = fixture(false);
    const result = acquire(entry.store, 'disabled-allocation', [item(evidence(digest('one')))]);
    expect(result).toMatchObject({
      disposition: 'withheld', reason: 'disabled', ownerCapability: null,
      executionAuthority: false, providerContactAuthority: false, routingMutation: false,
    });
    expect(entry.store.inspect()).toEqual({
      authority: 'lease-only', executionAuthority: false, providerContactAuthority: false,
      routingMutation: false, sameUserTamperResistant: false,
      enabled: false, sourceState: 'disabled', complete: true,
      identities: [], leases: [], activeLeaseCount: 0, expiredPendingReclaim: 0,
      stopReasons: ['disabled'],
    });
    expect(() => lstatSync(entry.root)).toThrow();
  });

  it('atomically acquires an exact multi-identity batch and persists only commitments', () => {
    const entry = fixture();
    const one = evidence(digest('one'), 1, 2);
    const two = evidence(digest('two'), 1, 3);
    const result = acquire(entry.store, 'raw-allocation-secret', [item(two, 2), item(one, 1)]);
    expect(result).toMatchObject({
      disposition: 'recorded', reason: 'recorded', leaseEpoch: 1, durable: true,
      committedWithoutReceipt: false, executionAuthority: false,
      providerContactAuthority: false, routingMutation: false,
    });
    expect(result.ownerCapability).toMatch(/^ecap_[A-Za-z0-9_-]{43}$/);
    const persisted = readFileSync(entry.statePath, 'utf8');
    expect(persisted).not.toContain('raw-allocation-secret');
    expect(persisted).not.toContain(result.ownerCapability!);
    expect(lstatSync(entry.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(entry.statePath).mode & 0o777).toBe(0o600);

    const inspection = entry.store.inspect();
    expect(inspection).toMatchObject({
      sourceState: 'healthy', complete: true, activeLeaseCount: 1,
      executionAuthority: false, providerContactAuthority: false, routingMutation: false,
    });
    expect(inspection.identities).toEqual(expect.arrayContaining([
      expect.objectContaining({ executionIdentityDigest: one.executionIdentityDigest, trustedSlots: 2, reservedSlots: 1, availableSlots: 1 }),
      expect.objectContaining({ executionIdentityDigest: two.executionIdentityDigest, trustedSlots: 3, reservedSlots: 2, availableSlots: 1 }),
    ]));
    expect(JSON.stringify(inspection)).not.toContain('raw-allocation-secret');
    expect(JSON.stringify(inspection)).not.toContain('ecap_');
  });

  it('makes allocation acquisition idempotent without re-disclosing the owner capability', () => {
    const entry = fixture();
    const capacity = evidence(digest('identity'));
    const first = acquire(entry.store, 'same-allocation', [item(capacity)]);
    const replay = acquire(entry.store, 'same-allocation', [item(capacity)]);
    expect(first.ownerCapability).toMatch(/^ecap_/);
    expect(replay).toMatchObject({
      disposition: 'replayed', reason: 'replayed', allocationDigest: first.allocationDigest,
      leaseEpoch: 1, ownerCapability: null, durable: false,
    });
    expect(entry.store.inspect().activeLeaseCount).toBe(1);
  });

  it('conserves trusted slots and rejects an over-capacity batch all-or-nothing', () => {
    const entry = fixture();
    const one = evidence(digest('one'), 1, 1);
    const two = evidence(digest('two'), 1, 1);
    expect(acquire(entry.store, 'first', [item(one)])).toMatchObject({ reason: 'recorded' });
    expect(acquire(entry.store, 'atomic-reject', [item(one), item(two)])).toMatchObject({
      disposition: 'withheld', reason: 'trusted-slots-exhausted', ownerCapability: null,
    });
    const inspection = entry.store.inspect();
    expect(inspection.activeLeaseCount).toBe(1);
    expect(inspection.identities.find((identity) =>
      identity.executionIdentityDigest === two.executionIdentityDigest)).toBeUndefined();
  });

  it('distinguishes cross-identity allocation reuse from same-identity request conflict', () => {
    const entry = fixture();
    const one = evidence(digest('one'));
    const two = evidence(digest('two'));
    expect(acquire(entry.store, 'shared-id', [item(one)])).toMatchObject({ reason: 'recorded' });
    expect(acquire(entry.store, 'shared-id', [item(two)])).toMatchObject({ reason: 'identity-conflict' });
    expect(acquire(entry.store, 'shared-id', [item(one, 2)])).toMatchObject({ reason: 'allocation-conflict' });
  });

  it.each([
    ['stale', { observedAt: new Date(NOW - 300_001).toISOString() }, 'evidence-stale'],
    ['future', { observedAt: new Date(NOW + 60_001).toISOString(), expiresAt: new Date(NOW + 120_000).toISOString() }, 'evidence-future'],
    ['expired', { observedAt: new Date(NOW - 120_000).toISOString(), expiresAt: new Date(NOW).toISOString() }, 'evidence-expired'],
  ] as const)('rejects %s authenticated capacity evidence', (_label, overrides, reason) => {
    const entry = fixture();
    const capacity = evidence(digest('identity'), 1, 2, overrides);
    expect(acquire(entry.store, `allocation-${reason}`, [item(capacity)])).toMatchObject({
      disposition: 'withheld', reason,
    });
    expect(entry.store.inspect().activeLeaseCount).toBe(0);
  });

  it('rejects missing, invalid, mismatched, and verifier-mutated evidence', () => {
    const capacity = evidence(digest('identity'));
    const missing = fixture(true, null);
    expect(missing.store.acquire({ allocationId: 'missing', leaseTtlMs: 60_000, items: [item(capacity)] }))
      .toMatchObject({ reason: 'verifier-unavailable' });
    const invalid = fixture(true, { verifierIdentityDigest: VERIFIER_ID, verify: () => false });
    expect(invalid.store.acquire({
      allocationId: 'invalid', leaseTtlMs: 60_000, items: [item(capacity)],
    })).toMatchObject({ reason: 'evidence-unauthenticated' });
    const mutated = fixture(true, {
      verifierIdentityDigest: VERIFIER_ID,
      verify: (input) => {
        input.canonicalDomainSeparatedEnvelope[0] = 0;
        return true;
      },
    });
    expect(mutated.store.acquire({
      allocationId: 'mutated', leaseTtlMs: 60_000, items: [item(capacity)],
    })).toMatchObject({ reason: 'evidence-unauthenticated' });
    const entry = fixture();
    expect(entry.store.acquire({
      allocationId: 'mismatch', leaseTtlMs: 60_000,
      items: [{ ...item(capacity), expectedEvidenceDigest: digest('wrong') }],
    })).toMatchObject({ reason: 'evidence-mismatch' });
  });

  it('snapshots the complete batch before invoking pinned verifier code', () => {
    const one = evidence(digest('snapshot-one'));
    const two = evidence(digest('snapshot-two'));
    const second = item(two);
    let calls = 0;
    const mutatingVerifier: ExecutionCapacityEvidenceVerifierV1 = {
      verifierIdentityDigest: VERIFIER_ID,
      verify: (input) => {
        calls += 1;
        if (calls === 1) second.evidenceEnvelope = { ...two, authenticator: 'replaced' };
        return verifier.verify(input);
      },
    };
    const entry = fixture(true, mutatingVerifier);
    expect(entry.store.acquire({
      allocationId: 'snapshotted-batch', leaseTtlMs: 60_000,
      items: [item(one), second],
    })).toMatchObject({ disposition: 'recorded', reason: 'recorded', durable: true });
    expect(calls).toBe(2);
  });

  it('rejects proxy, accessor, and custom-iterator batches without invoking hostile code', () => {
    const entry = fixture();
    const capacity = evidence(digest('hostile-batch'));
    const validItem = item(capacity);
    let iteratorInvoked = false;
    const customIterator = [validItem];
    Object.defineProperty(customIterator, Symbol.iterator, {
      configurable: true,
      value: function* hostileIterator() {
        iteratorInvoked = true;
        while (true) yield validItem;
      },
    });
    expect(entry.store.acquire({
      allocationId: 'custom-iterator', leaseTtlMs: 60_000, items: customIterator,
    })).toMatchObject({ disposition: 'withheld', reason: 'invalid-input' });
    expect(iteratorInvoked).toBe(false);

    let accessorInvoked = false;
    const accessorItems: ExecutionCapacityLeaseBatchItemV1[] = [];
    Object.defineProperty(accessorItems, '0', {
      configurable: true,
      enumerable: true,
      get() {
        accessorInvoked = true;
        return validItem;
      },
    });
    expect(entry.store.acquire({
      allocationId: 'accessor-index', leaseTtlMs: 60_000, items: accessorItems,
    })).toMatchObject({ disposition: 'withheld', reason: 'invalid-input' });
    expect(accessorInvoked).toBe(false);

    const proxyItems = new Proxy([validItem], {});
    expect(entry.store.acquire({
      allocationId: 'proxy-array', leaseTtlMs: 60_000, items: proxyItems,
    })).toMatchObject({ disposition: 'withheld', reason: 'invalid-input' });
    expect(entry.store.inspect()).toMatchObject({ sourceState: 'missing', activeLeaseCount: 0 });
  });

  it('pins the trusted verifier and rejects request-level substitution or identity drift', () => {
    const mutableVerifier = {
      verifierIdentityDigest: VERIFIER_ID,
      verify: verifier.verify,
    };
    const entry = fixture(true, mutableVerifier);
    mutableVerifier.verify = () => true;
    const unsigned = unsignedEvidence(digest('forged'));
    const forged: ExecutionCapacityEvidenceEnvelopeV1 = {
      ...unsigned,
      evidenceDigest: digestExecutionCapacityEvidenceV1(unsigned),
      authenticator: 'forged',
    };
    expect(acquire(entry.store, 'forged', [item(forged)]))
      .toMatchObject({ reason: 'evidence-unauthenticated' });

    expect(entry.store.acquire({
      allocationId: 'request-verifier', leaseTtlMs: 60_000, items: [item(evidence(digest('valid')))],
      verifier: { verifierIdentityDigest: VERIFIER_ID, verify: () => true },
    } as never)).toMatchObject({ reason: 'invalid-input' });

    const alternate = evidence(digest('alternate-verifier'), 1, 2, {
      verifierIdentityDigest: digest('untrusted-verifier'),
    });
    expect(acquire(entry.store, 'alternate-verifier', [item(alternate)]))
      .toMatchObject({ reason: 'evidence-mismatch' });
  });

  it('rejects same-epoch evidence drift and capacity shrink below conserved reservations', () => {
    const entry = fixture();
    const identity = digest('identity');
    const original = evidence(identity, 1, 2);
    expect(acquire(entry.store, 'first', [item(original, 2)])).toMatchObject({ reason: 'recorded' });
    const drifted = evidence(identity, 1, 3, { expiresAt: new Date(NOW + 180_000).toISOString() });
    expect(acquire(entry.store, 'drifted', [item(drifted)])).toMatchObject({ reason: 'evidence-drift' });
    const shrunk = evidence(identity, 2, 1);
    expect(acquire(entry.store, 'shrunk', [item(shrunk)])).toMatchObject({ reason: 'evidence-drift' });
  });

  it('persists expiry housekeeping without leaking rejected request evidence updates', () => {
    const entry = fixture();
    const expiringIdentity = digest('expired-housekeeping');
    const occupiedIdentity = digest('occupied');
    expect(acquire(entry.store, 'expires-first', [item(evidence(expiringIdentity, 1, 1))], 1_000))
      .toMatchObject({ reason: 'recorded' });
    expect(acquire(entry.store, 'occupied-first', [item(evidence(occupiedIdentity, 1, 1))]))
      .toMatchObject({ reason: 'recorded' });
    entry.now.value += 1_001;
    const advanced = evidence(occupiedIdentity, 2, 1, {
      observedAt: new Date(entry.now.value).toISOString(),
      expiresAt: new Date(entry.now.value + 120_000).toISOString(),
    });
    expect(acquire(entry.store, 'must-reject', [item(advanced)]))
      .toMatchObject({ disposition: 'withheld', reason: 'trusted-slots-exhausted' });

    const inspection = entry.store.inspect();
    expect(inspection.expiredPendingReclaim).toBe(0);
    expect(inspection.identities.find((identity) =>
      identity.executionIdentityDigest === occupiedIdentity)).toMatchObject({
      observationEpoch: 1,
      evidenceDigest: evidence(occupiedIdentity, 1, 1).evidenceDigest,
    });
  });

  it('renews and releases only with the exact owner capability and lease epoch', () => {
    const entry = fixture();
    const identity = digest('identity');
    const firstEvidence = evidence(identity, 1, 1);
    const acquired = acquire(entry.store, 'owned', [item(firstEvidence)]);
    expect(entry.store.renew({
      allocationId: 'owned', ownerCapability: `ecap_${'a'.repeat(43)}`,
      expectedLeaseEpoch: 1, leaseTtlMs: 60_000, items: [item(firstEvidence)],
    })).toMatchObject({ reason: 'owner-capability-invalid' });
    const renewedEvidence = evidence(identity, 2, 1, {
      observedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 180_000).toISOString(),
    });
    const renewed = entry.store.renew({
      allocationId: 'owned', ownerCapability: acquired.ownerCapability!, expectedLeaseEpoch: 1,
      leaseTtlMs: 120_000, items: [item(renewedEvidence)],
    });
    expect(renewed).toMatchObject({ reason: 'renewed', leaseEpoch: 2, ownerCapability: null, durable: true });
    expect(entry.store.release({
      allocationId: 'owned', ownerCapability: acquired.ownerCapability!, expectedLeaseEpoch: 1,
    })).toMatchObject({ reason: 'lease-epoch-conflict' });
    expect(entry.store.release({
      allocationId: 'owned', ownerCapability: acquired.ownerCapability!, expectedLeaseEpoch: 2,
    })).toMatchObject({ reason: 'released', leaseEpoch: 3, durable: true });
    expect(entry.store.release({
      allocationId: 'owned', ownerCapability: acquired.ownerCapability!, expectedLeaseEpoch: 3,
    })).toMatchObject({ reason: 'allocation-finalized' });
    expect(entry.store.inspect().activeLeaseCount).toBe(0);
  });

  it('refuses renew and release when the safe-integer lease epoch is exhausted', () => {
    const entry = fixture();
    const capacity = evidence(digest('epoch-exhaustion'), 1, 1);
    const acquired = acquire(entry.store, 'epoch-exhaustion', [item(capacity)]);
    rewriteFirstLeaseEpoch(entry.statePath, Number.MAX_SAFE_INTEGER);

    expect(entry.store.renew({
      allocationId: 'epoch-exhaustion', ownerCapability: acquired.ownerCapability!,
      expectedLeaseEpoch: Number.MAX_SAFE_INTEGER, leaseTtlMs: 60_000, items: [item(capacity)],
    })).toMatchObject({ disposition: 'withheld', reason: 'lease-epoch-exhausted' });
    expect(entry.store.release({
      allocationId: 'epoch-exhaustion', ownerCapability: acquired.ownerCapability!,
      expectedLeaseEpoch: Number.MAX_SAFE_INTEGER,
    })).toMatchObject({ disposition: 'withheld', reason: 'lease-epoch-exhausted' });
    expect(entry.store.inspect()).toMatchObject({ sourceState: 'healthy' });
    expect(entry.store.inspect().leases[0]).toMatchObject({ leaseEpoch: Number.MAX_SAFE_INTEGER });
  });

  it('deterministically reclaims expired never-executing leases and retains the ABA tombstone', () => {
    const entry = fixture();
    const capacity = evidence(digest('identity'), 1, 1);
    const acquired = acquire(entry.store, 'expiring', [item(capacity)], 1_000);
    entry.now.value += 1_001;
    expect(entry.store.inspect()).toMatchObject({ activeLeaseCount: 0, expiredPendingReclaim: 1 });
    expect(entry.store.reclaimExpired()).toMatchObject({
      disposition: 'recorded', reason: 'reclaimed', executionAuthority: false,
      providerContactAuthority: false, routingMutation: false,
    });
    expect(entry.store.inspect()).toMatchObject({ activeLeaseCount: 0, expiredPendingReclaim: 0 });
    expect(entry.store.release({
      allocationId: 'expiring', ownerCapability: acquired.ownerCapability!, expectedLeaseEpoch: 1,
    })).toMatchObject({ reason: 'lease-expired' });
    const fresh = evidence(capacity.executionIdentityDigest, 2, 1, {
      observedAt: new Date(entry.now.value).toISOString(),
      expiresAt: new Date(entry.now.value + 120_000).toISOString(),
    });
    expect(acquire(entry.store, 'expiring', [item(fresh)], 1_000)).toMatchObject({
      reason: 'allocation-finalized', ownerCapability: null,
    });
    expect(acquire(entry.store, 'other', [item(fresh)], 1_000)).toMatchObject({ reason: 'recorded' });
  });

  it.each(['mode', 'hardlink', 'symlink', 'corruption'] as const)(
    'fails closed on unsafe or corrupt private storage: %s',
    (scenario) => {
      const entry = fixture();
      const capacity = evidence(digest('identity'));
      expect(acquire(entry.store, 'first', [item(capacity)])).toMatchObject({ reason: 'recorded' });
      if (scenario === 'mode') chmodSync(entry.statePath, 0o644);
      if (scenario === 'hardlink') linkSync(entry.statePath, join(entry.root, 'alias.json'));
      if (scenario === 'symlink') {
        renameSync(entry.statePath, join(entry.root, 'real.json'));
        symlinkSync(join(entry.root, 'real.json'), entry.statePath);
      }
      if (scenario === 'corruption') writeFileSync(entry.statePath, '{"broken":true}\n', { mode: 0o600 });
      expect(entry.store.inspect()).toMatchObject({ sourceState: 'degraded', complete: false });
      expect(acquire(entry.store, 'second', [item(capacity)])).toMatchObject({
        disposition: 'unavailable', reason: 'store-unavailable', ownerCapability: null,
      });
    },
  );

  it('fails closed when the ledger pathname is replaced after descriptor open', () => {
    const entry = fixture();
    const capacity = evidence(digest('identity'));
    expect(acquire(entry.store, 'first', [item(capacity)])).toMatchObject({ reason: 'recorded' });
    const displaced = `${entry.statePath}.displaced`;
    const original = readFileSync(entry.statePath, 'utf8');
    const replacement = '{"replacement":"must-survive"}\n';
    setExecutionCapacityLeaseTestHooksForTests({
      afterLedgerOpen: (path) => {
        renameSync(path, displaced);
        writeFileSync(path, replacement, { mode: 0o600 });
      },
    });

    expect(entry.store.inspect()).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(readFileSync(displaced, 'utf8')).toBe(original);
    expect(readFileSync(entry.statePath, 'utf8')).toBe(replacement);
  });

  it('fails closed under lock contention and destination replacement races', () => {
    const entry = fixture();
    mkdirSync(entry.root, { recursive: true, mode: 0o700 });
    chmodSync(entry.root, 0o700);
    const held = acquireLocalStoreLockWithOutcome(join(entry.root, '.leases-v1.lock'), 0, {
      anchorPath: entry.anchor, exactPrivateStorage: true,
    });
    expect(held.state).toBe('acquired');
    expect(acquire(entry.store, 'contended', [item(evidence(digest('identity')))]))
      .toMatchObject({ disposition: 'unavailable', reason: 'store-unavailable' });
    if (held.state === 'acquired') expect(releaseLocalStoreLock(held.lock)).toBe(true);

    setExecutionCapacityLeaseTestHooksForTests({
      beforeRename: () => writeFileSync(entry.statePath, '{}\n', { mode: 0o600 }),
    });
    expect(acquire(entry.store, 'raced', [item(evidence(digest('race')))]))
      .toMatchObject({ disposition: 'failed', reason: 'publication-failed', durable: false });
  });

  it('withholds the capability when durable commit acknowledgement is ambiguous', () => {
    const entry = fixture();
    setExecutionCapacityLeaseTestHooksForTests({
      fsyncDirectory: () => { throw new Error('simulated directory fsync failure'); },
    });
    const result = acquire(entry.store, 'ambiguous', [item(evidence(digest('identity')))]);
    expect(result).toMatchObject({
      disposition: 'failed', reason: 'publication-failed', ownerCapability: null,
      durable: false, committedWithoutReceipt: true,
    });
    expect(readFileSync(entry.statePath, 'utf8')).not.toContain('ambiguous');
  });

  it('reports a committed reservation but never returns its capability after lock release failure', () => {
    const entry = fixture();
    setExecutionCapacityLeaseTestHooksForTests({ releaseLock: () => false });
    const result = acquire(entry.store, 'release-failed', [item(evidence(digest('identity')))]);
    expect(result).toMatchObject({
      disposition: 'unavailable', reason: 'lock-release-failed', ownerCapability: null,
      durable: true, committedWithoutReceipt: true,
    });
  });

  it('defines no direct execution, provider, process-spawn, or runtime-resolver calls', () => {
    const source = readFileSync(new URL('../src/core/fabric/execution-capacity-lease.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bbeginExecution\s*\(/u);
    expect(source).not.toMatch(/\b(?:spawn|spawnSync|exec|execFile)\s*\(/u);
    expect(source).not.toMatch(/\bresolveExecutionIdentityRuntimeV1\s*\(/u);
    expect(source).not.toMatch(/\b(?:fetch|request)\s*\(/u);
  });

  it('turns an unavailable inspection clock into explicit degraded state', () => {
    const anchor = mkdtempSync(join(tmpdir(), 'ashlr-m566-clock-'));
    chmodSync(anchor, 0o700);
    const root = join(anchor, 'capacity');
    let unavailable = false;
    const store = new ExecutionCapacityLeaseStoreV1({
      anchorPath: anchor,
      rootPath: root,
      enabled: true,
      verifier,
      clock: () => {
        if (unavailable) throw new Error('clock unavailable');
        return new Date(NOW);
      },
    });
    fixtures.push({ anchor, root, statePath: join(root, 'leases-v1.json'), now: { value: NOW }, store });
    expect(acquire(store, 'clock-state', [item(evidence(digest('clock-identity')))]))
      .toMatchObject({ reason: 'recorded' });
    unavailable = true;
    expect(store.inspect()).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['store-unavailable'],
    });
  });
});

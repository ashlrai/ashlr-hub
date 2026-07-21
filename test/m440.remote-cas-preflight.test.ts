import { describe, expect, it } from 'vitest';

import { buildRemoteCasRequestFromInspection } from '../src/core/inbox/remote-cas-preflight.js';
import type { OperationalProjectionTransactionV2 } from '../src/core/inbox/operational-projection-transaction.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function transaction(): OperationalProjectionTransactionV2 {
  return {
    schemaVersion: 2,
    transactionId: A,
    signingKeyId: B,
    proposalId: 'proposal-440',
    phase: 'prepared',
    before: { proposal: null, projection: null },
    after: { proposal: A, projection: B },
    staged: {
      proposal: { present: true, digest: A, bytes: 12 },
      projection: { present: true, digest: B, bytes: 34 },
    },
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    attestation: C,
  };
}

function input() {
  const current = transaction();
  return {
    inspection: {
      state: 'recoverable-observation' as const,
      transactionId: current.transactionId,
      phase: current.phase,
      actual: 'no-effect' as const,
      next: 'would-write-proposal' as const,
    },
    transaction: current,
    authority: {
      mode: 'probe' as const,
      provider: 'ashlr-authority',
      endpoint: 'https://authority.ashlr.ai/',
      authorityId: 'authority-prod-1',
      audience: 'ashlr-operational-projection',
    },
    repositoryId: 'github-node:repository-440',
    expectedEpoch: '0',
    requestId: 'request-440',
    requestedAt: '2026-07-21T00:00:01.000Z',
  };
}

describe('M440 remote CAS preflight', () => {
  it('builds a deterministic metadata-only request for an exact inspected V2 transaction', () => {
    const first = buildRemoteCasRequestFromInspection(input());
    const second = buildRemoteCasRequestFromInspection(input());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      state: 'ready',
      request: {
        expectedEpoch: '0',
        action: 'would-write-proposal',
        binding: {
          transactionId: A,
          transactionAttestation: C,
          signingKeyId: B,
          staged: { proposal: { digest: A, bytes: 12 }, projection: { digest: B, bytes: 34 } },
        },
      },
    });
    expect(JSON.stringify(first)).not.toContain('endpoint');
  });

  it.each([
    ['transaction', (value: ReturnType<typeof input>) => ({ ...value, inspection: { ...value.inspection, transactionId: B } })],
    ['phase', (value: ReturnType<typeof input>) => ({ ...value, inspection: { ...value.inspection, phase: 'proposal-installed' as const } })],
    ['action', (value: ReturnType<typeof input>) => ({ ...value, inspection: { ...value.inspection, next: 'would-delete-proposal' as const } })],
    ['actual', (value: ReturnType<typeof input>) => ({ ...value, inspection: { ...value.inspection, actual: 'proposal-only' as const } })],
    ['padded epoch', (value: ReturnType<typeof input>) => ({ ...value, expectedEpoch: '01' })],
    ['oversized epoch', (value: ReturnType<typeof input>) => ({ ...value, expectedEpoch: '9'.repeat(40) })],
    ['invalid timestamp', (value: ReturnType<typeof input>) => ({ ...value, requestedAt: '2026-07-21T00:00:01Z' })],
    ['invalid repository id', (value: ReturnType<typeof input>) => ({ ...value, repositoryId: 'repo\n440' })],
    ['invalid authority id', (value: ReturnType<typeof input>) => ({ ...value, authority: { ...value.authority, authorityId: '' } })],
  ])('refuses %s drift before any authority or execution behavior', (_name, mutate) => {
    expect(buildRemoteCasRequestFromInspection(mutate(input()))).toMatchObject({ state: 'refused' });
  });

  it('binds staged artifact metadata to the exact V2 transaction', () => {
    const value = input();
    value.transaction = {
      ...value.transaction,
      staged: { ...value.transaction.staged, proposal: { ...value.transaction.staged.proposal, digest: B } },
    };
    expect(buildRemoteCasRequestFromInspection(value)).toEqual({ state: 'refused', reason: 'request-binding-invalid' });
  });
});

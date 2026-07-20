import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDispatchSelectionObservation, readLocallyBoundDispatchSelectionV2, type DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import {
  receiptDigestV2,
  rootDigestV2,
  selectionDigestV2,
  writeCoordinatorSelectionStartReceiptV2,
} from '../src/core/fleet/selection-start-receipt.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

describe('local V2 selection binding projection', () => {
  let fixture: H1Fixture;

  beforeEach(() => {
    fixture = makeFixture();
    loadOrCreateKey();
  });

  afterEach(() => fixture.cleanup());

  it('requires an exact configured shared binding without granting receipt-qualified authority', () => {
    const ts = new Date().toISOString();
    const root = {
      runId: 'local-v2-binding-run',
      trajectoryId: 'run:local-v2-binding-run',
      objectiveHash: 'a'.repeat(64),
    };
    const selectionObservation = createDispatchSelectionObservation({
      candidates: [
        { backend: 'codex', tier: 'frontier', model: 'gpt-5.6' },
        { backend: 'claude', tier: 'frontier', model: 'opus' },
      ],
      selected: { backend: 'codex', tier: 'frontier', model: 'gpt-5.6' },
      selectionPolicyVersion: 'canary-v1',
      randomizationProtocolVersion: 'binary-uniform-v1',
      selectionProbabilityPpm: 500_000,
      trajectoryId: root.trajectoryId,
      runId: root.runId,
      objectiveHash: root.objectiveHash,
      routerPolicyVersion: 'router-v1',
      learningEpoch: ts.slice(0, 10),
    }, loadOrCreateKey());
    if (!selectionObservation) throw new Error('selection observation was not created');
    const receipt = writeCoordinatorSelectionStartReceiptV2({
      root,
      claim: {
        queueId: '8f76ce25-9b10-4ddb-8e94-43a4d880d4fc',
        claimEpoch: 1,
        claimBindingDigest: 'b'.repeat(64),
      },
      selectionObservation,
      ts: new Date(Date.now() - 1_000).toISOString(),
    });
    if (receipt.status !== 'recorded') throw new Error('V2 receipt was not recorded');
    const event: DispatchProductionEvent = {
      schemaVersion: 1,
      ts,
      itemId: 'local-v2-binding-item',
      source: 'todo',
      repo: fixture.home,
      title: 'local binding projection',
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.6',
      assignedBy: 'concurrent-planner',
      routeReason: 'ordinary route',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: root.runId,
      trajectoryId: root.trajectoryId,
      objectiveHash: root.objectiveHash,
      routerPolicyVersion: 'router-v1',
      learningEpoch: ts.slice(0, 10),
      selectionObservation,
      selectionStartReceiptId: receipt.receipt.receiptId,
      spentUsd: 0,
      basis: 'run-proposal-outcome',
    };
    const binding = {
      schemaVersion: 2 as const,
      receiptId: receipt.receipt.receiptId,
      receiptDigest: receiptDigestV2(receipt.receipt)!,
      queueId: receipt.receipt.claim.queueId,
      claimEpoch: receipt.receipt.claim.claimEpoch,
      claimBindingDigest: receipt.receipt.claim.claimBindingDigest,
      rootDigest: rootDigestV2(receipt.receipt.root)!,
      selectionDigest: selectionDigestV2(receipt.receipt.selectionObservation)!,
      committedAt: receipt.receipt.ts,
    };
    const reader = (receiptId: string) => receiptId === binding.receiptId
      ? ({ status: 'found' as const, binding })
      : ({ status: 'missing' as const, reason: 'receipt-binding-not-found' });

    expect(readLocallyBoundDispatchSelectionV2(event, reader)).toEqual({
      receiptId: receipt.receipt.receiptId,
      selectionObservation,
    });
    expect(readLocallyBoundDispatchSelectionV2(event, () => ({
      status: 'missing', reason: 'receipt-binding-not-found',
    }))).toBeUndefined();
    expect(readLocallyBoundDispatchSelectionV2(event, () => ({
      status: 'found', binding: { ...binding, committedAt: ts },
    }))).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDispatchSelectionObservation } from '../src/core/fleet/dispatch-production-ledger.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import { SharedWorkQueueCoordinator } from '../src/core/seams/work-queue-coordinator.js';
import type { WorkItem } from '../src/core/types.js';
import {
  createCoordinatorSelectionStartReceiptV2,
  createSelectionStartReceipt,
  coordinatorSelectionStartReceiptV2Dir,
  readCoordinatorSelectionStartReceiptV2,
  receiptMatchesSelectionBindingV2,
  readSelectionStartReceipt,
  receiptDigestV2,
  rootDigestV2,
  selectionDigestV2,
  selectionStartReceiptDir,
  verifyCoordinatorSelectionStartReceiptV2,
  verifySelectionStartReceipt,
  writeCoordinatorSelectionStartReceiptV2,
  writeSelectionStartReceipt,
} from '../src/core/fleet/selection-start-receipt.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

const key = Buffer.alloc(32, 7);
const root = {
  runId: 'selection-receipt-run',
  trajectoryId: 'run:selection-receipt-run',
  objectiveHash: 'a'.repeat(64),
};
const claim = {
  queueId: '8f76ce25-9b10-4ddb-8e94-43a4d880d4fc',
  claimEpoch: 42,
  claimBindingDigest: 'b'.repeat(64),
};

function observation() {
  const value = createDispatchSelectionObservation({
    candidates: [
      { backend: 'codex', tier: 'frontier', model: 'gpt-5' },
      { backend: 'claude', tier: 'frontier', model: 'sonnet' },
    ],
    selected: { backend: 'codex', tier: 'frontier', model: 'gpt-5' },
    selectionPolicyVersion: 'selection-policy-v1',
    randomizationProtocolVersion: 'binary-uniform-v1',
    selectionProbabilityPpm: 500_000,
    trajectoryId: root.trajectoryId,
    runId: root.runId,
    objectiveHash: root.objectiveHash,
    routerPolicyVersion: 'router-v1',
    learningEpoch: 'epoch-1',
  }, key);
  if (!value) throw new Error('fixture observation failed');
  return value;
}

function input(ts = '2026-07-20T15:00:00.000Z') {
  return { root, claim, selectionObservation: observation(), ts };
}

function workItem(id: string): WorkItem {
  return {
    id,
    repo: '/tmp/selection-receipt-fixture',
    source: 'todo',
    title: id,
    detail: id,
    value: 1,
    effort: 1,
    score: 1,
    tags: [],
    ts: '2026-07-20T15:00:00.000Z',
  };
}

describe('selection start receipt contract', () => {
  it('signs and verifies an exact metadata-only root/claim/assignment envelope', () => {
    const receipt = createSelectionStartReceipt({
      root,
      claim,
      selectionObservation: observation(),
      ts: '2026-07-20T15:00:00.000Z',
    }, key);
    expect(receipt).not.toBeNull();
    expect(verifySelectionStartReceipt(receipt, key)).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain('ownerToken');
    expect(JSON.stringify(receipt)).not.toContain('candidates');
  });

  it('fails closed on signed-field tampering, extra fields, or a different key', () => {
    const receipt = createSelectionStartReceipt({
      root,
      claim,
      selectionObservation: observation(),
      ts: '2026-07-20T15:00:00.000Z',
    }, key)!;
    expect(verifySelectionStartReceipt({ ...receipt, ts: '2026-07-20T15:00:01.000Z' }, key)).toBeNull();
    expect(verifySelectionStartReceipt({ ...receipt, leakedCandidate: 'codex' }, key)).toBeNull();
    expect(verifySelectionStartReceipt(receipt, Buffer.alloc(32, 8))).toBeNull();
  });

  it('refuses local-looking or malformed root and claim authority', () => {
    expect(createSelectionStartReceipt({
      root,
      claim: { ...claim, queueId: 'local' },
      selectionObservation: observation(),
      ts: 'not-a-date',
    }, key)).toBeNull();
    expect(createSelectionStartReceipt({
      root: { ...root, trajectoryId: 'wrong' },
      claim,
      selectionObservation: observation(),
      ts: '2026-07-20T15:00:00.000Z',
    }, key)).toBeNull();
  });

  it('refuses non-binary or non-uniform selection observations', () => {
    expect(createSelectionStartReceipt({
      ...input(),
      selectionObservation: {
        ...observation(), randomizationProtocolVersion: 'uniform-v1',
      },
    }, key)).toBeNull();
    expect(createSelectionStartReceipt({
      ...input(),
      selectionObservation: {
        ...observation(), selectionProbabilityPpm: 1_000_000,
      },
    }, key)).toBeNull();
  });
});

describe('selection start receipt V2 contract', () => {
  it('signs and verifies an isolated coordinator-minted envelope', () => {
    const receipt = createCoordinatorSelectionStartReceiptV2(input(), key);
    expect(receipt).not.toBeNull();
    expect(receipt).toMatchObject({ schemaVersion: 2, authority: 'coordinator-minted-v2' });
    expect(verifyCoordinatorSelectionStartReceiptV2(receipt, key)).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain('ownerToken');
    expect(JSON.stringify(receipt)).not.toContain('candidates');
  });

  it('rejects altered V2 signed fields, extra fields, invalid authority, and a different key', () => {
    const receipt = createCoordinatorSelectionStartReceiptV2(input(), key)!;
    expect(verifyCoordinatorSelectionStartReceiptV2({ ...receipt, ts: '2026-07-20T15:00:01.000Z' }, key)).toBeNull();
    expect(verifyCoordinatorSelectionStartReceiptV2({ ...receipt, root: { ...root, objectiveHash: 'c'.repeat(64) } }, key)).toBeNull();
    expect(verifyCoordinatorSelectionStartReceiptV2({ ...receipt, leakedCandidate: 'codex' }, key)).toBeNull();
    expect(verifyCoordinatorSelectionStartReceiptV2({ ...receipt, root: { ...root, extra: true } }, key)).toBeNull();
    expect(verifyCoordinatorSelectionStartReceiptV2({ ...receipt, claim: { ...claim, extra: true } }, key)).toBeNull();
    expect(verifyCoordinatorSelectionStartReceiptV2({ ...receipt, selectionObservation: { ...observation(), extra: true } }, key)).toBeNull();
    expect(verifyCoordinatorSelectionStartReceiptV2({ ...receipt, authority: 'observation-only' }, key)).toBeNull();
    expect(verifyCoordinatorSelectionStartReceiptV2(receipt, Buffer.alloc(32, 8))).toBeNull();
  });

  it('exports stable public binding digests without accepting malformed metadata', () => {
    const first = createCoordinatorSelectionStartReceiptV2(input(), key)!;
    const second = createCoordinatorSelectionStartReceiptV2(input(), key)!;
    expect(receiptDigestV2(first)).toBe(receiptDigestV2(second));
    expect(rootDigestV2(root)).toMatch(/^[a-f0-9]{64}$/);
    expect(selectionDigestV2(observation())).toMatch(/^[a-f0-9]{64}$/);
    expect(receiptDigestV2({ ...first, extra: true })).toBeNull();
    expect(rootDigestV2({ ...root, trajectoryId: 'wrong' })).toBeNull();
    expect(selectionDigestV2({ ...observation(), selectionProbabilityPpm: 1_000_000 })).toBeNull();
  });
});

describe('selection start receipt store', () => {
  let fx: H1Fixture;

  beforeEach(() => {
    fx = makeFixture();
    loadOrCreateKey();
  });

  afterEach(() => fx.cleanup());

  it('installs a private immutable receipt, replays it, and refuses tampered authority', () => {
    const first = writeSelectionStartReceipt(input());
    expect(first.status).toBe('recorded');
    if (first.status !== 'recorded') throw new Error('receipt was not recorded');
    const path = join(selectionStartReceiptDir(), `${first.receipt.receiptId}.json`);
    expect(existsSync(path)).toBe(true);
    expect(readSelectionStartReceipt(first.receipt.receiptId)).toEqual({ status: 'found', receipt: first.receipt });

    const replay = writeSelectionStartReceipt(input('2026-07-20T15:01:00.000Z'));
    expect(replay).toEqual({ status: 'replayed', receipt: first.receipt });
    expect(writeSelectionStartReceipt({
      ...input('2026-07-20T15:02:00.000Z'),
      selectionObservation: { ...observation(), assignmentDigest: 'c'.repeat(64) },
    })).toEqual({ status: 'conflicted', reason: 'receipt-id-conflict' });
    expect(readFileSync(path, 'utf8')).not.toContain('ownerToken');
    expect(readFileSync(path, 'utf8')).not.toContain('candidates');

    writeFileSync(path, `${JSON.stringify({ ...first.receipt, signature: '0'.repeat(64) })}\n`, 'utf8');
    expect(readSelectionStartReceipt(first.receipt.receiptId)).toMatchObject({ status: 'degraded' });
  });
});

describe('selection start receipt V2 store', () => {
  let fx: H1Fixture;

  beforeEach(() => {
    fx = makeFixture();
    loadOrCreateKey();
  });

  afterEach(() => fx.cleanup());

  it('durably records and exactly replays an isolated V2 receipt', () => {
    const first = writeCoordinatorSelectionStartReceiptV2(input());
    expect(first.status).toBe('recorded');
    if (first.status !== 'recorded') throw new Error('V2 receipt was not recorded');
    const path = join(coordinatorSelectionStartReceiptV2Dir(), `${first.receipt.receiptId}.json`);
    expect(existsSync(path)).toBe(true);
    expect(readCoordinatorSelectionStartReceiptV2(first.receipt.receiptId)).toEqual({
      status: 'found', receipt: first.receipt,
    });

    expect(writeCoordinatorSelectionStartReceiptV2(input())).toEqual({
      status: 'replayed', receipt: first.receipt,
    });
    expect(writeCoordinatorSelectionStartReceiptV2(input('2026-07-20T15:01:00.000Z'))).toEqual({
      status: 'conflicted', reason: 'receipt-id-conflict',
    });
    expect(readFileSync(path, 'utf8')).not.toContain('ownerToken');
    expect(readFileSync(path, 'utf8')).not.toContain('candidates');
  });

  it('fails closed when a V2 receipt becomes tampered or unreadable', () => {
    const first = writeCoordinatorSelectionStartReceiptV2(input());
    if (first.status !== 'recorded') throw new Error('V2 receipt was not recorded');
    const path = join(coordinatorSelectionStartReceiptV2Dir(), `${first.receipt.receiptId}.json`);
    writeFileSync(path, `${JSON.stringify({ ...first.receipt, signature: '0'.repeat(64) })}\n`, 'utf8');
    expect(readCoordinatorSelectionStartReceiptV2(first.receipt.receiptId)).toMatchObject({ status: 'degraded' });
  });

  it('keeps V1 and V2 storage namespaces and readers isolated', () => {
    const v1 = writeSelectionStartReceipt(input());
    const v2 = writeCoordinatorSelectionStartReceiptV2(input());
    if (v1.status !== 'recorded' || v2.status !== 'recorded') throw new Error('receipts were not recorded');
    expect(selectionStartReceiptDir()).not.toBe(coordinatorSelectionStartReceiptV2Dir());
    expect(readSelectionStartReceipt(v2.receipt.receiptId)).toEqual({ status: 'missing', reason: 'absent' });
    expect(readCoordinatorSelectionStartReceiptV2(v1.receipt.receiptId)).toEqual({ status: 'missing', reason: 'absent' });
  });

  it('records only through the exact shared coordinator execution authority', () => {
    const store = new SharedStore(join(fx.home, 'shared-queue'), 30_000);
    const coordinator = new SharedWorkQueueCoordinator(store, 'machine-a', 30_000, true);
    const item = workItem('coordinator-receipt');
    expect(coordinator.claimItems([item], 1, 'machine-a')).toEqual([item]);
    const authority = coordinator.beginExecution(item, 'machine-a');
    if (!authority) throw new Error('execution authority was not minted');
    expect(coordinator.beginExecution(item, 'machine-a')).toBe(authority);

    const recorded = coordinator.recordSelectionStartReceiptV2(authority, {
      root,
      selectionObservation: observation(),
      ts: '2026-07-20T15:00:00.000Z',
    });
    expect(recorded.status).toBe('recorded');
    if (recorded.status !== 'recorded') throw new Error('coordinator receipt was not recorded');
    const binding = store.readSelectionReceiptBinding(recorded.receiptId);
    expect(binding).toMatchObject({
      status: 'found',
      binding: { receiptId: recorded.receiptId },
    });
    const receipt = readCoordinatorSelectionStartReceiptV2(recorded.receiptId);
    if (binding.status !== 'found' || receipt.status !== 'found') throw new Error('durable receipt join was not found');
    expect(receiptMatchesSelectionBindingV2(receipt.receipt, binding.binding)).toBe(true);
    expect(receiptMatchesSelectionBindingV2(receipt.receipt, {
      ...binding.binding,
      committedAt: '2026-07-20T15:00:01.000Z',
    })).toBe(false);
    expect(coordinator.recordSelectionStartReceiptV2({ ...authority }, {
      root,
      selectionObservation: observation(),
      ts: '2026-07-20T15:00:00.000Z',
    })).toMatchObject({ status: 'authority-lost' });
    expect(coordinator.recordSelectionStartReceiptV2(authority, {
      root,
      selectionObservation: observation(),
      ts: '2026-07-20T15:00:00.000Z',
    })).toEqual({ status: 'replayed', receiptId: recorded.receiptId });
    expect(coordinator.recordSelectionStartReceiptV2(authority, {
      root,
      selectionObservation: observation(),
      ts: '2026-07-20T15:01:00.000Z',
    })).toEqual({
      status: 'conflicted', reason: 'authority-already-bound-to-different-receipt',
    });
    expect(readdirSync(coordinatorSelectionStartReceiptV2Dir()).filter((name) => name.endsWith('.json')))
      .toEqual([`${recorded.receiptId}.json`]);
    expect(coordinator.settleClaim(item, 'machine-a')).toBe(true);
    expect(coordinator.recordSelectionStartReceiptV2(authority, {
      root,
      selectionObservation: observation(),
      ts: '2026-07-20T15:00:00.000Z',
    })).toMatchObject({ status: 'authority-lost' });
  });
});

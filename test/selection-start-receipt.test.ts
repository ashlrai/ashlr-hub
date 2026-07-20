import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDispatchSelectionObservation } from '../src/core/fleet/dispatch-production-ledger.js';
import {
  createCoordinatorSelectionStartReceiptV2,
  createSelectionStartReceipt,
  readSelectionStartReceipt,
  receiptDigestV2,
  rootDigestV2,
  selectionDigestV2,
  selectionStartReceiptDir,
  verifyCoordinatorSelectionStartReceiptV2,
  verifySelectionStartReceipt,
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

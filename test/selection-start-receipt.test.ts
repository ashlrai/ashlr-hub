import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDispatchSelectionObservation } from '../src/core/fleet/dispatch-production-ledger.js';
import {
  createSelectionStartReceipt,
  readSelectionStartReceipt,
  selectionStartReceiptDir,
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
    candidates: [{ backend: 'codex', tier: 'frontier', model: 'gpt-5' }],
    selected: { backend: 'codex', tier: 'frontier', model: 'gpt-5' },
    selectionPolicyVersion: 'selection-policy-v1',
    randomizationProtocolVersion: 'binary-uniform-v1',
    selectionProbabilityPpm: 1_000_000,
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

import { describe, expect, it } from 'vitest';
import { createDispatchSelectionObservation } from '../src/core/fleet/dispatch-production-ledger.js';
import {
  createSelectionStartReceipt,
  verifySelectionStartReceipt,
} from '../src/core/fleet/selection-start-receipt.js';

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

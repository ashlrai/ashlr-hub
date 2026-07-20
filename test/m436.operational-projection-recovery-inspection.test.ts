import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  migrateOperationalProposalProjection,
  observeOperationalProjectionArtifacts,
  operationalProposalProjectionDir,
  operationalProposalProjectionPath,
  validateOperationalProjectionStageText,
  validateOperationalProposalStageText,
} from '../src/core/inbox/operational-projection.js';
import { inspectOperationalProjectionRecoveryV2 } from '../src/core/inbox/operational-projection-recovery-inspection.js';
import {
  operationalProjectionTransactionPath,
  prepareOperationalProjectionTransactionJournalOnly,
} from '../src/core/inbox/operational-projection-transaction.js';
import {
  advanceOperationalProjectionTransaction,
  prepareOperationalProjectionTransaction,
} from '../src/core/inbox/operational-projection-transaction-coordinator.js';
import { operationalProjectionReplayLedgerPath } from '../src/core/inbox/operational-projection-replay-ledger.js';
import {
  operationalProjectionStagePath,
  writeOperationalProjectionStage,
} from '../src/core/inbox/operational-projection-staging.js';
import {
  acquireProposalStoreMutationLock,
  releaseProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';
import { inboxDir } from '../src/core/inbox/store.js';
import type { Proposal } from '../src/core/types.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let home: string;
let repo: string;
let lock: ProposalStoreMutationLock | null;

function restore(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

function proposal(title: string, id = 'proposal-436-v2'): Proposal {
  return {
    id, repo, origin: 'agent', kind: 'patch', title,
    summary: 'Recovery inspection fixture.', diff: 'diff --git a/a b/a\n',
    status: 'pending', createdAt: '2026-07-20T00:00:00.000Z',
  };
}

function writeProposal(value: Proposal): void {
  fs.mkdirSync(inboxDir(), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(inboxDir(), 0o700);
  fs.writeFileSync(path.join(inboxDir(), `${value.id}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

beforeEach(() => {
  lock = null;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m436-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { mode: 0o700 });
  repo = fs.realpathSync(repo);
  loadOrCreateKey();
  fs.mkdirSync(operationalProposalProjectionDir(), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(home, '.ashlr'), 0o700);
    fs.chmodSync(operationalProposalProjectionDir(), 0o700);
  }
  lock = acquireProposalStoreMutationLock();
  expect(lock).not.toBeNull();
});

afterEach(() => {
  releaseProposalStoreMutationLock(lock);
  fs.rmSync(home, { recursive: true, force: true });
  restore('HOME', originalHome);
  restore('USERPROFILE', originalUserProfile);
});

describe('M436 operational projection recovery inspection', () => {
  it('is read-only for a missing active transaction and rejects a foreign lock', () => {
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toEqual({ state: 'no-active-v2-transaction' });
    expect(inspectOperationalProjectionRecoveryV2({} as ProposalStoreMutationLock))
      .toEqual({ state: 'refused', reason: 'store-lock-not-owned' });
    expect(fs.existsSync(path.join(operationalProposalProjectionDir(), 'active-transaction.json'))).toBe(false);
  });

  it('refuses a released store lock before observing or writing recovery state', () => {
    const staleLock = lock!;
    const projectionDir = operationalProposalProjectionDir();
    const beforeEntries = fs.readdirSync(projectionDir).sort();
    releaseProposalStoreMutationLock(staleLock);
    lock = acquireProposalStoreMutationLock();
    expect(lock).not.toBeNull();

    expect(inspectOperationalProjectionRecoveryV2(staleLock)).toEqual({
      state: 'refused', reason: 'store-lock-not-owned',
    });
    expect(fs.readdirSync(projectionDir).sort()).toEqual(beforeEntries);
    expect(fs.existsSync(path.join(projectionDir, 'active-transaction.json'))).toBe(false);
    expect(fs.existsSync(path.join(projectionDir, 'staged'))).toBe(false);
  });

  it('refuses authenticated V1 journal records without creating replay or staging state', () => {
    const result = prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-436',
      before: { proposal: '1'.repeat(64), projection: '2'.repeat(64) },
      after: { proposal: '3'.repeat(64), projection: '4'.repeat(64) },
      storeLock: lock!, now: new Date('2026-07-20T01:00:00.000Z'),
    });
    expect(result.state).toBe('healthy');
    expect(inspectOperationalProjectionRecoveryV2(lock!))
      .toEqual({ state: 'refused', reason: 'transaction-not-v2' });
    expect(fs.existsSync(path.join(operationalProposalProjectionDir(), 'staged'))).toBe(false);
  });

  it('refuses a malformed active journal without changing recovery storage', () => {
    const active = path.join(operationalProposalProjectionDir(), 'active-transaction.json');
    const malformed = '{"schemaVersion":2}';
    fs.writeFileSync(active, malformed, { mode: 0o600 });

    expect(inspectOperationalProjectionRecoveryV2(lock!)).toEqual({
      state: 'refused', reason: 'transaction-transaction-invalid',
    });
    expect(fs.readFileSync(active, 'utf8')).toBe(malformed);
    expect(fs.existsSync(path.join(operationalProposalProjectionDir(), 'staged'))).toBe(false);
    expect(fs.existsSync(operationalProjectionReplayLedgerPath())).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('refuses a symlinked active journal without touching its target', () => {
    const active = operationalProjectionTransactionPath();
    const outside = path.join(home, 'outside-transaction.json');
    const content = '{"outside":true}';
    fs.writeFileSync(outside, content, { mode: 0o600 });
    fs.symlinkSync(outside, active);

    expect(inspectOperationalProjectionRecoveryV2(lock!)).toMatchObject({
      state: 'refused', reason: expect.stringMatching(/^transaction-/),
    });
    expect(fs.readFileSync(outside, 'utf8')).toBe(content);
    expect(fs.existsSync(path.join(operationalProposalProjectionDir(), 'staged'))).toBe(false);
    expect(fs.existsSync(operationalProjectionReplayLedgerPath())).toBe(false);
  });

  it('reports a V2 no-effect recovery action without changing canonical artifacts or phases', () => {
    const beforeProposal = proposal('Before stage');
    writeProposal(beforeProposal);
    const beforeMigration = migrateOperationalProposalProjection({ proposals: [beforeProposal], storeLock: lock! });
    expect(beforeMigration).toMatchObject({ state: 'healthy' });
    const before = observeOperationalProjectionArtifacts(beforeProposal.id, lock!);
    expect(before.state).toBe('healthy');
    if (before.state !== 'healthy') return;
    const beforeProposalText = fs.readFileSync(path.join(inboxDir(), `${beforeProposal.id}.json`));
    const beforeProjectionText = fs.readFileSync(operationalProposalProjectionPath());

    const afterProposal = proposal('After stage');
    writeProposal(afterProposal);
    const afterMigration = migrateOperationalProposalProjection({ proposals: [afterProposal], storeLock: lock! });
    expect(afterMigration.state).toBe('healthy');
    const key = loadOrCreateKey();
    const afterProposalText = JSON.stringify(Object.fromEntries(
      Object.entries(afterProposal).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    ));
    const afterProjectionText = fs.readFileSync(operationalProposalProjectionPath(), 'utf8');
    const proposalValidation = validateOperationalProposalStageText(afterProposalText, afterProposal.id);
    const projectionValidation = validateOperationalProjectionStageText(afterProjectionText, key);
    expect(proposalValidation).not.toBeNull();
    expect(projectionValidation).not.toBeNull();
    if (!proposalValidation || !projectionValidation) return;

    fs.writeFileSync(path.join(inboxDir(), `${beforeProposal.id}.json`), beforeProposalText, { mode: 0o600 });
    fs.writeFileSync(operationalProposalProjectionPath(), beforeProjectionText, { mode: 0o600 });
    const prepared = prepareOperationalProjectionTransaction({
      proposalId: beforeProposal.id,
      before: { proposal: before.proposal.digest, projection: before.projection.digest },
      after: { proposal: proposalValidation.digest, projection: projectionValidation.digest },
      staged: {
        proposal: { present: true, ...proposalValidation },
        projection: { present: true, ...projectionValidation },
      },
      storeLock: lock!, now: new Date('2026-07-20T01:00:00.000Z'),
    });
    expect(prepared).toMatchObject({ state: 'healthy', transaction: { schemaVersion: 2, phase: 'prepared' } });
    if (prepared.state !== 'healthy') return;
    const validateProposal = (text: string) => validateOperationalProposalStageText(text, beforeProposal.id);
    expect(writeOperationalProjectionStage(
      prepared.transaction.transactionId,
      'proposal',
      Buffer.from(afterProposalText),
      prepared.transaction.staged.proposal,
      validateProposal,
    )).toEqual({ ok: true });
    expect(writeOperationalProjectionStage(
      prepared.transaction.transactionId,
      'projection',
      Buffer.from(afterProjectionText),
      prepared.transaction.staged.projection,
      (text) => validateOperationalProjectionStageText(text, key),
    )).toEqual({ ok: true });

    expect(inspectOperationalProjectionRecoveryV2(lock!)).toEqual({
      state: 'recoverable-observation', transactionId: prepared.transaction.transactionId,
      phase: 'prepared', actual: 'no-effect', next: 'would-write-proposal',
    });
    expect(fs.readFileSync(path.join(inboxDir(), `${beforeProposal.id}.json`))).toEqual(beforeProposalText);
    expect(fs.readFileSync(operationalProposalProjectionPath())).toEqual(beforeProjectionText);

    fs.writeFileSync(
      operationalProjectionStagePath(prepared.transaction.transactionId, 'projection'),
      '{}',
      { mode: 0o600 },
    );
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toEqual({
      state: 'refused', reason: 'projection-stage-stage-content-invalid',
    });
    if (process.platform !== 'win32') {
      const stagedProposal = operationalProjectionStagePath(prepared.transaction.transactionId, 'proposal');
      const outsideProposal = path.join(home, 'outside-proposal.json');
      fs.writeFileSync(outsideProposal, afterProposalText, { mode: 0o600 });
      fs.rmSync(stagedProposal);
      fs.symlinkSync(outsideProposal, stagedProposal);
      expect(inspectOperationalProjectionRecoveryV2(lock!)).toMatchObject({
        state: 'refused', reason: expect.stringMatching(/^proposal-stage-stage-/),
      });
      expect(fs.readFileSync(path.join(inboxDir(), `${beforeProposal.id}.json`))).toEqual(beforeProposalText);
      expect(fs.readFileSync(operationalProposalProjectionPath())).toEqual(beforeProjectionText);
      fs.unlinkSync(stagedProposal);
      expect(writeOperationalProjectionStage(
        prepared.transaction.transactionId,
        'proposal',
        Buffer.from(afterProposalText),
        prepared.transaction.staged.proposal,
        validateProposal,
      )).toEqual({ ok: true });
    }
    expect(writeOperationalProjectionStage(
      prepared.transaction.transactionId,
      'projection',
      Buffer.from(afterProjectionText),
      prepared.transaction.staged.projection,
      (text) => validateOperationalProjectionStageText(text, key),
    )).toEqual({ ok: true });

    fs.writeFileSync(operationalProposalProjectionPath(), afterProjectionText, { mode: 0o600 });
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toEqual({
      state: 'refused', reason: 'artifact-state-projection-only',
    });
    fs.writeFileSync(operationalProposalProjectionPath(), beforeProjectionText, { mode: 0o600 });

    writeProposal(proposal('Unbound third state'));
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toEqual({
      state: 'refused', reason: 'artifact-state-unknown',
    });
    fs.writeFileSync(path.join(inboxDir(), `${beforeProposal.id}.json`), beforeProposalText, { mode: 0o600 });

    fs.rmSync(operationalProjectionStagePath(prepared.transaction.transactionId, 'proposal'));
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toEqual({
      state: 'refused', reason: 'proposal-stage-stage-missing',
    });
    expect(writeOperationalProjectionStage(
      prepared.transaction.transactionId,
      'proposal',
      Buffer.from(afterProposalText),
      prepared.transaction.staged.proposal,
      validateProposal,
    )).toEqual({ ok: true });
    fs.rmSync(operationalProjectionReplayLedgerPath());
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toEqual({
      state: 'refused', reason: 'replay-missing-local-ledger',
    });
    expect(fs.readFileSync(path.join(inboxDir(), `${beforeProposal.id}.json`))).toEqual(beforeProposalText);
    expect(fs.readFileSync(operationalProposalProjectionPath())).toEqual(beforeProjectionText);
  });

  it('plans and observes the first creation effect without treating absence as degraded authority', () => {
    const createProposal = proposal('Created stage', 'proposal-436-create');
    writeProposal(createProposal);
    expect(migrateOperationalProposalProjection({ proposals: [createProposal], storeLock: lock! }).state).toBe('healthy');
    const created = observeOperationalProjectionArtifacts(createProposal.id, lock!);
    expect(created.state).toBe('healthy');
    if (created.state !== 'healthy') return;
    const createProposalText = JSON.stringify(Object.fromEntries(
      Object.entries(createProposal).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    ));
    const createProjectionText = fs.readFileSync(operationalProposalProjectionPath(), 'utf8');
    const key = loadOrCreateKey();
    const createProposalStage = validateOperationalProposalStageText(createProposalText, createProposal.id);
    const createProjectionStage = validateOperationalProjectionStageText(createProjectionText, key);
    expect(createProposalStage).not.toBeNull();
    expect(createProjectionStage).not.toBeNull();
    if (!createProposalStage || !createProjectionStage) return;
    fs.rmSync(path.join(inboxDir(), `${createProposal.id}.json`));
    fs.rmSync(operationalProposalProjectionPath());
    const createPrepared = prepareOperationalProjectionTransaction({
      proposalId: createProposal.id,
      before: { proposal: null, projection: null },
      after: { proposal: created.proposal.digest, projection: created.projection.digest },
      staged: {
        proposal: { present: true, ...createProposalStage },
        projection: { present: true, ...createProjectionStage },
      },
      storeLock: lock!, now: new Date('2026-07-20T02:00:00.000Z'),
    });
    expect(createPrepared.state).toBe('healthy');
    if (createPrepared.state !== 'healthy') return;
    expect(writeOperationalProjectionStage(
      createPrepared.transaction.transactionId, 'proposal', Buffer.from(createProposalText),
      createPrepared.transaction.staged.proposal,
      (text) => validateOperationalProposalStageText(text, createProposal.id),
    )).toEqual({ ok: true });
    expect(writeOperationalProjectionStage(
      createPrepared.transaction.transactionId, 'projection', Buffer.from(createProjectionText),
      createPrepared.transaction.staged.projection,
      (text) => validateOperationalProjectionStageText(text, key),
    )).toEqual({ ok: true });
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toMatchObject({
      state: 'recoverable-observation', actual: 'no-effect', next: 'would-write-proposal',
    });
    expect(fs.existsSync(path.join(inboxDir(), `${createProposal.id}.json`))).toBe(false);

    fs.writeFileSync(path.join(inboxDir(), `${createProposal.id}.json`), createProposalText, { mode: 0o600 });
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toMatchObject({
      state: 'recoverable-observation', actual: 'proposal-only', next: 'would-attest-proposal-installed',
    });
    expect(fs.existsSync(operationalProposalProjectionPath())).toBe(false);
  });

  it('plans and observes the first deletion effect without treating absence as degraded authority', () => {
    const deleteProposal = proposal('Deleted stage', 'proposal-436-delete');
    writeProposal(deleteProposal);
    expect(migrateOperationalProposalProjection({ proposals: [deleteProposal], storeLock: lock! }).state).toBe('healthy');
    const beforeDelete = observeOperationalProjectionArtifacts(deleteProposal.id, lock!);
    expect(beforeDelete.state).toBe('healthy');
    if (beforeDelete.state !== 'healthy') return;

    const deletePrepared = prepareOperationalProjectionTransaction({
      proposalId: deleteProposal.id,
      before: { proposal: beforeDelete.proposal.digest, projection: beforeDelete.projection.digest },
      after: { proposal: null, projection: null },
      staged: {
        proposal: { present: false, digest: null, bytes: 0 },
        projection: { present: false, digest: null, bytes: 0 },
      },
      storeLock: lock!, now: new Date('2026-07-20T03:00:00.000Z'),
    });
    expect(deletePrepared.state).toBe('healthy');
    if (deletePrepared.state !== 'healthy') return;
    expect(writeOperationalProjectionStage(
      deletePrepared.transaction.transactionId, 'proposal', Buffer.alloc(0),
      deletePrepared.transaction.staged.proposal, () => null,
    )).toEqual({ ok: true });
    expect(writeOperationalProjectionStage(
      deletePrepared.transaction.transactionId, 'projection', Buffer.alloc(0),
      deletePrepared.transaction.staged.projection, () => null,
    )).toEqual({ ok: true });
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toMatchObject({
      state: 'recoverable-observation', actual: 'no-effect', next: 'would-delete-proposal',
    });

    fs.rmSync(path.join(inboxDir(), `${deleteProposal.id}.json`));
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toMatchObject({
      state: 'recoverable-observation', actual: 'proposal-only', next: 'would-attest-proposal-installed',
    });
    expect(fs.existsSync(operationalProposalProjectionPath())).toBe(true);
  });

  it('observes every remaining phase boundary without installing or advancing state', () => {
    const proposalId = 'proposal-436-phases';
    const beforeProposal = proposal('Before phases', proposalId);
    writeProposal(beforeProposal);
    expect(migrateOperationalProposalProjection({ proposals: [beforeProposal], storeLock: lock! }).state).toBe('healthy');
    const before = observeOperationalProjectionArtifacts(proposalId, lock!);
    expect(before.state).toBe('healthy');
    if (before.state !== 'healthy') return;
    const beforeProposalText = fs.readFileSync(path.join(inboxDir(), `${proposalId}.json`));
    const beforeProjectionText = fs.readFileSync(operationalProposalProjectionPath());

    const afterProposal = proposal('After phases', proposalId);
    writeProposal(afterProposal);
    expect(migrateOperationalProposalProjection({ proposals: [afterProposal], storeLock: lock! }).state).toBe('healthy');
    const after = observeOperationalProjectionArtifacts(proposalId, lock!);
    expect(after.state).toBe('healthy');
    if (after.state !== 'healthy') return;
    const afterProposalText = JSON.stringify(Object.fromEntries(
      Object.entries(afterProposal).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    ));
    const afterProjectionText = fs.readFileSync(operationalProposalProjectionPath(), 'utf8');
    const key = loadOrCreateKey();
    const proposalStage = validateOperationalProposalStageText(afterProposalText, proposalId);
    const projectionStage = validateOperationalProjectionStageText(afterProjectionText, key);
    expect(proposalStage).not.toBeNull();
    expect(projectionStage).not.toBeNull();
    if (!proposalStage || !projectionStage) return;

    fs.writeFileSync(path.join(inboxDir(), `${proposalId}.json`), beforeProposalText, { mode: 0o600 });
    fs.writeFileSync(operationalProposalProjectionPath(), beforeProjectionText, { mode: 0o600 });
    const prepared = prepareOperationalProjectionTransaction({
      proposalId,
      before: { proposal: before.proposal.digest, projection: before.projection.digest },
      after: { proposal: after.proposal.digest, projection: after.projection.digest },
      staged: {
        proposal: { present: true, ...proposalStage },
        projection: { present: true, ...projectionStage },
      },
      storeLock: lock!, now: new Date('2026-07-20T04:00:00.000Z'),
    });
    expect(prepared.state).toBe('healthy');
    if (prepared.state !== 'healthy') return;
    expect(writeOperationalProjectionStage(
      prepared.transaction.transactionId, 'proposal', Buffer.from(afterProposalText),
      prepared.transaction.staged.proposal,
      (text) => validateOperationalProposalStageText(text, proposalId),
    )).toEqual({ ok: true });
    expect(writeOperationalProjectionStage(
      prepared.transaction.transactionId, 'projection', Buffer.from(afterProjectionText),
      prepared.transaction.staged.projection,
      (text) => validateOperationalProjectionStageText(text, key),
    )).toEqual({ ok: true });

    fs.writeFileSync(path.join(inboxDir(), `${proposalId}.json`), afterProposalText, { mode: 0o600 });
    expect(advanceOperationalProjectionTransaction(
      prepared.transaction.transactionId, 'proposal-installed', lock!, new Date('2026-07-20T04:01:00.000Z'),
    )).toMatchObject({ state: 'healthy', transaction: { phase: 'proposal-installed' } });
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toMatchObject({
      state: 'recoverable-observation', phase: 'proposal-installed', actual: 'proposal-only', next: 'would-write-projection',
    });

    fs.writeFileSync(operationalProposalProjectionPath(), afterProjectionText, { mode: 0o600 });
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toMatchObject({
      state: 'recoverable-observation', phase: 'proposal-installed', actual: 'complete', next: 'would-attest-projection-installed',
    });
    expect(advanceOperationalProjectionTransaction(
      prepared.transaction.transactionId, 'projection-installed', lock!, new Date('2026-07-20T04:02:00.000Z'),
    )).toMatchObject({ state: 'healthy', transaction: { phase: 'projection-installed' } });
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toMatchObject({
      state: 'recoverable-observation', phase: 'projection-installed', actual: 'complete', next: 'would-attest-committed',
    });
    expect(advanceOperationalProjectionTransaction(
      prepared.transaction.transactionId, 'committed', lock!, new Date('2026-07-20T04:03:00.000Z'),
    )).toMatchObject({ state: 'healthy', transaction: { phase: 'committed' } });
    expect(inspectOperationalProjectionRecoveryV2(lock!)).toEqual({
      state: 'complete-observation', transactionId: prepared.transaction.transactionId,
    });
  });
});

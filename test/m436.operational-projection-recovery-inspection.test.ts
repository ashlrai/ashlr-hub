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
import { prepareOperationalProjectionTransactionJournalOnly } from '../src/core/inbox/operational-projection-transaction.js';
import { prepareOperationalProjectionTransaction } from '../src/core/inbox/operational-projection-transaction-coordinator.js';
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

function proposal(title: string): Proposal {
  return {
    id: 'proposal-436-v2', repo, origin: 'agent', kind: 'patch', title,
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
      phase: 'prepared', actual: 'no-effect', next: 'would-install-proposal',
    });
    expect(fs.readFileSync(path.join(inboxDir(), `${beforeProposal.id}.json`))).toEqual(beforeProposalText);
    expect(fs.readFileSync(operationalProposalProjectionPath())).toEqual(beforeProjectionText);

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
});

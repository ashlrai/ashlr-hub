import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { operationalProposalProjectionDir } from '../src/core/inbox/operational-projection.js';
import { inspectOperationalProjectionRecoveryV2 } from '../src/core/inbox/operational-projection-recovery-inspection.js';
import { prepareOperationalProjectionTransactionJournalOnly } from '../src/core/inbox/operational-projection-transaction.js';
import {
  acquireProposalStoreMutationLock,
  releaseProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let home: string;
let lock: ProposalStoreMutationLock | null;

function restore(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

beforeEach(() => {
  lock = null;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m436-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  loadOrCreateKey();
  fs.mkdirSync(operationalProposalProjectionDir(), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(operationalProposalProjectionDir(), 0o700);
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
});

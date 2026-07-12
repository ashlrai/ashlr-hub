import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  sanitizeRemoteHandoffReconciliation,
  verifyRemoteHandoffReconciliation,
} from '../src/core/inbox/remote-handoff-attestation.js';
import type { ProposalRemoteHandoff } from '../src/core/types.js';

const priorHome = process.env.ASHLR_HOME;
let home: string | undefined;

function handoff(): ProposalRemoteHandoff {
  return {
    provider: 'github', state: 'merged', prUrl: 'https://github.com/ashlrai/hub/pull/7',
    branch: 'ashlr/change', base: 'main', mergeCommitOid: 'a'.repeat(40),
    mergedAt: '2026-07-11T12:00:00.000Z', createdAt: '2026-07-10T12:00:00.000Z',
  };
}

afterEach(() => {
  if (priorHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = priorHome;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe('M378 remote host reconciliation attestation', () => {
  it('drops malformed and unverifiable receipts', () => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-m378-'));
    process.env.ASHLR_HOME = join(home, '.ashlr');
    const repo = resolve(home, 'repo');
    expect(sanitizeRemoteHandoffReconciliation('proposal-1', repo, {
      ...handoff(),
      reconciliation: { schemaVersion: 1, observedAt: '2026-07-12T12:00:00.000Z', attestation: '0'.repeat(64) },
    })).toBeUndefined();
  });

  it('rejects receipts observed before merge or beyond bounded clock skew', () => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-m378-'));
    process.env.ASHLR_HOME = join(home, '.ashlr');
    const repo = resolve(home, 'repo');
    expect(verifyRemoteHandoffReconciliation('proposal-1', repo, {
      ...handoff(),
      reconciliation: {
        schemaVersion: 1, observedAt: '2026-07-11T11:59:59.999Z', attestation: '0'.repeat(64),
      },
    })).toBe(false);
    expect(verifyRemoteHandoffReconciliation('proposal-1', repo, {
      ...handoff(),
      reconciliation: {
        schemaVersion: 1, observedAt: new Date(Date.now() + 61_000).toISOString(), attestation: '0'.repeat(64),
      },
    })).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireProposalMutationLock,
  ownsProposalMutationLock,
  releaseProposalMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';

let priorHome: string | undefined;
let home: string;

beforeEach(() => {
  priorHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-proposal-lock-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

describe('proposal mutation authority fence', () => {
  it('rejects unrelated same-process entrants and only accepts the exact owner capability', () => {
    const owner = acquireProposalMutationLock('prop-authority-fence', 20);
    expect(owner).not.toBeNull();
    expect(ownsProposalMutationLock('prop-authority-fence', owner)).toBe(true);
    expect(acquireProposalMutationLock('prop-authority-fence', 20)).toBeNull();

    releaseProposalMutationLock({ key: owner!.key, token: Symbol('forged') });
    expect(acquireProposalMutationLock('prop-authority-fence', 20)).toBeNull();

    releaseProposalMutationLock(owner);
    const successor = acquireProposalMutationLock('prop-authority-fence', 20);
    expect(successor).not.toBeNull();
    releaseProposalMutationLock(successor);
  });
});

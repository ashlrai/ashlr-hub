import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assure: vi.fn(),
  viewPr: vi.fn(),
}));

vi.mock('../src/core/util/private-storage.js', () => ({
  assurePrivateStoragePath: mocks.assure,
}));

vi.mock('../src/core/integrations/github.js', () => ({
  viewPr: mocks.viewPr,
}));

import { viewPrWithReconciliation } from '../src/core/inbox/remote-handoff-attestation.js';
import type { ProposalRemoteHandoff } from '../src/core/types.js';

const priorHome = process.env.ASHLR_HOME;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-m380-'));
  process.env.ASHLR_HOME = join(home, '.ashlr');
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  mocks.assure.mockReset();
  mocks.viewPr.mockReset();
  mocks.viewPr.mockReturnValue({
    state: 'MERGED',
    mergedAt: '2026-07-12T04:00:00.000Z',
    mergeCommitOid: 'a'.repeat(40),
    url: 'https://github.com/ashlrai/hub/pull/7',
    headRefName: 'ashlr/change',
    baseRefName: 'main',
  });
});

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  if (priorHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

function handoff(): ProposalRemoteHandoff {
  return {
    provider: 'github', state: 'awaiting-host-merge',
    prUrl: 'https://github.com/ashlrai/hub/pull/7',
    branch: 'ashlr/change', base: 'main', createdAt: '2026-07-12T03:00:00.000Z',
  };
}

describe('M380 Windows reconciliation key lifecycle', () => {
  it('removes a new directory when ACL assurance fails and retries cleanly', () => {
    const privateDir = join(home, '.ashlr', 'foundry', 'reconciliation');
    let rejectedDirectory = false;
    mocks.assure.mockImplementation((_path: string, kind: string, mode: string) => {
      if (kind === 'directory' && mode === 'secure-created' && !rejectedDirectory) {
        rejectedDirectory = true;
        return { ok: false, reason: 'adapter-failed' };
      }
      return { ok: true, reason: 'exact-private-dacl' };
    });

    expect(viewPrWithReconciliation(home, '7', 'proposal-7', handoff())?.reconciliation).toBeUndefined();
    expect(rejectedDirectory).toBe(true);
    expect(existsSync(privateDir)).toBe(false);
    expect(viewPrWithReconciliation(home, '7', 'proposal-7', handoff())?.reconciliation?.attestation)
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it('writes no secret on ACL failure, removes the partial file, and succeeds on retry', () => {
    const keyPath = join(home, '.ashlr', 'foundry', 'reconciliation', 'key');
    let rejectedEmptyFile = false;
    mocks.assure.mockImplementation((path: string, kind: string, mode: string) => {
      if (kind === 'file' && mode === 'secure-created' && !rejectedEmptyFile) {
        expect(resolve(path)).toBe(resolve(keyPath));
        expect(lstatSync(path).size).toBe(0);
        rejectedEmptyFile = true;
        return { ok: false, reason: 'adapter-failed' };
      }
      return { ok: true, reason: 'exact-private-dacl' };
    });

    expect(viewPrWithReconciliation(home, '7', 'proposal-7', handoff())?.reconciliation).toBeUndefined();
    expect(rejectedEmptyFile).toBe(true);
    expect(existsSync(keyPath)).toBe(false);

    const retried = viewPrWithReconciliation(home, '7', 'proposal-7', handoff());
    expect(retried?.reconciliation?.attestation).toMatch(/^[a-f0-9]{64}$/);
    expect(lstatSync(keyPath).size).toBe(32);
  });

  it('retains and uses an exact legacy flat key instead of rotating prior receipts', () => {
    const legacy = join(home, '.ashlr', 'foundry', 'remote-handoff-reconciliation.key');
    const replacement = join(home, '.ashlr', 'foundry', 'reconciliation', 'key');
    mkdirSync(join(home, '.ashlr', 'foundry'), { recursive: true });
    writeFileSync(legacy, Buffer.alloc(32, 9));
    mocks.assure.mockReturnValue({ ok: true, reason: 'exact-private-dacl' });

    expect(viewPrWithReconciliation(home, '7', 'proposal-7', handoff())?.reconciliation?.attestation)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(lstatSync(legacy).size).toBe(32);
    expect(existsSync(replacement)).toBe(false);
    expect(mocks.assure).toHaveBeenCalledWith(legacy, 'file', 'inspect-existing', {
      anchorPath: join(home, '.ashlr'),
    });
  });
});

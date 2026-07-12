import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  inboxDir,
  listProposals,
  listProposalsDetailed,
} from '../src/core/inbox/store.js';
import type { Proposal } from '../src/core/types.js';

const originalHome = process.env.HOME;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m374-proposals-'));
  process.env.HOME = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

function proposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id,
    repo: '/tmp/repo',
    origin: 'manual',
    kind: 'patch',
    title: id,
    summary: `summary for ${id}`,
    status: 'pending',
    createdAt: '2026-07-11T12:00:00.000Z',
    ...overrides,
  };
}

function seed(file: string, value: unknown): string {
  fs.mkdirSync(inboxDir(), { recursive: true });
  const target = path.join(inboxDir(), file);
  fs.writeFileSync(target, JSON.stringify(value), 'utf8');
  return target;
}

describe('M374 bounded detailed proposal enumeration', () => {
  it('reports a missing source distinctly from a healthy empty source', () => {
    expect(listProposalsDetailed()).toMatchObject({
      proposals: [],
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
      filesDiscovered: 0,
      filesRead: 0,
    });

    fs.mkdirSync(inboxDir(), { recursive: true });
    expect(listProposalsDetailed()).toMatchObject({
      proposals: [],
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
    });
  });

  it('orders and filters deterministically while reusing validation and sanitization', () => {
    seed('z.json', proposal('same-a', {
      title: 'secret_key = "abcdefghijklmnopqrstuvwxyz1234567890"',
    }));
    seed('a.json', proposal('same-z'));
    seed('middle.json', proposal('newest', {
      status: 'approved',
      createdAt: '2026-07-11T13:00:00.000Z',
    }));
    seed('ignored.json.tmp', proposal('temporary'));
    fs.writeFileSync(path.join(inboxDir(), 'ignored.txt'), '{}', 'utf8');

    const all = listProposalsDetailed();
    expect(all.proposals.map((item) => item.id)).toEqual(['newest', 'same-z', 'same-a']);
    expect(all.proposals.find((item) => item.id === 'same-a')?.title).toContain('[REDACTED]');
    expect(all).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      filesDiscovered: 3,
      filesRead: 3,
      invalidFiles: 0,
      unreadableFiles: 0,
      stopReasons: [],
    });
    expect(listProposalsDetailed({ status: 'approved' }).proposals.map((item) => item.id))
      .toEqual(['newest']);
  });

  it('counts malformed and structurally invalid files and requireComplete withholds rows', () => {
    seed('a-good.json', proposal('good'));
    fs.writeFileSync(path.join(inboxDir(), 'b-malformed.json'), '{', 'utf8');
    seed('c-invalid.json', { id: 'not-a-proposal' });

    const partial = listProposalsDetailed();
    expect(partial.proposals.map((item) => item.id)).toEqual(['good']);
    expect(partial).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      filesDiscovered: 3,
      filesRead: 3,
      invalidFiles: 2,
      unreadableFiles: 0,
      stopReasons: ['invalid-file'],
    });
    expect(listProposalsDetailed({ requireComplete: true }).proposals).toEqual([]);
  });

  it('rejects symlink, hardlinked, non-regular, and unreadable proposal paths', () => {
    seed('a-good.json', proposal('good'));
    const external = path.join(home, 'external.json');
    fs.writeFileSync(external, JSON.stringify(proposal('external')), 'utf8');
    fs.symlinkSync(external, path.join(inboxDir(), 'b-symlink.json'));
    fs.linkSync(external, path.join(inboxDir(), 'c-hardlink.json'));
    fs.mkdirSync(path.join(inboxDir(), 'd-directory.json'));
    const unreadable = seed('e-unreadable.json', proposal('unreadable'));
    fs.chmodSync(unreadable, 0o000);

    try {
      const result = listProposalsDetailed();
      expect(result.proposals.map((item) => item.id)).toEqual(['good']);
      expect(result).toMatchObject({
        sourceState: 'degraded',
        complete: false,
        filesDiscovered: 5,
        filesRead: 5,
        unreadableFiles: 4,
        stopReasons: ['io-error'],
      });
    } finally {
      fs.chmodSync(unreadable, 0o600);
    }
  });

  it('enforces file count, aggregate byte, and per-file byte limits', () => {
    const first = seed('a.json', proposal('a'));
    seed('b.json', proposal('b'));
    seed('c.json', proposal('c', { summary: 'x'.repeat(2_000) }));

    const fileLimited = listProposalsDetailed({ maxFiles: 1 });
    expect(fileLimited).toMatchObject({
      filesDiscovered: 3,
      filesRead: 1,
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['file-limit'],
    });

    const byteLimited = listProposalsDetailed({ maxBytes: fs.statSync(first).size });
    expect(byteLimited).toMatchObject({
      filesRead: 1,
      bytesRead: fs.statSync(first).size,
      sourceState: 'degraded',
      stopReasons: ['byte-limit'],
    });

    const perFileLimited = listProposalsDetailed({ maxFileBytes: 500 });
    expect(perFileLimited.proposals.map((item) => item.id)).toEqual(['b', 'a']);
    expect(perFileLimited).toMatchObject({
      filesRead: 3,
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['per-file-byte-limit'],
    });
    expect(listProposalsDetailed({ maxFiles: 1, requireComplete: true }).proposals).toEqual([]);
  });

  it('detects replacement of the inbox directory during enumeration', () => {
    seed('a.json', proposal('a'));
    seed('b.json', proposal('b'));
    const displaced = `${inboxDir()}-displaced`;
    const parse = JSON.parse.bind(JSON);
    let replaced = false;
    vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
      if (!replaced) {
        replaced = true;
        fs.renameSync(inboxDir(), displaced);
        fs.mkdirSync(inboxDir(), { recursive: true });
      }
      return parse(text) as unknown;
    });

    const result = listProposalsDetailed({ requireComplete: true });
    vi.mocked(JSON.parse).mockRestore();
    expect(result).toMatchObject({
      proposals: [],
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['io-error'],
    });
    expect(result.unreadableFiles).toBeGreaterThan(0);
  });

  it('does not change listProposals compatibility behavior or persisted bytes', () => {
    const valid = seed('valid.json', proposal('valid'));
    const linkedTarget = path.join(home, 'legacy-linked.json');
    fs.writeFileSync(linkedTarget, JSON.stringify(proposal('linked')), 'utf8');
    fs.symlinkSync(linkedTarget, path.join(inboxDir(), 'linked.json'));
    fs.writeFileSync(path.join(inboxDir(), 'malformed.json'), '{', 'utf8');
    const before = fs.readFileSync(valid);

    expect(listProposals().map((item) => item.id)).toEqual(['valid', 'linked']);
    listProposalsDetailed();
    expect(listProposals().map((item) => item.id)).toEqual(['valid', 'linked']);
    expect(fs.readFileSync(valid)).toEqual(before);
  });
});

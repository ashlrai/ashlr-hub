import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  _setProposalReadRaceHookForTest,
  createProposal,
  inboxDir,
  listProposals,
  listProposalsDetailed,
  loadProposal,
  setStatus,
} from '../src/core/inbox/store.js';
import type { Proposal } from '../src/core/types.js';

const originalHome = process.env.HOME;
const REPO = path.join(fs.realpathSync.native(os.tmpdir()), 'ashlr-m374-repo');
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m374-proposals-'));
  process.env.HOME = home;
});

afterEach(() => {
  _setProposalReadRaceHookForTest(undefined);
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

function proposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id,
    repo: REPO,
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
    seed('same-a.json', proposal('same-a', {
      title: 'secret_key = "abcdefghijklmnopqrstuvwxyz1234567890"',
    }));
    seed('same-z.json', proposal('same-z'));
    seed('newest.json', proposal('newest', {
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
    seed('good.json', proposal('good'));
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
    seed('good.json', proposal('good'));
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

  it('rejects filename and embedded proposal identity disagreement', () => {
    seed('claimed.json', proposal('embedded'));

    const result = listProposalsDetailed();
    expect(result).toMatchObject({
      proposals: [],
      sourceState: 'degraded',
      complete: false,
      invalidFiles: 1,
      stopReasons: ['invalid-file'],
    });
    expect(listProposals()).toEqual([]);
    expect(loadProposal('claimed')).toBeNull();
    expect(setStatus('claimed', 'approved')).toBe(false);
    expect(fs.existsSync(path.join(inboxDir(), 'embedded.json'))).toBe(false);
  });

  it('rejects filenames whose embedded IDs cannot be addressed by lifecycle APIs', () => {
    seed('space id.json', proposal('space id'));

    expect(listProposals()).toEqual([]);
    expect(loadProposal('space id')).toBeNull();
    expect(listProposalsDetailed({ requireComplete: true })).toMatchObject({
      proposals: [],
      sourceState: 'degraded',
      complete: false,
      invalidFiles: 1,
      stopReasons: ['invalid-file'],
    });
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

  it('fails closed when the default source exceeds the hard proposal file cap', () => {
    for (let index = 0; index < 4_097; index++) {
      const id = `hard-cap-${String(index).padStart(4, '0')}`;
      seed(`${id}.json`, proposal(id));
    }

    expect(listProposalsDetailed({ requireComplete: true })).toMatchObject({
      proposals: [],
      sourceState: 'degraded',
      complete: false,
      filesDiscovered: 4_097,
      filesRead: 4_096,
      stopReasons: ['file-limit'],
    });
  });

  it('uses the same authoritative per-file ceiling for writes and default reads', () => {
    const oversizedSummary = 'x'.repeat(4 * 1024 * 1024);
    const written = createProposal({
      repo: REPO,
      origin: 'manual',
      kind: 'patch',
      title: 'oversized writer',
      summary: oversizedSummary,
    });
    expect(written).toMatchObject({
      status: 'rejected',
      decisionReason: 'proposal persistence failed',
    });
    expect(fs.existsSync(path.join(inboxDir(), `${written.id}.json`))).toBe(false);

    const external = seed('oversized.json', proposal('oversized', { summary: oversizedSummary }));
    expect(fs.statSync(external).size).toBeGreaterThan(4 * 1024 * 1024);
    expect(listProposalsDetailed({ requireComplete: true })).toMatchObject({
      proposals: [],
      sourceState: 'degraded',
      complete: false,
      filesDiscovered: 1,
      filesRead: 1,
      stopReasons: ['per-file-byte-limit'],
    });
  });

  it('rejects an opened proposal when its pathname is replaced after the read', () => {
    const original = seed('target.json', proposal('target'));
    const displaced = path.join(home, 'target.displaced');
    let replaced = false;
    _setProposalReadRaceHookForTest((point, filePath) => {
      if (!replaced && point === 'after-file-read' && filePath === original) {
        replaced = true;
        fs.renameSync(original, displaced);
        fs.writeFileSync(
          original,
          JSON.stringify(proposal('target', { title: 'replacement' })),
          'utf8',
        );
      }
    });

    const result = listProposalsDetailed();
    expect(replaced).toBe(true);
    expect(result).toMatchObject({
      proposals: [],
      sourceState: 'degraded',
      complete: false,
      filesDiscovered: 1,
      filesRead: 1,
      bytesRead: 0,
      stopReasons: ['io-error'],
    });
    expect(result.unreadableFiles).toBeGreaterThan(0);
  });

  it('withholds authoritative rows when a proposal is added after directory enumeration', () => {
    seed('a.json', proposal('a'));
    let added = false;
    _setProposalReadRaceHookForTest((point) => {
      if (!added && point === 'after-directory-scan') {
        added = true;
        seed('b.json', proposal('b'));
      }
    });

    const result = listProposalsDetailed({ requireComplete: true });
    expect(added).toBe(true);
    expect(result).toMatchObject({
      proposals: [],
      sourceState: 'degraded',
      complete: false,
      filesDiscovered: 1,
      filesRead: 1,
      stopReasons: ['io-error'],
    });
    expect(result.unreadableFiles).toBeGreaterThan(0);
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

  it('moves compatibility reads to the same no-follow boundary without changing persisted bytes', () => {
    const valid = seed('valid.json', proposal('valid'));
    const linkedTarget = path.join(home, 'legacy-linked.json');
    fs.writeFileSync(linkedTarget, JSON.stringify(proposal('linked')), 'utf8');
    fs.symlinkSync(linkedTarget, path.join(inboxDir(), 'linked.json'));
    fs.writeFileSync(path.join(inboxDir(), 'malformed.json'), '{', 'utf8');
    const before = fs.readFileSync(valid);

    expect(listProposals().map((item) => item.id)).toEqual(['valid']);
    expect(loadProposal('linked')).toBeNull();
    listProposalsDetailed();
    expect(listProposals().map((item) => item.id)).toEqual(['valid']);
    expect(fs.readFileSync(valid)).toEqual(before);
  });

  it('refuses a symlinked inbox directory in compatibility and detailed readers', () => {
    const external = path.join(home, 'external-inbox');
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(
      path.join(external, 'outside.json'),
      JSON.stringify(proposal('outside')),
      'utf8',
    );
    fs.mkdirSync(path.dirname(inboxDir()), { recursive: true });
    fs.symlinkSync(external, inboxDir());

    expect(listProposals()).toEqual([]);
    expect(loadProposal('outside')).toBeNull();
    expect(listProposalsDetailed({ requireComplete: true })).toMatchObject({
      proposals: [],
      sourceState: 'degraded',
      complete: false,
    });
  });
});

/**
 * V3.10 Track B unit B-U1 — the authority ledger (~/.ashlr/authority/ledger.jsonl).
 *
 * SPEC-310B §7 U1 key test "ledger chain holds": appends chain by hash, any
 * edit / reorder / deletion / truncation is detected (in the chain, against
 * the anchor, against this process's high-water mark), a broken chain is
 * sticky and refuses appends, and only a signed recovery starts over.
 * HOME-isolated: every test runs in a fresh temp HOME.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/authority/surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/surface.js')>()),
  currentHostBinding: () => 'a'.repeat(64),
}));

import {
  appendLedger,
  currentLedgerHead,
  ledgerAnchorPath,
  ledgerBrokenMarkerPath,
  ledgerEntryHash,
  ledgerPath,
  ledgerSnapshot,
  readLedger,
  resetLedgerCachesForTest,
  withLedgerTransaction,
} from '../src/core/authority/ledger.js';
import type { LedgerAppendInput, LedgerEntry, LedgerEventKind } from '../src/core/authority/types.js';
import { withTempHome } from './helpers/authority-310b.js';

let restore: () => void;

beforeEach(() => {
  restore = withTempHome('bu1-ledger-').restore;
  resetLedgerCachesForTest();
});

afterEach(() => {
  resetLedgerCachesForTest();
  restore();
});

const GRANT = '0123456789abcdef0123456789abcdef';

function note(detail: string, extra: Partial<LedgerAppendInput<'note'>> = {}): LedgerAppendInput<'note'> {
  return { kind: 'note', actor: 'daemon', grantId: null, repo: null, data: { topic: 'test', detail }, ...extra };
}

function mustAppend<K extends LedgerEventKind>(input: LedgerAppendInput<K>): LedgerEntry {
  const result = appendLedger(input);
  if (!result.ok) throw new Error(result.reason);
  return result.entry as LedgerEntry;
}

function lines(): string[] {
  return readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean);
}

function rewrite(next: string[]): void {
  writeFileSync(ledgerPath(), next.map((l) => `${l}\n`).join(''), { mode: 0o600 });
}

describe('appending', () => {
  it('starts with a genesis row, chains every entry, and fsyncs private files', async () => {
    expect(ledgerSnapshot().chain).toBe('empty');
    expect(currentLedgerHead()).toBeNull();
    const first = mustAppend(note('one'));
    const second = mustAppend(note('two', { repo: 'ashlrai/binshield', grantId: GRANT }));
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(ledgerEntryHash(second)).toBe(second.hash);
    const read = await readLedger();
    expect(read.chain).toBe('ok');
    expect(read.entries.map((e) => e.kind)).toEqual(['ledger:genesis', 'note', 'note']);
    expect(read.entries[0]!.data).toEqual({ hostBinding: 'a'.repeat(64) });
    expect(currentLedgerHead()).toEqual({ seq: 2, hash: second.hash, at: second.at });
    expect(statSync(ledgerPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(ledgerPath(), '..')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(ledgerAnchorPath(), 'utf8'))).toMatchObject({ seq: 2, hash: second.hash });
  });

  it('never lets time run backwards and writes canonical lines', () => {
    mustAppend(note('a'));
    mustAppend(note('b'));
    const entries = lines().map((l) => JSON.parse(l) as LedgerEntry);
    for (let i = 1; i < entries.length; i += 1) expect(entries[i]!.at >= entries[i - 1]!.at).toBe(true);
    expect(lines().every((l) => !l.includes(': ') && !l.includes(', '))).toBe(true);
  });

  it('refuses malformed input and ledger-internal kinds without writing anything', () => {
    expect(appendLedger({ ...note('x'), kind: 'nonsense' as 'note' }).ok).toBe(false);
    expect(appendLedger({ ...note('x'), actor: 'agent' as 'daemon' }).ok).toBe(false);
    expect(appendLedger({ ...note('x'), repo: '/Users/me/checkout' }).ok).toBe(false);
    expect(appendLedger({ ...note('x'), grantId: 'short' }).ok).toBe(false);
    expect(appendLedger({ ...note('x'), data: [] as unknown as { topic: string; detail: string } }).ok).toBe(false);
    expect(appendLedger({ kind: 'ledger:genesis', actor: 'daemon', grantId: null, repo: null, data: { hostBinding: null } }).ok).toBe(false);
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('takes U4 rows with grantId null — holds and revert failures are recorded even when no grant was ever installed', async () => {
    expect(ledgerSnapshot().chain).toBe('empty');
    const since = new Date().toISOString();
    mustAppend({
      kind: 'hold:set',
      actor: 'daemon',
      grantId: null,
      repo: 'ashlrai/binshield',
      data: { v: 1, repo: 'ashlrai/binshield', kind: 'quarantine', reason: 'post-merge red', since, until: null, setBy: 'daemon', landingId: null },
    });
    mustAppend({ kind: 'revert:failed', actor: 'daemon', grantId: null, repo: 'ashlrai/binshield', data: { landingId: 'l-1', repo: 'ashlrai/binshield', reason: 'conflict' } });
    mustAppend({ kind: 'hold:cleared', actor: 'mason', grantId: null, repo: 'ashlrai/binshield', data: { repo: 'ashlrai/binshield', kind: 'quarantine', reason: 'fixed' } });
    const read = await readLedger({ repo: 'ashlrai/binshield' });
    expect(read.chain).toBe('ok');
    expect(read.entries.map((e) => [e.kind, e.grantId])).toEqual([['hold:set', null], ['revert:failed', null], ['hold:cleared', null]]);
  });

  it('reads with filters, newest `limit` last', async () => {
    mustAppend(note('a', { repo: 'ashlrai/one' }));
    mustAppend({ kind: 'kill:on', actor: 'mason', grantId: null, repo: null, data: { reason: 'stop' } });
    mustAppend(note('b', { repo: 'ashlrai/two', grantId: GRANT }));
    mustAppend(note('c', { repo: 'ashlrai/one' }));
    expect((await readLedger({ kinds: ['kill:on'] })).entries.map((e) => e.seq)).toEqual([2]);
    expect((await readLedger({ repo: 'ashlrai/one' })).entries.map((e) => e.seq)).toEqual([1, 4]);
    expect((await readLedger({ grantId: GRANT })).entries.map((e) => e.seq)).toEqual([3]);
    expect((await readLedger({ sinceSeq: 3 })).entries.map((e) => e.seq)).toEqual([3, 4]);
    expect((await readLedger({ limit: 2 })).entries.map((e) => e.seq)).toEqual([3, 4]);
  });
});

describe('tamper evidence', () => {
  it('an edited entry breaks the chain at that entry, and the break is sticky', async () => {
    mustAppend(note('a'));
    mustAppend(note('b'));
    mustAppend(note('c'));
    const all = lines();
    all[2] = all[2]!.replace('"detail":"b"', '"detail":"B"');
    rewrite(all);
    resetLedgerCachesForTest();
    const read = await readLedger();
    expect(read.chain).toBe('broken');
    expect(read.brokenAtSeq).toBe(2);
    expect(read.entries.map((e) => e.seq)).toEqual([0, 1]);
    expect(ledgerSnapshot().chain).toBe('broken');
    expect(existsSync(ledgerBrokenMarkerPath())).toBe(true);
    expect(() => currentLedgerHead()).toThrow(/broken/);
    expect(appendLedger(note('after')).ok).toBe(false);
    // Restoring the bytes does not un-break it: only a signed recovery does.
    rewrite(lines().map((l, i) => (i === 2 ? l.replace('"detail":"B"', '"detail":"b"') : l)));
    resetLedgerCachesForTest();
    expect(ledgerSnapshot('full').chain).toBe('broken');
  });

  it('reordered and non-canonical lines break the chain', async () => {
    mustAppend(note('a'));
    mustAppend(note('b'));
    const all = lines();
    rewrite([all[0]!, all[2]!, all[1]!]);
    resetLedgerCachesForTest();
    expect((await readLedger()).chain).toBe('broken');
  });

  it('a non-canonical encoding of a valid entry is refused', async () => {
    mustAppend(note('a'));
    const all = lines();
    all[1] = JSON.stringify(JSON.parse(all[1]!), null, 1).replace(/\n/g, '');
    rewrite(all);
    resetLedgerCachesForTest();
    const read = await readLedger();
    expect(read.chain).toBe('broken');
    expect(read.reason).toMatch(/canonical/);
  });

  it('a truncated ledger is shorter than its anchor', async () => {
    mustAppend(note('a'));
    mustAppend(note('b'));
    rewrite(lines().slice(0, 2));
    resetLedgerCachesForTest();
    const read = await readLedger();
    expect(read.chain).toBe('broken');
    expect(read.reason).toMatch(/shorter than its anchor/);
  });

  it('a deleted ledger with a surviving anchor is broken, not empty', () => {
    mustAppend(note('a'));
    writeFileSync(ledgerPath(), '', { mode: 0o600 });
    resetLedgerCachesForTest();
    expect(ledgerSnapshot().chain).toBe('broken');
  });

  it("this process's high-water mark catches a truncation that also rewrote the anchor", () => {
    mustAppend(note('a'));
    mustAppend(note('b'));
    expect(ledgerSnapshot().head?.seq).toBe(2);
    const kept = lines().slice(0, 2);
    rewrite(kept);
    const last = JSON.parse(kept[1]!) as LedgerEntry;
    writeFileSync(ledgerAnchorPath(), `${JSON.stringify({ v: 1, seq: last.seq, hash: last.hash, at: last.at })}\n`, { mode: 0o600 });
    const snap = ledgerSnapshot();
    expect(snap.chain).toBe('broken');
    expect(snap.reason).toMatch(/shorter|rewritten/);
  });

  it('prefix mode catches an in-place edit of an entry this process already verified', () => {
    mustAppend(note('aaaa'));
    mustAppend(note('bbbb'));
    expect(ledgerSnapshot('cached').chain).toBe('ok');
    // Same length, same line count: only a re-hash of verified bytes can see it.
    rewrite(lines().map((l, i) => (i === 1 ? l.replace('aaaa', 'zzzz') : l)));
    const snap = ledgerSnapshot('prefix');
    expect(snap.chain).toBe('broken');
  });

  it('a torn trailing line is ignored by readers and dropped by the next append', async () => {
    mustAppend(note('a'));
    appendFileSync(ledgerPath(), '{"v":1,"seq":2,"at":"2026');
    resetLedgerCachesForTest();
    expect(ledgerSnapshot().chain).toBe('ok');
    const next = mustAppend(note('b'));
    expect(next.seq).toBe(2);
    const read = await readLedger();
    expect(read.chain).toBe('ok');
    expect(read.entries).toHaveLength(3);
  });
});

describe('the authority index and recovery', () => {
  it('derives acceptances, revocations, rollout position and evidence while verifying', () => {
    mustAppend({
      kind: 'grant:accepted',
      actor: 'mason',
      grantId: GRANT,
      repo: null,
      data: {
        grantId: GRANT,
        grantSeq: 4,
        keyId: 'k',
        issuedAt: '2026-09-24T00:00:00.000Z',
        expiresAt: '2026-10-24T00:00:00.000Z',
        authoritySurfaceDigest: 'b'.repeat(64),
        stageIds: ['shadow', '2a'],
        envelopeDigest: 'e'.repeat(64),
      },
    });
    mustAppend({
      kind: 'rollout:regressed',
      actor: 'daemon',
      grantId: GRANT,
      repo: null,
      data: {
        grantId: GRANT,
        fromStageId: '2a',
        toStageId: 'shadow',
        toStageIndex: 0,
        breach: 'a sandbox violation',
        evidence: { hoursInStage: 1, merges: 0, postMergeGreenPct: null, revertRatePct: null, sandboxViolations: 1, reserveBreaches: 0 },
      },
    });
    mustAppend({
      kind: 'sandbox:violation',
      actor: 'daemon',
      grantId: GRANT,
      repo: 'ashlrai/binshield',
      data: { v: 1, engine: 'grok-cli', repo: 'ashlrai/binshield', runId: null, operation: 'file-read ~/.ashlr/authority', at: '2026-09-24T01:00:00.000Z' },
    });
    mustAppend({ kind: 'grant:revoked', actor: 'mason', grantId: GRANT, repo: null, data: { grantId: GRANT, minGrantSeq: 5, reason: 'test' } });
    const { index } = ledgerSnapshot();
    expect(index.maxAcceptedGrantSeq).toBe(4);
    expect(index.lastAccepted?.grantId).toBe(GRANT);
    expect(index.minGrantSeq).toBe(5);
    expect(index.revokedGrantIds.has(GRANT)).toBe(true);
    expect(index.rollout.get(GRANT)).toMatchObject({ stageIndex: 0, stageId: 'shadow', move: 'regressed', fromStageId: '2a', breach: 'a sandbox violation' });
    expect(index.evidence.map((e) => e.kind)).toEqual(['sandbox:violation']);
  });

  it('a signed recovery archives the broken chain and carries the grantSeq floor forward (even from unverified rows)', () => {
    mustAppend(note('a'));
    const all = lines();
    // A row past the break that claims grant #9 was accepted: unverifiable, but it may only RAISE the floor.
    const forged = JSON.stringify({ kind: 'grant:accepted', data: { grantSeq: 9 } });
    all[1] = all[1]!.replace('"detail":"a"', '"detail":"A"');
    rewrite([...all, forged]);
    resetLedgerCachesForTest();
    expect(ledgerSnapshot().chain).toBe('broken');
    const result = withLedgerTransaction((tx) => {
      expect(tx.brokenChainFloor()).toBe(9);
      return tx.recoverBrokenChain('test recovery');
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grantSeqFloor).toBe(9);
    const dir = join(ledgerPath(), '..');
    expect(readdirSync(dir).some((name) => name.startsWith('ledger.broken-') && name.endsWith('.jsonl'))).toBe(true);
    expect(existsSync(ledgerBrokenMarkerPath())).toBe(false);
    const snap = ledgerSnapshot();
    expect(snap.chain).toBe('ok');
    expect(snap.index.minGrantSeq).toBe(10);
    expect(snap.index.recovered).toMatchObject({ grantSeqFloor: 9 });
    expect(appendLedger(note('after recovery')).ok).toBe(true);
  });

  it('a landing row that says it is a revert never counts as a merge', () => {
    const landing = (kind: 'merge' | 'revert', id: string) => ({
      v: 1 as const, id, kind, repo: 'ashlrai/binshield', baseBranch: 'main', prNumber: 1, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40),
      proposalId: null, revertsLandingId: null, grantId: GRANT, rolloutStageId: '2a', gatesDigest: 'c'.repeat(64), ledgerHead: 'd'.repeat(64),
      enforcement: 'server' as const, risk: 'low' as const, files: 1, linesAdded: 1, linesDeleted: 0, producer: null, judgeId: null,
      proposedAt: null, landedAt: '2026-09-24T01:00:00.000Z', watchUntil: '2026-09-24T03:00:00.000Z',
    });
    mustAppend({ kind: 'merge:landed', actor: 'daemon', grantId: GRANT, repo: 'ashlrai/binshield', data: landing('merge', 'M1') });
    mustAppend({ kind: 'merge:landed', actor: 'daemon', grantId: GRANT, repo: 'ashlrai/binshield', data: landing('revert', 'R1') });
    expect(ledgerSnapshot().index.evidence.map((e) => [e.kind, e.landingId])).toEqual([['merge:landed', 'M1'], ['revert:landed', 'R1']]);
  });

  it('recovery is refused on an intact chain', () => {
    mustAppend(note('a'));
    const result = withLedgerTransaction((tx) => tx.recoverBrokenChain('nope'));
    expect(result.ok).toBe(false);
  });
});

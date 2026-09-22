import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { canonical } from '../src/core/universe/artifacts.js';
import { appendDailyMemory, consolidateFirmMemory, readDailyMemory, readFirmMemory } from '../src/core/universe/firm-memory.js';

let root: string;
const date = '2026-09-10';
const inputTraceDigest = 'a'.repeat(64);
const entry = (patch = {}) => ({ root, date, id: 'entry-1', content: 'Verified an inert local result.', inputTraceDigest, ...patch });
function proposal(patch = {}) {
  return { root, id: 'version-1', content: 'Retain the verified result.', inputTraceDigest, expectedPriorDigest: null,
    sourceDailyDigests: [{ date, digest: readDailyMemory({ root, date }).digest! }], ...patch };
}
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'firm-memory-test-'))); chmodSync(root, 0o700); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('explicit private daily memory', () => {
  it('reports missing without initializing root or memory paths', () => {
    const before = readdirSync(root);
    expect(readDailyMemory({ root, date })).toEqual({ sourceState: 'missing', complete: true, entries: [], digest: null });
    expect(readFirmMemory({ root })).toMatchObject({ sourceState: 'missing', current: null, digest: null });
    expect(readdirSync(root)).toEqual(before);
    const missing = join(root, 'missing');
    expect(readDailyMemory({ root: missing, date }).sourceState).toBe('missing');
    expect(appendDailyMemory(entry({ root: missing })).status).toBe('unavailable');
    expect(existsSync(missing)).toBe(false);
  });

  it('appends bounded entries immutably and replays only identical requests', () => {
    const first = appendDailyMemory(entry()); expect(first.status).toBe('recorded'); expect(first.entryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(appendDailyMemory(entry())).toEqual({ ...first, status: 'replayed' });
    expect(appendDailyMemory(entry({ content: 'Changed content.' })).status).toBe('conflicted');
    const read = readDailyMemory({ root, date }); expect(read.sourceState).toBe('healthy'); expect(read.complete).toBe(true);
    expect(read.entries).toHaveLength(1); expect(read.entries[0]!.content).toBe(entry().content);
    read.entries[0]!.content = 'Only mutate the returned snapshot';
    expect(readDailyMemory({ root, date }).entries[0]!.content).toBe(entry().content);
  });

  it('serializes concurrent API callers without losing distinct entries or duplicating IDs', async () => {
    const results = await Promise.all([entry(), entry(), entry({ id: 'entry-2' })].map((value) => Promise.resolve().then(() => appendDailyMemory(value))));
    expect(results.map((value) => value.status)).toEqual(['recorded', 'replayed', 'recorded']);
    expect(readDailyMemory({ root, date }).entries.map((value) => value.id)).toEqual(['entry-1', 'entry-2']);
  });

  it('refuses a contending store owner and can retry after the owner releases', () => {
    const acquired = acquireLocalStoreLockWithOutcome(join(root, '.firm-memory.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    expect(acquired.state).toBe('acquired'); if (acquired.state !== 'acquired') throw new Error('Fixture lock unavailable');
    try { expect(appendDailyMemory(entry()).status).toBe('unavailable'); expect(existsSync(join(root, 'firm-memory'))).toBe(false); }
    finally { releaseLocalStoreLock(acquired.lock); }
    expect(appendDailyMemory(entry()).status).toBe('recorded');
  });

  it.each([
    { date: '../master' }, { date: '2026-02-30' }, { date: '2026-9-10' }, { id: '../../MEMORY.md' }, { id: 'MEMORY.md' },
    { id: '/absolute' }, { id: 'a'.repeat(65) }, { content: '' }, { content: 'a'.repeat(16 * 1024 + 1) },
    { content: '\u0000bad' }, { content: '\ud800' }, { inputTraceDigest: 'bad' }, { root: '/' }, { root: 'relative' },
  ])('rejects traversal or malformed requests before writes (%j)', (patch) => {
    expect(() => appendDailyMemory(entry(patch))).toThrow('Invalid explicit firm memory request');
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects accessor/unknown fields without calling getters', () => {
    const getter = vi.fn(() => 'entry');
    const value = Object.defineProperty(entry(), 'content', { get: getter });
    expect(() => appendDailyMemory(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => appendDailyMemory({ ...entry(), path: 'MEMORY.md' } as ReturnType<typeof entry>)).toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses new entries at the aggregate bound while preserving exact replays', () => {
    appendDailyMemory(entry());
    const directory = join(root, 'firm-memory', 'daily', date, 'records');
    const template = readDailyMemory({ root, date }).entries[0]!;
    for (let index = 1; index < 256; index++) {
      const value = { ...template, id: `bounded-${index}` };
      writeFileSync(join(directory, `${value.id}.json`), `${canonical(value)}\n`, { mode: 0o600 });
    }
    expect(readDailyMemory({ root, date }).entries).toHaveLength(256);
    expect(appendDailyMemory(entry({ id: 'over-bound' })).status).toBe('unavailable');
    expect(appendDailyMemory(entry()).status).toBe('replayed');
    expect(readdirSync(directory)).toHaveLength(256);
  });

  it('cannot clobber master files or versions using a daily entry name or markdown content', () => {
    const protectedPath = join(root, 'MEMORY.md'); writeFileSync(protectedPath, 'Operator-owned master', { mode: 0o600 });
    appendDailyMemory(entry()); const consolidated = consolidateFirmMemory(proposal()); expect(consolidated.status).toBe('recorded');
    const before = readFirmMemory({ root });
    expect(appendDailyMemory(entry({ id: 'master', content: '# MEMORY.md\nReplacement-looking prose.' })).status).toBe('recorded');
    expect(readFileSync(protectedPath, 'utf8')).toBe('Operator-owned master');
    expect(readFirmMemory({ root })).toEqual(before);
  });

  it('rejects symlink roots and ancestors instead of following or creating through them', () => {
    const target = join(root, 'target'); mkdirSync(target, { mode: 0o700 });
    const link = join(root, 'linked'); symlinkSync(target, link, 'dir');
    expect(appendDailyMemory(entry({ root: link })).status).toBe('unavailable');
    expect(readDailyMemory({ root: link, date }).sourceState).toBe('degraded');
    symlinkSync(target, join(root, 'firm-memory'), 'dir');
    expect(appendDailyMemory(entry()).status).toBe('unavailable');
    expect(readDailyMemory({ root, date }).sourceState).toBe('degraded');
    expect(readdirSync(target)).toEqual([]);
  });

  it.each(['record', 'staging', 'missing-layout'])('fails closed on %s corruption without exposing partial entries or repairing evidence', (kind) => {
    appendDailyMemory(entry());
    const directory = join(root, 'firm-memory', 'daily', date);
    if (kind === 'record') writeFileSync(join(directory, 'records', 'entry-1.json'), '{bad', { mode: 0o600 });
    else if (kind === 'staging') writeFileSync(join(directory, 'staging', 'unpublished.stage'), 'partial', { mode: 0o600 });
    else rmSync(join(directory, 'staging'), { recursive: true });
    const before = readdirSync(directory);
    expect(readDailyMemory({ root, date })).toMatchObject({ sourceState: 'degraded', complete: false, entries: [], digest: null });
    expect(appendDailyMemory(entry({ id: 'later' })).status).toBe('unavailable');
    expect(readdirSync(directory)).toEqual(before);
    if (kind === 'staging') expect(readFileSync(join(directory, 'staging', 'unpublished.stage'), 'utf8')).toBe('partial');
  });
});

describe('separate immutable master consolidation', () => {
  it('allows only one competing consolidation of the same expected prior', async () => {
    appendDailyMemory(entry());
    const first = proposal(); const second = proposal({ id: 'version-other', content: 'Competing synthesis.' });
    const result = await Promise.all([first, second].map((value) => Promise.resolve().then(() => consolidateFirmMemory(value))));
    expect(result.map((value) => value.status)).toEqual(['recorded', 'conflicted']);
    expect(readFirmMemory({ root }).entries).toHaveLength(1);
  });

  it('binds a version chain to exact prior and source digests without overwriting prior versions', () => {
    appendDailyMemory(entry()); const firstInput = proposal(); const first = consolidateFirmMemory(firstInput);
    expect(first.status).toBe('recorded');
    expect(consolidateFirmMemory(firstInput)).toEqual({ ...first, status: 'replayed' });
    const second = consolidateFirmMemory(proposal({ id: 'version-2', content: 'Refined synthesis.', expectedPriorDigest: first.entryDigest }));
    expect(second.status).toBe('recorded');
    const read = readFirmMemory({ root }); expect(read.sourceState).toBe('healthy');
    expect(read.entries.map((value) => value.sequence)).toEqual([0, 1]);
    expect(read.current!.previousDigest).toBe(first.entryDigest); expect(read.digest).toBe(second.entryDigest);
    expect(read.entries[0]!.content).toBe(firstInput.content);
    expect(consolidateFirmMemory(firstInput).status).toBe('replayed');
  });

  it('refuses stale expected-prior digests and changed requests under a reused ID', () => {
    appendDailyMemory(entry()); const first = consolidateFirmMemory(proposal());
    const before = readFirmMemory({ root });
    expect(consolidateFirmMemory(proposal({ id: 'version-2' })).status).toBe('conflicted');
    expect(consolidateFirmMemory(proposal({ id: 'version-2', expectedPriorDigest: 'f'.repeat(64) })).status).toBe('conflicted');
    expect(consolidateFirmMemory(proposal({ content: 'Changed version' })).status).toBe('conflicted');
    expect(readFirmMemory({ root })).toEqual(before); expect(before.digest).toBe(first.entryDigest);
  });

  it('rejects stale, missing or malformed source daily evidence', () => {
    appendDailyMemory(entry()); const frozen = proposal();
    appendDailyMemory(entry({ id: 'entry-2' }));
    expect(consolidateFirmMemory(frozen).status).toBe('conflicted');
    expect(consolidateFirmMemory(proposal({ sourceDailyDigests: [{ date: '2026-09-11', digest: 'a'.repeat(64) }] })).status).toBe('conflicted');
    expect(() => consolidateFirmMemory(proposal({ sourceDailyDigests: [] }))).toThrow();
    expect(() => consolidateFirmMemory(proposal({ sourceDailyDigests: [{ date: '../master', digest: 'a'.repeat(64) }] }))).toThrow();
    expect(readFirmMemory({ root }).sourceState).toBe('missing');
  });

  it('never uses a corrupt master chain as an empty prior or unlocks it by expected null', () => {
    appendDailyMemory(entry()); consolidateFirmMemory(proposal());
    const path = join(root, 'firm-memory', 'master', 'records', 'version-1.json');
    const saved = JSON.parse(readFileSync(path, 'utf8')); saved.previousDigest = 'f'.repeat(64);
    // Canonical shape is insufficient: first-version continuity must also hold.
    writeFileSync(path, `${canonical(saved)}\n`, { mode: 0o600 });
    expect(readFirmMemory({ root })).toMatchObject({ sourceState: 'degraded', current: null, entries: [], digest: null });
    expect(consolidateFirmMemory(proposal({ id: 'version-2' })).status).toBe('unavailable');
  });
});

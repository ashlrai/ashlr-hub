/**
 * 3.10 review d7 (session-meta.ts + budget-store.ts half): a store whose file
 * EXISTS but cannot be read must never be rewritten from defaults. The write
 * is refused with a typed 503 error, the original bytes stay where they are,
 * a byte-exact copy is kept beside them, and only a MISSING file starts fresh.
 *
 * Before the fix: session-meta's load() persisted a fresh empty state over a
 * garbled/oversized/unreadable file on the FIRST READ (wiping every pin,
 * archive and the unread baseline), and updateBudgetPolicy wrote "defaults +
 * one click" over the operator's policy.
 *
 * HOME-isolated: every test relocates HOME to a fresh temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createSessionMetaStore,
  SessionMetaUnreadableError,
  UNREADABLE_RECHECK_MS,
  VERSE_SESSION_META_FILE,
} from '../src/core/verse/session-meta.js';
import {
  budgetPolicyPath,
  BudgetPolicyUnreadableError,
  loadBudgetPolicy,
  readBudgetPolicyFileState,
  updateBudgetPolicy,
} from '../src/core/routing/budget-store.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'd7-store-refusal-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  // Undo any chmod 000 so the temp tree can be removed.
  for (const dir of [path.join(home, '.ashlr', 'verse'), path.join(home, '.ashlr')]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try { if (fs.lstatSync(full).isFile()) fs.chmodSync(full, 0o600); } catch { /* best effort */ }
      }
    } catch { /* absent */ }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

// root ignores file modes, so the EACCES cases only prove anything as a user.
const canDenyRead = typeof process.getuid === 'function' && process.getuid() !== 0;

const T0 = Date.parse('2026-09-24T12:00:00.000Z');

function verseDir(): string {
  return path.join(home, '.ashlr', 'verse');
}

function metaFile(): string {
  return path.join(verseDir(), VERSE_SESSION_META_FILE);
}

function plant(file: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

function archivesIn(dir: string, stem: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.startsWith(`${stem}.unreadable-`) && n.endsWith('.json'));
}

const chat = (id: string, turnCount = 5) => ({ id, turnCount, updatedAt: new Date(T0 - 60_000).toISOString() });

// ---------------------------------------------------------------------------
// session-meta
// ---------------------------------------------------------------------------

describe('session-meta never writes defaults over an unreadable file', () => {
  it('a garbled file: the first READ no longer overwrites it; writes refuse; a byte-exact copy is kept', () => {
    // A real pinned file with one byte of damage — the operator's pins are in there.
    const garbled = '{"version":1,"baselineAt":"2026-01-01T00:00:00.000Z","sessions":{"a":{"pinned":true}},ÿ';
    plant(metaFile(), garbled);
    const store = createSessionMetaStore({ now: () => T0 });

    // Reads stay total (the server must boot) …
    expect(store.get(chat('a'))).toMatchObject({ pinned: false, archived: false });
    expect(store.list([chat('a')])).toBeDefined();
    // … and, the regression: the read itself must not have replaced the file.
    expect(fs.readFileSync(metaFile(), 'utf8')).toBe(garbled);

    const state = store.fileState();
    expect(state.state).toBe('unreadable');
    if (state.state !== 'unreadable') throw new Error('unreachable');
    expect(state.reason).toMatch(/not valid JSON/);
    expect(state.archivedTo).not.toBeNull();
    expect(fs.readFileSync(state.archivedTo!)).toEqual(Buffer.from(garbled, 'utf8'));
    expect(fs.statSync(state.archivedTo!).mode & 0o777).toBe(0o600);

    // Every write is refused with a typed, forwardable error and writes nothing.
    let caught: unknown;
    try { store.update(chat('a'), { pinned: true }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(SessionMetaUnreadableError);
    expect(caught).toMatchObject({ code: 'VERSE_STORE_UNREADABLE', status: 503, archivedTo: state.archivedTo });
    expect(() => store.markSeen(chat('a'), 3)).toThrow(SessionMetaUnreadableError);
    expect(() => store.markMindSeen('2026-09-24T12:00:00.000Z')).toThrow(SessionMetaUnreadableError);
    // Seeding is a write too: it quietly does nothing rather than throwing on a poll.
    expect(store.seedBaseline([chat('a')])).toBe(0);
    expect(fs.readFileSync(metaFile(), 'utf8')).toBe(garbled);

    // Repeated refusals re-check the file but copy the same bytes only once.
    expect(archivesIn(verseDir(), 'session-meta')).toHaveLength(1);
  });

  it('an oversized file, a newer version, or a non-map sessions is refused the same way', () => {
    const cases: Array<[string, RegExp]> = [
      [JSON.stringify({ version: 1, sessions: { a: { pinned: true } }, pad: 'x'.repeat(2 * 1024 * 1024 + 16) }), /larger than/],
      [JSON.stringify({ version: 2, sessions: { a: { pinned: true, colour: 'red' } } }), /unknown version/],
      [JSON.stringify({ version: 1, sessions: [{ id: 'a', pinned: true }] }), /malformed sessions/],
      ['[1,2,3]', /not a JSON object/],
    ];
    for (const [content, reason] of cases) {
      fs.rmSync(verseDir(), { recursive: true, force: true });
      plant(metaFile(), content);
      const store = createSessionMetaStore({ now: () => T0 });
      expect(() => store.update(chat('a'), { archived: true })).toThrow(reason);
      expect(fs.readFileSync(metaFile(), 'utf8')).toBe(content);
      const archives = archivesIn(verseDir(), 'session-meta');
      expect(archives).toHaveLength(1);
      expect(fs.readFileSync(path.join(verseDir(), archives[0]!), 'utf8')).toBe(content);
    }
  });

  it.runIf(canDenyRead)('a file that cannot be opened (EACCES) is refused, left in place, and not archived', () => {
    const content = JSON.stringify({ version: 1, baselineAt: '2026-01-01T00:00:00.000Z', mindSeenAt: null, sessions: { a: { pinned: true } } });
    plant(metaFile(), content, 0o000);
    const store = createSessionMetaStore({ now: () => T0 });
    expect(store.get(chat('a')).pinned).toBe(false);
    const state = store.fileState();
    expect(state).toMatchObject({ state: 'unreadable', reason: 'could not be read', archivedTo: null });
    expect(() => store.update(chat('a'), { pinned: false })).toThrow(SessionMetaUnreadableError);
    fs.chmodSync(metaFile(), 0o600);
    expect(fs.readFileSync(metaFile(), 'utf8')).toBe(content);
    expect(archivesIn(verseDir(), 'session-meta')).toHaveLength(0);
  });

  it('a symlink at the name is refused and its target is never written', () => {
    const target = path.join(home, 'elsewhere.json');
    fs.writeFileSync(target, 'precious');
    fs.mkdirSync(verseDir(), { recursive: true, mode: 0o700 });
    fs.symlinkSync(target, metaFile());
    const store = createSessionMetaStore({ now: () => T0 });
    expect(() => store.update(chat('a'), { pinned: true })).toThrow(/symlink/);
    expect(fs.lstatSync(metaFile()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
  });

  it('recovers without a restart: a transient failure that clears keeps the real pins; a moved-aside file starts fresh', () => {
    const good = JSON.stringify({ version: 1, baselineAt: '2026-01-01T00:00:00.000Z', mindSeenAt: null, sessions: { a: { pinned: true, seen: 2 } } });
    plant(metaFile(), '{truncated');
    const clock = { now: T0 };
    const store = createSessionMetaStore({ now: () => clock.now });
    expect(() => store.update(chat('b'), { pinned: true })).toThrow(SessionMetaUnreadableError);

    // The file becomes readable again (the operator restores it): the next
    // write re-checks and builds on the REAL pins, not on defaults.
    fs.writeFileSync(metaFile(), good);
    store.update(chat('b'), { pinned: true });
    const onDisk = JSON.parse(fs.readFileSync(metaFile(), 'utf8')) as { sessions: Record<string, unknown>; baselineAt: string };
    expect(onDisk.sessions).toEqual({ a: { pinned: true, seen: 2 }, b: { pinned: true } });
    expect(onDisk.baselineAt).toBe('2026-01-01T00:00:00.000Z');
    expect(store.fileState().state).toBe('ok');

    // A second store sees a damaged file, then the operator moves it aside:
    // a missing file is the one case that starts fresh.
    fs.writeFileSync(metaFile(), 'not json');
    const second = createSessionMetaStore({ now: () => clock.now });
    expect(second.fileState().state).toBe('unreadable');
    fs.renameSync(metaFile(), path.join(verseDir(), 'moved-aside.json'));
    // Reads trust the verdict for a short while, then look again.
    clock.now += UNREADABLE_RECHECK_MS + 1;
    expect(second.fileState().state).toBe('ok');
    second.update(chat('c'), { archived: true });
    // (seen 5: the fresh baseline covers the chat and is materialised into its entry.)
    expect(JSON.parse(fs.readFileSync(metaFile(), 'utf8')).sessions).toEqual({ c: { archived: true, seen: 5 } });
  });

  it('a missing file still starts fresh and fixes the baseline on first read (unchanged behaviour)', () => {
    const store = createSessionMetaStore({ now: () => T0 });
    expect(store.fileState().state).toBe('ok');
    expect(store.baselineAt()).toBe(new Date(T0).toISOString());
    expect(fs.existsSync(metaFile())).toBe(true);
    expect(archivesIn(verseDir(), 'session-meta')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// budget-store
// ---------------------------------------------------------------------------

describe('updateBudgetPolicy never writes defaults over an unreadable policy', () => {
  const ashlrDir = () => path.join(home, '.ashlr');
  const now = new Date('2026-09-24T12:00:00.000Z');

  it('a garbled policy: the update is refused, the file is untouched, and a byte-exact copy is kept', () => {
    const garbled = '{"mode":"all-in","seats":{"claude":{"seatId":"claude","enabled":true,"reservePercent":5}}';
    plant(budgetPolicyPath(), garbled);
    // The reader still boots on it (defaults) — unchanged.
    expect(loadBudgetPolicy()).toEqual(defaultBudgetPolicy());
    expect(readBudgetPolicyFileState()).toMatchObject({ state: 'unreadable', reason: 'is not valid JSON' });

    let caught: unknown;
    try { updateBudgetPolicy({ seatId: 'codex', policy: { enabled: false } }, { now }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(BudgetPolicyUnreadableError);
    expect(caught).toMatchObject({ code: 'VERSE_STORE_UNREADABLE', status: 503 });
    expect(fs.readFileSync(budgetPolicyPath(), 'utf8')).toBe(garbled);
    const archivedTo = (caught as BudgetPolicyUnreadableError).archivedTo!;
    expect(path.dirname(archivedTo)).toBe(ashlrDir());
    expect(path.basename(archivedTo)).toMatch(/^budget\.unreadable-.*\.json$/);
    expect(fs.readFileSync(archivedTo, 'utf8')).toBe(garbled);
    expect(fs.statSync(archivedTo).mode & 0o777).toBe(0o600);

    // A second refused click on the same bytes does not pile up copies.
    expect(() => updateBudgetPolicy({ mode: 'reserve' }, { now })).toThrow(BudgetPolicyUnreadableError);
    expect(archivesIn(ashlrDir(), 'budget')).toHaveLength(1);
  });

  it('an unknown mode, a non-map seats, an oversized file or a non-object is refused', () => {
    const cases: Array<[string, RegExp]> = [
      [JSON.stringify({ mode: 'turbo', seats: {}, updatedAt: now.toISOString() }), /mode this build does not know/],
      [JSON.stringify({ mode: 'reserve', seats: ['claude'] }), /malformed seats/],
      [JSON.stringify({ mode: 'reserve', seats: {}, pad: 'x'.repeat(70 * 1024) }), /larger than/],
      ['"reserve"', /not a JSON object/],
    ];
    for (const [content, reason] of cases) {
      plant(budgetPolicyPath(), content);
      expect(() => updateBudgetPolicy({ mode: 'balanced' }, { now })).toThrow(reason);
      expect(fs.readFileSync(budgetPolicyPath(), 'utf8')).toBe(content);
    }
  });

  it.runIf(canDenyRead)('an unopenable policy (EACCES) is refused and left in place with no copy', () => {
    const content = JSON.stringify({ mode: 'all-in', seats: {}, updatedAt: now.toISOString() });
    plant(budgetPolicyPath(), content, 0o000);
    expect(() => updateBudgetPolicy({ mode: 'reserve' }, { now })).toThrow(/could not be read/);
    fs.chmodSync(budgetPolicyPath(), 0o600);
    expect(fs.readFileSync(budgetPolicyPath(), 'utf8')).toBe(content);
    expect(archivesIn(ashlrDir(), 'budget')).toHaveLength(0);
  });

  it('a symlinked policy is refused; its target is never written', () => {
    const target = path.join(home, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ mode: 'all-in', seats: {}, updatedAt: now.toISOString() }));
    fs.mkdirSync(ashlrDir(), { recursive: true, mode: 0o700 });
    fs.symlinkSync(target, budgetPolicyPath());
    expect(() => updateBudgetPolicy({ mode: 'reserve' }, { now })).toThrow(/symlink/);
    expect(fs.lstatSync(budgetPolicyPath()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).mode).toBe('all-in');
  });

  it('a readable policy is built on, and a missing one starts from the defaults (unchanged behaviour)', () => {
    expect(readBudgetPolicyFileState()).toEqual({ state: 'missing' });
    expect(updateBudgetPolicy({ mode: 'reserve' }, { now }).mode).toBe('reserve');
    const seat = updateBudgetPolicy({ seatId: 'claude', policy: { reservePercent: 40 } }, { now });
    expect(seat.mode).toBe('reserve');
    expect(seat.seats['claude']!.reservePercent).toBe(40);
    expect(readBudgetPolicyFileState()).toMatchObject({ state: 'ok' });
    expect(archivesIn(ashlrDir(), 'budget')).toHaveLength(0);
  });
});

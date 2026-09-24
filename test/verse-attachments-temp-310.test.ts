/**
 * Review 3.10 d8: the atomic writer's temp file for an attachment used to be
 * `<stored name>.<pid>.<16 hex>.tmp` in the SAME directory, a name STORED_RE
 * accepts. A crash mid-save left a phantom attachment that was listed, counted
 * toward the per-chat quotas, and never cleaned up. Now:
 *   - saves write through a dot-file temp STORED_RE never matches;
 *   - a temp-shaped name (including an older build's orphan) is never listed,
 *     counted, removed as an attachment, or granted to a CLI;
 *   - orphans are swept when the directory is next listed (or saved into).
 *
 * Pure filesystem work under a tmp dir (HOME is isolated by test/setup/home.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAttachmentStore,
  resolveAttachmentRefs,
  VERSE_ATTACHMENTS_PER_SESSION,
  type VerseAttachmentStore,
} from '../src/core/verse/attachments.js';
import { writePrivateFileAtomically } from '../src/core/verse/session-store.js';

/** Observes (and can fail) the atomic writer's rename — the crash window between temp create and publish. */
const renameHook = vi.hoisted(() => ({ current: null as ((from: string, to: string) => void) | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const renameSync = (from: import('node:fs').PathLike, to: import('node:fs').PathLike): void => {
    renameHook.current?.(String(from), String(to));
    actual.renameSync(from, to);
  };
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

const SID = 'sess-1';
let root: string;
let store: VerseAttachmentStore;
let ids = 0;

function upload(name: string, text = 'hello'): { name: string; mime: string; dataBase64: string } {
  return { name, mime: 'text/plain', dataBase64: Buffer.from(text).toString('base64') };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verse-attach-'));
  ids = 0;
  store = createAttachmentStore(root, { randomId: () => (++ids).toString(16).padStart(8, '0') });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('attachment temp files (review d8)', () => {
  it('writes through a DOT-FILE temp that the stored-name rule can never match', () => {
    const renames: string[] = [];
    renameHook.current = (from) => {
      renames.push(from);
      // Simulate the crash window: the temp exists, the rename never happens.
      throw new Error('killed mid-save');
    };
    try {
      expect(() => store.save(SID, upload('photo.txt'))).toThrow();
    } finally {
      renameHook.current = null;
    }
    expect(renames).toHaveLength(1);
    const tempName = renames[0]!.split('/').at(-1)!;
    expect(tempName).toMatch(/^\.00000001-photo\.txt\.\d+\.[0-9a-f]{16}\.tmp$/);
  });

  it('never lists, counts, removes or grants an orphaned temp — and sweeps it', () => {
    const saved = store.save(SID, upload('real.txt'));
    const dir = store.dirFor(SID);
    // An orphan in the OLD naming (it matched STORED_RE) from a dead process, and one in the new naming.
    const legacy = `${saved.id}-real.txt.999999.0123456789abcdef.tmp`;
    const hidden = `.00000009-other.txt.999999.fedcba9876543210.tmp`;
    writeFileSync(join(dir, legacy), 'x'.repeat(4096), { mode: 0o600 });
    writeFileSync(join(dir, hidden), 'y', { mode: 0o600 });
    // remove() by the shared id must hit the REAL file, never the orphan.
    const list = store.list(SID);
    expect(list.map((a) => a.name)).toEqual(['real.txt']);
    expect(existsSync(join(dir, legacy))).toBe(false);
    expect(existsSync(join(dir, hidden))).toBe(false);
    // A reference to an orphan grants nothing.
    writeFileSync(join(dir, legacy), 'x', { mode: 0o600 });
    const resolved = resolveAttachmentRefs(`see @${join(dir, legacy)}`, dir);
    expect(resolved.files).toEqual([]);
    expect(store.remove(SID, saved.id)).toBe(true);
    expect(existsSync(join(dir, `${saved.id}-real.txt`))).toBe(false);
  });

  it('leaves a fresh temp of ANOTHER live process alone (a save in flight), sweeps it once stale', () => {
    store.save(SID, upload('a.txt'));
    const dir = store.dirFor(SID);
    // The parent of this test worker is alive and is not us.
    const other = `.0000000f-b.txt.${process.ppid}.0123456789abcdef.tmp`;
    writeFileSync(join(dir, other), 'z', { mode: 0o600 });
    expect(store.list(SID)).toHaveLength(1);
    expect(existsSync(join(dir, other))).toBe(true);
    const old = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(join(dir, other), old, old);
    store.list(SID);
    expect(existsSync(join(dir, other))).toBe(false);
  });

  it('orphans no longer eat the per-chat quota', () => {
    const dir = store.dirFor(SID);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < VERSE_ATTACHMENTS_PER_SESSION; i += 1) {
      writeFileSync(join(dir, `${i.toString(16).padStart(8, '0')}-x.txt.999999.0123456789abcdef.tmp`), 'x', { mode: 0o600 });
    }
    expect(() => store.save(SID, upload('fits.txt'))).not.toThrow();
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a real upload whose name ends like a temp is stored under a name that cannot be mistaken for one', () => {
    const saved = store.save(SID, upload('notes.123.0123456789abcdef.tmp'));
    expect(saved.name).toBe('notes.123.0123456789abcdef_tmp');
    expect(store.list(SID).map((a) => a.id)).toEqual([saved.id]);
  });

  it('other store files keep their visible temp naming (the option is opt-in)', () => {
    const dir = join(root, 'plain');
    const renames: string[] = [];
    renameHook.current = (from) => {
      renames.push(from);
      throw new Error('stop');
    };
    try {
      expect(() => writePrivateFileAtomically(dir, join(dir, 'running.json'), '{}')).toThrow();
    } finally {
      renameHook.current = null;
    }
    expect(renames[0]!.split('/').at(-1)).toMatch(/^running\.json\.\d+\.[0-9a-f]{16}\.tmp$/);
  });
});

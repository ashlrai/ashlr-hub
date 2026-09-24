/**
 * test/verse-preferences.test.ts — the operator's standing context choices
 * (`<verse root>/preferences.json`, docs/VERSE-CONTEXT.md).
 *
 * Defended here:
 *  1. STRICT UPDATES. Exactly one of the three `VersePreferencesUpdate` forms,
 *     no unknown keys — a body can never change more than the operator clicked,
 *     and a rejected body writes nothing.
 *  2. TOTAL LOADS. Any file on disk (missing, corrupt, oversized, symlinked,
 *     half-valid) yields usable preferences; valid parts survive.
 *  3. PRIVACY. 0600 file, 0700 directory, atomic writes, no write through a
 *     symlinked directory.
 *  4. CANONICAL PATHS. A project opted out under one spelling is opted out
 *     under every spelling that resolves to it.
 *
 * Every test uses its own tmp root; HOME is relocated by test/setup/home.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VERSE_PREFERENCES_MAX_SEATS,
  VerseServiceError,
  canonicalProjectPath,
  defaultVersePreferences,
  defaultVerseRoot,
  loadVersePreferences,
  memoryEnabledFor,
  parseVersePreferencesUpdate,
  seatDefaultMode,
  updateVersePreferences,
  versePreferencesPath,
} from '../src/core/verse/preferences.js';
import type { VersePreferencesUpdate } from '../src/core/verse/types.js';

let tmp: string;
let root: string;
let project: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'verse-prefs-'));
  root = join(tmp, 'verse');
  project = join(tmp, 'repo');
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function expectInvalid(fn: () => unknown, code: 'VERSE_INVALID' | 'VERSE_TOO_LARGE' = 'VERSE_INVALID'): VerseServiceError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VerseServiceError);
  expect((caught as VerseServiceError).code).toBe(code);
  expect((caught as VerseServiceError).status).toBe(code === 'VERSE_INVALID' ? 400 : 413);
  return caught as VerseServiceError;
}

describe('defaults', () => {
  it('loads the defaults when no file exists, without creating anything', () => {
    expect(loadVersePreferences(root)).toEqual({
      version: 1,
      seats: {},
      memory: { enabled: true, disabledProjects: [] },
    });
    expect(existsSync(root)).toBe(false);
  });

  it('defaults the root to ~/.ashlr/verse under the (isolated) HOME', () => {
    expect(defaultVerseRoot()).toBe(join(homedir(), '.ashlr', 'verse'));
    expect(versePreferencesPath()).toBe(join(homedir(), '.ashlr', 'verse', 'preferences.json'));
  });

  it('memory is on by default and seats default to standard', () => {
    const prefs = defaultVersePreferences();
    expect(memoryEnabledFor(prefs, project)).toBe(true);
    expect(seatDefaultMode(prefs, 'claude-a')).toBe('standard');
  });
});

describe('updateVersePreferences', () => {
  it('stores a seat default mode and reads it back', () => {
    const stored = updateVersePreferences({ seatId: 'claude-a', contextMode: 'expansive' }, root);
    expect(stored.seats).toEqual({ 'claude-a': { contextMode: 'expansive' } });
    const loaded = loadVersePreferences(root);
    expect(loaded).toEqual(stored);
    expect(seatDefaultMode(loaded, 'claude-a')).toBe('expansive');
    expect(seatDefaultMode(loaded, 'codex-b')).toBe('standard');
  });

  it('removes a seat entry set back to standard (absent means standard)', () => {
    updateVersePreferences({ seatId: 'claude-a', contextMode: 'expansive' }, root);
    const stored = updateVersePreferences({ seatId: 'claude-a', contextMode: 'standard' }, root);
    expect(stored.seats).toEqual({});
    expect(JSON.parse(readFileSync(versePreferencesPath(root), 'utf8')).seats).toEqual({});
  });

  it('accepts local seat ids with colons', () => {
    const stored = updateVersePreferences({ seatId: 'local:qwen3.8:27b-ctx64k', contextMode: 'expansive' }, root);
    expect(Object.keys(stored.seats)).toEqual(['local:qwen3.8:27b-ctx64k']);
  });

  it('toggles memory globally', () => {
    expect(updateVersePreferences({ memoryEnabled: false }, root).memory.enabled).toBe(false);
    const prefs = loadVersePreferences(root);
    expect(memoryEnabledFor(prefs, project)).toBe(false);
    expect(updateVersePreferences({ memoryEnabled: true }, root).memory.enabled).toBe(true);
  });

  it('opts one project out and back in, under its canonical path', () => {
    const alias = join(tmp, 'alias');
    symlinkSync(project, alias);
    const stored = updateVersePreferences({ projectPath: alias, memoryEnabled: false }, root);
    expect(stored.memory.disabledProjects).toEqual([realpathSync(project)]);

    const prefs = loadVersePreferences(root);
    // Every spelling of the same directory is opted out.
    expect(memoryEnabledFor(prefs, project)).toBe(false);
    expect(memoryEnabledFor(prefs, alias)).toBe(false);
    expect(memoryEnabledFor(prefs, realpathSync(project))).toBe(false);
    // Other projects are unaffected.
    const other = join(tmp, 'other');
    mkdirSync(other);
    expect(memoryEnabledFor(prefs, other)).toBe(true);

    const back = updateVersePreferences({ projectPath: project, memoryEnabled: true }, root);
    expect(back.memory.disabledProjects).toEqual([]);
  });

  it('is idempotent for a repeated opt-out', () => {
    updateVersePreferences({ projectPath: project, memoryEnabled: false }, root);
    const again = updateVersePreferences({ projectPath: project, memoryEnabled: false }, root);
    expect(again.memory.disabledProjects).toHaveLength(1);
  });

  it('writes a 0600 file inside a 0700 directory and leaves no temp files', () => {
    updateVersePreferences({ memoryEnabled: false }, root);
    if (process.platform !== 'win32') {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(versePreferencesPath(root)).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(root)).toEqual(['preferences.json']);
  });

  it('writes byte-identical files for equal states (stable key order)', () => {
    updateVersePreferences({ seatId: 'z-seat', contextMode: 'expansive' }, root);
    updateVersePreferences({ seatId: 'a-seat', contextMode: 'expansive' }, root);
    const first = readFileSync(versePreferencesPath(root), 'utf8');
    expect(Object.keys(JSON.parse(first).seats)).toEqual(['a-seat', 'z-seat']);
    updateVersePreferences({ seatId: 'a-seat', contextMode: 'expansive' }, root);
    expect(readFileSync(versePreferencesPath(root), 'utf8')).toBe(first);
  });

  it('refuses to write through a symlinked verse root', () => {
    const real = join(tmp, 'elsewhere');
    mkdirSync(real);
    symlinkSync(real, root);
    expect(() => updateVersePreferences({ memoryEnabled: false }, root)).toThrow(/not a real directory/);
    expect(readdirSync(real)).toEqual([]);
  });

  it('bounds the seat registry', () => {
    const seats: Record<string, { contextMode: string }> = {};
    for (let i = 0; i < VERSE_PREFERENCES_MAX_SEATS; i += 1) seats[`seat-${i}`] = { contextMode: 'expansive' };
    mkdirSync(root, { recursive: true });
    writeFileSync(versePreferencesPath(root), JSON.stringify({ version: 1, seats, memory: { enabled: true, disabledProjects: [] } }));
    expectInvalid(() => updateVersePreferences({ seatId: 'one-more', contextMode: 'expansive' }, root), 'VERSE_TOO_LARGE');
    // Updating an existing seat is still allowed at the bound.
    expect(() => updateVersePreferences({ seatId: 'seat-0', contextMode: 'expansive' }, root)).not.toThrow();
  });
});

describe('strict validation', () => {
  const bad: Array<[string, unknown]> = [
    ['non-object', 'expansive'],
    ['array', [{ memoryEnabled: true }]],
    ['null', null],
    ['empty object', {}],
    ['two forms mixed', { memoryEnabled: true, seatId: 'claude-a', contextMode: 'standard' }],
    ['unknown key', { memoryEnabled: true, extra: 1 }],
    ['seat without mode', { seatId: 'claude-a' }],
    ['bad mode', { seatId: 'claude-a', contextMode: 'huge' }],
    ['bad seat id', { seatId: '../etc', contextMode: 'standard' }],
    ['empty seat id', { seatId: '', contextMode: 'standard' }],
    ['memoryEnabled not boolean', { memoryEnabled: 'yes' }],
    ['project path relative', { projectPath: 'repo', memoryEnabled: false }],
    ['project path with NUL', { projectPath: '/tmp/a\0b', memoryEnabled: false }],
    ['project path not string', { projectPath: 42, memoryEnabled: false }],
    ['project memoryEnabled missing', { projectPath: '/tmp/x' }],
  ];

  for (const [label, body] of bad) {
    it(`rejects ${label} and writes nothing`, () => {
      expectInvalid(() => updateVersePreferences(body as VersePreferencesUpdate, root));
      expect(existsSync(versePreferencesPath(root))).toBe(false);
    });
  }

  it('parseVersePreferencesUpdate names the three accepted forms', () => {
    const err = expectInvalid(() => parseVersePreferencesUpdate({ nope: true }));
    expect(err.message).toMatch(/seatId, contextMode.*memoryEnabled.*projectPath, memoryEnabled/);
  });

  it('canonicalProjectPath expands ~ and rejects relative paths', () => {
    expect(canonicalProjectPath('~/x')).toBe(join(homedir(), 'x'));
    expectInvalid(() => canonicalProjectPath('x/y'));
    expectInvalid(() => canonicalProjectPath(''));
  });

  it('memoryEnabledFor treats an uncanonicalisable path as disabled', () => {
    expect(memoryEnabledFor(defaultVersePreferences(), 'relative/path')).toBe(false);
  });
});

describe('loadVersePreferences is total', () => {
  function writeRaw(content: string): void {
    mkdirSync(root, { recursive: true });
    writeFileSync(versePreferencesPath(root), content, { mode: 0o600 });
  }

  it('corrupt JSON → defaults', () => {
    writeRaw('{not json');
    expect(loadVersePreferences(root)).toEqual(defaultVersePreferences());
  });

  it('salvages valid fields and drops invalid ones', () => {
    writeRaw(JSON.stringify({
      version: 7,
      seats: {
        'claude-a': { contextMode: 'expansive' },
        'codex-b': { contextMode: 'standard' },     // default — not kept
        'grok-a': { contextMode: 'galactic' },       // invalid mode
        '../bad': { contextMode: 'expansive' },      // invalid id
        'local:x': 'expansive',                      // not an object
      },
      memory: { enabled: false, disabledProjects: ['/b', 'relative', 3, '/a', '/a'] },
      extra: true,
    }));
    expect(loadVersePreferences(root)).toEqual({
      version: 1,
      seats: { 'claude-a': { contextMode: 'expansive' } },
      memory: { enabled: false, disabledProjects: ['/a', '/b'] },
    });
  });

  it('wrong-typed memory fields fall back field by field', () => {
    writeRaw(JSON.stringify({ seats: [], memory: { enabled: 'no', disabledProjects: 'x' } }));
    expect(loadVersePreferences(root)).toEqual(defaultVersePreferences());
  });

  it('an oversized file is ignored', () => {
    writeRaw(JSON.stringify({ memory: { enabled: false, disabledProjects: [] }, pad: 'x'.repeat(300 * 1024) }));
    expect(loadVersePreferences(root).memory.enabled).toBe(true);
  });

  it('a symlinked preferences file is not followed', () => {
    mkdirSync(root, { recursive: true });
    const target = join(tmp, 'planted.json');
    writeFileSync(target, JSON.stringify({ memory: { enabled: false, disabledProjects: [] } }));
    symlinkSync(target, versePreferencesPath(root));
    expect(loadVersePreferences(root).memory.enabled).toBe(true);
  });

  it('an update over a corrupt file rewrites it cleanly', () => {
    writeRaw('garbage');
    const stored = updateVersePreferences({ seatId: 'claude-a', contextMode: 'expansive' }, root);
    expect(JSON.parse(readFileSync(versePreferencesPath(root), 'utf8'))).toEqual(stored);
  });
});

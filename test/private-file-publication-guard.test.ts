/** Real private-file publication; no providers, subprocesses or runtime activation. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePrivateFileAtomically } from '../src/core/util/private-file-write.js';

let root: string; let temporary: string; let target: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'private-publication-guard-')));
  const directory = join(root, 'private'); mkdirSync(directory, { mode: 0o700 });
  temporary = join(directory, '.candidate.tmp'); target = join(directory, 'active.json');
  writeFileSync(target, 'old', { mode: 0o600 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const write = (prepublish?: () => void) => writePrivateFileAtomically(temporary, target, 'new',
  { anchorPath: root, label: 'Fixture', ...(prepublish ? { prepublish } : {}) });

describe('private-file publication guard', () => {
  it('retains the existing unguarded publication behavior', () => {
    write(); expect(readFileSync(target, 'utf8')).toBe('new'); expect(existsSync(temporary)).toBe(false);
  });
  it('checks after candidate bytes are durable and before target replacement', () => {
    let checked = false;
    write(() => {
      checked = true; expect(readFileSync(temporary, 'utf8')).toBe('new'); expect(readFileSync(target, 'utf8')).toBe('old');
    });
    expect(checked).toBe(true); expect(readFileSync(target, 'utf8')).toBe('new');
  });
  it('preserves the target and cleans only its own unpublished temporary on refusal', () => {
    expect(() => write(() => { throw new Error('evidence changed'); })).toThrow('evidence changed');
    expect(readFileSync(target, 'utf8')).toBe('old'); expect(existsSync(temporary)).toBe(false);
  });
  it('rechecks the temporary identity after the guard and preserves a substituted file', () => {
    const moved = join(root, 'original.tmp');
    expect(() => write(() => {
      renameSync(temporary, moved); writeFileSync(temporary, 'new', { mode: 0o600 });
    })).toThrow('changed before publication');
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readFileSync(temporary, 'utf8')).toBe('new'); expect(readFileSync(moved, 'utf8')).toBe('new');
  });
  it.each([true, null, Promise.resolve(), { then() { throw new Error('Must not assimilate thenables'); } }])(
    'rejects a non-void guard result without publishing %#', result => {
      expect(() => write(() => result)).toThrow('must finish synchronously');
      expect(readFileSync(target, 'utf8')).toBe('old'); expect(existsSync(temporary)).toBe(false);
    });
  it('consumes a rejected async guard promise while refusing publication', async () => {
    expect(() => write(() => Promise.reject(new Error('async refusal')))).toThrow('must finish synchronously');
    await Promise.resolve(); expect(readFileSync(target, 'utf8')).toBe('old'); expect(existsSync(temporary)).toBe(false);
  });
});

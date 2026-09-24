/**
 * The composer's pure text rules (unit C3): triggers at the caret, what a
 * completion inserts and where the caret lands, attachment tokens.
 */
import { describe, expect, it } from 'vitest';
import {
  activeTrigger,
  applyCompletion,
  formatBytes,
  insertAttachmentRef,
  matchSlashCommands,
  mentionFor,
  removeAttachmentRef,
  SLASH_COMMANDS,
} from './composer-text.js';

describe('activeTrigger', () => {
  it('finds an @ mention at the start or after whitespace, not inside an address', () => {
    expect(activeTrigger('@comp', 5)).toEqual({ kind: 'mention', query: 'comp', start: 0, end: 5 });
    expect(activeTrigger('open @src/ver', 13)).toEqual({ kind: 'mention', query: 'src/ver', start: 5, end: 13 });
    expect(activeTrigger('mail me@host', 12)).toBeNull();
    expect(activeTrigger('done @x then', 12)).toBeNull();
    // The caret in the middle of a token: the whole word is replaced.
    expect(activeTrigger('see @compo here', 8)).toEqual({ kind: 'mention', query: 'com', start: 4, end: 10 });
  });

  it('finds a / command only as the first thing in the message', () => {
    expect(activeTrigger('/', 1)).toEqual({ kind: 'command', query: '', start: 0, end: 1 });
    expect(activeTrigger('/Pl', 3)).toEqual({ kind: 'command', query: 'pl', start: 0, end: 3 });
    expect(activeTrigger('run /plan', 9)).toBeNull();
    expect(activeTrigger('/plan now', 9)).toBeNull();
    expect(activeTrigger('/usr/bin', 8)).toBeNull();
  });

  it('refuses an out-of-range caret', () => {
    expect(activeTrigger('@a', 5)).toBeNull();
    expect(activeTrigger('@a', -1)).toBeNull();
  });
});

describe('completions', () => {
  it('replaces the trigger with one trailing space and places the caret after it', () => {
    const t = activeTrigger('open @comp please', 10)!;
    expect(applyCompletion('open @comp please', t, '@src/Composer.tsx')).toEqual({ text: 'open @src/Composer.tsx please', caret: 22 });
    const end = activeTrigger('@rea', 4)!;
    expect(applyCompletion('@rea', end, '@README.md')).toEqual({ text: '@README.md ', caret: 11 });
  });

  it('writes a primary-root file relative and another root’s from that root; quotes spaces', () => {
    expect(mentionFor({ path: 'src/a.ts', root: '~/dev/hub' }, '~/dev/hub')).toBe('@src/a.ts');
    expect(mentionFor({ path: 'lib/b.ts', root: '~/dev/shared/' }, '~/dev/hub')).toBe('@~/dev/shared/lib/b.ts');
    expect(mentionFor({ path: 'My Docs/c.md', root: '~/dev/hub' }, '~/dev/hub')).toBe('@"My Docs/c.md"');
  });

  it('ranks commands by prefix, then by substring', () => {
    expect(matchSlashCommands('').map((c) => c.id)).toEqual(SLASH_COMMANDS.map((c) => c.id));
    expect(matchSlashCommands('pl').map((c) => c.id)).toEqual(['plan']);
    expect(matchSlashCommands('mo').map((c) => c.id)[0]).toBe('model');
    expect(matchSlashCommands('zzz')).toEqual([]);
  });
});

describe('attachment tokens', () => {
  const ref = '@~/.ashlr/verse/attachments/s/0a0b0c0d-a.png';

  it('appends with one separating space, or inserts at the caret', () => {
    expect(insertAttachmentRef('', ref).text).toBe(`${ref} `);
    expect(insertAttachmentRef('look at', ref).text).toBe(`look at ${ref} `);
    expect(insertAttachmentRef('look at ', ref).text).toBe(`look at ${ref} `);
    expect(insertAttachmentRef('ab', ref, 1)).toEqual({ text: `a ${ref} b`, caret: 2 + ref.length + 1 });
  });

  it('removes every copy of the token and the space after it', () => {
    expect(removeAttachmentRef(`look at ${ref} and ${ref}`, ref)).toBe('look at and ');
    expect(removeAttachmentRef('untouched', ref)).toBe('untouched');
  });

  it('formats sizes the way an operator reads them', () => {
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(14 * 1024)).toBe('14 KB');
    expect(formatBytes(2.3 * 1024 * 1024)).toBe('2.3 MB');
    expect(formatBytes(-1)).toBe('—');
  });
});

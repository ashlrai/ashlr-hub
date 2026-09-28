/**
 * 3.15 — the input editor's pure rules (input-model.ts): when it shows, what
 * ↩ sends to the PTY, the hand-off bytes, ghost text, ↑/↓, `#` requests, and
 * path completion from the composer's file index.
 */
import { describe, expect, it } from 'vitest';
import {
  assistRequest,
  fileIndexQuery,
  ghostFor,
  handOffBytes,
  HistoryWalker,
  inputVisible,
  isOperatorKeystroke,
  nextPromptPhase,
  pathCompletions,
  pathToken,
  relativePath,
  submitBytes,
  type InputVisibility,
} from './input-model.js';

const AT_PROMPT: InputVisibility = {
  phase: 'input', integration: true, alternateScreen: false, exited: false, raw: false, handedOff: false, terminalMode: true,
};

describe('when the editor shows', () => {
  it('follows the OSC 133 marks: only after B and before C', () => {
    let phase = nextPromptPhase('unknown', 'A');
    expect(phase).toBe('prompt');
    phase = nextPromptPhase(phase, 'B');
    expect(phase).toBe('input');
    expect(nextPromptPhase(phase, 'C')).toBe('running');
    expect(nextPromptPhase('running', 'D;0')).toBe('done');
    expect(nextPromptPhase('input', 'P;Cwd=/x')).toBe('input');
  });

  it('never in the alternate screen, a Raw shell, a shell without integration, after a hand-off, or in the Blocks view', () => {
    expect(inputVisible(AT_PROMPT)).toBe(true);
    for (const off of [
      { phase: 'running' as const }, { phase: 'prompt' as const }, { alternateScreen: true }, { raw: true },
      { integration: false }, { handedOff: true }, { exited: true }, { terminalMode: false },
    ]) {
      expect(inputVisible({ ...AT_PROMPT, ...off }), JSON.stringify(off)).toBe(false);
    }
  });

  it('terminal replies (cursor position, device attributes, focus) are not the operator typing', () => {
    expect(isOperatorKeystroke('\x1b[12;1R')).toBe(false);
    expect(isOperatorKeystroke('\x1b[?1;2c')).toBe(false);
    expect(isOperatorKeystroke('\x1b[I')).toBe(false);
    expect(isOperatorKeystroke('\x1b]11;rgb:0000/0000/0000\x1b\\')).toBe(false);
    expect(isOperatorKeystroke('l')).toBe(true);
    expect(isOperatorKeystroke('\x1b[A')).toBe(true); // ↑ in the terminal: theirs
    expect(isOperatorKeystroke('\x03')).toBe(true);
  });
});

describe('what ↩ sends', () => {
  it('one line: the text and CR, as typed', () => {
    expect(submitBytes('ls -la', true)).toBe('ls -la\r');
    expect(submitBytes('', true)).toBe('\r');
  });

  it('several lines: one bracketed paste then CR (one command), else line by line', () => {
    expect(submitBytes('for f in *; do\n  echo $f\ndone', true)).toBe('\x1b[200~for f in *; do\n  echo $f\ndone\x1b[201~\r');
    expect(submitBytes('a\r\nb\n', false)).toBe('a\rb\r');
  });

  it('control characters cannot break out of the paste', () => {
    expect(submitBytes('echo hi\x1b[201~; rm -rf ~\nx', true)).toBe('\x1b[200~echo hi[201~; rm -rf ~\nx\x1b[201~\r');
    expect(submitBytes('a\x07b\tc', true)).toBe('ab\tc\r');
  });

  it('hand-off: the line goes to the shell\'s editor, then the key', () => {
    expect(handOffBytes('git st', '\t')).toBe('git st\t');
    expect(handOffBytes('', '\t')).toBe('\t');
    expect(handOffBytes('a\nb', '')).toBe('\x1b[200~a\nb\x1b[201~');
  });
});

describe('history in the editor', () => {
  const ranked = ['git status', 'git switch main', 'npm test', 'git stash'];

  it('ghost text: the best ranked command starting with what is typed', () => {
    expect(ghostFor('git s', ranked)).toBe('git status');
    expect(ghostFor('git sw', ranked)).toBe('git switch main');
    expect(ghostFor('git status', ranked)).toBeNull();
    expect(ghostFor('', ranked)).toBeNull();
    expect(ghostFor('   ', ranked)).toBeNull();
    expect(ghostFor('a\nb', ranked)).toBeNull();
  });

  it('↑/↓ walk the most recent first, filtered by the draft; ↓ past the newest restores the draft', () => {
    const recent = ['npm test', 'git stash', 'git status'];
    const w = new HistoryWalker(() => recent);
    expect(w.next()).toBeNull();
    expect(w.prev('')).toBe('npm test');
    expect(w.prev('npm test')).toBe('git stash');
    expect(w.prev('git stash')).toBe('git status');
    expect(w.prev('git status')).toBeNull();
    expect(w.next()).toBe('git stash');
    expect(w.next()).toBe('npm test');
    expect(w.next()).toBe('');
    expect(w.active).toBe(false);
    const g = new HistoryWalker(() => recent);
    expect(g.prev('git')).toBe('git stash');
    expect(g.prev('git stash')).toBe('git status');
    expect(g.next()).toBe('git stash');
    expect(g.next()).toBe('git');
  });

  it('# starts a plain-language request', () => {
    expect(assistRequest('# list big files')).toBe('list big files');
    expect(assistRequest('#find todo comments')).toBe('find todo comments');
    expect(assistRequest('#')).toBeNull();
    expect(assistRequest('echo # not a request')).toBeNull();
  });
});

describe('path completion', () => {
  it('finds the path-like word under the cursor', () => {
    expect(pathToken('cat src/co', 10)).toEqual({ from: 4, token: 'src/co' });
    expect(pathToken('ls ./a', 6)).toEqual({ from: 3, token: './a' });
    expect(pathToken('cd ~/code', 9)).toEqual({ from: 3, token: '~/code' });
    expect(pathToken('echo hello', 10)).toBeNull();
    expect(pathToken('x=$(cat src/', 12)).toEqual({ from: 8, token: 'src/' });
  });

  it('relative paths without node:path', () => {
    expect(relativePath('~/code/app/pkg', '~/code/app/src/x.ts')).toBe('../src/x.ts');
    expect(relativePath('/a/b', '/a/b/c/d')).toBe('c/d');
    expect(relativePath('/a/b', '/a/b')).toBe('.');
  });

  it('the file index\'s matches, spelled from the shell\'s cwd, one segment at a time, folders first', () => {
    const files = [
      { root: '~/code/app', path: 'src/components/Button.tsx' },
      { root: '~/code/app', path: 'src/config.ts' },
      { root: '~/code/app', path: 'src/cli.ts' },
      { root: '~/code/app', path: 'README.md' },
    ];
    expect(pathCompletions('src/c', '~/code/app', files)).toEqual(['src/components/', 'src/cli.ts', 'src/config.ts']);
    expect(pathCompletions('./src/co', '~/code/app', files)).toEqual(['./src/components/', './src/config.ts']);
    expect(pathCompletions('../src/', '~/code/app/pkg', files)).toEqual(['../src/components/', '../src/cli.ts', '../src/config.ts']);
    expect(pathCompletions('~/code/app/R', null, files)).toEqual(['~/code/app/README.md']);
    expect(pathCompletions('src/', null, files)).toEqual([]);
    expect(fileIndexQuery('../src/co')).toBe('src/co');
    expect(fileIndexQuery('~/code/app/R')).toBe('code/app/R');
  });
});

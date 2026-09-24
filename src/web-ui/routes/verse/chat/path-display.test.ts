import { describe, expect, it } from 'vitest';
import { abbreviateHome, displayPath, inputPath } from './path-display.js';

const SCRATCH = '/private/tmp/claude-501/-Users-mason-dev-hub/f387891f-39b2-43eb-90fc-2c5b22fac1e5/scratchpad/e2e-proj-39';

describe('displayPath', () => {
  it('draws a path under the chat root relative to it — the scratch path the live app showed', () => {
    expect(displayPath(`${SCRATCH}/math.ts`, [SCRATCH])).toBe('math.ts');
    expect(displayPath(`${SCRATCH}/src/lib/util.ts`, [`${SCRATCH}/`])).toBe('src/lib/util.ts');
  });

  it('lets the longest root win, so a nested worktree is its own root', () => {
    const roots = ['/Users/mason/dev/hub', '/Users/mason/dev/hub/.worktrees/fix'];
    expect(displayPath('/Users/mason/dev/hub/.worktrees/fix/src/a.ts', roots)).toBe('src/a.ts');
    expect(displayPath('/Users/mason/dev/hub/src/a.ts', roots)).toBe('src/a.ts');
  });

  it('matches a ~-saved project against the absolute paths its tools report', () => {
    expect(displayPath('/Users/mason/dev/hub/src/a.ts', ['~/dev/hub'])).toBe('src/a.ts');
  });

  it('names the root itself rather than drawing an empty string', () => {
    expect(displayPath('/Users/mason/dev/hub', ['/Users/mason/dev/hub'])).toBe('hub');
    expect(displayPath(SCRATCH, [SCRATCH])).toBe('e2e-proj-39');
  });

  it('does not treat a sibling that shares a prefix as inside the root', () => {
    expect(displayPath('/Users/mason/dev/hub-old/a.ts', ['/Users/mason/dev/hub'])).toBe('~/dev/hub-old/a.ts');
  });

  it('falls back to ~ outside the roots, and to the tail of a long absolute path', () => {
    expect(displayPath('/Users/mason/.claude/settings.json', ['/Users/mason/dev/hub'])).toBe('~/.claude/settings.json');
    expect(displayPath('/home/mason/notes.md')).toBe('~/notes.md');
    expect(displayPath(`${SCRATCH}/math.ts`)).toBe('…/scratchpad/e2e-proj-39/math.ts');
    // Short absolute paths and relative ones are already readable.
    expect(displayPath('/x/a.test.ts')).toBe('/x/a.test.ts');
    expect(displayPath('./src/a.ts')).toBe('src/a.ts');
    expect(displayPath('src/a.ts', [SCRATCH])).toBe('src/a.ts');
  });

  it('abbreviates only a real home prefix', () => {
    expect(abbreviateHome('/Users/mason')).toBe('~');
    expect(abbreviateHome('/var/Users/x')).toBe('/var/Users/x');
  });

  it('pulls the file out of a file call, never out of a command', () => {
    expect(inputPath({ file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(inputPath({ command: 'cat /a/b.ts', path: '/a' })).toBeNull();
    expect(inputPath('just text')).toBeNull();
    expect(inputPath(null)).toBeNull();
  });
});

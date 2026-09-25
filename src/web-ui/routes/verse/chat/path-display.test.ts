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

  it('matches a ~ root against the ~ paths the hub sends (it rewrote the operator\'s home in both)', () => {
    expect(displayPath('~/dev/hub/src/a.ts', ['~/dev/hub'])).toBe('src/a.ts');
    expect(displayPath('~/dev/hub', ['~/dev/hub/'])).toBe('hub');
  });

  it('names the root itself rather than drawing an empty string', () => {
    expect(displayPath('/Users/mason/dev/hub', ['/Users/mason/dev/hub'])).toBe('hub');
    expect(displayPath(SCRATCH, [SCRATCH])).toBe('e2e-proj-39');
  });

  it('does not treat a sibling that shares a prefix as inside the root', () => {
    expect(displayPath('~/dev/hub-old/a.ts', ['~/dev/hub'])).toBe('~/dev/hub-old/a.ts');
    expect(displayPath('/srv/dev/hub-old/a.ts', ['/srv/dev/hub'])).toBe('/srv/dev/hub-old/a.ts');
  });

  it('keeps a ~ path as the hub sent it outside the roots, and tails a long absolute path', () => {
    expect(displayPath('~/.claude/settings.json', ['~/dev/hub'])).toBe('~/.claude/settings.json');
    expect(displayPath(`${SCRATCH}/math.ts`)).toBe('…/scratchpad/e2e-proj-39/math.ts');
    // Short absolute paths and relative ones are already readable.
    expect(displayPath('/x/a.test.ts')).toBe('/x/a.test.ts');
    expect(displayPath('./src/a.ts')).toBe('src/a.ts');
    expect(displayPath('src/a.ts', [SCRATCH])).toBe('src/a.ts');
  });

  // 3.10.1 review: every `/Users/<x>` used to read as the operator's `~`, and
  // was compared against roots only after that — so a write to the shared,
  // world-writable /Users/Shared/proj/deploy.sh in a chat rooted at
  // /Users/mason/proj drew as the in-project `deploy.sh`. The hub alone knows
  // the operator's home and already sends it as `~`; nothing else is one.
  describe('never guesses a home', () => {
    it('does not draw /Users/Shared or another account as ~', () => {
      for (const p of ['/Users/Shared/.zshrc', '/Users/alice/x', '/home/alice/notes.md', '/Users/mason', 'C:\\Users\\alice\\x.txt']) {
        expect(abbreviateHome(p)).toBe(p);
        expect(displayPath(p)).toBe(p);
      }
      expect(displayPath('/Users/mason/.claude/settings.json', ['/Users/mason/dev/hub'])).toBe('/Users/mason/.claude/settings.json');
    });

    it('does not put a path under /Users/Shared or another home inside the chat root', () => {
      expect(displayPath('/Users/Shared/proj/deploy.sh', ['/Users/mason/proj'])).toBe('/Users/Shared/proj/deploy.sh');
      expect(displayPath('/Users/Shared/proj/deploy.sh', ['~/proj'])).toBe('/Users/Shared/proj/deploy.sh');
      expect(displayPath('/Users/alice/proj/a.ts', ['~/proj'])).toBe('/Users/alice/proj/a.ts');
      // A long one is tailed like any out-of-root path: the `…/` is what says
      // "not in this project" (an in-root path never starts with it).
      expect(displayPath('/home/alice/proj/src/lib/a.ts', ['~/proj'])).toBe('…/src/lib/a.ts');
    });
  });

  it('folds the macOS /private alias both ways — roots are not realpath\'d', () => {
    expect(displayPath('/private/tmp/e2e-proj/math.ts', ['/tmp/e2e-proj'])).toBe('math.ts');
    expect(displayPath('/tmp/e2e-proj/src/a.ts', ['/private/tmp/e2e-proj/'])).toBe('src/a.ts');
    expect(displayPath('/private/var/folders/xy/abc/T/proj/a.ts', ['/var/folders/xy/abc/T/proj'])).toBe('a.ts');
    expect(displayPath('/private/tmp/e2e-proj', ['/tmp/e2e-proj'])).toBe('e2e-proj');
    // Only the alias itself: /private/tmpx is not /tmpx, /private/opt is not /opt.
    expect(displayPath('/private/tmpx/a.ts', ['/tmpx'])).toBe('/private/tmpx/a.ts');
    expect(displayPath('/private/opt/a.ts', ['/opt'])).toBe('/private/opt/a.ts');
  });

  it('draws Windows paths relative to their root, in the CLI\'s own separators', () => {
    expect(displayPath('C:\\Users\\me\\proj\\src\\a.ts', ['C:\\Users\\me\\proj'])).toBe('src\\a.ts');
    expect(displayPath('C:\\Users\\me\\proj\\src\\a.ts', ['C:\\Users\\me\\proj\\'])).toBe('src\\a.ts');
    expect(displayPath('C:\\Users\\me\\proj\\src\\a.ts', ['C:/Users/me/proj'])).toBe('src\\a.ts');
    expect(displayPath('c:\\Users\\me\\proj\\a.ts', ['C:\\Users\\me\\proj'])).toBe('a.ts');
    expect(displayPath('C:/Users/me/proj/src/a.ts', ['C:\\Users\\me\\proj'])).toBe('src/a.ts');
    expect(displayPath('C:\\Users\\me\\proj', ['C:\\Users\\me\\proj'])).toBe('proj');
    expect(displayPath('C:\\Users\\me\\proj-old\\a.ts', ['C:\\Users\\me\\proj'])).toBe('C:\\Users\\me\\proj-old\\a.ts');
    // Outside every root: a long one keeps its tail, like a POSIX path.
    expect(displayPath('D:\\work\\a\\b\\c\\d.ts')).toBe('…\\b\\c\\d.ts');
    expect(displayPath('.\\src\\a.ts')).toBe('src\\a.ts');
  });

  it('ignores a bare /, drive or UNC root — it would claim every path', () => {
    expect(displayPath('/x/a.ts', ['/'])).toBe('/x/a.ts');
    expect(displayPath('C:\\x\\a.ts', ['C:\\'])).toBe('C:\\x\\a.ts');
    expect(displayPath('\\\\srv\\share\\a.ts', ['\\\\'])).toBe('\\\\srv\\share\\a.ts');
    expect(displayPath('\\\\srv\\share\\proj\\a.ts', ['\\\\srv\\share\\proj'])).toBe('a.ts');
  });

  it('pulls the file out of a file call, never out of a command', () => {
    expect(inputPath({ file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(inputPath({ command: 'cat /a/b.ts', path: '/a' })).toBeNull();
    expect(inputPath('just text')).toBeNull();
    expect(inputPath(null)).toBeNull();
  });
});

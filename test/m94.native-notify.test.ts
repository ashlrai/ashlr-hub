/**
 * M94 — cross-platform desktop notifications
 * (src/core/integrations/desktop-notify.ts)
 *
 * Invariants under test:
 *   - darwin  → osascript with AppleScript escape
 *   - win32   → powershell with PS single-quote escape, no injection
 *   - linux   → notify-send with direct args, no injection
 *   - opt-in gate: false when cfg.notify.desktop !== true (all platforms)
 *   - never throws when the OS tool is absent (spawn error)
 *   - never throws on 2s timeout path
 *   - returns false (not throw) for unsupported platforms
 *
 * No real notifications are sent; node:child_process is fully mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- mock node:child_process -----------------------------------------------
// Captured calls and the error to inject (reset in beforeEach).
let _calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
let _injectErr: Error | null = null;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      opts: Record<string, unknown>,
      cb: (err: Error | null) => void,
    ) => {
      _calls.push({ file, args, opts });
      cb(_injectErr);
      return {} as ReturnType<typeof actual.execFile>;
    },
  };
});

// ---- helpers ----------------------------------------------------------------

import { makeCfg } from './helpers/h1-fixture.js';
import { desktopNotify, desktopNotifyEnabled } from '../src/core/integrations/desktop-notify.js';
import type { AshlrConfig, NotifyTarget } from '../src/core/types.js';

function cfgOn(): AshlrConfig {
  const cfg = makeCfg() as AshlrConfig & { notify?: NotifyTarget };
  cfg.notify = { desktop: true };
  return cfg;
}

function cfgOff(): AshlrConfig {
  const cfg = makeCfg() as AshlrConfig & { notify?: NotifyTarget };
  cfg.notify = { desktop: false };
  return cfg;
}

/** Temporarily override process.platform, restore after the callback. */
async function withPlatform(platform: string, fn: () => Promise<void>): Promise<void> {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
}

// ---- setup ------------------------------------------------------------------

beforeEach(() => {
  expect.hasAssertions();
  _calls = [];
  _injectErr = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---- opt-in gate (platform-independent) -------------------------------------

describe('opt-in gate', () => {
  it('no-op when notify.desktop is unset', async () => {
    await withPlatform('darwin', async () => {
      const sent = await desktopNotify('t', 'b', makeCfg());
      expect(sent).toBe(false);
      expect(_calls).toHaveLength(0);
    });
  });

  it('no-op when notify.desktop is false', async () => {
    await withPlatform('linux', async () => {
      const sent = await desktopNotify('t', 'b', cfgOff());
      expect(sent).toBe(false);
      expect(_calls).toHaveLength(0);
    });
  });

  it('no-op on unsupported platform even when desktop=true', async () => {
    await withPlatform('freebsd', async () => {
      const sent = await desktopNotify('t', 'b', cfgOn());
      expect(sent).toBe(false);
      expect(_calls).toHaveLength(0);
    });
  });

  it('desktopNotifyEnabled returns false when notify.desktop is unset', async () => {
    await withPlatform('darwin', async () => {
      expect(desktopNotifyEnabled(makeCfg())).toBe(false);
    });
  });
});

// ---- darwin -----------------------------------------------------------------

describe('darwin — osascript', () => {
  it('spawns osascript with correct file and returns true', async () => {
    await withPlatform('darwin', async () => {
      const sent = await desktopNotify('hello', 'world', cfgOn());
      expect(sent).toBe(true);
      expect(_calls).toHaveLength(1);
      expect(_calls[0]!.file).toBe('osascript');
      expect(_calls[0]!.args[0]).toBe('-e');
    });
  });

  it('carries title and body in the AppleScript literal', async () => {
    await withPlatform('darwin', async () => {
      await desktopNotify('My Title', 'My Body', cfgOn());
      const script = _calls[0]!.args[1] ?? '';
      expect(script).toContain('My Title');
      expect(script).toContain('My Body');
    });
  });

  it('escapes double-quotes in title and body (AppleScript)', async () => {
    await withPlatform('darwin', async () => {
      await desktopNotify('say "hi"', 'foo "bar"', cfgOn());
      const script = _calls[0]!.args[1] ?? '';
      expect(script).toContain('\\"hi\\"');
      expect(script).toContain('\\"bar\\"');
      // The original unescaped " chars must not appear bare (must be preceded by backslash)
      expect(script).not.toMatch(/[^\\]"hi"/);
      expect(script).not.toMatch(/[^\\]"bar"/);
    });
  });

  it('escapes backslashes in title and body (AppleScript)', async () => {
    await withPlatform('darwin', async () => {
      await desktopNotify('C:\\Users', 'path\\to\\file', cfgOn());
      const script = _calls[0]!.args[1] ?? '';
      expect(script).toContain('C:\\\\Users');
      expect(script).toContain('path\\\\to\\\\file');
    });
  });

  it('collapses newlines (no literal \\n in AppleScript)', async () => {
    await withPlatform('darwin', async () => {
      await desktopNotify('line1\nline2', 'a\nb', cfgOn());
      const script = _calls[0]!.args[1] ?? '';
      expect(script).not.toContain('\n');
    });
  });

  it('passes 2s timeout option', async () => {
    await withPlatform('darwin', async () => {
      await desktopNotify('t', 'b', cfgOn());
      expect(_calls[0]!.opts).toMatchObject({ timeout: 2000 });
    });
  });

  it('returns false and does not throw when osascript errors', async () => {
    await withPlatform('darwin', async () => {
      _injectErr = new Error('spawn osascript ENOENT');
      const sent = await desktopNotify('t', 'b', cfgOn());
      expect(sent).toBe(false);
    });
  });

  it('prevents injection: $ in body does not reach shell (no shell used)', async () => {
    await withPlatform('darwin', async () => {
      // execFile is used, not exec — the AppleScript is a direct arg, not shell-expanded.
      // We just verify the arg contains the literal $ characters.
      await desktopNotify('t', 'price is $100 `date`', cfgOn());
      const script = _calls[0]!.args[1] ?? '';
      expect(script).toContain('$100');
      expect(script).toContain('`date`');
    });
  });
});

// ---- win32 ------------------------------------------------------------------

describe('win32 — PowerShell toast', () => {
  it('spawns powershell with -NoProfile -NonInteractive -Command', async () => {
    await withPlatform('win32', async () => {
      const sent = await desktopNotify('hello', 'world', cfgOn());
      expect(sent).toBe(true);
      expect(_calls).toHaveLength(1);
      expect(_calls[0]!.file).toBe('powershell');
      expect(_calls[0]!.args).toContain('-NoProfile');
      expect(_calls[0]!.args).toContain('-NonInteractive');
      expect(_calls[0]!.args).toContain('-Command');
    });
  });

  it('carries title and body in the PS script', async () => {
    await withPlatform('win32', async () => {
      await desktopNotify('Win Title', 'Win Body', cfgOn());
      const script = _calls[0]!.args.join(' ');
      expect(script).toContain('Win Title');
      expect(script).toContain('Win Body');
    });
  });

  it('escapes single-quotes (PS double them: \' → \'\')', async () => {
    await withPlatform('win32', async () => {
      await desktopNotify("it's here", "don't break", cfgOn());
      const script = _calls[0]!.args.join(' ');
      // Each ' in title/body must be doubled inside PS single-quoted strings
      expect(script).toContain("it''s here");
      expect(script).toContain("don''t break");
    });
  });

  it('collapses newlines in title and body', async () => {
    await withPlatform('win32', async () => {
      await desktopNotify('line1\nline2', 'a\nb\nc', cfgOn());
      const script = _calls[0]!.args.join(' ');
      // No literal newlines should appear in the PS command string
      expect(script).not.toContain('\n');
    });
  });

  it('prevents injection: $ and backticks are inside single-quoted PS strings (not expanded)', async () => {
    await withPlatform('win32', async () => {
      await desktopNotify('$env:USERNAME', '`whoami`', cfgOn());
      const script = _calls[0]!.args.join(' ');
      // The values appear literally — they are inside '' so PS doesn't expand them
      expect(script).toContain("'$env:USERNAME'");
      expect(script).toContain("'`whoami`'");
    });
  });

  it('passes 2s timeout option', async () => {
    await withPlatform('win32', async () => {
      await desktopNotify('t', 'b', cfgOn());
      expect(_calls[0]!.opts).toMatchObject({ timeout: 2000 });
    });
  });

  it('returns false and does not throw when powershell errors', async () => {
    await withPlatform('win32', async () => {
      _injectErr = new Error('spawn powershell ENOENT');
      const sent = await desktopNotify('t', 'b', cfgOn());
      expect(sent).toBe(false);
    });
  });
});

// ---- linux ------------------------------------------------------------------

describe('linux — notify-send', () => {
  it('spawns notify-send with title and body as separate args', async () => {
    await withPlatform('linux', async () => {
      const sent = await desktopNotify('hello', 'world', cfgOn());
      expect(sent).toBe(true);
      expect(_calls).toHaveLength(1);
      expect(_calls[0]!.file).toBe('notify-send');
      expect(_calls[0]!.args[0]).toBe('hello');
      expect(_calls[0]!.args[1]).toBe('world');
    });
  });

  it('passes title and body verbatim (no shell, execFile direct)', async () => {
    await withPlatform('linux', async () => {
      await desktopNotify('My Title', 'My Body', cfgOn());
      expect(_calls[0]!.args[0]).toBe('My Title');
      expect(_calls[0]!.args[1]).toBe('My Body');
    });
  });

  it('collapses newlines in args', async () => {
    await withPlatform('linux', async () => {
      await desktopNotify('line1\nline2', 'a\nb', cfgOn());
      expect(_calls[0]!.args[0]).not.toContain('\n');
      expect(_calls[0]!.args[1]).not.toContain('\n');
    });
  });

  it('strips NUL bytes from args', async () => {
    await withPlatform('linux', async () => {
      await desktopNotify('ti\0tle', 'bo\0dy', cfgOn());
      expect(_calls[0]!.args[0]).toBe('title');
      expect(_calls[0]!.args[1]).toBe('body');
    });
  });

  it('preserves shell metacharacters as literal text (execFile, no shell)', async () => {
    await withPlatform('linux', async () => {
      await desktopNotify('$(rm -rf /)', '`date`; $HOME', cfgOn());
      // execFile means no shell expansion — args arrive literally
      expect(_calls[0]!.args[0]).toBe('$(rm -rf /)');
      expect(_calls[0]!.args[1]).toBe('`date`; $HOME');
    });
  });

  it('passes 2s timeout option', async () => {
    await withPlatform('linux', async () => {
      await desktopNotify('t', 'b', cfgOn());
      expect(_calls[0]!.opts).toMatchObject({ timeout: 2000 });
    });
  });

  it('returns false and does not throw when notify-send is absent', async () => {
    await withPlatform('linux', async () => {
      _injectErr = new Error('spawn notify-send ENOENT');
      const sent = await desktopNotify('t', 'b', cfgOn());
      expect(sent).toBe(false);
    });
  });
});

// ---- desktopNotifyEnabled cross-platform ------------------------------------

describe('desktopNotifyEnabled cross-platform', () => {
  it('true on darwin with desktop=true', async () => {
    await withPlatform('darwin', async () => {
      expect(desktopNotifyEnabled(cfgOn())).toBe(true);
    });
  });

  it('true on win32 with desktop=true', async () => {
    await withPlatform('win32', async () => {
      expect(desktopNotifyEnabled(cfgOn())).toBe(true);
    });
  });

  it('true on linux with desktop=true', async () => {
    await withPlatform('linux', async () => {
      expect(desktopNotifyEnabled(cfgOn())).toBe(true);
    });
  });

  it('false on freebsd even with desktop=true', async () => {
    await withPlatform('freebsd', async () => {
      expect(desktopNotifyEnabled(cfgOn())).toBe(false);
    });
  });

  it('false on all platforms with desktop=false', async () => {
    for (const plat of ['darwin', 'win32', 'linux']) {
      await withPlatform(plat, async () => {
        expect(desktopNotifyEnabled(cfgOff())).toBe(false);
      });
    }
  });
});

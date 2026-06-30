/**
 * M32 — desktop notifications (src/core/integrations/desktop-notify.ts) and
 * the new-proposal fan-out (src/core/inbox/notify-proposal.ts).
 *
 * Invariants: strict no-op unless darwin AND cfg.notify.desktop === true;
 * AppleScript string escaping; never throws even when osascript is missing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:child_process so no real osascript ever runs; capture the args.
let _execFileCalls: { file: string; args: string[] }[] = [];
let _execFileErr: Error | null = null;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null) => void,
    ) => {
      _execFileCalls.push({ file, args });
      cb(_execFileErr);
      return {} as ReturnType<typeof actual.execFile>;
    },
  };
});

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import {
  desktopNotify,
  desktopNotifyEnabled,
  buildWindowsToastXml,
  buildWindowsToastScript,
} from '../src/core/integrations/desktop-notify.js';
import { notifyNewProposal } from '../src/core/inbox/notify-proposal.js';
import type { AshlrConfig, NotifyTarget, Proposal } from '../src/core/types.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  _execFileCalls = [];
  _execFileErr = null;
});

afterEach(() => {
  fx.cleanup();
  vi.clearAllMocks();
});

function cfgWithDesktop(on: boolean): AshlrConfig {
  const cfg = makeCfg() as AshlrConfig & { notify?: NotifyTarget };
  cfg.notify = { desktop: on };
  return cfg;
}

const onDarwin = process.platform === 'darwin';
const onWin32 = process.platform === 'win32';

describe('desktopNotify gating', () => {
  it('is a strict no-op when notify.desktop is unset', async () => {
    const sent = await desktopNotify('t', 'b', makeCfg());
    expect(sent).toBe(false);
    expect(_execFileCalls).toHaveLength(0);
  });

  it('is a strict no-op when notify.desktop is false', async () => {
    const sent = await desktopNotify('t', 'b', cfgWithDesktop(false));
    expect(sent).toBe(false);
    expect(_execFileCalls).toHaveLength(0);
  });

  it('desktopNotifyEnabled reflects config + platform', () => {
    expect(desktopNotifyEnabled(makeCfg())).toBe(false);
    // M94: desktop notifications are supported on darwin, win32, and linux.
    const supported = ['darwin', 'win32', 'linux'].includes(process.platform);
    expect(desktopNotifyEnabled(cfgWithDesktop(true))).toBe(supported);
  });

  it.runIf(onDarwin)('fires osascript when enabled on darwin', async () => {
    const sent = await desktopNotify('hello', 'world', cfgWithDesktop(true));
    expect(sent).toBe(true);
    expect(_execFileCalls).toHaveLength(1);
    expect(_execFileCalls[0]!.file).toBe('osascript');
  });

  it.runIf(onDarwin)('escapes quotes, backslashes, and newlines in the AppleScript literal', async () => {
    await desktopNotify('ti"tle', 'bo\\dy\nline2', cfgWithDesktop(true));
    const script = _execFileCalls[0]!.args[1] ?? '';
    expect(script).toContain('ti\\"tle');
    expect(script).toContain('bo\\\\dy');
    expect(script).not.toContain('\n');
  });

  it.runIf(onDarwin)('resolves false (never throws) when osascript errors', async () => {
    _execFileErr = new Error('spawn osascript ENOENT');
    const sent = await desktopNotify('t', 'b', cfgWithDesktop(true));
    expect(sent).toBe(false);
  });
});

describe('desktopNotify on Windows', () => {
  it.runIf(onWin32)('fires powershell when enabled on win32', async () => {
    const sent = await desktopNotify('hello', 'world', cfgWithDesktop(true));
    expect(sent).toBe(true);
    expect(_execFileCalls).toHaveLength(1);
    expect(_execFileCalls[0]!.file).toBe('powershell');
    // The script is passed via -Command as the final arg.
    expect(_execFileCalls[0]!.args).toContain('-Command');
  });

  it.runIf(onWin32)('XML-escapes title/body into the toast script', async () => {
    await desktopNotify('a & b <c>', 'say "hi"', cfgWithDesktop(true));
    const script = _execFileCalls[0]!.args.at(-1) ?? '';
    expect(script).toContain('a &amp; b &lt;c&gt;');
    expect(script).toContain('say &quot;hi&quot;');
  });

  it.runIf(onWin32)('resolves false (never throws) when powershell errors', async () => {
    _execFileErr = new Error('spawn powershell ENOENT');
    const sent = await desktopNotify('t', 'b', cfgWithDesktop(true));
    expect(sent).toBe(false);
  });
});

describe('Windows toast builders (pure — run on any platform)', () => {
  it('adds a protocol launch + action button when launchUri is set', () => {
    const xml = buildWindowsToastXml('Done', 'Ready', {
      launchUri: 'vscode://file/C:/proj',
      openLabel: 'Open proj',
    });
    expect(xml).toContain('launch="vscode://file/C:/proj"');
    expect(xml).toContain('<actions>');
    expect(xml).toContain('content="Open proj"');
    expect(xml).toContain('arguments="vscode://file/C:/proj"');
  });

  it('omits the action block and leaves launch empty when no launchUri', () => {
    const xml = buildWindowsToastXml('Done', 'Ready');
    expect(xml).toContain('launch=""');
    expect(xml).not.toContain('<actions>');
  });

  it('XML-escapes a launch URI containing reserved characters', () => {
    const xml = buildWindowsToastXml('t', 'b', {
      launchUri: 'vscode://file/C:/a&b/c d',
    });
    expect(xml).toContain('vscode://file/C:/a&amp;b/c d');
  });

  it('injects the XML as a single-quoted PS literal, doubling embedded quotes', () => {
    const script = buildWindowsToastScript("<toast launch='x''y'/>");
    // The single quotes inside the XML must be doubled for the PS literal.
    expect(script).toContain("LoadXml('<toast launch=''x''''y''/>')");
    expect(script).toContain('ToastNotificationManager');
  });
});

describe('notifyNewProposal', () => {
  function makeProposal(): Proposal {
    return {
      id: 'p-test-1',
      repo: null,
      origin: 'swarm',
      kind: 'patch',
      title: 'fix the widget',
      summary: 'meta',
      diff: 'SECRET-DIFF-CONTENT should never appear in notifications',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  }

  it('never throws and carries metadata only (no diff)', async () => {
    await expect(notifyNewProposal(makeProposal(), cfgWithDesktop(true))).resolves.toBeUndefined();
    for (const call of _execFileCalls) {
      expect(call.args.join(' ')).not.toContain('SECRET-DIFF-CONTENT');
      expect(call.args.join(' ')).toContain('fix the widget');
    }
  });

  it('is silent when nothing is configured', async () => {
    await notifyNewProposal(makeProposal(), makeCfg());
    expect(_execFileCalls).toHaveLength(0);
  });
});

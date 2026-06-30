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
import { desktopNotify, desktopNotifyEnabled } from '../src/core/integrations/desktop-notify.js';
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

/**
 * V3.10 R3c — `ashlr vision review` goes through the budget-gated Leader tick,
 * never the legacy Strategist (Claude CLI first, no budget gate), and
 * `ashlr leader oversight-plist --print` prints (never installs) the nightly
 * ai.ashlr.oversight LaunchAgent that runs `ashlr leader tick`.
 *
 * The Leader core and the Strategist are mocked: no seat is resolved and no
 * model is called. HOME is a tmp dir so nothing touches the real ~/.ashlr.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  runStrategist: vi.fn(async () => { throw new Error('runStrategist must not be reached'); }),
  loadDeps: vi.fn(async () => ({ fake: 'deps' })),
  leaderTick: vi.fn(async () => ({
    applied: [],
    graded: [],
    due: { due: false, trigger: null, reason: 'Nothing new since the last memo.', nextRunAt: '2026-09-25T10:30:00.000Z' },
    started: false,
    run: null,
  })),
  runLeader: vi.fn(async () => { throw new Error('vision review must not force a run'); }),
}));

vi.mock('../src/core/vision/strategist.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runStrategist: calls.runStrategist,
}));
vi.mock('../src/core/vision/leader.js', () => ({
  loadDefaultLeaderRunDeps: calls.loadDeps,
  leaderTick: calls.leaderTick,
  runLeader: calls.runLeader,
  buildLeaderState: vi.fn(() => { throw new Error('not used by tick'); }),
}));

import { cmdVision } from '../src/cli/vision.js';
import { buildOversightPlist, oversightScript, runLeaderCli } from '../src/cli/leader.js';

const origHome = process.env['HOME'];
let tmpHome: string;
let out: string[];
let err: string[];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-r3c-home-'));
  process.env['HOME'] = tmpHome;
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  for (const fn of Object.values(calls)) fn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env['HOME'] = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('ashlr vision review → Leader tick', () => {
  it('runs the Leader tick awaiting a due run, and never reaches runStrategist', async () => {
    expect(await cmdVision(['review'])).toBe(0);
    expect(calls.loadDeps).toHaveBeenCalledTimes(1);
    expect(calls.leaderTick).toHaveBeenCalledWith({ fake: 'deps' }, { awaitRun: true });
    expect(calls.runStrategist).not.toHaveBeenCalled();
    expect(calls.runLeader).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('No run due: Nothing new since the last memo.');
  });

  it('accepts --project for old scripts but says the Leader reviews the whole portfolio', async () => {
    expect(await cmdVision(['review', '--project', 'my\u001b[31mrepo'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('--project my[31mrepo: the Leader reviews the whole portfolio');
    expect(text).not.toContain('\u001b[31mrepo');
    expect(calls.leaderTick).toHaveBeenCalledTimes(1);
    expect(calls.runStrategist).not.toHaveBeenCalled();
  });

  it('refuses bad usage without ticking', async () => {
    expect(await cmdVision(['review', '--project'])).toBe(2);
    expect(await cmdVision(['review', '--project', '--force'])).toBe(2);
    expect(await cmdVision(['review', '--frobnicate'])).toBe(2);
    expect(calls.leaderTick).not.toHaveBeenCalled();
    expect(calls.runStrategist).not.toHaveBeenCalled();
  });

  it('points a missing-briefing approve at Leader memos, not at review', async () => {
    expect(await cmdVision(['approve'])).toBe(1);
    expect(err.join('\n')).toContain('ashlr leader show');
    expect(err.join('\n')).not.toContain('vision review');
  });
});

describe('ashlr leader oversight-plist', () => {
  function capture(): { restore: () => string } {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      chunks.push(String(c));
      return true;
    });
    return { restore: () => { spy.mockRestore(); return chunks.join(''); } };
  }

  it('--print writes the plist to stdout, touches nothing, and never loads the Leader core', async () => {
    const cap = capture();
    const code = await runLeaderCli(['oversight-plist', '--print']);
    const xml = cap.restore();
    expect(code).toBe(0);
    expect(xml).toContain('<string>ai.ashlr.oversight</string>');
    expect(xml).toContain(`&apos;${tmpHome}/.local/bin/ashlr&apos; leader tick --wait`);
    expect(xml).not.toContain('vision review');
    expect(xml).not.toContain(' manager');
    expect(xml).toContain('<key>Hour</key>\n\t\t<integer>7</integer>');
    expect(fs.readdirSync(tmpHome)).toEqual([]);
    expect(calls.loadDeps).not.toHaveBeenCalled();
    expect(calls.leaderTick).not.toHaveBeenCalled();
  });

  it('requires --print and an absolute --bin', async () => {
    expect(await runLeaderCli(['oversight-plist'])).toBe(2);
    expect(await runLeaderCli(['oversight-plist', '--print', '--bin', 'ashlr'])).toBe(2);
    expect(await runLeaderCli(['oversight-plist', '--print', '--bin'])).toBe(2);
    expect(await runLeaderCli(['oversight-plist', '--print', 'extra'])).toBe(2);
  });

  it('shell-quotes the launcher and XML-escapes the whole script', () => {
    const bin = "/Users/it's <me>/bin/ashlr";
    const script = oversightScript(bin);
    expect(script).toContain(`'/Users/it'\\''s <me>/bin/ashlr' leader tick --wait`);
    expect(script.indexOf('leader tick --wait')).toBeLessThan(script.indexOf('comms ask-vision'));
    const xml = buildOversightPlist({ home: '/Users/a&b', ashlrBin: bin });
    expect(xml).toContain('&apos;/Users/it&apos;\\&apos;&apos;s &lt;me&gt;/bin/ashlr&apos; leader tick --wait');
    expect(xml).toContain('<string>/Users/a&amp;b</string>');
    expect(xml).toContain('} &gt;&gt; &quot;$LOG&quot; 2&gt;&amp;1');
    // XML forbids "--" inside a comment; plutil would reject the file.
    for (const comment of xml.match(/<!--([\s\S]*?)-->/g) ?? []) expect(comment.slice(4, -3)).not.toContain('--');
  });
});

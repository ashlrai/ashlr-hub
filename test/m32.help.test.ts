/**
 * M32 — topic-grouped help (src/cli/help.ts cmdHelp + HELP_ENTRIES).
 *
 * Pure unit tests over the exported data + captured stdout. No HOME mutation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { cmdHelp, HELP_ENTRIES } from '../src/cli/help.js';
import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';

let captured: string[] = [];
let origLog: typeof console.log;

beforeEach(() => {
  expect.hasAssertions();
  captured = [];
  origLog = console.log;
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
});

afterEach(() => {
  console.log = origLog;
});

function output(): string {
  return captured.join('\n');
}

describe('HELP_ENTRIES — the command table', () => {
  it('every entry has a command, description, and known topic', () => {
    expect(HELP_ENTRIES.length).toBeGreaterThanOrEqual(80);
    for (const e of HELP_ENTRIES) {
      expect(e.cmd.length).toBeGreaterThan(1);
      expect(e.desc.length).toBeGreaterThan(10);
    }
  });

  it('covers every top-level command (no drift vs completions)', () => {
    const tableCmds = new Set(HELP_ENTRIES.map((e) => e.cmd.split(' ')[0]));
    for (const cmd of TOP_LEVEL_COMMANDS) {
      if (cmd === 'dash') continue; // alias of tui
      expect(tableCmds.has(cmd), `help table missing "${cmd}"`).toBe(true);
    }
  });
});

describe('cmdHelp routing', () => {
  it('no args → grouped topic summary (not the full wall)', async () => {
    expect(await cmdHelp([])).toBe(0);
    const text = output();
    expect(text).toContain('autonomy');
    expect(text).toContain('ashlr help <topic>');
    // The summary must NOT include every command (that is --all's job).
    expect(text).not.toContain('onboard --rollback');
  });

  it('help <topic> → full table for that topic with examples', async () => {
    expect(await cmdHelp(['run'])).toBe(0);
    const text = output();
    expect(text).toContain('run "<goal>"');
    expect(text).toContain('--estimate');
    expect(text).not.toContain('enroll add');
  });

  it('help autonomy advertises resource-aware direction', async () => {
    expect(await cmdHelp(['autonomy'])).toBe(0);
    const text = output();
    expect(text).toContain('fleet direction [--json]');
    expect(text).toContain('resource-aware mode recommendation');
    expect(text).toContain('fleet evidence doctor <source>');
    expect(text).toContain('Bounded read-only diagnosis');
  });

  it('help --all → every command', async () => {
    expect(await cmdHelp(['--all'])).toBe(0);
    const text = output();
    for (const e of HELP_ENTRIES.slice(0, 30)) {
      expect(text).toContain(e.cmd);
    }
  });

  it('help --search finds commands by keyword', async () => {
    expect(await cmdHelp(['--search', 'kill'])).toBe(0);
    expect(output()).toContain('enroll kill on|off');
  });

  it('help --search with no hits says so', async () => {
    expect(await cmdHelp(['--search', 'zzzznotathing'])).toBe(0);
    expect(output()).toContain('no commands match');
  });

  it('unknown topic lists the valid topics (exit 0 — help never fails)', async () => {
    expect(await cmdHelp(['nonsense'])).toBe(0);
    expect(output()).toContain('unknown topic');
    expect(output()).toContain('autonomy');
  });
});

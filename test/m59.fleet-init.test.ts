/**
 * M59 — `ashlr fleet init` (config bootstrap) print path + help.
 *
 * Hermetic and SAFE: only the print path is exercised (it never writes config).
 * The --write path is intentionally NOT invoked here because resolveConfigDir
 * uses os.homedir() (not process.env.HOME), so a write test could touch the real
 * ~/.ashlr; --write is verified manually. The typed cfg.foundry.intelligence
 * field is covered by the project typecheck.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return { lines, restore: () => { console.log = orig; } };
}

afterEach(() => vi.restoreAllMocks());

describe('M59 — ashlr fleet init (print)', () => {
  it('prints a starter cfg.foundry block and returns 0 (no write)', async () => {
    const cap = captureLog();
    let rc: number;
    try {
      rc = await cmdFleet(['init']);
    } finally {
      cap.restore();
    }
    const out = cap.lines.join('\n');
    expect(rc).toBe(0);
    expect(out).toContain('"foundry"');
    expect(out).toContain('"allowedBackends"');
    expect(out).toContain('hermes');
    expect(out).toContain('autoMerge');
    // The starter must keep auto-merge OFF.
    expect(out).toMatch(/"enabled":\s*false/);
    // It must point at the reference doc.
    expect(out).toContain('FOUNDRY-CONFIG.md');
  });
});

describe('M59 — fleet help lists init', () => {
  it('`ashlr fleet --help` documents the init subcommand', async () => {
    const cap = captureLog();
    try {
      await cmdFleet(['--help']);
    } finally {
      cap.restore();
    }
    expect(cap.lines.join('\n')).toContain('fleet init');
  });
});

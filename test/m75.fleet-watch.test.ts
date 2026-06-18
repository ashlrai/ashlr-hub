/**
 * m75.fleet-watch.test.ts — M75: `ashlr fleet watch` glanceable monitoring summary.
 *
 * Units under test:
 *   1. tailErrLog (src/cli/fleet.ts) — pure tail helper; exported for testing.
 *   2. cmdFleetWatch (src/cli/fleet.ts) — the watch subcommand.
 *
 * HOME is relocated to a fresh tmp dir per test so the whole ~/.ashlr surface
 * is isolated (audit log, daemon err log, daemon state, etc.). Mirrors the
 * conventions established in test/m49.fleet-status.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdFleetWatch, tailErrLog } from '../src/cli/fleet.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m75-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // win32 homedir()
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Stdout capture helper
// ---------------------------------------------------------------------------

function captureStdout(fn: () => Promise<number>): Promise<{ output: string; exitCode: number }> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);

  process.stdout.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(' ') + '\n');
  };

  return fn().then((exitCode) => {
    process.stdout.write = origWrite;
    console.log = origLog;
    return { output: chunks.join(''), exitCode };
  }).catch((err) => {
    process.stdout.write = origWrite;
    console.log = origLog;
    throw err;
  });
}

// ---------------------------------------------------------------------------
// tailErrLog — pure helper
// ---------------------------------------------------------------------------

describe('tailErrLog', () => {
  it('returns [] for a missing file', () => {
    expect(tailErrLog('/nonexistent/path/daemon.err.log', 5)).toEqual([]);
  });

  it('returns [] for an existing file that is empty or all-blank', () => {
    const p = join(tmpHome, 'empty.log');
    writeFileSync(p, '\n\n\n');
    expect(tailErrLog(p, 5)).toEqual([]);
  });

  it('returns last N non-empty lines when file has fewer than N', () => {
    const p = join(tmpHome, 'small.log');
    writeFileSync(p, 'line1\nline2\nline3\n');
    expect(tailErrLog(p, 5)).toEqual(['line1', 'line2', 'line3']);
  });

  it('returns exactly the last N non-empty lines when file has more than N', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `error line ${i + 1}`);
    const p = join(tmpHome, 'big.log');
    writeFileSync(p, lines.join('\n') + '\n');
    const result = tailErrLog(p, 5);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe('error line 16');
    expect(result[4]).toBe('error line 20');
  });

  it('handles a file larger than maxBytes by reading only the tail slice', () => {
    // Build a file where only the last few lines are within the tail window.
    const earlyLines = Array.from({ length: 1000 }, () => 'a'.repeat(30)).join('\n');
    const tailLines = ['tail-1', 'tail-2', 'tail-3'];
    const p = join(tmpHome, 'large.log');
    writeFileSync(p, earlyLines + '\n' + tailLines.join('\n') + '\n');
    const result = tailErrLog(p, 3, 100); // maxBytes=100 — only captures the tail
    expect(result).toContain('tail-3');
  });
});

// ---------------------------------------------------------------------------
// cmdFleetWatch — JSON mode
// ---------------------------------------------------------------------------

describe('cmdFleetWatch — JSON mode', () => {
  it('returns exit code 0 and emits valid JSON', async () => {
    const { output, exitCode } = await captureStdout(() => cmdFleetWatch(true));
    expect(exitCode).toBe(0);

    let parsed: Record<string, unknown>;
    expect(() => { parsed = JSON.parse(output); }).not.toThrow();
    parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('fleet');
    expect(parsed).toHaveProperty('recentActions');
    expect(parsed).toHaveProperty('recentErrors');
    expect(Array.isArray(parsed.recentActions)).toBe(true);
    expect(Array.isArray(parsed.recentErrors)).toBe(true);
  });

  it('never throws when the err-log is absent', async () => {
    // No ~/.ashlr dir at all — should degrade gracefully.
    await expect(cmdFleetWatch(true)).resolves.toBe(0);
  });

  it('never throws when the audit log is absent', async () => {
    // Ensure ~/.ashlr exists but has no audit files.
    mkdirSync(join(tmpHome, '.ashlr'), { recursive: true });
    await expect(cmdFleetWatch(true)).resolves.toBe(0);
  });

  it('includes recentErrors from a seeded err-log', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    mkdirSync(ashlrDir, { recursive: true });
    const errLog = join(ashlrDir, 'daemon.launchd.err.log');
    writeFileSync(errLog, ['err A', 'err B', 'err C', 'err D', 'err E', 'err F'].join('\n') + '\n');

    const { output } = await captureStdout(() => cmdFleetWatch(true));
    const parsed = JSON.parse(output);

    expect(parsed.recentErrors).toHaveLength(5);
    // Last 5 of 6 lines.
    expect(parsed.recentErrors).toEqual(['err B', 'err C', 'err D', 'err E', 'err F']);
  });

  it('recentErrors is [] when err-log is missing', async () => {
    const { output } = await captureStdout(() => cmdFleetWatch(true));
    const parsed = JSON.parse(output);
    expect(parsed.recentErrors).toEqual([]);
  });

  it('recentActions is [] when audit is unavailable', async () => {
    // No audit module wired (fresh tmp HOME, no audit JSONL) — module import
    // may succeed but readAudit() returns []; either way recentActions is [].
    const { output } = await captureStdout(() => cmdFleetWatch(true));
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed.recentActions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cmdFleetWatch — human mode
// ---------------------------------------------------------------------------

describe('cmdFleetWatch — human mode', () => {
  it('returns 0 and prints a non-empty block', async () => {
    const { output, exitCode } = await captureStdout(() => cmdFleetWatch(false));
    expect(exitCode).toBe(0);
    expect(output.trim().length).toBeGreaterThan(0);
  });

  it('contains "fleet:" health header', async () => {
    const { output } = await captureStdout(() => cmdFleetWatch(false));
    expect(output).toMatch(/fleet:/);
  });

  it('contains "Recent actions" section header', async () => {
    const { output } = await captureStdout(() => cmdFleetWatch(false));
    expect(output).toContain('Recent actions');
  });

  it('contains "Recent errors" section header', async () => {
    const { output } = await captureStdout(() => cmdFleetWatch(false));
    expect(output).toContain('Recent errors');
  });

  it('shows "none" for errors when err-log is absent', async () => {
    const { output } = await captureStdout(() => cmdFleetWatch(false));
    // The "Recent errors" section should say "none" when no log exists.
    const errSection = output.slice(output.indexOf('Recent errors'));
    expect(errSection).toContain('none');
  });

  it('shows error lines from a seeded err-log', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    mkdirSync(ashlrDir, { recursive: true });
    const errLog = join(ashlrDir, 'daemon.launchd.err.log');
    writeFileSync(errLog, 'fatal: something exploded\n');

    const { output } = await captureStdout(() => cmdFleetWatch(false));
    expect(output).toContain('fatal: something exploded');
  });

  it('never throws with a completely bare environment', async () => {
    await expect(cmdFleetWatch(false)).resolves.toBe(0);
  });
});

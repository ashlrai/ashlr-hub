/**
 * Regression test for the `ashlr doctor` / `ashlr init` exit-code contract (M2).
 *
 * The CLI header promises "Exit codes: 0 success, 1 error/not-found" and
 * cmdDoctor()/cmdInit() return 1 when any check fails. A prior bug discarded
 * that return value in main()'s dispatcher, so Node always exited 0 even when
 * checks failed — breaking `ashlr doctor || setup` style scripting.
 *
 * These tests spawn the REAL compiled CLI (bin/ashlr) as a subprocess with a
 * forced-fail condition and assert a non-zero exit in BOTH plain and --json
 * modes. Spawning the real binary is the only way to verify that
 * process.exitCode is actually propagated to the OS exit status.
 *
 * Forced-fail mechanism: we strip PATH down to nothing so `which git` resolves
 * to nothing. checkGit() is a HARD 'fail' when git is not on PATH — a
 * deterministic, network-independent failure. We still invoke node and the bin
 * via absolute paths so the CLI itself launches normally.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const BIN = resolve(__dirname, '..', 'bin', 'ashlr');

// Absolute path to the node executable so we don't rely on PATH.
const NODE = process.execPath;

let tmpHome: string;

/** Seed a valid config so the CLI starts cleanly (failure comes from PATH). */
function writeValidConfig(home: string): void {
  const ashlrDir = join(home, '.ashlr');
  mkdirSync(ashlrDir, { recursive: true });
  writeFileSync(
    join(ashlrDir, 'config.json'),
    JSON.stringify({
      version: 1,
      roots: [join(home, 'Desktop')],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: {
        lmstudio: 'http://localhost:1234',
        ollama: 'http://localhost:11434',
        providerChain: ['lmstudio', 'ollama'],
      },
      telemetry: {},
      tools: {},
    }),
  );
}

/**
 * Run the compiled CLI with an isolated HOME and an EMPTY PATH so `which git`
 * fails inside doctor (deterministic hard failure). node and the bin are
 * invoked by absolute path, so the process still launches.
 */
function runCliNoPath(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...process.env, HOME: tmpHome, PATH: '' };
  const result = spawnSync(NODE, [BIN, ...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Helper that runs with an empty PATH and sanity-checks that the CLI actually
 * produced stdout (i.e. it launched). Returns the result for assertions.
 */
function runCliAssertLaunched(args: string[]): { status: number | null; stdout: string } {
  const { status, stdout, stderr } = runCliNoPath(args);
  if (!stdout.trim()) {
    throw new Error(`CLI produced no stdout (did it launch?). stderr: ${stderr}`);
  }
  return { status, stdout };
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-exitcode-'));
  writeValidConfig(tmpHome);
});

afterEach(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe('ashlr doctor — exit-code propagation', () => {
  it('compiled bin exists (build ran)', () => {
    expect(existsSync(BIN)).toBe(true);
  });

  it('exits non-zero (1) in plain mode when a check fails', () => {
    const { status, stdout } = runCliAssertLaunched(['doctor']);
    expect(status).toBe(1);
    expect(stdout).toContain('git');
  });

  it('exits non-zero (1) in --json mode when a check fails', () => {
    const { status, stdout } = runCliAssertLaunched(['doctor', '--json']);
    expect(status).toBe(1);
    const report = JSON.parse(stdout) as { summary: { fail: number } };
    expect(report.summary.fail).toBeGreaterThan(0);
  });
});

describe('ashlr init — exit-code propagation', () => {
  it('exits non-zero (1) in --json mode when resulting doctor has failures', () => {
    const { status, stdout } = runCliAssertLaunched(['init', '--json']);
    expect(status).toBe(1);
    const result = JSON.parse(stdout) as { doctorSummary: { fail: number } };
    expect(result.doctorSummary.fail).toBeGreaterThan(0);
  });
});

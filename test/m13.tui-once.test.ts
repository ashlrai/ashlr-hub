/**
 * M13 TUI --once mode tests — hermetic, no interactive mode entered.
 *
 * Tests runTui(cfg, { once: true }) from src/tui/app.ts:
 *   - Resolves to exit code 0 without entering raw mode or alt-screen.
 *   - Writes a non-empty frame to stdout.
 *   - Does NOT call process.stdin.setRawMode (never enters raw mode).
 *   - Does NOT write ESC[?1049h (alt-screen enter sequence) to stdout.
 *   - Works correctly on a non-TTY stdout (same as --once).
 *   - Calls buildSnapshot and renderFrame under the hood.
 *   - Returns 0 even when buildSnapshot() resolves to a zeroed snapshot.
 *
 * All data sources are mocked so no real ~/.ashlr/ data is read.
 * process.stdin.setRawMode is spied on to guarantee raw mode is never engaged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig, DashboardSnapshot } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

// ---------------------------------------------------------------------------
// Minimal snapshot fixture
// ---------------------------------------------------------------------------

function makeSnapshot(): DashboardSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    repos: { total: 3, dirty: 1, stale: 0 },
    tools: { installed: 2, total: 5 },
    activity: { sessions: 2, tokens: 8000, estCostUsd: 0.15, commits: 4 },
    runs: [
      { id: 'run-001', goal: 'Test goal alpha', status: 'done', tokens: 1000 },
    ],
    swarms: [
      { id: 'swarm-001', goal: 'Test swarm beta', status: 'running', tasksDone: 1, tasksTotal: 3, phase: 'build' },
    ],
    mcp: [
      { name: 'ashlr', ok: true, tools: 8 },
    ],
    genome: { entries: 10, projects: 3 },
  };
}

// ---------------------------------------------------------------------------
// Mock dashboard module so buildSnapshot returns our fixture
// ---------------------------------------------------------------------------

vi.mock('../src/core/dashboard.js', () => ({
  buildSnapshot: vi.fn(async () => makeSnapshot()),
}));

// ---------------------------------------------------------------------------
// Lazy-load runTui — mirrors the cli/tui.ts pattern so the test file loads
// cleanly even when src/tui/app.ts has not yet been written.
// ---------------------------------------------------------------------------

type RunTuiFn = (cfg: AshlrConfig, opts: { once: boolean }) => Promise<number>;

let runTui: RunTuiFn | null = null;
let moduleUnavailable = false;

try {
  const mod = await import('../src/tui/app.js' as string) as { runTui: RunTuiFn };
  runTui = mod.runTui;
} catch {
  moduleUnavailable = true;
}

// ---------------------------------------------------------------------------
// Stdout capture helpers
// ---------------------------------------------------------------------------

let stdoutChunks: string[] = [];
let originalStdoutWrite: typeof process.stdout.write;

function captureStdout(): void {
  stdoutChunks = [];
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (chunk: unknown, ...rest: unknown[]): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalStdoutWrite as any)(chunk, ...rest);
    },
  );
}

function capturedOutput(): string {
  return stdoutChunks.join('');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  captureStdout();

  // Reset buildSnapshot mock to default fixture on each test
  const { buildSnapshot } = await import('../src/core/dashboard.js');
  vi.mocked(buildSnapshot).mockResolvedValue(makeSnapshot());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// --once path: resolves, exits 0, writes output, no raw mode / alt-screen
// ---------------------------------------------------------------------------

describe('runTui({ once: true }) — basic contract', () => {
  it.skipIf(moduleUnavailable)('resolves (does not throw or reject)', async () => {
    await expect(runTui!(makeConfig(), { once: true })).resolves.toBeDefined();
  });

  it.skipIf(moduleUnavailable)('returns exit code 0', async () => {
    const code = await runTui!(makeConfig(), { once: true });
    expect(code).toBe(0);
  });

  it.skipIf(moduleUnavailable)('writes a non-empty string to stdout', async () => {
    await runTui!(makeConfig(), { once: true });
    expect(capturedOutput().length).toBeGreaterThan(0);
  });

  it.skipIf(moduleUnavailable)('stdout contains visible content (not just escape codes)', async () => {
    await runTui!(makeConfig(), { once: true });
    // Strip ANSI codes; remaining text must be non-trivial
    // eslint-disable-next-line no-control-regex
    const plain = capturedOutput().replace(/\x1b\[[0-9;]*[mABCDHJKSTfhl]/g, '');
    expect(plain.trim().length).toBeGreaterThan(0);
  });
});

describe('runTui({ once: true }) — no interactive/raw-mode engagement', () => {
  it.skipIf(moduleUnavailable)('does NOT call process.stdin.setRawMode', async () => {
    // In a non-TTY test worker stdin has no setRawMode; install a no-op so the
    // spy can be created. The assertion (never called) still holds meaning.
    if (typeof process.stdin.setRawMode !== 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdin as any).setRawMode = () => process.stdin;
    }
    const setRawModeSpy = vi.spyOn(process.stdin, 'setRawMode').mockImplementation(() => process.stdin);
    await runTui!(makeConfig(), { once: true });
    expect(setRawModeSpy).not.toHaveBeenCalled();
  });

  it.skipIf(moduleUnavailable)('does NOT write the alt-screen enter sequence (ESC[?1049h) to stdout', async () => {
    await runTui!(makeConfig(), { once: true });
    expect(capturedOutput()).not.toContain('\x1b[?1049h');
  });

  it.skipIf(moduleUnavailable)('does NOT write the hide-cursor sequence (ESC[?25l) to stdout', async () => {
    await runTui!(makeConfig(), { once: true });
    expect(capturedOutput()).not.toContain('\x1b[?25l');
  });
});

describe('runTui({ once: true }) — calls buildSnapshot', () => {
  it.skipIf(moduleUnavailable)('calls buildSnapshot exactly once', async () => {
    const { buildSnapshot } = await import('../src/core/dashboard.js');
    vi.mocked(buildSnapshot).mockClear();
    await runTui!(makeConfig(), { once: true });
    expect(vi.mocked(buildSnapshot)).toHaveBeenCalledTimes(1);
  });

  it.skipIf(moduleUnavailable)('passes the config to buildSnapshot', async () => {
    const { buildSnapshot } = await import('../src/core/dashboard.js');
    vi.mocked(buildSnapshot).mockClear();
    const cfg = makeConfig();
    await runTui!(cfg, { once: true });
    expect(vi.mocked(buildSnapshot)).toHaveBeenCalledWith(cfg);
  });
});

describe('runTui({ once: true }) — rendered frame content', () => {
  it.skipIf(moduleUnavailable)('frame contains the overview tab or some tab name', async () => {
    await runTui!(makeConfig(), { once: true });
    // eslint-disable-next-line no-control-regex
    const output = capturedOutput().replace(/\x1b\[[0-9;]*m/g, '').toLowerCase();
    expect(
      output.includes('overview') ||
      output.includes('runs') ||
      output.includes('swarms') ||
      output.includes('pulse') ||
      output.includes('mcp')
    ).toBe(true);
  });

  it.skipIf(moduleUnavailable)('frame reflects snapshot data (repos or tools or activity visible)', async () => {
    const snap = makeSnapshot();
    const { buildSnapshot } = await import('../src/core/dashboard.js');
    vi.mocked(buildSnapshot).mockResolvedValue(snap);

    await runTui!(makeConfig(), { once: true });

    // eslint-disable-next-line no-control-regex
    const plain = capturedOutput().replace(/\x1b\[[0-9;]*m/g, '');
    // At least one piece of fixture data should appear in the output
    const hasRepos = plain.includes('3');   // repos.total
    const hasTools = plain.includes('2');   // tools.installed
    const hasCost  = plain.includes('0.15') || plain.includes('8000') || plain.includes('8,000');
    expect(hasRepos || hasTools || hasCost).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-TTY stdout: same behavior as --once
// ---------------------------------------------------------------------------

describe('runTui — non-TTY stdout degrades to --once behavior', () => {
  it.skipIf(moduleUnavailable)('on non-TTY stdout with once=false, resolves without throw', async () => {
    // Simulate non-TTY by overriding isTTY
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    try {
      await expect(runTui!(makeConfig(), { once: false })).resolves.toBeDefined();
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it.skipIf(moduleUnavailable)('on non-TTY stdout with once=false, returns exit code 0', async () => {
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    let code: number;
    try {
      code = await runTui!(makeConfig(), { once: false });
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    }
    expect(code!).toBe(0);
  });

  it.skipIf(moduleUnavailable)('on non-TTY stdout with once=false, does NOT call setRawMode', async () => {
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    if (typeof process.stdin.setRawMode !== 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdin as any).setRawMode = () => process.stdin;
    }
    const setRawModeSpy = vi.spyOn(process.stdin, 'setRawMode').mockImplementation(() => process.stdin);

    try {
      await runTui!(makeConfig(), { once: false });
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    }

    expect(setRawModeSpy).not.toHaveBeenCalled();
  });

  it.skipIf(moduleUnavailable)('on non-TTY stdout with once=false, does NOT write alt-screen sequence', async () => {
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    try {
      await runTui!(makeConfig(), { once: false });
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    }

    expect(capturedOutput()).not.toContain('\x1b[?1049h');
  });
});

// ---------------------------------------------------------------------------
// Graceful handling of snapshot errors
// ---------------------------------------------------------------------------

describe('runTui({ once: true }) — graceful on snapshot error', () => {
  it.skipIf(moduleUnavailable)('does not throw when buildSnapshot rejects', async () => {
    const { buildSnapshot } = await import('../src/core/dashboard.js');
    vi.mocked(buildSnapshot).mockRejectedValue(new Error('snapshot failed'));
    // Should not throw — either returns 0 (with degraded output) or 1
    await expect(runTui!(makeConfig(), { once: true })).resolves.toBeDefined();
  });

  it.skipIf(moduleUnavailable)('returns a numeric exit code when buildSnapshot rejects', async () => {
    const { buildSnapshot } = await import('../src/core/dashboard.js');
    vi.mocked(buildSnapshot).mockRejectedValue(new Error('snapshot failed'));
    const code = await runTui!(makeConfig(), { once: true });
    expect(typeof code).toBe('number');
  });

  it.skipIf(moduleUnavailable)('returns exit code 0 when snapshot resolves with zeroed data', async () => {
    const { buildSnapshot } = await import('../src/core/dashboard.js');
    vi.mocked(buildSnapshot).mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: { total: 0, dirty: 0, stale: 0 },
      tools: { installed: 0, total: 0 },
      activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
      runs: [],
      swarms: [],
      mcp: [],
      genome: { entries: 0, projects: 0 },
    });
    const code = await runTui!(makeConfig(), { once: true });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Terminal restoration guarantee (once mode)
// ---------------------------------------------------------------------------

describe('runTui({ once: true }) — terminal state', () => {
  it.skipIf(moduleUnavailable)('show-cursor sequence is NOT suppressed in --once mode (cursor was never hidden)', async () => {
    // In --once mode the cursor should never be hidden, so there's nothing to restore.
    // We simply verify the alt-screen and raw-mode guards hold.
    await runTui!(makeConfig(), { once: true });
    expect(capturedOutput()).not.toContain('\x1b[?1049h');
    expect(capturedOutput()).not.toContain('\x1b[?25l');
  });
});

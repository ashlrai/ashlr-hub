/**
 * M-LP3 provider-picker tests — hermetic, no real network/spawn/prompt I/O.
 *
 * The interactive picker can't be unit-tested for keypresses, but its most
 * important guarantee CAN: in a non-TTY environment (like CI / this test
 * runner) it MUST be detect-only — never prompt, never hang, never install.
 *
 * Covers:
 *   runProviderPicker (detect-only path):
 *     - Non-TTY → scans and reports, returns code 0, prompts nothing
 *     - yes:true → same detect-only behavior
 *     - No live runtimes → action 'none' with a re-run hint
 *     - A live runtime → action 'scanned', listed in result.live
 *     - --json emits a single valid ProviderSetupResult object
 *
 *   `ashlr models setup` / `install` dispatch:
 *     - Both route to the picker; non-TTY → detect-only JSON, exit 0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks: child_process (whichBin's execFileSync) + fetch
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.fn();
const mockExecFile = vi.fn();
const mockSpawn = vi.fn(() => ({ unref: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1 })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------

import { runProviderPicker } from '../src/cli/provider-picker.js';
import { cmdModels } from '../src/cli/models.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

/** Capture everything written to stdout during `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let buf = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk);
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Setup / teardown — the test runner is already non-TTY (stdin.isTTY undefined)
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockRejectedValue(new Error('connection refused'));
  mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// runProviderPicker — detect-only guarantees
// ---------------------------------------------------------------------------

describe('runProviderPicker — non-TTY is detect-only', () => {
  it('returns code 0 and changes nothing when nothing is live', async () => {
    let result!: Awaited<ReturnType<typeof runProviderPicker>>['result'];
    await captureStdout(async () => {
      const r = await runProviderPicker({ json: false, yes: false });
      result = r.result;
      expect(r.code).toBe(0);
    });
    expect(result.action).toBe('none');
    expect(result.changed).toBe(false);
    expect(result.live).toEqual([]);
    expect(result.detail).toContain('ashlr models setup');
  });

  it('does not install or start anything (no execFile / spawn, only PATH lookups)', async () => {
    await captureStdout(async () => {
      await runProviderPicker({ json: false, yes: true });
    });
    // Installs go through execFile; daemon starts through spawn/execFile.
    // Detect-only must touch neither — only execFileSync (which/where) is OK.
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    // And every PATH lookup must be the platform finder, not a runtime verb.
    for (const call of mockExecFileSync.mock.calls) {
      expect(['which', 'where']).toContain(call[0]);
    }
  });

  it('reports a live runtime as action "scanned"', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('11434')) {
        return Promise.resolve(okResponse({ models: [{ name: 'llama3.2:3b' }] }));
      }
      return Promise.reject(new Error('down'));
    });

    let result!: Awaited<ReturnType<typeof runProviderPicker>>['result'];
    await captureStdout(async () => {
      result = (await runProviderPicker({ json: false, yes: true })).result;
    });
    expect(result.action).toBe('scanned');
    expect(result.live.map((d) => d.id)).toContain('ollama');
  });

  it('--json emits exactly one valid ProviderSetupResult object', async () => {
    const out = await captureStdout(async () => {
      await runProviderPicker({ json: true, yes: true });
    });
    const trimmed = out.trim();
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    expect(parsed).toHaveProperty('action');
    expect(parsed).toHaveProperty('live');
    expect(parsed).toHaveProperty('changed');
    expect(parsed).toHaveProperty('detail');
    expect(Array.isArray(parsed['live'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `ashlr models setup` / `install` dispatch
// ---------------------------------------------------------------------------

describe('ashlr models setup dispatch', () => {
  it('`setup --json` routes to the picker, detect-only, exit 0', async () => {
    let code = -1;
    const out = await captureStdout(async () => {
      code = await cmdModels(['setup', '--json']);
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
    expect(parsed).toHaveProperty('action');
  });

  it('`install` is an alias for setup', async () => {
    let code = -1;
    await captureStdout(async () => {
      code = await cmdModels(['install', '--json']);
    });
    expect(code).toBe(0);
  });

  it('unknown subcommand still errors with exit 2', async () => {
    // stderr only; no stdout JSON expected.
    const code = await cmdModels(['frobnicate']);
    expect(code).toBe(2);
  });
});

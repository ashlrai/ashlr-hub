/**
 * M-LP1 cross-platform detection tests — hermetic, no real spawn/network I/O.
 *
 * Covers the cross-platform foundation for the Local Provider Picker:
 *
 *   whichBin(name):
 *     - Uses `where` on win32, `which` on darwin/linux
 *     - Returns true when the lookup exits 0, false when it throws
 *     - Never throws
 *
 *   ollamaInstalled():
 *     - Delegates to whichBin('ollama') — same lookup tool per platform
 *
 *   startOllama():
 *     - On win32/linux, does NOT call the macOS `open -a Ollama` path;
 *       spawns `ollama serve` directly
 *     - On darwin, prefers `open -a Ollama` over `ollama serve`
 *
 * Platform is overridden per test via withPlatform() so a single CI run on any
 * OS exercises all three code paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withPlatform } from './helpers/platform.js';

// ---------------------------------------------------------------------------
// Mock child_process — capture every which/where/serve invocation
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn();
const mockExecFileSync = vi.fn();
const mockSpawn = vi.fn();

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

import { whichBin, ollamaInstalled, startOllama } from '../src/core/run/model-manager.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: lookup fails (binary absent), providers unreachable.
  mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
  mockFetch.mockRejectedValue(new Error('connection refused'));
  mockExecFile.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, '');
    },
  );
  mockSpawn.mockReturnValue({ unref: vi.fn() });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// whichBin — platform-native lookup selection
// ---------------------------------------------------------------------------

describe('whichBin — platform selection', () => {
  it('uses `where` on win32', () => {
    mockExecFileSync.mockReturnValue('C:\\path\\ollama.exe\r\n');
    const found = withPlatform('win32', () => whichBin('ollama'));
    expect(found).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync.mock.calls[0]![0]).toBe('where');
    expect(mockExecFileSync.mock.calls[0]![1]).toEqual(['ollama']);
  });

  it('uses `which` on darwin', () => {
    mockExecFileSync.mockReturnValue('/usr/local/bin/ollama\n');
    const found = withPlatform('darwin', () => whichBin('ollama'));
    expect(found).toBe(true);
    expect(mockExecFileSync.mock.calls[0]![0]).toBe('which');
  });

  it('uses `which` on linux', () => {
    mockExecFileSync.mockReturnValue('/usr/bin/ollama\n');
    const found = withPlatform('linux', () => whichBin('ollama'));
    expect(found).toBe(true);
    expect(mockExecFileSync.mock.calls[0]![0]).toBe('which');
  });

  it('returns false when the lookup exits non-zero (binary absent)', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('exit 1'); });
    expect(withPlatform('win32', () => whichBin('ollama'))).toBe(false);
    expect(withPlatform('linux', () => whichBin('ollama'))).toBe(false);
  });

  it('never throws', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('lookup tool missing'); });
    expect(() => withPlatform('win32', () => whichBin('ollama'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ollamaInstalled — delegates to whichBin per platform
// ---------------------------------------------------------------------------

describe('ollamaInstalled — cross-platform', () => {
  it('queries `where ollama` on win32', () => {
    mockExecFileSync.mockReturnValue('C:\\path\\ollama.exe\r\n');
    const result = withPlatform('win32', () => ollamaInstalled());
    expect(result).toBe(true);
    expect(mockExecFileSync.mock.calls[0]![0]).toBe('where');
    expect(mockExecFileSync.mock.calls[0]![1]).toEqual(['ollama']);
  });

  it('queries `which ollama` on darwin/linux', () => {
    mockExecFileSync.mockReturnValue('/usr/local/bin/ollama\n');
    withPlatform('darwin', () => ollamaInstalled());
    expect(mockExecFileSync.mock.calls[0]![0]).toBe('which');
  });

  it('returns false on any platform when not on PATH', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    expect(withPlatform('win32', () => ollamaInstalled())).toBe(false);
    expect(withPlatform('darwin', () => ollamaInstalled())).toBe(false);
    expect(withPlatform('linux', () => ollamaInstalled())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startOllama — non-mac must not use the macOS `open` path
// ---------------------------------------------------------------------------

describe('startOllama — platform launch path', () => {
  it('on win32, spawns `ollama serve` and never calls `open`', async () => {
    // Installed, but server not yet up → first poll succeeds so we exit fast.
    mockExecFileSync.mockReturnValue('C:\\path\\ollama.exe\r\n');
    let up = false;
    mockFetch.mockImplementation(() => {
      const wasUp = up;
      up = true; // come up on the next poll
      return wasUp
        ? Promise.resolve({ ok: true } as Response)
        : Promise.reject(new Error('down'));
    });

    await withPlatform('win32', () => startOllama());

    // No execFile call should be the macOS `open` launcher.
    for (const call of mockExecFile.mock.calls) {
      expect(call[0]).not.toBe('open');
    }
    // `ollama serve` should have been spawned.
    expect(mockSpawn).toHaveBeenCalled();
    expect(mockSpawn.mock.calls[0]![0]).toBe('ollama');
    expect(mockSpawn.mock.calls[0]![1]).toEqual(['serve']);
  });

  it('on linux, spawns `ollama serve` and never calls `open`', async () => {
    mockExecFileSync.mockReturnValue('/usr/bin/ollama\n');
    let up = false;
    mockFetch.mockImplementation(() => {
      const wasUp = up;
      up = true;
      return wasUp
        ? Promise.resolve({ ok: true } as Response)
        : Promise.reject(new Error('down'));
    });

    await withPlatform('linux', () => startOllama());

    for (const call of mockExecFile.mock.calls) {
      expect(call[0]).not.toBe('open');
    }
    expect(mockSpawn).toHaveBeenCalledWith('ollama', ['serve'], expect.anything());
  });

  it('on darwin, prefers `open -a Ollama` over spawning serve', async () => {
    mockExecFileSync.mockReturnValue('/usr/local/bin/ollama\n');
    let up = false;
    mockFetch.mockImplementation(() => {
      const wasUp = up;
      up = true;
      return wasUp
        ? Promise.resolve({ ok: true } as Response)
        : Promise.reject(new Error('down'));
    });
    // `open -a Ollama` succeeds.
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, '');
      },
    );

    await withPlatform('darwin', () => startOllama());

    const openCall = mockExecFile.mock.calls.find((c) => c[0] === 'open');
    expect(openCall).toBeDefined();
    expect(openCall![1]).toEqual(['-a', 'Ollama']);
    // Since the app launch succeeded, serve must NOT have been spawned.
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('returns {ok:false} immediately when not installed (any platform)', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    const result = await withPlatform('win32', () => startOllama());
    expect(result.ok).toBe(false);
    expect(result.detail.length).toBeGreaterThan(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

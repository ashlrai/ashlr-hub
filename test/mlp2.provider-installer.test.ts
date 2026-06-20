/**
 * M-LP2 provider-installer tests — hermetic, no real network/spawn/install I/O.
 *
 * Covers the runtime registry + confirm-gated installer:
 *
 *   PROVIDER_INSTALLERS:
 *     - Exactly the three known runtimes, each with required fields
 *     - install commands are argv arrays (no shell-pipe strings)
 *
 *   detect():
 *     - 'running'   when the endpoint probe succeeds
 *     - 'installed' when probe fails but the binary is on PATH
 *     - 'absent'    when probe fails and the binary is missing
 *
 *   scanExistingProviders():
 *     - Returns only live (running) runtimes
 *
 *   installProvider():
 *     - confirm:false  → plan only, never spawns (the install-plan)
 *     - confirm:true   → execFile the per-platform argv, {ok} from exit
 *     - no command for platform → ok:false + docsUrl, never spawns
 *     - unknown id     → ok:false, never spawns
 *     - never throws on execFile error
 *
 * INVARIANT: detect/scan never spawn an install; install never runs without
 * confirm:true.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withPlatform } from './helpers/platform.js';

// ---------------------------------------------------------------------------
// Mocks: child_process (execFile + whichBin's execFileSync) and fetch
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1 })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------

import {
  PROVIDER_INSTALLERS,
  getInstaller,
  scanExistingProviders,
  installProvider,
} from '../src/core/run/provider-installer.js';

// ---------------------------------------------------------------------------
// Fetch helpers — shape responses per probe URL
// ---------------------------------------------------------------------------

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

/** Make only the given runtime ids respond "up" on their probe URL. */
function fetchUpFor(...ids: Array<'ollama' | 'lmstudio' | 'llamacpp'>) {
  return (url: string) => {
    const u = String(url);
    if (ids.includes('ollama') && u.includes('11434')) {
      return Promise.resolve(okResponse({ models: [{ name: 'llama3.2:3b' }] }));
    }
    if (ids.includes('lmstudio') && u.includes('1234')) {
      return Promise.resolve(okResponse({ data: [{ id: 'mistral-7b' }] }));
    }
    if (ids.includes('llamacpp') && u.includes('8080')) {
      return Promise.resolve(okResponse({ data: [{ id: 'qwen-gguf' }] }));
    }
    return Promise.reject(new Error('connection refused'));
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing reachable, nothing on PATH.
  mockFetch.mockRejectedValue(new Error('connection refused'));
  mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
  mockExecFile.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, '');
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('PROVIDER_INSTALLERS registry', () => {
  it('contains exactly ollama, lmstudio, llamacpp', () => {
    const ids = PROVIDER_INSTALLERS.map((p) => p.id).sort();
    expect(ids).toEqual(['llamacpp', 'lmstudio', 'ollama']);
  });

  it('each entry has the required fields', () => {
    for (const p of PROVIDER_INSTALLERS) {
      expect(typeof p.label).toBe('string');
      expect(p.label.length).toBeGreaterThan(0);
      expect(typeof p.detect).toBe('function');
      expect(typeof p.docsUrl).toBe('string');
      expect(p.docsUrl).toMatch(/^https:\/\//);
      expect(Array.isArray(p.recommendedModels)).toBe(true);
      expect(typeof p.installCmd).toBe('object');
    }
  });

  it('install commands are argv arrays, not shell-pipe strings', () => {
    for (const p of PROVIDER_INSTALLERS) {
      for (const [, argv] of Object.entries(p.installCmd)) {
        expect(Array.isArray(argv)).toBe(true);
        expect(argv!.length).toBeGreaterThan(0);
        // No element may smuggle a shell pipe/redirect/chain.
        for (const tok of argv!) {
          expect(tok).not.toMatch(/[|&;><]/);
        }
      }
    }
  });

  it('getInstaller resolves known ids and rejects unknown', () => {
    expect(getInstaller('ollama')?.id).toBe('ollama');
    expect(getInstaller('nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

describe('detect — runtime state', () => {
  it('reports running when the endpoint probe succeeds', async () => {
    mockFetch.mockImplementation(fetchUpFor('ollama'));
    const d = await getInstaller('ollama')!.detect();
    expect(d.state).toBe('running');
    expect(d.models.length).toBeGreaterThan(0);
  });

  it('reports installed when probe fails but the binary is on PATH', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    mockExecFileSync.mockReturnValue('/usr/local/bin/ollama\n'); // whichBin → found
    const d = await withPlatform('linux', () => getInstaller('ollama')!.detect());
    expect(d.state).toBe('installed');
    expect(d.models).toEqual([]);
  });

  it('reports absent when probe fails and the binary is missing', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    const d = await getInstaller('ollama')!.detect();
    expect(d.state).toBe('absent');
  });

  it('detect never spawns an install (no execFile calls)', async () => {
    mockFetch.mockImplementation(fetchUpFor('lmstudio'));
    await getInstaller('lmstudio')!.detect();
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scanExistingProviders()
// ---------------------------------------------------------------------------

describe('scanExistingProviders', () => {
  it('returns only the live runtimes', async () => {
    mockFetch.mockImplementation(fetchUpFor('ollama', 'llamacpp'));
    const live = await scanExistingProviders();
    const ids = live.map((d) => d.id).sort();
    expect(ids).toEqual(['llamacpp', 'ollama']);
    expect(live.every((d) => d.state === 'running')).toBe(true);
  });

  it('returns empty when nothing is up', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    const live = await scanExistingProviders();
    expect(live).toEqual([]);
  });

  it('never spawns an install', async () => {
    mockFetch.mockImplementation(fetchUpFor('ollama'));
    await scanExistingProviders();
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// installProvider — confirm gate
// ---------------------------------------------------------------------------

describe('installProvider — confirm gate', () => {
  it('confirm:false returns the plan and spawns nothing', async () => {
    const result = await installProvider('ollama', { confirm: false, platform: 'win32' });
    expect(result.ok).toBe(false);
    expect(result.command).toBe('winget install --id Ollama.Ollama -e');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('confirm:true runs the per-platform argv via execFile', async () => {
    const calls: { bin: string; args: string[] }[] = [];
    mockExecFile.mockImplementation(
      (bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        calls.push({ bin, args });
        cb(null, 'installed ok');
      },
    );

    const result = await installProvider('ollama', { confirm: true, platform: 'darwin' });
    expect(result.ok).toBe(true);
    expect(result.command).toBe('brew install ollama');
    expect(calls.length).toBe(1);
    expect(calls[0]!.bin).toBe('brew');
    expect(calls[0]!.args).toEqual(['install', 'ollama']);
  });

  it('returns ok:false + docsUrl when the platform has no install command', async () => {
    // Ollama has no linux argv (curl|sh path intentionally omitted).
    const result = await installProvider('ollama', { confirm: true, platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ollama.com');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns ok:false for an unknown provider, spawns nothing', async () => {
    const result = await installProvider('bogus', { confirm: true, platform: 'win32' });
    expect(result.ok).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('never throws when the install command fails', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(new Error('winget exited 1'), '');
      },
    );
    const result = await installProvider('lmstudio', { confirm: true, platform: 'win32' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('failed');
  });

  it('passes the model name / args as discrete argv (no shell injection surface)', async () => {
    const calls: { bin: string; args: string[] }[] = [];
    mockExecFile.mockImplementation(
      (bin: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        calls.push({ bin, args });
        cb(null, 'ok');
      },
    );
    await installProvider('llamacpp', { confirm: true, platform: 'darwin' });
    expect(calls[0]!.bin).toBe('brew');
    expect(calls[0]!.args).toEqual(['install', 'llama.cpp']);
  });
});

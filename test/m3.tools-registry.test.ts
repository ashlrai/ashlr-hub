/**
 * Tests for src/core/tools-registry.ts (M3)
 *
 * Hermetic: mocks node:child_process so no real binaries are invoked.
 *
 * Verifies:
 *   - installed tools yield { installed:true, version:<string>, path:<string> }
 *   - absent tools yield { installed:false, version:null, path:null }
 *   - installedCount matches the number of installed tools
 *   - getToolsRegistry() never throws regardless of spawn errors
 *   - all expected ecosystem tool ids are probed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import { win32 } from 'node:path';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test.
// tools-registry.ts uses spawnSync (or execFileSync) for PATH lookup and --version.
// We intercept ALL calls and route based on the command+args.
// ---------------------------------------------------------------------------

type MockResponse = SpawnSyncReturns<string>;

// Per-command response map: key is "<cmd> <args.join(' ')>", value is result.
let _mockResponses: Map<string, MockResponse> = new Map();
// Default fallback (ENOENT = not found).
let _defaultResponse: MockResponse;
let _execFileCalls: string[] = [];
let _execFileOptions: Array<{ key: string; options: unknown }> = [];
const origSystemRoot = process.env.SystemRoot;

// ---------------------------------------------------------------------------
// Mock node:fs — controls existsSync for app-path detection (ashlr-md etc.)
// ---------------------------------------------------------------------------

// Set of paths that existsSync should report as present.
let _existingPaths: Set<string> = new Set();

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: (p: unknown): boolean => _existingPaths.has(String(p)),
    // readFileSync is used by ashlrHubVersionFromPackageJson — keep original
    readFileSync: original.readFileSync,
  };
});

function makeResult(
  stdout: string,
  stderr = '',
  status: number | null = 0,
  error?: Error,
): MockResponse {
  return { pid: 1, output: [], stdout, stderr, status, signal: null, error };
}

function enoent(cmd: string): MockResponse {
  return makeResult(
    '',
    '',
    null,
    Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }),
  );
}

function versionResult(version: string): MockResponse {
  return makeResult(`${version}\n`);
}

function whichResult(binPath: string): MockResponse {
  return makeResult(`${binPath}\n`);
}

vi.mock('node:child_process', () => ({
  spawnSync: (cmd: string, args: string[] = [], _opts?: unknown): MockResponse => {
    const key = `${cmd} ${args.join(' ')}`.trim();
    if (_mockResponses.has(key)) return _mockResponses.get(key)!;
    // Also try matching by just command name for `which`-style lookups
    if (_mockResponses.has(cmd)) return _mockResponses.get(cmd)!;
    return _defaultResponse ?? enoent(cmd);
  },
  execFileSync: (cmd: string, args: string[] = [], options?: unknown): string => {
    const key = `${cmd} ${args.join(' ')}`.trim();
    _execFileCalls.push(key);
    _execFileOptions.push({ key, options });
    const resp = _mockResponses.get(key) ?? _mockResponses.get(cmd) ?? _defaultResponse;
    if (!resp) throw Object.assign(new Error(`${cmd}: not found`), { code: 'ENOENT' });
    if (resp.error) throw resp.error;
    if (resp.status !== 0) throw new Error(resp.stderr || `exit ${resp.status}`);
    return resp.stdout;
  },
}));

import { getToolsRegistry } from '../src/core/tools-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Register a tool as "installed" with a given version and path. */
function mockInstalled(toolCmd: string, version: string, binPath: string): void {
  // Register both platform locators so the same fixture is native-portable.
  _mockResponses.set(`which ${toolCmd}`, whichResult(binPath));
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const whereExe = win32.join(systemRoot, 'System32', 'where.exe');
  _mockResponses.set(`${whereExe} $PATH:${toolCmd}`, whichResult(binPath));
  // Execute the resolved path for version identity, not a second PATH lookup.
  _mockResponses.set(`${binPath} --version`, versionResult(version));
  // also handle bare cmd key for version lookup fallbacks
  _mockResponses.set(toolCmd, whichResult(binPath));
}

/** Register a tool as absent (ENOENT from either platform locator). */
function mockAbsent(toolCmd: string): void {
  _mockResponses.set(`which ${toolCmd}`, enoent(toolCmd));
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const whereExe = win32.join(systemRoot, 'System32', 'where.exe');
  _mockResponses.set(`${whereExe} $PATH:${toolCmd}`, enoent(toolCmd));
  _mockResponses.set(`${toolCmd} --version`, enoent(toolCmd));
  _mockResponses.set(toolCmd, enoent(toolCmd));
}

beforeEach(() => {
  _mockResponses = new Map();
  _defaultResponse = enoent('__default__');
  _execFileCalls = [];
  _execFileOptions = [];
  // Reset app-path presence — no apps present by default.
  _existingPaths = new Set();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (origSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = origSystemRoot;
});

describe('getToolsRegistry — platform PATH lookup', () => {
  it('uses where.exe on Windows and keeps the first non-empty result', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    process.env.SystemRoot = 'C:\\Windows';
    _mockResponses.set(
      'C:\\Windows\\System32\\where.exe $PATH:phantom',
      whichResult('\r\nC:\\Tools\\phantom.exe\r\nC:\\Other\\phantom.exe'),
    );
    _mockResponses.set('C:\\Tools\\phantom.exe --version', versionResult('0.6.0'));

    const phantom = getToolsRegistry().tools.find(tool => tool.id === 'phantom');

    expect(phantom).toMatchObject({
      installed: true,
      path: 'C:\\Tools\\phantom.exe',
      version: '0.6.0',
    });
    expect(_execFileCalls).toContain('C:\\Windows\\System32\\where.exe $PATH:phantom');
    expect(_execFileCalls).not.toContain('which phantom');
    expect(_execFileCalls).not.toContain('phantom --version');
    expect(_execFileOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'C:\\Windows\\System32\\where.exe $PATH:phantom',
        options: expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
      }),
      expect.objectContaining({
        key: 'C:\\Tools\\phantom.exe --version',
        options: expect.objectContaining({ timeout: 3_000, killSignal: 'SIGKILL' }),
      }),
    ]));
  });

  it('fails closed when where.exe cannot resolve a Windows binary', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    process.env.SystemRoot = 'C:\\Windows';
    mockAbsent('phantom');

    const phantom = getToolsRegistry().tools.find(tool => tool.id === 'phantom');

    expect(phantom).toMatchObject({ installed: false, path: null, version: null });
    expect(_execFileCalls).toContain('C:\\Windows\\System32\\where.exe $PATH:phantom');
  });

  it('does not invoke a shell to version a discovered Windows command shim', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    process.env.SystemRoot = 'C:\\Windows';
    _mockResponses.set(
      'C:\\Windows\\System32\\where.exe $PATH:phantom',
      whichResult('C:\\Tools\\phantom.cmd'),
    );

    const phantom = getToolsRegistry().tools.find(tool => tool.id === 'phantom');

    expect(phantom).toMatchObject({
      installed: true,
      path: 'C:\\Tools\\phantom.cmd',
      version: null,
    });
    expect(_execFileCalls).toContain('C:\\Tools\\phantom.cmd --version');
  });
});

// ---------------------------------------------------------------------------
// All tools absent
// ---------------------------------------------------------------------------

describe('getToolsRegistry — all tools absent', () => {
  beforeEach(() => {
    // Default response is ENOENT — all absent.
  });

  it('does not throw when nothing is installed', () => {
    expect(() => getToolsRegistry()).not.toThrow();
  });

  it('returns a ToolsRegistry with tools array', () => {
    const reg = getToolsRegistry();
    expect(Array.isArray(reg.tools)).toBe(true);
  });

  it('installedCount is 0 when nothing is installed', () => {
    const reg = getToolsRegistry();
    expect(reg.installedCount).toBe(0);
  });

  it('all tool entries have installed:false', () => {
    const reg = getToolsRegistry();
    for (const t of reg.tools) {
      expect(t.installed).toBe(false);
    }
  });

  it('all tool entries have version:null when absent', () => {
    const reg = getToolsRegistry();
    for (const t of reg.tools) {
      expect(t.version).toBeNull();
    }
  });

  it('all tool entries have path:null when absent', () => {
    const reg = getToolsRegistry();
    for (const t of reg.tools) {
      expect(t.path).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Expected tool ids are probed
// ---------------------------------------------------------------------------

describe('getToolsRegistry — all expected ecosystem tool ids present', () => {
  const EXPECTED_IDS = [
    'phantom',
    'ashlr-plugin',
    'stack',
    'pulse',
    'ashlrcode',
    'aw',
    'morphkit',
    'binshield',
    'ashlr-md',
    'ashlr-hub',
  ];

  it('registry contains all expected tool ids', () => {
    const reg = getToolsRegistry();
    const ids = reg.tools.map(t => t.id);
    for (const expected of EXPECTED_IDS) {
      expect(ids).toContain(expected);
    }
  });

  it('each tool entry has required fields: id, name, installed, version, path', () => {
    const reg = getToolsRegistry();
    for (const t of reg.tools) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.name).toBe('string');
      expect(typeof t.installed).toBe('boolean');
      // version is string | null
      expect(t.version === null || typeof t.version === 'string').toBe(true);
      // path is string | null
      expect(t.path === null || typeof t.path === 'string').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// phantom installed
// ---------------------------------------------------------------------------

describe('getToolsRegistry — phantom installed', () => {
  beforeEach(() => {
    mockInstalled('phantom', '0.6.0', '/usr/local/bin/phantom');
  });

  it('phantom tool is installed:true', () => {
    const reg = getToolsRegistry();
    const t = reg.tools.find(t => t.id === 'phantom');
    expect(t?.installed).toBe(true);
  });

  it('phantom tool has a version string', () => {
    const reg = getToolsRegistry();
    const t = reg.tools.find(t => t.id === 'phantom');
    expect(t?.version).not.toBeNull();
    expect(typeof t?.version).toBe('string');
  });

  it('phantom tool has a path', () => {
    const reg = getToolsRegistry();
    const t = reg.tools.find(t => t.id === 'phantom');
    expect(t?.path).not.toBeNull();
  });

  it('installedCount increments for phantom', () => {
    const reg = getToolsRegistry();
    expect(reg.installedCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// ashlrcode installed
// ---------------------------------------------------------------------------

describe('getToolsRegistry — ashlrcode installed', () => {
  beforeEach(() => {
    mockInstalled('ashlrcode', '2.1.0', '/Users/user/.local/bin/ashlrcode');
  });

  it('ashlrcode tool is installed:true', () => {
    const reg = getToolsRegistry();
    const t = reg.tools.find(t => t.id === 'ashlrcode');
    expect(t?.installed).toBe(true);
  });

  it('ashlrcode version is reported', () => {
    const reg = getToolsRegistry();
    const t = reg.tools.find(t => t.id === 'ashlrcode');
    expect(t?.version).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Multiple tools installed — installedCount correct
// ---------------------------------------------------------------------------

describe('getToolsRegistry — multiple tools installed', () => {
  beforeEach(() => {
    mockInstalled('phantom', '0.6.0', '/usr/local/bin/phantom');
    mockInstalled('ashlrcode', '2.0.0', '/home/user/.local/bin/ashlrcode');
    mockAbsent('stack');
    mockAbsent('pulse');
    mockAbsent('aw');
    mockAbsent('morphkit');
    mockAbsent('binshield');
  });

  it('installedCount equals number of installed tools', () => {
    const reg = getToolsRegistry();
    const actualInstalled = reg.tools.filter(t => t.installed).length;
    expect(reg.installedCount).toBe(actualInstalled);
  });

  it('installedCount is at least 2', () => {
    const reg = getToolsRegistry();
    expect(reg.installedCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// ashlr-hub always present (self)
// ---------------------------------------------------------------------------

describe('getToolsRegistry — ashlr-hub entry', () => {
  it('ashlr-hub entry exists in registry', () => {
    const reg = getToolsRegistry();
    const t = reg.tools.find(t => t.id === 'ashlr-hub');
    expect(t).toBeDefined();
  });

  it('ashlr-hub has a display name', () => {
    const reg = getToolsRegistry();
    const t = reg.tools.find(t => t.id === 'ashlr-hub');
    expect(t?.name.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// spawnSync throws unexpectedly — never propagates
// ---------------------------------------------------------------------------

describe('getToolsRegistry — unexpected spawnSync error does not propagate', () => {
  beforeEach(() => {
    _defaultResponse = makeResult('', '', null, new Error('unexpected internal error'));
  });

  it('does not throw when child_process throws', () => {
    expect(() => getToolsRegistry()).not.toThrow();
  });

  it('returns a registry (possibly with all installed:false)', () => {
    const reg = getToolsRegistry();
    expect(reg).toBeDefined();
    expect(Array.isArray(reg.tools)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToolInfo shape invariants
// ---------------------------------------------------------------------------

describe('getToolsRegistry — ToolInfo shape invariants', () => {
  it('installed:true entries always have non-null version (or null if binary gives no version)', () => {
    // If installed is true, path must be non-null.
    mockInstalled('phantom', '0.6.0', '/bin/phantom');
    const reg = getToolsRegistry();
    for (const t of reg.tools) {
      if (t.installed) {
        expect(t.path).not.toBeNull();
      }
    }
  });

  it('installed:false entries always have null path', () => {
    const reg = getToolsRegistry();
    for (const t of reg.tools) {
      if (!t.installed) {
        expect(t.path).toBeNull();
      }
    }
  });

  it('installedCount matches tools where installed:true', () => {
    mockInstalled('phantom', '1.0.0', '/bin/phantom');
    const reg = getToolsRegistry();
    const count = reg.tools.filter(t => t.installed).length;
    expect(reg.installedCount).toBe(count);
  });
});

// ---------------------------------------------------------------------------
// ashlr-md — Tauri desktop app detection (not a CLI binary)
// ---------------------------------------------------------------------------

describe('getToolsRegistry — ashlr-md app detection', () => {
  it('ashlr-md is installed:false when no app bundle exists', () => {
    // _existingPaths is empty (reset in beforeEach)
    const reg = getToolsRegistry();
    const t = reg.tools.find(t => t.id === 'ashlr-md');
    expect(t?.installed).toBe(false);
    expect(t?.path).toBeNull();
    expect(t?.version).toBeNull();
  });

  it('ashlr-md is installed:true when /Applications/Ashlr MD.app exists', () => {
    _existingPaths.add('/Applications/Ashlr MD.app');
    const reg = getToolsRegistry();
    const t = reg.tools.find(t => t.id === 'ashlr-md');
    expect(t?.installed).toBe(true);
    expect(t?.path).toBe('/Applications/Ashlr MD.app');
    // App tools have no CLI version to query
    expect(t?.version).toBeNull();
  });

  it('ashlr-md falls back to ~/Applications when system path absent', () => {
    const userAppPath = `${process.env['HOME'] ?? ''}/Applications/Ashlr MD.app`;
    _existingPaths.add(userAppPath);
    const reg = getToolsRegistry();
    const t = reg.tools.find(t => t.id === 'ashlr-md');
    expect(t?.installed).toBe(true);
    expect(t?.path).toBe(userAppPath);
  });

  it('ashlr-md installed:true increments installedCount', () => {
    _existingPaths.add('/Applications/Ashlr MD.app');
    const reg = getToolsRegistry();
    const count = reg.tools.filter(t => t.installed).length;
    expect(reg.installedCount).toBe(count);
    expect(reg.installedCount).toBeGreaterThanOrEqual(1);
  });
});

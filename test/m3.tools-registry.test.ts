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
import { join, win32 } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
let _mockFiles: Map<string, string | Error> = new Map();
let _mockRealPaths: Map<string, string> = new Map();
let _readPaths: string[] = [];
const scratch: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: (p: unknown): boolean => _existingPaths.has(String(p)),
    readFileSync: (path: unknown, ...args: unknown[]) => {
      _readPaths.push(String(path));
      if (_mockFiles.has(String(path))) {
        const value = _mockFiles.get(String(path))!;
        if (value instanceof Error) throw value;
        return value;
      }
      return Reflect.apply(original.readFileSync, original, [path, ...args]);
    },
    statSync: (path: unknown, ...args: unknown[]) => {
      if (_mockFiles.has(String(path))) {
        const value = _mockFiles.get(String(path))!;
        return { isFile: () => true, size: value instanceof Error ? 1 : Buffer.byteLength(value) };
      }
      return Reflect.apply(original.statSync, original, [path, ...args]);
    },
    realpathSync: Object.assign((path: unknown, ...args: unknown[]) => _mockRealPaths.get(String(path)) ??
      Reflect.apply(original.realpathSync, original, [path, ...args]), { native: original.realpathSync.native }),
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
  _mockFiles = new Map();
  _mockRealPaths = new Map();
  _readPaths = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
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

describe.each(['linux', 'darwin', 'win32'] as const)('Plugin identity on %s', (platform) => {
  const paths = platform === 'win32' ? win32 : { join };
  const prefix = platform === 'win32' ? 'C:\\Tools' : '/tools';
  const binPath = (name: string) => paths.join(prefix, name);
  const packageRoot = (name: string) => paths.join(prefix, 'node_modules', name);
  const plugin = () => getToolsRegistry().tools.find(tool => tool.id === 'ashlr-plugin');
  const declare = (path: string, name: string, command: string, version: unknown = '1.36.4') => {
    const root = packageRoot(name);
    const target = paths.join(root, 'scripts', command === 'ashlr-mcp' ? 'ashlr-mcp.ts' : 'cli.ts');
    _mockRealPaths.set(path, target);
    _mockRealPaths.set(target, target);
    _mockFiles.set(paths.join(root, 'package.json'), JSON.stringify({ name, version,
      bin: { [command]: command === 'ashlr-mcp' ? 'scripts/ashlr-mcp.ts' : 'scripts/cli.ts' } }));
    return paths.join(root, 'package.json');
  };
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    if (platform === 'win32') process.env.SystemRoot = 'C:\\Windows';
  });

  it('does not count a Hub-only installation as Plugin', () => {
    const hub = binPath('ashlr');
    mockInstalled('ashlr', '3.24.0', hub);
    declare(hub, '@ashlr/hub', 'ashlr', '3.24.0');
    const registry = getToolsRegistry();
    expect(registry.tools.find(tool => tool.id === 'ashlr-hub')).toMatchObject({ installed: true, version: '3.24.0' });
    expect(registry.tools.find(tool => tool.id === 'ashlr-plugin')).toMatchObject({ installed: false, path: null, version: null });
    expect(registry.installedCount).toBe(1);
  });

  it('prefers dedicated Plugin beside Hub and never starts its MCP version probe', () => {
    const hub = binPath('ashlr');
    const mcp = binPath('ashlr-mcp');
    mockInstalled('ashlr', '3.24.0', hub);
    mockInstalled('ashlr-mcp', 'wrong version output 9.9.9', mcp);
    declare(mcp, 'ashlr-plugin', 'ashlr-mcp');
    const registry = getToolsRegistry();
    expect(registry.tools.find(tool => tool.id === 'ashlr-plugin')).toMatchObject({ installed: true, version: '1.36.4', path: mcp });
    expect(registry.installedCount).toBe(2);
    expect(_execFileCalls.filter(call => call.endsWith('--version'))).toEqual([`${hub} --version`]);
  });

  it('reports a dedicated launcher with unknown metadata without executing it', () => {
    const mcp = binPath('ashlr-mcp');
    mockInstalled('ashlr-mcp', 'usage unknown 3.24.0', mcp);
    expect(plugin()).toMatchObject({ installed: true, path: mcp, version: null });
    expect(_execFileCalls).not.toContain(`${mcp} --version`);
  });

  it.each(['ashlr-plugin', 'ashlr'])('recognizes the owned %s alias from its actual declared target', (alias) => {
    const path = binPath(alias);
    mockInstalled(alias, 'unknown output', path);
    declare(path, 'ashlr-plugin', alias);
    expect(plugin()).toMatchObject({ installed: true, path, version: '1.36.4' });
    // Hub's separate self probe may invoke the shared legacy `ashlr` alias once.
    expect(_execFileCalls.filter(call => call === `${path} --version`)).toHaveLength(alias === 'ashlr' ? 1 : 0);
  });

  it('does not infer alias ownership from a bare semver or nearby unrelated package', () => {
    const alias = binPath('ashlr-plugin');
    mockInstalled('ashlr-plugin', '1.36.4', alias);
    declare(alias, 'unrelated-tool', 'ashlr-plugin');
    expect(plugin()).toMatchObject({ installed: false, path: null, version: null });
    expect(_execFileCalls).not.toContain(`${alias} --version`);
  });

  it('requires the package bin declaration to match the real alias target', () => {
    const alias = binPath('ashlr-plugin');
    mockInstalled('ashlr-plugin', '1.36.4', alias);
    const manifest = declare(alias, 'ashlr-plugin', 'ashlr-plugin');
    _mockFiles.set(manifest, JSON.stringify({ name: 'ashlr-plugin', version: '1.36.4', bin: { 'ashlr-plugin': 'unrelated.ts' } }));
    expect(plugin()).toMatchObject({ installed: false, path: null, version: null });
  });

  it.each(['not JSON', '[]', new Error('unreadable')])('holds an alias with invalid/unreadable package metadata %s', (value) => {
    const alias = binPath('ashlr-plugin');
    mockInstalled('ashlr-plugin', '1.36.4', alias);
    const manifest = declare(alias, 'ashlr-plugin', 'ashlr-plugin');
    _mockFiles.set(manifest, value);
    expect(plugin()).toMatchObject({ installed: false, path: null, version: null });
  });

  it('does not read an oversized package manifest for alias ownership', () => {
    const alias = binPath('ashlr-plugin');
    mockInstalled('ashlr-plugin', '1.36.4', alias);
    const manifest = declare(alias, 'ashlr-plugin', 'ashlr-plugin');
    _mockFiles.set(manifest, ' '.repeat(256 * 1024 + 1));
    expect(plugin()).toMatchObject({ installed: false, path: null, version: null });
    expect(_readPaths).not.toContain(manifest);
  });

  it('retains availability but does not invent a version for an owned alias', () => {
    const alias = binPath('ashlr-plugin');
    mockInstalled('ashlr-plugin', '3.24.0', alias);
    declare(alias, 'ashlr-plugin', 'ashlr-plugin', 'not a version');
    expect(plugin()).toMatchObject({ installed: true, path: alias, version: null });
  });

  it('refuses a dedicated name whose package proves it is Hub, then tries the owned alias', () => {
    const mcp = binPath('ashlr-mcp');
    const alias = binPath('ashlr-plugin');
    mockInstalled('ashlr-mcp', '3.24.0', mcp);
    declare(mcp, '@ashlr/hub', 'ashlr', '3.24.0');
    mockInstalled('ashlr-plugin', '1.36.4', alias);
    declare(alias, 'ashlr-plugin', 'ashlr-plugin');
    expect(plugin()).toMatchObject({ installed: true, path: alias, version: '1.36.4' });
  });
});

it('uses an actual local package/bin identity and observes a later wrong-owner replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-plugin-catalog-'));
  scratch.push(root);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts);
  const path = join(scripts, 'cli.ts');
  const manifest = join(root, 'package.json');
  writeFileSync(path, '// Metadata-only fixture; never executed.\n');
  const metadata = { name: 'ashlr-plugin', version: '1.36.4', bin: { 'ashlr-plugin': 'scripts/cli.ts' } };
  writeFileSync(manifest, JSON.stringify(metadata));
  mockInstalled('ashlr-plugin', 'wrong output', path);
  expect(getToolsRegistry().tools.find(tool => tool.id === 'ashlr-plugin'))
    .toMatchObject({ installed: true, version: '1.36.4', path });
  writeFileSync(manifest, JSON.stringify({ ...metadata, name: '@ashlr/hub', version: '3.24.0' }));
  expect(getToolsRegistry().tools.find(tool => tool.id === 'ashlr-plugin'))
    .toMatchObject({ installed: false, version: null, path: null });
  expect(_execFileCalls).not.toContain(`${path} --version`);
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

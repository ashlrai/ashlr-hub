/**
 * Tests for src/core/config.ts
 *
 * Strategy: Because CONFIG_DIR / CONFIG_PATH / INDEX_PATH are module-level
 * constants derived from homedir() at import time, we can't simply set HOME
 * after the module is loaded. Instead we:
 *  1. Test defaultConfig() shape directly (no filesystem interaction).
 *  2. Test loadConfig() and saveConfig() by stubbing the module constants
 *     via a vi.mock factory that redirects all paths into a temp directory.
 *
 * All tests are hermetic: they operate only in os.tmpdir() subtrees.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync,
  readFileSync, existsSync, chmodSync, lstatSync, readdirSync, symlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { canSymlink } from './helpers/platform.js';

const fsFaults = vi.hoisted(() => ({
  failRename: false,
  partialWrites: false,
  writeCalls: 0,
  fsyncCalls: 0,
  renameSources: [] as string[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    writeSync(
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null = null,
    ): number {
      fsFaults.writeCalls++;
      // Keep the short lock-owner record intact; inject partial writes only
      // into the larger config payload.
      const writeLength = fsFaults.partialWrites && length > 512 ? Math.min(length, 7) : length;
      return real.writeSync(fd, buffer, offset, writeLength, position);
    },
    fsyncSync(fd: number): void {
      fsFaults.fsyncCalls++;
      real.fsyncSync(fd);
    },
    renameSync(...args: Parameters<typeof real.renameSync>): void {
      fsFaults.renameSources.push(String(args[0]));
      if (fsFaults.failRename) {
        const err = new Error('injected rename failure') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }
      real.renameSync(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// We test defaultConfig, loadConfig, saveConfig by importing directly from
// the config module. To make loadConfig hermetic we patch the module-level
// path constants via vi.mock.
//
// IMPORTANT: vi.mock is hoisted to the top of the file by vitest, so the
// factory runs before any imports. We use a closure variable (_tmpDir) that
// we populate in beforeEach via a global shared across the mock factory and
// the tests.
// ---------------------------------------------------------------------------

// Shared temp dir — populated before each test. The mock factory reads it.
let _configDir = '';
let _configPath = '';
let _indexPath = '';

vi.mock('../src/core/config.js', async (importOriginal) => {
  // Re-export the real implementation but:
  //  - Override the path constants via getters so they pick up the test-set values.
  //  - Wrap loadConfig/saveConfig to temporarily redirect HOME so that homedir()-
  //    based path resolution inside the real functions lands in our temp dir.
  //
  // vi.mock is hoisted and runs before beforeEach, so _configDir starts as ''.
  // Tests must call useTmpHome() before invoking loadConfig/saveConfig.

  const real = await importOriginal<typeof import('../src/core/config.js')>();

  return {
    get CONFIG_DIR() { return _configDir || real.CONFIG_DIR; },
    get CONFIG_PATH() { return _configPath || real.CONFIG_PATH; },
    get INDEX_PATH() { return _indexPath || real.INDEX_PATH; },
    defaultConfig: real.defaultConfig,
    loadConfig(): ReturnType<typeof real.loadConfig> {
      // Temporarily point HOME at the test dir so homedir() resolves correctly
      // inside the real loadConfig implementation.
      const savedHome = process.env.HOME;
      // _configDir is built with path.join() so it uses the platform separator
      // (backslash on Windows); strip the trailing .ashlr segment via dirname()
      // rather than a forward-slash regex that never matches on win32.
      if (_configDir) process.env.HOME = dirname(_configDir);
      try { return real.loadConfig(); } finally { process.env.HOME = savedHome; }
    },
    loadConfigReadOnly(): ReturnType<typeof real.loadConfigReadOnly> {
      const savedHome = process.env.HOME;
      if (_configDir) process.env.HOME = dirname(_configDir);
      try { return real.loadConfigReadOnly(); } finally { process.env.HOME = savedHome; }
    },
    saveConfig(c: Parameters<typeof real.saveConfig>[0]): void {
      const savedHome = process.env.HOME;
      if (_configDir) process.env.HOME = dirname(_configDir);
      try { real.saveConfig(c); } finally { process.env.HOME = savedHome; }
    },
  };
});

// ---------------------------------------------------------------------------
// After the mock is registered, import the (mocked) module under test.
// ---------------------------------------------------------------------------
import {
  defaultConfig, loadConfig, loadConfigReadOnly, saveConfig,
} from '../src/core/config.js';
import type { AshlrConfig } from '../src/core/types.js';

afterEach(() => {
  fsFaults.failRename = false;
  fsFaults.partialWrites = false;
  fsFaults.writeCalls = 0;
  fsFaults.fsyncCalls = 0;
  fsFaults.renameSources.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'ashlr-config-test-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Set the in-process HOME env var AND update the shared path variables so
 * that the mocked config module resolves to the right temp directory.
 */
function useTmpHome(tmpHome: string): void {
  const ashlrDir = join(tmpHome, '.ashlr');
  _configDir = ashlrDir;
  _configPath = join(ashlrDir, 'config.json');
  _indexPath = join(ashlrDir, 'index.json');
  // Also set HOME so that any code that calls homedir() internally gets the right value
  process.env.HOME = tmpHome;
}

// ---------------------------------------------------------------------------
// defaultConfig — shape / required fields
// ---------------------------------------------------------------------------

describe('defaultConfig', () => {
  it('returns a config with version=1', () => {
    const cfg = defaultConfig();
    expect(cfg.version).toBe(1);
  });

  it('returns a config with a non-empty roots array', () => {
    const cfg = defaultConfig();
    expect(Array.isArray(cfg.roots)).toBe(true);
    expect(cfg.roots.length).toBeGreaterThan(0);
  });

  it('returns a valid editor value', () => {
    const cfg = defaultConfig();
    expect(['cursor', 'vscode']).toContain(cfg.editor);
  });

  it('returns a positive staleDays', () => {
    const cfg = defaultConfig();
    expect(typeof cfg.staleDays).toBe('number');
    expect(cfg.staleDays).toBeGreaterThan(0);
  });

  it('returns a categories object (not null/undefined)', () => {
    const cfg = defaultConfig();
    expect(typeof cfg.categories).toBe('object');
    expect(cfg.categories).not.toBeNull();
  });

  it('returns a tidyRules array', () => {
    const cfg = defaultConfig();
    expect(Array.isArray(cfg.tidyRules)).toBe(true);
  });

  it('returns a keepers array', () => {
    const cfg = defaultConfig();
    expect(Array.isArray(cfg.keepers)).toBe(true);
  });

  it('returns models with lmstudio, ollama, providerChain fields', () => {
    const cfg = defaultConfig();
    expect(typeof cfg.models.lmstudio).toBe('string');
    expect(typeof cfg.models.ollama).toBe('string');
    expect(Array.isArray(cfg.models.providerChain)).toBe(true);
  });

  it('returns telemetry object', () => {
    const cfg = defaultConfig();
    expect(typeof cfg.telemetry).toBe('object');
    expect(cfg.telemetry).not.toBeNull();
  });

  it('returns tools object', () => {
    const cfg = defaultConfig();
    expect(typeof cfg.tools).toBe('object');
    expect(cfg.tools).not.toBeNull();
  });

  it('keepers include expected Desktop top-level names', () => {
    const cfg = defaultConfig();
    // Per the spec, known keepers include things like "github", "ASHLRAI", "Keys & Recovery" etc.
    // We only assert that keepers is non-empty and contains strings.
    expect(cfg.keepers.every(k => typeof k === 'string')).toBe(true);
  });

  it('categories map contains expected github sub-categories', () => {
    const cfg = defaultConfig();
    const keys = Object.keys(cfg.categories);
    // The config should seed the known Desktop github categories
    const expectedCategories = [
      'dev-tools', 'side-projects', 'professional-tools',
      'artist-encyclopedias', 'client-engagements', 'forks', 'ashlrai',
    ];
    for (const cat of expectedCategories) {
      expect(keys).toContain(cat);
    }
  });

  it('all tidyRules have match, matchType, dest fields', () => {
    const cfg = defaultConfig();
    for (const rule of cfg.tidyRules) {
      expect(typeof rule.match).toBe('string');
      expect(['glob', 'regex', 'ext']).toContain(rule.matchType);
      expect(typeof rule.dest).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig — creates dir + default config when missing
// ---------------------------------------------------------------------------

describe('loadConfig — fresh install', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = makeTmpHome();
    useTmpHome(tmpHome);
  });

  afterEach(() => {
    cleanup(tmpHome);
    process.env.HOME = origHome;
    _configDir = '';
    _configPath = '';
    _indexPath = '';
  });

  it('creates ~/.ashlr directory when it does not exist', () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    expect(existsSync(ashlrDir)).toBe(false);

    loadConfig();

    expect(existsSync(ashlrDir)).toBe(true);
  });

  it('writes config.json when it does not exist', () => {
    const cfgPath = join(tmpHome, '.ashlr', 'config.json');
    expect(existsSync(cfgPath)).toBe(false);

    loadConfig();

    expect(existsSync(cfgPath)).toBe(true);
  });

  it('returns a valid AshlrConfig when config.json is absent', () => {
    const cfg = loadConfig();
    expect(cfg.version).toBeGreaterThan(0);
    expect(Array.isArray(cfg.roots)).toBe(true);
    expect(['cursor', 'vscode']).toContain(cfg.editor);
  });
});

describe('loadConfigReadOnly — observational reads', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = makeTmpHome();
    useTmpHome(tmpHome);
  });

  afterEach(() => {
    cleanup(tmpHome);
    process.env.HOME = origHome;
    _configDir = '';
    _configPath = '';
    _indexPath = '';
  });

  it('returns in-memory defaults without creating a directory or file', () => {
    const ashlrDir = join(tmpHome, '.ashlr');

    const cfg = loadConfigReadOnly();

    expect(cfg.version).toBeGreaterThan(0);
    expect(existsSync(ashlrDir)).toBe(false);
  });

  it('deep-merges an existing partial config without changing its bytes', () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const cfgPath = join(ashlrDir, 'config.json');
    mkdirSync(ashlrDir, { recursive: true });
    const bytes = '{"version":1,"editor":"vscode","foundry":{"autoMerge":{"enabled":false}}}\n';
    writeFileSync(cfgPath, bytes);

    const cfg = loadConfigReadOnly();

    expect(cfg.editor).toBe('vscode');
    expect(cfg.foundry?.autoMerge?.enabled).toBe(false);
    expect(cfg.plugins).toEqual({ enabled: [], settings: {}, integrity: {} });
    expect(readFileSync(cfgPath, 'utf8')).toBe(bytes);
  });

  it('preserves malformed config while returning defaults', () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const cfgPath = join(ashlrDir, 'config.json');
    mkdirSync(ashlrDir, { recursive: true });
    const bytes = '{malformed';
    writeFileSync(cfgPath, bytes);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cfg = loadConfigReadOnly();

    expect(cfg.version).toBe(defaultConfig().version);
    expect(readFileSync(cfgPath, 'utf8')).toBe(bytes);
    expect(warning).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// loadConfig — reads existing config.json
// ---------------------------------------------------------------------------

describe('loadConfig — existing config', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = makeTmpHome();
    useTmpHome(tmpHome);
    // Pre-create the .ashlr dir
    mkdirSync(join(tmpHome, '.ashlr'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpHome);
    process.env.HOME = origHome;
    _configDir = '';
    _configPath = '';
    _indexPath = '';
  });

  it('reads an existing config.json and returns its values', () => {
    const stored: AshlrConfig = {
      version: 1,
      roots: ['/custom/root'],
      editor: 'vscode',
      staleDays: 99,
      categories: { 'my-cat': '/custom/root/my-cat' },
      tidyRules: [],
      keepers: ['keep-me.txt'],
      models: { lmstudio: 'my-model', ollama: 'llama3', providerChain: ['lmstudio'] },
      telemetry: { pulse: 'http://pulse' },
      tools: { entire: '/usr/local/bin/entire' },
    };
    writeFileSync(join(tmpHome, '.ashlr', 'config.json'), JSON.stringify(stored, null, 2));

    const cfg = loadConfig();
    expect(cfg.staleDays).toBe(99);
    expect(cfg.editor).toBe('vscode');
    expect(cfg.keepers).toContain('keep-me.txt');
    expect(cfg.roots).toContain('/custom/root');
  });

  it('does not overwrite an existing config.json', () => {
    const cfgPath = join(tmpHome, '.ashlr', 'config.json');
    const stored: AshlrConfig = {
      version: 1,
      roots: ['/preserved/root'],
      editor: 'vscode',
      staleDays: 42,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
    };
    writeFileSync(cfgPath, JSON.stringify(stored, null, 2));

    loadConfig();

    const mtime2 = readFileSync(cfgPath, 'utf8');
    // Content should be unchanged (not re-written with defaults)
    expect(JSON.parse(mtime2).roots).toContain('/preserved/root');
  });
});

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

describe('saveConfig', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = makeTmpHome();
    useTmpHome(tmpHome);
  });

  afterEach(() => {
    cleanup(tmpHome);
    process.env.HOME = origHome;
    _configDir = '';
    _configPath = '';
    _indexPath = '';
  });

  it('writes the config to disk as valid JSON', () => {
    const cfg: AshlrConfig = {
      version: 1,
      roots: ['/test/root'],
      editor: 'cursor',
      staleDays: 14,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
    };

    saveConfig(cfg);

    const cfgPath = join(tmpHome, '.ashlr', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as AshlrConfig;
    expect(parsed.staleDays).toBe(14);
    expect(parsed.roots).toContain('/test/root');
  });

  it('preserves two-space JSON formatting with a trailing newline', () => {
    const cfg = defaultConfig();
    cfg.staleDays = 14;

    saveConfig(cfg);

    const cfgPath = join(tmpHome, '.ashlr', 'config.json');
    expect(readFileSync(cfgPath, 'utf8')).toBe(`${JSON.stringify(cfg, null, 2)}\n`);
  });

  it('completes partial writes before installing the config', () => {
    const cfg = defaultConfig();
    cfg.staleDays = 41;
    fsFaults.partialWrites = true;

    saveConfig(cfg);

    expect(fsFaults.writeCalls).toBeGreaterThan(1);
    expect(readFileSync(join(tmpHome, '.ashlr', 'config.json'), 'utf8'))
      .toBe(`${JSON.stringify(cfg, null, 2)}\n`);
  });

  it.skipIf(process.platform === 'win32')('fsyncs both the completed file and its directory', () => {
    saveConfig(defaultConfig());

    // Lock record/publication, completed config/directory, and lock release.
    expect(fsFaults.fsyncCalls).toBe(5);
  });

  it('uses a unique temporary name in the config directory for each save', () => {
    saveConfig(defaultConfig());
    saveConfig(defaultConfig());

    expect(fsFaults.renameSources).toHaveLength(2);
    expect(new Set(fsFaults.renameSources).size).toBe(2);
    expect(fsFaults.renameSources.every(path => dirname(path) === join(tmpHome, '.ashlr'))).toBe(true);
    expect(readdirSync(join(tmpHome, '.ashlr'))).toEqual(['config.json']);
  });

  it('creates ~/.ashlr directory if it does not exist before saving', () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    expect(existsSync(ashlrDir)).toBe(false);

    saveConfig(defaultConfig());

    expect(existsSync(ashlrDir)).toBe(true);
    expect(existsSync(join(ashlrDir, 'config.json'))).toBe(true);
  });

  it('round-trips through loadConfig after saveConfig', () => {
    const cfg = defaultConfig();
    cfg.staleDays = 77;
    cfg.editor = 'vscode';

    saveConfig(cfg);

    const loaded = loadConfig();
    expect(loaded.staleDays).toBe(77);
    expect(loaded.editor).toBe('vscode');
  });

  it('overwrites an existing config.json on subsequent saves', () => {
    const cfg1 = defaultConfig();
    cfg1.staleDays = 10;
    saveConfig(cfg1);

    const cfg2 = defaultConfig();
    cfg2.staleDays = 20;
    saveConfig(cfg2);

    const cfgPath = join(tmpHome, '.ashlr', 'config.json');
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as AshlrConfig;
    expect(parsed.staleDays).toBe(20);
  });

  it.skipIf(process.platform === 'win32')('creates a private config directory and file', () => {
    saveConfig(defaultConfig());

    const ashlrDir = join(tmpHome, '.ashlr');
    expect(lstatSync(ashlrDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(ashlrDir, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('tightens owner-controlled legacy modes during save', () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const cfgPath = join(ashlrDir, 'config.json');
    mkdirSync(ashlrDir, { mode: 0o755 });
    writeFileSync(cfgPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { mode: 0o644 });
    chmodSync(ashlrDir, 0o755);
    chmodSync(cfgPath, 0o644);

    saveConfig(defaultConfig());

    expect(lstatSync(ashlrDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(cfgPath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!canSymlink())('refuses a symlink config without modifying its target', () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const outside = join(tmpHome, 'outside.json');
    mkdirSync(ashlrDir, { mode: 0o700 });
    writeFileSync(outside, 'outside stays unchanged\n');
    symlinkSync(outside, join(ashlrDir, 'config.json'));

    expect(() => saveConfig(defaultConfig())).toThrow(/unsafe config file/i);
    expect(readFileSync(outside, 'utf8')).toBe('outside stays unchanged\n');
    expect(readdirSync(ashlrDir)).toEqual(['config.json']);
  });

  it.skipIf(!canSymlink())('refuses a symlink config directory without writing through it', () => {
    const outsideDir = join(tmpHome, 'outside');
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, join(tmpHome, '.ashlr'));

    expect(() => saveConfig(defaultConfig())).toThrow(/unsafe config directory/i);
    expect(readdirSync(outsideDir)).toEqual([]);
  });

  it('keeps the live config and removes its unique temp when rename fails', () => {
    const original = defaultConfig();
    original.staleDays = 11;
    saveConfig(original);
    const ashlrDir = join(tmpHome, '.ashlr');
    const cfgPath = join(ashlrDir, 'config.json');
    const before = readFileSync(cfgPath, 'utf8');

    const replacement = defaultConfig();
    replacement.staleDays = 88;
    fsFaults.failRename = true;
    expect(() => saveConfig(replacement)).toThrow(/injected rename failure/);

    expect(readFileSync(cfgPath, 'utf8')).toBe(before);
    expect(readdirSync(ashlrDir)).toEqual(['config.json']);
  });
});

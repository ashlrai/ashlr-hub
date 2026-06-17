/**
 * M58 — Reference plugin (examples/plugins/backlog-scanner) integration test.
 *
 * Hermetic: uses h1-fixture for HOME isolation; creates a tmp repo fixture
 * for scanner input. Does NOT use loadEnabledPlugins (avoids the full gate
 * chain — integrity pin, kill switch, etc.); instead imports the plugin
 * entry's activate() directly with a constructed PluginHost stub.
 *
 * Coverage:
 *  1. readManifest returns ok:true for the reference plugin.
 *  2. Manifest field invariants: name === basename, apiVersion compatible,
 *     capabilities includes 'scanner', entry contained in dir.
 *  3. activate() with a stub host returns exactly one scanner.
 *  4. The scanner's output passed through wrapScanner (REAL wrapper) produces
 *     correctly wrapped items: source==='plugin', namespaced ids, score
 *     recomputed, no raw secrets, ≤100 items.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename, resolve as resolvePath, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { readManifest } from '../src/core/plugins/manifest.js';
import { wrapScanner } from '../src/core/plugins/wrappers.js';
import { PLUGIN_API_VERSION } from '../src/core/plugins/types.js';
import type { PluginHost } from '../src/core/plugins/types.js';

// ---------------------------------------------------------------------------
// Path to the reference plugin
// ---------------------------------------------------------------------------

/** Absolute path to the reference plugin directory. */
const PLUGIN_DIR = resolvePath(
  new URL('.', import.meta.url).pathname,
  '../examples/plugins/backlog-scanner',
);

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// Minimal PluginHost stub (no real HOME writes needed for activate())
// ---------------------------------------------------------------------------

function makeStubHost(overrides?: Partial<PluginHost>): PluginHost {
  return {
    apiVersion: PLUGIN_API_VERSION,
    pluginName: 'backlog-scanner',
    log: (_msg: string) => { /* silent in tests */ },
    audit: (_action: string, _summary: string) => { /* silent in tests */ },
    settings: {},
    view: { editor: 'vscode', staleDays: 30 },
    dataDir: fx.ashlrDir,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: create a minimal tmp repo with FIXME comments for the scanner
// ---------------------------------------------------------------------------

function makeTmpRepo(files: Record<string, string>): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-m58-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return {
    dir,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. readManifest returns ok:true
// ---------------------------------------------------------------------------

describe('manifest validation', () => {
  it('readManifest returns ok:true for the reference plugin', () => {
    const result = readManifest(PLUGIN_DIR);
    expect(result.ok).toBe(true);
  });

  it('manifest.name equals directory basename', () => {
    const result = readManifest(PLUGIN_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.name).toBe(basename(resolvePath(PLUGIN_DIR)));
  });

  it('manifest.name matches ^[a-z][a-z0-9-]{0,39}$', () => {
    const result = readManifest(PLUGIN_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.name).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
  });

  it('manifest.apiVersion is compatible with PLUGIN_API_VERSION', () => {
    const result = readManifest(PLUGIN_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // readManifest already verifies semver compatibility internally;
    // this assertion double-checks the declared range is not wildly wrong.
    expect(result.manifest.apiVersion).toBeTruthy();
    // PLUGIN_API_VERSION must start with the major in the caret range
    const rangeBase = result.manifest.apiVersion.replace(/^[\^~]/, '');
    const [rangeMajor] = rangeBase.split('.');
    const [hostMajor] = PLUGIN_API_VERSION.split('.');
    expect(rangeMajor).toBe(hostMajor);
  });

  it('manifest.capabilities includes "scanner"', () => {
    const result = readManifest(PLUGIN_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.capabilities).toContain('scanner');
  });

  it('manifest.entry resolves inside the plugin directory', () => {
    const result = readManifest(PLUGIN_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resolvedDir = resolvePath(PLUGIN_DIR) + sep;
    const resolvedEntry = resolvePath(PLUGIN_DIR, result.manifest.entry);
    expect(resolvedEntry.startsWith(resolvedDir)).toBe(true);
  });

  it('manifest.entry is a relative path (not absolute)', () => {
    const result = readManifest(PLUGIN_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.entry.startsWith('/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. activate() with stub host contributes exactly one scanner
// ---------------------------------------------------------------------------

describe('plugin activate()', () => {
  it('returns exactly one scanner contribution', async () => {
    // Import the TS source directly — vitest transpiles it.
    // The manifest entry points to ./index.js (the compiled artefact), but
    // vitest resolves .ts in-process, so we import the source here.
    const mod = await import('../examples/plugins/backlog-scanner/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };

    expect(typeof plugin.activate).toBe('function');

    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));

    expect(contributions).toBeDefined();
    const c = contributions as { scanners?: unknown[] };
    expect(Array.isArray(c.scanners)).toBe(true);
    expect(c.scanners).toHaveLength(1);
  });

  it('the contributed scanner has a non-empty id', async () => {
    const mod = await import('../examples/plugins/backlog-scanner/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
    const c = contributions as { scanners?: Array<{ id: string }> };
    expect(c.scanners?.[0]?.id).toBeTruthy();
  });

  it('activate() never throws even with a minimal stub host', async () => {
    const mod = await import('../examples/plugins/backlog-scanner/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    await expect(Promise.resolve(plugin.activate(makeStubHost()))).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. wrapScanner produces correct wrapped output
// ---------------------------------------------------------------------------

describe('wrapScanner integration (REAL wrapper)', () => {
  it('produces items with source === "plugin"', async () => {
    const repo = makeTmpRepo({
      'src/auth.ts': '// FIXME(alice): add null check before release\nexport {};\n',
    });
    try {
      const mod = await import('../examples/plugins/backlog-scanner/index.js');
      const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
      const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
      const c = contributions as { scanners?: Array<{ id: string; scan: (r: string, ctx: { signal: AbortSignal }) => Promise<unknown[]> }> };
      const scanner = c.scanners![0]!;

      const wrapped = wrapScanner('backlog-scanner', scanner);
      const items = await wrapped(repo.dir);

      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.source).toBe('plugin');
      }
    } finally {
      repo.cleanup();
    }
  });

  it('produces namespaced ids prefixed with "plugin:backlog-scanner:"', async () => {
    const repo = makeTmpRepo({
      'src/auth.ts': '// FIXME(bob): replace with v2 API\nexport {};\n',
    });
    try {
      const mod = await import('../examples/plugins/backlog-scanner/index.js');
      const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
      const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
      const c = contributions as { scanners?: Array<{ id: string; scan: (r: string, ctx: { signal: AbortSignal }) => Promise<unknown[]> }> };
      const scanner = c.scanners![0]!;

      const wrapped = wrapScanner('backlog-scanner', scanner);
      const items = await wrapped(repo.dir);

      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.id).toMatch(/^plugin:backlog-scanner:/);
      }
    } finally {
      repo.cleanup();
    }
  });

  it('score is recomputed (value/effort), not the raw 0 from plugin', async () => {
    const repo = makeTmpRepo({
      'lib/core.ts': '// FIXME(carol): fix the edge case on line 99\nexport {};\n',
    });
    try {
      const mod = await import('../examples/plugins/backlog-scanner/index.js');
      const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
      const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
      const c = contributions as { scanners?: Array<{ id: string; scan: (r: string, ctx: { signal: AbortSignal }) => Promise<unknown[]> }> };
      const scanner = c.scanners![0]!;

      const wrapped = wrapScanner('backlog-scanner', scanner);
      const items = await wrapped(repo.dir);

      expect(items.length).toBeGreaterThan(0);
      // Plugin emits score:0; wrapper recomputes as value/effort = 3/2 = 1.5
      for (const item of items) {
        expect(item.score).not.toBe(0);
        expect(item.score).toBe(item.value / item.effort);
      }
    } finally {
      repo.cleanup();
    }
  });

  it('items have required tags: plugin, backlog-scanner, scanner-id', async () => {
    const repo = makeTmpRepo({
      'utils/helpers.ts': '// FIXME(dave): this is a temp hack\nexport {};\n',
    });
    try {
      const mod = await import('../examples/plugins/backlog-scanner/index.js');
      const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
      const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
      const c = contributions as { scanners?: Array<{ id: string; scan: (r: string, ctx: { signal: AbortSignal }) => Promise<unknown[]> }> };
      const scanner = c.scanners![0]!;

      const wrapped = wrapScanner('backlog-scanner', scanner);
      const items = await wrapped(repo.dir);

      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.tags).toContain('plugin');
        expect(item.tags).toContain('backlog-scanner');
        expect(item.tags).toContain(scanner.id);
      }
    } finally {
      repo.cleanup();
    }
  });

  it('returns at most 100 items even when the repo has more FIXME markers', async () => {
    // Seed 110 FIXME lines in one file
    const lines = Array.from(
      { length: 110 },
      (_, i) => `// FIXME(owner): item ${i}`,
    ).join('\n');
    const repo = makeTmpRepo({ 'src/big.ts': lines + '\nexport {};\n' });
    try {
      const mod = await import('../examples/plugins/backlog-scanner/index.js');
      const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
      const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
      const c = contributions as { scanners?: Array<{ id: string; scan: (r: string, ctx: { signal: AbortSignal }) => Promise<unknown[]> }> };
      const scanner = c.scanners![0]!;

      const wrapped = wrapScanner('backlog-scanner', scanner);
      const items = await wrapped(repo.dir);

      expect(items.length).toBeLessThanOrEqual(100);
    } finally {
      repo.cleanup();
    }
  });

  it('scrubs secrets from item titles', async () => {
    // A FIXME that contains a fake secret token in its message
    const repo = makeTmpRepo({
      'src/bad.ts':
        '// FIXME(eve): remove sk-abcdefghijklmnopqrstuvwx1234567890ABCDEF from config\nexport {};\n',
    });
    try {
      const mod = await import('../examples/plugins/backlog-scanner/index.js');
      const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
      const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
      const c = contributions as { scanners?: Array<{ id: string; scan: (r: string, ctx: { signal: AbortSignal }) => Promise<unknown[]> }> };
      const scanner = c.scanners![0]!;

      const wrapped = wrapScanner('backlog-scanner', scanner);
      const items = await wrapped(repo.dir);

      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.title).not.toContain('sk-abcdefghijklmnopqrstuvwx1234567890ABCDEF');
        expect(item.title).toContain('[REDACTED]');
      }
    } finally {
      repo.cleanup();
    }
  });

  it('returns [] and never throws when repo directory does not exist', async () => {
    const mod = await import('../examples/plugins/backlog-scanner/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
    const c = contributions as { scanners?: Array<{ id: string; scan: (r: string, ctx: { signal: AbortSignal }) => Promise<unknown[]> }> };
    const scanner = c.scanners![0]!;

    const wrapped = wrapScanner('backlog-scanner', scanner);
    await expect(wrapped('/does/not/exist/ashlr-m58')).resolves.toEqual([]);
  });

  it('finds FIXME markers across multiple files', async () => {
    const repo = makeTmpRepo({
      'src/a.ts': '// FIXME(alice): fix a\nexport {};\n',
      'src/b.ts': '// FIXME(bob): fix b\nexport {};\n',
      'lib/c.ts': '// FIXME(carol): fix c\nexport {};\n',
    });
    try {
      const mod = await import('../examples/plugins/backlog-scanner/index.js');
      const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
      const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
      const c = contributions as { scanners?: Array<{ id: string; scan: (r: string, ctx: { signal: AbortSignal }) => Promise<unknown[]> }> };
      const scanner = c.scanners![0]!;

      const wrapped = wrapScanner('backlog-scanner', scanner);
      const items = await wrapped(repo.dir);

      // Should find all 3 FIXME markers (one per file)
      expect(items.length).toBe(3);
    } finally {
      repo.cleanup();
    }
  });
});

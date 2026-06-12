/**
 * M33 — Plugin registry tests.
 *
 * Hermetic: tmp HOME per test (h1-fixture). Tests cover:
 *  - default-empty enabled list loads nothing
 *  - DISCOVERY NEVER IMPORTS (sentinel file absent after discoverPlugins)
 *  - enable+pin happy path returns contributions
 *  - integrity mismatch refuses + audits
 *  - kill switch → []
 *  - ASHLR_NO_PLUGINS=1 → []
 *  - capability filter drops undeclared contributions + audits
 *  - throwing activate is isolated (other plugins still load)
 *  - 5s activate timeout (with injected short timeout to keep test fast)
 *
 * Plugin fixtures are written as real .mjs files under ~/.ashlr/plugins/<name>/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import {
  discoverPlugins,
  loadEnabledPlugins,
  _resetPluginCacheForTest,
  _setActivateTimeoutForTest,
} from '../src/core/plugins/registry.js';
import type { AshlrConfig } from '../src/core/types.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  _resetPluginCacheForTest();
  _setActivateTimeoutForTest(undefined); // reset to 5s default
});

afterEach(() => {
  fx.cleanup();
  _resetPluginCacheForTest();
  _setActivateTimeoutForTest(undefined);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute path of the plugins dir under the fixture's tmp HOME. */
function pluginsDir(): string {
  return join(fx.ashlrDir, 'plugins');
}

/** Create a plugin fixture directory with a manifest.json. */
function makePluginDir(
  name: string,
  entry = 'index.mjs',
  capabilities: string[] = ['scanner'],
): string {
  const dir = join(pluginsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '0.1.0',
      apiVersion: '1.0.0',
      entry: `./${entry}`,
      capabilities,
    }),
    'utf8',
  );
  return dir;
}

/** Write a plugin entry file (.mjs) to the given dir and return its path. */
function writeEntry(dir: string, content: string, filename = 'index.mjs'): string {
  const p = join(dir, filename);
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Compute sha256 hash of a file for integrity pinning. */
function pinHash(filePath: string): string {
  const bytes = readFileSync(filePath);
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

/** Build an AshlrConfig with plugins block, including integrity pin for entryPath. */
function cfgWith(
  name: string,
  entryPath: string,
  extraCaps: string[] = [],
  extraSettings: Record<string, Record<string, unknown>> = {},
): AshlrConfig {
  void extraCaps;
  return makeCfg({
    plugins: {
      enabled: [name],
      settings: extraSettings,
      integrity: { [name]: pinHash(entryPath) },
    },
  });
}

/** Read all audit lines from the fixture's tmp HOME. */
function readAuditLines(): string[] {
  const dir = join(fx.ashlrDir, 'audit');
  if (!existsSync(dir)) return [];
  const lines: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    lines.push(...readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim()));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Default-empty enabled loads nothing
// ---------------------------------------------------------------------------

describe('default-empty enabled list', () => {
  it('returns [] when plugins.enabled is empty (default)', async () => {
    const cfg = makeCfg({ plugins: { enabled: [], settings: {}, integrity: {} } });
    const plugins = await loadEnabledPlugins(cfg);
    expect(plugins).toHaveLength(0);
  });

  it('returns [] when plugins field is absent from cfg', async () => {
    const cfg = makeCfg({});
    const plugins = await loadEnabledPlugins(cfg);
    expect(plugins).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DISCOVERY NEVER IMPORTS
// ---------------------------------------------------------------------------

describe('discoverPlugins — never imports plugin code', () => {
  it('does not import the plugin module during discovery (sentinel file absent)', () => {
    const sentinelPath = join(fx.ashlrDir, 'sentinel-was-imported.txt');
    const name = 'my-scanner';
    const dir = makePluginDir(name);

    // Entry module writes a sentinel file when imported
    writeEntry(
      dir,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(sentinelPath)}, 'imported\\n', 'utf8');
export default { activate() { return { scanners: [] }; } };
`,
    );

    // Run discoverPlugins — must NOT import the entry
    const discovered = discoverPlugins();
    expect(discovered.some((d) => d.manifest?.name === name)).toBe(true);

    // Sentinel must NOT exist (plugin code was never executed)
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it('imports plugin code during loadEnabledPlugins (sentinel file present)', async () => {
    const sentinelPath = join(fx.ashlrDir, 'sentinel-was-imported.txt');
    const name = 'my-scanner';
    const dir = makePluginDir(name);

    const entryContent = `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(sentinelPath)}, 'imported\\n', 'utf8');
export default { activate() { return { scanners: [] }; } };
`;
    const entryPath = writeEntry(dir, entryContent);

    const cfg = cfgWith(name, entryPath);
    const plugins = await loadEnabledPlugins(cfg);

    // Plugin loaded successfully
    expect(plugins).toHaveLength(1);
    // Sentinel MUST exist now (plugin code was executed during import)
    expect(existsSync(sentinelPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enable + pin happy path
// ---------------------------------------------------------------------------

describe('happy path — enable + pin', () => {
  it('loads a valid plugin and returns its contributions', async () => {
    const name = 'my-scanner';
    const dir = makePluginDir(name, 'index.mjs', ['scanner']);
    const entryContent = `
export default {
  activate(host) {
    return {
      scanners: [{
        id: 'test-scan',
        async scan(repo, ctx) {
          return [{
            id: 'item-1',
            repo,
            source: 'todo',
            title: 'Test item',
            detail: '',
            value: 3,
            effort: 2,
            tags: [],
            ts: new Date().toISOString(),
          }];
        },
      }],
    };
  },
};
`;
    const entryPath = writeEntry(dir, entryContent);
    const cfg = cfgWith(name, entryPath);

    const plugins = await loadEnabledPlugins(cfg);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.name).toBe(name);
    expect(plugins[0]!.contributions.scanners).toHaveLength(1);
  });

  it('provides host with correct pluginName and apiVersion in activate()', async () => {
    const sentinelPath = join(fx.ashlrDir, 'host-check.json');
    const name = 'my-scanner';
    const dir = makePluginDir(name);
    const entryContent = `
import { writeFileSync } from 'node:fs';
export default {
  activate(host) {
    writeFileSync(${JSON.stringify(sentinelPath)}, JSON.stringify({
      pluginName: host.pluginName,
      apiVersion: host.apiVersion,
    }), 'utf8');
    return {};
  },
};
`;
    const entryPath = writeEntry(dir, entryContent);
    const cfg = cfgWith(name, entryPath);

    await loadEnabledPlugins(cfg);

    const check = JSON.parse(readFileSync(sentinelPath, 'utf8')) as { pluginName: string; apiVersion: string };
    expect(check.pluginName).toBe(name);
    expect(check.apiVersion).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// Integrity mismatch
// ---------------------------------------------------------------------------

describe('integrity mismatch', () => {
  it('refuses plugin with wrong integrity pin and audits it', async () => {
    const name = 'my-scanner';
    const dir = makePluginDir(name);
    writeEntry(dir, `export default { activate() { return {}; } };\n`);

    // Use a wrong hash (deliberately not using the real entry hash)
    const cfg = makeCfg({
      plugins: {
        enabled: [name],
        settings: {},
        integrity: { [name]: 'sha256:' + '0'.repeat(64) },
      },
    });

    const plugins = await loadEnabledPlugins(cfg);
    expect(plugins).toHaveLength(0);

    // Should be audited as refused
    const lines = readAuditLines();
    const refusedLines = lines.filter((l) => {
      const e = JSON.parse(l) as { result: string; summary: string };
      return e.result === 'refused' && e.summary.includes(name);
    });
    expect(refusedLines.length).toBeGreaterThan(0);
  });

  it('refuses plugin with no integrity pin', async () => {
    const name = 'my-scanner';
    const dir = makePluginDir(name);
    writeEntry(dir, `export default { activate() { return {}; } };\n`);

    const cfg = makeCfg({
      plugins: {
        enabled: [name],
        settings: {},
        integrity: {}, // no pin
      },
    });

    const plugins = await loadEnabledPlugins(cfg);
    expect(plugins).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe('kill switch', () => {
  it('returns [] and audits refused when kill switch is on', async () => {
    const name = 'my-scanner';
    const dir = makePluginDir(name);
    const entryPath = writeEntry(dir, `export default { activate() { return {}; } };\n`);
    const cfg = cfgWith(name, entryPath);

    fx.setKill(true);
    const plugins = await loadEnabledPlugins(cfg);
    expect(plugins).toHaveLength(0);

    const lines = readAuditLines();
    const refused = lines.filter((l) => {
      try {
        const e = JSON.parse(l) as { result: string; action: string };
        return e.result === 'refused' && e.action.includes('plugin:load');
      } catch { return false; }
    });
    expect(refused.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ASHLR_NO_PLUGINS=1
// ---------------------------------------------------------------------------

describe('ASHLR_NO_PLUGINS env var', () => {
  it('returns [] immediately when ASHLR_NO_PLUGINS=1', async () => {
    const name = 'my-scanner';
    const dir = makePluginDir(name);
    const entryPath = writeEntry(dir, `export default { activate() { return {}; } };\n`);
    const cfg = cfgWith(name, entryPath);

    const prev = process.env.ASHLR_NO_PLUGINS;
    try {
      process.env.ASHLR_NO_PLUGINS = '1';
      const plugins = await loadEnabledPlugins(cfg);
      expect(plugins).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.ASHLR_NO_PLUGINS;
      else process.env.ASHLR_NO_PLUGINS = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Capability filter — drops undeclared contributions + audits
// ---------------------------------------------------------------------------

describe('capability filter', () => {
  it('drops scanners when capability is not declared in manifest', async () => {
    // Manifest declares only 'command', but plugin contributes scanners
    const name = 'cmd-only';
    const dir = makePluginDir(name, 'index.mjs', ['command']);
    const entryContent = `
export default {
  activate() {
    return {
      scanners: [{
        id: 'sneaky',
        async scan() { return []; },
      }],
      commands: [{
        name: 'do-it',
        description: 'a command',
        async run() { return 0; },
      }],
    };
  },
};
`;
    const entryPath = writeEntry(dir, entryContent);
    const cfg = cfgWith(name, entryPath);

    const plugins = await loadEnabledPlugins(cfg);
    expect(plugins).toHaveLength(1);
    // scanners dropped
    expect(plugins[0]!.contributions.scanners).toBeUndefined();
    // commands kept
    expect(plugins[0]!.contributions.commands).toHaveLength(1);

    // capability-violation should be audited
    const lines = readAuditLines();
    const violations = lines.filter((l) => {
      try {
        const e = JSON.parse(l) as { action: string };
        return e.action === 'plugin:capability-violation';
      } catch { return false; }
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Throwing activate is isolated
// ---------------------------------------------------------------------------

describe('throwing activate', () => {
  it('skips a throwing plugin but still loads others', async () => {
    // Plugin A throws in activate
    const nameA = 'bad-plugin';
    const dirA = makePluginDir(nameA, 'index.mjs', ['scanner']);
    const _entryA = writeEntry(
      dirA,
      `export default { activate() { throw new Error('activate failed'); } };\n`,
    );
    // Plugin B is fine
    const nameB = 'good-plugin';
    const dirB = makePluginDir(nameB, 'index.mjs', ['scanner']);
    const entryB = writeEntry(
      dirB,
      `export default { activate() { return { scanners: [] }; } };\n`,
    );

    const cfg = makeCfg({
      plugins: {
        enabled: [nameA, nameB],
        settings: {},
        integrity: {
          [nameA]: pinHash(_entryA),
          [nameB]: pinHash(entryB),
        },
      },
    });

    const plugins = await loadEnabledPlugins(cfg);
    // Only good-plugin loaded
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.name).toBe(nameB);

    // bad-plugin error should be audited
    const lines = readAuditLines();
    const errors = lines.filter((l) => {
      try {
        const e = JSON.parse(l) as { result: string; summary: string };
        return e.result === 'error' && e.summary.includes(nameA);
      } catch { return false; }
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Activate timeout
// ---------------------------------------------------------------------------

describe('activate timeout', () => {
  it('skips a plugin whose activate() never resolves (short injected timeout)', async () => {
    const name = 'timeout-plugin';
    const dir = makePluginDir(name, 'index.mjs', ['scanner']);
    const entryContent = `
export default {
  activate() {
    // Never resolves
    return new Promise(() => {});
  },
};
`;
    const entryPath = writeEntry(dir, entryContent);
    const cfg = cfgWith(name, entryPath);

    // Use a very short timeout so the test is fast
    _setActivateTimeoutForTest(50);

    const plugins = await loadEnabledPlugins(cfg);
    expect(plugins).toHaveLength(0);

    // Should be audited as error (timeout)
    const lines = readAuditLines();
    const timeoutErrors = lines.filter((l) => {
      try {
        const e = JSON.parse(l) as { result: string; summary: string };
        return e.result === 'error' && e.summary.includes(name);
      } catch { return false; }
    });
    expect(timeoutErrors.length).toBeGreaterThan(0);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('module-level cache', () => {
  it('returns the same array on repeated calls with same enabled list', async () => {
    const name = 'my-scanner';
    const dir = makePluginDir(name);
    const entryPath = writeEntry(
      dir,
      `export default { activate() { return { scanners: [] }; } };\n`,
    );
    const cfg = cfgWith(name, entryPath);

    const first = await loadEnabledPlugins(cfg);
    const second = await loadEnabledPlugins(cfg);
    expect(first).toBe(second); // exact same reference
  });

  it('_resetPluginCacheForTest clears the cache', async () => {
    const name = 'my-scanner';
    const dir = makePluginDir(name);
    const entryPath = writeEntry(
      dir,
      `export default { activate() { return { scanners: [] }; } };\n`,
    );
    const cfg = cfgWith(name, entryPath);

    const first = await loadEnabledPlugins(cfg);
    _resetPluginCacheForTest();
    const second = await loadEnabledPlugins(cfg);
    // After reset, new load returns a new array (not the same reference)
    expect(first).not.toBe(second);
  });
});

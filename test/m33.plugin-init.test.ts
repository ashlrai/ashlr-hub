/**
 * M33 — `ashlr plugins init` scaffolder: every capability skeleton it writes
 * must be a WORKING plugin (valid manifest, loadable entry, real
 * contribution). This is the living-documentation guarantee — users start
 * from skeletons that are proven to load, not lorem ipsum.
 *
 * Hermetic: tmp HOME per test (h1-fixture).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { cmdPlugins } from '../src/cli/plugins.js';
import {
  discoverPlugins,
  loadEnabledPlugins,
  _resetPluginCacheForTest,
} from '../src/core/plugins/registry.js';
import type { AshlrConfig } from '../src/core/types.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  _resetPluginCacheForTest();
});

afterEach(() => {
  fx.cleanup();
  _resetPluginCacheForTest();
});

/** Run `plugins init` quietly; return the scaffolded dir. */
async function init(name: string, capability: string): Promise<string> {
  const origLog = console.log;
  console.log = () => {};
  try {
    expect(await cmdPlugins(['init', name, '--capability', capability])).toBe(0);
  } finally {
    console.log = origLog;
  }
  return join(fx.ashlrDir, 'plugins', name);
}

/** Build a cfg that enables `name` with a correct integrity pin. */
function enabledCfg(name: string, dir: string): AshlrConfig {
  const entry = join(dir, 'index.mjs');
  const pin = 'sha256:' + createHash('sha256').update(readFileSync(entry)).digest('hex');
  return makeCfg({
    plugins: { enabled: [name], settings: {}, integrity: { [name]: pin } },
  });
}

describe('plugins init — every skeleton is a valid, loadable plugin', () => {
  for (const capability of ['scanner', 'template', 'provider', 'command'] as const) {
    it(`${capability}: scaffold → valid manifest → loads → contributes`, async () => {
      const name = `init-${capability}`;
      const dir = await init(name, capability);

      expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(dir, 'index.mjs'))).toBe(true);

      // Discovery sees a VALID manifest (name pattern, basename match,
      // contained entry, compatible apiVersion range).
      const found = discoverPlugins().find((p) => p.manifest?.name === name);
      expect(found?.ok, `manifest invalid: ${found?.reason}`).toBe(true);
      expect(found!.manifest!.capabilities).toEqual([capability]);

      // The skeleton actually LOADS and contributes its declared kind.
      const loaded = await loadEnabledPlugins(enabledCfg(name, dir));
      expect(loaded).toHaveLength(1);
      const contrib = loaded[0]!.contributions;
      const kindKey = (
        { scanner: 'scanners', template: 'templates', provider: 'providers', command: 'commands' } as const
      )[capability];
      expect(contrib[kindKey], `no ${kindKey} contributed`).toBeTruthy();
      expect((contrib[kindKey] as unknown[]).length).toBeGreaterThan(0);
    });
  }

  it('the scanner skeleton produces a wrapped, namespaced WorkItem', async () => {
    const name = 'init-scan-run';
    const dir = await init(name, 'scanner');
    const { getPluginScanners } = await import('../src/core/plugins/registry.js');
    const scanners = await getPluginScanners(enabledCfg(name, dir));
    expect(scanners).toHaveLength(1);
    const items = await scanners[0]!('/tmp/some-repo');
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('plugin');
    expect(items[0]!.id).toContain(`plugin:${name}:`);
  });

  it('refuses bad names and never overwrites an existing manifest', async () => {
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const origLog = console.log;
    console.log = () => {};
    try {
      expect(await cmdPlugins(['init', 'Bad_Name'])).toBe(2);
      expect(await cmdPlugins(['init', 'dupe'])).toBe(0);
      expect(await cmdPlugins(['init', 'dupe'])).toBe(1); // second init refused
    } finally {
      process.stderr.write = origErr;
      console.log = origLog;
    }
  });
});

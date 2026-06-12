/**
 * M33 — extension-point WIRING: plugin contributions actually flow through
 * the real surfaces — backlog (scanners), templates, providers (with the
 * local-first gates), and `ashlr x` command dispatch.
 *
 * Hermetic: tmp HOME per test (h1-fixture); plugin fixtures are real .mjs
 * files under ~/.ashlr/plugins/. Where the wired surface reads config from
 * disk (backlog's scanner merge), the test persists the config with
 * saveConfig; where it takes cfg as a param, makeCfg overrides are used.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { _resetPluginCacheForTest } from '../src/core/plugins/registry.js';
import { saveConfig } from '../src/core/config.js';
import type { AshlrConfig } from '../src/core/types.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  _resetPluginCacheForTest();
  delete process.env['M33_FAKE_KEY'];
});

afterEach(() => {
  fx.cleanup();
  _resetPluginCacheForTest();
  delete process.env['M33_FAKE_KEY'];
});

function makePlugin(name: string, capabilities: string[], entrySource: string): string {
  const dir = join(fx.ashlrDir, 'plugins', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name, version: '0.1.0', apiVersion: '1.0.0', entry: './index.mjs', capabilities }),
  );
  const entryPath = join(dir, 'index.mjs');
  writeFileSync(entryPath, entrySource);
  return entryPath;
}

function pinHash(entryPath: string): string {
  return 'sha256:' + createHash('sha256').update(readFileSync(entryPath)).digest('hex');
}

function cfgWith(name: string, entryPath: string): AshlrConfig {
  return makeCfg({
    plugins: { enabled: [name], settings: {}, integrity: { [name]: pinHash(entryPath) } },
    // Unreachable local endpoints so getProviderRegistry probes fail fast and
    // provider resolution falls through to the requested plugin provider.
    models: { lmstudio: 'http://127.0.0.1:9', ollama: 'http://127.0.0.1:9', providerChain: [] },
  } as Partial<AshlrConfig>);
}

// ---------------------------------------------------------------------------
// Scanners → backlog
// ---------------------------------------------------------------------------

describe('plugin scanners flow into buildBacklog', () => {
  it('a plugin scanner item appears in the built backlog, clamped + namespaced', async () => {
    const entry = makePlugin(
      'wire-scan',
      ['scanner'],
      `export default { activate() { return { scanners: [{
        id: 'finder',
        async scan(repo) { return [{
          id: 'raw', repo, source: 'plugin',
          title: 'plugin found work', detail: 'a detail',
          value: 99, effort: 0, score: 12345, tags: [], ts: new Date().toISOString(),
        }]; },
      }] }; } };\n`,
    );
    // backlog's scanner merge reads config from disk — persist it.
    saveConfig(cfgWith('wire-scan', entry));

    const repo = fx.makeRepo();
    repo.enroll();

    const { buildBacklog } = await import('../src/core/portfolio/backlog.js');
    const backlog = await buildBacklog({ repos: [repo.dir] });

    const pluginItems = backlog.items.filter((it) => it.source === 'plugin');
    expect(pluginItems.length).toBeGreaterThan(0);
    const item = pluginItems[0]!;
    expect(item.title).toBe('plugin found work');
    // Wrapper guarantees: clamped 1..5, score recomputed, namespaced id, tags forced.
    expect(item.value).toBeLessThanOrEqual(5);
    expect(item.effort).toBeGreaterThanOrEqual(1);
    expect(item.id).toContain('plugin:wire-scan:finder');
    expect(item.tags).toContain('plugin');
  }, 30_000);

  it('with no plugins enabled the backlog is plugin-free (zero behavior change)', async () => {
    saveConfig(makeCfg());
    const repo = fx.makeRepo();
    repo.enroll();
    const { buildBacklog } = await import('../src/core/portfolio/backlog.js');
    const backlog = await buildBacklog({ repos: [repo.dir] });
    expect(backlog.items.filter((it) => it.source === 'plugin')).toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describe('plugin templates merge into getTemplates', () => {
  it('a plugin template appears prefixed alongside the builtins', async () => {
    const entry = makePlugin(
      'wire-tpl',
      ['template'],
      `export default { activate() { return { templates: [{
        id: 'starter', title: 'Wire Starter', description: 'from plugin',
        files: () => [{ path: 'README.md', content: '# hi' }],
      }] }; } };\n`,
    );
    const { getTemplates } = await import('../src/core/lifecycle/templates.js');
    const all = await getTemplates(cfgWith('wire-tpl', entry));

    const builtinCount = (await getTemplates(makeCfg())).length;
    expect(all.length).toBe(builtinCount + 1);
    const tpl = all.find((t) => t.id === 'wire-tpl:starter');
    expect(tpl).toBeTruthy();
    expect(tpl!.files({ name: 'x', category: 'c' })[0]!.path).toBe('README.md');
  });

  it('builtins are unchanged with no plugins enabled', async () => {
    const { getTemplates, TEMPLATES } = await import('../src/core/lifecycle/templates.js');
    const all = await getTemplates(makeCfg());
    expect(all.map((t) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
  });
});

// ---------------------------------------------------------------------------
// Providers — local-first gates
// ---------------------------------------------------------------------------

const PROVIDER_ENTRY = `export default { activate() { return { providers: [{
  id: 'wirecloud', tier: 'cloud', envKeys: ['M33_FAKE_KEY'],
  async probe() { return { up: true }; },
  async createClient() { return { id: 'wirecloud', supportsTools: false,
    async chat() { return { text: 'ok', toolCalls: [], usage: { tokensIn: 1, tokensOut: 1 } }; } }; },
}] }; } };\n`;

describe('plugin providers sit behind the local-first gates', () => {
  it('cloud-tier plugin provider refuses without --allow-cloud', async () => {
    const entry = makePlugin('wire-prov', ['provider'], PROVIDER_ENTRY);
    const cfg = cfgWith('wire-prov', entry);
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    await expect(
      getActiveClient(cfg, { allowCloud: false, provider: 'wirecloud' }),
    ).rejects.toThrow(/allow-cloud|local-first/);
  }, 20_000);

  it('cloud-tier plugin provider refuses when the declared key env is unset', async () => {
    const entry = makePlugin('wire-prov', ['provider'], PROVIDER_ENTRY);
    const cfg = cfgWith('wire-prov', entry);
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    await expect(
      getActiveClient(cfg, { allowCloud: true, provider: 'wirecloud' }),
    ).rejects.toThrow(/M33_FAKE_KEY/);
  }, 20_000);

  it('cloud-tier plugin provider returns a validated client when fully gated-through', async () => {
    process.env['M33_FAKE_KEY'] = 'present';
    const entry = makePlugin('wire-prov', ['provider'], PROVIDER_ENTRY);
    const cfg = cfgWith('wire-prov', entry);
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    const client = await getActiveClient(cfg, { allowCloud: true, provider: 'wirecloud' });
    expect(client.id).toBe('wirecloud');
    expect(typeof client.chat).toBe('function');
  }, 20_000);

  it('a plugin returning a garbage client fails loudly', async () => {
    const entry = makePlugin(
      'wire-bad',
      ['provider'],
      `export default { activate() { return { providers: [{
        id: 'badprov', tier: 'local',
        async probe() { return {}; },
        async createClient() { return { nope: true }; },
      }] }; } };\n`,
    );
    const cfg = cfgWith('wire-bad', entry);
    const { getActiveClient } = await import('../src/core/run/provider-client.js');
    await expect(
      getActiveClient(cfg, { allowCloud: false, provider: 'badprov' }),
    ).rejects.toThrow(/invalid client/);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Command dispatch — ashlr x
// ---------------------------------------------------------------------------

describe('ashlr x dispatches plugin commands', () => {
  it('runs an enabled plugin command and propagates its exit code', async () => {
    const entry = makePlugin(
      'wire-cmd',
      ['command'],
      `export default { activate() { return { commands: [{
        name: 'greet', description: 'says hi',
        async run(args, host) { host.log('hi ' + (args[0] ?? 'there')); return 7; },
      }] }; } };\n`,
    );
    saveConfig(cfgWith('wire-cmd', entry));
    const { cmdX } = await import('../src/cli/plugins.js');
    expect(await cmdX(['greet', 'mason'])).toBe(7);
  }, 20_000);

  it('returns 1 for an unknown command (no enabled plugin provides it)', async () => {
    saveConfig(makeCfg());
    const { cmdX } = await import('../src/cli/plugins.js');
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await cmdX(['nothere'])).toBe(1);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

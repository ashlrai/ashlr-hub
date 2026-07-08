/**
 * Effective config visibility: read-only, curated, no secret values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildEffectiveConfigSnapshot, loadEffectiveConfigSnapshot } from '../src/core/effective-config.js';
import { startServer } from '../src/core/web/server.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';

let fx: H1Fixture;
let openHandles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  openHandles = [];
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  openHandles = [];
  fx.cleanup();
});

function makeOpts(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return { port: 0, open: false, allowDispatch: false, ...overrides };
}

function request(
  method: string,
  url: string,
  port: number,
): Promise<{ statusCode: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: { Host: `127.0.0.1:${port}` },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: data,
            contentType: String(res.headers['content-type'] ?? ''),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('effective config snapshot', () => {
  it('does not create a config file when reading effective defaults', () => {
    const configPath = join(fx.ashlrDir, 'config.json');
    expect(existsSync(configPath)).toBe(false);

    const snapshot = loadEffectiveConfigSnapshot();

    expect(snapshot.configFile.exists).toBe(false);
    expect(snapshot.foundry.allowedBackends.value).toEqual(['builtin']);
    expect(existsSync(configPath)).toBe(false);
  });

  it('surfaces daemon/foundry/backend defaults with warnings when config is implicit', () => {
    const cfg = makeCfg({ daemon: undefined, foundry: undefined });
    const snapshot = buildEffectiveConfigSnapshot(cfg, {
      configPath: join(fx.ashlrDir, 'config.json'),
      configExists: false,
      configParsed: false,
      now: new Date('2026-07-02T00:00:00.000Z'),
    });

    expect(snapshot.daemon.dailyBudgetUsd.value).toBe(1);
    expect(snapshot.daemon.dailyBudgetUsd.source).toBe('default');
    expect(snapshot.foundry.enabled.value).toBe(false);
    expect(snapshot.foundry.allowedBackends.value).toEqual(['builtin']);
    expect(snapshot.backends.map((b) => b.backend)).toEqual(['builtin']);
    expect(snapshot.warnings.join('\n')).toMatch(/cfg\.daemon is missing/);
    expect(snapshot.warnings.join('\n')).toMatch(/cfg\.foundry is missing/);
  });

  it('marks configured operator settings and never serializes secret values', () => {
    const cfg = makeCfg({
      daemon: {
        dailyBudgetUsd: 5,
        perTickItems: 7,
        parallel: 4,
        intervalMs: 60_000,
        concurrency: { total: 12 },
      },
      foundry: {
        allowedBackends: ['codex', 'nim'],
        models: { codex: 'gpt-5.5' },
        autonomyControlLoop: true,
        autoMerge: { enabled: true, trustBasis: 'verification' },
        fabric: { gateway: true, concurrentDispatch: true },
        nim: {
          apiKeyEnv: 'NVIDIA_NIM_API_KEY',
          model: 'moonshotai/kimi-k2.6',
          tier: 'frontier',
        },
      },
      comms: {
        telegram: { botToken: 'super-secret-token', chatId: '123' },
      },
    } as Partial<AshlrConfig>);
    const rawConfig = {
      daemon: {
        dailyBudgetUsd: 5,
        perTickItems: 7,
        parallel: 4,
        intervalMs: 60_000,
        concurrency: { total: 12 },
      },
      foundry: {
        allowedBackends: ['codex', 'nim'],
        models: { codex: 'gpt-5.5' },
        autonomyControlLoop: true,
        autoMerge: { enabled: true, trustBasis: 'verification' },
        fabric: { gateway: true, concurrentDispatch: true },
        nim: {
          apiKeyEnv: 'NVIDIA_NIM_API_KEY',
          model: 'moonshotai/kimi-k2.6',
          tier: 'frontier',
        },
      },
      comms: {
        telegram: { botToken: 'super-secret-token', chatId: '123' },
      },
    };

    const snapshot = buildEffectiveConfigSnapshot(cfg, {
      rawConfig,
      configPath: join(fx.ashlrDir, 'config.json'),
      configExists: true,
      configParsed: true,
    });
    const codex = snapshot.backends.find((b) => b.backend === 'codex');
    const nim = snapshot.backends.find((b) => b.backend === 'nim');
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.daemon.dailyBudgetUsd.source).toBe('configured');
    expect(snapshot.daemon.maxConcurrent.value).toBe(12);
    expect(snapshot.daemon.maxConcurrent.source).toBe('derived');
    expect(snapshot.foundry.allowedBackends.source).toBe('configured');
    expect(codex?.model).toMatchObject({ value: 'gpt-5.5', source: 'configured' });
    expect(nim?.tier).toBe('frontier');
    expect(nim?.apiKeyEnvName).toBe('NVIDIA_NIM_API_KEY');
    expect(serialized).not.toContain('super-secret-token');
  });

  it('surfaces evidence auto-merge trust without tier mergeAuthority warnings', () => {
    const cfg = makeCfg({
      foundry: {
        allowedBackends: ['local-coder'],
        mergeAuthority: [],
        autoMerge: { enabled: true, trustBasis: 'evidence' },
      },
    } as Partial<AshlrConfig>);

    const snapshot = buildEffectiveConfigSnapshot(cfg, {
      rawConfig: {
        foundry: {
          allowedBackends: ['local-coder'],
          mergeAuthority: [],
          autoMerge: { enabled: true, trustBasis: 'evidence' },
        },
      },
      configPath: join(fx.ashlrDir, 'config.json'),
      configExists: true,
      configParsed: true,
    });

    expect(snapshot.foundry.autoMerge.trustBasis.value).toBe('evidence');
    expect(snapshot.warnings.join('\n')).not.toMatch(/mergeAuthority is empty/);
  });

  it('GET /api/config/effective exposes the read-only snapshot', async () => {
    mkdirSync(fx.ashlrDir, { recursive: true });
    writeFileSync(
      join(fx.ashlrDir, 'config.json'),
      JSON.stringify({
        version: 1,
        roots: [],
        editor: 'vscode',
        staleDays: 30,
        categories: {},
        tidyRules: [],
        keepers: [],
        models: { providerChain: ['ollama'], lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434' },
        telemetry: {},
        tools: {},
        daemon: { dailyBudgetUsd: 2 },
        foundry: { allowedBackends: ['builtin', 'codex'] },
      }, null, 2) + '\n',
      'utf8',
    );
    const h = await startServer(makeCfg(), makeOpts());
    openHandles.push(h);

    const res = await request('GET', `${h.url}/api/config/effective`, h.port);
    expect(res.statusCode).toBe(200);
    expect(res.contentType).toContain('application/json');
    const body = JSON.parse(res.body) as ReturnType<typeof buildEffectiveConfigSnapshot>;
    expect(body.daemon.dailyBudgetUsd).toMatchObject({ value: 2, source: 'configured' });
    expect(body.foundry.allowedBackends.value).toEqual(['builtin', 'codex']);
    expect(body.backends.map((b) => b.backend)).toEqual(['builtin', 'codex']);
  });
});

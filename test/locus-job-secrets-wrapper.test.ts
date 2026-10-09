import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AshlrConfig } from '../src/core/types.js';

const canary = vi.hoisted(() => ({
  execFileSync: vi.fn(() => '/synthetic/installed/phantom'),
  spawnSync: vi.fn(() => { throw new Error('unexpected synchronous execution'); }),
  spawn: vi.fn(() => { throw new Error('unexpected child execution'); }),
  inspected: [] as string[],
}));
vi.mock('node:child_process', () => ({
  execFileSync: canary.execFileSync,
  spawnSync: canary.spawnSync,
  spawn: canary.spawn,
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
    canary.inspected.push(String(path));
    return actual.existsSync(path);
  } };
});

import { runInLocusJobEnv } from '../src/core/integrations/locus-job-env.js';
import { spawnEngine } from '../src/core/run/engines.js';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'locus-secrets-canary-'));
afterEach(() => {
  canary.execFileSync.mockClear();
  canary.spawnSync.mockClear();
  canary.spawn.mockClear();
  canary.inspected.length = 0;
});

describe('sealed jobs refuse unqualified generic Secrets wrapping', () => {
  it('refuses before any installed-binary probe, config inspection, or execution', async () => {
    const configured = join(fixtureRoot, 'configured');
    mkdirSync(configured);
    const configPath = join(configured, '.phantom.toml');
    writeFileSync(configPath, '[phantom]\nname = "synthetic-canary"\n');
    canary.execFileSync.mockClear();
    canary.spawnSync.mockClear();
    canary.spawn.mockClear();
    canary.inspected.length = 0;
    try {
      const cfg = { models: { providerChain: [] }, roots: [], phantom: { enabled: true } } as unknown as AshlrConfig;
      await runInLocusJobEnv({ HOME: join(fixtureRoot, 'worker'), LOCUS_ENFORCE: 'off',
        LOCUS_SESSION_ID: 'synthetic-session', LOCUS_EXECUTOR_CAPABILITY: 'a'.repeat(64) }, async () => {
        const result = await spawnEngine({ bin: '/synthetic/must-not-execute', args: [], cwd: configured }, cfg);
        expect(result).toMatchObject({ ok: false, terminationReason: 'error-exit' });
        expect(result.error).toContain('cannot use generic Secrets exec');
      });
      // The installed-probe canary would return success if queried. None is allowed.
      expect(canary.execFileSync).not.toHaveBeenCalled();
      expect(canary.spawnSync).not.toHaveBeenCalled();
      expect(canary.spawn).not.toHaveBeenCalled();
      expect(canary.inspected).not.toContain(configPath);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from 'vitest';
import { parseRunArgs } from '../src/cli/run.js';
import type { AshlrConfig } from '../src/core/types.js';

describe('run registered engine arguments', () => {
  it('preserves builtin default and the original explicit CLI choices', () => {
    expect(parseRunArgs(['Explain this module']).engine).toBeUndefined();
    for (const engine of ['builtin', 'ashlrcode', 'aw', 'claude', 'codex']) {
      expect(parseRunArgs(['Explain this module', '--engine', engine]).usageError).toBeUndefined();
    }
  });

  it('accepts Meta only after explicit provider enrollment', () => {
    expect(parseRunArgs(['Explain', '--engine', 'meta-muse']).usageError).toMatch(/allowedBackends/);
    const cfg = { foundry: { allowedBackends: ['meta-muse'] } } as AshlrConfig;
    const args = parseRunArgs(['Explain', '--engine', 'meta-muse', '--sandbox-engine', '--allow-cloud'], cfg);
    expect(args.engine).toBe('meta-muse');
    expect(args.sandboxEngine).toBe(true);
    expect(args.allowCloud).toBe(true);
    expect(args.usageError).toBeUndefined();
  });

  it('refuses a selected API model when sandboxing is disabled unless explicitly requested or estimating', () => {
    const cfg = { foundry: { allowedBackends: ['meta-muse'], sandboxExternal: false } } as AshlrConfig;
    expect(parseRunArgs(['Explain', '--engine', 'meta-muse'], cfg).usageError).toMatch(/requires --sandbox-engine/);
    expect(parseRunArgs(['Explain', '--engine', 'meta-muse', '--sandbox-engine'], cfg).usageError).toBeUndefined();
    expect(parseRunArgs(['Explain', '--engine', 'meta-muse', '--estimate'], cfg).usageError).toBeUndefined();
  });

  it('accepts explicitly configured valid custom engines and refuses unknown or malformed commands', () => {
    const cfg = { foundry: {
      allowedBackends: ['private-runtime', 'bad-runtime'],
      engines: {
        'private-runtime': { id: 'private-runtime', kind: 'api-model', tier: 'mid', api: { envKey: 'PRIVATE_RUNTIME_KEY', defaultBaseUrl: 'http://127.0.0.1:8000/v1', defaultModel: 'local' } },
        'bad-runtime': { kind: 'cli-agent', bin: 'sh' },
      },
    } } as unknown as AshlrConfig;
    expect(parseRunArgs(['Explain', '--engine', 'private-runtime'], cfg).usageError).toBeUndefined();
    expect(parseRunArgs(['Explain', '--engine', 'bad-runtime'], cfg).usageError).toMatch(/registered/);
    for (const name of ['sh', '/bin/sh', 'unknown', 'meta-muse;touch /tmp/x']) {
      expect(parseRunArgs(['Explain', '--engine', name], cfg).usageError).toMatch(/registered/);
    }
  });
});

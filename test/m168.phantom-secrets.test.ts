/** M168 compatibility: existing env callbacks and names-only vault inspection. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: (...args: unknown[]) => exec(...args) }));
import { phantomAvailable, withPhantomSecrets, listAvailableSecretKeys } from '../src/core/integrations/phantom.js';
let _execFileSyncImpl: (...args: unknown[]) => string | Buffer;
const FAKE_SECRET_VALUE = 'sk-testvalue-very-secret-abc123xyz';
const FAKE_GITHUB_TOKEN = 'ghp_faketoken123456789abcdefghij';
const cfgOn = () => ({ foundry: { usePhantom: true } }) as unknown as AshlrConfig;
const cfgOff = () => ({ foundry: { usePhantom: false } }) as unknown as AshlrConfig;
const cfgNoFoundry = () => ({}) as AshlrConfig;
function mockPhantomPresent(secretMap: Record<string, string> = { ANTHROPIC_API_KEY: FAKE_SECRET_VALUE }, listNames = Object.keys(secretMap)): void {
  _execFileSyncImpl = (...args: unknown[]) => {
    const [bin, argv] = args as [string, string[]];
    if ((bin === 'which' || bin === 'where') && argv[0] === 'phantom') return '';
    if (bin === 'phantom' && argv[0] === 'list' && argv[1] === '--json') return JSON.stringify(listNames);
    throw new Error('unsupported extraction must not run');
  };
}
function mockPhantomAbsent(): void { _execFileSyncImpl = () => { throw new Error('binary absent'); }; }
beforeEach(() => {
  exec.mockImplementation((...args: unknown[]) => _execFileSyncImpl(...args));
  mockPhantomAbsent();
});
afterEach(() => { vi.unstubAllEnvs(); exec.mockClear(); });

describe('existing callback environment compatibility', () => {
  it.each([cfgOff(), cfgNoFoundry(), cfgOn()])('executes without credential subprocesses', async cfg => {
    vi.stubEnv('ANTHROPIC_API_KEY', FAKE_SECRET_VALUE);
    await withPhantomSecrets({ cfg, keys: ['ANTHROPIC_API_KEY'] }, async env => {
      expect(env.ANTHROPIC_API_KEY).toBe(FAKE_SECRET_VALUE);
      expect(env).not.toBe(process.env);
      return 'ok';
    });
    expect(exec).not.toHaveBeenCalled();
    expect(process.env.ANTHROPIC_API_KEY).toBe(FAKE_SECRET_VALUE);
  });
  it('does not accept generated env/template or unwrap output as a key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    _execFileSyncImpl = () => 'ANTHROPIC_API_KEY=template-or-status';
    const result = await withPhantomSecrets({ cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'], cwd: '/unused' }, async env => {
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      return 'ran';
    });
    expect(result).toBe('ran');
    expect(exec).not.toHaveBeenCalled();
  });
  it('scrubs requested existing env values from strings, nested objects and arrays', async () => {
    vi.stubEnv('CUSTOM_TOKEN', 'plainvalue');
    const result = await withPhantomSecrets({ cfg: cfgOn(), keys: ['CUSTOM_TOKEN'] }, async env => ({
      message: `token=${env.CUSTOM_TOKEN}`, nested: [env.CUSTOM_TOKEN], count: 3,
    }));
    expect(JSON.stringify(result)).not.toContain('plainvalue');
    expect(result).toEqual({ message: 'token=[REDACTED]', nested: ['[REDACTED]'], count: 3 });
  });
  it('clears only the private callback copy after successful execution', async () => {
    vi.stubEnv('CUSTOM_TOKEN', 'plainvalue');
    let captured: NodeJS.ProcessEnv | undefined;
    await withPhantomSecrets({ cfg: cfgOn(), keys: ['CUSTOM_TOKEN'] }, async env => { captured = env; return 'ok'; });
    expect(captured?.CUSTOM_TOKEN).toBe('');
    expect(process.env.CUSTOM_TOKEN).toBe('plainvalue');
  });
  it('retains flag-off unsanitized return behavior', async () => {
    vi.stubEnv('CUSTOM_TOKEN', 'plainvalue');
    expect(await withPhantomSecrets({ cfg: cfgOff(), keys: ['CUSTOM_TOKEN'] }, async env => env.CUSTOM_TOKEN)).toBe('plainvalue');
  });
  it('propagates callback errors unchanged and clears its private env copy', async () => {
    vi.stubEnv('CUSTOM_TOKEN', 'plainvalue');
    let captured: NodeJS.ProcessEnv | undefined;
    const error = new Error('callback failed');
    await expect(withPhantomSecrets({ cfg: cfgOn(), keys: ['CUSTOM_TOKEN'] }, async env => { captured = env; throw error; })).rejects.toBe(error);
    expect(captured?.CUSTOM_TOKEN).toBe('');
    expect(process.env.CUSTOM_TOKEN).toBe('plainvalue');
  });
});
describe('phantomAvailable names-only discovery', () => {
  it('detects present or absent binary without reading credentials', () => {
    mockPhantomPresent(); expect(phantomAvailable()).toBe(true);
    mockPhantomAbsent(); expect(phantomAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listAvailableSecretKeys() — names only, never values
// ---------------------------------------------------------------------------

describe('listAvailableSecretKeys — names only', () => {
  const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'VERCEL_TOKEN'];

  beforeEach(() => {
    mockPhantomPresent(
      { ANTHROPIC_API_KEY: FAKE_SECRET_VALUE, GITHUB_TOKEN: FAKE_GITHUB_TOKEN, VERCEL_TOKEN: 'tok_fake' },
      SECRET_NAMES,
    );
  });

  it('returns the secret names', () => {
    const names = listAvailableSecretKeys(cfgOn());
    expect(names).toContain('ANTHROPIC_API_KEY');
    expect(names).toContain('GITHUB_TOKEN');
    expect(names).toContain('VERCEL_TOKEN');
  });

  it('never returns secret values in names list', () => {
    const names = listAvailableSecretKeys(cfgOn());
    const all = names.join('\n');
    expect(all).not.toContain(FAKE_SECRET_VALUE);
    expect(all).not.toContain(FAKE_GITHUB_TOKEN);
    expect(all).not.toContain('tok_fake');
  });

  it('names contain only identifier-shaped strings', () => {
    const names = listAvailableSecretKeys(cfgOn());
    for (const name of names) {
      expect(name).not.toContain('=');
      expect(name).not.toMatch(/\s/);
    }
  });

  it('full JSON of name list does not contain secret values', () => {
    const names = listAvailableSecretKeys(cfgOn());
    const json = JSON.stringify(names);
    expect(json).not.toContain(FAKE_SECRET_VALUE);
    expect(json).not.toContain(FAKE_GITHUB_TOKEN);
  });
});

describe('listAvailableSecretKeys — flag OFF', () => {
  const callLog: string[] = [];

  beforeEach(() => {
    callLog.length = 0;
    _execFileSyncImpl = (...args: unknown[]) => {
      callLog.push(String((args as unknown[])[0]));
      return '';
    };
  });

  it('returns [] when usePhantom is false', () => {
    expect(listAvailableSecretKeys(cfgOff())).toEqual([]);
  });

  it('makes no execFileSync calls when flag is off', () => {
    listAvailableSecretKeys(cfgOff());
    expect(callLog).toHaveLength(0);
  });

  it('returns [] when foundry is absent', () => {
    expect(listAvailableSecretKeys(cfgNoFoundry())).toEqual([]);
  });
});

describe('listAvailableSecretKeys — phantom absent', () => {
  beforeEach(() => {
    mockPhantomAbsent();
  });

  it('returns [] when phantom is not on PATH', () => {
    expect(listAvailableSecretKeys(cfgOn())).toEqual([]);
  });

  it('never throws when phantom is absent', () => {
    expect(() => listAvailableSecretKeys(cfgOn())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listAvailableSecretKeys — adversarial JSON (value fields present)
// ---------------------------------------------------------------------------

describe('listAvailableSecretKeys — adversarial: JSON includes value fields', () => {
  beforeEach(() => {
    // Simulate a phantom version that emits value fields in list --json output.
    _execFileSyncImpl = (...args: unknown[]) => {
      const argv = args as [string, string[]];
      const bin = argv[0];
      const argList = argv[1] ?? [];
      if (bin === 'which' || bin === 'where') return '';
      if (bin === 'phantom' && argList[0] === 'list' && argList[1] === '--json') {
        return JSON.stringify([
          { name: 'ANTHROPIC_API_KEY', value: FAKE_SECRET_VALUE },
          { name: 'GITHUB_TOKEN',      value: FAKE_GITHUB_TOKEN },
        ]) + '\n';
      }
      throw new Error('unexpected');
    };
  });

  it('returns only name identifiers, not values', () => {
    const names = listAvailableSecretKeys(cfgOn());
    expect(names).toContain('ANTHROPIC_API_KEY');
    expect(names).toContain('GITHUB_TOKEN');
  });

  it('the names list does not contain any value strings', () => {
    const names = listAvailableSecretKeys(cfgOn());
    const all = names.join('\n');
    expect(all).not.toContain(FAKE_SECRET_VALUE);
    expect(all).not.toContain(FAKE_GITHUB_TOKEN);
  });
});

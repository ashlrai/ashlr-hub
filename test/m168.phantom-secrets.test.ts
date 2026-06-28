/**
 * M168 — phantom-secret injection for fleet VERIFICATION/integration tasks.
 *
 * Tests: src/core/integrations/phantom.ts
 *
 * Security invariants verified here:
 *  1. phantomAvailable() detects presence via mock execFile.
 *  2. withPhantomSecrets injects keys into the child env AND the injected value
 *     is NOT present in the returned result or any captured log.
 *  3. Degrades gracefully (runs without secrets) when phantom is absent.
 *  4. Degrades gracefully when a key is missing (phantom env/unwrap returns
 *     nothing).
 *  5. listAvailableSecretKeys returns NAMES only, never values.
 *  6. Flag OFF (cfg.foundry?.usePhantom absent/false) → zero phantom calls.
 *  7. Never throws under any mocked failure path.
 *
 * All phantom CLI calls are mocked — NO real phantom binary is invoked.
 * Conventions mirror m2.phantom.test.ts and m157.judge-attestation.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test.
// vi.mock is hoisted by vitest — must appear before any imports of the module.
// ---------------------------------------------------------------------------

/**
 * Shared state for execFileSync mock.
 * Tests set this to control what execFileSync returns or throws.
 */
let _execFileSyncImpl: (...args: unknown[]) => string | Buffer;

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => _execFileSyncImpl(...args),
}));

// Import module under test AFTER the mock is registered.
import {
  phantomAvailable,
  withPhantomSecrets,
  listAvailableSecretKeys,
} from '../src/core/integrations/phantom.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A secret value that is plausibly secret-shaped (≥8 chars). */
const FAKE_SECRET_VALUE = 'sk-testvalue-very-secret-abc123xyz';
const FAKE_GITHUB_TOKEN = 'ghp_faketoken123456789abcdefghij';

/** Minimal cfg with usePhantom enabled. */
function cfgOn(): AshlrConfig {
  return { foundry: { usePhantom: true } } as unknown as AshlrConfig;
}

/** Minimal cfg with usePhantom OFF (default). */
function cfgOff(): AshlrConfig {
  return { foundry: { usePhantom: false } } as unknown as AshlrConfig;
}

/** Minimal cfg with no foundry block at all. */
function cfgNoFoundry(): AshlrConfig {
  return {} as AshlrConfig;
}

/**
 * Make execFileSync behave as:
 *  - `which phantom` → succeeds (phantom available)
 *  - `phantom env KEY` → returns "KEY=VALUE\n"
 *  - `phantom list --json` → returns JSON names array
 */
function mockPhantomPresent(
  secretMap: Record<string, string> = { ANTHROPIC_API_KEY: FAKE_SECRET_VALUE },
  listNames: string[] = Object.keys(secretMap),
): void {
  _execFileSyncImpl = (...args: unknown[]) => {
    const argv = args as [string, string[]];
    const bin = argv[0];
    const argList = argv[1] ?? [];

    // `which phantom` → success (return empty string, no throw)
    if (bin === 'which' && argList[0] === 'phantom') return '';
    if (bin === 'where' && argList[0] === 'phantom') return '';

    if (bin === 'phantom') {
      const sub = argList[0];

      // `phantom env KEY` → "KEY=VALUE\n"
      if (sub === 'env' && argList[1]) {
        const key = argList[1];
        if (key in secretMap) return `${key}=${secretMap[key]}\n`;
        throw Object.assign(new Error(`phantom env: key not found: ${key}`), { status: 1 });
      }

      // `phantom unwrap KEY` → fallback (not typically needed when env works)
      if (sub === 'unwrap' && argList[1]) {
        const key = argList[1];
        if (key in secretMap) return `${secretMap[key]}\n`;
        throw Object.assign(new Error(`phantom unwrap: key not found: ${key}`), { status: 1 });
      }

      // `phantom list --json` → JSON array of name strings
      if (sub === 'list' && argList[1] === '--json') {
        return JSON.stringify(listNames) + '\n';
      }
    }

    throw new Error(`Unexpected execFileSync call: ${bin} ${argList.join(' ')}`);
  };
}

/** Make execFileSync simulate phantom not on PATH. */
function mockPhantomAbsent(): void {
  _execFileSyncImpl = (..._args: unknown[]) => {
    throw Object.assign(new Error('spawn phantom ENOENT'), { code: 'ENOENT' });
  };
}

/** Make execFileSync throw for any invocation (unexpected internal error). */
function mockExecFileThrows(msg = 'unexpected error'): void {
  _execFileSyncImpl = () => { throw new Error(msg); };
}

// ---------------------------------------------------------------------------
// phantomAvailable()
// ---------------------------------------------------------------------------

describe('phantomAvailable — binary present', () => {
  beforeEach(() => {
    mockPhantomPresent();
  });

  it('returns true when `which phantom` succeeds', () => {
    expect(phantomAvailable()).toBe(true);
  });
});

describe('phantomAvailable — binary absent', () => {
  beforeEach(() => {
    mockPhantomAbsent();
  });

  it('returns false when `which phantom` throws ENOENT', () => {
    expect(phantomAvailable()).toBe(false);
  });
});

describe('phantomAvailable — execFile throws unexpectedly', () => {
  beforeEach(() => {
    mockExecFileThrows('unexpected OS error');
  });

  it('returns false without throwing', () => {
    expect(() => phantomAvailable()).not.toThrow();
    expect(phantomAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withPhantomSecrets — flag OFF (no phantom calls)
// ---------------------------------------------------------------------------

describe('withPhantomSecrets — flag OFF', () => {
  const callLog: string[] = [];

  beforeEach(() => {
    callLog.length = 0;
    // Track ANY execFileSync call to detect phantom invocations.
    _execFileSyncImpl = (...args: unknown[]) => {
      callLog.push(String((args as unknown[])[0]));
      return '';
    };
  });

  it('runs runFn without any phantom calls when usePhantom is false', async () => {
    let ran = false;
    await withPhantomSecrets({ cfg: cfgOff(), keys: ['ANTHROPIC_API_KEY'] }, async (_env) => {
      ran = true;
      return 'ok';
    });
    expect(ran).toBe(true);
    expect(callLog).toHaveLength(0);
  });

  it('runs runFn without any phantom calls when foundry is absent', async () => {
    let ran = false;
    await withPhantomSecrets({ cfg: cfgNoFoundry(), keys: ['ANTHROPIC_API_KEY'] }, async (_env) => {
      ran = true;
      return 'ok';
    });
    expect(ran).toBe(true);
    expect(callLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// withPhantomSecrets — secret injection + never-leak invariant
// ---------------------------------------------------------------------------

describe('withPhantomSecrets — secret injected into child env', () => {
  beforeEach(() => {
    mockPhantomPresent({ ANTHROPIC_API_KEY: FAKE_SECRET_VALUE });
  });

  it('injects the requested key into the child env', async () => {
    let receivedValue: string | undefined;
    await withPhantomSecrets({ cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'] }, async (env) => {
      receivedValue = env['ANTHROPIC_API_KEY'];
      return 'done';
    });
    // The env inside runFn MUST have received the secret value.
    expect(receivedValue).toBe(FAKE_SECRET_VALUE);
  });

  it('NEVER returns the secret value in the result string', async () => {
    const result = await withPhantomSecrets(
      { cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'] },
      async (env) => {
        // Simulate a poorly-written runFn that accidentally echoes the secret.
        return `verification output: key=${env['ANTHROPIC_API_KEY']} done`;
      },
    );
    // The returned string MUST NOT contain the secret value.
    expect(result).not.toContain(FAKE_SECRET_VALUE);
    expect(result).toContain('[REDACTED]');
  });

  it('NEVER leaks secret value in nested object result', async () => {
    const result = await withPhantomSecrets(
      { cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'] },
      async (env) => ({
        output: `env had key=${env['ANTHROPIC_API_KEY']}`,
        status: 'ok',
        meta: { raw: env['ANTHROPIC_API_KEY'] },
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FAKE_SECRET_VALUE);
  });

  it('NEVER leaks secret value in array result', async () => {
    const result = await withPhantomSecrets(
      { cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'] },
      async (env) => [env['ANTHROPIC_API_KEY'] ?? '', 'other'],
    );
    for (const item of result) {
      expect(item).not.toContain(FAKE_SECRET_VALUE);
    }
  });

  it('injects multiple keys independently', async () => {
    mockPhantomPresent({
      ANTHROPIC_API_KEY: FAKE_SECRET_VALUE,
      GITHUB_TOKEN: FAKE_GITHUB_TOKEN,
    });

    const received: Record<string, string | undefined> = {};
    await withPhantomSecrets(
      { cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'] },
      async (env) => {
        received['ANTHROPIC_API_KEY'] = env['ANTHROPIC_API_KEY'];
        received['GITHUB_TOKEN'] = env['GITHUB_TOKEN'];
        return 'ok';
      },
    );
    expect(received['ANTHROPIC_API_KEY']).toBe(FAKE_SECRET_VALUE);
    expect(received['GITHUB_TOKEN']).toBe(FAKE_GITHUB_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// withPhantomSecrets — degrade path (phantom absent)
// ---------------------------------------------------------------------------

describe('withPhantomSecrets — degrades when phantom absent', () => {
  beforeEach(() => {
    mockPhantomAbsent();
  });

  it('still calls runFn when phantom is absent', async () => {
    let ran = false;
    const result = await withPhantomSecrets(
      { cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'] },
      async (_env) => {
        ran = true;
        return 'ran-ok';
      },
    );
    expect(ran).toBe(true);
    expect(result).toBe('ran-ok');
  });

  it('never throws when phantom is absent', async () => {
    await expect(
      withPhantomSecrets({ cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'] }, async () => 'ok'),
    ).resolves.not.toThrow();
  });

  it('env does not contain phantom-injected keys when absent', async () => {
    let hadKey = false;
    await withPhantomSecrets(
      { cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'] },
      async (env) => {
        // When phantom is absent, ANTHROPIC_API_KEY should be whatever was in
        // process.env — typically undefined in test isolation.
        hadKey = env['ANTHROPIC_API_KEY'] === FAKE_SECRET_VALUE;
        return 'ok';
      },
    );
    expect(hadKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withPhantomSecrets — degrade path (key missing in vault)
// ---------------------------------------------------------------------------

describe('withPhantomSecrets — degrades when key missing in vault', () => {
  beforeEach(() => {
    // phantom is present, but the vault has no ANTHROPIC_API_KEY.
    mockPhantomPresent({ GITHUB_TOKEN: FAKE_GITHUB_TOKEN });
  });

  it('still calls runFn when a requested key is missing', async () => {
    let ran = false;
    await withPhantomSecrets(
      { cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'] },
      async (_env) => {
        ran = true;
        return 'ok';
      },
    );
    expect(ran).toBe(true);
  });

  it('never throws when a key is missing', async () => {
    await expect(
      withPhantomSecrets(
        { cfg: cfgOn(), keys: ['MISSING_KEY_XYZ'] },
        async () => 'ok',
      ),
    ).resolves.not.toThrow();
  });

  it('still injects keys that ARE present', async () => {
    let githubToken: string | undefined;
    await withPhantomSecrets(
      { cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'] },
      async (env) => {
        githubToken = env['GITHUB_TOKEN'];
        return 'ok';
      },
    );
    expect(githubToken).toBe(FAKE_GITHUB_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// withPhantomSecrets — never throws under any failure
// ---------------------------------------------------------------------------

describe('withPhantomSecrets — never throws on unexpected errors', () => {
  beforeEach(() => {
    mockExecFileThrows('totally unexpected OS error');
  });

  it('never throws when execFileSync throws unexpectedly', async () => {
    await expect(
      withPhantomSecrets({ cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'] }, async () => 'ok'),
    ).resolves.not.toThrow();
  });
});

describe('withPhantomSecrets — never throws when runFn throws', () => {
  beforeEach(() => {
    mockPhantomPresent({ ANTHROPIC_API_KEY: FAKE_SECRET_VALUE });
  });

  it('propagates runFn errors (does not swallow them)', async () => {
    await expect(
      withPhantomSecrets({ cfg: cfgOn(), keys: ['ANTHROPIC_API_KEY'] }, async () => {
        throw new Error('runFn exploded');
      }),
    ).rejects.toThrow('runFn exploded');
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

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
});

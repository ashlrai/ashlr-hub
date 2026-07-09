/**
 * Tests for src/core/phantom.ts (M2)
 *
 * Mocks child_process.spawnSync so no real `phantom` binary is invoked.
 * Key invariant: NO secret values ever appear in any returned data structure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test.
// vi.mock is hoisted to the top of the file by vitest.
// ---------------------------------------------------------------------------

// Shared state the mock factory reads — tests control it via helpers below.
// The real spawnSync with encoding:'utf8' returns SpawnSyncReturns<string>.
let _spawnSyncImpl: (...args: unknown[]) => SpawnSyncReturns<string>;

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => _spawnSyncImpl(...args),
}));

// Import module under test AFTER mock is registered.
import {
  phantomInstalled,
  getPhantomStatus,
  getCachedFleetPhantomStatus,
  resetPhantomStatusCache,
} from '../src/core/phantom.js';

beforeEach(() => {
  resetPhantomStatusCache();
});

// ---------------------------------------------------------------------------
// spawnSync response builders
// ---------------------------------------------------------------------------

// phantom.ts calls spawnSync with encoding:'utf8' so stdout/stderr arrive as
// strings (not Buffers). Our mock must return SpawnSyncReturns<string> so
// that .trim() / string operations in phantom.ts work without error.

function makeSpawnResult(
  stdout: string,
  stderr = '',
  status: number | null = 0,
  error?: Error,
): SpawnSyncReturns<string> {
  return {
    pid: 1234,
    output: [],
    stdout,
    stderr,
    status,
    signal: null,
    error,
  };
}

/** Simulate `phantom` not found on PATH (ENOENT). */
function spawnNotFound(): SpawnSyncReturns<string> {
  return makeSpawnResult('', '', null, Object.assign(new Error('spawn phantom ENOENT'), { code: 'ENOENT' }));
}

/** Simulate `phantom --version` returning a version string. */
function spawnVersion(version: string): SpawnSyncReturns<string> {
  return makeSpawnResult(`phantom ${version}\n`);
}

/** Simulate `phantom --help` returning a Commands block. */
function spawnHelp(commands = ['setup', 'mcp', 'exec', 'status', 'list']): SpawnSyncReturns<string> {
  return makeSpawnResult([
    'Phantom keeps secrets away from the AI agent.',
    '',
    'Commands:',
    ...commands.map((command) => `  ${command}    command help text`),
    '',
    'Options:',
    '  --help',
  ].join('\n'));
}

/** Simulate `phantom status` returning initialized status output. */
function spawnStatusInitialized(): SpawnSyncReturns<string> {
  return makeSpawnResult('Phantom is initialized\nvault: ~/.phantom\n');
}

/** Simulate `phantom status` returning uninitialized status output. */
function spawnStatusUninitialized(): SpawnSyncReturns<string> {
  return makeSpawnResult('', 'Phantom vault not initialized\n', 1);
}

/**
 * Simulate `phantom list --json` returning secret NAMES as a JSON array.
 * phantom.ts calls `list --json` and parses the JSON output — no plain-text
 * line format here; a JSON string array is the simplest passing shape.
 */
function spawnListSecrets(names: string[]): SpawnSyncReturns<string> {
  return makeSpawnResult(JSON.stringify(names) + '\n');
}

// ---------------------------------------------------------------------------
// Control helper: set up a sequence of spawnSync return values per invocation.
// ---------------------------------------------------------------------------

function setSpawnSequence(responses: SpawnSyncReturns<string>[]): void {
  let idx = 0;
  _spawnSyncImpl = () => {
    const res = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return res;
  };
}

// ---------------------------------------------------------------------------
// phantomInstalled()
// ---------------------------------------------------------------------------

describe('phantomInstalled — binary present', () => {
  beforeEach(() => {
    // Any non-ENOENT result means the binary exists.
    setSpawnSequence([spawnVersion('0.6.0')]);
  });

  it('returns true when phantom binary is on PATH', () => {
    expect(phantomInstalled()).toBe(true);
  });
});

describe('phantomInstalled — binary absent', () => {
  beforeEach(() => {
    setSpawnSequence([spawnNotFound()]);
  });

  it('returns false when phantom binary is not found', () => {
    expect(phantomInstalled()).toBe(false);
  });
});

describe('phantomInstalled — non-zero exit (e.g. --version fails)', () => {
  beforeEach(() => {
    // phantomInstalled() uses `phantom --version` and requires status === 0.
    // A non-zero exit (even without ENOENT) is treated as not installed.
    setSpawnSequence([makeSpawnResult('', 'some error', 1)]);
  });

  it('returns false when --version exits non-zero', () => {
    expect(phantomInstalled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPhantomStatus() — not installed
// ---------------------------------------------------------------------------

describe('getPhantomStatus — not installed', () => {
  beforeEach(() => {
    // Every spawnSync call returns ENOENT.
    _spawnSyncImpl = () => spawnNotFound();
  });

  it('returns installed:false', () => {
    const status = getPhantomStatus();
    expect(status.installed).toBe(false);
  });

  it('returns version:null when not installed', () => {
    const status = getPhantomStatus();
    expect(status.version).toBeNull();
  });

  it('returns initialized:false when not installed', () => {
    const status = getPhantomStatus();
    expect(status.initialized).toBe(false);
  });

  it('returns empty secretNames when not installed', () => {
    const status = getPhantomStatus();
    expect(status.secretNames).toEqual([]);
  });

  it('returns unknown command support when not installed', () => {
    const status = getPhantomStatus();
    expect(status.capability.commands).toEqual({
      commandsKnown: false,
      setupAvailable: false,
      execAvailable: false,
      mcpAvailable: false,
      agentAvailable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// getPhantomStatus() — installed, initialized, with secrets
// ---------------------------------------------------------------------------

describe('getPhantomStatus — installed and initialized', () => {
  const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY'];

  beforeEach(() => {
    // Call order: installed probe -> version -> status -> list -> help
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusInitialized(),
      spawnListSecrets(SECRET_NAMES),
      spawnHelp(),
    ]);
  });

  it('returns installed:true', () => {
    const status = getPhantomStatus();
    expect(status.installed).toBe(true);
  });

  it('returns a non-null version string', () => {
    const status = getPhantomStatus();
    expect(status.version).not.toBeNull();
    expect(typeof status.version).toBe('string');
    expect(status.version!.length).toBeGreaterThan(0);
  });

  it('returns initialized:true', () => {
    const status = getPhantomStatus();
    expect(status.initialized).toBe(true);
  });

  it('returns secret NAMES (not values)', () => {
    const status = getPhantomStatus();
    for (const name of SECRET_NAMES) {
      expect(status.secretNames).toContain(name);
    }
  });

  it('secretNames contains only strings', () => {
    const status = getPhantomStatus();
    expect(status.secretNames.every(n => typeof n === 'string')).toBe(true);
  });

  // ── THE KEY SAFETY INVARIANT ──────────────────────────────────────────────
  it('NEVER returns secret values — secretNames are just identifiers', () => {
    const status = getPhantomStatus();
    const json = JSON.stringify(status);
    // Secret values would contain patterns like 'sk-', 'ghp_', 'Bearer ', etc.
    // The names array should only contain the NAME tokens, not anything value-shaped.
    for (const name of status.secretNames) {
      // A secret NAME is an identifier (no whitespace, not a token format).
      // We verify no entry looks like an API key value.
      expect(name).not.toMatch(/^sk-/);       // OpenAI key value
      expect(name).not.toMatch(/^ghp_/);      // GitHub PAT value
      expect(name).not.toMatch(/^xoxb-/);     // Slack token value
      expect(name).not.toMatch(/\s/);         // Values can have spaces; names don't
    }
    // The entire serialized status should not contain key-value pairs with '='
    // (i.e. no "KEY=value" style leakage).
    expect(json).not.toMatch(/=[a-zA-Z0-9_-]{20,}/);
    void json; // consumed above
  });

  it('does not set error when fully operational', () => {
    const status = getPhantomStatus();
    expect(status.error).toBeUndefined();
  });

  it('returns a values-free capability summary for known fleet secrets', () => {
    const status = getPhantomStatus();

    expect(status.capability).toMatchObject({
      valueMode: 'metadata-and-names-only',
      secretCount: 3,
      knownFleetSecrets: {
        pulsePatPresent: false,
      },
      modes: {
        metadataStatus: true,
        childEnvInjectionAvailable: true,
        mcpServerAvailable: true,
        mutationRequiresHumanApproval: true,
      },
      commands: {
        commandsKnown: true,
        setupAvailable: true,
        execAvailable: true,
        mcpAvailable: true,
        agentAvailable: false,
      },
    });
    expect(status.capability.knownFleetSecrets.present).toEqual([
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
    ]);
    expect(status.capability.knownFleetSecrets.missing).toContain('ASHLR_PULSE_PAT');
    expect(status.capability.knownFleetSecrets.missing).toContain('ASHLR_PULSE_TOKEN');
  });
});

describe('getPhantomStatus — command support from help output', () => {
  it('parses only the Commands block, so "AI agent" prose does not imply an agent command', () => {
    const calls: string[][] = [];
    const responses = [
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusInitialized(),
      spawnListSecrets(['ANTHROPIC_API_KEY']),
      spawnHelp(['setup', 'mcp', 'exec', 'status', 'list']),
    ];
    let idx = 0;
    _spawnSyncImpl = (_bin: unknown, args: unknown) => {
      calls.push(Array.isArray(args) ? args.map(String) : []);
      const res = responses[idx] ?? responses[responses.length - 1];
      idx++;
      return res;
    };

    const status = getPhantomStatus();

    expect(status.capability.commands).toEqual({
      commandsKnown: true,
      setupAvailable: true,
      execAvailable: true,
      mcpAvailable: true,
      agentAvailable: false,
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('Phantom keeps secrets away from the AI agent.');
    expect(serialized).not.toContain('command help text');
    expect(calls).toContainEqual(['--help']);
    expect(calls).not.toContainEqual(['agent']);
    expect(calls).not.toContainEqual(['agent', '--help']);
  });

  it('reports agentAvailable only when agent is an actual command', () => {
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusInitialized(),
      spawnListSecrets(['ANTHROPIC_API_KEY']),
      spawnHelp(['setup', 'mcp', 'exec', 'agent']),
    ]);

    const status = getPhantomStatus();

    expect(status.capability.commands).toMatchObject({
      commandsKnown: true,
      agentAvailable: true,
    });
  });

  it('reports unknown command support when help has no Commands block', () => {
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusInitialized(),
      spawnListSecrets(['ANTHROPIC_API_KEY']),
      makeSpawnResult('legacy help without a command list\n'),
    ]);

    const status = getPhantomStatus();

    expect(status.capability.commands).toEqual({
      commandsKnown: false,
      setupAvailable: false,
      execAvailable: false,
      mcpAvailable: false,
      agentAvailable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// getPhantomStatus() — installed but not initialized
// ---------------------------------------------------------------------------

describe('getPhantomStatus — installed but not initialized', () => {
  beforeEach(() => {
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusUninitialized(),
      spawnHelp(),
    ]);
  });

  it('returns installed:true', () => {
    const status = getPhantomStatus();
    expect(status.installed).toBe(true);
  });

  it('returns initialized:false', () => {
    const status = getPhantomStatus();
    expect(status.initialized).toBe(false);
  });

  it('returns empty secretNames when not initialized', () => {
    const status = getPhantomStatus();
    expect(status.secretNames).toEqual([]);
  });

  it('still parses command support when the vault is not initialized', () => {
    const status = getPhantomStatus();
    expect(status.capability.commands).toEqual({
      commandsKnown: true,
      setupAvailable: true,
      execAvailable: true,
      mcpAvailable: true,
      agentAvailable: false,
    });
  });

  it('treats structured error JSON as not initialized', () => {
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      makeSpawnResult(JSON.stringify({ error: 'not initialized; run phantom init' }) + '\n'),
    ]);

    const status = getPhantomStatus();
    expect(status.initialized).toBe(false);
    expect(status.secretNames).toEqual([]);
    expect(status.capability.modes.childEnvInjectionAvailable).toBe(false);
  });

  it('treats unknown structured status JSON as not initialized', () => {
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      makeSpawnResult(JSON.stringify({ ok: true }) + '\n'),
    ]);

    const status = getPhantomStatus();
    expect(status.initialized).toBe(false);
    expect(status.secretNames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getPhantomStatus() — installed but list fails / empty
// ---------------------------------------------------------------------------

describe('getPhantomStatus — installed, initialized, but no secrets', () => {
  beforeEach(() => {
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusInitialized(),
      spawnListSecrets([]),
    ]);
  });

  it('returns empty secretNames when vault is empty', () => {
    const status = getPhantomStatus();
    expect(status.secretNames).toEqual([]);
  });

  it('still returns installed:true and initialized:true', () => {
    const status = getPhantomStatus();
    expect(status.installed).toBe(true);
    expect(status.initialized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getPhantomStatus() — spawnSync throws internally (e.g. unexpected OS error)
// ---------------------------------------------------------------------------

describe('getPhantomStatus — unexpected spawnSync error', () => {
  beforeEach(() => {
    // runPhantom() catches thrown errors and surfaces them as error strings.
    // phantomInstalled() sees error !== undefined and returns false, so
    // getPhantomStatus() hits the early-return branch (installed: false).
    _spawnSyncImpl = () => { throw new Error('unexpected internal error'); };
  });

  it('does not propagate the error (returns gracefully)', () => {
    expect(() => getPhantomStatus()).not.toThrow();
  });

  it('returns installed:false when spawnSync throws', () => {
    const status = getPhantomStatus();
    expect(status.installed).toBe(false);
  });

  it('returns empty secretNames when spawnSync throws', () => {
    const status = getPhantomStatus();
    expect(status.secretNames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Safety: secretNames must NEVER contain secret values regardless of output
// ---------------------------------------------------------------------------

describe('getPhantomStatus — safety: JSON output never leaks values', () => {
  // phantom.ts calls `list --json`. Even if someone crafted output that has
  // value-like fields, parseSecretNames only extracts the "name" or "key"
  // field from each object — never "value", "token", or any other field.
  beforeEach(() => {
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusInitialized(),
      // Simulate a rogue/extended JSON shape that includes value fields.
      makeSpawnResult(JSON.stringify([
        { name: 'ANTHROPIC_API_KEY', value: 'sk-abc123verylongsecretvalue' },
        { name: 'GITHUB_TOKEN',      value: 'ghp_supersecrettoken12345678' },
      ]) + '\n'),
    ]);
  });

  it('secretNames contains only the name identifiers, not values', () => {
    const status = getPhantomStatus();
    expect(status.secretNames).toContain('ANTHROPIC_API_KEY');
    expect(status.secretNames).toContain('GITHUB_TOKEN');
  });

  it('secretNames do not contain any of the secret values', () => {
    const status = getPhantomStatus();
    const allText = status.secretNames.join('\n');
    expect(allText).not.toContain('sk-abc123verylongsecretvalue');
    expect(allText).not.toContain('ghp_supersecrettoken12345678');
  });

  it('the full serialized PhantomStatus does not contain secret values', () => {
    const status = getPhantomStatus();
    const json = JSON.stringify(status);
    expect(json).not.toContain('sk-abc123verylongsecretvalue');
    expect(json).not.toContain('ghp_supersecrettoken12345678');
  });

  it('filters value-shaped strings from flat string arrays before returning names', () => {
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusInitialized(),
      makeSpawnResult(JSON.stringify([
        'ANTHROPIC_API_KEY',
        'sk-abc123verylongsecretvalue',
        'ghp_supersecrettoken12345678',
        'ASHLR_PULSE_PAT',
      ]) + '\n'),
    ]);

    const status = getPhantomStatus();
    const serialized = JSON.stringify(status);

    expect(status.secretNames).toEqual(['ANTHROPIC_API_KEY', 'ASHLR_PULSE_PAT']);
    expect(status.capability.knownFleetSecrets.pulsePatPresent).toBe(true);
    expect(status.capability.knownFleetSecrets.pulseCredentialPresent).toBe(true);
    expect(serialized).not.toContain('sk-abc123verylongsecretvalue');
    expect(serialized).not.toContain('ghp_supersecrettoken12345678');
  });

  it('filters value-shaped tokens from non-JSON plain-text fallback output', () => {
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusInitialized(),
      makeSpawnResult([
        'NAME PROTECTED',
        'ANTHROPIC_API_KEY yes',
        'AKIAABCDEFGHIJKLMNOP no',
        'ASHLR_PULSE_TOKEN yes',
        'GITHUB_TOKEN yes',
        'KEY ignored',
      ].join('\n')),
    ]);

    const status = getPhantomStatus();
    const serialized = JSON.stringify(status);

    expect(status.secretNames).toEqual(['ANTHROPIC_API_KEY', 'ASHLR_PULSE_TOKEN', 'GITHUB_TOKEN']);
    expect(status.capability.knownFleetSecrets.pulsePatPresent).toBe(false);
    expect(status.capability.knownFleetSecrets.pulseTokenPresent).toBe(true);
    expect(status.capability.knownFleetSecrets.pulseCredentialPresent).toBe(true);
    expect(serialized).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('uses an allowlist so non-env-name token families cannot masquerade as names', () => {
    setSpawnSequence([
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusInitialized(),
      makeSpawnResult(JSON.stringify([
        { name: 'ANTHROPIC_API_KEY' },
        { name: 'github_pat_1234567890abcdef1234567890abcdef1234567890abcdef' },
        { key: 'glpat-1234567890abcdef1234' },
        { name: 'hf_abcdefghijklmnopqrstuvwxyz123456' },
        { key: 'npm_abcdefghijklmnopqrstuvwxyz123456' },
        { name: 'AIzaabcdefghijklmnopqrstuvwxyz123456' },
        { name: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
        'OPENAI_API_KEY',
      ]) + '\n'),
    ]);

    const status = getPhantomStatus();
    const serialized = JSON.stringify(status);

    expect(status.secretNames).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(serialized).not.toContain('github_pat_');
    expect(serialized).not.toContain('glpat-');
    expect(serialized).not.toContain('hf_');
    expect(serialized).not.toContain('npm_');
    expect(serialized).not.toContain('AIza');
    expect(serialized).not.toContain('0123456789abcdef0123456789abcdef');
  });
});

describe('getCachedFleetPhantomStatus — short fleet cache', () => {
  it('reuses the cached metadata snapshot within the TTL and resets on demand', () => {
    const responses = [
      spawnVersion('0.6.0'),
      spawnVersion('0.6.0'),
      spawnStatusInitialized(),
      spawnListSecrets(['ANTHROPIC_API_KEY']),
      spawnHelp(),
    ];
    let idx = 0;
    let calls = 0;
    _spawnSyncImpl = () => {
      calls++;
      const res = responses[idx] ?? responses[responses.length - 1];
      idx++;
      return res;
    };

    const first = getCachedFleetPhantomStatus({ nowMs: 1_000, ttlMs: 30_000 });
    const second = getCachedFleetPhantomStatus({ nowMs: 2_000, ttlMs: 30_000 });

    expect(second).toBe(first);
    expect(calls).toBe(5);

    resetPhantomStatusCache();
    idx = 0;
    const third = getCachedFleetPhantomStatus({ nowMs: 3_000, ttlMs: 30_000 });

    expect(third).not.toBe(first);
    expect(calls).toBe(10);
  });
});

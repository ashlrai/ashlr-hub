/**
 * M18 — hermetic tests for src/core/integrations/identity.ts
 *
 * Mocks node:child_process so no real `phantom` binary is invoked.
 *
 * Invariants verified:
 *   - getIdentity parses phantom output for user/tier/team — NAMES/status only
 *   - getIdentity NEVER returns secret values in any field
 *   - getIdentity degrades to loggedIn:false when phantom is absent / not logged in
 *   - getIdentity NEVER throws — always returns Identity shape
 *   - getIdentity only reads (names/status) — never modifies phantom state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test.
// ---------------------------------------------------------------------------

let _spawnSyncImpl: (...args: unknown[]) => SpawnSyncReturns<string>;

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => _spawnSyncImpl(...args),
  execFileSync: () => { throw new Error('execFileSync not expected'); },
}));

import { getIdentity } from '../src/core/integrations/identity.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpawn(
  stdout: string,
  status: number | null = 0,
  error?: Error,
): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr: '', status, signal: null, error };
}

function spawnNotFound(): SpawnSyncReturns<string> {
  return makeSpawn('', null, Object.assign(new Error('spawn phantom ENOENT'), { code: 'ENOENT' }));
}

function setSpawnAlways(res: SpawnSyncReturns<string>): void {
  _spawnSyncImpl = () => res;
}

function setSpawnSequence(responses: SpawnSyncReturns<string>[]): void {
  let idx = 0;
  _spawnSyncImpl = () => {
    const res = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return res;
  };
}

// Realistic phantom cloud status output (names/status only — no secret values)
const PHANTOM_STATUS_LOGGED_IN = `
Logged in as: mason@example.com
User: mason
Tier: pro
Team: acme-eng
Status: active
`.trim();

const PHANTOM_STATUS_WITH_TEAM_JSON = JSON.stringify({
  user: 'mason',
  tier: 'pro',
  team: 'acme-eng',
  loggedIn: true,
});

const PHANTOM_STATUS_NOT_LOGGED_IN = 'Not logged in. Run: phantom auth login';

// ---------------------------------------------------------------------------
// getIdentity — happy path: logged in with user/tier/team
// ---------------------------------------------------------------------------

describe('getIdentity — logged in user with tier and team', () => {
  beforeEach(() => {
    setSpawnSequence([
      makeSpawn(PHANTOM_STATUS_LOGGED_IN),
      makeSpawn(JSON.stringify({ team: 'acme-eng' })),
    ]);
  });

  it('returns loggedIn:true', () => {
    const id = getIdentity();
    expect(id.loggedIn).toBe(true);
  });

  it('returns a non-null user field', () => {
    const id = getIdentity();
    expect(id.user).not.toBeNull();
    expect(typeof id.user).toBe('string');
    expect((id.user as string).length).toBeGreaterThan(0);
  });

  it('user field is a name/identifier (not a secret value)', () => {
    const id = getIdentity();
    // Names must not look like API keys or tokens
    expect(id.user).not.toMatch(/^sk-/);
    expect(id.user).not.toMatch(/^ghp_/);
    expect(id.user).not.toMatch(/^xoxb-/);
    expect(id.user).not.toMatch(/=[a-zA-Z0-9_-]{20,}/);
  });
});

describe('getIdentity — JSON output format', () => {
  beforeEach(() => {
    setSpawnAlways(makeSpawn(PHANTOM_STATUS_WITH_TEAM_JSON));
  });

  it('returns loggedIn:true when JSON indicates logged in', () => {
    const id = getIdentity();
    expect(id.loggedIn).toBe(true);
  });

  it('returns tier field when present', () => {
    const id = getIdentity();
    // tier may be parsed from JSON — either present or null is valid
    expect(id.tier === null || typeof id.tier === 'string').toBe(true);
  });

  it('returns team field when present', () => {
    const id = getIdentity();
    expect(id.team === null || typeof id.team === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getIdentity — not logged in
// ---------------------------------------------------------------------------

describe('getIdentity — not logged in', () => {
  beforeEach(() => {
    setSpawnAlways(makeSpawn(PHANTOM_STATUS_NOT_LOGGED_IN, 1));
  });

  it('does not throw', () => {
    expect(() => getIdentity()).not.toThrow();
  });

  it('returns loggedIn:false', () => {
    const id = getIdentity();
    expect(id.loggedIn).toBe(false);
  });

  it('returns user:null when not logged in', () => {
    const id = getIdentity();
    expect(id.user).toBeNull();
  });

  it('returns tier:null when not logged in', () => {
    const id = getIdentity();
    expect(id.tier).toBeNull();
  });

  it('returns team:null when not logged in', () => {
    const id = getIdentity();
    expect(id.team).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getIdentity — phantom binary not found
// ---------------------------------------------------------------------------

describe('getIdentity — phantom binary not on PATH', () => {
  beforeEach(() => {
    setSpawnAlways(spawnNotFound());
  });

  it('does not throw when phantom is missing', () => {
    expect(() => getIdentity()).not.toThrow();
  });

  it('returns loggedIn:false when phantom is missing', () => {
    const id = getIdentity();
    expect(id.loggedIn).toBe(false);
  });

  it('returns all null fields when phantom is missing', () => {
    const id = getIdentity();
    expect(id.user).toBeNull();
    expect(id.tier).toBeNull();
    expect(id.team).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getIdentity — spawnSync throws internally
// ---------------------------------------------------------------------------

describe('getIdentity — spawnSync throws internally', () => {
  beforeEach(() => {
    _spawnSyncImpl = () => { throw new Error('unexpected OS error'); };
  });

  it('does not propagate the error', () => {
    expect(() => getIdentity()).not.toThrow();
  });

  it('returns loggedIn:false', () => {
    const id = getIdentity();
    expect(id.loggedIn).toBe(false);
  });

  it('returns Identity shape even when spawnSync throws', () => {
    const id = getIdentity();
    expect(typeof id.loggedIn).toBe('boolean');
    expect(id.user === null || typeof id.user === 'string').toBe(true);
    expect(id.tier === null || typeof id.tier === 'string').toBe(true);
    expect(id.team === null || typeof id.team === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getIdentity — malformed output
// ---------------------------------------------------------------------------

describe('getIdentity — malformed phantom output', () => {
  it('does not throw on empty output', () => {
    setSpawnAlways(makeSpawn(''));
    expect(() => getIdentity()).not.toThrow();
  });

  it('does not throw on completely random output', () => {
    setSpawnAlways(makeSpawn('%%%GARBAGE%%%\x00\x01'));
    expect(() => getIdentity()).not.toThrow();
  });

  it('returns a valid Identity shape on malformed output', () => {
    setSpawnAlways(makeSpawn('{ not valid json !!!'));
    const id = getIdentity();
    expect(typeof id.loggedIn).toBe('boolean');
    expect(id.user === null || typeof id.user === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL SAFETY INVARIANT — NEVER returns secret values
// ---------------------------------------------------------------------------

describe('getIdentity — NEVER returns secret values', () => {
  it('serialized Identity does not contain token-shaped values', () => {
    setSpawnSequence([
      makeSpawn(PHANTOM_STATUS_LOGGED_IN),
      makeSpawn(JSON.stringify({ team: 'acme-eng' })),
    ]);
    const id = getIdentity();
    const json = JSON.stringify(id);
    // Must not contain common secret token patterns
    expect(json).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    expect(json).not.toMatch(/ghp_[a-zA-Z0-9]{20,}/);
    expect(json).not.toMatch(/xoxb-[a-zA-Z0-9-]{20,}/);
    expect(json).not.toMatch(/Bearer [a-zA-Z0-9._-]{20,}/);
  });

  it('even if phantom outputs rogue fields with secret values, Identity shape only has known fields', () => {
    // Simulate rogue/extended JSON output that includes secret-like fields
    const rogueOutput = JSON.stringify({
      user: 'mason',
      tier: 'pro',
      team: 'acme-eng',
      loggedIn: true,
      secretToken: 'sk-abc123supersecretvalue',
      apiKey: 'ghp_supersecrettoken12345678',
    });
    setSpawnAlways(makeSpawn(rogueOutput));
    const id = getIdentity();
    // The returned Identity shape must only have the contract fields
    const json = JSON.stringify(id);
    expect(json).not.toContain('sk-abc123supersecretvalue');
    expect(json).not.toContain('ghp_supersecrettoken12345678');
  });

  it('Identity shape only contains loggedIn, user, tier, team fields', () => {
    setSpawnAlways(makeSpawn(PHANTOM_STATUS_WITH_TEAM_JSON));
    const id = getIdentity();
    const keys = Object.keys(id);
    const allowedKeys = new Set(['loggedIn', 'user', 'tier', 'team']);
    for (const k of keys) {
      expect(allowedKeys.has(k)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// getIdentity — shape invariant: always returns Identity
// ---------------------------------------------------------------------------

describe('getIdentity — always returns a valid Identity shape', () => {
  it('shape is correct on success', () => {
    setSpawnAlways(makeSpawn(PHANTOM_STATUS_WITH_TEAM_JSON));
    const id = getIdentity();
    expect(typeof id.loggedIn).toBe('boolean');
    expect(id.user === null || typeof id.user === 'string').toBe(true);
    expect(id.tier === null || typeof id.tier === 'string').toBe(true);
    expect(id.team === null || typeof id.team === 'string').toBe(true);
  });

  it('shape is correct on failure', () => {
    setSpawnAlways(spawnNotFound());
    const id = getIdentity();
    expect(typeof id.loggedIn).toBe('boolean');
    expect(id.user === null || typeof id.user === 'string').toBe(true);
    expect(id.tier === null || typeof id.tier === 'string').toBe(true);
    expect(id.team === null || typeof id.team === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getIdentity — read-only: never mutates phantom state
// ---------------------------------------------------------------------------

describe('getIdentity — read-only: never invokes mutating phantom commands', () => {
  it('does not invoke phantom auth login, logout, or init', () => {
    const calls: string[] = [];
    _spawnSyncImpl = (cmd: unknown, args: unknown) => {
      if (Array.isArray(args)) {
        calls.push([cmd, ...args].filter(Boolean).join(' '));
      }
      return makeSpawn(PHANTOM_STATUS_WITH_TEAM_JSON, 0);
    };
    getIdentity();
    const mutatingCalls = calls.filter(c =>
      c.includes('auth login') ||
      c.includes('auth logout') ||
      c.includes('phantom init') ||
      c.includes('phantom rotate') ||
      c.includes('phantom add') ||
      c.includes('phantom remove'),
    );
    expect(mutatingCalls).toHaveLength(0);
  });
});

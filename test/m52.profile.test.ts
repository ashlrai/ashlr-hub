/**
 * m52.profile.test.ts — M52: Pure SBPL profile string assertions.
 *
 * No subprocess spawns. Tests:
 *   1. Profile includes expected clauses (allow default, deny file-read*,
 *      re-allow worktree, deny network-outbound*, deny file-write*).
 *   2. Injection safety: a worktree/readAllowed path containing `"` or `)`
 *      cannot break out of the SBPL string literal.
 *   3. networkEgress:true omits (deny network-outbound*).
 *   4. readAllowed paths appear in the allow file-read* clause.
 *   5. escapeSbplPath escapes `"` and `\` correctly.
 *   6. confinementProfileFor resolves per-engine over * over default.
 */

import { describe, it, expect } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';

import {
  buildMacosSbplProfile,
  escapeSbplPath,
  confinementProfileFor,
} from '../src/core/sandbox/confine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/home/u/Desktop/github'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

const WORKTREE = '/tmp/ashlr-wt-test-12345';

function buildProfile(overrides: {
  networkEgress?: boolean;
  readAllowed?: string[];
  worktree?: string;
} = {}): string {
  return buildMacosSbplProfile(
    {
      mode: 'os',
      networkEgress: overrides.networkEgress ?? false,
      readAllowed: overrides.readAllowed,
    },
    {
      worktree: overrides.worktree ?? WORKTREE,
      home: '/Users/testuser',
      env: { TMPDIR: '/tmp' },
    },
  );
}

// ---------------------------------------------------------------------------
// 1. Profile structure — expected SBPL clauses
// ---------------------------------------------------------------------------

describe('M52 SBPL profile structure', () => {
  it('begins with (version 1)', () => {
    const p = buildProfile();
    expect(p).toMatch(/^\(version 1\)/);
  });

  it('contains (allow default)', () => {
    const p = buildProfile();
    expect(p).toContain('(allow default)');
  });

  it('contains (deny file-read*)', () => {
    const p = buildProfile();
    expect(p).toContain('(deny file-read*');
  });

  it('contains (allow file-read* ...) clause', () => {
    const p = buildProfile();
    expect(p).toMatch(/\(allow file-read\*/);
  });

  it('allows the worktree subpath in the read-allow clause', () => {
    const p = buildProfile({ worktree: WORKTREE });
    // The worktree must appear as a (subpath "...") inside the allow file-read* block.
    expect(p).toContain(`(subpath "${WORKTREE}")`);
  });

  it('contains (deny file-write*)', () => {
    const p = buildProfile();
    expect(p).toContain('(deny file-write*');
  });

  it('contains (allow file-write* ...) with worktree', () => {
    const p = buildProfile({ worktree: WORKTREE });
    // file-write* allow must include the worktree
    const writeAllow = p.match(/\(deny file-write\*[\s\S]*?\(allow file-write\*[\s\S]*?\)/);
    expect(writeAllow).not.toBeNull();
    expect(p).toContain(`(subpath "${WORKTREE}")`);
  });

  it('contains (deny network-outbound*) when networkEgress is false', () => {
    const p = buildProfile({ networkEgress: false });
    expect(p).toContain('(deny network*)');
  });

  it('does NOT contain (deny network-outbound*) when networkEgress is true', () => {
    const p = buildProfile({ networkEgress: true });
    expect(p).not.toContain('(deny network*)');
  });
});

// ---------------------------------------------------------------------------
// 2. readAllowed extra paths
// ---------------------------------------------------------------------------

describe('M52 SBPL readAllowed paths', () => {
  it('includes extra readAllowed path in allow file-read* clause', () => {
    const extra = '/Users/testuser/extra-data';
    const p = buildProfile({ readAllowed: [extra] });
    expect(p).toContain(`(subpath "${extra}")`);
  });

  it('includes multiple readAllowed paths', () => {
    const extras = ['/data/project-a', '/data/project-b'];
    const p = buildProfile({ readAllowed: extras });
    for (const extra of extras) {
      expect(p).toContain(`(subpath "${extra}")`);
    }
  });

  it('handles empty readAllowed array gracefully', () => {
    expect(() => buildProfile({ readAllowed: [] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Injection safety — escapeSbplPath
// ---------------------------------------------------------------------------

describe('M52 escapeSbplPath injection safety', () => {
  it('passes through a normal absolute path unchanged', () => {
    const p = '/home/user/project/worktree';
    expect(escapeSbplPath(p)).toBe(p);
  });

  it('escapes double-quote characters so they cannot terminate the SBPL string', () => {
    const malicious = '/tmp/evil' + '"' + ')(allow file-read* (subpath "/' + "'";
    const escaped = escapeSbplPath(malicious);
    // No bare (unescaped) double-quote should remain.
    // After escaping, every " should be preceded by \.
    expect(escaped).not.toMatch(/(?<!\\)"/);
    // The escaped form should contain \".
    expect(escaped).toContain('\\"');
  });

  it('escapes backslash characters', () => {
    const withBackslash = '/tmp/evil\\path';
    const escaped = escapeSbplPath(withBackslash);
    expect(escaped).toContain('\\\\');
  });

  it('does NOT escape parentheses (they are safe inside a SBPL string literal)', () => {
    // A closing paren inside a quoted string literal is NOT a syntax character;
    // it is safe — the lexer finds the closing " first.
    const withParen = '/tmp/dir)with(parens';
    const escaped = escapeSbplPath(withParen);
    expect(escaped).toContain(')');
    expect(escaped).toContain('(');
  });

  it('a path with ")" does not escape and remains in the profile as a (subpath ...) without breaking out', () => {
    const evil = '/tmp/dir)evil';
    const profile = buildProfile({ readAllowed: [evil] });
    // The path is embedded as (subpath "/tmp/dir)evil") — the ) is inside quotes.
    // The profile must still contain the properly-closed allow clause.
    expect(profile).toContain(`(subpath "${evil}")`);
    // And the (deny file-read*) clause must also still be present (profile is valid).
    expect(profile).toContain('(deny file-read*');
  });

  it('a path with " does not break SBPL profile structure', () => {
    const evil = '/tmp/dir"with-quote';
    const profile = buildProfile({ readAllowed: [evil] });
    // The quote is escaped — profile must still have the deny clause intact.
    expect(profile).toContain('(deny file-read*');
    // The escaped form appears in the profile.
    expect(profile).toContain('\\"');
    // And (deny network-outbound*) is still present.
    expect(profile).toContain('(deny network*)');
  });
});

// ---------------------------------------------------------------------------
// 4. confinementProfileFor — resolution logic
// ---------------------------------------------------------------------------

describe('M52 confinementProfileFor', () => {
  it('returns mode:off when cfg.foundry.confinement is absent', () => {
    const cfg = makeConfig();
    const profile = confinementProfileFor('claude', cfg);
    expect(profile.mode).toBe('off');
  });

  it('returns mode:off when cfg.foundry is absent entirely', () => {
    const cfg = makeConfig();
    delete (cfg as Record<string, unknown>)['foundry'];
    const profile = confinementProfileFor('claude', cfg);
    expect(profile.mode).toBe('off');
  });

  it('picks up fleet-wide * default', () => {
    const cfg = makeConfig({
      foundry: {
        confinement: {
          '*': { mode: 'os', networkEgress: false },
        },
      },
    } as Partial<AshlrConfig>);
    const profile = confinementProfileFor('claude', cfg);
    expect(profile.mode).toBe('os');
    expect(profile.networkEgress).toBe(false);
  });

  it('per-engine key overrides * default', () => {
    const cfg = makeConfig({
      foundry: {
        confinement: {
          '*': { mode: 'os', networkEgress: false },
          claude: { mode: 'off' },
        },
      },
    } as Partial<AshlrConfig>);
    const profile = confinementProfileFor('claude', cfg);
    expect(profile.mode).toBe('off');
  });

  it('per-engine key can set networkEgress:true even when * has false', () => {
    const cfg = makeConfig({
      foundry: {
        confinement: {
          '*': { mode: 'os', networkEgress: false },
          codex: { mode: 'os', networkEgress: true },
        },
      },
    } as Partial<AshlrConfig>);
    const codexProfile = confinementProfileFor('codex', cfg);
    expect(codexProfile.networkEgress).toBe(true);
    const claudeProfile = confinementProfileFor('claude', cfg);
    expect(claudeProfile.networkEgress).toBe(false);
  });

  it('preserves readAllowed from resolved profile', () => {
    const extra = '/data/extra';
    const cfg = makeConfig({
      foundry: {
        confinement: {
          claude: { mode: 'os', readAllowed: [extra] },
        },
      },
    } as Partial<AshlrConfig>);
    const profile = confinementProfileFor('claude', cfg);
    expect(profile.readAllowed).toContain(extra);
  });
});

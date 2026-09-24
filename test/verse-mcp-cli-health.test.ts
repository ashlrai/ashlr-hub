/**
 * Tests for src/core/verse/mcp-cli-health.ts — per-account CLI health and the
 * version pin.
 *
 * What is proven here:
 *
 *   1. THE TWO COPIES OF THE PIN ARE COMPARED. The enforcing check is an
 *      inline literal inside `probeClaudeAccountUsage`; the value the UI shows
 *      is a separate exported constant. Nothing in the product compares them,
 *      so they can drift silently and the surface would confidently display
 *      the wrong version. This file compares them.
 *   2. Drift is derived from the collector's VERBATIM reason, with no probe
 *      run — the free path — and it is loud: `driftDetected`, plus a note
 *      naming the file the pin lives in.
 *   3. `unverified` is never dressed up as agreement. No version read means
 *      `version: null` and state `unverified`, not `matches-pin`.
 *   4. The version probe returns ONLY the reading. The launcher argv and the
 *      private cwd it needed never appear in its result.
 *
 * Hermetic: the compatibility check is injected, so nothing spawns.
 */
import { CLAUDE_USAGE_VERIFIED_VERSIONS } from '../src/core/resources/claude-account-usage.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  VERSE_CLAUDE_USAGE_PINNED_VERSION,
  VERSE_CLAUDE_VERSION_REASON,
  type VerseAccountRecord,
} from '../src/core/verse/accounts.js';
import {
  VERSE_CLI_PIN_SOURCE,
  buildVerseCliHealth,
  probeVerseAccountCliVersions,
  type VerseCliVersionReading,
} from '../src/core/verse/mcp-cli-health.js';

function record(patch: Partial<VerseAccountRecord> = {}): VerseAccountRecord {
  return {
    id: 'claude',
    label: 'Claude Code',
    provider: 'claude',
    state: 'observed',
    authentication: 'signed-in',
    health: 'reachable',
    planType: 'max',
    observedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    windows: [],
    reason: 'probe-observed',
    onDemandEnabled: null,
    executionSupported: true,
    credits: null,
    binding: null,
    notes: [],
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// 1. The pin's two copies
// ---------------------------------------------------------------------------

describe('the version pin is stored twice and they must agree', () => {
  it('the displayed constant is the newest version the usage probe enforces', () => {
    const source = readFileSync(join(process.cwd(), VERSE_CLI_PIN_SOURCE), 'utf8');
    // The probe must gate on the verified list, never a lone inline literal.
    expect(source, 'the probe must check CLAUDE_USAGE_VERIFIED_VERSIONS').toMatch(/CLAUDE_USAGE_VERIFIED_VERSIONS\.some\(/);
    expect(
      CLAUDE_USAGE_VERIFIED_VERSIONS.at(-1),
      'VERSE_CLAUDE_USAGE_PINNED_VERSION has drifted from the newest version the probe actually enforces',
    ).toBe(VERSE_CLAUDE_USAGE_PINNED_VERSION);
    expect(CLAUDE_USAGE_VERIFIED_VERSIONS).toContain('2.1.257');
  });

  it('the reason constant is the code the probe actually reports', () => {
    const source = readFileSync(join(process.cwd(), VERSE_CLI_PIN_SOURCE), 'utf8');
    expect(source).toContain(`'${VERSE_CLAUDE_VERSION_REASON}'`);
  });
});

// ---------------------------------------------------------------------------
// 2. Drift, derived free and surfaced loudly
// ---------------------------------------------------------------------------

describe('buildVerseCliHealth', () => {
  it('reads drift straight off the collector\'s verbatim reason, with no probe', () => {
    const health = buildVerseCliHealth({
      accounts: [record({ reason: VERSE_CLAUDE_VERSION_REASON })],
    });

    const account = health.accounts[0]!;
    expect(account.usageBlockedByPin).toBe(true);
    expect(account.versionState).toBe('drift');
    expect(account.pinnedVersion).toBe(VERSE_CLAUDE_USAGE_PINNED_VERSION);
    expect(health.driftDetected).toBe(true);
    // Loud: the note says what to do and where the constant is.
    expect(health.notes.join(' ')).toContain(VERSE_CLI_PIN_SOURCE);
    expect(account.notes.join(' ')).toContain(VERSE_CLAUDE_USAGE_PINNED_VERSION);
    expect(account.notes.join(' ')).toContain('version pin, not an outage');
  });

  it('carries auth state and plan through unchanged', () => {
    const health = buildVerseCliHealth({
      accounts: [record({ authentication: 'signed-out', state: 'signed-out', planType: null })],
    });
    const account = health.accounts[0]!;
    expect(account.authentication).toBe('signed-out');
    expect(account.state).toBe('signed-out');
    expect(account.planType).toBeNull();
  });

  it('never rewrites the machine reason into prose', () => {
    const health = buildVerseCliHealth({ accounts: [record({ reason: 'probe-timed-out' })] });
    expect(health.accounts[0]!.reason).toBe('probe-timed-out');
  });
});

// ---------------------------------------------------------------------------
// 3. Unverified is not agreement
// ---------------------------------------------------------------------------

describe('an unread version is reported as unread', () => {
  it('reports unverified and a null version when no probe has run', () => {
    const health = buildVerseCliHealth({ accounts: [record()] });
    const account = health.accounts[0]!;
    expect(account.version).toBeNull();
    expect(account.versionState).toBe('unverified');
    expect(health.driftDetected).toBe(false);
    expect(account.notes.join(' ')).toContain('No CLI version has been read');
  });

  it('reports matches-pin only when a reading actually equals the pin', () => {
    const readings = new Map<string, VerseCliVersionReading>([
      ['claude', { version: VERSE_CLAUDE_USAGE_PINNED_VERSION, status: 'supported', reason: 'launcher-flags-advertised' }],
    ]);
    const health = buildVerseCliHealth({ accounts: [record()], readings });
    expect(health.accounts[0]!.versionState).toBe('matches-pin');
    expect(health.driftDetected).toBe(false);
  });

  it('reports drift when a reading disagrees with the pin, even if the probe has not failed yet', () => {
    const readings = new Map<string, VerseCliVersionReading>([
      ['claude', { version: '2.9.9', status: 'supported', reason: 'launcher-flags-advertised' }],
    ]);
    const health = buildVerseCliHealth({ accounts: [record()], readings });
    expect(health.accounts[0]!.versionState).toBe('drift');
    expect(health.driftDetected).toBe(true);
  });

  it('reports a version for an unpinned provider without inventing a pin', () => {
    const readings = new Map<string, VerseCliVersionReading>([
      ['codex-personal', { version: '1.2.3', status: 'supported', reason: 'launcher-flags-advertised' }],
    ]);
    const health = buildVerseCliHealth({
      accounts: [record({ id: 'codex-personal', provider: 'codex', label: 'Personal' })],
      readings,
    });
    const account = health.accounts[0]!;
    expect(account.pinnedVersion).toBeNull();
    expect(account.versionState).toBe('reported');
    expect(health.driftDetected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. The probe returns only the reading
// ---------------------------------------------------------------------------

describe('probeVerseAccountCliVersions', () => {
  it('drops the launcher argv and private cwd it was given', async () => {
    const seen: Array<{ command: string[]; cwd: string }> = [];

    const readings = await probeVerseAccountCliVersions({
      accountsRoot: '/unused-because-readLaunches-is-injected',
      readLaunches: () => [
        { id: 'codex-personal', provider: 'codex', command: ['/usr/bin/node', '/private/p/launcher.mjs'], cwd: '/private/p/native-state' },
      ],
      check: async (options) => {
        seen.push({ command: [...options.command], cwd: options.cwd });
        return {
          schemaVersion: 1,
          scope: 'native-cli-help',
          provider: options.provider,
          status: 'supported',
          reason: 'launcher-flags-advertised',
          version: '1.2.3',
          requiredFlags: [],
          observedFlags: [],
          missingFlags: [],
          hubTransport: 'native-cli',
          upstreamTransport: 'native-cli',
          upstreamCapability: 'advertised',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
        };
      },
    });

    // The check DID receive the private inputs — that is how it works.
    expect(seen[0]!.command).toEqual(['/usr/bin/node', '/private/p/launcher.mjs']);

    // ...and none of it survives into what the caller gets back.
    const serialized = JSON.stringify([...readings.entries()]);
    expect(serialized).not.toContain('launcher.mjs');
    expect(serialized).not.toContain('native-state');
    expect(readings.get('codex-personal')).toEqual({
      version: '1.2.3',
      status: 'supported',
      reason: 'launcher-flags-advertised',
    });
  });

  it('records a refused configuration as a reading, not a crash', async () => {
    const readings = await probeVerseAccountCliVersions({
      accountsRoot: '/unused',
      readLaunches: () => [
        { id: 'grok', provider: 'grok', command: ['/usr/bin/node', '/private/g/launcher.mjs'], cwd: '/private/g/native-state' },
      ],
      check: async () => { throw new Error('Invalid resource launcher compatibility configuration'); },
    });
    expect(readings.get('grok')).toEqual({
      version: null,
      status: 'unavailable',
      reason: 'launcher-process-failed',
    });
  });

  it('stops early when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const readings = await probeVerseAccountCliVersions({
      accountsRoot: '/unused',
      signal: controller.signal,
      readLaunches: () => [
        { id: 'a', provider: 'codex', command: ['/usr/bin/node', '/p/launcher.mjs'], cwd: '/p/native-state' },
      ],
      check: async () => { throw new Error('should never be called'); },
    });
    expect(readings.size).toBe(0);
  });
});

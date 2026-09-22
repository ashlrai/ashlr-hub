/**
 * mcp-contract.test.ts — the client-side seam.
 *
 * The facts pinned here are the ones a naive projection gets wrong in a way
 * that is dangerous rather than merely ugly:
 *
 *   1. The env redaction is RE-APPLIED, not trusted. If a server regression
 *      ever shipped a real value, this layer still prints '<set>'.
 *   2. A missing version stays null. `usedPercent`-style coercion to a
 *      placeholder string would make "not read" indistinguishable from a
 *      reading, which is the specific lie this surface exists to avoid.
 *   3. `driftDetected` is derived locally as well as read, so a server that
 *      forgot the flag still raises the alert.
 *   4. A body of the wrong shape degrades to null rather than throwing at
 *      render time.
 */
import { describe, expect, it } from 'vitest';
import {
  SEAT_REASON_COPY,
  narrowServer,
  projectCliHealth,
  projectMcpSnapshot,
  reasonSentence,
} from './mcp-contract.js';

describe('narrowServer', () => {
  it('re-applies the env redaction rather than trusting the wire', () => {
    const server = narrowServer({
      name: 'weather',
      command: '/usr/local/bin/weather',
      args: ['--serve'],
      // A server regression: a REAL value arrives where '<set>' should be.
      env: { API_KEY: 'REDACTION-CANARY-C' },
      sourceRef: '.ashlr/settings.json',
    });
    expect(server?.env).toEqual({ API_KEY: '<set>' });
    expect(JSON.stringify(server)).not.toContain('REDACTION-CANARY-C');
  });

  it('shows the command and args in full', () => {
    const server = narrowServer({
      name: 'x', command: '/bin/x', args: ['--a', '--b'], sourceRef: '.mcp.json',
    });
    expect(server?.command).toBe('/bin/x');
    expect(server?.args).toEqual(['--a', '--b']);
  });

  it('drops a row with no usable command instead of rendering a blank', () => {
    expect(narrowServer({ name: 'x', sourceRef: '.mcp.json' })).toBeNull();
    expect(narrowServer(null)).toBeNull();
    expect(narrowServer('nope')).toBeNull();
  });

  it('treats an empty env object as no env at all', () => {
    expect(narrowServer({ name: 'x', command: '/bin/x', env: {} })?.env).toBeNull();
  });
});

describe('projectMcpSnapshot', () => {
  const body = {
    sampledAt: '2026-01-01T00:00:00.000Z',
    seats: [
      { seatId: 'claude', label: 'Claude Code', engine: 'claude', accountId: 'claude', servers: [], reason: 'mcp-seat-isolated-by-adapter', configFile: null, configFormat: null, notes: ['n'] },
    ],
    machine: {
      servers: [{ name: 'house', command: '/usr/bin/house', args: [], env: { T: '<set>' }, sourceRef: '.mcp.json' }],
      configured: true,
      note: 'nobody reads these',
    },
    scope: { available: true, pinned: true, aliasRef: 'acme', tenantRef: 'tenant_1', principalRef: 'p1', reason: 'mcp-scope-pinned' },
    notes: ['1 MCP server is configured on this machine and no Verse seat loads any of them.'],
  };

  it('keeps the seat/machine split intact', () => {
    const snapshot = projectMcpSnapshot(body);
    expect(snapshot?.seats[0]!.servers).toEqual([]);
    expect(snapshot?.machine.servers).toHaveLength(1);
    expect(snapshot?.machine.configured).toBe(true);
    expect(snapshot?.notes[0]).toContain('no Verse seat loads any of them');
  });

  it('carries Locus references through unchanged', () => {
    expect(projectMcpSnapshot(body)?.scope).toEqual({
      available: true, pinned: true, aliasRef: 'acme', tenantRef: 'tenant_1',
      principalRef: 'p1', reason: 'mcp-scope-pinned',
    });
  });

  it('degrades to null on a body of the wrong shape', () => {
    expect(projectMcpSnapshot(null)).toBeNull();
    expect(projectMcpSnapshot({ seats: 'nope' })).toBeNull();
    expect(projectMcpSnapshot([])).toBeNull();
  });

  it('survives a snapshot with no scope at all', () => {
    const snapshot = projectMcpSnapshot({ ...body, scope: null });
    expect(snapshot?.scope).toBeNull();
    expect(snapshot?.seats).toHaveLength(1);
  });
});

describe('projectCliHealth', () => {
  it('keeps an unread version null rather than coercing it', () => {
    const health = projectCliHealth({
      sampledAt: null,
      accounts: [{ accountId: 'claude', label: 'Claude', provider: 'claude', authentication: 'signed-in', state: 'observed', planType: 'max', reason: 'probe-observed', version: null, pinnedVersion: '2.1.257', versionState: 'unverified', usageBlockedByPin: false, notes: [] }],
      driftDetected: false,
      notes: [],
    });
    expect(health?.accounts[0]!.version).toBeNull();
    expect(health?.accounts[0]!.versionState).toBe('unverified');
    expect(health?.driftDetected).toBe(false);
  });

  it('raises drift locally even if the server forgot the flag', () => {
    const health = projectCliHealth({
      accounts: [{ accountId: 'claude', label: 'Claude', provider: 'claude', authentication: 'signed-in', state: 'observed', planType: null, reason: 'usage-version-unsupported', version: null, pinnedVersion: '2.1.257', versionState: 'drift', usageBlockedByPin: true, notes: [] }],
      // The flag is ABSENT on purpose.
    });
    expect(health?.driftDetected).toBe(true);
  });

  it('degrades to null on a body of the wrong shape', () => {
    expect(projectCliHealth({ accounts: 7 })).toBeNull();
    expect(projectCliHealth(undefined)).toBeNull();
  });
});

describe('reasonSentence', () => {
  it('returns prose for a known code', () => {
    expect(reasonSentence(SEAT_REASON_COPY, 'mcp-seat-isolated-by-adapter', 'fallback'))
      .toContain('loads no MCP servers at all');
  });

  it('never prints an unknown raw code as the sentence', () => {
    expect(reasonSentence(SEAT_REASON_COPY, 'mcp-something-new', 'fallback')).toBe('fallback');
  });
});

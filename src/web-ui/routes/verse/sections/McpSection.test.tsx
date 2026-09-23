/**
 * sections/McpSection.test.tsx — the MCP rail section, rendered against the
 * SERVER'S OWN response types.
 *
 * The two fixtures below are annotated `VerseMcpSnapshot` and
 * `VerseCliHealthSnapshot`, the exact types `GET /api/verse/mcp` and
 * `GET /api/verse/mcp/cli-health` serialize (src/core/verse/mcp-seat-view.ts,
 * mcp-cli-health.ts). That is deliberate and it is the point of the file: a
 * field rename on the server breaks `npm run typecheck:web` HERE rather than
 * blanking a panel at runtime, and it means "this renders" is a claim about
 * the real wire shape, not about a hand-rolled object that happened to match.
 *
 * Type-only imports, like mcp-contract.ts — a value import of anything under
 * src/core drags node:fs into the browser bundle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { VerseCliHealthSnapshot } from '../../../../core/verse/mcp-cli-health.js';
import type { VerseMcpSnapshot } from '../../../../core/verse/mcp-seat-view.js';
import { evictAll } from '../../../data/cache.js';
import { McpSection } from './McpSection.js';

const SNAPSHOT: VerseMcpSnapshot = {
  sampledAt: '2026-09-22T10:00:00.000Z',
  seats: [
    {
      seatId: 'claude-main',
      label: 'Claude Max',
      engine: 'claude',
      accountId: 'claude-main',
      servers: [],
      reason: 'mcp-seat-isolated-by-adapter',
      configFile: null,
      configFormat: null,
      notes: ['Every turn on this seat is launched with --strict-mcp-config.'],
    },
    {
      seatId: 'codex-personal',
      label: 'Personal Codex',
      engine: 'codex',
      accountId: 'codex-personal',
      servers: [
        {
          name: 'ashlr',
          command: 'bun',
          args: ['/Users/x/.claude/plugins/ashlr/mcp/server.ts'],
          env: { ASHLR_TOKEN: '<set>' },
          sourceRef: '.ashlr/settings.json',
        },
      ],
      reason: 'mcp-account-config-read',
      configFile: 'config.toml',
      configFormat: 'toml',
      notes: [],
    },
    {
      seatId: 'local',
      label: 'Local seats (every Ollama tag)',
      engine: 'local',
      accountId: 'local',
      servers: [],
      reason: 'mcp-seat-isolated-by-adapter',
      configFile: null,
      configFormat: null,
      notes: [],
    },
  ],
  machine: {
    servers: [],
    configured: true,
    note: 'These are configured on this machine and read by no Verse seat.',
  },
  scope: {
    available: true,
    pinned: true,
    aliasRef: 'ashlr',
    tenantRef: 'tenant_abc',
    principalRef: 'me',
    bindingRef: 'binding_1',
    sealOk: true,
    expired: false,
    frozen: false,
    expiresAt: '2026-09-23T10:00:00.000Z',
    status: 'pinned: ashlr',
    statusOneline: 'ashlr · tenant_abc',
    reason: 'mcp-scope-pinned',
  },
  notes: ['Servers are configured on this machine, and no Verse seat loads any of them.'],
};

const HEALTH: VerseCliHealthSnapshot = {
  sampledAt: '2026-09-22T10:00:00.000Z',
  accounts: [
    {
      accountId: 'claude-main',
      label: 'Claude Max',
      provider: 'claude',
      authentication: 'signed-in',
      state: 'observed',
      health: 'reachable',
      planType: 'max',
      observedAt: '2026-09-22T09:59:00.000Z',
      reason: 'claude-cli-version-mismatch',
      version: '2.1.279',
      pinnedVersion: '2.1.280',
      versionState: 'drift',
      usageBlockedByPin: true,
      notes: ['This is a version pin, not an outage.'],
    },
  ],
  driftDetected: true,
  notes: [],
};

function stubFetch(opts: { snapshot?: unknown; health?: unknown; snapshot404?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url === '/api/verse/mcp') {
        if (opts.snapshot404 === true) return new Response('not found', { status: 404 });
        return json(opts.snapshot ?? SNAPSHOT);
      }
      if (url === '/api/verse/mcp/cli-health') return json(opts.health ?? HEALTH);
      return new Response('not found', { status: 404 });
    }),
  );
}

beforeEach(() => {
  evictAll();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('McpSection', () => {
  it('renders every seat from the server’s own snapshot shape, with what each would load', async () => {
    stubFetch();
    render(<McpSection />);

    // Both panels are fed, from two separate routes: the seat appears once
    // under "Per seat" and once under "Per account".
    expect(await screen.findAllByText('Claude Max')).toHaveLength(2);
    expect(screen.getByText('Personal Codex')).toBeInTheDocument();

    // A seat that loads nothing SAYS nothing, rather than showing an empty list.
    expect(screen.getAllByText('loads no MCP servers')).toHaveLength(2); // claude + local
    expect(screen.getByText('loads 1 server')).toBeInTheDocument();

    // The disclosure card, with the env VALUE never printed.
    expect(screen.getByText('bun /Users/x/.claude/plugins/ashlr/mcp/server.ts')).toBeInTheDocument();
    expect(screen.getByText('ASHLR_TOKEN=<set>')).toBeInTheDocument();
    expect(screen.getByText('configured in .ashlr/settings.json')).toBeInTheDocument();

    // Per-account CLI health, and the drift alert quoting the pin.
    const drift = screen.getByRole('alert');
    expect(drift).toHaveTextContent('Version drift');
    expect(screen.getByText('usage probe pinned to 2.1.280 · claude-cli-version-mismatch'))
      .toBeInTheDocument();
  });

  it('discloses that an MCP write can be refused on an unenrolled folder, and says which seats', async () => {
    // THE UNDISCLOSED FOOTGUN this block exists for. Claude/local seats launch
    // with `--strict-mcp-config --mcp-config {"mcpServers":{}}`
    // (src/core/verse/adapters/claude.ts), so they load no MCP at all. Codex and
    // Grok add no such flag and inherit their own native profile config, so a
    // turn on those seats CAN reach an `ashlr__*` MCP write tool — which
    // assertMayMutate (src/core/sandbox/policy.ts) refuses when the chat's
    // folder is not enrolled. Nothing else in Verse says this anywhere.
    stubFetch();
    render(<McpSection />);

    const CAVEAT = { name: 'MCP writes can be refused on a folder that is not enrolled' };
    const note = await screen.findByRole('note', CAVEAT);
    expect(note).toHaveTextContent('MCP writes can be refused on a folder that is not enrolled');

    // Unaffected seats are named as unaffected — not merely left out.
    expect(note).toHaveTextContent(/Claude and local seats are unaffected/);
    expect(within(note).getByText('--strict-mcp-config --mcp-config {"mcpServers":{}}'))
      .toBeInTheDocument();

    // Affected seats are named, with the consequence and the two ways out.
    expect(note).toHaveTextContent(/Codex and Grok seats are affected/);
    expect(note).toHaveTextContent(/ashlr__ MCP write tool/);
    expect(note).toHaveTextContent(/the turn fails on policy, not on the model/);
    expect(note).toHaveTextContent(/Enrol the folder first, or keep that chat on a Claude or local seat/);
  });

  it('keeps the caveat visible when the reads are unavailable, because it is still true', async () => {
    // A 404 degrades the panel (optionalGet), it does not blank it — and the
    // seat difference does not depend on any read having succeeded.
    stubFetch({ snapshot404: true });
    render(<McpSection />);

    expect(await screen.findByText('This server does not expose /api/verse/mcp, so this panel has no source.'))
      .toBeInTheDocument();
    expect(
      screen.getByRole('note', { name: 'MCP writes can be refused on a folder that is not enrolled' }),
    ).toHaveTextContent('Codex and Grok seats are affected');
  });
});

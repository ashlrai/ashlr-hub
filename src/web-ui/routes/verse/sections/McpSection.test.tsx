/**
 * sections/McpSection.test.tsx — MCP folded into Apps & Accounts
 * (SPEC-310C §0.1, §4). The legacy `mcp` entry point (a stored v2 section, or
 * the shell's fallback while AppsSection loads) must land on the SAME page's
 * MCP group — one implementation, never two MCP views that could drift — and
 * everything the old section refused to soften must still be said there:
 * the "configured, but unused" fact, the version-drift alert quoting the pin,
 * the standing caveat about which seats load MCP, and no env value ever.
 *
 * Fixtures are typed with the server's own snapshot types
 * (apps.test-support.ts), so a server field rename breaks this at compile time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseCliHealthSnapshot } from '../../../../core/verse/mcp-cli-health.js';
import { evictAll } from '../../../data/cache.js';
import { MCP, stubAppsFetch } from '../apps/apps.test-support.js';
import { McpSection } from './McpSection.js';

const DRIFT: VerseCliHealthSnapshot = {
  sampledAt: '2026-09-22T10:00:00.000Z',
  accounts: [
    {
      accountId: 'claude-a', label: 'Claude Max', provider: 'claude', authentication: 'signed-in', state: 'observed', health: 'reachable',
      planType: 'max', observedAt: 'x', reason: 'claude-cli-version-mismatch', version: '2.1.279', pinnedVersion: '2.1.280',
      versionState: 'drift', usageBlockedByPin: true, notes: ['This is a version pin, not an outage.'],
    },
  ],
  driftDetected: true,
  notes: ['A pinned CLI version differs from the installed one.'],
};

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

describe('McpSection (folded into Apps & Accounts)', () => {
  it('renders the Apps page and focuses its MCP group', async () => {
    stubAppsFetch();
    render(<McpSection />);
    const heading = await screen.findByRole('heading', { name: 'MCP servers' });
    expect(heading).toHaveFocus();
    // The rest of the page is there too: it is the same page, not a copy.
    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeInTheDocument();
  });

  it('keeps every fact the old section refused to soften', async () => {
    stubAppsFetch();
    const drift = DRIFT;
    const fetchWithDrift = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/verse/mcp/cli-health') {
        return new Response(JSON.stringify(drift), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return fetchWithDrift(input, init);
    }));
    const user = userEvent.setup();
    render(<McpSection />);
    const group = await screen.findByRole('region', { name: 'MCP servers' });

    expect(await within(group).findByRole('note')).toHaveTextContent(`Configured, but unused. ${MCP.notes[0]} ${MCP.machine.note}`);
    expect(await within(group).findByRole('alert')).toHaveTextContent('Claude Max: 2.1.279, pinned 2.1.280.');
    expect(within(group).getByText(/Claude and local seats load no MCP servers/)).toBeInTheDocument();
    expect(within(group).getByText(/refused on a folder that is not enrolled/)).toBeInTheDocument();

    await user.click(within(group).getByRole('button', { name: 'Show servers' }));
    expect(within(group).getByText('bun server.ts')).toBeInTheDocument();
    expect(within(group).getByText('ASHLR_TOKEN=<set>')).toBeInTheDocument();
    expect(within(group).getByText(/Writes are attributed to the pinned Locus tenant/)).toBeInTheDocument();
  });

  it('keeps the caveat when the read is unavailable, because it is still true', async () => {
    stubAppsFetch({ mcp: 404 });
    render(<McpSection />);
    const group = await screen.findByRole('region', { name: 'MCP servers' });
    expect(within(group).getByText(/Claude and local seats load no MCP servers/)).toBeInTheDocument();
    expect(await within(group).findByText(/This server does not expose \/api\/verse\/mcp/)).toBeInTheDocument();
  });
});

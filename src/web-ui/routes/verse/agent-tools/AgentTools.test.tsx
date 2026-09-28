/**
 * Agent tools UI (3.15) — the sheet and the strip above the composer, on a
 * fake API.
 *
 *   - the sheet shows the chat's grant and changes it through the token gate;
 *     a seat that cannot use the tools (Devin cloud) says why and disables them;
 *   - the strip renders nothing while tools are off; with tools on it shows the
 *     recent actions, a destructive command's card with [Allow once]
 *     [Allow for chat] [Deny], and "Resume agent" for a taken-over terminal.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseAgentToolsActivity, VerseAgentToolsState } from '../../../../core/verse/verse-mcp-types.js';
import { VERSE_AGENT_TOOLS_OFF } from '../../../../core/verse/verse-mcp-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import type { AgentToolsApi } from './agent-tools-client.js';
import { AgentToolsSheet } from './AgentToolsSheet.js';
import { AgentToolsStrip } from './AgentToolsStrip.js';

function state(over: Partial<VerseAgentToolsState> = {}): VerseAgentToolsState {
  return {
    sessionId: 's-1',
    seatLabel: 'Codex',
    grant: { ...VERSE_AGENT_TOOLS_OFF, computerApps: [] },
    scopes: [],
    sharedTabs: [],
    support: { supported: true, transport: 'stdio', note: 'Loaded through Ashlr\'s stdio bridge for each turn.' },
    desktop: true,
    turnActive: false,
    ...over,
  };
}

function fakeApi(initial: VerseAgentToolsState, activity: VerseAgentToolsActivity = { sessionId: 's-1', pending: [], actions: [], tabs: [] }) {
  let current = initial;
  const api: AgentToolsApi = {
    state: vi.fn(async () => current),
    setGrant: vi.fn(async (req) => {
      const { sessionId: _s, ...patch } = req;
      current = { ...current, grant: { ...current.grant, ...patch }, scopes: patch.terminal && patch.terminal !== 'off' ? ['terminal'] : current.scopes };
      return current;
    }),
    activity: vi.fn(async () => activity),
    confirm: vi.fn(async () => {}),
    share: vi.fn(async () => current),
    resume: vi.fn(async () => {}),
    tabs: vi.fn(async () => ({ tabs: [] })),
  };
  return api;
}

beforeEach(() => setMutationToken('a'.repeat(64)));
afterEach(() => clearMutationToken());

describe('AgentToolsSheet', () => {
  it('shows the grant and changes it', async () => {
    const api = fakeApi(state());
    render(<AgentToolsSheet sessionId="s-1" open onClose={() => {}} api={api} />);
    expect(await screen.findByText(/What Codex may do on this Mac/)).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Agent tabs' }));
    await waitFor(() => expect(api.setGrant).toHaveBeenCalledWith({ sessionId: 's-1', terminal: 'agent' }));
    expect(await screen.findByText(/opens its own terminal tabs/)).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Act: localhost' }));
    await waitFor(() => expect(api.setGrant).toHaveBeenCalledWith({ sessionId: 's-1', browser: 'act-localhost' }));
  });

  it('a seat that cannot reach the tools says why, and nothing can be switched on', async () => {
    const api = fakeApi(state({ seatLabel: 'Devin', support: { supported: false, reason: 'Devin cloud runs on Cognition\'s machines and cannot reach tools on this Mac.' } }));
    render(<AgentToolsSheet sessionId="s-1" open onClose={() => {}} api={api} />);
    expect(await screen.findByText(/cannot reach tools on this Mac/)).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Agent tabs' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('AgentToolsStrip', () => {
  it('renders nothing while tools are off', async () => {
    const api = fakeApi(state());
    render(<AgentToolsStrip sessionId="s-1" api={api} />);
    await waitFor(() => expect(api.state).toHaveBeenCalled());
    expect(screen.queryByTestId('agent-tools-strip')).toBeNull();
    expect(api.activity).not.toHaveBeenCalled();
  });

  it('with tools on: recent actions, a confirmation card answered through the gate, and Resume agent', async () => {
    const now = Date.parse('2026-09-27T12:00:00.000Z');
    const api = fakeApi(state({ scopes: ['terminal'], grant: { ...VERSE_AGENT_TOOLS_OFF, terminal: 'agent', computerApps: [] } }), {
      sessionId: 's-1',
      pending: [{ id: 'cf_AAAAAAAAAAAA', sessionId: 's-1', at: new Date(now).toISOString(), expiresAt: new Date(now + 90_000).toISOString(), tool: 'terminal_run', rule: 'rm-recursive', reason: 'It deletes files recursively without asking (rm -rf).', command: 'rm -rf build', tabId: 't-1' }],
      actions: [{ id: 'aa_1', at: new Date(now).toISOString(), tool: 'terminal_run', summary: 'npm test', tabId: 't-1', outcome: 'ok' }],
      tabs: [{ tabId: 't-1', sessionId: 's-1', kind: 'agent', takenOverAt: new Date(now).toISOString() }],
    });
    render(<AgentToolsStrip sessionId="s-1" api={api} now={() => now} />);
    expect(await screen.findByText('rm -rf build')).toBeTruthy();
    expect(screen.getByText(/Codex wants to run/)).toBeTruthy();
    expect(screen.getByText(/90s left/)).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Allow for chat' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith('s-1', 'cf_AAAAAAAAAAAA', 'chat'));
    await userEvent.click(screen.getByRole('button', { name: 'Resume agent' }));
    await waitFor(() => expect(api.resume).toHaveBeenCalledWith('t-1'));
  });
});

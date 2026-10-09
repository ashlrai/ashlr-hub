import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ProactiveProfile, ProactiveProfileInput } from '../../../../core/proactive/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN, type RecordedCall } from '../context/context-fixtures.test-support.js';
import { ProactiveAgents } from './ProactiveAgents.js';

const NOW = '2026-10-09T08:00:00.000Z';
function profile(over: Partial<ProactiveProfile> = {}): ProactiveProfile {
  return { id: 'pa_aaaaaaaaaaaaaaaa', version: 1, identity: { provider: 'openai-dot', accountId: 'account-one', agentId: 'dot-one' },
    displayName: 'Build companion', responsibility: 'Watch deployments', avatar: { color: '#5a59ef', variant: 'classic' },
    computer: { kind: 'unknown', label: '', providerComputerId: null }, services: [], fundingReference: null, enabled: false,
    connection: 'configured', lastRun: null, createdAt: NOW, updatedAt: NOW,
    operations: { dispatch: { state: 'unverified', verifiedAt: null, note: 'No qualified transport.' },
      status: { state: 'unsupported', verifiedAt: null, note: 'No status interface.' },
      cancel: { state: 'unsupported', verifiedAt: null, note: 'No cancel interface.' },
      result: { state: 'unsupported', verifiedAt: null, note: 'No result interface.' } }, ...over };
}
function server(initial: ProactiveProfile[] = [], override?: (call: RecordedCall) => Response | undefined) {
  let profiles = initial;
  const { calls } = installFetch(call => {
    const custom = override?.(call); if (custom) return custom;
    if (call.path === '/api/verse/proactive-agents' && call.method === 'GET') return json({ schemaVersion: 1, profiles });
    if (call.path === '/api/verse/proactive-agents' && call.method === 'POST') {
      const input = call.body as ProactiveProfileInput; const saved = profile({ ...input, id: 'pa_created', version: 1 });
      profiles = [...profiles, saved]; return json({ profile: saved }, 201);
    }
    if (call.path.endsWith('/delete') && call.method === 'POST') { profiles = []; return json({ ok: true }); }
    if (call.path.startsWith('/api/verse/proactive-agents/') && call.method === 'POST') {
      const { expectedVersion: _expected, ...patch } = call.body as { expectedVersion: number } & Partial<ProactiveProfile>;
      const saved = { ...profiles[0]!, ...patch, version: profiles[0]!.version + 1 }; profiles = [saved]; return json({ profile: saved });
    }
    return json({ error: 'not found' }, 404);
  });
  return { calls, update: (next: ProactiveProfile[]) => { profiles = next; } };
}
beforeEach(() => { evictAll(); clearMutationToken(); setMutationToken(TEST_TOKEN); });
afterEach(() => { evictAll(); clearMutationToken(); vi.unstubAllGlobals(); });

async function edit() { fireEvent.click(await screen.findByRole('button', { name: 'Edit Build companion' })); return screen.getByRole('dialog', { name: 'Edit Build companion' }); }
describe('proactive agent profiles', () => {
  it('shows an empty setup state without asserting connection or spending', async () => {
    server(); render(<ProactiveAgents />);
    await screen.findByText('Bring your persistent agents together');
    expect(screen.getByText(/connections, execution and funding are verified separately/)).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
  it('offers official provider setup while keeping profile metadata distinct from commissioned transport', async () => {
    const { calls } = server([profile(), profile({ id: 'pa_grok', identity: { provider: 'grok-bot', accountId: 'account-grok', agentId: 'bot-one' } }),
      profile({ id: 'pa_meta', identity: { provider: 'meta-muse', accountId: 'account-meta', agentId: 'muse-one' } })]);
    render(<ProactiveAgents />);
    expect(await screen.findByRole('link', { name: 'OpenAI plugin events setup ↗' })).toHaveAttribute('href', 'https://developers.openai.com/plugins/build/mcp-events');
    expect(screen.getByRole('link', { name: 'Grok Bot routine setup ↗' })).toHaveAttribute('href', 'https://cursor.com/help/grok-bot/routines');
    expect(screen.getByRole('link', { name: 'Meta Muse product guide ↗' })).toHaveAttribute('href', 'https://ai.meta.com/muse/');
    expect(screen.getByText(/Meta Model API funding does not connect your personal Muse/)).toBeInTheDocument();
    expect(screen.getByText('Bot allowance and reset unknown · separate from Grok Build.')).toBeVisible();
    expect(calls.every(call => call.method === 'GET' && call.path === '/api/verse/proactive-agents')).toBe(true);
  });
  it('refuses unsupported response versions instead of advertising an invented connection', async () => {
    server([], call => call.method === 'GET' ? json({ schemaVersion: 2, profiles: [profile()] }) : undefined);
    render(<ProactiveAgents />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent profiles are unavailable');
    expect(screen.queryByRole('heading', { name: 'Build companion' })).not.toBeInTheDocument();
  });
  it('keeps unavailable reads distinct from an empty account list', async () => {
    server([], call => call.method === 'GET' ? json({ code: 'UNAVAILABLE', error: 'Private records unavailable.' }, 503) : undefined);
    render(<ProactiveAgents />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent profiles are unavailable');
    expect(screen.queryByText('Bring your persistent agents together')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add agent' })).toBeDisabled();
  });
  it('persists an actual profile with normalized stable identity and a saved planning preference, without claiming capabilities', async () => {
    const { calls } = server(); render(<ProactiveAgents />); await screen.findByText('Bring your persistent agents together');
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a proactive agent' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'My Dot' } });
    fireEvent.change(within(dialog).getByLabelText('Account identity'), { target: { value: '  account-two  ' } });
    fireEvent.change(within(dialog).getByLabelText('Agent identity'), { target: { value: ' dot-two ' } });
    fireEvent.change(within(dialog).getByLabelText('Responsibility'), { target: { value: 'Improve Phantom' } });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Save planning preference' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }));
    await screen.findByRole('heading', { name: 'My Dot' });
    const post = calls.find(call => call.method === 'POST')!;
    expect(post.headers['x-ashlr-token']).toBe(TEST_TOKEN);
    expect(post.body).toMatchObject({ identity: { provider: 'openai-dot', accountId: 'account-two', agentId: 'dot-two' }, responsibility: 'Improve Phantom', enabled: true, fundingReference: null });
    expect(screen.getByText('Planning preference on')).toBeInTheDocument();
    expect(screen.getByText('Configured profile; transport unverified')).toBeInTheDocument();
    expect(screen.getByText('No qualified run evidence')).toBeInTheDocument();
  });
  it('updates only editable fields with the exact saved CAS version and same-account funding reference', async () => {
    const { calls } = server([profile({ version: 7 })]); render(<ProactiveAgents />); const dialog = await edit();
    expect(within(dialog).getByLabelText('Provider')).toBeDisabled();
    expect(within(dialog).getByLabelText('Account identity')).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Release partner' } });
    fireEvent.change(within(dialog).getByLabelText('Funding kind'), { target: { value: 'promotional-api' } });
    fireEvent.change(within(dialog).getByLabelText('Pool identity'), { target: { value: 'pool-one' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }));
    await screen.findByRole('heading', { name: 'Release partner' });
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ expectedVersion: 7, displayName: 'Release partner', fundingReference: { kind: 'promotional-api', accountId: 'account-one', poolId: 'pool-one' } });
    expect(calls.find(call => call.method === 'POST')?.body).not.toHaveProperty('identity');
  });
  it('preserves stale drafts, refuses repeated overwrite, and requires explicit latest reload', async () => {
    const api = server([profile()], call => call.method === 'POST' ? json({ code: 'CONFLICT', error: 'Profile changed.' }, 409) : undefined);
    render(<ProactiveAgents />); const dialog = await edit();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'My unsaved name' } });
    api.update([profile({ version: 2, displayName: 'Other window name' })]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }));
    await within(dialog).findByRole('alert');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('My unsaved name');
    expect(within(dialog).getByRole('button', { name: 'Save profile' })).toBeDisabled();
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Load latest profile' }));
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Other window name');
  });
  it('asks only for the existing mutation token and sends no profile without it', async () => {
    clearMutationToken(); const { calls } = server([profile()]); render(<ProactiveAgents />); const dialog = await edit();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('dialog', { name: /Unlock/i })).toBeInTheDocument();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it('deletes only the saved profile revision and does not cancel its provider agent', async () => {
    const { calls } = server([profile({ version: 3 })]); render(<ProactiveAgents />); const dialog = await edit();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete profile' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete this profile?' });
    expect(confirm).toHaveTextContent('It does not stop or delete the provider’s agent');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete agent profile' }));
    await screen.findByText('Agent profile deleted.');
    expect(calls.filter(call => call.method === 'POST').map(call => ({ path: call.path, body: call.body }))).toEqual([{ path: '/api/verse/proactive-agents/pa_aaaaaaaaaaaaaaaa/delete', body: { expectedVersion: 3 } }]);
  });
});

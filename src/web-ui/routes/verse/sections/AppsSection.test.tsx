/**
 * sections/AppsSection.test.tsx — Apps & Accounts end to end in the page,
 * against the server's own wire types (apps.test-support.ts), driven the way
 * the operator drives it: by keyboard and by click.
 *
 * SPEC-310C §7 C6 test points covered here:
 *   - the toggle requires confirm:true (the switch alone sends nothing; the
 *     dialog shows the command AND --restore; only its button posts);
 *   - copy shows ✓ (for 1.2 s, then back);
 *   - ONE shared CapacityStrip carries the Accounts group;
 *   - Launch goes to Terminal.app with the chosen folder / via / model;
 *   - MCP folded in: the caveat, the per-seat view, and the digest-bound Add;
 *   - 375 (C0's viewport mock) and a read-only server (404 routes) degrade,
 *     never blank.
 * Nothing here spends or opens anything: fetch is stubbed and every POST is
 * recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { mockCompactViewport } from '../shell/viewport.test-support.js';
import { stubAppsFetch, type Recorded } from '../apps/apps.test-support.js';
import { AppsSection } from './AppsSection.js';

const TOKEN = 'test-token';

beforeEach(() => {
  evictAll();
  setMutationToken(TOKEN);
});
afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function posts(calls: Recorded[]): Recorded[] {
  return calls.filter((c) => c.method === 'POST');
}

async function renderPage() {
  render(<AppsSection />);
  await screen.findByRole('heading', { name: 'Terminal agents' });
}

describe('AppsSection — layout', () => {
  it('shows the five groups in SPEC order, with a word for every state', async () => {
    stubAppsFetch();
    await renderPage();
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles.filter((t) => ['Accounts', 'Desktop', 'Terminal agents', 'Local models', 'MCP servers'].includes(t ?? '')))
      .toEqual(['Accounts', 'Desktop', 'Terminal agents', 'Local models', 'MCP servers']);

    const agents = screen.getByRole('region', { name: 'Terminal agents' });
    expect(within(agents).getByText('2.1.280')).toBeInTheDocument();
    expect(within(agents).getAllByText('installed').length).toBe(3);
    expect(within(agents).getByText('not installed')).toBeInTheDocument();
    // `ollama launch` pills only where the installed Ollama lists the agent.
    expect(within(agents).getByRole('button', { name: /Copy the Ollama launch command for Codex: ollama launch codex/ })).toBeInTheDocument();
    expect(within(agents).queryByRole('button', { name: /Ollama launch command for Grok/ })).not.toBeInTheDocument();
    // Not installed: Launch is replaced by why, never offered.
    expect(within(agents).getByText('Not installed. Running ollama launch opencode yourself can install it.')).toBeInTheDocument();
    expect(within(agents).queryByRole('button', { name: 'Launch OpenCode' })).not.toBeInTheDocument();

    const local = screen.getByRole('region', { name: 'Local models' });
    expect(within(local).getByText('4 models · 1 loaded · ≈8.5 tok/s end to end, last local turn')).toBeInTheDocument();
    expect(screen.getByText('checked 2 min ago')).toBeInTheDocument();
  });

  it('Accounts is the shared capacity strip with plan, connection, bars, reserve, and the seat’s one action', async () => {
    stubAppsFetch();
    await renderPage();
    const accounts = screen.getByRole('region', { name: 'Accounts' });
    await within(accounts).findByText(/Reserved for you 40%/);
    expect(within(accounts).getByText('older CLI pinned')).toBeInTheDocument();
    // Each account leads with a sentence-case status; signed out says what to do.
    expect(within(accounts).getByText('Signed out')).toBeInTheDocument();
    expect(within(accounts).getByText('· reconnect to use it')).toBeInTheDocument();
    expect(within(accounts).getByRole('img', { name: /Claude Max weekly fable window: 92% used; 40% kept for you/ })).toBeInTheDocument();
    // Signed out → Reconnect; skewed CLI → Fix; every paid seat → Edit budget.
    expect(within(accounts).getByRole('button', { name: 'Reconnect: Grok' })).toBeInTheDocument();
    expect(within(accounts).getByRole('button', { name: 'Fix: Claude Max' })).toBeInTheDocument();
    expect(within(accounts).getAllByRole('button', { name: /^Edit budget:/ })).toHaveLength(2);
    // The local seat needs none of them.
    expect(within(accounts).queryByRole('button', { name: /Qwen3 Coder/ })).not.toBeInTheDocument();
  });

  it('Reconnect opens the seat’s own sign-in through the health route, with the token', async () => {
    const calls = stubAppsFetch();
    const user = userEvent.setup();
    await renderPage();
    await user.click(await screen.findByRole('button', { name: 'Reconnect: Grok' }));
    await waitFor(() => expect(posts(calls).map((c) => c.url)).toContain('/api/verse/health/reconnect'));
    const call = posts(calls).find((c) => c.url === '/api/verse/health/reconnect')!;
    expect(call.body).toEqual({ seatId: 'grok' });
    expect(call.token).toBe(TOKEN);
    expect(await screen.findByText(/Opened the sign-in for Grok in Terminal/)).toBeInTheDocument();
  });

  it('Fix shows the command to copy and runs nothing', async () => {
    const calls = stubAppsFetch();
    const user = userEvent.setup();
    await renderPage();
    await user.click(await screen.findByRole('button', { name: 'Fix: Claude Max' }));
    const dialog = await screen.findByRole('dialog', { name: 'Fix Claude Max' });
    expect(within(dialog).getByRole('button', { name: /Copy the fix for Claude Max: ashlr resources profile repin/ })).toBeInTheDocument();
    expect(within(dialog).getByText(/never runs it for you/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Fix Claude Max' })).not.toBeInTheDocument();
    expect(posts(calls)).toEqual([]);
  });

  it('Edit budget opens the BudgetControl in a sheet', async () => {
    stubAppsFetch();
    const user = userEvent.setup();
    await renderPage();
    await user.click((await screen.findAllByRole('button', { name: /^Edit budget:/ }))[0]!);
    const sheet = await screen.findByRole('dialog', { name: 'Budget' });
    expect(await within(sheet).findByRole('radiogroup', { name: 'Budget mode' }).catch(() => within(sheet).findByText('Balanced'))).toBeInTheDocument();
  });
});

describe('AppsSection — copy pill', () => {
  it('copies the command and shows ✓ for 1.2 s, announced to screen readers', async () => {
    stubAppsFetch();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderPage();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pill = screen.getByRole('button', { name: 'Copy the Codex command: codex' });
    await act(async () => { pill.click(); });
    expect(writeText).toHaveBeenCalledWith('codex');
    expect(pill).toHaveAttribute('data-state', 'copied');
    expect(screen.getByText('Copied')).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1_250); });
    expect(pill).toHaveAttribute('data-state', 'idle');
  });
});

describe('AppsSection — desktop switches need confirm:true', () => {
  it('the switch only opens the confirmation; Cancel sends nothing', async () => {
    const calls = stubAppsFetch();
    const user = userEvent.setup();
    await renderPage();
    const toggle = screen.getByRole('switch', { name: /Use Ollama models in Claude Desktop: off/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    const dialog = await screen.findByRole('dialog');
    // Both commands, verbatim, and the recommendation against it.
    expect(within(dialog).getByRole('button', { name: /Copy the command this runs: ollama launch claude-desktop$/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Copy the restore command: ollama launch claude-desktop --restore/ })).toBeInTheDocument();
    expect(within(dialog).getByText(/Recommended: leave this off/)).toBeInTheDocument();
    // Focus starts on Cancel, the safe choice.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts(calls)).toEqual([]);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('confirming posts {enabled, confirm:true} with the token', async () => {
    const calls = stubAppsFetch();
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('switch', { name: /Use Ollama models in Claude Desktop/ }));
    await user.click(await screen.findByRole('button', { name: 'Open in Terminal' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ url: '/api/verse/apps/claude-desktop/toggle', body: { enabled: true, confirm: true }, token: TOKEN });
    expect(await screen.findByText(/Answer its prompts there/)).toBeInTheDocument();
  });

  it('Restore goes through the same confirmation, the other way', async () => {
    const calls = stubAppsFetch();
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore Claude Desktop?' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore in Terminal' }));
    await waitFor(() => expect(posts(calls)[0]).toMatchObject({ body: { enabled: false, confirm: true } }));
  });
});

describe('AppsSection — launch', () => {
  it('Launch opens the agent in Terminal.app in the current project (the newest chat’s folder)', async () => {
    const calls = stubAppsFetch();
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('button', { name: 'Launch Codex' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ url: '/api/verse/apps/codex/launch', body: { root: '/Users/op/code/ashlr-hub', via: 'native' }, token: TOKEN });
    expect(await screen.findByText('Opened Codex in Terminal.')).toBeInTheDocument();
  });

  it('the options dialog is keyboard-operable: through Ollama, with a local model, in another folder', async () => {
    const calls = stubAppsFetch();
    const user = userEvent.setup();
    await renderPage();
    screen.getByRole('button', { name: 'Launch options for Claude Code' }).focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Launch Claude Code' });
    // Native is chosen and focused first.
    expect(within(dialog).getByRole('radio', { name: /claude its own command/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(dialog).getByRole('radio', { name: /ollama launch claude through Ollama/ })).toBeChecked();
    await user.selectOptions(within(dialog).getByLabelText('Local model'), 'qwen3-coder');
    await user.selectOptions(within(dialog).getByLabelText('Folder (Terminal.app)'), '/Users/op/code/site');
    // The exact command is on screen before anything opens.
    expect(within(dialog).getByRole('button', { name: /Copy the Claude Code launch command: ollama launch claude --model qwen3-coder/ })).toBeInTheDocument();
    // No Verse terminal here (no desktop app, no open chat): it says why.
    expect(within(dialog).getByText(/^Verse terminal: /)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Open in Terminal.app' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.body).toEqual({ root: '/Users/op/code/site', via: 'ollama', model: 'qwen3-coder' });
  });

  it('a refused launch says why, in the dialog', async () => {
    stubAppsFetch({ post: { '/api/verse/apps/codex/launch': { status: 400, body: { code: 'VERSE_INVALID', error: 'root must be a chat folder or a discovered project' } } } });
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('button', { name: 'Launch options for Codex' }));
    const dialog = await screen.findByRole('dialog', { name: 'Launch Codex' });
    await user.click(within(dialog).getByRole('button', { name: 'Open in Terminal.app' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('root must be a chat folder or a discovered project');
  });
});

describe('AppsSection — MCP servers (folded in)', () => {
  it('states the caveat, what each seat loads, and never an env value', async () => {
    stubAppsFetch();
    const user = userEvent.setup();
    await renderPage();
    const mcp = screen.getByRole('region', { name: 'MCP servers' });
    expect(within(mcp).getByText(/Claude and local seats load no MCP servers/)).toBeInTheDocument();
    expect(within(mcp).getByText('--strict-mcp-config')).toBeInTheDocument();
    expect(await within(mcp).findByText('loads 1 server')).toBeInTheDocument();
    expect(within(mcp).getAllByText('loads none — isolated by Verse')).toHaveLength(2);
    expect(within(mcp).getByRole('note')).toHaveTextContent('Configured, but unused.');
    await user.click(within(mcp).getByRole('button', { name: 'Show servers' }));
    expect(within(mcp).getByText('ASHLR_TOKEN=<set>')).toBeInTheDocument();
  });

  it('Add goes propose → read the disclosure → apply with the digest', async () => {
    const calls = stubAppsFetch({
      post: {
        '/api/verse/mcp/proposal': {
          status: 200,
          body: {
            ok: true,
            server: { name: 'fs', command: '/opt/homebrew/bin/npx', args: ['-y', 'server-fs', '~/code'], env: { API_KEY: '<set>' }, sourceRef: '.ashlr/settings.json' },
            target: { id: 'hub', ref: '.ashlr/settings.json', label: 'Hub gateway registry' },
            action: 'add', replaces: null, warnings: ['1 environment variable will be stored.'], scope: {}, digest: 'd1g3st', note: 'Nothing has been written.',
          },
        },
        '/api/verse/mcp/apply': { status: 200, body: { ok: true, action: 'add', target: { id: 'hub', ref: '.ashlr/settings.json' }, server: {}, note: 'Written.' } },
      },
    });
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('button', { name: 'Add server' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add an MCP server' });
    // TOML accounts cannot take a write, and say why.
    expect(within(sheet).getByRole('option', { name: 'Personal Codex (codex)' })).toBeDisabled();
    await user.type(within(sheet).getByLabelText('Name'), 'fs');
    await user.type(within(sheet).getByLabelText('Command'), '/opt/homebrew/bin/npx');
    await user.type(within(sheet).getByLabelText('Arguments'), '-y server-fs "~/code"');
    await user.type(within(sheet).getByRole('textbox', { name: /Environment/ }), 'API_KEY=secret-value');
    await user.click(within(sheet).getByRole('button', { name: 'Review' }));

    const review = await screen.findByRole('dialog', { name: 'Review before adding' });
    expect(posts(calls)[0]).toMatchObject({ url: '/api/verse/mcp/proposal', body: { target: 'hub', server: { name: 'fs', command: '/opt/homebrew/bin/npx', args: ['-y', 'server-fs', '~/code'], env: { API_KEY: 'secret-value' } } } });
    expect(within(review).getByText('/opt/homebrew/bin/npx -y server-fs ~/code')).toBeInTheDocument();
    expect(within(review).getByText('API_KEY=<set>')).toBeInTheDocument();
    expect(within(review).queryByText(/secret-value/)).not.toBeInTheDocument();
    expect(within(review).getByText('1 environment variable will be stored.')).toBeInTheDocument();

    await user.click(within(review).getByRole('button', { name: 'Add server' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1]).toMatchObject({ url: '/api/verse/mcp/apply', body: { target: 'hub', digest: 'd1g3st', confirm: true } });
    expect(await screen.findByText('Added fs in .ashlr/settings.json.')).toBeInTheDocument();
  });
});

describe('AppsSection — degraded and compact', () => {
  it('an older server (no /apps, no /mcp) still shows Accounts and says what is missing', async () => {
    stubAppsFetch({ apps: 404, mcp: 404 });
    render(<AppsSection />);
    expect(await screen.findByText(/older than Apps & Accounts/)).toBeInTheDocument();
    expect(await screen.findByText(/This server does not expose \/api\/verse\/mcp/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Reconnect: Grok' })).toBeInTheDocument();
  });

  it('renders every group at 375', async () => {
    const viewport = mockCompactViewport();
    try {
      stubAppsFetch();
      await renderPage();
      expect(screen.getByRole('region', { name: 'MCP servers' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Launch Codex' })).toBeInTheDocument();
    } finally {
      viewport.restore();
    }
  });

  it('Check again re-probes apps and health with the token', async () => {
    const calls = stubAppsFetch();
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(posts(calls).map((c) => c.url).sort()).toEqual(['/api/verse/apps/refresh', '/api/verse/health/refresh']));
    expect(await screen.findByText('Checked again.')).toBeInTheDocument();
  });
});

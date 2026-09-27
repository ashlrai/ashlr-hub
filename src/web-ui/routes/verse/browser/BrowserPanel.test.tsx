/**
 * BrowserPanel — RTL over both engines with a fake API and a fake native
 * bridge (no frame ever loads, no native window exists).
 *
 * Under test:
 *   - web UI fallback: loopback pages in a sandboxed <iframe>; anything else
 *     "Open in your browser"; capture features explain the desktop app;
 *   - desktop app: the page is a native webview placed over the stage
 *     (`open` with bounds), hidden when a dialog opens over it, native nav /
 *     title events drive the tab; screenshot → tray → Send to chat attaches
 *     it and drafts into the composer (never sends);
 *   - agent access: the switch goes through the token gate; a command from
 *     the agent runs in this pane and its answer is posted back;
 *   - acting (3.15 P2/P3): an `act` command becomes a native query with the
 *     validated spec; a `confirm` command shows the card and posts the
 *     operator's answer; operator input while an agent works pauses it
 *     until Resume; the recent-actions strip lists what the agent did;
 *   - the launcher offers the chat's dev servers.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseBrowserAgentCommand, VerseBrowserCommandsResponse, VerseBrowserPolicy } from '../../../../core/verse/browser-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { BrowserPanel, type BrowserPanelDeps } from './BrowserPanel.js';
import type { BrowserApi } from './browser-queries.js';
import { BROWSER_TABS_STORAGE_KEY } from './browser-tabs.js';
import { NATIVE_BROWSER_EVENT, type NativeBrowser, type NativeBrowserOp } from './native-browser.js';

const VERSE = 'http://127.0.0.1:7777';

function policy(over: Partial<VerseBrowserPolicy> = {}): VerseBrowserPolicy {
  return {
    sessionId: 's-1', agentAccess: false, actAccess: false, scriptAccess: false, allowances: [],
    allowedOrigins: [], blocked: [], toolEngines: ['claude', 'local'], paneSeenAt: null, ...over,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, map };
}

function harness(opts: { native?: boolean; screenshot?: boolean; policy?: VerseBrowserPolicy; commands?: VerseBrowserAgentCommand[]; tabUrl?: string } = {}) {
  const sent: NativeBrowserOp[] = [];
  let pendingCommands = opts.commands ? [...opts.commands] : [];
  const api: BrowserApi = {
    policy: vi.fn(async () => opts.policy ?? policy()),
    setAccess: vi.fn(async (_s: string, enabled: boolean, scope?: string) => policy({ agentAccess: scope ? true : enabled, actAccess: scope === 'browser_act' ? enabled : enabled })),
    revokeAllowance: vi.fn(async () => policy({ agentAccess: true, actAccess: true })),
    allowOrigin: vi.fn(async (_s: string, origin: string) => policy({ agentAccess: true, allowedOrigins: [origin] })),
    commands: vi.fn(async (_s: string, signal?: AbortSignal): Promise<VerseBrowserCommandsResponse> => {
      if (pendingCommands.length > 0) {
        const out = pendingCommands;
        pendingCommands = [];
        return { commands: out };
      }
      // Park like the real long-poll until aborted.
      return new Promise<VerseBrowserCommandsResponse>((resolve) => signal?.addEventListener('abort', () => resolve({ commands: [] })));
    }),
    result: vi.fn(async () => {}),
    targets: vi.fn(async () => ({
      devServers: [
        { id: 'd1', label: 'npm run dev', url: 'http://localhost:5173/', port: 5173, source: 'package-json' as const, running: true, root: '~/app' },
      ],
      artifacts: [],
    })),
    attach: vi.fn(async () => ({ id: 'a1', sessionId: 's-1', name: 'shot.png', mime: 'image/png', bytes: 4, ref: '@/tmp/att/shot.png', createdAt: 'now' })),
    canWrite: vi.fn(() => true),
  };
  const bridge: NativeBrowser = {
    version: 1,
    capabilities: { screenshot: opts.screenshot ?? true, picker: true, console: true, text: true, act: true },
    send: (op) => {
      sent.push(op);
      // Answer requests the way the shell would.
      if (op.op === 'screenshot') {
        queueMicrotask(() => emit({ kind: 'result', req: op.req, ok: true, data: { mime: 'image/png', base64: 'iVBORw0KGgo=', width: 640, height: 400 } }));
      }
      if (op.op === 'query' && typeof op.what === 'object' && 'act' in op.what) {
        queueMicrotask(() => emit({ kind: 'result', req: op.req, ok: true, data: { kind: 'click', x: 10, y: 20, native: true, url: 'http://localhost:5173/', title: 'App' } }));
      }
      if (op.op === 'query' && op.what === 'console') {
        queueMicrotask(() => emit({ kind: 'result', req: op.req, ok: true, data: { url: 'http://localhost:5173/', console: [{ t: 0, level: 'error', text: 'boom' }], network: [] } }));
      }
      return true;
    },
  };
  const insert = vi.fn((_sessionId: string, _text: string) => true);
  const openExternal = vi.fn();
  const storage = memoryStorage(opts.tabUrl
    ? { [BROWSER_TABS_STORAGE_KEY]: JSON.stringify({ tabs: [{ id: 't1', url: opts.tabUrl, title: 'App' }], activeId: 't1', nextId: 2 }) }
    : {});
  const deps: Partial<BrowserPanelDeps> = {
    api,
    native: () => (opts.native ? bridge : null),
    origin: () => VERSE,
    insert,
    openExternal,
    storage: () => storage,
    now: () => new Date('2026-09-27T10:00:00Z'),
  };
  return { api, deps, sent, insert, openExternal, storage };
}

function emit(detail: unknown) {
  window.dispatchEvent(new CustomEvent(NATIVE_BROWSER_EVENT, { detail }));
}

async function go(address: string) {
  const user = userEvent.setup();
  const bar = screen.getByRole('textbox', { name: 'Address' });
  await user.clear(bar);
  await user.type(bar, `${address}{Enter}`);
}

let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 100, y: 80, left: 100, top: 80, width: 800, height: 600, right: 900, bottom: 680, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  rectSpy?.mockRestore();
  clearMutationToken();
  document.querySelectorAll('[data-test-overlay]').forEach((n) => n.remove());
});

describe('web UI fallback (no desktop browser contract)', () => {
  it('frames a loopback dev server in a sandboxed iframe', async () => {
    const h = harness();
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('5173');
    const frame = await screen.findByTitle(/Browser: localhost:5173/);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', 'http://localhost:5173/');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
  });

  it('offers anything else externally — sites refuse framing, and the page CSP only frames loopback', async () => {
    const h = harness();
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('example.com/docs');
    expect(screen.queryByTitle(/Browser:/)).toBeNull();
    expect(screen.getByText(/can’t be shown in the web UI/)).toBeInTheDocument();
    // The card's button (the toolbar has the same action as an icon).
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Open in your browser' }).at(-1)!);
    expect(h.openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('screenshot fallback: says the desktop app is needed instead of pretending', async () => {
    const h = harness();
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('5173');
    const shot = screen.getByRole('button', { name: 'Screenshot' });
    expect(shot).toHaveAttribute('title', 'Screenshots need the Ashlr desktop app');
    await userEvent.setup().click(shot);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Screenshots need the Ashlr desktop app/);
    expect(screen.getByRole('button', { name: 'Pick an element' })).toBeDisabled();
  });

  it('refuses Verse itself and non-web schemes in the address bar', async () => {
    const h = harness();
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('7777');
    expect(screen.getByRole('status')).toHaveTextContent(/Verse itself/);
    await go('javascript:alert(1)');
    expect(screen.getByRole('status')).toHaveTextContent(/not an address|Only http/);
  });

  it('send to chat drafts the page with a note about what the web UI cannot capture', async () => {
    const h = harness();
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('5173');
    await userEvent.setup().click(screen.getByRole('button', { name: /Send to chat/ }));
    await waitFor(() => expect(h.insert).toHaveBeenCalled());
    const [sid, text] = h.insert.mock.calls[0]!;
    expect(sid).toBe('s-1');
    expect(text).toContain('http://localhost:5173/');
    expect(text).toContain('need the Ashlr desktop app');
    expect(h.api.attach).not.toHaveBeenCalled();
  });

  it('the launcher lists this chat\'s dev servers and opens one', async () => {
    const h = harness();
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    expect(await screen.findByText('npm run dev')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByTitle(/Browser: localhost:5173/)).toBeInTheDocument();
  });

  it('restores saved tabs', () => {
    const h = harness();
    h.storage.setItem(BROWSER_TABS_STORAGE_KEY, JSON.stringify({ tabs: [{ id: 't3', url: 'http://localhost:4000/' }], activeId: 't3' }));
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('http://localhost:4000/');
  });
});

describe('desktop app (native webview)', () => {
  it('opens the page as a native webview laid over the stage, and follows its nav / title events', async () => {
    const h = harness({ native: true });
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('example.com');
    await waitFor(() => expect(h.sent.some((op) => op.op === 'open')).toBe(true));
    const open = h.sent.find((op) => op.op === 'open') as Extract<NativeBrowserOp, { op: 'open' }>;
    expect(open).toEqual({ op: 'open', tab: 't1', url: 'https://example.com/', bounds: { x: 100, y: 80, width: 800, height: 600 } });
    // No iframe in native mode: any site works.
    expect(screen.queryByTitle(/Browser:/)).toBeNull();
    act(() => {
      emit({ kind: 'nav', tab: 't1', url: 'https://example.com/welcome', loading: false });
      emit({ kind: 'title', tab: 't1', title: 'Welcome' });
    });
    expect(screen.getByRole('tab', { name: /Welcome/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('https://example.com/welcome');
    // Navigating an open tab navigates the webview (not a new window).
    await go('localhost:3000');
    expect(h.sent).toContainEqual({ op: 'navigate', tab: 't1', url: 'http://localhost:3000/' });
  });

  it('device presets resize the webview; zoom is sent to it', async () => {
    const h = harness({ native: true });
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('5173');
    await waitFor(() => expect(h.sent.some((op) => op.op === 'open')).toBe(true));
    await userEvent.setup().click(screen.getByRole('radio', { name: /Phone 390/ }));
    await waitFor(() => expect(h.sent).toContainEqual({ op: 'bounds', tab: 't1', bounds: { x: 305, y: 80, width: 390, height: 600 } }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(h.sent).toContainEqual({ op: 'zoom', tab: 't1', factor: 1.1 });
  });

  it('hides the webview while a dialog is open over it', async () => {
    const h = harness({ native: true });
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('5173');
    await waitFor(() => expect(h.sent.some((op) => op.op === 'open')).toBe(true));
    const overlay = document.createElement('div');
    overlay.setAttribute('data-test-overlay', '');
    overlay.innerHTML = '<div role="dialog" aria-modal="true">Palette</div>';
    act(() => { document.body.appendChild(overlay); });
    await waitFor(() => expect(h.sent.at(-1)).toEqual({ op: 'hide' }));
    act(() => { overlay.remove(); });
    await waitFor(() => expect(h.sent.at(-1)).toMatchObject({ op: 'bounds', tab: 't1' }));
  });

  it('hides (not closes) its webviews when the pane is hidden or unmounted', async () => {
    const h = harness({ native: true });
    const { rerender, unmount } = render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('5173');
    await waitFor(() => expect(h.sent.some((op) => op.op === 'open')).toBe(true));
    rerender(<BrowserPanel sessionId="s-1" visible={false} deps={h.deps} />);
    expect(h.sent.at(-1)).toEqual({ op: 'hide' });
    unmount();
    expect(h.sent.filter((op) => op.op === 'close')).toEqual([]);
  });

  it('a tab closed natively (⌘W in the page) closes here too instead of re-opening', async () => {
    const h = harness({ native: true });
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('5173');
    await waitFor(() => expect(h.sent.some((op) => op.op === 'open')).toBe(true));
    const opens = h.sent.filter((op) => op.op === 'open').length;
    act(() => { emit({ kind: 'closed', tab: 't1' }); });
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('');
    await new Promise((r) => setTimeout(r, 500));
    expect(h.sent.filter((op) => op.op === 'open').length).toBe(opens);
  });

  it('screenshot → tray → Send to chat attaches it and drafts the console (never sends)', async () => {
    const h = harness({ native: true });
    setMutationToken('a'.repeat(64));
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('5173');
    await waitFor(() => expect(h.sent.some((op) => op.op === 'open')).toBe(true));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Screenshot' }));
    expect(await screen.findByRole('img', { name: /Screenshot of http:\/\/localhost:5173\// })).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=');
    await user.click(screen.getByRole('button', { name: /Send to chat/ }));
    await waitFor(() => expect(h.insert).toHaveBeenCalled());
    expect(h.api.attach).toHaveBeenCalledWith('s-1', expect.objectContaining({ mime: 'image/png', dataBase64: 'iVBORw0KGgo=' }));
    const text = h.insert.mock.calls[0]![1];
    expect(text).toContain('Screenshot: @/tmp/att/shot.png');
    expect(text).toContain('ERROR boom');
    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing was sent/);
  });

  it('a shell without screenshots (non-macOS) says so', async () => {
    const h = harness({ native: true, screenshot: false });
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await go('5173');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Screenshot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/macOS only/);
  });
});

describe('agent access', () => {
  it('the switch goes through the token gate and the API', async () => {
    const h = harness();
    setMutationToken('a'.repeat(64));
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    const toggle = await screen.findByRole('switch', { name: /Agents in this chat can use this browser/ });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    await userEvent.setup().click(toggle);
    await waitFor(() => expect(h.api.setAccess).toHaveBeenCalledWith('s-1', true));
  });

  it('runs an agent\'s command in this pane and posts the answer', async () => {
    const command: VerseBrowserAgentCommand = { id: 'bc_AAAAAAAAAAAA', sessionId: 's-1', op: 'navigate', url: 'http://localhost:5173/settings', allowedOrigins: [], createdAt: 'now' };
    const h = harness({ native: true, policy: policy({ agentAccess: true }), commands: [command] });
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    // The pane opens the page natively …
    await waitFor(() => expect(h.sent).toContainEqual(expect.objectContaining({ op: 'open', tab: 't1', url: 'http://localhost:5173/settings' })));
    // … and answers once the webview reports it loaded.
    act(() => { emit({ kind: 'nav', tab: 't1', url: 'http://localhost:5173/settings', loading: false }); });
    await waitFor(() => expect(h.api.result).toHaveBeenCalledWith('s-1', expect.objectContaining({ id: command.id, ok: true, url: 'http://localhost:5173/settings' })));
  });

  it('shows a refused external request with one-click Allow', async () => {
    const h = harness({ policy: policy({ agentAccess: true, blocked: [{ url: 'https://example.com/a', origin: 'https://example.com', at: 'now' }] }) });
    setMutationToken('a'.repeat(64));
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    expect(await screen.findByText(/Agent asked for https:\/\/example.com/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Allow for this chat' }));
    await waitFor(() => expect(h.api.allowOrigin).toHaveBeenCalledWith('s-1', 'https://example.com', true));
  });

  const cmd = (op: VerseBrowserAgentCommand['op'], args: Record<string, unknown>, id = 'bc_AAAAAAAAAAAA'): VerseBrowserAgentCommand =>
    ({ id, sessionId: 's-1', op, args, allowedOrigins: [], createdAt: 'now' });

  it('an act command becomes one native query with the validated spec, and is listed in the strip', async () => {
    const click = cmd('act', { kind: 'click', ref: 'e3', expect: 'abc123' });
    const h = harness({ native: true, tabUrl: 'http://localhost:5173/', policy: policy({ agentAccess: true, actAccess: true }), commands: [click] });
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await waitFor(() => expect(h.api.result).toHaveBeenCalledWith('s-1', expect.objectContaining({ id: click.id, ok: true })));
    expect(h.sent).toContainEqual(expect.objectContaining({ op: 'query', tab: 't1', what: { act: { kind: 'click', ref: 'e3', expect: 'abc123' } } }));
    expect(await screen.findByRole('list', { name: 'Recent agent actions' })).toHaveTextContent('Clicked e3');
  });

  it('refuses an act command whose arguments are not the closed shape (nothing reaches native)', async () => {
    const bad = cmd('act', { kind: 'click', ref: 'e3', script: 'alert(1)' });
    const h = harness({ native: true, tabUrl: 'http://localhost:5173/', policy: policy({ agentAccess: true, actAccess: true }), commands: [bad] });
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await waitFor(() => expect(h.api.result).toHaveBeenCalledWith('s-1', expect.objectContaining({ id: bad.id, ok: false })));
    expect(h.sent.some((op) => op.op === 'query')).toBe(false);
  });

  it('a confirm command shows the card and posts the operator\'s answer', async () => {
    const ask = cmd('confirm', {
      action: 'Click the Delete button', target: 'button "Delete project"', origin: 'http://localhost:5173',
      reasons: ['the control is labelled "delete"'], tool: 'browser_click', expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const h = harness({ native: true, tabUrl: 'http://localhost:5173/', policy: policy({ agentAccess: true, actAccess: true }), commands: [ask] });
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    const card = await screen.findByRole('group', { name: 'The agent is asking to act' });
    expect(card).toHaveTextContent('Click the Delete button');
    expect(card).toHaveTextContent('button "Delete project"');
    expect(card).toHaveTextContent('Asked because the control is labelled "delete".');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(h.api.result).toHaveBeenCalledWith('s-1', { id: ask.id, ok: true, data: { decision: 'once' } }));
    expect(screen.queryByRole('group', { name: 'The agent is asking to act' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Recent agent actions' })).toHaveTextContent('Asked you: Click the Delete button — allowed');
  });

  it('operator input while an agent works pauses it until Resume', async () => {
    const first = cmd('act', { kind: 'scroll', direction: 'down' }, 'bc_AAAAAAAAAAA1');
    const h = harness({ native: true, tabUrl: 'http://localhost:5173/', policy: policy({ agentAccess: true, actAccess: true }), commands: [first] });
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    await waitFor(() => expect(h.api.result).toHaveBeenCalledWith('s-1', expect.objectContaining({ id: first.id, ok: true })));
    act(() => { emit({ kind: 'operator', tab: 't1' }); });
    expect(await screen.findByText(/You took over\./)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume agent' }));
    expect(screen.queryByText(/You took over\./)).toBeNull();
  });

  it('with access on, the scope switches go through the gate with their scope', async () => {
    const h = harness({ policy: policy({ agentAccess: true, actAccess: true }) });
    setMutationToken('a'.repeat(64));
    render(<BrowserPanel sessionId="s-1" deps={h.deps} />);
    const scripts = await screen.findByRole('switch', { name: 'Run scripts (localhost)' });
    await waitFor(() => expect(scripts).not.toBeDisabled());
    await userEvent.setup().click(scripts);
    await waitFor(() => expect(h.api.setAccess).toHaveBeenCalledWith('s-1', true, 'browser_script'));
    expect(screen.getByRole('switch', { name: 'Click and type' })).toBeInTheDocument();
  });

  it('without a chat the pane still browses, with no agent controls', () => {
    const h = harness();
    render(<BrowserPanel sessionId={null} deps={h.deps} />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByRole('button', { name: /Send to chat/ })).toBeDisabled();
  });
});

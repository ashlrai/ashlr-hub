/**
 * PreviewPane (unit C4) — RTL + user-event on the keyboard paths and the 375
 * layout (SPEC-310C §7 test method). The API is a fake; no frame ever loads.
 *
 * Under test: the launcher (dev servers + this chat's files), loopback-only
 * addresses (anything else is "Open in browser ↗", Verse itself is refused),
 * the sandbox on every frame, Start → a terminal request → wait for the port
 * → open, artifacts through a frame ticket (Markdown rendered in-pane),
 * back / forward / reload, the Desktop / 375 toggle, tabs by keyboard, and
 * per-chat tab restore.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VersePreviewTargetsResponse } from '../../../../data/api-types.js';
import { ApiError } from '../../../../data/client.js';
import type { PreviewOpenRequest, TerminalOpenRequest } from '../../shell/slots.js';
import { mockCompactViewport, type ViewportMock } from '../../shell/viewport.test-support.js';
import { formatBytes, parsePreviewAddress, shortUrl, type PreviewApi } from './preview-client.js';
import { PreviewPane, resetPreviewPaneForTest, type PreviewPaneDeps } from './PreviewPane.js';

const VERSE = 'http://127.0.0.1:7970';

function targets(over: Partial<VersePreviewTargetsResponse> = {}): VersePreviewTargetsResponse {
  return {
    devServers: [
      { id: 'dev-vite', label: 'npm run dev', url: 'http://localhost:5173/', port: 5173, source: 'package-json', running: false, root: '~/code/app' },
      { id: 'port-8787', label: 'bun :8787', url: 'http://localhost:8787/', port: 8787, source: 'listening', running: true, root: '~/code/app' },
    ],
    artifacts: [
      { path: 'out/report.html', kind: 'html', bytes: 12_400 },
      { path: 'NOTES.md', kind: 'md', bytes: 300 },
      { path: 'shot.png', kind: 'image', bytes: 2048 },
    ],
    ...over,
  };
}

function harness(initial: VersePreviewTargetsResponse = targets()) {
  let current = initial;
  let now = 1_000_000;
  const api: PreviewApi = {
    targets: vi.fn(async () => structuredClone(current)),
    ticket: vi.fn(async (_s: string, path: string) => ({ url: `/api/verse/preview/frame/${'t'.repeat(40)}${path.length}`, expiresAt: 'x', kind: 'html' as const })),
    text: vi.fn(async () => '# Notes\n\nShipped **3.10**.'),
  };
  const deps: Partial<PreviewPaneDeps> = { api, origin: () => VERSE, now: () => now };
  return {
    api,
    deps,
    setTargets: (next: VersePreviewTargetsResponse) => { current = next; },
    advance: (ms: number) => { now += ms; },
  };
}

type Harness = ReturnType<typeof harness>;

function renderPane(h: Harness, props: { request?: PreviewOpenRequest | null; visible?: boolean; sessionId?: string; onOpenTerminal?: (r: Omit<TerminalOpenRequest, 'nonce'>) => void } = {}) {
  const onOpenTerminal = props.onOpenTerminal ?? vi.fn();
  const utils = render(
    <PreviewPane sessionId={props.sessionId ?? 's-1'} roots={['~/code/app']} request={props.request ?? null}
      onOpenTerminal={onOpenTerminal} visible={props.visible ?? true} deps={h.deps} />,
  );
  return { ...utils, onOpenTerminal };
}

let viewport: ViewportMock | null = null;

beforeEach(() => {
  resetPreviewPaneForTest();
  try { localStorage.clear(); } catch { /* jsdom has it */ }
});

afterEach(() => {
  viewport?.restore();
  viewport = null;
  vi.useRealTimers();
});

describe('PreviewPane — launcher', () => {
  it('lists this chat\'s dev servers and files, with what each action will do', async () => {
    const h = harness();
    renderPane(h);
    const servers = await screen.findByRole('region', { name: 'Dev servers' });
    expect(within(servers).getByText('npm run dev')).toBeInTheDocument();
    expect(within(servers).getByText(/localhost:5173 · stopped · package\.json/)).toBeInTheDocument();
    expect(within(servers).getByRole('button', { name: 'Start npm run dev' })).toHaveAttribute('title', 'Runs npm run dev in a terminal tab');
    expect(within(servers).getByRole('button', { name: 'Open bun :8787' })).toBeInTheDocument();
    const files = screen.getByRole('region', { name: "This chat's files" });
    expect(within(files).getByText('out/report.html')).toBeInTheDocument();
    expect(within(files).getByText('HTML · 12 KB')).toBeInTheDocument();
  });

  it('shows what Start will type when the row\'s name is not the command (launch.json)', async () => {
    const h = harness(targets({
      devServers: [
        { id: 'lj-web', label: 'web', command: 'pnpm --filter web dev --port 3000', url: 'http://localhost:3000/', port: 3000, source: 'launch-json', running: false, root: '~/code/app' },
        { id: 'port-8787', label: 'bun :8787', command: null, url: 'http://localhost:8787/', port: 8787, source: 'listening', running: true, root: '~/code/app' },
      ],
    }));
    renderPane(h);
    const servers = await screen.findByRole('region', { name: 'Dev servers' });
    expect(within(servers).getByText('pnpm --filter web dev --port 3000')).toBeInTheDocument();
    expect(within(servers).getByRole('button', { name: 'Start web' })).toHaveAttribute('title', 'Runs pnpm --filter web dev --port 3000 in a terminal tab');
    // A server only seen listening has nothing to start, so no command line.
    expect(within(servers).queryByText('null')).not.toBeInTheDocument();
  });

  it('says what to do when there is nothing yet', async () => {
    const h = harness({ devServers: [], artifacts: [] });
    renderPane(h);
    expect(await screen.findByText('Nothing to preview yet')).toBeInTheDocument();
  });

  it('does not fetch while hidden', async () => {
    const h = harness();
    renderPane(h, { visible: false });
    await act(async () => { await Promise.resolve(); });
    expect(h.api.targets).not.toHaveBeenCalled();
  });
});

describe('PreviewPane — dev servers', () => {
  it('opens a running server in a sandboxed frame that can never navigate Verse', async () => {
    const user = userEvent.setup();
    const h = harness();
    renderPane(h);
    await user.click(await screen.findByRole('button', { name: 'Open bun :8787' }));
    const frame = await screen.findByTitle('Preview of localhost:8787');
    expect(frame).toHaveAttribute('src', 'http://localhost:8787/');
    const sandbox = frame.getAttribute('sandbox')!;
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.getByRole('tab', { name: /localhost:8787/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('link', { name: 'Open in browser' })).toHaveAttribute('href', 'http://localhost:8787/');
  });

  it('Start runs the server in a terminal tab, waits for its port, then opens it', async () => {
    const user = userEvent.setup();
    const h = harness();
    const { onOpenTerminal } = renderPane(h);
    await user.click(await screen.findByRole('button', { name: 'Start npm run dev' }));
    expect(onOpenTerminal).toHaveBeenCalledWith({ root: '~/code/app', devServerId: 'dev-vite' });
    expect(screen.getByRole('status')).toHaveTextContent('Starting npm run dev — waiting for localhost:5173');
    // The port answers on a later poll.
    const up = targets();
    up.devServers[0] = { ...up.devServers[0]!, running: true };
    h.setTargets(up);
    await act(async () => { await new Promise((r) => setTimeout(r, 2_100)); });
    expect(await screen.findByTitle('Preview of localhost:5173')).toBeInTheDocument();
    expect(screen.queryByText(/waiting for/)).not.toBeInTheDocument();
  }, 10_000);

  it('gives up after two minutes with a pointer to the terminal', async () => {
    const user = userEvent.setup();
    const h = harness();
    renderPane(h);
    await user.click(await screen.findByRole('button', { name: 'Start npm run dev' }));
    h.advance(121_000);
    await act(async () => { await new Promise((r) => setTimeout(r, 2_100)); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing answered on port 5173 within 2 minutes. Check the terminal for errors.');
  }, 10_000);

  it('a devServerId request from the dock opens (or starts) that server', async () => {
    const h = harness();
    const { rerender, onOpenTerminal } = renderPane(h);
    await screen.findByRole('region', { name: 'Dev servers' });
    rerender(<PreviewPane sessionId="s-1" roots={['~/code/app']} request={{ nonce: 4, devServerId: 'dev-vite' }}
      onOpenTerminal={onOpenTerminal} visible deps={h.deps} />);
    await waitFor(() => expect(onOpenTerminal).toHaveBeenCalledWith({ root: '~/code/app', devServerId: 'dev-vite' }));
  });
});

describe('PreviewPane — address bar', () => {
  it('opens loopback addresses (with shorthands) and walks back and forward', async () => {
    const user = userEvent.setup();
    const h = harness();
    renderPane(h);
    const bar = await screen.findByRole('textbox', { name: 'Address' });
    await user.type(bar, '5173{Enter}');
    expect(await screen.findByTitle('Preview of localhost:5173')).toHaveAttribute('src', 'http://localhost:5173/');
    await user.clear(bar);
    await user.type(bar, 'localhost:5173/admin{Enter}');
    expect(await screen.findByTitle('Preview of localhost:5173/admin')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByTitle('Preview of localhost:5173')).toBeInTheDocument();
    expect(bar).toHaveValue('http://localhost:5173/');
    await user.click(screen.getByRole('button', { name: 'Forward' }));
    expect(await screen.findByTitle('Preview of localhost:5173/admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  it('never frames anything else: external pages are "Open in browser ↗", Verse itself is refused', async () => {
    const user = userEvent.setup();
    const h = harness();
    renderPane(h);
    const bar = await screen.findByRole('textbox', { name: 'Address' });
    await user.type(bar, 'github.com/ashlrai{Enter}');
    expect(screen.getByText(/Only local dev servers open here/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in browser ↗' })).toHaveAttribute('href', 'https://github.com/ashlrai');
    expect(screen.getByRole('link', { name: 'Open in browser ↗' })).toHaveAttribute('rel', 'noopener noreferrer');
    await user.clear(bar);
    await user.type(bar, '7970{Enter}');
    expect(screen.getByText('That address is Verse itself.')).toBeInTheDocument();
    await user.clear(bar);
    await user.type(bar, 'javascript:alert(1){Enter}');
    expect(screen.getByText(/Enter a local address/)).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('Esc puts the address back', async () => {
    const user = userEvent.setup();
    const h = harness();
    renderPane(h, { request: { nonce: 1, url: 'http://localhost:3000/' } });
    const bar = await screen.findByRole('textbox', { name: 'Address' });
    await waitFor(() => expect(bar).toHaveValue('http://localhost:3000/'));
    await user.clear(bar);
    await user.type(bar, 'oops{Escape}');
    expect(bar).toHaveValue('http://localhost:3000/');
  });
});

describe('PreviewPane — artifacts', () => {
  it('shows HTML through a frame ticket in a no-same-origin sandbox', async () => {
    const user = userEvent.setup();
    const h = harness();
    renderPane(h);
    await user.click(await screen.findByRole('button', { name: 'Open out/report.html' }));
    const frame = await screen.findByTitle('Preview of out/report.html');
    expect(h.api.ticket).toHaveBeenCalledWith('s-1', 'out/report.html');
    expect(frame.getAttribute('src')).toMatch(/^\/api\/verse\/preview\/frame\//);
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    // Reload mints a fresh ticket.
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(h.api.ticket).toHaveBeenCalledTimes(2));
  });

  it('renders Markdown in the pane, sanitised like a chat message', async () => {
    const user = userEvent.setup();
    const h = harness();
    renderPane(h);
    await user.click(await screen.findByRole('button', { name: 'Open NOTES.md' }));
    const article = await screen.findByRole('article', { name: 'NOTES.md' });
    expect(within(article).getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
    expect(h.api.ticket).not.toHaveBeenCalled();
  });

  it('shows images as images', async () => {
    const user = userEvent.setup();
    const h = harness();
    renderPane(h);
    await user.click(await screen.findByRole('button', { name: 'Open shot.png' }));
    expect(await screen.findByRole('img', { name: 'shot.png' })).toHaveAttribute('src', expect.stringMatching(/^\/api\/verse\/preview\/frame\//));
  });

  it('says so when a file is gone', async () => {
    const user = userEvent.setup();
    const h = harness();
    (h.api.ticket as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError('gone', 404, '/x'));
    renderPane(h);
    await user.click(await screen.findByRole('button', { name: 'Open out/report.html' }));
    expect(await screen.findByText("This file is no longer in the chat's folder.")).toBeInTheDocument();
  });
});

describe('PreviewPane — tabs, frame width, restore', () => {
  it('moves between tabs with ← → Home End and closes them', async () => {
    const user = userEvent.setup();
    const h = harness();
    renderPane(h);
    await user.click(await screen.findByRole('button', { name: 'Open bun :8787' }));
    await user.click(screen.getByRole('button', { name: 'New preview tab' }));
    await user.click(await screen.findByRole('button', { name: 'Open out/report.html' }));
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['localhost:8787', 'report.html']);
    tabs[1]!.focus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: /localhost:8787/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /localhost:8787/ })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: /report\.html/ })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('button', { name: 'Close preview report.html' }));
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('toggles the frame between desktop width and 375', async () => {
    const user = userEvent.setup();
    const h = harness();
    renderPane(h, { request: { nonce: 2, url: 'http://localhost:3000/' } });
    const frame = await screen.findByTitle('Preview of localhost:3000');
    expect(frame.parentElement).toHaveAttribute('data-device', 'desktop');
    await user.click(screen.getByRole('radio', { name: '375 px width' }));
    expect(frame.parentElement).toHaveAttribute('data-device', 'phone');
  });

  it('restores a chat\'s tabs after a reload, and keeps each chat\'s tabs apart', async () => {
    const h = harness();
    const first = renderPane(h, { request: { nonce: 1, url: 'http://localhost:3000/' } });
    await screen.findByTitle('Preview of localhost:3000');
    first.unmount();
    renderPane(h);
    expect(await screen.findByTitle('Preview of localhost:3000')).toBeInTheDocument();
    // Another chat has its own (empty) set.
    const other = harness();
    renderPane(other, { sessionId: 's-2' });
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'Dev servers' }).length).toBeGreaterThan(0));
  });

  it('at 375 the address bar takes its own row and the width toggle is not offered', async () => {
    viewport = mockCompactViewport();
    const h = harness();
    renderPane(h, { request: { nonce: 1, url: 'http://localhost:3000/' } });
    await screen.findByTitle('Preview of localhost:3000');
    expect(screen.queryByRole('radio', { name: '375 px width' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Address' })).toBeInTheDocument();
    expect(document.querySelector('[data-compact]')).not.toBeNull();
  });
});

describe('address rules', () => {
  it('parses what people type', () => {
    expect(parsePreviewAddress('5173', VERSE)).toEqual({ kind: 'loopback', url: 'http://localhost:5173/' });
    expect(parsePreviewAddress(':3000', VERSE)).toEqual({ kind: 'loopback', url: 'http://localhost:3000/' });
    expect(parsePreviewAddress('127.0.0.1:8080/x?y=1', VERSE)).toEqual({ kind: 'loopback', url: 'http://127.0.0.1:8080/x?y=1' });
    expect(parsePreviewAddress('https://localhost:5173', VERSE).kind).toBe('external');
    expect(parsePreviewAddress('http://localhost:7970/verse', VERSE).kind).toBe('self');
    expect(parsePreviewAddress('http://127.0.0.1:7970', VERSE).kind).toBe('self');
    expect(parsePreviewAddress('example.com', VERSE)).toEqual({ kind: 'external', url: 'https://example.com/' });
    expect(parsePreviewAddress('file:///etc/passwd', VERSE).kind).toBe('invalid');
    expect(parsePreviewAddress('data:text/html,hi', VERSE).kind).toBe('invalid');
    expect(parsePreviewAddress('not a url', VERSE).kind).toBe('invalid');
    expect(parsePreviewAddress('http://user:pw@localhost:1/', VERSE).kind).toBe('invalid');
  });

  it('labels', () => {
    expect(shortUrl('http://localhost:5173/')).toBe('localhost:5173');
    expect(shortUrl('http://localhost:5173/a?b=1')).toBe('localhost:5173/a?b=1');
    expect(formatBytes(300)).toBe('300 B');
    expect(formatBytes(12_400)).toBe('12 KB');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
  });
});

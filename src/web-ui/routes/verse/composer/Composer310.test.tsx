/**
 * V3.10 composer (SPEC-310C §2, §7 C3) — RTL + user-event on the keyboard
 * paths, against a fake server that records every request:
 *
 *   - pickers open from their catalog keys (⇧⌘M / ⇧⌘I / ⇧⌘E) and the palette
 *     event, move with the arrows, choose with Enter; unavailable options are
 *     disabled WITH the reason and cannot be chosen;
 *   - bypass asks first (focus on Cancel) and only the red button sends
 *     `confirmBypass: true`;
 *   - Enter during a running turn queues (server-side), ⇧⌘Enter stops and
 *     sends, Esc stops only from an empty box, the queue row edits / sends /
 *     removes, a held queue says why;
 *   - paste / drop attach files (8 MB cap on the client too), the `@path`
 *     token lands in the text and leaves with the chip; grok refuses;
 *   - `@` fuzzy-finds files, `/` runs commands;
 *   - at 375px the footer folds its pickers into a bottom sheet;
 *   - (3.10.1) the measured fold: mounts folded, re-measures on words and on
 *     the capacity ring, folds from where it is on a width change, never
 *     moves under an open sheet or menu, and keeps focus and Esc-to-stop
 *     working across every fold change.
 */
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import type {
  VerseControlOption,
  VerseQueueResponse,
  VerseSessionControlsResponse,
} from '../../../../core/verse/workbench-types.js';
import { CLAUDE_SEAT, CODEX_SEAT, GROK_SEAT, LOCAL_SEAT } from '../fixtures.test-support.js';
import { Composer, type ComposerProps } from '../Composer.js';
import { ContextMeter } from '../ContextMeter.js';
import { ControlMenu } from './ControlMenu.js';
import { moduleDeclaration } from '../../../design/token-probe.test-support.js';
import type { VerseSeat } from '../../../data/api-types.js';
import { detectKeyPlatform } from '../shell/command-catalog.js';
import { mockCompactViewport, type ViewportMock } from '../shell/viewport.test-support.js';

/** The catalog's `mod` is ⌘ on macOS and Ctrl elsewhere — jsdom reports no platform, so Ctrl. */
const MOD = detectKeyPlatform() === 'mac' ? 'Meta' : 'Control';
const chord = (key: string, shift = true) => `{${MOD}>}${shift ? '{Shift>}' : ''}${key}${shift ? '{/Shift}' : ''}{/${MOD}}`;

const SEATS = [CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT, GROK_SEAT];
const SID = 'vs_1';

function modes(unavailable: Partial<Record<string, string>> = {}): VerseControlOption<'plan' | 'accept-edits' | 'auto' | 'bypass'>[] {
  const labels = { plan: 'Plan', 'accept-edits': 'Accept edits', auto: 'Auto', bypass: 'Bypass permissions' } as const;
  return (['plan', 'accept-edits', 'auto', 'bypass'] as const).map((id) => ({
    id,
    label: labels[id],
    available: !unavailable[id],
    ...(unavailable[id] ? { reason: unavailable[id] } : {}),
    ...(id === 'bypass' ? { danger: true } : {}),
  }));
}

function controlsView(over: Partial<VerseSessionControlsResponse['controls']> = {}, appliesNextTurn = false): VerseSessionControlsResponse {
  return {
    sessionId: SID,
    controls: { model: 'claude-opus-5', effort: null, permissionMode: 'accept-edits', ...over },
    appliesNextTurn,
    options: {
      models: [
        { id: 'claude-opus-5', label: 'Opus 5', available: true },
        { id: 'claude-sonnet-5', label: 'Sonnet 5', available: true },
        { id: 'claude-next', label: 'Next', available: false, reason: 'needs Claude Code 2.1.300' },
      ],
      efforts: [
        { id: 'minimal', label: 'Minimal', available: false, reason: 'Claude’s lowest effort is Low.' },
        { id: 'low', label: 'Low', available: true },
        { id: 'medium', label: 'Medium', available: true },
        { id: 'high', label: 'High', available: true },
        { id: 'xhigh', label: 'Extra high', available: true },
        { id: 'max', label: 'Max', available: true },
      ],
      permissionModes: modes(),
    },
  };
}

interface Call { method: string; url: string; body: Record<string, unknown> | null }

interface FakeServer {
  calls: Call[];
  controls: VerseSessionControlsResponse;
  queue: VerseQueueResponse;
  files: Array<{ path: string; root: string }>;
  posts(path: RegExp): Call[];
}

let server: FakeServer;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installServer(over: Partial<Pick<FakeServer, 'controls' | 'queue' | 'files'>> = {}): FakeServer {
  const state: FakeServer = {
    calls: [],
    controls: over.controls ?? controlsView(),
    queue: over.queue ?? { sessionId: SID, items: [], held: false, heldReason: null },
    files: over.files ?? [
      { path: 'src/web-ui/routes/verse/Composer.tsx', root: '~/dev/hub' },
      { path: 'README.md', root: '~/dev/hub' },
    ],
    posts(path) { return this.calls.filter((c) => c.method === 'POST' && path.test(c.url)); },
  };
  let attachmentN = 0;
  let queueN = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    state.calls.push({ method, url, body });
    if (url.startsWith('/api/verse/session-controls/')) {
      if (method === 'POST') {
        if (body?.['permissionMode'] === 'bypass' && body['confirmBypass'] !== true) return json({ code: 'VERSE_INVALID', error: 'confirm it' }, 400);
        const next = { ...state.controls.controls };
        if (typeof body?.['model'] === 'string') next.model = body['model'];
        if (body && 'effort' in body) next.effort = body['effort'] as typeof next.effort;
        if (typeof body?.['permissionMode'] === 'string') next.permissionMode = body['permissionMode'] as typeof next.permissionMode;
        state.controls = { ...state.controls, controls: next };
      }
      return json(state.controls);
    }
    if (url.startsWith('/api/verse/queue/')) {
      if (method === 'POST' && /\/queue\/vs_1$/.test(url)) {
        queueN += 1;
        const item = { id: `00000000000${queueN}`, sessionId: SID, text: String(body?.['text']), createdAt: '2026-09-24T10:00:00Z' };
        state.queue = { ...state.queue, items: body?.['sendNow'] ? [item, ...state.queue.items] : [...state.queue.items, item] };
        return json({ ...state.queue, sentTurnId: null });
      }
      const del = /\/queue\/vs_1\/([0-9a-f]+)\/(delete|send)$/.exec(url);
      if (method === 'POST' && del) {
        state.queue = { ...state.queue, items: state.queue.items.filter((i) => i.id !== del[1]), held: false, heldReason: null };
        return json({ ...state.queue, sentTurnId: del[2] === 'send' ? 'turn-2' : null });
      }
      return json(state.queue);
    }
    if (url.startsWith('/api/verse/attachments/')) {
      if (/\/delete$/.test(url)) return json({ sessionId: SID, items: [] });
      attachmentN += 1;
      const name = String(body?.['name']);
      return json({ id: `0000000${attachmentN}`, sessionId: SID, name, mime: body?.['mime'], bytes: 5, ref: `@~/.ashlr/verse/attachments/vs_1/0000000${attachmentN}-${name}`, createdAt: '2026-09-24T10:00:00Z' }, 201);
    }
    if (url.startsWith('/api/verse/files')) {
      const q = new URL(url, 'http://x').searchParams.get('q') ?? '';
      const files = state.files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase()));
      return json({ sessionId: SID, query: q, files, truncated: false, primaryRoot: '~/dev/hub' });
    }
    if (url.startsWith('/api/verse/budget')) return json({ effective: { 'claude-main': { seatId: 'claude-main', enabled: true, reservePercent: 40 } } });
    return json({ error: 'not found' }, 404);
  }));
  return state;
}

function props(over: Partial<ComposerProps> = {}): ComposerProps {
  return {
    sessionId: SID,
    seats: SEATS,
    seat: { seatId: 'claude-main', model: 'claude-opus-5' },
    engine: 'claude',
    running: false,
    disabled: false,
    locked: false,
    onSend: vi.fn(async () => true),
    onStop: vi.fn(),
    onSeatChange: vi.fn(),
    autoFocus: true,
    ...over,
  };
}

async function renderReady(p: ComposerProps = props()) {
  const view = render(<Composer {...p} />);
  // Controls and queue have loaded when the pickers are drawn.
  await screen.findByRole('button', { name: /^Permission mode:/ });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  setMutationToken('tok');
  server = installServer();
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

describe('pickers', () => {
  it('⇧⌘M opens Permission; arrows + Enter choose Plan; the menu closes and focus returns', async () => {
    const user = userEvent.setup();
    await renderReady();
    const button = screen.getByRole('button', { name: 'Permission mode: Accept edits' });
    await user.keyboard(chord('m'));
    const menu = await screen.findByRole('menu', { name: 'Permission mode' });
    expect(within(menu).getByRole('menuitemradio', { name: /Accept edits/ })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(within(menu).getByRole('menuitemradio', { name: /^Plan/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(server.posts(/session-controls\/vs_1$/)).toHaveLength(1));
    expect(server.posts(/session-controls\/vs_1$/)[0]!.body).toEqual({ permissionMode: 'plan' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    await screen.findByRole('button', { name: 'Permission mode: Plan' });
  });

  it('lists an option the seat cannot honour DISABLED with its reason, and Enter on it does nothing', async () => {
    server = installServer({ controls: { ...controlsView(), options: { ...controlsView().options, permissionModes: modes({ auto: 'Codex never asks in a chat — Accept edits already runs on its own.' }) } } });
    const user = userEvent.setup();
    await renderReady();
    await user.click(screen.getByRole('button', { name: /^Permission mode:/ }));
    const auto = screen.getByRole('menuitemradio', { name: /^Auto/ });
    expect(auto).toHaveAttribute('aria-disabled', 'true');
    expect(auto).toHaveAccessibleDescription('Codex never asks in a chat — Accept edits already runs on its own.');
    auto.focus();
    await user.keyboard('{Enter}');
    expect(server.posts(/session-controls/)).toHaveLength(0);
    // Escape closes without stopping anything.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('⇧⌘E picks an effort, Default resets it; a typed letter jumps', async () => {
    const user = userEvent.setup();
    await renderReady();
    await user.keyboard(chord('e'));
    const menu = await screen.findByRole('menu', { name: 'Effort' });
    expect(within(menu).getByRole('menuitemradio', { name: /^Default/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: /^Minimal/ })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('h');
    expect(within(menu).getByRole('menuitemradio', { name: /^High/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(server.posts(/session-controls/).at(-1)!.body).toEqual({ effort: 'high' }));
    await user.click(await screen.findByRole('button', { name: 'Effort: High' }));
    await user.click(screen.getByRole('menuitemradio', { name: /^Default/ }));
    await waitFor(() => expect(server.posts(/session-controls/).at(-1)!.body).toEqual({ effort: null }));
  });

  it('⇧⌘I switches the model; a running turn is told it applies next turn', async () => {
    server = installServer({ controls: controlsView({}, true) });
    const user = userEvent.setup();
    await renderReady(props({ running: true }));
    await user.keyboard(chord('i'));
    const menu = await screen.findByRole('menu', { name: 'Model' });
    expect(menu).toHaveTextContent('Changes apply from the next turn.');
    expect(within(menu).getByRole('menuitemradio', { name: /^Next/ })).toHaveAccessibleDescription('needs Claude Code 2.1.300');
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(server.posts(/session-controls/).at(-1)!.body).toEqual({ model: 'claude-sonnet-5' }));
    expect(await screen.findByText('The new model takes over from the next turn.')).toBeInTheDocument();
  });

  it('the palette reaches the same commands through the ashlr:command event', async () => {
    await renderReady();
    act(() => { window.dispatchEvent(new CustomEvent('ashlr:command', { detail: { id: 'composer.model' } })); });
    expect(await screen.findByRole('menu', { name: 'Model' })).toBeInTheDocument();
  });

  it('⌘K "Run in cloud…" opens the Chat settings sheet, where Run in cloud lives with its own checks', async () => {
    await renderReady();
    act(() => { window.dispatchEvent(new CustomEvent('ashlr:command', { detail: { id: 'composer.cloud' } })); });
    const sheet = await screen.findByRole('dialog', { name: 'Chat settings' });
    expect(await within(sheet).findByRole('button', { name: 'Run in cloud' })).toBeInTheDocument();
  });
});

describe('bypass', () => {
  it('asks first with focus on Cancel; Cancel changes nothing; the red button confirms for this chat', async () => {
    const user = userEvent.setup();
    await renderReady();
    await user.click(screen.getByRole('button', { name: /^Permission mode:/ }));
    const bypass = screen.getByRole('menuitemradio', { name: /^Bypass permissions/ });
    expect(bypass).toHaveAccessibleDescription(/Skips every permission check/);
    await user.click(bypass);
    const dialog = await screen.findByRole('dialog', { name: 'Bypass permissions for this chat?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(server.posts(/session-controls/)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /^Permission mode:/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /^Bypass permissions/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Bypass for this chat' }));
    await waitFor(() => expect(server.posts(/session-controls/)).toHaveLength(1));
    expect(server.posts(/session-controls/)[0]!.body).toEqual({ permissionMode: 'bypass', confirmBypass: true });
    const on = await screen.findByRole('button', { name: 'Permission mode: Bypass permissions' });
    expect(on.className).toMatch(/controlDanger/);
  });
});

// ---------------------------------------------------------------------------
// Queue, stop, send
// ---------------------------------------------------------------------------

describe('queued follow-ups', () => {
  it('Enter while a turn runs queues the message on the server and clears the box', async () => {
    const user = userEvent.setup();
    const p = props({ running: true });
    await renderReady(p);
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box).not.toBeDisabled();
    await user.type(box, 'then run the tests{Enter}');
    await waitFor(() => expect(server.posts(/queue\/vs_1$/)).toHaveLength(1));
    expect(server.posts(/queue\/vs_1$/)[0]!.body).toEqual({ text: 'then run the tests' });
    expect(p.onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('');
    const row = await screen.findByRole('region', { name: '1 queued follow-up' });
    expect(row).toHaveTextContent('Queued · sends when this turn ends');
    expect(row).toHaveTextContent('then run the tests');
  });

  it('⇧⌘Enter stops the turn and sends this message next', async () => {
    const user = userEvent.setup();
    await renderReady(props({ running: true }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'change of plan');
    await user.keyboard(chord('{Enter}'));
    await waitFor(() => expect(server.posts(/queue\/vs_1$/)).toHaveLength(1));
    expect(server.posts(/queue\/vs_1$/)[0]!.body).toEqual({ text: 'change of plan', sendNow: true });
    expect(await screen.findByText('Stopping the turn — this message goes next.')).toBeInTheDocument();
  });

  it('Esc stops the turn only from an empty box with nothing open', async () => {
    const user = userEvent.setup();
    const p = props({ running: true });
    await renderReady(p);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'draft');
    await user.keyboard('{Escape}');
    expect(p.onStop).not.toHaveBeenCalled();
    await user.clear(box);
    // A menu open over the box owns Esc.
    await user.keyboard(chord('m'));
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    expect(p.onStop).not.toHaveBeenCalled();
    box.focus();
    await user.keyboard('{Escape}');
    expect(p.onStop).toHaveBeenCalledTimes(1);
  });

  it('the row edits, sends now and removes; a held queue says why', async () => {
    server = installServer({
      queue: {
        sessionId: SID,
        held: true,
        heldReason: 'The last turn failed, so the follow-ups are waiting for you.',
        items: [
          { id: '000000000001', sessionId: SID, text: 'first follow-up', createdAt: '2026-09-24T10:00:00Z' },
          { id: '000000000002', sessionId: SID, text: 'second follow-up', createdAt: '2026-09-24T10:00:01Z' },
        ],
      },
    });
    const user = userEvent.setup();
    await renderReady();
    const row = await screen.findByRole('region', { name: '2 queued follow-ups' });
    expect(row).toHaveTextContent('Held — The last turn failed');
    await user.click(within(row).getByRole('button', { name: 'Edit queued message 1' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('first follow-up'));
    expect(server.posts(/000000000001\/delete$/)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Send queued message 1 now' }));
    await waitFor(() => expect(server.posts(/000000000002\/send$/)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: /queued follow-up/ })).not.toBeInTheDocument());
  });

  it('refuses a fourth follow-up in words', async () => {
    server = installServer({
      queue: { sessionId: SID, held: false, heldReason: null, items: [1, 2, 3].map((n) => ({ id: `00000000000${n}`, sessionId: SID, text: `q${n}`, createdAt: 'x' })) },
    });
    const user = userEvent.setup();
    await renderReady(props({ running: true }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'one more');
    expect(screen.getByRole('button', { name: 'Queue is full' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(server.posts(/queue\/vs_1$/)).toHaveLength(0);
  });

  it('idle: Enter sends through onSend as before', async () => {
    const user = userEvent.setup();
    const p = props();
    await renderReady(p);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello{Enter}');
    await waitFor(() => expect(p.onSend).toHaveBeenCalledWith('hello'));
    expect(server.posts(/queue/)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe('attachments', () => {
  it('paste uploads, shows a chip and puts the @path token in the text; × removes both', async () => {
    const user = userEvent.setup();
    await renderReady();
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'look at');
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    fireEvent.paste(box, { clipboardData: { files: [file], getData: () => '' } });
    await waitFor(() => expect(server.posts(/attachments\/vs_1$/)).toHaveLength(1));
    expect(server.posts(/attachments\/vs_1$/)[0]!.body).toMatchObject({ name: 'notes.md', mime: 'text/markdown', dataBase64: btoa('hello') });
    const chips = await screen.findByRole('list', { name: 'Attachments' });
    await waitFor(() => expect(within(chips).getByText('5 B')).toBeInTheDocument());
    await waitFor(() => expect(box).toHaveValue('look at @~/.ashlr/verse/attachments/vs_1/00000001-notes.md '));
    await user.click(within(chips).getByRole('button', { name: 'Remove notes.md' }));
    await waitFor(() => expect(server.posts(/00000001\/delete$/)).toHaveLength(1));
    expect(box).toHaveValue('look at ');
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  it('refuses a file over 8 MB before uploading it, and says so on the chip', async () => {
    await renderReady();
    const big = new File(['x'], 'huge.bin', { type: 'application/octet-stream' });
    Object.defineProperty(big, 'size', { value: 8 * 1024 * 1024 + 1 });
    fireEvent.paste(screen.getByRole('textbox', { name: 'Message' }), { clipboardData: { files: [big], getData: () => '' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('each file must be 8.0 MB or smaller');
    expect(server.posts(/attachments/)).toHaveLength(0);
  });

  it('grok cannot read attachments: + explains, paste is refused in words', async () => {
    await renderReady(props({ seat: { seatId: 'grok-a', model: 'build-fast' }, engine: 'grok' }));
    const plus = screen.getByRole('button', { name: 'Attach files' });
    expect(plus).toHaveAttribute('aria-disabled', 'true');
    fireEvent.paste(screen.getByRole('textbox', { name: 'Message' }), { clipboardData: { files: [new File(['x'], 'a.txt')], getData: () => '' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Grok can only open files inside the project folder');
    expect(server.posts(/attachments/)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// @ and /
// ---------------------------------------------------------------------------

describe('@ files and / commands', () => {
  it('@ fuzzy-finds files; ↓ + Enter inserts a relative @path for the chat’s own folder', async () => {
    const user = userEvent.setup();
    await renderReady();
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'open @comp');
    const list = await screen.findByRole('listbox', { name: 'Files in this chat’s folders' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
    expect(box).toHaveAttribute('aria-activedescendant', within(list).getAllByRole('option')[0]!.id);
    await user.keyboard('{Enter}');
    expect(box).toHaveValue('open @src/web-ui/routes/verse/Composer.tsx ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    const search = server.calls.find((c) => c.url.startsWith('/api/verse/files'))!;
    expect(search.url).toContain('sessionId=vs_1');
  });

  it('Esc closes the finder without clearing the draft or stopping anything', async () => {
    const user = userEvent.setup();
    const p = props({ running: true });
    await renderReady(p);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), '@read');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('@read');
    expect(p.onStop).not.toHaveBeenCalled();
  });

  it('/ offers the six commands; /plan switches to Plan and clears itself', async () => {
    const user = userEvent.setup();
    await renderReady();
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, '/');
    const list = await screen.findByRole('listbox', { name: 'Commands' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('/handoff'), expect.stringContaining('/compact'), expect.stringContaining('/new'),
      expect.stringContaining('/plan'), expect.stringContaining('/effort'), expect.stringContaining('/model'),
    ]);
    // No handoff wired by the owner: listed, disabled, and says where it is.
    expect(within(list).getAllByRole('option')[0]).toHaveAttribute('aria-disabled', 'true');
    await user.type(box, 'pl{Enter}');
    await waitFor(() => expect(server.posts(/session-controls/).at(-1)!.body).toEqual({ permissionMode: 'plan' }));
    expect(box).toHaveValue('');
  });

  it('/model opens the model picker; /new starts a new chat on this seat; /handoff calls the owner', async () => {
    const user = userEvent.setup();
    const onHandoff = vi.fn();
    const p = props({ onHandoff });
    await renderReady(p);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, '/mod{Enter}');
    expect(await screen.findByRole('menu', { name: 'Model' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    box.focus();
    await user.type(box, '/new{Enter}');
    expect(p.onSeatChange).toHaveBeenCalledWith({ seatId: 'claude-main', model: 'claude-opus-5' });
    await user.type(box, '/hand{Enter}');
    expect(onHandoff).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Footer: seat chip, 375
// ---------------------------------------------------------------------------

describe('footer', () => {
  it('the seat chip says the seat and its capacity, and offers Continue on ‹seat› when wired', async () => {
    const user = userEvent.setup();
    const onContinueOn = vi.fn();
    await renderReady(props({ onContinueOn }));
    const chip = screen.getByRole('button', { name: /^Seat: Claude Max, 5h window 12% used/ });
    await user.click(chip);
    const menu = screen.getByRole('menu', { name: 'Seat' });
    await user.click(within(menu).getByRole('menuitem', { name: /Continue on Qwen3 Coder/ }));
    expect(onContinueOn).toHaveBeenCalledWith({ seatId: 'local:qwen3-coder', model: 'qwen3-coder' });
  });

  it('the context ring states occupancy in words; unknown is "—", never zero', async () => {
    const view = await renderReady(props({ contextTokens: 50_000, contextWindow: 200_000, autoCompactAt: 167_000 }));
    expect(screen.getByRole('img', { name: 'Context 25% — 50k of 200k tokens, compacts ≈167k' })).toBeInTheDocument();
    view.rerender(<Composer {...props({ contextTokens: null, contextWindow: null })} />);
    expect(screen.getByRole('img', { name: 'Context — not measured yet' })).toBeInTheDocument();
  });

  describe('at 375px', () => {
    let vp: ViewportMock;
    beforeEach(() => { vp = mockCompactViewport(); });
    afterEach(() => vp.restore());

    it('folds to [+] [mic] · seat · ⋯ · Send, with the pickers in a bottom sheet', async () => {
      const user = userEvent.setup();
      render(<Composer {...props()} />);
      const more = await screen.findByRole('button', { name: /^Chat settings: Accept edits, Opus 5/ });
      expect(screen.queryByRole('button', { name: /^Permission mode:/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Model:/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('img', { name: /^Context/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Attach files' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Seat:/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();

      await user.click(more);
      const sheet = screen.getByRole('dialog', { name: 'Chat settings' });
      expect(within(sheet).getByRole('button', { name: 'Done' })).toHaveFocus();
      for (const name of ['Permission mode', 'Model', 'Effort']) expect(within(sheet).getByRole('menu', { name })).toBeInTheDocument();
      // Keyboard: Tab reaches each list at its checked option; the arrows move within it.
      await user.tab();
      const permission = within(sheet).getByRole('menu', { name: 'Permission mode' });
      expect(within(permission).getByRole('menuitemradio', { name: /^Accept edits/ })).toHaveFocus();
      await user.keyboard('{ArrowUp}{Enter}');
      await waitFor(() => expect(server.posts(/session-controls/).at(-1)!.body).toEqual({ permissionMode: 'plan' }));
      await user.tab();
      expect(within(within(sheet).getByRole('menu', { name: 'Model' })).getByRole('menuitemradio', { name: /^Opus 5/ })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(more).toHaveFocus();
    });

    it('a picker shortcut opens the sheet on a phone', async () => {
      const user = userEvent.setup();
      render(<Composer {...props()} />);
      await screen.findByRole('button', { name: /^Chat settings/ });
      await user.keyboard(chord('e'));
      expect(screen.getByRole('dialog', { name: 'Chat settings' })).toBeInTheDocument();
    });
  });

  it('drafts text in from another pane once per request, never sending it', async () => {
    const p = props();
    const view = await renderReady(p);
    const box = screen.getByRole('textbox', { name: 'Message' });
    view.rerender(<Composer {...p} insertRequest={{ nonce: 1, text: 'src/a.ts:12: rename this' }} />);
    await waitFor(() => expect(box).toHaveValue('src/a.ts:12: rename this'));
    view.rerender(<Composer {...p} insertRequest={{ nonce: 1, text: 'src/a.ts:12: rename this' }} />);
    view.rerender(<Composer {...p} insertRequest={{ nonce: 2, text: '```\nnpm test\n```' }} />);
    await waitFor(() => expect(box).toHaveValue('src/a.ts:12: rename this\n\n```\nnpm test\n```'));
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it('an older server without session controls keeps the 3.9 composer working', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'not found' }, 404)));
    const user = userEvent.setup();
    const p = props({ running: true });
    render(<Composer {...p} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'draft{Enter}');
    // No queue route: Enter keeps the draft rather than losing it.
    expect(box).toHaveValue('draft');
    expect(screen.queryByRole('button', { name: /^Permission mode:/ })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Footer polish (3.10.1): one row, every word whole, the model said once
// ---------------------------------------------------------------------------

/** The live case that read "Qwen3.8 27b-ctx64k (l…" · ○ · "Qwen3.8 27b-ctx64k ▾" · "No effort setting". */
const QWEN_SEAT: VerseSeat = {
  ...LOCAL_SEAT,
  id: 'local:qwen3.8:27b-ctx64k',
  label: 'Qwen3.8 27b-ctx64k (local)',
  models: [{ id: 'qwen3.8:27b-ctx64k', label: 'Qwen3.8 27b-ctx64k', contextWindow: 65_536 }],
};

function localView(): VerseSessionControlsResponse {
  return {
    sessionId: SID,
    controls: { model: 'qwen3.8:27b-ctx64k', effort: null, permissionMode: 'accept-edits' },
    appliesNextTurn: false,
    options: {
      models: [{ id: 'qwen3.8:27b-ctx64k', label: 'Qwen3.8 27b-ctx64k', available: true }],
      efforts: controlsView().options.efforts.map((o) => ({ ...o, available: false, reason: 'Local models run without an effort setting.' })),
      permissionModes: modes({ auto: 'Auto needs Anthropic’s safety check, which a local model can’t provide.' }),
    },
  };
}

function footerOf(): HTMLElement {
  // Attach → its cluster (footerLeft) → the footer row.
  return screen.getByRole('button', { name: 'Attach files' }).closest('div')!.parentElement!;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('footer — the model is said once', () => {
  it('the seat chip names the account and the Model picker the model', async () => {
    await renderReady();
    const footer = footerOf();
    expect(count(footer.textContent ?? '', 'Opus 5')).toBe(1);
    expect(screen.getByRole('button', { name: /^Seat: Claude Max,/ })).not.toHaveTextContent('Opus');
    expect(screen.getByRole('button', { name: 'Model: Opus 5' })).toHaveTextContent('Opus 5');
  });

  it('a local seat reads "Local" + the model, with no empty capacity ring and no effort control', async () => {
    server = installServer({ controls: localView() });
    await renderReady(props({ seats: [...SEATS, QWEN_SEAT], seat: { seatId: QWEN_SEAT.id, model: 'qwen3.8:27b-ctx64k' }, engine: 'local' }));
    const footer = footerOf();
    expect(count(footer.textContent ?? '', 'Qwen3.8 27b-ctx64k')).toBe(1);
    const chip = screen.getByRole('button', { name: 'Seat: Local, no usage limits' });
    expect(chip).toHaveTextContent(/^Local$/);
    expect(chip.querySelector('svg[data-provider="local"]')).not.toBeNull();
    // The hollow circle is gone: a seat without limits draws no ring at all.
    expect(chip.querySelector('svg[data-tone]')).toBeNull();
    // No effort on this seat: no control, and no "No effort setting" either.
    expect(screen.queryByRole('button', { name: /^Effort/ })).toBeNull();
    expect(footer).not.toHaveTextContent(/effort/i);
  });

  it('before session controls load (or on an older server) the model is plain text in the same place', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'not found' }, 404)));
    render(<Composer {...props()} />);
    const footer = footerOf();
    expect(count(footer.textContent ?? '', 'Opus 5')).toBe(1);
    expect(screen.queryByRole('button', { name: /^Model:/ })).toBeNull();
  });
});

describe('footer — whole words', () => {
  it.each([
    ['plan', 'Plan', 'Plan'],
    ['accept-edits', 'Accept edits', 'Accept edits'],
    ['auto', 'Auto', 'Auto'],
    ['bypass', 'Bypass', 'Bypass permissions'],
  ] as const)('mode %s shows "%s" in full; its name and tooltip carry "%s"', async (mode, shown, full) => {
    server = installServer({ controls: controlsView({ permissionMode: mode }) });
    await renderReady();
    const button = screen.getByRole('button', { name: `Permission mode: ${full}` });
    expect(button).toHaveTextContent(new RegExp(`^${shown}$`));
    // The Tooltip primitive, not a native title (which never shows on keyboard focus).
    expect(button).not.toHaveAttribute('title');
    act(() => { button.focus(); });
    expect(screen.getByRole('tooltip')).toHaveTextContent(new RegExp(`^Permission mode: ${full}.+M$`));
  });

  it('no footer label can ellipsize: no max-width, no text-overflow on the picker, chip or send text', () => {
    const css = 'routes/verse/composer/composer.module.css';
    for (const selector of ['.control', '.seatChip']) expect(moduleDeclaration(css, selector, 'max-width')).toBeNull();
    for (const selector of ['.controlText', '.seatChipText', '.controlStatic']) {
      expect(moduleDeclaration(css, selector, 'text-overflow')).toBeNull();
      expect(moduleDeclaration(css, selector, 'white-space')).toBe('nowrap');
    }
    // Hit targets: every footer control is the 28px step.
    for (const selector of ['.control', '.seatChip', '.contextRing', '.controlStatic']) {
      expect(moduleDeclaration(css, selector, 'min-height')).toBe('var(--control-h-sm)');
    }
  });

  it('effort reads "Effort: High" where the seat supports it', async () => {
    server = installServer({ controls: controlsView({ effort: 'high' }) });
    await renderReady();
    expect(screen.getByRole('button', { name: 'Effort: High' })).toHaveTextContent(/^Effort: High$/);
  });

  it('the placeholder says what the box takes', async () => {
    await renderReady();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Ask anything — @ to add files, / for commands');
  });

  it('Send shows ⏎; while a turn runs ■ and Queue stay put whether or not there is text', async () => {
    const user = userEvent.setup();
    const view = await renderReady();
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveTextContent('Send⏎');
    view.rerender(<Composer {...props({ running: true })} />);
    const queue = await screen.findByRole('button', { name: /^Queue this message/ });
    expect(queue).toBeDisabled();
    const before = footerOf().textContent;
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'then run the tests');
    expect(queue).toBeEnabled();
    expect(footerOf().textContent).toBe(before);
    expect(screen.getByRole('button', { name: 'Stop the running turn' })).toBeInTheDocument();
  });
});

describe('footer — context ring', () => {
  const reading = { contextTokens: 150_000, contextWindow: 200_000, autoCompactAt: 167_000 };

  it('focus shows used / limit tokens and the compaction point', async () => {
    await renderReady(props(reading));
    const ring = screen.getByRole('img', { name: 'Context 75% — 150k of 200k tokens, compacts ≈167k' });
    ring.focus();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Context: 150,000 of 200,000 tokens (75%).');
    expect(tip).toHaveTextContent('Auto-compacts at ≈167,000 tokens — ≈17,000 left.');
    expect(ring).toHaveAccessibleDescription(/Auto-compacts at ≈167,000 tokens/);
  });

  it('matches the header ring: same figure, same tone, the same compaction tick', async () => {
    await renderReady(props(reading));
    const ring = screen.getByRole('img', { name: /^Context 75%/ });
    render(<ContextMeter variant="ring" {...reading} exact engine="claude" />);
    const header = screen.getByRole('meter', { name: 'Context window' });
    expect(ring).toHaveTextContent('75%');
    expect(header).toHaveTextContent('75%');
    expect(ring.dataset['tone']).toBe(header.dataset['tone']);
    expect(ring.dataset['tone']).toBe('warn');
    expect(ring.querySelector('[data-testid="compaction-tick"]')).not.toBeNull();
  });

  it('marks an upper bound with ≤, as the header does', async () => {
    await renderReady(props({ ...reading, contextTokens: 50_000, contextExact: false }));
    expect(screen.getByRole('img', { name: /^Context ≤25% — ≤50k of 200k tokens/ })).toHaveTextContent('≤25%');
  });
});

describe('footer — folds instead of truncating', () => {
  // jsdom lays nothing out: give every element the footer's width, and make
  // an element's content as wide as its visible text — plus the seat chip's
  // capacity ring, which has no text but takes room — so the fold steps are
  // exercised for real. Spies on Element.prototype (where jsdom defines both
  // getters), so the config's `restoreMocks` puts jsdom's own back after each test.
  const CHAR = 8;
  const RING_CHARS = 3;
  let limitChars = 0;
  const observers = new Set<{ deliver(): void }>();

  beforeEach(() => {
    observers.clear();
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function scrollWidth(this: Element) {
      // Visible text only: a screen-reader-only label takes no room.
      let chars = (this.textContent ?? '').length;
      this.querySelectorAll('.visually-hidden').forEach((hidden) => { chars -= (hidden.textContent ?? '').length; });
      chars += this.querySelectorAll('svg[data-tone]').length * RING_CHARS;
      // A provider mark takes the room its monogram letter used to (3.11.1).
      chars += this.querySelectorAll('svg[data-provider]').length;
      return chars * CHAR;
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => limitChars * CHAR);
    // Reports only when the test moves the width: the first measurement must
    // not wait for it (a real observer delivers after the first paint).
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      deliver() { this.callback([{ contentRect: { width: limitChars * CHAR } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
      unobserve() {}
    });
  });

  /** The chat column changes width (the dock or sidebar opens or closes, a drag). */
  function resize(chars: number) {
    limitChars = chars;
    act(() => { for (const observer of observers) observer.deliver(); });
  }

  // Visible at fold 0: "Accept edits" "C" "Claude Max" ring "Opus 5" "Effort: High" "—" "Send⏎" = 50 chars;
  // fold 1 drops "Effort: " (42), fold 2 "Claude Max" (32), fold 3 "Accept edits" (20); fold 4 is "C" ring "Send⏎" (9).

  it('drops "Effort:", then the seat name, then the mode word — names intact, nothing ellipsized', async () => {
    const user = userEvent.setup();
    limitChars = 25;
    server = installServer({ controls: controlsView({ effort: 'high' }) });
    render(<Composer {...props()} />);
    const mode = await screen.findByRole('button', { name: 'Permission mode: Accept edits' });
    await waitFor(() => expect(mode).toHaveTextContent(/^$/));
    expect(screen.getByRole('button', { name: /^Seat: Claude Max,/ })).not.toHaveTextContent('Claude Max');
    const effort = screen.getByRole('button', { name: 'Effort: High' });
    expect(effort).toHaveTextContent(/^High$/);
    expect(effort.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Model: Opus 5' })).toHaveTextContent('Opus 5');
    expect(screen.queryByRole('button', { name: /^Chat settings/ })).toBeNull();
    // Typing never refolds the row.
    const before = footerOf().textContent;
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'a long message that changes nothing below it');
    expect(footerOf().textContent).toBe(before);
    expect(mode).toHaveTextContent(/^$/);
  });

  it('too narrow even for icons: the pickers move into the ⋯ sheet', async () => {
    limitChars = 10;
    render(<Composer {...props()} />);
    const more = await screen.findByRole('button', { name: /^Chat settings: Accept edits, Opus 5/ });
    expect(screen.queryByRole('button', { name: /^Permission mode:/ })).toBeNull();
    const user = userEvent.setup();
    await user.click(more);
    expect(within(screen.getByRole('dialog', { name: 'Chat settings' })).getByRole('menu', { name: 'Model' })).toBeInTheDocument();
  });

  it('mounts already folded — on every chat switch — without waiting for a ResizeObserver delivery', async () => {
    limitChars = 25;
    server = installServer({ controls: controlsView({ effort: 'high' }) });
    const view = render(<Composer key="vs_1" {...props()} />);
    expect(await screen.findByRole('button', { name: 'Permission mode: Accept edits' })).toHaveTextContent(/^$/);
    // Workspace keys Composer by chat: a switch mounts a new one.
    view.rerender(<Composer key="vs_2" {...props({ sessionId: 'vs_2' })} />);
    const mode = await screen.findByRole('button', { name: 'Permission mode: Accept edits' });
    expect(mode).toHaveTextContent(/^$/);
    expect(screen.getByRole('button', { name: 'Effort: High' })).toHaveTextContent(/^High$/);
    expect(observers.size).toBe(1);
  });

  it('a width change folds from where it is: no render while the fold holds, one render to a new fold, never back through fold 0', async () => {
    limitChars = 25;
    server = installServer({ controls: controlsView({ effort: 'high' }) });
    let commits = 0;
    render(<Profiler id="composer" onRender={() => { commits += 1; }}><Composer {...props()} /></Profiler>);
    const mode = await screen.findByRole('button', { name: 'Permission mode: Accept edits' });
    await waitFor(() => expect(mode).toHaveTextContent(/^$/));
    await act(async () => {});
    const seatChip = screen.getByRole('button', { name: /^Seat: Claude Max,/ });

    // A drag: a pixel at a time, the fold never changes — nothing renders.
    commits = 0;
    for (const chars of [24, 26, 28, 31, 30]) resize(chars);
    expect(commits).toBe(0);
    expect(mode).toHaveTextContent(/^$/);

    // Room for fold 2 (32) but not fold 1 (42): ONE render, straight there.
    resize(33);
    expect(commits).toBe(1);
    expect(mode).toHaveTextContent(/^Accept edits$/);
    expect(seatChip).not.toHaveTextContent('Claude Max');
    expect(screen.getByRole('button', { name: 'Effort: High' })).toHaveTextContent(/^High$/);

    // Narrower again: one step up from here, not a climb from fold 0.
    commits = 0;
    resize(25);
    expect(commits).toBe(1);
    expect(mode).toHaveTextContent(/^$/);

    // Room for every word: one render to fold 0.
    commits = 0;
    resize(60);
    expect(commits).toBe(1);
    expect(screen.getByRole('button', { name: 'Effort: High' })).toHaveTextContent(/^Effort: High$/);
    expect(seatChip).toHaveTextContent('Claude Max');
  });

  it('measures again when the seat’s capacity ring appears or goes (it takes room without changing a word)', async () => {
    const unread: VerseSeat = { ...CLAUDE_SEAT, health: { ...CLAUDE_SEAT.health, summary: null, windows: [] } };
    // No ring: fold 2 is 29 chars and fits 30. With the ring it is 32 and does not.
    limitChars = 30;
    server = installServer({ controls: controlsView({ effort: 'high' }) });
    const view = render(<Composer {...props({ seats: [unread, CODEX_SEAT, LOCAL_SEAT, GROK_SEAT] })} />);
    const mode = await screen.findByRole('button', { name: 'Permission mode: Accept edits' });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Seat: Claude Max,/ })).not.toHaveTextContent('Claude Max'));
    expect(mode).toHaveTextContent(/^Accept edits$/);
    expect(screen.getByRole('button', { name: /^Seat: Claude Max,/ }).querySelector('svg[data-tone]')).toBeNull();

    // The next roster poll brings a reading: the ring appears, and the row folds one more step.
    view.rerender(<Composer {...props()} />);
    expect(screen.getByRole('button', { name: /^Seat: Claude Max,/ }).querySelector('svg[data-tone]')).not.toBeNull();
    expect(mode).toHaveTextContent(/^$/);

    // …and unfolds again when the reading goes.
    view.rerender(<Composer {...props({ seats: [unread, CODEX_SEAT, LOCAL_SEAT, GROK_SEAT] })} />);
    expect(mode).toHaveTextContent(/^Accept edits$/);
  });

  it('words that change while the footer has no size are measured when it gets one back, even at the same width', async () => {
    const unread: VerseSeat = { ...CLAUDE_SEAT, health: { ...CLAUDE_SEAT.health, summary: null, windows: [] } };
    // No ring: 47 chars, fits 48. With the ring: 50 — fold 1 (42).
    limitChars = 48;
    server = installServer({ controls: controlsView({ effort: 'high' }) });
    const view = render(<Composer {...props({ seats: [unread, CODEX_SEAT, LOCAL_SEAT, GROK_SEAT] })} />);
    const effort = await screen.findByRole('button', { name: 'Effort: High' });
    expect(effort).toHaveTextContent(/^Effort: High$/);
    resize(0); // the panel is hidden
    view.rerender(<Composer {...props()} />);
    resize(48); // shown again, at the width it had
    expect(effort).toHaveTextContent(/^High$/);
  });

  it('the icon-only mode picker shows its words on keyboard focus (the Tooltip, not a hover-only title)', async () => {
    const user = userEvent.setup();
    limitChars = 25;
    render(<Composer {...props()} />);
    const mode = await screen.findByRole('button', { name: 'Permission mode: Accept edits' });
    await waitFor(() => expect(mode).toHaveTextContent(/^$/));
    expect(mode).not.toHaveAttribute('title');
    screen.getByRole('textbox', { name: 'Message' }).focus();
    for (let i = 0; i < 6 && document.activeElement !== mode; i++) await user.tab();
    expect(mode).toHaveFocus();
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Permission mode: Accept edits.+M$/);
    expect(mode).toHaveAccessibleDescription(/^Permission mode: Accept edits/);
    await user.tab();
    expect(screen.queryByRole('tooltip', { name: /Permission mode/ })).toBeNull();
  });

  describe('the ⋯ sheet in a wide window with a narrow chat column', () => {
    it('a pick in the sheet keeps the sheet and the focus where they are; Esc returns to ⋯', async () => {
      const user = userEvent.setup();
      limitChars = 10;
      const p = props();
      const view = render(<Composer {...p} />);
      await user.click(await screen.findByRole('button', { name: /^Chat settings: Accept edits, Opus 5/ }));
      const sheet = screen.getByRole('dialog', { name: 'Chat settings' });
      // Done → the Permission list → the Model list.
      await user.tab();
      await user.tab();
      const models = within(sheet).getByRole('menu', { name: 'Model' });
      expect(within(models).getByRole('menuitemradio', { name: /^Opus 5/ })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      const sonnet = within(models).getByRole('menuitemradio', { name: /^Sonnet 5/ });
      expect(sonnet).toHaveFocus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(server.posts(/session-controls/).at(-1)!.body).toEqual({ model: 'claude-sonnet-5' }));
      await waitFor(() => expect(sonnet).toHaveAttribute('aria-checked', 'true'));
      // New words in the row (the model's name): the sheet was not remounted and focus stayed on the pick.
      expect(screen.getByRole('dialog', { name: 'Chat settings' })).toBe(sheet);
      expect(sonnet).toHaveFocus();
      // A turn starting under the open sheet changes the words again: still nothing moves.
      view.rerender(<Composer {...p} running />);
      expect(screen.getByRole('dialog', { name: 'Chat settings' })).toBe(sheet);
      expect(sonnet).toHaveFocus();
      // Esc: focus back on ⋯ (the one on screen now), never <body>.
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: /^Chat settings: Accept edits, Sonnet 5/ })).toHaveFocus();
    });

    it('widening under the open sheet leaves it open; closed, the row unfolds, focus lands in the box, and Esc stops the turn', async () => {
      const user = userEvent.setup();
      limitChars = 10;
      const p = props({ running: true });
      render(<Composer {...p} />);
      await user.click(await screen.findByRole('button', { name: /^Chat settings/ }));
      const sheet = screen.getByRole('dialog', { name: 'Chat settings' });
      resize(200);
      expect(screen.getByRole('dialog', { name: 'Chat settings' })).toBe(sheet);
      expect(sheet).toContainElement(document.activeElement as HTMLElement);

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Permission mode: Accept edits' })).toHaveTextContent(/^Accept edits$/);
      const box = screen.getByRole('textbox', { name: 'Message' });
      expect(box).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(p.onStop).toHaveBeenCalledTimes(1);

      // Narrow again: the row folds to ⋯, and the sheet does not come back by itself.
      resize(10);
      expect(screen.getByRole('button', { name: /^Chat settings/ })).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('a picker menu open while the column narrows: nothing folds under it; closed, focus goes to ⋯ and Esc still stops the turn', async () => {
      const user = userEvent.setup();
      limitChars = 200;
      const p = props({ running: true });
      render(<Composer {...p} />);
      await screen.findByRole('button', { name: /^Permission mode:/ });
      await user.keyboard(chord('i'));
      const menu = await screen.findByRole('menu', { name: 'Model' });
      resize(10);
      expect(menu).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Chat settings/ })).toBeNull();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
      // The Model button folded into ⋯ as the menu closed: focus follows it there.
      expect(screen.getByRole('button', { name: /^Chat settings/ })).toHaveFocus();
      screen.getByRole('textbox', { name: 'Message' }).focus();
      await user.keyboard('{Escape}');
      expect(p.onStop).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ControlMenu', () => {
  it('unmounted while open, it reports itself closed (else the composer’s Esc-to-stop stays disarmed)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const view = render(
      <ControlMenu<string> label="Model" valueLabel="Opus 5" value="a" onChange={() => {}} onOpenChange={onOpenChange}
        options={[{ id: 'a', label: 'Opus 5', available: true }, { id: 'b', label: 'Sonnet 5', available: true }]} />,
    );
    await user.click(screen.getByRole('button', { name: 'Model: Opus 5' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    view.unmount();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('closed when unmounted, it reports nothing', () => {
    const onOpenChange = vi.fn();
    const view = render(
      <ControlMenu<string> label="Model" valueLabel="Opus 5" value="a" onChange={() => {}} onOpenChange={onOpenChange}
        options={[{ id: 'a', label: 'Opus 5', available: true }]} />,
    );
    view.unmount();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe('the fold tests’ width stubs', () => {
  it('leave jsdom’s own widths in place for every later test', () => {
    expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')).toBeUndefined();
    const probe = document.createElement('div');
    probe.textContent = 'x'.repeat(40);
    document.body.append(probe);
    expect(probe.scrollWidth).toBe(0);
    expect(probe.clientWidth).toBe(0);
    probe.remove();
  });
});

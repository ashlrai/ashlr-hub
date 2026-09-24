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
 *   - at 375px the footer folds its pickers into a bottom sheet.
 */
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
    const chip = screen.getByRole('button', { name: /^Seat: Claude Max · Opus 5, 5h window 12% used/ });
    await user.click(chip);
    const menu = screen.getByRole('menu', { name: 'Seat' });
    await user.click(within(menu).getByRole('menuitem', { name: /Continue on Qwen3 Coder/ }));
    expect(onContinueOn).toHaveBeenCalledWith({ seatId: 'local:qwen3-coder', model: 'qwen3-coder' });
  });

  it('the context ring states occupancy in words; unknown is "—", never zero', async () => {
    const view = await renderReady(props({ contextTokens: 50_000, contextWindow: 200_000, autoCompactAt: 167_000 }));
    expect(screen.getByRole('img', { name: /^Context 25% — 50k of 200k tokens; the CLI compacts at 167k/ })).toBeInTheDocument();
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

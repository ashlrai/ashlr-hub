/**
 * ComputerControl — RTL over a fake relay api and a fake native bridge.
 *
 * Under test:
 *   - nothing renders (and nothing polls) without a supporting shell;
 *   - the access sheet: chat title, the agent's reason as text, one row per
 *     app with its tier, denied apps disabled, nothing pre-ticked, Allow
 *     disabled until a tick, Deny / Esc decline; answers post once;
 *   - the confirmation card: Deny focused, buttons map to once/chat/deny,
 *     Esc denies; prompts from several chats queue;
 *   - a no-permission answer from native opens the onboarding sheet;
 *   - the pill: grants listed with Revoke, KILL = native kill + api.kill,
 *     native `killed` by Esc also revokes on the sidecar.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  NativeComputerOp,
  VerseComputerCommand,
  VerseComputerCommandResult,
  VerseComputerCommandsResponse,
  VerseComputerState,
} from '../../../../core/verse/computer-types.js';
import { ComputerControl, confirmWhy, type ComputerControlDeps } from './ComputerControl.js';
import type { ComputerApi } from './computer-queries.js';
import type { NativeComputer, NativeComputerResult, NativeComputerStateEvent } from './native-computer.js';

const ID1 = 'cc_AAAAAAAAAAA1';
const ID2 = 'cc_AAAAAAAAAAA2';
const AT = '2026-09-27T10:00:00Z';

const NO_GRANTS: VerseComputerState = { windowPresent: true, chats: [] };
const ONE_GRANT: VerseComputerState = {
  windowPresent: true,
  chats: [{ sessionId: 's-1', grants: [{ bundleId: 'com.apple.mail', name: 'Mail', tier: 'full', grantedAt: AT }], allowedForChat: [] }],
};

function access(id: string, reason = 'Check the build in Xcode'): VerseComputerCommand {
  return {
    id,
    sessionId: 's-1',
    kind: 'access',
    reason,
    createdAt: AT,
    apps: [
      { bundleId: 'com.apple.dt.Xcode', name: 'Xcode', tier: 'click', category: 'terminal-ide', reason: 'Terminals and editors are click-only.', running: true },
      { bundleId: 'com.apple.mail', name: 'Mail', tier: 'full', category: 'other', reason: 'Full control.', running: false },
      { bundleId: 'com.1password.1password', name: '1Password', tier: null, category: 'denied', reason: 'Never available to agents.', running: true },
    ],
  };
}

function confirm(id: string, sessionId = 's-1'): VerseComputerCommand {
  return {
    id,
    sessionId,
    kind: 'confirm',
    createdAt: AT,
    confirm: { action: 'click', app: 'Mail', label: 'Send', reason: 'sensitive-label', summary: 'click "Send" in Mail' },
  };
}

function harness(opts: { state?: VerseComputerState; answer?: (op: Extract<NativeComputerOp, { req: string }>) => NativeComputerResult } = {}) {
  let queue: VerseComputerCommand[] = [];
  let wake: (() => void) | null = null;
  const results: VerseComputerCommandResult[] = [];
  let currentState = opts.state ?? NO_GRANTS;
  const api: ComputerApi = {
    commands: vi.fn(async (signal?: AbortSignal): Promise<VerseComputerCommandsResponse> => {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener('abort', () => resolve());
        });
      }
      const out = queue;
      queue = [];
      return { commands: out };
    }),
    result: vi.fn(async (r: VerseComputerCommandResult) => {
      results.push(r);
    }),
    state: vi.fn(async () => currentState),
    revoke: vi.fn(async () => {
      currentState = NO_GRANTS;
      return NO_GRANTS;
    }),
    kill: vi.fn(async () => {
      currentState = NO_GRANTS;
      return NO_GRANTS;
    }),
    canWrite: vi.fn(() => true),
  };
  const stateListeners = new Set<(e: NativeComputerStateEvent) => void>();
  const sent: NativeComputerOp[] = [];
  const native: NativeComputer = {
    version: 1,
    send: vi.fn((op: NativeComputerOp) => (sent.push(op), true)),
    request: vi.fn(async (op: Extract<NativeComputerOp, { req: string }>) => {
      sent.push(op);
      return opts.answer ? opts.answer(op) : ({ kind: 'result', req: op.req, ok: true, data: { screen: true, accessibility: true } } as NativeComputerResult);
    }),
    onState: vi.fn((listener: (e: NativeComputerStateEvent) => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    }),
  };
  const deps: Partial<ComputerControlDeps> = {
    api,
    native: () => native,
    titleOf: (id) => (id === 's-1' ? 'Fix the release notes' : null),
  };
  return {
    api,
    native,
    sent,
    results,
    deps,
    push(...commands: VerseComputerCommand[]) {
      act(() => {
        queue.push(...commands);
        const w = wake;
        wake = null;
        w?.();
      });
    },
    state(event: NativeComputerStateEvent) {
      act(() => {
        for (const l of stateListeners) l(event);
      });
    },
  };
}

let unmount: (() => void) | null = null;
function mount(h: ReturnType<typeof harness>) {
  const r = render(<ComputerControl deps={h.deps} />);
  unmount = r.unmount;
  return r;
}
afterEach(() => {
  unmount?.();
  unmount = null;
});

describe('without a supporting shell', () => {
  it('renders nothing and never polls', async () => {
    const h = harness();
    const { container } = render(<ComputerControl deps={{ ...h.deps, native: () => null }} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container).toBeEmptyDOMElement();
    expect(h.api.commands).not.toHaveBeenCalled();
    expect(h.api.state).not.toHaveBeenCalled();
  });
});

describe('the access sheet', () => {
  it('shows the request with denied apps disabled and nothing ticked', async () => {
    const h = harness();
    mount(h);
    h.push(access(ID1, '<b>please</b>\u202e click everything'));
    const dialog = await screen.findByRole('dialog', { name: 'An agent wants to control apps on this Mac' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Fix the release notes')).toBeInTheDocument();
    // The agent's words are text, not markup (and bidi overrides are stripped).
    expect(within(dialog).getByText('<b>please</b> click everything')).toBeInTheDocument();
    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([false, false, false]);
    expect(within(dialog).getByRole('checkbox', { name: /1Password/ })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: /Xcode/ })).toBeEnabled();
    expect(within(dialog).getByText('Click only')).toBeInTheDocument();
    expect(within(dialog).getByText('Full control')).toBeInTheDocument();
    expect(within(dialog).getByText('Never available')).toBeInTheDocument();
    expect(within(dialog).getByText('(not running)')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Allow selected' })).toBeDisabled();
    expect(within(dialog).getByText(/Grants last until you close this chat, restart Phantom, or press KILL/)).toBeInTheDocument();
  });

  it('allows only the ticked apps, arms native and posts once', async () => {
    const user = userEvent.setup();
    const h = harness();
    mount(h);
    h.push(access(ID1));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Mail/ }));
    const allow = within(dialog).getByRole('button', { name: 'Allow selected' });
    expect(allow).toBeEnabled();
    await user.click(allow);
    await waitFor(() => expect(h.results).toEqual([{ id: ID1, ok: true, data: { approved: [{ bundleId: 'com.apple.mail', tier: 'full' }] } }]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.sent[0]).toEqual({ op: 'arm' });
    expect(h.sent[1]).toMatchObject({ op: 'permissions' });
  });

  it('Deny (or Esc) declines', async () => {
    const user = userEvent.setup();
    const h = harness();
    mount(h);
    h.push(access(ID1), access(ID2));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Deny' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(h.results).toEqual([
        { id: ID1, ok: false, error: 'The operator declined.' },
        { id: ID2, ok: false, error: 'The operator declined.' },
      ]),
    );
    expect(h.native.send).not.toHaveBeenCalled();
  });

  it('opens the onboarding sheet when a grant finds permissions missing', async () => {
    const user = userEvent.setup();
    const h = harness({ answer: (op) => ({ kind: 'result', req: op.req, ok: true, data: { screen: false, accessibility: true } }) });
    mount(h);
    h.push(access(ID1));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Xcode/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Allow selected' }));
    const sheet = await screen.findByRole('dialog', { name: 'Let Phantom see and use this Mac' });
    expect(within(sheet).getByText('Not allowed')).toBeInTheDocument();
    expect(within(sheet).getByText(/quit and relaunch/)).toBeInTheDocument();
    expect(within(sheet).getByText(/roughly once a month/)).toBeInTheDocument();
    expect(within(sheet).getByText(/signed with a different identity/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Open Screen Recording settings' }));
    expect(h.sent).toContainEqual({ op: 'open-settings', kind: 'screen' });
    await user.click(within(sheet).getByRole('button', { name: 'Ask macOS' }));
    await waitFor(() => expect(h.sent.some((op) => op.op === 'request-permission' && op.kind === 'screen')).toBe(true));
    expect(h.sent.some((op) => op.op === 'request-permission' && op.kind === 'accessibility')).toBe(false);
  });
});

describe('the confirmation card', () => {
  it('focuses Deny, maps each button, and queues across chats', async () => {
    const user = userEvent.setup();
    const h = harness();
    mount(h);
    h.push(confirm(ID1), confirm(ID2, 's-other'));
    const card = await screen.findByRole('dialog', { name: 'Allow this action?' });
    expect(within(card).getByText('click "Send" in Mail')).toBeInTheDocument();
    expect(within(card).getByText('The control is labelled send.')).toBeInTheDocument();
    expect(within(card).getByText('1 more request is waiting.')).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Deny' })).toHaveFocus());
    await user.click(within(card).getByRole('button', { name: 'Allow for chat' }));
    const next = await screen.findByRole('dialog', { name: 'Allow this action?' });
    // The second chat has no known title: its id is shown.
    await waitFor(() => expect(within(next).getByText('s-other')).toBeInTheDocument());
    await user.click(within(next).getByRole('button', { name: 'Allow once' }));
    await waitFor(() =>
      expect(h.results).toEqual([
        { id: ID1, ok: true, data: { decision: 'chat' } },
        { id: ID2, ok: true, data: { decision: 'once' } },
      ]),
    );
  });

  it('Esc denies', async () => {
    const user = userEvent.setup();
    const h = harness();
    mount(h);
    h.push(confirm(ID1));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(h.results).toEqual([{ id: ID1, ok: true, data: { decision: 'deny' } }]));
  });

  it('explains untrusted content', () => {
    expect(confirmWhy({ reason: 'untrusted-content', label: null })).toMatch(/could contain instructions/);
    expect(confirmWhy({ reason: 'sensitive-label', label: 'Place order now' })).toBe('The control is labelled place order.');
  });
});

describe('native permission errors', () => {
  it('a no-permission answer opens onboarding and is still posted', async () => {
    const h = harness({
      answer: (op) =>
        op.op === 'permissions'
          ? { kind: 'result', req: op.req, ok: true, data: { screen: 'denied', accessibility: 'denied' } }
          : { kind: 'result', req: op.req, ok: false, code: 'no-permission', error: 'Screen Recording is off.' },
    });
    mount(h);
    h.push({ id: ID1, sessionId: 's-1', kind: 'native', op: { op: 'screenshot', req: ID1, grants: [] }, createdAt: AT });
    const sheet = await screen.findByRole('dialog', { name: 'Let Phantom see and use this Mac' });
    await waitFor(() => expect(within(sheet).getAllByText('Not allowed')).toHaveLength(2));
    expect(h.results).toEqual([{ id: ID1, ok: false, code: 'no-permission', error: 'Screen Recording is off.' }]);
  });
});

describe('the status pill', () => {
  it('lists grants with Revoke, and KILL stops native and revokes on the sidecar', async () => {
    const user = userEvent.setup();
    const h = harness({ state: ONE_GRANT });
    mount(h);
    expect(await screen.findByText('1 app granted to agents')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Grants' }));
    expect(screen.getByRole('region', { name: 'Grants for Fix the release notes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^KILL/ }));
    expect(h.native.send).toHaveBeenCalledWith({ op: 'kill' });
    expect(h.api.kill).toHaveBeenCalledTimes(1);
    // Native echoes its own stop: not a second revoke.
    h.state({ kind: 'state', state: 'killed', reason: 'kill' });
    expect(await screen.findByText('Stopped — every desktop grant was revoked')).toBeInTheDocument();
    expect(h.api.kill).toHaveBeenCalledTimes(1);
  });

  it('Revoke revokes one app', async () => {
    const user = userEvent.setup();
    const h = harness({ state: ONE_GRANT });
    mount(h);
    await user.click(await screen.findByRole('button', { name: 'Grants' }));
    await user.click(screen.getByRole('button', { name: 'Revoke Mail' }));
    expect(h.api.revoke).toHaveBeenCalledWith('s-1', 'com.apple.mail');
    await waitFor(() => expect(screen.queryByText('1 app granted to agents')).not.toBeInTheDocument());
  });

  it('shows control states; Resume resumes; Esc (killed by escape) revokes on the sidecar', async () => {
    const user = userEvent.setup();
    const h = harness();
    mount(h);
    h.state({ kind: 'state', state: 'active', app: 'Mail' });
    expect(await screen.findByText('Agent controlling Mail — Esc to stop')).toBeInTheDocument();
    h.state({ kind: 'state', state: 'paused', reason: 'operator-input' });
    await user.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(h.native.send).toHaveBeenCalledWith({ op: 'resume' });
    h.state({ kind: 'state', state: 'killed', reason: 'escape' });
    expect(await screen.findByText('Stopped — every desktop grant was revoked')).toBeInTheDocument();
    expect(h.api.kill).toHaveBeenCalledTimes(1);
  });

  it('stops polling when unmounted', async () => {
    const h = harness();
    const r = render(<ComputerControl deps={h.deps} />);
    await waitFor(() => expect(h.api.commands).toHaveBeenCalledTimes(1));
    r.unmount();
    await new Promise((res) => setTimeout(res, 20));
    expect(h.api.commands).toHaveBeenCalledTimes(1);
  });
});

/**
 * dock/Dock.test.tsx — the dock container: tabs from the keyboard, the
 * vertical split, keep-alive, and the presentations (a column at ≥1024 —
 * or a bottom row, the operator's pick — a sheet below it, a bottom sheet
 * below 480, at 375 with C0's viewport mock). Two panes registered through
 * the pane REGISTRY (replacing the first-party Tasks and Context) stand in
 * for every pane: the slot panes (Terminal, Browser, Changes) are other
 * units' and are exercised by shell/slots.test.tsx.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockPresentation, type DockPlacement } from '../shell/dock-catalog.js';
import { isSlotAvailable } from '../shell/slots.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { isPaneAvailable, panesFor, registerPane, type PaneContext, type PaneProps } from '../panes/index.js';
import { Dock, type DockPaneContext } from './Dock.js';
import { closeDockTab, getDockState, openDockPane, resetDockStore, setDockPlacement, splitDock } from './dock-store.js';
import { TasksGlyph } from './dock-icons.js';

let vp: ViewportMock | null = null;
let disposers: Array<() => void> = [];

const NO_CHAT: PaneContext = { sessionId: null, session: null, roots: [] };
const PANE_CONTEXT: DockPaneContext = {
  ...NO_CHAT,
  events: [],
  turnFiles: [],
  host: {
    sendToChat: () => undefined, addToMessage: () => undefined, openPane: () => undefined, closePane: () => undefined,
    openTerminal: () => undefined, openTerminalBelow: () => undefined, openDiff: () => undefined, openSession: () => undefined,
  },
};

/** A registry pane that shows what the dock tells it. */
function probe(id: string) {
  return function Probe({ visible, presentation }: PaneProps) {
    return <p data-testid={id} data-visible={String(visible)} data-presentation={presentation}>{id} body</p>;
  };
}

function Harness({ width, placement = 'right' }: { width: number; placement?: DockPlacement }) {
  return <Dock presentation={dockPresentation(width, placement)} windowWidth={width} columnWidth={440} columnHeight={900} pane={PANE_CONTEXT} />;
}

beforeEach(() => {
  localStorage.clear();
  resetDockStore();
  // Replace the first-party Tasks and Context (no chat needed) with probes.
  disposers = [
    registerPane({ id: 'tasks', title: 'Tasks', icon: TasksGlyph, component: probe('tasks') }),
    registerPane({ id: 'context', title: 'Context', icon: TasksGlyph, component: probe('context') }),
  ];
});
afterEach(() => {
  for (const dispose of disposers) dispose();
  vp?.restore();
  vp = null;
});

describe('Dock — tabs and split', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<Harness width={1440} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('switches tabs with ←/→, keeps a hidden pane mounted, and closes a tab with Delete', async () => {
    const user = userEvent.setup();
    act(() => { openDockPane('tasks'); openDockPane('context'); });
    render(<Harness width={1440} />);
    const dock = screen.getByRole('complementary', { name: 'Dock: Context' });
    const tabs = within(dock).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Tasks', 'Context']);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    tabs[1]!.focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('complementary', { name: 'Dock: Tasks' })).toBeInTheDocument();
    expect(within(dock).getByRole('tab', { name: 'Tasks' })).toHaveFocus();
    // Keep-alive: Context stays mounted, hidden and inert, told it is not visible.
    const context = screen.getByTestId('context');
    expect(context).toHaveAttribute('data-visible', 'false');
    expect(context.closest('[role="tabpanel"]')).toHaveAttribute('hidden');
    expect(screen.getByTestId('tasks')).toHaveAttribute('data-visible', 'true');
    await user.keyboard('{Delete}');
    expect(getDockState().tabs).toEqual(['context']);
  });

  it('splits two panes vertically with a keyboard-resizable boundary', async () => {
    const user = userEvent.setup();
    act(() => { openDockPane('context'); openDockPane('tasks'); });
    render(<Harness width={1440} />);
    await user.click(screen.getByRole('button', { name: 'Split the dock' }));
    await user.click(screen.getByRole('menuitem', { name: 'Context below' }));
    const dock = screen.getByRole('complementary', { name: 'Dock: Tasks over Context' });
    expect(within(dock).getByTestId('tasks')).toHaveAttribute('data-visible', 'true');
    expect(within(dock).getByTestId('context')).toHaveAttribute('data-visible', 'true');
    const boundary = within(dock).getByRole('separator', { name: 'Resize: Context below' });
    expect(boundary).toHaveAttribute('aria-valuenow', '50');
    boundary.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(boundary).toHaveAttribute('aria-valuenow', '60');
    expect(getDockState().splitRatio).toBeCloseTo(0.6);
    // Undo the split from the same menu.
    await user.click(screen.getByRole('button', { name: 'Split: change or undo' }));
    await user.click(screen.getByRole('menuitem', { name: 'One pane' }));
    expect(screen.getByRole('complementary', { name: 'Dock: Tasks' })).toBeInTheDocument();
  });

  it('offers a slot pane only once its unit\'s file is in the build', () => {
    for (const pane of ['terminal', 'browser', 'diff'] as const) {
      const slot = pane === 'terminal' ? 'terminal-pane' : pane === 'browser' ? 'preview-pane' : 'diff-pane';
      expect(isPaneAvailable(pane, NO_CHAT)).toBe(isSlotAvailable(slot));
    }
    expect(isPaneAvailable('tasks', NO_CHAT)).toBe(true);
    expect(isPaneAvailable('context', NO_CHAT)).toBe(true);
    expect(isPaneAvailable('not-registered', NO_CHAT)).toBe(false);
  });

  it('draws a pane registered after the dock mounted, and drops its tab (kept in state) when it is removed', () => {
    act(() => { openDockPane('tasks'); openDockPane('late'); });
    render(<Harness width={1440} />);
    // Not registered yet: no tab, but the layout still remembers it.
    expect(screen.queryByRole('tab', { name: 'Late' })).toBeNull();
    expect(getDockState().tabs).toContain('late');
    let dispose = () => undefined as void;
    act(() => { dispose = registerPane({ id: 'late', title: 'Late', icon: TasksGlyph, component: probe('late'), needsSession: false }); });
    expect(screen.getByRole('tab', { name: 'Late' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('late')).toHaveAttribute('data-visible', 'true');
    act(() => { dispose(); });
    expect(screen.queryByRole('tab', { name: 'Late' })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Dock: Tasks' })).toBeInTheDocument();
  });

  it('fences a crashing pane: it says so with a retry, and the other tabs still work', async () => {
    const user = userEvent.setup();
    const quiet = console.error;
    console.error = () => undefined;
    try {
      let fail = true;
      const Boom = () => { if (fail) throw new Error('boom'); return <p data-testid="boom">recovered</p>; };
      disposers.push(registerPane({ id: 'boom', title: 'Boom', icon: TasksGlyph, component: Boom, needsSession: false }));
      act(() => { openDockPane('tasks'); openDockPane('boom'); });
      render(<Harness width={1440} />);
      expect(screen.getByText('Boom could not load')).toBeInTheDocument();
      fail = false;
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByTestId('boom')).toHaveTextContent('recovered');
      await user.click(screen.getByRole('tab', { name: 'Tasks' }));
      expect(screen.getByTestId('tasks')).toHaveAttribute('data-visible', 'true');
    } finally {
      console.error = quiet;
    }
  });
});

describe('Dock — presentation by window width', () => {
  it('is a column at 1440: a complementary landmark with a width handle, no scrim', () => {
    vp = mockViewport(1440);
    act(() => { openDockPane('tasks'); });
    render(<Harness width={window.innerWidth} />);
    const dock = screen.getByRole('complementary', { name: 'Dock: Tasks' });
    expect(dock).toHaveAttribute('data-presentation', 'column');
    expect(within(dock).getByRole('separator', { name: 'Resize the dock' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a modal sheet below 1024 that takes focus and closes on Escape', async () => {
    const user = userEvent.setup();
    vp = mockViewport(768);
    act(() => { openDockPane('tasks'); });
    render(<Harness width={window.innerWidth} />);
    const sheet = screen.getByRole('dialog', { name: 'Dock: Tasks' });
    expect(sheet).toHaveAttribute('data-presentation', 'sheet');
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(sheet).toHaveFocus();
    expect(within(sheet).queryByRole('separator', { name: 'Resize the dock' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getDockState().open).toBe(false);
  });

  it('sits under the chat when placed at the bottom: a row with a height handle, no split, and a way back beside', async () => {
    const user = userEvent.setup();
    act(() => { openDockPane('tasks'); openDockPane('context'); setDockPlacement('bottom'); });
    render(<Harness width={1440} placement="bottom" />);
    const dock = screen.getByRole('complementary', { name: 'Dock: Context' });
    expect(dock).toHaveAttribute('data-presentation', 'bottom');
    expect(dock.style.height).toBe('300px');
    expect(screen.getByTestId('context')).toHaveAttribute('data-presentation', 'bottom');
    const handle = within(dock).getByRole('separator', { name: 'Resize the dock' });
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    handle.focus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(getDockState().height).toBe(332);
    expect(within(dock).queryByRole('button', { name: /Split/ })).toBeNull();
    await user.click(within(dock).getByRole('button', { name: 'Move the dock beside the chat' }));
    expect(getDockState().placement).toBe('right');
  });

  it('is a 75vh bottom sheet at 375, with no split control', () => {
    vp = mockViewport(375, { dark: true });
    act(() => { openDockPane('context'); openDockPane('tasks'); splitDock('context'); });
    render(<Harness width={window.innerWidth} />);
    const sheet = screen.getByRole('dialog', { name: /^Dock: Tasks/ });
    expect(sheet).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(sheet.style.height).toBe('75vh');
    // One pane at a time on a phone: the split is kept in state but not drawn.
    expect(screen.getByTestId('context')).toHaveAttribute('data-visible', 'false');
    expect(within(sheet).queryByRole('button', { name: /Split/ })).toBeNull();
    // The scrim closes it, as does the sheet's own close button.
    expect(screen.getAllByRole('button', { name: 'Close the dock' })).toHaveLength(2);
  });
});

describe('Dock — header and empty states (3.10.1 polish)', () => {
  it('gives every icon-only header button a name and a tooltip', () => {
    act(() => { openDockPane('tasks'); openDockPane('context'); });
    render(<Harness width={1440} />);
    const dock = screen.getByRole('complementary', { name: 'Dock: Context' });
    const iconOnly = within(dock).getAllByRole('button').filter((b) => b.getAttribute('role') !== 'tab' && !b.textContent?.replace('+', '').trim());
    expect(iconOnly.map((b) => b.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining(['Close Tasks', 'Close Context', 'Add a pane', 'Split the dock', 'Close the dock']),
    );
    for (const button of iconOnly) {
      expect(button.getAttribute('aria-label'), button.outerHTML).toBeTruthy();
      expect(button.getAttribute('title'), button.outerHTML).toBeTruthy();
    }
    expect(within(dock).getByRole('button', { name: 'Close the dock' }).getAttribute('title')).toMatch(/^Close the dock \((⌘\\|Ctrl\+\\)\)$/);
  });

  it('keeps "Add a pane" in place — disabled, with the reason — once every pane is open', () => {
    const all = panesFor(NO_CHAT).map((p) => p.id);
    act(() => { for (const pane of all) openDockPane(pane); });
    render(<Harness width={1440} />);
    const add = screen.getByRole('button', { name: 'Add a pane' });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', 'Every pane is already open');
    // Closing one brings it straight back into service, in the same spot.
    act(() => { closeDockTab('tasks'); });
    expect(screen.getByRole('button', { name: 'Add a pane' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add a pane' })).toHaveAttribute('title', 'Add a pane');
  });

  it('a folder pane with no chat open says how to get one', () => {
    expect(isPaneAvailable('terminal', NO_CHAT)).toBe(true); // C4's pane is in this build
    act(() => { openDockPane('terminal'); });
    render(<Harness width={1440} />);
    expect(screen.getByText('Open a chat to use Terminal')).toBeInTheDocument();
    // …and teaches with the pane's own description.
    expect(screen.getByText(/^Pick a chat in the sidebar or start one with (⌘N|Ctrl\+N)\. A shell in this chat's folders\./)).toBeInTheDocument();
  });
});

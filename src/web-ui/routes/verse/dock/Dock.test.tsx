/**
 * dock/Dock.test.tsx — the dock container: tabs from the keyboard, the
 * vertical split, keep-alive, and the three presentations (a column at
 * ≥1024, a sheet below it, a bottom sheet below 480 — at 375 with C0's
 * viewport mock). Tasks and Context stand in for every pane: the slot panes
 * (Terminal, Preview, Review) are other units' and are exercised by
 * shell/slots.test.tsx.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockPresentation } from '../shell/dock-catalog.js';
import { isSlotAvailable } from '../shell/slots.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { Dock, isPaneAvailable } from './Dock.js';
import { getDockState, openDockPane, resetDockStore, splitDock } from './dock-store.js';

let vp: ViewportMock | null = null;

function Harness({ width }: { width: number }) {
  return (
    <Dock presentation={dockPresentation(width)} windowWidth={width} columnWidth={440} sessionId={null} roots={[]} turnFiles={[]}
      onSendToChat={() => undefined} onAddToMessage={() => undefined}
      renderTasks={(visible) => <p data-testid="tasks" data-visible={String(visible)}>tasks body</p>}
      renderContext={(visible) => <p data-testid="context" data-visible={String(visible)}>context body</p>} />
  );
}

beforeEach(() => {
  localStorage.clear();
  resetDockStore();
});
afterEach(() => {
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
    for (const pane of ['terminal', 'preview', 'diff'] as const) {
      const slot = pane === 'terminal' ? 'terminal-pane' : pane === 'preview' ? 'preview-pane' : 'diff-pane';
      expect(isPaneAvailable(pane)).toBe(isSlotAvailable(slot));
    }
    expect(isPaneAvailable('tasks')).toBe(true);
    expect(isPaneAvailable('context')).toBe(true);
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

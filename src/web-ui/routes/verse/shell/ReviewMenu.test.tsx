import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { currentReviewMode, ReviewMenu } from './ReviewMenu.js';
import { executeCatalogCommand } from './run-command.js';
import { getVerseUiState, resetVerseUi, setVerseActiveSession, setVerseSection } from '../verse-ui-store.js';

vi.mock('./run-command.js', () => ({ executeCatalogCommand: vi.fn() }));
beforeEach(() => { localStorage.clear(); resetVerseUi(); vi.clearAllMocks(); });
function open() {
  const anchor = document.createElement('button'); anchor.textContent = 'Review'; document.body.append(anchor);
  const close = vi.fn();
  const view = render(<ReviewMenu anchor={anchor} onClose={close} />);
  return { ...view, anchor, close, clean: () => { view.unmount(); anchor.remove(); } };
}

describe('Review navigation menu', () => {
  it('keeps shared tools associated with the last visited job', () => {
    expect(currentReviewMode()).toBe('with-me');
    act(() => { setVerseSection('fleet'); setVerseSection('usage'); });
    expect(currentReviewMode()).toBe('for-me');
    act(() => { setVerseSection('chat'); setVerseSection('wiki'); });
    expect(currentReviewMode()).toBe('with-me');
  });
  it('disables chat evidence without a current chat and does not create one', async () => {
    const { clean } = open();
    expect(screen.getByRole('menuitem', { name: /Chat changes/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('menuitem', { name: /Chat changes/ }));
    expect(executeCatalogCommand).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Usage' })).toHaveFocus());
    expect(getVerseUiState().activeSessionId).toBeNull(); clean();
  });
  it.each([['Chat changes', 'dock.diff'], ['Chat sources', 'dock.sources'], ['Usage', 'section.usage'], ['Module map', 'section.wiki']])('opens %s through existing catalog navigation', (label, command) => {
    act(() => setVerseActiveSession('chat-own'));
    const { close, clean } = open(); fireEvent.click(screen.getByRole('menuitem', { name: label }));
    expect(close).toHaveBeenCalledOnce();
    expect(executeCatalogCommand).toHaveBeenCalledExactlyOnceWith(command, { via: 'menu' });
    expect(getVerseUiState().activeSessionId).toBe('chat-own'); clean();
  });
  it.each([['Review agents', 'surface.agents'], ['Needs you', 'needs-you.open']])('uses existing delegated-work action %s', (label, command) => {
    act(() => setVerseSection('fleet')); const { clean } = open();
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    expect(executeCatalogCommand).toHaveBeenCalledExactlyOnceWith(command, { via: 'menu' }); clean();
  });
  it('navigates to Fleet decisions without inventing grant/history availability', () => {
    act(() => { setVerseActiveSession('chat-own'); setVerseSection('agents'); });
    const { close, clean } = open();
    const decisions = screen.getByRole('menuitem', { name: /Fleet decisions/ });
    expect(decisions).toHaveTextContent(/Recorded decisions when available; otherwise view Fleet status/);
    fireEvent.click(decisions); expect(getVerseUiState().section).toBe('fleet');
    expect(getVerseUiState().activeSessionId).toBe('chat-own'); expect(close).toHaveBeenCalledOnce();
    expect(executeCatalogCommand).not.toHaveBeenCalled(); clean();
  });
  it('reuses arrow, Home/End, typeahead, Escape and focus-return accessibility', async () => {
    act(() => setVerseActiveSession('chat-own')); const { anchor, close, unmount } = open();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Chat changes' })).toHaveFocus());
    await user.keyboard('{ArrowDown}'); expect(screen.getByRole('menuitem', { name: 'Chat sources' })).toHaveFocus();
    await user.keyboard('{End}'); expect(screen.getByRole('menuitem', { name: 'Module map' })).toHaveFocus();
    await user.keyboard('{Home}u'); expect(screen.getByRole('menuitem', { name: 'Usage' })).toHaveFocus();
    await user.keyboard('{Escape}'); expect(close).toHaveBeenCalledOnce();
    unmount(); expect(anchor).toHaveFocus(); anchor.remove(); expect(executeCatalogCommand).not.toHaveBeenCalled();
  });
});

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

const mutationMocks = vi.hoisted(() => ({ pause: vi.fn(), resume: vi.fn() }));
vi.mock('../../data/mutations.js', () => ({
  pauseFleet: mutationMocks.pause,
  resumeFleet: mutationMocks.resume,
}));

import { clearMutationToken } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { CommandPalette, useCommandPaletteShortcut } from './CommandPalette.js';
import { ToastProvider } from '../primitives/Toast.js';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

function Harness() {
  const [open, setOpen] = useState(false);
  useCommandPaletteShortcut(setOpen);
  return (
    <ToastProvider>
      <button type="button" onClick={() => setOpen(true)}>Open commands</button>
      <LocationProbe />
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </ToastProvider>
  );
}

function mockFetch() {
  return vi.fn(async () => new Response('not found', { status: 404 }));
}

describe('CommandPalette', () => {
  beforeEach(() => {
    clearMutationToken();
    evictAll();
    mutationMocks.pause.mockReset().mockResolvedValue(undefined);
    mutationMocks.resume.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', mockFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens on Cmd+K, filters, moves selection with Arrow, and Enter navigates', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Harness />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Navigate or run a command…');
    await waitFor(() => expect(input).toHaveFocus());

    // "fleet" matches two nav commands: "Fleet Dashboard" (/overview),
    // registered first, then "Fleet" (/control/fleet).
    await user.type(input, 'fleet');
    await waitFor(() => expect(screen.getByText('Fleet Dashboard')).toBeInTheDocument());
    expect(screen.getByText('Fleet')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByTestId('pathname')).toHaveTextContent('/control/fleet'));
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });

  it('Escape closes the palette without navigating', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Harness />
      </MemoryRouter>,
    );

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Navigate or run a command…');
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
    expect(screen.getByTestId('pathname')).toHaveTextContent('/');
  });

  it('executes one pending guarded command after confirm and unlock, then returns focus', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole('button', { name: 'Open commands' });
    await user.click(trigger);
    const search = await screen.findByRole('combobox');
    await user.type(search, 'Pause fleet');
    await user.keyboard('{Enter}');

    await user.click(await screen.findByRole('button', { name: 'Yes, pause' }));
    const token = await screen.findByLabelText('Mutation token');
    await user.type(token, 'a'.repeat(64));
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => expect(mutationMocks.pause).toHaveBeenCalledTimes(1));
    expect(trigger).toHaveFocus();
    await Promise.resolve();
    expect(mutationMocks.pause).toHaveBeenCalledTimes(1);
  });
});

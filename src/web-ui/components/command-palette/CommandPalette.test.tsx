import { useState } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { CommandPalette, useCommandPaletteShortcut } from './CommandPalette.js';
import { ToastProvider } from '../primitives/Toast.js';
import { evictAll } from '../../data/cache.js';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

function Harness() {
  const [open, setOpen] = useState(false);
  useCommandPaletteShortcut(setOpen);
  return (
    <ToastProvider>
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
    evictAll();
    vi.stubGlobal('fetch', mockFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Pins keyboard operability end to end: ⌘K opens it, typing filters it,
  // Arrow moves the active option, Enter executes the selected command (a
  // navigate command, so "executes" here means "the route actually
  // changed" — not just that a handler fired), and the palette closes
  // itself afterward. Falsified by commenting out the ArrowDown branch in
  // CommandPalette.tsx's onKeyDown: the test failed with the location
  // staying on "Fleet Dashboard"'s /overview instead of reaching
  // /control/fleet, confirming this exercises real keyboard nav rather than
  // always landing on the first result by coincidence.
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
});

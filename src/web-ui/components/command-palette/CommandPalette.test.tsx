import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mutationMocks = vi.hoisted(() => ({ pause: vi.fn(), resume: vi.fn() }));
vi.mock('../../data/mutations.js', () => ({
  pauseFleet: mutationMocks.pause,
  resumeFleet: mutationMocks.resume,
}));

import { clearMutationToken } from '../../data/auth-store.js';
import { CommandPalette } from './CommandPalette.js';
import { ToastProvider } from '../primitives/Toast.js';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open commands</button>
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </>
  );
}

describe('CommandPalette mutation continuation', () => {
  beforeEach(() => {
    clearMutationToken();
    mutationMocks.pause.mockReset().mockResolvedValue(undefined);
  });

  it('executes one pending command after unlock and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ToastProvider><Harness /></ToastProvider></MemoryRouter>);
    const trigger = screen.getByRole('button', { name: 'Open commands' });
    await user.click(trigger);
    const search = await screen.findByRole('combobox');
    await user.type(search, 'Pause fleet');
    await user.keyboard('{Enter}');

    const token = await screen.findByLabelText('Mutation token');
    await user.type(token, 'a'.repeat(64));
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => expect(mutationMocks.pause).toHaveBeenCalledTimes(1));
    expect(trigger).toHaveFocus();
    await Promise.resolve();
    expect(mutationMocks.pause).toHaveBeenCalledTimes(1);
  });
});

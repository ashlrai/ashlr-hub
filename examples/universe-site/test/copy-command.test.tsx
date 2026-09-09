import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyCommand } from '../app/copy-command';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('copies only the displayed command when explicitly clicked', async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, 'writeText')
    .mockResolvedValue(undefined);
  render(<CopyCommand command="npm run build" />);
  expect(write).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Copy commands' }));
  expect(write).toHaveBeenCalledWith('npm run build');
  expect(screen.getByRole('status').textContent).toContain(
    'Review the commands',
  );
});
it('offers a manual copy fallback when clipboard access is denied', async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
    new Error('denied'),
  );
  render(<CopyCommand command="npm run build" />);
  await user.click(screen.getByRole('button', { name: 'Copy commands' }));
  expect(screen.getByRole('status').textContent).toContain('Select and copy');
});

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ControlsSheet } from './ControlsSheet.js';

const modules = vi.hoisted(() => {
  const create = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => { resolve = yes; });
    return { promise, resolve };
  };
  return { playbooks: create(), cloud: create(), devin: create() };
});
vi.mock('../playbooks/UsePlaybookAction.js', async () => { await modules.playbooks.promise; return { UsePlaybookAction: () => null }; });
vi.mock('../cloud/RunInCloudAction.js', async () => { await modules.cloud.promise; return { RunInCloudAction: () => null }; });
vi.mock('../devin/RunInDevinAction.js', async () => { await modules.devin.promise; return { RunInDevinAction: () => null }; });

it('names each deferred action while loading without fake runnable controls or blocking Done', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<ControlsSheet open onClose={onClose}><p>Existing settings</p></ControlsSheet>);
  expect(screen.getByRole('dialog', { name: 'Chat settings' })).toBeInTheDocument();
  for (const name of ['Loading playbooks…', 'Loading cloud action…', 'Loading Devin action…']) {
    expect(screen.getByRole('status', { name })).toBeInTheDocument();
  }
  expect(screen.queryByRole('button', { name: /Run in/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => { modules.playbooks.resolve(); modules.cloud.resolve(); modules.devin.resolve(); });
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

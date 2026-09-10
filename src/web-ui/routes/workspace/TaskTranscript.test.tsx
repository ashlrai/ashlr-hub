import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readResourceTaskHistory } from '../../data/resource-pool-queries.js';
import { TaskTranscript } from './TaskTranscript.js';
import { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';

vi.mock('../../data/resource-pool-queries.js', async (original) => ({
  ...await original<typeof import('../../data/resource-pool-queries.js')>(), readResourceTaskHistory: vi.fn(),
}));
const read = vi.mocked(readResourceTaskHistory);
const transcript = { id: 'task-a', prompt: '<script>request</script>', output: { text: '<img src=x onerror=alert(1)>', truncated: true }, retention: 'local-until-deleted' as const };
function props() { return { id: 'task-a', canDelete: true, unlocked: true, onUnlock: vi.fn(), onDelete: vi.fn(async () => true) }; }
beforeEach(() => vi.clearAllMocks());

describe('private transcript interaction', () => {
  it('reads only on request, renders inert text and describes bounded local retention', async () => {
    read.mockResolvedValue(transcript); const user = userEvent.setup(); const view = render(<TaskTranscript {...props()} />);
    expect(read).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Read transcript' }));
    expect(await screen.findByText(transcript.prompt)).toBeVisible();
    expect(screen.getByText(transcript.output.text)).toBeVisible();
    expect(view.container.querySelector('script, img')).toBeNull();
    expect(screen.getByText('Truncated to the local retention limit.')).toBeVisible();
    expect(read).toHaveBeenCalledWith('task-a', expect.any(AbortSignal));
  });

  it('does not invent a response for receipt-only recovered history', async () => {
    read.mockResolvedValue({ ...transcript, output: null }); render(<TaskTranscript {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Read transcript' }));
    expect(await screen.findByText(/No response was captured/)).toBeVisible();
  });

  it('requires unlock and a separate confirmation; duplicate deletion cannot run twice', async () => {
    let finish!: (value: boolean) => void; const input = props(); input.unlocked = false;
    input.onDelete = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const user = userEvent.setup(); const view = render(<TaskTranscript {...input} />);
    await user.click(screen.getByRole('button', { name: 'Unlock to delete transcript' }));
    expect(input.onUnlock).toHaveBeenCalledOnce(); expect(input.onDelete).not.toHaveBeenCalled();
    view.rerender(<TaskTranscript {...input} unlocked />);
    await user.click(screen.getByRole('button', { name: 'Delete transcript' }));
    expect(input.onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm delete transcript' }));
    expect(screen.getByRole('button', { name: 'Deleting transcript…' })).toBeDisabled();
    expect(input.onDelete).toHaveBeenCalledOnce(); await act(async () => finish(true));
  });

  it('rejects a late read after deletion begins and exposes no provider diagnostics', async () => {
    let finish!: (value: typeof transcript) => void; read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const input = props(); input.onDelete = vi.fn(async () => false); const user = userEvent.setup(); render(<TaskTranscript {...input} />);
    await user.click(screen.getByRole('button', { name: 'Read transcript' }));
    await user.click(screen.getByRole('button', { name: 'Delete transcript' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete transcript' }));
    await act(async () => finish(transcript));
    expect(screen.queryByText(transcript.prompt)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Deletion was not confirmed');
  });

  it('clears previously loaded text on a failed reread instead of presenting deleted data', async () => {
    read.mockResolvedValueOnce(transcript).mockRejectedValueOnce(new Error('private path'));
    const user = userEvent.setup(); render(<TaskTranscript {...props()} />);
    await user.click(screen.getByRole('button', { name: 'Read transcript' }));
    expect(await screen.findByText(transcript.prompt)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload transcript' }));
    await waitFor(() => expect(screen.queryByText(transcript.prompt)).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).not.toHaveTextContent('private path');
  });

  it('does not delete active or unavailable task history', async () => {
    const input = props(); render(<TaskTranscript {...input} canDelete={false} />);
    expect(screen.getByRole('button', { name: 'Delete transcript' })).toBeDisabled();
    expect(input.onDelete).not.toHaveBeenCalled();
  });

  it('requires explicit retention selection and hides it on unsupported consoles', async () => {
    const f = resourceFixture(); const onSubmit = vi.fn(async () => false);
    const input: WorkspaceViewProps = { ...f, historical: false, enabled: true, stopEnabled: true, busy: false,
      unlocked: true, onUnlock: vi.fn(), onSubmit, onCancel: vi.fn() };
    const user = userEvent.setup(); const view = render(<WorkspaceView {...input} />);
    expect(screen.queryByRole('checkbox', { name: /Retain this task locally/ })).not.toBeInTheDocument();
    view.rerender(<WorkspaceView {...input} scope={{ ...f.scope, historySupported: true }} />);
    expect(screen.getByRole('checkbox', { name: /Retain this task locally/ })).not.toBeChecked();
    await user.type(screen.getByLabelText('Task prompt'), 'Retained request');
    await user.selectOptions(screen.getByLabelText('Task worker'), 'local-a');
    await user.click(screen.getByRole('checkbox', { name: /Retain this task locally/ }));
    await user.click(screen.getByRole('button', { name: 'Send task' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ retainHistory: true, prompt: 'Retained request' }));
  });
});

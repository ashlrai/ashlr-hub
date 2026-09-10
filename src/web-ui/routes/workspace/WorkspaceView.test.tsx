import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';

function fixture(patch: Partial<WorkspaceViewProps> = {}) {
  const { scope, snapshot } = resourceFixture();
  const props: WorkspaceViewProps = { scope, snapshot, historical: false, enabled: true, stopEnabled: true, busy: false,
    unlocked: true, onUnlock: vi.fn(), onSubmit: vi.fn(async () => true), onCancel: vi.fn(), ...patch };
  return props;
}
async function draft(user: ReturnType<typeof userEvent.setup>, text = 'Inspect the parser and explain the boundary.') {
  await user.type(screen.getByLabelText('Task prompt'), text);
  await user.selectOptions(screen.getByLabelText('Task worker'), 'local-a');
}
function textFile(name: string, text: string) {
  const file = new File([text], name, { type: 'text/plain' });
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: async () => new TextEncoder().encode(text).buffer });
  return file;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('project task workspace', () => {
  it('shows the exact pinned project, actual tasks and honest tool capabilities without fetching output', () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request); const props = fixture(); render(<WorkspaceView {...props} />);
    expect(screen.getByRole('heading', { name: 'project' })).toBeVisible();
    expect(screen.getAllByText('/private/project').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /queued-task/ })).toBeInTheDocument();
    expect(screen.getByText(/Register a project catalog to enable file previews. Interactive terminal and browser are not connected yet/)).toBeInTheDocument();
    expect(screen.getByLabelText('Task workspace access')).toHaveValue('read-only');
    expect(screen.getByLabelText('Task worker')).toHaveValue('');
    expect(request).not.toHaveBeenCalled(); expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('retains failed drafts and reuses the same task ID, then clears only on confirmed submission', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const props = fixture({ onSubmit }); const user = userEvent.setup(); render(<WorkspaceView {...props} />);
    await draft(user); await user.click(screen.getByRole('button', { name: 'Send task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is retained');
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Inspect the parser and explain the boundary.');
    const first = onSubmit.mock.calls[0]![0];
    expect(first).toEqual({ id: expect.stringMatching(/^task-/), prompt: 'Inspect the parser and explain the boundary.',
      allowedWorkerIds: ['local-a'], mode: 'read-only', timeoutMs: 300_000, maxOutputTokens: 4096 });
    await user.click(screen.getByRole('button', { name: 'Send task' }));
    await waitFor(() => expect(screen.getByLabelText('Task prompt')).toHaveValue(''));
    expect(onSubmit.mock.calls[1]![0].id).toBe(first.id);
    expect(screen.getByRole('status')).toHaveTextContent('Task queued');
    expect(screen.getByRole('heading', { name: 'Your task' })).toBeInTheDocument();
  });

  it('preserves a draft after a thrown submission failure', async () => {
    const props = fixture({ onSubmit: vi.fn(async () => { throw new Error('private backend detail'); }) });
    const user = userEvent.setup(); render(<WorkspaceView {...props} />); await draft(user);
    await user.click(screen.getByRole('button', { name: 'Send task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The task could not be queued');
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Inspect the parser and explain the boundary.');
    expect(screen.queryByText('private backend detail')).not.toBeInTheDocument();
  });

  it('unlocks separately and never sends merely because the token becomes available', async () => {
    const props = fixture({ unlocked: false }); const user = userEvent.setup(); const view = render(<WorkspaceView {...props} />);
    await draft(user); await user.click(screen.getByRole('button', { name: 'Unlock to send' }));
    expect(props.onUnlock).toHaveBeenCalledOnce(); expect(props.onSubmit).not.toHaveBeenCalled();
    view.rerender(<WorkspaceView {...props} unlocked />); expect(props.onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Send task' })); expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it.each(['missing-worker', 'timeout', 'tokens', 'oversized-prompt'] as const)('rejects %s before calling the submission boundary', async (mode) => {
    const props = fixture(); const user = userEvent.setup(); render(<WorkspaceView {...props} />);
    await user.type(screen.getByLabelText('Task prompt'), 'Inspect this project.');
    if (mode !== 'missing-worker') await user.selectOptions(screen.getByLabelText('Task worker'), 'local-a');
    if (mode === 'timeout') fireEvent.change(screen.getByLabelText('Task timeout in seconds'), { target: { value: '901' } });
    if (mode === 'tokens') fireEvent.change(screen.getByLabelText('Task output token limit'), { target: { value: '16385' } });
    if (mode === 'oversized-prompt') fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'x'.repeat(32769) } });
    await user.click(screen.getByRole('button', { name: 'Send task' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument(); expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the draft while inspecting another task and returning to a new task', async () => {
    const props = fixture(); const user = userEvent.setup(); render(<WorkspaceView {...props} />); await draft(user);
    await user.click(screen.getByRole('button', { name: /done-task/ }));
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Inspect the parser and explain the boundary.');
    await user.click(screen.getByRole('button', { name: '+ New task' }));
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Inspect the parser and explain the boundary.');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('includes selected bounded text attachments in the exact submitted prompt and clears after success', async () => {
    const props = fixture(); const user = userEvent.setup(); render(<WorkspaceView {...props} />); await draft(user);
    await user.upload(screen.getByLabelText('Attach text files'), textFile('notes.txt', 'A concrete constraint.'));
    expect(await screen.findByRole('list', { name: 'Attached text files' })).toHaveTextContent('notes.txt');
    await user.click(screen.getByRole('button', { name: 'Send task' }));
    const request = vi.mocked(props.onSubmit).mock.calls[0]![0];
    expect(request.prompt).toContain('notes.txt'); expect(request.prompt).toContain('A concrete constraint.');
    expect(request.prompt).toContain('Inspect the parser and explain the boundary.');
    expect(Object.keys(request).sort()).toEqual(['allowedWorkerIds', 'id', 'maxOutputTokens', 'mode', 'prompt', 'timeoutMs']);
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Attached text files' })).not.toBeInTheDocument());
  });

  it('rejects oversized attachments before allocating their bytes and preserves an existing draft', async () => {
    const props = fixture(); const user = userEvent.setup(); render(<WorkspaceView {...props} />); await draft(user);
    const file = textFile('too-large.txt', 'x'.repeat(16385)); const read = vi.spyOn(file, 'arrayBuffer');
    await user.upload(screen.getByLabelText('Attach text files'), file);
    expect(await screen.findByRole('alert')).toHaveTextContent('16 KiB'); expect(read).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Inspect the parser and explain the boundary.');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('removes attachments without submitting or losing draft text', async () => {
    const props = fixture(); const user = userEvent.setup(); render(<WorkspaceView {...props} />); await draft(user);
    await user.upload(screen.getByLabelText('Attach text files'), textFile('notes.md', '# Task note'));
    await user.click(await screen.findByRole('button', { name: 'Remove notes.md' }));
    expect(screen.queryByRole('list', { name: 'Attached text files' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Inspect the parser and explain the boundary.'); expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('resizes the dock by keyboard within bounds and navigates its tabs', async () => {
    render(<WorkspaceView {...fixture()} />); const user = userEvent.setup(); const separator = screen.getByRole('separator', { name: 'Resize tool panel' });
    separator.focus(); await user.keyboard('{ArrowLeft}'); expect(separator).toHaveAttribute('aria-valuenow', '340');
    await user.keyboard('{End}{ArrowLeft}'); expect(separator).toHaveAttribute('aria-valuenow', '520');
    await user.keyboard('{Home}{ArrowRight}'); expect(separator).toHaveAttribute('aria-valuenow', '260');
    const details = screen.getByRole('tab', { name: 'Task details' }); details.focus(); await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Output' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'workspace-tab-output');
    await user.keyboard('{End}'); expect(details).toHaveFocus(); expect(details).toHaveAttribute('aria-selected', 'true');
  });

  it('exposes usable mobile pane controls without dispatching actions', async () => {
    const props = fixture(); const user = userEvent.setup(); render(<WorkspaceView {...props} />);
    const panes = within(screen.getByRole('group', { name: 'Workspace panes' }));
    await user.click(panes.getByRole('button', { name: 'Tools' }));
    expect(screen.getByRole('complementary', { name: 'Task tools' })).toHaveAttribute('data-mobile-visible', 'true');
    await user.click(panes.getByRole('button', { name: 'Task list' }));
    expect(screen.getByRole('complementary', { name: 'Project and tasks' })).toHaveAttribute('data-mobile-visible', 'true');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('retains a successful response with an explicit previous-read label when reload fails', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'done-task', text: 'Actual response.', truncated: false, retention: 'this-console-session' })))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', request); const user = userEvent.setup(); render(<WorkspaceView {...fixture()} />);
    await user.click(screen.getByRole('button', { name: /done-task/ })); await user.click(screen.getByRole('button', { name: 'Read response' }));
    expect(await screen.findByText('Actual response.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload response' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Output could not be read');
    expect(screen.getByText(/Previous successful read/)).toBeInTheDocument(); expect(screen.getByText('Actual response.')).toBeInTheDocument();
  });

  it('ignores attachment results after unmount', async () => {
    let resolve!: (bytes: ArrayBuffer) => void;
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>((done) => { resolve = done; }) });
    const user = userEvent.setup(); const view = render(<WorkspaceView {...fixture()} />);
    await user.upload(screen.getByLabelText('Attach text files'), file); view.unmount();
    await act(async () => { resolve(new TextEncoder().encode('notes').buffer); });
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
  });
});

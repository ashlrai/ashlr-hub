import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleTaskInput } from '../../../core/resources/console-types.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';
import { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView.js';

const digest = 'a'.repeat(64);
const transcript = { id: 'done-task', prompt: 'Earlier request', output: { text: 'Earlier answer', truncated: false },
  transcriptDigest: digest, retention: 'local-until-deleted' };
function setup() {
  const fixture = resourceFixture(); fixture.scope.historySupported = true; fixture.scope.followUpSupported = true;
  fixture.snapshot.supervisor!.jobs.find((job) => job.id === 'done-task')!.historyAvailable = true;
  const props: WorkspaceViewProps = { ...fixture, historical: false, enabled: true, stopEnabled: true, busy: false,
    unlocked: true, onUnlock: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn(async (_input: ResourceConsoleTaskInput) => true) };
  return props;
}
function select(id: string) {
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Project and tasks' })).getByRole('button', { name: new RegExp(id) }));
}
async function follow() {
  select('done-task');
  fireEvent.click(screen.getByRole('button', { name: 'Read transcript' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Follow up from this task' }));
}
function compose() {
  fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Next request only' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Task worker' }), { target: { value: 'local-a' } });
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(transcript)))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('server-pinned workspace follow-ups', () => {
  it('pins inspected history without sending prior text or inheriting retention', async () => {
    const props = setup(); render(<WorkspaceView {...props} />); await follow();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Follow-up context')).toBeInTheDocument();
    compose();
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Workspace task composer' })); });
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Next request only',
      parent: { taskId: 'done-task', expectedTranscriptDigest: digest }, allowedWorkerIds: ['local-a'], mode: 'read-only' }));
    const sent = vi.mocked(props.onSubmit).mock.calls[0]![0];
    expect(sent.id).not.toBe('done-task'); expect(sent.retainHistory).toBeUndefined();
    expect(screen.queryByText('Follow-up context')).not.toBeInTheDocument();
  });
  it('keeps the explicit parent when inspecting another task and preserves it on failed send', async () => {
    const props = setup(); vi.mocked(props.onSubmit).mockResolvedValue(false);
    render(<WorkspaceView {...props} />); await follow(); select('owned-task'); compose();
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Workspace task composer' })); });
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ parent: { taskId: 'done-task', expectedTranscriptDigest: digest } }));
    expect(screen.getByText('Follow-up context')).toBeInTheDocument();
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Next request only');
  });
  it.each(['Start standalone', '+ New task'])('explicitly removes parent with %s', async (name) => {
    const props = setup(); render(<WorkspaceView {...props} />); await follow(); compose();
    fireEvent.click(screen.getByRole('button', { name }));
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Workspace task composer' })); });
    expect(vi.mocked(props.onSubmit).mock.calls[0]![0].parent).toBeUndefined();
  });
  it('does not silently detach a draft when its source transcript is deleted', async () => {
    const props = setup(); props.onDeleteHistory = vi.fn(async () => true);
    render(<WorkspaceView {...props} />); await follow(); compose();
    fireEvent.click(screen.getByRole('button', { name: 'Delete transcript' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delete transcript' })); });
    expect(props.onDeleteHistory).toHaveBeenCalledWith('done-task');
    expect(screen.getByText('Follow-up context')).toBeInTheDocument();
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Workspace task composer' })); });
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ parent: { taskId: 'done-task', expectedTranscriptDigest: digest } }));
  });
  it('requires capability and terminal state, and does not treat a legacy transcript as follow-up capable', async () => {
    const props = setup(); props.scope.followUpSupported = false;
    const view = render(<WorkspaceView {...props} />); select('done-task'); fireEvent.click(screen.getByRole('button', { name: 'Read transcript' }));
    await screen.findByText('Earlier answer'); expect(screen.queryByRole('button', { name: 'Follow up from this task' })).not.toBeInTheDocument();
    view.unmount();
    const { transcriptDigest: _digest, ...legacy } = transcript;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(legacy))));
    const next = setup(); render(<WorkspaceView {...next} />); select('done-task'); fireEvent.click(screen.getByRole('button', { name: 'Read transcript' }));
    await screen.findByText('Earlier answer'); expect(screen.queryByRole('button', { name: 'Follow up from this task' })).not.toBeInTheDocument();
  });
  it('shows flat prior turns with actual null and truncated response markers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...transcript,
      parent: { taskId: 'prior-b', expectedTranscriptDigest: digest }, context: [
        { taskId: 'prior-a', prompt: 'Cancelled request', output: null, outcome: 'cancelled' },
        { taskId: 'prior-b', prompt: 'Second request', output: { text: 'Partial answer', truncated: true }, outcome: 'completed' },
      ] }))));
    const props = setup(); render(<WorkspaceView {...props} />); await follow();
    expect(screen.getByText('No captured response.')).toBeInTheDocument();
    expect(screen.getByText('Response (truncated)')).toBeInTheDocument();
    expect(screen.getByText(/3 prior turns through/)).toBeInTheDocument();
  });
  it('preserves the explicit pin across console restart but clears it on project change', async () => {
    const props = setup(); const view = render(<WorkspaceView {...props} />); await follow();
    view.rerender(<WorkspaceView {...props} snapshot={{ ...props.snapshot, supervisor: { ...props.snapshot.supervisor!, instanceId: 'another-instance' } }} />);
    expect(screen.getByText('Follow-up context')).toBeInTheDocument();
    view.rerender(<WorkspaceView {...props} scope={{ ...props.scope, workspace: '/other-project' }} />);
    expect(screen.queryByText('Follow-up context')).not.toBeInTheDocument();
  });
});

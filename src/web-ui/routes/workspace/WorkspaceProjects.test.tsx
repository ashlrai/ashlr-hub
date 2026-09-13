import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleTaskInput } from '../../../core/resources/console-types.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';
import { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView.js';

function setup() {
  const fixture = resourceFixture(); fixture.scope.historySupported = true; fixture.scope.followUpSupported = true;
  fixture.scope.defaultProjectId = 'default'; fixture.scope.projects = [
    { id: 'default', label: 'Hub', workspace: fixture.scope.workspace!, enabled: true },
    { id: 'cortex', label: 'Cortex', workspace: '/workspace/cortex', enabled: true },
    { id: 'retired', label: 'Retired', workspace: '/workspace/retired', enabled: false },
  ];
  const parent = fixture.snapshot.supervisor!.jobs.find((job) => job.id === 'done-task')!; parent.historyAvailable = true;
  fixture.snapshot.supervisor!.jobs.push({ ...parent, id: 'cortex-task', projectId: 'cortex' });
  const props: WorkspaceViewProps = { ...fixture, historical: false, enabled: true, stopEnabled: true, busy: false,
    unlocked: true, onUnlock: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn(async (_input: ResourceConsoleTaskInput) => true) };
  return props;
}
const pane = () => within(screen.getByRole('region', { name: 'Project task workspace' }));
function choose(name: string) { fireEvent.click(pane().getByRole('button', { name: `Switch to ${name}` })); }
function task(id: string) { fireEvent.click(pane().getByRole('button', { name: new RegExp(`${id} `) })); }
function prompt(text: string) { fireEvent.change(pane().getByLabelText('Task prompt'), { target: { value: text } }); }
function worker() { fireEvent.change(pane().getByRole('combobox', { name: 'Task worker' }), { target: { value: 'local-a' } }); }
async function send() { await act(async () => { fireEvent.submit(pane().getByRole('form', { name: 'Workspace task composer' })); }); }
const digest = 'a'.repeat(64);
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'done-task', prompt: 'Hub request',
  output: { text: 'Hub answer', truncated: false }, transcriptDigest: digest, retention: 'local-until-deleted' })))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('project-bound engineering workspace', () => {
  it('selects the legacy default, filters task attribution, and sends only the chosen registered ID', async () => {
    const props = setup(); render(<WorkspaceView {...props} />);
    expect(pane().getByRole('heading', { name: 'Hub' })).toBeInTheDocument();
    expect(pane().queryByRole('button', { name: /cortex-task/ })).not.toBeInTheDocument();
    expect(pane().queryByRole('button', { name: /external-task/ })).not.toBeInTheDocument();
    choose('Cortex'); expect(pane().getByRole('button', { name: /cortex-task/ })).toBeInTheDocument();
    expect(pane().queryByRole('button', { name: /done-task/ })).not.toBeInTheDocument();
    prompt('Cortex request'); worker(); await send();
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'cortex', prompt: 'Cortex request' }));
    expect(vi.mocked(props.onSubmit).mock.calls[0]![0]).not.toHaveProperty('workspace');
  });
  it('preserves separate drafts, workers and attachments without local storage', async () => {
    const props = setup(); const storage = vi.spyOn(Storage.prototype, 'setItem'); render(<WorkspaceView {...props} />);
    prompt('Hub draft'); worker();
    const file = new File(['Hub attachment'], 'hub.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('Hub attachment').buffer });
    await act(async () => { fireEvent.change(pane().getByLabelText('Attach text files'), { target: { files: [file] } }); });
    choose('Cortex'); expect(pane().getByLabelText('Task prompt')).toHaveValue('');
    expect(pane().queryByLabelText('Attached text files')).not.toBeInTheDocument(); prompt('Cortex draft');
    choose('Hub'); expect(pane().getByLabelText('Task prompt')).toHaveValue('Hub draft');
    expect(pane().getByRole('combobox', { name: 'Task worker' })).toHaveValue('local-a');
    expect(pane().getByText('hub.txt')).toBeInTheDocument();
    choose('Cortex'); expect(pane().getByLabelText('Task prompt')).toHaveValue('Cortex draft');
    expect(storage).not.toHaveBeenCalled();
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('keeps a follow-up pin in its original project while another project sends standalone work', async () => {
    const props = setup(); render(<WorkspaceView {...props} />); task('done-task');
    fireEvent.click(pane().getByRole('button', { name: 'Read transcript' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Follow up from this task' })); prompt('Hub continuation');
    choose('Cortex'); expect(pane().queryByText('Follow-up context')).not.toBeInTheDocument(); prompt('Cortex independent'); worker(); await send();
    expect(vi.mocked(props.onSubmit).mock.calls[0]![0].parent).toBeUndefined();
    choose('Hub'); expect(pane().getByText('Follow-up context')).toBeInTheDocument(); worker(); await send();
    expect(vi.mocked(props.onSubmit).mock.calls[1]![0]).toMatchObject({ parent: { taskId: 'done-task', expectedTranscriptDigest: digest } });
    expect(vi.mocked(props.onSubmit).mock.calls[1]![0].projectId).toBeUndefined();
  });
  it('allows inspection but refuses sending into a disabled project', async () => {
    const props = setup(); render(<WorkspaceView {...props} />); choose('Retired');
    expect(pane().getByText(/This project is disabled/)).toBeInTheDocument();
    prompt('not allowed'); worker(); expect(pane().getByRole('button', { name: 'Send task' })).toBeDisabled();
    await send(); expect(props.onSubmit).not.toHaveBeenCalled();
  });
  it('discards an in-flight transcript when switching projects, including a late response', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    render(<WorkspaceView {...setup()} />); task('done-task'); fireEvent.click(pane().getByRole('button', { name: 'Read transcript' }));
    choose('Cortex'); await act(async () => { resolve(new Response(JSON.stringify({ id: 'done-task', prompt: 'PRIVATE LATE HUB TEXT', output: null,
      transcriptDigest: digest, retention: 'local-until-deleted' }))); });
    expect(pane().queryByText('PRIVATE LATE HUB TEXT')).not.toBeInTheDocument();
    choose('Hub'); expect(pane().queryByText('PRIVATE LATE HUB TEXT')).not.toBeInTheDocument();
    expect(pane().getByRole('button', { name: 'Read transcript' })).toBeInTheDocument();
  });
  it('resets all project drafts when the host scope changes', () => {
    const props = setup(); const view = render(<WorkspaceView {...props} />); prompt('Old host draft'); choose('Cortex'); prompt('Old cortex draft');
    view.rerender(<WorkspaceView {...props} scope={{ ...props.scope, root: '/different-host-root' }} />);
    expect(pane().getByLabelText('Task prompt')).toHaveValue(''); choose('Cortex'); expect(pane().getByLabelText('Task prompt')).toHaveValue('');
  });
});

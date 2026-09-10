import { createHash } from 'node:crypto';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleFilePreview } from '../../../core/resources/console-files-types.js';
import type { ResourceConsoleTaskInput } from '../../../core/resources/console-types.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';
import { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView.js';

const token = 'f'.repeat(64);
function props(): WorkspaceViewProps {
  const fixture = resourceFixture(); fixture.scope.workspaceFilesSupported = true;
  fixture.scope.defaultProjectId = 'default'; fixture.scope.projects = [
    { id: 'default', label: 'Hub', workspace: fixture.scope.workspace!, enabled: true },
    { id: 'cortex', label: 'Cortex', workspace: '/fixture/cortex', enabled: true },
  ];
  return { ...fixture, historical: false, enabled: true, stopEnabled: true, busy: false, unlocked: true,
    onUnlock: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn(async (_task: ResourceConsoleTaskInput) => true) };
}
const pane = () => within(screen.getByRole('region', { name: 'Project task workspace' }));
const choose = (name: string) => fireEvent.click(pane().getByRole('button', { name: `Switch to ${name}` }));
const filesTab = () => fireEvent.click(pane().getByRole('tab', { name: 'Files' }));
function draft(value: string) {
  fireEvent.change(pane().getByLabelText('Task prompt'), { target: { value } });
  fireEvent.change(pane().getByRole('combobox', { name: 'Task worker' }), { target: { value: 'local-a' } });
}
async function send() { await act(async () => { fireEvent.submit(pane().getByRole('form', { name: 'Workspace task composer' })); }); }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function preview(projectId = 'default', text = 'const selected = "EXPLICIT_SOURCE_SNAPSHOT";'): ResourceConsoleFilePreview {
  const byteLength = new TextEncoder().encode(text).byteLength;
  return { projectId, path: 'selected.ts', text, sizeBytes: byteLength, byteLength, truncated: false,
    digest: createHash('sha256').update(text).digest('hex') };
}
function listing(projectId = 'default') {
  return { projectId, path: '', entries: [{ name: 'selected.ts', path: 'selected.ts', kind: 'file', sizeBytes: 100 }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function transport(read: (projectId: string) => Promise<Response> = async (projectId) => json(preview(projectId))) {
  const calls = vi.fn(async (url: string, init?: RequestInit) => {
    const match = /^\/api\/resources\/projects\/(default|cortex)\/files\/(list|read)$/.exec(url);
    if (!match) throw new Error(`Unexpected fixture request ${url}`);
    expect(init?.method).toBe('POST'); expect(init?.headers).toMatchObject({ 'x-ashlr-token': token });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ path: match[2] === 'list' ? '' : 'selected.ts' });
    return match[2] === 'list' ? json(listing(match[1])) : read(match[1]!);
  });
  vi.stubGlobal('fetch', calls); return calls;
}
async function browseAndPreview() {
  filesTab(); fireEvent.click(pane().getByRole('button', { name: 'Browse files' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Preview file selected.ts' }));
}
beforeEach(() => { setMutationToken(token); });
afterEach(() => { act(() => clearMutationToken()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('independent WorkspaceView file acceptance', () => {
  it('clears a file preview when switching mobile panes without discarding the draft', async () => {
    const request = transport(); render(<WorkspaceView {...props()} />); draft('Keep my mobile draft');
    fireEvent.click(pane().getByRole('button', { name: 'Tools' }));
    await browseAndPreview(); await screen.findByText(preview().text);
    fireEvent.click(pane().getByRole('button', { name: 'Task' }));
    expect(screen.queryByText(preview().text)).not.toBeInTheDocument();
    fireEvent.click(pane().getByRole('button', { name: 'Tools' }));
    expect(screen.queryByText(preview().text)).not.toBeInTheDocument();
    expect(pane().getByLabelText('Task prompt')).toHaveValue('Keep my mobile draft'); expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not read files on mount, tab opening, project selection or control unlock', () => {
    const request = transport(); const input = props(); const view = render(<WorkspaceView {...input} unlocked={false} />);
    filesTab(); fireEvent.click(pane().getByRole('button', { name: 'Unlock file access' }));
    expect(input.onUnlock).toHaveBeenCalledOnce(); view.rerender(<WorkspaceView {...input} />);
    choose('Cortex'); filesTab(); choose('Hub');
    expect(request).not.toHaveBeenCalled(); expect(input.onSubmit).not.toHaveBeenCalled();
  });

  it('attaches the exact viewed snapshot with provenance and sends only on an explicit submit', async () => {
    const source = preview(); const request = transport(async () => json(source)); const input = props();
    render(<WorkspaceView {...input} />); draft('Explain the selected source.'); await browseAndPreview();
    expect(await screen.findByText(source.text)).toBeInTheDocument();
    expect(pane().queryByRole('list', { name: 'Attached text files' })).not.toBeInTheDocument();
    expect(input.onSubmit).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
    fireEvent.click(pane().getByRole('button', { name: 'Attach viewed snapshot' }));
    expect(pane().getByRole('list', { name: 'Attached text files' })).toHaveTextContent('selected.ts');
    source.text = 'LATER_SOURCE_CHANGE'; expect(input.onSubmit).not.toHaveBeenCalled();
    await send(); expect(input.onSubmit).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledTimes(2);
    const task = vi.mocked(input.onSubmit).mock.calls[0]![0];
    const compiled = JSON.parse(task.prompt.slice(task.prompt.indexOf('{')));
    expect(compiled).toEqual({ request: 'Explain the selected source.', attachments: [{ name: 'selected.ts',
      text: preview().text, source: { projectId: 'default', path: 'selected.ts', digest: preview().digest } }] });
    expect(task.allowedWorkerIds).toEqual(['local-a']); expect(task.projectId).toBeUndefined();
    expect(task.prompt).not.toContain('LATER_SOURCE_CHANGE');
  });

  it('keeps attached source in its original project and sends another project without that context', async () => {
    const request = transport(); const input = props(); render(<WorkspaceView {...input} />);
    draft('Hub draft'); await browseAndPreview(); await screen.findByText(preview().text);
    fireEvent.click(pane().getByRole('button', { name: 'Attach viewed snapshot' }));
    choose('Cortex'); expect(pane().queryByRole('list', { name: 'Attached text files' })).not.toBeInTheDocument();
    draft('Independent Cortex request'); await send();
    expect(vi.mocked(input.onSubmit).mock.calls[0]![0]).toMatchObject({ projectId: 'cortex', prompt: 'Independent Cortex request' });
    choose('Hub'); expect(pane().getByLabelText('Task prompt')).toHaveValue('Hub draft');
    expect(pane().getByRole('list', { name: 'Attached text files' })).toHaveTextContent('selected.ts');
    expect(pane().queryByRole('region', { name: 'File preview' })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['project', 'surface', 'lock'] as const)('aborts and discards a late preview after %s changes without losing the draft', async (change) => {
    const pending = deferred<Response>(); const request = transport(() => pending.promise); const input = props();
    const view = render(<WorkspaceView {...input} />); draft('Preserve scoped draft'); await browseAndPreview();
    const signal = request.mock.calls[1]![1]!.signal as AbortSignal; expect(signal.aborted).toBe(false);
    if (change === 'project') choose('Cortex');
    if (change === 'surface') view.rerender(<WorkspaceView {...input} surfaceActive={false} />);
    if (change === 'lock') { act(() => clearMutationToken()); view.rerender(<WorkspaceView {...input} unlocked={false} />); }
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(json(preview('default', 'PRIVATE_LATE_PREVIEW'))); await pending.promise; });
    expect(screen.queryByText('PRIVATE_LATE_PREVIEW')).not.toBeInTheDocument();
    if (change === 'project') choose('Hub');
    if (change === 'surface') view.rerender(<WorkspaceView {...input} surfaceActive />);
    if (change === 'lock') { act(() => setMutationToken(token)); view.rerender(<WorkspaceView {...input} />); }
    expect(pane().getByLabelText('Task prompt')).toHaveValue('Preserve scoped draft');
    expect(pane().queryByRole('region', { name: 'File preview' })).not.toBeInTheDocument();
    expect(pane().queryByRole('button', { name: 'Attach viewed snapshot' })).not.toBeInTheDocument();
    expect(pane().queryByRole('list', { name: 'Attached text files' })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2); expect(input.onSubmit).not.toHaveBeenCalled();
  });

  it('clears an already loaded preview on lock and surface hide while preserving explicit draft text', async () => {
    const request = transport(); const input = props(); const view = render(<WorkspaceView {...input} />);
    draft('Keep this draft'); await browseAndPreview(); await screen.findByText(preview().text);
    view.rerender(<WorkspaceView {...input} unlocked={false} />);
    expect(screen.queryByText(preview().text)).not.toBeInTheDocument(); view.rerender(<WorkspaceView {...input} />);
    expect(screen.queryByText(preview().text)).not.toBeInTheDocument();
    fireEvent.click(pane().getByRole('button', { name: 'Browse files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview file selected.ts' })); await screen.findByText(preview().text);
    view.rerender(<WorkspaceView {...input} surfaceActive={false} />);
    expect(screen.queryByText(preview().text)).not.toBeInTheDocument();
    view.rerender(<WorkspaceView {...input} surfaceActive />);
    expect(screen.queryByText(preview().text)).not.toBeInTheDocument(); expect(pane().getByLabelText('Task prompt')).toHaveValue('Keep this draft');
    expect(request).toHaveBeenCalledTimes(4); expect(input.onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a wrong-project preview before it can be displayed or attached', async () => {
    transport(async () => json(preview('cortex', 'WRONG_PROJECT_PRIVATE_TEXT'))); const input = props();
    render(<WorkspaceView {...input} />); await browseAndPreview();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
    expect(screen.queryByText('WRONG_PROJECT_PRIVATE_TEXT')).not.toBeInTheDocument();
    expect(pane().queryByRole('button', { name: 'Attach viewed snapshot' })).not.toBeInTheDocument();
    expect(pane().queryByRole('list', { name: 'Attached text files' })).not.toBeInTheDocument(); expect(input.onSubmit).not.toHaveBeenCalled();
  });

  it('renders source markup as inert text rather than a document or executable element', async () => {
    const text = '<img src="fixture" onerror="window.injected=true"><script>window.injected=true</script>';
    transport(async () => json(preview('default', text))); const view = render(<WorkspaceView {...props()} />);
    await browseAndPreview(); expect(await screen.findByText(text)).toBeInTheDocument();
    expect(view.container.querySelector('img,script,iframe')).toBeNull();
  });

  it.each(['partial', 'oversized'] as const)('does not attach a %s preview', async (kind) => {
    const source = preview('default', kind === 'partial' ? 'Selected prefix' : 'x'.repeat(16 * 1024 + 1));
    if (kind === 'partial') { source.sizeBytes += 50; source.truncated = true; }
    const request = transport(async () => json(source)); const input = props(); render(<WorkspaceView {...input} />);
    await browseAndPreview(); const attach = await screen.findByRole('button', { name: 'Attach viewed snapshot' });
    expect(attach).toBeDisabled(); fireEvent.click(attach);
    expect(pane().queryByRole('list', { name: 'Attached text files' })).not.toBeInTheDocument();
    expect(input.onSubmit).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
  });

  it('reports a basename collision and retains the original attachment without silently replacing it', async () => {
    const request = transport(); const input = props(); render(<WorkspaceView {...input} />); draft('Use my chosen reference');
    const file = new File(['ORIGINAL_LOCAL_ATTACHMENT'], 'selected.ts', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('ORIGINAL_LOCAL_ATTACHMENT').buffer });
    await act(async () => { fireEvent.change(pane().getByLabelText('Attach text files'), { target: { files: [file] } }); });
    await browseAndPreview(); await screen.findByText(preview().text);
    fireEvent.click(pane().getByRole('button', { name: 'Attach viewed snapshot' }));
    expect(pane().getByRole('alert')).toHaveTextContent('Attachment filenames must be distinct');
    expect(within(pane().getByRole('list', { name: 'Attached text files' })).getAllByRole('listitem')).toHaveLength(1);
    expect(input.onSubmit).not.toHaveBeenCalled(); await send();
    const sent = vi.mocked(input.onSubmit).mock.calls[0]![0];
    expect(sent.prompt).toContain('ORIGINAL_LOCAL_ATTACHMENT'); expect(sent.prompt).not.toContain('EXPLICIT_SOURCE_SNAPSHOT');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('uses End to reach the third Files tab without silently browsing', () => {
    const request = transport(); render(<WorkspaceView {...props()} />);
    const details = pane().getByRole('tab', { name: 'Task details' }); details.focus();
    fireEvent.keyDown(details, { key: 'End' }); const files = pane().getByRole('tab', { name: 'Files' });
    expect(files).toHaveFocus(); expect(files).toHaveAttribute('aria-selected', 'true');
    expect(pane().getByRole('tabpanel', { name: 'Files' })).toBeInTheDocument();
    expect(pane().getByRole('button', { name: 'Browse files' })).toBeInTheDocument(); expect(request).not.toHaveBeenCalled();
  });
});

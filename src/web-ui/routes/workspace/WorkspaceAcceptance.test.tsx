import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourcePoolConsoleApp } from '../../app/ResourcePoolConsoleApp.js';
import { clearMutationToken, markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';
import { WorkspaceView, type WorkspaceViewProps } from './WorkspaceView.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function props(): WorkspaceViewProps {
  return { ...resourceFixture(), historical: false, enabled: true, stopEnabled: true,
    busy: false, unlocked: true, onUnlock: vi.fn(), onSubmit: vi.fn(async () => true), onCancel: vi.fn() };
}
function selectTask(id: string) {
  fireEvent.click(within(screen.getByRole('complementary', { name: 'Project and tasks' })).getByRole('button', { name: new RegExp(id) }));
}
function fillDraft() {
  fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Preserve this scoped draft.' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Task worker' }), { target: { value: 'local-a' } });
}
afterEach(() => {
  act(() => { clearMutationToken(); markCheckComplete(false); });
  evictAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/');
});

describe('independent workspace acceptance boundaries', () => {
  it('keeps disabled native file-picker chrome hidden while dimming its visible label', () => {
    // jsdom does not model the full CSS cascade. Real-browser computed opacity
    // is checked separately; retain the disabled selector that wins over the
    // generic .workspace input:disabled rule without hiding the accessible input.
    const css = readFileSync('src/web-ui/routes/workspace/WorkspaceView.module.css', 'utf8');
    expect(css).toMatch(/\.fileButton input:disabled\s*\{[^}]*opacity:\s*0;[^}]*cursor:\s*not-allowed;/);
    expect(css).toMatch(/\.fileButton:has\(input:disabled\)\s*\{[^}]*opacity:\s*\.65;[^}]*cursor:\s*not-allowed;/);
  });

  it('renders a null-workspace read-only session without enabling send or upload', () => {
    const input = props(); input.scope = { ...input.scope, readOnly: true, workspace: null, maxParallel: 0, maxQueued: 0 };
    input.snapshot.supervisor = null;
    render(<WorkspaceView {...input} />);
    expect(screen.getByRole('heading', { name: 'No execution workspace' })).toBeInTheDocument();
    expect(screen.getByLabelText('Task prompt')).toBeDisabled();
    expect(screen.getByLabelText('Attach text files')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send task' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: 'Workspace task composer' }));
    expect(input.onSubmit).not.toHaveBeenCalled();
  });

  it('admits exactly the chosen worker once across rapid form submissions', async () => {
    const input = props(); const pending = deferred<boolean>(); input.onSubmit = vi.fn(() => pending.promise);
    render(<WorkspaceView {...input} />); fillDraft();
    const form = screen.getByRole('form', { name: 'Workspace task composer' });
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(input.onSubmit).toHaveBeenCalledOnce();
    expect(input.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      allowedWorkerIds: ['local-a'], mode: 'read-only', prompt: 'Preserve this scoped draft.',
    }));
    await act(async () => { pending.resolve(false); await pending.promise; });
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Preserve this scoped draft.');
  });

  it('keeps owned cancellation available when stale evidence blocks new work', () => {
    const input = props(); input.historical = true; input.enabled = false;
    render(<WorkspaceView {...input} />); fillDraft();
    expect(screen.getByRole('button', { name: 'Send task' })).toBeDisabled();
    selectTask('owned-task');
    const cancel = screen.getByRole('button', { name: 'Cancel owned task' });
    expect(cancel).toBeEnabled(); fireEvent.click(cancel);
    expect(input.onCancel).toHaveBeenCalledExactlyOnceWith('owned-task');
    expect(input.onSubmit).not.toHaveBeenCalled();
  });

  it.each(['task', 'session'] as const)('discards late output after a %s identity change', async (change) => {
    const input = props(); const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const view = render(<WorkspaceView {...input} />);
    selectTask('done-task'); fireEvent.click(screen.getByRole('button', { name: 'Read response' }));
    if (change === 'task') selectTask('owned-task');
    else view.rerender(<WorkspaceView {...input} snapshot={{ ...input.snapshot,
      supervisor: { ...input.snapshot.supervisor!, instanceId: 'next-console-instance' } }} />);
    await act(async () => {
      pending.resolve(new Response(JSON.stringify({ id: 'done-task', text: 'OLD PRIVATE RESPONSE',
        truncated: false, retention: 'this-console-session' })));
      await pending.promise;
    });
    expect(screen.queryByText('OLD PRIVATE RESPONSE')).not.toBeInTheDocument();
    expect(screen.queryByText('Reading response…')).not.toBeInTheDocument();
  });

  it('renders response markup only as inert text', async () => {
    const input = props();
    const text = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'done-task', text,
      truncated: false, retention: 'this-console-session' }))));
    const view = render(<WorkspaceView {...input} />); selectTask('done-task');
    fireEvent.click(screen.getByRole('button', { name: 'Read response' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(view.container.querySelector('script, img')).toBeNull();
  });

  it('drops in-flight attachment content after switching tasks', async () => {
    const input = props(); const pending = deferred<ArrayBuffer>(); const user = userEvent.setup();
    const file = new File(['private reference'], 'private.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => pending.promise });
    render(<WorkspaceView {...input} />); fillDraft();
    await user.upload(screen.getByLabelText('Attach text files'), file);
    expect(screen.getByText('Reading selected text files…')).toBeInTheDocument();
    selectTask('owned-task');
    await act(async () => { pending.resolve(new TextEncoder().encode('private reference').buffer); await pending.promise; });
    expect(screen.queryByRole('list', { name: 'Attached text files' })).not.toBeInTheDocument();
    expect(screen.queryByText('Reading selected text files…')).not.toBeInTheDocument();
    expect(input.onSubmit).not.toHaveBeenCalled();
  });

  it('does not attach a prior-session submit completion to the new session', async () => {
    const input = props(); const pending = deferred<boolean>(); input.onSubmit = vi.fn(() => pending.promise);
    const view = render(<WorkspaceView {...input} />); fillDraft();
    fireEvent.submit(screen.getByRole('form', { name: 'Workspace task composer' }));
    view.rerender(<WorkspaceView {...input} snapshot={{ ...input.snapshot,
      supervisor: { ...input.snapshot.supervisor!, instanceId: 'new-session' } }} />);
    await act(async () => { pending.resolve(true); await pending.promise; });
    expect(screen.queryByRole('heading', { name: 'Your task' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Preserve this scoped draft.');
    expect(screen.getByRole('heading', { name: 'What would you like to work on?' })).toBeInTheDocument();
  });

  it('resets draft and ignores pending submit completion on a host workspace change', async () => {
    const input = props(); const pending = deferred<boolean>(); input.onSubmit = vi.fn(() => pending.promise);
    const view = render(<WorkspaceView {...input} />); fillDraft();
    fireEvent.submit(screen.getByRole('form', { name: 'Workspace task composer' }));
    view.rerender(<WorkspaceView {...input} scope={{ ...input.scope, workspace: '/private/another-project' }} />);
    expect(screen.getByLabelText('Task prompt')).toHaveValue('');
    await act(async () => { pending.resolve(true); await pending.promise; });
    expect(screen.queryByRole('heading', { name: 'Your task' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task prompt')).toHaveValue('');
  });

  it('removes private workspace drafts on disconnect and does not restore them after reconnecting', async () => {
    window.history.replaceState(null, '', '/resources/#resource-workspace');
    evictAll(); clearMutationToken(); markCheckComplete(true);
    const { scope, snapshot } = resourceFixture(); let authenticated = true;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/session') {
        authenticated = init?.method === 'POST'; return new Response(null, { status: 204 });
      }
      if (!authenticated) return new Response(null, { status: 401 });
      if (path === '/api/resources/console') return new Response(JSON.stringify(scope));
      if (path === '/api/resources') return new Response(JSON.stringify(snapshot));
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', request); vi.stubGlobal('EventSource', vi.fn());
    const user = userEvent.setup(); render(<ResourcePoolConsoleApp />);
    await screen.findByLabelText('Task prompt'); fillDraft();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await screen.findByRole('heading', { name: 'Connect to Ashlrverse resources' });
    expect(screen.queryByLabelText('Task prompt')).not.toBeInTheDocument();
    expect(screen.queryByText('Preserve this scoped draft.')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Read token'), 'a'.repeat(64));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByLabelText('Task prompt')).toHaveValue('');
    expect(request.mock.calls.some(([path]) => path === '/api/resources/tasks')).toBe(false);
    expect(EventSource).not.toHaveBeenCalled();
  });
});

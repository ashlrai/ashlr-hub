/**
 * MemoryPanel.test.tsx — shared project memory, pinned at the DOM against the
 * real query layer (fetch is the only thing stubbed), so the requests the
 * panel makes are the requests the server will see.
 *
 * The promises under test:
 *  - the scope is stated (one file per PROJECT, shared by every seat);
 *  - an agent's write while the operator edits is a CONFLICT, never a silent
 *    overwrite;
 *  - a credential-shaped paste is flagged before it is saved;
 *  - on/off is per project, with the global switch honoured;
 *  - a server without the route gets a sentence, not a crash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VersePreferences, VerseProjectMemory } from '../../../../core/verse/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, memoryRecord, preferences, TEST_TOKEN, type RecordedCall } from './context-fixtures.test-support.js';
import { MemoryPanel } from './MemoryPanel.js';

const PROJECT = '/Users/mason/dev/hub';

interface ServerState {
  memory: VerseProjectMemory;
  prefs: VersePreferences;
  /** When set, the NEXT memory GET answers this instead (an agent wrote the file meanwhile). */
  agentWrite: string | null;
  memoryStatus: number;
}

function server(initial: Partial<ServerState> = {}) {
  const state: ServerState = {
    memory: memoryRecord(),
    prefs: preferences(),
    agentWrite: null,
    memoryStatus: 200,
    ...initial,
  };
  const handle = (call: RecordedCall) => {
    const url = new URL(call.path, 'http://localhost');
    if (url.pathname === '/api/verse/memory' && call.method === 'GET') {
      if (state.memoryStatus !== 200) return json({ error: 'not found' }, state.memoryStatus);
      if (state.agentWrite !== null) {
        state.memory = memoryRecord({ content: state.agentWrite, updatedAt: new Date().toISOString() });
        state.agentWrite = null;
      }
      return json({ ...state.memory, enabled: state.prefs.memory.enabled && !state.prefs.memory.disabledProjects.includes(PROJECT) });
    }
    if (url.pathname === '/api/verse/memory' && call.method === 'POST') {
      const body = call.body as { projectPath: string; content: string };
      state.memory = memoryRecord({ content: body.content, updatedAt: new Date().toISOString() });
      return json(state.memory);
    }
    if (url.pathname === '/api/verse/preferences' && call.method === 'GET') return json(state.prefs);
    if (url.pathname === '/api/verse/preferences' && call.method === 'POST') {
      const body = call.body as { projectPath?: string; memoryEnabled?: boolean };
      if (body.projectPath !== undefined) {
        const disabled = state.prefs.memory.disabledProjects.filter((p) => p !== body.projectPath);
        state.prefs = { ...state.prefs, memory: { ...state.prefs.memory, disabledProjects: body.memoryEnabled ? disabled : [...disabled, body.projectPath] } };
      } else if (body.memoryEnabled !== undefined) {
        state.prefs = { ...state.prefs, memory: { ...state.prefs.memory, enabled: body.memoryEnabled } };
      }
      return json(state.prefs);
    }
    return json({ error: 'not found' }, 404);
  };
  const { calls } = installFetch(handle);
  return { state, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

function section() {
  return screen.getByRole('region', { name: /Project memory/ });
}

beforeEach(() => {
  evictAll();
  setMutationToken(TEST_TOKEN);
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

describe('what it shows', () => {
  it('asks for a chat when none is open, and reads nothing', () => {
    const { calls } = server();
    render(<MemoryPanel projectPath={null} />);
    expect(screen.getByText(/Open a chat to see the memory its project shares/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('shows the file, its size and age, the other files, and the scope', async () => {
    server({ memory: memoryRecord({ files: ['plan.md', 'findings.log'] }) });
    render(<MemoryPanel projectPath={PROJECT} />);
    const file = await screen.findByLabelText('MEMORY.md for hub');
    expect(file).toHaveTextContent('Billing migration: use batched copies');
    const panel = section();
    expect(within(panel).getByText('on')).toBeInTheDocument();
    expect(within(panel).getByText(/shared by every chat on/)).toHaveTextContent('hub');
    expect(within(panel).getByText('plan.md')).toBeInTheDocument();
    expect(within(panel).getByText('findings.log')).toBeInTheDocument();
    expect(within(panel).getByText(/^\d+ B$|KB$/)).toBeInTheDocument();
    // The honesty notes live one click away, not hidden entirely.
    expect(within(panel).getByText(/a Grok seat is given the text and can only read it/)).toBeInTheDocument();
    expect(within(panel).getByText(/never put secrets in it/)).toBeInTheDocument();
  });

  it('offers to write the first entries when the file is empty', async () => {
    const user = userEvent.setup();
    server({ memory: memoryRecord({ content: '' }) });
    render(<MemoryPanel projectPath={PROJECT} />);
    expect(await screen.findByText(/MEMORY.md is empty/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Write it' }));
    expect(screen.getByLabelText('Edit MEMORY.md')).toHaveFocus();
  });

  it('puts the caret at the end, so a typed line is appended rather than prepended', async () => {
    const user = userEvent.setup();
    server();
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByLabelText('Edit MEMORY.md') as HTMLTextAreaElement;
    expect(editor).toHaveFocus();
    expect(editor.selectionStart).toBe(editor.value.length);
    await user.keyboard('- appended');
    expect(editor.value.startsWith('# Hub memory')).toBe(true);
    expect(editor.value.endsWith('- appended')).toBe(true);
  });

  it('says so, quietly, on a server without the route', async () => {
    server({ memoryStatus: 404 });
    render(<MemoryPanel projectPath={PROJECT} />);
    expect(await screen.findByText(/This server has no project memory yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a real read failure with a retry', async () => {
    const srv = server({ memoryStatus: 500 });
    const user = userEvent.setup();
    render(<MemoryPanel projectPath={PROJECT} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not read this project’s memory/);
    srv.state.memoryStatus = 200;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('MEMORY.md for hub')).toBeInTheDocument();
  });

  it('re-reads when the caller’s refresh key moves (a turn finished)', async () => {
    const srv = server();
    const { rerender } = render(<MemoryPanel projectPath={PROJECT} refreshKey={3} />);
    await screen.findByLabelText('MEMORY.md for hub');
    const reads = () => srv.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/verse/memory')).length;
    const before = reads();
    srv.state.agentWrite = '# Hub memory\n\n- New: the backfill is done.\n';
    rerender(<MemoryPanel projectPath={PROJECT} refreshKey={4} />);
    await waitFor(() => expect(screen.getByLabelText('MEMORY.md for hub')).toHaveTextContent('the backfill is done'));
    expect(reads()).toBe(before + 1);
  });
});

describe('editing', () => {
  it('saves the edit with the exact body the route validates', async () => {
    const user = userEvent.setup();
    const srv = server();
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByLabelText('Edit MEMORY.md') as HTMLTextAreaElement;
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(editor, '- Gotcha: the staging DB needs VPN.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(srv.posts()).toHaveLength(1);
    expect(srv.posts()[0]!.body).toEqual({ projectPath: PROJECT, content: `${memoryRecord().content}- Gotcha: the staging DB needs VPN.` });
    expect(srv.posts()[0]!.headers['x-ashlr-token']).toBe(TEST_TOKEN);
    expect(screen.getByLabelText('MEMORY.md for hub')).toHaveTextContent('staging DB needs VPN');
  });

  it('turns an agent’s concurrent write into a conflict instead of overwriting it', async () => {
    const user = userEvent.setup();
    const srv = server();
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Edit MEMORY.md'), '- mine');
    srv.state.agentWrite = '# Hub memory\n\n- theirs: plan step 3 done\n';
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/An agent changed MEMORY.md while you were editing/)).toBeInTheDocument();
    expect(srv.posts()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Overwrite with mine' }));
    await screen.findByText('Saved.');
    expect(srv.posts()).toHaveLength(1);
    expect((srv.posts()[0]!.body as { content: string }).content.endsWith('- mine')).toBe(true);
  });

  it('can start over from the agent’s version', async () => {
    const user = userEvent.setup();
    const srv = server();
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Edit MEMORY.md'), '- mine');
    srv.state.agentWrite = '- theirs\n';
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Start over from theirs' }));
    expect((screen.getByLabelText('Edit MEMORY.md') as HTMLTextAreaElement).value).toBe('- theirs\n');
    expect(screen.queryByText(/An agent changed MEMORY.md/)).toBeNull();
  });

  it('flags a credential-shaped paste before it is saved', async () => {
    const user = userEvent.setup();
    server();
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByLabelText('Edit MEMORY.md'));
    await user.paste('deploy key: ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(screen.getByRole('alert')).toHaveTextContent('This looks like it contains a GitHub token');
  });

  it('refuses to save over the 64 KB cap and says by how much', async () => {
    const user = userEvent.setup();
    server({ memory: memoryRecord({ content: '' }) });
    render(<MemoryPanel projectPath={PROJECT} />);
    await user.click(await screen.findByRole('button', { name: 'Write it' }));
    const editor = screen.getByLabelText('Edit MEMORY.md') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor, 'x'.repeat(64 * 1024 + 1));
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(screen.getByText(/over the limit; trim it to save/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses a file under the memory cap whose REQUEST would exceed the body cap once escaped', async () => {
    const user = userEvent.setup();
    server({ memory: memoryRecord({ content: '' }) });
    render(<MemoryPanel projectPath={PROJECT} />);
    await user.click(await screen.findByRole('button', { name: 'Write it' }));
    const editor = screen.getByLabelText('Edit MEMORY.md') as HTMLTextAreaElement;
    // 50 KB of text, but every line break travels as two bytes: ~75 KB on the wire.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor, 'a\n'.repeat(25_000));
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(screen.getByText(/once line breaks and quotes are encoded for sending, over the 64 KB request limit/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('asks for the token when none is held, and saves once unlocked', async () => {
    clearMutationToken();
    const user = userEvent.setup();
    const srv = server();
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Edit MEMORY.md'), '- x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const prompt = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(prompt).toHaveTextContent('Saving writes MEMORY.md for this project');
    expect(srv.posts()).toHaveLength(0);
    await user.type(screen.getByLabelText('Mutation token'), TEST_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByText('Saved.');
    expect(srv.posts()).toHaveLength(1);
  });
});

describe('clearing', () => {
  it('clears only after an explicit confirmation', async () => {
    const user = userEvent.setup();
    const srv = server();
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Clear…' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Every chat on this project loses what it says');
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    expect(srv.posts()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Clear…' }));
    await user.click(screen.getByRole('button', { name: 'Clear it' }));
    expect(await screen.findByText(/Cleared\./)).toBeInTheDocument();
    expect(srv.posts()[0]!.body).toEqual({ projectPath: PROJECT, content: '' });
    expect(await screen.findByText(/MEMORY.md is empty/)).toBeInTheDocument();
  });
});

describe('on and off', () => {
  it('turns memory off for this project only, and says what that changes', async () => {
    const user = userEvent.setup();
    const srv = server();
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    const toggle = screen.getByRole('switch', { name: /Give new chats on hub this memory/ });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    expect(await screen.findByText(/New chats on hub will start without shared memory. The file is kept./)).toBeInTheDocument();
    expect(srv.posts()[0]!.body).toEqual({ projectPath: PROJECT, memoryEnabled: false });
    await waitFor(() => expect(screen.getByRole('switch', { name: /Give new chats on hub this memory/ })).toHaveAttribute('aria-checked', 'false'));
  });

  it('honours the global switch, and can turn it back on', async () => {
    const user = userEvent.setup();
    const srv = server({ prefs: preferences({ memory: { enabled: false, disabledProjects: [] } }) });
    render(<MemoryPanel projectPath={PROJECT} />);
    expect(await screen.findByText(/Shared memory is off for every project/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(within(section()).getByText('off everywhere')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn memory on' }));
    await waitFor(() => expect(srv.posts()[0]!.body).toEqual({ memoryEnabled: true }));
    expect(await screen.findByRole('switch', { name: /Give new chats on hub this memory/ })).toBeInTheDocument();
  });

  it('can turn memory off everywhere from the explainer', async () => {
    const user = userEvent.setup();
    const srv = server();
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByText('How project memory works'));
    await user.click(screen.getByRole('button', { name: 'Turn it off for every project' }));
    await waitFor(() => expect(srv.posts()[0]!.body).toEqual({ memoryEnabled: false }));
  });
});

describe('sanitized content (contentSanitized)', () => {
  /** What GET /memory answers when the public-JSON sanitizer changed the file's text on the way out. */
  function sanitized(content: string): VerseProjectMemory {
    return { ...memoryRecord({ content }), contentSanitized: true } as VerseProjectMemory;
  }
  const WITH_SECRET = '# Hub memory\n\n- deploy token: [REDACTED]\n- notes in ~/dev/hub/NOTES.md\n';

  it('says the view is sanitized, and that the real values are still in the file', async () => {
    server({ memory: sanitized(WITH_SECRET) });
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    expect(section()).toHaveTextContent('Shown sanitized for the browser');
    expect(section()).toHaveTextContent('The real values are still in the file.');
  });

  it('keeps Save off while a placeholder remains, and saves once the operator removes it', async () => {
    const user = userEvent.setup();
    const srv = server({ memory: sanitized(WITH_SECRET) });
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByLabelText('Edit MEMORY.md') as HTMLTextAreaElement;
    await user.type(editor, '- more');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('One [REDACTED] placeholder stands in for secret-looking text that is still in MEMORY.md');
    expect(alert).toHaveTextContent('Save stays off until it is gone');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(editor);
    await user.type(editor, '# Hub memory{Enter}{Enter}- notes in ~/dev/hub/NOTES.md{Enter}');
    expect(screen.queryByRole('alert')).toBeNull();
    // The `~` rewrite is not blocked — it names the same folder — but it is said.
    expect(section()).toHaveTextContent('a home-folder path appears as ~');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(srv.posts()).toHaveLength(1);
    expect((srv.posts()[0]!.body as { content: string }).content).not.toContain('[REDACTED]');
  });

  it('counts several placeholders in the warning', async () => {
    const user = userEvent.setup();
    server({ memory: sanitized('- a: [REDACTED]\n- b: [REDACTED]\n') });
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('alert')).toHaveTextContent('2 [REDACTED] placeholders stand in');
  });

  it('does not block a literal "[REDACTED]" in a file that was NOT sanitized', async () => {
    const user = userEvent.setup();
    server({ memory: memoryRecord({ content: '- the scrubber writes [REDACTED] over keys\n' }) });
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    expect(section()).not.toHaveTextContent('Shown sanitized');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Edit MEMORY.md'), '- more');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows the server’s own sentence when it refuses a save that would write placeholders', async () => {
    const user = userEvent.setup();
    const srv = server();
    // Backstop: the server refuses with 409 VERSE_MEMORY_REDACTED on its own count.
    installFetch((call) => {
      if (call.method === 'POST' && call.path === '/api/verse/memory') {
        return json({ code: 'VERSE_MEMORY_REDACTED', error: 'content contains [REDACTED] placeholders; saving would replace the real values.' }, 409);
      }
      if (call.path.startsWith('/api/verse/memory')) return json({ ...srv.state.memory, enabled: true });
      return json(srv.state.prefs);
    });
    render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Edit MEMORY.md'), '- more');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('saving would replace the real values');
  });
});

describe('switching projects', () => {
  it('drops a half-finished edit instead of saving it onto the next project', async () => {
    const user = userEvent.setup();
    server();
    const { rerender } = render(<MemoryPanel projectPath={PROJECT} />);
    await screen.findByLabelText('MEMORY.md for hub');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Edit MEMORY.md'), '- unsaved');
    rerender(<MemoryPanel projectPath="/Users/mason/dev/site" />);
    expect(screen.queryByLabelText('Edit MEMORY.md')).toBeNull();
    expect(await screen.findByLabelText('MEMORY.md for site')).toBeInTheDocument();
  });
});

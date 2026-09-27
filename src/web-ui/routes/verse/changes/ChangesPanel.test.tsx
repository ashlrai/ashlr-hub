import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  VerseCheckpointDiffResponse,
  VerseCheckpointListResponse,
  VerseCheckpointPreviewResponse,
  VerseCheckpointTurn,
} from '../../../../core/verse/checkpoint-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { status as gitStatus } from '../git/git-fixtures.test-support.js';
import { ChangesPanel } from './ChangesPanel.js';
import { ChangesPaneAdapter, CHANGES_PANE } from './changes-pane.js';
import type { CheckpointClient } from './checkpoint-queries.js';

const ROOT = 'aaaabbbbcccc';
const SHA = 'a'.repeat(40);

function turn(index: number, over: Partial<VerseCheckpointTurn> = {}): VerseCheckpointTurn {
  return {
    turnId: `turn-${index}`,
    index,
    startedAt: '2026-09-27T10:00:00.000Z',
    endedAt: '2026-09-27T10:01:00.000Z',
    outcome: 'ok',
    state: 'done',
    roots: [{ rootId: ROOT, pre: { commit: SHA, error: null, skipped: 0, at: '', ms: 12 }, post: { commit: SHA, error: null, skipped: 0, at: '', ms: 10 } }],
    filesChanged: 2,
    ...over,
  };
}

function listOf(over: Partial<VerseCheckpointListResponse> = {}): VerseCheckpointListResponse {
  return {
    chatId: 'chat-1',
    running: false,
    roots: [{ rootId: ROOT, path: '~/code/repo', name: 'repo' }],
    turns: [turn(1), turn(2)],
    redo: null,
    ...over,
  };
}

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' import x from "x";',
  '-const total = count + 1;',
  '+const total = counts + 2;',
  ' export default total;',
  '@@ -20,2 +20,3 @@ function tail',
  ' a',
  ' b',
  '+c',
  '',
].join('\n');

function diffOf(file: string | null, over: Partial<VerseCheckpointDiffResponse> = {}): VerseCheckpointDiffResponse {
  return {
    chatId: 'chat-1',
    turnId: 'turn-2',
    rootId: ROOT,
    mode: 'since',
    base: SHA,
    target: SHA,
    files: [
      { path: 'src/app.ts', oldPath: null, status: 'M', additions: 2, deletions: 1, binary: false, captured: true, editedAfterTurn: false, accepted: false },
      { path: 'README.md', oldPath: null, status: 'A', additions: 4, deletions: 0, binary: false, captured: true, editedAfterTurn: true, accepted: false },
    ],
    patch: file === 'src/app.ts'
      ? {
        path: 'src/app.ts',
        text: PATCH,
        truncated: false,
        binary: false,
        hunks: [
          { index: 0, hash: '0123456789abcdef0123', header: '@@ -1,3 +1,3 @@', accepted: false },
          { index: 1, hash: 'fedcba9876543210fedc', header: '@@ -20,2 +20,3 @@ function tail', accepted: false },
        ],
      }
      : file === 'README.md'
        ? { path: 'README.md', text: 'diff --git a/README.md b/README.md\n--- /dev/null\n+++ b/README.md\n@@ -0,0 +1,1 @@\n+hello\n', truncated: false, binary: false, hunks: [{ index: 0, hash: '11112222333344445555', header: '@@ -0,0 +1,1 @@', accepted: false }] }
        : null,
    actionable: true,
    ...over,
  };
}

const PREVIEW: VerseCheckpointPreviewResponse = {
  previewId: 'feedface00',
  kind: 'undo',
  chatId: 'chat-1',
  turnId: 'turn-2',
  expiresAt: '2026-09-27T10:15:00.000Z',
  roots: [{
    rootId: ROOT,
    apply: [{ path: 'src/app.ts', action: 'restore' }],
    conflicts: [{
      path: 'README.md',
      action: 'delete',
      kind: 'edited-after',
      merge: { clean: false, text: null, conflicts: 1 },
      diff: '--- a/README.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-hello\n',
    }],
    kept: ['notes.txt'],
    uncaptured: [],
    unavailable: null,
  }],
};

function fakeClient(over: Partial<CheckpointClient> = {}): CheckpointClient & { [K in keyof CheckpointClient]: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => listOf()),
    diff: vi.fn(async (q: { file?: string | null; mode: string }) => diffOf(q.file ?? null, { mode: q.mode as 'since' | 'turn', actionable: q.mode === 'since' })),
    review: vi.fn(async (input: { decision: 'accept' | 'reject' }) => ({ ok: true as const, decision: input.decision, changed: [] })),
    previewUndo: vi.fn(async () => PREVIEW),
    previewRedo: vi.fn(async () => ({ ...PREVIEW, kind: 'redo' as const, roots: [{ ...PREVIEW.roots[0]!, conflicts: [] }] })),
    apply: vi.fn(async () => ({ ok: true as const, kind: 'undo' as const, turnId: 'turn-2', roots: [{ rootId: ROOT, written: ['src/app.ts'], deleted: [], merged: [], kept: ['README.md'] }], redo: { turnId: 'turn-2', at: '' } })),
    ...over,
  } as never;
}

beforeEach(() => {
  setMutationToken('test-token');
});

afterEach(() => {
  clearMutationToken();
});

describe('ChangesPanel', () => {
  it('lists the turn’s files grouped by folder and shows a highlighted, word-level patch', async () => {
    const client = fakeClient();
    render(<ChangesPanel sessionId="chat-1" client={client} />);
    const list = await screen.findByRole('listbox', { name: 'Changed files' });
    expect(within(list).getAllByRole('option').map((o) => o.getAttribute('data-path'))).toEqual(['README.md', 'src/app.ts']);
    expect(within(list).getByText('edited')).toBeInTheDocument();
    // First file selected; pick the source file.
    await userEvent.click(within(list).getByRole('option', { name: /src\/app\.ts/ }));
    const table = await screen.findByRole('table', { name: 'Changes in src/app.ts' });
    const emphasised = [...table.querySelectorAll('[data-em="true"]')].map((n) => n.textContent);
    expect(emphasised).toEqual(expect.arrayContaining(['count', 'counts', '1', '2']));
    expect(document.querySelector('p[aria-live="polite"]')?.textContent).toMatch(/^2 files · \+6 −1 since before turn 2/);
    expect(client.diff).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-1', turnId: 'turn-2', rootId: ROOT, mode: 'since' }), expect.anything());
  });

  it('rejects one hunk with its hash, and accepts another', async () => {
    const client = fakeClient();
    render(<ChangesPanel sessionId="chat-1" client={client} />);
    await userEvent.click(await screen.findByRole('option', { name: /src\/app\.ts/ }));
    await screen.findByRole('table', { name: 'Changes in src/app.ts' });
    await userEvent.click(screen.getByRole('button', { name: /Reject the change at Line 20/ }));
    await waitFor(() => expect(client.review).toHaveBeenCalledWith({ chatId: 'chat-1', turnId: 'turn-2', rootId: ROOT, file: 'src/app.ts', hunk: 'fedcba9876543210fedc', decision: 'reject' }));
    await screen.findByText(/Restored the change in src\/app\.ts/);
    await userEvent.click(screen.getByRole('button', { name: /Accept the change at Line 1 in/ }));
    await waitFor(() => expect(client.review).toHaveBeenLastCalledWith(expect.objectContaining({ hunk: '0123456789abcdef0123', decision: 'accept' })));
  });

  it('asks a second click before rejecting a whole file', async () => {
    const client = fakeClient();
    render(<ChangesPanel sessionId="chat-1" client={client} />);
    const reject = await screen.findByRole('button', { name: 'Reject README.md (restore it from the checkpoint)' });
    await userEvent.click(reject);
    expect(client.review).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm: restore README.md from the checkpoint' }));
    await waitFor(() => expect(client.review).toHaveBeenCalledWith(expect.objectContaining({ file: 'README.md', decision: 'reject' })));
    expect(client.review.mock.calls[0]![0]).not.toHaveProperty('hunk');
  });

  it('"This turn" is the historical record: no accept/reject', async () => {
    const client = fakeClient();
    render(<ChangesPanel sessionId="chat-1" client={client} />);
    await screen.findByRole('listbox', { name: 'Changed files' });
    await userEvent.click(screen.getByRole('radio', { name: 'This turn' }));
    await waitFor(() => expect(client.diff).toHaveBeenCalledWith(expect.objectContaining({ mode: 'turn' }), expect.anything()));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Reject / })).toBeNull());
  });

  it('Undo opens a three-way preview; confirm waits for a decision on every conflict', async () => {
    const client = fakeClient();
    render(<ChangesPanel sessionId="chat-1" client={client} />);
    const undoButton = await screen.findByRole('button', { name: 'Undo turn…' });
    await waitFor(() => expect(undoButton).toBeEnabled());
    await userEvent.click(undoButton);
    const dialog = await screen.findByRole('dialog', { name: 'Undo turn 2' });
    expect(client.previewUndo).toHaveBeenCalledWith('chat-1', 'turn-2');
    expect(within(dialog).getByText(/Restores 1 file/)).toBeInTheDocument();
    expect(within(dialog).getByText(/changed again after the agent/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Leaves 1 file alone/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Undo turn 2' });
    expect(confirm).toBeDisabled();
    // Not mergeable: "Merge both" is off; keep the file.
    expect(within(dialog).getByRole('radio', { name: 'Merge both' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Keep current' }));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(client.apply).toHaveBeenCalledWith('chat-1', 'feedface00', { [ROOT]: { 'README.md': 'keep' } }));
    await screen.findByText(/Undid turn 2: 1 file restored/);
  });

  it('offers Redo after an undo', async () => {
    const client = fakeClient({ list: vi.fn(async () => listOf({ redo: { turnId: 'turn-2', at: '' }, turns: [turn(1), turn(2, { state: 'undone' })] })) } as never);
    render(<ChangesPanel sessionId="chat-1" client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Redo turn 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Redo turn 2' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(client.apply).toHaveBeenCalledWith('chat-1', 'feedface00', expect.any(Object)));
  });

  it('while a turn runs: says so, and every write is off', async () => {
    const client = fakeClient({ list: vi.fn(async () => listOf({ running: true, turns: [turn(1), turn(2, { state: 'running', endedAt: null })] })) } as never);
    const diff = vi.fn(async (q: { file?: string | null }) => diffOf(q.file ?? null, { actionable: false }));
    render(<ChangesPanel sessionId="chat-1" client={{ ...client, diff } as never} pollMs={60_000} />);
    await screen.findByText(/A turn is running/);
    expect(screen.getByRole('button', { name: 'Undo turn…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Commit…' })).toBeDisabled();
    await screen.findByRole('listbox', { name: 'Changed files' });
    expect(screen.queryByRole('button', { name: /^Reject / })).toBeNull();
  });

  it('Commit… uses the existing git flow for the turn’s repository', async () => {
    const client = fakeClient();
    const git = {
      status: vi.fn(async () => gitStatus({ root: '~/code/repo', dirty: 2 })),
      commit: vi.fn(async () => ({ ok: true as const, status: gitStatus({ root: '~/code/repo', dirty: 0 }), pr: null })),
      openPr: vi.fn(),
    };
    render(<ChangesPanel sessionId="chat-1" client={client} git={git as never} />);
    const commit = await screen.findByRole('button', { name: 'Commit…' });
    await waitFor(() => expect(commit).toBeEnabled());
    await userEvent.click(commit);
    expect(git.status).toHaveBeenCalledWith('~/code/repo');
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Message' }), 'Apply the agent’s change');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(git.commit).toHaveBeenCalledWith({ root: '~/code/repo', message: 'Apply the agent’s change' }));
  });

  it('empty and error states', async () => {
    const empty = fakeClient({ list: vi.fn(async () => listOf({ turns: [] })) } as never);
    const { unmount } = render(<ChangesPanel sessionId="chat-1" client={empty} />);
    await screen.findByText('No checkpoints yet');
    unmount();
    const failing = fakeClient({ list: vi.fn(async () => { throw Object.assign(new Error('x'), { status: 500, detail: 'Boom.' }); }) } as never);
    render(<ChangesPanel sessionId="chat-1" client={failing} />);
    await screen.findByText('Boom.');
  });

  it('a turn with no checkpoint says why', async () => {
    const client = fakeClient({
      list: vi.fn(async () => listOf({ turns: [turn(1, { roots: [{ rootId: ROOT, pre: { commit: null, error: 'More than 20,000 files changed; this working tree is too large to checkpoint.', skipped: 0, at: '', ms: 1 }, post: null }] })] })),
    } as never);
    render(<ChangesPanel sessionId="chat-1" client={client} />);
    await screen.findByText(/too large to checkpoint/);
    expect(screen.getByRole('button', { name: 'Undo turn…' })).toBeDisabled();
  });

  it('fetches nothing while hidden', () => {
    const client = fakeClient();
    render(<ChangesPanel sessionId="chat-1" client={client} visible={false} />);
    expect(client.list).not.toHaveBeenCalled();
  });
});

describe('changes pane adapter', () => {
  it('describes itself for a pane registry and handles "no chat"', () => {
    expect(CHANGES_PANE).toMatchObject({ id: 'changes', title: 'Changes' });
    render(<ChangesPaneAdapter sessionId={null} visible />);
    expect(screen.getByText('No chat open')).toBeInTheDocument();
  });
});

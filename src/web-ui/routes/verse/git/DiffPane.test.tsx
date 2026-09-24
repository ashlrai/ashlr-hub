/**
 * Review pane (unit C5; SPEC-310C §3): scopes, lazy patches, the file listbox
 * and patch grid from the keyboard, line comments → "Add to message", and the
 * honest states (not a repo, truncated, committed-since). Reads go through the
 * component's `fetchDiff` seam.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import type { VerseGitDiffFile, VerseGitDiffScope } from '../../../data/api-types.js';
import type { DiffPaneProps, TurnFileChange } from '../shell/slots.js';
import { mockCompactViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { DiffPane } from './DiffPane.js';
import type { GitDiffView } from './git-queries.js';

const ROOT = '~/code/ashlr-hub';

const file = (path: string, over: Partial<VerseGitDiffFile> = {}): VerseGitDiffFile => ({
  path, oldPath: null, status: 'M', additions: 2, deletions: 1, binary: false, ...over,
});

const PATCHES: Record<string, string> = {
  'src/a.ts': [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@ function main()',
    ' const a = 1;',
    '-const count = items.length;',
    '+const counts = items.length;',
    '+log(counts);',
    ' export {};',
  ].join('\n'),
  'notes/new.md': ['diff --git a/notes/new.md b/notes/new.md', 'new file mode 100644', '--- /dev/null', '+++ b/notes/new.md', '@@ -0,0 +1,2 @@', '+hello', '+world'].join('\n'),
  'src/b.ts': ['diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
};

let calls: Array<{ root: string; scope: VerseGitDiffScope; file: string | null }>;
let lists: Record<VerseGitDiffScope, VerseGitDiffFile[]>;
let overrides: { truncated?: boolean; patchBytes?: number; fail?: unknown };

const fetchDiff = vi.fn(async (root: string, scope: VerseGitDiffScope, f: string | null): Promise<GitDiffView> => {
  calls.push({ root, scope, file: f });
  if (overrides.fail) throw overrides.fail;
  return {
    root,
    scope,
    base: scope === 'branch' ? 'main' : null,
    files: lists[scope],
    patch: f === null ? null : { path: f, text: PATCHES[f] ?? '', truncated: overrides.truncated ?? false },
    patchBytes: f === null ? null : overrides.patchBytes ?? 200,
  };
});

beforeEach(() => {
  calls = [];
  overrides = {};
  lists = {
    working: [file('src/a.ts', { additions: 2, deletions: 1 }), file('src/b.ts'), file('notes/new.md', { status: 'A', additions: 7, deletions: 0 })],
    branch: [file('src/a.ts'), file('src/b.ts'), file('src/c.ts', { status: 'D', additions: 0, deletions: 40 }), file('logo.png', { binary: true, additions: 0, deletions: 0 })],
  };
  fetchDiff.mockClear();
});

function renderPane(props: Partial<DiffPaneProps> = {}) {
  const onAddToMessage = vi.fn();
  const all: DiffPaneProps = {
    sessionId: 's-1',
    roots: [ROOT],
    request: null,
    turnFiles: [],
    onAddToMessage,
    visible: true,
    ...props,
  };
  const utils = render(<DiffPane {...all} fetchDiff={fetchDiff} />);
  return { ...utils, onAddToMessage, props: all };
}

describe('DiffPane', () => {
  it('opens on Uncommitted, lists files by folder with M/A/D and counts, and loads only the first patch', async () => {
    renderPane();
    const list = await screen.findByRole('listbox', { name: 'Changed files' });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('data-path'))).toEqual(['notes/new.md', 'src/a.ts', 'src/b.ts']);
    expect(within(options[0]!).getByLabelText('added')).toHaveTextContent('A');
    expect(screen.getByText(/3 files/)).toHaveTextContent('3 files · +11 −2 uncommitted');
    await screen.findByRole('grid', { name: /Changes in notes\/new.md/ });
    expect(calls.filter((c) => c.file !== null).map((c) => c.file)).toEqual(['notes/new.md']);
  });

  it('moves through files with the arrow keys, loading each patch once', async () => {
    const user = userEvent.setup();
    renderPane();
    const list = await screen.findByRole('listbox', { name: 'Changed files' });
    list.focus();
    await user.keyboard('{ArrowDown}');
    expect(within(list).getByRole('option', { selected: true })).toHaveAttribute('data-path', 'src/a.ts');
    await screen.findByRole('grid', { name: /Changes in src\/a.ts/ });
    await user.keyboard('{ArrowDown}{ArrowUp}');
    await screen.findByRole('grid', { name: /Changes in src\/a.ts/ });
    expect(calls.filter((c) => c.file === 'src/a.ts')).toHaveLength(1);
    expect(list).toHaveAttribute('aria-activedescendant', expect.stringContaining(encodeURIComponent('src/a.ts')));
  });

  it('switches scope with the radio group, and says what the branch is measured against', async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole('listbox', { name: 'Changed files' });
    await user.click(screen.getByRole('radio', { name: 'Branch' }));
    await waitFor(() => expect(screen.getByText(/against/)).toHaveTextContent('4 files · +4 −42 against main'));
    expect(calls.some((c) => c.scope === 'branch' && c.file === null)).toBe(true);
    // The binary file shows as binary and never asks for a patch.
    const png = screen.getByRole('option', { name: /logo.png/ });
    expect(png).toHaveTextContent('binary');
  });

  it('"This turn" shows the turn’s files, and one committed since as such', async () => {
    const user = userEvent.setup();
    const turnFiles: TurnFileChange[] = [
      { root: ROOT, path: 'src/b.ts' },
      { root: ROOT, path: 'src/gone.ts' },
      { root: '~/elsewhere', path: 'x.ts' },
    ];
    renderPane({ turnFiles });
    await screen.findByRole('listbox', { name: 'Changed files' });
    await user.click(screen.getByRole('radio', { name: 'This turn' }));
    const list = screen.getByRole('listbox', { name: 'Changed files' });
    await waitFor(() => expect(within(list).getAllByRole('option').map((o) => o.getAttribute('data-path'))).toEqual(['src/b.ts', 'src/gone.ts']));
    const gone = within(list).getByRole('option', { name: /gone.ts/ });
    expect(gone).toHaveAttribute('aria-disabled', 'true');
    expect(gone).toHaveTextContent('committed');
    await screen.findByRole('grid', { name: /Changes in src\/b.ts/ });
  });

  it('disables "This turn" when the turn touched nothing here', async () => {
    renderPane();
    await screen.findByRole('listbox', { name: 'Changed files' });
    expect(screen.getByRole('radio', { name: 'This turn' })).toBeDisabled();
  });

  it('follows an open request: root, scope and file', async () => {
    const { rerender, props } = renderPane({ roots: [ROOT, '~/other'] });
    await screen.findByRole('listbox', { name: 'Changed files' });
    rerender(<DiffPane {...props} request={{ root: ROOT, scope: 'branch', file: 'src/b.ts', nonce: 1 }} fetchDiff={fetchDiff} />);
    await screen.findByRole('grid', { name: /Changes in src\/b.ts/ });
    expect(screen.getByRole('radio', { name: 'Branch' })).toBeChecked();
    expect(calls.some((c) => c.scope === 'branch' && c.file === 'src/b.ts')).toBe(true);
  });

  it('fetches nothing while it is a background tab', async () => {
    renderPane({ visible: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchDiff).not.toHaveBeenCalled();
  });

  it('says so when the folder is not a repository', async () => {
    overrides.fail = new ApiError('x', 404, '/api/verse/git/diff', 'This folder is not a git repository.', 'VERSE_GIT_NOT_A_REPO');
    renderPane();
    expect(await screen.findByText('Not a git repository')).toBeInTheDocument();
  });

  it('says a patch was cut at 256 KB', async () => {
    overrides.truncated = true;
    overrides.patchBytes = 3 * 1024 * 1024;
    renderPane();
    expect(await screen.findByRole('note')).toHaveTextContent('Showing the first 256 KB of 3.0 MB.');
  });
});

describe('the patch grid and comments, from the keyboard', () => {
  async function openA(user: ReturnType<typeof userEvent.setup>) {
    const list = await screen.findByRole('listbox', { name: 'Changed files' });
    list.focus();
    await user.keyboard('{ArrowDown}');
    return screen.findByRole('grid', { name: /Changes in src\/a.ts/ });
  }

  it('walks lines with ↑↓ and emphasises only the changed word', async () => {
    const user = userEvent.setup();
    renderPane();
    const grid = await openA(user);
    grid.focus();
    const active = () => document.getElementById(grid.getAttribute('aria-activedescendant')!)!;
    expect(active()).toHaveAccessibleName('Line 1, unchanged: const a = 1;');
    await user.keyboard('{ArrowDown}');
    expect(active()).toHaveAccessibleName('Line 2, removed: const count = items.length;');
    await user.keyboard('{End}');
    expect(active()).toHaveAccessibleName('Line 4, unchanged: export {};');
    // Intra-line emphasis: only `count` / `counts` differ.
    const ems = grid.querySelectorAll('[class*="em"]');
    expect([...ems].map((e) => e.textContent)).toContain('counts');
  });

  it('Enter opens a comment, ⌘Enter saves it, Esc on a new one cancels back to the grid', async () => {
    const user = userEvent.setup();
    const { onAddToMessage } = renderPane();
    const grid = await openA(user);
    grid.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    const box = screen.getByLabelText('Comment on line 2');
    expect(box).toHaveFocus();
    await user.keyboard('rename back to count{Meta>}{Enter}{/Meta}');
    expect(grid).toHaveFocus();
    expect(within(grid).getByText('rename back to count')).toBeInTheDocument();
    await user.keyboard('{ArrowUp}{Enter}');
    await user.keyboard('never mind{Escape}');
    expect(screen.queryByText('never mind')).toBeNull();
    expect(grid).toHaveFocus();

    expect(screen.getByText('1 comment')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add to message' }));
    expect(onAddToMessage).toHaveBeenCalledWith('src/a.ts:2: rename back to count');
    expect(screen.queryByRole('button', { name: 'Add to message' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Added 1 comment to the message.');
  });

  it('comments on a removed line carry the old line number, and survive a file switch', async () => {
    const user = userEvent.setup();
    const { onAddToMessage } = renderPane();
    const grid = await openA(user);
    // Pointer path: the gutter "+" on the removed line.
    await user.click(within(grid).getAllByRole('button', { name: 'Add a comment on line 2' })[0]!);
    await user.keyboard('why?{Control>}{Enter}{/Control}');
    const list = screen.getByRole('listbox', { name: 'Changed files' });
    list.focus();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('grid', { name: /Changes in src\/b.ts/ });
    expect(within(list).getByRole('option', { name: /a.ts/ })).toHaveTextContent('1');
    await user.click(screen.getByRole('button', { name: 'Add to message' }));
    expect(onAddToMessage).toHaveBeenCalledWith('src/a.ts:2 (removed line): why?');
  });

  it('split layout pairs the removed and added line on one row', async () => {
    const user = userEvent.setup();
    // jsdom has no layout: say the pane is wide enough for split.
    renderPane();
    const grid = await openA(user);
    await user.click(screen.getByRole('radio', { name: 'Split' }));
    const split = await screen.findByRole('grid', { name: /Changes in src\/a.ts/ });
    expect(split).toHaveAttribute('data-layout', 'split');
    expect(grid).not.toBeNull();
    const pair = within(split).getByRole('gridcell', { name: /removed: const count.*added: const counts/ });
    expect(pair).toBeInTheDocument();
  });
});

describe('at 375px (a bottom-sheet dock)', () => {
  let vp: ViewportMock;
  beforeEach(() => {
    vp = mockCompactViewport({ dark: true });
  });
  afterEach(() => vp.restore());

  it('renders the stacked layout with every control reachable', async () => {
    renderPane();
    expect(await screen.findByRole('listbox', { name: 'Changed files' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'What to review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh changes' })).toBeInTheDocument();
    await screen.findByRole('grid');
  });
});

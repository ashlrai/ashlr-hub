/**
 * Branch bar (unit C5; SPEC-310C §2): RTL + user-event, keyboard first.
 * Status reads go through the component's test seam; writes go through a
 * stubbed `fetch`, so the real client, token gate and error mapping run.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { mockCompactViewport, mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { resetCommandBus, runCommand, runCommandWhenReady } from '../shell/command-bus.js';
import { BranchBar } from './BranchBar.js';
import { pr, status } from './git-fixtures.test-support.js';
import type { GitStatusView } from './git-model.js';
import type { DiffPaneRequest } from '../shell/slots.js';

const TOKEN = 'a'.repeat(64);
const ROOT = '~/code/ashlr-hub';

let vp: ViewportMock;
let posts: Array<{ url: string; body: Record<string, unknown> }>;
let postReply: (url: string, body: Record<string, unknown>) => { status: number; json: unknown };

beforeEach(() => {
  vp = mockWideViewport();
  posts = [];
  postReply = (_url, body) => ({ status: 200, json: { ok: true, status: status({ suggested: 'push', dirty: 0, ahead: 1 }), pr: null, echo: body } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    posts.push({ url, body });
    const reply = postReply(url, body);
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }));
  setMutationToken(TOKEN);
});

afterEach(() => {
  // Undo setVisibility's own-property override (jsdom's getter lives on the prototype).
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  resetCommandBus();
  vp.restore();
  vi.unstubAllGlobals();
  clearMutationToken();
});

/** Flip document visibility; hidden → visible makes usePollWhileVisible re-read now (the poll's "refresh on show"). */
function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function renderBar(statuses: GitStatusView[] | ((root: string) => GitStatusView), extra: { roots?: string[] } = {}) {
  const onOpenDiff = vi.fn<(request: DiffPaneRequest) => void>();
  const fetchStatus = vi.fn(async (root: string) => (typeof statuses === 'function' ? statuses(root) : statuses.find((s) => s.root === root) ?? statuses[0]!));
  const utils = render(
    <BranchBar sessionId="s-1" roots={extra.roots ?? [ROOT]} onOpenDiff={onOpenDiff} statusOptions={{ fetchStatus }} />,
  );
  return { ...utils, onOpenDiff, fetchStatus };
}

describe('BranchBar', () => {
  it('renders nothing when no root has changes', async () => {
    const { container, fetchStatus } = renderBar([status({ diffstat: { files: 0, additions: 0, deletions: 0 }, suggested: 'none' })]);
    await waitFor(() => expect(fetchStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows repo, branch, ± counts and the suggested action', async () => {
    renderBar([status({ suggested: 'create-pr' })]);
    const row = await screen.findByRole('listitem', { name: 'ashlr-hub, branch feat/branch-bar' });
    expect(within(row).getByText('ashlr-hub')).toBeInTheDocument();
    expect(within(row).getByText('feat/branch-bar')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /12 files changed, 35,079 added, 1,074 removed/ })).toHaveTextContent('+35,079−1,074');
    const primary = within(row).getByRole('button', { name: 'Create PR' });
    expect(primary).toHaveAccessibleDescription('Open a pull request from feat/branch-bar into main.');
  });

  it('opens the branch diff from the ± counts', async () => {
    const { onOpenDiff } = renderBar([status()]);
    await userEvent.click(await screen.findByRole('button', { name: /files changed/ }));
    expect(onOpenDiff).toHaveBeenCalledWith({ root: ROOT, scope: 'branch' });
  });

  it('shows a PR chip with a word, and offers Merge only when the server suggests it', async () => {
    renderBar([status({ suggested: 'merge', pr: pr(), prCheckCounts: { total: 9, passed: 9, failed: 0, pending: 0 } })]);
    const chip = await screen.findByRole('link', { name: /Pull request #463/ });
    expect(chip).toHaveAttribute('href', 'https://github.com/ashlrai/ashlr-hub/pull/463');
    expect(chip).toHaveTextContent('Open');
    expect(chip).toHaveTextContent('9/9 checks passed');
    expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument();
  });

  it('says it is checking GitHub instead of guessing', async () => {
    renderBar([status({ suggested: 'none', prLookup: 'pending' })]);
    expect(await screen.findByText('Checking GitHub…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
  });

  it('one row per repository with changes, the rest behind "Show N more"', async () => {
    const rows = [
      status({ root: '~/a', gitRoot: '~/a', name: 'alpha' }),
      status({ root: '~/a/web', gitRoot: '~/a', name: 'alpha' }),
      status({ root: '~/b', gitRoot: '~/b', name: 'beta' }),
      status({ root: '~/c', gitRoot: '~/c', name: 'gamma', diffstat: { files: 0, additions: 0, deletions: 0 }, suggested: 'none' }),
    ];
    renderBar((root) => rows.find((r) => r.root === root)!, { roots: ['~/a', '~/a/web', '~/b', '~/c'] });
    await screen.findByText('alpha');
    expect(screen.queryByText('beta')).toBeNull();
    const more = screen.getByRole('button', { name: 'Show 1 more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getAllByText('alpha')).toHaveLength(1);
    expect(screen.queryByText('gamma')).toBeNull();
  });
});

describe('the ▾ menu, from the keyboard', () => {
  it('opens on ArrowDown, skips disabled items, shows their reasons, and Escape returns focus', async () => {
    const user = userEvent.setup();
    renderBar([status()]);
    const menuButton = await screen.findByRole('button', { name: 'More git actions for ashlr-hub' });
    menuButton.focus();
    await user.keyboard('{ArrowDown}');
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Create draft PR…',
      'Commit…Nothing to commit',
      'PushAlready pushed',
      'Open on GitHubNo pull request for this branch',
      'Copy branch name',
      'Review changes',
    ]);
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    // Commit, Push and Open on GitHub are disabled: focus jumps to Copy.
    expect(items[4]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items[5]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(menuButton).toHaveFocus();
  });

  it('runs an item with Enter: Review changes opens the diff', async () => {
    const user = userEvent.setup();
    const { onOpenDiff } = renderBar([status()]);
    (await screen.findByRole('button', { name: 'More git actions for ashlr-hub' })).focus();
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onOpenDiff).toHaveBeenCalledWith({ root: ROOT, scope: 'branch' });
  });

  it('copies the branch name', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderBar([status()]);
    await user.click(await screen.findByRole('button', { name: 'More git actions for ashlr-hub' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy branch name' }));
    expect(writeText).toHaveBeenCalledWith('feat/branch-bar');
    expect(await screen.findByText('Copied feat/branch-bar.')).toBeInTheDocument();
  });
});

describe('actions', () => {
  it('commits from the keyboard: primary → message → ⌘Enter, then the answered status replaces the row', async () => {
    const user = userEvent.setup();
    renderBar([status({ suggested: 'commit', dirty: 3 })]);
    await user.click(await screen.findByRole('button', { name: 'Commit' }));
    const dialog = screen.getByRole('dialog', { name: 'Commit changes' });
    expect(within(dialog).getByText(/3 changed files in/)).toBeInTheDocument();
    await user.keyboard('feat: the branch bar');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/verse/git/commit', body: { root: ROOT, message: 'feat: the branch bar' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Push' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Committed on feat/branch-bar.');
  });

  it('keeps a refusal inside the dialog, in the server’s words', async () => {
    const user = userEvent.setup();
    postReply = () => ({ status: 409, json: { code: 'VERSE_GIT_REFUSED', error: 'Git does not know your name and email yet.' } });
    renderBar([status({ suggested: 'commit', dirty: 1 })]);
    await user.click(await screen.findByRole('button', { name: 'Commit' }));
    await user.keyboard('x{Meta>}{Enter}{/Meta}');
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Git does not know your name and email yet.');
  });

  it('opens a PR with the disclosure, the default title and the chosen base', async () => {
    const user = userEvent.setup();
    postReply = () => ({ status: 200, json: { ok: true, status: status({ suggested: 'view-pr', pr: pr({ number: 464 }) }), pr: pr({ number: 464 }) } });
    renderBar([status({ suggested: 'create-pr', upstream: null, dirty: 2 })]);
    await user.click(await screen.findByRole('button', { name: 'Create PR' }));
    const dialog = screen.getByRole('dialog', { name: 'Create pull request' });
    expect(within(dialog).getByText(/Pushes/)).toHaveTextContent('Pushes feat/branch-bar to origin first.');
    expect(within(dialog).getByText(/uncommitted changes are not in the PR/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Title')).toHaveValue('feat: branch bar above the composer');
    await user.click(within(dialog).getByLabelText('Draft'));
    await user.click(within(dialog).getByRole('button', { name: 'Create draft PR' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/verse/git/pr');
    expect(posts[0]!.body).toEqual({ root: ROOT, title: 'feat: branch bar above the composer', base: 'main', draft: true });
    expect(await screen.findByText('Opened #464.')).toBeInTheDocument();
  });

  it('merges only the head it showed: the PR’s own SHA goes to the server', async () => {
    const user = userEvent.setup();
    const head = 'c'.repeat(40);
    postReply = () => ({ status: 200, json: { ok: true, status: status({ suggested: 'view-pr', pr: pr({ state: 'merged', headSha: head }) }), pr: pr({ state: 'merged', headSha: head }) } });
    renderBar([status({ suggested: 'merge', pr: pr({ headSha: head }), headSha: 'd'.repeat(40), prCheckCounts: { total: 4, passed: 4, failed: 0, pending: 0 } })]);
    await user.click(await screen.findByRole('button', { name: 'Merge' }));
    const dialog = screen.getByRole('dialog', { name: 'Merge #463?' });
    expect(within(dialog).getByText(/4\/4 checks passed/)).toBeInTheDocument();
    expect(within(dialog).getByText('ccccccc')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Merge #463' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/verse/git/pr/merge', body: { root: ROOT, number: 463, headSha: head } });
    expect(await screen.findByText('Merged #463 into main.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Merged/ })).toHaveTextContent('Merged ✓');
  });

  // Review 3.10 c16: the dialog used to follow the 10 s poll, so a head that
  // landed while it was open was shown as "checks passed, no conflicts" and
  // its SHA — not the one confirmed — went to the server.
  it('pins the head it opened on: a new head from the poll disables Merge and is never sent', async () => {
    const user = userEvent.setup();
    const confirmed = 'c'.repeat(40);
    let current = status({ suggested: 'merge', pr: pr({ headSha: confirmed }), prCheckCounts: { total: 9, passed: 9, failed: 0, pending: 0 } });
    const { fetchStatus } = renderBar(() => current);
    await user.click(await screen.findByRole('button', { name: 'Merge' }));
    const dialog = screen.getByRole('dialog', { name: 'Merge #463?' });
    expect(within(dialog).getByText('ccccccc')).toBeInTheDocument();

    // An agent pushes: the next poll reports a new head with checks pending.
    current = status({ suggested: 'view-pr', pr: pr({ headSha: 'e'.repeat(40), checks: 'pending', mergeable: null }), prCheckCounts: { total: 0, passed: 0, failed: 0, pending: 0 } });
    const reads = fetchStatus.mock.calls.length;
    await act(async () => { setVisibility('hidden'); });
    await act(async () => { setVisibility('visible'); });
    await waitFor(() => expect(fetchStatus.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(within(dialog).getByText(/The PR changed since you opened this/)).toBeInTheDocument());
    // Still the confirmed head, never the new one, and Merge is off.
    expect(within(dialog).getByText('ccccccc')).toBeInTheDocument();
    expect(within(dialog).queryByText('eeeeeee')).toBeNull();
    const merge = within(dialog).getByRole('button', { name: 'Merge #463' });
    expect(merge).toBeDisabled();
    await user.click(merge);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(posts).toEqual([]);
  });

  it('asks for the mutation token first, and does nothing if it is dismissed', async () => {
    const user = userEvent.setup();
    clearMutationToken();
    renderBar([status({ suggested: 'push', ahead: 2 })]);
    await user.click(await screen.findByRole('button', { name: 'Push' }));
    const unlock = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(unlock).toHaveTextContent('Push feat/branch-bar to origin/feat/branch-bar.');
    await user.keyboard('{Escape}');
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(posts).toEqual([]);
  });

  it('pushes in one click once unlocked, and says where it went', async () => {
    const user = userEvent.setup();
    postReply = () => ({ status: 200, json: { ok: true, status: status({ suggested: 'create-pr' }), pr: null } });
    renderBar([status({ suggested: 'push', ahead: 2 })]);
    await user.click(await screen.findByRole('button', { name: 'Push' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/verse/git/push', body: { root: ROOT } }]));
    expect(await screen.findByText('Pushed feat/branch-bar to origin/feat/branch-bar.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeInTheDocument();
  });

  it('a one-click failure goes to the bar’s alert line', async () => {
    const user = userEvent.setup();
    postReply = () => ({ status: 409, json: { code: 'VERSE_GIT_REFUSED', error: 'The remote has commits this branch does not. Pull or rebase first, then push again.' } });
    renderBar([status({ suggested: 'push', ahead: 1 })]);
    await user.click(await screen.findByRole('button', { name: 'Push' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pull or rebase first');
  });
});

describe('at 375px', () => {
  it('drops the PR title from the chip (it stays in the accessible name) and marks the compact layout', async () => {
    vp.restore();
    vp = mockCompactViewport({ dark: true });
    renderBar([status({ suggested: 'merge', pr: pr() })]);
    const chip = await screen.findByRole('link', { name: /Pull request #463, verse context orchestration/ });
    expect(chip).not.toHaveTextContent('verse context orchestration');
    expect(screen.getByRole('region', { name: 'Branches' })).toHaveAttribute('data-compact', 'true');
    expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument();
  });
});

// ⌘K "Create pull request…" / "Merge pull request…" (command-catalog.ts
// git.create-pr / git.merge-pr): without these handlers the palette entries
// switched to Chat and silently expired after the parked-command TTL.
describe('palette git commands', () => {
  it('Create pull request… opens the same dialog the row button opens', async () => {
    renderBar([status({ suggested: 'create-pr' })]);
    await screen.findByRole('button', { name: 'Create PR' });
    act(() => {
      expect(runCommand('git.create-pr', { via: 'palette' })).toBe(true);
    });
    expect(await screen.findByRole('dialog', { name: 'Create pull request' })).toBeInTheDocument();
    expect(posts).toHaveLength(0); // opening is not writing
  });

  it('Merge pull request… opens the merge dialog only where the server suggests merge', async () => {
    renderBar([status({ suggested: 'merge', pr: pr(), prCheckCounts: { total: 4, passed: 4, failed: 0, pending: 0 } })]);
    await screen.findByRole('button', { name: 'Merge' });
    act(() => {
      runCommand('git.merge-pr', { via: 'palette' });
    });
    expect(await screen.findByRole('dialog', { name: 'Merge #463?' })).toBeInTheDocument();
  });

  it('says why instead of declining when no row can merge', async () => {
    renderBar([status({ suggested: 'view-pr', pr: pr({ checks: 'failing' }) })]);
    await screen.findByRole('link', { name: /Pull request #463/ });
    act(() => {
      expect(runCommand('git.merge-pr', { via: 'palette' })).toBe(true);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent("#463 isn't ready to merge yet");
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives the menu’s reason when no row can open a PR', async () => {
    renderBar([status({ suggested: 'view-pr', pr: pr() })]);
    await screen.findByRole('link', { name: /Pull request #463/ });
    act(() => {
      runCommand('git.create-pr', { via: 'palette' });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't open a pull request: #463 is already open.");
  });

  it('a command parked before mount waits for the first status read', async () => {
    // From another surface the shell parks the command, then Chat mounts the
    // bar; the command is delivered on registration, before any status.
    let answer!: (s: GitStatusView) => void;
    const first = new Promise<GitStatusView>((resolve) => {
      answer = resolve;
    });
    expect(runCommandWhenReady('git.create-pr', { via: 'palette' })).toBe(false);
    render(<BranchBar sessionId="s-1" roots={[ROOT]} onOpenDiff={() => {}} statusOptions={{ fetchStatus: () => first }} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      answer(status({ suggested: 'create-pr' }));
      await first;
    });
    expect(await screen.findByRole('dialog', { name: 'Create pull request' })).toBeInTheDocument();
  });
});

describe('through the real C0 slots', () => {
  it('BranchBarSlot and DiffPaneSlot load these files by their contract names', async () => {
    const { BranchBarSlot, DiffPaneSlot, isSlotAvailable } = await import('../shell/slots.js');
    expect(isSlotAvailable('branch-bar')).toBe(true);
    expect(isSlotAvailable('diff-pane')).toBe(true);
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url);
      const body = url.startsWith('/api/verse/git/status')
        ? status({ suggested: 'create-pr' })
        : { root: ROOT, scope: 'working', base: null, files: [], patch: null, patchBytes: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    render(
      <>
        <BranchBarSlot sessionId="s-1" roots={[ROOT]} onOpenDiff={() => {}} />
        <DiffPaneSlot sessionId="s-1" roots={[ROOT]} request={null} turnFiles={[]} onAddToMessage={() => {}} visible />
      </>,
    );
    expect(await screen.findByRole('button', { name: 'Create PR' })).toBeInTheDocument();
    expect(await screen.findByText('No uncommitted changes.')).toBeInTheDocument();
    expect(seen).toContain(`/api/verse/git/status?root=${encodeURIComponent(ROOT)}`);
  });
});

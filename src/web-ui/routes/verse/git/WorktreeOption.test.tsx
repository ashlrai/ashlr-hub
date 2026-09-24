/**
 * "Isolate in worktree" (unit C5; SPEC-310C §2 Worktrees): the option C2's
 * New chat dialog mounts, and the folder a new chat starts in.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import {
  defaultWorktreeName,
  isValidWorktreeName,
  resolveChatFolder,
  slugifyWorktreeName,
  WorktreeOption,
  type WorktreeValue,
} from './WorktreeOption.js';

afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
});

function Harness({ initial }: { initial: WorktreeValue }) {
  const [value, setValue] = useState(initial);
  return <WorktreeOption repoName="ashlr-hub" value={value} onChange={setValue} />;
}

describe('names', () => {
  it('defaults to a readable, valid slug', () => {
    const name = defaultWorktreeName(new Date(2026, 8, 24, 14, 32));
    expect(name).toBe('chat-0924-1432');
    expect(isValidWorktreeName(name)).toBe(true);
  });

  it('turns typing into a slug', () => {
    expect(slugifyWorktreeName('Fix login!!')).toBe('fix-login-');
    expect(slugifyWorktreeName('--x')).toBe('x');
    expect(isValidWorktreeName('fix.lock')).toBe(false);
    expect(isValidWorktreeName('a..b')).toBe(false);
  });
});

describe('WorktreeOption', () => {
  it('is off by default and says what isolation means; on, it names the folder and branch', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ enabled: false, name: '' }} />);
    const box = screen.getByRole('checkbox', { name: 'Isolate in a worktree' });
    expect(box).toHaveAccessibleDescription(/its own branch in its own folder/);
    await user.keyboard('{Tab}{ }');
    expect(box).toBeChecked();
    const name = screen.getByRole('textbox', { name: 'Name' });
    expect(isValidWorktreeName((name as HTMLInputElement).value)).toBe(true);
    await user.clear(name);
    await user.type(name, 'Fix Login');
    expect(name).toHaveValue('fix-login');
    // (The accessible-name algorithm pads inline <code>, so match the words, not the spacing.)
    expect(box).toHaveAccessibleDescription(/Creates ~\/\.ashlr-worktrees\/ashlr-hub\/fix-login on a new branch verse\/fix-login\s*, from the current commit\. Uncommitted changes stay in ashlr-hub\./);
  });
});

describe('resolveChatFolder', () => {
  it('returns the project itself when isolation is off, without asking the server', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await resolveChatFolder('~/code/ashlr-hub', { enabled: false, name: 'x' })).toBe('~/code/ashlr-hub');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates the worktree and returns its folder', async () => {
    setMutationToken('a'.repeat(64));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ path: '~/.ashlr-worktrees/ashlr-hub/fix-login', branch: 'verse/fix-login' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await resolveChatFolder('~/code/ashlr-hub', { enabled: true, name: 'fix-login' })).toBe('~/.ashlr-worktrees/ashlr-hub/fix-login');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/verse/git/worktree');
    expect(JSON.parse(String(init.body))).toEqual({ root: '~/code/ashlr-hub', name: 'fix-login' });
  });
});

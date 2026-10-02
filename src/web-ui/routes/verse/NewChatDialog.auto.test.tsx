import type { ComponentProps } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseCreateSessionRequest } from '../../data/api-types.js';
import { bootstrap, CLAUDE_SEAT, LOCAL_SEAT } from './fixtures.test-support.js';
import { NewChatDialog } from './NewChatDialog.js';

const route = vi.hoisted(() => vi.fn());
const worktree = vi.hoisted(() => vi.fn());
vi.mock('./git/git-queries.js', () => ({ createGitWorktree: worktree }));
vi.mock('./multimodel/initial-auto-seat.js', () => ({ initialAutoSeat: route }));
vi.mock('./context/context-queries.js', () => ({
  fetchPreferences: async () => ({ version: 1, seats: {}, memory: { enabled: true, disabledProjects: [] } }),
  fetchContextFit: async () => ({ roots: [], totalEstTokens: 0, estimator: 'bytes/4', sampledAt: '' }),
  updatePreferences: vi.fn(),
}));
beforeEach(() => {
  route.mockReset().mockResolvedValue({ seatId: LOCAL_SEAT.id, model: 'qwen3-coder' });
});
function mount(onCreate = vi.fn(), extra: Partial<ComponentProps<typeof NewChatDialog>> = {}) {
  return { onCreate, ...render(<NewChatDialog open onClose={vi.fn()} projects={bootstrap().projects}
    seats={[CLAUDE_SEAT, LOCAL_SEAT]} onCreate={onCreate} {...extra} />) };
}
const PROMPT = 'Fix the navigation and explain the changes';

describe('Automatic first chat', () => {
  it('starts from prompt and project without showing or requiring resource selection, even with a remembered seat', async () => {
    const { onCreate } = mount(vi.fn(), { initialSeat: { seatId: CLAUDE_SEAT.id, model: CLAUDE_SEAT.models[0]!.id } });
    const user = userEvent.setup();
    expect(screen.queryByLabelText('Seat and model')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeDisabled();
    await user.type(screen.getByLabelText('What would you like to work on?'), PROMPT);
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledExactlyOnceWith(
      { projectPath: '/Users/mason/dev/hub', seatId: LOCAL_SEAT.id, model: 'qwen3-coder' }, PROMPT, { automatic: true }));
    expect(route.mock.calls[0]![0].roots).toEqual(['/Users/mason/dev/hub']);
  });
  it('respects an explicit manual choice and never asks the automatic adviser', async () => {
    const { onCreate } = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.selectOptions(screen.getByLabelText('Seat and model'), JSON.stringify([CLAUDE_SEAT.id, CLAUDE_SEAT.models[0]!.id]));
    await user.type(screen.getByLabelText('What would you like to work on?'), PROMPT);
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect((onCreate.mock.calls[0]![0] as VerseCreateSessionRequest).seatId).toBe(CLAUDE_SEAT.id);
    expect(onCreate.mock.calls[0]![2]).toEqual({ automatic: false });
    expect(route).not.toHaveBeenCalled();
  });
  it('uses every saved-workspace root without mixing workspaceId and projectPath', async () => {
    const workspace = { id: 'workspace-1', name: 'Product', roots: [{ path: '/repo', name: 'repo', primary: true }, { path: '/private', name: 'private', primary: false }], section: false, createdAt: '', updatedAt: '' };
    const { onCreate } = mount(vi.fn(), { workspaces: [workspace] });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Project'), within(screen.getByLabelText('Project')).getByRole('option', { name: /^Product/ }));
    await user.type(screen.getByLabelText('What would you like to work on?'), PROMPT);
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(route.mock.calls[0]![0].roots).toEqual(['/repo', '/private']);
    expect(onCreate.mock.calls[0]![0]).toEqual({ workspaceId: 'workspace-1', seatId: LOCAL_SEAT.id, model: 'qwen3-coder' });
  });
  it('disables repeat submits during selection, preserves the prompt on failure, and allows retry', async () => {
    let reject!: (error: Error) => void;
    route.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const { onCreate } = mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('What would you like to work on?'), PROMPT);
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(screen.getByRole('button', { name: 'Choosing resource…' })).toBeDisabled();
    expect(screen.getByLabelText('Project')).toBeDisabled();
    act(() => reject(new Error('Privacy read failed')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Privacy read failed');
    expect(screen.getByLabelText('What would you like to work on?')).toHaveValue(PROMPT);
    expect(onCreate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  });
  it('does not start a chat after the dialog is closed while selection is pending', async () => {
    let resolve!: (choice: { seatId: string; model: string }) => void;
    route.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { onCreate, rerender } = mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('What would you like to work on?'), PROMPT);
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    rerender(<NewChatDialog open={false} onClose={vi.fn()} projects={bootstrap().projects} seats={[CLAUDE_SEAT, LOCAL_SEAT]} onCreate={onCreate} />);
    await act(async () => resolve({ seatId: LOCAL_SEAT.id, model: 'qwen3-coder' }));
    expect(onCreate).not.toHaveBeenCalled();
  });
  it('does not create a chat after closing during worktree creation', async () => {
    let resolve!: (result: { path: string; branch: string }) => void;
    worktree.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { onCreate, rerender } = mount(vi.fn(), { initialManual: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Isolate in a worktree' }));
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(worktree).toHaveBeenCalledTimes(1));
    rerender(<NewChatDialog open={false} onClose={vi.fn()} projects={bootstrap().projects} seats={[CLAUDE_SEAT, LOCAL_SEAT]} onCreate={onCreate} />);
    await act(async () => resolve({ path: '/worktree', branch: 'verse/test' }));
    expect(onCreate).not.toHaveBeenCalled();
  });

});

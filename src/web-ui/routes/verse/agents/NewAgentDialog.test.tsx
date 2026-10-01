import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLAUDE_SEAT } from '../context/context-fixtures.test-support.js';
import { NewAgentDialog } from './NewAgentDialog.js';
import type { SpawnInput } from './agents-queries.js';

vi.mock('./agents-queries.js', () => ({
  fetchWorkspaceConfig: vi.fn().mockResolvedValue({
    source: 'defaults', warnings: [], config: { setup: null, run: [], copy: [], ports: 10 },
  }),
}));
afterEach(cleanup);

function show(multi = false) {
  const onSpawn = vi.fn<(inputs: SpawnInput[]) => void>();
  const seats = Array.from({ length: multi ? 8 : 1 }, (_, i) => ({ ...CLAUDE_SEAT, id: `seat-${i}`, accountId: `account-${i}`, label: `Account ${i + 1}` }));
  const view = render(<NewAgentDialog open multi={multi} projects={[{ path: '/repo', name: 'Repo', enrolled: true }]}
    seats={seats} initialRoot="/repo" busy={false} error={null} onClose={vi.fn()} onSpawn={onSpawn} />);
  // Dialog renders into its own portal, outside the React render container.
  return { ...view, container: screen.getByRole('dialog'), onSpawn };
}

describe('focused agent creation', () => {
  it('starts with the existing options unchanged and optional controls collapsed', async () => {
    const { container, onSpawn } = show();
    await waitFor(() => expect(screen.getByLabelText('What should it do?')).toHaveFocus());
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    fireEvent.change(screen.getByLabelText('What should it do?'), { target: { value: 'Fix login and verify it.' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(onSpawn).toHaveBeenCalledWith([expect.objectContaining({
      root: '/repo', prompt: 'Fix login and verify it.', isolate: true, planFirst: false,
      autoFix: false, autoMerge: false, spendCapUsd: null,
    })]);
  });

  it('retains explicitly selected optional settings when the disclosure closes', async () => {
    const { container, onSpawn } = show();
    const user = userEvent.setup();
    const disclosure = container.querySelector('summary')!;
    await user.click(disclosure);
    const options = container.querySelector('details')!;
    await user.click(within(options).getByRole('switch', { name: 'Auto-fix CI' }));
    fireEvent.change(screen.getByLabelText('Spend cap (USD, at API list price)'), { target: { value: '7.50' } });
    await user.click(disclosure);
    fireEvent.change(screen.getByLabelText('What should it do?'), { target: { value: 'Fix login.' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(onSpawn).toHaveBeenCalledWith([expect.objectContaining({ autoFix: true, spendCapUsd: 7.5, isolate: true })]);
  });

  it('lets every selected available seat run in its own workspace beyond the former six-seat limit', async () => {
    const { container, onSpawn } = show(true);
    const user = userEvent.setup();
    for (const box of screen.getAllByRole('checkbox')) if (!(box as HTMLInputElement).checked) await user.click(box);
    fireEvent.change(screen.getByLabelText('What should they do?'), { target: { value: 'Review the parser and test it.' } });
    fireEvent.submit(container.querySelector('form')!);
    const inputs = onSpawn.mock.calls[0]?.[0];
    expect(inputs).toHaveLength(8);
    expect(new Set(inputs?.map((input) => input.seatId)).size).toBe(8);
    expect(inputs?.every((input) => input.isolate && !input.planFirst && !input.autoMerge)).toBe(true);
  });
});

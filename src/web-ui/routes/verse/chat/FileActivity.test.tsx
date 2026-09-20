import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileActivity } from './FileActivity.js';
import type { TurnFileEntry } from './turn-model.js';

function file(over: Partial<TurnFileEntry> = {}): TurnFileEntry {
  return {
    path: 'src/a.ts',
    reads: 1, edits: 0, creates: 0, deletes: 0,
    action: 'read',
    anchorToolUseId: 'tu-1',
    additions: 0, deletions: 0,
    failed: false,
    ...over,
  };
}

describe('FileActivity', () => {
  it('summarizes the blast radius of the turn', () => {
    render(
      <FileActivity onJump={vi.fn()} files={[
        file({ path: 'src/a.ts', action: 'edit', edits: 2, reads: 1, additions: 12, deletions: 3 }),
        file({ path: 'src/b.ts', action: 'create', creates: 1, additions: 40 }),
        file({ path: 'src/c.ts' }),
      ]} />,
    );
    const section = screen.getByRole('region', { name: 'Files this turn touched' });
    expect(section).toHaveTextContent('3');
    expect(section).toHaveTextContent('1 created, 1 edited, 1 read');
    // Basename and directory are separate so the row can truncate the middle.
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.getAllByText('src')).toHaveLength(3);
    expect(screen.getByText('+12')).toBeInTheDocument();
    expect(screen.getByText('−3')).toBeInTheDocument();
    expect(screen.getByText('×3')).toBeInTheDocument();
  });

  it('names the action in words, not only in the rule tint', () => {
    render(<FileActivity onJump={vi.fn()} files={[file({ action: 'delete', reads: 0, deletes: 1, path: 'src/gone.ts' })]} />);
    const row = screen.getByRole('button', { name: 'deleted src/gone.ts' });
    expect(row).toHaveAttribute('data-action', 'delete');
    expect(row).toHaveTextContent('deleted');
  });

  it('says in the accessible name when a call on the file failed', () => {
    render(<FileActivity onJump={vi.fn()} files={[file({ action: 'edit', edits: 1, failed: true })]} />);
    expect(screen.getByRole('button', { name: /a call on this file failed/ })).toBeInTheDocument();
  });

  it('jumps to the tool call that did the work', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<FileActivity onJump={onJump} files={[file({ anchorToolUseId: 'tu-42' })]} />);
    await user.click(screen.getByRole('button', { name: /src\/a\.ts/ }));
    expect(onJump).toHaveBeenCalledWith('tu-42');
  });

  it('collapses a big refactor and expands on demand', async () => {
    const user = userEvent.setup();
    const files = Array.from({ length: 14 }, (_, i) => file({ path: `src/f${i}.ts`, anchorToolUseId: `tu-${i}` }));
    render(<FileActivity onJump={vi.fn()} files={files} />);
    expect(screen.getAllByRole('button', { name: /src\/f/ })).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Show 6 more files' }));
    expect(screen.getAllByRole('button', { name: /src\/f/ })).toHaveLength(14);
    await user.click(screen.getByRole('button', { name: 'Show fewer files' }));
    expect(screen.getAllByRole('button', { name: /src\/f/ })).toHaveLength(8);
  });

  it('renders nothing when the turn touched no files', () => {
    const { container } = render(<FileActivity onJump={vi.fn()} files={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

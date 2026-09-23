/**
 * saved-projects-sidebar.test.tsx — the "Projects" section in the chat
 * sidebar.
 *
 * It reads the workspace registry itself rather than taking it as a prop (the
 * sidebar's props belong to the chat section), so the query is replaced here
 * with one that answers in memory. What is pinned is the behaviour the
 * operator sees: the kept projects are listed, and pressing one opens the
 * editor for THAT project rather than the create form.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseWorkspacesResponse } from '../../../data/api-types.js';

const RESPONSE: VerseWorkspacesResponse = {
  workspaces: [
    {
      id: 'w1',
      name: 'Service + lib',
      roots: [
        { path: '/repo/service', name: 'service', primary: true },
        { path: '/repo/lib', name: 'lib', primary: false },
      ],
      section: false,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
  ],
  status: {},
  priorities: {},
  focusSectionId: null,
};

vi.mock('../verse-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../verse-queries.js')>();
  return {
    ...actual,
    // A distinct cache key, so this file's in-memory answer cannot be served
    // to (or from) any other test's copy of the real key.
    verseWorkspacesQuery: {
      key: 'verse-workspaces--sidebar-test',
      fetch: () => Promise.resolve(RESPONSE),
    },
  };
});

const { SavedProjects } = await import('./SavedProjects.js');

describe('SavedProjects', () => {
  it('lists each kept project with its folder count', async () => {
    render(<SavedProjects />);
    const row = await screen.findByRole('button', { name: 'Edit project Service + lib' });
    expect(row).toHaveTextContent('Service + lib');
    expect(row).toHaveTextContent('2 folders');
    // The primary folder is the row's tooltip — it costs no pixels there.
    expect(row).toHaveAttribute('title', '/repo/service');
    expect(screen.queryByText('No saved projects yet.')).not.toBeInTheDocument();
  });

  it('opens the editor for the project that was pressed', async () => {
    const user = userEvent.setup();
    render(<SavedProjects />);
    await user.click(await screen.findByRole('button', { name: 'Edit project Service + lib' }));
    expect(screen.getByRole('dialog', { name: 'Edit project' })).toBeInTheDocument();
    expect(screen.getByLabelText('Primary folder')).toHaveValue('/repo/service');
    expect(screen.getByLabelText('Folder 2')).toHaveValue('/repo/lib');
  });

  it('offers the create form from the same section', async () => {
    const user = userEvent.setup();
    render(<SavedProjects />);
    await user.click(screen.getByRole('button', { name: 'Save a project' }));
    expect(screen.getByRole('dialog', { name: 'Save a project' })).toBeInTheDocument();
  });
});

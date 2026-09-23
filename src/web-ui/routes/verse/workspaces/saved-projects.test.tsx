/**
 * saved-projects.test.tsx — what the operator is PROMISED about saved
 * projects, pinned at the DOM.
 *
 * The three rules that drove this feature, in order of how badly they used to
 * be broken:
 *
 *  1. A saved-project group that cannot be filled must not be drawn. Before
 *     this dialog could create one, the group was an empty promise on every
 *     normal install.
 *  2. A folder can be KEPT before any chat exists on it. That is the whole
 *     feature: `core/verse/projects.ts` only ever remembered folders a chat
 *     had already run in.
 *  3. A multi-folder project on a Grok seat reaches ONE folder. The picker is
 *     the only surface that knows both the folder set and the seat, so it is
 *     the only surface that can say so before the turn.
 *
 * The native folder chooser is exercised against its CONTRACT
 * (`nativePickerAvailable` / `pickDirectory`), not against a real shell —
 * there is no Tauri webview in jsdom. What is proven here is that the button
 * appears only when the shell says it can choose, that the chosen path lands
 * in the field, and that the typed-path input never goes away.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseSeat, VerseWorkspace } from '../../../data/api-types.js';
import { CLAUDE_SEAT, LOCAL_SEAT, bootstrap } from '../fixtures.test-support.js';

const mutations = vi.hoisted(() => ({
  createVerseWorkspace: vi.fn(),
  updateVerseWorkspace: vi.fn(),
  deleteVerseWorkspace: vi.fn(),
  setVerseRootPriority: vi.fn(),
  setVerseFocusSection: vi.fn(),
}));

// Only the writes are replaced; `verseBootstrapQuery` and friends stay real so
// the dialog's own re-read path behaves exactly as it does in the app.
vi.mock('../verse-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../verse-queries.js')>();
  return { ...actual, ...mutations };
});

const picker = vi.hoisted(() => ({
  nativePickerAvailable: vi.fn(),
  pickDirectory: vi.fn(),
}));
vi.mock('../folder-picker.js', () => picker);

const { NewChatDialog } = await import('../NewChatDialog.js');
const { SavedProjectDialog } = await import('./SavedProjectDialog.js');

/** Grok is the one engine with no additional-directory flag. */
const GROK_SEAT: VerseSeat = {
  id: 'grok-main',
  engine: 'grok',
  label: 'Grok',
  accountId: 'grok-main',
  models: [{ id: 'grok-code-fast-1', label: 'Grok Code', contextWindow: 256_000 }],
  contextWindow: 256_000,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};

function workspace(over: Partial<VerseWorkspace> = {}): VerseWorkspace {
  return {
    id: 'w1',
    name: 'Service + lib',
    roots: [
      { path: '/repo/service', name: 'service', primary: true },
      { path: '/repo/lib', name: 'lib', primary: false },
    ],
    section: false,
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
    ...over,
  };
}

function projectSelect(): HTMLSelectElement {
  return screen.getByLabelText('Project') as HTMLSelectElement;
}

beforeEach(() => {
  picker.nativePickerAvailable.mockReturnValue(false);
  picker.pickDirectory.mockResolvedValue(null);
  mutations.createVerseWorkspace.mockResolvedValue(workspace());
  mutations.updateVerseWorkspace.mockResolvedValue(workspace());
  mutations.deleteVerseWorkspace.mockResolvedValue(undefined);
  mutations.setVerseRootPriority.mockResolvedValue(undefined);
  mutations.setVerseFocusSection.mockResolvedValue(undefined);
});

describe('the saved-projects group is drawn only when it has something in it', () => {
  it('draws no group at all on an install with no saved projects', () => {
    const boot = bootstrap();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} />);
    // The seat picker has optgroups of its own, so this is scoped to the
    // project field rather than the whole document.
    expect(projectSelect().querySelectorAll('optgroup')).toHaveLength(0);
    expect(screen.queryByText('Saved projects')).not.toBeInTheDocument();
  });

  it('draws it, named and populated, as soon as one exists', () => {
    const boot = bootstrap();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={boot.seats}
      workspaces={[workspace()]} onCreate={() => {}} />);
    const groups = projectSelect().querySelectorAll('optgroup');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.getAttribute('label')).toBe('Saved projects');
    expect(within(projectSelect()).getByRole('option', { name: /Service \+ lib — 2 folders/ })).toBeInTheDocument();
  });
});

describe('a multi-folder project on a Grok seat', () => {
  async function pickTheProject(seats: readonly VerseSeat[]) {
    const user = userEvent.setup();
    const boot = bootstrap();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={seats}
      workspaces={[workspace()]} onCreate={() => {}} />);
    await user.selectOptions(projectSelect(), within(projectSelect()).getByRole('option', { name: /Service \+ lib/ }));
  }

  it('says the extra folders will be unreachable', async () => {
    await pickTheProject([GROK_SEAT]);
    expect(screen.getByText(/only the primary folder/)).toBeInTheDocument();
    expect(screen.getByText(/unreachable/)).toBeInTheDocument();
  });

  it('says nothing of the sort on a Claude seat', async () => {
    await pickTheProject([CLAUDE_SEAT]);
    expect(screen.queryByText(/only the primary folder/)).not.toBeInTheDocument();
  });

  it('says nothing of the sort on a local seat', async () => {
    await pickTheProject([LOCAL_SEAT]);
    expect(screen.queryByText(/only the primary folder/)).not.toBeInTheDocument();
  });

  it('says nothing for a ONE-folder project, which grok does reach', async () => {
    const user = userEvent.setup();
    const boot = bootstrap();
    const single = workspace({ id: 'w2', name: 'Just service', roots: [{ path: '/repo/service', name: 'service', primary: true }] });
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[GROK_SEAT]}
      workspaces={[single]} onCreate={() => {}} />);
    await user.selectOptions(projectSelect(), within(projectSelect()).getByRole('option', { name: /Just service/ }));
    expect(screen.queryByText(/only the primary folder/)).not.toBeInTheDocument();
  });
});

describe('keeping a folder before any chat exists on it', () => {
  it('saves the typed folder and puts it in the picker immediately', async () => {
    const user = userEvent.setup();
    const boot = bootstrap();
    mutations.createVerseWorkspace.mockResolvedValue(
      workspace({ id: 'w9', name: 'elsewhere', roots: [{ path: '/Users/mason/dev/elsewhere', name: 'elsewhere', primary: true }] }),
    );
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[CLAUDE_SEAT]} onCreate={() => {}} />);

    await user.selectOptions(projectSelect(), 'Other folder…');
    await user.type(screen.getByLabelText('Folder path'), '/Users/mason/dev/elsewhere');
    await user.click(screen.getByRole('button', { name: 'Save as a project' }));

    expect(mutations.createVerseWorkspace).toHaveBeenCalledWith({
      name: 'elsewhere',
      roots: ['/Users/mason/dev/elsewhere'],
    });
    // In the list, and selected, on the next paint — not after a round trip.
    await waitFor(() => {
      expect(projectSelect().querySelectorAll('optgroup')).toHaveLength(1);
    });
    expect(within(projectSelect()).getByRole('option', { name: /elsewhere — 1 folder/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('is in this list from now on');
  });

  it('sends the extra folders along, primary first', async () => {
    const user = userEvent.setup();
    const boot = bootstrap();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[CLAUDE_SEAT]} onCreate={() => {}} />);

    await user.selectOptions(projectSelect(), 'Other folder…');
    await user.type(screen.getByLabelText('Folder path'), '/repo/service');
    await user.click(screen.getByRole('button', { name: 'Add a folder' }));
    await user.type(screen.getByLabelText('Additional folder 1'), '/repo/lib');
    await user.click(screen.getByRole('button', { name: 'Save as a project' }));

    expect(mutations.createVerseWorkspace).toHaveBeenCalledWith({
      name: 'service',
      roots: ['/repo/service', '/repo/lib'],
    });
  });

  it('reports the server’s refusal instead of claiming the folder was kept', async () => {
    const user = userEvent.setup();
    const boot = bootstrap();
    mutations.createVerseWorkspace.mockRejectedValue(new Error('Unlock actions with the mutation token before chatting.'));
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[CLAUDE_SEAT]} onCreate={() => {}} />);

    await user.selectOptions(projectSelect(), 'Other folder…');
    await user.type(screen.getByLabelText('Folder path'), '/repo/service');
    await user.click(screen.getByRole('button', { name: 'Save as a project' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Unlock actions with the mutation token');
    });
    expect(projectSelect().querySelectorAll('optgroup')).toHaveLength(0);
  });
});

describe('the native folder chooser is an addition, never a replacement', () => {
  it('offers no button in a browser, where there is no chooser', async () => {
    const user = userEvent.setup();
    const boot = bootstrap();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[CLAUDE_SEAT]} onCreate={() => {}} />);
    await user.selectOptions(projectSelect(), 'Other folder…');
    expect(screen.queryByRole('button', { name: 'Choose folder…' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Folder path')).toBeInTheDocument();
  });

  it('puts the chosen path in the field, and KEEPS the typed-path input', async () => {
    picker.nativePickerAvailable.mockReturnValue(true);
    picker.pickDirectory.mockResolvedValue('/Users/mason/dev/picked');
    const user = userEvent.setup();
    const boot = bootstrap();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[CLAUDE_SEAT]} onCreate={() => {}} />);

    await user.selectOptions(projectSelect(), 'Other folder…');
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }));

    await waitFor(() => expect(screen.getByLabelText('Folder path')).toHaveValue('/Users/mason/dev/picked'));
  });

  it('leaves the field alone when the chooser is cancelled', async () => {
    picker.nativePickerAvailable.mockReturnValue(true);
    picker.pickDirectory.mockResolvedValue(null);
    const user = userEvent.setup();
    const boot = bootstrap();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[CLAUDE_SEAT]} onCreate={() => {}} />);

    await user.selectOptions(projectSelect(), 'Other folder…');
    await user.type(screen.getByLabelText('Folder path'), '/typed/by/hand');
    await user.click(screen.getByRole('button', { name: 'Choose folder…' }));

    // null is "no path, carry on" — not an error, and not a reason to clear
    // what the operator already typed.
    expect(screen.getByLabelText('Folder path')).toHaveValue('/typed/by/hand');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('SavedProjectDialog — root order', () => {
  it('moving a folder to the top makes it the primary, in that order', async () => {
    const user = userEvent.setup();
    render(<SavedProjectDialog open workspace={workspace()} onClose={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Move folder 2 up' }));
    // The order on screen is the order that gets sent.
    expect(screen.getByLabelText('Primary folder')).toHaveValue('/repo/lib');
    expect(screen.getByLabelText('Folder 2')).toHaveValue('/repo/service');

    await user.click(screen.getByRole('button', { name: 'Save project' }));
    await waitFor(() => {
      expect(mutations.updateVerseWorkspace).toHaveBeenCalledWith('w1', {
        name: 'Service + lib',
        roots: ['/repo/lib', '/repo/service'],
        section: false,
      });
    });
  });

  it('cannot move the primary up or the last folder down', () => {
    render(<SavedProjectDialog open workspace={workspace()} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Move primary folder up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move folder 2 down' })).toBeDisabled();
  });

  it('names a new project after its folder when nothing was typed', async () => {
    const user = userEvent.setup();
    render(<SavedProjectDialog open workspace={null} initialRoots={['/repo/service']} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Save project' }));
    await waitFor(() => {
      expect(mutations.createVerseWorkspace).toHaveBeenCalledWith({
        name: 'service',
        roots: ['/repo/service'],
        section: false,
      });
    });
  });

  it('refuses a relative path in the operator’s own words', async () => {
    const user = userEvent.setup();
    render(<SavedProjectDialog open workspace={null} onClose={() => {}} />);
    await user.type(screen.getByLabelText('Primary folder'), 'relative/path');
    await user.click(screen.getByRole('button', { name: 'Save project' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/absolute path/);
    expect(mutations.createVerseWorkspace).not.toHaveBeenCalled();
  });
});

describe('SavedProjectDialog — priority', () => {
  it('ranks a repo without claiming that ranking grants it', async () => {
    const user = userEvent.setup();
    render(<SavedProjectDialog open workspace={workspace({ section: true })} priorities={{}} onClose={() => {}} />);

    // The note that priority never widens scope is at the point of the choice.
    expect(screen.getByText(/never adds one/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Priority for /repo/lib'), 'critical');
    await user.click(screen.getByRole('button', { name: 'Save project' }));

    await waitFor(() => {
      expect(mutations.setVerseRootPriority).toHaveBeenCalledWith('/repo/lib', 'critical');
    });
    // Untouched repos are not re-sent — a save is not a re-rank of everything.
    expect(mutations.setVerseRootPriority).toHaveBeenCalledTimes(1);
  });

  it('points the fleet at this section, and lets it be un-pointed', async () => {
    const user = userEvent.setup();
    const view = render(<SavedProjectDialog open workspace={workspace({ section: true })} focusSectionId={null} onClose={() => {}} />);
    await user.click(screen.getByLabelText('Focus the fleet on this section'));
    await user.click(screen.getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(mutations.setVerseFocusSection).toHaveBeenCalledWith('w1'));

    view.unmount();
    mutations.setVerseFocusSection.mockClear();
    const user2 = userEvent.setup();
    render(<SavedProjectDialog open workspace={workspace({ section: true })} focusSectionId="w1" onClose={() => {}} />);
    expect(screen.getByLabelText('Focus the fleet on this section')).toBeChecked();
    await user2.click(screen.getByLabelText('Focus the fleet on this section'));
    await user2.click(screen.getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(mutations.setVerseFocusSection).toHaveBeenCalledWith(null));
  });

  it('leaves the focus alone when it was not touched', async () => {
    const user = userEvent.setup();
    render(<SavedProjectDialog open workspace={workspace({ section: true })} focusSectionId="w1" onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(mutations.updateVerseWorkspace).toHaveBeenCalled());
    expect(mutations.setVerseFocusSection).not.toHaveBeenCalled();
  });

  it('offers no priority controls for a project that is not a section', () => {
    render(<SavedProjectDialog open workspace={workspace({ section: false })} onClose={() => {}} />);
    expect(screen.queryByLabelText('Priority for /repo/lib')).not.toBeInTheDocument();
  });
});

describe('SavedProjectDialog — forgetting a project', () => {
  it('asks first, and says that existing chats are untouched', async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    render(<SavedProjectDialog open workspace={workspace()} onClose={() => {}} onDeleted={onDeleted} />);

    await user.click(screen.getByRole('button', { name: 'Forget project' }));
    expect(screen.getByText(/Chats already on it are untouched/)).toBeInTheDocument();
    expect(mutations.deleteVerseWorkspace).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(mutations.deleteVerseWorkspace).toHaveBeenCalledWith('w1'));
    expect(onDeleted).toHaveBeenCalledWith('w1');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseContextFit, VersePreferences, VersePreferencesUpdate } from '../../../core/verse/types.js';
import type { VerseWorkspace } from '../../data/api-types.js';
import { ApiError } from '../../data/client.js';
import { bootstrap } from './fixtures.test-support.js';
import {
  CLAUDE_CONTEXT_SEAT,
  CLAUDE_SKEW_NOTE,
  CLAUDE_TIGHT_SEAT,
  CODEX_CONTEXT_SEAT,
  CODEX_CREDITS_SEAT,
  GROK_CONTEXT_SEAT,
  LOCAL_CONTEXT_SEAT,
  OPUS_55_REASON,
  UNREAD_SEAT,
} from './seat-fixtures.test-support.js';
import { NewChatDialog, normalizeChoice, requestContextMode, seatPreferredMode, type RunMutation } from './NewChatDialog.js';
import { encodeSeatChoice } from './SeatSelector.js';
import { WINDOW_SOURCE_TEXT } from './verse-model.js';
import { VerseMutationLockedError } from './verse-queries.js';

/**
 * The dialog's three V3.9 reads/writes are U9's context queries. They are
 * replaced here so each test states exactly what the server answered — and
 * so no test can reach a real endpoint.
 */
const queries = vi.hoisted(() => ({
  fetchPreferences: vi.fn(),
  updatePreferences: vi.fn(),
  fetchContextFit: vi.fn(),
}));
vi.mock('./context/context-queries.js', () => queries);

function prefs(seats: VersePreferences['seats'] = {}): VersePreferences {
  return { version: 1, seats, memory: { enabled: true, disabledProjects: [] } };
}

function fitOf(totalEstTokens: number, truncated = false): VerseContextFit {
  return {
    roots: [{ path: '/Users/mason/dev/hub', files: 900, bytes: totalEstTokens * 4, estTokens: totalEstTokens, truncated }],
    totalEstTokens,
    estimator: 'bytes/4',
    sampledAt: '2026-09-23T10:00:00.000Z',
  };
}

const V39_SEATS = [CLAUDE_CONTEXT_SEAT, CODEX_CONTEXT_SEAT, GROK_CONTEXT_SEAT, LOCAL_CONTEXT_SEAT];

beforeEach(() => {
  queries.fetchPreferences.mockReset().mockResolvedValue(prefs());
  queries.fetchContextFit.mockReset().mockResolvedValue(fitOf(120_000));
  queries.updatePreferences.mockReset().mockImplementation(async (update: VersePreferencesUpdate) => {
    if ('seatId' in update) return prefs({ [update.seatId]: { contextMode: update.contextMode } });
    return prefs();
  });
});

describe('NewChatDialog', () => {
  it('keeps what was typed when the project/seat lists refetch while it is open', async () => {
    const user = userEvent.setup();
    const boot = bootstrap();
    const onCreate = vi.fn();
    const view = render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={onCreate} />);

    await user.selectOptions(screen.getByLabelText('Project'), 'Other folder…');
    await user.type(screen.getByLabelText('Folder path'), '/Users/mason/dev/elsewhere');
    await user.type(screen.getByLabelText(/^Title/), 'Long title in progress');

    // A turn finishing in another chat invalidates bootstrap: new array references, same content.
    const again = bootstrap();
    view.rerender(<NewChatDialog open onClose={() => {}} projects={again.projects} seats={[...V39_SEATS]} onCreate={onCreate} />);

    expect(screen.getByLabelText('Folder path')).toHaveValue('/Users/mason/dev/elsewhere');
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Long title in progress');

    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    // The default is the seat's first RUNNABLE model, and because it has a
    // second budget the mode on screen is sent explicitly.
    expect(onCreate).toHaveBeenCalledWith({
      projectPath: '/Users/mason/dev/elsewhere',
      seatId: 'claude-a',
      model: 'claude-fable-5-1',
      title: 'Long title in progress',
      contextMode: 'standard',
    });
  });

  it('resets to the pre-fill on each open, not on every render', async () => {
    const user = userEvent.setup();
    const boot = bootstrap();
    const view = render(<NewChatDialog open={false} onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} initialProjectPath="/Users/mason/dev/site" />);
    view.rerender(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} initialProjectPath="/Users/mason/dev/site" />);
    expect(screen.getByLabelText('Project')).toHaveValue('/Users/mason/dev/site');
    await user.type(screen.getByLabelText(/^Title/), 'draft');
    view.rerender(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} initialProjectPath="/Users/mason/dev/hub" />);
    // Pre-fill changes while open do not clobber the form …
    expect(screen.getByLabelText(/^Title/)).toHaveValue('draft');
    expect(screen.getByLabelText('Project')).toHaveValue('/Users/mason/dev/site');
    // … but the next open applies them.
    view.rerender(<NewChatDialog open={false} onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} initialProjectPath="/Users/mason/dev/hub" />);
    view.rerender(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={boot.seats} onCreate={() => {}} initialProjectPath="/Users/mason/dev/hub" />);
    expect(screen.getByLabelText(/^Title/)).toHaveValue('');
    expect(screen.getByLabelText('Project')).toHaveValue('/Users/mason/dev/hub');
  });
});

/**
 * The seat list is where the choice actually gets made, so the cost of making
 * it belongs here — not one section away in Usage, discovered at turn time.
 */
describe('NewChatDialog — capacity at the point of choice', () => {
  const boot = bootstrap();

  it('shows the chosen seat\u2019s plan, binding meter and verbatim reset', () => {
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[CLAUDE_TIGHT_SEAT]} onCreate={() => {}} />);
    expect(screen.getByText('max')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Claude Max weekly fable window used' })).toHaveAttribute('aria-valuenow', '92');
    expect(screen.getByText('resets Sep 25 at 7pm (America/New_York)')).toBeInTheDocument();
    expect(screen.getByText('tight')).toBeInTheDocument();
  });

  it('names the credits that outlive a spent window', () => {
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[CODEX_CREDITS_SEAT]} onCreate={() => {}} />);
    expect(screen.getByText('limit reached')).toBeInTheDocument();
    expect(screen.getByText(/2048\.42 credits left/)).toBeInTheDocument();
  });

  it('draws no meter for a seat nothing was read from', () => {
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={[UNREAD_SEAT]} onCreate={() => {}} />);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText('no capacity reading')).toBeInTheDocument();
  });
});

/**
 * V3.9 — the context a chat will have is decided in this dialog: its mode,
 * whether the chosen folders fit, and whether the pinned CLI can run the
 * model at all.
 */
describe('NewChatDialog — context mode', () => {
  const boot = bootstrap();

  it('shows the chosen model’s budget and its provenance', async () => {
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} />);
    const context = screen.getByRole('group', { name: 'Context' });
    expect(within(context).getByText('1M window · compacts ≈367k')).toBeInTheDocument();
    expect(within(context).getByText(`Window ${WINDOW_SOURCE_TEXT['cli-catalog']}.`)).toBeInTheDocument();
    expect(await within(context).findByRole('radio', { name: 'Standard', checked: true })).toBeInTheDocument();
    expect(within(context).getByText(/Compacts at about 367k\. Every turn re-sends the whole context/)).toBeInTheDocument();
  });

  it('starts from the seat’s saved default and sends it', async () => {
    queries.fetchPreferences.mockResolvedValue(prefs({ 'claude-a': { contextMode: 'expansive' } }));
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={onCreate} />);
    expect(await screen.findByRole('radio', { name: 'Expansive', checked: true })).toBeInTheDocument();
    // The picker row for the chosen model shows the budget it will actually get.
    expect(screen.getByRole('option', { name: /Fable 5\.1 · 1M ctx · compacts ≈967k \(expansive\)/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ seatId: 'claude-a', model: 'claude-fable-5-1', contextMode: 'expansive' }));
  });

  it('lets the operator switch mode, explains the cost, and saves it as the seat default through the guard', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const reasons: string[] = [];
    const runMutation: RunMutation = async (reason, action) => {
      reasons.push(reason);
      return action();
    };
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={onCreate} runMutation={runMutation} />);
    await screen.findByRole('radio', { name: 'Standard', checked: true });
    // Nothing to save while the mode on screen IS the saved default.
    expect(screen.queryByRole('button', { name: /the default for/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Expansive' }));
    expect(screen.getByText(/Runs to about 967k before compacting/)).toBeInTheDocument();
    expect(screen.getByText(/re-sends 2\.6× the tokens of one at 367k/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Make Expansive the default for Claude Max' }));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/default context mode for Claude Max/);
    expect(queries.updatePreferences).toHaveBeenCalledWith({ seatId: 'claude-a', contextMode: 'expansive' });
    expect(await screen.findByText('New chats on Claude Max now start in Expansive.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /the default for/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ contextMode: 'expansive' }));
  });

  it('writes nothing when the token prompt is dismissed', async () => {
    const user = userEvent.setup();
    let asked = 0;
    const runMutation: RunMutation = async () => {
      asked += 1;
      return null;
    };
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} runMutation={runMutation} />);
    await screen.findByRole('radio', { name: 'Standard', checked: true });
    await user.click(screen.getByRole('radio', { name: 'Expansive' }));
    await user.click(screen.getByRole('button', { name: 'Make Expansive the default for Claude Max' }));
    expect(asked).toBe(1);
    expect(queries.updatePreferences).not.toHaveBeenCalled();
    expect(screen.queryByText(/now start in/)).not.toBeInTheDocument();
    // Still offered: nothing was saved.
    expect(screen.getByRole('button', { name: 'Make Expansive the default for Claude Max' })).toBeEnabled();
  });

  it('never sticks on "Saving…" when the write fails after an unlock, and shows the server’s own words', async () => {
    // ChatSection's guard, when no token is held, PARKS the action behind the
    // token prompt and later runs `action().then(resolve)` — a rejection is
    // never forwarded. This guard behaves the same way, so the dialog must
    // settle the write itself.
    const parked: RunMutation = (_reason, action) => new Promise((resolve) => { void action().then(resolve); });
    queries.updatePreferences.mockRejectedValue(
      new ApiError('POST /api/verse/preferences failed (HTTP 400).', 400, '/api/verse/preferences', 'claude-a has no expansive budget for that model.'),
    );
    const user = userEvent.setup();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} runMutation={parked} />);
    await screen.findByRole('radio', { name: 'Standard', checked: true });
    await user.click(screen.getByRole('radio', { name: 'Expansive' }));
    await user.click(screen.getByRole('button', { name: 'Make Expansive the default for Claude Max' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('claude-a has no expansive budget for that model.');
    // Back to a usable button — not "Saving…" for the rest of the dialog.
    expect(screen.getByRole('button', { name: 'Make Expansive the default for Claude Max' })).toBeEnabled();
    expect(screen.queryByText('Saving…')).not.toBeInTheDocument();

    // And a retry that succeeds through the same parked guard lands normally.
    queries.updatePreferences.mockResolvedValue(prefs({ 'claude-a': { contextMode: 'expansive' } }));
    await user.click(screen.getByRole('button', { name: 'Make Expansive the default for Claude Max' }));
    expect(await screen.findByText('New chats on Claude Max now start in Expansive.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says to unlock when no mutation token is held', async () => {
    queries.updatePreferences.mockRejectedValue(new VerseMutationLockedError());
    const user = userEvent.setup();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} />);
    await screen.findByRole('radio', { name: 'Standard', checked: true });
    await user.click(screen.getByRole('radio', { name: 'Expansive' }));
    await user.click(screen.getByRole('button', { name: 'Make Expansive the default for Claude Max' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unlock actions with the mutation token to save a default.');
  });

  it('offers no mode for a model with one budget, and sends none', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={onCreate} />);
    await user.selectOptions(screen.getByLabelText('Seat and model'), encodeSeatChoice({ seatId: 'grok-a', model: 'grok-4.7-build-fast' }));
    expect(screen.queryByRole('radiogroup', { name: 'Context mode' })).not.toBeInTheDocument();
    expect(screen.getByText(/One budget: this CLI compacts at its own fixed point/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('contextMode');
  });

  it('never lets a saved Expansive default reach a model that has no such budget', async () => {
    queries.fetchPreferences.mockResolvedValue(prefs({ 'claude-a': { contextMode: 'expansive' } }));
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={onCreate} />);
    await screen.findByRole('radio', { name: 'Expansive', checked: true });
    await user.selectOptions(screen.getByLabelText('Seat and model'), encodeSeatChoice({ seatId: 'claude-a', model: 'claude-haiku-4-5-20251001' }));
    await user.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-haiku-4-5-20251001', contextMode: 'standard' }));
  });

  it('falls back to Standard, and says so, when saved defaults cannot be read', async () => {
    queries.fetchPreferences.mockRejectedValue(new ApiError('GET /api/verse/preferences failed (HTTP 404).', 404, '/api/verse/preferences'));
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} />);
    expect(await screen.findByText(/Saved defaults could not be read/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Standard', checked: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /the default for/ })).not.toBeInTheDocument();
  });
});

describe('NewChatDialog — models the pinned CLI cannot run', () => {
  const boot = bootstrap();

  it('refuses the model with its reason, and resolves an aliased pre-fill to the catalog row', async () => {
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}}
      initialSeat={{ seatId: 'claude-a', model: 'claude-opus-5.5' }} />);
    expect(screen.getByLabelText('Seat and model')).toHaveValue(encodeSeatChoice({ seatId: 'claude-a', model: 'claude-opus-5-5' }));
    expect(screen.getByText(`Opus 5.5 cannot run on this seat: ${OPUS_55_REASON}. Pick another model.`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeDisabled();
  });

  it('shows the seat’s pinned CLI and its own notes in visible text', () => {
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} />);
    const facts = screen.getByRole('list', { name: 'Claude Max facts' });
    expect(within(facts).getByText('Runs Claude Code 2.1.257.')).toBeInTheDocument();
    expect(within(facts).getByText(CLAUDE_SKEW_NOTE)).toBeInTheDocument();
  });
});

describe('NewChatDialog — context fit', () => {
  const boot = bootstrap();

  it('sizes the chosen folder and gives every model a verdict, explaining the chosen one', async () => {
    queries.fetchContextFit.mockResolvedValue(fitOf(300_000));
    const user = userEvent.setup();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} />);
    expect(await screen.findByText('Tight fit')).toBeInTheDocument();
    expect(queries.fetchContextFit).toHaveBeenCalledWith({ projectPath: '/Users/mason/dev/hub' });
    expect(screen.getByText(/~300k tokens of tracked code fits under the ≈367k compaction point/)).toBeInTheDocument();
    expect(screen.getByText(/bytes ÷ 4/)).toBeInTheDocument();
    // Every row carries its own verdict.
    expect(screen.getByRole('option', { name: /GPT-6 Astra .* · code needs expansive/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /qwen3\.8:27b-ctx64k .* · code too big — split/ })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Seat and model'), encodeSeatChoice({ seatId: LOCAL_CONTEXT_SEAT.id, model: 'qwen3.8:27b-ctx64k' }));
    expect(screen.getByText('Split the work')).toBeInTheDocument();
    expect(screen.getByText(/fan it out across several chats, each scoped to one folder or subsystem/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Seat and model'), encodeSeatChoice({ seatId: 'codex-b', model: 'gpt-6-astra' }));
    expect(screen.getByText('Needs expansive')).toBeInTheDocument();
    expect(screen.getByText(/Switch to Expansive, or narrow the folders/)).toBeInTheDocument();
    // Suggests — never switches.
    expect(screen.getByRole('radio', { name: 'Standard', checked: true })).toBeInTheDocument();
  });

  it('re-judges the fit against the Expansive budget once the chat is set to it', async () => {
    queries.fetchContextFit.mockResolvedValue(fitOf(300_000));
    const user = userEvent.setup();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} />);
    expect(await screen.findByText('Tight fit')).toBeInTheDocument();
    expect(screen.getByText(/Expansive \(≈967k\) would hold it with room to spare/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Expansive' }));
    expect(screen.getByText('Fits')).toBeInTheDocument();
    expect(screen.getByText(/fits well inside this model's Expansive budget \(compacts ≈967k\)/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Fable 5\.1 · 1M ctx · compacts ≈967k \(expansive\) · code fits$/ })).toBeInTheDocument();
  });

  it('marks a truncated scan as a floor', async () => {
    queries.fetchContextFit.mockResolvedValue(fitOf(100_000, true));
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} />);
    expect(await screen.findByText(/All at least ~100k tokens of tracked code fits/)).toBeInTheDocument();
  });

  it('sizes a saved project by its id', async () => {
    const workspace: VerseWorkspace = {
      id: 'ws_1',
      name: 'platform',
      roots: [{ path: '/Users/mason/dev/hub', primary: true }, { path: '/Users/mason/dev/lib', primary: false }],
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    } as VerseWorkspace;
    const user = userEvent.setup();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} workspaces={[workspace]} onCreate={() => {}} />);
    await user.selectOptions(screen.getByLabelText('Project'), 'platform — 2 folders');
    await waitFor(() => expect(queries.fetchContextFit).toHaveBeenCalledWith({ workspaceId: 'ws_1' }));
  });

  it('sizes a typed path once, after it settles, never each prefix', async () => {
    const user = userEvent.setup();
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} />);
    await user.selectOptions(screen.getByLabelText('Project'), 'Other folder…');
    await user.type(screen.getByLabelText('Folder path'), '/Users/mason/dev/elsewhere');
    await waitFor(() => expect(queries.fetchContextFit).toHaveBeenCalledWith({ projectPath: '/Users/mason/dev/elsewhere' }));
    const partial = queries.fetchContextFit.mock.calls.filter(([q]) => {
      const path = (q as { projectPath?: string }).projectPath ?? '';
      return path !== '/Users/mason/dev/elsewhere' && path !== '/Users/mason/dev/hub';
    });
    expect(partial).toEqual([]);
  });

  it('says so when the folders could not be sized, and claims no fit', async () => {
    queries.fetchContextFit.mockRejectedValue(new ApiError('GET failed (HTTP 400).', 400, '/api/verse/context-fit', 'projectPath is not a directory'));
    render(<NewChatDialog open onClose={() => {}} projects={boot.projects} seats={V39_SEATS} onCreate={() => {}} />);
    expect(await screen.findByText('Could not size the chosen folders: projectPath is not a directory')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /code fits/ })).not.toBeInTheDocument();
  });
});

describe('NewChatDialog — pure helpers', () => {
  const [FABLE, , HAIKU] = CLAUDE_CONTEXT_SEAT.models;

  it('sends a mode only when there was a choice, or to keep a saved default off a model without it', () => {
    expect(requestContextMode(FABLE!, 'expansive', 'standard')).toBe('expansive');
    expect(requestContextMode(FABLE!, 'standard', 'expansive')).toBe('standard');
    expect(requestContextMode(HAIKU!, 'standard', 'standard')).toBeNull();
    expect(requestContextMode(HAIKU!, 'expansive', 'expansive')).toBe('standard');
    expect(requestContextMode({ id: 'x', label: 'X', contextWindow: null }, 'standard', 'expansive')).toBeNull();
    expect(requestContextMode(null, 'standard', 'standard')).toBeNull();
  });

  it('reads the seat default, and normalizes a pre-fill against the roster', () => {
    expect(seatPreferredMode(null, 'claude-a')).toBe('standard');
    expect(seatPreferredMode(prefs({ 'claude-a': { contextMode: 'expansive' } }), 'claude-a')).toBe('expansive');
    expect(seatPreferredMode(prefs({ 'claude-a': {} }), 'claude-a')).toBe('standard');
    expect(normalizeChoice({ seatId: 'claude-a', model: 'claude-opus-5.5' }, V39_SEATS)).toEqual({ seatId: 'claude-a', model: 'claude-opus-5-5' });
    expect(normalizeChoice({ seatId: 'gone', model: 'x' }, V39_SEATS)).toEqual({ seatId: 'gone', model: 'x' });
    expect(normalizeChoice(null, V39_SEATS)).toBeNull();
  });
});

/**
 * HandoffDialog.test.tsx — what the operator is PROMISED by "Continue in a
 * fresh chat", pinned at the DOM:
 *
 *  1. Building the preview and creating the chat spend nothing, and the
 *     dialog says so. The handoff text is handed back to be pre-filled — it
 *     is never sent by the dialog.
 *  2. The text sent is the text on screen, edits included.
 *  3. The only spending path ("summarize first") is an explicit button that
 *     names its cost, goes through the ordinary turn route, and folds the
 *     seat's own reply into the handoff only once the turn really finished.
 *  4. Nothing is created on a model the seat cannot run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseEvent, VerseSession } from '../../../data/api-types.js';
import { VERSE_HANDOFF_SUMMARY_REQUEST, type VerseHandoffPreview, type VersePreferences } from '../../../../core/verse/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { applyVerseEvent, getVerseSessionState, resetVerseStore, seedVerseSession, setVerseStreamState } from '../verse-store.js';
import {
  CLAUDE_SEAT,
  CODEX_SEAT,
  contextSession,
  LOCAL_SEAT,
  preferences,
  SEATS,
  TEST_TOKEN,
} from './context-fixtures.test-support.js';
import { CODEX_EXPANSIVE_METERING_NOTE } from '../verse-model.js';

const prefsHolder = vi.hoisted(() => ({ current: null as VersePreferences | null }));

const queries = vi.hoisted(() => ({
  fetchHandoffPreview: vi.fn(),
  createHandoffSession: vi.fn(),
}));
vi.mock('./context-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context-queries.js')>();
  return {
    ...actual,
    ...queries,
    versePreferencesQuery: {
      key: 'verse-preferences:handoff-test',
      fetch: () => (prefsHolder.current ? Promise.resolve(prefsHolder.current) : Promise.reject(new Error('no preferences route'))),
    },
  };
});

const turns = vi.hoisted(() => ({
  sendVerseTurn: vi.fn(),
  cancelVerseTurn: vi.fn(),
  fetchVerseSessionDetail: vi.fn(),
}));
vi.mock('../verse-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../verse-queries.js')>();
  return { ...actual, ...turns };
});

const { HandoffDialog, initialHandoffTarget, turnOutcome } = await import('./HandoffDialog.js');

const SOURCE = contextSession();

function preview(over: Partial<VerseHandoffPreview> = {}): VerseHandoffPreview {
  const text = over.text ?? '# Handoff: Migrate the billing tables\n\nGoal: move billing to the partitioned schema.\n';
  return {
    sourceSessionId: SOURCE.id,
    sourceTitle: SOURCE.title,
    text,
    stats: { chars: text.length, estTokens: Math.ceil(text.length / 4), turnsCovered: 14, filesTouched: 6, truncated: [], ...over.stats },
    ...over,
  };
}

/** A VerseEvent before it is stamped (distributive, so each variant keeps its own fields). */
type Unstamped = VerseEvent extends infer E ? (E extends VerseEvent ? Omit<E, 'seq' | 'at'> : never) : never;

let seq = 1000;
function event(e: Unstamped): VerseEvent {
  seq += 1;
  return { seq, at: new Date(Date.UTC(2026, 8, 23, 10, 0, seq % 60)).toISOString(), ...e } as VerseEvent;
}

function mount(over: { session?: VerseSession; onClose?: () => void; onCreated?: (s: VerseSession, t: string) => void; open?: boolean } = {}) {
  const onClose = over.onClose ?? vi.fn();
  const onCreated = over.onCreated ?? vi.fn();
  const utils = render(
    <HandoffDialog session={over.session ?? SOURCE} seats={SEATS} open={over.open ?? true} onClose={onClose} onCreated={onCreated} />,
  );
  return { ...utils, onClose, onCreated };
}

function handoffBox(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: /Handoff — becomes the new chat’s first message/ }) as HTMLTextAreaElement;
}

beforeEach(() => {
  evictAll();
  resetVerseStore();
  setMutationToken(TEST_TOKEN);
  prefsHolder.current = preferences();
  queries.fetchHandoffPreview.mockResolvedValue(preview());
  queries.createHandoffSession.mockImplementation(async (input: { seatId: string; model?: string; title?: string }) =>
    contextSession({ id: 'vs_new', title: input.title ?? 'New chat', seatId: input.seatId, model: input.model ?? 'x', turnCount: 0 }));
  turns.sendVerseTurn.mockResolvedValue({ turnId: 't-sum', session: { ...SOURCE, status: 'running' } });
  turns.cancelVerseTurn.mockResolvedValue(undefined);
  turns.fetchVerseSessionDetail.mockResolvedValue({ session: SOURCE, events: [] });
  // The open chat's live stream is what normally feeds the store.
  seedVerseSession(SOURCE.id, SOURCE, []);
  setVerseStreamState(SOURCE.id, 'open');
});

afterEach(() => {
  clearMutationToken();
});

describe('opening', () => {
  it('renders nothing while closed and fetches nothing', () => {
    mount({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(queries.fetchHandoffPreview).not.toHaveBeenCalled();
  });

  it('builds the preview on open and shows what it covers', async () => {
    queries.fetchHandoffPreview.mockResolvedValue(preview({ stats: { chars: 0, estTokens: 0, turnsCovered: 14, filesTouched: 6, truncated: ['commands run', 'errors'] } }));
    mount();
    const dialog = screen.getByRole('dialog', { name: 'Continue in a fresh chat' });
    await waitFor(() => expect(handoffBox().value).toContain('Goal: move billing'));
    expect(queries.fetchHandoffPreview).toHaveBeenCalledWith('vs_src', { includeLastAssistant: false, focus: '' });
    expect(within(dialog).getByText(/14 turns · 6 files touched/)).toBeInTheDocument();
    expect(within(dialog).getByText(/these sections were left out: commands run, errors/)).toBeInTheDocument();
    // The spending rule, in the dialog's own words.
    expect(within(dialog).getByText(/Creating the chat is free — nothing is sent to a model/)).toBeInTheDocument();
  });

  it('waits for an explicit unlock when no token is held — and Escape on the prompt leaves this dialog open', async () => {
    clearMutationToken();
    const user = userEvent.setup();
    const { onClose } = mount();
    expect(queries.fetchHandoffPreview).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Unlock and build the handoff' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Unlock actions' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Continue in a fresh chat' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(queries.fetchHandoffPreview).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Unlock and build the handoff' }));
    await user.type(await screen.findByLabelText('Mutation token'), TEST_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(queries.fetchHandoffPreview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handoffBox().value).toContain('Goal: move billing'));
  });

  it('says why when the preview cannot be built, and retries', async () => {
    queries.fetchHandoffPreview.mockRejectedValueOnce(new Error('events.jsonl unreadable'));
    const user = userEvent.setup();
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not build the handoff: events.jsonl unreadable');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(handoffBox().value).toContain('Goal: move billing'));
  });
});

describe('editing and focus', () => {
  it('rebuilds with the focus line, and warns that a rebuild replaces edits', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    await user.type(handoffBox(), 'Also: keep the old table for a week.');
    expect(screen.getByText(/· edited/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rebuild (replaces your edits)' })).toBeInTheDocument();

    queries.fetchHandoffPreview.mockResolvedValueOnce(preview({ text: 'Focus: finish the backfill\n' }));
    await user.type(screen.getByLabelText(/Focus for the next chat/), 'finish the backfill');
    await user.click(screen.getByRole('button', { name: 'Rebuild (replaces your edits)' }));
    expect(queries.fetchHandoffPreview).toHaveBeenLastCalledWith('vs_src', { includeLastAssistant: false, focus: 'finish the backfill' });
    await waitFor(() => expect(handoffBox().value).toBe('Focus: finish the backfill\n'));
    expect(screen.getByRole('button', { name: 'Rebuild' })).toBeInTheDocument();
  });

  it('refuses a handoff over the one-message limit, and only warns over the handoff budget', async () => {
    mount();
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    const create = screen.getByRole('button', { name: 'Create chat' });

    await act(async () => { setTextareaValue(handoffBox(), 'x'.repeat(13_000)); });
    expect(screen.getByText(/Longer than the 12,000-character handoff budget/)).toBeInTheDocument();
    expect(create).toBeEnabled();

    await act(async () => { setTextareaValue(handoffBox(), 'é'.repeat(40_000)); });
    expect(screen.getByRole('alert')).toHaveTextContent(/Over the 64 KB limit for one message/);
    expect(create).toBeDisabled();

    // Under 64 KB as text, over it as sent: each line break is escaped to two bytes.
    await act(async () => { setTextareaValue(handoffBox(), 'a\n'.repeat(25_000)); });
    expect(screen.getByRole('alert')).toHaveTextContent(/counted as it is sent/);
    expect(create).toBeDisabled();

    await act(async () => { setTextareaValue(handoffBox(), '   '); });
    expect(create).toBeDisabled();
    expect(screen.getByText(/The handoff is empty/)).toBeInTheDocument();
  });
});

/** React-controlled textareas need the native setter + an input event. */
function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('where it continues', () => {
  it('defaults to the same seat and model, offers the mode the model has, and states its budget', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    const picker = screen.getByLabelText('Continue on') as HTMLSelectElement;
    expect(JSON.parse(picker.value)).toEqual(['claude-a', 'claude-fable-5-1']);
    const modes = screen.getByRole('radiogroup', { name: 'Context mode' });
    expect(within(modes).getByRole('radio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/1M window · compacts ≈367k/)).toBeInTheDocument();
    expect(screen.getByText(/^Fits:/)).toBeInTheDocument();

    await user.click(within(modes).getByRole('radio', { name: 'Expansive' }));
    expect(screen.getByText(/1M window · compacts ≈967k/)).toBeInTheDocument();
    expect(screen.getByText(/each turn costs more usage/)).toBeInTheDocument();

    // A 200k model has no expansive budget: no mode control at all.
    await user.selectOptions(picker, JSON.stringify(['claude-a', 'claude-haiku-4-5-20251001']));
    expect(screen.queryByRole('radiogroup', { name: 'Context mode' })).toBeNull();
    expect(screen.getByText(/200k window · compacts ≈167k/)).toBeInTheDocument();
  });

  it('sizes the fit with the TARGET seat’s estimated fixed prompt, and says it is an estimate', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    expect(screen.getByText(/an estimated ~25k of fixed prompt/)).toBeInTheDocument();
    const picker = screen.getByLabelText('Continue on') as HTMLSelectElement;
    await user.selectOptions(picker, JSON.stringify([LOCAL_SEAT.id, LOCAL_SEAT.models[0]!.id]));
    // A 64k local seat: the local CLI's ~15k, not a flat 30k that called every handoff "too big".
    expect(screen.getByText(/an estimated ~15k of fixed prompt/)).toBeInTheDocument();
    expect(screen.queryByText(/Too big for one context/)).toBeNull();
  });

  it('carries codex’s reported >272k metering on the Expansive hint, and only for codex', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Context mode' })).getByRole('radio', { name: 'Expansive' }));
    expect(screen.queryByText(/reportedly/)).toBeNull();

    await user.selectOptions(screen.getByLabelText('Continue on') as HTMLSelectElement, JSON.stringify([CODEX_SEAT.id, CODEX_SEAT.models[0]!.id]));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Context mode' })).getByRole('radio', { name: 'Expansive' }));
    expect(screen.getByText((text) => text.includes(CODEX_EXPANSIVE_METERING_NOTE))).toBeInTheDocument();
  });

  it('keeps an expansive source expansive on the same model', async () => {
    mount({ session: contextSession({ contextMode: 'expansive' }) });
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    expect(screen.getByRole('radio', { name: 'Expansive' })).toHaveAttribute('aria-checked', 'true');
  });

  it('refuses a model the seat’s pinned CLI cannot run, and says why', async () => {
    // The picker disables such a model, so the realistic path is a roster
    // refresh marking the CHOSEN model unrunnable while the dialog is open
    // (the seat was re-pinned to an older CLI). The dialog must not create on it.
    const runnable = { ...CLAUDE_SEAT, models: CLAUDE_SEAT.models.map((m) => ({ ...m, unavailableReason: null })) };
    const source = contextSession({ model: 'claude-opus-5-5' });
    const onCreated = vi.fn();
    const { rerender } = render(<HandoffDialog session={source} seats={[runnable, CODEX_SEAT]} open onClose={() => {}} onCreated={onCreated} />);
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    expect(JSON.parse((screen.getByLabelText('Continue on') as HTMLSelectElement).value)).toEqual(['claude-a', 'claude-opus-5-5']);
    expect(screen.getByRole('button', { name: 'Create chat' })).toBeEnabled();

    rerender(<HandoffDialog session={source} seats={[CLAUDE_SEAT, CODEX_SEAT]} open onClose={() => {}} onCreated={onCreated} />);
    expect(screen.getByRole('button', { name: 'Create chat' })).toBeDisabled();
    expect(screen.getAllByText(/Opus 5.5 cannot run on Claude Max: needs Claude Code 2.1.280/).length).toBeGreaterThan(0);
    expect(queries.createHandoffSession).not.toHaveBeenCalled();
  });

  it('warns that a Grok seat reaches only the primary folder', async () => {
    const grok = { ...LOCAL_SEAT, id: 'grok-a', engine: 'grok' as const, label: 'Grok', accountId: 'grok-a',
      models: [{ id: 'grok-4.7', label: 'Grok 4.7', contextWindow: 500_000, autoCompactAt: 400_000 }] };
    const user = userEvent.setup();
    render(<HandoffDialog session={contextSession({ extraRoots: ['/Users/mason/dev/lib'] })} seats={[CLAUDE_SEAT, CODEX_SEAT, grok]}
      open onClose={() => {}} onCreated={() => {}} />);
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    await user.selectOptions(screen.getByLabelText('Continue on'), JSON.stringify(['grok-a', 'grok-4.7']));
    expect(screen.getByText(/it will reach only the primary folder/)).toBeInTheDocument();
  });
});

/**
 * "Continue on ‹seat›" in the composer opens this dialog already pointed at
 * the seat the operator named (Workspace passes `initialTarget`). Opening on
 * "same seat" instead would make them pick again — or worse, create on the
 * seat they just said not to use.
 */
describe('initialTarget — the seat "Continue on" named', () => {
  it('opens on the named seat and model, and creates there', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<HandoffDialog session={SOURCE} seats={SEATS} open onClose={() => {}} onCreated={onCreated}
      initialTarget={{ seatId: CODEX_SEAT.id, model: CODEX_SEAT.models[0]!.id }} />);
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    expect(JSON.parse((screen.getByLabelText('Continue on') as HTMLSelectElement).value)).toEqual([CODEX_SEAT.id, CODEX_SEAT.models[0]!.id]);
    await user.click(screen.getByRole('button', { name: 'Create chat' }));
    await waitFor(() => expect(queries.createHandoffSession).toHaveBeenCalled());
    expect(queries.createHandoffSession.mock.calls[0]![0]).toMatchObject({ seatId: CODEX_SEAT.id, model: CODEX_SEAT.models[0]!.id });
  });

  it('a later pick inside the dialog wins over the prop (read once per open)', async () => {
    const user = userEvent.setup();
    const initial = { seatId: CODEX_SEAT.id, model: CODEX_SEAT.models[0]!.id };
    const { rerender } = render(<HandoffDialog session={SOURCE} seats={SEATS} open onClose={() => {}} onCreated={() => {}} initialTarget={initial} />);
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    const pick = [LOCAL_SEAT.id, LOCAL_SEAT.models[0]!.id];
    await user.selectOptions(screen.getByLabelText('Continue on') as HTMLSelectElement, JSON.stringify(pick));
    rerender(<HandoffDialog session={SOURCE} seats={[...SEATS]} open onClose={() => {}} onCreated={() => {}} initialTarget={{ ...initial }} />);
    expect(JSON.parse((screen.getByLabelText('Continue on') as HTMLSelectElement).value)).toEqual(pick);
  });

  it('waits for a cold roster, then fills in the NAMED seat rather than the default', async () => {
    const initial = { seatId: CODEX_SEAT.id, model: CODEX_SEAT.models[0]!.id };
    const { rerender } = render(<HandoffDialog session={SOURCE} seats={[]} open onClose={() => {}} onCreated={() => {}} initialTarget={initial} />);
    rerender(<HandoffDialog session={SOURCE} seats={SEATS} open onClose={() => {}} onCreated={() => {}} initialTarget={initial} />);
    await waitFor(() => expect(JSON.parse((screen.getByLabelText('Continue on') as HTMLSelectElement).value)).toEqual([CODEX_SEAT.id, CODEX_SEAT.models[0]!.id]));
  });

  it('resolves a stale choice honestly', () => {
    const source = { seatId: CLAUDE_SEAT.id, model: 'claude-fable-5-1' };
    // No prop → the ordinary default.
    expect(initialHandoffTarget(SEATS, source, undefined)).toEqual({ seatId: 'claude-a', model: 'claude-fable-5-1' });
    // Cold roster → nothing yet (the effect retries).
    expect(initialHandoffTarget([], source, { seatId: CODEX_SEAT.id, model: 'x' })).toBeNull();
    // A seat that left the roster → the ordinary default, not an empty picker.
    expect(initialHandoffTarget(SEATS, source, { seatId: 'gone', model: 'x' })).toEqual({ seatId: 'claude-a', model: 'claude-fable-5-1' });
    // A model the seat no longer lists → the seat's first runnable model: the SEAT was the choice.
    expect(initialHandoffTarget(SEATS, source, { seatId: CODEX_SEAT.id, model: 'renamed-away' }))
      .toEqual({ seatId: CODEX_SEAT.id, model: CODEX_SEAT.models.find((m) => !m.unavailableReason)!.id });
    // Nothing on the seat runs → keep the named model so the dialog can say why; never a different seat unasked.
    const dead = { ...CODEX_SEAT, models: CODEX_SEAT.models.map((m) => ({ ...m, unavailableReason: 'needs a newer CLI' })) };
    expect(initialHandoffTarget([CLAUDE_SEAT, dead], source, { seatId: dead.id, model: 'renamed-away' })).toEqual({ seatId: dead.id, model: 'renamed-away' });
  });
});

describe('creating', () => {
  it('creates the chat and hands back the EDITED text for the composer — never sending it', async () => {
    const user = userEvent.setup();
    const { onCreated, onClose } = mount();
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    await user.type(handoffBox(), 'Extra note.');
    await user.selectOptions(screen.getByLabelText('Continue on'), JSON.stringify(['codex-b', 'gpt-6-astra']));
    await user.click(screen.getByRole('radio', { name: 'Expansive' }));
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    expect(title.value).toBe('Migrate the billing tables · part 2');
    await user.click(screen.getByRole('button', { name: 'Create chat' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(queries.createHandoffSession).toHaveBeenCalledWith({
      source: SOURCE,
      seatId: 'codex-b',
      model: 'gpt-6-astra',
      contextMode: 'expansive',
      title: 'Migrate the billing tables · part 2',
    });
    const [created, text] = (onCreated as ReturnType<typeof vi.fn>).mock.calls[0] as [VerseSession, string];
    expect(created.id).toBe('vs_new');
    expect(text.endsWith('Extra note.')).toBe(true);
    expect(onClose).toHaveBeenCalled();
    // The dialog never sends a turn of its own.
    expect(turns.sendVerseTurn).not.toHaveBeenCalled();
    // The store knows the new chat before its detail fetch lands.
    expect(getVerseSessionState('vs_new').session?.id).toBe('vs_new');
  });

  it('shows the server’s refusal and stays open', async () => {
    queries.createHandoffSession.mockRejectedValueOnce(new Error('seat not found: codex-b'));
    const user = userEvent.setup();
    const { onCreated, onClose } = mount();
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    await user.click(screen.getByRole('button', { name: 'Create chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('seat not found: codex-b');
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ask this seat to summarize first', () => {
  it('names its cost, sends the canned turn, and folds the reply in only after the turn finished', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    expect(screen.getByText(/Sends one turn to Claude Max and spends from its usage/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Ask Claude Max to summarize first' }));
    expect(turns.sendVerseTurn).toHaveBeenCalledWith('vs_src', VERSE_HANDOFF_SUMMARY_REQUEST);
    expect(await screen.findByText('Waiting for Claude Max to finish its summary…')).toBeInTheDocument();
    // Creating mid-summary would snapshot a handoff without it.
    expect(screen.getByRole('button', { name: 'Create chat' })).toBeDisabled();

    queries.fetchHandoffPreview.mockResolvedValueOnce(preview({ text: '# Handoff\n\n## The agent’s own summary\nAll migrations written.\n' }));
    act(() => {
      applyVerseEvent('vs_src', event({ type: 'turn-started', turnId: 't-sum', pid: 1 }));
      applyVerseEvent('vs_src', event({ type: 'assistant-message', turnId: 't-sum', text: 'All migrations written.' }));
    });
    // Not finished yet: nothing rebuilt.
    expect(queries.fetchHandoffPreview).toHaveBeenCalledTimes(1);
    act(() => {
      applyVerseEvent('vs_src', event({ type: 'turn-done', turnId: 't-sum', ok: true, nativeSessionId: 'uuid-src', durationMs: 900 }));
    });
    await waitFor(() => expect(queries.fetchHandoffPreview).toHaveBeenLastCalledWith('vs_src', { includeLastAssistant: true, focus: '' }));
    await waitFor(() => expect(handoffBox().value).toContain('All migrations written.'));
    expect(screen.getByText('Summary added.')).toBeInTheDocument();
    expect(screen.getByText(/includes Claude Max’s own summary/)).toBeInTheDocument();
  });

  it('says a local summary spends no subscription usage', async () => {
    const local = contextSession({ engine: 'local', seatId: LOCAL_SEAT.id, accountId: 'local', model: LOCAL_SEAT.models[0]!.id });
    seedVerseSession(local.id, local, []);
    mount({ session: local });
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    expect(screen.getByText(/spends no subscription usage/)).toBeInTheDocument();
  });

  it('reports a failed summary and leaves the automatic preview alone', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    await user.click(screen.getByRole('button', { name: 'Ask Claude Max to summarize first' }));
    await screen.findByText('Waiting for Claude Max to finish its summary…');
    act(() => {
      applyVerseEvent('vs_src', event({ type: 'error', turnId: 't-sum', message: 'weekly limit reached' }));
      applyVerseEvent('vs_src', event({ type: 'turn-done', turnId: 't-sum', ok: false, nativeSessionId: null, durationMs: 10 }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('The summary turn failed: weekly limit reached. The automatic preview is unchanged.');
    expect(queries.fetchHandoffPreview).toHaveBeenCalledTimes(1);
    expect(handoffBox().value).toContain('Goal: move billing');
  });

  it('stops the summary turn on request', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    await user.click(screen.getByRole('button', { name: 'Ask Claude Max to summarize first' }));
    await user.click(await screen.findByRole('button', { name: 'Stop the summary' }));
    expect(turns.cancelVerseTurn).toHaveBeenCalledWith('vs_src');
    act(() => {
      applyVerseEvent('vs_src', event({ type: 'cancelled', turnId: 't-sum' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Summary stopped. The automatic preview is unchanged.');
  });

  it('is unavailable while another turn runs, or before any turn', async () => {
    mount({ session: contextSession({ status: 'running' }) });
    await waitFor(() => expect(handoffBox().value).toContain('Goal'));
    expect(screen.getByRole('button', { name: 'Ask Claude Max to summarize first' })).toBeDisabled();
    expect(screen.getByText(/A turn is running in this chat/)).toBeInTheDocument();
  });

  it('falls back to polling the log when no live stream feeds the store', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setVerseStreamState(SOURCE.id, 'closed');
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mount();
      await waitFor(() => expect(handoffBox().value).toContain('Goal'));
      await user.click(screen.getByRole('button', { name: 'Ask Claude Max to summarize first' }));
      await screen.findByText('Waiting for Claude Max to finish its summary…');
      turns.fetchVerseSessionDetail.mockResolvedValue({
        session: SOURCE,
        events: [
          event({ type: 'assistant-message', turnId: 't-sum', text: 'Summary.' }),
          event({ type: 'turn-done', turnId: 't-sum', ok: true, nativeSessionId: null, durationMs: 5 }),
        ],
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
      await waitFor(() => expect(queries.fetchHandoffPreview).toHaveBeenLastCalledWith('vs_src', { includeLastAssistant: true, focus: '' }));
      expect(turns.fetchVerseSessionDetail).toHaveBeenCalledWith('vs_src');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('turnOutcome', () => {
  const at = '2026-09-23T10:00:00.000Z';
  it('is null while the turn runs, and reads every ending', () => {
    const running: VerseEvent[] = [{ seq: 1, at, type: 'turn-started', turnId: 't', pid: 1 }];
    expect(turnOutcome(running, 't')).toBeNull();
    expect(turnOutcome([...running, { seq: 2, at, type: 'assistant-message', turnId: 't', text: 'x' },
      { seq: 3, at, type: 'turn-done', turnId: 't', ok: true, nativeSessionId: null, durationMs: 1 }], 't')).toEqual({ kind: 'ok' });
    expect(turnOutcome([...running, { seq: 2, at, type: 'turn-done', turnId: 't', ok: true, nativeSessionId: null, durationMs: 1 }], 't'))
      .toEqual({ kind: 'empty' });
    expect(turnOutcome([...running, { seq: 2, at, type: 'cancelled', turnId: 't' },
      { seq: 3, at, type: 'turn-done', turnId: 't', ok: false, nativeSessionId: null, durationMs: 1 }], 't')).toEqual({ kind: 'cancelled' });
    expect(turnOutcome([...running, { seq: 2, at, type: 'error', turnId: 't', message: 'boom' },
      { seq: 3, at, type: 'turn-done', turnId: 't', ok: false, nativeSessionId: null, durationMs: 1 }], 't'))
      .toEqual({ kind: 'failed', message: 'boom' });
  });

  it('ignores another turn’s ending', () => {
    expect(turnOutcome([{ seq: 1, at, type: 'turn-done', turnId: 'other', ok: true, nativeSessionId: null, durationMs: 1 }], 't')).toBeNull();
  });
});

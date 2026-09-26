/**
 * OnboardingFlow.test.tsx — the first-run tour as the operator meets it.
 *
 * The assertions that matter are about restraint: it never blocks the app,
 * it disappears permanently the moment it is answered, and it never claims a
 * seat or a runtime is fine when the read did not say so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { resetVerseUi, getVerseUiState } from '../verse-ui-store.js';
import { bootstrap } from '../fixtures.test-support.js';
import { healthReport } from '../health/health.test-support.js';
import { CLAUDE_TIGHT_SEAT, GROK_SEAT } from '../seat-fixtures.test-support.js';
import { OnboardingFlow } from './OnboardingFlow.js';
import { OnboardingPanel, describeOnboardingState } from './OnboardingPanel.js';
import {
  VERSE_ONBOARDING_STORAGE_KEY,
  expandOnboarding,
  getOnboardingState,
  resetOnboarding,
} from './onboarding-store.js';
import { authorityStatus, grantDraft, setupReport } from '../command/fixtures.test-support.js';
import { setShellNotifier } from '../shell/run-command.js';

/** Step 2 reads C6's shared capacity strip: the seat roster (bootstrap) and A2's health. */
const SEATS = [CLAUDE_TIGHT_SEAT, GROK_SEAT];
const HEALTH = {
  seats: [
    healthReport('claude'),
    healthReport('grok', {
      engine: 'grok',
      connection: 'signed-out',
      reasons: ['The Grok seat is signed out.'],
      fix: { kind: 'reauth', command: ['grok', 'login'] },
    }),
  ],
};

const LOCAL_MODELS = {
  machine: { totalMemoryBytes: 137_438_953_472, freeMemoryBytes: 48_242_049_024 },
  ollama: {
    reachable: true,
    baseUrl: 'http://localhost:11434',
    reason: null,
    models: [
      { label: 'qwen3:8b', state: 'available', sizeBytes: 1_073_741_824, capabilities: ['completion', 'tools'], supportsTools: true },
    ],
  },
  lmStudio: { reachable: false, baseUrl: 'http://localhost:1234', models: [], reason: 'lmstudio-unreachable' },
  notes: [],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function routes(overrides: Record<string, () => Response> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : String(input);
    for (const [path, make] of Object.entries(overrides)) {
      if (url.startsWith(path)) return make();
    }
    if (url.startsWith('/api/verse/bootstrap')) return json(bootstrap({ seats: SEATS }));
    if (url.startsWith('/api/verse/health')) return json(HEALTH);
    // No budget route in this build: the strip then says less, never more.
    if (url.startsWith('/api/verse/budget')) return new Response('{"error":"not found"}', { status: 404 });
    if (url.startsWith('/api/verse/local-models')) return json(LOCAL_MODELS);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

async function stepTo(user: ReturnType<typeof userEvent.setup>, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await user.click(screen.getByRole('button', { name: 'Next' }));
  }
}

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseUi();
  resetOnboarding();
  vi.stubGlobal('fetch', routes());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OnboardingFlow — the chip', () => {
  it('starts as a one-line chip naming the step, not the full card', () => {
    render(<OnboardingFlow />);
    const chip = screen.getByRole('region', { name: 'Getting started' });
    expect(chip).toHaveTextContent('Getting started1/6');
    expect(within(chip).getByRole('button', { name: /Getting started/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Welcome to Verse')).not.toBeInTheDocument();
    // The chip reads nothing: no step has mounted, so no step's query ran.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens into the card on click, and the card folds back to the chip without answering the tour', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await user.click(screen.getByRole('button', { name: /Getting started/ }));
    expect(screen.getByText('Welcome to Verse')).toBeInTheDocument();
    expect(screen.getByText('Getting started · 1 of 6')).toBeInTheDocument();
    expect(getOnboardingState().expanded).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Minimize getting started' }));
    expect(screen.queryByText('Welcome to Verse')).not.toBeInTheDocument();
    const reopen = screen.getByRole('button', { name: /Getting started/ });
    expect(reopen).toHaveFocus();
    expect(getOnboardingState()).toMatchObject({ open: true, expanded: false, dismissedAt: null, completedAt: null });
  });

  it('keeps the step it was on, so the chip counts where the operator left off', async () => {
    const user = userEvent.setup();
    expandOnboarding();
    render(<OnboardingFlow />);
    await stepTo(user, 2);
    await user.click(screen.getByRole('button', { name: 'Minimize getting started' }));
    expect(screen.getByRole('region', { name: 'Getting started' })).toHaveTextContent('3/6');
    expect(JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!)).toMatchObject({ expanded: false, step: 2 });
  });

  it('its × dismisses the tour for good', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<OnboardingFlow />);
    await user.click(screen.getByRole('button', { name: 'Dismiss getting started' }));
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!).dismissedAt).toEqual(expect.any(String));
    rerender(<OnboardingFlow />);
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
  });
});

describe('OnboardingFlow — presence and dismissal', () => {
  beforeEach(() => {
    expandOnboarding();
  });

  it('opens on a first run and names the step it is on', () => {
    render(<OnboardingFlow />);
    expect(screen.getByText('Welcome to Verse')).toBeInTheDocument();
    expect(screen.getByText('Getting started · 1 of 6')).toBeInTheDocument();
  });

  it('welcomes in one sentence', () => {
    render(<OnboardingFlow />);
    const lead = screen.getByText(/^Verse runs your chats/);
    expect(lead.textContent!.match(/[.!?](\s|$)/g)).toHaveLength(1);
  });

  it('gives the icon-only minimise button a tooltip as well as an accessible name', () => {
    render(<OnboardingFlow />);
    expect(screen.getByRole('button', { name: 'Minimize getting started' })).toHaveAttribute('title', 'Minimize getting started');
  });

  it('tours the 3.10 rail — Command ⌘1 through Chat ⌘5 — and points at ⌘K, ⌘J and the gear', () => {
    render(<OnboardingFlow />);
    const names = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(names.map((n) => n.slice(0, n.indexOf('⌘') + 2))).toEqual(['Command ⌘1', 'Fleet ⌘2', 'Growth ⌘3', 'Mind ⌘4', 'Chat ⌘5']);
    expect(screen.getByText(/runs anything by name/)).toBeInTheDocument();
    expect(screen.queryByText(/Approvals|Autonomy/)).not.toBeInTheDocument();
  });

  it('is not a modal: no dialog role, no backdrop, nothing to trap focus', () => {
    const { container } = render(<OnboardingFlow />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-modal="true"]')).toBeNull();
    // It is a region, so a screen reader can reach it deliberately and skip
    // past it just as easily.
    expect(screen.getByRole('region', { name: 'Welcome to Verse' })).toBeInTheDocument();
  });

  it('Skip closes it and records the answer so it never returns', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<OnboardingFlow />);
    await user.click(screen.getByRole('button', { name: 'Skip setup' }));

    expect(screen.queryByText('Welcome to Verse')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!).dismissedAt).toEqual(expect.any(String));

    rerender(<OnboardingFlow />);
    expect(screen.queryByText('Welcome to Verse')).not.toBeInTheDocument();
  });

  /**
   * Deliberately narrowed from "Escape dismisses it from anywhere".
   *
   * "Anywhere" was the defect, not the feature. This card is not a modal (the
   * app behind it stays clickable, which is the whole design constraint), so a
   * document-level Escape handler also caught every Escape the operator pressed
   * for something else — closing the command palette, backing out of a seat
   * menu, stopping dictation — and each one permanently wrote `dismissedAt`
   * with no confirmation and no undo short of Settings → Replay. It also called
   * `preventDefault()` unconditionally, suppressing whatever they were actually
   * trying to close.
   */
  it('Escape folds it back to the chip when the focus is inside the card — never answering the tour', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    screen.getByRole('button', { name: 'Minimize getting started' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Welcome to Verse')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
    expect(getOnboardingState().dismissedAt).toBeNull();
    expect(getOnboardingState().open).toBe(true);
  });

  it('Escape pressed elsewhere in the app leaves the tour alone', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    // Nothing in the card has focus — this is the operator dismissing some
    // other transient surface while the tour happens to be open.
    document.body.focus();
    await user.keyboard('{Escape}');
    expect(screen.getByText('Welcome to Verse')).toBeInTheDocument();
    expect(getOnboardingState().dismissedAt).toBeNull();
  });

  it('walks forward and back through all six steps', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 1);
    expect(screen.getByText('Your seats')).toBeInTheDocument();
    await stepTo(user, 1);
    expect(screen.getByText('Local runtime')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Your seats')).toBeInTheDocument();
    await stepTo(user, 2);
    expect(screen.getByText('Turn on autonomy')).toBeInTheDocument();
    await stepTo(user, 2);
    expect(screen.getByText('Make it yours')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('the last step records completion and hands the shell a new-chat request', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 5);
    await user.click(screen.getByRole('button', { name: 'Start a first chat' }));

    expect(getOnboardingState().completedAt).not.toBeNull();
    expect(getOnboardingState().dismissedAt).toBeNull();
    expect(getVerseUiState().section).toBe('chat');
    expect(getVerseUiState().command?.name).toBe('new-chat');
    expect(screen.queryByText('Make it yours')).not.toBeInTheDocument();
  });
});

describe('OnboardingFlow — what it says about the machine', () => {
  beforeEach(() => {
    expandOnboarding();
  });

  it('shows the seats through the shared capacity strip, with A2’s exact fix for a signed-out one', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 1);

    await waitFor(() => expect(screen.getByText('grok login')).toBeInTheDocument());
    const strip = screen.getByRole('list', { name: 'Your seats' });
    expect(strip).toHaveTextContent('Claude Max');
    expect(strip).toHaveTextContent('Grok');
    // Only the broken seat carries a fix; the connected one gets none.
    expect(screen.getAllByText('Fix')).toHaveLength(1);
    // The 3.9 accounts narrower is gone: the tour reads what Apps & Accounts reads.
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.startsWith('/api/verse/accounts'))).toBe(false);
  });

  it('says no seats were reported, rather than inventing a roster, when there are none', async () => {
    vi.stubGlobal('fetch', routes({ '/api/verse/bootstrap': () => json(bootstrap({ seats: [] })) }));
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 1);

    await waitFor(() => expect(screen.getByText(/No seats reported yet/)).toBeInTheDocument());
    expect(screen.queryByText('Fix')).not.toBeInTheDocument();
  });

  it('reports the local runtime with its tool-capable count', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 2);

    await waitFor(() => expect(screen.getByText(/1 local model available/)).toBeInTheDocument());
    expect(screen.getByText('available')).toBeInTheDocument();
    expect(screen.getByText(/consume no provider quota/)).toBeInTheDocument();
  });

  it('never presents an unanswered probe as "not installed"', async () => {
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/verse/local-models': () =>
          json({
            machine: LOCAL_MODELS.machine,
            ollama: { reachable: false, baseUrl: 'http://localhost:11434', models: [], reason: 'ollama-unreachable' },
            lmStudio: { reachable: false, baseUrl: 'http://localhost:1234', models: [], reason: 'lmstudio-unreachable' },
            notes: [],
          }),
      }),
    );
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 2);

    // `verseLocalModelsQuery` deliberately re-reads a reported-unreachable
    // runtime twice (350ms + 1200ms) before believing it, so this waits past
    // that ladder rather than asserting on the first, provisional answer.
    await waitFor(
      () => expect(screen.getByText(/cannot tell whether one is not running or not installed/)).toBeInTheDocument(),
      { timeout: 4_000 },
    );
    expect(screen.getByText('unreachable')).toBeInTheDocument();
  });

  it('states the three stops at their real blast radius, and never calls the kill switch a pause', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 4);

    expect(screen.getByText('Pause')).toBeInTheDocument();
    expect(screen.getByText('Stop loop')).toBeInTheDocument();
    expect(screen.getByText('Emergency stop')).toBeInTheDocument();
    expect(screen.getByText(/engages the GLOBAL kill switch/)).toBeInTheDocument();
    expect(screen.getByText(/Every mutating path refuses/)).toBeInTheDocument();
  });

  it('reads autonomy from the same authority entry Command reads, and offers the setup command while no grant exists', async () => {
    vi.stubGlobal('fetch', routes({ '/api/verse/authority': () => json(authorityStatus('dark')) }));
    const writeText = vi.fn(async () => {});
    const notify = vi.fn();
    setShellNotifier(notify);
    const user = userEvent.setup();
    // After setup(): user-event installs its own clipboard stub on navigator.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<OnboardingFlow />);
    await stepTo(user, 3);

    expect(screen.getByText('Turn on autonomy')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Off')).toBeInTheDocument());
    expect(screen.getByText(/No standing grant is installed/)).toBeInTheDocument();
    expect(screen.getByText('ashlr authority setup')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('ashlr authority setup');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Copied `ashlr authority setup`'), 'success');
    setShellNotifier(null);
  });

  it('says so, rather than failing silently, when the clipboard is unavailable', async () => {
    vi.stubGlobal('fetch', routes({ '/api/verse/authority': () => json(authorityStatus('dark')) }));
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<OnboardingFlow />);
    await stepTo(user, 3);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/copy it by hand/);
  });

  it('while setup has a step open, shows the live checklist unfolded and copies THAT step’s command', async () => {
    const fetchMock = routes({
      // Longest first: `routes` matches by prefix, in insertion order.
      '/api/verse/authority/setup': () => json(setupReport('deploy')),
      '/api/verse/authority/draft': () => json(grantDraft()),
      '/api/verse/authority': () => json(authorityStatus('dark')),
    });
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.fn(async () => {});
    const notify = vi.fn();
    setShellNotifier(notify);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<OnboardingFlow />);
    await stepTo(user, 3);
    const checklist = await screen.findByTestId('setup-checklist');
    expect(checklist).toHaveTextContent('NextDeploy');
    expect(checklist.querySelector('details')?.open).toBe(true);
    expect(within(checklist).getByRole('list', { name: 'Setup: 4 of 15 ready' })).toBeInTheDocument();
    expect(within(checklist).getByText('npm run build')).toBeInTheDocument();
    await user.click(within(checklist).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('npm run build');
    expect(notify).toHaveBeenCalledWith('Copied `npm run build`. Run it in a terminal; then rerun `ashlr authority setup`.', 'success');
    expect(fetchMock.mock.calls.some(([u]: [unknown]) => String(u).startsWith('/api/verse/authority/draft'))).toBe(false);
    setShellNotifier(null);
  });

  it('when only the grant is left, offers "Approve grant…" (the ⌘K command) instead of setup — without drafting one', async () => {
    const fetchMock = routes({
      '/api/verse/authority/setup': () => json(setupReport()),
      '/api/verse/authority/draft': () => json(grantDraft()),
      '/api/verse/authority': () => json(authorityStatus('dark')),
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 3);
    const approve = await screen.findByRole('button', { name: 'Approve grant…' });
    expect(screen.queryByText('ashlr authority setup')).not.toBeInTheDocument();
    await user.click(approve);
    // The shell brings Command forward and parks the command for its bar.
    expect(getVerseUiState().section).toBe('command');
    expect(fetchMock.mock.calls.some(([u]: [unknown]) => String(u).startsWith('/api/verse/authority/draft'))).toBe(false);
  });

  it('once a grant exists, points at Command instead of setup', async () => {
    vi.stubGlobal('fetch', routes({ '/api/verse/authority': () => json(authorityStatus('live')) }));
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 3);
    await waitFor(() => expect(screen.getByText('Autonomous')).toBeInTheDocument());
    expect(screen.queryByText('ashlr authority setup')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Command' }));
    expect(getVerseUiState().section).toBe('command');
  });

  it('never claims an autonomy state it could not read', async () => {
    vi.stubGlobal('fetch', routes({ '/api/verse/authority': () => new Response('{"error":"not found"}', { status: 404 }) }));
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 3);
    await waitFor(() => expect(screen.getByText('not reported')).toBeInTheDocument());
    expect(screen.getByText(/not in this build yet/)).toBeInTheDocument();
    expect(screen.queryByText('Off')).not.toBeInTheDocument();
  });

  it('points at Settings from the last step', async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);
    await stepTo(user, 5);
    await user.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(getVerseUiState().section).toBe('settings');
    // Opening Settings does not answer the tour — it is still there to finish.
    expect(getOnboardingState().open).toBe(true);
  });
});

describe('OnboardingPanel — replay from Settings', () => {
  it('reopens the tour and reports that it had been skipped', async () => {
    const user = userEvent.setup();
    render(
      <>
        <OnboardingPanel />
        <OnboardingFlow />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss getting started' }));
    expect(screen.getByText(/Skipped\./)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Replay' }));
    expect(screen.getByText('Welcome to Verse')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Showing' })).toBeDisabled();
  });

  it('says when the tour was completed in the app’s relative wording, not a numeric date', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z');
    expect(describeOnboardingState('2026-09-24T11:55:00.000Z', null, now)).toBe('Last completed 5m ago.');
    const older = describeOnboardingState('2026-09-01T10:00:00.000Z', null, now);
    // A date reads "on <date>" in any locale ("on Sep 1" en-US, "on 1 Sept" en-GB) — never "1 Sept ago".
    expect(older).toMatch(/^Last completed on .+\.$/);
    expect(older).not.toMatch(/ago\.$/);
    if (new Intl.DateTimeFormat().resolvedOptions().locale === 'en-US') expect(older).toMatch(/^Last completed on \w{3} \d{1,2}\.$/);
    expect(older).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}|2026-09-01/);
  });

  it('names the next step when the tour has not been seen', () => {
    expect(describeOnboardingState(null, null)).toBe('Not seen yet. Replay it to take the two-minute tour.');
  });
});

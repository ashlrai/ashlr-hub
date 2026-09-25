import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AutonomySection } from './AutonomySection.js';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { AUDIT_ENTRIES, BOOTSTRAP, CAPS, SAFETY_REPORT, controlSnapshot } from './section-fixtures.test-support.js';
import { VERSE_KILL_SWITCH_NOTE } from '../autonomy/control-types.js';

const TOKEN = 'a'.repeat(64);

interface Routes {
  control?: unknown;
  caps?: unknown;
  scope?: unknown;
  bootstrap?: unknown;
  posts?: (url: string, body: unknown) => Response;
}

function stubFetch(routes: Routes = {}) {
  const posted: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      posted.push({ url, body });
      return routes.posts?.(url, body) ?? new Response(JSON.stringify({ ok: true, applied: CAPS, live: true }), { status: 200 });
    }
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.startsWith('/api/verse/control')) return json(routes.control ?? controlSnapshot());
    if (url.startsWith('/api/verse/caps')) return json(routes.caps ?? CAPS);
    if (url.startsWith('/api/verse/scope')) return json(routes.scope ?? { repos: [{ path: '/Users/m/code/hub', name: 'hub', exists: true }] });
    if (url.startsWith('/api/verse/audit')) return json({ entries: AUDIT_ENTRIES, truncated: false });
    if (url.startsWith('/api/verse/safety')) return json(SAFETY_REPORT);
    if (url.startsWith('/api/verse/bootstrap')) return json(routes.bootstrap ?? BOOTSTRAP);
    if (url.startsWith('/api/goals')) return json([]);
    if (url.startsWith('/api/backlog')) return json(null);
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, posted };
}

describe('AutonomySection', () => {
  beforeEach(() => {
    evictAll();
    clearMutationToken();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearMutationToken();
  });

  it('answers the five questions at a glance', async () => {
    stubFetch();
    render(<AutonomySection />);

    await waitFor(() => expect(screen.getByText('Running')).toBeInTheDocument());

    // Spend against the cap, as one line.
    expect(screen.getByText('$4.50 of $25.00 today · 18%')).toBeInTheDocument();
    expect(screen.getByText('$20.50 left today.')).toBeInTheDocument();
    // Direction mode and last tick outcome.
    expect(screen.getByText('auto-merge-ready')).toBeInTheDocument();
    expect(screen.getAllByText(/· ok$/).length).toBeGreaterThan(0);
    // Next tick is a live countdown derived from lastTickAt + intervalMs.
    expect(screen.getByText(/^in \d+m \d+s$/)).toBeInTheDocument();
    // Scope and the approvals queue.
    expect(screen.getByText('1 repo')).toBeInTheDocument();
    expect(screen.getByText('2 approvals')).toBeInTheDocument();
  });

  it('never calls the kill switch a pause, and says what else it disables', async () => {
    stubFetch();
    render(<AutonomySection />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Emergency stop' })).toBeInTheDocument());

    // DELIBERATE UPDATE (V2.1). This used to assert that the word "pause"
    // appeared NOWHERE in the section. That was the right rule while the only
    // thing it could have described was the global kill switch — but it also
    // meant the word was unavailable to the control that deserves it. There is
    // now a real daemon-scoped pause (`~/.ashlr/daemon.paused`), so the rule is
    // stated precisely instead of by blanket absence: the EMERGENCY STOP and
    // the ordinary STOP are never labelled "pause"; the narrow, reversible
    // halt is, and it is a button of its own.
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Emergency stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pause.*(kill|emergency)|emergency.*pause/i })).toBeNull();
    // The ordinary stop is a separate, differently-named control.
    expect(screen.getByRole('button', { name: 'Stop loop' })).toBeInTheDocument();

    setMutationToken(TOKEN);
    fireEvent.click(screen.getByRole('button', { name: 'Emergency stop' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/disables the agent’s own\s+write tools/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Engage emergency stop' })).toBeInTheDocument();
    // The emergency dialog explains itself without borrowing the pause's name.
    expect(within(dialog).getByRole('button', { name: 'Engage emergency stop' }).textContent?.toLowerCase())
      .not.toContain('pause');
  });

  it('refuses an out-of-range cap before the round trip', async () => {
    const { posted } = stubFetch();
    setMutationToken(TOKEN);
    render(<AutonomySection />);

    const input = await screen.findByLabelText('Items per tick');
    fireEvent.change(input, { target: { value: '51' } });
    fireEvent.blur(input);

    expect(await screen.findByText('Items per tick must be between 1 and 50 items.')).toBeInTheDocument();
    expect(posted.filter((p) => p.url === '/api/verse/caps')).toHaveLength(0);
  });

  it('commits a valid cap on blur and confirms it applied live', async () => {
    const { posted } = stubFetch();
    setMutationToken(TOKEN);
    render(<AutonomySection />);

    const input = await screen.findByLabelText('Parallel swarms');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);

    await waitFor(() => expect(posted).toContainEqual({ url: '/api/verse/caps', body: { parallel: 5 } }));
    expect(await screen.findByText('applied live')).toBeInTheDocument();
  });

  it('states that a daily budget of 0 is a stop, not "unlimited"', async () => {
    const zeroed = { ...CAPS, dailyBudgetUsd: 0 };
    stubFetch({ caps: zeroed, control: controlSnapshot({ caps: zeroed, spend: { todayUsd: 0, todayDate: '2026-09-19', dailyBudgetUsd: 0 } }) });
    render(<AutonomySection />);

    expect(await screen.findByText('Daily budget is 0 — the loop is stopped, not unlimited.')).toBeInTheDocument();
    expect(screen.getByText('Loop stopped — a budget of 0 is a stop, not "unlimited".')).toBeInTheDocument();
  });

  it('explains that an empty enrollment registry is the default, not a bug', async () => {
    stubFetch({ scope: { repos: [] }, control: controlSnapshot({ scope: { repos: [] } }) });
    render(<AutonomySection />);

    expect(await screen.findByText('No repositories are enrolled, so the daemon will do nothing.')).toBeInTheDocument();
    expect(screen.getByText(/That is the default and it is not a bug/)).toBeInTheDocument();
  });

  it('renders the audit trail and the safety checks with pass/fail per check', async () => {
    stubFetch();
    render(<AutonomySection />);

    expect(await screen.findByText('enrolled hub')).toBeInTheDocument();
    expect(screen.getByText('kill switch engaged')).toBeInTheDocument();
    expect(screen.getByText('3 entries · newest first')).toBeInTheDocument();

    expect(screen.getByText('4/5 passing')).toBeInTheDocument();
    expect(screen.getByText('gate moved below the client build')).toBeInTheDocument();
    // Failure is carried by text, not by colour alone.
    expect(screen.getByText('— failed')).toBeInTheDocument();
  });

  it('renders a server without dispatch as a read-only session, not a crash', async () => {
    stubFetch({ bootstrap: { ...BOOTSTRAP, dispatchEnabled: false } });
    render(<AutonomySection />);

    expect(await screen.findByText('Read-only session')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start loop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Emergency stop' })).toBeDisabled();
    // The observable half of the cockpit still renders.
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('withholds the run state rather than claiming "stopped" when the ledger is degraded', async () => {
    const snapshot = controlSnapshot();
    stubFetch({
      control: {
        ...snapshot,
        daemon: { ...snapshot.daemon, sourceQuality: { sourceState: 'degraded', complete: false, reason: 'inconsistent' } },
      },
    });
    render(<AutonomySection />);

    expect(await screen.findByText('Run state unknown')).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
    expect(screen.queryByText('Stopped')).not.toBeInTheDocument();
  });

  // The header names the SWITCH, not the button: `stopDaemon()` is
  // `setKill(true)`, so the ordinary "Stop loop" engages the same sentinel and
  // the snapshot cannot say which path set it.
  it('shows the kill switch as engaged and offers release when it is on', async () => {
    stubFetch({ control: controlSnapshot({ killSwitch: { state: 'active', sourceState: 'healthy', reason: 'present', note: VERSE_KILL_SWITCH_NOTE } }) });
    render(<AutonomySection />);

    expect(await screen.findByText('Kill switch engaged')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Release emergency stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start loop' })).toBeDisabled();
  });

  /**
   * The default config is the one Mason's server actually answers with:
   * readVerseCaps sends null for maxConcurrent and every concurrency tier when
   * config omits them. CapField used to pass `disabled={disabled || stored ===
   * null}`, so four of nine caps rendered as blank, permanently disabled
   * inputs — "not configured yet" was being treated as "nothing to show",
   * when it is the one state the control most needs to be editable in.
   */
  it('keeps unconfigured caps editable instead of dead', async () => {
    stubFetch({
      caps: { ...CAPS, maxConcurrent: null, concurrency: { local: null, cloud: null, total: null } },
    });
    setMutationToken(TOKEN);
    render(<AutonomySection />);

    for (const label of ['Max concurrent', 'Local tier', 'Cloud tier', 'All tiers']) {
      const field = await screen.findByLabelText(new RegExp(`^${label}`));
      expect(field, `${label} must render`).toBeInTheDocument();
      expect(field, `${label} must be editable when unconfigured`).not.toBeDisabled();
      expect(field).toHaveValue(null);
    }
    // A configured cap is unaffected.
    expect(await screen.findByLabelText(/^Items per tick/)).toHaveValue(4);
  });

  /**
   * `spend.todayUsd` belongs to `spend.todayDate`. The daemon writes the
   * figure once a day and leaves it, so a machine that last ticked weeks ago
   * answers `{todayUsd: 0, todayDate: "<old>"}` — and the header used to
   * render "$0.00 of $25.00 today · 0%" with a green meter from it.
   */
  it('refuses to call a stale ledger day "today"', async () => {
    stubFetch({
      control: controlSnapshot({
        spend: { todayUsd: 0, todayDate: '2026-09-01', dailyBudgetUsd: CAPS.dailyBudgetUsd },
      }),
    });
    render(<AutonomySection />);

    // Both the status header and the budget cap's usage line say it.
    // A calendar day, not the ledger's raw YYYY-MM-DD key.
    expect((await screen.findAllByText(/last ledger day is Sep 1\b/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/2026-09-01/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00 of \$25\.00 today/)).not.toBeInTheDocument();
    expect(screen.getByText(/— spent today/)).toBeInTheDocument();
  });

  /**
   * The control plane writes a careful refusal ladder and returns it as `note`
   * on a 409 body that has no `error` key. The client only read `error`, so
   * every refusal became the fixed, usually-false string "The server refused:
   * something else is already running."
   */
  it('shows the server’s own refusal sentence, not a guess', async () => {
    stubFetch({
      posts: (url) =>
        url === '/api/verse/daemon'
          ? new Response(
              JSON.stringify({
                ok: false,
                action: 'once',
                spawned: false,
                pid: null,
                note: 'Refused: no repositories are enrolled, so the loop would do nothing. Add scope first.',
              }),
              { status: 409 },
            )
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    setMutationToken(TOKEN);
    render(<AutonomySection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Run one tick' }));
    // The guard is shared, so every panel bound to it renders the message.
    expect(
      (await screen.findAllByText(/no repositories are enrolled, so the loop would do nothing/)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/something else is already running/)).not.toBeInTheDocument();
  });

  /**
   * `stopDaemon()` is `setKill(true)`: the ordinary stop engages the SAME
   * global sentinel as the emergency button. It used to fire straight from the
   * click with no confirm, and the returned note saying so was discarded.
   */
  it('confirms the ordinary stop and echoes what it actually did', async () => {
    const note =
      "Daemon stop requested. This sets the global kill switch, which also refuses the agent's own write tools until it is cleared.";
    const { posted } = stubFetch({
      posts: (url) =>
        url === '/api/verse/daemon'
          ? new Response(
              JSON.stringify({ ok: true, action: 'stop', spawned: false, pid: null, note }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    setMutationToken(TOKEN);
    render(<AutonomySection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Stop loop' }));
    // Nothing is posted until the confirm is accepted.
    expect(posted.filter((p) => p.url === '/api/verse/daemon')).toHaveLength(0);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/global kill switch/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop loop' }));

    await waitFor(() =>
      expect(posted.filter((p) => p.url === '/api/verse/daemon')).toHaveLength(1),
    );
    expect(await screen.findByText(note)).toBeInTheDocument();
  });

  /**
   * Granting autonomous scope had no confirm step while REMOVING it did — the
   * friction was on the safe half. Enrolment is what the contract calls "the
   * single biggest scope lever": it is the gate `isEnrolled()` checks before
   * the agent's mcp-native write tools will touch a directory. In the desktop
   * shell the mutation hold never expires, so an Enter keypress in the path
   * field was the whole flow.
   */
  it('confirms before granting autonomous scope, not only before removing it', async () => {
    const { posted } = stubFetch();
    setMutationToken(TOKEN);
    render(<AutonomySection />);

    const input = await screen.findByLabelText('Repository path to enroll');
    fireEvent.change(input, { target: { value: '/Users/m/code/new-repo' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Enter opens the confirm; it does not post.
    expect(posted.filter((p) => p.url === '/api/verse/scope')).toHaveLength(0);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('/Users/m/code/new-repo')).toBeInTheDocument();
    expect(within(dialog).getByText(/write tools will act on it/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Enroll repository' }));
    await waitFor(() =>
      expect(posted).toContainEqual({
        url: '/api/verse/scope',
        body: { action: 'enroll', path: '/Users/m/code/new-repo' },
      }),
    );
  });

  it('refuses ~/.ashlr before the round trip, as the server does', async () => {
    const { posted } = stubFetch();
    setMutationToken(TOKEN);
    render(<AutonomySection />);

    const input = await screen.findByLabelText('Repository path to enroll');
    fireEvent.change(input, { target: { value: '/Users/m/.ashlr' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText(/control directory/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posted.filter((p) => p.url === '/api/verse/scope')).toHaveLength(0);
  });

  it('surfaces a failed control read instead of rendering a guessed cockpit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/verse/control')) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify(BOOTSTRAP), { status: 200 });
      }),
    );
    render(<AutonomySection />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing below is shown rather than guessed/);
    expect(screen.queryByRole('button', { name: 'Start loop' })).not.toBeInTheDocument();
  });
});

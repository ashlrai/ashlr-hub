/**
 * CloudCard — Command's cloud lane card in each of its states (loading, not
 * in this build, empty, running, pr-open, failed, budget-refused), and its
 * writes going through Command's guarded actions: Improve Verse confirms
 * first, Dismiss confirms first, the self-improvement switch and the budget
 * popover send exactly what changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { useSurfaceActions } from '../command/actions.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { CloudCard } from './CloudCard.js';
import { ESTIMATE_NOTE, HOUR, budget, budgetView, json, overview, stubCloudFetch, task } from './cloud-fixtures.test-support.js';

const TOKEN = 'c'.repeat(64);

function Host() {
  const actions = useSurfaceActions();
  return (
    <>
      <CloudCard actions={actions} />
      {actions.dialogs}
    </>
  );
}

const card = () => screen.getByRole('region', { name: 'Cloud' });

beforeEach(() => {
  evictAll();
  resetActivityForTest(async () => { throw new Error('no activity in this test'); });
  clearMutationToken();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  resetActivityForTest();
});

describe('CloudCard states', () => {
  it('loading: says it is reading, with no numbers yet', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<Host />);
    expect(within(card()).getByText('Reading the cloud lane…')).toHaveAttribute('aria-busy', 'true');
    expect(within(card()).queryByRole('meter')).toBeNull();
    expect(within(card()).queryByRole('button', { name: 'New cloud task' })).toBeNull();
  });

  it('not in this build: one designed line, no buttons', async () => {
    stubCloudFetch(null);
    render(<Host />);
    expect(await within(card()).findByText('The cloud lane is not in this build yet.')).toBeInTheDocument();
    expect(within(card()).queryByRole('button')).toBeNull();
  });

  it('empty: the estimate meter, the note and link, the counts, and an invitation', async () => {
    stubCloudFetch(overview({ budget: budgetView({ estimatedSpentUsd: 38 }) }));
    render(<Host />);
    const meter = await within(card()).findByRole('meter', { name: /Estimated credits remaining/ });
    expect(meter).toHaveAttribute('aria-valuenow', '85');
    expect(within(card()).getByText('$212 of $250 · estimate')).toBeInTheDocument();
    expect(within(card()).getByText(ESTIMATE_NOTE, { exact: false })).toBeInTheDocument();
    expect(within(card()).getByRole('link', { name: 'Check the real balance on claude.ai' })).toHaveAttribute('href', 'https://claude.ai/settings/usage');
    expect(within(card()).getByText(/^3 of 20 sessions today · 0 running · resets /)).toBeInTheDocument();
    expect(within(card()).getByText('No cloud tasks yet. Start one with New cloud task, or let Verse improve itself.')).toBeInTheDocument();
    expect(within(card()).getByRole('switch', { name: 'Self-improvement' })).toHaveAttribute('aria-checked', 'true');
    expect(within(card()).getByRole('button', { name: 'New cloud task' })).toBeEnabled();
    expect(within(card()).getByRole('button', { name: 'Improve Verse' })).toBeEnabled();
    // No ISO instant reaches the page.
    expect(card().textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it('running: a state chip, the full title, where it runs, and the session link', async () => {
    const running = task('running', { title: 'Make the tracker transitions table-driven so every state change is covered by one test' });
    stubCloudFetch(overview({ tasks: [running], budget: budgetView({ running: 1 }) }));
    render(<Host />);
    const row = within(await within(card()).findByRole('list', { name: 'Cloud tasks' })).getByRole('listitem');
    expect(within(row).getByText('Running')).toBeInTheDocument();
    // Never cut mid-word: the whole title is there.
    expect(within(row).getByText(running.title)).toBeInTheDocument();
    expect(within(row).getByText('ashlrai/ashlr-hub from master · started 5m ago')).toBeInTheDocument();
    const open = within(row).getByRole('link', { name: `Open “${running.title}” in Claude` });
    expect(open).toHaveAttribute('href', running.sessionUrl);
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(within(card()).getByText(/1 running/)).toBeInTheDocument();
  });

  it('pr-open: the PR link and the report summary', async () => {
    const pr = task('pr-open', {
      pr: { number: 481, url: 'https://github.com/ashlrai/ashlr-hub/pull/481', state: 'open', draft: true, title: '[ashlr-cloud] fix' },
      report: { status: 'done', summary: 'Fixed the race in the tracker; 12 tests added.', testsRun: ['npm test'], risks: [] },
    });
    stubCloudFetch(overview({ tasks: [pr] }));
    render(<Host />);
    const row = within(await within(card()).findByRole('list', { name: 'Cloud tasks' })).getByRole('listitem');
    expect(within(row).getByText('Draft PR')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Pull request #481 on GitHub' })).toHaveAttribute('href', 'https://github.com/ashlrai/ashlr-hub/pull/481');
    expect(within(row).getByText('Cloud session reports (unverified): Fixed the race in the tracker; 12 tests added.')).toBeInTheDocument();
  });

  it('redacts a credential-shaped PR report before showing it on the Command cloud card', async () => {
    const secret = 'supersecretvalue123456';
    const pr = task('pr-open', {
      report: { status: 'done', summary: `Fixed the race. api_key=${secret}`, testsRun: [], risks: [] },
    });
    stubCloudFetch(overview({ tasks: [pr] }));
    render(<Host />);
    const row = within(await within(card()).findByRole('list', { name: 'Cloud tasks' })).getByRole('listitem');
    expect(within(row).getByText('Cloud session reports (unverified): Fixed the race. api_key=[REDACTED]')).toBeInTheDocument();
    expect(row.textContent).not.toContain(secret);
  });

  it('failed: the plain reason, no session link, and never a link to a foreign host', async () => {
    const failed = task('failed', { stateReason: 'Claude Code cloud sessions need a claude.ai login on the claude-a seat.', failure: 'auth' });
    const spoofed = task('running', { title: 'spoofed', sessionUrl: 'https://claude.ai.evil.example/code/session_x' });
    stubCloudFetch(overview({ tasks: [failed, spoofed] }));
    render(<Host />);
    const list = await within(card()).findByRole('list', { name: 'Cloud tasks' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(within(first!).getByText('Failed')).toBeInTheDocument();
    expect(within(first!).getByText('Claude Code cloud sessions need a claude.ai login on the claude-a seat.')).toBeInTheDocument();
    expect(within(first!).queryByRole('link')).toBeNull();
    expect(within(second!).queryByRole('link')).toBeNull();
  });

  it('budget-refused: the gate sentence is shown and both launch buttons are disabled with it as their tooltip', async () => {
    const reason = '20 of 20 sessions used today.';
    stubCloudFetch(overview({ budget: budgetView({ sessionsToday: 20, canLaunch: { ok: false, reason }, canSelfImprove: { ok: false, reason } }) }));
    const user = userEvent.setup();
    render(<Host />);
    expect(await within(card()).findByTestId('cloud-budget-refused')).toHaveTextContent(`New launches are paused: ${reason}`);
    const launch = within(card()).getByRole('button', { name: 'New cloud task' });
    expect(launch).toBeDisabled();
    expect(within(card()).getByRole('button', { name: 'Improve Verse' })).toBeDisabled();
    await user.hover(launch.parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(reason);
  });

  it('says so when the seat is not ready, and disables launching', async () => {
    stubCloudFetch(overview({ seat: { id: 'claude-a', ready: false, reason: "The Claude seat isn't set up on this Mac." } }));
    render(<Host />);
    expect(await within(card()).findByText("The Claude seat isn't set up on this Mac.")).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'New cloud task' })).toBeDisabled();
  });

  it('warns when the estimate is under the reserve', async () => {
    stubCloudFetch(overview({ budget: budgetView({ estimatedSpentUsd: 220 }) }));
    render(<Host />);
    expect(await within(card()).findByText('Under the $40 reserve, so Verse stops launching self-improvement tasks.')).toBeInTheDocument();
  });

  it('gives every icon button a tooltip', async () => {
    stubCloudFetch(overview());
    const user = userEvent.setup();
    render(<Host />);
    const refresh = await within(card()).findByRole('button', { name: 'Check GitHub for task updates now' });
    await user.hover(refresh);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Check GitHub for task updates now');
  });
});

describe('CloudCard actions', () => {
  it('Improve Verse confirms first, then launches the next backlog item and links the session', async () => {
    setMutationToken(TOKEN);
    const launched = task('running', { title: 'Tighten the tracker tests', origin: 'self-improve', requestedBy: 'self-improve' });
    const { posted } = stubCloudFetch(overview(), { post: (url) => (url.endsWith('/improve') ? json({ launched: [launched], skipped: [] }) : undefined) });
    const user = userEvent.setup();
    render(<Host />);
    await user.click(await within(card()).findByRole('button', { name: 'Improve Verse' }));
    const dialog = screen.getByRole('dialog', { name: 'Improve Verse now?' });
    expect(dialog).toHaveTextContent('Launches “Tighten the tracker tests” as a cloud session on ashlrai/ashlr-hub, estimated at $3.');
    expect(posted).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/cloud/improve', body: { count: 1 } }]));
    const status = await within(card()).findByRole('status');
    expect(status).toHaveTextContent('Started “Tighten the tracker tests”.');
    expect(within(status).getByRole('link', { name: /Open in Claude/ })).toHaveAttribute('href', launched.sessionUrl);
  });

  it('Improve Verse reports a skip in the server’s words', async () => {
    setMutationToken(TOKEN);
    stubCloudFetch(overview(), { post: () => json({ launched: [], skipped: [{ itemId: 'si-tests', reason: '4 of 4 self-improvement launches used today.' }] }) });
    const user = userEvent.setup();
    render(<Host />);
    await user.click(await within(card()).findByRole('button', { name: 'Improve Verse' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Launch' }));
    expect(await within(card()).findByRole('status')).toHaveTextContent('4 of 4 self-improvement launches used today.');
  });

  it('asks for the mutation token before any write when none is held', async () => {
    const { posted } = stubCloudFetch(overview());
    const user = userEvent.setup();
    render(<Host />);
    await user.click(await within(card()).findByRole('switch', { name: 'Self-improvement' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toHaveTextContent('Stop Verse launching its own self-improvement tasks.');
    expect(posted).toEqual([]);
  });

  it('the self-improvement switch sends only `enabled`', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubCloudFetch(overview());
    const user = userEvent.setup();
    render(<Host />);
    await user.click(await within(card()).findByRole('switch', { name: 'Self-improvement' }));
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/cloud/budget', body: { selfImprove: { enabled: false } } }]));
    expect(await within(card()).findByRole('status')).toHaveTextContent('Self-improvement is off.');
  });

  it('Edit budget opens a popover whose Save sends only the changed fields, then closes', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubCloudFetch(overview({ budget: budgetView({ budget: budget({ maxSessionsPerDay: 20 }) }) }));
    const user = userEvent.setup();
    render(<Host />);
    const edit = await within(card()).findByRole('button', { name: 'Edit budget' });
    expect(edit).toHaveAttribute('aria-expanded', 'false');
    await user.click(edit);
    const pop = screen.getByRole('dialog', { name: 'Cloud budget' });
    expect(edit).toHaveAttribute('aria-expanded', 'true');
    const perDay = within(pop).getByLabelText('Sessions per day');
    await user.clear(perDay);
    await user.type(perDay, '8');
    await user.click(within(pop).getByRole('button', { name: 'Save budget' }));
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/cloud/budget', body: { maxSessionsPerDay: 8 } }]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cloud budget' })).toBeNull());
  });

  it('the budget popover validates before sending and closes on Escape', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubCloudFetch(overview());
    const user = userEvent.setup();
    render(<Host />);
    await user.click(await within(card()).findByRole('button', { name: 'Edit budget' }));
    const pop = screen.getByRole('dialog', { name: 'Cloud budget' });
    const perSession = within(pop).getByLabelText('Estimate per session');
    await user.clear(perSession);
    await user.click(within(pop).getByRole('button', { name: 'Save budget' }));
    expect(within(pop).getByRole('alert')).toHaveTextContent('Enter a number.');
    expect(posted).toEqual([]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Cloud budget' })).toBeNull();
  });

  it('Dismiss confirms, says nothing on GitHub changes, and posts the task’s dismiss', async () => {
    setMutationToken(TOKEN);
    const expired = task('expired', { title: 'Old idea', stateReason: 'No PR after 6 hours.' }, Date.now(), 7 * HOUR);
    const { posted } = stubCloudFetch(overview({ tasks: [expired] }));
    const user = userEvent.setup();
    render(<Host />);
    await user.click(await within(card()).findByRole('button', { name: 'Dismiss “Old idea”' }));
    const dialog = screen.getByRole('dialog', { name: 'Dismiss this cloud task?' });
    expect(dialog).toHaveTextContent('Nothing on GitHub or claude.ai changes');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(posted).toEqual([{ url: `/api/verse/cloud/tasks/${expired.id}/dismiss`, body: {} }]));
  });

  it('the refresh button asks the server to re-read GitHub', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubCloudFetch(overview());
    const user = userEvent.setup();
    render(<Host />);
    await user.click(await within(card()).findByRole('button', { name: 'Check GitHub for task updates now' }));
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/cloud/refresh', body: {} }]));
  });
});

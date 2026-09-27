/**
 * NeedsYouDrawer — cloud PR triage (3.13). RTL + user-event.
 *
 *   - each cloud PR row carries its gate verdict: "Clean", or "Held · why";
 *   - "Land all clean" lands every Clean PR after ONE confirmation, each POST
 *     pinned to the head SHA its preview judged;
 *   - X picks rows and R then closes every pick (one confirmation, one token);
 *   - Shift-click picks without opening; the detail lists every check and
 *     opens the task's evidence timeline.
 *   - 3.15: Devin PR rows get the same chip, join "Land all clean" and open
 *     their own evidence route; a single Close takes an optional reason.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudPrPreview } from '../../../../core/cloud/pr-preview.js';
import { isNeedsYouItem, type NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { useVerseUi } from '../useVerseUi.js';
import { openVerseNeedsYou, resetVerseUi } from '../verse-ui-store.js';
import { GuardHost, resetGuard } from './guarded-action.js';
import { resetResolvedForTest } from './needs-you-actions.js';
import { NeedsYouDrawer } from './NeedsYouDrawer.js';
import { activity, fixtureNow, shellFetch, TOKEN } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function cloudNeed(taskId: string, pr: number, title: string, headSha: string, behind: boolean, lane: 'cloud' | 'devin' = 'cloud'): NeedsYouItem {
  const route = (verb: string) => ({ method: 'POST' as const, path: `/api/verse/${lane}/tasks/${taskId}/${verb}`, body: { headSha } });
  const item: NeedsYouItem = {
    id: `fleet:owner-lane-pr:${lane}-${taskId}`,
    source: 'fleet',
    kind: 'owner-lane-pr',
    severity: 'info',
    title: `Cloud task ready for review: ${title}`,
    detail: behind ? 'Held: 2 commits behind. Cloud session reports (unverified): Done.' : 'Clean: low risk, 1 file, 3 lines, checks green. Cloud session reports (unverified): Done.',
    since: new Date(fixtureNow() - 60 * 60_000).toISOString(),
    expiresAt: null,
    subject: { repo: 'ashlrai/ashlr-hub', pr, seatId: null, sessionId: null, engine: 'claude' },
    target: { kind: 'url', url: `https://github.com/ashlrai/ashlr-hub/pull/${pr}` },
    actions: [
      { kind: 'approve', label: 'Land', request: route('land'), confirm: { title: `Land #${pr} on master?`, body: 'Squash-merges.', confirmLabel: 'Land' }, destructive: false },
      { kind: 'reject', label: 'Close', request: route('close'), confirm: { title: `Close #${pr} without landing?`, body: 'Closes it.', confirmLabel: 'Close PR' }, destructive: true },
      ...(behind ? [{ kind: 'fix' as const, label: 'Update branch', request: route('update-branch'), confirm: null, destructive: false }] : []),
      { kind: 'done', label: 'Dismiss', request: { method: 'POST', path: `/api/verse/${lane}/tasks/${taskId}/dismiss`, body: {} }, confirm: null, destructive: false },
    ],
  };
  if (!isNeedsYouItem(item)) throw new Error('fixture is not a valid NeedsYouItem');
  return item;
}

function previewOf(taskId: string, pr: number, headSha: string, behind: boolean, lane: 'cloud' | 'devin' = 'cloud'): CloudPrPreview {
  return {
    taskId,
    itemId: `fleet:owner-lane-pr:${lane}-${taskId}`,
    prNumber: pr,
    headSha,
    baseBranch: 'master',
    open: true,
    wouldAutoLand: !behind,
    reason: behind ? 'Held: 2 commits behind.' : 'Clean: low risk, 1 file, 3 lines, checks green.',
    landable: { ok: true, reason: null },
    behind,
    checks: [
      { id: 'protected', ok: true, text: 'No protected paths' },
      { id: 'scope', ok: true, text: 'Low risk · 1 file · 3 lines' },
      behind ? { id: 'behind', ok: false, text: '2 commits behind' } : { id: 'behind', ok: true, text: 'Up to date with master' },
      { id: 'ci', ok: true, text: 'Checks green' },
    ],
    computedAt: new Date(fixtureNow()).toISOString(),
  };
}

const CLEAN = cloudNeed('ct_20260926T1100_clean1', 42, 'Tidy the drawer', SHA_A, false);
const HELD = cloudNeed('ct_20260926T1100_held01', 43, 'Split the model', SHA_B, true);
const PREVIEWS = [previewOf('ct_20260926T1100_clean1', 42, SHA_A, false), previewOf('ct_20260926T1100_held01', 43, SHA_B, true)];

function Harness() {
  const ui = useVerseUi();
  return (
    <>
      {ui.overlay === 'needs-you' ? <NeedsYouDrawer /> : null}
      <GuardHost />
    </>
  );
}

let cloudPosts: Array<{ path: string; body: unknown }>;
let reads: string[];

const DEVIN_ID = 'dv_20260927T0400_devin1';
const DEVIN_CLEAN = cloudNeed(DEVIN_ID, 44, 'Add a CSV export', SHA_A, false, 'devin');
const DEVIN_PREVIEWS = [previewOf(DEVIN_ID, 44, SHA_A, false, 'devin')];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(opts: { needsYou?: NeedsYouItem[]; devinPreviews?: CloudPrPreview[] | 404 } = {}) {
  const net = shellFetch(activity({ needsYou: opts.needsYou ?? [CLEAN, HELD] }));
  cloudPosts = [];
  reads = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString();
    if (path === '/api/verse/cloud/previews') {
      return json({ generatedAt: new Date(fixtureNow()).toISOString(), previews: PREVIEWS });
    }
    if (path === '/api/verse/devin/previews') {
      const devin = opts.devinPreviews ?? 404;
      return devin === 404 ? json({ error: 'not found' }, 404) : json({ generatedAt: new Date(fixtureNow()).toISOString(), previews: devin });
    }
    if (/^\/api\/verse\/(cloud|devin)\/tasks\/[^/]+\/timeline$/.test(path)) {
      reads.push(path);
      return json({ error: 'No task with that id.' }, 404);
    }
    if (/^\/api\/verse\/(cloud|devin)\/tasks\//.test(path) && init?.method === 'POST') {
      cloudPosts.push({ path, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      return json({ ok: true });
    }
    return net.fetch(input, init);
  }));
  resetActivityForTest();
}

async function openDrawer() {
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
  act(() => openVerseNeedsYou({ split: 'all' }));
  await screen.findByRole('dialog', { name: /Needs you/ });
  return screen.findByRole('listbox');
}

const row = (text: RegExp) => screen.getAllByRole('option').find((o) => text.test(o.textContent ?? ''))!;

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseUi();
  resetGuard();
  resetResolvedForTest();
  clearMutationToken();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
});

afterEach(() => {
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  resetActivityForTest();
});

describe('cloud PR triage in the drawer', () => {
  it('shows each PR’s verdict as a word on its row', async () => {
    setup();
    await openDrawer();
    await waitFor(() => expect(within(row(/Tidy the drawer/)).getByText('Clean')).toBeInTheDocument());
    expect(within(row(/Split the model/)).getByText('Held')).toBeInTheDocument();
    expect(within(row(/Split the model/)).getByText(/2 commits behind/)).toBeInTheDocument();
  });

  it('"Land all clean" confirms once, then lands only the Clean PR at its checked head', async () => {
    setup();
    act(() => setMutationToken(TOKEN));
    const user = userEvent.setup();
    await openDrawer();
    const bar = await screen.findByRole('toolbar', { name: 'Cloud pull requests' });
    expect(within(bar).getByText('1 clean cloud PR')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Land all clean' }));
    const confirm = await screen.findByRole('dialog', { name: 'Land 1 pull request?' });
    expect(cloudPosts).toEqual([]);
    await user.click(within(confirm).getByRole('button', { name: 'Land 1' }));
    await waitFor(() => expect(cloudPosts).toEqual([{ path: '/api/verse/cloud/tasks/ct_20260926T1100_clean1/land', body: { headSha: SHA_A } }]));
    expect(await screen.findByText('Land: 1 of 1 done.')).toBeInTheDocument();
  });

  it('X picks rows; R then closes every pick after one confirmation', async () => {
    setup();
    act(() => setMutationToken(TOKEN));
    const user = userEvent.setup();
    await openDrawer();
    await user.keyboard('x');
    await user.keyboard('j');
    await user.keyboard('x');
    const bar = await screen.findByRole('toolbar', { name: 'Picked items' });
    expect(within(bar).getByText('2 picked')).toBeInTheDocument();
    // Update branch is offered for the one pick that is behind, with its count.
    expect(within(bar).getByRole('button', { name: /Update branch 1/ })).toBeInTheDocument();
    await user.keyboard('r');
    const confirm = await screen.findByRole('dialog', { name: 'Close 2 pull requests?' });
    await user.click(within(confirm).getByRole('button', { name: 'Close 2' }));
    await waitFor(() => expect(cloudPosts.map((p) => p.path)).toEqual([
      '/api/verse/cloud/tasks/ct_20260926T1100_clean1/close',
      '/api/verse/cloud/tasks/ct_20260926T1100_held01/close',
    ]));
    expect(cloudPosts.map((p) => p.body)).toEqual([{ headSha: SHA_A }, { headSha: SHA_B }]);
  });

  it('Shift-click picks without opening; the detail lists every check', async () => {
    setup();
    const user = userEvent.setup();
    await openDrawer();
    await user.keyboard('{Shift>}');
    await user.click(row(/Split the model/));
    await user.keyboard('{/Shift}');
    expect(screen.getByRole('toolbar', { name: 'Picked items' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Gate preview' })).not.toBeInTheDocument();
    await user.click(row(/Split the model/));
    const verdict = await screen.findByRole('region', { name: 'Gate preview' });
    expect(within(verdict).getByText('2 commits behind')).toBeInTheDocument();
    expect(within(verdict).getByText('No protected paths')).toBeInTheDocument();
    expect(within(verdict).getByText('bbbbbbb')).toBeInTheDocument();
  });

  it('a cloud item opens its evidence timeline from the detail', async () => {
    setup();
    const user = userEvent.setup();
    await openDrawer();
    await user.click(row(/Tidy the drawer/));
    await user.click(await screen.findByRole('button', { name: 'Evidence' }));
    expect(await screen.findByRole('dialog', { name: 'Evidence' })).toBeInTheDocument();
  });
});

describe('3.15: Devin PR rows and the close reason', () => {
  it('a Devin row gets its Clean chip and joins "Land all clean", which lands it on its own route', async () => {
    setup({ needsYou: [CLEAN, HELD, DEVIN_CLEAN], devinPreviews: DEVIN_PREVIEWS });
    act(() => setMutationToken(TOKEN));
    const user = userEvent.setup();
    await openDrawer();
    await waitFor(() => expect(within(row(/Add a CSV export/)).getByText('Clean')).toBeInTheDocument());
    const bar = await screen.findByRole('toolbar', { name: 'Pull requests' });
    expect(within(bar).getByText('2 clean PRs')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Land all clean' }));
    const confirm = await screen.findByRole('dialog', { name: 'Land 2 pull requests?' });
    await user.click(within(confirm).getByRole('button', { name: 'Land 2' }));
    await waitFor(() => expect(cloudPosts).toEqual([
      { path: '/api/verse/cloud/tasks/ct_20260926T1100_clean1/land', body: { headSha: SHA_A } },
      { path: `/api/verse/devin/tasks/${DEVIN_ID}/land`, body: { headSha: SHA_A } },
    ]));
  });

  it('with Devin off (its previews 404) the cloud chips still show and the Devin row simply has none', async () => {
    setup({ needsYou: [CLEAN, DEVIN_CLEAN], devinPreviews: 404 });
    await openDrawer();
    await waitFor(() => expect(within(row(/Tidy the drawer/)).getByText('Clean')).toBeInTheDocument());
    expect(within(row(/Add a CSV export/)).queryByText('Clean')).not.toBeInTheDocument();
    expect(within(await screen.findByRole('toolbar', { name: 'Cloud pull requests' })).getByText('1 clean cloud PR')).toBeInTheDocument();
  });

  it('a Devin item opens its evidence from the Devin timeline route', async () => {
    setup({ needsYou: [DEVIN_CLEAN], devinPreviews: DEVIN_PREVIEWS });
    const user = userEvent.setup();
    await openDrawer();
    await user.click(row(/Add a CSV export/));
    await user.click(await screen.findByRole('button', { name: 'Evidence' }));
    expect(await screen.findByRole('dialog', { name: 'Evidence' })).toBeInTheDocument();
    await waitFor(() => expect(reads).toEqual([`/api/verse/devin/tasks/${DEVIN_ID}/timeline`]));
  });

  it('a single Close takes an optional one-line reason that rides in the POST body', async () => {
    setup();
    act(() => setMutationToken(TOKEN));
    const user = userEvent.setup();
    await openDrawer();
    await user.click(row(/Tidy the drawer/));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    const confirm = await screen.findByRole('dialog', { name: 'Close #42 without landing?' });
    const field = within(confirm).getByRole('textbox', { name: 'Why? (optional)' });
    expect(field).toHaveAttribute('maxlength', '200');
    await user.type(field, '  Wrong approach; reuse the list  ');
    await user.click(within(confirm).getByRole('button', { name: 'Close PR' }));
    await waitFor(() => expect(cloudPosts).toEqual([
      { path: '/api/verse/cloud/tasks/ct_20260926T1100_clean1/close', body: { headSha: SHA_A, reason: 'Wrong approach; reuse the list' } },
    ]));
  });

  it('a Close with nothing typed sends no reason key', async () => {
    setup();
    act(() => setMutationToken(TOKEN));
    const user = userEvent.setup();
    await openDrawer();
    await user.click(row(/Tidy the drawer/));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    const confirm = await screen.findByRole('dialog', { name: 'Close #42 without landing?' });
    await user.click(within(confirm).getByRole('button', { name: 'Close PR' }));
    await waitFor(() => expect(cloudPosts).toEqual([
      { path: '/api/verse/cloud/tasks/ct_20260926T1100_clean1/close', body: { headSha: SHA_A } },
    ]));
  });
});

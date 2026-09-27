/**
 * Automations (3.15) — the section against a stubbed server: the list with
 * last fired / next run / queue / spend / success, on/off, Run now, Dry run,
 * create from a template, edit, delete (confirmed), recent firings with
 * links back to their sources, the blocked banner, and the ⌘K hand-off.
 * Plus the pure model (form ⇄ definition, wording, tones).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  AutomationFireResponse,
  AutomationFiringV1,
  AutomationsOverviewResponse,
  AutomationTemplate,
  AutomationV1,
} from '../../../../core/automations/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN, type RecordedCall } from '../context/context-fixtures.test-support.js';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import { AutomationsView } from './AutomationsView.js';
import { requestAutomationsFocus, resetAutomationsFocus } from './automations-focus.js';
import { firingTone, formFrom, inputFromForm, relativeTime, safeHref, spendLabel, successLabel } from './automations-model.js';

const NOW = Date.now();
const iso = (deltaMin: number): string => new Date(NOW + deltaMin * 60_000).toISOString();

const template: AutomationTemplate = {
  id: 'fix-labeled-issues',
  name: 'Fix issues labeled ashlr',
  blurb: 'Every open issue labelled ashlr becomes one fleet task.',
  input: {
    name: 'Fix issues labeled ashlr',
    enabled: false,
    trigger: { kind: 'github-issues', labels: ['ashlr'], query: null, includePrs: false, pollMinutes: 15 },
    lane: 'fleet',
    playbookId: null,
    repos: ['*'],
    instructions: 'Fix the issue.',
    maxConcurrent: 2,
    maxPerDay: 6,
    queueDepth: 20,
    spendCapUsd: 0,
    dedupeKey: null,
    triage: null,
  },
};

const automation: AutomationV1 = {
  ...template.input,
  v: 1,
  id: 'au_nightly',
  name: 'Nightly flaky test hunt',
  enabled: true,
  trigger: { kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=2' },
  lane: 'cloud',
  repos: ['acme/app'],
  spendCapUsd: 60,
  createdAt: iso(-600),
  updatedAt: iso(-600),
};

const firing: AutomationFiringV1 = {
  v: 1,
  id: 'af_20260927T020000_abcdef',
  automationId: 'au_nightly',
  dedupeKey: 'acme/app@x',
  source: { kind: 'github-issues', url: 'https://github.com/acme/app/issues/12', ref: '#12' },
  repo: 'acme/app',
  title: 'Issue #12: Flaky login test',
  text: '',
  lane: 'cloud',
  playbookId: null,
  state: 'dispatched',
  reason: 'Claude cloud session started.',
  laneRef: { lane: 'cloud', id: 'ct_20260927T0200_abcdef', url: 'https://claude.ai/code/session_1' },
  spendUsd: 3,
  attempts: 1,
  createdAt: iso(-30),
  dispatchedAt: iso(-30),
  settledAt: null,
  updatedAt: iso(-30),
};

function overview(patch: Partial<AutomationsOverviewResponse> = {}): AutomationsOverviewResponse {
  return {
    generatedAt: iso(0),
    automations: [{
      automation,
      triggerSummary: 'Every day at 02:00 on acme/app',
      stats: { lastFiredAt: iso(-30), nextRunAt: iso(120), queued: 1, active: 1, firedToday: 1, spentThisMonthUsd: 3, successRate: 0.75, succeeded: 3, failed: 1, lastError: null },
    }],
    firings: [firing],
    templates: [template],
    blocked: null,
    schedulerRunning: true,
    ...patch,
  };
}

function server(over: { view?: () => AutomationsOverviewResponse; fire?: AutomationFireResponse; onPost?: (c: RecordedCall) => void } = {}) {
  return installFetch((call) => {
    if (call.method === 'POST') over.onPost?.(call);
    if (call.path === '/api/verse/automations' && call.method === 'GET') return json(over.view ? over.view() : overview());
    if (call.path === '/api/verse/automations' && call.method === 'POST') return json({ automation: { ...automation, id: 'au_fix-issues-labeled-ashlr', name: (call.body as { name: string }).name, enabled: false } }, 201);
    if (call.path === '/api/verse/automations/au_nightly' && call.method === 'POST') return json({ automation });
    if (call.path === '/api/verse/automations/au_nightly/disable') return json({ automation: { ...automation, enabled: false } });
    if (call.path === '/api/verse/automations/au_nightly/delete') return json({ ok: true });
    if (call.path === '/api/verse/automations/au_nightly/fire') {
      return json(over.fire ?? { ok: true, dryRun: false, planned: [], firings: [firing], error: null });
    }
    return json({ error: 'not found' }, 404);
  });
}

beforeEach(() => {
  evictAll();
  resetVerseUi();
  resetAutomationsFocus();
  setMutationToken(TEST_TOKEN);
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

describe('automations-model', () => {
  it('maps a template to a form and back', () => {
    const form = formFrom(template.input);
    expect(form).toMatchObject({ name: 'Fix issues labeled ashlr', triggerKind: 'github-issues', labels: 'ashlr', repos: '*', pollMinutes: '15' });
    const shaped = inputFromForm({ ...form, labels: 'ashlr, ashlr:devin', repos: 'acme/app, acme/web', spendCapUsd: '12.5' });
    expect(shaped.ok && shaped.input).toMatchObject({
      trigger: { kind: 'github-issues', labels: ['ashlr', 'ashlr:devin'], query: null, includePrs: false, pollMinutes: 15 },
      repos: ['acme/app', 'acme/web'],
      spendCapUsd: 12.5,
      triage: null,
    });
    expect(inputFromForm({ ...form, name: ' ' })).toEqual({ ok: false, error: 'Give the automation a name.' });
    expect(inputFromForm({ ...form, repos: '' }).ok).toBe(false);
    expect(inputFromForm({ ...form, maxPerDay: 'lots' })).toEqual({ ok: false, error: 'Max per day must be a number.' });
    const schedule = inputFromForm({ ...form, triggerKind: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
    expect(schedule.ok && schedule.input['trigger']).toEqual({ kind: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
  });

  it('words times, spend, success and tones', () => {
    expect(relativeTime(null, NOW)).toBe('—');
    expect(relativeTime(iso(12), NOW)).toBe('in 12 min');
    expect(relativeTime(iso(-180), NOW)).toBe('3 h ago');
    expect(successLabel({ successRate: null } as never)).toBe('no results yet');
    expect(successLabel({ successRate: 0.75, succeeded: 3, failed: 1 } as never)).toBe('75% (3 of 4)');
    expect(spendLabel({ lane: 'cloud', spendCapUsd: 60 }, { spentThisMonthUsd: 3 } as never)).toBe('$3.00 of $60.00 this month');
    expect(spendLabel({ lane: 'fleet', spendCapUsd: 0 }, { spentThisMonthUsd: 0 } as never)).toBe('no paid spend');
    expect(firingTone('failed')).toBe('danger');
    expect(firingTone('awaiting-review')).toBe('warning');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://github.com/x')).toBe('https://github.com/x');
  });
});

describe('<AutomationsView>', () => {
  it('lists automations with their numbers and recent firings linked to their sources', async () => {
    server();
    render(<AutomationsView />);
    const row = await screen.findByText('Nightly flaky test hunt');
    const item = row.closest('li')!;
    expect(within(item).getByText('Every day at 02:00 on acme/app')).toBeTruthy();
    expect(within(item).getByText('30 min ago')).toBeTruthy();
    expect(within(item).getByText('in 2 h')).toBeTruthy();
    expect(within(item).getByText('1 of 20')).toBeTruthy();
    expect(within(item).getByText('$3.00 of $60.00 this month')).toBeTruthy();
    expect(within(item).getByText('75% (3 of 4)')).toBeTruthy();
    expect(within(item).getByText('Claude cloud')).toBeTruthy();
    const firings = screen.getByRole('region', { name: 'Recent firings' });
    const link = within(firings).getByRole('link', { name: 'Issue #12: Flaky login test' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/app/issues/12');
    expect(within(firings).getByRole('link', { name: 'open task' }).getAttribute('href')).toBe('https://claude.ai/code/session_1');
  });

  it('shows why nothing dispatches', async () => {
    server({ view: () => overview({ blocked: 'Stop is on (KILL) — automations dispatch nothing until it is cleared.' }) });
    render(<AutomationsView />);
    expect(await screen.findByText(/Stop is on \(KILL\)/)).toBeTruthy();
  });

  it('switches an automation off, runs it now, and dry-runs it', async () => {
    const posts: RecordedCall[] = [];
    server({ onPost: (c) => posts.push(c) });
    render(<AutomationsView />);
    await screen.findByText('Nightly flaky test hunt');
    fireEvent.click(screen.getByRole('switch', { name: 'Nightly flaky test hunt on' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain('/api/verse/automations/au_nightly/disable'));
    expect(posts[0]!.headers['x-ashlr-token']).toBe(TEST_TOKEN);

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/Nightly flaky test hunt: 1 sent, 0 queued/)).toBeTruthy();
    expect(posts.at(-1)!.body).toEqual({});
  });

  it('dry run shows the plan and says nothing was sent', async () => {
    const posts: RecordedCall[] = [];
    server({
      onPost: (c) => posts.push(c),
      fire: { ok: true, dryRun: true, planned: [{ dedupeKey: 'k', repo: 'acme/app', title: 'Nightly — acme/app', lane: 'cloud', verdict: 'dispatch to cloud' }], firings: [], error: null },
    });
    render(<AutomationsView />);
    await screen.findByText('Nightly flaky test hunt');
    fireEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    const card = await screen.findByRole('region', { name: 'Dry run: Nightly flaky test hunt' });
    expect(within(card).getByText(/dispatch to cloud/)).toBeTruthy();
    expect(within(card).getByText('Nothing was sent or recorded.')).toBeTruthy();
    expect(posts[0]!.body).toEqual({ dryRun: true });
  });

  it('creates from a template with a simple form', async () => {
    const posts: RecordedCall[] = [];
    server({ onPost: (c) => posts.push(c) });
    render(<AutomationsView />);
    await screen.findByText('Nightly flaky test hunt');
    fireEvent.click(screen.getByRole('button', { name: 'New automation' }));
    const form = screen.getByRole('form', { name: 'New automation' });
    fireEvent.change(within(form).getByLabelText('Repos'), { target: { value: 'acme/app' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Fix ashlr issues' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['/api/verse/automations']));
    expect(posts[0]!.body).toMatchObject({
      name: 'Fix ashlr issues',
      lane: 'fleet',
      repos: ['acme/app'],
      trigger: { kind: 'github-issues', labels: ['ashlr'] },
    });
    expect(await screen.findByText(/Created Fix ashlr issues \(off/)).toBeTruthy();
  });

  it('edits in place and confirms before deleting', async () => {
    const posts: RecordedCall[] = [];
    server({ onPost: (c) => posts.push(c) });
    render(<AutomationsView />);
    await screen.findByText('Nightly flaky test hunt');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit Nightly flaky test hunt' });
    expect((within(form).getByLabelText('Schedule (RRULE, local time)') as HTMLInputElement).value).toBe('FREQ=DAILY;BYHOUR=2');
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['/api/verse/automations/au_nightly']));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(posts).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Nightly flaky test hunt' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain('/api/verse/automations/au_nightly/delete'));
  });

  it('an empty list offers the templates', async () => {
    server({ view: () => overview({ automations: [], firings: [] }) });
    render(<AutomationsView />);
    expect(await screen.findByText('No automations yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fix issues labeled ashlr' }));
    expect(screen.getByRole('form', { name: 'New automation' })).toBeTruthy();
  });

  it('⌘K "New automation…" opens the section with the form', async () => {
    server();
    requestAutomationsFocus('new');
    expect(getVerseUiState().section).toBe('automations');
    render(<AutomationsView />);
    expect(await screen.findByRole('form', { name: 'New automation' })).toBeTruthy();
  });
});

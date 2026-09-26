/**
 * The evidence timeline (3.13): the pure model (badges, narrowing, summary)
 * and the sheet — opened from a cloud task row on Command's card, every step
 * rendered in order with a trust WORD, the report always a Claim, links only
 * to GitHub / claude.ai, and a server without the route saying so plainly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloudTimelinePath, TIMELINE_STEP_ORDER, type CloudTimelineResponse, type TimelineStep } from '../../../../core/cloud/timeline-types.js';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { useSurfaceActions } from '../command/actions.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { CloudCard } from './CloudCard.js';
import { EvidenceTimeline } from './EvidenceTimeline.js';
import { overview, stubCloudFetch, task } from './cloud-fixtures.test-support.js';
import { badgeFor, narrowTimeline, timelineSummary } from './timeline-model.js';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const ID = 'ct_20260925T1200_abc123';

function step(kind: TimelineStep['kind'], over: Partial<TimelineStep> = {}): TimelineStep {
  return { kind, at: null, title: `${kind} title`, detail: '', source: 'test source', verified: 'unknown', reached: true, ...over };
}

function timeline(over: Partial<CloudTimelineResponse> = {}): CloudTimelineResponse {
  const steps = TIMELINE_STEP_ORDER.map((kind) => step(kind));
  steps[0] = step('objective', { verified: true, title: 'Fix the flaky tracker test', detail: 'From New cloud task, requested by mason.', at: '2026-09-26T10:00:00.000Z', source: 'cloud task record' });
  steps[3] = step('report', { verified: false, title: 'Session reports “done” (unverified)', detail: 'Fixed the race.', source: 'session report (a claim, not evidence)' });
  steps[4] = step('pr', { verified: true, title: 'PR #512 open (draft)', link: { href: 'https://github.com/ashlrai/ashlr-hub/pull/512', label: 'PR #512' } });
  steps[9] = step('release', { verified: 'unknown', reached: false, title: 'Release unknown' });
  steps[11] = step('cost', { verified: false, title: '$3 estimated', link: { href: 'https://claude.ai/settings/usage', label: 'Check usage on claude.ai' } });
  return { v: 1, generatedAt: '2026-09-26T12:00:00.000Z', taskId: ID, repo: 'ashlrai/ashlr-hub', title: 'Fix the flaky tracker test', state: 'pr-open', steps, ...over };
}

beforeEach(() => {
  evictAll();
  resetActivityForTest(async () => { throw new Error('no activity in this test'); });
  clearMutationToken();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetActivityForTest();
});

describe('timeline-model', () => {
  it('false is a Claim — or an Estimate for the cost — never Verified', () => {
    expect(badgeFor({ kind: 'report', verified: false })).toBe('claim');
    expect(badgeFor({ kind: 'cost', verified: false })).toBe('estimate');
    expect(badgeFor({ kind: 'merge', verified: true })).toBe('verified');
    expect(badgeFor({ kind: 'release', verified: 'unknown' })).toBe('unknown');
  });

  it('narrowTimeline drops malformed and unknown steps, and links to foreign hosts', () => {
    const raw = {
      ...timeline(),
      steps: [
        step('objective', { verified: true }),
        { kind: 'mystery', at: null, title: 'x', detail: '', source: 's', verified: true, reached: true },
        { kind: 'pr', at: null, title: 'x', detail: '', source: 's', verified: 'maybe', reached: true },
        step('pr', { link: { href: 'https://evil.example/pull/1', label: 'PR' } }),
      ],
    };
    const t = narrowTimeline(raw);
    expect(t?.steps.map((s) => s.kind)).toEqual(['objective', 'pr']);
    expect(t?.steps[1]?.link).toBeUndefined();
    expect(narrowTimeline({ v: 2, taskId: ID, steps: [] })).toBeNull();
    expect(narrowTimeline(null)).toBeNull();
  });

  it('the summary counts only reached stages', () => {
    const s = timelineSummary(timeline().steps);
    // objective + pr verified; report + cost claims; the other reached steps unknown; release not reached.
    expect(s).toMatchObject({ verified: 2, claims: 2, unknown: 7 });
    expect(s.text).toBe('2 verified · 2 claims or estimates · 7 unknown');
  });
});

describe('EvidenceTimeline', () => {
  it('renders every step in order with its trust word, source and links', async () => {
    stubCloudFetch(null, { routes: { [cloudTimelinePath(ID)]: timeline() } });
    render(<EvidenceTimeline taskId={ID} title="Fix the flaky tracker test" open onClose={() => {}} now={NOW} />);
    const list = await screen.findByRole('list', { name: 'Evidence, from objective to cost' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-kind'))).toEqual([...TIMELINE_STEP_ORDER]);
    const report = items[3]!;
    expect(report).toHaveAttribute('data-badge', 'claim');
    expect(within(report).getByText('Claim')).toBeInTheDocument();
    expect(within(report).getByText('session report (a claim, not evidence)')).toBeInTheDocument();
    expect(within(items[0]!).getByText('✓ Verified')).toBeInTheDocument();
    expect(within(items[0]!).getByText('2h ago')).toBeInTheDocument();
    expect(within(items[11]!).getByText('Estimate')).toBeInTheDocument();
    expect(items[9]).toHaveAttribute('data-reached', 'false');
    const pr = within(items[4]!).getByRole('link', { name: /PR #512/ });
    expect(pr).toHaveAttribute('href', 'https://github.com/ashlrai/ashlr-hub/pull/512');
    expect(pr).toHaveAttribute('rel', 'noreferrer noopener');
    expect(screen.getByText('2 verified · 2 claims or estimates · 7 unknown')).toBeInTheDocument();
  });

  it('a server without the route says so, in words', async () => {
    stubCloudFetch(null);
    render(<EvidenceTimeline taskId={ID} title="Fix" open onClose={() => {}} now={NOW} />);
    expect(await screen.findByRole('note')).toHaveTextContent('Verse has no evidence for this task');
  });

  it('never requests a path for an id Verse did not issue', async () => {
    const stub = stubCloudFetch(null);
    render(<EvidenceTimeline taskId="../../etc" title="Fix" open onClose={() => {}} now={NOW} />);
    expect(await screen.findByRole('note')).toHaveTextContent('That task id is not one Verse issued.');
    expect(stub.fetchMock).not.toHaveBeenCalled();
  });

  it('opens from a task row on Command’s cloud card and closes again', async () => {
    const t = task('pr-open', { id: ID, pr: { number: 512, url: 'https://github.com/ashlrai/ashlr-hub/pull/512', state: 'open', draft: true, title: 'Fix' } });
    const stub = stubCloudFetch(overview({ tasks: [t] }), { routes: { [cloudTimelinePath(ID)]: timeline() } });
    function Host() {
      const actions = useSurfaceActions();
      return <CloudCard actions={actions} />;
    }
    render(<Host />);
    const open = await screen.findByRole('button', { name: `Evidence for “${t.title}”` });
    // Nothing is read until the operator asks.
    expect(stub.fetchMock.mock.calls.some(([u]) => String(u).includes('/timeline'))).toBe(false);
    await userEvent.click(open);
    const sheet = await screen.findByRole('dialog', { name: 'Evidence' });
    await within(sheet).findByRole('list', { name: 'Evidence, from objective to cost' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Evidence' })).toBeNull());
  });
});

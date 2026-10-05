import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { AdoptionPanel } from './AdoptionPanel.js';
import { GrowthSection } from '../sections/GrowthSection.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { mockCompactViewport, mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { showTable } from '../../../components/charts/chart-test-support.js';
import { narrowAdoption, trafficDays } from './adoption-model.js';
import { ADOPTION_TARGET, type AdoptionSnapshot, type AdoptionReading } from '../../../../core/verse/adoption-types.js';

let vp: ViewportMock;
beforeEach(() => { evictAll(); vp = mockWideViewport(); });
afterEach(() => { vi.unstubAllGlobals(); vp.restore(); });
const observedAt = '2026-10-05T12:00:00Z';
function ready<T>(value: T): AdoptionReading<T> { return { state: 'ready', value, observedAt, checkedAt: observedAt, refreshing: false, stale: false, reason: null, retryAt: null }; }
function fixture(): AdoptionSnapshot {
  const warming = () => ({ state: 'warming' as const, value: null, observedAt: null, checkedAt: null, refreshing: false, stale: false, reason: null, retryAt: null });
  const sources = { repository: warming(), npm: warming(), views: warming(), clones: warming(), release: warming() };
  return { v: 1, target: ADOPTION_TARGET, sources: {
    ...sources,
    repository: ready({ repo: ADOPTION_TARGET.repo, stars: 0, forks: 7 }),
    npm: ready({ packageName: ADOPTION_TARGET.packageName, start: '2026-09-01', end: '2026-09-30', days: Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, count: i })), complete: true, total: 435 }),
    views: { ...sources.views, state: 'unavailable', reason: 'permission', checkedAt: observedAt },
    clones: ready({ count: 3, uniques: 2, window: 'provider-last-14-days-utc', days: [{ day: '2026-10-02', count: 0, uniques: 0 }, { day: '2026-10-04', count: 3, uniques: 2 }] }),
    release: ready({ id: 5, tag: 'v3.22.2', publishedAt: observedAt, coverage: 'latest-published-release-only', assets: [{ id: 10, name: 'Ashlr.dmg', count: 3 }, { id: 11, name: 'receipt.json', count: 2 }] }),
  } };
}
// Fixture values stay DTO-only; no core collector imports on the browser path.
function routes(data: unknown) { stubSurfaceFetch({ kind: 'dark', routes: { '/api/verse/adoption': data } }); }

describe('Adoption source projection', () => {
  it('validates exact public target and refuses malformed/unsafe source counts', () => {
    expect(narrowAdoption(fixture())).not.toBeNull();
    const raw = fixture(); raw.sources.repository.value!.stars = -1; expect(narrowAdoption(raw)).toBeNull();
    expect(narrowAdoption({ ...fixture(), target: { repo: 'private/other', packageName: '@ashlr/hub' } })).toBeNull();
    const bad = fixture(); bad.sources.npm.value!.total = 999; expect(narrowAdoption(bad)).toBeNull();
  });
  it('fills traffic gaps only between returned UTC days, preserving provider zero', () => {
    expect(trafficDays([{ day: '2026-10-02', count: 0 }, { day: '2026-10-04', count: 3 }])).toEqual([{ day: '2026-10-02', count: 0 }, { day: '2026-10-03', count: null }, { day: '2026-10-04', count: 3 }]);
  });
});
describe('AdoptionPanel', () => {
  it('keeps independent readings, UTC dates and latest-only asset IDs visible', async () => {
    routes(fixture()); render(<AdoptionPanel />);
    const repository = await screen.findByRole('region', { name: 'GitHub repository' });
    await waitFor(() => expect(repository).toHaveTextContent('Stars0Forks7'));
    expect(screen.getByText(/do not measure unique installations or active engineers/)).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'Repository views' })).toHaveTextContent('requires permission');
    const npm = screen.getByRole('figure', { name: 'npm package retrievals' });
    expect(npm).toHaveTextContent('2026-09-01 to 2026-09-30 UTC · 435 retrievals');
    showTable('npm package retrievals'); expect(within(npm).getByRole('cell', { name: '2026-09-01' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Latest published release assets' });
    expect(within(table).getByRole('cell', { name: '10' })).toBeInTheDocument();
    expect(screen.getByText(/not all-release totals or a daily series/)).toBeInTheDocument();
  });
  it('marks stale data and never pretends a failed refresh is current', async () => {
    const data = fixture(); data.sources.repository = { ...data.sources.repository, stale: true, reason: 'rate-limited', retryAt: '2026-10-05T14:00:00Z', checkedAt: '2026-10-05T13:00:00Z' };
    routes(data); render(<AdoptionPanel />);
    const region = await screen.findByRole('region', { name: 'GitHub repository' });
    await waitFor(() => expect(region).toHaveTextContent('Stale reading.'));
    expect(region).toHaveTextContent('source is rate limited'); expect(region).toHaveTextContent('Next permitted attempt');
    expect(region).toHaveTextContent('Stars0');
  });
  it('missing npm days retain unknown total and missing chart bins', async () => {
    const data = fixture(); data.sources.npm.value!.days[4]!.count = null; data.sources.npm.value!.total = null; data.sources.npm.value!.complete = false;
    routes(data); render(<AdoptionPanel />);
    const chart = await screen.findByRole('figure', { name: 'npm package retrievals' });
    await waitFor(() => expect(chart).toHaveTextContent('Incomplete daily coverage; total unknown'));
    showTable('npm package retrievals');
    const row = within(chart).getByRole('cell', { name: '2026-09-05' }).closest('tr')!;
    expect(row.textContent).not.toMatch(/2026-09-050$/);
  });
  it('older server leaves unknowns visible rather than assigning zero', async () => {
    routes(null); render(<AdoptionPanel />);
    const repository = await screen.findByRole('region', { name: 'GitHub repository' });
    await waitFor(() => expect(repository).toHaveTextContent('Stars—Forks—'));
    expect(screen.queryByRole('table', { name: 'Latest published release assets' })).toBeNull();
  });
  it('stays readable with Fleet off and uses keyboard-operable asset pagination on phone', async () => {
    vp.restore(); vp = mockCompactViewport();
    const data = fixture(); data.sources.release.value!.assets = Array.from({ length: 21 }, (_, i) => ({ id: i + 1, name: `asset-${i}`, count: i }));
    routes(data); render(<GrowthSection />);
    const table = await screen.findByRole('table', { name: 'Latest published release assets' });
    expect(screen.getByRole('region', { name: 'Growth starts with the first fleet run.' })).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    fireEvent.click(screen.getByRole('button', { name: 'Next assets' }));
    expect(within(table).getByRole('rowheader', { name: 'asset-20' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next assets' })).toBeDisabled();
  });
});

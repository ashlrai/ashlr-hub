/**
 * Fleet repo table: the fleet's own mirror clones are reported apart from
 * the repo rows (FleetLiveSnapshotV1.mirrors, 3.10 review follow-up).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SurfaceActions } from '../command/actions.js';
import { fleetLive } from '../command/fixtures.test-support.js';
import { mirrorsText, RepoTable } from './RepoTable.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');
const actions = { act: () => undefined, busy: false, error: null, clearError: () => undefined, readOnly: true, dialogs: null } as SurfaceActions;

describe('mirrorsText', () => {
  it('says nothing for an older server, "unknown" for an unreadable registry, and never calls unknown "none"', () => {
    expect(mirrorsText(undefined)).toBeNull();
    expect(mirrorsText(null)).toMatch(/unknown/);
    expect(mirrorsText({ count: 0, repos: [] })).toMatch(/none yet/);
    expect(mirrorsText({ count: 1, repos: ['ashlrai/binshield'] })).toBe(
      "Fleet mirrors: 1 working copy (ashlrai/binshield) — the fleet's own clones of the repos above, not repos of their own.",
    );
    const many = Array.from({ length: 8 }, (_, i) => `ashlrai/r${i}`);
    expect(mirrorsText({ count: 8, repos: many })).toContain('and 2 more');
  });
});

describe('RepoTable', () => {
  it('lists mirrors under the table, not as repo rows', () => {
    const live = { ...fleetLive('live', NOW), mirrors: { count: 2, repos: ['ashlrai/ashlr-hub', 'ashlrai/binshield'] } };
    render(<RepoTable read={{ value: live, available: true, reason: null }} actions={actions} now={NOW} compact={false} />);
    expect(screen.getByText(/Fleet mirrors: 2 working copies \(ashlrai\/ashlr-hub, ashlrai\/binshield\)/)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(live.repos.length + 1);
  });
});

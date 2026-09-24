/**
 * LocalRuntimePanel — the V3.10 lane-cap line (B-U6 request 8).
 *
 * The panel's big number is what the RUNTIME can run at once; a tick's lane
 * cap (Mason present → 2, a Leader decision, budget, grant) can make the fleet
 * run fewer. The fact reaches the page only as a sentence in
 * FleetSnapshot.notes, so these tests build that sentence with the REAL
 * producer (`deriveLocalFleetConcurrency` → `projectFleetSnapshot`): if core
 * rewords it, this fails here instead of the line silently disappearing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import {
  deriveLocalFleetConcurrency,
  projectFleetSnapshot,
  type LocalFleetSnapshotV1,
  type ServingRuntimeCapacity,
} from '../../../../core/daemon/local-fleet.js';
import { evictAll, runQuery } from '../../../data/cache.js';
import { LANE_CAP_NOTE_PREFIX, laneCapFromNotes, LocalRuntimePanel } from './LocalRuntimePanel.js';
import type { FleetSnapshot, OptionalFleetRead, ServingRuntimeSnapshot } from './fleet-contract.js';
import { VERSE_FLEET_KEY } from './fleet-queries.js';
import type { GuardedAction } from './use-guarded-action.js';

function guard(): GuardedAction {
  return {
    request: vi.fn(),
    busy: false,
    error: null,
    clearError: vi.fn(),
    readOnly: false,
    tokenOpen: false,
    tokenReason: '',
    closeToken: vi.fn(),
  };
}

function ok<T>(value: T): OptionalFleetRead<T> {
  return { value, available: true, reason: null };
}

const RUNTIME: ServingRuntimeSnapshot = {
  kind: 'llama-server',
  state: 'running',
  endpoint: '127.0.0.1:8080',
  model: 'qwen3.8:27b-ctx64k',
  slotsTotal: 4,
  slotsBusy: 1,
  contextTokens: 16384,
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  parallel: { capable: true, refusal: null, slots: 4 },
  reason: null,
  supervised: true,
  sampledAt: null,
};

const CAPACITY: ServingRuntimeCapacity = {
  runtime: 'llama-server',
  endpoint: '127.0.0.1:8080',
  state: 'up',
  slots: 4,
  busySlots: 1,
  model: 'qwen',
  managed: true,
  startedAt: null,
  observedAt: new Date(0).toISOString(),
  detail: 'llama-server up with 4 slot(s)',
};

/** The route's body for a tick whose lane cap is `laneCap` — through the real producer. */
function fleetWith(laneCap: { limit: number; reason: string } | null, read?: Parameters<typeof projectFleetSnapshot>[1]): FleetSnapshot {
  const concurrency = deriveLocalFleetConcurrency(CAPACITY, null, { laneCap });
  // Only the fields projectFleetSnapshot reads; the rest of V1 is irrelevant here.
  const snapshot = {
    enabled: true,
    concurrency,
    health: { state: 'healthy', reasons: [] },
    runtime: { slots: 4, busySlots: 1, detail: CAPACITY.detail },
    limiter: { note: 'local dispatch costs $0' },
    inFlight: [],
    queue: { depth: 0, next: [] },
    observedAt: new Date().toISOString(),
  } as unknown as LocalFleetSnapshotV1;
  return projectFleetSnapshot(snapshot, read) as FleetSnapshot;
}

afterEach(() => {
  evictAll();
});

describe('LocalRuntimePanel — lane cap', () => {
  it('says the fleet runs fewer than the runtime could, and why, when a lane cap binds', () => {
    const fleet = fleetWith({ limit: 2, reason: 'Mason is present (live Verse turn)' });
    render(<LocalRuntimePanel read={ok(RUNTIME)} fleet={ok(fleet)} guard={guard()} dispatchEnabled />);
    // The runtime's own number stays the headline…
    expect(screen.getByText('4 agents in parallel')).toBeInTheDocument();
    // …and the lane cap is named, with a word, beside it.
    const line = screen.getByRole('note');
    expect(line).toHaveTextContent('lane-capped');
    expect(line).toHaveTextContent('The fleet runs at most 2 local agents this tick, not 4 — a lane cap is tighter than this runtime: Mason is present (live Verse turn).');
  });

  it('says the local lane is off when the cap is zero', () => {
    const fleet = fleetWith({ limit: 0, reason: 'grant lists no local engine' });
    render(<LocalRuntimePanel read={ok(RUNTIME)} fleet={ok(fleet)} guard={guard()} dispatchEnabled />);
    const line = screen.getByRole('note');
    expect(line).toHaveTextContent('lane off');
    expect(line).toHaveTextContent('The fleet runs no local agent this tick: grant lists no local engine.');
  });

  it('says nothing when the cap does not bind (it never raises the answer)', () => {
    const fleet = fleetWith({ limit: 8, reason: 'Leader set 8' });
    render(<LocalRuntimePanel read={ok(RUNTIME)} fleet={ok(fleet)} guard={guard()} dispatchEnabled />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('calls an aged snapshot "last tick", not "this tick"', () => {
    const fleet = fleetWith({ limit: 2, reason: 'budget' }, { freshness: 'stale', ageMs: 600_000 });
    render(<LocalRuntimePanel read={ok(RUNTIME)} fleet={ok(fleet)} guard={guard()} dispatchEnabled />);
    expect(screen.getByRole('note')).toHaveTextContent('at most 2 local agents as of its last tick, not 4');
  });

  it('peeks the shared fleet cache when no fleet prop is given — and never fetches it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      render(<LocalRuntimePanel read={ok(RUNTIME)} guard={guard()} dispatchEnabled />);
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
      // What Advanced's own fleet read would have put in the cache.
      const cached = ok(fleetWith({ limit: 1, reason: 'Mason is present' }));
      await act(async () => { await runQuery(VERSE_FLEET_KEY, async () => cached); });
      expect(await screen.findByRole('note')).toHaveTextContent('at most 1 local agent this tick, not 4');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('parses only the lane-cap note, and keeps an unknown reason in the server’s words', () => {
    expect(laneCapFromNotes(null)).toBeNull();
    expect(laneCapFromNotes(['bounded by the outward mutation fence, not by slots: x'])).toBeNull();
    expect(laneCapFromNotes([`${LANE_CAP_NOTE_PREFIX}something new`])).toEqual({ off: false, limit: null, uncapped: null, why: 'something new' });
  });
});

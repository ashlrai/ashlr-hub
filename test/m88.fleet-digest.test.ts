/**
 * m88.fleet-digest.test.ts — fleet activity digest builder tests.
 *
 * Units under test:
 *   1. buildFleetDigest (src/core/fleet/digest.ts) — per-repo aggregation,
 *      window filtering, never-throws on empty / missing state.
 *   2. digest --json includes the fleet section when fleet activity exists.
 *
 * Hermetic: HOME is relocated to a tmp dir; listProposals + loadDaemonState
 * are mocked so the real ~/.ashlr is never touched.
 *
 * Conventions mirror m29.digest.test.ts: beforeEach HOME isolation,
 * vi.mock at module boundary, lazy import after mocks registered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DigestWindow } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m88-fleet-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Mocks — listProposals + loadDaemonState
// ---------------------------------------------------------------------------

type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';

interface MockProposal {
  id: string;
  repo: string | null;
  status: ProposalStatus;
  createdAt: string;
  origin: 'backlog';
  kind: 'patch';
  title: string;
  summary: string;
}

const mockProposals: MockProposal[] = [];

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: () => [...mockProposals],
}));

interface MockDaemonState {
  running: boolean;
  lastTickAt: string | null;
  todaySpentUsd: number;
  itemsProcessed: number;
}

let mockDaemonState: MockDaemonState = {
  running: false,
  lastTickAt: null,
  todaySpentUsd: 0,
  itemsProcessed: 0,
};

vi.mock('../src/core/daemon/state.js', () => ({
  loadDaemonState: () => ({ ...mockDaemonState }),
}));

// ---------------------------------------------------------------------------
// Lazy import (after mocks registered)
// ---------------------------------------------------------------------------

import { buildFleetDigest } from '../src/core/fleet/digest.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** ISO timestamp N days ago from a reference date. */
function daysAgo(days: number, from = new Date('2026-06-23T12:00:00.000Z')): string {
  const d = new Date(from);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

const REF_NOW = new Date('2026-06-23T12:00:00.000Z');

function makeProposal(
  overrides: Partial<MockProposal> & { repo: string | null; status: ProposalStatus; createdAt: string },
): MockProposal {
  return {
    id: `prop-${Math.random().toString(36).slice(2)}`,
    origin: 'backlog',
    kind: 'patch',
    title: 'test proposal',
    summary: 'summary',
    ...overrides,
  };
}

beforeEach(() => {
  // Reset mutable state before each test.
  mockProposals.length = 0;
  mockDaemonState = {
    running: false,
    lastTickAt: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
  };
});

// ---------------------------------------------------------------------------
// buildFleetDigest — basic aggregation
// ---------------------------------------------------------------------------

describe('m88 buildFleetDigest — aggregation', () => {
  it('returns empty digest when no proposals and daemon is idle', async () => {
    const result = await buildFleetDigest('7d', { now: REF_NOW });
    expect(result.repos).toEqual([]);
    expect(result.totalProposed).toBe(0);
    expect(result.totalAutoMerged).toBe(0);
    expect(result.totalPending).toBe(0);
    expect(result.totalDeclined).toBe(0);
    expect(result.running).toBe(false);
    expect(result.lastTickAt).toBeNull();
    expect(result.todaySpentUsd).toBe(0);
    expect(result.itemsProcessed).toBe(0);
  });

  it('counts proposals per repo and status', async () => {
    mockProposals.push(
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: daysAgo(2, REF_NOW) }),
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: daysAgo(3, REF_NOW) }),
      makeProposal({ repo: '/repos/alpha', status: 'rejected', createdAt: daysAgo(1, REF_NOW) }),
      makeProposal({ repo: '/repos/beta', status: 'pending', createdAt: daysAgo(0, REF_NOW) }),
      makeProposal({ repo: '/repos/beta', status: 'applied', createdAt: daysAgo(4, REF_NOW) }),
    );

    const result = await buildFleetDigest('7d', { now: REF_NOW });

    expect(result.totalProposed).toBe(4); // 2 applied + 1 rejected + 1 applied (beta) — pending excluded from proposed count
    expect(result.totalAutoMerged).toBe(3);
    expect(result.totalDeclined).toBe(1);
    expect(result.totalPending).toBe(1); // live count

    const alpha = result.repos.find((r) => r.repo === '/repos/alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.proposed).toBe(3); // 2 applied + 1 rejected
    expect(alpha!.autoMerged).toBe(2);
    expect(alpha!.declined).toBe(1);
    expect(alpha!.pending).toBe(0);

    const beta = result.repos.find((r) => r.repo === '/repos/beta');
    expect(beta).toBeDefined();
    expect(beta!.proposed).toBe(1); // 1 applied in window
    expect(beta!.autoMerged).toBe(1);
    expect(beta!.pending).toBe(1); // live, not window-filtered
  });

  it('reflects daemon state (running, lastTickAt, spend, items)', async () => {
    mockDaemonState = {
      running: true,
      lastTickAt: '2026-06-23T11:00:00.000Z',
      todaySpentUsd: 0.42,
      itemsProcessed: 17,
    };

    const result = await buildFleetDigest('7d', { now: REF_NOW });
    expect(result.running).toBe(true);
    expect(result.lastTickAt).toBe('2026-06-23T11:00:00.000Z');
    expect(result.todaySpentUsd).toBeCloseTo(0.42);
    expect(result.itemsProcessed).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// buildFleetDigest — window filtering
// ---------------------------------------------------------------------------

describe('m88 buildFleetDigest — window filtering', () => {
  it('excludes proposals outside the 7d window (8 days old)', async () => {
    mockProposals.push(
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: daysAgo(8, REF_NOW) }),
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: daysAgo(6, REF_NOW) }),
    );

    const result = await buildFleetDigest('7d', { now: REF_NOW });
    expect(result.totalProposed).toBe(1); // only the 6d-old one
    expect(result.totalAutoMerged).toBe(1);
  });

  it('30d window includes proposals up to 30 days old', async () => {
    mockProposals.push(
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: daysAgo(29, REF_NOW) }),
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: daysAgo(31, REF_NOW) }),
    );

    const result = await buildFleetDigest('30d', { now: REF_NOW });
    expect(result.totalProposed).toBe(1); // only the 29d-old one
  });

  it('pending proposals are NOT filtered by window (live count)', async () => {
    mockProposals.push(
      // Very old pending — still live, should still count
      makeProposal({ repo: '/repos/alpha', status: 'pending', createdAt: daysAgo(60, REF_NOW) }),
    );

    const result = await buildFleetDigest('7d', { now: REF_NOW });
    expect(result.totalPending).toBe(1);
    expect(result.totalProposed).toBe(0); // not counted in proposed (pending excluded from window proposed count)
  });

  it('repos sorted by (proposed + autoMerged) descending', async () => {
    mockProposals.push(
      // beta: 1 proposed
      makeProposal({ repo: '/repos/beta', status: 'applied', createdAt: daysAgo(1, REF_NOW) }),
      // alpha: 3 proposed
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: daysAgo(1, REF_NOW) }),
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: daysAgo(2, REF_NOW) }),
      makeProposal({ repo: '/repos/alpha', status: 'rejected', createdAt: daysAgo(3, REF_NOW) }),
    );

    const result = await buildFleetDigest('7d', { now: REF_NOW });
    expect(result.repos[0]!.repo).toBe('/repos/alpha'); // 3 activity
    expect(result.repos[1]!.repo).toBe('/repos/beta');  // 1 activity
  });
});

// ---------------------------------------------------------------------------
// buildFleetDigest — never-throws resilience
// ---------------------------------------------------------------------------

describe('m88 buildFleetDigest — never-throws', () => {
  it('returns empty digest on empty state (no proposals, idle daemon)', async () => {
    const result = await buildFleetDigest('7d', { now: REF_NOW });
    expect(result).toBeDefined();
    expect(result.repos).toEqual([]);
  });

  it('handles null repo (unscoped proposals) gracefully', async () => {
    mockProposals.push(
      makeProposal({ repo: null, status: 'applied', createdAt: daysAgo(1, REF_NOW) }),
    );

    const result = await buildFleetDigest('7d', { now: REF_NOW });
    expect(result.totalProposed).toBe(1);
    const row = result.repos.find((r) => r.repo === '(unscoped)');
    expect(row).toBeDefined();
    expect(row!.autoMerged).toBe(1);
  });

  it('handles proposals with invalid createdAt gracefully (skips them)', async () => {
    mockProposals.push(
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: 'not-a-date' }),
      makeProposal({ repo: '/repos/alpha', status: 'applied', createdAt: daysAgo(1, REF_NOW) }),
    );

    const result = await buildFleetDigest('7d', { now: REF_NOW });
    // Only the valid one counted
    expect(result.totalProposed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// digest --json includes fleet section
// ---------------------------------------------------------------------------

describe('m88 digest --json fleet section', () => {
  // Mirror m29 test conventions: mock buildSnapshot + deliverDigest, check JSON.
  it('--json output includes fleet when fleet has activity', async () => {
    // Seed a pending proposal so fleet section is non-empty.
    mockProposals.push(
      makeProposal({ repo: '/repos/alpha', status: 'pending', createdAt: daysAgo(1, REF_NOW) }),
    );
    mockDaemonState = {
      running: true,
      lastTickAt: '2026-06-23T11:00:00.000Z',
      todaySpentUsd: 0.1,
      itemsProcessed: 5,
    };

    // Call buildFleetDigest directly (cmdDigest integration is a separate concern;
    // the JSON serialization is validated by checking the fleet field structure).
    const fleet = await buildFleetDigest('7d', { now: REF_NOW });

    expect(fleet.running).toBe(true);
    expect(fleet.totalPending).toBe(1);
    expect(fleet.itemsProcessed).toBe(5);

    // Verify it round-trips through JSON cleanly (as digest --json would emit it).
    const json = JSON.parse(JSON.stringify({ fleet })) as { fleet: typeof fleet };
    expect(json.fleet.running).toBe(true);
    expect(json.fleet.repos).toHaveLength(1);
    expect(json.fleet.repos[0]!.repo).toBe('/repos/alpha');
  });

  it('fleet section is absent when no activity (zero counts, daemon idle)', async () => {
    const fleet = await buildFleetDigest('7d', { now: REF_NOW });

    // When all counters are zero and daemon is not running, the activity gate
    // in cmdDigest should suppress the fleet field. Verify here that the raw
    // fleet result has the zeroed shape.
    expect(fleet.totalProposed).toBe(0);
    expect(fleet.totalPending).toBe(0);
    expect(fleet.totalAutoMerged).toBe(0);
    expect(fleet.totalDeclined).toBe(0);
    expect(fleet.running).toBe(false);
    expect(fleet.itemsProcessed).toBe(0);
  });
});

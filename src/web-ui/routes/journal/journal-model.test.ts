import { describe, expect, it } from 'vitest';
import { buildJournalEntries, filterJournalEntries, bucketByHour, type JournalEntry } from './journal-model.js';

describe('buildJournalEntries', () => {
  it('merges every source into one chronologically-sorted feed (newest first)', () => {
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();

    const entries = buildJournalEntries({
      logs: {
        entries: [{ ts: iso(5000), kind: 'merge', msg: 'merged proposal p1' }],
        sourceQuality: { sourceState: 'healthy', complete: true },
      },
      fleetActivity: {
        recentTicks: [{ ts: iso(4000), reason: 'scheduled', dryRun: false, backends: {}, spentUsd: 0.5, merged: 1, directionMode: null, directionReason: null, autoMerge: null, remoteHandoff: null, proposalProduction: null, dispatches: [] }],
        recentMerges: [{ repo: 'r1', proposalId: 'p1', ts: iso(3000), engine: 'claude' }],
        recentActions: [{ ts: iso(2000), actor: 'daemon', kind: 'merge', outcome: 'success', action: 'merge', summary: 'merged cleanly', proseDigest: 'Merged the thing' }],
        recentTicksSourceQuality: undefined,
        recentMergesSourceQuality: undefined,
      } as never,
      runs: [{ id: 'run1', goal: 'ship it', status: 'done', updatedAt: iso(1000), steps: [], tasks: [] } as never],
      inbox: { pending: 1, proposals: [{ id: 'p2', title: 'new proposal', kind: 'patch', repo: 'r2', origin: 'agent', createdAt: iso(500) }] },
    });

    expect(entries).toHaveLength(6);
    expect(entries.map((e) => e.source)).toEqual(['proposal', 'run', 'agent-action', 'merge', 'daemon-tick', 'daemon-tick']);
    expect(entries[entries.length - 1]!.title).toBe('Daemon merge');
  });

  it('carries drill-in ids through for merges, agent actions, runs, and pending proposals', () => {
    const entries = buildJournalEntries({
      fleetActivity: { recentMerges: [{ repo: 'r', proposalId: 'p1', ts: new Date().toISOString(), engine: 'e' }] } as never,
      runs: [{ id: 'run1', goal: 'g', status: 'running', updatedAt: new Date().toISOString(), steps: [], tasks: [] } as never],
    });
    expect(entries.find((e) => e.source === 'merge')?.drillIn).toEqual({ proposalId: 'p1' });
    expect(entries.find((e) => e.source === 'run')?.drillIn).toEqual({ runId: 'run1' });
  });
});

describe('filterJournalEntries', () => {
  const base: JournalEntry[] = [
    { id: '1', ts: new Date().toISOString(), source: 'run', title: 'ship the thing', detail: 'ok', statusLabel: 'done' },
    { id: '2', ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), source: 'merge', title: 'merged x', detail: 'ok', statusLabel: 'merged' },
  ];

  it('filters by enabled sources', () => {
    const out = filterJournalEntries(base, { sources: new Set(['run']), query: '', windowMs: null });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('1');
  });

  it('filters by search text across title/detail', () => {
    const out = filterJournalEntries(base, { sources: new Set(['run', 'merge']), query: 'ship', windowMs: null });
    expect(out.map((e) => e.id)).toEqual(['1']);
  });

  it('filters by time window', () => {
    const out = filterJournalEntries(base, { sources: new Set(['run', 'merge']), query: '', windowMs: 60 * 60 * 1000 });
    expect(out.map((e) => e.id)).toEqual(['1']);
  });
});

describe('bucketByHour', () => {
  it('produces one bucket per hour, oldest first, with correct counts', () => {
    const now = Date.now();
    const entries: JournalEntry[] = [
      { id: '1', ts: new Date(now).toISOString(), source: 'run', title: '', detail: '', statusLabel: 'done' },
      { id: '2', ts: new Date(now - 60 * 60 * 1000).toISOString(), source: 'run', title: '', detail: '', statusLabel: 'done' },
    ];
    const buckets = bucketByHour(entries, 3);
    expect(buckets).toHaveLength(3);
    expect(buckets[2]!.count).toBe(1); // current hour
    expect(buckets[1]!.count).toBe(1); // one hour ago
    expect(buckets[0]!.count).toBe(0);
  });
});

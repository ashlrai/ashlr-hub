/**
 * 3.15 — Grok shows its usage again.
 *
 * Diagnosed read-only on Mason's machine, 2026-09-27: every surface read Grok
 * as "—" / "unknown usage" while Claude and Codex had readings. The last Grok
 * reading in ~/.ashlr/routing/capacity-history.jsonl was 2026-09-26T10:05Z
 * (30% used, resets 12:43:50Z); the published capacity snapshot has carried
 * `grok: { windows: [], observedAt: null }` ever since. The native probe itself
 * kept succeeding every 30 s — but after the weekly reset xAI's proto3 JSON
 * omits a zero `creditUsagePercent`, the probe reported `usedPercent: null`, and
 * the chain below faithfully turned "no signal" into an empty meter and a seat
 * autonomy could not use.
 *
 * This pins that chain from the probe's window to what the rail, the drawer
 * and the fleet read: a connection row carrying the post-reset window becomes a
 * `ready` seat with a 0% window, the capacity snapshot the Verse/daemon
 * publishers write carries it, and budgeting assesses it as known headroom.
 *
 * HOME-isolated; every path is an explicit tmp root; no native account is contacted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ResourceAccountConnection, ResourceConnectionsSnapshot } from '../src/core/resources/connection-types.js';
import { buildVerseAccountsSnapshot, type VerseAccountCollector } from '../src/core/verse/accounts.js';
import { buildSeatTelemetry } from '../src/core/verse/seats.js';
import type { VerseSeat } from '../src/core/verse/types.js';
import { assessSeat, capacityFromSeat } from '../src/core/routing/headroom.js';
import { readCapacitySnapshot, writeCapacitySnapshot } from '../src/core/routing/budget-store.js';

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-grok-reset-')));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify({
    schemaVersion: 1, intervalMs: 30_000,
    accounts: [{ id: 'grok', label: 'Grok', provider: 'grok',
      command: ['/opt/fixture-does-not-exist/bin/node', '/opt/fixture-does-not-exist/.ashlr/native-profiles/grok-a/launcher.mjs'] }],
  }), { mode: 0o600 });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const NOW = Date.now();
const RESETS_AT = new Date(NOW + 6 * 86_400_000).toISOString();

/** The row `createResourceConnectionMonitor` builds from an `observed` Grok probe. */
function grokRow(usedPercent: number | null): ResourceAccountConnection {
  return {
    id: 'grok', label: 'Grok', provider: 'grok', state: 'observed', authentication: 'signed-in', health: 'reachable',
    planType: 'SuperGrok', observedAt: new Date(NOW - 5_000).toISOString(), expiresAt: new Date(NOW + 55_000).toISOString(),
    windows: [{ id: 'grok_unified_weekly', usedPercent, resetsAt: RESETS_AT }],
    reason: 'probe-observed', onDemandEnabled: null, executionSupported: false,
  };
}

function collectorWith(row: ResourceAccountConnection): VerseAccountCollector {
  const snapshot: ResourceConnectionsSnapshot = { sampledAt: new Date(NOW).toISOString(), refreshing: false, accounts: [row] };
  return {
    accountsRoot: root,
    status: () => ({ mode: 'owned', state: 'running', owner: 'this-server', reasonCode: null, pollIntervalMs: 30_000,
      idleSuspendMs: 300_000, lastPolledAt: null, lastRequestAt: null, note: '' }),
    touch: () => {},
    connections: () => snapshot,
    observations: () => [],
    unavailableWorkerIds: () => [],
    credits: () => null,
    close: async () => {},
  };
}

const GROK_SEAT: VerseSeat = {
  id: 'grok', engine: 'grok', label: 'Grok', accountId: 'grok', models: [], contextWindow: 500_000,
  health: { state: 'unknown', summary: null, windows: [], observedAt: null },
};

describe('a post-reset Grok reading reaches every surface', () => {
  it('the account record and seat capacity carry a measured 0% weekly window, ready for chat and the fleet', () => {
    const collector = collectorWith(grokRow(0));
    const record = buildVerseAccountsSnapshot({ accountsRoot: root, collector }).accounts.find((a) => a.id === 'grok')!;
    expect(record).toMatchObject({ state: 'observed', binding: { id: 'grok_unified_weekly', usedPercent: 0, limitReached: false } });

    const capacity = buildSeatTelemetry(root, { collector }).get('grok')!.capacity;
    expect(capacity.usability).toBe('ready');
    expect(capacity.binding).toMatchObject({ id: 'grok_unified_weekly', usedPercent: 0, resetsAt: RESETS_AT });
  });

  it('the capacity snapshot the publishers write carries Grok usage, and budgeting sees known headroom', () => {
    const capacity = buildSeatTelemetry(root, { collector: collectorWith(grokRow(0)) }).get('grok')!.capacity;
    const seat = capacityFromSeat(GROK_SEAT, capacity);
    const file = path.join(root, 'capacity.json');
    writeCapacitySnapshot([seat], new Date(NOW), file);
    const published = readCapacitySnapshot(file)!.seats.find((s) => s.seatId === 'grok')!;
    expect(published.windows).toEqual([{ id: 'grok_unified_weekly', usedPercent: 0, resetsAt: RESETS_AT, resetDescription: null, limitReached: false }]);
    expect(published.observedAt).not.toBeNull();

    const assessed = assessSeat(published, { seatId: 'grok', enabled: true, reservePercent: 20 }, { nowMs: NOW });
    expect(assessed.unknownUsage).toBe(false);
    expect(assessed.exhausted).toBe(false);
    expect(assessed.headroom.eligibleForAutonomy).toBe(true);
  });

  it('a genuinely missing percent still reads as no signal — never invented into headroom', () => {
    const capacity = buildSeatTelemetry(root, { collector: collectorWith(grokRow(null)) }).get('grok')!.capacity;
    expect(capacity.usability).toBe('unknown');
    // Exactly the snapshot row Mason's machine published from 2026-09-26 on.
    const seat = capacityFromSeat(GROK_SEAT, capacity);
    expect(seat).toMatchObject({ windows: [], observedAt: null });
    expect(assessSeat(seat, { seatId: 'grok', enabled: true, reservePercent: 20 }, { nowMs: NOW }).unknownUsage).toBe(true);
  });
});

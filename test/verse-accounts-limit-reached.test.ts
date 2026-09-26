/**
 * V3.10 — Codex's `limitReached` flag survives the Verse EVIDENCE path.
 *
 * The live connection path (`deriveVerseAccountRecord`) already honoured the
 * flag, but `toObservationMap` — which feeds both the in-process collector's
 * observations and the shared ledger evidence file — rebuilt every window as
 * `{id, usedPercent, resetsAt}` and silently dropped it. A provider DENIAL
 * then read as an unexplained measured 100, and `seatUsability` could not call
 * the Codex seat exhausted on that path. These cases pin the flag end to end:
 * collector → evidence map → record → seat verdict, and ledger file → evidence
 * map (through pool-policy's key-exact validator).
 *
 * HOME-isolated; every path is an explicit tmp root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { canonical, digest } from '../src/core/universe/artifacts.js';
import {
  acquireResourceQuotaRefreshLease,
  type ResourceQuotaRefreshLease,
} from '../src/core/resources/quota-refresh-lease.js';
import { publishSharedQuotaEvidence } from '../src/core/resources/quota-shared-evidence.js';
import type { ResourceObservation } from '../src/core/resources/pool-policy.js';
import {
  accountsLedgerRoot,
  deriveVerseAccountRecordFromEvidence,
  readVerseAccountEvidence,
  type VerseAccountCollector,
} from '../src/core/verse/accounts.js';
import { seatUsability } from '../src/core/verse/seats.js';

const FAKE_NODE = '/opt/fixture/bin/node';
const launcherFor = (profile: string) => `/opt/fixture/.ashlr/native-profiles/${profile}/launcher.mjs`;

const POOL = {
  schemaVersion: 1,
  id: 'ashlr-subscriptions-fixture',
  workers: [
    { id: 'codex-a', provider: 'codex', model: 'gpt-6-astra', maxConcurrent: 1, reservePercent: 0,
      maxTasksPerWindow: 6, taskWindowMs: 3_600_000, priority: 50 },
  ],
};
const BINDINGS = [
  { workerId: 'codex-a', capacityKey: 'personal', kind: 'native-cli', command: [FAKE_NODE, launcherFor('codex-a')] },
];
const QUOTA_CONFIG = {
  schemaVersion: 1,
  poolDigest: digest(canonical({ pool: POOL, bindings: BINDINGS })),
  workers: [{ workerId: 'codex-a', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }],
};
const CONNECTIONS = {
  schemaVersion: 1,
  intervalMs: 30_000,
  accounts: [{ id: 'codex-a', label: 'Personal Codex', provider: 'codex', command: [FAKE_NODE, launcherFor('codex-a')] }],
};

function writePrivate(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** A Codex observation whose primary window the provider FLAGGED, secondary measured. */
function flaggedObservation(): ResourceObservation {
  const now = Date.now();
  return {
    workerId: 'codex-a',
    observedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 45_000).toISOString(),
    health: 'ready',
    windows: [
      { id: 'codex_codex_primary', usedPercent: 100, resetsAt: null, limitReached: true },
      { id: 'codex_codex_secondary', usedPercent: 40, resetsAt: null },
    ],
    retryAfter: null,
  };
}

function fakeCollector(accountsRoot: string, rows: ResourceObservation[]): VerseAccountCollector {
  return {
    accountsRoot,
    status: () => { throw new Error('not used'); },
    touch: () => {},
    connections: () => null,
    observations: () => rows,
    unavailableWorkerIds: () => [],
    credits: () => null,
    close: async () => {},
  };
}

let root: string;
let tmpHome: string;
let prevHome: string | undefined;
let held: ResourceQuotaRefreshLease | null = null;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-limit-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ashlr-verse-limit-')));
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, 'ledger'), { mode: 0o700 });
  fs.chmodSync(path.join(root, 'ledger'), 0o700);
  writePrivate(path.join(root, 'pool.json'), POOL);
  writePrivate(path.join(root, 'bindings.json'), BINDINGS);
  writePrivate(path.join(root, 'quota-config.json'), QUOTA_CONFIG);
  writePrivate(path.join(root, 'connections.json'), CONNECTIONS);
  writePrivate(path.join(root, 'observations.json'), []);
});

afterEach(() => {
  if (held) { try { held.close(true); } catch { /* fence preserved */ } held = null; }
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('verse accounts — limitReached on the evidence path', () => {
  it('keeps the flag on collector observations and leaves unflagged windows in their three-key shape', () => {
    const evidence = readVerseAccountEvidence(root, fakeCollector(root, [flaggedObservation()]));
    expect(evidence.source).toBe('collector');
    expect(evidence.byAccount.get('codex-a')!.windows).toEqual([
      { id: 'codex_codex_primary', usedPercent: 100, resetsAt: null, limitReached: true },
      // No `limitReached: false` / `undefined` key is invented for a measured window.
      { id: 'codex_codex_secondary', usedPercent: 40, resetsAt: null },
    ]);
    expect(Object.keys(evidence.byAccount.get('codex-a')!.windows[1]!)).toEqual(['id', 'usedPercent', 'resetsAt']);
  });

  it('carries the flag through to the record and makes the Codex seat exhausted', () => {
    const evidence = readVerseAccountEvidence(root, fakeCollector(root, [flaggedObservation()]));
    const record = deriveVerseAccountRecordFromEvidence(
      { id: 'codex-a', label: 'Personal Codex', provider: 'codex' },
      evidence.byAccount.get('codex-a')!,
      'connection-not-checked',
    );
    expect(record.windows[0]).toMatchObject({ limitReached: true, measured: false, usedPercent: 100 });
    expect(record.windows[1]).toMatchObject({ limitReached: false, measured: true, usedPercent: 40 });
    expect(record.binding).toEqual({ id: 'codex_codex_primary', usedPercent: 100, limitReached: true });
    expect(record.notes.some((n) => n.includes('that flag is a denial'))).toBe(true);
    // The flag is the provider's denial for the bucket: exhausted even though
    // the secondary window has headroom (no credits on an evidence record).
    expect(seatUsability(record)).toBe('exhausted');
  });

  it('an unflagged 100 on the same path stays a measurement and is only tight', () => {
    const row = flaggedObservation();
    row.windows[0] = { id: 'codex_codex_primary', usedPercent: 100, resetsAt: null };
    const evidence = readVerseAccountEvidence(root, fakeCollector(root, [row]));
    const record = deriveVerseAccountRecordFromEvidence(
      { id: 'codex-a', label: 'Personal Codex', provider: 'codex' },
      evidence.byAccount.get('codex-a')!,
      'connection-not-checked',
    );
    expect(record.windows[0]).toMatchObject({ limitReached: false, measured: true });
    expect(record.notes.some((n) => n.includes('does not claim which'))).toBe(true);
    expect(seatUsability(record)).toBe('tight');
  });

  it('keeps the flag when read back from the shared ledger evidence file', async () => {
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    held.markPending();
    publishSharedQuotaEvidence({
      root: accountsLedgerRoot(root),
      pool: POOL as never,
      bindings: BINDINGS as never,
      config: QUOTA_CONFIG as never,
      lease: held,
      state: 'running',
      evidence: { observations: [flaggedObservation()], unavailableWorkerIds: [] },
    });

    const evidence = readVerseAccountEvidence(root);
    expect(evidence.source).toBe('shared-evidence');
    expect(evidence.unavailableAccountIds.has('codex-a')).toBe(true);
    expect(evidence.byAccount.get('codex-a')!.windows[0]).toEqual(
      { id: 'codex_codex_primary', usedPercent: 100, resetsAt: null, limitReached: true });
    expect(evidence.byAccount.get('codex-a')!.windows[1]).not.toHaveProperty('limitReached');
    const record = deriveVerseAccountRecordFromEvidence(
      { id: 'codex-a', label: 'Personal Codex', provider: 'codex' },
      evidence.byAccount.get('codex-a')!,
      'connection-not-checked',
      false,
      evidence.unavailableAccountIds.has('codex-a'),
    );
    expect(record).toMatchObject({ state: 'unavailable', reason: 'native-account-unavailable' });
    expect(record.windows[0]).toMatchObject({ limitReached: true, measured: false });
    expect(seatUsability(record)).toBe('unknown');
  });
});

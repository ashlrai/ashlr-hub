/**
 * 3.10 c8 follow-up — a Verse account collector that started READ-ONLY because
 * another process held the native-metadata lease (typically the daemon's
 * short-lived capacity publisher, mid-sample) retries the lease on client
 * interest instead of staying read-only for the whole session.
 *
 * Real lease files under a tmp root and a tmp HOME; the real ~/.ashlr is never
 * touched. The fixture's launcher binary does not exist, so an owned collector
 * cannot reach any real account (no paid seat is ever contacted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { canonical, digest } from '../src/core/universe/artifacts.js';
import { acquireResourceQuotaRefreshLease, type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import {
  accountsLedgerRoot,
  startVerseAccountCollector,
  VERSE_ACCOUNTS_LEASE_RETRY_MS,
  type VerseAccountCollector,
} from '../src/core/verse/accounts.js';

const FAKE_NODE = '/opt/fixture-does-not-exist/bin/node';
const launcherFor = (profile: string) => `/opt/fixture-does-not-exist/.ashlr/native-profiles/${profile}/launcher.mjs`;

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

function makeRoot(): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ashlr-lease-retry-')));
  fs.chmodSync(base, 0o700);
  fs.mkdirSync(path.join(base, 'ledger'), { mode: 0o700 });
  fs.chmodSync(path.join(base, 'ledger'), 0o700);
  writePrivate(path.join(base, 'pool.json'), POOL);
  writePrivate(path.join(base, 'bindings.json'), BINDINGS);
  writePrivate(path.join(base, 'quota-config.json'), QUOTA_CONFIG);
  writePrivate(path.join(base, 'connections.json'), CONNECTIONS);
  writePrivate(path.join(base, 'observations.json'), []);
  return base;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

let root: string;
let tmpHome: string;
let prevHome: string | undefined;
let held: ResourceQuotaRefreshLease | null = null;
let collector: VerseAccountCollector | null = null;
let clockOffset = 0;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-lease-retry-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  root = makeRoot();
  clockOffset = 0;
  // Only Date.now moves: the lease's own timers and fs work stay real.
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
});

afterEach(async () => {
  if (collector) { try { await collector.close(); } catch { /* reported inside */ } collector = null; }
  if (held) { try { held.close(false); } catch { /* best effort */ } held = null; }
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('verse account collector — read-only lease retry on touch()', () => {
  it('takes the lease over once its holder released it, instead of staying read-only all session', async () => {
    // Stand in for the daemon publisher holding the lease mid-sample.
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    const logs: string[] = [];
    collector = await startVerseAccountCollector({ accountsRoot: root, log: (m) => logs.push(m) });
    expect(collector.status()).toMatchObject({ mode: 'read-only', owner: 'another-collector', reasonCode: 'collector-owned' });

    // The publisher finishes its sample and releases the lease.
    held.close(false);
    held = null;

    // Within the retry spacing a touch does not hammer the lock.
    collector.touch();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(collector.status().mode).toBe('read-only');

    clockOffset += VERSE_ACCOUNTS_LEASE_RETRY_MS + 1;
    collector.touch();
    expect(await waitFor(() => collector!.status().mode === 'owned')).toBe(true);
    expect(collector.status()).toMatchObject({ mode: 'owned', owner: 'this-server', reasonCode: null });
    expect(logs.some((m) => m.includes('now collects live readings'))).toBe(true);

    // It really holds the lease now: a third party is refused.
    await expect(acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true }))
      .rejects.toMatchObject({ code: 'collector-owned' });

    // And close() releases it again.
    await collector.close();
    collector = null;
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    expect(held).toBeTruthy();
  });

  it('stays read-only (and quiet) while the holder keeps the lease', async () => {
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    const logs: string[] = [];
    collector = await startVerseAccountCollector({ accountsRoot: root, log: (m) => logs.push(m) });
    expect(logs).toHaveLength(1);

    for (let i = 0; i < 3; i += 1) {
      clockOffset += VERSE_ACCOUNTS_LEASE_RETRY_MS + 1;
      collector.touch();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(collector.status()).toMatchObject({ mode: 'read-only', owner: 'another-collector', reasonCode: 'collector-owned' });
    // A refusal for the same reason is not logged again on every touch.
    expect(logs).toHaveLength(1);
  });

  it('a close() racing an in-flight retry hands the lease straight back', async () => {
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    collector = await startVerseAccountCollector({ accountsRoot: root });
    held.close(false);
    held = null;

    clockOffset += VERSE_ACCOUNTS_LEASE_RETRY_MS + 1;
    collector.touch();
    await collector.close();
    collector = null;
    // Whichever finished first, nothing is left holding the lock.
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    expect(held).toBeTruthy();
  });
});

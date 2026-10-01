/**
 * 3.15 — Grok capacity, end to end, through whichever process holds the lease.
 *
 * Follow-up to #558 ("Grok shows its usage again"). That fix lives in the
 * probe helper: after a weekly reset xAI's proto3 JSON omits a zero
 * `creditUsagePercent`, the helper read the absence as "no signal", and the
 * fleet saw `grok: { windows: [], observedAt: null }`. #558's own tests pin the
 * helper against a fake native and the projection chain against a FAKE
 * collector. Nothing drove the REAL chain in between, so three questions asked
 * on Mason's machine (2026-09-27) had no test that could answer them:
 *
 *  (a) Is a Grok probe result with a null-percent window dropped before it
 *      becomes an observation? (observations.json carries no Grok row.)
 *      No: observations.json is the operator-seeded baseline nothing writes;
 *      the live Grok reading lives in the lease holder's connection monitor,
 *      and a null-percent result is still an `observed` row there.
 *  (b) Does the publisher drop the seat or publish it blank? It publishes the
 *      seat with no windows and no observedAt (unknown usage, autonomy off),
 *      and with #558's post-reset reading it publishes 0% and known headroom.
 *  (c) Does the DAEMON's publisher — the one that samples after an idle Verse
 *      hands the lease back (#531) — run the Grok probe at all? Yes: its
 *      collector runs the same connection monitor over every account in
 *      connections.json, Grok included, and it publishes the same reading.
 *
 * Real lease, real ResourceConnectionMonitor, real Grok probe + helper
 * subprocess, real capacity source (discoverSeats → buildSeatTelemetry →
 * capacityFromSeat) and real snapshot/history files, all under a tmp HOME and a
 * tmp accounts root. The "Grok" native is an inert ACP fixture script answering
 * with the exact post-reset billing shape Grok 0.2.118 logged on that machine
 * (period bracketing now, no percent). No real account, network or paid turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  accountsLedgerRoot,
  buildVerseAccountsSnapshot,
  setVerseAccountCollector,
  startVerseAccountCollector,
  type VerseAccountCollector,
} from '../src/core/verse/accounts.js';
import {
  createDaemonCapacityPublisher,
  defaultDaemonCapacityPublisherDeps,
} from '../src/core/daemon/capacity-publisher.js';
import {
  publishCapacitySnapshotFrom,
  setBudgetCapacitySourceForTest,
  startBudgetCapacityPublisher,
} from '../src/core/routing/budget-api.js';
import { capacitySnapshotPath, readCapacitySnapshot, type CapacitySnapshot } from '../src/core/routing/budget-store.js';
import { readCapacityHistory } from '../src/core/routing/capacity-history.js';
import { assessSeat } from '../src/core/routing/headroom.js';
import type { AshlrConfig } from '../src/core/types.js';

const DAY = 86_400_000;
// Real time, taken before any test mocks the clock: the fixture's period must
// bracket every sample, including one taken after an idle hand-back.
const PERIOD_START = new Date(Date.now() - DAY);
const PERIOD_END = new Date(Date.now() + 6 * DAY);
/** Grok's own wire spelling: microseconds and an explicit +00:00 offset. */
const wire = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1076+00:00');
const RESETS_AT = new Date(Date.parse(wire(PERIOD_END))).toISOString();

/** Exactly what Grok logged after the 2026-09-26 12:43:50Z reset: no creditUsagePercent. */
const POST_RESET_BILLING = {
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: wire(PERIOD_START), end: wire(PERIOD_END) },
    onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 }, isUnifiedBillingUser: true,
    billingPeriodStart: wire(PERIOD_START), billingPeriodEnd: wire(PERIOD_END),
  },
  subscription_tier: 'SuperGrok',
};
/** A reply with no period and no percent: genuinely no signal, before and after #558. */
const NO_SIGNAL_BILLING = { config: { isUnifiedBillingUser: true }, subscription_tier: 'SuperGrok' };

const INIT = { protocolVersion: 1, agentCapabilities: {}, _meta: { grokShell: true, agentVersion: '0.2.118' } };
const ACCOUNT = { methodId: 'cached_token', email: 'fixture@example.invalid' };

const POOL = {
  schemaVersion: 1,
  id: 'grok-e2e-fixture',
  workers: [
    { id: 'codex-personal', provider: 'codex', model: 'gpt-6-astra', maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 6, taskWindowMs: 3_600_000, priority: 50 },
  ],
};
// Never spawned: there is no quota-config.json, so no Codex refresher runs.
const BINDINGS = [{ workerId: 'codex-personal', capacityKey: 'personal', kind: 'native-cli',
  command: ['/opt/fixture-does-not-exist/bin/node', '/opt/fixture-does-not-exist/launcher.mjs'] }];

let home: string;
let accountsRoot: string;
let saved: Record<string, string | undefined>;
let collector: VerseAccountCollector | null = null;
let stopVersePublisher: (() => void) | null = null;
let clockOffset = 0;

function writePrivate(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** An inert Grok ACP native that answers the probe's four fixed requests. */
function writeFakeGrok(billing: unknown): string {
  const script = path.join(home, 'fake-grok-native.cjs');
  fs.writeFileSync(script, `
const readline=require('node:readline');
const reader=readline.createInterface({input:process.stdin});
reader.on('line',(line)=>{const r=JSON.parse(line);
 const result=r.id===1?${JSON.stringify(INIT)}:r.id===3?${JSON.stringify(billing)}:${JSON.stringify(ACCOUNT)};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});
reader.on('close',()=>{process.exitCode=0;});
`, { mode: 0o600 });
  return script;
}

function configureGrok(billing: unknown): void {
  writePrivate(path.join(accountsRoot, 'connections.json'), {
    schemaVersion: 1,
    intervalMs: 30_000,
    accounts: [{ id: 'grok', label: 'Grok', provider: 'grok', command: [process.execPath, writeFakeGrok(billing)] }],
  });
}

/** A fresh cfg object per test: budget-api caches seat identity by cfg identity. */
function config(): AshlrConfig {
  // Port 9 (discard) refuses at once, so local-seat discovery never touches a real runtime.
  return { models: { ollama: 'http://127.0.0.1:9' }, verse: { accountsRoot } } as unknown as AshlrConfig;
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function grokRow(c: VerseAccountCollector) {
  return c.connections()?.accounts.find((row) => row.id === 'grok') ?? null;
}

function publishedGrok(snapshot: CapacitySnapshot | null) {
  return snapshot?.seats.find((seat) => seat.seatId === 'grok') ?? null;
}

const AUTONOMY_POLICY = { seatId: 'grok', enabled: true, reservePercent: 20 };

beforeEach(() => {
  saved = {
    HOME: process.env['HOME'],
    ASHLR_CAPACITY_HISTORY: process.env['ASHLR_CAPACITY_HISTORY'],
    ASHLR_VERSE_LOCAL_DISPATCH: process.env['ASHLR_VERSE_LOCAL_DISPATCH'],
  };
  home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ashlr-grok-e2e-')));
  fs.chmodSync(home, 0o700);
  process.env['HOME'] = home;
  delete process.env['ASHLR_CAPACITY_HISTORY'];
  delete process.env['ASHLR_VERSE_LOCAL_DISPATCH'];
  accountsRoot = path.join(home, 'accounts');
  fs.mkdirSync(path.join(accountsRoot, 'ledger'), { recursive: true, mode: 0o700 });
  fs.chmodSync(accountsRoot, 0o700);
  fs.chmodSync(path.join(accountsRoot, 'ledger'), 0o700);
  writePrivate(path.join(accountsRoot, 'pool.json'), POOL);
  writePrivate(path.join(accountsRoot, 'bindings.json'), BINDINGS);
  // Mason's is `[]`, untouched since the pool was created.
  writePrivate(path.join(accountsRoot, 'observations.json'), []);
  clockOffset = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  setBudgetCapacitySourceForTest();
});

afterEach(async () => {
  stopVersePublisher?.();
  stopVersePublisher = null;
  setVerseAccountCollector(null);
  if (collector) { try { await collector.close(); } catch { /* reported inside */ } collector = null; }
  setBudgetCapacitySourceForTest();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('(a) the live Grok reading lives in the lease holder\'s monitor, never in observations.json', () => {
  it('a post-reset reply becomes an observed 0% row; the operator baseline is neither read for it nor written', async () => {
    configureGrok(POST_RESET_BILLING);
    const baselineBefore = fs.readFileSync(path.join(accountsRoot, 'observations.json'));
    collector = await startVerseAccountCollector({ accountsRoot });
    expect(collector.status()).toMatchObject({ mode: 'owned', owner: 'this-server' });

    expect(await waitFor(() => grokRow(collector!)?.state === 'observed')).toBe(true);
    expect(grokRow(collector)).toMatchObject({
      state: 'observed', authentication: 'signed-in', reason: 'probe-observed', planType: 'SuperGrok',
      windows: [{ id: 'grok_unified_weekly', usedPercent: 0, resetsAt: RESETS_AT }],
    });

    const record = buildVerseAccountsSnapshot({ accountsRoot, collector }).accounts.find((a) => a.id === 'grok')!;
    expect(record).toMatchObject({ state: 'observed', binding: { id: 'grok_unified_weekly', usedPercent: 0 } });

    // Nothing writes the baseline, and Grok never rides the Codex-only shared
    // evidence file — "no Grok row in observations.json" is expected, not a symptom.
    expect(fs.readFileSync(path.join(accountsRoot, 'observations.json'))).toEqual(baselineBefore);
    const shared = path.join(accountsLedgerRoot(accountsRoot), '.resource-quota-shared-evidence.json');
    expect(fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8') : '').not.toContain('grok');
  });

  it('a reply with no percent and no period is still an observed row — kept, with the window unmeasured', async () => {
    configureGrok(NO_SIGNAL_BILLING);
    collector = await startVerseAccountCollector({ accountsRoot });
    expect(await waitFor(() => grokRow(collector!)?.state === 'observed')).toBe(true);
    expect(grokRow(collector)).toMatchObject({
      state: 'observed', reason: 'probe-observed', windows: [{ id: 'grok_unified', usedPercent: null, resetsAt: null }],
    });
  });
});

describe('(b) the Verse publisher (lease holder) writes Grok into the fleet\'s capacity snapshot', () => {
  it('post-reset: Grok is published at 0% with its reset, and autonomy sees known headroom', async () => {
    configureGrok(POST_RESET_BILLING);
    const cfg = config();
    collector = await startVerseAccountCollector({ accountsRoot });
    expect(await waitFor(() => grokRow(collector!)?.state === 'observed')).toBe(true);

    // Exactly the Verse server's wiring: the registered collector gates the publisher.
    setVerseAccountCollector(collector);
    stopVersePublisher = startBudgetCapacityPublisher(cfg);
    expect(await waitFor(() => publishedGrok(readCapacitySnapshot()) !== null)).toBe(true);

    const published = publishedGrok(readCapacitySnapshot())!;
    expect(published.windows).toEqual([
      { id: 'grok_unified_weekly', usedPercent: 0, resetsAt: RESETS_AT, resetDescription: null, limitReached: false,
        resetProvenance: { kind: 'fixed-period', source: 'grok-native-billing',
          startsAt: new Date(Date.parse(wire(PERIOD_START))).toISOString(), at: RESETS_AT,
          description: 'Provider weekly billing period.' } },
    ]);
    expect(published.observedAt).toBe(grokRow(collector)!.observedAt);
    const assessed = assessSeat(published, AUTONOMY_POLICY, { nowMs: Date.now() });
    expect(assessed.unknownUsage).toBe(false);
    expect(assessed.headroom.eligibleForAutonomy).toBe(true);
  });

  it('no signal: the seat is published blank and stays off autonomy — unknown usage is never headroom', async () => {
    configureGrok(NO_SIGNAL_BILLING);
    const cfg = config();
    collector = await startVerseAccountCollector({ accountsRoot });
    expect(await waitFor(() => grokRow(collector!)?.state === 'observed')).toBe(true);
    await publishCapacitySnapshotFrom(cfg, collector);

    // The exact row Mason's capacity.json carried from the reset until #558.
    const published = publishedGrok(readCapacitySnapshot())!;
    expect(published).toMatchObject({ windows: [], observedAt: null, signedOut: false });
    const assessed = assessSeat(published, AUTONOMY_POLICY, { nowMs: Date.now() });
    expect(assessed.unknownUsage).toBe(true);
    expect(assessed.headroom.eligibleForAutonomy).toBe(false);
  });
});

describe('(c) the daemon\'s publisher samples Grok itself once an idle Verse hands the lease back', () => {
  it('after the hand-back the daemon\'s own collector probes Grok, publishes it and records it; Verse re-takes the lease', async () => {
    configureGrok(POST_RESET_BILLING);
    const cfg = config();
    collector = await startVerseAccountCollector({ accountsRoot, idleSuspendMs: 60_000, idleCheckMs: 20 });
    expect(collector.status()).toMatchObject({ mode: 'owned' });

    // Nobody looks at Verse for longer than its idle window: it pauses and
    // hands the lease back (#531). Its retained Grok row expires with it.
    clockOffset += 61_000;
    expect(await waitFor(() => collector!.status().mode === 'read-only')).toBe(true);
    expect(collector.status().reasonCode).toBe('connection-polling-paused');
    // Back to real time for the daemon's sample: the probe stamps its reading
    // with `new Date()`, which the Date.now spy does not move, so a shifted
    // clock would read a seconds-old Grok row as already expired.
    clockOffset = 0;

    // The PRODUCTION deps: a real short-lived collector under the lease, the
    // real capacity source, the real snapshot and history stores.
    const logs: string[] = [];
    const daemon = createDaemonCapacityPublisher(cfg, { ...defaultDaemonCapacityPublisherDeps(), log: (m) => logs.push(m) });
    const status = await daemon.cycle();
    expect(status.state, logs.join('\n')).toBe('published');

    const snapshot = readCapacitySnapshot();
    expect(snapshot?.publishedAt).toBe(status.lastPublishedAt);
    const published = publishedGrok(snapshot)!;
    expect(published.windows).toEqual([
      { id: 'grok_unified_weekly', usedPercent: 0, resetsAt: RESETS_AT, resetDescription: null, limitReached: false,
        resetProvenance: { kind: 'fixed-period', source: 'grok-native-billing',
          startsAt: new Date(Date.parse(wire(PERIOD_START))).toISOString(), at: RESETS_AT,
          description: 'Provider weekly billing period.' } },
    ]);
    expect(published.observedAt).not.toBeNull();
    expect(assessSeat(published, AUTONOMY_POLICY, { nowMs: Date.now() }).headroom.eligibleForAutonomy).toBe(true);
    expect(readCapacityHistory().filter((row) => row.seat === 'grok')).toEqual([
      expect.objectContaining({ seat: 'grok', window: 'weekly', usedPct: 0, source: 'daemon' }),
    ]);
    expect(fs.statSync(capacitySnapshotPath()).mode & 0o777).toBe(0o600);

    // The daemon closed its collector: the next Verse request takes the lease straight back.
    collector.touch();
    expect(await waitFor(() => collector!.status().mode === 'owned')).toBe(true);
  });

  it('while Verse holds the lease and publishes, the daemon stays dormant and records Verse\'s Grok reading', async () => {
    configureGrok(POST_RESET_BILLING);
    const cfg = config();
    collector = await startVerseAccountCollector({ accountsRoot });
    expect(await waitFor(() => grokRow(collector!)?.state === 'observed')).toBe(true);
    setVerseAccountCollector(collector);
    stopVersePublisher = startBudgetCapacityPublisher(cfg);
    expect(await waitFor(() => publishedGrok(readCapacitySnapshot()) !== null)).toBe(true);

    let started = 0;
    const daemon = createDaemonCapacityPublisher(cfg, {
      ...defaultDaemonCapacityPublisherDeps(),
      startCollector: async () => { started += 1; throw new Error('a dormant daemon never starts a collector'); },
      log: () => {},
    });
    expect((await daemon.cycle()).state).toBe('dormant');
    expect(started).toBe(0);
    expect(readCapacityHistory().filter((row) => row.seat === 'grok')).toEqual([
      expect.objectContaining({ seat: 'grok', window: 'weekly', usedPct: 0, source: 'daemon' }),
    ]);
  });
});

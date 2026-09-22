/**
 * Tests for src/core/verse/accounts.ts + the seat health path in
 * src/core/verse/seats.ts (owner T, V2.1). See docs/VERSE-TELEMETRY-V2.md.
 *
 * What is proven here:
 *   1. THE ROOT-CAUSE FIX — seats read the LEDGER evidence path
 *      (`<accountsRoot>/ledger/.resource-quota-shared-evidence.json`), not just
 *      the operator-seeded `observations.json`, and live readings merge ON TOP
 *      OF that seed rather than being masked by it.
 *   2. LEASE CONTENTION degrades to read-only instead of throwing: the lock is
 *      exclusive per root, and `ashlr resource-console` legitimately wins it.
 *   3. Per-provider record derivation, including the two facts that are easy to
 *      render as lies: Claude's structurally-null `resetsAt`, and Codex's
 *      hard-denial SENTINEL 100.
 *   4. No launcher command, token, or absolute native-profile path can reach a
 *      route payload.
 *
 * REAL IO: this suite acquires a real collector lease and writes real private
 * files under a tmp root — hence its membership in the real-io lane. It NEVER
 * touches the real ~/.ashlr: every path is an explicit tmp root.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import {
  acquireResourceQuotaRefreshLease,
  type ResourceQuotaRefreshLease,
} from '../src/core/resources/quota-refresh-lease.js';
import { publishSharedQuotaEvidence } from '../src/core/resources/quota-shared-evidence.js';
import type { ResourceAccountConnection } from '../src/core/resources/connection-types.js';
import {
  accountsLedgerRoot,
  bindingWindow,
  buildVerseAccountsSnapshot,
  VERSE_COLLECTOR_STOPPED_NOTE,
  deriveVerseAccountRecord,
  deriveVerseAccountRecordFromEvidence,
  overlayObservations,
  readBaselineObservations,
  readVerseAccountEvidence,
  readVerseAccountIdentities,
  readVerseAccountsConfig,
  startVerseAccountCollector,
  VERSE_ACCOUNTS_DEFAULT_POLL_MS,
  VERSE_ACCOUNTS_MAX_POLL_MS,
  VERSE_ACCOUNTS_MIN_RECOVERIES_PER_WINDOW,
  VERSE_ACCOUNTS_RECOVERIES_PER_POLL_CYCLE,
  VERSE_ACCOUNTS_RECOVERY_WINDOW_MS,
  VERSE_COLLECTOR_RECOVERING_NOTE,
  VERSE_COLLECTOR_RECOVERY_EXHAUSTED_NOTE,
  verseAccountsRecoveryBudget,
  VERSE_CLAUDE_USAGE_PINNED_VERSION,
  VERSE_CLAUDE_VERSION_REASON,
  type VerseAccountCollector,
  type VerseCodexCredits,
} from '../src/core/verse/accounts.js';
import { discoverSeats, refreshSeatTelemetry, seatUsability } from '../src/core/verse/seats.js';

// ---------------------------------------------------------------------------
// Fixture root
// ---------------------------------------------------------------------------

/**
 * A distinctive fake launcher path. Nothing that mentions `native-profiles`
 * may appear in any payload; these exact strings are the canaries.
 */
const FAKE_NODE = '/opt/fixture/bin/node';
const launcherFor = (profile: string) => `/opt/fixture/.ashlr/native-profiles/${profile}/launcher.mjs`;

/** A stand-in for the live bearer tokens in console-startup.json. */
const FAKE_BEARER = 'sk-fixture-live-bearer-token-must-never-leak';

const POOL = {
  schemaVersion: 1,
  id: 'ashlr-subscriptions-fixture',
  workers: [
    { id: 'codex-a', provider: 'codex', model: 'gpt-6-astra', maxConcurrent: 1, reservePercent: 0,
      maxTasksPerWindow: 6, taskWindowMs: 3_600_000, priority: 50 },
    { id: 'claude', provider: 'claude', model: 'opus', maxConcurrent: 1, reservePercent: 0,
      maxTasksPerWindow: 6, taskWindowMs: 3_600_000, priority: 50 },
  ],
};

const BINDINGS = [
  { workerId: 'codex-a', capacityKey: 'personal', kind: 'native-cli', command: [FAKE_NODE, launcherFor('codex-a')] },
  { workerId: 'claude', capacityKey: 'claude', kind: 'native-cli', command: [FAKE_NODE, launcherFor('claude-a')] },
];

const ACCOUNT_HINT = 'a'.repeat(64);

const QUOTA_CONFIG = {
  schemaVersion: 1,
  poolDigest: digest(canonical({ pool: POOL, bindings: BINDINGS })),
  workers: [{ workerId: 'codex-a', accountHint: ACCOUNT_HINT, bucketIds: ['codex'] }],
};

const CONNECTIONS = {
  schemaVersion: 1,
  intervalMs: 30_000,
  accounts: [
    { id: 'codex-a', label: 'Personal Codex', provider: 'codex', command: [FAKE_NODE, launcherFor('codex-a')] },
    { id: 'claude', label: 'Claude Code', provider: 'claude', command: [FAKE_NODE, launcherFor('claude-a')] },
    { id: 'grok', label: 'Grok', provider: 'grok', command: [FAKE_NODE, launcherFor('grok-a')] },
  ],
};

/** The seeded baseline: one Claude row, and NOTHING for codex-a. */
const BASELINE = [
  {
    workerId: 'claude',
    health: 'ready',
    windows: [{ id: 'seven_day', usedPercent: 12, resetsAt: null }],
    observedAt: '2026-09-13T10:00:00.000Z',
  },
];

let root: string;

function writePrivate(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function makeRoot(opts: { baseline?: unknown } = {}): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ashlr-verse-accounts-')));
  fs.chmodSync(base, 0o700);
  fs.mkdirSync(path.join(base, 'ledger'), { mode: 0o700 });
  fs.chmodSync(path.join(base, 'ledger'), 0o700);
  writePrivate(path.join(base, 'pool.json'), POOL);
  writePrivate(path.join(base, 'bindings.json'), BINDINGS);
  writePrivate(path.join(base, 'quota-config.json'), QUOTA_CONFIG);
  writePrivate(path.join(base, 'connections.json'), CONNECTIONS);
  writePrivate(path.join(base, 'observations.json'), opts.baseline ?? BASELINE);
  // The file that holds LIVE BEARER TOKENS. Present on purpose: no code path
  // under test may read it, and the canary below proves it.
  writePrivate(path.join(base, 'console-startup.json'), { readToken: FAKE_BEARER, controlToken: FAKE_BEARER });
  return base;
}

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

const zeroUsage = () => ({ tokens5h: 0, tokens7d: 0, messages5h: 0, messages7d: 0, readAt: 0, filesScanned: 0 });

/** One fresh, valid Codex observation for `codex-a`. */
function freshObservation(usedPercent: number) {
  const now = Date.now();
  return {
    workerId: 'codex-a',
    observedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 45_000).toISOString(),
    health: 'ready' as const,
    windows: [{ id: 'codex_primary', usedPercent, resetsAt: new Date(now + 3_600_000).toISOString() }],
    retryAfter: null,
  };
}

let held: ResourceQuotaRefreshLease | null = null;
let collector: VerseAccountCollector | null = null;
let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  // HOME is relocated for the whole suite so that anything resolving paths at
  // call time — `buildRollup` behind /api/verse/usage-series, the enrollment
  // registry, the claude usage reader — lands in an EMPTY tmp home and never
  // reads the real ~/.ashlr or ~/.claude.
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-accounts-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  root = makeRoot();
});

afterEach(async () => {
  if (collector) { try { await collector.close(); } catch { /* reported inside */ } collector = null; }
  if (held) { try { held.close(true); } catch { /* fence preserved */ } held = null; }
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Config + identities
// ---------------------------------------------------------------------------

describe('verse accounts — configuration', () => {
  it('loads pool, bindings, quota and connection config from the accounts root', () => {
    const config = readVerseAccountsConfig(root);
    expect(config).not.toBeNull();
    expect(config!.ledgerRoot).toBe(path.join(root, 'ledger'));
    expect(accountsLedgerRoot(root)).toBe(path.join(root, 'ledger'));
    expect(config!.pool.id).toBe('ashlr-subscriptions-fixture');
    expect(config!.quota!.workers.map((w) => w.workerId)).toEqual(['codex-a']);
    expect(config!.connections!.accounts.map((a) => a.id)).toEqual(['codex-a', 'claude', 'grok']);
  });

  it('clamps the poll interval into the range the monitor accepts', () => {
    expect(readVerseAccountsConfig(root, 1_000)!.connections!.intervalMs).toBe(30_000);
    expect(readVerseAccountsConfig(root, 120_000)!.connections!.intervalMs).toBe(120_000);
    expect(readVerseAccountsConfig(root, 10_000_000)!.connections!.intervalMs).toBe(3_600_000);
    expect(VERSE_ACCOUNTS_DEFAULT_POLL_MS).toBe(30_000);
  });

  it('returns null rather than throwing when the accounts root has no pool', () => {
    expect(readVerseAccountsConfig(path.join(root, 'missing'))).toBeNull();
  });

  it('reads only id/label/provider from connections.json — never the launcher command', () => {
    const identities = readVerseAccountIdentities(root);
    expect(identities).toEqual([
      { id: 'codex-a', label: 'Personal Codex', provider: 'codex' },
      { id: 'claude', label: 'Claude Code', provider: 'claude' },
      { id: 'grok', label: 'Grok', provider: 'grok' },
    ]);
    expect(JSON.stringify(identities)).not.toContain('launcher');
  });
});

// ---------------------------------------------------------------------------
// THE ROOT-CAUSE FIX — the ledger evidence path
// ---------------------------------------------------------------------------

describe('verse accounts — evidence precedence', () => {
  it('overlays live readings on top of the seeded baseline, never the other way round', () => {
    const base = new Map([
      ['claude', { health: 'ready', windows: [{ id: 'seven_day', usedPercent: 12, resetsAt: null }], observedAt: 'seed' }],
      ['codex-a', { health: 'ready', windows: [{ id: 'codex_primary', usedPercent: 1, resetsAt: null }], observedAt: 'seed' }],
    ]);
    const live = new Map([
      ['codex-a', { health: 'ready', windows: [{ id: 'codex_primary', usedPercent: 88, resetsAt: null }], observedAt: 'live' }],
    ]);
    const merged = overlayObservations(base, live);
    expect(merged.get('codex-a')!.windows[0]!.usedPercent).toBe(88);
    // A baseline row with no live counterpart survives.
    expect(merged.get('claude')!.observedAt).toBe('seed');
    // The inputs are not mutated.
    expect(base.get('codex-a')!.windows[0]!.usedPercent).toBe(1);
  });

  it('falls back to the operator-seeded baseline and says so', () => {
    const evidence = readVerseAccountEvidence(root);
    expect(evidence.source).toBe('baseline');
    expect(evidence.byAccount.get('claude')!.windows[0]!.usedPercent).toBe(12);
    expect(evidence.byAccount.has('codex-a')).toBe(false);
    expect(readBaselineObservations(root).size).toBe(1);
  });

  it('reports "none" for an empty seed — no signal is not zero', () => {
    const empty = makeRoot({ baseline: [] });
    try {
      const evidence = readVerseAccountEvidence(empty);
      expect(evidence.source).toBe('none');
      expect(evidence.byAccount.size).toBe(0);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reads the LEDGER shared-evidence file, which is where the live data actually lives', async () => {
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    held.markPending();
    publishSharedQuotaEvidence({
      root: accountsLedgerRoot(root),
      pool: POOL as never,
      bindings: BINDINGS as never,
      config: QUOTA_CONFIG as never,
      lease: held,
      state: 'running',
      evidence: { observations: [freshObservation(42)] as never, unavailableWorkerIds: [] },
    });

    const evidence = readVerseAccountEvidence(root);
    expect(evidence.source).toBe('shared-evidence');
    expect(evidence.ownerNote).toContain('read-only');
    // The live Codex reading arrived…
    expect(evidence.byAccount.get('codex-a')!.windows[0]!.usedPercent).toBe(42);
    // …and the seeded Claude baseline still survives underneath it.
    expect(evidence.byAccount.get('claude')!.windows[0]!.usedPercent).toBe(12);
  });

  it('seats render the ledger reading — the file the V1 code never opened', async () => {
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    held.markPending();
    publishSharedQuotaEvidence({
      root: accountsLedgerRoot(root),
      pool: POOL as never,
      bindings: BINDINGS as never,
      config: QUOTA_CONFIG as never,
      lease: held,
      state: 'running',
      evidence: { observations: [freshObservation(73)] as never, unavailableWorkerIds: [] },
    });

    const discovery = await discoverSeats(makeConfig(root), { accountsRoot: root, claudeUsage: zeroUsage });
    const codex = discovery.seats.find((s) => s.id === 'codex-a')!;
    expect(codex.health.state).toBe('ready');
    expect(codex.health.windows).toEqual([
      { id: 'codex_primary', usedPercent: 73, resetsAt: expect.any(String) },
    ]);
    expect(codex.health.summary).toContain('codex_primary window 73% used');

    // The seed is still the floor for accounts with no live reading.
    const claude = discovery.seats.find((s) => s.id === 'claude')!;
    expect(claude.health.windows[0]!.usedPercent).toBe(12);

    // The launcher is still the account's private identity.
    const wire = JSON.stringify(discovery.seats);
    expect(wire).not.toContain('launcher');
    expect(wire).not.toContain('native-profiles');
  });
});

// ---------------------------------------------------------------------------
// Lease contention
// ---------------------------------------------------------------------------

describe('verse accounts — collector lifecycle', () => {
  it('degrades to read-only when another collector owns the exclusive lease, instead of throwing', async () => {
    // Stand in for `ashlr resource-console` already holding the lock.
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    held.markPending();

    collector = await startVerseAccountCollector({ accountsRoot: root });
    const status = collector.status();
    expect(status.mode).toBe('read-only');
    expect(status.owner).toBe('another-collector');
    expect(status.reasonCode).toBe('collector-owned');
    expect(status.state).toBe('blocked');
    expect(status.note).toContain('resource-console');
    // A read-only collector spawns nothing and reports no live connections.
    expect(collector.connections()).toBeNull();
    expect(collector.observations()).toEqual([]);
    await expect(collector.close()).resolves.toBeUndefined();
    collector = null;
  });

  it('reports "not configured" for a root with no collector inputs, without throwing', async () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ashlr-verse-bare-')));
    try {
      collector = await startVerseAccountCollector({ accountsRoot: bare });
      const status = collector.status();
      expect(status.mode).toBe('unconfigured');
      expect(status.reasonCode).toBe('accounts-pool-unavailable');
      expect(collector.connections()).toBeNull();
      await collector.close();
      collector = null;
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('surfaces the read-only collector in the snapshot rather than an unexplained blank', async () => {
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    held.markPending();
    collector = await startVerseAccountCollector({ accountsRoot: root });

    const snapshot = buildVerseAccountsSnapshot({ accountsRoot: root, collector });
    expect(snapshot.collector.mode).toBe('read-only');
    expect(snapshot.collector.reasonCode).toBe('collector-owned');
    expect(snapshot.accounts.map((a) => a.id)).toEqual(['codex-a', 'claude', 'grok']);
    // Degraded records carry the reason, not a fabricated reading.
    expect(snapshot.accounts.every((a) => a.reason === 'collector-owned')).toBe(true);
    expect(snapshot.accounts.find((a) => a.id === 'codex-a')!.windows).toEqual([]);
    expect(snapshot.accounts.find((a) => a.id === 'claude')!.windows[0]!.usedPercent).toBe(12);
  });

  // ── Integration regression (V2.1) ───────────────────────────────────────
  //
  // Live-verified failure: with the lease HELD and the collector nominally
  // `owned`, `ResourceConnectionMonitor` latched after its first sample whose
  // native cleanup could not be confirmed. It projects every row to
  // `connection-monitor-stopped` and never reschedules, but the object stays
  // non-null — so the collector reported `state: 'running'` with the note
  // "readings are live" over four permanently dead accounts. A confident
  // banner on top of nothing is the exact failure this surface exists to
  // prevent, so the status must demote, matching `collectorLifecycle()` in
  // core/web/resource-console-server.ts.
  it('states plainly that collection stopped instead of claiming the readings are live', () => {
    const stopped: VerseAccountCollector = {
      accountsRoot: root,
      status: () => ({
        mode: 'owned',
        state: 'blocked',
        owner: 'this-server',
        reasonCode: 'collector-unavailable',
        pollIntervalMs: 30_000,
        idleSuspendMs: 300_000,
        lastPolledAt: '2026-09-20T05:30:13.906Z',
        lastRequestAt: '2026-09-20T05:30:20.000Z',
        note: VERSE_COLLECTOR_STOPPED_NOTE,
      }),
      touch: () => {},
      connections: () => null,
      observations: () => [],
      credits: () => null,
      close: async () => {},
    };

    const snapshot = buildVerseAccountsSnapshot({ accountsRoot: root, collector: stopped });
    expect(snapshot.collector.state).not.toBe('running');
    expect(snapshot.collector.reasonCode).toBe('collector-unavailable');
    expect(snapshot.notes).toContain(VERSE_COLLECTOR_STOPPED_NOTE);
    // The remedy is stated and no private path is named to state it.
    expect(VERSE_COLLECTOR_STOPPED_NOTE).toMatch(/ashlr verse/);
    for (const forbidden of ['launcher.mjs', 'native-profiles', 'account-connections', os.homedir()]) {
      expect(JSON.stringify(snapshot)).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-provider record derivation
// ---------------------------------------------------------------------------

function connection(overrides: Partial<ResourceAccountConnection>): ResourceAccountConnection {
  return {
    id: 'x', label: 'X', provider: 'codex', state: 'observed', authentication: 'signed-in',
    health: 'reachable', planType: null, observedAt: '2026-09-19T12:00:00.000Z',
    expiresAt: '2026-09-19T12:01:00.000Z', windows: [], reason: 'probe-observed',
    onDemandEnabled: null, executionSupported: true, ...overrides,
  };
}

describe('verse accounts — per-provider derivation', () => {
  it('CLAUDE: resetsAt stays null and the provider\'s own reset wording is preserved verbatim', () => {
    const record = deriveVerseAccountRecord(connection({
      id: 'claude', label: 'Claude Code', provider: 'claude', health: 'unknown', planType: 'max',
      reason: 'usage-observed',
      windows: [
        { id: 'five_hour', usedPercent: 47, resetsAt: null,
          nativeReport: { source: 'claude-usage', resetDescription: 'Sep 20 at 2:30am (America/New_York)' } },
        { id: 'seven_day', usedPercent: 58, resetsAt: null,
          nativeReport: { source: 'claude-usage', resetDescription: 'Sep 25 at 7pm (America/New_York)' } },
        { id: 'seven_day_fable', usedPercent: 100, resetsAt: null,
          nativeReport: { source: 'claude-usage', resetDescription: 'Sep 25 at 7pm (America/New_York)' } },
      ],
    }));

    expect(record.windows.every((w) => w.resetsAt === null)).toBe(true);
    expect(record.windows[0]!.nativeReport!.resetDescription).toBe('Sep 20 at 2:30am (America/New_York)');
    // Claude's 100% IS a measurement — the sentinel rule is Codex-only.
    expect(record.windows[2]!.limitReached).toBe(false);
    expect(record.windows[2]!.measured).toBe(true);
    // The per-model weekly window is the one that actually bites.
    expect(record.binding).toEqual({ id: 'seven_day_fable', usedPercent: 100, limitReached: false });
    expect(record.notes.some((n) => n.includes('no machine-readable reset time'))).toBe(true);
    expect(record.notes.some((n) => n.includes('"unknown" by construction'))).toBe(true);
    expect(record.credits).toBeNull();
  });

  it('CLAUDE: names the version pin verbatim when the probe fails closed', () => {
    const record = deriveVerseAccountRecord(connection({
      id: 'claude', provider: 'claude', state: 'unavailable', health: 'unknown',
      reason: VERSE_CLAUDE_VERSION_REASON, windows: [],
    }));
    expect(record.reason).toBe('usage-version-unsupported');
    const note = record.notes.find((n) => n.includes(VERSE_CLAUDE_VERSION_REASON))!;
    expect(note).toContain(VERSE_CLAUDE_USAGE_PINNED_VERSION);
    expect(note).toContain('claude-account-usage.ts');
  });

  /**
   * UPDATED DELIBERATELY (V2.1 fixer pass). This used to assert that a Codex
   * window at exactly 100 IS the `rateLimitReachedType` sentinel. That
   * assertion cannot be honoured, because the distinguishing field is
   * destroyed upstream: `normalizeCodexResourceObservation` writes a
   * classified `rateLimitReachedType` as `usedPercent: 100` and then DROPS
   * the flag, while `codexWindow()` clamps a genuine reading with
   * `Math.min(100, raw)`. The telemetry doc's own verified Codex payload
   * (docs/VERSE-TELEMETRY-V2.md:40-43) is a MEASURED `used_percent: 100.0`
   * with no `rateLimitReachedType` — exactly the case the old inference got
   * backwards, and it then SUPPRESSED the real number behind prose claiming a
   * provenance nothing here could witness. A measured 100% is true under both
   * provenances; the sentinel claim is not.
   */
  it('CODEX: reports a bare 100 as the measurement it is, and does not claim a sentinel', () => {
    const record = deriveVerseAccountRecord(connection({
      id: 'codex-a', label: 'Personal Codex', provider: 'codex', planType: 'pro',
      windows: [
        { id: 'codex_primary', usedPercent: 100, resetsAt: '2026-09-26T00:00:00.000Z' },
        { id: 'codex_secondary', usedPercent: 63, resetsAt: '2026-09-21T00:00:00.000Z' },
      ],
    }), { credits: { hasCredits: true, unlimited: false, balance: '2048.4196250000' } });

    const primary = record.windows[0]!;
    expect(primary.limitReached).toBe(false);
    expect(primary.measured).toBe(true);
    expect(primary.usedPercent).toBe(100);
    const secondary = record.windows[1]!;
    expect(secondary.limitReached).toBe(false);
    expect(secondary.measured).toBe(true);
    expect(record.binding).toEqual({ id: 'codex_primary', usedPercent: 100, limitReached: false });

    // Credits are INDEPENDENT of the window: 100% used is not "blocked".
    expect(record.credits).toEqual({ hasCredits: true, unlimited: false, balance: '2048.4196250000' });
    expect(record.planType).toBe('pro');
    // The provenance ambiguity is STATED rather than resolved by guessing.
    expect(record.notes.some((n) => n.includes('does not claim which'))).toBe(true);
    expect(record.notes.some((n) => n.includes('independent of the window'))).toBe(true);
  });

  it('CODEX: honours a limitReached flag when the upstream actually supplies one', () => {
    const record = deriveVerseAccountRecord(connection({
      id: 'codex-a', provider: 'codex',
      // `ResourceQuotaWindow` is key-exact-validated in pool-policy.ts, so the
      // flag does not reach here today; this pins the behaviour for the day it
      // is threaded through, so the fix lands in one place.
      windows: [{ id: 'codex_primary', usedPercent: 100, resetsAt: null, limitReached: true } as
        ResourceAccountConnection['windows'][number] & { limitReached: true }],
    }), { credits: null });
    expect(record.windows[0]!.limitReached).toBe(true);
    expect(record.windows[0]!.measured).toBe(false);
    expect(record.notes.some((n) => n.includes('that flag is a denial'))).toBe(true);
  });

  it('CODEX: absent credits read as unknown, never as zero', () => {
    const record = deriveVerseAccountRecord(connection({ id: 'codex-b', provider: 'codex' }), { credits: null });
    expect(record.credits).toBeNull();
    expect(record.notes.some((n) => n.includes('unknown, not zero'))).toBe(true);
  });

  /**
   * UPDATED DELIBERATELY (V2.1 fixer pass). The old fixture hand-built
   * `state: 'signed-out', authentication: 'signed-out'` with a reason string
   * (`grok-not-authenticated`) that is not in grok-account-probe.ts's REASONS
   * set — a row `ResourceConnectionMonitor` never produces. It cannot: Grok's
   * `checkedOutput` REJECTS any `observed` result whose `loggedIn` is not
   * exactly `true`, so an unauthenticated profile comes back `failed` and the
   * monitor leaves the row on its `connection-probe-unavailable` initializer.
   * This fixture is now shaped like what the monitor actually emits.
   */
  it('GROK: an unauthenticated probe reason renders as signed out, with a reconnect route and no launcher command', () => {
    const record = deriveVerseAccountRecord(connection({
      id: 'grok', label: 'Grok', provider: 'grok', state: 'unavailable', authentication: 'unknown',
      health: 'unavailable', reason: 'probe-account-unavailable', executionSupported: false, windows: [],
      planType: null, observedAt: null, expiresAt: null,
    }));
    expect(record.state).toBe('signed-out');
    expect(record.authentication).toBe('signed-out');
    // The verbatim probe code still rides along untouched.
    expect(record.reason).toBe('probe-account-unavailable');
    expect(record.binding).toBeNull();
    expect(record.notes.some((n) => n.includes('Re-authenticate'))).toBe(true);
    expect(record.notes.some((n) => n.includes('frontier-usage.ts'))).toBe(true);
    expect(JSON.stringify(record)).not.toContain('launcher');
  });

  it('GROK: an identity-change or transport reason is NOT rewritten as signed out', () => {
    for (const reason of ['probe-account-changed', 'probe-account-hint-mismatch', 'probe-native-unavailable',
      'connection-monitor-stopped']) {
      const record = deriveVerseAccountRecord(connection({
        id: 'grok', provider: 'grok', state: 'unavailable', authentication: 'unknown',
        health: 'unavailable', reason, executionSupported: false, windows: [],
      }));
      expect(record.state, reason).toBe('unavailable');
      expect(record.authentication, reason).toBe('unknown');
      expect(record.notes.some((n) => n.includes('Re-authenticate')), reason).toBe(false);
    }
  });

  it('binding picks the highest used percent and ignores windows with no signal', () => {
    expect(bindingWindow([])).toBeNull();
    expect(bindingWindow([
      { id: 'a', usedPercent: null, resetsAt: null, nativeReport: null, limitReached: false, measured: true },
    ])).toBeNull();
    expect(bindingWindow([
      { id: 'a', usedPercent: 10, resetsAt: null, nativeReport: null, limitReached: false, measured: true },
      { id: 'b', usedPercent: 90, resetsAt: null, nativeReport: null, limitReached: false, measured: true },
      { id: 'c', usedPercent: null, resetsAt: null, nativeReport: null, limitReached: false, measured: true },
    ])!.id).toBe('b');
  });

  it('evidence-only records state their reason instead of implying a reading', () => {
    const record = deriveVerseAccountRecordFromEvidence(
      { id: 'grok', label: 'Grok', provider: 'grok' }, null, 'connection-not-checked');
    expect(record.state).toBe('unavailable');
    expect(record.health).toBe('unknown');
    expect(record.authentication).toBe('unknown');
    expect(record.reason).toBe('connection-not-checked');
    expect(record.executionSupported).toBe(false);
    expect(record.windows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Security canaries
// ---------------------------------------------------------------------------

describe('verse accounts — nothing private reaches a payload', () => {
  it('never carries a launcher command, a native-profile path, or a console-startup token', () => {
    const snapshot = buildVerseAccountsSnapshot({ accountsRoot: root, collector: null });
    const wire = JSON.stringify(snapshot);

    expect(wire).not.toContain(FAKE_BEARER);
    expect(wire).not.toContain('native-profiles');
    expect(wire).not.toContain('launcher.mjs');
    expect(wire).not.toContain(FAKE_NODE);
    expect(wire).not.toContain(launcherFor('codex-a'));
    expect(wire).not.toContain('console-startup');
    // No absolute path of any kind: this body names accounts, not the filesystem.
    expect(wire).not.toContain(root);
    expect(/"[^"]*\/(?:Users|opt|home)\//.test(wire)).toBe(false);

    // …while still answering the question the view exists to answer.
    expect(snapshot.accounts.map((a) => a.id)).toEqual(['codex-a', 'claude', 'grok']);
    expect(snapshot.collector.mode).toBe('unconfigured');
    expect(snapshot.evidenceSource).toBe('baseline');
    expect(snapshot.notes.some((n) => n.includes('zero tokens'))).toBe(true);
  });

  it('keeps every V2.1 route body free of private material', async () => {
    const { handleVerseControlApi, isVerseControlPath } = await import('../src/core/verse/control-api.js');
    const ctx = { cfg: makeConfig(root), token: 'test-mutation-token', allowDispatch: false };

    for (const route of ['/api/verse/accounts', '/api/verse/usage-series', '/api/verse/local-models']) {
      expect(isVerseControlPath(route)).toBe(true);
      const captured: { status?: number; body?: string } = {};
      const res = {
        headersSent: false,
        writableEnded: false,
        setHeader: () => {},
        writeHead: (status: number) => { captured.status = status; },
        end: (payload?: string) => { captured.body = payload; },
      } as unknown as import('node:http').ServerResponse;
      const req = { url: route, method: 'GET', headers: {} } as unknown as import('node:http').IncomingMessage;

      const handled = await handleVerseControlApi(ctx, req, res, route, 'GET');
      expect(handled).toBe(true);
      expect(captured.status).toBe(200);
      const wire = captured.body ?? '';
      expect(wire.length).toBeGreaterThan(2);
      expect(wire).not.toContain(FAKE_BEARER);
      expect(wire).not.toContain('native-profiles');
      expect(wire).not.toContain('launcher.mjs');
      expect(wire).not.toContain(FAKE_NODE);
      expect(wire).not.toContain(ctx.token);
    }
  });

  it('rejects an unsupported usage-series window instead of guessing one', async () => {
    const { handleVerseControlApi } = await import('../src/core/verse/control-api.js');
    const captured: { status?: number; body?: string } = {};
    const res = {
      headersSent: false,
      writableEnded: false,
      setHeader: () => {},
      writeHead: (status: number) => { captured.status = status; },
      end: (payload?: string) => { captured.body = payload; },
    } as unknown as import('node:http').ServerResponse;
    const req = {
      url: '/api/verse/usage-series?window=1y', method: 'GET', headers: {},
    } as unknown as import('node:http').IncomingMessage;

    await handleVerseControlApi(
      { cfg: makeConfig(root), token: 't', allowDispatch: false },
      req, res, '/api/verse/usage-series', 'GET');
    expect(captured.status).toBe(400);
    expect(captured.body).toContain('VERSE_INVALID');
  });

  it('keeps the canary out of the seat payload too', async () => {
    const discovery = await discoverSeats(makeConfig(root), { accountsRoot: root, claudeUsage: zeroUsage });
    const wire = JSON.stringify(discovery.seats);
    expect(wire).not.toContain(FAKE_BEARER);
    expect(wire).not.toContain('native-profiles');
    expect(wire).not.toContain(FAKE_NODE);
  });
});

// ---------------------------------------------------------------------------
// Regression (V2.1): a stranded native process group must not kill the
// collector for the life of the process
// ---------------------------------------------------------------------------
//
// MEASURED ROOT CAUSE. `codex app-server` kicks off a background
// `git clone --depth 1 …/openai/plugins.git` into its CODEX_HOME. That clone
// inherits the probe's POSIX process group, outlives both the App Server and
// the probe helper (it reparents to PID 1), and so keeps the group alive past
// the fixed post-close drain in `runVerifySubprocessAsync`. The resulting
// `processGroupSettlement: 'unconfirmed'` is CORRECT — the group really was
// still there — and the probe correctly reports `status: 'uncertain'`.
//
// What was wrong was the response. One such sample latched
// `ResourceConnectionMonitor`, aborted the shared coordinator, stranded the
// lease reservation in phase `registered` forever, and left the collector
// reporting `blocked` until `ashlr verse` was restarted — so a transient,
// self-clearing clone permanently blanked the entire telemetry feature.
//
// `unconfirmed` means "not witnessed YET". These tests pin the two halves of
// the fix: the witness can be FINISHED later, and only on kernel-confirmed
// absence; and a collector that stopped for that reason starts a new
// generation by itself without leaking the lease.

function heldProcessGroup(): { pgid: number; stop(): void } {
  const child = childProcess.spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  child.unref();
  return {
    pgid: child.pid!,
    stop() { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } },
  };
}

async function processGroupGone(pgid: number, budgetMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try { process.kill(-pgid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function until(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function activityReservations(ledger: string): unknown[] {
  const raw = fs.readFileSync(path.join(ledger, '.resource-quota-refresh-activity.json'), 'utf8');
  return (JSON.parse(raw) as { reservations: unknown[] }).reservations;
}

/** Is the pid recorded by the fixture launcher still alive? */
function lingeringChildAlive(pidFile: string): boolean {
  let pid: number;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); }
  catch { return false; }
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

describe('verse accounts — stranded native cleanup recovery', () => {
  it('holds the fence while the stranded group lives, then releases it on kernel-confirmed absence', async () => {
    const ledger = accountsLedgerRoot(root);
    held = await acquireResourceQuotaRefreshLease(ledger, { trackNativeActivity: true });
    held.markPending();

    // Reproduce the production shape exactly: prepare + spawned, and then NO
    // `settled()` — which is what an `unconfirmed` receipt leaves behind.
    const phase = held.beginNativeActivity().processGroupLifecycle.prepare();
    const group = heldProcessGroup();
    phase.spawned(group.pgid);

    expect(held.reclaimNativeActivity())
      .toEqual({ state: 'blocked', reasonCode: 'process-group-not-confirmed-absent' });
    // The durable fence is untouched while absence is unproven.
    expect(activityReservations(ledger)).toHaveLength(1);

    group.stop();
    expect(await processGroupGone(group.pgid)).toBe(true);

    expect(held.reclaimNativeActivity()).toEqual({ state: 'reclaimed', released: 1 });
    expect(activityReservations(ledger)).toEqual([]);
    expect(held.reclaimNativeActivity()).toEqual({ state: 'idle' });

    // Discharged for real: the NON-preserving close now succeeds, so the
    // pending marker and the exclusive lock are both handed back.
    held.close(false);
    expect(fs.existsSync(path.join(ledger, '.resource-quota-refresh-pending.json'))).toBe(false);
    expect(fs.existsSync(path.join(ledger, '.resource-quota-refresh.lock'))).toBe(false);
    held = null;
  }, 40_000);

  it('never releases a reservation that published no process group', async () => {
    const ledger = accountsLedgerRoot(root);
    held = await acquireResourceQuotaRefreshLease(ledger, { trackNativeActivity: true });
    held.markPending();
    // `preparing`: the owner may have spawned native work but not yet named the
    // group, so absence is unprovable and must stay unrecoverable.
    held.beginNativeActivity().processGroupLifecycle.prepare();
    expect(held.reclaimNativeActivity())
      .toEqual({ state: 'blocked', reasonCode: 'command-registration-incomplete' });
    expect(activityReservations(ledger)).toHaveLength(1);
  });

  it('refuses reclamation on a lease that never tracked native activity', async () => {
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), {});
    held.markPending();
    expect(held.reclaimNativeActivity())
      .toEqual({ state: 'blocked', reasonCode: 'activity-evidence-unavailable' });
  });

  it('bounds recovery to roughly one new generation per poll cycle', () => {
    expect(verseAccountsRecoveryBudget(VERSE_ACCOUNTS_DEFAULT_POLL_MS))
      .toBe((VERSE_ACCOUNTS_RECOVERY_WINDOW_MS / VERSE_ACCOUNTS_DEFAULT_POLL_MS)
        * VERSE_ACCOUNTS_RECOVERIES_PER_POLL_CYCLE);
    // A long cadence still gets a usable floor rather than an unreachable budget.
    expect(verseAccountsRecoveryBudget(VERSE_ACCOUNTS_MAX_POLL_MS))
      .toBe(VERSE_ACCOUNTS_MIN_RECOVERIES_PER_WINDOW);
    // And it is a CAP, not a licence to spin: never unbounded.
    expect(Number.isFinite(verseAccountsRecoveryBudget(1))).toBe(true);
  });

  it('stops telling the reader to restart once a new generation is already on the way', () => {
    const recovering: VerseAccountCollector = {
      accountsRoot: root,
      status: () => ({
        mode: 'owned', state: 'blocked', owner: 'this-server', reasonCode: 'collector-unavailable',
        pollIntervalMs: 30_000, idleSuspendMs: 300_000,
        lastPolledAt: '2026-09-20T06:24:21.061Z', lastRequestAt: '2026-09-20T06:24:21.061Z',
        note: VERSE_COLLECTOR_RECOVERING_NOTE,
      }),
      touch: () => {}, connections: () => null, observations: () => [], credits: () => null,
      close: async () => {},
    };
    const snapshot = buildVerseAccountsSnapshot({ accountsRoot: root, collector: recovering });
    expect(snapshot.notes).toContain(VERSE_COLLECTOR_RECOVERING_NOTE);
    expect(snapshot.notes).not.toContain(VERSE_COLLECTOR_STOPPED_NOTE);
    // It may mention a restart only to say one is NOT needed; it must never ask for one.
    expect(VERSE_COLLECTOR_RECOVERING_NOTE).not.toMatch(/Restart `ashlr verse`/);
    expect(VERSE_COLLECTOR_RECOVERING_NOTE).toMatch(/No restart is needed/);
    // The exhausted wording is the one that may still ask for a restart.
    expect(VERSE_COLLECTOR_RECOVERY_EXHAUSTED_NOTE).toMatch(/ashlr verse/);
  });

  it('starts a NEW collection generation by itself after a probe leaves a lingering process group', async () => {
    // A launcher that, on its FIRST run only, leaves a grandchild alive in its
    // own POSIX group and exits — the same shape as the background git clone.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ashlr-verse-linger-')));
    fs.chmodSync(base, 0o700);
    const ledger = path.join(base, 'ledger');
    fs.mkdirSync(ledger, { mode: 0o700 });
    fs.chmodSync(ledger, 0o700);
    const marker = path.join(base, 'leaked-once');
    const pidFile = path.join(base, 'lingering.pid');
    const launcher = path.join(base, 'launcher.mjs');
    fs.writeFileSync(launcher, [
      "import { spawn } from 'node:child_process';",
      "import { existsSync, writeFileSync } from 'node:fs';",
      `const marker = ${JSON.stringify(marker)};`,
      `const pidFile = ${JSON.stringify(pidFile)};`,
      'if (!existsSync(marker)) {',
      "  writeFileSync(marker, 'x');",
      "  const child = spawn('/bin/sleep', ['4'], { detached: false, stdio: 'ignore' });",
      '  writeFileSync(pidFile, String(child.pid));',
      '  child.unref();',
      '}',
      'process.exit(0);',
    ].join('\n'), { mode: 0o600 });
    writePrivate(path.join(base, 'pool.json'), POOL);
    writePrivate(path.join(base, 'bindings.json'), BINDINGS);
    writePrivate(path.join(base, 'observations.json'), []);
    // Connections only: no quota-config.json, so the monitor is the only collector.
    writePrivate(path.join(base, 'connections.json'), {
      schemaVersion: 1,
      intervalMs: 30_000,
      accounts: [{ id: 'grok', label: 'Grok', provider: 'grok', command: [process.execPath, launcher] }],
    });

    let local: VerseAccountCollector | null = null;
    try {
      local = await startVerseAccountCollector({ accountsRoot: base });
      expect(local.status().mode).toBe('owned');

      // 1. The lingering group stops the first generation. This is the bug.
      const stopped = await until(() => local!.status().state === 'blocked', 30_000);
      expect(stopped).toBe(true);
      expect(fs.existsSync(marker)).toBe(true);

      // 2. And it recovers with no restart and no operator action — `touch()`
      //    is exactly what a page refresh does.
      //
      //    While recovering, the INVARIANT must hold at every sample: the
      //    collector never reports live collection while a native reservation
      //    is still outstanding in the durable activity record. That is what
      //    stops a page refresh (or an idle-suspend/resume) from restarting
      //    probes behind an undischarged fence.
      const violations: string[] = [];
      const recovered = await until(() => {
        local!.touch();
        const status = local!.status();
        if (status.state === 'running' && lingeringChildAlive(pidFile)) violations.push(status.note);
        return status.state === 'running';
      }, 40_000);
      expect(violations).toEqual([]);
      expect(recovered).toBe(true);
      // The witness really was finished, not skipped.
      expect(lingeringChildAlive(pidFile)).toBe(false);
      expect(local.status().note).toContain('readings are live');

      // 3. The lease is handed back cleanly: the fence was discharged by a
      //    confirmed witness, not preserved by an unresolved one.
      await local.close();
      local = null;
      expect(fs.existsSync(path.join(ledger, '.resource-quota-refresh-pending.json'))).toBe(false);
      expect(fs.existsSync(path.join(ledger, '.resource-quota-refresh.lock'))).toBe(false);
      expect(activityReservations(ledger)).toEqual([]);
    } finally {
      if (local) { try { await local.close(); } catch { /* reported inside */ } }
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Seat health comes from the LIVE collector (V2.1 regression)
// ---------------------------------------------------------------------------
//
// MEASURED ROOT CAUSE. Seat health was derived from `readVerseAccountEvidence`,
// whose best source is the shared quota evidence file. That file's scope is
// literally `codex-native-metadata`: it structurally CANNOT carry Claude or
// Grok. Against a live server, warmed for 75 seconds:
//
//   source                        codex-*      claude                grok
//   GET /api/verse/accounts       observed     observed, 3 windows   observed
//   bootstrap.seats[].health      ready        UNKNOWN (forever)     UNKNOWN
//
// Both halves were served by the same process from the same monitor. These
// tests pin the seat half to the live rows.

const LIVE_AT = '2026-09-20T05:31:00.000Z';

/** The four accounts exactly as measured on this machine, 2026-09-20. */
function liveConnections(): ResourceAccountConnection[] {
  const codex = (id: string, label: string, resetsAt: string): ResourceAccountConnection => ({
    id, label, provider: 'codex', state: 'observed', authentication: 'signed-in',
    health: 'reachable', planType: 'pro', observedAt: LIVE_AT, expiresAt: null,
    windows: [{ id: 'codex_codex_primary', usedPercent: 100, resetsAt }],
    reason: 'probe-observed', onDemandEnabled: null, executionSupported: true,
  });
  const claudeWindow = (id: string, usedPercent: number, resetDescription: string) => ({
    // Claude's machine-readable reset is STRUCTURALLY null; the sentence is all
    // the provider publishes and it is carried verbatim.
    id, usedPercent, resetsAt: null,
    nativeReport: { source: 'claude-usage' as const, resetDescription },
  });
  return [
    codex('codex-personal', 'Personal Codex', '2026-09-25T18:25:44.000Z'),
    codex('codex-cmp', 'CMP Codex', '2026-09-26T03:46:56.000Z'),
    {
      id: 'claude', label: 'Claude Code', provider: 'claude', state: 'observed',
      authentication: 'signed-in',
      // Always `unknown` for Claude BY CONSTRUCTION — not a fault, and it must
      // not be allowed to demote the seat.
      health: 'unknown', planType: 'max', observedAt: LIVE_AT, expiresAt: null,
      windows: [
        claudeWindow('five_hour', 15, 'Sep 21 at 1:40am (America/New_York)'),
        claudeWindow('seven_day', 85, 'Sep 25 at 7pm (America/New_York)'),
        claudeWindow('seven_day_fable', 100, 'Sep 25 at 7pm (America/New_York)'),
      ],
      reason: 'probe-observed', onDemandEnabled: null, executionSupported: true,
    },
    {
      id: 'grok', label: 'Grok', provider: 'grok', state: 'observed', authentication: 'signed-in',
      health: 'reachable', planType: 'SuperGrok', observedAt: LIVE_AT, expiresAt: null,
      windows: [{ id: 'grok_unified_weekly', usedPercent: 1, resetsAt: '2026-09-26T12:43:50.000Z' }],
      reason: 'probe-observed', onDemandEnabled: null, executionSupported: true,
    },
  ];
}

/** A collector that owns the lease and is already warm. Spawns nothing. */
function warmCollector(
  accountsRoot: string,
  accounts: ResourceAccountConnection[],
  credits: Record<string, VerseCodexCredits | null> = {},
): VerseAccountCollector {
  return {
    accountsRoot,
    status: () => ({
      mode: 'owned', state: 'running', owner: 'this-server', reasonCode: null,
      pollIntervalMs: 30_000, idleSuspendMs: 300_000,
      lastPolledAt: LIVE_AT, lastRequestAt: LIVE_AT, note: 'Readings are live.',
    }),
    touch: () => {},
    connections: () => ({ sampledAt: LIVE_AT, refreshing: false, accounts }),
    // Deliberately EMPTY: the Codex-only evidence path must not be what makes
    // these seats work, or the Claude/Grok bug comes straight back.
    observations: () => [],
    credits: (id: string) => credits[id] ?? null,
    close: async () => {},
  };
}

/** An accounts root whose connections.json names the four live accounts. */
function makeLiveRoot(): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ashlr-verse-live-')));
  fs.chmodSync(base, 0o700);
  writePrivate(path.join(base, 'connections.json'), {
    schemaVersion: 1,
    intervalMs: 30_000,
    accounts: [
      { id: 'codex-personal', label: 'Personal Codex', provider: 'codex', command: [FAKE_NODE, launcherFor('codex-a')] },
      { id: 'codex-cmp', label: 'CMP Codex', provider: 'codex', command: [FAKE_NODE, launcherFor('codex-b')] },
      { id: 'claude', label: 'Claude Code', provider: 'claude', command: [FAKE_NODE, launcherFor('claude-a')] },
      { id: 'grok', label: 'Grok', provider: 'grok', command: [FAKE_NODE, launcherFor('grok-a')] },
    ],
  });
  // Present on purpose: the live-bearer-token file must never be read.
  writePrivate(path.join(base, 'console-startup.json'), { readToken: FAKE_BEARER, controlToken: FAKE_BEARER });
  return base;
}

describe('verse seats — live collector is the source of seat health', () => {
  let liveRoot: string;

  beforeEach(() => { liveRoot = makeLiveRoot(); });
  afterEach(() => { fs.rmSync(liveRoot, { recursive: true, force: true }); });

  it('shows ALL FOUR providers with their real windows — not just the two the evidence file can carry', async () => {
    const collector = warmCollector(liveRoot, liveConnections(), {
      'codex-personal': { hasCredits: true, unlimited: false, balance: '2048.4196250000' },
      'codex-cmp': { hasCredits: true, unlimited: false, balance: '2048.4196250000' },
    });
    const discovery = await discoverSeats(makeConfig(liveRoot), {
      accountsRoot: liveRoot, claudeUsage: zeroUsage, collector,
    });
    const byId = new Map(discovery.seats.map((seat) => [seat.id, seat]));
    expect([...byId.keys()]).toEqual(['codex-personal', 'codex-cmp', 'claude', 'grok']);

    // THE REGRESSION: every one of the four reaches `ready`, Claude and Grok
    // included. Before this fix those two were `unknown` forever.
    for (const id of ['codex-personal', 'codex-cmp', 'claude', 'grok']) {
      const seat = byId.get(id)!;
      expect(seat.health.state).toBe('ready');
      expect(seat.health.windows.length).toBeGreaterThan(0);
      expect(seat.capacity?.evidenceSource).toBe('collector');
      expect(seat.capacity?.observedAt).toBe(LIVE_AT);
    }

    const claude = byId.get('claude')!;
    expect(claude.capacity?.planType).toBe('max');
    expect(claude.capacity?.windows.map((w) => w.id))
      .toEqual(['five_hour', 'seven_day', 'seven_day_fable']);
    expect(claude.capacity?.binding?.id).toBe('seven_day_fable');
    expect(claude.capacity?.binding?.usedPercent).toBe(100);
    // A per-model window at its limit does NOT make the account exhausted:
    // five_hour still has 85 points of headroom.
    expect(claude.capacity?.usability).toBe('tight');

    const grok = byId.get('grok')!;
    expect(grok.capacity?.planType).toBe('SuperGrok');
    expect(grok.capacity?.binding).toMatchObject({
      id: 'grok_unified_weekly', usedPercent: 1, resetsAt: '2026-09-26T12:43:50.000Z', measured: true,
    });
    expect(grok.capacity?.usability).toBe('ready');

    const codex = byId.get('codex-personal')!;
    expect(codex.capacity?.planType).toBe('pro');
    expect(codex.capacity?.credits).toEqual({ hasCredits: true, unlimited: false, balance: '2048.4196250000' });
    // Its only window is spent — but credits remain spendable, so it is not
    // "blocked", which is what `exhausted` would have claimed.
    expect(codex.capacity?.usability).toBe('tight');
    expect(codex.capacity?.notes.some((n) => n.includes('independent of the window'))).toBe(true);
  });

  it('CLAUDE: the null resetsAt and the verbatim reset sentence both survive onto the seat', async () => {
    const collector = warmCollector(liveRoot, liveConnections());
    const discovery = await discoverSeats(makeConfig(liveRoot), {
      accountsRoot: liveRoot, claudeUsage: zeroUsage, collector,
    });
    const claude = discovery.seats.find((seat) => seat.id === 'claude')!;

    for (const window of claude.capacity!.windows) expect(window.resetsAt).toBeNull();
    for (const window of claude.health.windows) expect(window.resetsAt).toBeNull();
    expect(claude.capacity?.windows.map((w) => w.resetDescription)).toEqual([
      'Sep 21 at 1:40am (America/New_York)',
      'Sep 25 at 7pm (America/New_York)',
      'Sep 25 at 7pm (America/New_York)',
    ]);
    // Rendered verbatim into the summary — never converted into a countdown.
    expect(claude.health.summary).toContain('five_hour window 15% used, resets Sep 21 at 1:40am (America/New_York)');
    expect(claude.capacity?.notes.some((n) => n.includes('no machine-readable reset'))).toBe(true);
    // Claude's health is `unknown` by construction; that must not read as a fault.
    expect(claude.health.state).toBe('ready');
  });

  it('CODEX: a flagged sentinel 100 stays a denial on the seat, not a measurement', async () => {
    const flagged = liveConnections().map((account) => account.id !== 'codex-cmp' ? account : {
      ...account,
      windows: [{ id: 'codex_codex_primary', usedPercent: 100, resetsAt: null, limitReached: true } as
        ResourceAccountConnection['windows'][number] & { limitReached: true }],
    });
    // No credits for this account: nothing is left to spend.
    const collector = warmCollector(liveRoot, flagged, { 'codex-cmp': null });
    const discovery = await discoverSeats(makeConfig(liveRoot), {
      accountsRoot: liveRoot, claudeUsage: zeroUsage, collector,
    });
    const seat = discovery.seats.find((s) => s.id === 'codex-cmp')!;

    expect(seat.capacity?.windows[0]).toMatchObject({ limitReached: true, measured: false, usedPercent: 100 });
    expect(seat.capacity?.binding).toMatchObject({ limitReached: true, measured: false });
    expect(seat.capacity?.usability).toBe('exhausted');
    // "limit reached", never "100% used" — the number was never measured.
    expect(seat.health.summary).toContain('codex_codex_primary window limit reached');
    expect(seat.health.summary).not.toContain('100% used');
    expect(seat.capacity?.notes.some((n) => n.includes('a denial, not a measurement'))).toBe(true);
  });

  it('GROK: an unauthenticated probe makes the seat unavailable with a reconnect note, not a shrug', async () => {
    const signedOut = liveConnections().map((account) => account.id !== 'grok' ? account : {
      ...account,
      state: 'unavailable' as const, authentication: 'unknown' as const, health: 'unknown' as const,
      windows: [], reason: 'probe-account-unavailable',
    });
    const collector = warmCollector(liveRoot, signedOut);
    const discovery = await discoverSeats(makeConfig(liveRoot), {
      accountsRoot: liveRoot, claudeUsage: zeroUsage, collector,
    });
    const grok = discovery.seats.find((seat) => seat.id === 'grok')!;

    expect(grok.health.state).toBe('unavailable');
    expect(grok.capacity?.usability).toBe('signed-out');
    expect(grok.capacity?.binding).toBeNull();
    expect(grok.capacity?.notes.some((n) => n.includes('Re-authenticate'))).toBe(true);
    // The remedy is named without naming the pinned profile.
    expect(JSON.stringify(grok)).not.toContain('native-profiles');
  });

  it('falls back to the Codex-only evidence file when no collector is running, and says so', async () => {
    // This root has the pool/quota config the evidence reader needs.
    held = await acquireResourceQuotaRefreshLease(accountsLedgerRoot(root), { trackNativeActivity: true });
    held.markPending();
    publishSharedQuotaEvidence({
      root: accountsLedgerRoot(root),
      pool: POOL as never,
      bindings: BINDINGS as never,
      config: QUOTA_CONFIG as never,
      lease: held,
      state: 'running',
      evidence: { observations: [freshObservation(73)] as never, unavailableWorkerIds: [] },
    });

    const discovery = await discoverSeats(makeConfig(root), {
      accountsRoot: root, claudeUsage: zeroUsage, collector: null,
    });
    const codex = discovery.seats.find((seat) => seat.id === 'codex-a')!;
    expect(codex.health.state).toBe('ready');
    expect(codex.capacity?.binding).toMatchObject({ id: 'codex_primary', usedPercent: 73, measured: true });
    expect(codex.capacity?.evidenceSource).toBe('shared-evidence');
    // The evidence file structurally cannot carry credits or a plan tier —
    // both read as "no signal", never as zero or a guess.
    expect(codex.capacity?.credits).toBeNull();
    expect(codex.capacity?.planType).toBeNull();
    expect(codex.capacity?.notes.some((n) => n.includes('unknown, not zero'))).toBe(true);

    // Grok is in connections.json but the evidence file cannot describe it, so
    // it degrades to "no reading" rather than to a zero meter.
    const grok = discovery.seats.find((seat) => seat.id === 'grok')!;
    expect(grok.health.state).toBe('unknown');
    expect(grok.capacity?.usability).toBe('unknown');
    expect(grok.capacity?.binding).toBeNull();
    expect(grok.capacity?.windows).toEqual([]);
  });

  it('a seat read taken after the collector warms shows the warm data, not the mount-time snapshot', async () => {
    // Cold: the app opened before the collector's first cycle finished. This is
    // exactly what Mason's screenshot showed — every account "unknown".
    const cold = await discoverSeats(makeConfig(liveRoot), {
      accountsRoot: liveRoot, claudeUsage: zeroUsage, collector: null,
    });
    for (const seat of cold.seats) {
      expect(seat.health.state).toBe('unknown');
      expect(seat.capacity?.usability).toBe('unknown');
    }

    // …one collector cycle later, the SAME discovery re-reads live telemetry
    // without re-probing Ollama or re-reading connections.json.
    const warm = refreshSeatTelemetry(makeConfig(liveRoot), cold, {
      accountsRoot: liveRoot,
      claudeUsage: zeroUsage,
      collector: warmCollector(liveRoot, liveConnections()),
    });
    expect(warm.seats.map((seat) => seat.health.state)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(warm.seats.find((seat) => seat.id === 'claude')?.capacity?.windows).toHaveLength(3);

    // The cold snapshot is not mutated, and the private launch map still points
    // at the seats that were just returned.
    expect(cold.seats[0]!.health.state).toBe('unknown');
    for (const seat of warm.seats) expect(warm.launches.get(seat.id)!.seat).toBe(seat);
    expect(warm.launches.get('claude')!.launcher).toEqual([FAKE_NODE, launcherFor('claude-a')]);
    expect(warm.localRuntime).toBe(cold.localRuntime);
  });

  it('keeps every launcher argv and bearer token out of the live seat payload', async () => {
    const collector = warmCollector(liveRoot, liveConnections(), {
      'codex-personal': { hasCredits: true, unlimited: false, balance: '2048.4196250000' },
    });
    const discovery = await discoverSeats(makeConfig(liveRoot), {
      accountsRoot: liveRoot, claudeUsage: zeroUsage, collector,
    });
    const wire = JSON.stringify(discovery.seats);

    expect(wire).not.toContain(FAKE_BEARER);
    expect(wire).not.toContain(FAKE_NODE);
    expect(wire).not.toContain('native-profiles');
    expect(wire).not.toContain('launcher.mjs');
    expect(wire).not.toContain('console-startup');
    expect(wire).not.toContain(liveRoot);
    expect(wire).not.toContain(os.homedir());
    // No absolute path of any kind: this body names accounts, not the filesystem.
    expect(/"[^"]*\/(?:Users|opt|home)\//.test(wire)).toBe(false);
    // …while still answering the question the panel exists to answer.
    expect(wire).toContain('grok_unified_weekly');
  });

  it('seatUsability: no reading is unknown, and a null percent never counts as headroom', () => {
    const base = { state: 'observed' as const, credits: null };
    expect(seatUsability({ ...base, binding: null, windows: [] })).toBe('unknown');
    expect(seatUsability({
      ...base,
      binding: { id: 'a', usedPercent: 100, limitReached: false },
      windows: [
        { id: 'a', usedPercent: 100, resetsAt: null, nativeReport: null, limitReached: false, measured: true },
        // No signal — it must not be read as 0% of headroom left over.
        { id: 'b', usedPercent: null, resetsAt: null, nativeReport: null, limitReached: false, measured: true },
      ],
    })).toBe('exhausted');
    expect(seatUsability({
      ...base,
      binding: { id: 'a', usedPercent: 94, limitReached: false },
      windows: [{ id: 'a', usedPercent: 94, resetsAt: null, nativeReport: null, limitReached: false, measured: true }],
    })).toBe('tight');
  });
});

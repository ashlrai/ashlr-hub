/** Synthetic private fixtures only; no native executable, credential content or provider call. */
import { chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceReadingCache, normalizeResourceLastKnownUsage, readResourceHistoricalIdentityWitnesses, RESOURCE_READING_CACHE_FILENAME, RESOURCE_READING_CACHE_MAX_BYTES, type ResourceReadingCache } from '../src/core/resources/reading-cache.js';
import { buildVerseAccountsSnapshot, deriveVerseAccountRecord, type VerseAccountCollector } from '../src/core/verse/accounts.js';
import { buildSeatTelemetry } from '../src/core/verse/seats.js';
import { resourceAccountProfileDigest, validResourceAccountIdentityWitness, sameResourceAccountIdentity,
  type ResourceAccountLocalEpoch } from '../src/core/resources/account-identity-witness.js';
import type { ResourceAccountConnection } from '../src/core/resources/connection-types.js';
import { createResourceConnectionMonitor, type ResourceConnectionConfig, type ResourceConnectionMonitor } from '../src/core/resources/connection-monitor.js';

const probes = vi.hoisted(() => ({ codex: vi.fn(), claude: vi.fn(), grok: vi.fn() }));
const io = vi.hoisted(() => ({ gate: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock('../src/core/util/private-file-write.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/util/private-file-write.js')>();
  return { ...actual, async writePrivateFileAtomicallyAsync(...args: Parameters<typeof actual.writePrivateFileAtomicallyAsync>) {
    io.entered?.(); if (io.gate) await io.gate;
    return actual.writePrivateFileAtomicallyAsync(...args);
  } };
});
vi.mock('../src/core/resources/codex-account-probe.js', () => ({ probeCodexResourceAccount: probes.codex }));
vi.mock('../src/core/resources/claude-account-usage.js', () => ({ probeClaudeAccountUsage: probes.claude }));
vi.mock('../src/core/resources/grok-account-probe.js', () => ({ probeGrokAccount: probes.grok }));
const NOW = '2026-10-01T12:00:00.000Z'; const EXPIRES = '2026-10-01T12:01:00.000Z'; const HINT = 'a'.repeat(64);
let root: string; const handles: ResourceConnectionMonitor[] = []; const caches: ResourceReadingCache[] = [];
type Account = ResourceConnectionConfig['accounts'][number];
const account = (id = 'codex-a', provider: Account['provider'] = 'codex'): Account => ({ id, provider, label: 'Demo account', command: ['/private/inert/profile', id] });
const reading = (a: Account): ResourceAccountConnection => ({ id: a.id, label: a.label, provider: a.provider, state: 'observed',
  authentication: 'signed-in', health: 'reachable', planType: 'pro', observedAt: NOW, expiresAt: EXPIRES,
  windows: [{ id: 'weekly', usedPercent: 0, resetsAt: '2026-10-05T12:00:00.000Z' }], codexCredits: { hasCredits: true, unlimited: false, balance: '123.45' },
  reason: 'probe-observed', onDemandEnabled: false, executionSupported: true });
const local = (a: Account): ResourceAccountLocalEpoch => ({ profileDigest: resourceAccountProfileDigest(a), epochDigest: 'b'.repeat(64) });
function cache(accounts = [account()], readEpoch: (a: Account) => ResourceAccountLocalEpoch | null = local, assertOwnership = () => {}) {
  const result = createResourceReadingCache({ root, accountsRoot: root, accounts, readEpoch, assertOwnership }); caches.push(result); return result;
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-reading-cache-')));
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW));
  for (const probe of Object.values(probes)) probe.mockReset();
  io.gate = null; io.entered = null;
});
afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map(h => h.close()));
  await Promise.allSettled(caches.splice(0).map(c => c.flush()));
  io.gate = null; io.entered = null;
  vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});

describe('display-only historical reading storage', () => {
  it('hydrates original historical usage immediately after restart, never credits or current state', async () => {
    const a = account(); const first = cache(); first.remember(a, reading(a), HINT, local(a)); await first.flush();
    const bytes = readFileSync(join(root, RESOURCE_READING_CACHE_FILENAME), 'utf8');
    expect(bytes).not.toContain('123.45'); expect(bytes).not.toContain('command'); expect(bytes).not.toContain('signed-in');
    const next = cache();
    expect(next.lastKnown(a)).toEqual({ observedAt: NOW, expiresAt: EXPIRES, windows: reading(a).windows,
      source: 'native-account-checked-history', identitySource: 'native-account-checked-local-epoch' });
    vi.mocked(Date.now).mockReturnValue(Date.parse(EXPIRES) + 1);
    expect(next.lastKnown(a)?.expiresAt).toBe(EXPIRES); expect(next.lastKnown(a)?.windows[0]?.usedPercent).toBe(0);
    expect(next.witness(a)?.source).toBe('native-account-checked-local-epoch');
  });
  it('keeps paired Claude history through settings epochs without minting a financial witness', async () => {
    const a = account('claude-a', 'claude'); const before = { ...local(a), accountDigest: HINT };
    let current = { ...before, epochDigest: 'c'.repeat(64) };
    const first = cache([a], () => current); first.remember(a, reading(a), HINT, before); await first.flush();
    const saved = JSON.parse(readFileSync(join(root, RESOURCE_READING_CACHE_FILENAME), 'utf8')).readings[0];
    expect(saved.epochDigest).toBeNull(); expect(saved.displayIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.identityWitnessesSnapshot()[0]?.localEpoch).toBeNull();
    current = { ...current, epochDigest: 'd'.repeat(64) };
    vi.mocked(Date.now).mockReturnValue(Date.parse(EXPIRES) + 1);
    const restarted = cache([a], () => current);
    expect(restarted.lastKnown(a)).toEqual({ observedAt: NOW, expiresAt: EXPIRES, windows: reading(a).windows,
      source: 'native-account-checked-history', identitySource: 'native-account-checked-display-identity' });
    expect(normalizeResourceLastKnownUsage(JSON.parse(JSON.stringify(restarted.lastKnown(a))))).toEqual(restarted.lastKnown(a));
    expect(validResourceAccountIdentityWitness({ provider: a.provider, accountId: a.id, accountDigest: HINT,
      profileDigest: resourceAccountProfileDigest(a), generation: 1, observedAt: new Date(Date.now()).toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(), source: 'native-account-checked-display-identity' })).toBe(false);
    expect(restarted.witness(a)).toBeNull(); expect(restarted.identityWitnessesSnapshot()).toEqual([]);
    expect(readResourceHistoricalIdentityWitnesses({ root, accountsRoot: root, accounts: [a], readEpoch: () => current })).toEqual([]);
    current = { ...current, accountDigest: 'e'.repeat(64) }; expect(restarted.lastKnown(a)).toBeNull();
  });
  it.each(['absent-before', 'mismatched-before', 'missing-after', 'wrong-after'] as const)(
    'cannot bootstrap Claude display continuity from %s identity', async kind => {
      const a = account('claude-a', 'claude'); const before = { ...local(a), accountDigest: HINT };
      const after = kind === 'missing-after' ? null : { ...before, epochDigest: 'c'.repeat(64),
        ...(kind === 'wrong-after' ? { accountDigest: 'd'.repeat(64) } : {}) };
      const first = cache([a], () => after);
      first.remember(a, reading(a), HINT, kind === 'absent-before' ? null : kind === 'mismatched-before' ?
        { ...before, accountDigest: 'e'.repeat(64) } : before); await first.flush();
      expect(cache([a], () => after).lastKnown(a)).toBeNull();
    });
  it.each(['wrong-digest', 'wrong-provider', 'null-digest'] as const)('refuses a %s display-cache extension without rewriting it', async kind => {
    const a = account('claude-a', 'claude'); const current = { ...local(a), accountDigest: HINT };
    const first = cache([a], () => current); first.remember(a, reading(a), HINT, current); await first.flush();
    const file = join(root, RESOURCE_READING_CACHE_FILENAME); const value = JSON.parse(readFileSync(file, 'utf8'));
    if (kind === 'wrong-provider') value.readings[0].provider = 'codex';
    else value.readings[0].displayIdentityDigest = kind === 'wrong-digest' ? 'd'.repeat(64) : null;
    const bytes = JSON.stringify(value); writeFileSync(file, bytes, { mode: 0o600 });
    const next = cache([a], () => current); expect(next.lastKnown(a)).toBeNull();
    next.remember(a, reading(a), HINT, current); await next.flush(); expect(readFileSync(file, 'utf8')).toBe(bytes);
  });
  it('does not retroactively bind a legacy null epoch until a new paired native capture', async () => {
    const a = account('claude-a', 'claude'); const current = { ...local(a), accountDigest: HINT };
    const old = cache([a], () => null); old.remember(a, reading(a), HINT, null); await old.flush();
    const next = cache([a], () => current); expect(next.lastKnown(a)).toBeNull();
    next.remember(a, reading(a), HINT, current); await next.flush();
    expect(cache([a], () => ({ ...current, epochDigest: 'c'.repeat(64) })).lastKnown(a)?.observedAt).toBe(NOW);
  });
  it.each(['settings', 'account'] as const)('rechecks a deferred Claude %s change before commit', async kind => {
    const a = account('claude-a', 'claude'); let current = { ...local(a), accountDigest: HINT };
    let release!: () => void; let entered!: () => void;
    io.gate = new Promise(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; }); io.entered = entered;
    const first = cache([a], () => current); first.remember(a, reading(a), HINT, current); await ready;
    current = { ...current, epochDigest: 'c'.repeat(64), ...(kind === 'account' ? { accountDigest: 'd'.repeat(64) } : {}) };
    release(); await first.flush();
    const next = cache([a], () => current);
    if (kind === 'settings') {
      expect(next.lastKnown(a)?.observedAt).toBe(NOW); expect(next.witness(a)).toBeNull();
      expect(JSON.parse(readFileSync(join(root, RESOURCE_READING_CACHE_FILENAME), 'utf8')).readings[0].epochDigest).toBeNull();
    } else { expect(next.lastKnown(a)).toBeNull(); expect(first.identityWitnessesSnapshot()).toEqual([]); }
  });
  it('uses one requested projection clock for restart identity while preserving original quota timestamps', async () => {
    const a = account(); const first = cache(); first.remember(a, reading(a), HINT, local(a)); await first.flush();
    const projectionNow = Date.parse(NOW) + 1; vi.mocked(Date.now).mockReturnValue(projectionNow + 2);
    const [w] = readResourceHistoricalIdentityWitnesses({ root, accountsRoot: root, accounts: [a], readEpoch: local, nowMs: projectionNow });
    expect(w?.observedAt).toBe(new Date(projectionNow).toISOString());
    expect(validResourceAccountIdentityWitness(w, projectionNow)).toBe(true);
    expect(cache().lastKnown(a)?.observedAt).toBe(NOW); expect(cache().lastKnown(a)?.expiresAt).toBe(EXPIRES);
    expect(readResourceHistoricalIdentityWitnesses({ root, accountsRoot: root, accounts: [a], readEpoch: local, nowMs: projectionNow + 3 })).toEqual([]);
  });
  it('refuses a deferred old write even when a new lease owner now passes ownership checks', async () => {
    const a = account(); let owner = 'old-owner'; let release!: () => void; let entered!: () => void;
    io.gate = new Promise(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; }); io.entered = entered;
    const first = createResourceReadingCache({ root, accountsRoot: root, accounts: [a], readEpoch: local,
      assertOwnership: () => {}, ownershipIdentity: () => owner }); caches.push(first);
    first.remember(a, reading(a), HINT, local(a)); await ready; owner = 'new-owner'; release(); await first.flush();
    expect((await import('node:fs')).existsSync(join(root, RESOURCE_READING_CACHE_FILENAME))).toBe(false);
  });
  it('retains all 130 enrolled rows and coalesces partial updates without truncation', async () => {
    const roster = Array.from({ length: 130 }, (_, i) => account(`codex-${i}`)); const first = cache(roster);
    for (const a of roster) first.remember(a, reading(a), HINT, local(a)); await first.flush();
    const next = cache(roster); expect(roster.filter(a => next.lastKnown(a))).toHaveLength(130);
    const a = roster[129]!; next.remember(a, { ...reading(a), windows: [{ id: 'weekly', usedPercent: 77, resetsAt: null }] }, HINT, local(a)); await next.flush();
    const final = cache(roster); expect(final.lastKnown(a)?.windows[0]?.usedPercent).toBe(77);
    expect(final.lastKnown(roster[0]!)?.windows[0]?.usedPercent).toBe(0);
  });
  it.each(['unknown', 'changed', 'wrong-account'] as const)('suppresses a %s local identity without borrowing another profile', async kind => {
    const a = account(); const first = cache(); first.remember(a, reading(a), HINT, local(a)); await first.flush();
    const next = cache([a], () => kind === 'unknown' ? null : { ...local(a),
      ...(kind === 'changed' ? { epochDigest: 'c'.repeat(64) } : { accountDigest: 'd'.repeat(64) }) });
    expect(next.lastKnown(a)).toBeNull(); expect(next.witness(a)).toBeNull();
    expect(first.lastKnown({ ...a, command: ['/private/other/profile'] })).toBeNull();
  });
  it('does not pair a switched auth file during the await with a successful old account report', async () => {
    const a = account(); const next = cache([a], () => ({ ...local(a), epochDigest: 'c'.repeat(64) }));
    next.remember(a, reading(a), HINT, local(a)); await next.flush();
    expect(next.lastKnown(a)?.identitySource).toBe('native-account-checked');
    expect(cache().lastKnown(a)).toBeNull();
  });
  it('allows native identity only until its original expiry when no local witness exists', async () => {
    const a = account('claude-a', 'claude'); const next = cache([a], () => null);
    next.remember(a, reading(a), HINT, null); await next.flush();
    expect(next.lastKnown(a)?.identitySource).toBe('native-account-checked');
    expect(cache([a], () => null).lastKnown(a)).toBeNull();
    vi.mocked(Date.now).mockReturnValue(Date.parse(EXPIRES)); expect(next.lastKnown(a)).toBeNull();
  });
  it('persists invalidation so signed-out or changed accounts do not resurrect on restart', async () => {
    const a = account(); const first = cache(); first.remember(a, reading(a), HINT, local(a)); await first.flush();
    first.invalidate(a); await first.flush(); expect(cache().lastKnown(a)).toBeNull();
  });
  it('preserves original usage when an identity-only native sample has no usage signal', async () => {
    const a = account(); const first = cache(); first.remember(a, reading(a), HINT, local(a)); await first.flush();
    first.remember(a, { ...reading(a), observedAt: '2026-10-01T12:00:01.000Z', expiresAt: '2026-10-01T12:01:01.000Z', windows: [] }, HINT, local(a));
    // Future observations refuse, rather than resetting the historical timestamp.
    expect(first.lastKnown(a)?.observedAt).toBe(NOW);
    vi.mocked(Date.now).mockReturnValue(Date.parse(NOW) + 1_000);
    first.remember(a, { ...reading(a), observedAt: '2026-10-01T12:00:01.000Z', expiresAt: '2026-10-01T12:01:01.000Z', windows: [] }, HINT, local(a));
    await first.flush(); expect(first.lastKnown(a)?.observedAt).toBe(NOW); expect(first.lastKnown(a)?.windows[0]?.usedPercent).toBe(0);
  });
  it.each(['malformed', 'oversized', 'public', 'symlink', 'hardlink'] as const)('does not rewrite a %s private cache target', async kind => {
    const file = join(root, RESOURCE_READING_CACHE_FILENAME); const original = kind === 'oversized' ? 'x'.repeat(RESOURCE_READING_CACHE_MAX_BYTES + 1) : '{bad';
    const other = join(root, 'other');
    if (kind === 'symlink' || kind === 'hardlink') { writeFileSync(other, original, { mode: 0o600 });
      if (kind === 'symlink') symlinkSync(other, file); else linkSync(other, file);
    } else writeFileSync(file, original, { mode: 0o600 });
    if (kind === 'public') chmodSync(file, 0o644);
    const first = cache(); expect(first.lastKnown(account())).toBeNull();
    first.remember(account(), reading(account()), HINT, local(account())); await first.flush();
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
  it('refuses changed ownership before deferred persistence without blocking native samples', async () => {
    let held = true; const first = cache([account()], local, () => { if (!held) throw new Error('private detail'); });
    first.remember(account(), reading(account()), HINT, local(account())); held = false; await first.flush();
    expect(() => readFileSync(join(root, RESOURCE_READING_CACHE_FILENAME))).toThrow();
  });
  it('validates opaque witnesses without coerced values and ignores generation for persistent tuple matching', () => {
    const first = cache(); first.remember(account(), reading(account()), HINT, local(account()));
    const w = first.witness(account())!; expect(validResourceAccountIdentityWitness(w)).toBe(true);
    expect(sameResourceAccountIdentity(w, { ...w, generation: 2 })).toBe(true);
    const coercion = vi.fn(() => HINT); expect(validResourceAccountIdentityWitness({ ...w, accountDigest: { toString: coercion } })).toBe(false);
    expect(coercion).not.toHaveBeenCalled(); first.invalidate(account());
  });
  it('captures host-only witness snapshots without filesystem reads', () => {
    const readEpoch = vi.fn(local); const first = cache([account()], readEpoch);
    first.remember(account(), reading(account()), HINT, local(account())); readEpoch.mockClear();
    const snapshots = first.identityWitnessesSnapshot(); expect(snapshots).toHaveLength(1); expect(readEpoch).not.toHaveBeenCalled();
    expect(snapshots[0]?.witness.source).toBe('native-account-checked');
    snapshots[0]!.witness.accountDigest = 'd'.repeat(64); expect(first.identityWitnessesSnapshot()[0]?.witness.accountDigest).toBe(HINT);
  });
  it('refuses future original timestamps for both historical display and identity association', async () => {
    const a = account(); const first = cache(); first.remember(a, reading(a), HINT, local(a)); await first.flush();
    const opts = { root, accountsRoot: root, accounts: [a], readEpoch: local };
    expect(readResourceHistoricalIdentityWitnesses(opts)).toHaveLength(1);
    const file = join(root, RESOURCE_READING_CACHE_FILENAME); const parsed = JSON.parse(readFileSync(file, 'utf8'));
    parsed.readings[0].observedAt = '2026-10-01T12:02:00.000Z'; parsed.readings[0].expiresAt = '2026-10-01T12:03:00.000Z';
    writeFileSync(file, JSON.stringify(parsed), { mode: 0o600 });
    const loaded = cache(); expect(loaded.lastKnown(a)).toBeNull(); expect(loaded.witness(a)).toBeNull();
    expect(readResourceHistoricalIdentityWitnesses(opts)).toEqual([]);
  });
  it('refuses stale queued serialization after a newer reading and publishes only the latest revision', async () => {
    let release!: () => void; let entered!: () => void;
    io.gate = new Promise(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; }); io.entered = entered;
    const a = account(); const first = cache(); first.remember(a, reading(a), HINT, local(a)); await ready;
    first.remember(a, { ...reading(a), windows: [{ id: 'weekly', usedPercent: 88, resetsAt: null }] }, HINT, local(a));
    release(); await first.flush(); expect(cache().lastKnown(a)?.windows[0]?.usedPercent).toBe(88);
  });
  it('exposes immediate pure invalidation while deferred disk removal is pending', async () => {
    const a = account(); const first = cache(); first.remember(a, reading(a), HINT, local(a)); await first.flush();
    let release!: () => void; let entered!: () => void;
    io.gate = new Promise(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; }); io.entered = entered;
    const beforeRevision = first.identitySnapshotRevision(); first.invalidate(a); await ready;
    // Another worker can still see the old disk bytes; it must apply the host's pure tombstone.
    expect(readResourceHistoricalIdentityWitnesses({ root, accountsRoot: root, accounts: [a], readEpoch: local })).toHaveLength(1);
    expect(first.identityWitnessesSnapshot()).toEqual([]); expect(first.invalidatedIdentityAccountIdsSnapshot()).toEqual([a.id]);
    expect(first.identitySnapshotRevision()).toBeGreaterThan(beforeRevision); expect(first.lastKnown(a)).toBeNull();
    const snapshot = first.invalidatedIdentityAccountIdsSnapshot(); snapshot.length = 0;
    expect(first.invalidatedIdentityAccountIdsSnapshot()).toEqual([a.id]); release(); await first.flush();
    expect(readResourceHistoricalIdentityWitnesses({ root, accountsRoot: root, accounts: [a], readEpoch: local })).toEqual([]);
  });
  it('rechecks capture identity before async publication and persists removal on a mid-write switch', async () => {
    let release!: () => void; let entered!: () => void; let current = local(account());
    io.gate = new Promise(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; }); io.entered = entered;
    const a = account(); const first = cache([a], () => current); first.remember(a, reading(a), HINT, current); await ready;
    current = { ...current, epochDigest: 'c'.repeat(64) }; release(); await first.flush();
    expect(cache([a], () => current).lastKnown(a)).toBeNull();
    expect(JSON.parse(readFileSync(join(root, RESOURCE_READING_CACHE_FILENAME), 'utf8')).readings).toEqual([]);
  });
  it.each(['malformed', 'public', 'oversized'] as const)('preserves a target changed to %s during async write', async kind => {
    const a = account(); const first = cache(); first.remember(a, reading(a), HINT, local(a)); await first.flush();
    let release!: () => void; let entered!: () => void;
    io.gate = new Promise(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; }); io.entered = entered;
    first.remember(a, { ...reading(a), windows: [{ id: 'weekly', usedPercent: 99, resetsAt: null }] }, HINT, local(a)); await ready;
    const file = join(root, RESOURCE_READING_CACHE_FILENAME);
    const changed = kind === 'public' ? readFileSync(file, 'utf8') : kind === 'oversized' ? 'x'.repeat(RESOURCE_READING_CACHE_MAX_BYTES + 1) : '{malformed';
    writeFileSync(file, changed, { mode: 0o600 }); if (kind === 'public') chmodSync(file, 0o644);
    release(); await first.flush(); expect(readFileSync(file, 'utf8')).toBe(changed);
    expect((await import('node:fs')).readdirSync(root).filter(p => p.endsWith('.tmp'))).toEqual([]);
  });
  it('keeps public/seat historical usage separate and drops an invalidated captured history', async () => {
    const a = account(); const first = cache(); first.remember(a, reading(a), HINT, local(a)); await first.flush();
    const historical = first.lastKnown(a)!;
    const checking = { ...reading(a), state: 'checking' as const, authentication: 'unknown' as const, health: 'unknown' as const,
      planType: null, observedAt: null, expiresAt: null, windows: [], codexCredits: null, lastKnownUsage: historical };
    const projected = deriveVerseAccountRecord(checking);
    expect(projected.windows).toEqual([]); expect(projected.binding).toBeNull(); expect(projected.credits).toBeNull();
    expect(projected.lastKnownUsage).toEqual(historical);
    expect(deriveVerseAccountRecord({ ...checking, lastKnownUsage: { ...historical, accountDigest: 'SECRET_SENTINEL' } as never }).lastKnownUsage).toBeUndefined();
    writeFileSync(join(root, 'connections.json'), JSON.stringify({ schemaVersion: 1, intervalMs: 30_000, accounts: [a] }), { mode: 0o600 });
    const status = buildVerseAccountsSnapshot({ accountsRoot: root }).collector;
    const collector: VerseAccountCollector = { accountsRoot: root, status: () => status, touch() {}, observations: () => [], unavailableWorkerIds: () => [],
      credits: () => null, connections: () => ({ sampledAt: NOW, refreshing: true, accounts: [checking] }), lastReadingAt: () => NOW,
      lastKnownUsage: () => first.lastKnown(a), identityWitness: () => first.witness(a), async close() {} };
    const telemetry = buildSeatTelemetry(root, { collector }).get(a.id)!;
    expect(telemetry.lastKnownUsage).toEqual(historical); expect(telemetry.capacity.windows).toEqual([]);
    expect(telemetry.capacity.usability).toBe('unknown'); expect(telemetry.health.state).toBe('unknown');
    first.invalidate(a);
    const changed = buildVerseAccountsSnapshot({ accountsRoot: root, collector }).accounts[0]!;
    expect(changed.lastKnownUsage).toBeUndefined(); expect(changed.lastReadingAt).toBeUndefined();
  });
});

describe('immediate historical startup and independent refill (controlled timers)', () => {
  it('reads stopped state without touching historical profile metadata', async () => {
    const a = account(); const metadataRead = vi.fn(local); const first = cache([a], metadataRead);
    first.remember(a, reading(a), HINT, local(a)); await first.flush();
    const abort = new AbortController();
    probes.codex.mockImplementation(async () => ({ status: 'failed', reason: 'probe-request-failed' }));
    const handle = createResourceConnectionMonitor({ config: { schemaVersion: 1, intervalMs: 30_000, accounts: [a] },
      cwd: root, assertOwnership: () => {}, readingCache: first, signal: abort.signal }); handles.push(handle);
    await new Promise(resolve => setImmediate(resolve)); metadataRead.mockClear();
    for (let i = 0; i < 10; i++) expect(handle.isStopped?.()).toBe(false);
    expect(metadataRead).not.toHaveBeenCalled();
    abort.abort(); expect(handle.isStopped?.()).toBe(true); expect(metadataRead).not.toHaveBeenCalled();
  });
  it('returns cached history while Claude waits 20s, then fresh accounts settle independently at 10/20/30ms', async () => {
    const roster = [account('claude-a', 'claude'), ...Array.from({ length: 3 }, (_, i) => account(`codex-${i}`))];
    const first = cache(roster); for (const a of roster) first.remember(a, reading(a), HINT, local(a)); await first.flush();
    const restarted = cache(roster); vi.restoreAllMocks(); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(NOW);
    probes.claude.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 20_000));
      return { status: 'timed-out', reason: 'usage-timed-out' }; });
    probes.codex.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 10));
      return { status: 'observed', accountHint: HINT, planType: 'pro', reason: 'probe-observed',
        observation: { observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), windows: reading(roster[1]!).windows } }; });
    const handle = createResourceConnectionMonitor({ config: { schemaVersion: 1, intervalMs: 30_000, accounts: roster },
      cwd: root, assertOwnership: () => {}, readingCache: restarted }); handles.push(handle);
    const initial = handle.snapshot().accounts;
    expect(initial.every(r => r.state === 'checking' && r.windows.length === 0 && r.codexCredits === null)).toBe(true);
    expect(initial.every(r => r.lastKnownUsage?.observedAt === NOW)).toBe(true);
    await vi.advanceTimersByTimeAsync(30);
    const next = handle.snapshot().accounts;
    expect(next[0]?.state).toBe('checking'); expect(next[0]?.lastKnownUsage?.expiresAt).toBe(EXPIRES);
    expect(next.slice(1).every(r => r.state === 'observed' && r.lastKnownUsage === undefined)).toBe(true);
    expect(probes.codex).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000); await handle.close(); await restarted.flush();
  });
});

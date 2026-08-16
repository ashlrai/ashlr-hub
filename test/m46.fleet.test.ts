/**
 * m46.fleet.test.ts — M46: backend router + rate/quota ledger.
 *
 * Two units under test:
 *   1. routeBackend (src/core/fleet/router.ts) — PURE, deterministic policy.
 *      engineInstalled() does a real PATH probe, so frontier-routing tests are
 *      written to be robust whether or not 'claude'/'codex' are on PATH: we
 *      assert the contract (never a disallowed/uninstalled backend; deterministic
 *      alternation; tier matches backend) rather than a hard-coded backend that
 *      depends on the test machine's PATH.
 *   2. quota ledger (src/core/fleet/quota.ts) — atomic JSON persistence. HOME is
 *      relocated to a fresh tmp dir per quota test so ~/.ashlr/fleet is isolated;
 *      restored afterward.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig, EngineId, WorkItem, WorkSource } from '../src/core/types.js';
import { routeBackend } from '../src/core/fleet/router.js';
import {
  fleetQuotaPath,
  fleetQuotaReservationPath,
  fleetQuotaReservationLockPath,
  evalFleetQuotaAuthority,
  inspectFleetQuotaAuthority,
  loadFleetQuota,
  recordUse,
  reserveFleetQuotaUse,
  reserveFleetQuotaUses,
  setFleetQuotaTestHooksForTests,
  usesInWindow,
  windowToMs,
  withinLimit,
  evalQuota,
} from '../src/core/fleet/quota.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
} from '../src/core/fleet/local-store-lock.js';
import { engineInstalled } from '../src/core/run/engines.js';
import { engineTierOf } from '../src/core/run/sandboxed-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseConfig(): AshlrConfig {
  // Minimal valid AshlrConfig — only fields the router/quota touch matter.
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry };
}

function loadReservationLedger(): { events: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(fleetQuotaReservationPath(), 'utf8')) as {
    events: Array<Record<string, unknown>>;
  };
}

let _seq = 0;
function makeItem(over: Partial<WorkItem> & { source: WorkSource }): WorkItem {
  const id = over.id ?? `repo:${over.source}:item${_seq++}`;
  return {
    id,
    repo: '/repo',
    source: over.source,
    title: over.title ?? 't',
    detail: over.detail ?? 'd',
    value: over.value ?? 3,
    effort: over.effort ?? 3,
    score: over.score ?? 3,
    tags: over.tags ?? [],
    ts: over.ts ?? new Date().toISOString(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// routeBackend
// ---------------------------------------------------------------------------

describe('routeBackend', () => {
  it('routes doc/dep/todo/test (bulk) sources to a FRONTIER backend when frontier is allowed+installed, else builtin', () => {
    // NEW POLICY: frontier-first. builtin produces 0-diff proposals; frontier actually edits.
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude', 'codex'] });
    const anyFrontierAvailable = engineInstalled('claude') || engineInstalled('codex');
    for (const source of ['doc', 'dep', 'todo', 'test'] as WorkSource[]) {
      const d = routeBackend(makeItem({ source, effort: 5, score: 10 }), cfg);
      if (anyFrontierAvailable) {
        expect(['claude', 'codex']).toContain(d.backend);
        expect(d.tier).toBe('frontier');
      } else {
        expect(d.backend).toBe('builtin');
        expect(d.tier).toBe('local');
      }
    }
  });

  it('routes low-effort (<=2) non-bulk items to a FRONTIER backend when frontier is allowed+installed, else builtin', () => {
    // NEW POLICY: frontier-first regardless of effort level.
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude', 'codex'] });
    const d = routeBackend(makeItem({ source: 'security', effort: 1 }), cfg);
    const anyFrontierAvailable = engineInstalled('claude') || engineInstalled('codex');
    if (anyFrontierAvailable) {
      expect(['claude', 'codex']).toContain(d.backend);
      expect(d.tier).toBe('frontier');
    } else {
      expect(d.backend).toBe('builtin');
      expect(d.tier).toBe('local');
    }
  });

  it('fails closed when a diagnostic reslice has no journal-backed generation authority', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'local-coder', 'claude', 'codex'] });
    const parentTier = engineTierOf('local-coder', cfg);
    const d = routeBackend(makeItem({
      id: 'repo:proposal-repair-nodiff:abcdef123456',
      source: 'self',
      effort: 1,
      score: 1,
      title: 'Reslice no-diff dispatch for repo item repo:goal:stalled',
      detail:
        'Diagnostic reslice: a dispatch completed without file changes.\n' +
        'Original work item: repo:goal:stalled\n' +
        'Dispatch outcome: empty-diff\n' +
        'Action: reslice the work into a smaller concrete edit.',
      tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
      repairParentItemId: 'repo:goal:stalled',
      repairParentSource: 'goal',
      repairParentBackend: 'local-coder',
      repairParentTier: parentTier,
    }), cfg);

    expect(d.backend).toBe('builtin');
    expect(d.reason).toContain('repair-lifecycle-unavailable');
  });

  it('fails closed when a diagnostic reslice has no durable parent tier', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'local-coder', 'claude', 'codex'] });
    const d = routeBackend(makeItem({
      id: 'repo:proposal-repair-nodiff:abcdef123456',
      source: 'self',
      title: 'Reslice no-diff dispatch for repo item repo:goal:legacy',
      detail:
        'Diagnostic reslice: legacy.\n' +
        'Original work item: repo:goal:legacy\n' +
        'Dispatch outcome: empty-diff\n' +
        'Action: reslice the work into a smaller concrete edit.',
      tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
    }), cfg);

    expect(d.backend).toBe('builtin');
    expect(d.reason).toContain('repair-provenance-missing');
  });

  it('routes generated capture proposal repairs to frontier when available', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'local-coder', 'claude', 'codex'] });
    const d = routeBackend(makeItem({
      id: 'repo:proposal-repair-capture:abcdef123456',
      source: 'self',
      effort: 1,
      score: 1,
      title: 'Repair dispatch capture failure for repo item repo:self-heal:stalled',
      detail:
        'Dispatch capture repair: an autonomous dispatch produced repairable work but no proposal.\n' +
        'Original work item: repo:self-heal:stalled\n' +
        'Dispatch outcome: gate-blocked\n' +
        'Diff metadata: files=1, lines=12\n' +
        'Failure: completeness gate blocked proposal capture\n' +
        'Produce a fresh complete fix, rerun merge-grade verification, and do not copy any old partial diff or tool output.',
      tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate', 'verify', 'high-priority'],
    }), cfg);

    const anyFrontierAvailable = engineInstalled('claude') || engineInstalled('codex');
    if (anyFrontierAvailable) {
      expect(['claude', 'codex']).toContain(d.backend);
      expect(d.tier).toBe('frontier');
      expect(d.reason).toContain('frontier: generated capture proposal repair');
      expect(d.reason).not.toContain('local-mid bulk');
    } else if (engineInstalled('local-coder')) {
      expect(d.backend).toBe('local-coder');
      expect(d.tier).toBe(engineTierOf('local-coder', cfg));
    } else {
      expect(d.backend).toBe('builtin');
      expect(d.tier).toBe('local');
    }
  });

  it('fails closed when widened capture tier metadata lacks durable handoff authority', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'local-coder', 'claude', 'codex'] });
    const item = makeItem({
      id: 'repo:proposal-repair-capture:fedcba654321',
      source: 'self',
      effort: 5,
      score: 5,
      title: 'Repair dispatch capture failure for repo item repo:issue:42',
      detail:
        'Dispatch capture repair: an autonomous dispatch produced repairable work but no proposal.\n' +
        'Original work item: repo:issue:42\n' +
        'Dispatch outcome: gate-blocked\n' +
        'Diff metadata: files=1, lines=12\n' +
        'Failure: completeness gate blocked proposal capture\n' +
        'Produce a fresh complete fix, rerun merge-grade verification, and do not copy any old partial diff or tool output.',
      tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate', 'verify', 'high-priority'],
      repairParentItemId: 'repo:issue:42',
      repairParentSource: 'issue',
      repairParentBackend: 'local-coder',
      repairParentTier: 'mid',
      repairParentObjectiveHash: 'a'.repeat(64),
    });

    const decision = routeBackend(item, cfg);
    expect(decision.backend).toBe('builtin');
    expect(decision.reason).toContain('capture-repair-provenance-unavailable');
  });

  it('does not promote tag-only capture repair lookalikes to frontier as generated repairs', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'local-coder', 'claude', 'codex'] });
    const d = routeBackend(makeItem({
      id: 'repo:manual-capture-repair',
      source: 'self',
      effort: 1,
      score: 1,
      title: 'Manual capture repair',
      detail:
        'Dispatch capture repair: an autonomous dispatch produced repairable work but no proposal.\n' +
        'Original work item: repo:self-heal:stalled\n' +
        'Dispatch outcome: gate-blocked\n' +
        'Diff metadata: files=1, lines=12\n' +
        'Failure: completeness gate blocked proposal capture\n' +
        'Produce a fresh complete fix, rerun merge-grade verification, and do not copy any old partial diff or tool output.',
      tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate'],
    }), cfg);

    expect(d.reason).not.toContain('generated capture proposal repair');
  });

  it('fails closed for capture repair samples without tags', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'local-coder', 'claude', 'codex'] });
    const item = makeItem({
      id: 'repo:proposal-repair-capture:abcdef123456',
      source: 'self',
      effort: 1,
      score: 1,
      title: 'Repair dispatch capture failure for repo item repo:self-heal:stalled',
      detail:
        'Dispatch capture repair: an autonomous dispatch produced repairable work but no proposal.\n' +
        'Original work item: repo:self-heal:stalled\n' +
        'Dispatch outcome: gate-blocked\n' +
        'Diff metadata: files=1, lines=12\n' +
        'Failure: completeness gate blocked proposal capture\n' +
        'Produce a fresh complete fix, rerun merge-grade verification, and do not copy any old partial diff or tool output.',
      tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate'],
    });
    delete (item as Partial<WorkItem>).tags;

    const d = routeBackend(item, cfg);

    expect(d.reason).not.toContain('generated capture proposal repair');
  });

  it('does not promote tag-only no-diff repair lookalikes to frontier as generated repairs', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'local-coder', 'claude', 'codex'] });
    const d = routeBackend(makeItem({
      id: 'repo:manual-diagnostic-reslice',
      source: 'self',
      effort: 1,
      score: 1,
      title: 'Manual diagnostic reslice',
      detail:
        'Diagnostic reslice: a dispatch completed without file changes.\n' +
        'Original work item: repo:goal:stalled\n' +
        'Dispatch outcome: empty-diff\n' +
        'Action: reslice the work into a smaller concrete edit.',
      tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
    }), cfg);

    expect(d.reason).not.toContain('generated no-diff proposal repair');
  });

  it('routes security/issue/high-effort to a frontier backend when allowed+installed, else builtin', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude', 'codex'] });
    const item = makeItem({ source: 'security', effort: 5, score: 10 });
    const d = routeBackend(item, cfg);

    const anyFrontierAvailable =
      (engineInstalled('claude')) || (engineInstalled('codex'));
    if (anyFrontierAvailable) {
      expect(['claude', 'codex']).toContain(d.backend);
      expect(d.tier).toBe('frontier');
    } else {
      expect(d.backend).toBe('builtin');
      expect(d.tier).toBe('local');
    }
  });

  it('NEVER returns a backend outside allowedBackends', () => {
    // Only builtin allowed — even a senior item must stay on builtin.
    const cfg = withFoundry({ allowedBackends: ['builtin'] });
    const senior = routeBackend(makeItem({ source: 'security', effort: 5, score: 10 }), cfg);
    expect(senior.backend).toBe('builtin');

    // Default (foundry absent) ⇒ ['builtin'] only.
    const noFoundry = routeBackend(makeItem({ source: 'issue', effort: 5 }), baseConfig());
    expect(noFoundry.backend).toBe('builtin');
  });

  it('never returns an external backend that is not installed', () => {
    // Allow a frontier backend; if it is NOT installed it must fall back to builtin.
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] });
    const d = routeBackend(makeItem({ source: 'security', effort: 5 }), cfg);
    if (!engineInstalled('claude')) {
      expect(d.backend).toBe('builtin');
    } else {
      expect(d.backend).toBe('claude');
    }
  });

  it('tier always matches the chosen backend', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude', 'codex'] });
    for (const source of ['doc', 'security', 'issue', 'dep'] as WorkSource[]) {
      const d = routeBackend(makeItem({ source, effort: 4 }), cfg);
      expect(d.tier).toBe(engineTierOf(d.backend));
    }
  });

  it('is deterministic — same item routes identically across calls', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude', 'codex'] });
    const item = makeItem({ id: 'fixed-id', source: 'security', effort: 5 });
    const a = routeBackend(item, cfg);
    const b = routeBackend(item, cfg);
    expect(a.backend).toBe(b.backend);
  });

  it('alternates deterministically across two frontier backends by item.id', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude', 'codex'] });
    const bothInstalled = engineInstalled('claude') && engineInstalled('codex');
    if (!bothInstalled) {
      // Cannot exercise alternation on this machine — assert the structural
      // guarantee instead: the hash split is stable per id (determinism), which
      // is covered above. Treat as a documented skip-equivalent.
      expect(true).toBe(true);
      return;
    }
    // With both frontier backends available, scan many ids and require the
    // senior load to be SPLIT across both (not all on one) and DETERMINISTIC.
    const seen = new Set<EngineId>();
    for (let i = 0; i < 50; i++) {
      const item = makeItem({ id: `alt-${i}`, source: 'security', effort: 5 });
      const first = routeBackend(item, cfg);
      const again = routeBackend(item, cfg);
      expect(again.backend).toBe(first.backend); // deterministic per id
      seen.add(first.backend);
    }
    expect(seen.has('claude')).toBe(true);
    expect(seen.has('codex')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// quota ledger (HOME-isolated)
// ---------------------------------------------------------------------------

describe('fleet quota ledger', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m46-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome; // win32 homedir()
  });

  afterEach(() => {
    setFleetQuotaTestHooksForTests(undefined);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('loadFleetQuota returns a fresh empty ledger when missing', () => {
    const q = loadFleetQuota();
    expect(q).toEqual({ events: [] });
  });

  it('recordUse persists and usesInWindow counts within the window', () => {
    recordUse('claude');
    recordUse('claude');
    recordUse('codex');
    expect(existsSync(fleetQuotaPath())).toBe(true);

    const now = Date.now();
    // wide window — everything counts
    expect(usesInWindow('claude', 60 * 60_000, now)).toBe(2);
    expect(usesInWindow('codex', 60 * 60_000, now)).toBe(1);
    expect(usesInWindow('builtin', 60 * 60_000, now)).toBe(0);
  });

  it('usesInWindow excludes events older than the window (injected now)', () => {
    // Manually seed the ledger with an old and a recent event.
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    const now = Date.UTC(2026, 0, 1, 12, 0, 0); // fixed clock
    const old = new Date(now - 2 * 60_000).toISOString(); // 2 min ago
    const recent = new Date(now - 30_000).toISOString(); // 30 s ago
    writeFileSync(
      fleetQuotaPath(),
      JSON.stringify({
        events: [
          { backend: 'claude', ts: old },
          { backend: 'claude', ts: recent },
        ],
      }),
      'utf8',
    );

    // 1-minute window: only the 30s-ago event counts.
    expect(usesInWindow('claude', 60_000, now)).toBe(1);
    // 5-minute window: both count.
    expect(usesInWindow('claude', 5 * 60_000, now)).toBe(2);
  });

  it('withinLimit is true when no limit is configured (unlimited)', () => {
    recordUse('claude');
    recordUse('claude');
    recordUse('claude');
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] }); // no limits
    expect(withinLimit('claude', cfg)).toBe(true);
  });

  it('withinLimit becomes false once the cap is reached', () => {
    const now = Date.now();
    recordUse('claude');
    recordUse('claude');
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude'],
      limits: { claude: { window: '1h', max: 2 } },
    });
    // 2 used, cap 2 ⇒ NOT within limit (used < max is false).
    expect(withinLimit('claude', cfg, now)).toBe(false);

    const cfg3 = withFoundry({
      allowedBackends: ['builtin', 'claude'],
      limits: { claude: { window: '1h', max: 3 } },
    });
    // 2 used, cap 3 ⇒ within limit.
    expect(withinLimit('claude', cfg3, now)).toBe(true);
  });

  it('withinLimit honors consumed slots but leaves invalid authority to the final refusal gate', () => {
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 1 } },
    });
    expect(reserveFleetQuotaUse('claude', cfg, 'routing-authority-slot')).toMatchObject({
      kind: 'reserved', launchAuthorized: true,
    });
    expect(loadFleetQuota().events).toHaveLength(0);
    expect(withinLimit('claude', cfg)).toBe(false);

    const invalid = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '2h', max: 1 } },
    });
    expect(inspectFleetQuotaAuthority('claude', invalid)).toBe('invalid');
    expect(withinLimit('claude', invalid)).toBe(true);
  });

  it('evalQuota reports ok / warn / over (three levels)', () => {
    const now = Date.now();
    const mk = (max: number) =>
      withFoundry({
        allowedBackends: ['builtin', 'claude'],
        limits: { claude: { window: '1h', max } },
      });

    // 0 used so far.
    expect(evalQuota('claude', mk(10), now)).toBe('ok');

    // Record 8 uses → 80% of 10 ⇒ warn.
    for (let i = 0; i < 8; i++) recordUse('claude');
    expect(evalQuota('claude', mk(10), now)).toBe('warn');

    // Record 2 more → 10/10 ⇒ over.
    recordUse('claude');
    recordUse('claude');
    expect(evalQuota('claude', mk(10), now)).toBe('over');

    // No limit configured ⇒ always ok.
    const noLimit = withFoundry({ allowedBackends: ['builtin', 'claude'] });
    expect(evalQuota('claude', noLimit, now)).toBe('ok');
  });

  it('loadFleetQuota tolerates a corrupt file (returns fresh)', () => {
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fleetQuotaPath(), '{ this is not valid json ::::', 'utf8');
    expect(loadFleetQuota()).toEqual({ events: [] });

    // Wrong shape (array instead of object) also yields fresh.
    writeFileSync(fleetQuotaPath(), '[1,2,3]', 'utf8');
    expect(loadFleetQuota()).toEqual({ events: [] });
  });

  it('persists atomically and round-trips through loadFleetQuota', () => {
    recordUse('codex');
    const q = loadFleetQuota();
    expect(q.events.length).toBe(1);
    expect(q.events[0]!.backend).toBe('codex');
    expect(typeof q.events[0]!.ts).toBe('string');
    // No leftover tmp file after an atomic rename.
    expect(existsSync(fleetQuotaPath() + '.tmp')).toBe(false);
  });

  it('durably reserves configured quota and makes retries idempotent', () => {
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude'],
      limits: { claude: { window: '1h', max: 2 } },
    });
    expect(reserveFleetQuotaUse('claude', cfg, 'dispatch-sensitive-1')).toEqual({
      kind: 'reserved',
      launchAuthorized: true,
      reservations: [{ backend: 'claude', status: 'reserved', used: 1, limit: 2 }],
    });
    expect(reserveFleetQuotaUse('claude', cfg, 'dispatch-sensitive-1')).toEqual({
      kind: 'duplicate',
      launchAuthorized: false,
      backend: 'claude',
    });
    expect(reserveFleetQuotaUse('claude', cfg, 'dispatch-sensitive-2')).toEqual({
      kind: 'reserved',
      launchAuthorized: true,
      reservations: [{ backend: 'claude', status: 'reserved', used: 2, limit: 2 }],
    });
    expect(reserveFleetQuotaUse('claude', cfg, 'dispatch-sensitive-3')).toEqual({
      kind: 'exhausted',
      launchAuthorized: false,
      backend: 'claude',
      used: 2,
      limit: 2,
    });

    const raw = readFileSync(fleetQuotaReservationPath(), 'utf8');
    expect(raw).not.toContain('dispatch-sensitive');
    expect(loadReservationLedger().events).toHaveLength(2);
    expect(loadReservationLedger().events.every((event) =>
      typeof event.reservationIdHash === 'string' && /^[a-f0-9]{64}$/.test(event.reservationIdHash))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(fleetQuotaReservationPath()).mode & 0o777).toBe(0o600);
      expect(statSync(join(tmpHome, '.ashlr', 'fleet')).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(tmpHome, '.ashlr', 'fleet')).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('reports exhausted reserved authority even before actual-attempt telemetry exists', () => {
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 1 } },
    });
    expect(reserveFleetQuotaUse('claude', cfg, 'reserved-no-attempt').launchAuthorized).toBe(true);
    expect(loadFleetQuota().events).toEqual([]);
    expect(evalFleetQuotaAuthority('claude', cfg)).toBe('over');
    expect(reserveFleetQuotaUse('claude', cfg, 'next-attempt')).toMatchObject({
      kind: 'exhausted', launchAuthorized: false, used: 1, limit: 1,
    });
  });

  it('fails closed for configured limits when the ledger is corrupt', () => {
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    const corrupt = '{ not trustworthy quota state';
    writeFileSync(fleetQuotaReservationPath(), corrupt, 'utf8');
    if (process.platform !== 'win32') chmodSync(fleetQuotaReservationPath(), 0o600);
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'codex'],
      limits: { codex: { window: '1h', max: 5 } },
    });

    expect(reserveFleetQuotaUse('codex', cfg, 'dispatch-corrupt')).toEqual({
      kind: 'unavailable',
      launchAuthorized: false,
    });
    expect(inspectFleetQuotaAuthority('codex', cfg)).toBe('unavailable');
    expect(readFileSync(fleetQuotaReservationPath(), 'utf8')).toBe(corrupt);
  });

  it('fails closed on reservation lock contention', () => {
    const held = acquireLocalStoreLock(fleetQuotaReservationLockPath(), 0, {
      anchorPath: tmpHome,
      exactPrivateStorage: true,
    });
    expect(held).not.toBeNull();
    try {
      const cfg = withFoundry({
        allowedBackends: ['builtin', 'claude'],
        limits: { claude: { window: '1h', max: 5 } },
      });
      expect(reserveFleetQuotaUse('claude', cfg, 'dispatch-contended', { lockWaitMs: 0 })).toEqual({
        kind: 'unavailable',
        launchAuthorized: false,
      });
      expect(existsSync(fleetQuotaReservationPath())).toBe(false);
    } finally {
      expect(releaseLocalStoreLock(held)).toBe(true);
    }
  });

  it.runIf(process.platform !== 'win32')('reports a symlinked authority directory unavailable before file creation', () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const target = join(tmpHome, 'attacker-fleet');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(ashlrDir, 'fleet'), 'dir');
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 1 } },
    });

    expect(inspectFleetQuotaAuthority('claude', cfg)).toBe('unavailable');
    expect(evalFleetQuotaAuthority('claude', cfg)).toBe('over');
    expect(reserveFleetQuotaUse('claude', cfg, 'symlinked-authority')).toEqual({
      kind: 'unavailable', launchAuthorized: false,
    });
  });

  it('keeps absent limits unlimited without consulting damaged storage', () => {
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    const corrupt = '{ damaged but irrelevant for an unlimited backend';
    writeFileSync(fleetQuotaReservationPath(), corrupt, 'utf8');
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] });

    expect(reserveFleetQuotaUse('claude', cfg, 'dispatch-unlimited')).toEqual({
      kind: 'unlimited',
      launchAuthorized: true,
      reservations: [{ backend: 'claude', status: 'unlimited', used: 0, limit: null }],
    });
    expect(readFileSync(fleetQuotaReservationPath(), 'utf8')).toBe(corrupt);
  });

  it('supports the documented 5h window and reserves a mixed batch atomically', () => {
    expect(windowToMs('5h')).toBe(5 * 60 * 60_000);
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex'],
      limits: {
        claude: { window: '5h', max: 2 },
        codex: { window: '1h', max: 1 },
      },
    });
    expect(reserveFleetQuotaUses([
      { backend: 'claude', dispatchId: 'batch-claude-1' },
      { backend: 'codex', dispatchId: 'batch-codex-1' },
    ], cfg)).toEqual({
      kind: 'reserved',
      launchAuthorized: true,
      reservations: [
        { backend: 'claude', status: 'reserved', used: 1, limit: 2 },
        { backend: 'codex', status: 'reserved', used: 1, limit: 1 },
      ],
    });
    const before = readFileSync(fleetQuotaReservationPath(), 'utf8');
    expect(reserveFleetQuotaUses([
      { backend: 'claude', dispatchId: 'batch-claude-2' },
      { backend: 'codex', dispatchId: 'batch-codex-2' },
    ], cfg)).toEqual({
      kind: 'exhausted',
      launchAuthorized: false,
      backend: 'codex',
      used: 1,
      limit: 1,
    });
    expect(readFileSync(fleetQuotaReservationPath(), 'utf8')).toBe(before);
  });

  it('rejects unknown configured windows without creating authority state', () => {
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '2h', max: 2 } },
    });
    expect(reserveFleetQuotaUse('claude', cfg, 'unknown-window')).toEqual({
      kind: 'invalid',
      launchAuthorized: false,
      backend: 'claude',
    });
    expect(inspectFleetQuotaAuthority('claude', cfg)).toBe('invalid');
    expect(existsSync(fleetQuotaReservationPath())).toBe(false);
  });

  it('returns invalid rather than throwing for adversarial request or config getters', () => {
    const throwingRequest = Object.defineProperty({}, 'backend', {
      enumerable: true,
      get: () => { throw new Error('request getter'); },
    });
    expect(() => reserveFleetQuotaUses(
      [throwingRequest as never],
      withFoundry({ allowedBackends: ['claude'] }),
    )).not.toThrow();
    expect(reserveFleetQuotaUses(
      [throwingRequest as never],
      withFoundry({ allowedBackends: ['claude'] }),
    )).toEqual({ kind: 'invalid', launchAuthorized: false });

    const throwingConfig = Object.defineProperty({ version: 1 }, 'foundry', {
      enumerable: true,
      get: () => { throw new Error('config getter'); },
    }) as AshlrConfig;
    expect(reserveFleetQuotaUse('claude', throwingConfig, 'getter-config')).toEqual({
      kind: 'invalid', launchAuthorized: false,
    });
  });

  it('binds a persisted dispatch identity to exactly one backend', () => {
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex'],
      limits: {
        claude: { window: '1h', max: 2 },
        codex: { window: '1h', max: 2 },
      },
    });
    expect(reserveFleetQuotaUse('claude', cfg, 'global-dispatch-id').launchAuthorized).toBe(true);
    expect(reserveFleetQuotaUse('codex', cfg, 'global-dispatch-id')).toEqual({
      kind: 'conflict',
      launchAuthorized: false,
      backend: 'codex',
    });
    expect(loadReservationLedger().events).toHaveLength(1);
  });

  it('migrates active legacy telemetry into private authority state on first reservation', () => {
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    if (process.platform !== 'win32') chmodSync(dir, 0o755);
    writeFileSync(fleetQuotaPath(), JSON.stringify({
      events: [{ backend: 'claude', ts: new Date().toISOString() }],
    }) + '\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(fleetQuotaPath(), 0o644);
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 3 } },
    });
    expect(reserveFleetQuotaUse('claude', cfg, 'legacy-followup')).toMatchObject({
      kind: 'reserved',
      launchAuthorized: true,
      reservations: [{ backend: 'claude', status: 'reserved', used: 2, limit: 3 }],
    });
    expect(loadFleetQuota().events).toHaveLength(1);
    expect(loadReservationLedger().events).toHaveLength(2);
    if (process.platform !== 'win32') {
      expect(statSync(fleetQuotaPath()).mode & 0o777).toBe(0o644);
      expect(statSync(fleetQuotaReservationPath()).mode & 0o777).toBe(0o600);
    }
  });

  it('counts active legacy telemetry before first authority publication', () => {
    const now = Date.parse('2026-08-16T12:00:00.000Z');
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    if (process.platform !== 'win32') chmodSync(dir, 0o755);
    writeFileSync(fleetQuotaPath(), `${JSON.stringify({
      events: [{ backend: 'claude', ts: new Date(now - 1_000).toISOString() }],
    })}\n`, 'utf8');
    if (process.platform !== 'win32') chmodSync(fleetQuotaPath(), 0o644);
    setFleetQuotaTestHooksForTests({ now: () => now });
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 1 } },
    });

    expect(inspectFleetQuotaAuthority('claude', cfg)).toBe('healthy');
    expect(evalFleetQuotaAuthority('claude', cfg)).toBe('over');
    expect(reserveFleetQuotaUse('claude', cfg, 'legacy-cap-reached')).toEqual({
      kind: 'exhausted', launchAuthorized: false, backend: 'claude', used: 1, limit: 1,
    });
    expect(existsSync(fleetQuotaReservationPath())).toBe(false);
  });

  it('fails closed when legacy telemetry is corrupt before authority bootstrap', () => {
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fleetQuotaPath(), '{ corrupt legacy telemetry', 'utf8');
    if (process.platform !== 'win32') chmodSync(fleetQuotaPath(), 0o644);
    const cfg = withFoundry({
      allowedBackends: ['codex'],
      limits: { codex: { window: '1h', max: 2 } },
    });

    expect(inspectFleetQuotaAuthority('codex', cfg)).toBe('unavailable');
    expect(evalFleetQuotaAuthority('codex', cfg)).toBe('over');
    expect(reserveFleetQuotaUse('codex', cfg, 'legacy-corrupt')).toEqual({
      kind: 'unavailable', launchAuthorized: false,
    });
    expect(existsSync(fleetQuotaReservationPath())).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('rejects writable or symlinked legacy telemetry during bootstrap', () => {
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 2 } },
    });
    writeFileSync(fleetQuotaPath(), `${JSON.stringify({ events: [] })}\n`, 'utf8');
    chmodSync(fleetQuotaPath(), 0o666);
    expect(inspectFleetQuotaAuthority('claude', cfg)).toBe('unavailable');
    expect(evalFleetQuotaAuthority('claude', cfg)).toBe('over');
    expect(reserveFleetQuotaUse('claude', cfg, 'writable-legacy')).toEqual({
      kind: 'unavailable', launchAuthorized: false,
    });

    rmSync(fleetQuotaPath());
    const target = join(tmpHome, 'legacy-target.json');
    writeFileSync(target, `${JSON.stringify({ events: [] })}\n`, 'utf8');
    symlinkSync(target, fleetQuotaPath());
    expect(inspectFleetQuotaAuthority('claude', cfg)).toBe('unavailable');
    expect(reserveFleetQuotaUse('claude', cfg, 'symlinked-legacy')).toEqual({
      kind: 'unavailable', launchAuthorized: false,
    });
    expect(existsSync(fleetQuotaReservationPath())).toBe(false);
  });

  it('retains legacy usage when a limit is enabled after an unrelated authority publish', () => {
    const now = Date.parse('2026-08-16T12:00:00.000Z');
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fleetQuotaPath(), `${JSON.stringify({
      events: [{ backend: 'claude', ts: new Date(now - 30_000).toISOString() }],
    })}\n`, 'utf8');
    if (process.platform !== 'win32') chmodSync(fleetQuotaPath(), 0o644);
    setFleetQuotaTestHooksForTests({ now: () => now });

    const codexOnly = withFoundry({
      allowedBackends: ['claude', 'codex'],
      limits: { codex: { window: '1h', max: 2 } },
    });
    expect(reserveFleetQuotaUse('codex', codexOnly, 'codex-bootstrap')).toMatchObject({
      kind: 'reserved', launchAuthorized: true,
    });
    expect(loadReservationLedger().events).toHaveLength(2);

    const claudeEnabled = withFoundry({
      allowedBackends: ['claude', 'codex'],
      limits: { claude: { window: '1h', max: 1 } },
    });
    expect(evalFleetQuotaAuthority('claude', claudeEnabled)).toBe('over');
    expect(reserveFleetQuotaUse('claude', claudeEnabled, 'claude-after-enable')).toEqual({
      kind: 'exhausted', launchAuthorized: false, backend: 'claude', used: 1, limit: 1,
    });
  });

  it('retains active history when a configured window widens', () => {
    const now = Date.parse('2026-08-16T12:00:00.000Z');
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fleetQuotaPath(), `${JSON.stringify({
      events: [{ backend: 'claude', ts: new Date(now - 2 * 60 * 60_000).toISOString() }],
    })}\n`, 'utf8');
    if (process.platform !== 'win32') chmodSync(fleetQuotaPath(), 0o644);
    setFleetQuotaTestHooksForTests({ now: () => now });

    const narrow = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 2 } },
    });
    expect(reserveFleetQuotaUse('claude', narrow, 'narrow-window')).toMatchObject({
      kind: 'reserved', launchAuthorized: true,
      reservations: [{ backend: 'claude', used: 1, limit: 2 }],
    });
    expect(loadReservationLedger().events).toHaveLength(2);

    const widened = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '5h', max: 2 } },
    });
    expect(evalFleetQuotaAuthority('claude', widened)).toBe('over');
    expect(reserveFleetQuotaUse('claude', widened, 'wide-window')).toEqual({
      kind: 'exhausted', launchAuthorized: false, backend: 'claude', used: 2, limit: 2,
    });
  });

  it('compacts receipts outside the maximum supported window before enforcing capacity', () => {
    const now = Date.parse('2026-08-16T12:00:00.000Z');
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    writeFileSync(fleetQuotaReservationPath(), `${JSON.stringify({
      events: Array.from({ length: 2_000 }, (_, index) => ({
        backend: 'claude',
        ts: new Date(now - 31 * 24 * 60 * 60_000 - index).toISOString(),
      })),
    })}\n`, 'utf8');
    if (process.platform !== 'win32') chmodSync(fleetQuotaReservationPath(), 0o600);
    setFleetQuotaTestHooksForTests({ now: () => now });
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 2 } },
    });

    expect(reserveFleetQuotaUse('claude', cfg, 'after-expiry')).toEqual({
      kind: 'reserved',
      launchAuthorized: true,
      reservations: [{ backend: 'claude', status: 'reserved', used: 1, limit: 2 }],
    });
    expect(loadReservationLedger().events).toHaveLength(1);
  });

  it('appends safely at the exact 2,000-per-backend authority bound', () => {
    const now = Date.parse('2026-08-16T12:00:00.000Z');
    const backends: EngineId[] = [
      'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex',
      'hermes', 'kimi', 'nim', 'opencode', 'grok',
    ];
    const dir = join(tmpHome, '.ashlr', 'fleet');
    mkdirSync(dir, { recursive: true });
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    writeFileSync(fleetQuotaReservationPath(), `${JSON.stringify({
      events: backends.flatMap((backend) => Array.from({ length: 2_000 }, (_, index) => ({
        backend,
        ts: new Date(now - 2 * 60 * 60_000 - index).toISOString(),
      }))),
    })}\n`, 'utf8');
    if (process.platform !== 'win32') chmodSync(fleetQuotaReservationPath(), 0o600);
    setFleetQuotaTestHooksForTests({ now: () => now });
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 2 } },
    });

    expect(reserveFleetQuotaUse('claude', cfg, 'exact-global-bound')).toMatchObject({
      kind: 'reserved', launchAuthorized: true,
      reservations: [{ backend: 'claude', used: 1, limit: 2 }],
    });
    const events = loadReservationLedger().events;
    expect(events).toHaveLength(22_000);
    expect(events.filter((event) => event['backend'] === 'claude')).toHaveLength(2_000);
  });

  it('withholds launch when lock release fails after durable publication', () => {
    setFleetQuotaTestHooksForTests({
      releaseLock: (lock) => {
        expect(releaseLocalStoreLock(lock)).toBe(true);
        return false;
      },
    });
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 2 } },
    });
    expect(reserveFleetQuotaUse('claude', cfg, 'release-failure')).toEqual({
      kind: 'unavailable',
      launchAuthorized: false,
      reservationConsumed: true,
    });
    expect(loadReservationLedger().events).toHaveLength(1);
  });
});

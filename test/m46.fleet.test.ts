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
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig, EngineId, WorkItem, WorkSource } from '../src/core/types.js';
import { routeBackend } from '../src/core/fleet/router.js';
import {
  fleetQuotaPath,
  loadFleetQuota,
  recordUse,
  usesInWindow,
  withinLimit,
  evalQuota,
} from '../src/core/fleet/quota.js';
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

  it('routes generated no-diff proposal repair reslices to frontier when available', () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'local-coder', 'claude', 'codex'] });
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
    }), cfg);

    const anyFrontierAvailable = engineInstalled('claude') || engineInstalled('codex');
    if (anyFrontierAvailable) {
      expect(['claude', 'codex']).toContain(d.backend);
      expect(d.tier).toBe('frontier');
      expect(d.reason).toContain('frontier: generated no-diff proposal repair');
      expect(d.reason).not.toContain('local-mid bulk');
    } else if (engineInstalled('local-coder')) {
      expect(d.backend).toBe('local-coder');
      expect(d.tier).toBe(engineTierOf('local-coder', cfg));
    } else {
      expect(d.backend).toBe('builtin');
      expect(d.tier).toBe('local');
    }
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
});

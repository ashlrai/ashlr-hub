/**
 * usage-contract.test.ts — THE SEAM TEST (integration, V2.1).
 *
 * Every fixture here is annotated with owner T's REAL core type, not an
 * inline literal. That is the point of the file: if a field is renamed in
 * `src/core/verse/*.ts`, this file fails to COMPILE, and if the projector
 * stops reading it, this file fails to RUN. Owner V's other tests cover the
 * display logic against display shapes; this one covers the wire.
 *
 * It exists because all three seams were genuinely broken when integration
 * started, and each failure was SILENT — the projectors returned `null` or a
 * wrong-but-plausible value and the panels degraded to "unknown" rather than
 * throwing. A degraded panel looks like a design decision, so nothing would
 * have caught it but a human noticing the Usage view was empty against a
 * server that had the data.
 */
import { describe, expect, it } from 'vitest';

import type {
  VerseAccountRecord,
  VerseAccountsSnapshot,
} from '../../../../core/verse/accounts.js';
import type { VerseLocalModel, VerseLocalModelsSnapshot } from '../../../../core/verse/local-models.js';
import type { DailyUsage } from '../../../../core/types.js';

import {
  CLAUDE_USAGE_PINNED_VERSION,
  CLAUDE_VERSION_REASON,
  projectAccountsSnapshot,
  projectLocalModels,
  projectUsageSeries,
  sanitizeCommand,
} from './usage-contract.js';
import { buildLocalModelsView, resolveToolSupport } from './local-model.js';

// ---------------------------------------------------------------------------
// Fixtures, typed as the wire
// ---------------------------------------------------------------------------

function claudeRecord(over: Partial<VerseAccountRecord> = {}): VerseAccountRecord {
  return {
    id: 'claude-a',
    label: 'Claude',
    provider: 'claude',
    state: 'observed',
    authentication: 'signed-in',
    health: 'unknown',
    planType: 'max',
    observedAt: '2026-09-20T09:00:00.000Z',
    expiresAt: null,
    windows: [
      {
        id: 'five_hour',
        usedPercent: 47,
        resetsAt: null,
        nativeReport: { source: 'claude-usage', resetDescription: 'resets Sep 20 at 2:30am (America/New_York)' },
        limitReached: false,
        measured: true,
      },
      {
        id: 'seven_day',
        usedPercent: 58,
        resetsAt: null,
        nativeReport: { source: 'claude-usage', resetDescription: 'resets Sep 25 at 7pm (America/New_York)' },
        limitReached: false,
        measured: true,
      },
      {
        id: 'seven_day_fable',
        usedPercent: 100,
        resetsAt: null,
        nativeReport: { source: 'claude-usage', resetDescription: 'resets Sep 25 at 7pm (America/New_York)' },
        limitReached: false,
        measured: true,
      },
    ],
    reason: '',
    onDemandEnabled: null,
    executionSupported: true,
    credits: null,
    binding: { id: 'seven_day_fable', usedPercent: 100, limitReached: false },
    notes: [],
    ...over,
  };
}

function snapshot(over: Partial<VerseAccountsSnapshot> = {}): VerseAccountsSnapshot {
  return {
    sampledAt: '2026-09-20T09:00:00.000Z',
    refreshing: false,
    collector: {
      mode: 'owned',
      state: 'running',
      owner: 'this-server',
      reasonCode: null,
      pollIntervalMs: 30_000,
      idleSuspendMs: 300_000,
      lastPolledAt: '2026-09-20T09:00:00.000Z',
      lastRequestAt: '2026-09-20T09:00:00.000Z',
      note: 'This server owns the collector.',
    },
    accounts: [claudeRecord()],
    evidenceSource: 'collector',
    notes: [],
    ...over,
  };
}

function localModel(over: Partial<VerseLocalModel> & { id: string }): VerseLocalModel {
  return {
    runtime: 'ollama',
    label: over.id,
    state: 'available',
    sizeBytes: null,
    sizeVramBytes: null,
    placement: 'unknown',
    gpuPercent: null,
    expiresAt: null,
    contextLength: null,
    nativeContextLength: null,
    parameterSize: null,
    quantization: null,
    family: null,
    arch: null,
    capabilities: [],
    supportsTools: null,
    memoryPercent: null,
    ...over,
  };
}

function localSnapshot(over: Partial<VerseLocalModelsSnapshot> = {}): VerseLocalModelsSnapshot {
  return {
    sampledAt: '2026-09-20T09:00:00.000Z',
    machine: { totalMemoryBytes: 128 * 1024 ** 3, freeMemoryBytes: 40 * 1024 ** 3 },
    ollama: { reachable: true, baseUrl: 'http://127.0.0.1:11434', models: [], reason: null },
    lmStudio: { reachable: false, baseUrl: 'http://127.0.0.1:1234', models: [], reason: 'unreachable' },
    notes: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// GET /api/verse/accounts
// ---------------------------------------------------------------------------

describe('projectAccountsSnapshot against the real VerseAccountsSnapshot', () => {
  it('reads a Claude record end to end, keeping all three windows', () => {
    const projected = projectAccountsSnapshot(snapshot());
    expect(projected).not.toBeNull();
    expect(projected?.accounts).toHaveLength(1);
    const account = projected!.accounts[0]!;
    expect(account.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'seven_day_fable']);
    expect(account.planType).toBe('max');
  });

  it("lifts Claude's reset prose out of nativeReport and leaves resetsAt null", () => {
    // resetsAt is structurally always null for Claude; the human sentence is
    // the only reset fact that exists, and it must survive the projection or
    // the card silently loses its reset line.
    const account = projectAccountsSnapshot(snapshot())!.accounts[0]!;
    const weekly = account.windows.find((w) => w.id === 'seven_day')!;
    expect(weekly.resetsAt).toBeNull();
    expect(weekly.resetDescription).toBe('resets Sep 25 at 7pm (America/New_York)');
  });

  it('carries the server-computed binding window', () => {
    const account = projectAccountsSnapshot(snapshot())!.accounts[0]!;
    expect(account.binding?.id).toBe('seven_day_fable');
    expect(account.binding?.usedPercent).toBe(100);
  });

  it('derives `unsupported` from the version-pin reason code', () => {
    // The wire has no `unsupported` field; the probe failure arrives as the
    // verbatim reason. Losing it degrades a one-line constant bump into a
    // generic "No reading", which is precisely the outcome the pin exists to
    // prevent.
    const projected = projectAccountsSnapshot(
      snapshot({ accounts: [claudeRecord({ reason: CLAUDE_VERSION_REASON, windows: [], binding: null })] }),
    );
    const account = projected!.accounts[0]!;
    expect(account.unsupported).toEqual({
      code: CLAUDE_VERSION_REASON,
      pinnedVersion: CLAUDE_USAGE_PINNED_VERSION,
    });
  });

  it('does not invent `unsupported` for an ordinary reason', () => {
    const projected = projectAccountsSnapshot(
      snapshot({ accounts: [claudeRecord({ reason: 'signed-out' })] }),
    );
    expect(projected!.accounts[0]!.unsupported).toBeNull();
  });

  it('carries per-account notes, which is where the Grok fallback lives', () => {
    const projected = projectAccountsSnapshot(
      snapshot({
        accounts: [
          claudeRecord({
            id: 'grok-a',
            provider: 'grok',
            state: 'signed-out',
            authentication: 'signed-out',
            windows: [],
            binding: null,
            notes: ['Reconnect through the `ashlr resources` command group.'],
          }),
        ],
      }),
    );
    expect(projected!.accounts[0]!.notes).toEqual([
      'Reconnect through the `ashlr resources` command group.',
    ]);
  });

  it('raises the read-only banner only when ANOTHER collector owns the lease', () => {
    const owned = projectAccountsSnapshot(snapshot());
    expect(owned?.collectorNote).toBeNull();

    const borrowed = projectAccountsSnapshot(
      snapshot({
        collector: {
          mode: 'read-only',
          state: 'blocked',
          owner: 'another-collector',
          reasonCode: 'collector-owned',
          pollIntervalMs: 30_000,
          idleSuspendMs: 300_000,
          lastPolledAt: null,
          lastRequestAt: null,
          note: 'ashlr resource-console owns the quota-refresh lease.',
        },
      }),
    );
    expect(borrowed?.collectorNote).toBe('ashlr resource-console owns the quota-refresh lease.');
  });

  it('projects Codex credits verbatim, independent of the window', () => {
    const projected = projectAccountsSnapshot(
      snapshot({
        accounts: [
          claudeRecord({
            id: 'codex-a',
            provider: 'codex',
            planType: 'pro',
            windows: [
              { id: 'codex', usedPercent: 100, resetsAt: '2026-09-26T12:26:56.000Z', nativeReport: null, limitReached: true, measured: false },
            ],
            binding: { id: 'codex', usedPercent: 100, limitReached: true },
            credits: { hasCredits: true, unlimited: false, balance: '2048.4196250000' },
          }),
        ],
      }),
    );
    const account = projected!.accounts[0]!;
    // The decimal string is kept exactly — rounding a balance to a float is a
    // quiet lie about money.
    expect(account.credits?.balance).toBe('2048.4196250000');
    expect(account.credits?.balanceValue).toBeCloseTo(2048.419625, 6);
    expect(account.windows[0]!.limitReached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/verse/usage-series
// ---------------------------------------------------------------------------

describe('projectUsageSeries against the real {window, byDay, …} wrapper', () => {
  const byDay: DailyUsage[] = [
    { day: '2026-09-19', tokensIn: 100, tokensOut: 20, estCostUsd: 0.5, sessions: 2 },
    { day: '2026-09-18', tokensIn: 300, tokensOut: 60, estCostUsd: 1.5, sessions: 4 },
  ];

  it('reads `byDay`, which is the key the route actually sends', () => {
    // This is the seam that was broken: the projector only looked for `days`,
    // so the entire series panel rendered "unavailable" against a route that
    // was returning a perfectly good 30-day series.
    const series = projectUsageSeries({ window: '30d', byDay, estimated: true, caveats: [] }, '30d');
    expect(series).not.toBeNull();
    expect(series?.window).toBe('30d');
    expect(series?.days).toHaveLength(2);
  });

  it('sorts ascending so the chart reads left to right in time', () => {
    const series = projectUsageSeries({ window: '7d', byDay, estimated: true, caveats: [] }, '7d');
    expect(series?.days.map((d) => d.day)).toEqual(['2026-09-18', '2026-09-19']);
  });

  it('still accepts `days` and a bare array so an older server degrades, not dies', () => {
    expect(projectUsageSeries({ days: byDay }, '7d')?.days).toHaveLength(2);
    expect(projectUsageSeries(byDay, '7d')?.days).toHaveLength(2);
  });

  it('leaves absent cache columns null rather than substituting zero', () => {
    const series = projectUsageSeries({ window: '7d', byDay, estimated: true, caveats: [] }, '7d');
    expect(series?.days[0]!.cacheRead).toBeNull();
    expect(series?.days[0]!.cacheHitRate).toBeNull();
  });

  it('returns null when there is no series at all', () => {
    expect(projectUsageSeries({ window: '7d', estimated: true }, '7d')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/verse/local-models
// ---------------------------------------------------------------------------

describe('projectLocalModels against the real two-runtime snapshot', () => {
  it('flattens ollama + lmStudio into one list against the machine budget', () => {
    // The projector previously looked for a flat `models` array, which this
    // payload does not have, so it returned null and the whole local panel
    // went dark.
    const projected = projectLocalModels(
      localSnapshot({
        ollama: {
          reachable: true,
          baseUrl: 'http://127.0.0.1:11434',
          models: [localModel({ id: 'qwen3-coder:30b', state: 'loaded' })],
          reason: null,
        },
        lmStudio: {
          reachable: true,
          baseUrl: 'http://127.0.0.1:1234',
          models: [localModel({ id: 'lms-model', runtime: 'lmstudio' })],
          reason: null,
        },
      }),
    );
    expect(projected).not.toBeNull();
    expect(projected?.models.map((m) => m.name)).toEqual(['qwen3-coder:30b', 'lms-model']);
    expect(projected?.models.map((m) => m.runtime)).toEqual(['ollama', 'lmstudio']);
    expect(projected?.memoryBudgetBytes).toBe(128 * 1024 ** 3);
  });

  it("maps `state: 'loaded'` to resident, and `available` to installed-only", () => {
    const projected = projectLocalModels(
      localSnapshot({
        ollama: {
          reachable: true,
          baseUrl: 'http://127.0.0.1:11434',
          models: [
            localModel({ id: 'resident', state: 'loaded' }),
            localModel({ id: 'installed', state: 'available' }),
          ],
          reason: null,
        },
      }),
    );
    expect(projected?.models.find((m) => m.name === 'resident')?.loaded).toBe(true);
    expect(projected?.models.find((m) => m.name === 'installed')?.loaded).toBe(false);
  });

  it('keeps the native maximum and the configured context as two separate facts', () => {
    const projected = projectLocalModels(
      localSnapshot({
        ollama: {
          reachable: true,
          baseUrl: 'http://127.0.0.1:11434',
          models: [localModel({ id: 'q', nativeContextLength: 262_144, contextLength: 65_536 })],
          reason: null,
        },
      }),
    );
    const model = projected!.models[0]!;
    expect(model.nativeContext).toBe(262_144);
    expect(model.configuredContext).toBe(65_536);
  });

  it('reports no truncation when the runtime repeats the native context', () => {
    const projected = projectLocalModels(
      localSnapshot({
        ollama: {
          reachable: true,
          baseUrl: 'http://127.0.0.1:11434',
          models: [localModel({ id: 'q', nativeContextLength: 262_144, contextLength: 262_144 })],
          reason: null,
        },
      }),
    );
    expect(projected!.models[0]!.configuredContext).toBeNull();
    const view = buildLocalModelsView(projected, Date.now());
    expect(view?.rows[0]!.contextTruncated).toBe(false);
  });

  it('stays reachable when one runtime is down, and shows no reason beside a live list', () => {
    const projected = projectLocalModels(localSnapshot());
    expect(projected?.reachable).toBe(true);
    expect(projected?.reason).toBeNull();
  });

  it('surfaces a reason only when NOTHING is reachable', () => {
    const projected = projectLocalModels(
      localSnapshot({
        ollama: { reachable: false, baseUrl: 'http://127.0.0.1:11434', models: [], reason: 'ollama-unreachable' },
      }),
    );
    expect(projected?.reachable).toBe(false);
    expect(projected?.reason).toBe('ollama-unreachable');
  });

  it('still accepts a flat {reachable, models} body', () => {
    const projected = projectLocalModels({
      reachable: true,
      models: [{ name: 'a', loaded: true, size: 100, size_vram: 80 }],
      memoryBudgetBytes: 1000,
    });
    expect(projected?.models[0]!.sizeBytes).toBe(100);
    expect(projected?.models[0]!.sizeVramBytes).toBe(80);
    expect(projected?.models[0]!.runtime).toBeNull();
  });
});

describe('tool support — an empty capability list is not a denial', () => {
  it('prefers the runtime’s own supportsTools over the array', () => {
    expect(resolveToolSupport(true, [])).toBe('supported');
    expect(resolveToolSupport(false, ['completion', 'tools'])).toBe('unsupported');
  });

  it('reads an empty array as unknown, never as "cannot drive an agent"', () => {
    // The route sends `capabilities: []` when the runtime reported no list.
    // Treating that as "no tools" would wrongly gate a usable model out of
    // agentic work — a hard, visible, wrong answer.
    expect(resolveToolSupport(null, [])).toBe('unknown');
  });

  it('falls back to the array when the runtime gave no verdict', () => {
    expect(resolveToolSupport(null, ['completion', 'tools'])).toBe('supported');
    expect(resolveToolSupport(null, ['completion'])).toBe('unsupported');
    expect(resolveToolSupport(null, null)).toBe('unknown');
  });

  it('carries supportsTools through the projection', () => {
    const projected = projectLocalModels(
      localSnapshot({
        ollama: {
          reachable: true,
          baseUrl: 'http://127.0.0.1:11434',
          models: [localModel({ id: 'q', capabilities: [], supportsTools: null })],
          reason: null,
        },
      }),
    );
    const view = buildLocalModelsView(projected, Date.now());
    expect(view?.rows[0]!.tools).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Security backstop
// ---------------------------------------------------------------------------

describe('sanitizeCommand — the client-side backstop', () => {
  it('drops a native-profile launcher invocation', () => {
    expect(sanitizeCommand('node ~/.ashlr/native-profiles/grok-a/launcher.mjs')).toBeNull();
  });

  it('drops anything naming the private account store or a bearer token', () => {
    expect(sanitizeCommand('cat ~/.ashlr/account-connections/console-startup.json')).toBeNull();
    expect(sanitizeCommand('curl -H "Authorization: Bearer abc123" https://example.test')).toBeNull();
    expect(sanitizeCommand('some-cli --token abc123')).toBeNull();
  });

  it('refuses a smuggled second command on a new line', () => {
    expect(sanitizeCommand('ashlr resources\nrm -rf /')).toBeNull();
  });

  it('allows the safe command group', () => {
    expect(sanitizeCommand('ashlr resources login grok')).toBe('ashlr resources login grok');
  });
});

// ---------------------------------------------------------------------------
// V2.1 additions — staleness, the sentinel flag, machine memory, caveats
// ---------------------------------------------------------------------------

describe('a RETAINED runtime report is projected as retained, never as fresh', () => {
  it('carries stale and staleForMs through per runtime', () => {
    const projected = projectLocalModels(
      localSnapshot({
        ollama: {
          reachable: true,
          baseUrl: 'http://127.0.0.1:11434',
          models: [],
          reason: 'ollama-tags-timeout',
          stale: true,
          staleForMs: 12_000,
        },
      }),
    );
    const ollama = projected?.runtimes.find((r) => r.runtime === 'ollama');
    expect(ollama?.stale).toBe(true);
    expect(ollama?.staleForMs).toBe(12_000);
  });

  /**
   * A fresh report carrying a stray staleForMs must not age itself. The server
   * only writes the field alongside `stale: true`, and honouring it without
   * the flag would put "N seconds old" on a reading taken this instant.
   */
  it('ignores a staleForMs that arrives without the stale flag', () => {
    const projected = projectLocalModels(
      localSnapshot({
        ollama: {
          reachable: true,
          baseUrl: 'http://127.0.0.1:11434',
          models: [],
          reason: null,
          staleForMs: 9_000,
        },
      }),
    );
    const ollama = projected?.runtimes.find((r) => r.runtime === 'ollama');
    expect(ollama?.stale).toBe(false);
    expect(ollama?.staleForMs).toBeNull();
  });

  it('projects the machine free-memory figure as its own fact, beside the budget', () => {
    const projected = projectLocalModels(localSnapshot());
    expect(projected?.memoryBudgetBytes).toBe(128 * 1024 ** 3);
    expect(projected?.freeMemoryBytes).toBe(40 * 1024 ** 3);
  });

  it('reports no runtimes and no staleness for a flat legacy body, rather than inventing one', () => {
    const projected = projectLocalModels({ reachable: true, models: [], memoryBudgetBytes: 8 });
    expect(projected?.runtimes).toEqual([]);
    expect(projected?.freeMemoryBytes).toBeNull();
  });
});

describe("a window's `measured` flag survives the projection", () => {
  /**
   * Codex writes `rateLimitReachedType` as the value 100. The server marks it
   * `measured: false`; collapsing that back to "100% used" is the single
   * biggest misreading this surface can produce, so the flag is pinned here.
   */
  it('keeps measured:false on a flagged sentinel', () => {
    const projected = projectAccountsSnapshot(
      snapshot({
        accounts: [
          claudeRecord({
            id: 'codex-a',
            provider: 'codex',
            windows: [
              {
                id: 'codex',
                usedPercent: 100,
                resetsAt: null,
                nativeReport: null,
                limitReached: true,
                measured: false,
              },
            ],
          }),
        ],
      }),
    );
    const w = projected?.accounts[0]?.windows[0];
    expect(w?.limitReached).toBe(true);
    expect(w?.measured).toBe(false);
  });

  it('defaults an absent measured flag to false when the limit flag is set', () => {
    const projected = projectAccountsSnapshot({
      accounts: [{ id: 'x', provider: 'codex', windows: [{ id: 'codex', usedPercent: 100, limitReached: true }] }],
    });
    expect(projected?.accounts[0]?.windows[0]?.measured).toBe(false);
  });

  it('defaults an absent measured flag to true on an ordinary reading', () => {
    const projected = projectAccountsSnapshot({
      accounts: [{ id: 'x', provider: 'codex', windows: [{ id: 'codex', usedPercent: 40 }] }],
    });
    expect(projected?.accounts[0]?.windows[0]?.measured).toBe(true);
  });
});

describe('the usage-series wrapper carries its own disclosure', () => {
  it('keeps the server caveats verbatim and the estimated flag', () => {
    const projected = projectUsageSeries(
      {
        window: '30d',
        byDay: [],
        estimated: true,
        caveats: ['estCostUsd is estimated from a static price table, not a billed amount.'],
      },
      '7d',
    );
    expect(projected?.window).toBe('30d');
    expect(projected?.estimated).toBe(true);
    expect(projected?.caveats).toHaveLength(1);
  });

  /**
   * A server too old to say `estimated` is still estimating — every cost
   * column on this route comes from the static price table — so the
   * disclosure defaults ON. Defaulting it off would drop the caveat exactly
   * when the client is least sure what it is reading.
   */
  it('defaults estimated to true when the server did not say', () => {
    expect(projectUsageSeries({ window: '7d', byDay: [] }, '7d')?.estimated).toBe(true);
  });
});

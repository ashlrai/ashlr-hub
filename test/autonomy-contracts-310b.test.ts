/**
 * V3.10 Track B contract lock (unit B-U1, day 0). Every Track B unit and the
 * Track C surfaces build against these shapes in parallel, so this file pins
 * only what must stay true AFTER the owners replace the day-0 stubs:
 *   - the signed-grant key sets, signing / ledger domains, ceilings and
 *     patterns the TS verifier and the Swift custody helper share;
 *   - fail-closed answers with no grant installed (isolated HOME);
 *   - every Track B API module answers false for paths it does not own (the
 *     mount chain asks modules in order — one that claims or throws on a
 *     foreign path breaks every route after it);
 *   - browser safety of the contract files the web bundle imports.
 * (Tick-hook parity lives in tick-hooks-defaults-310b.test.ts: it mocks the
 * routers module-wide, which must not leak into the modules imported here.)
 *
 * Pure: no mocks, no disk writes (test/setup/home.ts isolates HOME regardless).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

import { canonicalizeDaemonActivationValue } from '../src/core/daemon/activation-permit.js';
import {
  AUTONOMY_SWITCH_RANK,
  BUDGET_MODE_RANK,
  LEDGER_EVENT_KINDS,
  LEDGER_GENESIS_PREV_HASH,
  LEDGER_HASH_DOMAIN,
  STANDING_GRANT_CEILINGS,
  STANDING_GRANT_KEYS,
  STANDING_GRANT_OPTIONAL_KEYS,
  STANDING_GRANT_PATTERNS,
  STANDING_GRANT_SIGNING_DOMAIN,
  VERSE_AUTHORITY_PATH,
  type StandingGrantV1,
} from '../src/core/authority/types.js';
import { GATE_ORDER, VERSE_FLEET_LIVE_PATH, VERSE_OVERNIGHT_PATH } from '../src/core/fleet/fleet-types.js';
import { VERSE_LEADER_PATH } from '../src/core/vision/leader-types.js';
import { HARNESS_ADOPTION_GATE, VERSE_LEARNING_PATH } from '../src/core/learn/harness-types.js';
import { currentStandingPolicy } from '../src/core/authority/effective-config.js';
import { openStandingSession } from '../src/core/authority/capability.js';
import { handleAuthorityApi } from '../src/core/verse/authority-api.js';
import { handleOvernightApi } from '../src/core/verse/overnight-api.js';
import { handleFleetLiveApi } from '../src/core/verse/fleet-live-api.js';
import { handleLeaderApi } from '../src/core/verse/leader-api.js';
import { handleLearningApi } from '../src/core/verse/learning-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

/** A representative grant: the default first grant's shape (addendum §11), two ladder stages. */
function sampleGrant(): StandingGrantV1 {
  return {
    v: 1,
    grantId: '0123456789abcdef0123456789abcdef',
    grantSeq: 1,
    keyId: 'mason-se-2026-09',
    issuedAt: '2026-09-24T12:00:00.000Z',
    expiresAt: '2026-10-24T12:00:00.000Z',
    hostBinding: 'a'.repeat(64),
    authoritySurfaceDigest: 'b'.repeat(64),
    repos: [
      { nameWithOwner: 'ashlrai/fleet-canary', stage: 'merge', enforcement: 'server', maxRisk: 'low', maxMergesPerDay: 6 },
      { nameWithOwner: 'ashlrai/measurably', stage: 'merge', enforcement: 'local', maxRisk: 'low', maxMergesPerDay: 4 },
    ],
    merge: { maxFiles: 10, maxLines: 300, selfRepo: 'merge-non-authority' },
    spend: {
      maxMode: 'balanced',
      meteredUsdPerDay: 0,
      seats: {
        'claude-a': { enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['judge', 'leader'] },
        'grok-a': { enabled: true, reserveFloorPercent: 0, roles: ['producer', 'judge', 'leader'] },
      },
    },
    engines: ['local', 'grok-cli', 'claude-cli', 'codex'],
    leader: { classes: ['A', 'B'], vetoMinutes: 30 },
    conductorGoals: true,
    rollout: {
      autoAdvance: true,
      stages: [
        {
          id: 'shadow',
          repos: [{ nameWithOwner: 'ashlrai/fleet-canary', stage: 'propose' }],
          engines: ['local', 'grok-cli'],
          maxRisk: 'low',
          maxFiles: 4,
          maxLines: 150,
          maxMergesPerRepoPerDay: 0,
          leaderClasses: [],
          criteria: {
            minMerges: 5,
            minPostMergeGreenPct: 0,
            maxRevertRatePct: 0,
            minHours: 12,
            maxSandboxViolations: 0,
            reserveBreaches: 0,
          },
        },
        {
          id: '2a',
          repos: [{ nameWithOwner: 'ashlrai/fleet-canary', stage: 'merge' }],
          engines: ['local', 'grok-cli'],
          maxRisk: 'low',
          maxFiles: 4,
          maxLines: 150,
          maxMergesPerRepoPerDay: 6,
          leaderClasses: ['A'],
          criteria: {
            minMerges: 3,
            minPostMergeGreenPct: 100,
            maxRevertRatePct: 10,
            minHours: 8,
            maxSandboxViolations: 0,
            reserveBreaches: 0,
          },
        },
      ],
    },
  };
}

const sorted = (keys: readonly string[]): string[] => [...keys].sort();

describe('standing grant — shared verifier / custody-helper contract', () => {
  it('names every key at every level exactly (the sample grant is the full shape)', () => {
    const grant = sampleGrant();
    expect(sorted(Object.keys(grant))).toEqual(sorted(STANDING_GRANT_KEYS.grant));
    for (const repo of grant.repos) expect(sorted(Object.keys(repo))).toEqual(sorted(STANDING_GRANT_KEYS.repo));
    expect(sorted(Object.keys(grant.merge))).toEqual(sorted(STANDING_GRANT_KEYS.merge));
    expect(sorted(Object.keys(grant.spend))).toEqual(sorted(STANDING_GRANT_KEYS.spend));
    expect(sorted(Object.keys(grant.leader))).toEqual(sorted(STANDING_GRANT_KEYS.leader));
    expect(sorted(Object.keys(grant.rollout))).toEqual(sorted(STANDING_GRANT_KEYS.rollout));
    for (const stage of grant.rollout.stages) {
      expect(sorted(Object.keys(stage))).toEqual(sorted(STANDING_GRANT_KEYS.stage));
      expect(sorted(Object.keys(stage.criteria))).toEqual(sorted(STANDING_GRANT_KEYS.criteria));
      for (const repo of stage.repos) expect(sorted(Object.keys(repo))).toEqual(sorted(STANDING_GRANT_KEYS.stageRepo));
    }
    const required = STANDING_GRANT_KEYS.seat.filter(
      (key) => !(STANDING_GRANT_OPTIONAL_KEYS.seat as readonly string[]).includes(key),
    );
    for (const seat of Object.values(grant.spend.seats)) {
      for (const key of required) expect(Object.keys(seat)).toContain(key);
      for (const key of Object.keys(seat)) expect(STANDING_GRANT_KEYS.seat).toContain(key);
    }
    expect(sorted(STANDING_GRANT_KEYS.envelope)).toEqual(['payload', 'signature']);
  });

  it('every string in a grant matches its pattern and every number is a non-negative integer', () => {
    const grant = sampleGrant();
    const p = STANDING_GRANT_PATTERNS;
    expect(grant.grantId).toMatch(p.grantId);
    expect(grant.keyId).toMatch(p.keyId);
    expect(grant.hostBinding).toMatch(p.sha256Hex);
    expect(grant.authoritySurfaceDigest).toMatch(p.sha256Hex);
    expect(grant.issuedAt).toMatch(p.isoInstant);
    expect(new Date(grant.issuedAt).toISOString()).toBe(grant.issuedAt);
    for (const repo of grant.repos) expect(repo.nameWithOwner).toMatch(p.nameWithOwner);
    for (const stage of grant.rollout.stages) expect(stage.id).toMatch(p.stageId);
    for (const seatId of Object.keys(grant.spend.seats)) expect(seatId).toMatch(p.seatId);
    const numbers: number[] = [];
    JSON.stringify(grant, (_key, value: unknown) => {
      if (typeof value === 'number') numbers.push(value);
      return value;
    });
    for (const n of numbers) expect(Number.isSafeInteger(n) && n >= 0).toBe(true);
  });

  it('signatures are base64 of exactly 64 bytes (IEEE-P1363 r‖s)', () => {
    expect(Buffer.alloc(64, 7).toString('base64')).toMatch(STANDING_GRANT_PATTERNS.signature);
    expect(Buffer.alloc(65, 7).toString('base64')).not.toMatch(STANDING_GRANT_PATTERNS.signature);
    expect(Buffer.alloc(72, 7).toString('base64')).not.toMatch(STANDING_GRANT_PATTERNS.signature);
  });

  it('canonical bytes: sorted keys, no whitespace, "/" not escaped, lossless', () => {
    const grant = sampleGrant();
    const canonical = canonicalizeDaemonActivationValue(grant);
    expect(canonical).toContain('"nameWithOwner":"ashlrai/fleet-canary"');
    expect(canonical).not.toContain('\\/');
    expect(canonical).not.toMatch(/\s/);
    expect(canonical.startsWith('{"authoritySurfaceDigest":')).toBe(true);
    expect(JSON.parse(canonical)).toEqual(grant);
  });

  it('pins the signing domain, ceilings and domain separation from the ledger', () => {
    expect(STANDING_GRANT_SIGNING_DOMAIN).toBe('ashlr:standing-grant:v1\0');
    expect(LEDGER_HASH_DOMAIN).toBe('ashlr:authority-ledger:v1\0');
    expect(LEDGER_GENESIS_PREV_HASH).toMatch(/^0{64}$/);
    expect(STANDING_GRANT_CEILINGS.maxTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(STANDING_GRANT_CEILINGS.maxRisk).toBe('medium');
    expect([STANDING_GRANT_CEILINGS.maxFiles, STANDING_GRANT_CEILINGS.maxLines]).toEqual([10, 300]);
    expect(STANDING_GRANT_CEILINGS.maxMergesPerRepoPerDay).toBe(24);
    expect(STANDING_GRANT_CEILINGS.localAuthored).toEqual({ maxRisk: 'low', maxFiles: 4, maxLines: 150 });
    expect(STANDING_GRANT_CEILINGS.localEnforcement).toEqual({ maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 4 });
    expect(STANDING_GRANT_CEILINGS.minVetoMinutes).toBe(30);
    expect(Object.isFrozen(STANDING_GRANT_CEILINGS)).toBe(true);
  });

  it('orders switches and budget modes so "lowering" is well defined', () => {
    expect(AUTONOMY_SWITCH_RANK.off).toBeLessThan(AUTONOMY_SWITCH_RANK.propose);
    expect(AUTONOMY_SWITCH_RANK.propose).toBeLessThan(AUTONOMY_SWITCH_RANK.autonomous);
    expect(BUDGET_MODE_RANK.reserve).toBeLessThan(BUDGET_MODE_RANK.balanced);
    expect(BUDGET_MODE_RANK.balanced).toBeLessThan(BUDGET_MODE_RANK['all-in']);
  });
});

describe('ledger, gates and the adoption gate', () => {
  it('ledger kinds are unique and include every event the rollout evaluates', () => {
    expect(new Set(LEDGER_EVENT_KINDS).size).toBe(LEDGER_EVENT_KINDS.length);
    for (const kind of [
      'grant:accepted',
      'grant:paused',
      'grant:revoked',
      'rollout:advanced',
      'rollout:regressed',
      'merge:landed',
      'revert:landed',
      'post-merge:result',
      'gate:would-merge',
      'sandbox:violation',
      'reserve:breach',
      'leader:action',
      'harness:adopted',
    ] as const) {
      expect(LEDGER_EVENT_KINDS).toContain(kind);
    }
  });

  it('gates run in the specified order', () => {
    expect(GATE_ORDER).toEqual(['G0', 'G1', 'G1b', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);
  });

  it('pins the harness adoption gate', () => {
    expect(HARNESS_ADOPTION_GATE).toMatchObject({
      minPairs: 8,
      ciLevel: 0.95,
      minLiftCiLow: 0,
      maxCostIncreasePct: 20,
      canaryHours: 48,
      rollbackStandardErrors: 1,
    });
  });
});

describe('fail closed with no grant installed (isolated HOME)', () => {
  it('there is no standing policy', () => {
    expect(currentStandingPolicy()).toBeNull();
  });

  it('no standing session can be opened', () => {
    const result = openStandingSession({} as AshlrConfig);
    expect(result.ok).toBe(false);
  });
});

describe('Track B API modules keep the mount chain intact', () => {
  const modules: [string, ApiModule][] = [
    ['authority', handleAuthorityApi],
    ['overnight', handleOvernightApi],
    ['fleet-live', handleFleetLiveApi],
    ['leader', handleLeaderApi],
    ['learning', handleLearningApi],
  ];
  const ctx = { cfg: {}, token: 't', allowDispatch: false } as unknown as VerseApiContext;
  const req = {} as IncomingMessage;
  const res = {} as ServerResponse;
  // Paths owned by other families (Track A modules and each other).
  const foreign = ['/api/verse/budget', '/api/verse/health', '/api/verse/fleet/history', '/api/verse/activity'];

  for (const [name, handler] of modules) {
    it(`${name} answers false for paths it does not own`, async () => {
      for (const path of foreign) {
        await expect(handler(ctx, req, res, path, 'GET')).resolves.toBe(false);
      }
    });
  }

  it('route prefixes are distinct and none shadows Track A fleet history', () => {
    const prefixes = [VERSE_AUTHORITY_PATH, VERSE_OVERNIGHT_PATH, VERSE_FLEET_LIVE_PATH, VERSE_LEADER_PATH, VERSE_LEARNING_PATH];
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const prefix of prefixes) {
      expect(prefix.startsWith('/api/verse/')).toBe(true);
      expect('/api/verse/fleet/history' === prefix || '/api/verse/fleet/history'.startsWith(`${prefix}/`)).toBe(false);
    }
  });
});

describe('browser safety of the Track B contract files the web bundle imports', () => {
  const files = [
    'src/core/authority/types.ts',
    'src/core/fleet/fleet-types.ts',
    'src/core/vision/leader-types.ts',
    'src/core/learn/harness-types.ts',
  ];
  for (const rel of files) {
    it(`${rel} has no runtime imports or re-exports`, () => {
      const src = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
      const imports = src.split('\n').filter((line) => /^\s*import\s/.test(line));
      for (const line of imports) expect(line).toMatch(/^\s*import\s+type\s/);
      expect(src).not.toMatch(/^\s*export\s+(?!type\b)[^\n]*\bfrom\s/m);
      expect(src).not.toMatch(/\brequire\(|\bimport\(/);
    });
  }
});

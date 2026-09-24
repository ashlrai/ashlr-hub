/**
 * Shared fixtures for the V3.10 Track B authority tests (unit B-U1).
 *
 * A fresh P-256 key pair per test process stands in for the Secure Enclave
 * custody key: tests that need a TRUSTED root inject it by mocking
 * src/core/authority/trust-roots.js (production code has no hook that could
 * add a root). Nothing here touches the real ~/.ashlr — withTempHome()
 * relocates HOME for the duration of one test.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJson } from '../../src/core/authority/canonical-json.js';
import {
  STANDING_GRANT_SIGNING_DOMAIN,
  type RolloutStage,
  type SignedStandingGrantV1,
  type StandingGrantTrustRoot,
  type StandingGrantV1,
} from '../../src/core/authority/types.js';

export const TEST_HOST = 'a'.repeat(64);
export const TEST_SURFACE = 'b'.repeat(64);
export const OTHER_SURFACE = 'c'.repeat(64);

function p256(): { privateKey: KeyObject; publicKeyPem: string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

const primary = p256();
const stranger = p256();

/**
 * Compiled roots must carry the id DERIVED from their key (custody-client
 * keyIdForPublicKeyPem: `se-p256-` + 16 hex of sha256(SPKI DER)). Recomputed
 * here with node:crypto rather than imported, because several suites mock
 * custody-client.js and this helper must load under any of those mocks;
 * authority-standing-grant-310b pins the two derivations equal.
 */
export function derivedKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `se-p256-${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

export const TEST_KEY_ID = derivedKeyId(primary.publicKeyPem);

export const TEST_PRIVATE_KEY = primary.privateKey;
export const STRANGER_PRIVATE_KEY = stranger.privateKey;

export const TEST_ROOT: StandingGrantTrustRoot = Object.freeze({ keyId: TEST_KEY_ID, alg: 'ES256', publicKeyPem: primary.publicKeyPem });

export function ed25519RootPem(): string {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

/** ES256 (IEEE-P1363 r‖s, base64) over the canonical signing bytes — exactly what ashlr-custody produces. */
export function signGrant(payload: StandingGrantV1, key: KeyObject = TEST_PRIVATE_KEY): SignedStandingGrantV1 {
  const bytes = Buffer.from(STANDING_GRANT_SIGNING_DOMAIN + canonicalJson(payload), 'utf8');
  const signature = sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
  return { payload, signature };
}

const HOUR = 60 * 60 * 1000;

export function criteria(minMerges: number, minPostMergeGreenPct = 0, maxRevertRatePct = 0, minHours = 0): RolloutStage['criteria'] {
  return { minMerges, minPostMergeGreenPct, maxRevertRatePct, minHours, maxSandboxViolations: 0, reserveBreaches: 0 };
}

/**
 * A valid two-plus-stage grant: shadow (propose only), then `merge` stages.
 * Times are relative to `nowMs` so it is valid when the test runs.
 */
export function makeGrant(overrides: Partial<StandingGrantV1> = {}, nowMs = Date.now()): StandingGrantV1 {
  const base: StandingGrantV1 = {
    v: 1,
    grantId: '0123456789abcdef0123456789abcdef',
    grantSeq: 1,
    keyId: TEST_KEY_ID,
    issuedAt: new Date(nowMs - HOUR).toISOString(),
    expiresAt: new Date(nowMs + 20 * 24 * HOUR).toISOString(),
    hostBinding: TEST_HOST,
    authoritySurfaceDigest: TEST_SURFACE,
    repos: [
      { nameWithOwner: 'ashlrai/fleet-canary', stage: 'merge', enforcement: 'server', maxRisk: 'medium', maxMergesPerDay: 6 },
      { nameWithOwner: 'ashlrai/ashlrcode', stage: 'merge', enforcement: 'server', maxRisk: 'medium', maxMergesPerDay: 12 },
      { nameWithOwner: 'ashlrai/measurably', stage: 'merge', enforcement: 'local', maxRisk: 'low', maxMergesPerDay: 4 },
      { nameWithOwner: 'ashlrai/ashlr-hub', stage: 'merge', enforcement: 'server', maxRisk: 'medium', maxMergesPerDay: 12 },
    ],
    merge: { maxFiles: 10, maxLines: 300, selfRepo: 'merge-non-authority' },
    spend: {
      maxMode: 'balanced',
      meteredUsdPerDay: 0,
      seats: {
        claude: { enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['judge', 'leader'] },
        grok: { enabled: true, reserveFloorPercent: 0, roles: ['producer', 'judge', 'leader'] },
        local: { enabled: true, reserveFloorPercent: 0, roles: ['producer', 'leader'] },
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
          repos: [
            { nameWithOwner: 'ashlrai/fleet-canary', stage: 'propose' },
            { nameWithOwner: 'ashlrai/ashlrcode', stage: 'propose' },
          ],
          engines: ['local', 'grok-cli', 'claude-cli'],
          maxRisk: 'low',
          maxFiles: 4,
          maxLines: 150,
          maxMergesPerRepoPerDay: 0,
          leaderClasses: [],
          criteria: criteria(2, 0, 0, 0),
        },
        {
          id: '2a',
          repos: [
            { nameWithOwner: 'ashlrai/fleet-canary', stage: 'merge' },
            { nameWithOwner: 'ashlrai/ashlrcode', stage: 'merge' },
          ],
          engines: ['local', 'grok-cli', 'claude-cli'],
          maxRisk: 'low',
          maxFiles: 4,
          maxLines: 150,
          maxMergesPerRepoPerDay: 6,
          leaderClasses: ['A'],
          criteria: criteria(2, 100, 10, 0),
        },
        {
          id: 'full',
          repos: [
            { nameWithOwner: 'ashlrai/fleet-canary', stage: 'merge' },
            { nameWithOwner: 'ashlrai/ashlrcode', stage: 'merge' },
            { nameWithOwner: 'ashlrai/measurably', stage: 'merge' },
            { nameWithOwner: 'ashlrai/ashlr-hub', stage: 'merge' },
          ],
          engines: ['local', 'grok-cli', 'claude-cli', 'codex'],
          maxRisk: 'medium',
          maxFiles: 10,
          maxLines: 300,
          maxMergesPerRepoPerDay: 12,
          leaderClasses: ['A', 'B'],
          criteria: criteria(5, 95, 5, 24),
        },
      ],
    },
  };
  return { ...base, ...overrides };
}

/** Deep-clone and edit a grant (tests mutate freely). */
export function editGrant(grant: StandingGrantV1, edit: (g: StandingGrantV1) => void): StandingGrantV1 {
  const copy = structuredClone(grant);
  edit(copy);
  return copy;
}

/** Relocate HOME to a fresh private temp dir; returns the dir and a restore function. */
export function withTempHome(prefix = 'bu1-authority-'): { home: string; restore: () => void } {
  const saved = process.env['HOME'];
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  process.env['HOME'] = home;
  return {
    home,
    restore: () => {
      process.env['HOME'] = saved;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

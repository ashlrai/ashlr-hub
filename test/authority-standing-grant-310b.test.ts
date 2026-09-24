/**
 * V3.10 Track B unit B-U1 — standing-grant parsing and verification (pure).
 *
 * SPEC-310B §7 U1 key tests: a grant is rejected when older than 30 days,
 * on key drift, for an ed25519 key, on the wrong host, on a surface-digest
 * mismatch, when revoked, and on sequence rollback. Plus: every ceiling is
 * refused (not clamped), a rollout stage can only narrow the grant, and the
 * default / re-approval drafts are themselves valid grants.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/core/authority/canonical-json.js';
import {
  buildDefaultGrantPayload,
  buildReapprovalGrantPayload,
  describeGrantScope,
  DEFAULT_ROLLOUT_STAGES,
  LOCAL_SEAT_WILDCARD,
  parseSignedStandingGrant,
  parseStandingGrantPayload,
  standingGrantPayloadDigest,
  standingGrantSigningBytes,
  standingTrustRootKeys,
  verifyStandingGrant,
  type StandingGrantVerifyContext,
} from '../src/core/authority/standing-grant.js';
import { STANDING_GRANT_SIGNING_DOMAIN, type StandingGrantV1 } from '../src/core/authority/types.js';
import { keyIdForPublicKeyPem } from '../src/core/authority/custody-client.js';
import {
  derivedKeyId,
  ed25519RootPem,
  editGrant,
  makeGrant,
  OTHER_SURFACE,
  signGrant,
  STRANGER_PRIVATE_KEY,
  TEST_HOST,
  TEST_KEY_ID,
  TEST_ROOT,
  TEST_SURFACE,
} from './helpers/authority-310b.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function ctx(overrides: Partial<StandingGrantVerifyContext> = {}): StandingGrantVerifyContext {
  return {
    nowMs: NOW,
    hostBinding: TEST_HOST,
    surfaceDigest: TEST_SURFACE,
    minGrantSeq: 0,
    revokedGrantIds: new Set(),
    ...overrides,
  };
}

const grant = (overrides: Partial<StandingGrantV1> = {}): StandingGrantV1 => makeGrant(overrides, NOW);

function rejectCode(value: unknown, context = ctx(), roots = [TEST_ROOT]): string {
  const verdict = verifyStandingGrant(value, context, roots);
  return verdict.ok ? 'ok' : verdict.code;
}

describe('verifyStandingGrant — the ES256 happy path', () => {
  it('verifies a grant signed by a compiled P-256 root', () => {
    const verdict = verifyStandingGrant(signGrant(grant()), ctx(), [TEST_ROOT]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.envelopeDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('signs exactly domain ‖ canonicalJson(payload)', () => {
    const payload = grant();
    expect(standingGrantSigningBytes(payload).toString('utf8')).toBe(STANDING_GRANT_SIGNING_DOMAIN + canonicalJson(payload));
    expect(standingGrantPayloadDigest(payload)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('verifyStandingGrant — every rejection the spec lists', () => {
  it('rejects a lifetime over 30 days (as a schema violation, never clamped)', () => {
    const tooLong = grant({ expiresAt: new Date(Date.parse(grant().issuedAt) + 30 * DAY + 1).toISOString() });
    expect(rejectCode(signGrant(tooLong))).toBe('schema');
    const exactly30 = grant({ expiresAt: new Date(Date.parse(grant().issuedAt) + 30 * DAY).toISOString() });
    expect(rejectCode(signGrant(exactly30))).toBe('ok');
  });

  it('rejects an expired grant and one issued in the future', () => {
    const g = grant();
    expect(rejectCode(signGrant(g), ctx({ nowMs: Date.parse(g.expiresAt) }))).toBe('expired');
    const future = grant({ issuedAt: new Date(NOW + 10 * 60 * 1000).toISOString(), expiresAt: new Date(NOW + 5 * DAY).toISOString() });
    expect(rejectCode(signGrant(future))).toBe('not-yet-valid');
  });

  it('rejects key drift: a key id that is not a compiled root, or a different key under a trusted id', () => {
    expect(rejectCode(signGrant(grant({ keyId: 'someone-else' })))).toBe('key-not-trusted');
    expect(rejectCode(signGrant(grant(), STRANGER_PRIVATE_KEY))).toBe('bad-signature');
  });

  it('rejects a tampered payload and a malformed signature', () => {
    const signed = signGrant(grant());
    const tampered = { ...signed, payload: { ...signed.payload, conductorGoals: false } };
    expect(rejectCode(tampered)).toBe('bad-signature');
    const der = { ...signed, signature: sign('sha256', standingGrantSigningBytes(signed.payload), { key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }).toString('base64') };
    expect(rejectCode(der)).toBe('schema');
    expect(rejectCode({ ...signed, signature: signed.signature.replace(/==$/, '=A') })).toBe('schema');
  });

  it('refuses ed25519 (the burned key type) and the burned key id as roots — the whole root set fails', () => {
    const ed = { keyId: TEST_KEY_ID, alg: 'ES256' as const, publicKeyPem: ed25519RootPem() };
    expect(rejectCode(signGrant(grant()), ctx(), [ed])).toBe('invalid-trust-root-set');
    expect(rejectCode(signGrant(grant()), ctx(), [TEST_ROOT, { ...TEST_ROOT, keyId: 'mason-workstation' }])).toBe('invalid-trust-root-set');
    expect(rejectCode(signGrant(grant()), ctx(), [TEST_ROOT, TEST_ROOT])).toBe('invalid-trust-root-set');
    expect(standingTrustRootKeys([{ ...TEST_ROOT, alg: 'EdDSA' as unknown as 'ES256' }]).ok).toBe(false);
  });

  it('refuses a root whose id is not the one derived from its key (custody keyIdForPublicKeyPem)', () => {
    expect(TEST_KEY_ID).toBe(keyIdForPublicKeyPem(TEST_ROOT.publicKeyPem));
    expect(derivedKeyId(TEST_ROOT.publicKeyPem)).toBe(keyIdForPublicKeyPem(TEST_ROOT.publicKeyPem));
    expect(TEST_KEY_ID).toMatch(/^se-p256-[a-f0-9]{16}$/);
    const relabelled = { ...TEST_ROOT, keyId: 'se-p256-0000000000000000' };
    const verdict = standingTrustRootKeys([relabelled]);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining(`the key's id is "${TEST_KEY_ID}"`) });
    // …and one bad root fails the whole set, the valid one included.
    expect(rejectCode(signGrant(grant()), ctx(), [TEST_ROOT, { ...relabelled, publicKeyPem: generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString() }])).toBe('invalid-trust-root-set');
    expect(standingTrustRootKeys([TEST_ROOT]).ok).toBe(true);
  });

  it('refuses everything while no root is compiled in', () => {
    expect(rejectCode(signGrant(grant()), ctx(), [])).toBe('no-trust-roots');
  });

  it('rejects the wrong host and an unreadable host', () => {
    expect(rejectCode(signGrant(grant()), ctx({ hostBinding: 'd'.repeat(64) }))).toBe('host-mismatch');
    expect(rejectCode(signGrant(grant()), ctx({ hostBinding: null }))).toBe('host-unknown');
  });

  it('rejects an authority-surface digest mismatch (changed code) and unverifiable code', () => {
    expect(rejectCode(signGrant(grant()), ctx({ surfaceDigest: OTHER_SURFACE }))).toBe('surface-mismatch');
    const unverified = verifyStandingGrant(signGrant(grant()), ctx({ surfaceDigest: null, surfaceReason: 'no manifest' }), [TEST_ROOT]);
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) {
      expect(unverified.code).toBe('surface-unverified');
      expect(unverified.reason).toBe('no manifest');
    }
  });

  it('rejects a revoked grant and a sequence rollback', () => {
    const g = grant({ grantSeq: 3 });
    expect(rejectCode(signGrant(g), ctx({ revokedGrantIds: new Set([g.grantId]) }))).toBe('revoked');
    expect(rejectCode(signGrant(g), ctx({ minGrantSeq: 4 }))).toBe('sequence-rollback');
    expect(rejectCode(signGrant(g), ctx({ minGrantSeq: 3 }))).toBe('ok');
  });
});

describe('parseStandingGrantPayload — exact keys and ceilings', () => {
  const refused = (edit: (g: StandingGrantV1 & Record<string, unknown>) => void): boolean =>
    !parseStandingGrantPayload(editGrant(grant(), edit as (g: StandingGrantV1) => void)).ok;

  it('refuses an unknown or missing key at every level', () => {
    expect(refused((g) => { (g as Record<string, unknown>)['extra'] = 1; })).toBe(true);
    expect(refused((g) => { delete (g as Partial<StandingGrantV1>).conductorGoals; })).toBe(true);
    expect(refused((g) => { (g.repos[0] as unknown as Record<string, unknown>)['x'] = 1; })).toBe(true);
    expect(refused((g) => { (g.merge as unknown as Record<string, unknown>)['x'] = 1; })).toBe(true);
    expect(refused((g) => { (g.spend.seats['claude'] as unknown as Record<string, unknown>)['x'] = 1; })).toBe(true);
    expect(refused((g) => { (g.rollout.stages[0]!.criteria as unknown as Record<string, unknown>)['x'] = 1; })).toBe(true);
    expect(refused((g) => { (g.rollout.stages[0]!.repos[0] as unknown as Record<string, unknown>)['x'] = 1; })).toBe(true);
    expect(parseSignedStandingGrant({ ...signGrant(grant()), note: 'x' }).ok).toBe(false);
    // The one optional key may be absent.
    expect(refused((g) => { delete g.spend.seats['claude']!.maxSessionWindowPercent; })).toBe(false);
  });

  it('refuses values above the compiled ceilings instead of clamping them', () => {
    expect(refused((g) => { g.merge.maxFiles = 11; })).toBe(true);
    expect(refused((g) => { g.merge.maxLines = 301; })).toBe(true);
    expect(refused((g) => { g.repos[1]!.maxMergesPerDay = 25; })).toBe(true);
    expect(refused((g) => { (g.repos[1] as { maxRisk: string }).maxRisk = 'high'; })).toBe(true);
    expect(refused((g) => { g.repos[2]!.maxRisk = 'medium'; })).toBe(true); // local enforcement: low only
    expect(refused((g) => { g.repos[2]!.maxMergesPerDay = 5; })).toBe(true); // local enforcement: ≤ 4/day
    expect(refused((g) => { g.leader.vetoMinutes = 29; })).toBe(true);
    expect(refused((g) => { g.spend.meteredUsdPerDay = 10_001; })).toBe(true);
    expect(refused((g) => { g.spend.seats['claude']!.reserveFloorPercent = 101; })).toBe(true);
    expect(refused((g) => { g.leader.classes = ['A', 'C' as 'A']; })).toBe(true);
    expect(refused((g) => { g.rollout.stages[0]!.criteria.maxSandboxViolations = 1 as 0; })).toBe(true);
    expect(refused((g) => { g.rollout.stages[0]!.criteria.reserveBreaches = 1 as 0; })).toBe(true);
    expect(refused((g) => { (g.rollout as { autoAdvance: boolean }).autoAdvance = false; })).toBe(true);
    expect(refused((g) => { g.grantSeq = 0; })).toBe(true);
    expect(refused((g) => { g.grantSeq = 1.5; })).toBe(true);
  });

  it('a rollout stage can only narrow the grant', () => {
    expect(refused((g) => { g.rollout.stages[0]!.repos.push({ nameWithOwner: 'ashlrai/not-granted', stage: 'propose' }); })).toBe(true);
    expect(refused((g) => {
      g.repos[0]!.stage = 'propose';
      g.rollout.stages[1]!.repos[0]!.stage = 'merge';
    })).toBe(true);
    expect(refused((g) => { g.engines = ['local']; })).toBe(true); // stages name grok-cli / claude-cli
    expect(refused((g) => { g.leader.classes = []; })).toBe(true); // stage 2a grants class A
    expect(refused((g) => {
      g.merge.maxFiles = 3;
    })).toBe(true); // stage maxFiles 4 > grant 3
    expect(refused((g) => { g.rollout.stages[1]!.id = 'shadow'; })).toBe(true);
    expect(refused((g) => { g.rollout.stages = []; })).toBe(true);
  });

  it('refuses duplicate repos (GitHub names are case-insensitive) and malformed strings', () => {
    expect(refused((g) => { g.repos.push({ ...g.repos[0]!, nameWithOwner: 'AshlrAI/Fleet-Canary' }); })).toBe(true);
    expect(refused((g) => { g.grantId = 'ABC'; })).toBe(true);
    expect(refused((g) => { g.issuedAt = '2026-09-24T12:00:00Z'; })).toBe(true); // not toISOString's shape
    expect(refused((g) => { g.hostBinding = 'A'.repeat(64); })).toBe(true);
    expect(refused((g) => {
      const seats = g.spend.seats as Record<string, unknown>;
      seats['__proto__x'] = seats['claude'];
    })).toBe(true);
  });
});

describe('drafts', () => {
  const draftInput = {
    nowMs: NOW,
    grantId: 'f'.repeat(32),
    grantSeq: 7,
    keyId: TEST_KEY_ID,
    hostBinding: TEST_HOST,
    authoritySurfaceDigest: TEST_SURFACE,
    repos: [
      { nameWithOwner: 'ashlrai/ashlr-hub', visibility: 'public' as const, hasVerify: true },
      { nameWithOwner: 'ashlrai/ashlrcode', visibility: null, hasVerify: true },
      { nameWithOwner: 'ashlrai/binshield', visibility: null, hasVerify: true },
      { nameWithOwner: 'ashlrai/ashlr-pulse', visibility: null, hasVerify: false },
      { nameWithOwner: 'ashlrai/measurably', visibility: 'private' as const, hasVerify: true },
      { nameWithOwner: 'ashlrai/fleet-canary', visibility: 'public' as const, hasVerify: true },
      { nameWithOwner: 'someone/unplanned', visibility: null, hasVerify: true },
    ],
    seats: [
      { seatId: 'claude', engine: 'claude' as const },
      { seatId: 'grok', engine: 'grok' as const },
      { seatId: 'codex-personal', engine: 'codex' as const },
      { seatId: 'local:qwen3', engine: 'local' as const },
    ],
  };

  it('the default ladder is a valid grant that starts in shadow and climbs 2a → 2b → 2c → phase 3', () => {
    const payload = buildDefaultGrantPayload(draftInput);
    expect(parseStandingGrantPayload(payload).ok).toBe(true);
    expect(payload.rollout.stages.map((s) => s.id)).toEqual(DEFAULT_ROLLOUT_STAGES.map((s) => s.id));
    expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(30 * DAY);
    const shadow = payload.rollout.stages[0]!;
    expect(shadow.repos.every((r) => r.stage === 'propose')).toBe(true);
    expect(shadow.leaderClasses).toEqual([]);
    expect(shadow.criteria).toMatchObject({ minMerges: 5, minHours: 12 });
    expect(payload.rollout.stages.find((s) => s.id === '2a')!.repos.filter((r) => r.stage === 'merge').map((r) => r.nameWithOwner).sort())
      .toEqual(['ashlrai/ashlrcode', 'ashlrai/fleet-canary']);
    expect(payload.rollout.stages.find((s) => s.id === '2c')!.leaderClasses).toEqual(['A']);
    expect(payload.spend).toMatchObject({ maxMode: 'balanced', meteredUsdPerDay: 0 });
    expect(payload.leader).toEqual({ classes: ['A', 'B'], vetoMinutes: 30 });
  });

  it('private repos get local enforcement at the local ceiling; repos needing a verify command stay propose-only', () => {
    const payload = buildDefaultGrantPayload(draftInput);
    const byName = new Map(payload.repos.map((r) => [r.nameWithOwner, r]));
    expect(byName.get('ashlrai/measurably')).toMatchObject({ enforcement: 'local', maxRisk: 'low', maxMergesPerDay: 4 });
    expect(byName.get('ashlrai/ashlr-pulse')!.stage).toBe('propose');
    expect(byName.get('someone/unplanned')).toMatchObject({ stage: 'propose' });
    const last = payload.rollout.stages[payload.rollout.stages.length - 1]!;
    expect(last.repos.find((r) => r.nameWithOwner === 'someone/unplanned')!.stage).toBe('propose');
    expect(last.repos.find((r) => r.nameWithOwner === 'ashlrai/ashlr-hub')!.stage).toBe('merge');
    expect(payload.merge.selfRepo).toBe('merge-non-authority');
  });

  it('seats follow the budget decisions: Claude 40% reserve and 70% session ceiling, one local wildcard', () => {
    const { seats } = buildDefaultGrantPayload(draftInput).spend;
    expect(seats['claude']).toEqual({ enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['judge', 'leader'] });
    expect(seats['grok']).toMatchObject({ reserveFloorPercent: 0 });
    expect(seats['codex-personal']).toMatchObject({ enabled: true, reserveFloorPercent: 40 });
    expect(seats[LOCAL_SEAT_WILDCARD]).toMatchObject({ reserveFloorPercent: 0 });
    expect(seats['local:qwen3']).toBeUndefined();
  });

  it('a re-approval continues at the current rung, with fresh ids, dates and bindings', () => {
    const current = buildDefaultGrantPayload(draftInput);
    const next = buildReapprovalGrantPayload(current, 2, { ...draftInput, nowMs: NOW + DAY, grantId: 'e'.repeat(32), grantSeq: 8, authoritySurfaceDigest: OTHER_SURFACE });
    expect(parseStandingGrantPayload(next).ok).toBe(true);
    expect(next.rollout.stages[0]!.id).toBe(current.rollout.stages[2]!.id);
    expect(next.rollout.stages).toHaveLength(current.rollout.stages.length - 2);
    expect(next).toMatchObject({ grantId: 'e'.repeat(32), grantSeq: 8, authoritySurfaceDigest: OTHER_SURFACE });
    expect(next.repos).toEqual(current.repos);
    expect(next.spend).toEqual(current.spend);
  });

  it('describes the scope in plain lines (the Touch ID sheet)', () => {
    const lines = describeGrantScope(buildDefaultGrantPayload(draftInput));
    expect(lines[0]).toMatch(/^Grant #7 /);
    expect(lines.some((l) => l.includes('seat claude: on, keep 40% for Mason, idle while 5 h > 70%'))).toBe(true);
    expect(lines.some((l) => l.includes('stage 1 shadow') && l.includes('propose only'))).toBe(true);
  });
});

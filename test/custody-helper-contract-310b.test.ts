/**
 * V3.10 Track B unit U2 — the TypeScript ↔ Swift custody contract.
 *
 * The helper (tools/custody) cannot import the TypeScript types, so it mirrors
 * them in GrantContract.swift. This file fails the moment either side drifts:
 *   - every constant, key set, pattern and enum in GrantContract.swift equals
 *     authority/types.ts (+ fleet/routing vocab);
 *   - the shared fixture's canonical bytes and digest are what the TypeScript
 *     canonicalizer produces, and its node- and Swift-made ES256 signatures
 *     verify here exactly as the grant verifier will verify them;
 *   - on macOS with the helper built, the REAL binary refuses non-grant
 *     payloads (these paths all stop before any key access or Touch ID).
 */
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/core/authority/canonical-json.js';
import { CUSTODY_DATA_DIR_RELATIVE, CUSTODY_HELPER_PATH, keyIdForPublicKeyPem } from '../src/core/authority/custody-client.js';
import {
  BUDGET_MODE_RANK,
  STANDING_GRANT_CEILINGS,
  STANDING_GRANT_KEYS,
  STANDING_GRANT_OPTIONAL_KEYS,
  STANDING_GRANT_PATTERNS,
  STANDING_GRANT_SIGNING_DOMAIN,
  type LeaderGrantClass,
  type SeatRole,
  type SelfRepoMode,
  type StandingGrantV1,
} from '../src/core/authority/types.js';
import { FLEET_ENGINES, MERGE_RISK_RANK, REPO_STAGE_RANK, type MergeRisk, type RepoEnforcement } from '../src/core/fleet/fleet-types.js';

const swiftPath = fileURLToPath(new URL('../tools/custody/Sources/CustodyCore/GrantContract.swift', import.meta.url));
const swift = readFileSync(swiftPath, 'utf8');

/** `public static let <name>` value, parsed from the one-declaration-per-line Swift file. */
function swiftConst(name: string): string {
  const m = new RegExp(`public static let ${name}(?:: \\w+)? = (.+)$`, 'm').exec(swift);
  if (!m) throw new Error(`GrantContract.swift has no ${name}`);
  return m[1]!.trim();
}
function swiftInt(name: string): number {
  return Number(swiftConst(name).replace(/_/g, ''));
}
function swiftString(name: string): string {
  const raw = swiftConst(name);
  const rawString = /^#"(.*)"#$/.exec(raw);
  if (rawString) return rawString[1]!;
  const plain = /^"(.*)"$/.exec(raw);
  if (!plain) throw new Error(`${name} is not a string literal`);
  return plain[1]!.replace(/\\u\{0\}/g, '\0');
}
function swiftList(name: string): string[] {
  const raw = swiftConst(name);
  const m = /^\[(.*)\]$/.exec(raw);
  if (!m) throw new Error(`${name} is not a list literal`);
  return [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
}

describe('GrantContract.swift mirrors authority/types.ts', () => {
  it('signing domain', () => {
    expect(swiftString('signingDomain')).toBe(STANDING_GRANT_SIGNING_DOMAIN);
  });

  it('ceilings', () => {
    const c = STANDING_GRANT_CEILINGS;
    expect(swiftInt('maxTtlMs')).toBe(c.maxTtlMs);
    expect(swiftString('maxRisk')).toBe(c.maxRisk);
    expect(swiftInt('maxFiles')).toBe(c.maxFiles);
    expect(swiftInt('maxLines')).toBe(c.maxLines);
    expect(swiftInt('maxMergesPerRepoPerDay')).toBe(c.maxMergesPerRepoPerDay);
    expect(swiftString('localAuthoredMaxRisk')).toBe(c.localAuthored.maxRisk);
    expect(swiftInt('localAuthoredMaxFiles')).toBe(c.localAuthored.maxFiles);
    expect(swiftInt('localAuthoredMaxLines')).toBe(c.localAuthored.maxLines);
    expect(swiftString('localEnforcementMaxRisk')).toBe(c.localEnforcement.maxRisk);
    expect(swiftInt('localEnforcementMaxFiles')).toBe(c.localEnforcement.maxFiles);
    expect(swiftInt('localEnforcementMaxLines')).toBe(c.localEnforcement.maxLines);
    expect(swiftInt('localEnforcementMaxMergesPerDay')).toBe(c.localEnforcement.maxMergesPerDay);
    expect(swiftInt('minVetoMinutes')).toBe(c.minVetoMinutes);
    expect(swiftInt('maxVetoMinutes')).toBe(c.maxVetoMinutes);
    expect(swiftInt('maxStageHours')).toBe(c.maxStageHours);
    expect(swiftInt('maxMeteredUsdPerDay')).toBe(c.maxMeteredUsdPerDay);
    expect(swiftInt('maxRepos')).toBe(c.maxRepos);
    expect(swiftInt('maxStages')).toBe(c.maxStages);
    expect(swiftInt('maxSeats')).toBe(c.maxSeats);
    expect(swiftInt('maxRolesPerSeat')).toBe(c.maxRolesPerSeat);
    expect(swiftInt('maxSafeInteger')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('patterns (identical regex sources)', () => {
    const p = STANDING_GRANT_PATTERNS;
    expect(swiftString('patternGrantId')).toBe(p.grantId.source);
    expect(swiftString('patternKeyId')).toBe(p.keyId.source);
    expect(swiftString('patternSha256Hex')).toBe(p.sha256Hex.source);
    expect(swiftString('patternIsoInstant')).toBe(p.isoInstant.source);
    expect(swiftString('patternNameWithOwner')).toBe(p.nameWithOwner.source);
    expect(swiftString('patternStageId')).toBe(p.stageId.source);
    expect(swiftString('patternSeatId')).toBe(p.seatId.source);
    expect(swiftString('patternSignature')).toBe(p.signature.source);
  });

  it('exact key sets per object level', () => {
    const k = STANDING_GRANT_KEYS;
    const pairs: [string, readonly string[]][] = [
      ['keysEnvelope', k.envelope], ['keysGrant', k.grant], ['keysRepo', k.repo], ['keysMerge', k.merge],
      ['keysSpend', k.spend], ['keysSeat', k.seat], ['keysLeader', k.leader], ['keysRollout', k.rollout],
      ['keysStage', k.stage], ['keysStageRepo', k.stageRepo], ['keysCriteria', k.criteria],
      ['optionalKeysSeat', STANDING_GRANT_OPTIONAL_KEYS.seat],
    ];
    for (const [name, ts] of pairs) expect([...swiftList(name)].sort(), name).toEqual([...ts].sort());
  });

  it('enum vocab', () => {
    expect(swiftList('fleetEngines')).toEqual([...FLEET_ENGINES]);
    expect(swiftList('repoStages').sort()).toEqual(Object.keys(REPO_STAGE_RANK).sort());
    expect(swiftList('budgetModes').sort()).toEqual(Object.keys(BUDGET_MODE_RANK).sort());
    // MERGE_RISK_RANK also ranks the never-mergeable 'high'.
    expect(swiftList('mergeRisks')).toEqual(Object.keys(MERGE_RISK_RANK).filter((r) => r !== 'high'));
    expect(swiftList('mergeRisks')).toEqual(['low', 'medium'] satisfies MergeRisk[]);
    expect(swiftList('repoEnforcements')).toEqual(['server', 'local'] satisfies RepoEnforcement[]);
    expect(swiftList('selfRepoModes')).toEqual(['propose-only', 'merge-non-authority'] satisfies SelfRepoMode[]);
    expect(swiftList('seatRoles')).toEqual(['producer', 'judge', 'leader'] satisfies SeatRole[]);
    expect(swiftList('leaderGrantClasses')).toEqual(['A', 'B'] satisfies LeaderGrantClass[]);
  });
});

describe('the helper and the client agree on where things live', () => {
  it('key data dir (denied to every autonomous sandbox)', () => {
    const signingKey = readFileSync(fileURLToPath(new URL('../tools/custody/Sources/ashlr-custody/SigningKey.swift', import.meta.url)), 'utf8');
    expect(signingKey).toContain(`"${CUSTODY_DATA_DIR_RELATIVE}"`);
  });

  it('install path', () => {
    const script = readFileSync(fileURLToPath(new URL('../scripts/install-custody.sh', import.meta.url)), 'utf8');
    expect(script).toContain(`readonly DEST_DIR=${CUSTODY_HELPER_PATH.slice(0, CUSTODY_HELPER_PATH.lastIndexOf('/'))}`);
    expect(script).toContain('readonly DEST="$DEST_DIR/ashlr-custody"');
  });
});

interface Fixture {
  payload: StandingGrantV1;
  canonical: string;
  digest: string;
  nodeSigned: { publicKeyPem: string; signature: string };
  swiftSigned: { publicKeyPem: string; signature: string; keyId: string };
}
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../tools/custody/Tests/CustodyCoreTests/Fixtures/standing-grant-fixture.json', import.meta.url)), 'utf8')) as Fixture;

describe('shared fixture — the bytes both languages sign', () => {
  it('canonical bytes and digest come from the TypeScript canonicalizer', () => {
    expect(canonicalJson(fixture.payload)).toBe(fixture.canonical);
    expect(createHash('sha256').update(fixture.canonical).digest('hex')).toBe(fixture.digest);
    expect(fixture.canonical).toContain('"nameWithOwner":"ashlrai/fleet-canary"');
  });

  it('node- and Swift-made ES256 signatures verify in IEEE-P1363 form', () => {
    const message = Buffer.from(`${STANDING_GRANT_SIGNING_DOMAIN}${fixture.canonical}`, 'utf8');
    for (const signed of [fixture.nodeSigned, fixture.swiftSigned]) {
      expect(signed.signature).toMatch(STANDING_GRANT_PATTERNS.signature);
      const key = createPublicKey(signed.publicKeyPem);
      expect(key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
      expect(verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signed.signature, 'base64'))).toBe(true);
      const tampered = Buffer.from(message.toString('utf8').replace('"grantSeq":1', '"grantSeq":2'), 'utf8');
      expect(verify('sha256', tampered, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signed.signature, 'base64'))).toBe(false);
    }
  });

  it('the Swift key id derivation matches the client', () => {
    expect(keyIdForPublicKeyPem(fixture.swiftSigned.publicKeyPem)).toBe(fixture.swiftSigned.keyId);
  });
});

const helper = fileURLToPath(new URL('../tools/custody/.build/release/ashlr-custody', import.meta.url));

describe.runIf(process.platform === 'darwin' && existsSync(helper))('the built helper refuses what it must (no key access, no Touch ID)', () => {
  const run = (args: string[], input?: string) => {
    const r = spawnSync(helper, args, { input: input ?? '', encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin' } });
    const last = (r.stderr ?? '').trim().split('\n').at(-1) ?? '';
    let error: { code?: string; message?: string } = {};
    try { error = (JSON.parse(last) as { error: typeof error }).error; } catch { /* success or usage */ }
    return { status: r.status, stdout: r.stdout ?? '', error };
  };
  const freshGrant = (): Record<string, unknown> => {
    const now = Date.now();
    return { ...fixture.payload, keyId: 'se-p256-0000000000000000', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString() };
  };

  it('prints its version', () => {
    const r = run(['version']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ v: 1, version: expect.any(String) });
  });

  it('refuses an envelope, arbitrary JSON and non-JSON as not a StandingGrantV1', () => {
    for (const input of [JSON.stringify({ payload: freshGrant(), signature: 'x' }), '{"sign":"these bytes"}', 'plain text', '']) {
      const r = run(['sign-grant', '-'], input);
      expect(r.status).toBe(3);
      expect(r.error.code).toBe('refused');
    }
  });

  it('refuses values above the compiled ceilings, naming the field', () => {
    const g = freshGrant();
    g['merge'] = { maxFiles: 11, maxLines: 300, selfRepo: 'merge-non-authority' };
    const r = run(['sign-grant', '-'], JSON.stringify(g));
    expect(r.status).toBe(3);
    expect(r.error.message).toContain('merge.maxFiles');
    const late = { ...freshGrant(), expiresAt: new Date(Date.now() + 31 * 86_400_000).toISOString() };
    expect(run(['sign-grant', '-'], JSON.stringify(late)).error.message).toContain('30 days');
  });

  it('a valid grant for a key this helper does not hold never reaches Touch ID', () => {
    const r = run(['sign-grant', '-'], JSON.stringify(freshGrant()));
    expect(r.status).not.toBe(0);
    expect(['key-missing', 'keyid-mismatch']).toContain(r.error.code);
  });

  it('install-custody.sh: the dry run changes nothing, and a real run insists on sudo', () => {
    const script = fileURLToPath(new URL('../scripts/install-custody.sh', import.meta.url));
    const dry = spawnSync('/bin/bash', [script, '--dry-run'], { encoding: 'utf8', timeout: 10_000 });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('nothing will change');
    expect(dry.stdout).toContain(CUSTODY_HELPER_PATH);
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const real = spawnSync('/bin/bash', [script], { encoding: 'utf8', timeout: 10_000 });
      expect(real.status).toBe(1);
      expect(real.stderr).toContain('run with sudo');
    }
    expect(spawnSync('/bin/bash', [script, '--bogus'], { encoding: 'utf8' }).status).toBe(2);
  });

  it('refuses malformed commands', () => {
    expect(run(['sign-bytes', '-']).status).toBe(2);
    expect(run(['gh-token', '--repo', 'not a repo']).error.code).toBe('refused');
    expect(run(['init', '--force']).status).toBe(2);
  });
});

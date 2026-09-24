/**
 * Standing grants — V3.10 Track B (unit B-U1).
 *
 * ONE Touch ID signs a StandingGrantV1 (types.ts) with a non-exportable Secure
 * Enclave key (tools/custody, unit U2). This module:
 *
 *   - parses a grant STRICTLY (exact key sets at every level, printable-ASCII
 *     strings matching STANDING_GRANT_PATTERNS, non-negative safe integers, and
 *     every value at or under STANDING_GRANT_CEILINGS — refused, never clamped,
 *     so what the helper shows in the Touch ID prompt is exactly what runs);
 *   - verifies it (`verifyStandingGrant`, PURE): ES256 over
 *     STANDING_GRANT_SIGNING_DOMAIN ‖ canonicalJson(payload) against a
 *     COMPILED trust root, ≤ 30-day lifetime, host binding, authority-surface
 *     digest, grantSeq ≥ minGrantSeq, not revoked;
 *   - drafts the grant the server asks Mason to sign (the addendum's default
 *     rollout ladder, or a re-approval that continues the current ladder);
 *   - stores the installed grant (grants are signed public data, not
 *     secrets — 0600 anyway) and records its acceptance in the ledger.
 *
 * Nothing here can raise authority on its own: without a valid signature from
 * a compiled root nothing verifies, and the compiled roots are empty until
 * Mason commits his custody key (trust-roots.ts).
 */
import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { BudgetEngine } from '../routing/policy.js';
import { BUDGET_MODES, type BudgetMode } from '../routing/types.js';
import { FLEET_ENGINES, MERGE_RISK_RANK, REPO_STAGE_RANK, type FleetEngine, type MergeRisk, type RepoEnforcement, type RepoStage } from '../fleet/fleet-types.js';
import { canonicalJson } from './canonical-json.js';
import { keyIdForPublicKeyPem } from './custody-client.js';
import {
  authorityDir,
  ensureAuthorityDir,
  readPrivateText,
  withLedgerTransaction,
  writePrivateAtomically,
  type LedgerSnapshot,
} from './ledger.js';
import { currentHostBinding, verifyAuthoritySurface, type SurfaceTarget } from './surface.js';
import { BURNED_KEY_IDS, STANDING_GRANT_TRUST_ROOTS } from './trust-roots.js';
import {
  STANDING_GRANT_CEILINGS,
  STANDING_GRANT_KEYS,
  STANDING_GRANT_OPTIONAL_KEYS,
  STANDING_GRANT_PATTERNS,
  STANDING_GRANT_SIGNING_DOMAIN,
  type LeaderGrantClass,
  type RolloutCriteria,
  type RolloutStage,
  type SeatRole,
  type SignedStandingGrantV1,
  type StandingGrantRepo,
  type StandingGrantSeat,
  type StandingGrantTrustRoot,
  type StandingGrantV1,
} from './types.js';

// ---------------------------------------------------------------------------
// Strict parsing
// ---------------------------------------------------------------------------

export type GrantParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const SEAT_ROLES: readonly SeatRole[] = ['producer', 'judge', 'leader'];
const LEADER_GRANT_CLASSES: readonly LeaderGrantClass[] = ['A', 'B'];
const SELF_REPO_MODES = ['propose-only', 'merge-non-authority'] as const;
const REPO_STAGES: readonly RepoStage[] = ['propose', 'merge'];
const ENFORCEMENTS: readonly RepoEnforcement[] = ['server', 'local'];
const MERGE_RISKS: readonly MergeRisk[] = ['low', 'medium'];

class GrantSchemaError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(reason: string): never {
  throw new GrantSchemaError(reason);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${where}: unknown key "${key.slice(0, 40)}"`);
  }
  for (const key of keys) {
    if (!optional.includes(key) && !Object.prototype.hasOwnProperty.call(value, key)) fail(`${where}: missing key "${key}"`);
  }
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${where} must be an object`);
  return value;
}

function intIn(value: unknown, min: number, max: number, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${where} must be a whole number from ${min} to ${max}`);
  }
  return value as number;
}

function matching(value: unknown, pattern: RegExp, where: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${where} is malformed`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(`${where} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function uniqueList<T extends string>(value: unknown, allowed: readonly T[], min: number, max: number, where: string): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${where} must list ${min}–${max} values`);
  const out: T[] = [];
  for (const entry of value) {
    const item = oneOf(entry, allowed, where);
    if (out.includes(item)) fail(`${where} lists "${item}" twice`);
    out.push(item);
  }
  return out;
}

function isoInstant(value: unknown, where: string): string {
  const text = matching(value, STANDING_GRANT_PATTERNS.isoInstant, where);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) fail(`${where} is not a real instant`);
  return text;
}

function parseRepo(value: unknown, i: number): StandingGrantRepo {
  const where = `repos[${i}]`;
  const repo = record(value, where);
  exactKeys(repo, STANDING_GRANT_KEYS.repo, [], where);
  const parsed: StandingGrantRepo = {
    nameWithOwner: matching(repo['nameWithOwner'], STANDING_GRANT_PATTERNS.nameWithOwner, `${where}.nameWithOwner`),
    stage: oneOf(repo['stage'], REPO_STAGES, `${where}.stage`),
    enforcement: oneOf(repo['enforcement'], ENFORCEMENTS, `${where}.enforcement`),
    maxRisk: oneOf(repo['maxRisk'], MERGE_RISKS, `${where}.maxRisk`),
    maxMergesPerDay: intIn(repo['maxMergesPerDay'], 0, STANDING_GRANT_CEILINGS.maxMergesPerRepoPerDay, `${where}.maxMergesPerDay`),
  };
  if (parsed.enforcement === 'local') {
    const ceiling = STANDING_GRANT_CEILINGS.localEnforcement;
    if (MERGE_RISK_RANK[parsed.maxRisk] > MERGE_RISK_RANK[ceiling.maxRisk]) fail(`${where}: a locally enforced repo may only merge ${ceiling.maxRisk}-risk work`);
    if (parsed.maxMergesPerDay > ceiling.maxMergesPerDay) fail(`${where}: a locally enforced repo may merge at most ${ceiling.maxMergesPerDay} times a day`);
  }
  return parsed;
}

function parseSeat(value: unknown, seatId: string): StandingGrantSeat {
  const where = `spend.seats["${seatId}"]`;
  const seat = record(value, where);
  exactKeys(seat, STANDING_GRANT_KEYS.seat, STANDING_GRANT_OPTIONAL_KEYS.seat, where);
  if (typeof seat['enabled'] !== 'boolean') fail(`${where}.enabled must be true or false`);
  const parsed: StandingGrantSeat = {
    enabled: seat['enabled'],
    reserveFloorPercent: intIn(seat['reserveFloorPercent'], 0, 100, `${where}.reserveFloorPercent`),
    roles: uniqueList(seat['roles'], SEAT_ROLES, 1, STANDING_GRANT_CEILINGS.maxRolesPerSeat, `${where}.roles`),
  };
  if (Object.prototype.hasOwnProperty.call(seat, 'maxSessionWindowPercent')) {
    parsed.maxSessionWindowPercent = intIn(seat['maxSessionWindowPercent'], 1, 100, `${where}.maxSessionWindowPercent`);
  }
  return parsed;
}

function parseCriteria(value: unknown, where: string): RolloutCriteria {
  const criteria = record(value, where);
  exactKeys(criteria, STANDING_GRANT_KEYS.criteria, [], where);
  if (criteria['maxSandboxViolations'] !== 0) fail(`${where}.maxSandboxViolations must be 0`);
  if (criteria['reserveBreaches'] !== 0) fail(`${where}.reserveBreaches must be 0`);
  return {
    minMerges: intIn(criteria['minMerges'], 0, 10_000, `${where}.minMerges`),
    minPostMergeGreenPct: intIn(criteria['minPostMergeGreenPct'], 0, 100, `${where}.minPostMergeGreenPct`),
    maxRevertRatePct: intIn(criteria['maxRevertRatePct'], 0, 100, `${where}.maxRevertRatePct`),
    minHours: intIn(criteria['minHours'], 0, STANDING_GRANT_CEILINGS.maxStageHours, `${where}.minHours`),
    maxSandboxViolations: 0,
    reserveBreaches: 0,
  };
}

function parseStage(
  value: unknown,
  i: number,
  grant: Pick<StandingGrantV1, 'repos' | 'engines' | 'merge' | 'leader'>,
): RolloutStage {
  const where = `rollout.stages[${i}]`;
  const stage = record(value, where);
  exactKeys(stage, STANDING_GRANT_KEYS.stage, [], where);
  const grantRepos = new Map(grant.repos.map((repo) => [repo.nameWithOwner, repo]));
  if (!Array.isArray(stage['repos']) || stage['repos'].length < 1 || stage['repos'].length > STANDING_GRANT_CEILINGS.maxRepos) {
    fail(`${where}.repos must list 1–${STANDING_GRANT_CEILINGS.maxRepos} repos`);
  }
  const repos = (stage['repos'] as unknown[]).map((entry, j) => {
    const repoWhere = `${where}.repos[${j}]`;
    const repo = record(entry, repoWhere);
    exactKeys(repo, STANDING_GRANT_KEYS.stageRepo, [], repoWhere);
    const nameWithOwner = matching(repo['nameWithOwner'], STANDING_GRANT_PATTERNS.nameWithOwner, `${repoWhere}.nameWithOwner`);
    const granted = grantRepos.get(nameWithOwner);
    if (!granted) fail(`${repoWhere}: ${nameWithOwner} is not one of the grant's repos`);
    const repoStage = oneOf(repo['stage'], REPO_STAGES, `${repoWhere}.stage`);
    if (REPO_STAGE_RANK[repoStage] > REPO_STAGE_RANK[granted.stage]) fail(`${repoWhere}: stage "${repoStage}" exceeds the grant's "${granted.stage}" for ${nameWithOwner}`);
    return { nameWithOwner, stage: repoStage };
  });
  const names = repos.map((repo) => repo.nameWithOwner);
  if (new Set(names).size !== names.length) fail(`${where}.repos lists a repo twice`);
  const engines = uniqueList(stage['engines'], FLEET_ENGINES, 1, FLEET_ENGINES.length, `${where}.engines`);
  for (const engine of engines) {
    if (!grant.engines.includes(engine)) fail(`${where}.engines: "${engine}" is not in the grant's engines`);
  }
  const maxRisk = oneOf(stage['maxRisk'], MERGE_RISKS, `${where}.maxRisk`);
  const leaderClasses = uniqueList(stage['leaderClasses'], LEADER_GRANT_CLASSES, 0, LEADER_GRANT_CLASSES.length, `${where}.leaderClasses`);
  for (const cls of leaderClasses) {
    if (!grant.leader.classes.includes(cls)) fail(`${where}.leaderClasses: class ${cls} is not granted to the Leader`);
  }
  return {
    id: matching(stage['id'], STANDING_GRANT_PATTERNS.stageId, `${where}.id`),
    repos,
    engines,
    maxRisk,
    maxFiles: intIn(stage['maxFiles'], 1, grant.merge.maxFiles, `${where}.maxFiles`),
    maxLines: intIn(stage['maxLines'], 1, grant.merge.maxLines, `${where}.maxLines`),
    maxMergesPerRepoPerDay: intIn(stage['maxMergesPerRepoPerDay'], 0, STANDING_GRANT_CEILINGS.maxMergesPerRepoPerDay, `${where}.maxMergesPerRepoPerDay`),
    leaderClasses,
    criteria: parseCriteria(stage['criteria'], `${where}.criteria`),
  };
}

function parsePayload(value: unknown): StandingGrantV1 {
  const grant = record(value, 'payload');
  exactKeys(grant, STANDING_GRANT_KEYS.grant, [], 'payload');
  if (grant['v'] !== 1) fail('payload.v must be 1');
  const issuedAt = isoInstant(grant['issuedAt'], 'issuedAt');
  const expiresAt = isoInstant(grant['expiresAt'], 'expiresAt');
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime <= 0) fail('expiresAt must be after issuedAt');
  if (lifetime > STANDING_GRANT_CEILINGS.maxTtlMs) fail('a standing grant may last at most 30 days');

  if (!Array.isArray(grant['repos']) || grant['repos'].length < 1 || grant['repos'].length > STANDING_GRANT_CEILINGS.maxRepos) {
    fail(`repos must list 1–${STANDING_GRANT_CEILINGS.maxRepos} repos`);
  }
  const repos = (grant['repos'] as unknown[]).map(parseRepo);
  const lowered = repos.map((repo) => repo.nameWithOwner.toLowerCase());
  if (new Set(lowered).size !== lowered.length) fail('repos lists a repo twice');

  const merge = record(grant['merge'], 'merge');
  exactKeys(merge, STANDING_GRANT_KEYS.merge, [], 'merge');
  const parsedMerge = {
    maxFiles: intIn(merge['maxFiles'], 1, STANDING_GRANT_CEILINGS.maxFiles, 'merge.maxFiles'),
    maxLines: intIn(merge['maxLines'], 1, STANDING_GRANT_CEILINGS.maxLines, 'merge.maxLines'),
    selfRepo: oneOf(merge['selfRepo'], SELF_REPO_MODES, 'merge.selfRepo'),
  };

  const spend = record(grant['spend'], 'spend');
  exactKeys(spend, STANDING_GRANT_KEYS.spend, [], 'spend');
  const seatsRaw = record(spend['seats'], 'spend.seats');
  const seatIds = Object.keys(seatsRaw);
  if (seatIds.length > STANDING_GRANT_CEILINGS.maxSeats) fail(`spend.seats may name at most ${STANDING_GRANT_CEILINGS.maxSeats} seats`);
  const seats: Record<string, StandingGrantSeat> = {};
  for (const seatId of seatIds) {
    matching(seatId, STANDING_GRANT_PATTERNS.seatId, `spend.seats key "${seatId.slice(0, 40)}"`);
    seats[seatId] = parseSeat(seatsRaw[seatId], seatId);
  }
  const parsedSpend = {
    maxMode: oneOf(spend['maxMode'], BUDGET_MODES, 'spend.maxMode') as BudgetMode,
    meteredUsdPerDay: intIn(spend['meteredUsdPerDay'], 0, STANDING_GRANT_CEILINGS.maxMeteredUsdPerDay, 'spend.meteredUsdPerDay'),
    seats,
  };

  const engines = uniqueList(grant['engines'], FLEET_ENGINES, 1, FLEET_ENGINES.length, 'engines');
  const leader = record(grant['leader'], 'leader');
  exactKeys(leader, STANDING_GRANT_KEYS.leader, [], 'leader');
  const parsedLeader = {
    classes: uniqueList(leader['classes'], LEADER_GRANT_CLASSES, 0, LEADER_GRANT_CLASSES.length, 'leader.classes'),
    vetoMinutes: intIn(leader['vetoMinutes'], STANDING_GRANT_CEILINGS.minVetoMinutes, STANDING_GRANT_CEILINGS.maxVetoMinutes, 'leader.vetoMinutes'),
  };
  if (typeof grant['conductorGoals'] !== 'boolean') fail('conductorGoals must be true or false');

  const rollout = record(grant['rollout'], 'rollout');
  exactKeys(rollout, STANDING_GRANT_KEYS.rollout, [], 'rollout');
  if (rollout['autoAdvance'] !== true) fail('rollout.autoAdvance must be true');
  if (!Array.isArray(rollout['stages']) || rollout['stages'].length < 1 || rollout['stages'].length > STANDING_GRANT_CEILINGS.maxStages) {
    fail(`rollout.stages must list 1–${STANDING_GRANT_CEILINGS.maxStages} stages`);
  }
  const scope = { repos, engines, merge: parsedMerge, leader: parsedLeader };
  const stages = (rollout['stages'] as unknown[]).map((stage, i) => parseStage(stage, i, scope));
  const stageIds = stages.map((stage) => stage.id);
  if (new Set(stageIds).size !== stageIds.length) fail('rollout stage ids must be unique');

  return {
    v: 1,
    grantId: matching(grant['grantId'], STANDING_GRANT_PATTERNS.grantId, 'grantId'),
    grantSeq: intIn(grant['grantSeq'], 1, Number.MAX_SAFE_INTEGER, 'grantSeq'),
    keyId: matching(grant['keyId'], STANDING_GRANT_PATTERNS.keyId, 'keyId'),
    issuedAt,
    expiresAt,
    hostBinding: matching(grant['hostBinding'], STANDING_GRANT_PATTERNS.sha256Hex, 'hostBinding'),
    authoritySurfaceDigest: matching(grant['authoritySurfaceDigest'], STANDING_GRANT_PATTERNS.sha256Hex, 'authoritySurfaceDigest'),
    repos,
    merge: parsedMerge,
    spend: parsedSpend,
    engines,
    leader: parsedLeader,
    conductorGoals: grant['conductorGoals'],
    rollout: { stages, autoAdvance: true },
  };
}

/** Strictly parse an unsigned grant payload (what the custody helper is asked to sign). */
export function parseStandingGrantPayload(value: unknown): GrantParseResult<StandingGrantV1> {
  try {
    return { ok: true, value: parsePayload(value) };
  } catch (error) {
    if (error instanceof GrantSchemaError) return { ok: false, reason: error.message };
    return { ok: false, reason: 'the grant could not be parsed' };
  }
}

/** Strictly parse a signed envelope `{payload, signature}`. */
export function parseSignedStandingGrant(value: unknown): GrantParseResult<SignedStandingGrantV1> {
  if (!isRecord(value)) return { ok: false, reason: 'the signed grant must be an object' };
  try {
    exactKeys(value, STANDING_GRANT_KEYS.envelope, [], 'envelope');
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const signature = value['signature'];
  if (typeof signature !== 'string' || !STANDING_GRANT_PATTERNS.signature.test(signature)) {
    return { ok: false, reason: 'signature must be base64 of a 64-byte ES256 (r‖s) signature' };
  }
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) {
    return { ok: false, reason: 'signature is not canonical base64 of 64 bytes' };
  }
  const payload = parseStandingGrantPayload(value['payload']);
  if (!payload.ok) return payload;
  return { ok: true, value: { payload: payload.value, signature } };
}

// ---------------------------------------------------------------------------
// Bytes and digests
// ---------------------------------------------------------------------------

/** The exact bytes the custody helper signs. */
export function standingGrantSigningBytes(payload: StandingGrantV1): Buffer {
  return Buffer.from(STANDING_GRANT_SIGNING_DOMAIN + canonicalJson(payload), 'utf8');
}

/** sha256 hex of the canonical payload — what a draft is identified by. */
export function standingGrantPayloadDigest(payload: StandingGrantV1): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/** sha256 hex of the canonical signed envelope. */
export function standingGrantEnvelopeDigest(envelope: SignedStandingGrantV1): string {
  return createHash('sha256').update(canonicalJson(envelope), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Verification (pure)
// ---------------------------------------------------------------------------

export type GrantRejectCode =
  | 'no-trust-roots'
  | 'invalid-trust-root-set'
  | 'schema'
  | 'key-not-trusted'
  | 'bad-signature'
  | 'not-yet-valid'
  | 'expired'
  | 'revoked'
  | 'sequence-rollback'
  | 'host-unknown'
  | 'host-mismatch'
  | 'surface-unverified'
  | 'surface-mismatch';

export interface StandingGrantVerifyContext {
  nowMs: number;
  /** This machine's binding; null = unreadable (never verifies). */
  hostBinding: string | null;
  /** The verified authority-surface digest of the code that would act; null = unverifiable. */
  surfaceDigest: string | null;
  /** Why `surfaceDigest` is null, for the rejection sentence. */
  surfaceReason?: string | null;
  /** From the ledger: revocations and every accepted grant raise it. */
  minGrantSeq: number;
  revokedGrantIds: ReadonlySet<string>;
}

export type StandingGrantVerification =
  | { ok: true; grant: StandingGrantV1; envelopeDigest: string }
  | { ok: false; code: GrantRejectCode; reason: string; grant: StandingGrantV1 | null };

/** A grant may be signed a little ahead of this machine's clock, never more. */
export const GRANT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Validate the compiled root set: ES256 / P-256 only, unique ids, no burned
 * key, and every id DERIVED from its key. A set with ANY bad root is refused
 * as a whole (fail closed and loud).
 *
 * WHY THE DERIVED ID (3.10 integration, U2's keyIdForPublicKeyPem): the
 * custody helper names its key `se-p256-<first 16 hex of sha256(SPKI DER)>`.
 * Requiring the compiled id to equal that derivation means a reviewer of the
 * trust-roots PR can recompute it from the PEM alone, and a root can never
 * carry a misleading label (e.g. the id of a different, familiar key).
 */
export function standingTrustRootKeys(
  roots: readonly StandingGrantTrustRoot[],
): { ok: true; keys: ReadonlyMap<string, KeyObject> } | { ok: false; reason: string } {
  const keys = new Map<string, KeyObject>();
  for (const root of roots) {
    if (!isRecord(root) || Object.keys(root).length !== 3 || root.alg !== 'ES256'
      || typeof root.keyId !== 'string' || !STANDING_GRANT_PATTERNS.keyId.test(root.keyId)
      || typeof root.publicKeyPem !== 'string') {
      return { ok: false, reason: 'a compiled trust root is malformed' };
    }
    if (BURNED_KEY_IDS.includes(root.keyId)) return { ok: false, reason: `trust root "${root.keyId}" is a burned key and can never be trusted` };
    if (keys.has(root.keyId)) return { ok: false, reason: `trust root "${root.keyId}" appears twice` };
    let key: KeyObject;
    try {
      key = createPublicKey(root.publicKeyPem);
    } catch {
      return { ok: false, reason: `trust root "${root.keyId}" is not a public key` };
    }
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      return { ok: false, reason: `trust root "${root.keyId}" is not a P-256 (ES256) key` };
    }
    let derived: string;
    try {
      derived = keyIdForPublicKeyPem(root.publicKeyPem);
    } catch {
      return { ok: false, reason: `trust root "${root.keyId}" is not a public key` };
    }
    if (derived !== root.keyId) {
      return { ok: false, reason: `trust root "${root.keyId}" does not match its key (the key's id is "${derived}")` };
    }
    keys.set(root.keyId, key);
  }
  return { ok: true, keys };
}

/**
 * PURE: is `value` a standing grant that may raise authority on this machine,
 * running this code, right now? Checks, in order: trust roots, exact schema
 * and ceilings, a trusted key, the ES256 signature, the validity window,
 * revocation, sequence rollback, the host binding and the surface digest.
 */
export function verifyStandingGrant(
  value: unknown,
  ctx: StandingGrantVerifyContext,
  roots: readonly StandingGrantTrustRoot[],
): StandingGrantVerification {
  if (roots.length === 0) {
    return { ok: false, code: 'no-trust-roots', reason: 'No custody key is compiled into this build yet (trust-roots.ts is empty), so no grant can verify.', grant: null };
  }
  const rootKeys = standingTrustRootKeys(roots);
  if (!rootKeys.ok) return { ok: false, code: 'invalid-trust-root-set', reason: rootKeys.reason, grant: null };
  const parsed = parseSignedStandingGrant(value);
  if (!parsed.ok) return { ok: false, code: 'schema', reason: `The grant is malformed: ${parsed.reason}.`, grant: null };
  const { payload: grant, signature } = parsed.value;
  const key = rootKeys.keys.get(grant.keyId);
  if (!key) {
    return { ok: false, code: 'key-not-trusted', reason: `The grant is signed by key "${grant.keyId}", which is not a compiled trust root.`, grant };
  }
  let signatureOk = false;
  try {
    signatureOk = verifySignature('sha256', standingGrantSigningBytes(grant), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, code: 'bad-signature', reason: 'The grant signature does not verify against its trust root.', grant };
  const issued = Date.parse(grant.issuedAt);
  const expires = Date.parse(grant.expiresAt);
  if (issued > ctx.nowMs + GRANT_MAX_FUTURE_SKEW_MS) {
    return { ok: false, code: 'not-yet-valid', reason: `The grant was issued in the future (${grant.issuedAt}); check this Mac's clock.`, grant };
  }
  if (ctx.nowMs >= expires) return { ok: false, code: 'expired', reason: `The grant expired at ${grant.expiresAt}.`, grant };
  if (ctx.revokedGrantIds.has(grant.grantId)) return { ok: false, code: 'revoked', reason: 'The grant was revoked.', grant };
  if (grant.grantSeq < ctx.minGrantSeq) {
    return {
      ok: false,
      code: 'sequence-rollback',
      reason: `The grant is #${grant.grantSeq} but grants below #${ctx.minGrantSeq} are no longer accepted (revoked or superseded).`,
      grant,
    };
  }
  if (!ctx.hostBinding) return { ok: false, code: 'host-unknown', reason: "This Mac's hardware identity could not be read, so no grant can be bound to it.", grant };
  if (grant.hostBinding !== ctx.hostBinding) return { ok: false, code: 'host-mismatch', reason: 'The grant was signed for a different Mac.', grant };
  if (!ctx.surfaceDigest) {
    return { ok: false, code: 'surface-unverified', reason: ctx.surfaceReason ?? 'The authority code of this release could not be verified.', grant };
  }
  if (grant.authoritySurfaceDigest !== ctx.surfaceDigest) {
    return { ok: false, code: 'surface-mismatch', reason: 'Authority code changed since this grant was signed — re-approve.', grant };
  }
  return { ok: true, grant, envelopeDigest: standingGrantEnvelopeDigest(parsed.value) };
}

// ---------------------------------------------------------------------------
// Drafts — what the server asks Mason to sign
// ---------------------------------------------------------------------------

export interface DraftRepoInput {
  nameWithOwner: string;
  /** Private repos on the free plan cannot get server-side protection → local enforcement. null = unknown (treated as public). */
  visibility: 'public' | 'private' | null;
  /** The checkout has a verify command (tests); null = unknown. */
  hasVerify: boolean | null;
}

export interface DraftSeatInput {
  seatId: string;
  engine: BudgetEngine;
}

export interface GrantDraftInput {
  nowMs: number;
  grantId: string;
  grantSeq: number;
  keyId: string;
  hostBinding: string;
  authoritySurfaceDigest: string;
  repos: readonly DraftRepoInput[];
  seats: readonly DraftSeatInput[];
}

/** ashlr-hub's own repo (package.json repository) — the grant's `merge.selfRepo` rule applies to it. */
export const SELF_REPO_NAME_WITH_OWNER = 'ashlrai/ashlr-hub';

/** The fleet's drill repo (addendum §7) — created by `ashlr authority setup`. */
export const FLEET_CANARY_REPO = 'ashlrai/fleet-canary';

interface PlannedRepo {
  /** Stage id the repo first appears in (as propose). */
  enter: string;
  /** Stage id from which it may merge. */
  mergeFrom: string;
  /** Highest risk the grant allows for it (stages cap it further). */
  risk: MergeRisk;
  /** Stays propose-only until the repo has a verify command. */
  needsVerify?: boolean;
  /** Max merges per day for this repo (server enforcement). */
  perDay: number;
}

/**
 * SPEC-310B §8 as a ladder (addendum §1): shadow → 2a → 2b → 2c, then phase 3
 * one repo (group) at a time in the spec's order, ashlr-hub last as
 * merge-non-authority. Keyed by the repo's NAME so a fork or a renamed owner
 * still lands on the right rung.
 */
const DEFAULT_REPO_PLAN: Readonly<Record<string, PlannedRepo>> = Object.freeze({
  ashlrcode: { enter: 'shadow', mergeFrom: '2a', risk: 'medium', perDay: 12 },
  binshield: { enter: 'shadow', mergeFrom: '2b', risk: 'medium', perDay: 12 },
  'fleet-canary': { enter: 'shadow', mergeFrom: '2a', risk: 'medium', perDay: 6 },
  'ashlr-plugin': { enter: '3a', mergeFrom: '3a', risk: 'medium', perDay: 12 },
  'ashlr-pulse': { enter: '3b', mergeFrom: '3b', risk: 'medium', needsVerify: true, perDay: 12 },
  locus: { enter: '3c', mergeFrom: '3c', risk: 'low', perDay: 12 },
  'phantom-secrets': { enter: '3c', mergeFrom: '3c', risk: 'low', perDay: 12 },
  measurably: { enter: '3d', mergeFrom: '3d', risk: 'low', perDay: 4 },
  'ashlr-cortex': { enter: '3d', mergeFrom: '3d', risk: 'low', needsVerify: true, perDay: 4 },
  'ashlr-hub': { enter: '3d', mergeFrom: '3d', risk: 'medium', perDay: 12 },
});

interface PlannedStage {
  id: string;
  engines: FleetEngine[];
  maxRisk: MergeRisk;
  maxFiles: number;
  maxLines: number;
  maxMergesPerRepoPerDay: number;
  leaderClasses: LeaderGrantClass[];
  criteria: RolloutCriteria;
}

const criteria = (minMerges: number, minPostMergeGreenPct: number, maxRevertRatePct: number, minHours: number): RolloutCriteria =>
  ({ minMerges, minPostMergeGreenPct, maxRevertRatePct, minHours, maxSandboxViolations: 0, reserveBreaches: 0 });

const PHASE2_ENGINES: FleetEngine[] = ['local', 'grok-cli', 'claude-cli'];
const PHASE3_ENGINES: FleetEngine[] = ['local', 'grok-cli', 'claude-cli', 'codex'];

/**
 * Stage parameters. Shadow proposes only (5 complete would-merge digests,
 * 12 h). 2a–2c: low risk, 4 files / 150 lines, ≤ 6 merges per repo per day;
 * 2a needs every post-merge watch green, 2b/2c tolerate ≤ 10% reverts; the
 * Leader's class A turns on at 2c. Phase 3: medium risk at the 10 / 300 cap,
 * class B on, one repo group per ≥ 24 h while reverts stay ≤ 5%.
 */
export const DEFAULT_ROLLOUT_STAGES: readonly Readonly<PlannedStage>[] = Object.freeze([
  { id: 'shadow', engines: PHASE2_ENGINES, maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerRepoPerDay: 0, leaderClasses: [], criteria: criteria(5, 0, 0, 12) },
  { id: '2a', engines: PHASE2_ENGINES, maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerRepoPerDay: 6, leaderClasses: [], criteria: criteria(3, 100, 0, 8) },
  { id: '2b', engines: PHASE2_ENGINES, maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerRepoPerDay: 6, leaderClasses: [], criteria: criteria(10, 90, 10, 24) },
  { id: '2c', engines: PHASE2_ENGINES, maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerRepoPerDay: 6, leaderClasses: ['A'], criteria: criteria(25, 95, 10, 48) },
  { id: '3a', engines: PHASE3_ENGINES, maxRisk: 'medium', maxFiles: 10, maxLines: 300, maxMergesPerRepoPerDay: 12, leaderClasses: ['A', 'B'], criteria: criteria(5, 95, 5, 24) },
  { id: '3b', engines: PHASE3_ENGINES, maxRisk: 'medium', maxFiles: 10, maxLines: 300, maxMergesPerRepoPerDay: 12, leaderClasses: ['A', 'B'], criteria: criteria(5, 95, 5, 24) },
  { id: '3c', engines: PHASE3_ENGINES, maxRisk: 'medium', maxFiles: 10, maxLines: 300, maxMergesPerRepoPerDay: 12, leaderClasses: ['A', 'B'], criteria: criteria(5, 95, 5, 24) },
  { id: '3d', engines: PHASE3_ENGINES, maxRisk: 'medium', maxFiles: 10, maxLines: 300, maxMergesPerRepoPerDay: 12, leaderClasses: ['A', 'B'], criteria: criteria(10, 95, 5, 24) },
]);

const STAGE_ORDER = DEFAULT_ROLLOUT_STAGES.map((stage) => stage.id);

function repoName(nameWithOwner: string): string {
  return nameWithOwner.slice(nameWithOwner.indexOf('/') + 1).toLowerCase();
}

/** Seat defaults by engine (addendum §11): Claude 40% weekly reserve and never while 5 h > 70%; Grok 0%; Codex like Claude; local unlimited. */
function defaultSeat(engine: BudgetEngine): StandingGrantSeat {
  switch (engine) {
    case 'claude':
      return { enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['judge', 'leader'] };
    case 'codex':
      return { enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['producer', 'judge'] };
    case 'grok':
      return { enabled: true, reserveFloorPercent: 0, roles: ['producer', 'judge', 'leader'] };
    case 'local':
      return { enabled: true, reserveFloorPercent: 0, roles: ['producer', 'leader'] };
    default:
      return { enabled: false, reserveFloorPercent: 100, roles: ['producer'] };
  }
}

/**
 * The seat key that stands for EVERY local-runtime seat (`local`,
 * `local:<tag>`): local models are free and windowless, and their tags change
 * whenever Mason pulls a model, so naming each would silently strand new ones.
 * Paid seats are always named exactly.
 */
export const LOCAL_SEAT_WILDCARD = 'local';

/**
 * PURE: the default first grant (addendum §11): the §8 ladder over whichever
 * of the planned repos are enrolled, balanced budget, no metered spend, all
 * four engine families, Leader classes A and B with a 30-minute veto window.
 */
export function buildDefaultGrantPayload(input: GrantDraftInput): StandingGrantV1 {
  const issuedAt = new Date(input.nowMs).toISOString();
  const expiresAt = new Date(input.nowMs + STANDING_GRANT_CEILINGS.maxTtlMs).toISOString();
  const seen = new Set<string>();
  const planned: { repo: StandingGrantRepo; enter: number; mergeFrom: number }[] = [];
  for (const candidate of input.repos) {
    const key = candidate.nameWithOwner.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const plan = DEFAULT_REPO_PLAN[repoName(candidate.nameWithOwner)];
    const local = candidate.visibility === 'private';
    const canMerge = plan !== undefined && !(plan.needsVerify && candidate.hasVerify !== true);
    const risk: MergeRisk = local ? 'low' : plan?.risk ?? 'low';
    planned.push({
      repo: {
        nameWithOwner: candidate.nameWithOwner,
        stage: canMerge ? 'merge' : 'propose',
        enforcement: local ? 'local' : 'server',
        maxRisk: risk,
        maxMergesPerDay: Math.min(plan?.perDay ?? 4, local ? STANDING_GRANT_CEILINGS.localEnforcement.maxMergesPerDay : STANDING_GRANT_CEILINGS.maxMergesPerRepoPerDay),
      },
      // Unknown repos join at the last rung, propose-only.
      enter: plan ? STAGE_ORDER.indexOf(plan.enter) : STAGE_ORDER.length - 1,
      mergeFrom: plan ? STAGE_ORDER.indexOf(plan.mergeFrom) : Number.POSITIVE_INFINITY,
    });
  }
  if (planned.length === 0) throw new Error('no enrolled GitHub repos to grant');

  const seats: Record<string, StandingGrantSeat> = {};
  let sawLocal = false;
  for (const seat of input.seats) {
    if (seat.engine === 'local') {
      sawLocal = true;
      continue;
    }
    if (!STANDING_GRANT_PATTERNS.seatId.test(seat.seatId) || seats[seat.seatId]) continue;
    seats[seat.seatId] = defaultSeat(seat.engine);
  }
  if (sawLocal || Object.keys(seats).length === 0) seats[LOCAL_SEAT_WILDCARD] = defaultSeat('local');

  const stages: RolloutStage[] = [];
  DEFAULT_ROLLOUT_STAGES.forEach((stage, index) => {
    const repos = planned
      .filter((p) => p.enter <= index)
      .map((p) => ({ nameWithOwner: p.repo.nameWithOwner, stage: (p.repo.stage === 'merge' && p.mergeFrom <= index ? 'merge' : 'propose') as RepoStage }));
    if (repos.length === 0) return;
    stages.push({
      id: stage.id,
      repos,
      engines: [...stage.engines],
      maxRisk: stage.maxRisk,
      maxFiles: stage.maxFiles,
      maxLines: stage.maxLines,
      maxMergesPerRepoPerDay: stage.maxMergesPerRepoPerDay,
      leaderClasses: [...stage.leaderClasses],
      criteria: { ...stage.criteria },
    });
  });

  const payload: StandingGrantV1 = {
    v: 1,
    grantId: input.grantId,
    grantSeq: input.grantSeq,
    keyId: input.keyId,
    issuedAt,
    expiresAt,
    hostBinding: input.hostBinding,
    authoritySurfaceDigest: input.authoritySurfaceDigest,
    repos: planned.map((p) => p.repo),
    merge: { maxFiles: STANDING_GRANT_CEILINGS.maxFiles, maxLines: STANDING_GRANT_CEILINGS.maxLines, selfRepo: 'merge-non-authority' },
    spend: { maxMode: 'balanced', meteredUsdPerDay: 0, seats },
    engines: [...PHASE3_ENGINES],
    leader: { classes: ['A', 'B'], vetoMinutes: 30 },
    conductorGoals: true,
    rollout: { stages, autoAdvance: true },
  };
  const checked = parseStandingGrantPayload(payload);
  if (!checked.ok) throw new Error(`default grant draft is invalid: ${checked.reason}`);
  return checked.value;
}

/**
 * PURE: the grant that continues `current` after a pause, an expiry or a new
 * 30-day period. Same scope, fresh ids / dates / bindings, and its ladder
 * STARTS at the stage `current` had reached — a deploy does not restart the
 * ramp from shadow. The start rung is inside the signed payload (the first
 * stage), so the Touch ID prompt shows exactly where autonomy resumes.
 */
export function buildReapprovalGrantPayload(
  current: StandingGrantV1,
  currentStageIndex: number,
  input: Omit<GrantDraftInput, 'repos' | 'seats'>,
): StandingGrantV1 {
  const from = Math.max(0, Math.min(currentStageIndex, current.rollout.stages.length - 1));
  const payload: StandingGrantV1 = {
    ...structuredClone(current),
    grantId: input.grantId,
    grantSeq: input.grantSeq,
    keyId: input.keyId,
    issuedAt: new Date(input.nowMs).toISOString(),
    expiresAt: new Date(input.nowMs + STANDING_GRANT_CEILINGS.maxTtlMs).toISOString(),
    hostBinding: input.hostBinding,
    authoritySurfaceDigest: input.authoritySurfaceDigest,
    rollout: { stages: structuredClone(current.rollout.stages.slice(from)), autoAdvance: true },
  };
  const checked = parseStandingGrantPayload(payload);
  if (!checked.ok) throw new Error(`re-approval draft is invalid: ${checked.reason}`);
  return checked.value;
}

/** Plain-language lines describing a grant's scope (CLI confirmation, the Touch ID sheet, logs). */
export function describeGrantScope(grant: StandingGrantV1): string[] {
  const lines = [
    `Grant #${grant.grantSeq} (${grant.grantId.slice(0, 8)}), key ${grant.keyId}, valid ${grant.issuedAt} → ${grant.expiresAt}`,
    `Engines: ${grant.engines.join(', ')} · budget up to ${grant.spend.maxMode} · metered spend $${grant.spend.meteredUsdPerDay}/day`,
    `Merge caps: ${grant.merge.maxFiles} files / ${grant.merge.maxLines} lines · ashlr-hub: ${grant.merge.selfRepo}`,
    `Leader: class ${grant.leader.classes.length > 0 ? grant.leader.classes.join('+') : 'none'} · veto window ${grant.leader.vetoMinutes} min · conductors ${grant.conductorGoals ? 'live' : 'dry-run'}`,
  ];
  for (const repo of grant.repos) {
    lines.push(`  ${repo.nameWithOwner}: up to ${repo.stage}, ${repo.maxRisk} risk, ${repo.maxMergesPerDay}/day, ${repo.enforcement} enforcement`);
  }
  for (const [seatId, seat] of Object.entries(grant.spend.seats)) {
    lines.push(`  seat ${seatId}: ${seat.enabled ? 'on' : 'off'}, keep ${seat.reserveFloorPercent}% for Mason${seat.maxSessionWindowPercent !== undefined ? `, idle while 5 h > ${seat.maxSessionWindowPercent}%` : ''}, ${seat.roles.join('/')}`);
  }
  grant.rollout.stages.forEach((stage, i) => {
    const merging = stage.repos.filter((r) => r.stage === 'merge').map((r) => r.nameWithOwner.split('/')[1]);
    lines.push(`  stage ${i + 1} ${stage.id}: ${stage.repos.length} repos (${merging.length > 0 ? `merging ${merging.join(', ')}` : 'propose only'}), ${stage.maxRisk} risk ${stage.maxFiles}/${stage.maxLines}, ≥${stage.criteria.minHours} h to advance`);
  });
  return lines;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function installedGrantPath(): string {
  return join(authorityDir(), 'grant.json');
}

export function grantArchiveDir(): string {
  return join(authorityDir(), 'grants');
}

const MAX_GRANT_BYTES = 256 * 1024;

export type InstalledGrantRead =
  | { state: 'none' }
  | { state: 'invalid'; reason: string }
  | { state: 'ok'; envelope: SignedStandingGrantV1 };

/**
 * The installed signed grant, parsed strictly. It is NOT verified here — only
 * verifyStandingGrant decides whether it may act. The file must be exactly the
 * canonical encoding the installer wrote, so a hand edit is visible.
 */
export function readInstalledGrant(): InstalledGrantRead {
  const read = readPrivateText(installedGrantPath(), MAX_GRANT_BYTES);
  if (read.state === 'missing') return { state: 'none' };
  if (read.state === 'invalid') return { state: 'invalid', reason: 'The installed grant file is not a private file owned by you.' };
  let value: unknown;
  try {
    value = JSON.parse(read.text) as unknown;
  } catch {
    return { state: 'invalid', reason: 'The installed grant file is not valid JSON.' };
  }
  const parsed = parseSignedStandingGrant(value);
  if (!parsed.ok) return { state: 'invalid', reason: `The installed grant is malformed: ${parsed.reason}.` };
  if (`${canonicalJson(parsed.value)}\n` !== read.text) {
    return { state: 'invalid', reason: 'The installed grant file was edited by hand (it is not in canonical form).' };
  }
  return { state: 'ok', envelope: parsed.value };
}

/** Move the installed grant aside (revoke). Returns the archive name, or null when none was installed. */
export function archiveInstalledGrant(tag: 'revoked' | 'superseded'): string | null {
  const read = readInstalledGrant();
  if (read.state === 'none') return null;
  ensureAuthorityDir();
  mkdirSync(grantArchiveDir(), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = read.state === 'ok' ? read.envelope.payload.grantId : 'unreadable';
  const name = `${id}.${tag}-${stamp}.json`;
  renameSync(installedGrantPath(), join(grantArchiveDir(), name));
  return name;
}

export interface InstallGrantOptions {
  /** Which release the grant must match: the daemon's installed release when drafting from Verse / the CLI. */
  surface: SurfaceTarget;
  nowMs?: number;
  actor?: 'mason';
}

export type InstallGrantResult =
  | { ok: true; grant: StandingGrantV1; envelopeDigest: string; recovered: boolean; alreadyInstalled: boolean }
  | { ok: false; code: GrantRejectCode | 'ledger' | 'storage'; reason: string };

function verifyContextFrom(snapshot: LedgerSnapshot, nowMs: number, surface: SurfaceTarget): StandingGrantVerifyContext {
  const verified = verifyAuthoritySurface(surface, { fresh: true, nowMs });
  return {
    nowMs,
    hostBinding: currentHostBinding(),
    surfaceDigest: verified.ok ? verified.digest : null,
    surfaceReason: verified.ok ? null : verified.reason,
    minGrantSeq: snapshot.index.minGrantSeq,
    revokedGrantIds: snapshot.index.revokedGrantIds,
  };
}

/**
 * Install a freshly signed grant: verify it completely against the COMPILED
 * roots, record `grant:accepted`, then write grant.json — all under the
 * ledger lock. A new grant must be NEWER than every grant ever accepted
 * (strictly higher grantSeq), so an older signed grant can never be put back.
 * If the ledger chain is broken, the new signature is also the authorization
 * to archive the broken chain and start a fresh one (`ledger:recovered`).
 */
export function installStandingGrant(envelope: unknown, opts: InstallGrantOptions): InstallGrantResult {
  const nowMs = opts.nowMs ?? Date.now();
  const result = withLedgerTransaction((tx): InstallGrantResult => {
    const snapshot = tx.snapshot;
    // Verify everything except sequence first: never archive a broken ledger for a grant that is not valid anyway.
    const ctx = verifyContextFrom(snapshot, nowMs, opts.surface);
    const verdict = verifyStandingGrant(envelope, { ...ctx, minGrantSeq: 0, revokedGrantIds: snapshot.chain === 'broken' ? new Set() : ctx.revokedGrantIds }, STANDING_GRANT_TRUST_ROOTS);
    if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason };
    const grant = verdict.grant;
    let recovered = false;
    if (snapshot.chain === 'broken') {
      const floor = tx.brokenChainFloor();
      if (grant.grantSeq <= floor) {
        return { ok: false, code: 'sequence-rollback', reason: `The broken ledger had already reached grant #${floor}; sign a newer grant.` };
      }
      tx.recoverBrokenChain(`grant #${grant.grantSeq} signed to replace a broken ledger`);
      recovered = true;
    } else {
      const index = snapshot.index;
      const last = index.lastAccepted;
      const reinstallSame = last !== null && last.grantId === grant.grantId && last.envelopeDigest === verdict.envelopeDigest
        && !index.revokedGrantIds.has(grant.grantId) && grant.grantSeq >= index.minGrantSeq;
      if (reinstallSame) {
        writePrivateAtomically(installedGrantPath(), `${canonicalJson(envelope)}\n`);
        return { ok: true, grant, envelopeDigest: verdict.envelopeDigest, recovered: false, alreadyInstalled: true };
      }
      if (grant.grantSeq < index.minGrantSeq || index.revokedGrantIds.has(grant.grantId)) {
        return { ok: false, code: 'revoked', reason: `Grant #${grant.grantSeq} was revoked or superseded; sign a new one.` };
      }
      if (grant.grantSeq <= index.maxAcceptedGrantSeq) {
        return { ok: false, code: 'sequence-rollback', reason: `Grant #${grant.grantSeq} is not newer than the last accepted grant (#${index.maxAcceptedGrantSeq}).` };
      }
    }
    tx.append({
      kind: 'grant:accepted',
      actor: opts.actor ?? 'mason',
      grantId: grant.grantId,
      repo: null,
      data: {
        grantId: grant.grantId,
        grantSeq: grant.grantSeq,
        keyId: grant.keyId,
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        authoritySurfaceDigest: grant.authoritySurfaceDigest,
        stageIds: grant.rollout.stages.map((stage) => stage.id),
        envelopeDigest: verdict.envelopeDigest,
      },
    });
    // Keep the previous grant for the record, then install the new one.
    try {
      archiveInstalledGrant('superseded');
    } catch {
      // An unreadable old file is simply replaced below.
    }
    writePrivateAtomically(installedGrantPath(), `${canonicalJson(envelope)}\n`);
    try {
      mkdirSync(grantArchiveDir(), { recursive: true, mode: 0o700 });
      writePrivateAtomically(join(grantArchiveDir(), `${grant.grantId}.json`), `${canonicalJson(envelope)}\n`);
    } catch {
      // The archive copy is a convenience; the installed file and the ledger row are what count.
    }
    return { ok: true, grant, envelopeDigest: verdict.envelopeDigest, recovered, alreadyInstalled: false };
  });
  if (!result.ok) return { ok: false, code: 'ledger', reason: result.reason };
  return result.value;
}

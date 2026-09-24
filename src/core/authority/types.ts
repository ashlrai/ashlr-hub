/**
 * Standing authority — V3.10 Track B contract (unit B-U1, frozen day 0).
 *
 * ONE Touch ID signs a StandingGrantV1 with a non-exportable Secure Enclave
 * key (tools/custody, unit U2). The grant bounds everything autonomy may do
 * for ≤ 30 days — repos and their stage, merge caps, spend, engines, the
 * Leader's action classes — plus a signed ROLLOUT LADDER that the daemon
 * climbs by itself as evidence accrues and drops back down on a breach
 * (addendum §1). It can never climb past the last signed stage, and the
 * Leader can neither skip nor edit stages.
 *
 * Invariants these types serve (SPEC-310B §0):
 *  I1 Only a grant signed under Touch ID RAISES authority. Lowering it — Stop,
 *     revoke, switching down, moving the budget toward reserve — is instant
 *     and needs no auth.
 *  I2 Agents cannot read, write or invoke anything that signs, stores or
 *     widens authority, and changed authority code cannot run under an old
 *     grant (`authoritySurfaceDigest`).
 *  I3 Effective policy = min(grant, current rollout stage, config, compiled
 *     ceilings). Config and the Leader can only tighten it.
 *  I4 Every merge is remote, pinned to a SHA, checked server-side, attributed
 *     and reversible.
 *  I5 Mason's reserve is never spent.
 *
 * CANONICAL BYTES — the contract between the TS verifier (U1) and the Swift
 * helper (U2). A grant is signed over
 *   STANDING_GRANT_SIGNING_DOMAIN ‖ canonicalizeDaemonActivationValue(payload)
 * i.e. keys sorted by UTF-16 code unit, no whitespace, `undefined` keys
 * omitted, strings escaped exactly as JSON.stringify escapes them (so '/' is
 * NOT escaped — Swift's JSONEncoder escapes it, so the helper needs its own
 * canonicalizer). To make byte-identical output easy in both languages, every
 * number in a grant is a non-negative safe integer and every string is
 * printable ASCII matching STANDING_GRANT_PATTERNS (never '"' or '\\').
 *
 * Honesty rule: `null` = unknown.
 *
 * BROWSER-SAFE: the Command surface imports this — type-only imports and
 * plain constants, no node: modules. It is also a LEAF of the authority
 * surface: it imports nothing at runtime, so it never widens the authority
 * import closure.
 */
import type { BudgetMode } from '../routing/types.js';
import type {
  FleetActor,
  FleetEngine,
  FleetPrChange,
  FleetPrRecord,
  GateResult,
  LandingRecord,
  MergeRisk,
  PostMergeResult,
  RepoEnforcement,
  RepoHold,
  RepoHoldKind,
  RepoStage,
  ReserveBreachRecord,
  SandboxViolationRecord,
  WouldMergeRecord,
} from '../fleet/fleet-types.js';
import type {
  LeaderAction,
  LeaderActionClass,
  LeaderMemoRecord,
  LeaderOutcomeRecord,
  LeaderVetoRecord,
} from '../vision/leader-types.js';
import type { ExperimentResultV1, HarnessTransition, HarnessVersion } from '../learn/harness-types.js';

// The three day-0 record types SPEC-310BC-COORD §1 lists under "authority
// types" live with their domains (fleet / vision / learn) so each owning unit
// finds them next to its code; re-exported here so both import paths work.
export type { LandingRecord, LeaderAction, HarnessVersion };

// ---------------------------------------------------------------------------
// Small shared vocab
// ---------------------------------------------------------------------------

/**
 * - `off`        — nothing autonomous runs (dark), whatever the grant allows.
 * - `propose`    — the fleet runs and opens PRs; nothing merges; the Leader only proposes.
 * - `autonomous` — merges land where the grant and its current rollout stage allow.
 * Anyone may lower it; raising it is capped at the grant (raising past the
 * grant needs a new grant — Touch ID).
 */
export type AutonomySwitch = 'off' | 'propose' | 'autonomous';

export const AUTONOMY_SWITCHES: readonly AutonomySwitch[] = ['off', 'propose', 'autonomous'];

export const AUTONOMY_SWITCH_RANK: Readonly<Record<AutonomySwitch, number>> = Object.freeze({
  off: 0,
  propose: 1,
  autonomous: 2,
});

/**
 * Budget modes ordered by how much autonomy may spend. "Toward reserve" is
 * lowering (instant, class A for the Leader); "toward all-in" is raising
 * (class B, capped at the grant's `spend.maxMode`).
 */
export const BUDGET_MODE_RANK: Readonly<Record<BudgetMode, number>> = Object.freeze({
  reserve: 0,
  balanced: 1,
  'all-in': 2,
});

/** Class C is never grantable — it is by definition outside the grant. */
export type LeaderGrantClass = Exclude<LeaderActionClass, 'C'>;

/** How the grant treats ashlr-hub itself. */
export type SelfRepoMode = 'propose-only' | 'merge-non-authority';

export type SeatRole = 'producer' | 'judge' | 'leader';

/**
 * Activation capability kinds. `proposal-once` is master's one-shot permit;
 * `resident-standing` is minted per tick under a standing grant (U1 widens
 * DaemonActivationCapability['kind'] in activation-permit.ts to this union).
 * Loop code should test `kind === 'proposal-once'`, which compiles before and
 * after the widening.
 */
export type DaemonCapabilityKind = 'proposal-once' | 'resident-standing';

// ---------------------------------------------------------------------------
// StandingGrantV1 (+ the addendum's rollout ladder)
// ---------------------------------------------------------------------------

export interface StandingGrantRepo {
  /** GitHub `owner/name`. */
  nameWithOwner: string;
  /** The most this repo may ever reach under this grant. */
  stage: RepoStage;
  enforcement: RepoEnforcement;
  maxRisk: MergeRisk;
  maxMergesPerDay: number;
}

export interface StandingGrantMerge {
  maxFiles: number;
  maxLines: number;
  selfRepo: SelfRepoMode;
}

export interface StandingGrantSeat {
  enabled: boolean;
  /** Percent (integer 0–100) of the binding window autonomy never touches — Mason's reserve. */
  reserveFloorPercent: number;
  /** Autonomy stays off the seat while its 5-hour window is above this percent. Absent = no session ceiling. */
  maxSessionWindowPercent?: number;
  roles: SeatRole[];
}

export interface StandingGrantSpend {
  /** Highest budget mode autonomy (and the Leader) may select. */
  maxMode: BudgetMode;
  /** Integer USD per day for metered (per-token) APIs; 0 = none. */
  meteredUsdPerDay: number;
  /** Keyed by seat id. A seat absent here is unusable by autonomy (fail closed). */
  seats: Record<string, StandingGrantSeat>;
}

export interface StandingGrantLeader {
  classes: LeaderGrantClass[];
  /** Class-B veto window in minutes (≥ STANDING_GRANT_CEILINGS.minVetoMinutes). */
  vetoMinutes: number;
}

/**
 * Exit criteria for ONE rollout stage, evaluated from ledger rows written
 * while that stage was current. All met ⇒ the daemon advances one stage
 * (`rollout:advanced`). A breach — any sandbox violation, any reserve
 * breach, or a revert rate above `maxRevertRatePct` — drops it back one
 * stage (`rollout:regressed`).
 */
export interface RolloutCriteria {
  /** Merges landed in the stage. In a stage where no repo is at `merge` (shadow), complete would-merge digests count instead. */
  minMerges: number;
  /** green / (green + red) over the stage's completed post-merge watches, integer percent. With no completed watch it is met only when minMerges is 0. */
  minPostMergeGreenPct: number;
  /** reverts / merges in the stage, integer percent. */
  maxRevertRatePct: number;
  /** Hours since the stage was entered. */
  minHours: number;
  /** Literal 0: no stage ever tolerates a sandbox violation. */
  maxSandboxViolations: 0;
  /** Literal 0: no stage ever tolerates spending Mason's reserve. */
  reserveBreaches: 0;
}

export interface RolloutStageRepo {
  nameWithOwner: string;
  stage: RepoStage;
}

/**
 * One rung of the ladder. A stage can only NARROW the grant's top-level
 * scope: its repos ⊆ grant repos (stage ≤ the repo's grant stage), engines ⊆
 * grant engines, caps ≤ grant caps, leaderClasses ⊆ grant leader classes.
 * The verifier and the Swift helper both reject a stage that widens anything.
 */
export interface RolloutStage {
  /** e.g. `shadow`, `2a`, `2b`, `2c`, `full` (STANDING_GRANT_PATTERNS.stageId). */
  id: string;
  repos: RolloutStageRepo[];
  engines: FleetEngine[];
  maxRisk: MergeRisk;
  maxFiles: number;
  maxLines: number;
  maxMergesPerRepoPerDay: number;
  leaderClasses: LeaderGrantClass[];
  criteria: RolloutCriteria;
}

export interface StandingGrantRollout {
  /** Ordered, first = where the grant starts. 1..STANDING_GRANT_CEILINGS.maxStages. */
  stages: RolloutStage[];
  /** Literal true: advancing is automatic; the ladder itself is what Mason signed. */
  autoAdvance: true;
}

export interface StandingGrantV1 {
  v: 1;
  /** 32 lowercase hex. */
  grantId: string;
  /** Positive integer; must be ≥ minGrantSeq (Revoke bumps minGrantSeq past the revoked grant). */
  grantSeq: number;
  /** Must name a compiled trust root (authority/trust-roots.ts); never a file or env value. */
  keyId: string;
  issuedAt: string;
  /** ≤ issuedAt + 30 days. */
  expiresAt: string;
  /** sha256 hex of this Mac's IOPlatformUUID (uppercase, as `ioreg` prints it) — the grant is useless elsewhere. */
  hostBinding: string;
  /** Digest of dist/authority-surface.json's closure; a deploy that changes it pauses the grant until re-approved. */
  authoritySurfaceDigest: string;
  repos: StandingGrantRepo[];
  merge: StandingGrantMerge;
  spend: StandingGrantSpend;
  engines: FleetEngine[];
  leader: StandingGrantLeader;
  /** Lets the goal / simple conductors run live (liveConductorActivationAuthorized). */
  conductorGoals: boolean;
  rollout: StandingGrantRollout;
}

/** What ashlr-custody `sign-grant` returns and what is stored on disk (grants are signed public data, not secrets). */
export interface SignedStandingGrantV1 {
  payload: StandingGrantV1;
  /** ES256 over the canonical bytes: base64 (RFC 4648 §4, padded) of the 64-byte IEEE-P1363 r‖s form. */
  signature: string;
}

/** A compiled trust root (authority/trust-roots.ts STANDING_GRANT_TRUST_ROOTS). ES256 only — the old ed25519 key is never trusted. */
export interface StandingGrantTrustRoot {
  keyId: string;
  alg: 'ES256';
  /** SPKI PEM of the Secure Enclave P-256 public key. */
  publicKeyPem: string;
}

export const STANDING_GRANT_SIGNING_DOMAIN = 'ashlr:standing-grant:v1\0';

/**
 * Compiled ceilings (SPEC-310B §1 + addendum §5). No grant, config value or
 * Leader action can exceed them; the helper refuses to sign a payload above
 * them and the verifier refuses to accept one. The structural bounds at the
 * end are parser limits (blast radius for a malformed payload), not policy.
 */
export const STANDING_GRANT_CEILINGS = Object.freeze({
  maxTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxRisk: 'medium',
  /** merge.ts's policy maximum — the latent 40 / 3000 config can never take effect. */
  maxFiles: 10,
  maxLines: 300,
  maxMergesPerRepoPerDay: 24,
  /** Work a local model authored merges only at low risk and small size. */
  localAuthored: Object.freeze({ maxRisk: 'low', maxFiles: 4, maxLines: 150 } as const),
  /** Repos with `enforcement: 'local'` (no server-side protection). */
  localEnforcement: Object.freeze({ maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 4 } as const),
  minVetoMinutes: 30,
  maxVetoMinutes: 24 * 60,
  maxStageHours: 30 * 24,
  /** Mirrors routing/policy.ts BUDGET_MAX_DAILY_USD. */
  maxMeteredUsdPerDay: 10_000,
  maxRepos: 32,
  maxStages: 8,
  maxSeats: 64,
  maxRolesPerSeat: 3,
} as const);

/** Every string in a grant matches one of these (see CANONICAL BYTES above). */
export const STANDING_GRANT_PATTERNS = Object.freeze({
  grantId: /^[a-f0-9]{32}$/u,
  keyId: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
  /** hostBinding, authoritySurfaceDigest. */
  sha256Hex: /^[a-f0-9]{64}$/u,
  /** Exactly Date.prototype.toISOString()'s shape. */
  isoInstant: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  nameWithOwner: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u,
  stageId: /^[a-z0-9][a-z0-9-]{0,31}$/u,
  /** Same spelling rule as routing/policy.ts BUDGET_SEAT_ID_RE. */
  seatId: /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u,
  /** base64 of 64 bytes. */
  signature: /^[A-Za-z0-9+/]{86}==$/u,
});

/**
 * Builds a key list from an object literal that must name EVERY key of T —
 * `-?` makes optional keys mandatory in the literal, so a key added to an
 * interface without being added here is a compile error, and an unknown key
 * is an excess-property error. This is what keeps "exact key set" checks in
 * the verifier and the Swift helper from drifting from the types.
 */
function keyList<T>(keys: { readonly [K in keyof T]-?: true }): readonly (keyof T & string)[] {
  return Object.freeze(Object.keys(keys)) as readonly (keyof T & string)[];
}

/**
 * Exact key sets per object level of a signed grant. Every key is required
 * EXCEPT those in STANDING_GRANT_OPTIONAL_KEYS; any other key is refused.
 */
export const STANDING_GRANT_KEYS = Object.freeze({
  envelope: keyList<SignedStandingGrantV1>({ payload: true, signature: true }),
  grant: keyList<StandingGrantV1>({
    v: true,
    grantId: true,
    grantSeq: true,
    keyId: true,
    issuedAt: true,
    expiresAt: true,
    hostBinding: true,
    authoritySurfaceDigest: true,
    repos: true,
    merge: true,
    spend: true,
    engines: true,
    leader: true,
    conductorGoals: true,
    rollout: true,
  }),
  repo: keyList<StandingGrantRepo>({
    nameWithOwner: true,
    stage: true,
    enforcement: true,
    maxRisk: true,
    maxMergesPerDay: true,
  }),
  merge: keyList<StandingGrantMerge>({ maxFiles: true, maxLines: true, selfRepo: true }),
  spend: keyList<StandingGrantSpend>({ maxMode: true, meteredUsdPerDay: true, seats: true }),
  seat: keyList<StandingGrantSeat>({
    enabled: true,
    reserveFloorPercent: true,
    maxSessionWindowPercent: true,
    roles: true,
  }),
  leader: keyList<StandingGrantLeader>({ classes: true, vetoMinutes: true }),
  rollout: keyList<StandingGrantRollout>({ stages: true, autoAdvance: true }),
  stage: keyList<RolloutStage>({
    id: true,
    repos: true,
    engines: true,
    maxRisk: true,
    maxFiles: true,
    maxLines: true,
    maxMergesPerRepoPerDay: true,
    leaderClasses: true,
    criteria: true,
  }),
  stageRepo: keyList<RolloutStageRepo>({ nameWithOwner: true, stage: true }),
  criteria: keyList<RolloutCriteria>({
    minMerges: true,
    minPostMergeGreenPct: true,
    maxRevertRatePct: true,
    minHours: true,
    maxSandboxViolations: true,
    reserveBreaches: true,
  }),
});

/** The only optional keys in a signed grant. */
export const STANDING_GRANT_OPTIONAL_KEYS = Object.freeze({
  seat: Object.freeze(['maxSessionWindowPercent'] as const),
});

// ---------------------------------------------------------------------------
// EffectivePolicy — what currentStandingPolicy() returns
// ---------------------------------------------------------------------------

export interface EffectiveRepoPolicy {
  nameWithOwner: string;
  /** min(grant repo stage, current rollout stage, switch, selfRepo rule). */
  stage: RepoStage;
  enforcement: RepoEnforcement;
  maxRisk: MergeRisk;
  maxFiles: number;
  maxLines: number;
  maxMergesPerDay: number;
  /** Non-null only for ashlr-hub itself: the grant's merge.selfRepo. */
  selfRepo: SelfRepoMode | null;
}

export interface EffectiveMergePolicy {
  /** The grant-wide cap after min(grant, stage, config, ceilings); a repo's own cap may be lower. */
  maxFiles: number;
  maxLines: number;
  selfRepo: SelfRepoMode;
  /** Caps for work a local model authored. */
  localAuthored: { maxRisk: 'low'; maxFiles: number; maxLines: number };
}

export interface EffectiveSeatPolicy {
  seatId: string;
  enabled: boolean;
  reserveFloorPercent: number;
  /** null = no session ceiling. */
  maxSessionWindowPercent: number | null;
  roles: readonly SeatRole[];
}

export interface EffectiveSpendPolicy {
  maxMode: BudgetMode;
  meteredUsdPerDay: number;
  /** A seat absent here is unusable by autonomy (fail closed). */
  seats: Readonly<Record<string, EffectiveSeatPolicy>>;
}

export interface EffectiveLeaderPolicy {
  /**
   * Current stage's leaderClasses ∩ the grant's. Empty while the switch is
   * `propose` (the Leader only proposes) and in a shadow stage (dry-run memos).
   */
  classes: readonly LeaderGrantClass[];
  vetoMinutes: number;
}

export interface EffectiveRolloutPosition {
  stageId: string;
  /** 0-based. */
  stageIndex: number;
  stageCount: number;
  /** When this stage became current (from the ledger). */
  enteredAt: string;
}

/**
 * The standing authority actually in force right now: min(grant, current
 * rollout stage, clamp switch, config, compiled ceilings). It exists only
 * while a verified, unexpired, unrevoked, unpaused grant is installed, KILL
 * is off, the switch is not `off` and the ledger chain is intact — otherwise
 * currentStandingPolicy() returns null and the fleet behaves exactly as
 * master does (dark).
 */
export interface EffectivePolicy {
  v: 1;
  grantId: string;
  grantSeq: number;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  /** Never `off` here (off ⇒ no policy at all). */
  switch: Exclude<AutonomySwitch, 'off'>;
  rollout: EffectiveRolloutPosition;
  /** The current stage's repos only, each fully clamped. */
  repos: readonly EffectiveRepoPolicy[];
  merge: EffectiveMergePolicy;
  spend: EffectiveSpendPolicy;
  /** Stage engines ∩ grant engines. */
  engines: readonly FleetEngine[];
  leader: EffectiveLeaderPolicy;
  conductorGoals: boolean;
  /** When this value was computed (currentStandingPolicy caches ≤ 10 s). */
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Rollout evidence / progress
// ---------------------------------------------------------------------------

/** What the criteria were evaluated against (recorded on rollout ledger rows). */
export interface RolloutEvidence {
  hoursInStage: number;
  merges: number;
  /** null = no completed post-merge watch in the stage. */
  postMergeGreenPct: number | null;
  /** null = no merges in the stage. */
  revertRatePct: number | null;
  sandboxViolations: number;
  reserveBreaches: number;
}

export interface RolloutProgress extends EffectiveRolloutPosition, RolloutEvidence {
  criteria: RolloutCriteria;
  /** null = this is the last signed stage. */
  nextStageId: string | null;
  /** Every criterion met — the daemon advances on its next tick. */
  met: boolean;
  /** Plain-language unmet criteria, e.g. "3 of 10 merges", "6 h of 8 h". */
  unmet: string[];
}

// ---------------------------------------------------------------------------
// The authority ledger — ~/.ashlr/authority/ledger.jsonl (authority/ledger.ts)
// ---------------------------------------------------------------------------

/**
 * Entry hash = sha256hex(LEDGER_HASH_DOMAIN ‖ canonicalizeDaemonActivationValue(
 * entry without `hash`)). `prevHash` chains to the previous entry (the first
 * entry uses LEDGER_GENESIS_PREV_HASH) and `seq` is contiguous from 0. A
 * broken or shortened chain halts everything until a new grant is signed.
 */
export const LEDGER_HASH_DOMAIN = 'ashlr:authority-ledger:v1\0';

export const LEDGER_GENESIS_PREV_HASH = '0'.repeat(64);

/** Why a grant is paused (it stays installed; a re-approval — new grant, one Touch ID — resumes). */
export type GrantPauseCode = 'authority-code-changed' | 'ledger-broken';

/**
 * An autonomous run whose sandbox-violation evidence is UNKNOWN (3.10 d0):
 * the kernel log watch for its tagged deny rules was unavailable or did not
 * reach its end barrier, so an empty violation list proves nothing. The
 * rollout neither counts the run as clean nor treats it as a breach: the row
 * HOLDS the stage (never advances it, never regresses it) — see
 * `EVIDENCE_UNKNOWN_HOLD_MS` in authority/rollout.ts.
 */
export interface SandboxEvidenceUnknownRecord {
  v: 1;
  engine: string;
  repo: string | null;
  runId: string | null;
  /** The kernel evidence state (never `complete` — a complete run writes no row). */
  state: 'incomplete' | 'unavailable';
  /** Plain sentence from the evidence watch, no paths. */
  reason: string;
  at: string;
}

/**
 * Payload per ledger event kind. Rows are immutable once written, so a
 * payload never changes shape — add a new kind instead. Grouped by writer.
 */
export interface LedgerPayloads {
  // U1 — lifecycle of the ledger itself, grants, switch, kill, rollout
  /** First row of every chain. `hostBinding` null = this machine's binding could not be read (non-macOS, tests). */
  'ledger:genesis': { hostBinding: string | null };
  /**
   * Second row of a chain that REPLACED a broken one. Written only while
   * installing a newly signed grant (the Touch ID is the authorization to
   * start over); the broken file is kept beside it. `grantSeqFloor` carries
   * the old chain's highest accepted grantSeq forward, so a grant accepted
   * before the break can never be re-installed (sequence rollback).
   */
  'ledger:recovered': {
    /** Last intact entry of the broken chain; null when nothing was intact. */
    previousHead: LedgerHead | null;
    brokenAtSeq: number | null;
    reason: string;
    /** File name (not path) the broken chain was archived under. */
    archivedAs: string;
    grantSeqFloor: number;
  };
  'grant:accepted': {
    grantId: string;
    grantSeq: number;
    keyId: string;
    issuedAt: string;
    expiresAt: string;
    authoritySurfaceDigest: string;
    stageIds: string[];
    /** sha256 hex of the canonical signed envelope. */
    envelopeDigest: string;
  };
  'grant:rejected': { grantId: string | null; code: string; reason: string };
  'grant:paused': { grantId: string; code: GrantPauseCode; reason: string };
  'grant:revoked': { grantId: string | null; minGrantSeq: number; reason: string };
  'grant:expired': { grantId: string; expiresAt: string };
  'switch:changed': { from: AutonomySwitch; to: AutonomySwitch; requested: AutonomySwitch; reason: string };
  'kill:on': { reason: string };
  'kill:off': { reason: string };
  'rollout:advanced': {
    grantId: string;
    fromStageId: string;
    toStageId: string;
    toStageIndex: number;
    evidence: RolloutEvidence;
  };
  'rollout:regressed': {
    grantId: string;
    fromStageId: string;
    toStageId: string;
    toStageIndex: number;
    breach: string;
    evidence: RolloutEvidence;
  };
  // U3 — gates, PRs, merges
  'gate:result': GateResult;
  'gate:would-merge': WouldMergeRecord;
  'pr:opened': FleetPrRecord;
  'pr:closed': FleetPrChange;
  'pr:reopened': FleetPrChange;
  'merge:landed': LandingRecord;
  // U4 — post-merge watch, reverts, holds
  'post-merge:result': PostMergeResult;
  'revert:landed': LandingRecord;
  'revert:failed': { landingId: string; repo: string; reason: string };
  'hold:set': RepoHold;
  'hold:cleared': { repo: string; kind: RepoHoldKind; reason: string };
  // Safety signals that regress the rollout (U2 / U5 / U6)
  'sandbox:violation': SandboxViolationRecord;
  'reserve:breach': ReserveBreachRecord;
  /** d0: a run whose violation evidence is unknown — HOLDS the rollout, never moves it. */
  'sandbox:evidence-unknown': SandboxEvidenceUnknownRecord;
  // U8 — Leader
  'leader:memo': LeaderMemoRecord;
  /** Written on every status change (scheduled, applied — with its inverse — refused, failed, escalated). */
  'leader:action': LeaderAction;
  'leader:vetoed': LeaderVetoRecord;
  'leader:outcome': LeaderOutcomeRecord;
  // U9 — harness
  'harness:experiment': ExperimentResultV1;
  'harness:adopted': HarnessTransition;
  'harness:rolled-back': HarnessTransition;
  'harness:rejected': HarnessTransition;
  // Informational only — nothing reads a note to make an authority decision.
  note: { topic: string; detail: string };
}

export type LedgerEventKind = keyof LedgerPayloads;

/** Every ledger event kind (exhaustive — a kind added to LedgerPayloads must be added here). */
export const LEDGER_EVENT_KINDS = keyList<LedgerPayloads>({
  'ledger:genesis': true,
  'ledger:recovered': true,
  'grant:accepted': true,
  'grant:rejected': true,
  'grant:paused': true,
  'grant:revoked': true,
  'grant:expired': true,
  'switch:changed': true,
  'kill:on': true,
  'kill:off': true,
  'rollout:advanced': true,
  'rollout:regressed': true,
  'gate:result': true,
  'gate:would-merge': true,
  'pr:opened': true,
  'pr:closed': true,
  'pr:reopened': true,
  'merge:landed': true,
  'post-merge:result': true,
  'revert:landed': true,
  'revert:failed': true,
  'hold:set': true,
  'hold:cleared': true,
  'sandbox:violation': true,
  'reserve:breach': true,
  'sandbox:evidence-unknown': true,
  'leader:memo': true,
  'leader:action': true,
  'leader:vetoed': true,
  'leader:outcome': true,
  'harness:experiment': true,
  'harness:adopted': true,
  'harness:rolled-back': true,
  'harness:rejected': true,
  note: true,
});

export interface LedgerEntryBase {
  v: 1;
  /** 0-based, contiguous. */
  seq: number;
  at: string;
  actor: FleetActor;
  /** The standing grant in force when written; null = none. */
  grantId: string | null;
  /** nameWithOwner when the event concerns one repo; null otherwise. */
  repo: string | null;
  prevHash: string;
  hash: string;
}

export type LedgerEntryOf<K extends LedgerEventKind> = LedgerEntryBase & { kind: K; data: LedgerPayloads[K] };

/** Discriminated on `kind`, so narrowing the kind narrows `data`. */
export type LedgerEntry = { [K in LedgerEventKind]: LedgerEntryOf<K> }[LedgerEventKind];

/** Input to appendLedger — the ledger fills seq, at, prevHash and hash. */
export interface LedgerAppendInput<K extends LedgerEventKind> {
  kind: K;
  data: LedgerPayloads[K];
  actor: FleetActor;
  grantId: string | null;
  repo: string | null;
}

/**
 * A failed append means the authority action must NOT proceed (fail closed):
 * e.g. U3 writes its gate rows before the merge call and aborts on !ok.
 */
export type LedgerAppendResult<K extends LedgerEventKind> =
  | { ok: true; entry: LedgerEntryOf<K> }
  | { ok: false; reason: string };

export interface LedgerHead {
  seq: number;
  hash: string;
  at: string;
}

export interface LedgerReadOptions {
  sinceSeq?: number;
  sinceAt?: string;
  kinds?: readonly LedgerEventKind[];
  repo?: string;
  grantId?: string;
  /** Newest `limit` entries (after filtering); absent = all. */
  limit?: number;
}

export interface LedgerReadResult {
  /** Oldest first. */
  entries: LedgerEntry[];
  head: LedgerHead | null;
  /** `broken` ⇒ callers fail closed (no merge, no advance). */
  chain: 'ok' | 'empty' | 'broken';
  brokenAtSeq: number | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Authority API (U1) — GET / POST /api/verse/authority
// ---------------------------------------------------------------------------

export const VERSE_AUTHORITY_PATH = '/api/verse/authority';

/**
 * - `none`    — no grant installed.
 * - `active`  — verified and in force.
 * - `paused`  — installed but paused (e.g. "authority code changed — re-approve").
 * - `expired` / `revoked` — needs a new grant.
 * - `invalid` — present but fails verification (key drift, host, digest, sequence).
 */
export type GrantState = 'none' | 'active' | 'paused' | 'expired' | 'revoked' | 'invalid';

export interface AuthorityGrantView {
  state: GrantState;
  /** Specific sentence for Mason; null when active. */
  reason: string | null;
  grantId: string | null;
  grantSeq: number | null;
  keyId: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  /** [] when there is no grant. */
  repos: StandingGrantRepo[];
  engines: FleetEngine[];
  maxMode: BudgetMode | null;
  stageIds: string[];
}

export interface AuthorityCustodyView {
  /** ashlr-custody installed (root-owned) — null = unknown. */
  installed: boolean | null;
  keyInitialized: boolean | null;
  githubApp: boolean | null;
  claudeToken: boolean | null;
}

export interface AuthorityStatusV1 {
  v: 1;
  checkedAt: string;
  /** The switch as last set (clamp.json). */
  switch: AutonomySwitch;
  /** What is actually in force: min(switch, grant, KILL). */
  effectiveSwitch: AutonomySwitch;
  /** Highest position reachable without a new grant; raising beyond it needs Touch ID. */
  maxSwitchWithoutGrant: AutonomySwitch;
  /** ~/.ashlr/KILL present (Stop). */
  kill: boolean;
  grant: AuthorityGrantView;
  rollout: RolloutProgress | null;
  /** currentStandingPolicy(). */
  policy: EffectivePolicy | null;
  ledger: { state: 'ok' | 'empty' | 'broken'; head: LedgerHead | null; reason: string | null };
  custody: AuthorityCustodyView;
  /**
   * Why `effectiveSwitch` is below `switch` (Stop, the grant's state, no OS
   * confinement, an unreadable config…); null when nothing holds it back.
   * Additive (3.10 phase 2) — absent from day-0 fixtures.
   */
  effectiveReason?: string | null;
}

/**
 * GET /api/verse/authority/draft — the grant the server would ask Mason to
 * sign (the default ladder) and its digest. The Touch ID sheet renders it;
 * the `grant` / `re-approve` actions echo `digest` so the server signs
 * exactly what Mason saw.
 */
export interface AuthorityGrantDraft {
  payload: StandingGrantV1;
  /** sha256 hex of the canonical payload. */
  digest: string;
}

/**
 * POST /api/verse/authority — exactly one form per request. Lowering forms
 * (switch down, stop, revoke) apply instantly with no auth. `clear-stop` and
 * raising the switch up to `maxSwitchWithoutGrant` need no Touch ID either:
 * both stay inside what the installed grant already allows. Raising past it
 * is refused with 409 `grant-required`; `grant` / `re-approve` trigger the
 * custody helper's Touch ID prompt on this Mac and answer with the new
 * AuthorityStatusV1. Like every Verse POST, these pass the dispatch and
 * mutation-token gates, which agents cannot reach.
 */
export type AuthorityActionRequest =
  | { action: 'switch'; to: AutonomySwitch }
  | { action: 'stop' }
  | { action: 'clear-stop' }
  | { action: 'revoke'; reason?: string }
  | { action: 'grant'; draftDigest: string }
  | { action: 're-approve'; draftDigest: string };

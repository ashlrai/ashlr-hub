/**
 * Effective standing policy — V3.10 Track B (unit B-U1).
 *
 * Everything that decides "may autonomy act right now, and how much" in one
 * place:
 *
 *   evaluateStandingAuthority()  reads the installed grant, verifies it
 *       (compiled roots, host, authority-surface digest, expiry, revocation,
 *       sequence), the ledger chain, the clamp switch, KILL and OS
 *       confinement, and derives the rollout position and the policy.
 *   computeEffectivePolicy()     PURE: min(grant, current rollout stage,
 *       switch, config, compiled ceilings). Config and the Leader can only
 *       TIGHTEN (invariant I3): an explicit config value lowers a cap, an
 *       absent one is no constraint, and nothing here can exceed the grant.
 *   currentStandingPolicy()      the cached answer (≤ 10 s) every consumer
 *       asks. The expensive parts are cached; the LOWERING signals — KILL,
 *       the switch, expiry — are re-read on EVERY call, because lowering
 *       authority must be instant (invariant I1).
 *   applyStandingOverlay() / clampBudgetPolicy()  PURE projections of a
 *       policy onto the loop's config and onto A9's budget policy.
 *
 * Every failure is fail-closed: null policy, and the fleet behaves exactly
 * like master (dark).
 */
import { loadConfigReadOnlyStrict } from '../config.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { effectiveSeatPolicy, engineOfSeatId, type BudgetEngine } from '../routing/policy.js';
import type { BudgetPolicy, SeatBudgetPolicy } from '../routing/types.js';
import {
  FLEET_ENGINES,
  MERGE_RISK_RANK,
  REPO_STAGE_RANK,
  type FleetActor,
  type FleetEngine,
  type MergeRisk,
  type RepoStage,
} from '../fleet/fleet-types.js';
import type { AshlrConfig } from '../types.js';
import { readClamp, minSwitch, setAutonomySwitch, type SwitchChangeResult } from './clamp.js';
import {
  appendLedger,
  ledgerPath,
  ledgerSnapshot,
  type LedgerReadMode,
  type LedgerRolloutPosition,
  type LedgerSnapshot,
} from './ledger.js';
import { evaluateRollout, rolloutPositionFor, type RolloutEvaluation, type RolloutPositionInternal } from './rollout.js';
import {
  LOCAL_SEAT_WILDCARD,
  SELF_REPO_NAME_WITH_OWNER,
  readInstalledGrant,
  verifyStandingGrant,
  type GrantRejectCode,
} from './standing-grant.js';
import {
  confinementAvailable,
  currentHostBinding,
  runningPackageRoot,
  verifyAuthoritySurface,
  type ConfinementProbe,
  type SurfaceTarget,
  type SurfaceVerification,
} from './surface.js';
import { STANDING_GRANT_TRUST_ROOTS } from './trust-roots.js';
import {
  AUTONOMY_SWITCH_RANK,
  BUDGET_MODE_RANK,
  STANDING_GRANT_CEILINGS,
  type AutonomySwitch,
  type EffectivePolicy,
  type EffectiveRepoPolicy,
  type EffectiveSeatPolicy,
  type GrantPauseCode,
  type GrantState,
  type StandingGrantSeat,
  type StandingGrantV1,
} from './types.js';

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

function minRisk(...risks: (MergeRisk | undefined)[]): MergeRisk {
  let out: MergeRisk = 'medium';
  for (const risk of risks) {
    if (risk !== undefined && MERGE_RISK_RANK[risk] < MERGE_RISK_RANK[out]) out = risk;
  }
  return out;
}

function minStage(...stages: RepoStage[]): RepoStage {
  return stages.reduce((a, b) => (REPO_STAGE_RANK[a] <= REPO_STAGE_RANK[b] ? a : b));
}

function positiveInt(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function minDefined(...values: (number | undefined)[]): number {
  let out = Number.POSITIVE_INFINITY;
  for (const value of values) if (value !== undefined && value < out) out = value;
  return out;
}

/** What config can tighten, read defensively (a mangled value is no constraint, never a loosening). */
export interface ConfigConstraints {
  /** config autoMerge.enabled === false: nothing merges. */
  mergeDisabled: boolean;
  maxRisk: MergeRisk | undefined;
  maxFiles: number | undefined;
  maxLines: number | undefined;
  /** config autoMerge.allowSelfMerge === false: ashlr-hub stays propose-only. */
  selfMergeDisabled: boolean;
  /** config foundry.localOnly === true: only the local engine family. */
  localOnly: boolean;
}

export function configConstraints(cfg: AshlrConfig | null): ConfigConstraints {
  const foundry = (cfg?.foundry ?? {}) as Record<string, unknown>;
  const autoMerge = (typeof foundry['autoMerge'] === 'object' && foundry['autoMerge'] !== null ? foundry['autoMerge'] : {}) as Record<string, unknown>;
  return {
    mergeDisabled: autoMerge['enabled'] === false,
    maxRisk: autoMerge['maxRisk'] === 'low' ? 'low' : undefined,
    maxFiles: positiveInt(autoMerge['maxAutomergeFiles']),
    maxLines: positiveInt(autoMerge['maxAutomergeLines']),
    selfMergeDisabled: autoMerge['allowSelfMerge'] === false,
    localOnly: foundry['localOnly'] === true,
  };
}

/** Which fleet engine family a seat belongs to. */
export function fleetEngineOfSeat(seatId: string): FleetEngine {
  const engine: BudgetEngine = engineOfSeatId(seatId);
  switch (engine) {
    case 'local':
      return 'local';
    case 'grok':
      return 'grok-cli';
    case 'codex':
      return 'codex';
    default:
      return 'claude-cli';
  }
}

/**
 * The grant's policy for one seat: its exact entry, or — for a local-runtime
 * seat only — the `local` wildcard entry. null = the grant does not name it,
 * so autonomy may not use it (fail closed).
 */
export function standingSeatFor<T extends StandingGrantSeat | EffectiveSeatPolicy>(
  spend: { seats: Readonly<Record<string, T>> },
  seatId: string,
): T | null {
  const exact = Object.prototype.hasOwnProperty.call(spend.seats, seatId) ? spend.seats[seatId] : undefined;
  if (exact) return exact;
  if (engineOfSeatId(seatId) === 'local' && Object.prototype.hasOwnProperty.call(spend.seats, LOCAL_SEAT_WILDCARD)) {
    return spend.seats[LOCAL_SEAT_WILDCARD] ?? null;
  }
  return null;
}

export interface EffectivePolicyInput {
  grant: StandingGrantV1;
  position: Pick<RolloutPositionInternal, 'stageIndex' | 'stageId' | 'enteredAt'>;
  /** The effective switch (already min(clamp, grant)); `off` never reaches here. */
  switch: Exclude<AutonomySwitch, 'off'>;
  config: AshlrConfig | null;
  nowMs: number;
}

/** PURE: min(grant, current rollout stage, switch, config, compiled ceilings). */
export function computeEffectivePolicy(input: EffectivePolicyInput): EffectivePolicy {
  const { grant, position } = input;
  const stage = grant.rollout.stages[position.stageIndex];
  if (!stage || stage.id !== position.stageId) throw new Error('rollout position does not match the grant');
  const cfg = configConstraints(input.config);
  const ceilings = STANDING_GRANT_CEILINGS;
  const switchStage: RepoStage = input.switch === 'autonomous' ? 'merge' : 'propose';
  const configStage: RepoStage = cfg.mergeDisabled ? 'propose' : 'merge';
  const grantRepos = new Map(grant.repos.map((repo) => [repo.nameWithOwner, repo]));

  const mergeMaxFiles = minDefined(grant.merge.maxFiles, stage.maxFiles, ceilings.maxFiles, cfg.maxFiles);
  const mergeMaxLines = minDefined(grant.merge.maxLines, stage.maxLines, ceilings.maxLines, cfg.maxLines);

  const repos: EffectiveRepoPolicy[] = stage.repos.flatMap((stageRepo) => {
    const granted = grantRepos.get(stageRepo.nameWithOwner);
    if (!granted) return [];
    const self = granted.nameWithOwner.toLowerCase() === SELF_REPO_NAME_WITH_OWNER;
    const local = granted.enforcement === 'local';
    let repoStage = minStage(stageRepo.stage, granted.stage, switchStage, configStage);
    if (self && (grant.merge.selfRepo === 'propose-only' || cfg.selfMergeDisabled)) repoStage = 'propose';
    return [{
      nameWithOwner: granted.nameWithOwner,
      stage: repoStage,
      enforcement: granted.enforcement,
      maxRisk: minRisk(granted.maxRisk, stage.maxRisk, ceilings.maxRisk, local ? ceilings.localEnforcement.maxRisk : undefined, cfg.maxRisk),
      maxFiles: minDefined(mergeMaxFiles, local ? ceilings.localEnforcement.maxFiles : undefined),
      maxLines: minDefined(mergeMaxLines, local ? ceilings.localEnforcement.maxLines : undefined),
      maxMergesPerDay: minDefined(
        granted.maxMergesPerDay,
        stage.maxMergesPerRepoPerDay,
        ceilings.maxMergesPerRepoPerDay,
        local ? ceilings.localEnforcement.maxMergesPerDay : undefined,
      ),
      selfRepo: self ? grant.merge.selfRepo : null,
    }];
  });

  const engines = FLEET_ENGINES.filter((engine) =>
    stage.engines.includes(engine) && grant.engines.includes(engine) && (!cfg.localOnly || engine === 'local'));

  const seats: Record<string, EffectiveSeatPolicy> = {};
  for (const [seatId, seat] of Object.entries(grant.spend.seats)) {
    seats[seatId] = {
      seatId,
      enabled: seat.enabled && engines.includes(fleetEngineOfSeat(seatId)),
      reserveFloorPercent: seat.reserveFloorPercent,
      maxSessionWindowPercent: seat.maxSessionWindowPercent ?? null,
      roles: Object.freeze([...seat.roles]),
    };
  }

  const classes = input.switch === 'propose'
    ? []
    : stage.leaderClasses.filter((cls) => grant.leader.classes.includes(cls));

  return {
    v: 1,
    grantId: grant.grantId,
    grantSeq: grant.grantSeq,
    keyId: grant.keyId,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    switch: input.switch,
    rollout: {
      stageId: stage.id,
      stageIndex: position.stageIndex,
      stageCount: grant.rollout.stages.length,
      enteredAt: position.enteredAt,
    },
    repos,
    merge: {
      maxFiles: mergeMaxFiles,
      maxLines: mergeMaxLines,
      selfRepo: grant.merge.selfRepo,
      localAuthored: {
        maxRisk: 'low',
        maxFiles: Math.min(ceilings.localAuthored.maxFiles, mergeMaxFiles),
        maxLines: Math.min(ceilings.localAuthored.maxLines, mergeMaxLines),
      },
    },
    spend: {
      maxMode: grant.spend.maxMode,
      meteredUsdPerDay: Math.min(grant.spend.meteredUsdPerDay, ceilings.maxMeteredUsdPerDay),
      seats,
    },
    engines,
    leader: { classes, vetoMinutes: grant.leader.vetoMinutes },
    conductorGoals: grant.conductorGoals,
    computedAt: new Date(input.nowMs).toISOString(),
  };
}

/** The highest switch a grant allows: autonomous when any rung merges, else propose. */
export function grantSwitchCap(grant: StandingGrantV1): Exclude<AutonomySwitch, 'off'> {
  return grant.rollout.stages.some((stage) => stage.repos.some((repo) => repo.stage === 'merge')) ? 'autonomous' : 'propose';
}

// ---------------------------------------------------------------------------
// Overlay and budget clamp (pure)
// ---------------------------------------------------------------------------

/**
 * Pure: `cfg` with the standing overlay applied — claimIntegrity,
 * selfImprove and counterfactual forced on; OS confinement forced (mode
 * `os`, fail when unsupported — unit U2's confine.ts additionally ignores
 * config while a policy is live); merge caps clamped to `policy`; pushToRemote
 * with no local-merge fallback; never merging without verification. An
 * explicit tighter config value is kept; nothing here loosens `cfg` beyond
 * what the signed grant authorizes.
 */
export function applyStandingOverlay(cfg: AshlrConfig, policy: EffectivePolicy): AshlrConfig {
  const foundry = (cfg.foundry ?? {}) as NonNullable<AshlrConfig['foundry']>;
  const configured = foundry.autoMerge;
  const constraints = configConstraints(cfg);
  const merging = policy.repos.filter((repo) => repo.stage === 'merge');
  const mergeRisk: MergeRisk = merging.some((repo) => repo.maxRisk === 'medium') ? 'medium' : 'low';
  const selfMerging = merging.some((repo) => repo.selfRepo === 'merge-non-authority');

  const confinement: NonNullable<NonNullable<AshlrConfig['foundry']>['confinement']> = {};
  for (const [engine, profile] of Object.entries(foundry.confinement ?? {})) {
    if (!profile) continue;
    // Keep only what tightens: a configured "no egress" stays; extra read paths are dropped.
    (confinement as Record<string, unknown>)[engine] = {
      mode: 'os',
      onUnsupported: 'fail',
      ...(profile.networkEgress === false ? { networkEgress: false } : { networkEgress: true }),
    };
  }
  const fleetDefault = (foundry.confinement as Record<string, { networkEgress?: boolean } | undefined> | undefined)?.['*'];
  (confinement as Record<string, unknown>)['*'] = {
    mode: 'os',
    onUnsupported: 'fail',
    networkEgress: fleetDefault?.networkEgress === false ? false : true,
  };

  const trustBasis = configured?.trustBasis === 'tier' ? 'tier' : 'verification';
  const autoMerge: NonNullable<NonNullable<AshlrConfig['foundry']>['autoMerge']> = {
    ...(configured ?? { enabled: false }),
    enabled: merging.length > 0 && !constraints.mergeDisabled,
    trustBasis,
    maxRisk: constraints.maxRisk === 'low' ? 'low' : mergeRisk,
    maxAutomergeFiles: Math.min(policy.merge.maxFiles, constraints.maxFiles ?? Number.POSITIVE_INFINITY),
    maxAutomergeLines: Math.min(policy.merge.maxLines, constraints.maxLines ?? Number.POSITIVE_INFINITY),
    allowSelfMerge: selfMerging && !constraints.selfMergeDisabled,
    pushToRemote: true,
    midToBranch: false,
    allowWithoutVerification: false,
  };

  return {
    ...cfg,
    foundry: {
      ...foundry,
      claimIntegrity: true,
      selfImprove: true,
      counterfactual: true,
      confinement,
      autoMerge,
    } as NonNullable<AshlrConfig['foundry']>,
  };
}

/**
 * Pure: the A9 budget policy clamped to the grant — mode ≤ spend.maxMode;
 * seats the grant does not name, or disables, are disabled; reserve ≥ the
 * grant's reserve floor; session ceiling ≤ the grant's; an existing USD cap ≤
 * meteredUsdPerDay. Can only tighten `policy`. Feed the result to routeSeat.
 *
 * `knownSeatIds` (optional): every seat the caller is about to route over
 * (e.g. the capacity snapshot's ids). BudgetPolicy has no "every other seat"
 * entry — an unnamed seat falls back to its mode default — so a seat is only
 * clamped here if it is stored in `policy`, named in the grant, or passed
 * here. Route over `standingSeatCapacity(...)` or pass the ids.
 */
export function clampBudgetPolicy(
  policy: BudgetPolicy,
  standing: Pick<EffectivePolicy, 'spend'>,
  knownSeatIds: readonly string[] = [],
): BudgetPolicy {
  const mode = BUDGET_MODE_RANK[policy.mode] <= BUDGET_MODE_RANK[standing.spend.maxMode] ? policy.mode : standing.spend.maxMode;
  const modeClamped: BudgetPolicy = { mode, seats: policy.seats, updatedAt: policy.updatedAt };
  const ids = new Set<string>([...Object.keys(policy.seats), ...Object.keys(standing.spend.seats), ...knownSeatIds]);
  const seats: Record<string, SeatBudgetPolicy> = {};
  for (const seatId of ids) {
    const current = effectiveSeatPolicy(modeClamped, seatId);
    const granted = standingSeatFor(standing.spend, seatId);
    if (!granted) {
      seats[seatId] = { ...current, seatId, enabled: false };
      continue;
    }
    const out: SeatBudgetPolicy = {
      seatId,
      enabled: current.enabled && granted.enabled,
      reservePercent: Math.max(current.reservePercent, granted.reserveFloorPercent),
    };
    const ceiling = minDefined(current.maxSessionWindowPercent, granted.maxSessionWindowPercent ?? undefined);
    if (Number.isFinite(ceiling)) out.maxSessionWindowPercent = ceiling;
    if (current.dailyUsdCap !== undefined) out.dailyUsdCap = Math.min(current.dailyUsdCap, standing.spend.meteredUsdPerDay);
    seats[seatId] = out;
  }
  return { mode, seats, updatedAt: policy.updatedAt };
}

/** Filter a capacity list to the seats the grant lets autonomy use at all. */
export function standingSeatCapacity<T extends { seatId: string }>(capacity: readonly T[], standing: Pick<EffectivePolicy, 'spend'>): T[] {
  return capacity.filter((seat) => standingSeatFor(standing.spend, seat.seatId)?.enabled === true);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface StandingEvaluation {
  checkedAt: string;
  grantState: GrantState;
  /** Why the grant is not active; null when active. */
  grantReason: string | null;
  /** Why nothing autonomous runs right now even if the grant is active (Stop, switch off, no confinement…); null when a policy is in force. */
  inactiveReason: string | null;
  rejectCode: GrantRejectCode | null;
  pauseCode: GrantPauseCode | null;
  grant: StandingGrantV1 | null;
  envelopeDigest: string | null;
  switch: AutonomySwitch;
  switchReadable: boolean;
  effectiveSwitch: AutonomySwitch;
  maxSwitchWithoutGrant: AutonomySwitch;
  kill: boolean;
  ledger: Pick<LedgerSnapshot, 'chain' | 'head' | 'brokenAtSeq' | 'reason'>;
  position: RolloutPositionInternal | null;
  rollout: RolloutEvaluation | null;
  /** The ledger's last rollout move for this grant (null = still on its first rung). */
  lastRolloutMove: LedgerRolloutPosition | null;
  confinement: ConfinementProbe;
  surface: SurfaceVerification;
  policy: EffectivePolicy | null;
  /** The config the policy was computed with (null = none loaded); a later re-projection must use the same one. */
  config: AshlrConfig | null;
}

export interface EvaluateOptions {
  /** `fresh`: re-hash the surface and the verified ledger prefix, reload config. */
  mode: 'cached' | 'fresh';
  surface: SurfaceTarget;
  nowMs?: number;
  /** Supplied config (the daemon's per-tick config); otherwise loaded read-only. */
  config?: AshlrConfig | null;
}

/** The surface a DISPLAY should evaluate: this release when it is a compiled one, else the installed daemon release. */
export function displaySurfaceTarget(): SurfaceTarget {
  return runningPackageRoot() ? 'running' : 'installed';
}

function loadConfigOrNull(): { cfg: AshlrConfig | null; error: string | null } {
  try {
    return { cfg: loadConfigReadOnlyStrict(), error: null };
  } catch (error) {
    return { cfg: null, error: `config.json could not be read (${(error as Error).message.slice(0, 120)})` };
  }
}

export function evaluateStandingAuthority(opts: EvaluateOptions): StandingEvaluation {
  const nowMs = opts.nowMs ?? Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const clamp = readClamp();
  const kill = killSwitchOn();
  const ledgerMode: LedgerReadMode = opts.mode === 'fresh' ? 'prefix' : 'cached';
  const snapshot = ledgerSnapshot(ledgerMode);
  const surface = verifyAuthoritySurface(opts.surface, { fresh: opts.mode === 'fresh', nowMs });
  const confinement = confinementAvailable();
  const base = {
    checkedAt,
    switch: clamp.clamp.switch,
    switchReadable: clamp.state !== 'invalid',
    kill,
    ledger: { chain: snapshot.chain, head: snapshot.head, brokenAtSeq: snapshot.brokenAtSeq, reason: snapshot.reason },
    confinement,
    surface,
  };
  const dark = (fields: Partial<StandingEvaluation> & Pick<StandingEvaluation, 'grantState' | 'grantReason'>): StandingEvaluation => ({
    ...base,
    inactiveReason: fields.grantReason,
    rejectCode: null,
    pauseCode: null,
    grant: null,
    envelopeDigest: null,
    effectiveSwitch: 'off',
    maxSwitchWithoutGrant: 'off',
    position: null,
    rollout: null,
    lastRolloutMove: null,
    policy: null,
    config: null,
    ...fields,
  });

  const installed = readInstalledGrant();
  if (installed.state === 'none') {
    return dark({ grantState: 'none', grantReason: 'No standing grant is installed — autonomy is dark.' });
  }
  if (installed.state === 'invalid') return dark({ grantState: 'invalid', grantReason: installed.reason });

  const verdict = verifyStandingGrant(installed.envelope, {
    nowMs,
    hostBinding: currentHostBinding(),
    surfaceDigest: surface.ok ? surface.digest : null,
    surfaceReason: surface.ok ? null : surface.reason,
    // Every grant ever accepted raises the floor too: putting an OLDER signed
    // grant back (sequence rollback) is refused even if it never expired.
    minGrantSeq: Math.max(snapshot.index.minGrantSeq, snapshot.index.maxAcceptedGrantSeq),
    revokedGrantIds: snapshot.index.revokedGrantIds,
  }, STANDING_GRANT_TRUST_ROOTS);
  if (!verdict.ok) {
    const code = verdict.code;
    const state: GrantState = code === 'expired'
      ? 'expired'
      : code === 'revoked' || code === 'sequence-rollback'
        ? 'revoked'
        : code === 'surface-mismatch' || code === 'surface-unverified'
          ? 'paused'
          : 'invalid';
    return dark({
      grantState: state,
      grantReason: verdict.reason,
      rejectCode: code,
      pauseCode: code === 'surface-mismatch' ? 'authority-code-changed' : null,
      grant: verdict.grant,
    });
  }
  const grant = verdict.grant;
  if (snapshot.chain === 'broken') {
    return dark({
      grantState: 'paused',
      grantReason: `The authority ledger is broken (${snapshot.reason ?? 'unknown reason'}) — autonomy is halted until you approve a new grant.`,
      pauseCode: 'ledger-broken',
      grant,
      envelopeDigest: verdict.envelopeDigest,
    });
  }
  const accepted = snapshot.index.accepted.get(grant.grantId);
  if (!accepted || accepted.envelopeDigest !== verdict.envelopeDigest) {
    return dark({ grantState: 'invalid', grantReason: 'The installed grant was never accepted into the authority ledger — install it with `ashlr authority grant`.', grant });
  }
  if (snapshot.index.lastAccepted?.grantId !== grant.grantId) {
    return dark({ grantState: 'revoked', grantReason: 'A newer grant was accepted after this one — the installed file is out of date.', grant });
  }
  const position = rolloutPositionFor(grant, snapshot.index);
  if (!position) {
    return dark({ grantState: 'invalid', grantReason: "The ledger's rollout position does not match the grant's ladder.", grant, envelopeDigest: verdict.envelopeDigest });
  }
  const rollout = evaluateRollout({ grant, position, evidence: snapshot.index.evidence, nowMs });
  const cap = grantSwitchCap(grant);
  const requested = clamp.clamp.switch;
  let effectiveSwitch: AutonomySwitch = kill ? 'off' : minSwitch(requested, cap);
  let inactiveReason: string | null = null;
  if (kill) inactiveReason = 'Stop is engaged (~/.ashlr/KILL).';
  else if (effectiveSwitch === 'off') inactiveReason = clamp.state === 'invalid' ? `The autonomy switch is unreadable (${clamp.reason}), so it reads as Off.` : 'The autonomy switch is Off.';
  if (effectiveSwitch !== 'off' && !confinement.ok) {
    effectiveSwitch = 'off';
    inactiveReason = `No OS confinement: ${confinement.reason}`;
  }
  let policy: EffectivePolicy | null = null;
  let configUsed: AshlrConfig | null = null;
  if (effectiveSwitch !== 'off') {
    const loaded = opts.config !== undefined ? { cfg: opts.config, error: null } : loadConfigOrNull();
    if (loaded.error) {
      effectiveSwitch = 'off';
      inactiveReason = loaded.error;
    } else {
      configUsed = loaded.cfg;
      policy = computeEffectivePolicy({ grant, position, switch: effectiveSwitch, config: loaded.cfg, nowMs });
    }
  }
  return {
    ...base,
    grantState: 'active',
    grantReason: null,
    inactiveReason,
    rejectCode: null,
    pauseCode: null,
    grant,
    envelopeDigest: verdict.envelopeDigest,
    effectiveSwitch,
    maxSwitchWithoutGrant: cap,
    position,
    rollout,
    lastRolloutMove: snapshot.index.rollout.get(grant.grantId) ?? null,
    policy,
    config: configUsed,
  };
}

/**
 * Ledger the state transitions an evaluation revealed, once each: a grant
 * that expired, or paused because the authority code changed. The daemon
 * calls this every tick; display paths never write.
 */
export function recordStandingTransitions(evaluation: StandingEvaluation, actor: FleetActor = 'daemon'): void {
  const grant = evaluation.grant;
  if (!grant || evaluation.ledger.chain === 'broken') return;
  const snapshot = ledgerSnapshot('cached');
  if (evaluation.grantState === 'expired' && !snapshot.index.expiredGrantIds.has(grant.grantId)) {
    appendLedger({ kind: 'grant:expired', actor, grantId: grant.grantId, repo: null, data: { grantId: grant.grantId, expiresAt: grant.expiresAt } });
  }
  if (evaluation.pauseCode === 'authority-code-changed' && !snapshot.index.pausedCodes.get(grant.grantId)?.has('authority-code-changed')) {
    appendLedger({
      kind: 'grant:paused',
      actor,
      grantId: grant.grantId,
      repo: null,
      data: { grantId: grant.grantId, code: 'authority-code-changed', reason: evaluation.grantReason ?? 'authority code changed' },
    });
  }
}

// ---------------------------------------------------------------------------
// currentStandingPolicy — the cached answer
// ---------------------------------------------------------------------------

const POLICY_CACHE_MS = 10_000;

interface PolicyCacheEntry {
  at: number;
  evaluation: StandingEvaluation;
}

const policyCache = new Map<string, PolicyCacheEntry>();

/** Drop the cached evaluation (after any authority change in this process). */
export function invalidateStandingPolicyCache(): void {
  policyCache.clear();
}

/**
 * Replace the cached evaluation with one just computed for the RUNNING
 * release (the daemon's fresh per-tick check), so every consumer in this
 * process sees the same verdict the tick's capability was minted under.
 * Evaluations of the installed release are never cached here.
 */
export function primeStandingPolicyCache(evaluation: StandingEvaluation): void {
  if (evaluation.surface.target !== 'running') return;
  policyCache.set(ledgerPath(), { at: Date.now(), evaluation });
}

/**
 * The standing policy in force right now — min(grant, current rollout stage,
 * switch, config, compiled ceilings) — or null when there is no standing
 * authority (no / expired / revoked / paused / invalid grant, KILL on, switch
 * off, broken ledger, no confinement). Verifies the code THIS process runs
 * (never another release). Re-verifies at most every 10 s; Stop, the switch
 * and expiry are re-read on every call so lowering is instant.
 */
export function currentStandingPolicy(): EffectivePolicy | null {
  try {
    const nowMs = Date.now();
    const key = ledgerPath();
    // The cheap signals, read on EVERY call: a Stop or a switch change (either
    // way) invalidates the cached evaluation immediately — lowering must be
    // instant, and raising within the grant should not lag 10 s behind it.
    const kill = killSwitchOn();
    const clampSwitch = readClamp().clamp.switch;
    let entry = policyCache.get(key);
    const stale = !entry
      || nowMs - entry.at > POLICY_CACHE_MS
      || nowMs < entry.at
      || entry.evaluation.kill !== kill
      || entry.evaluation.switch !== clampSwitch;
    if (stale) {
      entry = { at: nowMs, evaluation: evaluateStandingAuthority({ mode: 'cached', surface: 'running', nowMs }) };
      policyCache.set(key, entry);
    }
    const ev = entry!.evaluation;
    if (!ev.policy || !ev.grant) return null;
    if (kill || nowMs >= Date.parse(ev.grant.expiresAt)) return null;
    return ev.policy;
  } catch {
    return null;
  }
}

/**
 * Raise or lower the switch as `actor`. The cap for raising is what the
 * installed grant allows (the installed daemon release's view when this
 * process is not a compiled release), so the answer to "past the grant" is
 * always `grant-required`.
 */
export function requestAutonomySwitch(to: AutonomySwitch, actor: FleetActor, reason: string): SwitchChangeResult {
  const evaluation = AUTONOMY_SWITCH_RANK[to] > AUTONOMY_SWITCH_RANK[readClamp().clamp.switch]
    ? evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() })
    : null;
  const cap: AutonomySwitch = evaluation && evaluation.grantState === 'active' && evaluation.ledger.chain !== 'broken'
    ? evaluation.maxSwitchWithoutGrant
    : 'off';
  const result = setAutonomySwitch({ to, actor, reason, cap });
  invalidateStandingPolicyCache();
  return result;
}

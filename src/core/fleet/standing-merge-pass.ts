/**
 * The standing-grant merge pass — V3.10 Track B (owner: unit U3).
 *
 * What runAutoMergePass does INSTEAD of the legacy M47 path whenever a
 * standing grant is in force (currentStandingPolicy() ≠ null). Each tick:
 *
 *   1. PROGRESS every fleet PR in flight: read GitHub, then — required checks
 *      green on the exact head, head and base unmoved, G0 still true — merge
 *      it SHA-pinned through the App (host-merge.ts), or record a would-merge
 *      when the stage / switch only allows PRs. A moved base re-verifies and
 *      rebuilds the head (the landed tree is always the verified tree); a
 *      human push to the branch, a missing check set or an owner-lane label
 *      sends the PR to the owner lane; red checks close it.
 *   2. EVALUATE pending proposals produced in a fleet MIRROR through G0–G6
 *      (merge-gates.ts) and open the App PR (G7). Proposals in Mason's own
 *      checkouts are never touched — they stay in the inbox for him.
 *
 * Nothing here merges locally, pushes with Mason's credentials, or calls the
 * legacy handoff: under a standing grant the ONLY landing path is the App's
 * SHA-pinned squash merge (invariant I4). Every gate decision is a ledger row
 * (deduplicated per proposal, see recordGateRow); a row the ledger refuses
 * stops that proposal for the tick (fail closed).
 *
 * Every dependency is injectable (StandingPassDeps) so the gate order, the
 * owner lane, head-SHA races and judge-family refusals are tested without
 * GitHub, models or a real ledger.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

import { clampBudgetPolicy } from '../authority/effective-config.js';
import { ledgerSnapshot } from '../authority/ledger.js';
import {
  diffAddedLinesByPath,
  isTestPath,
  testContentImportsTier1,
} from '../authority/protected-paths.js';
import type { EffectivePolicy, EffectiveRepoPolicy } from '../authority/types.js';
import { hashDiff, verifyProvenance } from '../foundry/provenance.js';
import { resolveGitHubOriginAuthority } from '../git.js';
import {
  classifyRisk,
  hasCurrentVerificationBinding,
  selfEvalParityForRepo,
  verifyAndPersistProposal,
  type VerifyAndPersistProposalResult,
} from '../inbox/merge.js';
import { loadProposal, setStatus } from '../inbox/store.js';
import { measureAutoMergeDiffScope } from '../foundry/automerge-diff-scope.js';
import { loadBudgetPolicy, readCapacitySnapshot } from '../routing/budget-store.js';
import { engineOfSeatId, type BudgetEngine } from '../routing/policy.js';
import { routeSeat } from '../routing/router.js';
import { isSelfTargetProposal } from './self.js';
import { fleetMirrorsRoot as u6FleetMirrorsRoot, mirrorNameForPath, readMirrorState } from './mirrors.js';
import { listRepoHolds } from './quarantine.js';
import { scrubSecrets } from '../util/scrub.js';
import type { AshlrConfig, DecisionEntry, Proposal } from '../types.js';
import type { AutoMergePassResult } from './automerge-pass.js';
import { readDecisions } from './decisions-ledger.js';
import {
  closeFleetPr,
  closeGitScratch,
  commentOnPr,
  defaultHostMergeDeps,
  FLEET_APP_BOT_LOGIN,
  FLEET_BRANCH_PREFIX,
  fleetMergeCommitMessage,
  labelOwnerLane,
  landingId,
  ledgerPrOpened,
  mergeFleetPrPinned,
  openFleetPr,
  openGitScratch,
  OWNER_LANE_LABEL,
  policyEpochDigest,
  publishVerifiedTree,
  readBranchHead,
  readHeadChecks,
  readPr,
  readRemoteCommit,
  parseFleetTrailers,
  readRequiredChecks,
  scratchTreeChanges,
  treeForDiff,
  untrustedText,
  type FleetGitScratch,
  type HostMergeDeps,
  type PrSnapshot,
} from './host-merge.js';
import {
  combinedGatesDigest,
  buildGateResult,
  evaluateG0,
  evaluateG1,
  evaluateG1b,
  evaluateG2,
  evaluateG3,
  evaluateG4,
  evaluateG5,
  evaluateG6,
  evaluateG7Checks,
  g7MergeEvaluation,
  mergeWithheldBecause,
  allowedJudgeLanes,
  openGatesDigest,
  recordGateRow,
  repoPolicyFor,
  type G4Input,
  type G5Check,
  type GateEvaluation,
  type RiskClass,
} from './merge-gates.js';
import {
  listFleetMergeStateKeys,
  lockFleetMergeState,
  newFleetMergeState,
  proposalStateKey,
  readFleetMergeState,
  unlockFleetMergeState,
  writeFleetMergeState,
  type FleetMergeStateV1,
} from './fleet-merge-state.js';
import { producerModelFamily, type ReviewModelFamily } from './reviewer-independence.js';
import type {
  FleetEngine,
  GateId,
  GateResult,
  LandingRecord,
  MergeRisk,
  RepoHold,
  WouldMergeRecord,
} from './fleet-types.js';

const DEFAULT_VERIFY_PER_PASS = 2;
const DEFAULT_JUDGE_PER_PASS = 8;
const DEFAULT_PROPOSAL_TTL_DAYS = 7;
const MIN_CHECK_BACKOFF_MS = 60_000;
const MAX_CHECK_BACKOFF_MS = 5 * 60_000;
const OWNER_LANE_RECHECK_MS = 10 * 60_000;
const WATCH_WINDOW_MS = 2 * 60 * 60 * 1000;
/** A judge that answered without a usable verdict is asked again at most this often. */
const JUDGE_RETRY_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface StandingPassSummary {
  mode: 'standing';
  grantId: string;
  stageId: string;
  /** Proposals that passed G0 this pass (entered the gate chain). */
  evaluated: number;
  prsOpened: number;
  ownerLane: number;
  wouldMerge: number;
  merged: number;
  refused: number;
  waiting: number;
  closed: number;
  landings: LandingRecord[];
  /** Short operator-facing notes (scrubbed). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface JudgeSeatLanes {
  lanes: FleetEngine[];
  nextEligibleAt: string | null;
}

export interface StandingPassDeps {
  host: HostMergeDeps;
  loadProposal: (id: string) => Proposal | null;
  setStatus: (id: string, status: 'applied' | 'rejected', result: string, reason: string) => boolean;
  verifyAndPersist: (proposal: Proposal, cfg: AshlrConfig) => Promise<VerifyAndPersistProposalResult>;
  hasCurrentVerificationBinding: (proposal: Proposal) => boolean;
  selfEvalParity: (repoPath: string, cfg: AshlrConfig) => Promise<{ ok: boolean; reason: string }>;
  isSelfRepo: (proposal: Proposal, repo: string, repoPolicy: EffectiveRepoPolicy | null) => boolean;
  /** Throws when the hold store is unreadable (G0 then treats the repo as held). */
  listHolds: () => RepoHold[];
  mergeTimes24h: (repo: string, nowMs: number) => Promise<string[] | null>;
  judgeSeatLanes: (input: { producerFamily: ReviewModelFamily; policy: EffectivePolicy; waitSinceMs: number | null; nowMs: number }) => JudgeSeatLanes;
  runJudge: (proposal: Proposal, cfg: AshlrConfig, lanes: readonly FleetEngine[]) => Promise<{ called: boolean; reason: string }>;
  /** null = the decisions ledger is degraded. */
  readDecisions: (proposalId: string, sinceMs: number | null) => DecisionEntry[] | null;
  claimIntegrity: (proposal: Proposal, cfg: AshlrConfig, policy: EffectivePolicy) => Promise<G4Input>;
  blastChecks: (proposal: Proposal, cfg: AshlrConfig) => Promise<G5Check[]>;
  openScratch: (mirror: string) => FleetGitScratch | string;
  /** The mirror's local head of `branch`; null when unknown. */
  mirrorBranchHead: (repoPath: string, branch: string) => string | null;
  /** The mirror's default branch. */
  mirrorDefaultBranch: (repoPath: string) => string | null;
  /** Lowercase `owner/name` of the mirror's origin; null when it cannot be proven. */
  originOf: (repoPath: string) => string | null;
  postMergeEffects: (proposal: Proposal, cfg: AshlrConfig) => Promise<void>;
}

function hardenedGitRead(repoPath: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repoPath, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: homedir(),
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
      stdio: 'pipe',
      timeout: 15_000,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function laneForBudgetEngine(engine: BudgetEngine): FleetEngine {
  switch (engine) {
    case 'grok': return 'grok-cli';
    case 'codex': return 'codex';
    case 'local': return 'local';
    default: return 'claude-cli';
  }
}

/**
 * Judge lanes with a seat that has autonomy headroom right now: the lanes G6
 * allows for this producer (preferred lane first, all qualifying lanes after
 * 24 h of waiting), limited to engines in the grant, seats the grant gives
 * the `judge` role, and what A9's router admits under the grant-clamped
 * budget (reserves, 5-hour ceilings — invariant I5).
 */
export function defaultJudgeSeatLanes(input: {
  producerFamily: ReviewModelFamily;
  policy: EffectivePolicy;
  waitSinceMs: number | null;
  nowMs: number;
}): JudgeSeatLanes {
  const allowed = allowedJudgeLanes(input.producerFamily, input.waitSinceMs, input.nowMs)
    .filter((lane) => input.policy.engines.includes(lane));
  if (allowed.length === 0) return { lanes: [], nextEligibleAt: null };
  const snapshot = readCapacitySnapshot();
  if (!snapshot) return { lanes: [], nextEligibleAt: null };
  const seats = snapshot.seats.filter((seat) => {
    const lane = laneForBudgetEngine(seat.engine);
    if (!allowed.includes(lane)) return false;
    const grantSeat = Object.prototype.hasOwnProperty.call(input.policy.spend.seats, seat.seatId)
      ? input.policy.spend.seats[seat.seatId]
      : undefined;
    return grantSeat !== undefined && grantSeat.enabled && grantSeat.roles.includes('judge');
  });
  if (seats.length === 0) return { lanes: [], nextEligibleAt: null };
  let budget;
  try {
    // The grant clamps A9's policy: reserve floors, 5-hour ceilings, max mode (I5).
    budget = clampBudgetPolicy(loadBudgetPolicy(), input.policy, seats.map((seat) => seat.seatId));
  } catch {
    return { lanes: [], nextEligibleAt: null };
  }
  const decision = routeSeat({ task: 'review', difficulty: 'medium', autonomous: true }, seats, budget, { nowMs: input.nowMs });
  const admitted = new Set(decision.candidates.map((id) => laneForBudgetEngine(engineOfSeatId(id))));
  const nextEligibleAt = decision.exclusions
    .map((exclusion) => exclusion.nextEligibleAt)
    .filter((at): at is string => typeof at === 'string')
    .sort()[0] ?? null;
  return { lanes: allowed.filter((lane) => admitted.has(lane)), nextEligibleAt };
}

async function defaultRunJudge(
  proposal: Proposal,
  cfg: AshlrConfig,
  lanes: readonly FleetEngine[],
): Promise<{ called: boolean; reason: string }> {
  const { resolveFrontierJudgeClient } = await import('./manager.js');
  const client = resolveFrontierJudgeClient(cfg, {
    producerModel: proposal.engineModel,
    requireIndependent: true,
    allowedJudgeEngines: lanes,
  });
  if (!client) return { called: false, reason: `no judge could be resolved on ${lanes.join(', ')}` };
  const { runAuthorizedFrontierJudge } = await import('./automerge-pass.js');
  const result = await runAuthorizedFrontierJudge(proposal, cfg, client);
  return {
    called: result.requested,
    reason: result.requested ? `judged by ${client.model}` : 'the judge call was not authorized (Stop, fence or enrollment)',
  };
}

async function defaultClaimIntegrity(proposal: Proposal, cfg: AshlrConfig, policy: EffectivePolicy): Promise<G4Input> {
  try {
    const claims = await import('../classify/completion-claims.js');
    // With no metered budget in the grant (meteredUsdPerDay 0 — the default
    // first grant) the per-call classifier is never used: the deterministic
    // heuristic judges the claim, the diff supplies the fact.
    const useModel = policy.spend.meteredUsdPerDay > 0;
    const claim = useModel
      ? (await claims.classifyCompletionClaim(proposal.summary, cfg)).claim
      : claims.classifyCompletionClaimHeuristic(proposal.summary);
    const integrity = claims.turnIntegrity(claim, claims.changedFileCountFromDiff(proposal.diff));
    return { integrity, claim, classifier: useModel ? 'model' : 'heuristic', describe: claims.describeTurnIntegrity(integrity) };
  } catch (error) {
    return { integrity: null, claim: null, classifier: 'heuristic', error: error instanceof Error ? error.message : String(error) };
  }
}

/** G5 is SPEC "unchanged": exactly master's flag-gated additive checks. */
async function defaultBlastChecks(proposal: Proposal, cfg: AshlrConfig): Promise<G5Check[]> {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  const checks: G5Check[] = [];
  const detailOf = (value: unknown, fallback: string): string => (typeof value === 'string' && value ? value : fallback);
  if (foundry?.['blastRadius'] === true) {
    try {
      const { analyzeBlastRadius } = await import('../run/blast-radius.js');
      const scope = measureAutoMergeDiffScope(proposal.diff);
      const br = await analyzeBlastRadius(
        { repo: proposal.repo ?? '', changedFiles: scope.ok ? scope.touchedPaths : [] },
        cfg as unknown as import('../run/blast-radius.js').BlastRadiusConfig,
      ) as { risk?: unknown; detail?: unknown };
      const risk = br?.risk;
      if (risk !== 'none' && risk !== 'low' && risk !== 'medium' && risk !== 'high') {
        checks.push({ name: 'blast-radius', outcome: 'error', detail: 'untrustworthy result' });
      } else {
        checks.push({ name: 'blast-radius', outcome: risk === 'high' ? 'blocked' : 'ok', detail: detailOf(br.detail, `risk ${risk}`) });
      }
    } catch (error) {
      checks.push({ name: 'blast-radius', outcome: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  if (foundry?.['redTeam'] === true) {
    try {
      const { redTeamProposal } = await import('./red-team.js');
      const rt = await redTeamProposal(proposal, cfg) as { verdict?: unknown; detail?: unknown };
      if (rt?.verdict !== 'broken' && rt?.verdict !== 'survived') {
        checks.push({ name: 'red-team', outcome: 'error', detail: 'untrustworthy result' });
      } else {
        checks.push({ name: 'red-team', outcome: rt.verdict === 'broken' ? 'blocked' : 'ok', detail: detailOf(rt.detail, `red team: ${rt.verdict}`) });
      }
    } catch (error) {
      checks.push({ name: 'red-team', outcome: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const specId = (proposal as unknown as Record<string, unknown>)['specId'];
  if (foundry?.['specContract'] === true && typeof specId === 'string' && specId) {
    try {
      const { loadSpec } = await import('../spec/spec-store.js');
      const { checkSpecContract } = await import('../run/spec-contract.js');
      const loaded = loadSpec(specId, proposal.repo ?? undefined);
      if (!loaded) {
        checks.push({ name: 'spec-contract', outcome: 'error', detail: `spec '${specId}' could not be loaded` });
      } else {
        const sc = await checkSpecContract(
          { spec: { meta: loaded.meta, body: loaded.body }, repoDir: proposal.repo ?? undefined, diff: proposal.diff },
          cfg,
        ) as { satisfied?: unknown; detail?: unknown };
        if (typeof sc?.satisfied !== 'boolean') {
          checks.push({ name: 'spec-contract', outcome: 'error', detail: 'untrustworthy result' });
        } else {
          const reason = (sc.detail as Record<string, unknown> | undefined)?.['reason'];
          checks.push({ name: 'spec-contract', outcome: sc.satisfied ? 'ok' : 'blocked', detail: detailOf(reason, sc.satisfied ? 'satisfied' : 'spec contract unsatisfied') });
        }
      }
    } catch (error) {
      checks.push({ name: 'spec-contract', outcome: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return checks;
}

export function defaultStandingPassDeps(): StandingPassDeps {
  return {
    host: defaultHostMergeDeps(),
    loadProposal: (id) => loadProposal(id),
    setStatus: (id, status, result, reason) => setStatus(id, status, result, reason, undefined, {}, 'pending'),
    verifyAndPersist: (proposal, cfg) => verifyAndPersistProposal(proposal, cfg, 'auto-merge'),
    hasCurrentVerificationBinding: (proposal) => hasCurrentVerificationBinding(proposal),
    selfEvalParity: (repoPath, cfg) => selfEvalParityForRepo(repoPath, cfg),
    isSelfRepo: (proposal, repo, repoPolicy) =>
      (repoPolicy?.selfRepo ?? null) !== null || repo.toLowerCase() === 'ashlrai/ashlr-hub' || isSelfTargetProposal(proposal),
    // U4's store; a throw is "unreadable" and G0 treats the repo as held.
    listHolds: () => listRepoHolds(),
    mergeTimes24h: async (repo, nowMs) => {
      // B-U1's incrementally verified index (new bytes only per read) — a full
      // readLedger per pending proposal per tick would re-hash the whole chain.
      try {
        const snapshot = ledgerSnapshot('cached');
        if (snapshot.chain === 'broken') return null;
        const since = nowMs - 24 * 60 * 60 * 1000;
        const lower = repo.toLowerCase();
        return snapshot.index.evidence
          .filter((row) => row.kind === 'merge:landed' && row.repo?.toLowerCase() === lower && Date.parse(row.at) > since)
          .map((row) => row.at);
      } catch {
        return null;
      }
    },
    judgeSeatLanes: (input) => defaultJudgeSeatLanes(input),
    runJudge: (proposal, cfg, lanes) => defaultRunJudge(proposal, cfg, lanes),
    readDecisions: (proposalId, sinceMs) => {
      try {
        const decisions = readDecisions({ proposalId, ...(sinceMs !== null ? { sinceMs } : {}), requireComplete: true });
        const quality = (decisions as DecisionEntry[] & { sourceQuality?: { sourceState?: string; complete?: boolean } }).sourceQuality;
        if (quality && (quality.sourceState === 'degraded' || quality.complete !== true)) return null;
        return decisions;
      } catch {
        return null;
      }
    },
    claimIntegrity: (proposal, cfg, policy) => defaultClaimIntegrity(proposal, cfg, policy),
    blastChecks: (proposal, cfg) => defaultBlastChecks(proposal, cfg),
    openScratch: (mirror) => openGitScratch(mirror),
    mirrorBranchHead: (repoPath, branch) => {
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch)) return null;
      const head = hardenedGitRead(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
      return head && /^[0-9a-f]{40}$/.test(head) ? head : null;
    },
    mirrorDefaultBranch: (repoPath) => {
      // U6's state record first: it lives outside the clone (agents can reach
      // the clone's refs and HEAD, not ~/.ashlr/fleet/mirror-state). The git
      // reads below are the fallback for a mirror U6 has not recorded yet.
      const nameWithOwner = fleetMirrorNameWithOwner(repoPath);
      const recorded = nameWithOwner ? readMirrorState(nameWithOwner)?.base ?? null : null;
      if (recorded) return recorded;
      const sym = hardenedGitRead(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      if (sym && sym.includes('/')) return sym.slice(sym.indexOf('/') + 1);
      const current = hardenedGitRead(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      return current && current !== 'HEAD' ? current : null;
    },
    originOf: (repoPath) => resolveGitHubOriginAuthority(repoPath),
    postMergeEffects: async (proposal, cfg) => {
      const { runAuthorizedPostMergeEffects } = await import('./automerge-pass.js');
      await runAuthorizedPostMergeEffects(proposal, cfg);
    },
  };
}

// ---------------------------------------------------------------------------
// Mirrors
// ---------------------------------------------------------------------------

/**
 * The fleet mirrors root. WHY delegate: U6 (fleet/mirrors.ts) owns the layout;
 * a second copy of the path rule here could drift and silently classify a
 * Mason checkout as fleet work (or every mirror as not).
 */
export function fleetMirrorsRoot(): string {
  return u6FleetMirrorsRoot();
}

/**
 * `owner/name` for a proposal repo that is exactly a fleet mirror directory
 * (`~/.ashlr/fleet/mirrors/<owner>__<name>`), else null — U6's canonical
 * inverse (strict owner/name parse, symlinked spellings resolved). Never throws.
 */
export function fleetMirrorNameWithOwner(repoPath: string | null | undefined): string | null {
  if (typeof repoPath !== 'string' || repoPath.length === 0) return null;
  try {
    return mirrorNameForPath(repoPath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

interface PassContext {
  cfg: AshlrConfig;
  policy: EffectivePolicy;
  deps: StandingPassDeps;
  out: AutoMergePassResult;
  summary: StandingPassSummary;
  budget: { verify: number; judge: number };
  /**
   * Required checks per (repo, base) for THIS pass: every open PR on a repo
   * shares them, and the installation token's rate limit is per App install
   * (5,000 requests / hour), so they are read once per pass, not once per PR.
   */
  requiredChecks: Map<string, Awaited<ReturnType<typeof readRequiredChecks>>>;
  /** This pass's fleet merge times per repo (lowercase) — read once, then extended by this pass's own landings. */
  mergeTimes: Map<string, string[] | null>;
}

function positiveIntConfig(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Merge times for G0's daily cap, read once per repo per pass. A landing made
 * earlier in the SAME pass is appended (finishLanding), so two PRs of one
 * repo can never both squeeze under the cap in a single pass.
 */
async function mergeTimesFor(ctx: PassContext, repo: string): Promise<string[] | null> {
  const key = repo.toLowerCase();
  if (!ctx.mergeTimes.has(key)) ctx.mergeTimes.set(key, await ctx.deps.mergeTimes24h(repo, ctx.deps.host.nowMs()));
  const times = ctx.mergeTimes.get(key)!;
  return times === null ? null : [...times];
}

function note(ctx: PassContext, text: string): void {
  if (ctx.summary.notes.length < 50) ctx.summary.notes.push(scrubSecrets(text).slice(0, 300));
}

function skip(ctx: PassContext, proposalId: string, check: string, reason: string): void {
  ctx.out.skipped.push({ proposalId, check, reason: scrubSecrets(reason).slice(0, 400) });
}

/**
 * Run one standing-grant pass. Never throws; every failure fails closed for
 * the proposal it concerns and is visible in `summary.notes` / `out.skipped`.
 */
export async function runStandingMergePass(input: {
  cfg: AshlrConfig;
  policy: EffectivePolicy;
  pending: readonly Proposal[];
  out: AutoMergePassResult;
  deps?: Partial<StandingPassDeps>;
}): Promise<StandingPassSummary> {
  const summary: StandingPassSummary = {
    mode: 'standing',
    grantId: input.policy.grantId,
    stageId: input.policy.rollout.stageId,
    evaluated: 0,
    prsOpened: 0,
    ownerLane: 0,
    wouldMerge: 0,
    merged: 0,
    refused: 0,
    waiting: 0,
    closed: 0,
    landings: [],
    notes: [],
  };
  const foundry = input.cfg.foundry as Record<string, unknown> | undefined;
  const autoMerge = foundry?.['autoMerge'] as Record<string, unknown> | undefined;
  const ctx: PassContext = {
    cfg: input.cfg,
    policy: input.policy,
    deps: { ...defaultStandingPassDeps(), ...input.deps },
    out: input.out,
    summary,
    budget: {
      verify: positiveIntConfig(autoMerge?.['verifyBeforeJudgePerPass'], DEFAULT_VERIFY_PER_PASS),
      judge: positiveIntConfig(foundry?.['judgePerPass'], DEFAULT_JUDGE_PER_PASS),
    },
    requiredChecks: new Map(),
    mergeTimes: new Map(),
  };
  try {
    const keys = listFleetMergeStateKeys();
    if (keys === null) {
      note(ctx, 'the fleet merge state directory is unreadable; no fleet PR was progressed this pass');
    } else {
      for (const key of keys) {
        if (ctx.deps.host.killActive()) break;
        await progressFleetPr(key, ctx);
      }
    }
    const pending = [...input.pending].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    for (const proposal of pending) {
      if (ctx.deps.host.killActive()) break;
      await evaluateProposal(proposal, ctx);
    }
  } catch (error) {
    note(ctx, `standing pass aborted: ${error instanceof Error ? error.message : String(error)}`);
  }
  input.out.standing = summary;
  input.out.landings = [...(input.out.landings ?? []), ...summary.landings];
  return summary;
}

// ---------------------------------------------------------------------------
// Gate rows
// ---------------------------------------------------------------------------

function recordGate(
  ctx: PassContext,
  state: FleetMergeStateV1,
  gate: GateId,
  evaluation: GateEvaluation,
  headSha: string | null,
): GateResult | null {
  const row = buildGateResult({
    gate,
    proposalId: state.proposalId ?? state.key,
    repo: state.repo,
    headSha,
    evaluation,
    nowMs: ctx.deps.host.nowMs(),
  });
  const grantId = ctx.deps.host.policy()?.grantId ?? ctx.policy.grantId;
  const written = recordGateRow(state, row, grantId, (r, g) => {
    const result = ctx.deps.host.appendLedger({ kind: 'gate:result', data: r, actor: 'daemon', grantId: g, repo: state.repo });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  });
  if (!written.ok) {
    note(ctx, `${state.repo}: the ledger refused the ${gate} row (${written.reason}); the proposal waits`);
    return null;
  }
  return row;
}

function persist(ctx: PassContext, state: FleetMergeStateV1): boolean {
  const ok = writeFleetMergeState(state);
  if (!ok) note(ctx, `${state.repo}: fleet merge state for ${state.key} could not be written`);
  return ok;
}

function rejectProposal(ctx: PassContext, state: FleetMergeStateV1, proposal: Proposal, gate: GateId, evaluation: GateEvaluation): void {
  const reason = `fleet gate ${gate} refused (${evaluation.code}): ${evaluation.reason}`;
  ctx.deps.setStatus(proposal.id, 'rejected', scrubSecrets(reason).slice(0, 500), `standing gate ${gate}: ${evaluation.code}`);
  state.outcome = 'rejected';
  state.outcomeReason = `${gate}:${evaluation.code}`;
  persist(ctx, state);
  ctx.summary.refused++;
  skip(ctx, proposal.id, `standing-${gate}`, reason);
}

// ---------------------------------------------------------------------------
// Phase 2: pending proposals → G0 … G6 → App PR
// ---------------------------------------------------------------------------

function explicitConfigCaps(cfg: AshlrConfig): { maxRisk?: RiskClass; maxFiles?: number; maxLines?: number } {
  const autoMerge = (cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge'] as Record<string, unknown> | undefined;
  const out: { maxRisk?: RiskClass; maxFiles?: number; maxLines?: number } = {};
  if (autoMerge?.['maxRisk'] === 'low' || autoMerge?.['maxRisk'] === 'medium') out.maxRisk = autoMerge['maxRisk'] as RiskClass;
  const files = autoMerge?.['maxAutomergeFiles'];
  const lines = autoMerge?.['maxAutomergeLines'];
  if (typeof files === 'number' && Number.isSafeInteger(files) && files > 0) out.maxFiles = files;
  if (typeof lines === 'number' && Number.isSafeInteger(lines) && lines > 0) out.maxLines = lines;
  return out;
}

function referencesEphemeralAshlrPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\\/g, '/');
  return normalized.includes('/.ashlr/sandboxes/') || /\/\.ashlr\/tmp\/vwt-[^/\s"'`)]*/.test(normalized);
}

function cleanupReason(proposal: Proposal, cfg: AshlrConfig, nowMs: number): string | null {
  const rec = proposal as unknown as Record<string, unknown>;
  if (rec['workSource'] === 'goal' && typeof proposal.title === 'string' &&
    proposal.title.includes('Fix regression in') && referencesEphemeralAshlrPath(proposal.title)) {
    return 'auto-rejected: proposal came from an ephemeral Ashlr temp-worktree regression goal';
  }
  const ttlDays = positiveIntConfig((cfg.foundry as Record<string, unknown> | undefined)?.['proposalTtlDays'], DEFAULT_PROPOSAL_TTL_DAYS);
  const createdMs = Date.parse(proposal.createdAt);
  if (ttlDays > 0 && Number.isFinite(createdMs) && createdMs < nowMs - ttlDays * 24 * 60 * 60 * 1000) {
    return `auto-rejected: proposal older than ${ttlDays} days (TTL)`;
  }
  return null;
}

async function evaluateProposal(proposal: Proposal, ctx: PassContext): Promise<void> {
  const { deps, policy } = ctx;
  const key = proposalStateKey(proposal.id);
  if (!key) return;
  const dirRepo = fleetMirrorNameWithOwner(proposal.repo);
  // Not a fleet mirror ⇒ not fleet work: it stays in the inbox for Mason.
  if (!dirRepo || !proposal.repo) return;
  const repoPolicyAtStart = repoPolicyFor(policy, dirRepo);
  const repo = repoPolicyAtStart?.nameWithOwner ?? dirRepo;
  const origin = deps.originOf(proposal.repo);
  if (!origin || origin.toLowerCase() !== repo.toLowerCase()) {
    note(ctx, `${proposal.repo}: the mirror's origin (${origin ?? 'unreadable'}) is not ${repo}; skipped`);
    return;
  }
  const lock = lockFleetMergeState(key, 0);
  if (!lock) return;
  let scratch: FleetGitScratch | null = null;
  try {
    const read = readFleetMergeState(key);
    if (read.state === 'corrupt') {
      note(ctx, `${repo}: fleet merge state for ${proposal.id} is unreadable (${read.reason}); skipped`);
      return;
    }
    if (read.state === 'ok' && (read.record.pr !== null || read.record.outcome !== null)) return;
    const state = read.state === 'ok' ? read.record : newFleetMergeState({
      key,
      kind: 'change',
      proposalId: proposal.id,
      revertsLandingId: null,
      repo,
      repoPath: proposal.repo,
      enforcement: repoPolicyAtStart?.enforcement ?? null,
      nowIso: iso(deps.host.nowMs()),
    });
    const nowMs = deps.host.nowMs();
    const cleanup = cleanupReason(proposal, ctx.cfg, nowMs);
    if (cleanup) {
      deps.setStatus(proposal.id, 'rejected', cleanup, cleanup);
      skip(ctx, proposal.id, 'standing-cleanup', cleanup);
      return;
    }
    const diff = proposal.diff ?? '';
    if ((proposal.kind !== 'patch' && proposal.kind !== 'pr') || !diff.trim()) {
      skip(ctx, proposal.id, 'standing-shape', 'not a patch/pr proposal with a diff');
      return;
    }

    // ── G0 — authority ───────────────────────────────────────────────────
    const producerFamily = producerModelFamily(proposal.engineModel);
    const decisionsSince = Number.isFinite(Date.parse(proposal.createdAt)) ? Date.parse(proposal.createdAt) - 60_000 : null;
    const g6Preview = evaluateG6({
      proposalId: proposal.id,
      producerModel: proposal.engineModel,
      diff,
      decisions: deps.readDecisions(proposal.id, decisionsSince),
      nowMs,
    });
    const waitSinceMs = state.judgeWaitSince ? Date.parse(state.judgeWaitSince) : null;
    // A judge seat matters only when no valid verdict exists yet.
    const seat = g6Preview.verdict !== 'pass' && g6Preview.needsJudge
      ? deps.judgeSeatLanes({ producerFamily, policy, waitSinceMs, nowMs })
      : null;
    let holds: RepoHold[] | null;
    try {
      holds = deps.listHolds();
    } catch {
      holds = null;
    }
    const g0 = evaluateG0({
      purpose: 'change',
      // The LIVE policy: a grant revoked or a switch lowered mid-pass must be
      // seen here (never fall back to the pass-start snapshot).
      policy: deps.host.policy(),
      repo,
      killOn: deps.host.killActive(),
      holds,
      mergeTimes24h: repoPolicyAtStart ? await mergeTimesFor(ctx, repo) : [],
      judgeLanes: seat ? seat.lanes : null,
      judgeNextEligibleAt: seat?.nextEligibleAt ?? null,
      nowMs,
    });
    if (!recordGate(ctx, state, 'G0', g0, null)) {
      persist(ctx, state);
      return;
    }
    if (g0.verdict !== 'pass') {
      if (g0.code === 'no-judge-seat' && !state.judgeWaitSince) state.judgeWaitSince = iso(nowMs);
      persist(ctx, state);
      ctx.summary.waiting++;
      skip(ctx, proposal.id, 'standing-G0', g0.reason);
      return;
    }
    const livePolicy = deps.host.policy();
    const repoPolicy = livePolicy ? repoPolicyFor(livePolicy, repo) : null;
    if (!livePolicy || !repoPolicy) {
      persist(ctx, state);
      return;
    }
    state.enforcement = repoPolicy.enforcement;
    ctx.summary.evaluated++;
    ctx.out.attempted++;

    // ── G1 — protected paths ─────────────────────────────────────────────
    const scope = measureAutoMergeDiffScope(diff);
    const selfRepo = deps.isSelfRepo(proposal, repo, repoPolicy);
    const baseBranch = deps.mirrorDefaultBranch(proposal.repo);
    const mirrorBase = baseBranch ? deps.mirrorBranchHead(proposal.repo, baseBranch) : null;
    const opened = deps.openScratch(proposal.repo);
    if (typeof opened === 'string') {
      note(ctx, `${repo}: ${opened}`);
      persist(ctx, state);
      return;
    }
    scratch = opened;
    const testsImporting = selfRepo && scope.ok
      ? tier1TestImports(scratch, mirrorBase, scope.touchedPaths, diff)
      : new Set<string>();
    const g1 = evaluateG1({ paths: scope.ok ? scope.touchedPaths : null, selfRepo, testsImportingTier1: testsImporting });
    if (!recordGate(ctx, state, 'G1', g1, null)) {
      persist(ctx, state);
      return;
    }
    if (g1.verdict === 'refuse') return rejectProposal(ctx, state, proposal, 'G1', g1);
    if (g1.verdict === 'owner-lane') {
      await openOwnerLanePr(ctx, state, proposal, scratch, baseBranch, mirrorBase, g1.reason);
      return;
    }

    // ── G1b — tampering ──────────────────────────────────────────────────
    const g1b = evaluateG1b(diff);
    if (!recordGate(ctx, state, 'G1b', g1b, null)) {
      persist(ctx, state);
      return;
    }
    if (g1b.verdict !== 'pass') return rejectProposal(ctx, state, proposal, 'G1b', g1b);

    // ── G2 — risk and scope ──────────────────────────────────────────────
    const risk = classifyRisk(proposal);
    const g2 = evaluateG2({
      partial: proposal.isPartial === true,
      provenance: verifyProvenance(proposal),
      risk,
      scope: scope.ok ? { files: scope.files, changedLines: scope.changedLines } : null,
      repoPolicy,
      mergePolicy: livePolicy.merge,
      config: explicitConfigCaps(ctx.cfg),
      producerLocal: producerFamily === 'local' || producerFamily === 'unknown',
    });
    if (!recordGate(ctx, state, 'G2', g2, null)) {
      persist(ctx, state);
      return;
    }
    if (g2.verdict !== 'pass') {
      // A grant / stage cap can rise when the rollout advances, so a change
      // over THAT cap stays pending (its row is deduplicated). The local-author
      // and local-enforcement ceilings are compiled in and never rise: those
      // (and high risk, provenance, partial captures) are rejected.
      if (/^(?:risk|files|lines)-over-cap$/.test(g2.code)) {
        persist(ctx, state);
        ctx.summary.waiting++;
        skip(ctx, proposal.id, 'standing-G2', g2.reason);
        return;
      }
      return rejectProposal(ctx, state, proposal, 'G2', g2);
    }
    state.risk = (risk === 'high' ? 'medium' : risk) as MergeRisk;
    if (scope.ok) {
      state.files = scope.files;
      state.linesAdded = scope.additions;
      state.linesDeleted = scope.deletions;
    }
    const colon = (proposal.engineModel ?? '').indexOf(':');
    state.producer = {
      engine: colon > 0 ? proposal.engineModel!.slice(0, colon) : proposal.engineModel ?? 'unknown',
      model: colon > 0 ? proposal.engineModel!.slice(colon + 1) : null,
      family: producerFamily === 'unknown' ? null : producerFamily,
      seatId: null,
    };

    // ── G3 — verification ────────────────────────────────────────────────
    const g3 = await runG3(ctx, state, proposal, scratch);
    if (!g3) return;
    if (g3.verdict === 'refuse') return rejectProposal(ctx, state, proposal, 'G3', g3);
    if (g3.verdict !== 'pass') {
      persist(ctx, state);
      ctx.summary.waiting++;
      skip(ctx, proposal.id, 'standing-G3', g3.reason);
      return;
    }

    // ── G4 — claims ──────────────────────────────────────────────────────
    const g4 = evaluateG4(await deps.claimIntegrity(proposal, ctx.cfg, livePolicy));
    if (!recordGate(ctx, state, 'G4', g4, null)) {
      persist(ctx, state);
      return;
    }
    if (g4.verdict !== 'pass') return rejectProposal(ctx, state, proposal, 'G4', g4);

    // ── G5 — blast radius ────────────────────────────────────────────────
    const g5 = evaluateG5(await deps.blastChecks(proposal, ctx.cfg));
    if (!recordGate(ctx, state, 'G5', g5, null)) {
      persist(ctx, state);
      return;
    }
    if (g5.verdict !== 'pass') return rejectProposal(ctx, state, proposal, 'G5', g5);

    // ── G6 — judge ───────────────────────────────────────────────────────
    let g6 = g6Preview.verdict === 'pass' ? g6Preview : evaluateG6({
      proposalId: proposal.id,
      producerModel: proposal.engineModel,
      diff,
      decisions: deps.readDecisions(proposal.id, decisionsSince),
      nowMs: deps.host.nowMs(),
    });
    const judgeCalledMs = state.judgeCalledAt ? Date.parse(state.judgeCalledAt) : Number.NaN;
    const judgeRecentlyCalled = Number.isFinite(judgeCalledMs) && deps.host.nowMs() - judgeCalledMs < JUDGE_RETRY_MS;
    if (g6.verdict !== 'pass' && g6.needsJudge && !judgeRecentlyCalled) {
      const lanes = (seat ?? deps.judgeSeatLanes({ producerFamily, policy: livePolicy, waitSinceMs, nowMs })).lanes;
      if (lanes.length > 0 && ctx.budget.judge > 0) {
        ctx.budget.judge--;
        state.judgeCalledAt = iso(deps.host.nowMs());
        const judged = await deps.runJudge(proposal, ctx.cfg, lanes);
        if (judged.called) ctx.out.judged++;
        g6 = evaluateG6({
          proposalId: proposal.id,
          producerModel: proposal.engineModel,
          diff,
          decisions: deps.readDecisions(proposal.id, decisionsSince),
          nowMs: deps.host.nowMs(),
        });
        if (g6.verdict !== 'pass' && !judged.called) note(ctx, `${repo}: ${judged.reason}`);
      } else if (lanes.length === 0) {
        g6 = { ...g6, verdict: 'wait', code: 'no-judge-seat', reason: `${g6.reason}; no eligible judge seat has headroom (never a local or same-family judge)` };
      }
    }
    if (g6.verdict === 'wait' && g6.needsJudge && !state.judgeWaitSince) state.judgeWaitSince = iso(deps.host.nowMs());
    if (!recordGate(ctx, state, 'G6', g6, null)) {
      persist(ctx, state);
      return;
    }
    if (g6.verdict === 'refuse') return rejectProposal(ctx, state, proposal, 'G6', g6);
    if (g6.verdict !== 'pass') {
      persist(ctx, state);
      ctx.summary.waiting++;
      skip(ctx, proposal.id, 'standing-G6', g6.reason);
      return;
    }
    state.judgeId = g6.judgeId;
    state.judgeWaitSince = null;

    // ── G7 — publish the verified tree and open the App PR ───────────────
    await openChangePr(ctx, state, proposal, scratch, false, null);
  } catch (error) {
    note(ctx, `${repo}: ${proposal.id} failed closed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    closeGitScratch(scratch);
    unlockFleetMergeState(lock);
  }
}

/** Test paths the diff touches whose base content or added lines import ashlr-hub Tier-1 code. */
function tier1TestImports(
  scratch: FleetGitScratch,
  baseSha: string | null,
  touched: readonly string[],
  diff: string,
): Set<string> {
  const out = new Set<string>();
  const added = diffAddedLinesByPath(diff);
  for (const path of touched) {
    if (!path.startsWith('test/') || !isTestPath(path)) continue;
    const contents: (string | null)[] = [(added?.get(path) ?? []).join('\n')];
    if (baseSha && /^[0-9a-f]{40}$/.test(baseSha)) {
      try {
        contents.push(execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'cat-file', 'blob', `${baseSha}:${path}`], {
          env: scratch.env,
          stdio: 'pipe',
          timeout: 15_000,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        }));
      } catch {
        // New file (no base content) — the added lines above are all of it.
      }
    }
    if (testContentImportsTier1(path, contents)) out.add(path);
  }
  return out;
}

/** G3 for a change: fresh (or still-bound) verification, self-eval parity, and the exact tree. */
async function runG3(
  ctx: PassContext,
  state: FleetMergeStateV1,
  proposal: Proposal,
  scratch: FleetGitScratch,
): Promise<GateEvaluation | null> {
  const { deps } = ctx;
  const diff = proposal.diff ?? '';
  let verify: Parameters<typeof evaluateG3>[0]['verify'] = null;
  if (deps.hasCurrentVerificationBinding(proposal) && proposal.verifyResult?.passed === true) {
    const stored = proposal.verifyResult;
    verify = {
      ok: true,
      detail: stored.detail ?? 'verified earlier on the current base',
      ...(stored.baseBranch ? { baseBranch: stored.baseBranch } : {}),
      ...(stored.baseHead ? { baseHead: stored.baseHead } : {}),
      commandKinds: (stored.ran ?? []).map((command) => command.kind),
    };
  } else {
    if (ctx.budget.verify <= 0) {
      skip(ctx, proposal.id, 'standing-G3-budget', 'verification cap reached for this pass; next pass');
      persist(ctx, state);
      return { verdict: 'wait', code: 'verify-budget', reason: 'verification cap reached for this pass', inputs: {}, nextEligibleAt: null };
    }
    ctx.budget.verify--;
    try {
      const transaction = await deps.verifyAndPersist(proposal, ctx.cfg);
      if (transaction.persisted && transaction.authorityLive) {
        verify = {
          ok: transaction.verify.ok,
          detail: transaction.verify.detail,
          ...(transaction.verify.failureCategory ? { failureCategory: transaction.verify.failureCategory } : {}),
          ...(transaction.verify.baseBranch ? { baseBranch: transaction.verify.baseBranch } : {}),
          ...(transaction.verify.baseHead ? { baseHead: transaction.verify.baseHead } : {}),
          commandKinds: transaction.verify.ran.map((command) => command.kind),
        };
      } else {
        note(ctx, `${state.repo}: verification for ${proposal.id} was not persisted under live authority (${transaction.reason})`);
      }
    } catch (error) {
      note(ctx, `${state.repo}: verification for ${proposal.id} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let parity: { ok: boolean; reason: string } | null = null;
  if (verify?.ok && deps.isSelfRepo(proposal, state.repo, repoPolicyFor(ctx.policy, state.repo))) {
    try {
      parity = await deps.selfEvalParity(proposal.repo!, ctx.cfg);
    } catch (error) {
      parity = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const tree = verify?.ok && verify.baseHead ? treeForDiff(scratch, verify.baseHead, diff) : null;
  const scope = measureAutoMergeDiffScope(diff);
  const g3 = evaluateG3({
    verify,
    parity,
    tree,
    diffHash: hashDiff(diff),
    ...(tree?.ok && verify?.baseHead
      ? {
          treeChanges: {
            changes: scratchTreeChanges(scratch, verify.baseHead, tree.treeSha),
            parsedPaths: scope.ok ? scope.touchedPaths : [],
            selfRepo: deps.isSelfRepo(proposal, state.repo, repoPolicyFor(ctx.policy, state.repo)),
          },
        }
      : {}),
  });
  if (!recordGate(ctx, state, 'G3', g3, null)) {
    persist(ctx, state);
    return null;
  }
  if (g3.verdict === 'pass' && verify?.baseHead && verify.baseBranch && tree?.ok) {
    state.baseBranch = verify.baseBranch;
    state.baseSha = verify.baseHead;
    state.treeSha = tree.treeSha;
    state.diffHash = hashDiff(diff);
    state.verifyDigest = state.gates['G3']?.digest ?? null;
  }
  return g3;
}

function prBody(state: FleetMergeStateV1, proposal: Proposal, ownerLaneReason: string | null): string {
  const gateLine = (['G0', 'G1', 'G1b', 'G2', 'G3', 'G4', 'G5', 'G6'] as GateId[])
    .map((gate) => `${gate} ${state.gates[gate]?.code ?? '—'}`)
    .join(' · ');
  return [
    untrustedText(proposal.summary ?? '', 2_000, false),
    '',
    '---',
    `**ashlr fleet** · proposal \`${proposal.id}\` · producer \`${proposal.engineModel ?? 'unknown'}\` · ` +
      `${state.files ?? '?'} file(s), +${state.linesAdded ?? '?'}/−${state.linesDeleted ?? '?'}`,
    `Gates: ${gateLine}`,
    ...(state.judgeId ? [`Judge: \`${state.judgeId}\``] : []),
    ownerLaneReason
      ? `**Owner lane** — ${ownerLaneReason}. The fleet never merges this PR; it is here for review.`
      : 'The ashlr-fleet App merges this PR (squash, pinned to its head SHA) once every required check is green. Close it to stop it.',
  ].join('\n');
}

async function openChangePr(
  ctx: PassContext,
  state: FleetMergeStateV1,
  proposal: Proposal,
  scratch: FleetGitScratch,
  ownerLane: boolean,
  ownerLaneReason: string | null,
): Promise<void> {
  const { deps } = ctx;
  if (!state.baseSha || !state.treeSha || !state.baseBranch) {
    note(ctx, `${state.repo}: ${proposal.id} has no verified tree to publish`);
    persist(ctx, state);
    return;
  }
  const remoteBase = await readBranchHead(state.repo, state.baseBranch, deps.host);
  if (typeof remoteBase === 'string') {
    note(ctx, `${state.repo}: base branch unreadable: ${remoteBase}`);
    persist(ctx, state);
    return;
  }
  if (remoteBase.sha !== state.baseSha) {
    // The base moved since verification: the mirror resets to it next tick and
    // this proposal is re-verified there (the landed tree is always the verified one).
    state.gates['G3'] = undefined;
    persist(ctx, state);
    ctx.summary.waiting++;
    skip(ctx, proposal.id, 'standing-G7', `the base moved to ${remoteBase.sha?.slice(0, 12) ?? 'nothing'} since verification; re-verifying next pass`);
    return;
  }
  const branch = `${FLEET_BRANCH_PREFIX}${state.key}`;
  const published = await publishVerifiedTree({
    repo: state.repo,
    branch,
    baseSha: state.baseSha,
    treeSha: state.treeSha,
    scratch,
    commitMessage: `ashlr fleet: ${untrustedText(proposal.title, 100, true)}\n\nFleet proposal ${proposal.id}${ownerLane ? ' (owner lane)' : ''}.\n`,
  }, deps.host);
  if (!published.ok) {
    note(ctx, `${state.repo}: publishing ${proposal.id} failed (${published.code}): ${published.reason}`);
    if (!published.retryable) {
      const evaluation: GateEvaluation = {
        verdict: 'refuse',
        code: `publish-${published.code}`,
        reason: published.reason,
        inputs: { code: published.code },
        nextEligibleAt: null,
      };
      recordGate(ctx, state, 'G7', evaluation, null);
      return rejectProposal(ctx, state, proposal, 'G7', evaluation);
    }
    persist(ctx, state);
    return;
  }
  const opened = await openFleetPr({
    repo: state.repo,
    branch,
    baseBranch: state.baseBranch,
    headSha: published.headSha,
    baseSha: state.baseSha,
    treeSha: state.treeSha,
    title: `ashlr fleet: ${untrustedText(proposal.title, 100, true)}`,
    body: prBody(state, proposal, ownerLaneReason),
    ownerLane,
    ownerLaneReason,
  }, deps.host);
  if (!opened.ok) {
    note(ctx, `${state.repo}: opening the PR for ${proposal.id} failed: ${opened.reason}`);
    persist(ctx, state);
    return;
  }
  state.pr = opened.pr;
  state.openGatesDigest = openGatesDigest((['G0', 'G1', 'G1b', 'G2', 'G3', 'G4', 'G5', 'G6'] as GateId[])
    .map((gate) => ({ gate, digest: state.gates[gate]?.digest ?? 'none' })));
  const grantId = deps.host.policy()?.grantId ?? ctx.policy.grantId;
  if (!ledgerPrOpened(state, 'change', grantId, deps.host)) {
    note(ctx, `${state.repo}: PR #${opened.pr.number} is open but its pr:opened row was refused; it will not merge until ledgered`);
  }
  persist(ctx, state);
  ctx.summary.prsOpened++;
  ctx.out.handoffs++;
  if (opened.pr.ownerLane) ctx.summary.ownerLane++;
}

async function openOwnerLanePr(
  ctx: PassContext,
  state: FleetMergeStateV1,
  proposal: Proposal,
  scratch: FleetGitScratch,
  baseBranch: string | null,
  mirrorBase: string | null,
  reason: string,
): Promise<void> {
  // No verification is spent on an owner-lane change: Mason reviews it and
  // GitHub CI runs on the PR. The tree is still computed exactly (the PR head
  // is the proposal's diff on the current base, nothing more).
  if (!baseBranch || !mirrorBase) {
    note(ctx, `${state.repo}: the mirror's base could not be resolved for owner-lane proposal ${proposal.id}`);
    persist(ctx, state);
    return;
  }
  const tree = treeForDiff(scratch, mirrorBase, proposal.diff ?? '');
  if (!tree.ok) {
    if (tree.conflict) {
      const evaluation: GateEvaluation = { verdict: 'refuse', code: 'diff-does-not-apply', reason: tree.reason, inputs: {}, nextEligibleAt: null };
      recordGate(ctx, state, 'G7', evaluation, null);
      return rejectProposal(ctx, state, proposal, 'G7', evaluation);
    }
    note(ctx, `${state.repo}: ${tree.reason}`);
    persist(ctx, state);
    return;
  }
  state.baseBranch = baseBranch;
  state.baseSha = mirrorBase;
  state.treeSha = tree.treeSha;
  state.diffHash = hashDiff(proposal.diff ?? '');
  await openChangePr(ctx, state, proposal, scratch, true, reason);
}

// ---------------------------------------------------------------------------
// Phase 1: fleet PRs in flight
// ---------------------------------------------------------------------------

function schedule(ctx: PassContext, state: FleetMergeStateV1, ms: number): void {
  if (!state.pr) return;
  state.pr.nextCheckAt = iso(ctx.deps.host.nowMs() + ms);
}

function backoff(ctx: PassContext, state: FleetMergeStateV1): void {
  if (!state.pr) return;
  const next = Math.min(Math.max(state.pr.checkBackoffMs * 2, MIN_CHECK_BACKOFF_MS), MAX_CHECK_BACKOFF_MS);
  state.pr.checkBackoffMs = next;
  schedule(ctx, state, next);
}

async function progressFleetPr(key: string, ctx: PassContext): Promise<void> {
  const { deps } = ctx;
  const lock = lockFleetMergeState(key, 0);
  if (!lock) return;
  let scratch: FleetGitScratch | null = null;
  try {
    const read = readFleetMergeState(key);
    if (read.state === 'corrupt') {
      note(ctx, `fleet merge state ${key} is unreadable (${read.reason}); its PR is not progressed`);
      return;
    }
    if (read.state !== 'ok') return;
    const state = read.record;
    if (state.kind !== 'change' || !state.pr || (state.outcome !== null && state.landingLedgered)) return;
    if (state.landing && !state.landingLedgered) {
      ledgerLanding(ctx, state);
      persist(ctx, state);
      return;
    }
    const proposal = state.proposalId ? deps.loadProposal(state.proposalId) : null;
    const nowMs = deps.host.nowMs();
    if (state.outcome === null && state.pr.state === 'closed' && proposal?.status === 'pending') {
      // Closed by the Leader (class A) and never vetoed: once the proposal
      // outlives the TTL it is retired, so it does not sit pending forever.
      const expired = cleanupReason(proposal, ctx.cfg, nowMs);
      if (expired) {
        deps.setStatus(proposal.id, 'rejected', `${expired}; its fleet PR #${state.pr.number} was closed`, expired);
        state.outcome = 'closed';
        state.outcomeReason = expired;
        persist(ctx, state);
      }
      return;
    }
    if (state.outcome !== null || state.pr.state !== 'open') return;
    if (!proposal) return;
    if (proposal.status !== 'pending') {
      // Rejected — or handled outside the fleet (approved / applied / handed
      // off by hand): either way this PR must never land a second copy.
      await closeForReason(ctx, state, `the proposal is ${proposal.status} in the inbox; the fleet PR is withdrawn`, 'daemon');
      return;
    }
    if (!state.pr.ledgered) {
      if (!ledgerPrOpened(state, 'change', deps.host.policy()?.grantId ?? ctx.policy.grantId, deps.host)) {
        persist(ctx, state);
        return;
      }
    }
    if (state.pr.nextCheckAt && Date.parse(state.pr.nextCheckAt) > nowMs) return;

    const live = await readPr(state.repo, state.pr.number, deps.host);
    if (typeof live === 'string') {
      note(ctx, `${state.repo}#${state.pr.number}: ${live}`);
      backoff(ctx, state);
      persist(ctx, state);
      return;
    }
    if (live.merged) {
      await reconcileMerged(ctx, state, proposal, live);
      persist(ctx, state);
      return;
    }
    if (live.state === 'closed') {
      state.pr.state = 'closed';
      state.pr.closedBy = state.pr.closedBy ?? 'github';
      if (state.pr.closedBy === 'github') {
        deps.setStatus(proposal.id, 'rejected', `fleet PR #${live.number} was closed on GitHub`, 'fleet PR closed on GitHub');
        state.outcome = 'closed';
        state.outcomeReason = 'closed on GitHub';
        ctx.summary.closed++;
      }
      persist(ctx, state);
      return;
    }
    if (!state.pr.ownerLane && live.labels.includes(OWNER_LANE_LABEL)) {
      state.pr.ownerLane = true;
      state.pr.ownerLaneReason = `labelled ${OWNER_LANE_LABEL} on GitHub`;
    }
    if (!state.pr.ownerLane && live.authorLogin !== FLEET_APP_BOT_LOGIN) {
      state.pr.ownerLane = true;
      state.pr.ownerLaneReason = `PR #${live.number} is not authored by ${FLEET_APP_BOT_LOGIN}`;
    }
    if (state.pr.ownerLane) {
      schedule(ctx, state, OWNER_LANE_RECHECK_MS);
      persist(ctx, state);
      return;
    }
    if (live.headSha !== state.pr.headSha) {
      // Head-SHA race: someone pushed to the fleet branch. The fleet never
      // merges a head it did not verify; a human-touched PR is the owner's.
      const evaluation: GateEvaluation = {
        verdict: 'owner-lane',
        code: 'head-sha-changed',
        reason: `the PR head moved from ${state.pr.headSha.slice(0, 12)} to ${live.headSha.slice(0, 12)} outside the fleet; it goes to the owner lane`,
        inputs: { expected: state.pr.headSha, observed: live.headSha },
        nextEligibleAt: null,
      };
      recordGate(ctx, state, 'G7', evaluation, live.headSha);
      await labelOwnerLane(state.repo, live.number, deps.host);
      state.pr.ownerLane = true;
      state.pr.ownerLaneReason = evaluation.reason;
      ctx.summary.ownerLane++;
      persist(ctx, state);
      return;
    }
    const remoteBase = await readBranchHead(state.repo, state.pr.baseBranch, deps.host);
    if (typeof remoteBase === 'string' || remoteBase.sha === null) {
      note(ctx, `${state.repo}: base branch unreadable: ${typeof remoteBase === 'string' ? remoteBase : 'missing'}`);
      backoff(ctx, state);
      persist(ctx, state);
      return;
    }
    if (remoteBase.sha !== state.pr.baseSha) {
      const opened = deps.openScratch(state.repoPath);
      scratch = typeof opened === 'string' ? null : opened;
      await rebuildOnNewBase(ctx, state, proposal, remoteBase.sha, scratch);
      persist(ctx, state);
      return;
    }

    // ── G7 — required checks on the exact head ─────────────────────────
    const cacheKey = `${state.repo.toLowerCase()}\0${state.pr.baseBranch}`;
    let required = ctx.requiredChecks.get(cacheKey);
    if (required === undefined) {
      required = await readRequiredChecks(state.repo, state.pr.baseBranch, deps.host);
      ctx.requiredChecks.set(cacheKey, required);
    }
    const checks = typeof required === 'string' ? null : await readHeadChecks(state.repo, state.pr.headSha, deps.host);
    const g7c = evaluateG7Checks({
      enforcement: state.enforcement ?? 'server',
      required: typeof required === 'string' ? null : required.required,
      runs: checks && typeof checks !== 'string' ? checks.runs : null,
      statuses: checks && typeof checks !== 'string' ? checks.statuses : null,
      pendingSinceMs: Date.parse(state.pr.openedAt) || nowMs,
      nowMs,
    });
    state.pr.checks = { state: g7c.state, detail: g7c.reason, at: iso(nowMs) };
    if (g7c.verdict === 'owner-lane') {
      recordGate(ctx, state, 'G7', g7c, state.pr.headSha);
      await labelOwnerLane(state.repo, state.pr.number, deps.host);
      state.pr.ownerLane = true;
      state.pr.ownerLaneReason = g7c.reason;
      ctx.summary.ownerLane++;
      persist(ctx, state);
      return;
    }
    if (g7c.verdict === 'refuse') {
      recordGate(ctx, state, 'G7', g7c, state.pr.headSha);
      await closeForReason(ctx, state, g7c.reason, 'daemon');
      deps.setStatus(proposal.id, 'rejected', `fleet gate G7 refused (${g7c.code}): ${g7c.reason}`, `standing gate G7: ${g7c.code}`);
      state.outcome = 'rejected';
      state.outcomeReason = `G7:${g7c.code}`;
      ctx.summary.refused++;
      persist(ctx, state);
      return;
    }
    if (g7c.verdict === 'wait') {
      recordGate(ctx, state, 'G7', g7c, state.pr.headSha);
      backoff(ctx, state);
      ctx.summary.waiting++;
      persist(ctx, state);
      return;
    }
    if (typeof required === 'string') return;

    // ── G0 again, at merge time ─────────────────────────────────────────
    let holds: RepoHold[] | null;
    try {
      holds = deps.listHolds();
    } catch {
      holds = null;
    }
    const livePolicy = deps.host.policy();
    const g0 = evaluateG0({
      purpose: 'change',
      policy: livePolicy,
      repo: state.repo,
      killOn: deps.host.killActive(),
      holds,
      mergeTimes24h: await mergeTimesFor(ctx, state.repo),
      judgeLanes: null,
      nowMs,
    });
    if (!recordGate(ctx, state, 'G0', g0, state.pr.headSha)) {
      persist(ctx, state);
      return;
    }
    if (g0.verdict !== 'pass' || !livePolicy) {
      backoff(ctx, state);
      ctx.summary.waiting++;
      persist(ctx, state);
      return;
    }
    const repoPolicy = repoPolicyFor(livePolicy, state.repo);
    if (!repoPolicy) {
      backoff(ctx, state);
      persist(ctx, state);
      return;
    }
    const g7 = g7MergeEvaluation({
      headSha: state.pr.headSha,
      baseSha: state.pr.baseSha,
      treeSha: state.pr.treeSha,
      checks: g7c,
      protectionDigest: required.protectionDigest,
      strictUpToDate: required.strict,
    });
    if (!recordGate(ctx, state, 'G7', g7, state.pr.headSha)) {
      persist(ctx, state);
      return;
    }
    const withheld = mergeWithheldBecause(livePolicy, repoPolicy);
    if (withheld !== null) {
      recordWouldMerge(ctx, state, withheld);
      schedule(ctx, state, OWNER_LANE_RECHECK_MS);
      persist(ctx, state);
      return;
    }
    await landPr(ctx, state, proposal, livePolicy, required.protectionDigest);
    persist(ctx, state);
  } catch (error) {
    note(ctx, `fleet PR ${key} failed closed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    closeGitScratch(scratch);
    unlockFleetMergeState(lock);
  }
}

function recordWouldMerge(ctx: PassContext, state: FleetMergeStateV1, withheld: WouldMergeRecord['withheldBecause']): void {
  const pr = state.pr!;
  if (pr.wouldMergeHeadSha === pr.headSha) return;
  let gatesDigest: string;
  try {
    gatesDigest = combinedGatesDigest(gateMemoRows(state));
  } catch (error) {
    note(ctx, `${state.repo}#${pr.number}: would-merge not recorded (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  const record: WouldMergeRecord = {
    v: 1,
    proposalId: state.proposalId ?? state.key,
    repo: state.repo,
    headSha: pr.headSha,
    gatesDigest,
    withheldBecause: withheld,
    risk: state.risk ?? 'low',
    files: state.files ?? 0,
    linesAdded: state.linesAdded ?? 0,
    linesDeleted: state.linesDeleted ?? 0,
    at: iso(ctx.deps.host.nowMs()),
  };
  const row = ctx.deps.host.appendLedger({
    kind: 'gate:would-merge',
    data: record,
    actor: 'daemon',
    grantId: ctx.deps.host.policy()?.grantId ?? ctx.policy.grantId,
    repo: state.repo,
  });
  if (!row.ok) {
    note(ctx, `${state.repo}#${pr.number}: the would-merge row was refused (${row.reason})`);
    return;
  }
  pr.wouldMergeHeadSha = pr.headSha;
  ctx.summary.wouldMerge++;
}

function gateMemoRows(state: FleetMergeStateV1): { gate: GateId; digest: string; verdict: GateResult['verdict'] }[] {
  return (['G0', 'G1', 'G1b', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as GateId[]).flatMap((gate) => {
    const memo = state.gates[gate];
    return memo ? [{ gate, digest: memo.digest, verdict: memo.verdict }] : [];
  });
}

async function landPr(
  ctx: PassContext,
  state: FleetMergeStateV1,
  proposal: Proposal,
  policy: EffectivePolicy,
  protectionDigest: string,
): Promise<void> {
  const { deps } = ctx;
  const pr = state.pr!;
  let gatesDigest: string;
  try {
    gatesDigest = combinedGatesDigest(gateMemoRows(state));
  } catch (error) {
    note(ctx, `${state.repo}#${pr.number}: not merged — ${error instanceof Error ? error.message : String(error)}`);
    backoff(ctx, state);
    return;
  }
  let ledgerHead: string;
  try {
    const head = deps.host.ledgerHead();
    if (!head) {
      note(ctx, `${state.repo}#${pr.number}: not merged — the authority ledger is empty`);
      return;
    }
    ledgerHead = head.hash;
  } catch (error) {
    note(ctx, `${state.repo}#${pr.number}: not merged — ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const epoch = policyEpochDigest(policy, state.repo);
  if (!epoch) return;
  const trailers = { grantId: policy.grantId, gatesDigest, ledgerHead, stageId: policy.rollout.stageId };
  const outcome = await mergeFleetPrPinned({
    state,
    trailers,
    commitTitle: `ashlr fleet: ${untrustedText(proposal.title, 200, true)} (#${pr.number})`,
    commitMessage: fleetMergeCommitMessage(
      `${untrustedText(proposal.summary ?? '', 1_500, false)}\n\nMerged by the ashlr-fleet App under a standing grant: every gate G0–G7 passed on ${pr.headSha}.`,
      { ...trailers, proposalId: proposal.id },
    ),
    identity: {
      evidencePackDigest: gatesDigest,
      verifierManifestDigest: state.verifyDigest ?? state.gates['G3']?.digest ?? gatesDigest,
      protectionPolicyDigest: protectionDigest,
      policyEpoch: epoch,
    },
    currentPolicyEpoch: () => policyEpochDigest(deps.host.policy(), state.repo),
    recheck: async () => {
      if (deps.host.killActive()) return 'Stop is on';
      let holds: RepoHold[] | null;
      try {
        holds = deps.listHolds();
      } catch {
        holds = null;
      }
      const g0 = evaluateG0({
        purpose: 'change',
        policy: deps.host.policy(),
        repo: state.repo,
        killOn: deps.host.killActive(),
        holds,
        mergeTimes24h: await mergeTimesFor(ctx, state.repo),
        judgeLanes: null,
        nowMs: deps.host.nowMs(),
      });
      if (g0.verdict !== 'pass') return `G0 no longer passes: ${g0.reason}`;
      const live = await readPr(state.repo, pr.number, deps.host);
      if (typeof live === 'string') return `PR #${pr.number} could not be re-read: ${live}`;
      if (live.state !== 'open' || live.merged) return `PR #${pr.number} is no longer open`;
      if (live.headSha !== pr.headSha) return `PR #${pr.number}'s head moved off the verified commit`;
      if (live.labels.includes(OWNER_LANE_LABEL)) return `PR #${pr.number} was labelled ${OWNER_LANE_LABEL}`;
      const base = await readBranchHead(state.repo, pr.baseBranch, deps.host);
      if (typeof base === 'string' || base.sha !== pr.baseSha) return 'the base branch moved; the PR is rebuilt on the new base';
      return null;
    },
  }, deps.host);
  if (!outcome.ok) {
    note(ctx, `${state.repo}#${pr.number}: not merged (${outcome.code}): ${outcome.reason}`);
    if (outcome.code === 'head-changed') {
      await labelOwnerLane(state.repo, pr.number, deps.host);
      pr.ownerLane = true;
      pr.ownerLaneReason = outcome.reason;
      ctx.summary.ownerLane++;
    } else if (outcome.mergeCalled && outcome.code === 'github') {
      // The PUT went out and its answer was lost: the next pass reads the PR
      // and reconciles from what GitHub actually did — never a blind retry.
      schedule(ctx, state, MIN_CHECK_BACKOFF_MS);
    } else {
      backoff(ctx, state);
    }
    ctx.summary.waiting++;
    return;
  }
  finishLanding(ctx, state, proposal, policy, outcome.mergeSha, outcome.landedAt, trailers);
  await deps.postMergeEffects(proposal, ctx.cfg).catch(() => undefined);
}

function finishLanding(
  ctx: PassContext,
  state: FleetMergeStateV1,
  proposal: Proposal,
  policy: Pick<EffectivePolicy, 'grantId' | 'rollout'> | null,
  mergeSha: string,
  landedAt: string,
  trailers: { grantId: string; gatesDigest: string; ledgerHead: string; stageId: string },
): void {
  const pr = state.pr!;
  const landing: LandingRecord = {
    v: 1,
    id: landingId(state.repo, pr.number, mergeSha),
    kind: 'merge',
    repo: state.repo,
    baseBranch: pr.baseBranch,
    prNumber: pr.number,
    headSha: pr.headSha,
    mergeSha,
    proposalId: proposal.id,
    revertsLandingId: null,
    grantId: trailers.grantId,
    rolloutStageId: policy?.rollout.stageId ?? trailers.stageId,
    gatesDigest: trailers.gatesDigest,
    ledgerHead: trailers.ledgerHead,
    enforcement: state.enforcement ?? 'server',
    risk: state.risk ?? 'low',
    files: state.files ?? 0,
    linesAdded: state.linesAdded ?? 0,
    linesDeleted: state.linesDeleted ?? 0,
    producer: state.producer,
    judgeId: state.judgeId,
    proposedAt: proposal.createdAt ?? null,
    landedAt,
    watchUntil: iso(Date.parse(landedAt) + WATCH_WINDOW_MS),
  };
  state.landing = landing;
  state.outcome = 'merged';
  state.outcomeReason = `merged as ${mergeSha}`;
  pr.state = 'merged';
  ledgerLanding(ctx, state);
  ctx.deps.setStatus(
    proposal.id,
    'applied',
    `merged by the ashlr-fleet App: ${state.repo}#${pr.number} → ${mergeSha.slice(0, 12)}`,
    'fleet host merge (standing grant)',
  );
  ctx.summary.merged++;
  ctx.summary.landings.push(landing);
  ctx.out.merged++;
  const times = ctx.mergeTimes.get(state.repo.toLowerCase());
  if (times) times.push(landedAt);
}

/** Ledger `merge:landed`; a refusal leaves landingLedgered=false and the next pass retries. */
function ledgerLanding(ctx: PassContext, state: FleetMergeStateV1): void {
  if (!state.landing || state.landingLedgered) return;
  const row = ctx.deps.host.appendLedger({
    kind: 'merge:landed',
    data: state.landing,
    actor: 'daemon',
    grantId: state.landing.grantId,
    repo: state.repo,
  });
  if (row.ok) state.landingLedgered = true;
  else note(ctx, `${state.repo}: landing ${state.landing.id} is merged but not yet ledgered (${row.reason}); retrying next pass`);
}

async function reconcileMerged(ctx: PassContext, state: FleetMergeStateV1, proposal: Proposal, live: PrSnapshot): Promise<void> {
  const { deps } = ctx;
  const attempt = state.merge;
  const mergeSha = live.mergeCommitSha;
  if (attempt && (attempt.phase === 'consumed' || attempt.phase === 'merged') && attempt.trailers && mergeSha) {
    // Our PUT reached GitHub even if its answer did not reach us: prove it from
    // the commit's trailers before claiming the landing.
    const commit = await readRemoteCommit(state.repo, mergeSha, deps.host);
    const trailers = typeof commit === 'string' ? null : parseFleetTrailers(commit.message);
    if (trailers && trailers['Ashlr-Proposal']?.[0] === proposal.id && trailers['Ashlr-Gates']?.[0] === attempt.trailers.gatesDigest) {
      finishLanding(ctx, state, proposal, deps.host.policy(), mergeSha, live.mergedAt ?? iso(deps.host.nowMs()), attempt.trailers);
      return;
    }
  }
  // Merged by someone other than the fleet (Mason, on GitHub): not a fleet
  // landing, so the post-merge watch and the rollout never count it.
  state.pr!.state = 'merged';
  state.outcome = 'merged';
  state.outcomeReason = 'merged on GitHub outside the fleet';
  deps.setStatus(proposal.id, 'applied', `fleet PR ${state.repo}#${live.number} was merged on GitHub (not by the fleet)`, 'merged outside the fleet');
  note(ctx, `${state.repo}#${live.number} was merged outside the fleet; no landing recorded`);
}

async function closeForReason(ctx: PassContext, state: FleetMergeStateV1, reason: string, actor: 'daemon' | 'mason'): Promise<void> {
  const pr = state.pr!;
  const result = await closeFleetPr({ repo: state.repo, number: pr.number, reason, actor }, ctx.deps.host);
  if (result.ok || result.state === 'closed') {
    pr.state = 'closed';
    pr.closedBy = actor;
    state.outcome = 'closed';
    state.outcomeReason = reason;
    ctx.summary.closed++;
  } else {
    note(ctx, `${state.repo}#${pr.number}: could not be closed: ${result.reason}`);
    backoff(ctx, state);
  }
  persist(ctx, state);
}

/**
 * The base moved under an open fleet PR. Re-verify the SAME diff on the new
 * base in the mirror (once the mirror has caught up), rebuild the head
 * commit, and force-move the fleet branch — required checks then run again
 * on the new head. Keeps "the landed tree is exactly the verified tree"
 * true without ever merging a stale PR.
 */
async function rebuildOnNewBase(
  ctx: PassContext,
  state: FleetMergeStateV1,
  proposal: Proposal,
  remoteBaseSha: string,
  scratch: FleetGitScratch | null,
): Promise<void> {
  const { deps } = ctx;
  const pr = state.pr!;
  const mirrorBase = deps.mirrorBranchHead(state.repoPath, pr.baseBranch);
  if (mirrorBase !== remoteBaseSha || !scratch) {
    // U6 resets the mirror to origin/<base> every tick; wait for it.
    schedule(ctx, state, MIN_CHECK_BACKOFF_MS);
    ctx.summary.waiting++;
    return;
  }
  const g3 = await runG3(ctx, state, proposal, scratch);
  if (!g3) return;
  if (g3.verdict === 'refuse') {
    await commentOnPr(state.repo, pr.number, `The base moved and this change no longer verifies: ${g3.reason}`, deps.host);
    await closeForReason(ctx, state, `base moved; re-verification refused (${g3.code})`, 'daemon');
    deps.setStatus(proposal.id, 'rejected', `fleet gate G3 refused after the base moved (${g3.code}): ${g3.reason}`, `standing gate G3: ${g3.code}`);
    state.outcome = 'rejected';
    ctx.summary.refused++;
    return;
  }
  if (g3.verdict !== 'pass' || !state.treeSha || state.baseSha !== remoteBaseSha) {
    backoff(ctx, state);
    ctx.summary.waiting++;
    return;
  }
  const published = await publishVerifiedTree({
    repo: state.repo,
    branch: pr.branch,
    baseSha: state.baseSha,
    treeSha: state.treeSha,
    scratch,
    commitMessage: `ashlr fleet: ${untrustedText(proposal.title, 100, true)}\n\nFleet proposal ${proposal.id}, rebuilt on ${remoteBaseSha.slice(0, 12)}.\n`,
  }, deps.host);
  if (!published.ok) {
    note(ctx, `${state.repo}#${pr.number}: rebuild failed (${published.code}): ${published.reason}`);
    if (published.code === 'branch-foreign') {
      await labelOwnerLane(state.repo, pr.number, deps.host);
      pr.ownerLane = true;
      pr.ownerLaneReason = published.reason;
    } else {
      backoff(ctx, state);
    }
    return;
  }
  pr.headSha = published.headSha;
  pr.baseSha = remoteBaseSha;
  pr.treeSha = state.treeSha;
  pr.openedAt = iso(deps.host.nowMs());
  pr.checks = null;
  pr.wouldMergeHeadSha = null;
  pr.checkBackoffMs = 0;
  schedule(ctx, state, MIN_CHECK_BACKOFF_MS);
  note(ctx, `${state.repo}#${pr.number}: rebuilt on the new base ${remoteBaseSha.slice(0, 12)}`);
}

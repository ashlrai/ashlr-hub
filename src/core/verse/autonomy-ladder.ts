/**
 * The autonomy ladder and its shadow decisions, as Verse shows them (3.14).
 *
 *   GET /api/verse/authority                    + `ladder`    (AutonomyLadderV1)
 *   GET /api/verse/authority/ledger?view=decisions
 *                                               → ShadowDecisionsV1
 *
 * Both are ADDITIVE on the existing authority routes (authority-api.ts):
 * `ladder` is one more field on the status body, and `view=decisions` is one
 * more way to read the ledger. Nothing here writes, signs or decides — the
 * rollout itself stays in authority/rollout.ts (evaluateRollout /
 * stepRolloutUnderLock). This module only re-shapes what those already
 * recorded so the operator can see it:
 *
 *   ladder     every signed stage of the installed grant (id, the repos that
 *              MERGE at it and the ones that only propose, the risk / size
 *              caps, the criteria to leave it), where the ledger says we
 *              are, and the ladder's last move (with a regression's breach).
 *   decisions  one row per proposal the merge gates saw, newest first: its
 *              G0–G7 verdicts (the last one per gate), the outcome (would
 *              merge, merged, refused at a gate, owner lane, waiting), WHY in
 *              one sentence, and the stage that was current when it was
 *              decided. Plus every rollout move (advance / regress) so a
 *              regression is never buried under gate rows.
 *
 * WHY HERE AND NOT IN authority/: everything under src/core/authority is on
 * the authority surface closure's own roots; a display projection has no
 * business changing what a grant pins. Types-only imports from authority/
 * and fleet/ keep this a leaf for the browser as well (the web imports its
 * types).
 *
 * Honesty rule: null = unknown. A would-merge digest is a CLAIM that every
 * gate passed at that head; the gate chips are the rows that say so.
 */
import type { StandingEvaluation } from '../authority/effective-config.js';
import type { AuthorityStatusV1, LedgerEntry, LedgerReadResult, RolloutCriteria, RolloutStage } from '../authority/types.js';
import type { GateId, GateVerdict, MergeRisk, WouldMergeRecord } from '../fleet/fleet-types.js';

// ---------------------------------------------------------------------------
// Contract (browser-safe: types and plain constants only)
// ---------------------------------------------------------------------------

export interface AutonomyLadderStageV1 {
  id: string;
  /** 0-based position on the signed ladder. */
  index: number;
  /** Repos (owner/name) this stage lets MERGE. [] in shadow. */
  merging: string[];
  /** Repos this stage lets run but only PROPOSE. */
  proposing: string[];
  maxRisk: MergeRisk;
  maxFiles: number;
  maxLines: number;
  maxMergesPerRepoPerDay: number;
  criteria: RolloutCriteria;
  /**
   * What `criteria.minMerges` counts at this stage: landed merges, or — where
   * no repo merges (shadow) — complete would-merge digests (rollout.ts).
   */
  counts: 'merges' | 'would-merge digests';
}

export interface AutonomyLadderMoveV1 {
  move: 'advanced' | 'regressed';
  fromStageId: string | null;
  toStageId: string;
  at: string;
  /** The breach behind a regression; null for an advance. */
  breach: string | null;
}

export interface AutonomyLadderV1 {
  v: 1;
  grantId: string;
  stages: AutonomyLadderStageV1[];
  /** Where the ledger says the grant stands; null = no position (never accepted, or disagrees with the signed ladder). */
  currentIndex: number | null;
  /** The ladder's last move for this grant; null = still on the rung it was signed at. */
  lastMove: AutonomyLadderMoveV1 | null;
}

/**
 * GET /api/verse/authority as served: AuthorityStatusV1 plus the ladder.
 * Additive — a client that predates it ignores the field, and a day-0
 * fixture without it reads as "no ladder" (optional on the client side).
 */
export type AuthorityStatusWithLadder = AuthorityStatusV1 & { ladder: AutonomyLadderV1 | null };

export type ShadowDecisionOutcome = 'would-merge' | 'merged' | 'refused' | 'owner-lane' | 'waiting' | 'in-progress';

export interface ShadowGateVerdictV1 {
  gate: GateId;
  verdict: GateVerdict;
  /** Stable machine reason (`protected-path`, `risk-over-cap`…). */
  code: string;
  /** One scrubbed sentence. */
  reason: string;
  at: string;
}

export interface ShadowDecisionV1 {
  proposalId: string;
  /** owner/name. */
  repo: string;
  /** First 7 of the head SHA the verdicts are bound to; null before a head existed. */
  headShort: string | null;
  /** The fleet PR carrying it, when one was opened. */
  prNumber: number | null;
  outcome: ShadowDecisionOutcome;
  /** For `would-merge`: why the merge was withheld. */
  withheldBecause: WouldMergeRecord['withheldBecause'] | null;
  /** From the would-merge digest; null when there is none. */
  risk: MergeRisk | null;
  files: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  /** The last verdict per gate, in GATE_ORDER; gates that never reported are absent. */
  gates: ShadowGateVerdictV1[];
  /** One sentence: why it would (or would not) merge. */
  why: string;
  /**
   * 3.15 elite self-land: the elite model's label when G6 passed on tests
   * alone (no judge) — "Landed directly · elite model <label> · tests green".
   * Absent / null otherwise (additive).
   */
  eliteModel?: string | null;
  /** The ladder stage current when the latest row was written; null = no grant was in force. */
  stageId: string | null;
  grantId: string | null;
  /** Newest row about this proposal. */
  at: string;
}

export interface ShadowDecisionsV1 {
  v: 1;
  /** Newest first, at most `limit`. */
  decisions: ShadowDecisionV1[];
  /** Every rollout move, newest first (advances and regressions). */
  moves: AutonomyLadderMoveV1[];
  /** Would-merge digests per stage id over the rows read (what shadow's criterion counts, before its entry cut). */
  wouldMergeByStage: Record<string, number>;
  chain: LedgerReadResult['chain'];
  reason: string | null;
  /** Head seq the answer was built from; null for an empty ledger. */
  headSeq: number | null;
  /** True when the read hit its row cap, so older decisions may be missing. */
  truncated: boolean;
}

/** The query value that selects the decisions view on GET …/authority/ledger. */
export const LEDGER_DECISIONS_VIEW = 'decisions';

/** Gate order, repeated as a literal so this module stays types-only at runtime (fleet-types' GATE_ORDER). */
const GATES: readonly GateId[] = ['G0', 'G1', 'G1b', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

/** The ledger kinds the decisions view reads. */
export const DECISION_LEDGER_KINDS = [
  'grant:accepted',
  'rollout:advanced',
  'rollout:regressed',
  'gate:result',
  'gate:would-merge',
  'pr:opened',
  'merge:landed',
] as const satisfies readonly LedgerEntry['kind'][];

// ---------------------------------------------------------------------------
// Ladder (from the status evaluation — no I/O)
// ---------------------------------------------------------------------------

function stageView(stage: RolloutStage, index: number): AutonomyLadderStageV1 {
  const merging = stage.repos.filter((r) => r.stage === 'merge').map((r) => r.nameWithOwner);
  const proposing = stage.repos.filter((r) => r.stage !== 'merge').map((r) => r.nameWithOwner);
  return {
    id: stage.id,
    index,
    merging,
    proposing,
    maxRisk: stage.maxRisk,
    maxFiles: stage.maxFiles,
    maxLines: stage.maxLines,
    maxMergesPerRepoPerDay: stage.maxMergesPerRepoPerDay,
    criteria: { ...stage.criteria },
    // rollout.ts: a stage where no repo is at `merge` counts would-merge digests.
    counts: merging.length > 0 ? 'merges' : 'would-merge digests',
  };
}

/** PURE: the installed grant's ladder as the status shows it; null with no grant. */
export function autonomyLadder(ev: Pick<StandingEvaluation, 'grant' | 'position' | 'lastRolloutMove'>): AutonomyLadderV1 | null {
  const grant = ev.grant;
  if (!grant) return null;
  const move = ev.lastRolloutMove && ev.lastRolloutMove.grantId === grant.grantId ? ev.lastRolloutMove : null;
  return {
    v: 1,
    grantId: grant.grantId,
    stages: grant.rollout.stages.map(stageView),
    currentIndex: ev.position ? ev.position.stageIndex : null,
    lastMove: move
      ? { move: move.move, fromStageId: move.fromStageId, toStageId: move.stageId, at: move.enteredAt, breach: move.breach }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Decisions (from ledger rows — pure; the route reads the rows)
// ---------------------------------------------------------------------------

const WITHHELD_WHY: Record<WouldMergeRecord['withheldBecause'], string> = {
  shadow: 'the ladder is in shadow, so it only proposes',
  'stage-propose': 'this repo only proposes at the current stage',
  'switch-propose': 'the switch is at Propose',
};

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const capped = t.length > 280 ? `${t.slice(0, 279)}…` : t;
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
}

interface Building {
  proposalId: string;
  repo: string;
  headSha: string | null;
  prNumber: number | null;
  gates: Map<GateId, ShadowGateVerdictV1>;
  wouldMerge: WouldMergeRecord | null;
  landed: boolean;
  /** 3.15: from the landing row (LandingRecord.eliteModel). */
  landedElite: string | null;
  stageId: string | null;
  grantId: string | null;
  at: string;
  seq: number;
}


/**
 * authority/elite-models.ts ELITE_DIRECT_G6_CODE / ELITE_DIRECT_STAGE_ID,
 * copied (not imported) so this stays a types-only leaf; a test pins them equal.
 */
export const LADDER_ELITE_G6_CODE = 'elite-direct';
export const LADDER_ELITE_STAGE_ID = 'elite-direct';

/**
 * 3.15: the elite model's label when this proposal passed G6 on tests alone —
 * from the landing row, else from the G6 row's reason ("elite model <label>
 * (engine:model) under …"); null when it was judged (or is unknown).
 */
function eliteModelOf(b: Building): string | null {
  if (b.landedElite) return b.landedElite;
  const g6 = b.gates.get('G6');
  if (!g6 || g6.verdict !== 'pass' || g6.code !== LADDER_ELITE_G6_CODE) return null;
  return /^elite model (.{1,60}?) \(/u.exec(g6.reason)?.[1] ?? 'unnamed';
}

function decide(b: Building): Pick<ShadowDecisionV1, 'outcome' | 'why' | 'eliteModel'> {
  const ordered = GATES.map((g) => b.gates.get(g)).filter((v): v is ShadowGateVerdictV1 => v !== undefined);
  // A later would-merge / landing supersedes any earlier refusal only when the
  // gates that refused were re-run and passed: the last verdict per gate wins.
  const stop = ordered.find((v) => v.verdict !== 'pass') ?? null;
  const eliteModel = eliteModelOf(b);
  if (b.landed) {
    return eliteModel
      ? { outcome: 'merged', why: `Landed directly · elite model ${eliteModel} · tests green.`, eliteModel }
      : { outcome: 'merged', why: 'Every gate passed and it merged.', eliteModel: null };
  }
  if (b.wouldMerge && (!stop || Date.parse(b.wouldMerge.at) >= Date.parse(stop.at))) {
    if (eliteModel) {
      const held = b.wouldMerge.withheldBecause === 'shadow' && b.stageId !== LADDER_ELITE_STAGE_ID
        ? 'elite-direct is no longer the current stage, so this unjudged change waits for you'
        : WITHHELD_WHY[b.wouldMerge.withheldBecause] ?? 'the merge was withheld';
      return { outcome: 'would-merge', why: `Every gate passed on tests alone (elite model ${eliteModel}, no judge); held because ${held}.`, eliteModel };
    }
    return { outcome: 'would-merge', why: `Every gate passed; held because ${WITHHELD_WHY[b.wouldMerge.withheldBecause] ?? 'the merge was withheld'}.` };
  }
  if (stop) {
    const why = sentence(stop.reason) || `${stop.code}.`;
    if (stop.verdict === 'refuse') return { outcome: 'refused', why: `Refused at ${stop.gate}: ${why}` };
    if (stop.verdict === 'owner-lane') return { outcome: 'owner-lane', why: `${stop.gate} sent it to the owner lane: ${why}` };
    return { outcome: 'waiting', why: `Waiting at ${stop.gate}: ${why}` };
  }
  const last = ordered[ordered.length - 1];
  return {
    outcome: 'in-progress',
    why: last ? `Passed through ${last.gate}; the remaining gates have not reported yet.` : 'The gates have not reported yet.',
  };
}

/**
 * PURE: the decisions view over ledger rows (oldest first, as readLedger
 * returns them). `limit` caps the decisions (newest first); moves are all
 * returned (they are rare — at most one per tick, and a ladder has ≤ 8 rungs).
 */
export function shadowDecisionsFromLedger(
  read: Pick<LedgerReadResult, 'entries' | 'chain' | 'reason' | 'head'>,
  opts: { limit?: number; truncated?: boolean } = {},
): ShadowDecisionsV1 {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 40));
  const byProposal = new Map<string, Building>();
  const moves: AutonomyLadderMoveV1[] = [];
  const wouldMergeByStage: Record<string, number> = {};
  /** Current stage per grant, walked in ledger order. */
  const stageOf = new Map<string, string>();

  const touch = (proposalId: string, repo: string, entry: LedgerEntry): Building => {
    let b = byProposal.get(proposalId);
    if (!b) {
      b = { proposalId, repo, headSha: null, prNumber: null, gates: new Map(), wouldMerge: null, landed: false, landedElite: null, stageId: null, grantId: null, at: entry.at, seq: entry.seq };
      byProposal.set(proposalId, b);
    }
    b.at = entry.at;
    b.seq = entry.seq;
    b.grantId = entry.grantId;
    b.stageId = entry.grantId ? stageOf.get(entry.grantId) ?? null : null;
    return b;
  };

  for (const entry of read.entries) {
    switch (entry.kind) {
      case 'grant:accepted': {
        const first = entry.data.stageIds[0];
        if (first) stageOf.set(entry.data.grantId, first);
        break;
      }
      case 'rollout:advanced':
      case 'rollout:regressed': {
        stageOf.set(entry.data.grantId, entry.data.toStageId);
        moves.push({
          move: entry.kind === 'rollout:advanced' ? 'advanced' : 'regressed',
          fromStageId: entry.data.fromStageId,
          toStageId: entry.data.toStageId,
          at: entry.at,
          breach: entry.kind === 'rollout:regressed' ? sentence(entry.data.breach) || null : null,
        });
        break;
      }
      case 'gate:result': {
        const r = entry.data;
        const b = touch(r.proposalId, r.repo, entry);
        if (r.headSha && r.headSha !== b.headSha) {
          // A new head re-runs the gates: verdicts bound to the old head no longer describe it.
          if (b.headSha !== null) b.gates.clear();
          b.headSha = r.headSha;
        }
        b.gates.set(r.gate, { gate: r.gate, verdict: r.verdict, code: r.code, reason: sentence(r.reason), at: r.at });
        break;
      }
      case 'gate:would-merge': {
        const r = entry.data;
        const b = touch(r.proposalId, r.repo, entry);
        b.wouldMerge = r;
        if (r.headSha) b.headSha = r.headSha;
        if (b.stageId) wouldMergeByStage[b.stageId] = (wouldMergeByStage[b.stageId] ?? 0) + 1;
        break;
      }
      case 'pr:opened': {
        const r = entry.data;
        if (r.kind !== 'change' || !r.proposalId) break;
        const b = byProposal.get(r.proposalId);
        if (b) b.prNumber = r.number;
        break;
      }
      case 'merge:landed': {
        const r = entry.data;
        if (!r.proposalId) break;
        const b = touch(r.proposalId, r.repo, entry);
        b.landed = true;
        if (typeof r.eliteModel === 'string') b.landedElite = r.eliteModel.trim().replace(/\s+/g, ' ').slice(0, 60) || null;
        if (typeof r.prNumber === 'number') b.prNumber = r.prNumber;
        break;
      }
      default:
        break;
    }
  }

  const decisions = [...byProposal.values()]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, limit)
    .map((b): ShadowDecisionV1 => {
      const { outcome, why, eliteModel } = decide(b);
      const w = b.wouldMerge;
      return {
        proposalId: b.proposalId,
        repo: b.repo,
        headShort: b.headSha ? b.headSha.slice(0, 7) : null,
        prNumber: b.prNumber,
        outcome,
        withheldBecause: outcome === 'would-merge' && w ? w.withheldBecause : null,
        risk: w?.risk ?? null,
        files: w?.files ?? null,
        linesAdded: w?.linesAdded ?? null,
        linesDeleted: w?.linesDeleted ?? null,
        gates: GATES.map((g) => b.gates.get(g)).filter((v): v is ShadowGateVerdictV1 => v !== undefined),
        why,
        ...(eliteModel ? { eliteModel } : {}),
        stageId: b.stageId,
        grantId: b.grantId,
        at: b.at,
      };
    });

  return {
    v: 1,
    decisions,
    moves: moves.reverse(),
    wouldMergeByStage,
    chain: read.chain,
    reason: read.reason,
    headSeq: read.head?.seq ?? null,
    truncated: opts.truncated ?? false,
  };
}

// ---------------------------------------------------------------------------
// The route's read (cached by ledger head)
// ---------------------------------------------------------------------------

/** How many ledger rows the decisions view reads at most (newest). */
export const DECISIONS_ROW_CAP = 4_000;

let decisionsCache: { key: string; limit: number; value: ShadowDecisionsV1 } | null = null;

export interface ShadowDecisionsDeps {
  readLedger: (opts: { kinds: readonly LedgerEntry['kind'][]; limit: number }) => Promise<LedgerReadResult>;
  /**
   * The ledger head as the status evaluation already knows it (cheap), or
   * undefined when it cannot be had without a read. An unchanged head skips
   * the read entirely.
   */
  head?: () => { seq: number; hash: string } | null | undefined;
}

function headKey(head: { seq: number; hash: string } | null | undefined): string | null {
  if (head === undefined) return null;
  return head ? `${head.seq}:${head.hash}` : 'empty';
}

/**
 * The decisions view. One ledger read per new head: the ledger is
 * append-only, so an unchanged head (seq + hash) is an unchanged answer and
 * Command's and Fleet's polls cost nothing between fleet ticks.
 */
export async function readShadowDecisions(deps: ShadowDecisionsDeps, limit = 40): Promise<ShadowDecisionsV1> {
  let known: string | null = null;
  try {
    known = headKey(deps.head?.());
  } catch {
    known = null;
  }
  if (known !== null && decisionsCache && decisionsCache.key === known && decisionsCache.limit === limit) return decisionsCache.value;
  const read = await deps.readLedger({ kinds: DECISION_LEDGER_KINDS, limit: DECISIONS_ROW_CAP });
  const value = shadowDecisionsFromLedger(read, { limit, truncated: read.entries.length >= DECISIONS_ROW_CAP });
  // Keyed by the head the READ saw (a broken chain is never cached: it may heal on a new grant).
  const key = read.chain === 'broken' ? null : headKey(read.head);
  decisionsCache = key === null ? null : { key, limit, value };
  return value;
}

/** Test hook. */
export function resetShadowDecisionsCacheForTest(): void {
  decisionsCache = null;
}

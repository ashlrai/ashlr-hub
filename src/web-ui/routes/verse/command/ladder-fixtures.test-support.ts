/**
 * routes/verse/command/ladder-fixtures.test-support.ts — the 3.14 ladder and
 * shadow-decision payloads, typed by the real server contract
 * (core/verse/autonomy-ladder.ts) so a contract change fails the typecheck.
 *
 * `shadowStatus` is the state autonomy was first activated in: grant #1
 * active for 30 days, switch Autonomous, stage 1 of 8 "shadow".
 */
import type { AuthorityStatusV1, RolloutCriteria } from '../../../../core/authority/types.js';
import type {
  AutonomyLadderStageV1,
  AutonomyLadderV1,
  AuthorityStatusWithLadder,
  ShadowDecisionV1,
  ShadowDecisionsV1,
} from '../../../../core/verse/autonomy-ladder.js';
import type { GateId } from '../../../../core/fleet/fleet-types.js';
import { authorityStatus } from './fixtures.test-support.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const crit = (minMerges: number, minPostMergeGreenPct: number, maxRevertRatePct: number, minHours: number): RolloutCriteria =>
  ({ minMerges, minPostMergeGreenPct, maxRevertRatePct, minHours, maxSandboxViolations: 0, reserveBreaches: 0 });

function s(id: string, index: number, merging: string[], proposing: string[], phase3: boolean, criteria: RolloutCriteria): AutonomyLadderStageV1 {
  return {
    id,
    index,
    merging,
    proposing,
    maxRisk: phase3 ? 'medium' : 'low',
    maxFiles: phase3 ? 10 : 4,
    maxLines: phase3 ? 300 : 150,
    maxMergesPerRepoPerDay: id === 'shadow' ? 0 : phase3 ? 12 : 6,
    criteria,
    counts: merging.length > 0 ? 'merges' : 'would-merge digests',
  };
}

const P2 = ['ashlrai/ashlrcode', 'ashlrai/fleet-canary'];

/** The default 8-rung ladder (standing-grant.ts DEFAULT_ROLLOUT_STAGES). */
export function defaultLadder(grantId: string, currentIndex = 0, lastMove: AutonomyLadderV1['lastMove'] = null): AutonomyLadderV1 {
  return {
    v: 1,
    grantId,
    currentIndex,
    lastMove,
    stages: [
      s('shadow', 0, [], [...P2, 'ashlrai/binshield'], false, crit(5, 0, 0, 12)),
      s('2a', 1, P2, ['ashlrai/binshield'], false, crit(3, 100, 0, 8)),
      s('2b', 2, [...P2, 'ashlrai/binshield'], [], false, crit(10, 90, 10, 24)),
      s('2c', 3, [...P2, 'ashlrai/binshield'], [], false, crit(25, 95, 10, 48)),
      s('3a', 4, [...P2, 'ashlrai/binshield', 'ashlrai/ashlr-plugin'], [], true, crit(5, 95, 5, 24)),
      s('3b', 5, [...P2, 'ashlrai/binshield', 'ashlrai/ashlr-plugin'], ['ashlrai/ashlr-pulse'], true, crit(5, 95, 5, 24)),
      s('3c', 6, [...P2, 'ashlrai/binshield', 'ashlrai/ashlr-plugin', 'ashlrai/locus', 'ashlrai/phantom-secrets'], ['ashlrai/ashlr-pulse'], true, crit(5, 95, 5, 24)),
      s('3d', 7, [...P2, 'ashlrai/binshield', 'ashlrai/ashlr-plugin', 'ashlrai/locus', 'ashlrai/phantom-secrets', 'ashlrai/measurably', 'ashlrai/ashlr-hub'], ['ashlrai/ashlr-pulse', 'ashlrai/ashlr-cortex'], true, crit(10, 95, 5, 24)),
    ],
  };
}

/** Autonomy just activated: shadow, 1 of 8, `digests` of 5 would-merge digests, `hours` of 12 h. */
export function shadowStatus(now = Date.now(), opts: { digests?: number; hours?: number; expiresInMs?: number; kill?: boolean; lastMove?: AutonomyLadderV1['lastMove'] } = {}): AuthorityStatusWithLadder {
  const base = authorityStatus('live', now);
  const digests = opts.digests ?? 0;
  const hours = opts.hours ?? 0;
  const ladder = defaultLadder(base.grant.grantId!, 0, opts.lastMove ?? null);
  const unmet = [
    ...(digests < 5 ? [`${digests} of 5 would-merge digests`] : []),
    ...(hours < 12 ? [`${Math.floor(hours)} h of 12 h`] : []),
  ];
  const status: AuthorityStatusV1 = {
    ...base,
    kill: opts.kill ?? false,
    grant: {
      ...base.grant,
      grantSeq: 1,
      issuedAt: iso(now - hours * HOUR),
      expiresAt: iso(now + (opts.expiresInMs ?? 30 * DAY - hours * HOUR)),
      stageIds: ladder.stages.map((st) => st.id),
    },
    rollout: {
      stageId: 'shadow',
      stageIndex: 0,
      stageCount: 8,
      enteredAt: iso(now - hours * HOUR),
      hoursInStage: hours,
      merges: digests,
      postMergeGreenPct: null,
      revertRatePct: null,
      sandboxViolations: 0,
      reserveBreaches: 0,
      criteria: ladder.stages[0]!.criteria,
      nextStageId: '2a',
      met: unmet.length === 0,
      unmet,
    },
  };
  return { ...status, ladder };
}

const ALL: GateId[] = ['G0', 'G1', 'G1b', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];

function passes(gates: GateId[], at: string): ShadowDecisionV1['gates'] {
  return gates.map((gate) => ({ gate, verdict: 'pass', code: 'ok', reason: `${gate} passed.`, at }));
}

export function wouldMergeDecision(now: number, over: Partial<ShadowDecisionV1> = {}): ShadowDecisionV1 {
  const at = iso(now - 2 * HOUR);
  return {
    proposalId: 'prop-ashlrcode-1',
    repo: 'ashlrai/ashlrcode',
    headShort: 'a1b2c3d',
    prNumber: 12,
    outcome: 'would-merge',
    withheldBecause: 'shadow',
    risk: 'low',
    files: 2,
    linesAdded: 30,
    linesDeleted: 4,
    gates: passes(ALL, at),
    why: 'Every gate passed; held because the ladder is in shadow, so it only proposes.',
    stageId: 'shadow',
    grantId: 'g',
    at,
    ...over,
  };
}

export function refusedDecision(now: number): ShadowDecisionV1 {
  const at = iso(now - 5 * HOUR);
  return {
    proposalId: 'prop-canary-2',
    repo: 'ashlrai/fleet-canary',
    headShort: 'ffee001',
    prNumber: null,
    outcome: 'refused',
    withheldBecause: null,
    risk: null,
    files: null,
    linesAdded: null,
    linesDeleted: null,
    gates: [...passes(['G0', 'G1', 'G1b'], at), { gate: 'G2', verdict: 'refuse', code: 'protected-path', reason: 'The diff touches a protected path.', at }],
    why: 'Refused at G2: The diff touches a protected path.',
    stageId: 'shadow',
    grantId: 'g',
    at,
  };
}

export function decisionsView(now: number, over: Partial<ShadowDecisionsV1> = {}): ShadowDecisionsV1 {
  return {
    v: 1,
    decisions: [wouldMergeDecision(now), refusedDecision(now)],
    moves: [],
    wouldMergeByStage: { shadow: 1 },
    chain: 'ok',
    reason: null,
    headSeq: 40,
    truncated: false,
    ...over,
  };
}

export const EMPTY_DECISIONS: ShadowDecisionsV1 = { v: 1, decisions: [], moves: [], wouldMergeByStage: {}, chain: 'empty', reason: null, headSeq: null, truncated: false };

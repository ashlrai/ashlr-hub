/**
 * routes/verse/command/ladder-model.ts — the pure decisions behind the
 * active fleet's rollout: Command's Autonomy status and Fleet's Shadow
 * decisions (3.14).
 *
 * Sources (both additive on the existing authority routes,
 * core/verse/autonomy-ladder.ts):
 *   GET /api/verse/authority                       `ladder` + `rollout`
 *   GET /api/verse/authority/ledger?view=decisions ShadowDecisionsV1
 *
 * Every number here is the SERVER's (rollout.ts evaluates the criteria); the
 * page only draws them. A value the server did not send is unknown, never 0.
 * Framework-free; tested directly.
 */
import { formatMetric } from '../../../components/charts/format-metric.js';
import type { AuthorityStatusV1 } from '../../../../core/authority/types.js';
import type { CloudTaskV1 } from '../../../../core/cloud/types.js';
import type {
  AutonomyLadderMoveV1,
  AutonomyLadderStageV1,
  AutonomyLadderV1,
  ShadowDecisionOutcome,
  ShadowDecisionV1,
  ShadowDecisionsV1,
} from '../../../../core/verse/autonomy-ladder.js';
import type { ChipTone } from './authority-model.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Re-approve is offered once the grant has less than this left (the chip warns at 3 days; this card earlier). */
export const GRANT_WARN_MS = 7 * DAY;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

function isStage(v: unknown): v is AutonomyLadderStageV1 {
  return isRecord(v) && typeof v['id'] === 'string' && typeof v['index'] === 'number' && strings(v['merging']) && strings(v['proposing'])
    && isRecord(v['criteria']) && (v['counts'] === 'merges' || v['counts'] === 'would-merge digests');
}

/** The status's `ladder`, when this server sends one this client can read. */
export function narrowLadder(status: AuthorityStatusV1 | null): AutonomyLadderV1 | null {
  const raw = status ? (status as AuthorityStatusV1 & { ladder?: unknown }).ladder : null;
  if (!isRecord(raw) || raw['v'] !== 1 || !Array.isArray(raw['stages']) || !raw['stages'].every(isStage)) return null;
  return raw as unknown as AutonomyLadderV1;
}

function isDecision(v: unknown): v is ShadowDecisionV1 {
  return isRecord(v) && typeof v['proposalId'] === 'string' && typeof v['repo'] === 'string' && typeof v['outcome'] === 'string'
    && Array.isArray(v['gates']) && typeof v['why'] === 'string' && typeof v['at'] === 'string';
}

/** GET …/ledger?view=decisions, narrowed (a row this client cannot read is dropped, never guessed). */
export function narrowDecisions(raw: unknown): ShadowDecisionsV1 | null {
  if (!isRecord(raw) || raw['v'] !== 1 || !Array.isArray(raw['decisions']) || !Array.isArray(raw['moves'])) return null;
  return {
    ...(raw as unknown as ShadowDecisionsV1),
    decisions: raw['decisions'].filter(isDecision),
    moves: (raw['moves'] as unknown[]).filter((m): m is AutonomyLadderMoveV1 => isRecord(m) && typeof m['toStageId'] === 'string' && typeof m['at'] === 'string'),
  };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "shadow" → "Shadow"; "2a" stays "2a". */
export function stageLabel(id: string): string {
  // 3.15: the elite self-land rung reads as words, not an id.
  if (id === 'elite-direct') return 'Elite direct';
  return /^[a-z]/.test(id) ? id[0]!.toUpperCase() + id.slice(1) : id;
}

/** "ashlrai/ashlrcode" → "ashlrcode" (the owner is the same everywhere in a fleet). */
export function repoShort(repo: string): string {
  const i = repo.indexOf('/');
  return i >= 0 ? repo.slice(i + 1) : repo;
}

function list(repos: readonly string[]): string {
  return repos.map(repoShort).join(', ');
}

/** "just now", "12 m ago", "3 h ago", "2 d ago" — `now` injected so it tests without a clock. */
export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'at an unknown time';
  const ms = Math.max(0, now - t);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${formatMetric(Math.floor(ms / DAY))} d ago`;
}

/** Display the recorded hours with the shared metric precision. */
function hours(n: number): string {
  return formatMetric(n);
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export type RungState = 'done' | 'current' | 'next' | 'later';

export interface RungView {
  id: string;
  label: string;
  index: number;
  state: RungState;
  merging: string[];
  proposing: string[];
  /** "Merging: ashlrcode, fleet-canary" / "Nothing merges — propose only". */
  mergeLine: string;
  /** "Proposing: binshield"; null when every repo at the stage merges. */
  proposeLine: string | null;
  /** "low risk · ≤ 4 files / 150 lines · ≤ 6 merges/repo/day". */
  capLine: string;
  /** "Leaves after 5 would-merge digests and 12 h". */
  exitLine: string;
  /** The accessible name: everything the hover card says, in one sentence. */
  aria: string;
}

export interface ProgressBar {
  key: 'evidence' | 'hours';
  label: string;
  value: number;
  max: number;
  /** "2 / 5" or "3.5 h / 12 h". */
  text: string;
  met: boolean;
}

export interface LadderView {
  stageId: string;
  /** "Shadow". */
  stageName: string;
  /** "1 of 8". */
  position: string;
  rungs: RungView[];
  /** The two criteria every stage has; the rest (green %, watches) are in `otherUnmet`. */
  bars: ProgressBar[];
  nextStageName: string | null;
  /** Every criterion met: the daemon advances on its next tick. */
  met: boolean;
  /** Unmet criteria other than the two bars ("1 post-merge watch still running"). */
  otherUnmet: string[];
  /** One line on what the NEXT stage changes ("2a lets ashlrcode, fleet-canary merge"). */
  nextLine: string | null;
}

function rung(stage: AutonomyLadderStageV1, current: number): RungView {
  const state: RungState = stage.index < current ? 'done' : stage.index === current ? 'current' : stage.index === current + 1 ? 'next' : 'later';
  const mergeLine = stage.merging.length > 0 ? `Merging: ${list(stage.merging)}` : 'Nothing merges — propose only';
  const proposeLine = stage.proposing.length > 0 ? `Proposing: ${list(stage.proposing)}` : null;
  const capLine = `${stage.maxRisk} risk · ≤ ${stage.maxFiles} files / ${stage.maxLines} lines${stage.maxMergesPerRepoPerDay > 0 ? ` · ≤ ${stage.maxMergesPerRepoPerDay} merges/repo/day` : ''}`;
  const c = stage.criteria;
  const exit = [`${c.minMerges} ${c.minMerges === 1 ? stage.counts.replace(/s$/, '') : stage.counts}`, `${c.minHours} h`];
  if (c.minPostMergeGreenPct > 0) exit.push(`≥ ${c.minPostMergeGreenPct}% green`);
  const exitLine = `Leaves after ${exit.join(', ')}`;
  const label = stageLabel(stage.id);
  const where = state === 'current' ? ' (current)' : state === 'done' ? ' (passed)' : '';
  return {
    id: stage.id,
    label,
    index: stage.index,
    state,
    merging: stage.merging,
    proposing: stage.proposing,
    mergeLine,
    proposeLine,
    capLine,
    exitLine,
    aria: [`Stage ${stage.index + 1}, ${label}${where}`, mergeLine, proposeLine, capLine, exitLine].filter(Boolean).join('. ') + '.',
  };
}

/** Criteria the bars already show (rollout.ts words them "3 of 5 …" and "6 h of 12 h"). */
const BAR_UNMET = /^\d+ of \d+ (merges|would-merge digests)$|^\d+ h of \d+ h$/;

/**
 * The ladder as Command draws it; null unless a grant is ACTIVE and the
 * server sent both its ladder and its rollout position (anything else is the
 * off-state's job, never a half-drawn ladder).
 */
export function ladderView(status: AuthorityStatusV1 | null): LadderView | null {
  if (!status || status.grant.state !== 'active') return null;
  const ladder = narrowLadder(status);
  const rollout = status.rollout;
  if (!ladder || !rollout || ladder.stages.length === 0) return null;
  const current = ladder.stages[rollout.stageIndex];
  if (!current || current.id !== rollout.stageId) return null;
  const c = rollout.criteria;
  const bars: ProgressBar[] = [
    {
      key: 'evidence',
      label: current.counts === 'merges' ? 'Merges' : 'Would-merge digests',
      value: rollout.merges,
      max: c.minMerges,
      text: `${rollout.merges} / ${c.minMerges}`,
      met: rollout.merges >= c.minMerges,
    },
    {
      key: 'hours',
      label: 'Hours in stage',
      value: Math.min(rollout.hoursInStage, c.minHours),
      max: c.minHours,
      text: `${hours(Math.floor(rollout.hoursInStage * 10) / 10)} h / ${c.minHours} h`,
      met: rollout.hoursInStage >= c.minHours,
    },
  ];
  const next = ladder.stages[rollout.stageIndex + 1] ?? null;
  const newlyMerging = next ? next.merging.filter((r) => !current.merging.includes(r)) : [];
  const nextLine = next
    ? newlyMerging.length > 0
      ? `${stageLabel(next.id)} lets ${list(newlyMerging)} merge`
      : `${stageLabel(next.id)}: ${next.maxRisk} risk, ≤ ${next.maxFiles} files / ${next.maxLines} lines`
    : null;
  return {
    stageId: rollout.stageId,
    stageName: stageLabel(rollout.stageId),
    position: `${rollout.stageIndex + 1} of ${rollout.stageCount}`,
    rungs: ladder.stages.map((s) => rung(s, rollout.stageIndex)),
    bars,
    nextStageName: rollout.nextStageId ? stageLabel(rollout.nextStageId) : null,
    met: rollout.met,
    otherUnmet: rollout.unmet.filter((u) => !BAR_UNMET.test(u)),
    nextLine,
  };
}

// ---------------------------------------------------------------------------
// Grant expiry
// ---------------------------------------------------------------------------

export interface GrantExpiry {
  /** "23 d left" / "4 d 6 h left" / "5 h left". */
  text: string;
  tone: ChipTone;
  /** Under GRANT_WARN_MS: the card offers Re-approve. */
  warn: boolean;
  /** Absolute time, for the tooltip. */
  until: string;
}

export function grantExpiry(status: AuthorityStatusV1 | null, now: number): GrantExpiry | null {
  if (!status || status.grant.state !== 'active' || !status.grant.expiresAt) return null;
  const at = Date.parse(status.grant.expiresAt);
  if (!Number.isFinite(at)) return null;
  const left = at - now;
  const d = Math.floor(left / DAY);
  const h = Math.floor((left - d * DAY) / HOUR);
  const text = left <= 0
    ? 'expired'
    : left >= 3 * DAY
      ? `${d} d left`
      : left >= DAY
        ? `${d} d ${h} h left`
        : left >= HOUR
          ? `${Math.floor(left / HOUR)} h left`
          : `${Math.max(1, Math.floor(left / MINUTE))} m left`;
  const tone: ChipTone = left < DAY ? 'danger' : left < GRANT_WARN_MS ? 'warning' : 'success';
  return {
    text,
    tone,
    warn: left < GRANT_WARN_MS,
    until: new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  };
}

// ---------------------------------------------------------------------------
// What happened last
// ---------------------------------------------------------------------------

export interface LastEvent {
  text: string;
  tone: ChipTone;
  at: string | null;
}

function moveText(m: AutonomyLadderMoveV1): LastEvent {
  if (m.move === 'regressed') {
    const why = m.breach ? `: ${m.breach.replace(/[.]$/, '')}` : '';
    return { text: `Dropped back to ${stageLabel(m.toStageId)}${m.fromStageId ? ` from ${stageLabel(m.fromStageId)}` : ''}${why}.`, tone: 'danger', at: m.at };
  }
  return { text: `Advanced to ${stageLabel(m.toStageId)}${m.fromStageId ? ` from ${stageLabel(m.fromStageId)}` : ''}.`, tone: 'success', at: m.at };
}

export const OUTCOME_WORD: Readonly<Record<ShadowDecisionOutcome, string>> = {
  'would-merge': 'Would merge',
  merged: 'Merged',
  refused: 'Refused',
  'owner-lane': 'Owner lane',
  waiting: 'Waiting',
  'in-progress': 'In the gates',
};

export const OUTCOME_TONE: Readonly<Record<ShadowDecisionOutcome, ChipTone>> = {
  'would-merge': 'success',
  merged: 'success',
  refused: 'danger',
  'owner-lane': 'warning',
  waiting: 'neutral',
  'in-progress': 'neutral',
};

function decisionText(d: ShadowDecisionV1): LastEvent {
  const what = d.prNumber !== null ? `${repoShort(d.repo)} #${d.prNumber}` : repoShort(d.repo);
  const tone = OUTCOME_TONE[d.outcome];
  switch (d.outcome) {
    case 'would-merge':
      return { text: `Would merge ${what} — every gate passed.`, tone, at: d.at };
    case 'merged':
      // 3.15 elite self-land: tests, not a judge, carried it.
      return d.eliteModel
        ? { text: `Landed directly · elite model ${d.eliteModel} · tests green — ${what}.`, tone, at: d.at }
        : { text: `Merged ${what}.`, tone, at: d.at };
    default:
      return { text: `${what}: ${d.why}`, tone, at: d.at };
  }
}

/**
 * The one line "what happened last": the newest of the ladder's last move
 * (from the status — always there when a move happened) and the decisions
 * view's newest decision / move. `decisions`: undefined while the first read
 * is in flight, null when it answered without a readable view.
 */
export function lastEvent(ladder: AutonomyLadderV1 | null, decisions: ShadowDecisionsV1 | null | undefined): LastEvent {
  const candidates: LastEvent[] = [];
  if (ladder?.lastMove) candidates.push(moveText(ladder.lastMove));
  if (decisions?.moves[0]) candidates.push(moveText(decisions.moves[0]));
  if (decisions?.decisions[0]) candidates.push(decisionText(decisions.decisions[0]));
  const dated = candidates.filter((c) => c.at !== null && Number.isFinite(Date.parse(c.at)));
  dated.sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));
  if (dated[0]) return dated[0];
  if (decisions) return { text: 'Nothing has reached the merge gates yet under this grant.', tone: 'neutral', at: null };
  if (decisions === null) return { text: 'The latest decision could not be read.', tone: 'unknown', at: null };
  return { text: 'Reading the latest decision…', tone: 'unknown', at: null };
}

// ---------------------------------------------------------------------------
// Fleet: the decisions list
// ---------------------------------------------------------------------------

/** Regressions shown prominently above the list: the newest few, newest first. */
export function recentRegressions(decisions: ShadowDecisionsV1 | null, limit = 3): AutonomyLadderMoveV1[] {
  return (decisions?.moves ?? []).filter((m) => m.move === 'regressed').slice(0, limit);
}

/** "+30 −4 · 2 files · low" for a would-merge digest; null without one. */
export function sizeLine(d: ShadowDecisionV1): string | null {
  if (d.files === null && d.linesAdded === null) return null;
  const parts: string[] = [];
  if (d.linesAdded !== null || d.linesDeleted !== null) parts.push(`+${d.linesAdded ?? 0} −${d.linesDeleted ?? 0}`);
  if (d.files !== null) parts.push(`${d.files} file${d.files === 1 ? '' : 's'}`);
  if (d.risk) parts.push(`${d.risk} risk`);
  return parts.join(' · ');
}

/** GitHub URL of the fleet PR, when the repo is an owner/name slug and a PR exists. */
export function prUrl(d: Pick<ShadowDecisionV1, 'repo' | 'prNumber'>): string | null {
  if (d.prNumber === null || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(d.repo)) return null;
  return `https://github.com/${d.repo}/pull/${d.prNumber}`;
}

/**
 * The cloud task whose intake filed this proposal (3.13 cloud intake), so the
 * row can open that task's evidence timeline. Null when no task names it —
 * a proposal the fleet produced itself has no cloud timeline.
 */
export function cloudTaskFor(
  d: Pick<ShadowDecisionV1, 'proposalId' | 'repo'>,
  tasks: readonly Pick<CloudTaskV1, 'id' | 'title' | 'repo' | 'intake'>[] | null | undefined,
): { id: string; title: string } | null {
  const hit = (tasks ?? []).find((t) => t.intake?.proposalId === d.proposalId && t.repo.toLowerCase() === d.repo.toLowerCase());
  return hit ? { id: hit.id, title: hit.title } : null;
}

/** Tone of a gate verdict chip. */
export function gateTone(verdict: string): ChipTone {
  if (verdict === 'pass') return 'success';
  if (verdict === 'refuse') return 'danger';
  if (verdict === 'owner-lane') return 'warning';
  return 'neutral';
}

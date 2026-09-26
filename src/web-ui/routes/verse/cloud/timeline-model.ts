/**
 * routes/verse/cloud/timeline-model.ts — the evidence timeline's words and
 * decisions as pure functions (3.13; server: core/cloud/timeline.ts). No React.
 *
 * Copy rules, on top of the cloud lane's (cloud-model.ts):
 *   - every step carries a WORD for how far it can be trusted — "Verified",
 *     "Claim", "Estimate" or "Unknown" — never a colour or an icon alone;
 *   - the session's report is a claim and the cost an estimate, whatever the
 *     server sends: the badge is derived from `verified`, and `false` can only
 *     ever read as Claim / Estimate;
 *   - times are local and relative; a step with no recorded time shows none
 *     (it is never back-filled from a neighbour).
 */
import {
  TIMELINE_STEP_ORDER,
  type CloudTimelineResponse,
  type TimelineStep,
  type TimelineStepKind,
  type TimelineVerified,
} from '../../../../core/cloud/timeline-types.js';
import { scrubSecrets } from '../../../../core/util/scrub.js';
import { relativePhrase } from '../context/context-model.js';
import { safeHref } from './cloud-model.js';

export type TimelineBadge = 'verified' | 'claim' | 'estimate' | 'unknown';

export const BADGE_WORD: Record<TimelineBadge, string> = {
  verified: 'Verified',
  claim: 'Claim',
  estimate: 'Estimate',
  unknown: 'Unknown',
};

/** Tooltip / screen-reader sentence for each badge. */
export const BADGE_MEANING: Record<TimelineBadge, string> = {
  verified: 'Read from a record Verse or GitHub wrote, not from the session.',
  claim: 'The cloud session’s own say-so. Nothing checked it.',
  estimate: 'An estimate fixed at launch; the real balance is on claude.ai.',
  unknown: 'Nothing was recorded, or the record could not be read.',
};

export const STEP_LABEL: Record<TimelineStepKind, string> = {
  objective: 'Objective',
  launch: 'Session',
  worker: 'Worker',
  report: 'Report',
  pr: 'Pull request',
  diff: 'Diff',
  checks: 'Checks',
  gates: 'Merge gates',
  merge: 'Merge',
  release: 'Release',
  health: 'Health',
  cost: 'Cost',
};

export function badgeFor(step: Pick<TimelineStep, 'kind' | 'verified'>): TimelineBadge {
  if (step.verified === true) return 'verified';
  if (step.verified === false) return step.kind === 'cost' ? 'estimate' : 'claim';
  return 'unknown';
}

const VERIFIED_VALUES: readonly TimelineVerified[] = [true, false, 'unknown'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function narrowStep(raw: unknown): TimelineStep | null {
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(TIMELINE_STEP_ORDER as readonly string[]).includes(kind)) return null;
  if (!VERIFIED_VALUES.includes(raw['verified'] as TimelineVerified)) return null;
  if (typeof raw['title'] !== 'string' || typeof raw['detail'] !== 'string' || typeof raw['source'] !== 'string') return null;
  if (raw['at'] !== null && typeof raw['at'] !== 'string') return null;
  const step: TimelineStep = {
    kind: kind as TimelineStepKind,
    at: raw['at'] as string | null,
    title: raw['title'],
    detail: raw['detail'],
    source: raw['source'],
    verified: raw['verified'] as TimelineVerified,
    reached: raw['reached'] !== false,
  };
  const link = raw['link'];
  if (isRecord(link) && typeof link['href'] === 'string' && typeof link['label'] === 'string') {
    // Only these hosts ever become links, whatever the server sent.
    const href = safeHref(link['href'], 'github.com') ?? safeHref(link['href'], 'claude.ai');
    if (href) step.link = { href, label: link['label'] };
  }
  return step;
}

/**
 * Just enough structure that no render can crash; an unknown step kind or a
 * malformed step is dropped rather than guessed at. Null when the envelope
 * itself is unrecognisable.
 */
export function narrowTimeline(raw: unknown): CloudTimelineResponse | null {
  if (!isRecord(raw) || raw['v'] !== 1 || typeof raw['taskId'] !== 'string' || !Array.isArray(raw['steps'])) return null;
  const steps = raw['steps'].map(narrowStep).filter((s): s is TimelineStep => s !== null);
  return {
    v: 1,
    generatedAt: typeof raw['generatedAt'] === 'string' ? raw['generatedAt'] : '',
    taskId: raw['taskId'],
    repo: typeof raw['repo'] === 'string' ? raw['repo'] : '',
    title: typeof raw['title'] === 'string' ? raw['title'] : '',
    state: typeof raw['state'] === 'string' ? raw['state'] : '',
    steps,
  };
}

/** "5m ago" / "on Sep 24", or null when the step recorded no time. */
export function stepWhen(step: Pick<TimelineStep, 'at'>, now: number = Date.now()): string | null {
  return relativePhrase(step.at, now);
}

/** Server prose is already scrubbed; scrub again so the panel is safe outside the HTTP sanitizer too. */
export function stepText(text: string): string {
  return scrubSecrets(text);
}

export interface TimelineSummary {
  verified: number;
  claims: number;
  unknown: number;
  /** "7 verified · 2 claims · 3 unknown" */
  text: string;
}

/** Counts over the stages the task has REACHED — pending stages are not "unknown evidence". */
export function timelineSummary(steps: readonly TimelineStep[]): TimelineSummary {
  let verified = 0;
  let claims = 0;
  let unknown = 0;
  for (const step of steps) {
    if (!step.reached) continue;
    const badge = badgeFor(step);
    if (badge === 'verified') verified += 1;
    else if (badge === 'unknown') unknown += 1;
    else claims += 1;
  }
  const parts = [`${verified} verified`];
  if (claims > 0) parts.push(`${claims} ${claims === 1 ? 'claim or estimate' : 'claims or estimates'}`);
  if (unknown > 0) parts.push(`${unknown} unknown`);
  return { verified, claims, unknown, text: parts.join(' · ') };
}

/**
 * health.ts — Deterministic per-repo + portfolio HEALTH SCORING (M27).
 *
 * HARD SAFETY INVARIANTS (enforced throughout this file):
 *  - READ-ONLY: composes the six M22 read-only scanners (SCANNERS) + the
 *    read-only convention probes. WRITES NOTHING here (the quality store owns
 *    ~/.ashlr/quality snapshots; the CLI owns proposals). NEVER mutates a repo.
 *  - ENROLLMENT-SCOPED: computeReport defaults its repo set to listEnrolled()
 *    (DEFAULT EMPTY => empty report, no disk scan). When an explicit `repos`
 *    list is supplied, EACH entry is filtered through isEnrolled() (resolve()
 *    first) and a non-enrolled path HARD-ERRORS. This closes the exact gap the
 *    M25 review caught — enforced at the CORE layer here AND again at the CLI.
 *  - LOCAL-FIRST / NO LLM: scoring is deterministic and uses NO model. M27
 *    ships no LLM narrative path, so this module makes zero connections beyond
 *    what the M22 scanners already do.
 *  - BOUNDED: reuses the scanners' built-in bounds; caps repos per run
 *    (maxRepos) and worst-offenders per repo. No unbounded loops.
 *  - Never throws on a per-repo basis: a scanner failure yields [] (scanner
 *    contract); computeHealth additionally guards each scanner so a single
 *    rejection degrades that dimension to a neutral/penalized state with a
 *    note rather than crashing the whole report. computeReport surfaces an
 *    enrollment violation as a hard error (the only intentional throw).
 */

import { resolve } from 'node:path';

import type {
  ClampedHealthScore,
  ConventionFinding,
  HealthDimension,
  HealthDimensionScore,
  HealthOptions,
  HealthReport,
  HealthScoreError,
  HealthScore,
  WorkItem,
  WorkSource,
} from '../types.js';
import { SCANNERS } from '../portfolio/scanners.js';
import { isEnrolled, listEnrolled } from '../sandbox/policy.js';
import { probeConventions } from './conventions.js';

// ---------------------------------------------------------------------------
// Bounds / weights
// ---------------------------------------------------------------------------

/** Hard cap on repos scored per run (bounds work). */
const DEFAULT_MAX_REPOS = 100;

/** Cap on worst-offender WorkItems retained per repo. */
const MAX_WORST_OFFENDERS = 5;

/**
 * Relative weights for the overall 0..100 roll-up. Deterministic; sums are
 * normalized at compute time so they need not total 100 here.
 */
const DIMENSION_WEIGHTS: Record<HealthDimension, number> = {
  tests: 20,
  docs: 10,
  deps: 15,
  security: 25,
  codeDebt: 10,
  issuesCi: 10,
  conventions: 10,
};

/** Stable, deterministic order the dimensions are reported in. */
const DIMENSION_ORDER: readonly HealthDimension[] = [
  'tests',
  'docs',
  'deps',
  'security',
  'codeDebt',
  'issuesCi',
  'conventions',
] as const;

/**
 * Maps each scanner's WorkSource onto the HealthDimension it feeds.
 *   issue    -> issuesCi   (open GitHub issues + CI signal)
 *   todo     -> codeDebt   (TODO/FIXME/HACK/XXX markers)
 *   test     -> tests      (test-script presence + CI state)
 *   dep      -> deps       (freshness + npm-audit vulnerabilities)
 *   doc      -> docs       (README/LICENSE/CONTRIBUTING presence + thinness)
 *   security -> security   (binshield findings)
 * The seventh dimension, `conventions`, is fed by probeConventions (not a
 * WorkSource), so it is intentionally absent from this map.
 */
const SOURCE_TO_DIMENSION: Record<WorkSource, HealthDimension> = {
  issue: 'issuesCi',
  todo: 'codeDebt',
  self: 'codeDebt', // M54: self-improvement work rolls into the code-debt dimension
  test: 'tests',
  dep: 'deps',
  doc: 'docs',
  security: 'security',
  plugin:  'codeDebt', // M33: plugin items map to codeDebt dimension (best-fit)
  lint:    'codeDebt', // M101: lint errors roll into code-debt
  goal:    'issuesCi', // M161: goal items map to issuesCi (directive work)
  hygiene: 'codeDebt', // M161: hygiene items map to codeDebt dimension
  invent:  'codeDebt', // M181: invented items map to codeDebt (net-new capability work)
};

/**
 * Per-finding penalty applied to a dimension's 0..100 score. A WorkItem's
 * `value` field is a 1..5 severity proxy (5 = critical); we map it to a point
 * penalty so more/severe findings drive the dimension score down deterministically.
 */
function findingPenalty(item: WorkItem): number {
  // value 1..5 (clamped by the scanners). Penalty grows with severity:
  // 1->6, 2->12, 3->18, 4->24, 5->30 points. Deterministic.
  const v = Math.max(1, Math.min(5, Math.round(item.value)));
  return v * 6;
}

/**
 * Penalty for a FAILED convention probe (ok=false), weighted 1..5. A higher
 * `weight` means a more important miss. Mirrors findingPenalty's scale.
 */
function conventionPenalty(weight: number): number {
  const w = Math.max(1, Math.min(5, Math.round(weight)));
  return w * 6;
}

// ---------------------------------------------------------------------------
// Grade derivation (deterministic)
// ---------------------------------------------------------------------------

function rawScoreLabel(raw: unknown): string {
  if (typeof raw === 'number') {
    if (Number.isNaN(raw)) return 'NaN';
    if (raw === Infinity) return 'Infinity';
    if (raw === -Infinity) return '-Infinity';
  }
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  return String(raw);
}

export function clampScore(raw: unknown, context = 'health-score'): ClampedHealthScore {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return {
      score: 0,
      error: {
        code: 'invalid-health-score',
        context,
        raw: rawScoreLabel(raw),
        detail: 'health score candidate was not a finite number; coerced to 0/100',
      },
    };
  }

  return { score: Math.max(0, Math.min(100, raw)) };
}

function healthScoreError(context: string, raw: unknown, detail: string): HealthScoreError {
  return {
    code: 'invalid-health-score',
    context,
    raw: rawScoreLabel(raw),
    detail,
  };
}

function finiteWorkItemNumber(
  raw: unknown,
  fallback: number,
  context: string,
  errors: HealthScoreError[],
): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  errors.push(healthScoreError(
    context,
    raw,
    'work item numeric field was not finite; coerced for health report output',
  ));
  return fallback;
}

function finiteWorkItemScale(
  raw: unknown,
  fallback: number,
  context: string,
  errors: HealthScoreError[],
): number {
  const n = finiteWorkItemNumber(raw, fallback, context, errors);
  return Math.max(1, Math.min(5, Math.round(n)));
}

function sanitizeWorstOffender(item: WorkItem, errors: HealthScoreError[]): WorkItem {
  return {
    ...item,
    value: finiteWorkItemScale(item.value, 1, `worst-offender:${item.id}:value`, errors),
    effort: finiteWorkItemScale(item.effort, 1, `worst-offender:${item.id}:effort`, errors),
    score: finiteWorkItemNumber(item.score, 0, `worst-offender:${item.id}:score`, errors),
  };
}

function sanitizeConventionFinding(
  finding: ConventionFinding,
  errors: HealthScoreError[],
): ConventionFinding {
  if (typeof finding.weight === 'number' && Number.isFinite(finding.weight)) {
    return {
      ...finding,
      weight: Math.max(1, Math.min(5, Math.round(finding.weight))),
    };
  }

  errors.push(healthScoreError(
    `convention:${finding.key}:weight`,
    finding.weight,
    'convention weight was not finite; coerced for health report output',
  ));

  return {
    ...finding,
    weight: 1,
  };
}

/**
 * Map a 0..100 score to a letter grade: A>=90, B>=80, C>=70, D>=60, else F.
 * Exported so the report layer derives the average grade with the same rule.
 */
export function gradeFor(score: number): HealthScore['grade'] {
  const clamped = clampScore(score, 'grade');
  if (clamped.score >= 90) return 'A';
  if (clamped.score >= 80) return 'B';
  if (clamped.score >= 70) return 'C';
  if (clamped.score >= 60) return 'D';
  return 'F';
}

// ---------------------------------------------------------------------------
// Scanner orchestration (bounded, never-throws-per-scanner)
// ---------------------------------------------------------------------------

/**
 * Run all six SCANNERS over `repo` in parallel. Each scanner is bounded and
 * never-throws by the M22 contract, but we additionally guard each one so a
 * single rejection degrades to [] rather than crashing the whole report.
 *
 * We attribute a rejection to the dimension it would have fed (by scanner
 * position in SCANNERS) so that dimension can be conservatively penalized +
 * annotated rather than appearing falsely healthy. Returns the flattened
 * WorkItem[] plus the set of WorkSources whose scanner failed outright.
 */
async function runScanners(
  repo: string,
): Promise<{ items: WorkItem[]; failedSources: Set<WorkSource> }> {
  const settled = await Promise.allSettled(SCANNERS.map((s) => s(repo)));
  const items: WorkItem[] = [];
  const failedSources = new Set<WorkSource>();

  // SCANNERS order is fixed (M22): [issues, todos, tests, deps, docs, security].
  const ORDER: readonly WorkSource[] = ['issue', 'todo', 'test', 'dep', 'doc', 'security'];

  settled.forEach((result, idx) => {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      for (const it of result.value) items.push(it);
    } else if (result.status === 'rejected') {
      const src = ORDER[idx];
      if (src !== undefined) failedSources.add(src);
    }
  });

  return { items, failedSources };
}

// ---------------------------------------------------------------------------
// Dimension scoring (deterministic)
// ---------------------------------------------------------------------------

/**
 * Score one dimension 0..100 from its feeding WorkItems (and, for the
 * `conventions` dimension, its failed convention probes). The dimension starts
 * perfect (100) and is reduced by a deterministic penalty per finding, floored
 * at 0. Deterministic and pure.
 */
function scoreDimension(
  dimension: HealthDimension,
  items: WorkItem[],
  conventionPenaltyTotal: number,
  failed: boolean,
  conventionGapCount: number,
): HealthDimensionScore {
  const weight = DIMENSION_WEIGHTS[dimension];

  let penalty = conventionPenaltyTotal;
  for (const it of items) penalty += findingPenalty(it);

  // A scanner that failed outright is treated as a small fixed penalty + note,
  // not a perfect score (we can't prove the dimension is clean).
  if (failed) penalty += 10;

  const clamped = clampScore(100 - penalty, `dimension:${dimension}`);
  const score = clamped.score;
  // The `conventions` dimension is fed by probeConventions (not WorkItems), so
  // its finding count is the failed-probe count, not items.length (which is 0).
  const findingCount = dimension === 'conventions' ? conventionGapCount : items.length;

  let summary: string;
  if (clamped.error) {
    summary = `score error — ${clamped.error.detail}`;
  } else if (failed) {
    summary = `scanner unavailable — scored conservatively (${score}/100)`;
  } else if (findingCount === 0 && conventionPenaltyTotal === 0) {
    summary = 'no findings — healthy';
  } else if (dimension === 'conventions') {
    summary = `${findingCount} convention gap(s) — ${score}/100`;
  } else {
    summary = `${findingCount} finding(s) — ${score}/100`;
  }

  const result: HealthDimensionScore = { dimension, score, weight, findingCount, summary };
  if (clamped.error) result.error = clamped.error;
  return result;
}

// ---------------------------------------------------------------------------
// computeHealth — per-repo
// ---------------------------------------------------------------------------

/**
 * Compute the per-repo HealthScore for `repo` (an absolute path).
 *
 * Runs all six SCANNERS (in parallel; each individually bounded + never throws)
 * plus probeConventions(repo), maps their outputs onto the HealthDimensions,
 * scores each dimension 0..100, rolls them up into a weighted overall 0..100 +
 * letter grade, and records the worst offenders (highest WorkItem.score),
 * bounded to MAX_WORST_OFFENDERS.
 *
 * Deterministic, READ-ONLY, NO LLM. Never mutates `repo`. Never throws on a
 * scanner/probe failure (it degrades to a neutral/penalized dimension with a
 * note); the ONLY intentional throw is the enrollment guard below.
 *
 * ENROLLMENT-SCOPED (CORE layer, invariant #2): this per-repo entry point
 * self-defends — `repo` is resolve()'d and filtered through isEnrolled(), and a
 * NON-ENROLLED path HARD-ERRORS before any disk scan. This is defense-in-depth
 * matching computeReport: the CLI already gates the positional --repo, and
 * computeReport already filters via isEnrolled before calling here, so enrolled
 * callers pass through unaffected. The guard closes the single-layer gap class
 * the M25 review caught (the M27 contract requires enrollment at BOTH layers).
 */
export async function computeHealth(repo: string): Promise<HealthScore> {
  const abs = resolve(repo);

  // CORE-layer enrollment guard (invariant #2): never disk-scan a non-enrolled
  // path, no matter which caller reaches here. HARD-ERROR before any scanner runs.
  if (!isEnrolled(abs)) {
    throw new Error(`repo not enrolled for health review: ${abs}`);
  }

  // Read-only scanner sweep + convention probe (both never-throw-guarded).
  const { items, failedSources } = await runScanners(abs);

  let rawConventions: ConventionFinding[];
  try {
    rawConventions = probeConventions(abs);
  } catch {
    rawConventions = [];
  }
  const conventionErrors: HealthScoreError[] = [];
  const conventions = rawConventions.map((finding) =>
    sanitizeConventionFinding(finding, conventionErrors));

  // Bucket WorkItems by their feeding dimension.
  const byDimension = new Map<HealthDimension, WorkItem[]>();
  for (const dim of DIMENSION_ORDER) byDimension.set(dim, []);
  for (const it of items) {
    const dim = SOURCE_TO_DIMENSION[it.source];
    // Unknown/foreign source -> ignore (defensive; the union is closed).
    if (dim === undefined) continue;
    byDimension.get(dim)!.push(it);
  }

  // The `conventions` dimension penalty + gap count: derived from failed probes.
  let conventionPenaltyTotal = 0;
  let conventionGapCount = 0;
  for (const finding of rawConventions) {
    if (!finding.ok) {
      conventionPenaltyTotal += conventionPenalty(finding.weight);
      conventionGapCount += 1;
    }
  }

  // Score every dimension (stable order).
  const dimensions: HealthDimensionScore[] = DIMENSION_ORDER.map((dim) => {
    const dimItems = byDimension.get(dim) ?? [];
    const isConventions = dim === 'conventions';
    return scoreDimension(
      dim,
      dimItems,
      isConventions ? conventionPenaltyTotal : 0,
      isConventions ? false : failedSources.has(dimensionToSource(dim)),
      isConventions ? conventionGapCount : 0,
    );
  });

  // Weighted roll-up into the overall 0..100 (weights normalized at compute time).
  const totalWeight = dimensions.reduce((acc, d) => acc + d.weight, 0);
  const weightedSum = dimensions.reduce((acc, d) => acc + d.score * d.weight, 0);
  const overallClamp = clampScore(
    totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0,
    'repo-overall',
  );
  const overall = overallClamp.score;
  const offenderErrors: HealthScoreError[] = [];

  // Worst offenders: highest WorkItem.score first; deterministic tiebreak by id.
  const worstOffenders: WorkItem[] = items
    .map((it) => sanitizeWorstOffender(it, offenderErrors))
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
    .slice(0, MAX_WORST_OFFENDERS);
  const errors = collectScoreErrors([
    ...dimensions.map((d) => d.error),
    overallClamp.error,
    ...offenderErrors,
    ...conventionErrors,
  ]);

  const result: HealthScore = {
    repo: abs,
    score: overall,
    grade: gradeFor(overall),
    dimensions,
    conventions,
    worstOffenders,
    ts: new Date().toISOString(),
  };
  if (errors.length > 0) result.errors = errors;
  return result;
}

function collectScoreErrors(errors: Array<HealthScoreError | undefined>): HealthScoreError[] {
  return errors.filter((err): err is HealthScoreError => err !== undefined);
}

/**
 * Inverse of SOURCE_TO_DIMENSION for the six WorkSource-backed dimensions.
 * Only called for non-`conventions` dimensions (conventions has no backing
 * WorkSource), so the default branch is unreachable in practice.
 */
function dimensionToSource(dimension: HealthDimension): WorkSource {
  switch (dimension) {
    case 'issuesCi':
      return 'issue';
    case 'codeDebt':
      return 'todo';
    case 'tests':
      return 'test';
    case 'deps':
      return 'dep';
    case 'docs':
      return 'doc';
    case 'security':
    case 'conventions':
    default:
      return 'security';
  }
}

// ---------------------------------------------------------------------------
// computeReport — portfolio-wide
// ---------------------------------------------------------------------------

/**
 * Compute the portfolio-wide HealthReport over enrolled repos.
 *
 * Repo selection:
 *  - opts.repos omitted   => listEnrolled() (DEFAULT EMPTY => empty report; NO
 *                            disk scan when nothing is enrolled).
 *  - opts.repos provided  => EACH entry is resolve()'d and filtered through
 *                            isEnrolled(); a NON-ENROLLED path HARD-ERRORS
 *                            (throws) — never silently scanned. (M25 lesson.)
 *
 * Bounded by opts.maxRepos (default DEFAULT_MAX_REPOS). Scores each selected
 * repo via computeHealth (sequentially, mirroring buildBacklog to avoid a
 * gh/npm thundering-herd), ranks worst-first, computes averageScore/grade, and
 * leaves `delta` for the store/CLI layer to fill from loadPreviousReport().
 *
 * Deterministic, READ-ONLY, NO LLM. Never mutates any repo.
 */
export async function computeReport(opts?: HealthOptions): Promise<HealthReport> {
  const maxRepos = Math.max(0, opts?.maxRepos ?? DEFAULT_MAX_REPOS);

  // Enrollment-scoped repo selection (CORE-layer enforcement of invariant #2).
  let repos: string[];
  if (opts?.repos !== undefined) {
    repos = [];
    for (const r of opts.repos) {
      const abs = resolve(r);
      if (!isEnrolled(abs)) {
        // HARD-ERROR — never silently scan a non-enrolled path.
        throw new Error(`repo not enrolled for health review: ${abs}`);
      }
      repos.push(abs);
    }
  } else {
    repos = listEnrolled();
  }

  // Bound work: never score more than maxRepos in a single run.
  const scoped = repos.slice(0, maxRepos);

  // Score sequentially (mirrors buildBacklog — avoids a gh/npm thundering-herd).
  const scores: HealthScore[] = [];
  for (const r of scoped) {
    scores.push(await computeHealth(r));
  }

  // Rank worst-first (ascending overall score); deterministic tiebreak by path.
  scores.sort((a, b) =>
    (clampScore(a.score, `repo-sort:${a.repo}`).score - clampScore(b.score, `repo-sort:${b.repo}`).score) ||
    a.repo.localeCompare(b.repo),
  );

  const scoreClamps = scores.map((s) => clampScore(s.score, `repo-score:${s.repo}`));
  const averageClamp = clampScore(
    scoreClamps.length > 0
      ? Math.round(scoreClamps.reduce((acc, s) => acc + s.score, 0) / scoreClamps.length)
      : 0,
    'portfolio-average',
  );
  const averageScore = averageClamp.score;
  const errors = collectScoreErrors([
    ...scores.flatMap((s) => s.errors ?? []),
    ...scoreClamps.map((s) => s.error),
    averageClamp.error,
  ]);

  const report: HealthReport = {
    generatedAt: new Date().toISOString(),
    repos: scoped,
    scores,
    averageScore,
    averageGrade: gradeFor(averageScore),
    delta: {},
  };
  if (errors.length > 0) report.errors = errors;
  return report;
}

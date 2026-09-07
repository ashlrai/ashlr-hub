import { resolve } from 'node:path';
import { readUniverseCampaignComparison, type UniverseCampaignComparison, type UniverseComparisonArm } from '../core/universe/index.js';

const USAGE = `usage: ashlr universe compare <baseline> <challenger>
       [--root <private directory>] [--json]

Compare two explicit campaigns without running models, candidates, or evaluators.
Exact comparator, configuration, and workload matches are reported separately.
Feedback-disabled versus search-v2 is a bundled feedback contrast, not isolated
search-context uplift or evidence that a model is better. Unknown usage stays unknown.
Rates describe local archive outcomes, not accepted engineering or production changes.
Local branch delivery is not a push, merge, deployment, or production acceptance.
Reads use bounded repeated observations, not an atomic global snapshot.
--root defaults to ~/.ashlr/universe. Reads never create a missing store.
Exit codes: 0 healthy comparison-eligible, 1 incomplete/unmatched, 2 invalid arguments.
`;

class UsageError extends Error {}
interface Options { baseline?: string; challenger?: string; root?: string; json: boolean; help: boolean }

function controls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function parse(args: string[]): Options {
  const positional: string[] = [];
  let root: string | undefined;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (controls(arg)) throw new UsageError('Arguments must not contain control characters');
    if (arg === '--help' || arg === '-h') {
      if (help) throw new UsageError('--help may only be specified once');
      help = true;
    } else if (arg === '--json') {
      if (json) throw new UsageError('--json may only be specified once');
      json = true;
    } else if (arg === '--root') {
      if (root !== undefined) throw new UsageError('--root may only be specified once');
      const value = args[++index];
      if (!value?.trim() || value.startsWith('-') || value.length > 4_096 || controls(value)) {
        throw new UsageError('--root requires a bounded path without control characters');
      }
      root = resolve(value);
    } else if (arg.startsWith('-')) throw new UsageError('Unknown compare option');
    else positional.push(arg);
  }
  if (positional.length > 2 || (!help && positional.length !== 2)) throw new UsageError('compare requires two campaign ids');
  if (positional.some((id) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))) throw new UsageError('Invalid Universe campaign id');
  const [baseline, challenger] = positional;
  if (baseline !== undefined && baseline === challenger) throw new UsageError('Comparison requires two distinct campaign ids');
  return { baseline, challenger, root, json, help };
}

function available(value: number | null): string { return value === null ? 'unavailable' : String(value); }

function renderArm(label: string, arm: UniverseComparisonArm): string[] {
  return [
    `${label}: ${arm.campaignId} · source ${arm.sourceState} · campaign ${arm.campaignState ?? 'unavailable'}`,
    `  Completed: ${arm.completed} · fresh: ${arm.fresh} · fully attributed: ${arm.fullyAttributed} · nonempty: ${arm.nonempty}`,
    `  Attempts: ${arm.counts.attempts} · completed runs: ${arm.counts.completedRuns} · passed trials: ${arm.counts.passedTrials}`,
    `  Archive admissions: ${arm.counts.admissions} · strict improvements: ${arm.counts.improvements} · distinct selected artifacts: ${arm.counts.distinctSelectedArtifacts}`,
    `  Feedback: ${arm.feedback.observed} · recorded search-context receipts: ${arm.feedback.receipts.searchContext}`,
    `  Model request coverage: ${arm.counts.reportedModelRequests}/${arm.counts.modelRequestsStarted} recorded started requests reported usage · ${arm.counts.reservedModelRequests} reserved`,
    `  Observed token subtotal: ${arm.usage.recordedTokens} · complete model-generation tokens: ${available(arm.usage.reportedTokens)} · coverage complete: ${arm.usage.complete}`,
    `  Recorded run duration: ${available(arm.timing.recordedRunDurationMs)} ms · wall-clock span: ${available(arm.timing.wallSpanMs)} ms`,
    `  Strict improvements per million reported model tokens: ${available(arm.rates.improvementsPerMillionTokens)} · per recorded run hour: ${available(arm.rates.improvementsPerHour)}`,
    `  Distinct selected artifacts per million reported model tokens: ${available(arm.rates.distinctSelectedArtifactsPerMillionTokens)} · per recorded run hour: ${available(arm.rates.distinctSelectedArtifactsPerHour)}`,
    `  Currently verified local delivery branches: ${available(arm.counts.verifiedDeliveryBranches)} · distinct delivered artifacts: ${available(arm.counts.distinctDeliveredArtifacts)}`,
    ...arm.niches.map((niche) => `  Campaign-retained ${niche.niche}: ${niche.score}`),
    ...arm.reasons.map((reason) => `  Evidence: ${reason}`),
    ...arm.rates.reasons.map((reason) => `  Rate limitation: ${reason}`),
  ];
}

function render(report: UniverseCampaignComparison): string {
  return [
    `Universe campaign comparison · source ${report.sourceState} · ${report.matching.comparable ? 'comparison-eligible' : 'not comparison-eligible'}`,
    `Exact comparator match: ${report.matching.comparator} · configuration match: ${report.matching.configuration} · workload match: ${report.matching.workload}`,
    `Observed feedback contrast: ${report.feedbackContrast}`,
    ...renderArm('Baseline', report.baseline), ...renderArm('Challenger', report.challenger),
    ...report.differences.map((difference) => `Difference: ${difference}`),
    ...report.matching.reasons.map((reason) => `Matching: ${reason}`),
    ...report.reasons.map((reason) => `Evidence: ${reason}`),
    ...report.scoreDeltas.map((delta) => `Campaign-retained ${delta.niche}: baseline=${available(delta.baselineScore)} · challenger=${available(delta.challengerScore)} · direction-adjusted delta=${available(delta.directionAdjustedDelta)}`),
    'Observation-only local experiments. These comparisons do not establish causality, model superiority, or token savings.',
    'Archive selection and local branch delivery are not production acceptance. Accepted production changes: unavailable.',
    'Recorded run time is not inference-only time. Sampling is bounded repeated observation, not an atomic global snapshot.',
  ].join('\n');
}

/** Read-only projection; parsing completes before any evidence is inspected. */
export async function cmdUniverseCompare(args: string[]): Promise<number> {
  try {
    const options = parse(args);
    if (options.help) { console.log(USAGE); return 0; }
    const report = readUniverseCampaignComparison(options.baseline!, options.challenger!, { root: options.root });
    console.log(options.json ? JSON.stringify(report, null, 2) : render(report));
    return report.sourceState === 'healthy' && report.matching.comparable ? 0 : 1;
  } catch (error) {
    // Never echo raw filesystem, ledger, model-response, or candidate errors.
    const message = error instanceof UsageError ? error.message : 'Comparison evidence unavailable';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(`universe compare: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

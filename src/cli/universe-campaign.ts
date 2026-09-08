import { readFileSync } from 'node:fs';
import { isAbsolute, parse as parsePath, resolve } from 'node:path';
import {
  initUniverseCampaign, readUniverseCampaign, readUniverseCampaigns, requestUniverseCampaignControl, runUniverseCampaign,
  type UniverseCampaignSummary,
} from '../core/universe/index.js';
import type { UniverseCampaignReadiness } from '../core/universe/campaign-readiness.js';

const USAGE = `usage: ashlr universe campaign <command> [id] [--root <private directory>] [--json]

  init --manifest <file.json>   Register a bounded campaign for an existing universe
  run <id>                     Continue automatically within the original budget
  resume <id>                  Alias for run; does not reset the deadline or budget
  status [id]                  Inspect recorded progress without starting work
  check <id> --root <absolute>  Inspect recorded recovery evidence without execution
  pause <id>                   Request an owner-acknowledged pause
  stop <id>                    Request a terminal stop
  help                         Show this help

Run executes in this process; no daemon or background service is installed.
The campaign continues after a passing trial until its resource or stagnation
limit ends it. Paused or interrupted work resumes only with run/resume.
Requests are not acknowledgments: inspect status before assuming work stopped.
Terminal campaigns remain terminal. Results are local experiment evidence,
not accepted production changes. --root defaults to ~/.ashlr/universe except check.
Check requires an explicit canonical absolute private root. It reads saved
campaign evidence only: no runtime binding, quota refresh, provider/model check,
evaluator execution, control request or automatic resume. It does not establish
current worker readiness. --resource-runtime is not accepted by check.
Resource-pool run/resume requires --resource-runtime <private absolute JSON>.
Optional private quotaConfigPath enables bounded Codex metadata capture before
new resource admission; stale or refused evidence still pauses the campaign.
Optional private localModelConfigPath refreshes digest-pinned local inventory
before new resource admission; the inventory read does not perform inference.
Optional capacityWaitMs (0-60000) waits for eligible contention without adding
generations or extending the campaign deadline; omission/zero preserves no-wait.
Repeat that explicit runtime option on resume; it is not saved in the campaign.
maxModelRequests reserves generation transport invocations, not native API calls.
Native CLI invocations may make zero or multiple provider requests.
Exit codes: 0 command handled, 1 failed/interrupted/degraded, 2 invalid arguments.
Check: 0 valid snapshot (including held or terminal), 1 unavailable/degraded,
2 invalid arguments. A zero exit code is not permission or readiness to resume.
`;

class UsageError extends Error {}

function parse(args: string[]): { command: string; id?: string; manifest?: string; root?: string; resourceRuntime?: string; json: boolean } {
  const positional: string[] = [];
  let root: string | undefined;
  let suppliedRoot: string | undefined;
  let manifest: string | undefined;
  let resourceRuntime: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') return { command: 'help', json: false };
    if (arg === '--json') { json = true; continue; }
    if (arg === '--root' || arg === '--manifest' || arg === '--resource-runtime') {
      const value = args[++index];
      if (!value?.trim() || value.startsWith('--')) throw new UsageError(`${arg} requires a path`);
      if (arg === '--resource-runtime') {
        if (resourceRuntime) throw new UsageError('--resource-runtime may only be specified once');
        if (!isAbsolute(value) || Buffer.byteLength(value) > 4096 || [...value].some((character) => character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)) throw new UsageError('--resource-runtime requires a private absolute JSON path');
        resourceRuntime = resolve(value);
      } else if (arg === '--root') {
        if (root) throw new UsageError('--root may only be specified once');
        suppliedRoot = value;
        root = resolve(value);
      } else {
        if (manifest) throw new UsageError('--manifest may only be specified once');
        manifest = resolve(value);
      }
    } else if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const [requested = 'status', id] = positional;
  const command = requested === 'resume' ? 'run' : requested;
  if (!['help', 'init', 'run', 'status', 'check', 'pause', 'stop'].includes(command)) throw new UsageError(`Unknown campaign command: ${requested}`);
  const acceptsId = ['run', 'status', 'check', 'pause', 'stop'].includes(command);
  if (positional.length > (acceptsId ? 2 : 1)) throw new UsageError(`Too many arguments for ${requested}`);
  if (id && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new UsageError('Invalid campaign id');
  if (['run', 'check', 'pause', 'stop'].includes(command) && !id) throw new UsageError(`${requested} requires a campaign id`);
  if (command === 'init' && !manifest) throw new UsageError('init requires --manifest <file.json>');
  if (manifest && command !== 'init') throw new UsageError('--manifest is only valid with init');
  if (resourceRuntime && command !== 'run') throw new UsageError('--resource-runtime is only valid with campaign run/resume');
  if (command === 'check' && (!suppliedRoot || !isAbsolute(suppliedRoot) || root !== suppliedRoot ||
      root === parsePath(suppliedRoot).root || Buffer.byteLength(suppliedRoot) > 4096 ||
      [...suppliedRoot].some((character) => character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159))) {
    throw new UsageError('check requires --root <canonical absolute private directory>');
  }
  return { command, id, root, manifest, resourceRuntime, json };
}

function rootFlag(root?: string): string {
  return root ? ` --root '${root.replaceAll("'", "'\\''")}'` : '';
}

function renderReadiness(report: UniverseCampaignReadiness): string {
  const nextChecks = {
    startable: 'Review the recorded snapshot and commission the required runtime before explicitly starting work.',
    owned: 'Observe the current owner; do not start a competing campaign process.',
    'owner-held': 'Respect the recorded owner control. Do not automatically resume held work.',
    'resource-withheld': 'Inspect the recorded resource task and separately recheck current pool evidence before considering a new run.',
    'recovery-required': 'Inspect interrupted or uncertain work before explicit recovery; do not replay a task automatically.',
    'attention-required': 'Inspect the recorded failure before considering a new run. This check does not repair or resume work.',
    'budget-exhausted': 'The original deadline and consumed budget remain in force. This check does not reset them.',
    terminal: 'The campaign remains terminal. This check does not reopen it.',
    unavailable: 'Restore or recheck the selected recorded evidence; unavailable history is not a fresh campaign.',
  };
  return [
    `${report.campaignId} · recorded recovery check · ${report.disposition}`,
    `Source: ${report.sourceState} · recorded state=${report.observedState ?? 'unavailable'}`,
    `Reason code: ${report.reasonCode}`,
    `Advisory action: ${report.automaticAction} (no work started)`,
    `Explicit resource runtime required: ${report.resourceRuntimeRequired === null ? 'unknown' : report.resourceRuntimeRequired ? 'yes' : 'no'}`,
    `Next check: ${nextChecks[report.disposition]}`,
    'Scope: recorded campaign evidence only. Current worker, quota, provider/model and evaluator readiness are not checked.',
    'No execution, quota refresh, control request or automatic resume occurred. This snapshot is not authorization to start work.',
  ].join('\n');
}

function render(summary: UniverseCampaignSummary, root?: string): string {
  const { definition, progress } = summary;
  const healthy = summary.sourceState === 'healthy';
  const measured = (value: number): number | string => healthy ? value : 'unavailable';
  return [
    `${definition.id} · ${summary.state} · universe ${definition.universeId}`,
    `Reason: ${summary.reason ?? 'No stop reason recorded'}`,
    `Generation attempts: ${measured(progress.attempts)}/${definition.budget.maxGenerations}` +
      ` · completed=${measured(progress.completedRuns)} interrupted=${measured(progress.interruptedRuns)}`,
    `Reserved generation invocations: ${measured(progress.reservedModelRequests)}/${definition.budget.maxModelRequests} (maxModelRequests; not native API calls)`,
    `Deadline: ${summary.deadlineAt ?? 'Starts on first run'} · unchanged by resume`,
    `Initial niche admissions: ${measured(progress.admissions)} · strict improvements: ${measured(progress.improvements)}`,
    `Stagnant generations: ${measured(progress.stagnantGenerations)}/${definition.budget.maxStagnantGenerations}`,
    `Reported token total: ${healthy && progress.usageComplete && progress.reportedTokens !== null ? progress.reportedTokens : 'unavailable'}` +
      ` · recorded subtotal: ${measured(progress.recordedTokens)}`,
    `Reported-token stop threshold: ${definition.budget.maxReportedTokens ?? 'not configured'} (not a preventive spend ceiling)`,
    ...summary.steps.map((step) => `  Generation ${step.generation} · ${step.state}` +
      ` · ${measured(step.passedTrials)}/${measured(step.trialCount)} trials passed` +
      ` · new niches=${measured(step.admissions)} improvements=${measured(step.improvements)} · run ${step.runId}`),
    ...(summary.state === 'pause-requested' || summary.state === 'stop-requested'
      ? ['Control requested; the owner has not yet acknowledged completion.'] : []),
    ...(summary.state === 'ready' || summary.state === 'paused' || summary.state === 'interrupted'
      ? [`Continue: ashlr universe campaign run ${definition.id}${rootFlag(root)}`] : []),
    ...summary.reasons,
    'Campaign termination is not project success. Tokens cover recorded model generation only; missing usage is not zero.',
    'Resource-pool runs require the explicit --resource-runtime option again on resume; no runtime binding is saved in this campaign.',
  ].join('\n');
}

/** Campaign controls remain explicit CLI actions; console reads never dispatch. */
export async function cmdUniverseCampaign(args: string[]): Promise<number> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  let checking = false;
  try {
    const options = parse(args);
    if (options.command === 'help') { console.log(USAGE); return 0; }
    const store = { root: options.root };
    if (options.command === 'check') {
      checking = true;
      const { readUniverseCampaignReadiness } = await import('../core/universe/campaign-readiness.js');
      const report = readUniverseCampaignReadiness(options.id!, { root: options.root! });
      console.log(options.json ? JSON.stringify(report, null, 2) : renderReadiness(report));
      return report.sourceState === 'healthy' ? 0 : 1;
    }
    if (options.command === 'status' && !options.id) {
      const result = readUniverseCampaigns(store);
      console.log(options.json ? JSON.stringify(result, null, 2) : result.campaigns.length
        ? result.campaigns.map((campaign) => render(campaign, options.root)).join('\n\n')
        : `No recorded campaigns. Register one with: ashlr universe campaign init --manifest <file.json>\nSource: ${result.sourceState}` +
          (result.reasons.length ? `\n${result.reasons.join('\n')}` : ''));
      return result.sourceState === 'degraded' ? 1 : 0;
    }
    let summary: UniverseCampaignSummary;
    if (options.command === 'init') {
      const definition = JSON.parse(readFileSync(options.manifest!, 'utf8'));
      summary = initUniverseCampaign(definition, store);
    } else if (options.command === 'run') {
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      summary = await runUniverseCampaign(options.id!, { ...store, signal: controller.signal,
        ...(options.resourceRuntime ? { resourceRuntime: options.resourceRuntime } : {}) });
    } else if (options.command === 'pause' || options.command === 'stop') {
      summary = requestUniverseCampaignControl(options.id!, options.command, store);
    } else summary = readUniverseCampaign(options.id!, store);
    console.log(options.json ? JSON.stringify(summary, null, 2) : render(summary, options.root));
    if (summary.sourceState === 'degraded') return 1;
    return options.command === 'run' && ['failed', 'interrupted'].includes(summary.state) ? 1 : 0;
  } catch (error) {
    const message = checking && !(error instanceof UsageError) ? 'Campaign recorded readiness is unavailable' :
      error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(`universe campaign: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

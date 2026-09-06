import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initUniverse, readUniverseOverview, runUniverse,
  type UniverseManifest, type UniverseOverview, type UniverseRun,
} from '../core/universe/index.js';
import { runUniverseDemo } from './universe-demo.js';

const USAGE = `usage: ashlr universe <command> [--root <private directory>] [--json]

  demo                         Build and evaluate two local demo generations
  init --manifest <file.json>   Register a pinned experiment definition
  run <id>                     Execute one budgeted generation
  status [id]                  Read objectives, runs, and measurements
  archive [id]                 Read the winning artifact in each niche
  campaign <command>           Run or inspect a bounded multi-generation campaign
  help                         Show this help

Candidate and evaluator commands run with network access denied. An optional
local-chat generation variant contacts its explicitly configured loopback model
endpoint; it sends declared files and experiment context, without auth or tools.
The evaluator is pinned separately from candidate edits. Results are local
experiments, not accepted production changes. --root defaults to ~/.ashlr/universe.
Exit codes: 0 success, 1 failed/degraded execution, 2 invalid arguments.
`;

class UsageError extends Error {}

function rootFlag(root?: string): string {
  return root ? ` --root '${root.replaceAll("'", "'\\''")}'` : '';
}

function parse(args: string[]): {
  command: string; id?: string; root?: string; manifestPath?: string; json: boolean;
} {
  const positional: string[] = [];
  let root: string | undefined;
  let manifestPath: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return { command: 'help', json: false };
    if (arg === '--json') { json = true; continue; }
    if (arg === '--root' || arg === '--manifest') {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('--')) throw new UsageError(`${arg} requires a path`);
      if (arg === '--root') {
        if (root) throw new UsageError('--root may only be specified once');
        root = resolve(value);
      } else {
        if (manifestPath) throw new UsageError('--manifest may only be specified once');
        manifestPath = resolve(value);
      }
    } else if (arg.startsWith('-')) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else positional.push(arg);
  }
  const [command = 'status', id] = positional;
  if (!['help', 'demo', 'init', 'run', 'status', 'archive'].includes(command)) {
    throw new UsageError(`Unknown universe command: ${command}`);
  }
  const acceptsId = ['run', 'status', 'archive'].includes(command);
  if (positional.length > (acceptsId ? 2 : 1)) throw new UsageError(`Too many arguments for ${command}`);
  if (id && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new UsageError('Invalid universe id');
  if (command === 'run' && !id) throw new UsageError('run requires a universe id');
  if (command === 'init' && !manifestPath) throw new UsageError('init requires --manifest <file.json>');
  if (manifestPath && command !== 'init') throw new UsageError('--manifest is only valid with init');
  return { command, id, root, manifestPath, json };
}

function renderRun(run: UniverseRun): string {
  const rows = run.trials.map((trial) =>
    `  ${trial.variantId} [${trial.niche}] ${trial.status}` +
    ` score=${trial.score ?? 'unavailable'} ${trial.selected ? '→ selected' : ''}` +
    ` parent=${trial.parentTrialId ?? 'seed'}` +
    (trial.generation ?
      `\n    Model generation: ${trial.generation.status} · ${trial.generation.provider} · ${trial.generation.model}` +
      `\n    Endpoint: ${trial.generation.endpoint} · request ${trial.generation.requestStarted ? 'started' : 'not started'}` +
      `\n    Provider-reported tokens: input=${trial.generation.usage.inputTokens ?? 'unavailable'} output=${trial.generation.usage.outputTokens ?? 'unavailable'}` +
      ` · accounting=${trial.generation.usage.state} · files changed=${trial.generation.changedFiles.length}` : '') +
    (trial.error ? `\n    ${trial.error}` : ''),
  );
  const usage = run.generationUsage;
  return [
    `${run.universeId} · generation ${run.generation} · ${run.status}`,
    `Trials: ${run.trials.filter((trial) => trial.status === 'passed').length}/${run.trials.length} passed` +
      (run.status === 'completed' ? ` · ${run.trials.filter((trial) => trial.selected).length} admitted to niche archive` :
        run.status === 'running' ? ' · selection pending' : ' · selection not applied'),
    ...rows,
    `Elapsed: ${run.durationMs} ms · tokens: ${run.tokensUsed === null ? 'unmeasured' : `${run.tokensUsed} (model generation only)`} · cost: unmeasured`,
    ...(usage ? [`Generation usage coverage: ${usage.reportedRequests}/${usage.requestsStarted} recorded started requests reported tokens · ${usage.trials} model trials`,
      'Aggregate tokens require a completed generation; interrupted in-flight usage may be missing.',
      'Token totals cover model generation only, not command/evaluator work or accepted production changes.'] : []),
    ...(run.error ? [run.error] : []),
  ].join('\n');
}

function renderOverview(overview: UniverseOverview, archiveOnly: boolean): string {
  if (!overview.universes.length) {
    return `No experiments yet. Start with: ashlr universe demo\nSource: ${overview.sourceState}` +
      (overview.reasons.length ? `\n${overview.reasons.join('\n')}` : '');
  }
  return overview.universes.map((universe) => {
    const manifest = universe.manifest;
    return [
      `${manifest.name} (${manifest.id}) · ${universe.sourceState}`,
      manifest.objective,
      `Metric: ${manifest.metric.name} (${manifest.metric.direction}) · generations: ${universe.runs.length}`,
      ...universe.elites.map((elite) =>
        `  ${elite.niche}: ${elite.variantId} · score ${elite.score} · generation ${elite.generation}\n    ${elite.artifact.path}`),
      ...(!universe.elites.length ? ['  No passing artifacts selected yet.'] : []),
      ...(!archiveOnly && universe.runs.length ? [renderRun(universe.runs[universe.runs.length - 1]!)] : []),
      ...universe.reasons,
    ].join('\n');
  }).join('\n\n');
}

/** CLI and dashboard share the same persisted experiment records. */
export async function cmdUniverse(args: string[]): Promise<number> {
  if (args[0] === 'campaign') {
    const { cmdUniverseCampaign } = await import('./universe-campaign.js');
    return cmdUniverseCampaign(args.slice(1));
  }
  const jsonRequested = args.includes('--json');
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  try {
    const options = parse(args);
    if (options.command === 'help') { console.log(USAGE); return 0; }
    const store = { root: options.root };
    if (options.command === 'init') {
      const raw: unknown = JSON.parse(readFileSync(options.manifestPath!, 'utf8'));
      // Core validates the entire definition before any experiment is registered.
      const manifest = initUniverse(raw as UniverseManifest, store);
      console.log(options.json ? JSON.stringify(manifest, null, 2) :
        `Registered ${manifest.name} (${manifest.id}). Run: ashlr universe run ${manifest.id}${rootFlag(options.root)}`);
      return 0;
    }
    if (options.command === 'run' || options.command === 'demo') {
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      if (options.command === 'demo') {
        const demo = await runUniverseDemo({ ...store, signal: controller.signal });
        console.log(options.json ? JSON.stringify(demo, null, 2) :
          demo.runs.map(renderRun).join('\n\n') +
          `\n\nDemo verification: ${demo.verified ? 'passed' : 'failed'}.` +
          `\nSaved ${demo.universeId}. Inspect: ashlr universe archive ${demo.universeId}${rootFlag(options.root)}`);
        return demo.verified ? 0 : 1;
      }
      const run = await runUniverse(options.id!, { ...store, signal: controller.signal });
      console.log(options.json ? JSON.stringify(run, null, 2) : renderRun(run));
      return run.status === 'completed' ? 0 : 1;
    }
    const overview = readUniverseOverview(store);
    if (options.id) {
      overview.universes = overview.universes.filter((entry) => entry.manifest.id === options.id);
      if (!overview.universes.length) throw new Error(`Universe not found: ${options.id}`);
    }
    const archiveOnly = options.command === 'archive';
    const result = archiveOnly ? {
      schemaVersion: 1,
      measurementScope: overview.measurementScope,
      sourceState: overview.sourceState,
      reasons: overview.reasons,
      universes: overview.universes.map(({ manifest, elites, sourceState, reasons }) =>
        ({ id: manifest.id, metric: manifest.metric, elites, sourceState, reasons })),
    } : overview;
    console.log(options.json ? JSON.stringify(result, null, 2) : renderOverview(overview, archiveOnly));
    return overview.sourceState === 'degraded' ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonRequested) console.log(JSON.stringify({ error: message }));
    else console.error(`universe: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

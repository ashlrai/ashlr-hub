import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { resolve } from 'node:path';
import {
  readUniversePortfolioPlan, runUniversePortfolio, validateUniversePortfolioDefinition,
  type UniverseCampaignSummary, type UniversePortfolioDefinition, type UniversePortfolioPlan, type UniversePortfolioResult,
} from '../core/universe/index.js';

const MAX_MANIFEST_BYTES = 256 * 1024;
const USAGE = `usage: ashlr universe portfolio <plan|run> --manifest <file.json>
       [--root <private directory>] [--json]

  plan    Read campaign dependencies, readiness, and progress without changes
  run     Execute the declared campaign dependencies in this foreground process
  help    Show this help

The manifest is a regular UTF-8 JSON file, at most 256 KiB:
  {"schemaVersion":1,"id":"build","tasks":[{"campaignId":"existing-campaign",
   "dependsOn":[]}],"maxParallel":2,"maxDurationMs":60000}

Campaigns must already exist. Dependencies require completed campaigns; they do
not transfer or accept artifacts. Existing campaign deadlines and resource
budgets remain unchanged. Portfolio concurrency and duration bound only this
invocation, not other processes or subscription accounts. A new invocation gets
a new portfolio deadline, not new campaign budgets. Independent ready branches
may proceed while other branches are blocked. SIGINT/SIGTERM requests cancellation
and waits for started work to settle. No resident service is installed.
No automatic delivery, push, merge, deployment, or production acceptance.
--root defaults to ~/.ashlr/universe. Planning does not create missing stores.
Exit codes: 0 healthy unblocked plan/completed run, 1 incomplete/source failure,
            2 invalid arguments or manifest.
`;

class UsageError extends Error {}
interface Options { command: 'plan' | 'run' | 'help'; manifest?: string; root?: string; json: boolean }

function containsControls(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function parse(args: string[]): Options {
  const positional: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (containsControls(arg)) throw new UsageError('Arguments must not contain control characters');
    if (arg === '--help' || arg === '-h') {
      if (help) throw new UsageError('--help may only be specified once');
      help = true;
    } else if (arg === '--json') {
      if (json) throw new UsageError('--json may only be specified once');
      json = true;
    } else if (arg === '--manifest' || arg === '--root') {
      if (values.has(arg)) throw new UsageError(`${arg} may only be specified once`);
      const value = args[++index];
      if (!value?.trim() || value.startsWith('-') || containsControls(value) || value.length > 4_096) {
        throw new UsageError(`${arg} requires a bounded path`);
      }
      values.set(arg, value);
    } else if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new UsageError('portfolio accepts one command and no positional manifest or campaign id');
  const command = positional[0];
  if (command !== undefined && !['plan', 'run', 'help'].includes(command)) throw new UsageError('Expected portfolio plan, run, or help');
  if (help || command === 'help') return { command: 'help', json: false };
  if (command !== 'plan' && command !== 'run') throw new UsageError('Expected portfolio plan or run');
  const manifest = values.get('--manifest');
  if (!manifest) throw new UsageError(`${command} requires --manifest <file.json>`);
  const root = values.get('--root');
  return { command, manifest: resolve(manifest), root: root === undefined ? undefined : resolve(root), json };
}

function sameFile(before: Stats, after: Stats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** Bound the bytes read, not just the initial stat; never block opening a FIFO. */
function readDefinition(path: string): UniversePortfolioDefinition {
  let fd: number | undefined;
  try {
    const expected = lstatSync(path);
    if (!expected.isFile() || expected.isSymbolicLink() || expected.size < 1 || expected.size > MAX_MANIFEST_BYTES) {
      throw new UsageError('Manifest must be a regular non-symlink file between 1 byte and 256 KiB');
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!sameFile(expected, fstatSync(fd))) throw new UsageError('Manifest changed before reading');
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_MANIFEST_BYTES || length !== expected.size || !sameFile(expected, fstatSync(fd)) ||
        !sameFile(expected, lstatSync(path))) throw new UsageError('Manifest changed while reading or exceeded 256 KiB');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { throw new UsageError('Manifest must contain valid UTF-8 JSON'); }
    try { return validateUniversePortfolioDefinition(value); }
    catch (error) { throw new UsageError(error instanceof Error ? error.message : 'Invalid portfolio manifest'); }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError('Manifest could not be read as a bounded regular file');
  } finally { if (fd !== undefined) closeSync(fd); }
}

function progress(campaign: UniverseCampaignSummary | null): string {
  if (!campaign || campaign.sourceState !== 'healthy') return 'Campaign progress: unavailable';
  const value = campaign.progress;
  return `Campaign progress: ${value.attempts} attempts · ${value.completedRuns} completed runs` +
    ` · ${value.reservedModelRequests} reserved model requests · ${value.admissions} niche admissions · ${value.improvements} strict improvements` +
    `\n    Model-generation tokens: ${value.usageComplete && value.reportedTokens !== null ? value.reportedTokens : 'unavailable'}` +
    ` · recorded subtotal: ${value.recordedTokens} · campaign deadline: ${campaign.deadlineAt ?? 'not started'}`;
}

function renderPlan(plan: UniversePortfolioPlan): string {
  return [
    `${plan.definition.id} · portfolio plan · source ${plan.sourceState}`,
    `Invocation limits: ${plan.definition.maxParallel} concurrent campaigns · ${plan.definition.maxDurationMs} ms`,
    `Topological order (dependencies first): ${plan.topologicalOrder.join(' → ')}`,
    ...plan.nodes.map((node) => `  ${node.campaignId} · ${node.state} · universe ${node.universeId ?? 'unavailable'}` +
      `\n    Depends on: ${node.dependsOn.join(', ') || 'none'}${node.reason ? ` · ${node.reason}` : ''}` +
      `\n    ${progress(node.campaign)}`),
    ...plan.reasons,
    'Read-only plan. Campaign completion satisfies ordering, not artifact acceptance or production success.',
  ].join('\n');
}

function renderResult(result: UniversePortfolioResult): string {
  return [
    `${result.plan.definition.id} · portfolio ${result.status} · foreground invocation`,
    `Started: ${result.startedAt} · invocation deadline: ${result.deadlineAt} · finished: ${result.finishedAt}`,
    `Invocation concurrency: ${result.plan.definition.maxParallel}; existing campaign budgets and deadlines remain unchanged.`,
    'Initial dependency plan:',
    ...result.plan.nodes.map((node) => `  ${node.campaignId} · ${node.state} · depends on ${node.dependsOn.join(', ') || 'none'}`),
    'Final campaign outcomes:',
    ...result.outcomes.map((outcome) => `  ${outcome.campaignId} · ${outcome.status} · ${outcome.attempted ? 'attempted' : 'not attempted'}` +
      `${outcome.reason ? ` · ${outcome.reason}` : ''}\n    ${progress(outcome.campaign)}`),
    ...result.reasons,
    'Ordering only: no artifact transfer, automatic delivery, push, merge, deployment, or production acceptance.',
    'Token figures cover individual campaigns; unavailable usage is not zero and no portfolio cost is estimated.',
  ].join('\n');
}

/** Portfolio execution remains an explicitly awaited foreground action. */
export async function cmdUniversePortfolio(args: string[]): Promise<number> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  try {
    const options = parse(args);
    if (options.command === 'help') { console.log(USAGE); return 0; }
    const definition = readDefinition(options.manifest!);
    if (options.command === 'plan') {
      const plan = readUniversePortfolioPlan(definition, { root: options.root });
      console.log(options.json ? JSON.stringify(plan, null, 2) : renderPlan(plan));
      return plan.sourceState === 'healthy' && !plan.nodes.some((node) => ['blocked', 'busy', 'unavailable'].includes(node.state)) ? 0 : 1;
    }
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    const result = await runUniversePortfolio(definition, { root: options.root, signal: controller.signal });
    console.log(options.json ? JSON.stringify(result, null, 2) : renderResult(result));
    return result.status === 'completed' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(`universe portfolio: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

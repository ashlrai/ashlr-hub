/**
 * `ashlr eval attention` — metadata-only fleet attention evaluator.
 *
 * This command reads the agent-action ledger and emits aggregate signals about
 * attention concentration, context pressure, retrieval quality, proposal yield,
 * routing cost, evidence outcomes, and causal trajectory coverage. It never
 * reads run states, proposals, diffs, stdout/stderr, prompts, or file contents.
 */

import {
  attentionWindowMs,
  buildAttentionEvalReport,
  type AttentionEvalReport,
  type AttentionEvalWindow,
} from '../core/eval/attention.js';
import { saveAttentionReport } from '../core/eval/attention-store.js';
import {
  filterAgentActionsByRepoScope,
  readAgentActions,
  type AgentActionRepoScope,
} from '../core/fleet/agent-action-ledger.js';
import { makeColors, isTty, pad } from './ui.js';

const { bold, dim, cyan, red, green, yellow, gray } = makeColors(isTty());

interface ParsedArgs {
  window: AttentionEvalWindow;
  limit: number;
  json: boolean;
  save: boolean;
  allRepos: boolean;
  usageError?: string;
}

export interface AttentionEvalCliDeps {
  now?: () => Date;
  readEvents?: typeof readAgentActions;
  listEnrolledRepos?: () => string[];
  saveReport?: typeof saveAttentionReport;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

const DEFAULT_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { window: '1d', limit: DEFAULT_LIMIT, json: false, save: false, allRepos: false };
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--window') {
      const value = args[++i];
      if (value !== '1d' && value !== '7d' && value !== '30d') {
        parsed.usageError = '--window requires one of: 1d, 7d, 30d';
        return parsed;
      }
      parsed.window = value;
      i++;
    } else if (arg === '--limit') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        parsed.usageError = '--limit requires a positive integer';
        return parsed;
      }
      parsed.limit = Math.floor(value);
      i++;
    } else if (arg === '--json') {
      parsed.json = true;
      i++;
    } else if (arg === '--save') {
      parsed.save = true;
      i++;
    } else if (arg === '--all-repos' || arg === '--all') {
      parsed.allRepos = true;
      i++;
    } else if (arg === '--help' || arg === '-h' || arg === 'help') {
      parsed.usageError = 'help';
      return parsed;
    } else {
      parsed.usageError = `unknown flag: ${arg}`;
      return parsed;
    }
  }
  return parsed;
}

export async function cmdEvalAttention(
  args: string[],
  deps: AttentionEvalCliDeps = {},
): Promise<number> {
  const parsed = parseArgs(args);
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));

  if (parsed.usageError === 'help') {
    stdout(renderHelp());
    return 0;
  }
  if (parsed.usageError) {
    stderr(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  const now = deps.now?.() ?? new Date();
  const windowMs = attentionWindowMs(parsed.window);
  const sinceMs = now.getTime() - windowMs;
  const maxFiles = Math.max(1, Math.ceil(windowMs / DAY_MS) + 1);
  const rawEvents = (deps.readEvents ?? readAgentActions)({
    sinceMs,
    limit: parsed.limit,
    maxFiles,
  });
  const repoScope: AgentActionRepoScope = parsed.allRepos ? 'all' : 'enrolled-existing';
  const events = parsed.allRepos
    ? rawEvents
    : filterAgentActionsByRepoScope(rawEvents, {
      repoScope,
      enrolledRepos: safeListEnrolledRepos(deps),
    });
  const report = buildAttentionEvalReport(events, {
    window: parsed.window,
    generatedAt: now,
    limit: parsed.limit,
    repoScope,
  });

  let savedPath: string | undefined;
  if (parsed.save) {
    savedPath = (deps.saveReport ?? saveAttentionReport)(report);
  }

  if (parsed.json) {
    stdout(JSON.stringify({ report, savedPath }, null, 2) + '\n');
  } else {
    stdout(renderReport(report, savedPath));
  }
  return 0;
}

function renderReport(report: AttentionEvalReport, savedPath: string | undefined): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${bold('ashlr eval attention')} ${dim(`— ${report.window} metadata-only fleet report`)}`);
  lines.push('');
  lines.push(`  Window : ${cyan(report.window)}  events ${report.eventCount}  latest ${report.latestAt ?? 'none'}`);
  lines.push(`  Repo   : ${repoLine(report)}`);
  lines.push(`  Context: ${contextLine(report)}`);
  lines.push(`  Recall : ${retrievalLine(report)}`);
  lines.push(`  Yield  : ${yieldLine(report)}`);
  lines.push(`  Route  : ${routeLine(report)}`);
  lines.push(`  Trace  : ${traceLine(report)}`);
  if (report.dataQuality.warnings.length > 0) {
    lines.push(`  Data   : ${yellow(report.dataQuality.warnings.join(', '))}`);
  } else {
    lines.push(`  Data   : ${green('metadata-only, no warnings')}`);
  }
  if (savedPath) lines.push(`  Saved  : ${gray(savedPath)}`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function renderHelp(): string {
  const opts: [string, string][] = [
    ['--window 1d|7d|30d', 'Agent-action ledger window (default: 1d).'],
    ['--limit N', `Maximum events to read (default: ${DEFAULT_LIMIT}).`],
    ['--json', 'Emit JSON { report, savedPath }.'],
    ['--save', 'Persist the report under ~/.ashlr/eval/attention/reports/.'],
    ['--all-repos', 'Include every metadata event, including unenrolled or missing repos.'],
  ];
  const width = Math.max(...opts.map(([flag]) => flag.length));
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${bold('ashlr eval attention')} ${dim('— metadata-only fleet attention report')}`);
  lines.push('');
  lines.push('  ' + bold('Usage:'));
  lines.push('');
  lines.push('    ashlr eval attention [--window 1d|7d|30d] [--limit N] [--json] [--save] [--all-repos]');
  lines.push('');
  lines.push('  ' + bold('Options:'));
  lines.push('');
  for (const [flag, desc] of opts) {
    lines.push(`    ${cyan(pad(flag, width))}  ${desc}`);
  }
  lines.push('');
  lines.push(`  ${gray('Reads only agent-action metadata; it does not inspect run states, proposals, diffs, prompts, or command output.')}`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function repoLine(report: AttentionEvalReport): string {
  const top = report.repoAttention.topRepos[0];
  const share = report.repoAttention.topRepoShare === null
    ? 'n/a'
    : `${Math.round(report.repoAttention.topRepoShare * 100)}%`;
  const verdict = report.repoAttention.verdict === 'concentrated'
    ? yellow(report.repoAttention.verdict)
    : green(report.repoAttention.verdict);
  return `${report.repoAttention.activeRepos} active, top ${top?.repoLabel ?? 'none'} ${share}, entropy ${report.repoAttention.entropy} (${verdict})`;
}

function safeListEnrolledRepos(deps: AttentionEvalCliDeps): string[] | undefined {
  if (!deps.listEnrolledRepos) return undefined;
  try {
    return deps.listEnrolledRepos();
  } catch {
    return [];
  }
}

function contextLine(report: AttentionEvalReport): string {
  const promptAvg = pct(report.contextPressure.promptBudgetRatio.avg);
  const windowMax = pct(report.contextPressure.contextWindowRatio.max);
  const trunc = pct(report.contextPressure.truncationRate);
  return `${report.contextPressure.samples} samples, prompt avg ${promptAvg}, max window ${windowMax}, trunc ${trunc}, dropped ${report.contextPressure.droppedLayerCount}`;
}

function retrievalLine(report: AttentionEvalReport): string {
  return `${report.retrievalQuality.samples} samples, hits ${report.retrievalQuality.hitCount}, injected ${report.retrievalQuality.injectedHitCount}, chars ${report.retrievalQuality.injectedChars}`;
}

function yieldLine(report: AttentionEvalReport): string {
  return `${report.productionYield.proposalCreated}/${report.productionYield.attempts} proposals (${pct(report.productionYield.proposalRate)}), ` +
    `diagnostic ${report.productionYield.proposalCreated}/${report.productionYield.diagnosticAttempts} (${pct(report.productionYield.diagnosticProposalRate)}), ` +
    `no-proposal ${pct(report.productionYield.noProposalRate)}, policy-suppressed ${report.productionYield.policySuppressed}`;
}

function routeLine(report: AttentionEvalReport): string {
  const top = report.routingCost.byBackend[0]?.key ?? 'unknown';
  return `${top}, $${report.routingCost.spendUsd.toFixed(4)}, ${report.routingCost.totalTokens} tok`;
}

function traceLine(report: AttentionEvalReport): string {
  return `${report.trajectory.withTrajectoryId}/${report.eventCount} with trajectory, ${report.trajectory.distinctTrajectories} distinct`;
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

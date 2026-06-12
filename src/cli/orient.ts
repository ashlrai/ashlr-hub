/**
 * cli/orient.ts — `ashlr orient [--repo <r>] [--json]` (M31).
 *
 * The session-start command for agents AND humans: one read-only call that
 * answers "what should I know before I start working here" — genome memory,
 * health, backlog, pending proposals, portfolio attention.
 *
 * CLI-FIRST AGENT CONTRACT:
 *   - `--json` emits a stable OrientResult (src/core/types.ts) on stdout,
 *     no ANSI, exit 0. This shape is part of the M31 contract.
 *   - Exit codes: 0 success, 2 bad usage. (Sections are best-effort; a
 *     missing store yields empty sections, never a non-zero exit.)
 */

import { loadConfig } from '../core/config.js';
import { buildOrientation } from '../core/orient.js';
import { makeColors, isTty, pad } from './ui.js';

function printOrientHelp(): void {
  const c = makeColors(isTty());
  console.log('');
  console.log(c.bold('  ashlr orient') + c.dim(' — session-start context (read-only)'));
  console.log('');
  console.log('  Usage:');
  console.log(`    ${c.cyan('ashlr orient')}                   ${c.dim('portfolio-wide orientation')}`);
  console.log(`    ${c.cyan('ashlr orient --repo <path>')}     ${c.dim('scope to one repo')}`);
  console.log(`    ${c.cyan('ashlr orient --json')}            ${c.dim('stable OrientResult JSON (agent contract)')}`);
  console.log('');
  console.log('  ' + c.dim('Agents: run this once at session start; see `ashlr docs --agent`.'));
  console.log('');
}

export async function cmdOrient(args: string[]): Promise<number> {
  const json = args.includes('--json');
  let repo: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') continue;
    if (a === '--help' || a === '-h' || a === 'help') {
      printOrientHelp();
      return 0;
    }
    if (a === '--repo') {
      const val = args[i + 1];
      if (!val || val.startsWith('--')) {
        process.stderr.write('error: --repo requires a path\n');
        return 2;
      }
      repo = val;
      i++;
      continue;
    }
    process.stderr.write(`error: unknown argument: ${a}\n`);
    printOrientHelp();
    return 2;
  }

  const cfg = loadConfig();
  const result = await buildOrientation(cfg, repo);

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }

  const c = makeColors(isTty());
  console.log('');
  console.log(
    c.bold('  ashlr orient') +
    c.dim(result.repo ? ` — ${result.repo}` : ' — portfolio-wide'),
  );
  console.log('');

  // ── Memory ──────────────────────────────────────────────────────────────
  console.log('  ' + c.bold('Memory') + c.dim(` (${result.genomeHits.length} hits)`));
  if (result.genomeHits.length === 0) {
    console.log(c.dim('    none — seed with `ashlr learn "<text>"`'));
  }
  for (const hit of result.genomeHits) {
    const scope = hit.project ? c.dim(` [${hit.project}]`) : '';
    console.log(`    ${c.cyan('•')} ${hit.title}${scope}`);
  }
  console.log('');

  // ── Health ──────────────────────────────────────────────────────────────
  console.log('  ' + c.bold('Health'));
  if (result.health) {
    console.log(
      `    ${c.cyan(String(result.health.score))} (${result.health.grade})` +
      (result.health.worstDimensions.length
        ? c.dim(`  worst: ${result.health.worstDimensions.join(', ')}`)
        : ''),
    );
  } else {
    console.log(c.dim('    no health report — run `ashlr health`'));
  }
  console.log('');

  // ── Backlog ─────────────────────────────────────────────────────────────
  console.log('  ' + c.bold('Backlog') + c.dim(` (top ${result.backlogItems.length})`));
  if (result.backlogItems.length === 0) {
    console.log(c.dim('    none persisted — run `ashlr backlog refresh`'));
  }
  for (const item of result.backlogItems) {
    console.log(
      `    ${c.cyan(pad(String(item.score), 4, 'right'))}  ${c.dim(`[${item.source}]`)} ${item.title}`,
    );
  }
  console.log('');

  // ── Attention + inbox ───────────────────────────────────────────────────
  const att = result.attention;
  const attText = att
    ? `${att.dirtyRepos} dirty, ${att.staleRepos} stale repos`
    : 'no index — run `ashlr index`';
  console.log('  ' + c.bold('Attention  ') + attText);
  console.log(
    '  ' + c.bold('Inbox      ') +
    (result.pendingProposals > 0
      ? c.yellow(`${result.pendingProposals} pending proposal(s) — review with \`ashlr inbox\``)
      : c.dim('no pending proposals')),
  );
  console.log('');
  return 0;
}

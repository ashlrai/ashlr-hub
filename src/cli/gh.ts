/**
 * `ashlr gh` — GitHub integration subcommand.
 *
 * Usage:
 *   ashlr gh pr [list] [--json]
 *   ashlr gh issue [list] [--json]
 *   ashlr gh ci [--json]
 *   ashlr gh pr create --title <title> [--body <body>] [--base <branch>]
 *                       [--head <branch>] [--draft] [--yes]
 *
 * READ-FIRST: pr/issue/ci subcommands are read-only and never throw.
 * MUTATION: `pr create` is the ONLY mutation; requires explicit confirm (or --yes).
 * Non-TTY safe: --yes bypasses the confirm prompt in scripted environments.
 *
 * Reads via `gh` CLI (which owns its own auth); no raw tokens ever touched.
 *
 * Exit codes:
 *   0  success
 *   1  operation failed
 *   2  bad usage
 */

import { createInterface } from 'node:readline';
import { pad, makeColors, isTty } from './ui.js';

const { bold, dim, red, green, yellow, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy import — integrations built by another agent; degrade gracefully
// ---------------------------------------------------------------------------

async function importGithub() {
  return import('../core/integrations/github.js') as Promise<
    typeof import('../core/integrations/github.js')
  >;
}

// ---------------------------------------------------------------------------
// Non-TTY-safe confirm
// ---------------------------------------------------------------------------

async function confirmAction(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ---------------------------------------------------------------------------
// Subcommand: gh pr list
// ---------------------------------------------------------------------------

async function cmdGhPrList(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const cwd = process.cwd();

  let mod: Awaited<ReturnType<typeof importGithub>>;
  try {
    mod = await importGithub();
  } catch {
    process.stderr.write(red('error: ') + 'GitHub integration module not yet available.\n');
    return 1;
  }

  const prs = mod.listPrs(cwd);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(prs, null, 2) + '\n');
    return 0;
  }

  if (prs.length === 0) {
    console.log(dim('  No open pull requests.'));
    return 0;
  }

  const numW   = 5;
  const stateW = 8;
  const authW  = Math.max(8, ...prs.map(p => p.author.length));
  const titleW = 50;

  console.log('');
  console.log(bold('  Pull Requests') + gray(`  — ${prs.length} open`));
  console.log('');
  console.log(
    `  ${bold(pad('#', numW))}  ${bold(pad('State', stateW))}  ` +
    `${bold(pad('Author', authW))}  ${bold('Title')}`,
  );
  console.log(`  ${'─'.repeat(numW)}  ${'─'.repeat(stateW)}  ${'─'.repeat(authW)}  ${'─'.repeat(titleW)}`);

  for (const pr of prs) {
    const stateColor = pr.state === 'open' ? green : dim;
    const titleTrunc = pr.title.length > titleW ? pr.title.slice(0, titleW - 1) + '…' : pr.title;
    console.log(
      `  ${dim(pad(String(pr.number), numW))}  ${stateColor(pad(pr.state, stateW))}  ` +
      `${pad(pr.author, authW)}  ${titleTrunc}`,
    );
    console.log(`  ${''.padStart(numW)}  ${''.padStart(stateW)}  ${''.padStart(authW)}  ${dim(pr.url)}`);
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: gh issue list
// ---------------------------------------------------------------------------

async function cmdGhIssueList(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const cwd = process.cwd();

  let mod: Awaited<ReturnType<typeof importGithub>>;
  try {
    mod = await importGithub();
  } catch {
    process.stderr.write(red('error: ') + 'GitHub integration module not yet available.\n');
    return 1;
  }

  const issues = mod.listIssues(cwd);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(issues, null, 2) + '\n');
    return 0;
  }

  if (issues.length === 0) {
    console.log(dim('  No open issues.'));
    return 0;
  }

  const numW   = 5;
  const stateW = 8;
  const authW  = Math.max(8, ...issues.map(i => i.author.length));
  const titleW = 50;

  console.log('');
  console.log(bold('  Issues') + gray(`  — ${issues.length} open`));
  console.log('');
  console.log(
    `  ${bold(pad('#', numW))}  ${bold(pad('State', stateW))}  ` +
    `${bold(pad('Author', authW))}  ${bold('Title')}`,
  );
  console.log(`  ${'─'.repeat(numW)}  ${'─'.repeat(stateW)}  ${'─'.repeat(authW)}  ${'─'.repeat(titleW)}`);

  for (const issue of issues) {
    const stateColor = issue.state === 'open' ? yellow : dim;
    const titleTrunc = issue.title.length > titleW ? issue.title.slice(0, titleW - 1) + '…' : issue.title;
    console.log(
      `  ${dim(pad(String(issue.number), numW))}  ${stateColor(pad(issue.state, stateW))}  ` +
      `${pad(issue.author, authW)}  ${titleTrunc}`,
    );
    console.log(`  ${''.padStart(numW)}  ${''.padStart(stateW)}  ${''.padStart(authW)}  ${dim(issue.url)}`);
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: gh ci
// ---------------------------------------------------------------------------

async function cmdGhCi(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const cwd = process.cwd();

  let mod: Awaited<ReturnType<typeof importGithub>>;
  try {
    mod = await importGithub();
  } catch {
    process.stderr.write(red('error: ') + 'GitHub integration module not yet available.\n');
    return 1;
  }

  const status = mod.githubStatus(cwd);

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ci: status.ci, repo: status.repo, isRepo: status.isRepo }, null, 2) + '\n');
    return 0;
  }

  if (!status.isRepo) {
    console.log(dim('  Not a GitHub repository.'));
    return 0;
  }

  const ciColor =
    status.ci === 'passing' ? green :
    status.ci === 'failing' ? red :
    status.ci === 'pending' ? yellow :
    dim;

  const ciLabel = status.ci === 'none' ? dim('no checks') : ciColor(status.ci);

  console.log('');
  console.log(
    `  ${bold('CI')}  ${ciLabel}` +
    (status.repo ? gray(`  —  ${status.repo}`) : ''),
  );
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: gh pr create (EXPLICIT MUTATION — confirm-gated)
// ---------------------------------------------------------------------------

async function cmdGhPrCreate(args: string[]): Promise<number> {
  // Parse flags
  const titleIdx = args.indexOf('--title');
  const bodyIdx  = args.indexOf('--body');
  const baseIdx  = args.indexOf('--base');
  const headIdx  = args.indexOf('--head');
  const draft    = args.includes('--draft');
  const yes      = args.includes('--yes');
  const jsonMode = args.includes('--json');

  const title = titleIdx !== -1 ? args[titleIdx + 1] : undefined;

  if (!title || title.startsWith('--')) {
    process.stderr.write(red('error: ') + '--title <title> is required for `ashlr gh pr create`\n');
    return 2;
  }

  const body  = bodyIdx !== -1 && args[bodyIdx + 1] && !args[bodyIdx + 1]!.startsWith('--')
    ? args[bodyIdx + 1]
    : undefined;
  const base  = baseIdx !== -1 && args[baseIdx + 1] && !args[baseIdx + 1]!.startsWith('--')
    ? args[baseIdx + 1]
    : undefined;
  const head  = headIdx !== -1 && args[headIdx + 1] && !args[headIdx + 1]!.startsWith('--')
    ? args[headIdx + 1]
    : undefined;

  // Show what will be created before prompting
  if (!jsonMode) {
    console.log('');
    console.log(bold('  Create Pull Request'));
    console.log('');
    console.log(`  ${bold('Title:')}  ${title}`);
    if (body)  console.log(`  ${bold('Body:')}   ${body}`);
    if (base)  console.log(`  ${bold('Base:')}   ${base}`);
    if (head)  console.log(`  ${bold('Head:')}   ${head}`);
    if (draft) console.log(`  ${bold('Draft:')}  yes`);
    console.log('');
    console.log(yellow('  This will create a real pull request on GitHub.'));
    console.log('');
  }

  // Confirm gate — non-TTY safe (--yes bypasses; non-TTY defaults to no)
  const proceed = yes || await confirmAction('  Proceed? [y/N] ');
  if (!proceed) {
    if (!jsonMode) {
      console.log(dim('  Aborted — no PR created.'));
    } else {
      process.stdout.write(JSON.stringify({ ok: false, url: null, detail: 'aborted by user' }, null, 2) + '\n');
    }
    return 0;
  }

  let mod: Awaited<ReturnType<typeof importGithub>>;
  try {
    mod = await importGithub();
  } catch {
    process.stderr.write(red('error: ') + 'GitHub integration module not yet available.\n');
    return 1;
  }

  let result: Awaited<ReturnType<typeof mod.createPr>>;
  try {
    result = await mod.createPr(process.cwd(), { title, body, base, head, draft });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(red('error: ') + `createPr failed: ${msg}\n`);
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    console.log(green('  ✓ Pull request created'));
    if (result.url) console.log(`  ${cyan(result.url)}`);
  } else {
    console.log(red('  ✗ Failed to create pull request'));
    console.log(`  ${dim(result.detail)}`);
  }
  console.log('');
  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printGhHelp(): void {
  console.log('');
  console.log(bold('  ashlr gh') + dim(' — GitHub integration (read-first; mutations gated)'));
  console.log('');
  console.log('  ' + bold('Subcommands:'));
  console.log('');

  const cmds: [string, string][] = [
    ['pr [list] [--json]',                                  'List open pull requests (read-only).'],
    ['issue [list] [--json]',                               'List open issues (read-only).'],
    ['ci [--json]',                                         'Show CI status for the current repo (read-only).'],
    ['pr create --title <t> [--body <b>] [--base <b>]',    'Create a PR (MUTATION — requires confirm or --yes).'],
    ['          [--head <h>] [--draft] [--yes] [--json]',  ''],
  ];

  const w = Math.max(...cmds.map(([c]) => c.length));
  for (const [cmd, desc] of cmds) {
    if (desc) {
      console.log(`    ${cyan(pad(cmd, w))}  ${desc}`);
    } else {
      console.log(`    ${cyan(cmd)}`);
    }
  }
  console.log('');
  console.log('  ' + bold('Safety:'));
  console.log('');
  console.log(`    ${dim('• pr/issue/ci are read-only — no GitHub mutations.')}`);
  console.log(`    ${dim('• pr create shows a preview and prompts before creating.')}`);
  console.log(`    ${dim('• --yes skips the interactive prompt (scripted/CI use).')}`);
  console.log(`    ${dim('• Non-TTY without --yes: aborts instead of creating silently.')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdGh — main entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr gh <pr|issue|ci>` — read-only GitHub info.
 * `ashlr gh pr create` — ONLY mutation; requires explicit confirm.
 * Returns a process exit code.
 */
export async function cmdGh(args: string[]): Promise<number> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printGhHelp();
    return 0;
  }

  // `ashlr gh pr [list|create]`
  if (sub === 'pr') {
    const action = args[1];
    if (action === 'create') {
      return cmdGhPrCreate(args.slice(2));
    }
    // Default: list (also handles `pr list`)
    return cmdGhPrList(args.slice(1).filter(a => a !== 'list'));
  }

  // `ashlr gh issue [list]`
  if (sub === 'issue' || sub === 'issues') {
    return cmdGhIssueList(args.slice(1).filter(a => a !== 'list'));
  }

  // `ashlr gh ci`
  if (sub === 'ci') {
    return cmdGhCi(args.slice(1));
  }

  process.stderr.write(red('error: ') + `unknown gh subcommand: ${bold(sub)}\n`);
  process.stderr.write(dim('Run `ashlr gh help` for usage.\n'));
  return 2;
}

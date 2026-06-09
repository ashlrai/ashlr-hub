/**
 * `ashlr vercel` — Vercel integration subcommand (read-only).
 *
 * Usage:
 *   ashlr vercel ls [--json]          — list recent deployments
 *   ashlr vercel logs [--json]        — show latest deployment logs
 *
 * READ-FIRST: all subcommands are read-only. Deploy lives in `ashlr ship --deploy vercel`.
 * Reads via `vercel` CLI (which owns its own auth); no raw tokens ever touched.
 *
 * Exit codes:
 *   0  success
 *   1  operation failed
 *   2  bad usage
 */

import { pad, makeColors, isTty } from './ui.js';

const { bold, dim, red, green, yellow, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy import — integrations built by another agent; degrade gracefully
// ---------------------------------------------------------------------------

async function importVercel() {
  return import('../core/integrations/vercel.js') as Promise<
    typeof import('../core/integrations/vercel.js')
  >;
}

// ---------------------------------------------------------------------------
// Subcommand: vercel ls
// ---------------------------------------------------------------------------

async function cmdVercelLs(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const cwd = process.cwd();

  let mod: Awaited<ReturnType<typeof importVercel>>;
  try {
    mod = await importVercel();
  } catch {
    process.stderr.write(red('error: ') + 'Vercel integration module not yet available.\n');
    return 1;
  }

  const status = mod.vercelStatus(cwd);

  if (!status.linked) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ linked: false, deploys: [] }, null, 2) + '\n');
    } else {
      console.log(dim('  No Vercel project linked in this directory.'));
      console.log(dim('  Run `vercel link` to link a project.'));
    }
    return 0;
  }

  const deploys = mod.listDeploys(cwd);

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ linked: true, status, deploys }, null, 2) + '\n');
    return 0;
  }

  console.log('');
  console.log(bold('  Vercel Deployments') + gray(`  — ${deploys.length} recent`));
  if (status.url) {
    console.log(`  ${dim('latest:')}  ${cyan(status.url)}  ${stateLabel(status.latestState)}`);
  }
  console.log('');

  if (deploys.length === 0) {
    console.log(dim('  No deployments found.'));
    console.log('');
    return 0;
  }

  const urlW    = Math.min(50, Math.max(20, ...deploys.map(d => d.url.length)));
  const stateW  = 10;
  const targetW = Math.max(10, ...deploys.map(d => (d.target ?? '—').length));
  const dateW   = 24;

  console.log(
    `  ${bold(pad('URL', urlW))}  ${bold(pad('State', stateW))}  ` +
    `${bold(pad('Target', targetW))}  ${bold(pad('Created', dateW))}`,
  );
  console.log(
    `  ${'─'.repeat(urlW)}  ${'─'.repeat(stateW)}  ${'─'.repeat(targetW)}  ${'─'.repeat(dateW)}`,
  );

  for (const d of deploys) {
    const urlTrunc = d.url.length > urlW ? d.url.slice(0, urlW - 1) + '…' : d.url;
    const targetStr = d.target ?? dim('—');
    const dateStr = d.createdAt
      ? (() => {
          try { return new Date(d.createdAt).toLocaleString(); } catch { return d.createdAt; }
        })()
      : dim('—');

    console.log(
      `  ${pad(urlTrunc, urlW)}  ${pad(stateLabel(d.state), stateW)}  ` +
      `${pad(targetStr, targetW)}  ${dim(dateStr)}`,
    );
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: vercel logs
// ---------------------------------------------------------------------------

async function cmdVercelLogs(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const cwd = process.cwd();

  let mod: Awaited<ReturnType<typeof importVercel>>;
  try {
    mod = await importVercel();
  } catch {
    process.stderr.write(red('error: ') + 'Vercel integration module not yet available.\n');
    return 1;
  }

  const status = mod.vercelStatus(cwd);

  if (!status.linked || !status.url) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ linked: false, logs: null }, null, 2) + '\n');
    } else {
      console.log(dim('  No Vercel project linked or no deployment found.'));
    }
    return 0;
  }

  if (jsonMode) {
    // Surface what we have — detailed log streaming would require the vercel CLI interactively
    process.stdout.write(JSON.stringify({ linked: true, latestUrl: status.url, latestState: status.latestState }, null, 2) + '\n');
    return 0;
  }

  console.log('');
  console.log(bold('  Vercel Latest Deployment'));
  console.log('');
  console.log(`  ${bold('URL:')}    ${cyan(status.url)}`);
  console.log(`  ${bold('State:')}  ${stateLabel(status.latestState)}`);
  console.log('');
  console.log(dim(`  For full streaming logs: vercel logs ${status.url}`));
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateLabel(state: string | null): string {
  if (!state) return dim('unknown');
  const s = state.toLowerCase();
  if (s === 'ready')   return green(state);
  if (s === 'error')   return red(state);
  if (s === 'building' || s === 'queued') return yellow(state);
  return dim(state);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printVercelHelp(): void {
  console.log('');
  console.log(bold('  ashlr vercel') + dim(' — Vercel integration (read-only)'));
  console.log('');
  console.log('  ' + bold('Subcommands:'));
  console.log('');

  const cmds: [string, string][] = [
    ['ls [--json]',    'List recent deployments for the linked project.'],
    ['logs [--json]',  'Show latest deployment URL + state; hint for full streaming logs.'],
  ];

  const w = Math.max(...cmds.map(([c]) => c.length));
  for (const [cmd, desc] of cmds) {
    console.log(`    ${cyan(pad(cmd, w))}  ${desc}`);
  }
  console.log('');
  console.log('  ' + bold('Notes:'));
  console.log('');
  console.log(`    ${dim('• All subcommands are read-only. Deploy lives in `ashlr ship --deploy vercel --confirm`.')}`);
  console.log(`    ${dim('• Requires a linked Vercel project (run `vercel link` first).')}`);
  console.log(`    ${dim('• Auth is handled by the `vercel` CLI — no tokens handled here.')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdVercel — main entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr vercel <ls|logs>` — read-only Vercel deployment info.
 * Deploy lives in `ashlr ship`. Returns a process exit code.
 */
export async function cmdVercel(args: string[]): Promise<number> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printVercelHelp();
    return 0;
  }

  if (sub === 'ls' || sub === 'list') {
    return cmdVercelLs(args.slice(1));
  }

  if (sub === 'logs' || sub === 'log') {
    return cmdVercelLogs(args.slice(1));
  }

  process.stderr.write(red('error: ') + `unknown vercel subcommand: ${bold(sub)}\n`);
  process.stderr.write(dim('Run `ashlr vercel help` for usage.\n'));
  return 2;
}

/**
 * `ashlr notify` — notification webhook subcommand.
 *
 * Usage:
 *   ashlr notify test [--json]
 *
 * Sends a test ping to configured webhook(s) (cfg.notify.slackWebhook /
 * cfg.notify.discordWebhook). Informative no-op (exit 0) when none configured —
 * explains how to set one up. Never posts without a configured webhook.
 *
 * Exit codes:
 *   0  test ping sent (or no webhook configured — informative)
 *   1  test ping failed
 *   2  bad usage
 */

import { makeColors, isTty } from './ui.js';
import { loadConfig } from '../core/config.js';

const { bold, dim, red, green, yellow, cyan } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy import — integrations built by another agent; degrade gracefully
// ---------------------------------------------------------------------------

async function importNotify() {
  return import('../core/integrations/notify.js') as Promise<
    typeof import('../core/integrations/notify.js')
  >;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printNotifyHelp(): void {
  console.log('');
  console.log(bold('  ashlr notify') + dim(' — notification webhook (opt-in)'));
  console.log('');
  console.log('  ' + bold('Subcommands:'));
  console.log('');
  console.log(`    ${cyan('test [--json]')}  Send a test ping to configured webhook(s).`);
  console.log('');
  console.log('  ' + bold('How to configure:'));
  console.log('');
  console.log(`    Add ${bold('notify')} to your ${dim('~/.ashlr/config.json')}:`);
  console.log('');
  console.log(`    ${dim('"notify": {')}`);
  console.log(`    ${dim('  "slackWebhook":   "https://hooks.slack.com/services/..."')}`);
  console.log(`    ${dim('  "discordWebhook": "https://discord.com/api/webhooks/..."')}`);
  console.log(`    ${dim('}')}`);
  console.log('');
  console.log('  ' + bold('Notes:'));
  console.log('');
  console.log(`    ${dim('• No-op (safe, informative exit 0) when no webhook is configured.')}`);
  console.log(`    ${dim('• Posts concise summaries only — no secrets, no raw tokens.')}`);
  console.log(`    ${dim('• Automatic posting only happens when a run/swarm completes and')}`);
  console.log(`    ${dim('  notify is called explicitly from that flow — never from reads.')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Subcommand: notify test
// ---------------------------------------------------------------------------

async function cmdNotifyTest(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');

  // Load config — degrade gracefully if unavailable
  let cfg: Awaited<ReturnType<typeof loadConfig>>;
  try {
    cfg = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ sent: false, detail: `config load failed: ${msg}` }, null, 2) + '\n');
    } else {
      process.stderr.write(red('error: ') + `Could not load config: ${msg}\n`);
    }
    return 1;
  }

  // No webhook configured → informative no-op
  const hasSlack   = Boolean(cfg.notify?.slackWebhook);
  const hasDiscord = Boolean(cfg.notify?.discordWebhook);

  if (!hasSlack && !hasDiscord) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({
        sent: false,
        configured: false,
        detail: 'no webhook configured',
        hint: 'Add notify.slackWebhook or notify.discordWebhook to ~/.ashlr/config.json',
      }, null, 2) + '\n');
    } else {
      console.log('');
      console.log(yellow('  No notification webhook configured.'));
      console.log('');
      console.log('  To enable notifications, add to ' + dim('~/.ashlr/config.json') + ':');
      console.log('');
      console.log(`    ${dim('"notify": {')}`);
      console.log(`    ${dim('  "slackWebhook":   "https://hooks.slack.com/services/..."')}`);
      console.log(`    ${dim('  "discordWebhook": "https://discord.com/api/webhooks/..."')}`);
      console.log(`    ${dim('}')}`);
      console.log('');
      console.log(dim('  Run `ashlr notify test` again once a webhook is configured.'));
      console.log('');
    }
    return 0;
  }

  // Load the notify module
  let mod: Awaited<ReturnType<typeof importNotify>>;
  try {
    mod = await importNotify();
  } catch {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ sent: false, detail: 'notify module not yet available' }, null, 2) + '\n');
    } else {
      process.stderr.write(red('error: ') + 'Notify integration module not yet available.\n');
    }
    return 1;
  }

  const targets: string[] = [];
  if (hasSlack)   targets.push('Slack');
  if (hasDiscord) targets.push('Discord');

  if (!jsonMode) {
    console.log('');
    console.log(bold('  ashlr notify test'));
    console.log('');
    console.log(`  Sending test ping to: ${targets.map(t => cyan(t)).join(', ')}`);
    console.log('');
  }

  const text = `ashlr notify test — connection check from ashlr-hub (${new Date().toISOString()})`;

  let ok: boolean;
  try {
    ok = await mod.notify(text, cfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ sent: false, detail: msg }, null, 2) + '\n');
    } else {
      console.log(red(`  ✗ Failed: ${msg}`));
      console.log('');
    }
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ sent: ok, targets, detail: ok ? 'ping sent' : 'post failed' }, null, 2) + '\n');
    return ok ? 0 : 1;
  }

  if (ok) {
    console.log(green(`  ✓ Test ping sent to: ${targets.join(', ')}`));
  } else {
    console.log(red('  ✗ Failed to send test ping — check webhook URL and network.'));
  }
  console.log('');
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// cmdNotify — main entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr notify test` — send a test ping to configured webhook(s).
 * Informative no-op when no webhook is configured. Returns a process exit code.
 */
export async function cmdNotify(args: string[]): Promise<number> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printNotifyHelp();
    return 0;
  }

  if (sub === 'test') {
    return cmdNotifyTest(args.slice(1));
  }

  process.stderr.write(red('error: ') + `unknown notify subcommand: ${bold(sub)}\n`);
  process.stderr.write(dim('Run `ashlr notify help` for usage.\n'));
  return 2;
}

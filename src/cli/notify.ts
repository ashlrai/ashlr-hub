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

import { basename } from 'node:path';
import { makeColors, isTty } from './ui.js';
import { loadConfig } from '../core/config.js';
import { editorDeepLink } from './open.js';
import type { AshlrConfig } from '../core/types.js';

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
  console.log(`    ${cyan('test [--json]')}     Send a test ping to configured webhook(s).`);
  console.log(`    ${cyan('session [opts]')}    Notify on a Claude Code Stop/Notification hook.`);
  console.log('');
  console.log('  ' + bold('session options:'));
  console.log('');
  console.log(`    ${dim('--event <stop|notification>   what happened (default: stop)')}`);
  console.log(`    ${dim('--cwd <path>                  project dir (default: payload cwd / cwd)')}`);
  console.log(`    ${dim('--message <text>              body for the notification event')}`);
  console.log(`    ${dim('--editor <vscode|cursor>      editor the toast click opens (default: cfg.editor)')}`);
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

  // M32: opt-in desktop ping (macOS) — fired alongside the webhook test.
  let desktopSent = false;
  try {
    const { desktopNotify, desktopNotifyEnabled } = await import('../core/integrations/desktop-notify.js');
    if (desktopNotifyEnabled(cfg)) {
      desktopSent = await desktopNotify('ashlr', 'notify test — desktop notifications are working', cfg);
      if (!jsonMode && desktopSent) {
        process.stdout.write('desktop notification sent ✓\n');
      }
    }
  } catch { /* desktop ping is best-effort */ }

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
// Subcommand: notify session  (called by the Claude Code Stop/Notification hook)
// ---------------------------------------------------------------------------

/** Read a `--flag value` pair from args; returns undefined when absent/dangling. */
function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
    return args[i + 1];
  }
  return undefined;
}

/** Parse a stdin string as a JSON object, or null on any failure. */
function parseJsonObject(s: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read a hook JSON payload from stdin. Claude Code pipes a JSON context (with
 * `cwd`, `message`, …) to hook commands.
 *
 * Reads with a BOUNDED async read that ALWAYS settles — resolving on stream
 * `end` (the normal hook case: Claude writes the JSON then closes stdin) or
 * after a short safety timeout, whichever is first. A synchronous fd-0 read was
 * tried and rejected: it BLOCKS FOREVER when stdin is an open pipe with no EOF
 * (some hook runners leave it open), which would hang the hook and stall Claude
 * after every turn. Only reads when stdin is not a TTY; interactive use returns
 * null immediately. Returns null on any error / non-object / timeout-with-no-data.
 */
function readStdinPayload(): Promise<Record<string, unknown> | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (v: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
        process.stdin.pause();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    // Safety net: never wait more than this for a payload that never EOFs.
    const timer = setTimeout(() => finish(parseJsonObject(buf)), 800);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c: string) => {
        buf += c;
        if (buf.length > 65_536) finish(parseJsonObject(buf));
      });
      process.stdin.on('end', () => finish(parseJsonObject(buf)));
      process.stdin.on('error', () => finish(null));
      process.stdin.resume();
    } catch {
      finish(null);
    }
  });
}

/**
 * `ashlr notify session` — raise a desktop notification (and post to any
 * configured webhook) when a Claude Code session finishes or needs input.
 *
 * Designed to be invoked from the Claude Code Stop / Notification hooks:
 *   ashlr notify session --event stop --editor vscode
 *
 * Flags (all optional):
 *   --event <stop|notification>  what happened (default: stop)
 *   --cwd <path>                 project dir (default: hook payload cwd / process.cwd())
 *   --message <text>             body override for the notification event
 *   --editor <vscode|cursor>     editor to deep-link the click to (default: cfg.editor)
 *   --json                       emit a machine-readable result
 *
 * Best-effort by contract: ALWAYS returns 0 so a notification failure never
 * fails the hook (and never blocks Claude). Desktop toast is opt-in via
 * cfg.notify.desktop; webhook post is opt-in via cfg.notify.{slack,discord}Webhook.
 */
async function cmdNotifySession(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const wasPiped = !process.stdin.isTTY;

  const rawEvent = readFlag(args, '--event') ?? 'stop';
  const event = rawEvent === 'notification' ? 'notification' : 'stop';
  const cwdFlag = readFlag(args, '--cwd');
  const msgFlag = readFlag(args, '--message');
  const editorFlag = readFlag(args, '--editor');

  const payload = await readStdinPayload();
  const cwd =
    cwdFlag ||
    (typeof payload?.['cwd'] === 'string' ? (payload['cwd'] as string) : '') ||
    process.cwd();
  const message =
    msgFlag ||
    (typeof payload?.['message'] === 'string' ? (payload['message'] as string) : '');

  const project = basename(cwd) || 'Claude Code';

  const title =
    event === 'notification'
      ? `Claude needs input — ${project}`
      : `Claude finished — ${project}`;
  const body =
    event === 'notification'
      ? message || 'Waiting for your response'
      : 'Ready for your next instruction';

  // Config — degrade gracefully if it cannot be loaded.
  let cfg: AshlrConfig | null = null;
  try {
    cfg = loadConfig();
  } catch {
    cfg = null;
  }

  // Deep link the click back to the project's editor window. Prefer the
  // explicit --editor flag (the hook pins this to 'vscode' where Claude runs),
  // else fall back to the configured editor.
  let launchUri: string | undefined;
  if (cfg) {
    const editor: AshlrConfig['editor'] =
      editorFlag === 'vscode' || editorFlag === 'cursor' ? editorFlag : cfg.editor;
    try {
      launchUri = editorDeepLink(cwd, editor);
    } catch {
      launchUri = undefined;
    }
  }

  // Desktop toast (opt-in via cfg.notify.desktop).
  let desktopSent = false;
  if (cfg) {
    try {
      const { desktopNotify } = await import('../core/integrations/desktop-notify.js');
      desktopSent = await desktopNotify(title, body, cfg, {
        launchUri,
        openLabel: `Open ${project}`,
      });
    } catch {
      /* best-effort */
    }
  }

  // Webhook post (opt-in; strict no-op when no webhook configured).
  let webhookSent = false;
  if (cfg) {
    try {
      const mod = await importNotify();
      webhookSent = await mod.notify(`${title} — ${body}`, cfg);
    } catch {
      /* best-effort */
    }
  }

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({ event, project, desktopSent, webhookSent }, null, 2) + '\n',
    );
  } else if (!wasPiped) {
    // Interactive run — print a one-liner. In hook context (piped) stay silent.
    console.log(
      dim(
        `notify session: ${event} · ${project} · desktop=${desktopSent} webhook=${webhookSent}`,
      ),
    );
  }

  return 0;
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

  if (sub === 'session') {
    return cmdNotifySession(args.slice(1));
  }

  process.stderr.write(red('error: ') + `unknown notify subcommand: ${bold(sub)}\n`);
  process.stderr.write(dim('Run `ashlr notify help` for usage.\n'));
  return 2;
}

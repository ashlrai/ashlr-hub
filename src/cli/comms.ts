/**
 * M137/M147: `ashlr comms` — bidirectional channel CLI.
 *
 * Supports two transports selected by cfg.comms.channel:
 *   'imessage'  (default) — macOS iMessage via osascript + chat.db
 *   'telegram'            — Telegram Bot API (replaces broken iMessage-to-self)
 *
 * Subcommands:
 *   status                           Config + pending/outstanding + watermark.
 *   send-test                        Post + send a test 'report' to verify the channel.
 *   cycle                            Run one runCommsCycle (send pending + poll replies).
 *   ask "<text>" -o "a" -o "b"       Post a test question with numbered options.
 *   digest                           Build oversight snapshot + send summary.
 *   ask-vision                       Run strategist + post elon-vision question.
 *   ask-merges                       Post ship proposals for approval + run cycle.
 *   setup-telegram                   Print Telegram setup steps + discover chat id.
 *
 * Exit codes: 0 success, 1 error, 2 bad usage.
 */

import { loadConfig } from '../core/config.js';
import { commsEnabled } from '../core/integrations/imessage.js';
import { telegramEnabled } from '../core/integrations/telegram.js';
import { listRequests, outstanding, postRequest } from '../core/comms/requests.js';
import { runCommsCycle } from '../core/comms/dispatch.js';
import { registerCommsHandlers } from '../core/comms/handlers.js';
import { buildOversightSnapshot } from '../core/fleet/oversight-export.js';
import { runStrategist, loadLatestBriefing } from '../core/vision/strategist.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statePath(): string {
  return join(homedir(), '.ashlr', 'comms', 'state.json');
}

function loadWatermark(): number {
  try {
    if (!existsSync(statePath())) return 0;
    const raw = readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as { watermarkMs?: number };
    return typeof parsed.watermarkMs === 'number' ? parsed.watermarkMs : 0;
  } catch {
    return 0;
  }
}

function parseArgs(args: string[]): { sub: string; text: string; options: string[] } {
  const sub = args[0] ?? 'status';
  let text = '';
  const options: string[] = [];
  let i = 1;
  while (i < args.length) {
    const a = args[i]!;
    if ((a === '-o' || a === '--option') && i + 1 < args.length) {
      options.push(args[i + 1]!);
      i += 2;
    } else if (!text && !a.startsWith('-')) {
      text = a;
      i++;
    } else {
      i++;
    }
  }
  return { sub, text, options };
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

/** True when any configured channel is ready (iMessage or Telegram). */
function channelEnabled(cfg: Parameters<typeof commsEnabled>[0]): boolean {
  return commsEnabled(cfg) || telegramEnabled(cfg);
}

async function cmdStatus(): Promise<number> {
  const cfg = await loadConfig();
  const channel = cfg.comms?.channel ?? 'imessage';
  const isTelegram = telegramEnabled(cfg);
  const isIMessage = commsEnabled(cfg);
  const enabled = isTelegram || isIMessage;

  console.log('comms channel:');
  console.log(`  transport: ${channel}`);
  console.log(`  enabled:   ${enabled}`);

  if (channel === 'telegram' || isTelegram) {
    console.log(`  chat_id:   ${cfg.comms?.telegram?.chatId ?? '(unset)'}`);
    console.log(`  bot_token: ${cfg.comms?.telegram?.botToken ? '(set)' : process.env['TELEGRAM_BOT_TOKEN'] ? '(set via env)' : '(unset)'}`);
  } else {
    console.log(`  handle:    ${cfg.comms?.imessageHandle ?? '(unset)'}`);
    console.log(`  service:   ${cfg.comms?.service ?? 'iMessage'}`);
  }
  console.log(`  platform:  ${process.platform}`);
  console.log('');

  if (!enabled) {
    if (channel === 'telegram') {
      console.log('Telegram channel not configured. Run `ashlr comms setup-telegram` for setup steps.');
    } else {
      console.log('Channel disabled. Set cfg.comms.enabled=true and cfg.comms.imessageHandle in ~/.ashlr/config.json.');
      console.log('');
      console.log('macOS permissions needed:');
      console.log('  • System Settings → Privacy & Security → Automation → Terminal → Messages (to send)');
      console.log('  • System Settings → Privacy & Security → Full Disk Access → Terminal (to read chat.db)');
    }
    return 0;
  }

  const pending = listRequests({ status: 'pending' });
  const sent = listRequests({ status: 'sent' });
  const out = outstanding();
  const watermarkMs = loadWatermark();

  console.log(`pending requests:     ${pending.length}`);
  console.log(`outstanding (sent):   ${sent.length}`);
  if (out) {
    console.log(`  awaiting reply: [${out.id.slice(0, 8)}] "${out.text.slice(0, 60)}"`);
  }

  if (!isTelegram) {
    console.log(`watermark:            ${watermarkMs > 0 ? new Date(watermarkMs).toISOString() : '(none)'}`);
    console.log('');
    console.log('macOS permissions needed:');
    console.log('  • Automation → Messages  (send via osascript)');
    console.log('  • Full Disk Access        (read ~/Library/Messages/chat.db)');
  }

  return 0;
}

async function cmdSendTest(): Promise<number> {
  const cfg = await loadConfig();
  const isTelegram = telegramEnabled(cfg);

  if (!channelEnabled(cfg)) {
    console.error('comms disabled — configure cfg.comms (imessage or telegram) in ~/.ashlr/config.json');
    return 1;
  }

  const channel = isTelegram ? 'Telegram' : 'iMessage';
  const id = postRequest({
    kind: 'test',
    type: 'report',
    text: `[ashlr test] ${channel} channel OK — ${new Date().toISOString()}`,
    options: [],
    meta: { source: 'send-test' },
  });

  console.log(`posted test report: ${id}`);
  const result = await runCommsCycle(cfg);
  console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

  if (result.sent > 0) {
    console.log(`Test message sent via ${channel}.`);
    return 0;
  } else {
    console.error(`Send failed — check channel configuration (${channel}).`);
    return 1;
  }
}

async function cmdCycle(): Promise<number> {
  const cfg = await loadConfig();
  // Register M138 resolution handlers before the cycle polls/resolves.
  registerCommsHandlers(cfg);
  const result = await runCommsCycle(cfg);
  console.log(`cycle complete: sent=${result.sent} resolved=${result.resolved}`);
  return 0;
}

// ---------------------------------------------------------------------------
// M138: digest — build oversight snapshot → send SMS-sized summary
// ---------------------------------------------------------------------------

async function cmdDigest(): Promise<number> {
  const cfg = await loadConfig();

  if (!channelEnabled(cfg)) {
    console.error('comms disabled — configure cfg.comms (imessage or telegram) in ~/.ashlr/config.json');
    return 1;
  }

  try {
    const snap = buildOversightSnapshot(cfg);
    const m = snap.scorecard;

    // Build a terse SMS-sized fleet summary — no secrets, no long text.
    const lines: string[] = [];
    lines.push(`Fleet 24h: ${m.proposalsCreated} proposals, ${(m.acceptRate * 100).toFixed(0)}% accept, trivial ${(m.trivialRatio * 100).toFixed(0)}%.`);

    if (snap.goals.active > 0 || snap.goals.done > 0) {
      lines.push(`Goals: ${snap.goals.active} active, ${snap.goals.done} done (${snap.goals.progressPct}% complete).`);
    }

    if (snap.manager) {
      lines.push(`Judge: ${snap.manager.shipped} ship, ${snap.manager.review} review, ${snap.manager.noise} noise.`);
    }

    // Top concern: first manager recommendation, or a derived signal.
    const topConcern = snap.manager?.recommendations?.[0]
      ?? (m.trivialRatio > 0.5 ? 'High trivial ratio — proposal quality may be low.'
        : m.emptyRate > 0.3 ? 'High empty-diff rate — engine may be stalling.'
          : 'Fleet operating normally.');
    lines.push(`Top concern: ${topConcern}`);

    if (snap.vision) {
      lines.push(`Vision progress: ${snap.vision.progressPct}%.`);
    }

    const text = lines.join(' ');

    // Post as a report (no reply needed), then run one cycle to send it.
    const id = postRequest({
      kind: 'fleet-digest',
      type: 'report',
      text,
      options: [],
      meta: { source: 'digest', generatedAt: snap.generatedAt },
    });

    console.log(`posted digest report: ${id}`);
    registerCommsHandlers(cfg);
    const result = await runCommsCycle(cfg);
    console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

    if (result.sent > 0) {
      console.log('Digest sent.');
      return 0;
    } else {
      console.error('Send failed — check channel configuration or an outstanding request may be blocking.');
      return 1;
    }
  } catch (err) {
    console.error('digest failed:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// M138: ask-vision — run strategist → post elon-vision question
// ---------------------------------------------------------------------------

async function cmdAskVision(): Promise<number> {
  const cfg = await loadConfig();

  if (!channelEnabled(cfg)) {
    console.error('comms disabled — configure cfg.comms (imessage or telegram) in ~/.ashlr/config.json');
    return 1;
  }

  try {
    // Use the latest cached briefing if available; otherwise run the strategist.
    let briefing = loadLatestBriefing();
    if (!briefing) {
      console.log('No cached briefing — running strategist (this may take a moment)...');
      briefing = await runStrategist(cfg);
    }

    // Build a terse question text: state + gap + top direction.
    const topDirection = briefing.recommendedDirection[0] ?? 'no specific direction proposed';
    const questionLines: string[] = [
      `State: ${briefing.currentState}`,
      `Gap: ${briefing.gapToVision}`,
      `Top direction: ${topDirection}`,
    ];
    if (briefing.questionsForMason.length > 0) {
      questionLines.push(`Open question: ${briefing.questionsForMason[0]}`);
    }
    const text = questionLines.join(' | ');

    const id = postRequest({
      kind: 'elon-vision',
      type: 'question',
      text,
      options: ['Approve & create goals', 'Hold', 'Show full briefing'],
      meta: {
        source: 'ask-vision',
        briefingGeneratedAt: briefing.generatedAt,
      },
    });

    console.log(`posted vision question: ${id}`);
    registerCommsHandlers(cfg);
    const result = await runCommsCycle(cfg);
    console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

    if (result.sent > 0) {
      const dest = telegramEnabled(cfg)
        ? `Telegram (chat ${cfg.comms?.telegram?.chatId ?? '?'})`
        : cfg.comms?.imessageHandle ?? '?';
      console.log(`Vision question sent to ${dest}. Reply 1/2/3 (or tap a button on Telegram).`);
      return 0;
    } else {
      console.error('Send failed — check channel config or an existing outstanding question may be blocking.');
      return 1;
    }
  } catch (err) {
    console.error('ask-vision failed:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function cmdAsk(text: string, options: string[]): Promise<number> {
  if (!text) {
    console.error('usage: ashlr comms ask "<text>" -o "option1" -o "option2"');
    return 2;
  }
  if (options.length === 0) {
    console.error('ask requires at least one -o option');
    return 2;
  }

  const cfg = await loadConfig();

  if (!channelEnabled(cfg)) {
    console.error('comms disabled — configure cfg.comms (imessage or telegram) in ~/.ashlr/config.json');
    return 1;
  }

  const id = postRequest({
    kind: 'test-question',
    type: 'question',
    text,
    options,
    meta: { source: 'cli-ask' },
  });

  console.log(`posted question: ${id}`);
  const result = await runCommsCycle(cfg);
  console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

  if (result.sent > 0) {
    const dest = telegramEnabled(cfg)
      ? `Telegram (chat ${cfg.comms?.telegram?.chatId ?? '?'})`
      : cfg.comms?.imessageHandle ?? '?';
    console.log(`Question sent to ${dest}. Reply with a number (or tap a button) to answer.`);
    return 0;
  } else {
    console.error('Send failed — check channel config or an existing outstanding question may be blocking.');
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function cmdComms(args: string[]): Promise<number> {
  const { sub, text, options } = parseArgs(args);

  switch (sub) {
    case 'status':
      return cmdStatus();
    case 'send-test':
      return cmdSendTest();
    case 'cycle':
      return cmdCycle();
    case 'ask':
      return cmdAsk(text, options);
    case 'digest':
      return cmdDigest();
    case 'ask-vision':
      return cmdAskVision();
    case 'ask-merges':
      return cmdAskMerges();
    case 'setup-telegram':
      return cmdSetupTelegram();
    default:
      console.error(`unknown subcommand: ${sub}`);
      console.error('usage: ashlr comms <status|send-test|cycle|ask|digest|ask-vision|ask-merges|setup-telegram>');
      return 2;
  }
}

// ---------------------------------------------------------------------------
// M147: setup-telegram — print setup steps + discover chat id
// ---------------------------------------------------------------------------

async function cmdSetupTelegram(): Promise<number> {
  console.log('');
  console.log('Telegram Bot setup for ashlr comms');
  console.log('────────────────────────────────────────────────────────────────');
  console.log('');
  console.log('Step 1 — Create a bot via @BotFather');
  console.log('  1. Open Telegram and search for @BotFather');
  console.log('  2. Send: /newbot');
  console.log('  3. Follow prompts to name your bot (e.g. "ashlr-comms")');
  console.log('  4. Copy the API token (looks like: 123456789:ABCDefgh...)');
  console.log('');
  console.log('Step 2 — Add the token to your ashlr config');
  console.log('  In ~/.ashlr/config.json, add:');
  console.log('  {');
  console.log('    "comms": {');
  console.log('      "enabled": true,');
  console.log('      "channel": "telegram",');
  console.log('      "telegram": {');
  console.log('        "botToken": "<YOUR_BOT_TOKEN>",');
  console.log('        "chatId": ""');
  console.log('      }');
  console.log('    }');
  console.log('  }');
  console.log('  (Or set TELEGRAM_BOT_TOKEN env var instead of botToken in config)');
  console.log('');
  console.log('Step 3 — Discover your chat id');
  console.log('  1. Send any message to your bot in Telegram (e.g. "hello")');
  console.log('  2. Run `ashlr comms setup-telegram` again — it will print your chat id');
  console.log('  3. Paste the chat id into cfg.comms.telegram.chatId');
  console.log('');

  // If a token is set, call getUpdates to discover the chat id
  const cfg = await loadConfig();
  const token = cfg.comms?.telegram?.botToken ?? process.env['TELEGRAM_BOT_TOKEN'];

  if (!token) {
    console.log('No bot token configured yet — complete Step 1 and 2 first.');
    return 0;
  }

  console.log('Bot token detected. Calling getUpdates to discover chat id...');

  try {
    // Import https dynamically (mirrors telegram.ts pattern; allows test mocks)
    const { request } = await import('node:https');
    const url = `https://api.telegram.org/bot${token}/getUpdates`;
    const body = JSON.stringify({ timeout: 0, limit: 10 });

    const data = await new Promise<unknown>((resolve) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10_000,
      };
      const req = request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });

    if (!data || typeof data !== 'object' || (data as Record<string, unknown>)['ok'] !== true) {
      // Scrub token from any error message
      const errDesc = String((data as Record<string, unknown>)?.['description'] ?? 'unknown error')
        .split(token).join('[REDACTED]');
      console.error(`getUpdates failed: ${errDesc}`);
      console.error('Check that your bot token is correct.');
      return 1;
    }

    const updates = (data as Record<string, unknown>)['result'];
    if (!Array.isArray(updates) || updates.length === 0) {
      console.log('No updates yet — send any message to your bot in Telegram, then re-run this command.');
      return 0;
    }

    const chatIds = new Set<string>();
    for (const upd of updates) {
      if (typeof upd !== 'object' || upd === null) continue;
      const u = upd as Record<string, unknown>;
      const chat = (u['message'] as Record<string, unknown> | undefined)?.['chat'] as Record<string, unknown> | undefined;
      if (chat?.['id']) chatIds.add(String(chat['id']));
    }

    if (chatIds.size === 0) {
      console.log('Found updates but no chat ids could be extracted. Try sending another message to your bot.');
      return 0;
    }

    console.log('');
    console.log('Discovered chat id(s):');
    for (const id of chatIds) {
      console.log(`  ${id}`);
    }
    console.log('');
    console.log('Paste the correct chat id into cfg.comms.telegram.chatId in ~/.ashlr/config.json.');
    return 0;
  } catch {
    console.error('Failed to call getUpdates — check your network connection.');
    return 1;
  }
}

// ---------------------------------------------------------------------------
// M139: ask-merges — post ship proposals for approval + run comms cycle
// ---------------------------------------------------------------------------

async function cmdAskMerges(): Promise<number> {
  const cfg = await loadConfig();

  if (!channelEnabled(cfg)) {
    console.error('comms disabled — configure cfg.comms (imessage or telegram) in ~/.ashlr/config.json');
    return 1;
  }

  try {
    const { postShipProposalsForApproval } = await import('../core/comms/merge-requests.js');
    const { posted } = await postShipProposalsForApproval(cfg);
    console.log(`ask-merges: posted ${posted} approval request(s)`);

    registerCommsHandlers(cfg);
    const result = await runCommsCycle(cfg);
    console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

    return 0;
  } catch (err) {
    console.error('ask-merges failed:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

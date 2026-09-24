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
 *   ask-vision                       Leader tick + post the latest Leader memo.
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
import { scrubSecrets } from '../core/util/scrub.js';
import { judgeHealth } from '../core/fleet/judge-calibration.js';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// M177: per-run cadence tracking (atomic, never-throws)
// ---------------------------------------------------------------------------

function cadencePath(name: 'last-digest' | 'last-askvision'): string {
  return join(homedir(), '.ashlr', 'comms', `${name}.json`);
}

function readLastSent(name: 'last-digest' | 'last-askvision'): number {
  try {
    const p = cadencePath(name);
    if (!existsSync(p)) return 0;
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as { sentAt?: number };
    return typeof parsed.sentAt === 'number' ? parsed.sentAt : 0;
  } catch {
    return 0;
  }
}

function writeLastSent(name: 'last-digest' | 'last-askvision', nowMs: number): void {
  try {
    const p = cadencePath(name);
    mkdirSync(join(homedir(), '.ashlr', 'comms'), { recursive: true });
    writeFileSync(p, JSON.stringify({ sentAt: nowMs }), 'utf8');
  } catch {
    // never-throws — a write failure must not break the poll cycle
  }
}

function isDue(name: 'last-digest' | 'last-askvision', intervalHours: number): boolean {
  const lastMs = readLastSent(name);
  if (lastMs === 0) return true;
  return Date.now() - lastMs >= intervalHours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// M177: sendDigest / sendAskVision — callable helpers (no enabled guard,
//       no top-level try/catch — callers handle that)
// ---------------------------------------------------------------------------

async function sendDigest(cfg: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const snap = buildOversightSnapshot(cfg);
  const m = snap.scorecard;

  const lines: string[] = [];
  lines.push(`Fleet 24h: ${m.proposalsCreated} proposals, ${(m.acceptRate * 100).toFixed(0)}% accept, trivial ${(m.trivialRatio * 100).toFixed(0)}%.`);

  if (snap.goals.active > 0 || snap.goals.done > 0) {
    lines.push(`Goals: ${snap.goals.active} active, ${snap.goals.done} done (${snap.goals.progressPct}% complete).`);
  }

  if (snap.manager) {
    lines.push(`Judge: ${snap.manager.shipped} ship, ${snap.manager.review} review, ${snap.manager.noise} noise.`);
  }

  const topConcern = snap.manager?.recommendations?.[0]
    ?? (m.trivialRatio > 0.5 ? 'High trivial ratio — proposal quality may be low.'
      : m.emptyRate > 0.3 ? 'High empty-diff rate — engine may be stalling.'
        : 'Fleet operating normally.');
  lines.push(`Top concern: ${topConcern}`);

  if (snap.vision) {
    lines.push(`Vision progress: ${snap.vision.progressPct}%.`);
  }

  try {
    const jh = await judgeHealth(cfg);
    let judgeLine: string;
    if (jh.sampleSize === 0) {
      const traceMatch = jh.flags[0]?.match(/found (\d+)/);
      const n = traceMatch ? traceMatch[1] : '0';
      judgeLine = `Judge: calibrating (${n} traces)`;
    } else {
      const kappaStr = jh.kappaVsOutcome !== null
        ? `κ=${jh.kappaVsOutcome.toFixed(2)} vs outcomes`
        : 'κ=n/a';
      const firstDc = jh.darkCurrent[0];
      const shipBiasPct = firstDc
        ? `ship-bias ${((firstDc.verdictDistribution['ship'] ?? 0) * 100).toFixed(0)}%`
        : null;
      const parts = [kappaStr, shipBiasPct, `${jh.sampleSize} traces`].filter(Boolean);
      judgeLine = `Judge: ${parts.join(', ')}`;
      if (jh.flags.length > 0) {
        const flagStr = jh.flags
          .map((f) => {
            if (f.includes('low-kappa') || f.includes('< 0.20') || f.includes('< 0.40')) return '⚠ low-kappa';
            if (f.includes('rubber-stamp')) return '⚠ ship-bias';
            if (f.includes('over-filtering')) return '⚠ noise-bias';
            if (f.includes('insufficient outcome')) return '⚠ few-outcomes';
            return '⚠ ' + f.slice(0, 30);
          })
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .slice(0, 2)
          .join(' ');
        judgeLine += ` ${flagStr}`;
      }
    }
    lines.push(judgeLine);
  } catch {
    // judgeHealth failure must never break the digest — silently skip.
  }

  const text = lines.join(' ');

  postRequest({
    kind: 'fleet-digest',
    type: 'report',
    text,
    options: [],
    meta: { source: 'digest', generatedAt: snap.generatedAt },
  });
}

/**
 * The comms kind for the Leader's briefing question. `elon-vision` is a
 * PERSISTED wire value (rows in ~/.ashlr/comms/requests.jsonl and the
 * resolution-handler registry key in comms/handlers.ts), kept so requests
 * already posted still resolve. It is an identifier only: nothing shown to
 * Mason (message text, options, CLI output) names a real person.
 */
export const LEADER_BRIEFING_KIND = 'elon-vision';

export type LeaderBriefingOutcome = 'posted' | 'already-posted' | 'no-memo';

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * V3.10: the daily "vision question" is the Leader's, not the legacy
 * Strategist's. It runs the SAME path as `ashlr leader tick` — due class-B
 * actions apply, due moves are graded, and a Leader run starts only when one
 * is due (06:30 cadence / merge, revert, seat-reset, insight triggers; at
 * most 3 a day; skipped when the evidence has not changed; routed seat, no
 * cloud fallback, dry run without a grant). The legacy runStrategist path
 * went to the Claude CLI first with no budget gate; it is no longer reached
 * from comms.
 *
 * Then the newest successful memo is posted once (deduped by memo id):
 * Keep it / Veto this memo / Show full memo.
 */
export async function sendLeaderBriefing(cfg: Awaited<ReturnType<typeof loadConfig>>): Promise<LeaderBriefingOutcome> {
  const leader = await import('../core/vision/leader.js');
  const deps = await leader.loadDefaultLeaderRunDeps(cfg);
  await leader.leaderTick(deps, { awaitRun: true });
  const memo = leader.buildLeaderState(Date.now()).latest;
  if (!memo || memo.status !== 'ok') return 'no-memo';
  if (listRequests({ kind: LEADER_BRIEFING_KIND }).some((r) => r.meta?.['memoId'] === memo.id)) return 'already-posted';

  const parts: string[] = [`Leader memo${memo.dryRun ? ' (dry run)' : ''}`];
  if (memo.bottleneck) parts.push(`Bottleneck: ${clipText(memo.bottleneck.statement, 240)}`);
  if (memo.move) parts.push(`Move: ${clipText(memo.move.statement, 240)}`);
  const live = memo.actions.filter((a) => a.status === 'applied' || a.status === 'scheduled').length;
  if (live > 0) parts.push(`${live} action(s) applied or waiting on their veto window`);
  if (memo.questionsForMason.length > 0) parts.push(`Question: ${clipText(memo.questionsForMason[0]!, 240)}`);

  postRequest({
    kind: LEADER_BRIEFING_KIND,
    type: 'question',
    // Model-authored text on its way to Mason's phone: scrubbed like every outbound message.
    text: scrubSecrets(parts.join(' | ')),
    options: ['Keep it', 'Veto this memo', 'Show full memo'],
    meta: { source: 'leader', memoId: memo.id },
  });
  return 'posted';
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

  // M177: throttled cadence — drive digest + ask-vision from the working poller.
  if (channelEnabled(cfg)) {
    const digestIntervalHours = cfg.comms?.digestIntervalHours ?? 6;
    const askVisionIntervalHours = cfg.comms?.askVisionIntervalHours ?? 24;

    if (isDue('last-digest', digestIntervalHours)) {
      try {
        await sendDigest(cfg);
        writeLastSent('last-digest', Date.now());
        console.log('cycle: digest queued');
      } catch {
        // never-throws — digest failure must not break the poll cycle
      }
    }

    if (isDue('last-askvision', askVisionIntervalHours)) {
      try {
        const outcome = await sendLeaderBriefing(cfg);
        // Checked once per interval whatever the outcome: a missing memo is
        // not retried every poll (the daemon's own tick runs the Leader).
        writeLastSent('last-askvision', Date.now());
        console.log(outcome === 'posted' ? 'cycle: leader memo queued' : `cycle: leader memo not queued (${outcome})`);
      } catch {
        // never-throws — ask-vision failure must not break the poll cycle
      }
    }
  }

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
    await sendDigest(cfg);

    // Post as a report (no reply needed), then run one cycle to send it.
    const pending = listRequests({ kind: 'fleet-digest', status: 'pending' });
    const id = pending[pending.length - 1]?.id ?? '(unknown)';
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
// ask-vision — a Leader tick, then post the latest Leader memo (V3.10)
// ---------------------------------------------------------------------------

async function cmdAskVision(): Promise<number> {
  const cfg = await loadConfig();

  if (!channelEnabled(cfg)) {
    console.error('comms disabled — configure cfg.comms (imessage or telegram) in ~/.ashlr/config.json');
    return 1;
  }

  try {
    console.log('Running a Leader tick (a due run on a local model can take several minutes)…');
    const outcome = await sendLeaderBriefing(cfg);
    if (outcome === 'no-memo') {
      console.error('No Leader memo yet — run `ashlr leader run` (or wait for the 06:30 run), then try again.');
      return 1;
    }
    if (outcome === 'already-posted') console.log('The latest Leader memo was already sent; sending anything still pending.');
    else {
      const pending = listRequests({ kind: LEADER_BRIEFING_KIND, status: 'pending' });
      console.log(`posted Leader memo: ${pending[pending.length - 1]?.id ?? '(unknown)'}`);
    }
    registerCommsHandlers(cfg);
    const result = await runCommsCycle(cfg);
    console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

    if (outcome === 'already-posted' || result.sent > 0) {
      if (result.sent > 0) {
        const dest = telegramEnabled(cfg)
          ? `Telegram (chat ${cfg.comms?.telegram?.chatId ?? '?'})`
          : cfg.comms?.imessageHandle ?? '?';
        console.log(`Leader memo sent to ${dest}. Reply 1/2/3 (or tap a button on Telegram).`);
      }
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

function printCommsHelp(): void {
  console.log('');
  console.log('  ashlr comms — bidirectional operator channel (Telegram/iMessage)');
  console.log('');
  console.log('  Usage: ashlr comms <status|send-test|cycle|ask|digest|ask-vision|ask-merges|setup-telegram>');
  console.log('');
  console.log('    status                       config + pending/outstanding + watermark');
  console.log('    send-test                    post + send a test report to verify the channel');
  console.log('    cycle                        run one send-pending + poll-replies pass');
  console.log('    ask "<text>" -o a -o b       post a question with numbered options');
  console.log('    digest                       build oversight snapshot + send summary');
  console.log('    ask-vision                   run a Leader tick + post the latest Leader memo');
  console.log('    ask-merges                   post ship proposals for approval + run cycle');
  console.log('    setup-telegram               print Telegram setup steps + discover chat id');
  console.log('');
}

export async function cmdComms(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printCommsHelp();
    return 0;
  }
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

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
 *   digest [--force]                 Change-driven digest (silent when nothing changed).
 *   ask-vision                       Leader tick + deliver the Leader thread (latest memo).
 *   ask-merges                       Post ship proposals for approval + run cycle.
 *   setup-telegram                   Print Telegram setup steps + discover chat id.
 *   telegram-brand [--apply --expected-bot-id <id>] [--json]
 *                                    Preview/update this bot's Phantom display profile.
 *
 * Exit codes: 0 success, 1 error, 2 bad usage.
 */

import { loadConfig } from '../core/config.js';
import { commsEnabled } from '../core/integrations/imessage.js';
import { telegramEnabled } from '../core/integrations/telegram.js';
import { listRequests, outstanding, postRequest } from '../core/comms/requests.js';
import { runCommsCycle } from '../core/comms/dispatch.js';
import { registerCommsHandlers } from '../core/comms/handlers.js';
import { runChangeDigest, readDigestState, type ChangeDigestResult } from '../core/comms/change-digest.js';
import { LEGACY_BRIEFING_KIND, type CommsMigrationSummary } from '../core/comms/migrations.js';
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
// 3.14: change-driven digest + Leader memo delivery — callable helpers (no
//       enabled guard, no top-level try/catch — callers handle that)
// ---------------------------------------------------------------------------

/**
 * Queue the change-driven digest (comms/change-digest.ts): a message only
 * when something changed since the last one — merges, PRs, reverts, seats,
 * cloud tasks, a new Leader memo — and at most one honest idle line per idle
 * stretch. Silent otherwise. Returns what happened, for the log.
 */
async function sendDigest(opts: { nowMs?: number } = {}): Promise<ChangeDigestResult> {
  return runChangeDigest(opts);
}

/**
 * Wire kind of the pre-3.14 Leader briefing QUESTION (and the legacy
 * Strategist briefing). A persisted value — rows in requests.jsonl still
 * resolve through comms/handlers.ts — but nothing new is posted under it.
 */
export const LEADER_BRIEFING_KIND = LEGACY_BRIEFING_KIND;

/**
 * Where the newest Leader memo is on its way to Mason's phone:
 * - `queued`        — in the Leader thread, pending for Telegram (the cycle drains it);
 * - `delivered`     — already sent;
 * - `failed`        — Telegram delivery gave up after its retries;
 * - `not-in-thread` — the memo exists but the thread did not post it (older
 *                     than 7 days, or skipped by the first-sync backlog limit);
 * - `no-memo`       — there is no successful Leader memo yet.
 */
export type LeaderBriefingOutcome = 'queued' | 'delivered' | 'failed' | 'not-in-thread' | 'no-memo';

export interface LeaderBriefingStatus {
  outcome: LeaderBriefingOutcome;
  memoId: string | null;
  deliveredAt: string | null;
}

/** Where memo `memoId`'s summary message stands in the Leader thread (syncs recent memos first). */
async function leaderMemoDelivery(memoId: string): Promise<LeaderBriefingStatus> {
  const thread = await import('../core/vision/leader-thread.js');
  thread.syncLeaderMemosToThread();
  const msg = thread
    .listThread({ limit: 200 })
    .filter((m) => m.kind === 'memo' && m.memoId === memoId)
    .pop();
  const state = msg?.delivery?.telegram;
  if (state === 'sent') return { outcome: 'delivered', memoId, deliveredAt: msg?.delivery?.sentAt ?? null };
  if (state === 'pending') return { outcome: 'queued', memoId, deliveredAt: null };
  if (state === 'failed') return { outcome: 'failed', memoId, deliveredAt: null };
  return { outcome: 'not-in-thread', memoId, deliveredAt: null };
}

/**
 * The daily "vision question" is the Leader's. It runs the SAME path as
 * `ashlr leader tick` — due class-B actions apply, due moves are graded, and a
 * Leader run starts only when one is due (06:30 cadence / merge, revert,
 * seat-reset, insight triggers; at most 3 a day; skipped when the evidence has
 * not changed; routed seat, no cloud fallback, dry run without a grant). The
 * legacy Strategist path is never reached from comms.
 *
 * 3.14: the memo is NOT posted as a comms request any more (the old
 * "Keep it / Veto this memo / Show full memo" question is retired). The
 * Leader thread owns memo delivery: syncLeaderMemosToThread() queues the memo
 * summary plus one message per question for Telegram, and the comms cycle
 * drains pendingOutbound('telegram') with [Approve] [Veto] [Details] buttons.
 * This reports where the newest memo stands.
 */
export async function sendLeaderBriefing(cfg: Awaited<ReturnType<typeof loadConfig>>): Promise<LeaderBriefingStatus> {
  const leader = await import('../core/vision/leader.js');
  const deps = await leader.loadDefaultLeaderRunDeps(cfg);
  await leader.leaderTick(deps, { awaitRun: true });
  const memo = leader.buildLeaderState(Date.now()).latest;
  if (!memo || memo.status !== 'ok') return { outcome: 'no-memo', memoId: null, deliveredAt: null };
  return leaderMemoDelivery(memo.id);
}

function logMigration(summary: CommsMigrationSummary | undefined): void {
  if (!summary) return;
  console.log(`comms migration ${summary.id}:`);
  for (const line of summary.log) console.log(`  ${line}`);
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
      console.log('Telegram channel not configured. Run `phm comms setup-telegram` for setup steps.');
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
    text: `[Phantom test] ${channel} channel OK — ${new Date().toISOString()}`,
    options: [],
    meta: { source: 'send-test' },
  });

  console.log(`posted test report: ${id}`);
  const result = await runCommsCycle(cfg);
  logMigration(result.migration);
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

    // 3.15: with the Leader line on, the morning brief / evening recap carry
    // what shipped — the 6-hourly digest would repeat it, so it stays silent.
    const { leaderLineEnabled } = await import('../core/comms/leader-line.js');
    if (!leaderLineEnabled(cfg) && isDue('last-digest', digestIntervalHours)) {
      try {
        const digest = await sendDigest();
        // Evaluated once per interval whether or not it spoke.
        writeLastSent('last-digest', Date.now());
        console.log(digest.posted ? `cycle: digest queued (${digest.reason})` : `cycle: digest silent (${digest.reason})`);
      } catch {
        // never-throws — digest failure must not break the poll cycle
      }
    }

    if (isDue('last-askvision', askVisionIntervalHours)) {
      try {
        const { outcome, memoId } = await sendLeaderBriefing(cfg);
        // Checked once per interval whatever the outcome: a missing memo is
        // not retried every poll (the daemon's own tick runs the Leader).
        writeLastSent('last-askvision', Date.now());
        console.log(`cycle: leader memo ${memoId ?? '(none)'}: ${outcome}`);
      } catch {
        // never-throws — ask-vision failure must not break the poll cycle
      }
    }
  }

  // 3.14: Leader retries and working-hours check-ins without the daemon — a
  // detached `ashlr leader tick --wait` when a time-based run is due (cheap
  // state-file check; at most every 10 min; never throws).
  const wake = await (await import('./leader.js')).wakeLeaderIfDue(cfg);
  if (wake.started) console.log(`cycle: leader tick started (${wake.why})`);

  // Register M138 resolution handlers before the cycle polls/resolves.
  registerCommsHandlers(cfg);
  const result = await runCommsCycle(cfg);
  logMigration(result.migration);
  console.log(`cycle complete: sent=${result.sent} resolved=${result.resolved}`);
  return 0;
}

// ---------------------------------------------------------------------------
// M138: digest — build oversight snapshot → send SMS-sized summary
// ---------------------------------------------------------------------------

async function cmdDigest(force: boolean): Promise<number> {
  const cfg = await loadConfig();

  if (!channelEnabled(cfg)) {
    console.error('comms disabled — configure cfg.comms (imessage or telegram) in ~/.ashlr/config.json');
    return 1;
  }

  try {
    const digest = await sendDigest();
    let requestId = digest.requestId;
    if (!digest.posted) {
      if (!force) {
        const last = readDigestState()?.lastSentAt;
        console.log(`Nothing changed since the last digest${last ? ` (${last})` : ''} — nothing sent. Use --force to send the current state anyway.`);
        return 0;
      }
      const { buildStatusText } = await import('../core/comms/telegram-channel.js');
      requestId = postRequest({
        kind: 'fleet-digest',
        type: 'report',
        text: `No fleet changes since the last digest.\n${await buildStatusText()}`,
        options: [],
        meta: { source: 'digest', reason: 'forced' },
      });
    }
    console.log(`queued digest: ${requestId ?? '(unknown)'} (${digest.posted ? digest.reason : 'forced'})`);
    registerCommsHandlers(cfg);
    const result = await runCommsCycle(cfg);
    logMigration(result.migration);
    console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

    const delivered = requestId ? listRequests({ status: 'answered' }).some((r) => r.id === requestId) : false;
    if (delivered) {
      console.log('Digest sent.');
      return 0;
    }
    console.error('Digest queued but not sent yet — check the channel configuration (it retries on the next cycle).');
    return 1;
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
    const before = await sendLeaderBriefing(cfg);
    const { memoId } = before;
    if (before.outcome === 'no-memo' || !memoId) {
      console.error('No Leader memo yet — run `phm leader run` (or wait for the 06:30 run), then try again.');
      return 1;
    }
    // Say exactly where the memo is: "already posted" used to mean only
    // "queued", while the memo sat undelivered behind a blocked queue.
    if (before.outcome === 'delivered') {
      console.log(`Leader memo ${memoId} was already delivered${before.deliveredAt ? ` at ${before.deliveredAt}` : ''}; running a cycle for anything else pending.`);
    } else if (before.outcome === 'queued') {
      console.log(`Leader memo ${memoId} is queued in the Leader thread, not delivered yet; sending now.`);
    } else if (before.outcome === 'failed') {
      console.error(`Leader memo ${memoId}: Telegram delivery failed after its retries — see \`phm leader\` / Phantom for the memo.`);
    } else {
      console.log(`Leader memo ${memoId} is not in the Leader thread (older than 7 days, or skipped as backlog) — nothing to deliver.`);
    }
    registerCommsHandlers(cfg);
    const result = await runCommsCycle(cfg);
    logMigration(result.migration);
    console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

    if (before.outcome === 'delivered' || before.outcome === 'not-in-thread') return 0;
    if (before.outcome === 'failed') return 1;
    const after = await leaderMemoDelivery(memoId);
    if (after.outcome === 'delivered') {
      const dest = telegramEnabled(cfg)
        ? `Telegram (chat ${cfg.comms?.telegram?.chatId ?? '?'})`
        : cfg.comms?.imessageHandle ?? '?';
      console.log(`Leader memo ${memoId} delivered to ${dest}. Reply to it to talk to the Leader, or tap Approve / Veto / Details.`);
      return 0;
    }
    if (!telegramEnabled(cfg)) {
      console.log(`Leader memo ${memoId} is in the Leader thread; it is delivered over Telegram only (read it in Phantom or \`phm leader\`).`);
      return 0;
    }
    console.error(`Leader memo ${memoId} is queued but was not delivered — check the Telegram configuration (it retries on the next cycle).`);
    return 1;
  } catch (err) {
    console.error('ask-vision failed:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function cmdAsk(text: string, options: string[]): Promise<number> {
  if (!text) {
    console.error('usage: phm comms ask "<text>" -o "option1" -o "option2"');
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
  logMigration(result.migration);
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
  console.log('  Phantom comms — bidirectional operator channel (Telegram/iMessage)');
  console.log('');
  console.log('  Usage: phm comms <status|send-test|cycle|ask|digest|ask-vision|ask-merges|setup-telegram|telegram-brand>');
  console.log('  Compatible alias: ashlr comms <command>');
  console.log('');
  console.log('    status                       config + pending/outstanding + watermark');
  console.log('    send-test                    post + send a test report to verify the channel');
  console.log('    cycle                        run one send-pending + poll-replies pass');
  console.log('    ask "<text>" -o a -o b       post a question with numbered options');
  console.log('    digest [--force]             send what changed since the last digest (silent if nothing)');
  console.log('    ask-vision                   run a Leader tick + deliver the latest memo via the Leader thread');
  console.log('    ask-merges                   post ship proposals for approval + run cycle');
  console.log('    setup-telegram               print Telegram setup steps + discover chat id');
  console.log('    telegram-brand [--json]      preview the configured bot’s Phantom display profile');
  console.log('      --apply --expected-bot-id <id>  update default-locale profile and verify readback');
  console.log('');
}

export async function cmdComms(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printCommsHelp();
    return 0;
  }
  if (args[0] === 'telegram-brand') return cmdTelegramBrand(args.slice(1));
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
      return cmdDigest(args.includes('--force'));
    case 'ask-vision':
      return cmdAskVision();
    case 'ask-merges':
      return cmdAskMerges();
    case 'setup-telegram':
      return cmdSetupTelegram();
    default:
      console.error(`unknown subcommand: ${sub}`);
      console.error('usage: phm comms <status|send-test|cycle|ask|digest|ask-vision|ask-merges|setup-telegram|telegram-brand>');
      return 2;
  }
}

async function cmdTelegramBrand(args: string[]): Promise<number> {
  let apply = false, preview = false, json = false, expectedBotId: number | undefined;
  const seen = new Set<string>();
  const badUsage = (): number => {
    console.error('usage: phm comms telegram-brand [--preview | --apply --expected-bot-id <id>] [--json]');
    return 2;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg)) return badUsage();
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--preview') preview = true;
    else if (arg === '--json') json = true;
    else if (arg === '--expected-bot-id') {
      const value = args[++index];
      if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) return badUsage();
      expectedBotId = Number(value);
    } else return badUsage();
  }
  if (apply && (preview || expectedBotId === undefined) || !apply && expectedBotId !== undefined) return badUsage();
  try {
    // This explicit operation must not seed/repair configuration, enqueue messages,
    // or run the comms cycle. Existing other commands keep their loadConfig behavior.
    const { loadConfigReadOnlyStrict } = await import('../core/config.js');
    const { syncTelegramDisplayBrand } = await import('../core/integrations/telegram.js');
    const result = await syncTelegramDisplayBrand(loadConfigReadOnlyStrict(), { apply, expectedBotId });
    if (json) console.log(JSON.stringify(result));
    else {
      console.log(`Telegram Phantom profile: ${result.status}`);
      if (result.botId !== null) console.log(`  Bot ID: ${result.botId}${result.username ? ` (@${result.username})` : ''}`);
      for (const [field, value] of Object.entries(result.fields)) console.log(`  ${field}: ${value.state} → ${value.desired}`);
      for (const error of result.errors) console.log(`  ${error.stage}: ${error.reason}`);
    }
    return result.status === 'preview' || result.status === 'verified' ? 0 : 1;
  } catch {
    // Config errors can contain local paths; neither those nor provider exceptions
    // are part of this command's public diagnostics.
    if (json) console.log(JSON.stringify({ status: 'blocked', reason: 'configuration-or-operation-unavailable' }));
    else console.error('Telegram profile unavailable: configuration or operation could not be read safely.');
    return 1;
  }
}

// ---------------------------------------------------------------------------
// M147: setup-telegram — print setup steps + discover chat id
// ---------------------------------------------------------------------------

async function cmdSetupTelegram(): Promise<number> {
  console.log('');
  console.log('Telegram bot setup for Phantom');
  console.log('────────────────────────────────────────────────────────────────');
  console.log('');
  console.log('Step 1 — Create a bot via @BotFather');
  console.log('  1. Open Telegram and search for @BotFather');
  console.log('  2. Send: /newbot');
  console.log('  3. Follow prompts to name your bot (e.g. "Phantom")');
  console.log('  4. Copy the API token (looks like: 123456789:ABCDefgh...)');
  console.log('');
  console.log('Step 2 — Add the token to your Phantom configuration');
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
  console.log('  2. Run `phm comms setup-telegram` again — it will print your chat id');
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
    logMigration(result.migration);
    console.log(`cycle: sent=${result.sent} resolved=${result.resolved}`);

    return 0;
  } catch (err) {
    console.error('ask-merges failed:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}
